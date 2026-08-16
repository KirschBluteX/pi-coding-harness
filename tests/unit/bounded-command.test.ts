import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedCommand } from "../../src/effects/bounded-command.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pch-bounded-command-"));
  roots.push(root);
  return root;
}

describe("bounded command", () => {
  it("returns bounded output for a successful command", async () => {
    const root = temporaryRoot();
    const script = join(root, "success.cjs");
    writeFileSync(script, "process.stdout.write('bounded-ok')", "utf8");
    await expect(runBoundedCommand({
      command: `"${process.execPath}" "${script}"`,
      cwd: root,
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
      signal: new AbortController().signal,
    })).resolves.toEqual({ exitCode: 0, output: "bounded-ok" });
  });

  it("kills descendants before reporting a timeout", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "late-side-effect.txt");
    const descendant = join(root, "descendant.cjs");
    const parent = join(root, "parent.cjs");
    writeFileSync(descendant, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 700)`, "utf8");
    writeFileSync(parent, [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
      "setTimeout(() => {}, 10000);",
    ].join("\n"), "utf8");

    await expect(runBoundedCommand({
      command: `"${process.execPath}" "${parent}"`,
      cwd: root,
      timeoutMs: 100,
      maximumOutputBytes: 1_024,
      signal: new AbortController().signal,
    })).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(sentinel)).toBe(false);
  }, 15_000);

  it("kills the command when output exceeds the declared limit", async () => {
    const root = temporaryRoot();
    const script = join(root, "overflow.cjs");
    writeFileSync(script, "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 10000)", "utf8");
    await expect(runBoundedCommand({
      command: `"${process.execPath}" "${script}"`,
      cwd: root,
      timeoutMs: 5_000,
      maximumOutputBytes: 64,
      signal: new AbortController().signal,
    })).rejects.toThrow("output exceeded");
  });
});
