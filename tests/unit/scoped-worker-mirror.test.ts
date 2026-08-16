import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopedWorkerMirror } from "../../src/harness/worker/scoped-mirror.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(label: string): string {
  const root = mkdtempSync(resolve(tmpdir(), `pch-scoped-mirror-${label}-`));
  roots.push(root);
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "src", "index.ts"), "export const value = 1;\n");
  return root;
}

describe("ScopedWorkerMirror", () => {
  it.each([".env", ".GIT/config", "node_modules/pkg/index.js", ".npmrc"])(
    "rejects an explicitly declared secret or excluded root: %s",
    (declared) => {
      const root = workspace("SECRET");
      const target = resolve(root, declared);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, "secret\n");
      expect(() => ScopedWorkerMirror.create(root, [declared], [])).toThrow(/excluded or credential/u);
    },
  );

  it("rejects a missing declared read closure instead of silently omitting it", () => {
    const root = workspace("MISSING");
    expect(() => ScopedWorkerMirror.create(root, ["src/missing.ts"], [])).toThrow(/does not exist/u);
  });

  it("rejects a scope reached through a symlink or junction ancestor", () => {
    const root = workspace("LINK");
    const outside = workspace("OUTSIDE");
    try {
      symlinkSync(outside, resolve(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect(() => ScopedWorkerMirror.create(root, ["linked/src/index.ts"], [])).toThrow(/symbolic link or junction/u);
  });

  it("allows an absent write-only target while preserving a verified existing read closure", () => {
    const root = workspace("NEW-WRITE");
    const mirror = ScopedWorkerMirror.create(root, ["src/index.ts"], ["src/new.ts"]);
    roots.push(mirror.root);
    expect(existsSync(resolve(mirror.root, "src", "index.ts"))).toBe(true);
    expect(existsSync(resolve(mirror.root, "src", "new.ts"))).toBe(false);
  });
});
