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
const sessions = new Set<TaskFlowSession>();
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1, cost: null, turns: 1, wallTimeMs: 20 };
const modelFingerprintHmacByRole = Object.fromEntries(workerRoles.map((role) => [role, sha256Hex(`model:${role}`)])) as
  Readonly<Record<typeof workerRoles[number], string>>;

afterEach(() => {
  for (const session of sessions) session.shutdown();
  sessions.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CrashFixture {
  readonly root: string;
  readonly cwd: string;
  readonly dataRoot: string;
  readonly config: CodingHarnessConfig;
  readonly context: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
  readonly session: TaskFlowSession;
  readonly goalId: string;
}

function newSession(
  fixture: Pick<CrashFixture, "dataRoot" | "config" | "context">,
  fault?: "AFTER_PREPARE" | "AFTER_APPLY",
  faultOccurrence = 1,
): TaskFlowSession {
  let matches = 0;
  const session = new TaskFlowSession({
    config: fixture.config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
    dataRoot: fixture.dataRoot, now: () => Date.parse("2026-07-27T07:00:00Z"),
    ...(fault ? { onPatchTransactionFault: (point: "AFTER_PREPARE" | "AFTER_APPLY" | "AFTER_RECOVERY_APPLY") => {
      if (point === fault && ++matches === faultOccurrence) throw new Error(`SIMULATED_CRASH_${point}`);
    } } : {}),
  });
  sessions.add(session);
  session.initialize(fixture.context);
  return session;
}

function crashFixture(label: string, fault: "AFTER_PREPARE" | "AFTER_APPLY", faultOccurrence = 1): CrashFixture {
  const root = mkdtempSync(resolve(tmpdir(), `pch-patch-recovery-${label}-`)); roots.push(root);
  const cwd = resolve(root, "workspace"); mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n");
  const dataRoot = resolve(root, "data");
  const config = JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
  const context = {
    cwd, sessionManager: { getSessionId: () => `SESSION-PATCH-RECOVERY-${label}` }, ui: { notify: () => undefined },
  } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
  const base = { root, cwd, dataRoot, config, context };
  const session = newSession(base, fault, faultOccurrence);
  session.startFromInput("build: recover a bounded patch transaction", context);
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
  return { ...base, session, goalId: session.current()!.goalId };
}

function closeForRestart(session: TaskFlowSession): void {
  session.shutdown();
  sessions.delete(session);
}

describe("PatchTransaction crash recovery", () => {
  it("restores a dispatched CREATE and removes transaction-created parent directories", () => {
    const fixture = crashFixture("RESTORE", "AFTER_APPLY");
    const execution = fixture.session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner") });
    const submitted = fixture.session.submitHarnessWorkerResult({
      execution, output: "Create the generated source.", usage,
      patches: [{ operation: "CREATE", path: "src/generated/new.ts", beforeSha256: null, content: Buffer.from("export const generated = true;\n") }],
    });
    expect(() => fixture.session.integrateHarnessPatch(execution, submitted.patchSet!)).toThrow("SIMULATED_CRASH_AFTER_APPLY");
    expect(existsSync(resolve(fixture.cwd, "src", "generated", "new.ts"))).toBe(true);

    closeForRestart(fixture.session);
    const recovered = newSession(fixture);
    expect(existsSync(resolve(fixture.cwd, "src", "generated", "new.ts"))).toBe(false);
    expect(existsSync(resolve(fixture.cwd, "src", "generated"))).toBe(false);
    expect(recovered.resources()!.authority.readOpenPatchTransactions(fixture.goalId)).toEqual([]);
    expect(recovered.harnessView()).toMatchObject({ shards: [{ status: "REJECTED" }] });
    expect(recovered.current()).toMatchObject({ routeHealth: "H3_REFRAME" });
    expect(recovered.resources()!.authority.verifyHarnessIntegrity()).toMatchObject({ headMismatches: 0 });
  });

  it("stops canonical recovery writes after a lease takeover and leaves authority open", () => {
    const fixture = crashFixture("TAKEOVER", "AFTER_APPLY", 2);
    const secondPath = resolve(fixture.cwd, "src", "second.ts");
    writeFileSync(secondPath, "export const second = 1;\n");
    const execution = fixture.session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner") });
    const firstBefore = readFileSync(resolve(fixture.cwd, "src", "example.ts"));
    const secondBefore = readFileSync(secondPath);
    const submitted = fixture.session.submitHarnessWorkerResult({
      execution, output: "Update two bounded source files.", usage,
      patches: [
        { operation: "MODIFY", path: "src/example.ts", beforeSha256: sha256Hex(firstBefore), content: Buffer.from("export const value = 2;\n") },
        { operation: "MODIFY", path: "src/second.ts", beforeSha256: sha256Hex(secondBefore), content: Buffer.from("export const second = 2;\n") },
      ],
    });
    expect(() => fixture.session.integrateHarnessPatch(execution, submitted.patchSet!)).toThrow("SIMULATED_CRASH_AFTER_APPLY");
    expect(readFileSync(resolve(fixture.cwd, "src", "example.ts"), "utf8")).toContain("value = 2");
    expect(readFileSync(secondPath, "utf8")).toContain("second = 2");
    closeForRestart(fixture.session);

    let now = Date.parse("2026-07-27T07:00:00Z");
    let takeoverPath: string | null = null;
    const recovering = new TaskFlowSession({
      config: fixture.config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: fixture.dataRoot, now: () => now,
      onPatchTransactionFault: (point, path) => {
        if (point !== "AFTER_RECOVERY_APPLY" || takeoverPath !== null) return;
        takeoverPath = path;
        now += fixture.config.execution.lease_ttl_ms + 1;
        recovering.resources()!.authority.acquireLease(fixture.goalId, "SESSION-PATCH-RECOVERY-TAKEOVER-C", fixture.config.execution.lease_ttl_ms);
      },
    });
    sessions.add(recovering);
    expect(() => recovering.initialize(fixture.context)).toThrow(/lease|fenc|owned by another live session/iu);
    expect(takeoverPath).not.toBeNull();
    const restoredCount = [
      readFileSync(resolve(fixture.cwd, "src", "example.ts"), "utf8").includes("value = 1"),
      readFileSync(secondPath, "utf8").includes("second = 1"),
    ].filter(Boolean).length;
    expect(restoredCount).toBe(1);
    expect(recovering.resources()!.authority.readOpenPatchTransactions(fixture.goalId)).toHaveLength(1);
  });

  it("preserves an unrecognized external post-prepare edit and enters reconciliation", () => {
    const fixture = crashFixture("UNKNOWN", "AFTER_PREPARE");
    const execution = fixture.session.startNextHarnessWorker({ modelFingerprintHmacByRole, ownerHmac: sha256Hex("owner") });
    const original = readFileSync(resolve(fixture.cwd, "src", "example.ts"));
    const submitted = fixture.session.submitHarnessWorkerResult({
      execution, output: "Update the bounded source.", usage,
      patches: [{ operation: "MODIFY", path: "src/example.ts", beforeSha256: sha256Hex(original), content: Buffer.from("export const value = 2;\n") }],
    });
    expect(() => fixture.session.integrateHarnessPatch(execution, submitted.patchSet!)).toThrow("SIMULATED_CRASH_AFTER_PREPARE");
    writeFileSync(resolve(fixture.cwd, "src", "example.ts"), "export const value = 99;\n");

    closeForRestart(fixture.session);
    const recovered = newSession(fixture);
    expect(readFileSync(resolve(fixture.cwd, "src", "example.ts"), "utf8")).toContain("value = 99");
    expect(recovered.resources()!.authority.readOpenPatchTransactions(fixture.goalId)).toEqual([]);
    expect(recovered.harnessView()).toMatchObject({ status: "RECONCILING", shards: [{ status: "INTEGRATING" }] });
    expect(recovered.current()).toMatchObject({ routeHealth: "H5_RECONCILE_OR_STOP", blocker: expect.stringContaining("PatchTransaction") });
  });
});
