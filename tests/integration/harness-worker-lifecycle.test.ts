import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { workerRoles } from "../../src/harness/domain.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";

const roots: string[] = [];
const sessions: TaskFlowSession[] = [];
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1, cost: null, turns: 1, wallTimeMs: 20 };
const modelFingerprintHmacByRole = Object.fromEntries(workerRoles.map((role) => [role, sha256Hex(`model:${role}`)])) as
  Readonly<Record<typeof workerRoles[number], string>>;

afterEach(() => {
  for (const session of sessions.splice(0)) session.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function patchSession(label: string): { readonly session: TaskFlowSession; readonly cwd: string } {
  const root = mkdtempSync(resolve(tmpdir(), `pch-patch-${label}-`)); roots.push(root);
  const cwd = resolve(root, "workspace"); mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n");
  writeFileSync(resolve(cwd, "src", "remove.ts"), "remove me\n");
  writeFileSync(resolve(cwd, "src", "block"), "parent is initially a file\n");
  const config = JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
  const session = new TaskFlowSession({
    config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
    dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-27T06:30:00Z"),
  });
  sessions.push(session);
  const ctx = {
    cwd, sessionManager: { getSessionId: () => `SESSION-PATCH-${label}` }, ui: { notify: () => undefined },
  } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
  session.initialize(ctx);
  session.startFromInput("build: apply a bounded patch set", ctx);
  session.createHarnessRun({
    topology: "MULTI", createdByHostHmac: sha256Hex("host"),
    configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision"),
  });
  session.submitContract({
    user_outcomes: ["The source patch is applied"], scope: ["src"],
    obligations: [{ key: "patched", priority: "MUST", statement: "Apply and verify the source patch", oracle: { command: "npm test" } }],
    authorization_ceiling: "LOCAL_REVERSIBLE",
  });
  session.submitRoute({ outcomes: ["Apply the source patch"], work_cells: [{
    key: "patch", outcome: "Apply files under src", obligation_keys: ["patched"], read_roots: ["src"], write_roots: ["src"],
    effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm test" }, risk: "LOW", reversible: true,
  }], near_horizon: ["patch"] });
  session.defineHarnessShards([{
    key: "implement", role: "IMPLEMENTER", outcome: "Apply the bounded patch",
    read_roots: ["src"], write_roots: ["src"], oracle: {},
  }]);
  return { session, cwd };
}

describe("Coding Harness worker lifecycle", () => {
  it("rejects an out-of-shard patch before persisting Worker output or content", () => {
    const { session } = patchSession("SCOPE-GATE");
    const execution = session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner") });
    expect(() => session.submitHarnessWorkerResult({
      execution, output: "Attempted an out-of-scope patch.", usage,
      patches: [{ operation: "CREATE", path: "outside.ts", beforeSha256: null, content: Buffer.from("forbidden\n") }],
    })).toThrow(/outside its shard write scope before persistence/u);
    expect(existsSync(resolve(session.workspaceRoot(), "outside.ts"))).toBe(false);
  });

  it("serially commits CREATE, MODIFY and DELETE entries from one PatchSet", () => {
    const { session, cwd } = patchSession("MIXED");
    const execution = session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner"),
    });
    const original = readFileSync(resolve(cwd, "src", "example.ts"));
    const removed = readFileSync(resolve(cwd, "src", "remove.ts"));
    const submitted = session.submitHarnessWorkerResult({
      execution, output: "Applied mixed file operations.", usage,
      patches: [
        { operation: "MODIFY", path: "src/example.ts", beforeSha256: sha256Hex(original), content: Buffer.from("export const value = 2;\n") },
        { operation: "DELETE", path: "src/remove.ts", beforeSha256: sha256Hex(removed), content: null },
        { operation: "CREATE", path: "src/new.ts", beforeSha256: null, content: Buffer.from("export const added = true;\n") },
      ],
    });
    const receipt = session.integrateHarnessPatch(execution, submitted.patchSet!);
    expect(receipt).toMatchObject({ result: "APPLIED", conflict_paths: [] });
    expect(receipt.operation_ids).toHaveLength(3);
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toContain("value = 2");
    expect(existsSync(resolve(cwd, "src", "remove.ts"))).toBe(false);
    expect(readFileSync(resolve(cwd, "src", "new.ts"), "utf8")).toContain("added = true");
  });

  it("rejects an internally conflicting patch before any workspace mutation", () => {
    const { session, cwd } = patchSession("UNKNOWN");
    const execution = session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner"),
    });
    const block = readFileSync(resolve(cwd, "src", "block"));
    const submitted = session.submitHarnessWorkerResult({
      execution, output: "Patch with an injected filesystem conflict.", usage,
      patches: [
        { operation: "DELETE", path: "src/block", beforeSha256: sha256Hex(block), content: null },
        { operation: "CREATE", path: "src/block/child.ts", beforeSha256: null, content: Buffer.from("child\n") },
        { operation: "CREATE", path: "src/block/child.ts/grandchild.ts", beforeSha256: null, content: Buffer.from("grandchild\n") },
      ],
    });
    const receipt = session.integrateHarnessPatch(execution, submitted.patchSet!);
    expect(receipt.result).toBe("CONFLICT");
    expect(receipt.conflict_paths).toEqual(["src/block", "src/block/child.ts", "src/block/child.ts/grandchild.ts"]);
    expect(session.harnessView()).toMatchObject({ shards: [{ status: "REJECTED" }] });
    expect(readFileSync(resolve(cwd, "src", "block"))).toEqual(block);
  });

  it("invalidates the stale route when canonical files conflict with a worker baseline", () => {
    const { session, cwd } = patchSession("CONFLICT");
    const execution = session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner") });
    const original = readFileSync(resolve(cwd, "src", "example.ts"));
    const submitted = session.submitHarnessWorkerResult({
      execution, output: "Prepared the bounded update.", usage,
      patches: [{ operation: "MODIFY", path: "src/example.ts", beforeSha256: sha256Hex(original), content: Buffer.from("export const value = 2;\n") }],
    });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 3;\n");
    const receipt = session.integrateHarnessPatch(execution, submitted.patchSet!);
    expect(receipt).toMatchObject({ result: "CONFLICT", conflict_paths: ["src/example.ts"] });
    expect(session.current()).toMatchObject({ routeHealth: "H3_REFRAME" });
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toContain("value = 3");
  });

  it("closes an analysis shard and deterministically integrates a scoped patch shard", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pch-worker-")); roots.push(root);
    const cwd = resolve(root, "workspace"); mkdirSync(resolve(cwd, "src"), { recursive: true });
    const original = "export const value = 1;\n";
    writeFileSync(resolve(cwd, "src", "example.ts"), original);
    const config = JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
    const session = new TaskFlowSession({
      config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-27T06:00:00Z"),
    });
    sessions.push(session);
    const ctx = {
      cwd, sessionManager: { getSessionId: () => "SESSION-WORKER-1" }, ui: { notify: () => undefined },
    } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
    session.initialize(ctx);
    session.startFromInput("build: update the bounded example", ctx);
    session.createHarnessRun({ topology: "MULTI", createdByHostHmac: sha256Hex("host"), configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision") });
    session.submitContract({
      user_outcomes: ["The example is updated"], scope: ["src/example.ts"],
      obligations: [{ key: "updated", priority: "MUST", statement: "The file is updated and verified", oracle: { command: "npm test" } }],
      authorization_ceiling: "LOCAL_REVERSIBLE",
    });
    session.submitRoute({
      outcomes: ["Update the file"], work_cells: [{
        key: "update", outcome: "Update src/example.ts", obligation_keys: ["updated"], read_roots: ["src/example.ts"],
        write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm test" }, risk: "LOW", reversible: true,
      }], near_horizon: ["update"],
    });
    session.defineHarnessShards([
      { key: "inspect", role: "EXPLORER", outcome: "Inspect the current file", read_roots: ["src/example.ts"], write_roots: [], oracle: {} },
      { key: "implement", role: "IMPLEMENTER", outcome: "Implement the bounded update", dependencies: ["inspect"],
        read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], oracle: { command: "npm test" } },
    ]);

    const explorer = session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner-1") });
    expect(explorer.worker.role).toBe("EXPLORER");
    const explored = session.submitHarnessWorkerResult({ execution: explorer, output: "The file is bounded.", usage, patches: [] });
    expect(explored).toMatchObject({ integrated: true });

    const implementer = session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner-2") });
    expect(implementer.worker.role).toBe("IMPLEMENTER");
    expect(implementer.packet.evidence_refs).toContain(explored.result.artifact_sha256);
    expect(implementer.dependencyEvidence).toEqual([expect.objectContaining({
      role: "EXPLORER", resultKind: "ANALYSIS", artifactSha256: explored.result.artifact_sha256,
      trust: "UNVERIFIED", content: "The file is bounded.",
    })]);
    const submitted = session.submitHarnessWorkerResult({
      execution: implementer, output: "Updated the value.", usage,
      patches: [{ operation: "MODIFY", path: "src/example.ts", beforeSha256: sha256Hex(original), content: Buffer.from("export const value = 2;\n") }],
    });
    expect(submitted.patchSet).not.toBeNull();
    const receipt = session.integrateHarnessPatch(implementer, submitted.patchSet!);
    expect(receipt.result).toBe("APPLIED");
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(session.harnessView()).toMatchObject({ nextReadyShardId: null, shards: [{ status: "SUCCEEDED" }, { status: "SUCCEEDED" }] });
  });
});
