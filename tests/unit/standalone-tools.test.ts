import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostApplicationRequest } from "../../src/harness/host/application-protocol.js";
import { executeControlledTool } from "../../src/standalone/tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace() {
  const cwd = mkdtempSync(resolve(tmpdir(), "pch-standalone-tool-"));
  roots.push(cwd);
  return cwd;
}

describe("standalone controlled tools", () => {
  it("sends an empty directory listing as a valid nonempty Host tool result", async () => {
    const cwd = workspace();
    const host = { async request(method: string, params: unknown) {
      if (method === "tool_preflight") return { allow: true, managed: false, capture: true, reason: null };
      if (method === "tool_result") {
        parseHostApplicationRequest("tool_result", params as never);
        return { operation_id: null, control_frame: { control_frame_sha256: "b".repeat(64) } };
      }
      throw new Error(`Unexpected ${method}`);
    } };
    const result = await executeControlledTool({ host, cwd, controlFrameSha256: "a".repeat(64),
      call: { id: "call-empty", name: "ls", arguments: { path: "." } } });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/empty directory/i);
  });

  it("does not execute a denied mutation", async () => {
    const cwd = workspace();
    const path = resolve(cwd, "file.txt");
    writeFileSync(path, "original");
    const methods: string[] = [];
    const host = { async request(method: string) {
      methods.push(method);
      if (method === "tool_preflight") return { allow: false, managed: false, capture: false, reason: "DENIED" };
      throw new Error(`Unexpected ${method}`);
    } };
    const result = await executeControlledTool({ host, cwd, controlFrameSha256: "a".repeat(64),
      call: { id: "call-1", name: "edit", arguments: { path: "file.txt", oldText: "original", newText: "changed" } } });
    expect(result.isError).toBe(true);
    expect(methods).toEqual(["tool_preflight"]);
    expect(readFileSync(path, "utf8")).toBe("original");
  });

  it("observes a managed exact edit before ending the operation", async () => {
    const cwd = workspace();
    const path = resolve(cwd, "file.txt");
    writeFileSync(path, "original");
    const methods: string[] = [];
    const host = { async request(method: string) {
      methods.push(method);
      if (method === "tool_preflight") return { allow: true, managed: true, capture: true, reason: null };
      if (method === "tool_result") return { operation_id: "OP-1", control_frame: { control_frame_sha256: "b".repeat(64) } };
      if (method === "tool_end") return { status: { active: true }, control_frame: { control_frame_sha256: "c".repeat(64) } };
      throw new Error(`Unexpected ${method}`);
    } };
    const result = await executeControlledTool({ host, cwd, controlFrameSha256: "a".repeat(64),
      call: { id: "call-1", name: "edit", arguments: { path: "file.txt", oldText: "original", newText: "changed" } } });
    expect(result.isError).toBe(false);
    expect(result.controlFrameSha256).toBe("c".repeat(64));
    expect(methods).toEqual(["tool_preflight", "tool_result", "tool_end"]);
    expect(readFileSync(path, "utf8")).toBe("changed");
  });

  it("terminates a validation command's descendants before reporting cancellation", async () => {
    const cwd = workspace();
    const started = join(cwd, "started.txt");
    const late = join(cwd, "late.txt");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "pch-standalone-cancel-fixture", version: "1.0.0", scripts: { test: "node parent.cjs" },
    }));
    writeFileSync(join(cwd, "child.cjs"),
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late'), 700)`);
    writeFileSync(join(cwd, "parent.cjs"), [
      "const { spawn } = require('node:child_process');",
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');`,
      "spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' });",
      "setTimeout(() => {}, 2000);",
    ].join("\n"));
    const host = { async request(method: string) {
      if (method === "tool_preflight") return { allow: true, managed: true, capture: true,
        reason: null, oracle_policy: { timeout_ms: 10_000 } };
      if (method === "tool_result") return { operation_id: "OP-CANCEL",
        control_frame: { control_frame_sha256: "b".repeat(64) } };
      if (method === "tool_end") return { status: { active: true },
        control_frame: { control_frame_sha256: "c".repeat(64) } };
      throw new Error(`Unexpected ${method}`);
    } };
    const abort = new AbortController();
    const pending = executeControlledTool({ host, cwd, controlFrameSha256: "a".repeat(64),
      call: { id: "call-cancel", name: "bash", arguments: { command: "npm test" } }, signal: abort.signal });
    const deadline = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(existsSync(started)).toBe(true);
    abort.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(existsSync(late)).toBe(false);
  }, 20_000);
});
