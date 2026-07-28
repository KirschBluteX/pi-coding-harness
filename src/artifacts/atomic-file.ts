import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { UnsafePathError } from "../foundation/errors.js";

function normalized(path: string): string {
  const value = resolve(path).replaceAll("/", "\\");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function prepareSafeRoot(root: string): string {
  const resolved = resolve(root);
  if (resolved.startsWith("\\\\")) throw new UnsafePathError("Artifact root cannot use a UNC path");
  mkdirSync(resolved, { recursive: true });
  if (lstatSync(resolved).isSymbolicLink()) throw new UnsafePathError("Artifact root cannot be a symlink or junction");
  // Non-native realpath preserves Windows 8.3 aliases while still resolving links.
  const actual = realpathSync(resolved);
  if (normalized(actual) !== normalized(resolved)) throw new UnsafePathError("Artifact root resolves through a link");
  return actual;
}

export function assertContained(root: string, target: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (relation === "" || (relation !== ".." && !relation.startsWith("..\\") && !relation.startsWith("../") && !isAbsolute(relation))) return;
  throw new UnsafePathError(`Artifact target escapes root: ${target}`);
}

export function assertSafeExistingDirectory(root: string, directory: string): void {
  assertContained(root, directory);
  if (!existsSync(directory)
    || lstatSync(directory).isSymbolicLink()
    || normalized(realpathSync(directory)) !== normalized(directory)) {
    throw new UnsafePathError("Artifact directory resolves through a symlink or junction");
  }
}

export function publishAtomicNoReplace(root: string, target: string, bytes: Uint8Array): "CREATED" | "EXISTS" {
  assertContained(root, target);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  assertSafeExistingDirectory(root, directory);
  const temporary = resolve(directory, `.${basename(target)}.tmp.${randomUUID()}`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, target);
    unlinkSync(temporary);
    return "CREATED";
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve publish error. */ }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "EXISTS";
    throw error;
  }
}
