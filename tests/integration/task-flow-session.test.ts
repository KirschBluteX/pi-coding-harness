import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import { idFromSha256 } from "../../src/foundation/ids.js";
import { sealTaskFlowRecord, type TaskDecisionEntryRecord } from "../../src/task-flow/domain.js";

function config(): CodingHarnessConfig {
  return JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
}

function context(cwd: string, sessionId: string): Pick<ExtensionContext, "cwd" | "sessionManager" | "ui"> {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    ui: { notify: () => undefined } as unknown as ExtensionContext["ui"],
  };
}

const contract = {
  user_outcomes: ["The local file is correct and verified"],
  scope: ["src/example.ts"],
  non_goals: ["No external deployment"],
  constraints: ["Keep the change local"],
  obligations: [{
    key: "verified-output", priority: "MUST" as const,
    statement: "The final workspace passes npm test", oracle: { command: "npm test" },
  }],
  authorization_ceiling: "LOCAL_REVERSIBLE" as const,
};

const route = {
  outcomes: ["The bounded change is implemented"],
  work_cells: [{
    key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
    read_roots: ["src/example.ts"], write_roots: ["src/example.ts"],
    effect_classes: ["LOCAL_REVERSIBLE" as const], oracle: { command: "npm test" },
    risk: "LOW" as const, reversible: true,
  }],
  near_horizon: ["bounded-change"],
};

describe("Task Flow live session", () => {
  const roots: string[] = [];
  const sessions: TaskFlowSession[] = [];

  afterEach(() => {
    for (const session of sessions.splice(0)) session.shutdown();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(label: string, now: () => number = () => Date.parse("2026-07-24T12:00:00.000Z")) {
    const root = mkdtempSync(resolve(tmpdir(), `pch-task-flow-${label}-`));
    roots.push(root);
    const cwd = resolve(root, "workspace");
    mkdirSync(resolve(cwd, "src"), { recursive: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run",
        "test:runtime": "vitest run tests/runtime",
        "test:types": "tsc --noEmit",
        "test:ts:core": "vitest run tests/core",
        "bench:primary": "vitest bench tests/primary",
        "bench:regression": "vitest bench tests/regression",
        "bench:holdout": "vitest bench tests/holdout",
      },
    }), "utf8");
    const session = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now,
    });
    sessions.push(session);
    const ctx = context(cwd, `SESSION-${label}`);
    session.initialize(ctx);
    return { root, cwd, session, ctx };
  }

  function admit(session: TaskFlowSession, cwd: string, ctx: ReturnType<typeof context>): void {
    expect(session.startFromInput("build: 修改 src/example.ts 并运行测试", ctx)).toMatchObject({ action: "transform" });
    session.submitBuild(contract, route);
    expect(session.current()).toMatchObject({ mode: "BUILD", phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-1", toolName: "write", input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    expect(session.observeToolResult("WRITE-1", false, "Wrote src/example.ts")).toMatch(/PCH_OPERATION_COMMITTED/u);
  }

  function validate(session: TaskFlowSession, cwd: string, callId = "VALIDATE-1"): string {
    expect(session.prepareToolOperation({ toolCallId: callId, toolName: "bash", input: { command: "npm test" }, cwd }))
      .toMatchObject({ allow: true, managed: true });
    const feedback = session.observeToolResult(callId, false, "tests passed")!;
    const operationId = /operation=([A-Z][A-Z0-9_:-]*)/u.exec(feedback)?.[1];
    expect(operationId).toBeTruthy();
    return operationId!;
  }

  function createHarnessRun(session: TaskFlowSession, label: string) {
    return session.createHarnessRun({
      topology: "SINGLE",
      createdByHostHmac: hmacSha256Hex("test-host", label),
      configSha256: hmacSha256Hex("test-config", label),
      decisionSha256: hmacSha256Hex("test-decision", label),
    });
  }

  function controlDecision(session: TaskFlowSession, action: "PAUSE" | "RESUME" | "CANCEL"): TaskDecisionEntryRecord {
    const status = session.current()!;
    const authority = session.resources()!.authority;
    const view = authority.readTaskFlowView(status.goalId)!;
    const reasonSha256 = sha256Hex(`test-${action}`);
    const selection = {
      action, reason_sha256: reasonSha256, prior_status: view.status, prior_next_action: view.nextActionCode,
    };
    const bindingSha256 = canonicalJsonSha256({
      goal: status.goalId, selection, version: authority.readTaskFlowGoalVersion(status.goalId),
    });
    return sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1,
      decision_entry_id: idFromSha256("DECISION", sha256Hex(`${bindingSha256}\0${action}`)),
      goal_id: status.goalId, contract_id: view.contract?.contract_id ?? null,
      route_id: view.route?.route_id ?? null, decision_key: "USER_CONTROL", authority_actor: "USER",
      materiality: action === "CANCEL" ? "HIGH" : "MEDIUM", reversible: action !== "CANCEL",
      privacy_related: false, question_hmac: hmacSha256Hex("test-workspace", `USER_CONTROL:${action}`),
      recommendation: { recommended: action }, selection, state: "RESOLVED",
      binding_sha256: bindingSha256, created_at_ms: Date.parse("2026-07-24T12:00:00.000Z"), expires_at_ms: null,
    }, "record_sha256");
  }

  it("executes one bounded write, proves fresh acceptance and closes only through evidence", () => {
    const { session, cwd, ctx } = fixture("SUCCESS");
    admit(session, cwd, ctx);
    validate(session, cwd);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("clamps an oversized model timeout to the authority validation budget", () => {
    const { session, cwd, ctx } = fixture("ORACLE-TIMEOUT-CLAMP");
    admit(session, cwd, ctx);
    expect(session.prepareToolOperation({
      toolCallId: "VALIDATE-LONG-HINT", toolName: "bash",
      input: { command: "npm test", timeout: 1_200 }, cwd,
    })).toMatchObject({ allow: true, managed: true, oracle_policy: { timeout_ms: 900_000 } });
  });

  it("allows Single Supervisor reads across the frozen Route but keeps writes current-cell scoped", () => {
    const { session, cwd, ctx } = fixture("ROUTE-READ-SCOPE");
    writeFileSync(resolve(cwd, "src", "near.ts"), "export const near = true;\n", "utf8");
    session.startFromInput("build: update src/example.ts and src/near.ts and verify", ctx);
    session.submitContract({
      ...contract,
      user_outcomes: ["The current change is correct", "The near change is correct"],
      scope: ["src/example.ts", "src/near.ts"],
      obligations: [
        { key: "current", priority: "MUST", statement: "Current source is correct", oracle: { command: "npm test" } },
        { key: "near", priority: "MUST", statement: "Near source is correct", oracle: { command: "npm test" } },
      ],
    });
    session.submitRoute({
      outcomes: ["Update both bounded files"],
      work_cells: [
        { ...route.work_cells[0]!, key: "current", obligation_keys: ["current"] },
        {
          ...route.work_cells[0]!, key: "near", obligation_keys: ["near"], dependencies: ["current"],
          read_roots: ["src/near.ts"], write_roots: ["src/near.ts"],
        },
      ],
    });
    expect(session.prepareToolOperation({
      toolCallId: "READ-NEAR", toolName: "read", input: { path: "src/near.ts" }, cwd,
    })).toMatchObject({ allow: true, managed: false });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-NEAR", toolName: "write", input: { path: "src/near.ts", content: "changed\n" }, cwd,
    })).toMatchObject({ allow: false, reason: expect.stringMatching(/current WorkCell write scope/u) });
  });

  it("persists live PRD/FULL intake classification instead of the former TASK_SPEC default", () => {
    const { session, cwd, ctx } = fixture("LIVE-PRD-CLASSIFICATION");
    const objective = "Implement a new Node.js upload feature across multiple Axios modules. Target users use FormData. Measurable outcomes: fields remain exact; Blob type and length remain exact; legacy FormData remains compatible. Scope: adapter, stream helper, environment selection, utilities, browser mapping, package metadata, and focused tests. User flow: post FormData with a Blob to a local server.";
    expect(session.startFromInput(`build: ${objective}`, ctx)).toMatchObject({ action: "transform" });
    const resources = session.resources()!;
    const workspaceHmac = hmacSha256Hex(resources.workspaceSecret, cwd.replaceAll("\\", "/").toLowerCase().normalize("NFC"));
    const workspaceId = idFromSha256("WS", workspaceHmac);
    const goal = resources.authority.readGoalForSession(workspaceId, "SESSION-LIVE-PRD-CLASSIFICATION");
    expect(goal).toMatchObject({ requirementProfile: "PRD", planningDepth: "FULL" });
    expect(resources.authority.readActiveTaskFlowGoal(workspaceId, "SESSION-LIVE-PRD-CLASSIFICATION"))
      .toMatchObject({ acceptanceFacetMinimum: 3 });
    expect(session.workflowPrompt()).toContain("AcceptanceFacetMinimum=3");
    expect(session.current()).toMatchObject({ mode: "PLAN", phase: "CONTRACTING" });
  });

  it("rejects zero-mutation closure for an explicit fix, then closes after an edit and fresh validation", () => {
    const { session, cwd, ctx } = fixture("MUTATION-CLOSURE");
    const objective = "Fix hooks/src/index.js: every remaining cleanup must still run, the error must reach the boundary, and the throwing cleanup must not run again.";
    expect(session.startFromInput(`build: ${objective}`, ctx)).toMatchObject({ action: "transform" });
    const atomicContract = {
      ...contract,
      user_outcomes: ["Remaining cleanup runs", "The error reaches the boundary", "Throwing cleanup is not repeated"],
      obligations: [
        { key: "remaining-cleanup", priority: "MUST" as const, statement: "Remaining cleanup runs", oracle: { commands: ["npm test"] } },
        { key: "error-boundary", priority: "MUST" as const, statement: "The error reaches the boundary", oracle: { commands: ["npm test"] } },
        { key: "no-repeat", priority: "MUST" as const, statement: "Throwing cleanup is not repeated", oracle: { commands: ["npm test"] } },
      ],
    };
    const atomicRoute = {
      ...route,
      work_cells: [{
        ...route.work_cells[0]!, obligation_keys: ["remaining-cleanup", "error-boundary", "no-repeat"],
        oracle: { commands: ["npm test"] },
      }],
    };
    session.submitBuild(atomicContract, atomicRoute);
    expect(() => validate(session, cwd, "VALIDATE-BEFORE-EDIT")).toThrow(/PCH_MUTATION_REQUIRED/u);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.prepareToolOperation({
      toolCallId: "EDIT-AFTER-GATE", toolName: "edit",
      input: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    expect(session.observeToolResult("EDIT-AFTER-GATE", false, "edited")).toMatch(/PCH_OPERATION_COMMITTED/u);
    validate(session, cwd, "VALIDATE-AFTER-EDIT");
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("recovers a Goal left at CLOSE_GOAL after the WorkCell commit", () => {
    const { session, cwd, ctx } = fixture("CLOSE-RETRY");
    admit(session, cwd, ctx);
    const internal = session as unknown as { closeSucceededGoal(): void };
    const originalClose = internal.closeSucceededGoal.bind(session);
    const close = vi.spyOn(internal, "closeSucceededGoal")
      .mockImplementationOnce(() => { throw new Error("simulated closure crash"); })
      .mockImplementation(originalClose);
    expect(() => validate(session, cwd)).toThrow("simulated closure crash");
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "CLOSE_GOAL" });
    expect(session.completeWork()).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    close.mockRestore();
  });

  it("revalidates split MUST obligations on one final baseline and closes without replanning", () => {
    const { session, cwd, ctx } = fixture("TERMINAL-CLOSURE");
    session.startFromInput("build: update runtime and type behavior", ctx);
    session.submitBuild({
      ...contract,
      obligations: [
        { key: "runtime", priority: "MUST", statement: "Runtime behavior passes", oracle: { command: "npm run test:runtime" } },
        { key: "types", priority: "MUST", statement: "Type behavior passes", oracle: { command: "npm run test:types" } },
      ],
    }, {
      outcomes: ["Runtime and type behavior are verified"],
      work_cells: [
        {
          ...route.work_cells[0]!, key: "runtime", obligation_keys: ["runtime"],
          oracle: { command: "npm run test:runtime" },
        },
        {
          ...route.work_cells[0]!, key: "types", obligation_keys: ["types"], dependencies: ["runtime"],
          oracle: { command: "npm run test:types" },
        },
      ],
    });
    const run = (id: string, command: string): string => {
      expect(session.prepareToolOperation({ toolCallId: id, toolName: "bash", input: { command }, cwd }))
        .toMatchObject({ allow: true, managed: true });
      return session.observeToolResult(id, false, `${command} passed`)!;
    };
    run("RUNTIME-LOCAL", "npm run test:runtime");
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(run("RUNTIME-FINAL", "npm run test:runtime")).toMatch(/remaining validation commands=1/u);
    expect(run("TYPES-FINAL", "npm run test:types")).toMatch(/Goal .* closed/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("keeps terminal Goals immutable under lifecycle controls", () => {
    const { session, cwd, ctx } = fixture("TERMINAL-CONTROL");
    admit(session, cwd, ctx);
    validate(session, cwd);
    expect(() => session.mutate("replan", "try to reopen")).toThrow(/Terminal Task Flow Goal/u);
    expect(() => session.mutate("cancel", "try to rewrite terminal state")).toThrow(/Terminal Task Flow Goal/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("continues route revisions after a GoalContract revision clears the route head", () => {
    const { session, ctx } = fixture("ROUTE-AFTER-CONTRACT");
    session.startFromInput("build: update src/example.ts and verify", ctx);
    session.submitBuild(contract, route);
    session.reviseRequirement("SCOPE", "Refine the frozen scope before execution");
    session.submitContract({ ...contract, scope: ["src/example.ts", "src/extra.ts"] });
    const result = session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "revised-bounded-change" }],
      near_horizon: ["revised-bounded-change"],
    });
    expect(result).toMatch(/ r2 frozen/u);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
  });

  it("allows qualified multi-segment npm validation scripts without widening shell authority", () => {
    const { session, cwd, ctx } = fixture("NPM-SCRIPT");
    session.startFromInput("build: update src/example.ts and run the core tests", ctx);
    const scriptContract = {
      ...contract,
      obligations: [{ ...contract.obligations[0]!, oracle: { command: "npm run test:ts:core" } }],
    };
    const scriptRoute = {
      ...route,
      work_cells: [{ ...route.work_cells[0]!, oracle: { command: "npm run test:ts:core" } }],
    };
    session.submitBuild(scriptContract, scriptRoute);
    expect(session.prepareToolOperation({
      toolCallId: "UNSAFE-NPM", toolName: "bash", input: { command: "npm run test:ts:core; whoami" }, cwd,
    })).toMatchObject({ allow: false });
    expect(session.prepareToolOperation({
      toolCallId: "UNRELATED-NPM", toolName: "bash", input: { command: "npm run release:prod" }, cwd,
    })).toMatchObject({ allow: false });
    expect(session.prepareToolOperation({
      toolCallId: "SAFE-NPM", toolName: "bash", input: { command: "npm run test:ts:core" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
  });

  it("freezes a contract from an attached multiline task without discarding its details", () => {
    const { session, ctx } = fixture("ATTACHED-TASK");
    const details = `build: Update src/example.ts and run tests.\n\nAcceptance:\n${"Keep this detailed instruction. ".repeat(30)}`;
    const started = session.startFromInput(`<file name="X:\\work\\TASK.md">\n${details}\n</file>`, ctx);
    expect(started).toMatchObject({ action: "transform" });
    if (!started || started.action !== "transform") throw new Error("attached task was not transformed");
    expect(started.text).toContain("Acceptance:\n");
    expect(session.current()?.objective).not.toMatch(/[\r\n]/u);
    expect(session.current()?.objective.length).toBeLessThanOrEqual(512);
    expect(() => session.submitContract(contract)).not.toThrow();
  });

  it("exposes bounded proposal shapes only while contract submission is pending", () => {
    const { session, ctx } = fixture("PROPOSAL-GUIDE");
    expect(session.startFromInput("build: 修改 src/example.ts 并运行测试", ctx)).toMatchObject({ action: "transform" });
    expect(session.workflowPrompt()).toContain("GoalContract proposal shape");
    expect(session.workflowPrompt()).toContain("\"obligations\"");
    expect(session.workflowPrompt()).toContain("Route proposal shape");
    expect(session.workflowPrompt()).toContain('"status":"SUPPORTED|OPEN|INVALIDATED"');
    expect(session.workflowPrompt()).toContain('"disposition":"SELECTED|RESERVE|REJECTED"');
    expect(session.workflowPrompt()).toContain("do not invent fields such as evidence");
    expect(session.workflowPrompt()).toContain("oracle.commands only separates individually allowed commands");
    expect(session.workflowPrompt()).toContain('"commands":["<exact local command>"]');
    expect(session.workflowPrompt()).toContain("do not probe PI_MODEL, PI_SESSION");
    expect(session.workflowPrompt()).toContain("Do not add acceptance_policy.performance_contract unless");
    session.submitBuild(contract, route);
    expect(session.workflowPrompt()).not.toContain("GoalContract proposal shape");
    expect(session.workflowPrompt()).not.toContain("Route proposal shape");
  });

  it("instructs BUILD to coalesce same-file edits and stop after the final oracle", () => {
    const { session, cwd, ctx } = fixture("WORKFLOW-EDIT-GUIDANCE");
    admit(session, cwd, ctx);
    expect(session.workflowPrompt()).toContain("Merge all edits to the same file in one turn into one edit call");
    expect(session.workflowPrompt()).toContain("reread before any later edit to that path");
    expect(session.workflowPrompt()).toContain("run every Oracle command exactly as shown");
    expect(session.workflowPrompt()).toContain("then stop all tool calls");
  });

  it("rejects scope escape and denies further writes after automatic validation finalization", () => {
    const { root, session, cwd, ctx } = fixture("FRESHNESS");
    admit(session, cwd, ctx);
    writeFileSync(resolve(root, "outside-secret.txt"), "secret", "utf8");
    expect(session.prepareToolOperation({
      toolCallId: "READ-ESCAPE", toolName: "read", input: { path: resolve(root, "outside-secret.txt") }, cwd,
    })).toMatchObject({ allow: false, reason: "PCH denies reads outside the active workspace." });
    expect(session.prepareToolOperation({
      toolCallId: "READ-OUT-OF-CELL", toolName: "read", input: { path: "." }, cwd,
    })).toMatchObject({ allow: false, reason: "Read target is outside the frozen Route read scope." });
    const rejected = session.prepareToolOperation({
      toolCallId: "ESCAPE", toolName: "write", input: { path: "outside.ts", content: "bad" }, cwd,
    });
    expect(rejected.allow).toBe(false);
    expect(rejected.reason).toMatch(/outside.*write scope/iu);
    validate(session, cwd);
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-2", toolName: "write", input: { path: "src/example.ts", content: "export const value = 3;\n" }, cwd,
    })).toMatchObject({ allow: false });
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED" });
  });

  it("recovers an unknown write outcome by local readback without repeating the write", () => {
    const { root, cwd, session, ctx } = fixture("RECONCILE");
    admit(session, cwd, ctx);
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-UNKNOWN", toolName: "write", input: { path: "src/example.ts", content: "export const value = 4;\n" }, cwd,
    })).toMatchObject({ allow: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 4;\n", "utf8");
    session.endToolOperation("WRITE-UNKNOWN", false, "");
    expect(session.current()).toMatchObject({ phase: "RECONCILING", nextAction: "RECONCILE_OPERATION" });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-RECONCILE"));
    expect(resumed.current()).toMatchObject({ phase: "RECONCILING" });
    expect(resumed.reconcileOperations()).toMatch(/=APPLIED/u);
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
  });

  it("blocks a takeover owner from preparing new mutation until the durable unresolved operation is reconciled", () => {
    let now = Date.parse("2026-07-24T12:00:00.000Z");
    const { root, cwd, session, ctx } = fixture("UNRESOLVED-TAKEOVER", () => now);
    expect(session.startFromInput("build: update src/example.ts and run tests", ctx)).toMatchObject({ action: "transform" });
    session.submitBuild(contract, route);
    expect(session.prepareToolOperation({
      toolCallId: "TAKEOVER-PREPARED", toolName: "write",
      input: { path: "src/example.ts", content: "export const value = 8;\n" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    now += config().execution.lease_ttl_ms + 1;
    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => now,
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-UNRESOLVED-TAKEOVER-B"));
    expect(resumed.current()).toMatchObject({ blocker: "Operation outcome requires reconciliation." });
    const admission = resumed.prepareToolOperation({
      toolCallId: "TAKEOVER-SECOND", toolName: "write",
      input: { path: "src/example.ts", content: "export const value = 9;\n" }, cwd,
    });
    expect(admission).toMatchObject({ allow: false, managed: false });
    expect(admission.reason).toMatch(/reconcile.*unresolved operation/iu);
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 1;\n");
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 8;\n", "utf8");
    expect(resumed.reconcileOperations()).toMatch(/=APPLIED/u);
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK", blocker: null });
  });

  it("persists pause, resume and cancel as Task Flow authority transitions", () => {
    const { session, cwd, ctx } = fixture("CONTROL");
    admit(session, cwd, ctx);
    createHarnessRun(session, "CONTROL");
    expect(session.mutate("pause", "user pause")).toMatch(/pause committed/u);
    expect(session.current()).toMatchObject({ phase: "WAITING_USER", nextAction: "RESUME" });
    expect(session.harnessView()).toMatchObject({ status: "PAUSED" });
    expect(session.mutate("resume", "continue")).toMatch(/resume committed/u);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.harnessView()).toMatchObject({ status: "ACTIVE" });
    expect(session.mutate("cancel", "stop")).toMatch(/cancel committed/u);
    expect(session.current()).toMatchObject({ phase: "CANCELED", nextAction: "NONE" });
    expect(session.harnessView()).toMatchObject({ status: "CANCELED" });
    expect(session.startFromInput("build: create the next bounded local file", ctx)).toMatchObject({ action: "transform" });
    expect(createHarnessRun(session, "CONTROL-NEXT")).toMatchObject({ status: "ACTIVE" });
  });

  it("rolls back Task Flow control when the paired ManagedRun transition fails", () => {
    const { session, cwd, ctx } = fixture("CONTROL-ROLLBACK");
    admit(session, cwd, ctx);
    const harness = createHarnessRun(session, "CONTROL-ROLLBACK");
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const beforeVersion = authority.readTaskFlowGoalVersion(goalId);
    const decision = controlDecision(session, "PAUSE");
    expect(() => authority.transactTaskFlowHarness(
      { type: "CONTROL_TASK_FLOW", goalId, action: "PAUSE", decision },
      {
        type: "CONTROL_MANAGED_RUN", goalId, runId: harness.runId,
        action: "RESUME", reasonSha256: decision.record_sha256,
      },
      session.binding()!.mutation(`test:atomic-control:${decision.record_sha256}`),
    )).toThrow(/cannot RESUME from ACTIVE/u);
    expect(authority.readTaskFlowGoalVersion(goalId)).toBe(beforeVersion);
    expect(authority.readTaskFlowView(goalId)).toMatchObject({ status: "BUILDING" });
    expect(authority.readHarnessView(goalId)).toMatchObject({ status: "ACTIVE" });
  });

  it("repairs a terminal Task Flow with a legacy active ManagedRun before admitting the next Goal", () => {
    const { root, cwd, session, ctx } = fixture("CONTROL-RECOVERY");
    admit(session, cwd, ctx);
    createHarnessRun(session, "CONTROL-RECOVERY");
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const decision = controlDecision(session, "CANCEL");
    authority.transactTaskFlow(
      { type: "CONTROL_TASK_FLOW", goalId, action: "CANCEL", decision },
      session.binding()!.mutation(`test:legacy-cancel:${decision.record_sha256}`),
    );
    expect(authority.readHarnessView(goalId)).toMatchObject({ status: "ACTIVE" });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(ctx);
    expect(resumed.resources()!.authority.readHarnessView(goalId)).toMatchObject({ status: "CANCELED" });
    expect(resumed.startFromInput("build: create a replacement bounded file", ctx)).toMatchObject({ action: "transform" });
    expect(createHarnessRun(resumed, "CONTROL-RECOVERY-NEXT")).toMatchObject({ status: "ACTIVE" });
  });

  it("supersedes an OPEN clarification when the same binding is resolved", () => {
    const { root, session, cwd, ctx } = fixture("CLARIFICATION-HEAD");
    admit(session, cwd, ctx);
    const decision = {
      id: "output-format", question: "Which output format should be authoritative?",
      whyItMatters: "The choice changes acceptance.", changeKind: "ACCEPTANCE" as const, materiality: "HIGH" as const,
      reversible: true, privacyRelated: false,
      options: [
        { id: "json", label: "JSON", impact: "Machine-readable output" },
        { id: "markdown", label: "Markdown", impact: "Human-readable output" },
      ],
      recommendedOptionId: "json", recommendationReason: "The oracle can validate JSON deterministically.",
      dependsOnDecisionIds: [],
    };
    expect(session.resolveClarificationSelections([{ ...decision, selectedOptionId: null }])).toMatch(/remains OPEN/u);
    expect(session.resources()!.authority.readOpenTaskFlowDecisionCount(session.current()!.goalId)).toBe(1);
    expect(session.openClarifications()).toEqual([decision]);
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(ctx);
    expect(resumed.openClarifications()).toEqual([decision]);
    expect(resumed.resolveClarificationSelections([{ ...decision, selectedOptionId: "json" }])).toMatch(/Decisions resolved/u);
    expect(resumed.resources()!.authority.readOpenTaskFlowDecisionCount(resumed.current()!.goalId)).toBe(0);
  });

  it("revokes BUILD authorization before asking a material question and persists the choice", async () => {
    const { session, cwd, ctx } = fixture("H4");
    admit(session, cwd, ctx);
    const result = await session.resolveClarifications([{
      id: "output-format", question: "Which output format should be authoritative?",
      whyItMatters: "The choice changes acceptance.", changeKind: "ACCEPTANCE", materiality: "HIGH",
      reversible: true, privacyRelated: false,
      options: [
        { id: "json", label: "JSON", impact: "Machine-readable output" },
        { id: "markdown", label: "Markdown", impact: "Human-readable output" },
      ],
      recommendedOptionId: "json", recommendationReason: "The oracle can validate JSON deterministically.",
      dependsOnDecisionIds: [],
    }], {
      hasUI: true, mode: "print",
      ui: { select: (_title: string, options: string[]) => Promise.resolve(options[0]) } as unknown as ExtensionContext["ui"],
    });
    expect(result).toMatch(/Decisions resolved: DECISION-/u);
    expect(session.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-BLOCKED", toolName: "write", input: { path: "src/example.ts", content: "blocked" }, cwd,
    })).toMatchObject({ allow: false });
  });

  it("persists a contract revision fence and keeps writes blocked after restart", () => {
    const { root, cwd, session, ctx } = fixture("CONTRACT-REVISION");
    admit(session, cwd, ctx);
    expect(session.reviseRequirement("SCOPE", "Include an additional source file"))
      .toMatch(/authority version/u);
    expect(session.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-AFTER-REVISION", toolName: "write",
      input: { path: "src/example.ts", content: "not authorized" }, cwd,
    })).toMatchObject({ allow: false });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-CONTRACT-REVISION"));
    expect(resumed.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    expect(resumed.prepareToolOperation({
      toolCallId: "WRITE-AFTER-RESTART", toolName: "write",
      input: { path: "src/example.ts", content: "still not authorized" }, cwd,
    })).toMatchObject({ allow: false });
  });

  it("survives restart at PLAN continuation and enters BUILD only after the user choice", async () => {
    const { root, cwd, session, ctx } = fixture("PLAN");
    expect(session.startFromInput("plan: 修改 src/example.ts 并运行测试", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    session.submitRoute(route);
    expect(session.current()).toMatchObject({ phase: "WAITING_USER", nextAction: "PLAN_CONTINUATION" });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);
    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-PLAN"));
    const continuation = await resumed.continueFromPlan({
      hasUI: true, mode: "print",
      ui: { select: (_title: string, options: string[]) => Promise.resolve(options[0]) } as unknown as ExtensionContext["ui"],
    });
    expect(continuation).toMatch(/BUILD authorized/u);
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
  });

  it("closes the ManagedRun when a frozen PLAN is kept", () => {
    const { session, ctx } = fixture("PLAN-KEEP");
    expect(session.startFromInput("plan: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    createHarnessRun(session, "PLAN-KEEP");
    session.submitContract(contract);
    session.submitRoute(route);
    expect(session.resolvePlanContinuation("KEEP")).toMatch(/kept without implementation/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(session.harnessView()).toMatchObject({ status: "SUCCEEDED" });
    expect(session.startFromInput("build: start the next bounded task", ctx)).toMatchObject({ action: "transform" });
    expect(createHarnessRun(session, "PLAN-KEEP-NEXT")).toMatchObject({ status: "ACTIVE" });
  });

  it("expands deferred outcomes through a RouteRevision without revising the GoalContract", () => {
    const { session, cwd, ctx } = fixture("DEFERRED");
    expect(session.startFromInput("build: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract({
      ...contract,
      obligations: [
        { key: "implemented", priority: "MUST", statement: "The bounded change is implemented", oracle: { command: "npm test" } },
        { key: "verified", priority: "MUST", statement: "The final workspace is verified", oracle: { command: "npm test" } },
      ],
    });
    session.submitRoute({
      outcomes: ["Implement and then verify"],
      work_cells: [{
        ...route.work_cells[0]!, key: "implement", obligation_keys: ["implemented"],
      }],
      deferred_outcomes: [{
        key: "final-verification", outcome: "Verify the final workspace", obligation_keys: ["verified"],
        dependencies: ["implement"], expansion_trigger: "WORK_CELL_CLOSED", commitment: "REVERSIBLE",
      }],
    });
    expect(session.current()).toMatchObject({ phase: "BUILDING", routeHealth: "H0_CONTINUE" });
    const beforeGraph = session.resources()!.authority.readTaskFlowGoalVersion(session.current()!.goalId);
    expect(session.detail("graph")).toMatch(/\[DEFERRED:WORK_CELL_CLOSED\]/u);
    expect(session.resources()!.authority.readTaskFlowGoalVersion(session.current()!.goalId)).toBe(beforeGraph);
    validate(session, cwd, "VALIDATE-DEFERRED-1");
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE" });
    session.submitRoute({
      lane: "DIRECT_CELL", outcomes: ["Revalidate final acceptance"],
      work_cells: [{
        ...route.work_cells[0]!, key: "final-verification", obligation_keys: ["implemented", "verified"],
      }],
    });
    validate(session, cwd, "VALIDATE-DEFERRED-2");
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("promotes a directory-scoped DirectCell hint before authorization", () => {
    const { session, ctx } = fixture("DIRECTORY-PROMOTION");
    expect(session.startFromInput("build: update src and run tests", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    const result = session.submitRoute({
      lane: "DIRECT_CELL", outcomes: ["Update the bounded source directory"],
      work_cells: [{ ...route.work_cells[0]!, read_roots: ["src"], write_roots: ["src"] }],
    });
    expect(result).toMatch(/admission=ADAPTIVE_ROUTE requested=DIRECT_CELL selected=ADAPTIVE_ROUTE/u);
    expect(session.current()).toMatchObject({ mode: "BUILD", phase: "BUILDING" });
    expect(session.detail("why")).toMatch(/SCOPE_NOT_DIRECT_BOUNDED/u);
  });

  it("rejects secret-like intake and unsafe linked scope before authority or baseline capture", () => {
    const secretFixture = fixture("SECRET");
    expect(() => secretFixture.session.startFromInput(`build: use sk-${"a".repeat(40)} in src/example.ts`, secretFixture.ctx)).toThrow(/secret-like/u);
    expect(secretFixture.session.current()).toBeNull();

    const linkedFixture = fixture("LINK");
    const external = resolve(linkedFixture.root, "external");
    const linked = resolve(linkedFixture.cwd, "linked");
    mkdirSync(external, { recursive: true });
    try {
      symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    linkedFixture.session.startFromInput("build: update linked/example.ts and verify", linkedFixture.ctx);
    linkedFixture.session.submitContract({ ...contract, scope: ["linked/example.ts"] });
    expect(() => linkedFixture.session.submitRoute({
      outcomes: ["Update linked scope"],
      work_cells: [{ ...route.work_cells[0]!, read_roots: ["src", "linked"], write_roots: ["src", "linked"] }],
    })).toThrow(/unsafe link/u);
    const linkedCurrent = linkedFixture.session.current()!;
    expect(linkedCurrent).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE" });
    expect(linkedFixture.session.resources()!.authority.readTaskFlowView(linkedCurrent.goalId)?.route).toBeNull();
  }, 15_000);

  it("rejects secret-like Contract and Route payloads before authority persistence", () => {
    const { session, ctx } = fixture("SECRET-PROPOSAL");
    session.startFromInput("build: update src/example.ts and run tests", ctx);
    const fake = `sk-${"b".repeat(40)}`;
    expect(() => session.submitContract({ ...contract, constraints: [`api_key=${fake}`] })).toThrow(/secret-like material/u);
    expect(session.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    session.submitContract(contract);
    expect(() => session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, oracle: { command: `npm test --token=${fake}` } }],
    })).toThrow(/secret-like material/u);
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE" });
  });

  it("escalates the same failing validation signature instead of retrying forever", () => {
    const { session, cwd, ctx } = fixture("FAILURE");
    admit(session, cwd, ctx);
    const previousRoute = session.resources()!.authority.readTaskFlowView(session.current()!.goalId)!.route!;
    for (const callId of ["FAIL-1", "FAIL-2"]) {
      expect(session.prepareToolOperation({ toolCallId: callId, toolName: "bash", input: { command: "npm test" }, cwd }))
        .toMatchObject({ allow: true });
      session.observeToolResult(callId, true, "same deterministic failure");
    }
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE", routeHealth: "H3_REFRAME" });
    expect(session.workflowPrompt()).toMatch(/This is a RouteRevision/u);
    expect(session.workflowPrompt()).toMatch(/action=submit_route_revision/u);
    expect(session.prepareToolOperation({
      toolCallId: "STALE-ROUTE-WRITE", toolName: "write",
      input: { path: "src/example.ts", content: "stale route\n" }, cwd,
    })).toMatchObject({ allow: false });
    expect(() => session.submitRouteRevision({
      work_cells: route.work_cells,
    })).toThrow(/does not change the effective Route execution semantics/u);
    expect(session.resources()!.authority.readTaskFlowView(session.current()!.goalId)!.route?.route_id)
      .toBe(previousRoute.route_id);
    session.submitRouteRevision({
      work_cells: [{ ...route.work_cells[0]!, key: "bounded-repair" }],
    });
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK", routeHealth: "H0_CONTINUE" });
    expect(session.resources()!.authority.readTaskFlowView(session.current()!.goalId)!.route).toMatchObject({
      revision: previousRoute.revision + 1, parent_route_id: previousRoute.route_id,
    });
  });

  it("reports the replan trigger plus invalidated and preserved scope", () => {
    const { session, cwd, ctx } = fixture("USER-REPLAN-FEEDBACK");
    admit(session, cwd, ctx);
    const message = session.mutate("replan", "The installed API removed the planned endpoint");
    expect(message).toMatch(/Trigger: The installed API removed the planned endpoint/u);
    expect(message).toMatch(/Invalidated: active authorization and nonterminal WorkCells/u);
    expect(message).toMatch(/Preserved: GoalContract, succeeded WorkCells, and immutable operation\/evidence receipts/u);
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE", routeHealth: "H3_REFRAME" });
  });

  it("rejects an unrequested RouteRevision while execution remains authorized", () => {
    const { session, cwd, ctx } = fixture("ROUTE-BOUNDARY");
    admit(session, cwd, ctx);
    const before = session.current()!;
    const beforeRoute = session.resources()!.authority.readTaskFlowView(before.goalId)!.route!;
    expect(() => session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "unrequested-revision" }],
      near_horizon: ["unrequested-revision"],
    })).toThrow(/not authorized.*next=EXECUTE_WORK/u);
    expect(session.current()).toMatchObject({
      phase: "BUILDING", nextAction: "EXECUTE_WORK",
      workCell: before.workCell,
    });
    expect(session.resources()!.authority.readTaskFlowView(before.goalId)!.route).toMatchObject({
      route_id: beforeRoute.route_id, revision: beforeRoute.revision,
    });
  });

  it("reframes locally when authorization baseline capture fails after route persistence", () => {
    const { session, ctx } = fixture("AUTHORIZATION-PREFLIGHT");
    session.startFromInput("build: update src/example.ts and verify", ctx);
    const internal = session as unknown as { captureBaseline: () => never };
    const capture = vi.spyOn(internal, "captureBaseline").mockImplementationOnce(() => {
      throw new TypeError("simulated unsafe baseline race");
    });
    expect(session.submitBuild(contract, route)).toMatch(/authorization preflight reframed/u);
    expect(session.current()).toMatchObject({
      phase: "PLANNING", nextAction: "SUBMIT_ROUTE", routeHealth: "H3_REFRAME",
      blocker: expect.stringContaining("simulated unsafe baseline race"),
    });
    capture.mockRestore();
  });

  it("enforces structured baseline, improvement and holdout receipts before closing a performance Goal", () => {
    const { session, cwd, ctx } = fixture("TARGET-PERFORMANCE");
    const performanceContract = {
      schema_version: 1, mode: "OPTIMIZE", activation_basis: "USER_REQUEST",
      scope: { include: ["src/example.ts"], exclude: [] },
      workloads: [
        { key: "primary", role: "PRIMARY", command: "npm run bench:primary", fixture_ref: "fixtures/primary.json", representativeness: "primary" },
        { key: "regression", role: "REGRESSION", command: "npm run bench:regression", fixture_ref: "fixtures/regression.json", representativeness: "regression" },
        { key: "holdout", role: "HOLDOUT", command: "npm run bench:holdout", fixture_ref: "fixtures/holdout.json", representativeness: "holdout" },
      ],
      metrics: [{
        key: "latency_p95", role: "PRIMARY_GATE", unit: "ms", direction: "LOWER", aggregation: "P95",
        workload_keys: ["primary", "regression", "holdout"], minimum_improvement_pct: 10, maximum_regression_pct: 1,
      }],
      correctness_obligation_keys: ["correctness"],
      opportunity_gate: { minimum_hotspot_fraction: 0.1, minimum_practical_improvement_pct: 3, unknown_action: "ADVICE_ONLY" },
      budget: { max_candidates: 2, max_wall_time_ms: 60_000, max_user_blocking_ms: 1_000 },
      holdout_policy: "REQUIRED", rollback_required: true,
    };
    const performanceGoal = {
      user_outcomes: ["Parser latency improves without correctness regression"], scope: ["src/example.ts"],
      non_goals: ["No deployment"], constraints: ["Keep the patch reversible"],
      obligations: [{ key: "correctness", priority: "MUST" as const, statement: "Tests pass", oracle: { command: "npm test" } }],
      acceptance_policy: { all_must: true, performance_contract: performanceContract },
      authorization_ceiling: "LOCAL_REVERSIBLE" as const,
    };
    const performanceRoute = {
      lane: "ADAPTIVE_ROUTE" as const, outcomes: ["Baseline measured", "Candidate improved", "Holdout passed"],
      work_cells: [
        {
          key: "baseline", outcome: "Measure frozen baseline", obligation_keys: ["correctness"],
          read_roots: ["src/example.ts"], write_roots: [], effect_classes: ["READ_ONLY" as const],
          oracle: { commands: ["npm test", "npm run bench:primary", "npm run bench:regression", "npm run bench:holdout"] },
          risk: "LOW" as const, reversible: true, budget: { max_attempts: 1, performance_phase: "BASELINE_PROFILE" },
        },
        {
          key: "candidate", outcome: "Implement measured candidate", obligation_keys: ["correctness"], dependencies: ["baseline"],
          read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE" as const],
          oracle: { commands: ["npm test", "npm run bench:primary", "npm run bench:regression"] },
          risk: "LOW" as const, reversible: true, budget: { max_attempts: 2, performance_phase: "CANDIDATE" },
        },
        {
          key: "holdout", outcome: "Verify frozen holdout", obligation_keys: ["correctness"], dependencies: ["candidate"],
          read_roots: ["src/example.ts"], write_roots: [], effect_classes: ["READ_ONLY" as const],
          oracle: { commands: ["npm test", "npm run bench:holdout"] },
          risk: "LOW" as const, reversible: true, budget: { max_attempts: 1, performance_phase: "HOLDOUT" },
        },
      ],
    };
    const benchmark = (key: string, value: number) => `PCH_BENCHMARK_RESULT_V1=${JSON.stringify({
      schema_version: 1, workload_key: key, environment_sha256: "a".repeat(64),
      sample_count: 30, metrics: { latency_p95: value },
    })}`;
    const run = (id: string, command: string, output: string): string => {
      expect(session.prepareToolOperation({ toolCallId: id, toolName: "bash", input: { command }, cwd }))
        .toMatchObject({ allow: true, managed: true });
      return session.observeToolResult(id, false, output)!;
    };

    expect(session.startFromInput("build: optimize parser performance and latency", ctx)).toMatchObject({ action: "transform" });
    session.submitBuild(performanceGoal, performanceRoute);
    run("BASE-TEST", "npm test", "tests passed");
    run("BASE-PRIMARY", "npm run bench:primary", benchmark("primary", 100));
    run("BASE-REGRESSION", "npm run bench:regression", benchmark("regression", 100));
    run("BASE-HOLDOUT", "npm run bench:holdout", benchmark("holdout", 100));
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });

    expect(session.prepareToolOperation({
      toolCallId: "CANDIDATE-WRITE", toolName: "write",
      input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
    })).toMatchObject({ allow: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    session.observeToolResult("CANDIDATE-WRITE", false, "wrote");
    run("CANDIDATE-TEST", "npm test", "tests passed");
    run("CANDIDATE-PRIMARY", "npm run bench:primary", benchmark("primary", 80));
    run("CANDIDATE-REGRESSION", "npm run bench:regression", benchmark("regression", 99.5));
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });

    run("HOLDOUT-TEST", "npm test", "tests passed");
    const final = run("HOLDOUT-BENCH", "npm run bench:holdout", benchmark("holdout", 80));
    expect(final).toMatch(/Goal .* closed/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(session.resources()!.authority.readTargetPerformanceMeasurements(session.current()!.goalId, "BASELINE_PROFILE"))
      .toHaveLength(3);
  }, 15_000);
});
