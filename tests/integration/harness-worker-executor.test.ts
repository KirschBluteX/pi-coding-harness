import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import {
  createSandboxedWorkerTools, MultiWorkerExecutor, type WorkerAgentInput,
} from "../../src/harness/worker/executor.js";
import { resolveWorkerRuntimeMap } from "../../src/harness/worker/runtime-policy.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";
import { approvePendingTaskFlowContract } from "../helpers/task-flow-session.js";

const roots: string[] = [];
const sessions: TaskFlowSession[] = [];
const supervisorRuntime = { provider: "configured", api: "configured-api", model: "configured", thinking_level: "high", context_window: 100_000 };
const workerRuntimes = resolveWorkerRuntimeMap(supervisorRuntime, undefined);
const modelFingerprintHmacByRole = Object.fromEntries(Object.keys(workerRuntimes).map((role) => [role, sha256Hex(`model:${role}`)])) as
  Readonly<Record<keyof typeof workerRuntimes, string>>;
afterEach(() => {
  for (const session of sessions.splice(0)) session.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function managedSession(label: string): {
  session: TaskFlowSession; cwd: string; dataRoot: string; config: CodingHarnessConfig;
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
} {
  const root = mkdtempSync(resolve(tmpdir(), `pch-executor-${label}-`)); roots.push(root);
  const cwd = resolve(root, "workspace"); mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n");
  const config = JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
  const dataRoot = resolve(root, "data");
  const session = new TaskFlowSession({
    config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
    dataRoot, now: () => Date.parse("2026-07-27T07:00:00Z"),
  });
  sessions.push(session);
  const rawContext = { cwd, sessionManager: { getSessionId: () => `SESSION-${label}` }, ui: { notify: () => undefined } };
  const ctx = rawContext as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
  session.initialize(ctx); session.startFromInput("build: update example", ctx);
  session.createHarnessRun({ topology: "MULTI", createdByHostHmac: sha256Hex("host"), configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision") });
  session.submitContract(withAcceptanceV2({
    user_outcomes: ["Example updated"], scope: ["src/example.ts"],
    obligations: [{ key: "updated", priority: "MUST", statement: "Update and verify the example", oracle: { command: "npm test" } }],
    authorization_ceiling: "LOCAL_REVERSIBLE",
  }));
  approvePendingTaskFlowContract(session);
  session.submitRoute({ goal_fit_assessment: passingGoalFitAssessment(), outcomes: ["Update example"], work_cells: [{
    key: "update", outcome: "Update example", obligation_keys: ["updated"], read_roots: ["src/example.ts"], write_roots: ["src/example.ts"],
    effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm test" }, risk: "LOW", reversible: true,
  }], near_horizon: ["update"] });
  session.defineHarnessShards([{ key: "implement", role: "IMPLEMENTER", outcome: "Update the value", read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], oracle: {} }]);
  return { session, cwd, dataRoot, config, ctx };
}

describe("isolated Multi worker executor", () => {
  it("enforces mirror and write-root confinement inside Worker tool implementations", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "pch-worker-tools-")); roots.push(root);
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src", "inside.ts"), "export const inside = true;\n");
    const outside = resolve(root, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "outside\n"); roots.push(outside);
    const tools = createSandboxedWorkerTools(root, ["src"], ["read", "write"]);
    const read = tools.find((tool) => tool.name === "read")!;
    const write = tools.find((tool) => tool.name === "write")!;
    await expect(read.execute("READ-OUTSIDE", { path: outside }, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("escapes its scoped mirror");
    await expect(write.execute("WRITE-OUTSIDE", { path: "outside.ts", content: "bad\n" }, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("outside its write roots");
    await expect(write.execute("WRITE-INSIDE", { path: "src/new.ts", content: "export const value = 1;\n" }, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({ details: undefined });
    expect(readFileSync(resolve(root, "src", "new.ts"), "utf8")).toContain("value = 1");
  });

  it("runs an Implementer in a scoped mirror and integrates only its diff", async () => {
    const { session, cwd } = managedSession("SUCCESS");
    let workerCwd = ""; let tools: readonly string[] = []; let systemPrompt = "";
    const executor = new MultiWorkerExecutor({
      hostSecret: Buffer.alloc(32, 5), now: () => Date.parse("2026-07-27T07:00:01Z"),
      createWorker: async (input: WorkerAgentInput) => {
        workerCwd = input.cwd; tools = input.tools; systemPrompt = input.systemPrompt;
        return {
          async prompt() { writeFileSync(resolve(input.cwd, "src", "example.ts"), "export const value = 2;\n"); },
          async abort() {}, dispose() {}, getLastAssistantText: () => "Updated the value.",
          getSessionStats: () => ({ tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0 }, cost: 0.1, toolCalls: 2 }),
        };
      },
    });
    const result = await executor.runReady(session, workerRuntimes);
    expect(result.integrationResult).toBe("APPLIED");
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(tools).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
    expect(systemPrompt).not.toContain("[PCH-MEMORY-V3");
    expect(existsSync(workerCwd)).toBe(false);
  });

  it("retries one transient SDK factory failure and then stops at the repeated-failure limit", async () => {
    const { session } = managedSession("FACTORY-FAIL");
    const executor = new MultiWorkerExecutor({
      hostSecret: Buffer.alloc(32, 6),
      createWorker: async () => { throw new Error("SDK factory failed"); },
    });
    await expect(executor.runReady(session, workerRuntimes))
      .rejects.toThrow("SDK factory failed");
    expect(session.harnessView()?.shards[0]).toMatchObject({ status: "READY", attemptCount: 1 });
    await expect(executor.runReady(session, workerRuntimes))
      .rejects.toThrow("SDK factory failed");
    expect(session.harnessView()?.shards[0]).toMatchObject({ status: "FAILED", attemptCount: 2 });
  });

  it("times out a stalled worker, aborts it, and atomically requeues within the attempt budget", async () => {
    const { session } = managedSession("TIMEOUT");
    let aborts = 0;
    const executor = new MultiWorkerExecutor({
      hostSecret: Buffer.alloc(32, 7),
      createWorker: async () => ({
        prompt: async () => new Promise<void>(() => undefined),
        async abort() { aborts += 1; }, dispose() {}, getLastAssistantText: () => undefined,
        getSessionStats: () => ({ tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0 }),
      }),
    });
    await expect(executor.runReady(
      session, workerRuntimes,
      undefined, 10,
    )).rejects.toMatchObject({ name: "TimeoutError" });
    expect(aborts).toBeGreaterThan(0);
    expect(session.harnessView()?.shards[0]).toMatchObject({ status: "READY", attemptCount: 1 });
  });

  it("rejects a worker write outside declared roots without touching the user workspace", async () => {
    const { session, cwd } = managedSession("OUT-OF-SCOPE");
    const executor = new MultiWorkerExecutor({
      hostSecret: Buffer.alloc(32, 8),
      createWorker: async (input) => ({
        async prompt() { writeFileSync(resolve(input.cwd, "outside.txt"), "unauthorized\n"); },
        async abort() {}, dispose() {}, getLastAssistantText: () => "Changed an undeclared path.",
        getSessionStats: () => ({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 1 }),
      }),
    });
    await expect(executor.runReady(
      session, workerRuntimes,
    )).rejects.toThrow("outside its write roots");
    expect(existsSync(resolve(cwd, "outside.txt"))).toBe(false);
    expect(session.harnessView()?.shards[0]).toMatchObject({ status: "READY", attemptCount: 1 });
  });

  it("fences an aborted dispatch before a late worker completion can submit a result", async () => {
    const { session, cwd } = managedSession("LATE");
    let release!: () => void;
    const blocked = new Promise<void>((resolvePrompt) => { release = resolvePrompt; });
    const controller = new AbortController();
    const executor = new MultiWorkerExecutor({
      hostSecret: Buffer.alloc(32, 9),
      createWorker: async () => ({
        prompt: async () => blocked, async abort() {}, dispose() {}, getLastAssistantText: () => "late result",
        getSessionStats: () => ({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0 }),
      }),
    });
    const running = executor.runReady(
      session, workerRuntimes,
      controller.signal, 10_000,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    release();
    await Promise.resolve();
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(session.harnessView()?.shards[0]).toMatchObject({ status: "READY", attemptCount: 1 });
  });

  it("atomically fences and requeues an orphaned RUNNING worker when the Host restarts", () => {
    const fixture = managedSession("HOST-RESTART");
    const execution = fixture.session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("old-host"),
    });
    expect(fixture.session.harnessView()).toMatchObject({
      unresolvedWorkerRunIds: [execution.worker.worker_run_id], shards: [{ status: "RUNNING" }],
    });
    fixture.session.shutdown();

    const resumed = new TaskFlowSession({
      config: fixture.config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: fixture.dataRoot, now: () => Date.parse("2026-07-27T07:00:01Z"),
    });
    sessions.push(resumed);
    resumed.initialize(fixture.ctx);
    const recovered = resumed.createHarnessRun({
      topology: "MULTI", createdByHostHmac: sha256Hex("host"),
      configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision"),
    });
    expect(recovered).toMatchObject({ unresolvedWorkerRunIds: [], shards: [{ status: "READY", attemptCount: 1 }] });
    expect(() => resumed.submitHarnessWorkerResult({
      execution, output: "late", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, turns: 0, wallTimeMs: 0 }, patches: [],
    })).toThrow();
  });

  it("does not requeue an orphaned Worker until pending active-Goal input is classified", () => {
    const fixture = managedSession("HOST-RESTART-PENDING-INPUT");
    const execution = fixture.session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("old-host"),
    });
    expect(fixture.session.startFromInput("Explain the current Worker evidence.", fixture.ctx)).toBeNull();
    const pending = fixture.session.resources()!.authority
      .readPendingActiveGoalUserTurns(fixture.session.current()!.goalId)[0]!;
    fixture.session.shutdown();

    const resumed = new TaskFlowSession({
      config: fixture.config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: fixture.dataRoot, now: () => Date.parse("2026-07-27T07:00:01Z"),
    });
    sessions.push(resumed);
    resumed.initialize(fixture.ctx);
    expect(resumed.createHarnessRun({
      topology: "MULTI", createdByHostHmac: sha256Hex("host"),
      configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision"),
    })).toMatchObject({
      unresolvedWorkerRunIds: [execution.worker.worker_run_id],
      shards: [{ status: "RUNNING", attemptCount: 1 }],
    });

    resumed.classifyActiveGoalInput({
      user_turn_id: pending.user_turn_id,
      expected_user_turn_sha256: pending.record_sha256,
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
    });
    expect(resumed.harnessView()).toMatchObject({
      unresolvedWorkerRunIds: [],
      shards: [{ status: "READY", attemptCount: 1 }],
    });
  });

  it("fences rather than requeues an orphaned Worker after a material active-Goal change", () => {
    const fixture = managedSession("HOST-RESTART-MATERIAL-INPUT");
    const execution = fixture.session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("old-host"),
    });
    expect(fixture.session.startFromInput("Also update the adjacent parser.", fixture.ctx)).toBeNull();
    expect(fixture.session.startFromInput("What evidence currently covers the main source?", fixture.ctx)).toBeNull();
    const authority = fixture.session.resources()!.authority;
    const goalId = fixture.session.current()!.goalId;
    const [materialTurn, discussionTurn] = authority.readPendingActiveGoalUserTurns(goalId);
    if (!materialTurn || !discussionTurn) throw new TypeError("Expected two pending active-Goal turns");
    const workCell = authority.readTaskFlowPlanV2(goalId)!.subjects.find((subject) => subject.kind === "WORK_CELL")!;
    fixture.session.shutdown();

    const resumed = new TaskFlowSession({
      config: fixture.config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: fixture.dataRoot, now: () => Date.parse("2026-07-27T07:00:01Z"),
    });
    sessions.push(resumed);
    resumed.initialize(fixture.ctx);
    expect(resumed.createHarnessRun({
      topology: "MULTI", createdByHostHmac: sha256Hex("host"),
      configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision"),
    })).toMatchObject({ unresolvedWorkerRunIds: [execution.worker.worker_run_id] });

    resumed.classifyActiveGoalInput({
      user_turn_id: materialTurn.user_turn_id,
      expected_user_turn_sha256: materialTurn.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "SCOPE",
      changed_subjects: [{ kind: workCell.kind, id: workCell.id }],
    });
    expect(resumed.current()).toMatchObject({ blocker: expect.stringMatching(/typed classification/i) });
    expect(resumed.harnessView()).toMatchObject({
      unresolvedWorkerRunIds: [execution.worker.worker_run_id],
      shards: [{ status: "RUNNING", attemptCount: 1 }],
    });
    resumed.classifyActiveGoalInput({
      user_turn_id: discussionTurn.user_turn_id,
      expected_user_turn_sha256: discussionTurn.record_sha256,
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
    });
    expect(resumed.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    expect(resumed.harnessView()).toMatchObject({
      unresolvedWorkerRunIds: [],
      shards: [{ status: "FAILED", attemptCount: 1 }],
    });
  });

  it("rejects compaction while authority still owns a RUNNING worker", () => {
    const { session } = managedSession("COMPACTION-EXCLUSION");
    const execution = session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("host"),
    });
    expect(() => session.prepareCompaction()).toThrow("zero pending Operations and worker runs");
    session.failHarnessWorker(execution, new Error("test cleanup"), {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, turns: 0, wallTimeMs: 0,
    }, "ABORTED");
  });
});
