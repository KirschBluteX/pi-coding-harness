import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { sha256Hex } from "../../foundation/crypto.js";
import type { HarnessWorkerPatchInput } from "../../runtime/task-flow-session.js";
import type { TaskPacketArtifactRefV2 } from "../execution-v2/domain.js";
import { minimalScopePaths, scopeContains, scopePathKey } from "../scope-path.js";

const ignoredNames = new Set([".git", ".coding-harness", ".pi", "node_modules", "dist", "build", ".cache"]);
const credentialFiles = new Set([".npmrc", ".pypirc", ".netrc", "auth.json", "credentials.json", "id_rsa", "id_ed25519"]);
const maximumFiles = 8_192;
const maximumBytes = 128 * 1024 * 1024;

interface FileSnapshot {
  readonly sha256: string;
}

function ignoredEntry(name: string): boolean {
  const lower = name.toLowerCase();
  if (ignoredNames.has(lower) || credentialFiles.has(lower)) return true;
  return /^\.env(?:\..+)?$/u.test(lower) && !/^\.env\.(?:example|sample|template)$/u.test(lower);
}

function contained(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function normalizedRealPath(value: string): string {
  const normalized = realpathSync(value).replaceAll("/", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function minimalRoots(values: readonly string[]): string[] {
  return minimalScopePaths(values.map((value) => scopePathKey(value).normalized));
}

function assertDeclaredPath(workspace: string, scoped: string, mustExist: boolean): { readonly source: string; readonly exists: boolean } {
  const normalized = scopePathKey(scoped).normalized;
  const segments = normalized === "." ? [] : normalized.split("/");
  for (const segment of segments) {
    if (ignoredEntry(segment)) throw new TypeError(`Worker declared root is excluded or credential-bearing: ${scoped}`);
  }
  const source = resolve(workspace, normalized);
  if (!contained(workspace, source)) throw new TypeError(`Worker declared root escapes the workspace: ${scoped}`);
  let current = resolve(workspace);
  if (lstatSync(current).isSymbolicLink()) throw new TypeError("Worker workspace resolves through a symbolic link or junction");
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      if (mustExist) throw new TypeError(`Worker declared read root does not exist: ${scoped}`);
      return { source, exists: false };
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new TypeError(`Worker scope resolves through a symbolic link or junction: ${scoped}`);
    }
  }
  if (!contained(normalizedRealPath(workspace), normalizedRealPath(source))) {
    throw new TypeError(`Worker scope resolves outside the workspace: ${scoped}`);
  }
  return { source, exists: true };
}

function snapshot(root: string): Map<string, FileSnapshot> {
  const result = new Map<string, FileSnapshot>();
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (ignoredEntry(name)) continue;
      const absolute = resolve(directory, name);
      const entry = lstatSync(absolute);
      if (entry.isSymbolicLink()) throw new TypeError(`Worker sandbox contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const content = readFileSync(absolute);
        bytes += content.byteLength;
        if (result.size >= maximumFiles || bytes > maximumBytes) {
          throw new TypeError("Worker sandbox exceeds its bounded file or byte budget");
        }
        result.set(relative(root, absolute).replaceAll("\\", "/"), { sha256: sha256Hex(content) });
      }
    }
  };
  visit(root);
  return result;
}

function withinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => scopeContains(root, path));
}

export class ScopedWorkerMirror {
  private disposed = false;

  private constructor(
    readonly root: string,
    private readonly before: ReadonlyMap<string, FileSnapshot>,
    readonly writeRoots: readonly string[],
  ) {}

  static create(
    workspace: string,
    readRootsInput: readonly string[],
    writeRootsInput: readonly string[],
    exactInputRefs?: readonly TaskPacketArtifactRefV2[],
  ): ScopedWorkerMirror {
    const workspaceRoot = resolve(workspace);
    const readRoots = minimalRoots(readRootsInput);
    const writeRoots = minimalRoots(writeRootsInput);
    const requestedRoots = minimalRoots([...readRoots, ...writeRoots]);
    const root = mkdtempSync(resolve(tmpdir(), "pi-coding-worker-"));
    const before = new Map<string, FileSnapshot>();
    let copiedBytes = 0;
    try {
      const strictReadRoots = new Set(readRoots);
      for (const scoped of requestedRoots) {
        const declared = assertDeclaredPath(workspaceRoot, scoped, strictReadRoots.has(scoped));
        if (!declared.exists) continue;
        const copy = (from: string, relativePath: string): void => {
          const entry = lstatSync(from);
          if (entry.isSymbolicLink()) throw new TypeError(`Worker scope resolves through a symbolic link or junction: ${relativePath}`);
          const destination = resolve(root, relativePath);
          if (entry.isDirectory()) {
            mkdirSync(destination, { recursive: true });
            for (const name of readdirSync(from)) {
              if (!ignoredEntry(name)) copy(resolve(from, name), `${relativePath}/${name}`);
            }
          } else if (entry.isFile()) {
            const content = readFileSync(from);
            copiedBytes += content.byteLength;
            if (before.size >= maximumFiles || copiedBytes > maximumBytes) {
              throw new TypeError("Worker sandbox exceeds its bounded file or byte budget");
            }
            mkdirSync(resolve(destination, ".."), { recursive: true });
            writeFileSync(destination, content);
            before.set(relative(root, destination).replaceAll("\\", "/"), { sha256: sha256Hex(content) });
          }
        };
        copy(declared.source, scoped);
      }
      if (exactInputRefs !== undefined) {
        const expected = new Map<string, TaskPacketArtifactRefV2>();
        for (const ref of exactInputRefs) {
          const path = scopePathKey(ref.path).normalized;
          if (ref.classification === "SECRET") throw new TypeError(`Worker exact input is SECRET: ${path}`);
          if (!withinRoots(path, requestedRoots)) throw new TypeError(`Worker exact input is outside its declared roots: ${path}`);
          if (expected.has(path)) throw new TypeError(`Worker exact input contains a duplicate path: ${path}`);
          expected.set(path, { ...ref, path });
        }
        if (expected.size !== before.size) throw new TypeError("Worker exact input closure file count differs from its scoped mirror");
        for (const [path, actual] of before) {
          const ref = expected.get(path);
          if (!ref || ref.sha256 !== actual.sha256) {
            throw new TypeError(`Worker exact input closure differs at ${path}`);
          }
        }
      }
      return new ScopedWorkerMirror(root, before, writeRoots);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  diff(): readonly HarnessWorkerPatchInput[] {
    if (this.disposed) throw new TypeError("Worker mirror is disposed");
    const after = snapshot(this.root);
    const paths = [...new Set([...this.before.keys(), ...after.keys()])].sort();
    const patches: HarnessWorkerPatchInput[] = [];
    for (const path of paths) {
      const before = this.before.get(path);
      const current = after.get(path);
      if (before?.sha256 === current?.sha256) continue;
      if (!withinRoots(path, this.writeRoots)) throw new TypeError(`Worker changed a path outside its write roots: ${path}`);
      const content = current === undefined ? null : readFileSync(resolve(this.root, path));
      patches.push(before === undefined
        ? { operation: "CREATE", path, beforeSha256: null, content: content! }
        : current === undefined
          ? { operation: "DELETE", path, beforeSha256: before.sha256, content: null }
          : { operation: "MODIFY", path, beforeSha256: before.sha256, content: content! });
    }
    return patches;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    rmSync(this.root, { recursive: true, force: true });
  }
}
