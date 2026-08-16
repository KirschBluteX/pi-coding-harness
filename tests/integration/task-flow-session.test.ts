import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import { idFromSha256 } from "../../src/foundation/ids.js";
import { sealHarnessRecord, type TopologyRevisionRecord, workerRoles } from "../../src/harness/domain.js";
import { sealTaskFlowRecord, type TaskDecisionEntryRecord } from "../../src/task-flow/domain.js";
import { toSessionGoalBindingMarker } from "../../src/task-flow/session-binding.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment, passingMaterialChangeGoalFitAssessment } from "../helpers/goal-fit.js";
import { finalizeStrongSingleRolloutReceiptV1 } from "../../src/harness-v2/strong-single-rollout.js";
import { InputContextRepository } from "../../src/input-context/repository.js";
import { ProviderTurnLedgerCoordinator } from "../../src/input-context/provider-turn-ledger.js";

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

function withGoalFitAssessment<T extends object>(proposal: T): T & {
  readonly goal_fit_assessment: ReturnType<typeof passingGoalFitAssessment>;
} {
  return { ...proposal, goal_fit_assessment: passingGoalFitAssessment() };
}

const contract = withGoalFitAssessment(withAcceptanceV2({
  user_outcomes: ["The local file is correct and verified"],
  scope: ["src/example.ts"],
  non_goals: ["No external deployment"],
  constraints: ["Keep the change local"],
  obligations: [{
    key: "verified-output", priority: "MUST" as const,
    statement: "The final workspace passes npm test", oracle: { command: "npm test" },
  }],
  authorization_ceiling: "LOCAL_REVERSIBLE" as const,
}));

const route = withGoalFitAssessment({
  outcomes: ["The bounded change is implemented"],
  work_cells: [{
    key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
    read_roots: ["src/example.ts"], write_roots: ["src/example.ts"],
    effect_classes: ["LOCAL_REVERSIBLE" as const], oracle: { command: "npm test" },
    risk: "LOW" as const, reversible: true,
  }],
  near_horizon: ["bounded-change"],
});

let contractReviewTurn = 0;

function approvePendingContract(session: TaskFlowSession): void {
  const review = session.contractReview();
  if (!review) throw new TypeError("Test fixture expected a pending Goal Contract review");
  session.resolveContractReview({
    expectedDecisionRequirementRevisionId: review.decisionRequirementRevisionId,
    expectedRequirementRevisionSha256: review.requirementRevisionSha256,
    expectedDecisionFrontierSha256: review.decisionFrontierSha256,
    action: "APPROVE",
    selectedValue: true,
    turnId: `TEST-CONTRACT-REVIEW-${++contractReviewTurn}`,
  });
}

function submitApprovedBuild(
  session: TaskFlowSession,
  contractProposal: Parameters<TaskFlowSession["submitContract"]>[0],
  routeProposal: Parameters<TaskFlowSession["submitRoute"]>[0],
): string {
  session.submitContract(contractProposal);
  approvePendingContract(session);
  return session.submitRoute(routeProposal);
}

function crashBeforePendingAuthorityReconciliation(session: TaskFlowSession, boundary: string): void {
  const internal = session as unknown as { reconcilePendingAuthorityTransitions(): void };
  vi.spyOn(internal, "reconcilePendingAuthorityTransitions").mockImplementationOnce(() => {
    throw new Error(`SIMULATED_CRASH_${boundary}`);
  });
}

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

  function admit(
    session: TaskFlowSession,
    cwd: string,
    ctx: ReturnType<typeof context>,
    contractProposal: Parameters<TaskFlowSession["submitContract"]>[0] = contract,
    routeProposal: Parameters<TaskFlowSession["submitRoute"]>[0] = route,
  ): void {
    expect(session.startFromInput("build: 修改 src/example.ts 并运行测试", ctx)).toMatchObject({ action: "transform" });
    submitApprovedBuild(session, contractProposal, routeProposal);
    expect(session.current()).toMatchObject({ mode: "BUILD", phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-1", toolName: "write", input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    expect(session.observeToolResult("WRITE-1", false, "Wrote src/example.ts")).toMatch(/PCH_OPERATION_COMMITTED/u);
  }

  function validate(session: TaskFlowSession, cwd: string, callId = "VALIDATE-1", complete = true): string {
    expect(session.prepareToolOperation({ toolCallId: callId, toolName: "bash", input: { command: "npm test" }, cwd }))
      .toMatchObject({ allow: true, managed: true });
    const feedback = session.observeToolResult(callId, false, "tests passed")!;
    const operationId = /operation=([A-Z][A-Z0-9_:-]*)/u.exec(feedback)?.[1];
    expect(operationId).toBeTruthy();
    if (complete && feedback.includes("Fresh oracle closure is ready")) session.completeWork();
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

  it("discovers an active pre-binding Goal as an unbound recovery candidate", () => {
    const { session, ctx } = fixture("LEGACY-UNBOUND-DISCOVERY");
    expect(session.startFromInput("plan: recover the pre-binding goal", ctx)).toMatchObject({ action: "transform" });
    const current = session.current()!;

    expect(session.sessionGoalBinding()).toBeNull();
    expect(session.recoverableSessionGoals()).toMatchObject([{
      goalId: current.goalId,
      goalTitle: "recover the pre-binding goal",
      state: "UNBOUND",
      bindingReceiptSha256: null,
      status: "CONTRACTING",
      nextActionCode: "SUBMIT_CONTRACT",
    }]);
  });

  it("commits immutable session binding revisions and validates the exact marker", () => {
    const { session, ctx } = fixture("SESSION-BINDING");
    expect(session.startFromInput("plan: stabilize the recovery contract", ctx)).toMatchObject({ action: "transform" });
    const initial = session.bindCurrentGoal();
    expect(initial).toMatchObject({
      revision: 1,
      sessionId: "SESSION-SESSION-BINDING",
      state: "BOUND",
      autoResume: true,
      goalTitle: "stabilize the recovery contract",
    });
    expect(session.resources()!.authority.validateSessionGoalBindingMarker(
      toSessionGoalBindingMarker(initial), initial.workspaceId, initial.sessionId,
    )).toEqual(initial);

    const renamed = session.renameCurrentGoal("Recovery contract");
    expect(renamed).toMatchObject({ revision: 2, goalTitle: "Recovery contract", reasonCode: "TITLE_EDIT" });
    expect(renamed.predecessorReceiptSha256).toBe(initial.bindingReceiptSha256);
    const exited = session.unbindCurrentGoal();
    expect(exited).toMatchObject({ revision: 3, state: "UNBOUND", autoResume: false, reasonCode: "EXIT" });
    expect(session.resources()!.authority.verifySessionGoalBindingIntegrity()).toEqual({ revisions: 3, heads: 1 });
  });

  it("terminates auto-resume when the bound Goal becomes terminal", () => {
    const { session, ctx } = fixture("TERMINAL-BINDING");
    expect(session.startFromInput("plan: cancel this bounded goal", ctx)).toMatchObject({ action: "transform" });
    const initial = session.bindCurrentGoal();

    expect(session.mutate("cancel", "terminal binding test")).toMatch(/cancel committed/iu);

    expect(session.sessionGoalBinding()).toMatchObject({
      goalId: initial.goalId,
      revision: 2,
      state: "TERMINAL",
      autoResume: false,
      reasonCode: "GOAL_TERMINAL",
      predecessorReceiptSha256: initial.bindingReceiptSha256,
    });
  });

  it("resumes only the marker-bound Goal and fences a duplicate runtime instance", () => {
    const now = () => Date.parse("2026-07-24T12:00:00.000Z");
    const { root, cwd, session, ctx } = fixture("BOUND-RESUME", now);
    expect(session.startFromInput("plan: keep the exact bound goal", ctx)).toMatchObject({ action: "transform" });
    const binding = session.bindCurrentGoal();
    const marker = toSessionGoalBindingMarker(binding);
    const duplicate = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now,
    });
    sessions.push(duplicate);
    expect(() => duplicate.initialize(context(cwd, binding.sessionId), {
      recovery: { kind: "BOUND_MARKER", marker },
      runtimeInstanceId: "RUNTIME-DUPLICATE",
    })).toThrow(/another live session or runtime instance/iu);

    session.shutdown();
    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now,
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, binding.sessionId), {
      recovery: { kind: "BOUND_MARKER", marker },
      runtimeInstanceId: "RUNTIME-RESUMED",
    });
    expect(resumed.current()).toMatchObject({ goalId: binding.goalId, nextAction: "SUBMIT_CONTRACT" });

    const substituted = { ...marker, goal_id: "GOAL-SUBSTITUTED" };
    const rejected = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now,
    });
    sessions.push(rejected);
    expect(() => rejected.initialize(context(cwd, binding.sessionId), {
      recovery: { kind: "BOUND_MARKER", marker: substituted },
      runtimeInstanceId: "RUNTIME-SUBSTITUTED",
    })).toThrow(/marker does not match current authority/iu);
  });

  it("keeps a requested Multi WorkCell pending until its DAG is proposed", () => {
    const { session, cwd, ctx } = fixture("PENDING-MULTI-PROPOSAL");
    expect(session.startFromInput("build: update src/example.ts and run tests", ctx)).toMatchObject({ action: "transform" });
    submitApprovedBuild(session, contract, route);
    const harness = session.createHarnessRun({
      topology: "SINGLE",
      requestedTopology: "MULTI",
      reasonCode: "MULTI_BENEFIT_EVIDENCE_REQUIRED",
      createdByHostHmac: hmacSha256Hex("test-host", "pending-multi-proposal"),
      configSha256: hmacSha256Hex("test-config", "pending-multi-proposal"),
      decisionSha256: hmacSha256Hex("test-decision", "pending-multi-proposal"),
    });

    expect(harness).toMatchObject({
      requestedTopology: "MULTI",
      effectiveTopology: "SINGLE",
      topologyReasonCode: "MULTI_BENEFIT_EVIDENCE_REQUIRED",
    });
    expect(session.workflowPrompt()).toContain("Next=PENDING_MULTI_PROPOSAL");
    expect(session.workflowPrompt()).toContain("coding_delegate action=define");
    expect(session.workflowPrompt()).not.toContain("Merge all edits to the same file");
    expect(session.prepareToolOperation({
      toolCallId: "PENDING-MULTI-READ",
      toolName: "read",
      input: { path: "src/example.ts" },
      cwd,
    })).toMatchObject({ allow: true });
  });

  function authorityDatabasePath(root: string, cwd: string): string {
    const dataRoot = resolve(root, "data");
    const installKey = readFileSync(resolve(dataRoot, "install.key"));
    const workspaceHmac = hmacSha256Hex(
      installKey,
      resolve(cwd).replaceAll("\\", "/").toLowerCase().normalize("NFC"),
    );
    return resolve(dataRoot, "workspaces", workspaceHmac, "authority.sqlite");
  }

  function acceptanceStorageCounts(root: string, cwd: string): Record<string, number> {
    const connection = openAuthorityConnection({ path: authorityDatabasePath(root, cwd) });
    try {
      const tables = [
        "evidence_attestations_v1",
        "deliverable_manifests_v1",
        "acceptance_evidence_bindings_v2",
        "work_cell_completion_receipts_v2",
        "deliverable_manifests_v2",
      ];
      return Object.fromEntries(tables.map((table) => {
        const row = connection.prepare(`SELECT count(*) count FROM ${table}`).get() as { readonly count: number };
        return [table, Number(row.count)];
      }));
    } finally {
      closeAuthorityConnection(connection);
    }
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
    const { root, session, cwd, ctx } = fixture("SUCCESS");
    admit(session, cwd, ctx);
    validate(session, cwd);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(acceptanceStorageCounts(root, cwd)).toEqual({
      evidence_attestations_v1: 0,
      deliverable_manifests_v1: 0,
      acceptance_evidence_bindings_v2: 3,
      work_cell_completion_receipts_v2: 1,
      deliverable_manifests_v2: 1,
    });
  });

  it("keeps the terminal WorkCell writable until preservation review explicitly completes it", () => {
    const { session, cwd, ctx } = fixture("TERMINAL-PRESERVATION-REVIEW");
    admit(session, cwd, ctx);
    validate(session, cwd, "VALIDATE-BEFORE-REVIEW", false);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });

    expect(session.prepareToolOperation({
      toolCallId: "EDIT-DURING-REVIEW", toolName: "edit",
      input: { path: "src/example.ts", oldText: "value = 2", newText: "value = 3" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 3;\n", "utf8");
    expect(session.observeToolResult("EDIT-DURING-REVIEW", false, "edited after preservation review"))
      .toMatch(/PCH_OPERATION_COMMITTED/u);
    expect(session.settleReadyWork()).toBeNull();
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });

    validate(session, cwd, "VALIDATE-AFTER-REVIEW", false);
    expect(session.completeWork()).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("closes a reviewed terminal WorkCell locally when the Agent settles", () => {
    const { session, cwd, ctx } = fixture("TERMINAL-SETTLED-CLOSURE");
    admit(session, cwd, ctx);
    validate(session, cwd, "VALIDATE-BEFORE-SETTLE", false);
    expect(session.settleReadyWork()).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(session.settleReadyWork()).toBeNull();
  });

  it("records an event-bound Strong Single rollout only from the exact completed epoch", () => {
    const { root, session, cwd, ctx } = fixture("STRONG-SINGLE-ROLLOUT");
    const strongSingleContract = withGoalFitAssessment(withAcceptanceV2({
      ...contract,
      user_outcomes: ["The local file is correct and verified", "The follow-up review remains pending"],
      obligations: [
        ...contract.obligations,
        { key: "follow-up", priority: "MUST", statement: "The follow-up review is completed", oracle: { command: "npm test" } },
      ],
    }));
    const strongSingleRoute = withGoalFitAssessment({
      ...route,
      outcomes: ["The bounded change is implemented", "The follow-up review is completed"],
      work_cells: [
        route.work_cells[0]!,
        {
          ...route.work_cells[0]!, key: "follow-up", outcome: "Review the completed change",
          obligation_keys: ["follow-up"], dependencies: ["bounded-change"], write_roots: [],
          effect_classes: ["READ_ONLY" as const],
        },
      ],
      near_horizon: ["bounded-change", "follow-up"],
    });
    admit(session, cwd, ctx, strongSingleContract, strongSingleRoute);
    const harness = createHarnessRun(session, "strong-single-rollout");
    const authority = session.resources()!.authority;
    const preparation = authority.readStrongSingleRolloutPreparation(session.current()!.goalId, harness.runId);
    expect(preparation).not.toBeNull();
    const providerConnection = openAuthorityConnection({ path: authorityDatabasePath(root, cwd) });
    try {
      const provider = new ProviderTurnLedgerCoordinator(
        new InputContextRepository(providerConnection), "strong-single-provider-secret", () => preparation!.started_at_ms,
      );
      provider.begin({
        promptGenerationId: "PROMPT-GENERATION-STRONG-SINGLE-ROLLOUT",
        payloadShapeSha256: sha256Hex("strong-single-payload"),
        history: {
          descriptorRootSha256: sha256Hex("strong-single-history"), messageCount: 1,
          logicalBytes: 4, userBytes: 4, assistantBytes: 0, otherBytes: 0,
        },
        toolSchemaBytes: 10, contextEnvelopeSha256: null, layout: null, contributions: [],
        goalBinding: { goalId: preparation!.goal_id, runId: preparation!.run_id, sessionId: "SESSION-STRONG-SINGLE" },
      });
      provider.settle({
        usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, reasoning: 1 },
        responseStatus: 200, outcome: "RESPONDED", outputSeeds: [],
      });
    } finally { closeAuthorityConnection(providerConnection); }
    validate(session, cwd, "VALIDATE-STRONG-SINGLE", false);
    const rolloutView = authority.readTaskFlowView(preparation!.goal_id)!;
    expect(rolloutView.route?.work_cells).toHaveLength(2);
    expect(rolloutView.route?.work_cells.at(-1)?.work_cell_id).not.toBe(preparation!.work_cell_id);
    expect(rolloutView.workCellId).not.toBe(preparation!.work_cell_id);
    const completion = authority.readStrongSingleRolloutCompletion(preparation!);
    expect(completion).not.toBeNull();
    const usage = authority.readRunProviderTurnUsage({
      goal_id: preparation!.goal_id,
      run_id: preparation!.run_id,
      started_at_ms: preparation!.started_at_ms,
      completed_at_ms: completion!.completed_at_ms,
    });
    expect(usage).toMatchObject({
      accounting_completeness: "COMPLETE", requests: 1,
      input_tokens: 13, output_tokens: 3, cache_read_tokens: 2,
    });
    expect(usage.receipt_refs).toHaveLength(5);
    const receipt = finalizeStrongSingleRolloutReceiptV1({
      ...preparation!,
      runtime_fingerprint_sha256: sha256Hex("strong-single-runtime"),
      completion_receipt_id: completion!.completion_receipt_id,
      completion_receipt_sha256: completion!.completion_receipt_sha256,
      provider_requests: usage.accounting_completeness === "COMPLETE" ? usage.requests : 0,
      input_tokens: usage.accounting_completeness === "COMPLETE" ? usage.input_tokens : 0,
      output_tokens: usage.accounting_completeness === "COMPLETE" ? usage.output_tokens : 0,
      cache_read_tokens: usage.accounting_completeness === "COMPLETE" ? usage.cache_read_tokens : 0,
      provider_receipt_refs: usage.receipt_refs,
      user_interventions: completion!.user_interventions,
      safety_events: completion!.safety_events,
      completed_at_ms: completion!.completed_at_ms,
    });
    const binding = session.binding()!;
    const forged = finalizeStrongSingleRolloutReceiptV1({
      ...preparation!, runtime_fingerprint_sha256: receipt.runtime_fingerprint_sha256,
      completion_receipt_id: completion!.completion_receipt_id,
      completion_receipt_sha256: completion!.completion_receipt_sha256,
      provider_requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      provider_receipt_refs: [], user_interventions: completion!.user_interventions,
      safety_events: completion!.safety_events, completed_at_ms: completion!.completed_at_ms,
    });
    expect(() => authority.transactExecutionV2({
      type: "RECORD_STRONG_SINGLE_ROLLOUT_V1", goalId: preparation!.goal_id, receipt: forged,
    }, binding.mutation(`test:strong-single-rollout:forged:${forged.record_sha256}`)))
      .toThrow(/authority closure mismatch/u);
    const result = authority.transactExecutionV2({
      type: "RECORD_STRONG_SINGLE_ROLLOUT_V1",
      goalId: preparation!.goal_id,
      receipt,
    }, binding.mutation(`test:strong-single-rollout:${receipt.record_sha256}`));
    binding.advanceVersion(result.goalVersion);
    expect(authority.readStrongSingleRollout({
      goal_id: receipt.goal_id,
      run_id: receipt.run_id,
      work_cell_id: receipt.work_cell_id,
      plan_revision_id: receipt.plan_revision_id,
      plan_revision_sha256: receipt.plan_revision_sha256,
      input_closure_sha256: receipt.input_closure_sha256,
      runtime_fingerprint_sha256: receipt.runtime_fingerprint_sha256,
      config_sha256: receipt.config_sha256,
      baseline_sha256: receipt.baseline_sha256,
      baseline_content_root_sha256: receipt.baseline_content_root_sha256,
      environment_sha256: receipt.environment_sha256,
    })).toEqual(receipt);
    expect(receipt).toMatchObject({
      topology_revision: 1,
      topology_revision_sha256: preparation!.topology_revision_sha256,
    });
    const revisedTopology = sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
      schema_version: 1,
      run_id: harness.runId,
      revision: 2,
      requested_topology: "MULTI",
      effective_topology: "MULTI",
      reason_code: "MULTI_BENEFIT_GATE_PASSED",
      decision_sha256: sha256Hex("strong-single-rollout-multi-decision"),
      config_sha256: preparation!.config_sha256,
      created_at_ms: receipt.completed_at_ms,
    }, "record_sha256");
    const revised = authority.transactHarness({
      type: "REVISE_HARNESS_TOPOLOGY",
      goalId: preparation!.goal_id,
      topology: revisedTopology,
    }, binding.mutation(`test:strong-single-rollout:topology:${revisedTopology.record_sha256}`));
    binding.advanceVersion(revised.goalVersion);
    expect(authority.readHarnessView(preparation!.goal_id)).toMatchObject({
      topologyRevision: 2,
      effectiveTopology: "MULTI",
    });
    expect(revisedTopology.record_sha256).not.toBe(receipt.topology_revision_sha256);
    expect(authority.verifyExecutionV2Integrity().strongSingleRollouts).toBe(1);
  });

  it("clamps an oversized model timeout to the authority validation budget", () => {
    const { session, cwd, ctx } = fixture("ORACLE-TIMEOUT-CLAMP");
    admit(session, cwd, ctx);
    expect(session.prepareToolOperation({
      toolCallId: "VALIDATE-LONG-HINT", toolName: "bash",
      input: { command: "npm test", timeout: 1_200 }, cwd,
    })).toMatchObject({ allow: true, managed: true, oracle_policy: { timeout_ms: 900_000 } });
  });

  it("does not authorize an unsandboxed validation under a read-only WorkCell", () => {
    const { session, cwd, ctx } = fixture("READ-ONLY-VALIDATION");
    expect(session.startFromInput("build: inspect src/example.ts", ctx)).toMatchObject({ action: "transform" });
    submitApprovedBuild(session, {
      ...contract,
      authorization_ceiling: "READ_ONLY",
    }, {
      ...route,
      work_cells: [{
        ...route.work_cells[0]!,
        write_roots: [],
        effect_classes: ["READ_ONLY"],
      }],
    });
    expect(session.prepareToolOperation({
      toolCallId: "READ-ONLY-VALIDATE", toolName: "bash", input: { command: "npm test" }, cwd,
    })).toMatchObject({
      allow: false,
      reason: "Operation exceeds the current WorkCell effect ceiling.",
    });
  });

  it("allows Single Supervisor reads across the frozen Route but keeps writes current-cell scoped", () => {
    const { session, cwd, ctx } = fixture("ROUTE-READ-SCOPE");
    writeFileSync(resolve(cwd, "src", "near.ts"), "export const near = true;\n", "utf8");
    session.startFromInput("build: update src/example.ts and src/near.ts and verify", ctx);
    session.submitContract(withAcceptanceV2({
      ...contract,
      user_outcomes: ["The current change is correct", "The near change is correct"],
      scope: ["src/example.ts", "src/near.ts"],
      obligations: [
        { key: "current", priority: "MUST", statement: "Current source is correct", oracle: { command: "npm test" } },
        { key: "near", priority: "MUST", statement: "Near source is correct", oracle: { command: "npm test" } },
      ],
    }));
    approvePendingContract(session);
    session.submitRoute(withGoalFitAssessment({
      outcomes: ["Update both bounded files"],
      work_cells: [
        { ...route.work_cells[0]!, key: "current", obligation_keys: ["current"] },
        {
          ...route.work_cells[0]!, key: "near", obligation_keys: ["near"], dependencies: ["current"],
          read_roots: ["src/near.ts"], write_roots: ["src/near.ts"],
        },
      ],
    }));
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
    expect(resources.authority.readActiveTaskFlowGoal(workspaceId, "SESSION-LIVE-PRD-CLASSIFICATION")).not.toBeNull();
    expect(session.workflowPrompt()).toContain('"acceptance_facets"');
    expect(session.current()).toMatchObject({ mode: "PLAN", phase: "CONTRACTING" });
  });

  it("rejects zero-mutation closure for an explicit fix, then closes after an edit and fresh validation", () => {
    const { session, cwd, ctx } = fixture("MUTATION-CLOSURE");
    mkdirSync(resolve(cwd, "tests"), { recursive: true });
    writeFileSync(resolve(cwd, "tests", "atomic.test.ts"), [
      'test("remaining cleanup runs", () => undefined);',
      'test("error reaches boundary", () => undefined);',
      'test("throwing cleanup is not repeated", () => undefined);',
      "",
    ].join("\n"), "utf8");
    const objective = "Fix hooks/src/index.js: every remaining cleanup must still run, the error must reach the boundary, and the throwing cleanup must not run again.";
    expect(session.startFromInput(`build: ${objective}`, ctx)).toMatchObject({ action: "transform" });
    const atomicContract = {
      ...contract,
      scope: ["src/example.ts", "tests/atomic.test.ts"],
      user_outcomes: ["Remaining cleanup runs", "The error reaches the boundary", "Throwing cleanup is not repeated"],
      acceptance_facets: [
        {
          key: "remaining-cleanup", kind: "OUTCOME" as const,
          subject: { kind: "USER_OUTCOME" as const, index: 0 },
          source_binding: "ENTIRE_INTAKE" as const, obligation_keys: ["remaining-cleanup"],
        },
        {
          key: "error-boundary", kind: "OUTCOME" as const,
          subject: { kind: "USER_OUTCOME" as const, index: 1 },
          source_binding: "ENTIRE_INTAKE" as const, obligation_keys: ["error-boundary"],
        },
        {
          key: "no-repeat", kind: "OUTCOME" as const,
          subject: { kind: "USER_OUTCOME" as const, index: 2 },
          source_binding: "ENTIRE_INTAKE" as const, obligation_keys: ["no-repeat"],
        },
        {
          key: "local-only", kind: "CONSTRAINT" as const,
          subject: { kind: "CONSTRAINT" as const, index: 0 },
          source_binding: "ENTIRE_INTAKE" as const, obligation_keys: ["remaining-cleanup"],
        },
        {
          key: "no-deployment", kind: "NON_GOAL" as const,
          subject: { kind: "NON_GOAL" as const, index: 0 },
          source_binding: "ENTIRE_INTAKE" as const, obligation_keys: ["remaining-cleanup"],
        },
      ],
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
        read_roots: ["src/example.ts", "tests/atomic.test.ts"],
        oracle: { commands: ["npm test"] },
      }],
    };
    submitApprovedBuild(session, atomicContract, atomicRoute);
    const review = (operationId: string) => ({ outcome_evidence: [
      { obligation_key: "remaining-cleanup", operation_id: operationId, witnesses: [{ path: "tests/atomic.test.ts", locator: "remaining cleanup runs" }] },
      { obligation_key: "error-boundary", operation_id: operationId, witnesses: [{ path: "tests/atomic.test.ts", locator: "error reaches boundary" }] },
      { obligation_key: "no-repeat", operation_id: operationId, witnesses: [{ path: "tests/atomic.test.ts", locator: "throwing cleanup is not repeated" }] },
    ] });
    const beforeEditOperation = validate(session, cwd, "VALIDATE-BEFORE-EDIT", false);
    expect(() => session.completeWork(review(beforeEditOperation))).toThrow(/PCH_MUTATION_REQUIRED/u);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.prepareToolOperation({
      toolCallId: "EDIT-AFTER-GATE", toolName: "edit",
      input: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    expect(session.observeToolResult("EDIT-AFTER-GATE", false, "edited")).toMatch(/PCH_OPERATION_COMMITTED/u);
    const afterEditOperation = validate(session, cwd, "VALIDATE-AFTER-EDIT", false);
    expect(session.completeWork(review(afterEditOperation))).toMatch(/Goal .* closed by current evidence/u);
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
    submitApprovedBuild(session, withAcceptanceV2({
      ...contract,
      obligations: [
        { key: "runtime", priority: "MUST", statement: "Runtime behavior passes", oracle: { command: "npm run test:runtime" } },
        { key: "types", priority: "MUST", statement: "Type behavior passes", oracle: { command: "npm run test:types" } },
      ],
    }), withGoalFitAssessment({
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
    }));
    const run = (id: string, command: string): string => {
      expect(session.prepareToolOperation({ toolCallId: id, toolName: "bash", input: { command }, cwd }))
        .toMatchObject({ allow: true, managed: true });
      return session.observeToolResult(id, false, `${command} passed`)!;
    };
    run("RUNTIME-LOCAL", "npm run test:runtime");
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(run("RUNTIME-FINAL", "npm run test:runtime")).toMatch(/remaining validation commands=1/u);
    expect(run("TYPES-FINAL", "npm run test:types")).toMatch(/Fresh oracle closure is ready/u);
    expect(session.completeWork()).toMatch(/Goal .* closed by current evidence/u);
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
    submitApprovedBuild(session, contract, route);
    session.reviseRequirement("SCOPE", "Refine the frozen scope before execution");
    session.submitContract({ ...contract, scope: ["src/example.ts", "src/extra.ts"] });
    approvePendingContract(session);
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
    submitApprovedBuild(session, scriptContract, scriptRoute);
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

  it("runs safe supplemental validation without attesting or closing the frozen oracle", () => {
    const { session, cwd, ctx } = fixture("SUPPLEMENTAL-VALIDATION");
    admit(session, cwd, ctx);
    expect(session.prepareToolOperation({
      toolCallId: "SUPPLEMENTAL", toolName: "bash", input: { command: "npm run test:types" }, cwd,
    })).toMatchObject({
      allow: true,
      managed: true,
      oracle_policy: { evidence_role: "SUPPLEMENTAL_VALIDATION" },
    });
    expect(session.observeToolResult("SUPPLEMENTAL", false, "supplemental tests passed"))
      .toMatch(/PCH_SUPPLEMENTAL_VALIDATION_COMMITTED/u);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    validate(session, cwd, "FROZEN-ORACLE");
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("keeps final evidence review open until explicit completion", () => {
    const { session, cwd, ctx } = fixture("PRESERVATION-REVIEW");
    mkdirSync(resolve(cwd, "tests"), { recursive: true });
    writeFileSync(resolve(cwd, "tests", "review.test.ts"), [
      'test("primary result remains verified", () => undefined);',
      'test("existing callers retain behavior", () => undefined);',
      "",
    ].join("\n"), "utf8");
    session.startFromInput("build: update src/example.ts while preserving existing callers and run tests", ctx);
    submitApprovedBuild(session, withGoalFitAssessment({
      ...contract,
      scope: ["src/example.ts", "tests/review.test.ts"],
      user_outcomes: ["The change works", "Existing callers remain unchanged"],
      acceptance_facets: [
        {
          key: "verified-output", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 0 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["verified-output"],
        },
        {
          key: "preserve-callers", kind: "INVARIANT", subject: { kind: "USER_OUTCOME", index: 1 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["preserve-callers"],
        },
        {
          key: "local-only", kind: "CONSTRAINT", subject: { kind: "CONSTRAINT", index: 0 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["verified-output"],
        },
        {
          key: "no-deployment", kind: "NON_GOAL", subject: { kind: "NON_GOAL", index: 0 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["verified-output"],
        },
      ],
      obligations: [
        contract.obligations[0]!,
        {
          key: "preserve-callers", priority: "MUST" as const,
          statement: "Existing callers retain their prior behavior", oracle: { command: "npm test" },
        },
      ],
    }), withGoalFitAssessment({
      ...route,
      work_cells: [{
        ...route.work_cells[0]!, obligation_keys: ["verified-output", "preserve-callers"],
        read_roots: ["src/example.ts", "tests/review.test.ts"],
        oracle: { command: "npm test" },
      }],
    }));
    expect(session.workflowPrompt()).toContain('MustOutcomes=[{"key":"verified-output"');
    expect(session.workflowPrompt()).toContain('"key":"preserve-callers"');
    expect(session.workflowPrompt()).toContain("A test-family name is not proof of preservation");
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-PRESERVATION", toolName: "write",
      input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    session.observeToolResult("WRITE-PRESERVATION", false, "written");
    const operationId = validate(session, cwd, "FINAL-ORACLE", false);
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(session.completeWork({ outcome_evidence: [
      { obligation_key: "verified-output", operation_id: operationId, witnesses: [{ path: "tests/review.test.ts", locator: "primary result remains verified" }] },
      { obligation_key: "preserve-callers", operation_id: operationId, witnesses: [{ path: "tests/review.test.ts", locator: "existing callers retain behavior" }] },
    ] })).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({
      phase: "SUCCEEDED", nextAction: "NONE", routeHealth: "H0_CONTINUE",
    });
  });

  it("requires distinct current test witnesses before shared-oracle preservation outcomes can close", () => {
    const { session, cwd, ctx } = fixture("OUTCOME-EVIDENCE-REVIEW");
    mkdirSync(resolve(cwd, "tests"), { recursive: true });
    writeFileSync(resolve(cwd, "tests", "preservation.test.ts"), [
      'test("primary result passes", () => undefined);',
      'test("browser clients retain behavior", () => undefined);',
      'test("batch clients retain behavior", () => undefined);',
      'test("export consumers retain behavior", () => undefined);',
      "",
    ].join("\n"), "utf8");
    session.startFromInput(
      "build: update src/example.ts. The primary result must pass. Preserve browser clients, batch clients, and export consumers.",
      ctx,
    );
    submitApprovedBuild(session, withGoalFitAssessment({
      user_outcomes: [
        "The primary result passes", "Browser clients are preserved",
        "Batch clients are preserved", "Export consumers are preserved",
      ],
      scope: ["src", "tests"], authorization_ceiling: "LOCAL_REVERSIBLE",
      acceptance_facets: [
        {
          key: "primary-result", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 0 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["primary"],
        },
        {
          key: "browser-clients", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 1 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["browser-clients"],
        },
        {
          key: "batch-clients", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 2 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["batch-clients"],
        },
        {
          key: "export-consumers", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 3 },
          source_binding: "ENTIRE_INTAKE", obligation_keys: ["export-consumers"],
        },
      ],
      obligations: [
        { key: "primary", priority: "MUST", statement: "The primary result passes", oracle: { command: "npm test" } },
        { key: "browser-clients", priority: "MUST", statement: "Browser clients are preserved", oracle: { command: "npm test" } },
        { key: "batch-clients", priority: "MUST", statement: "Batch clients are preserved", oracle: { command: "npm test" } },
        { key: "export-consumers", priority: "MUST", statement: "Export consumers are preserved", oracle: { command: "npm test" } },
      ],
    }), withGoalFitAssessment({
      outcomes: ["Update the implementation and preserve every consumer"],
      work_cells: [{
        key: "shared-change", outcome: "Update and verify the shared implementation",
        obligation_keys: ["primary", "browser-clients", "batch-clients", "export-consumers"],
        read_roots: ["src", "tests"], write_roots: ["src/example.ts"],
        effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm test" }, risk: "MEDIUM", reversible: true,
      }],
      near_horizon: ["shared-change"],
    }));
    expect(session.workflowPrompt()).toContain("OutcomeEvidenceRequired");
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-OUTCOME-EVIDENCE", toolName: "write",
      input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
    session.observeToolResult("WRITE-OUTCOME-EVIDENCE", false, "written");
    const operationId = validate(session, cwd, "OUTCOME-EVIDENCE-ORACLE", false);
    expect(() => session.completeWork()).toThrow(/outcome_evidence/u);

    expect(session.completeWork({ outcome_evidence: [
      { obligation_key: "primary", operation_id: operationId, witnesses: [{ path: "tests/preservation.test.ts", locator: "primary result passes" }] },
      { obligation_key: "browser-clients", operation_id: operationId, witnesses: [{ path: "tests/preservation.test.ts", locator: "browser clients retain behavior" }] },
      { obligation_key: "batch-clients", operation_id: operationId, witnesses: [{ path: "tests/preservation.test.ts", locator: "batch clients retain behavior" }] },
      { obligation_key: "export-consumers", operation_id: operationId, witnesses: [{ path: "tests/preservation.test.ts", locator: "export consumers retain behavior" }] },
    ] })).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
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
    expect(session.workflowPrompt()).not.toContain("Route proposal shape");
    expect(session.workflowPrompt()).toContain("oracle.commands only separates individually allowed commands");
    expect(session.workflowPrompt()).toContain('"commands":["<exact local command>"]');
    expect(session.workflowPrompt()).toContain("do not probe PI_MODEL, PI_SESSION");
    expect(session.workflowPrompt()).toContain("Do not add acceptance_policy.performance_contract unless");
    session.submitContract(contract);
    expect(session.workflowPrompt()).toBeNull();
    approvePendingContract(session);
    expect(session.workflowPrompt()).not.toContain("GoalContract proposal shape");
    expect(session.workflowPrompt()).toContain("Route proposal shape");
    expect(session.workflowPrompt()).toContain('"goal_fit_assessment":{...}');
    expect(session.workflowPrompt()).toContain('"proposal_origin":"CURRENT_AGENT_TYPED_PROPOSAL"');
    expect(session.workflowPrompt()).toContain("do not submit subject IDs, receipt hashes, Plan hashes, authority roots or a verdict");
    expect(session.workflowPrompt()).not.toContain('"verdict":');
    expect(session.workflowPrompt()).toContain("do not invent fields such as evidence");
    session.submitRoute(route);
    expect(session.workflowPrompt()).not.toContain("GoalContract proposal shape");
    expect(session.workflowPrompt()).not.toContain("Route proposal shape");
  });

  it("instructs BUILD to coalesce same-file edits and stop after the final oracle", () => {
    const { session, cwd, ctx } = fixture("WORKFLOW-EDIT-GUIDANCE");
    admit(session, cwd, ctx);
    expect(session.workflowPrompt()).toContain("Merge all edits to the same file in one turn into one edit call");
    expect(session.workflowPrompt()).toContain("successful managed mutation readback as current exact-source evidence");
    expect(session.workflowPrompt()).toContain("reread only when PCH reports missing or stale source");
    expect(session.workflowPrompt()).toContain("inspect direct callers");
    expect(session.workflowPrompt()).toContain("map each MustOutcome to local evidence");
    expect(session.workflowPrompt()).toContain("may batch up to eight authorized Go files");
    expect(session.workflowPrompt()).toContain("run every Oracle command exactly as shown");
    expect(session.workflowPrompt()).toContain("call coding_flow action=complete once");
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

  it("uses an exact grep glob as the effective frozen read target", () => {
    const { session, cwd, ctx } = fixture("EXACT-GREP-GLOB");
    admit(session, cwd, ctx);
    expect(session.prepareToolOperation({
      toolCallId: "GREP-EXACT-GLOB", toolName: "grep",
      input: { path: "src", glob: "example.ts", pattern: "value" }, cwd,
    })).toMatchObject({ allow: true, managed: false, reason: null });
    expect(session.prepareToolOperation({
      toolCallId: "GREP-WILDCARD-GLOB", toolName: "grep",
      input: { path: ".", glob: "*.ts", pattern: "value" }, cwd,
    })).toMatchObject({ allow: false, reason: "Read target is outside the frozen Route read scope." });
  });

  it("admits git describe without advancing Task Flow authority", () => {
    const { session, cwd, ctx } = fixture("GIT-DESCRIBE-PROBE");
    admit(session, cwd, ctx);
    const status = session.current()!;
    const authority = session.resources()!.authority;
    const before = {
      version: authority.readTaskFlowGoalVersion(status.goalId),
      integrity: authority.verifyTaskFlowIntegrity(),
    };
    expect(session.prepareToolOperation({
      toolCallId: "GIT-DESCRIBE", toolName: "bash",
      input: { command: "git describe --tags --always --dirty" }, cwd,
    })).toMatchObject({ allow: true, managed: false, reason: null });
    expect(session.prepareToolOperation({
      toolCallId: "GIT-DESCRIBE-MIXED", toolName: "bash",
      input: { command: "git describe --always && npm install" }, cwd,
    })).toMatchObject({ allow: false, managed: false });
    expect({
      version: authority.readTaskFlowGoalVersion(status.goalId),
      integrity: authority.verifyTaskFlowIntegrity(),
    }).toEqual(before);
  });

  it("manages bounded gofmt writes through per-file edit readback", () => {
    const { session, cwd, ctx } = fixture("GOFMT-EDIT");
    writeFileSync(resolve(cwd, "src", "example.go"), "package example\n\nvar Value = 1\n", "utf8");
    writeFileSync(resolve(cwd, "src", "other.go"), "package example\n\nvar Other = 2\n", "utf8");
    session.startFromInput("build: format the authorized Go files and verify", ctx);
    submitApprovedBuild(session, { ...contract, scope: ["src"] }, {
      ...route,
      work_cells: [{
        ...route.work_cells[0]!, read_roots: ["src"], write_roots: ["src"],
      }],
    });
    expect(session.prepareToolOperation({
      toolCallId: "GOFMT-ONE", toolName: "bash", input: { command: "gofmt -w src/example.go" }, cwd,
    })).toMatchObject({ allow: true, managed: true, reason: null });
    expect(session.observeToolResult("GOFMT-ONE", false, "")).toMatch(/PCH_OPERATION_COMMITTED/u);
    expect(session.prepareToolOperation({
      toolCallId: "GOFMT-MANY", toolName: "bash",
      input: { command: "gofmt -w src/example.go src/other.go" }, cwd,
    })).toMatchObject({ allow: true, managed: true, reason: null });
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const preparedBatch = authority.readUnresolvedTaskFlowOperations(goalId);
    expect(preparedBatch).toHaveLength(2);
    expect(session.observeToolResult("GOFMT-MANY", false, ""))
      .toMatch(/PCH_OPERATION_BATCH_COMMITTED operations=2/u);
    expect(authority.readUnresolvedTaskFlowOperations(goalId)).toHaveLength(0);
    expect(preparedBatch.map((entry) => authority.readTaskFlowOperation(goalId, entry.attempt.operation_id)?.state))
      .toEqual(["COMMITTED", "COMMITTED"]);
    expect(session.prepareToolOperation({
      toolCallId: "GOFMT-CHAINED", toolName: "bash",
      input: { command: "gofmt -w src/example.go src/other.go && npm test" }, cwd,
    })).toMatchObject({
      allow: false,
      reason: "Run the bounded formatter and validation in separate tool calls.",
    });
  });

  it("rejects an entire formatter batch when one target escapes the WorkCell write scope", () => {
    const { session, cwd, ctx } = fixture("GOFMT-BATCH-SCOPE");
    writeFileSync(resolve(cwd, "src", "example.go"), "package example\n\nvar Value = 1\n", "utf8");
    writeFileSync(resolve(cwd, "src", "other.go"), "package example\n\nvar Other = 2\n", "utf8");
    session.startFromInput("build: format only the authorized Go file and verify", ctx);
    submitApprovedBuild(session, { ...contract, scope: ["src/example.go"] }, {
      ...route,
      work_cells: [{
        ...route.work_cells[0]!, read_roots: ["src"], write_roots: ["src/example.go"],
      }],
    });
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const version = authority.readTaskFlowGoalVersion(goalId);
    expect(session.prepareToolOperation({
      toolCallId: "GOFMT-BATCH-SCOPE-ESCAPE", toolName: "bash",
      input: { command: "gofmt -w src/example.go src/other.go" }, cwd,
    })).toMatchObject({
      allow: false, managed: false,
      reason: "Operation target is outside the current WorkCell write scope.",
    });
    expect(authority.readUnresolvedTaskFlowOperations(goalId)).toHaveLength(0);
    expect(authority.readTaskFlowGoalVersion(goalId)).toBe(version);
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

  it("never marks an unresolved validation as safe to retry", () => {
    const { session, cwd, ctx } = fixture("VALIDATION-RECONCILE");
    expect(session.startFromInput("build: verify src/example.ts", ctx)).toMatchObject({ action: "transform" });
    session.submitContract({ ...contract, scope: ["src/example.ts", "src/adjacent-parser.ts"] });
    approvePendingContract(session);
    session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "material-change-revision" }],
      near_horizon: ["material-change-revision"],
      goal_fit_assessment: passingGoalFitAssessment(),
    });
    expect(session.prepareToolOperation({
      toolCallId: "VALIDATION-UNKNOWN", toolName: "bash", input: { command: "npm test" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
    session.endToolOperation("VALIDATION-UNKNOWN", false, "");
    expect(session.current()).toMatchObject({ phase: "RECONCILING", nextAction: "RECONCILE_OPERATION" });
    expect(session.reconcileOperations()).toMatch(/=APPLIED_UNVERIFIED/u);
    expect(session.current()).toMatchObject({ routeHealth: "H5_RECONCILE_OR_STOP" });
  });

  it("blocks a takeover owner from preparing new mutation until the durable unresolved operation is reconciled", () => {
    let now = Date.parse("2026-07-24T12:00:00.000Z");
    const { root, cwd, session, ctx } = fixture("UNRESOLVED-TAKEOVER", () => now);
    expect(session.startFromInput("build: update src/example.ts and run tests", ctx)).toMatchObject({ action: "transform" });
    submitApprovedBuild(session, contract, route);
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

  it("fences the current BUILD authorization as soon as a new active-Goal user turn arrives", () => {
    const { session, cwd, ctx } = fixture("ACTIVE-GOAL-USER-TURN-FENCE");
    admit(session, cwd, ctx);

    expect(session.startFromInput("Also update the nearby parser and preserve its callers.", ctx)).toBeNull();
    expect(() => createHarnessRun(session, "ACTIVE-GOAL-PENDING"))
      .toThrow(/user turn|classification|fenc/i);
    const authority = session.resources()!.authority;
    const lease = authority.acquireLease(
      session.current()!.goalId,
      ctx.sessionManager.getSessionId(),
      config().execution.lease_ttl_ms,
    );
    let effectRan = false;
    expect(() => authority.withLeaseFence(lease, () => { effectRan = true; }))
      .toThrow(/user turn|classification|fenc/i);
    expect(effectRan).toBe(false);
    expect(session.prepareToolOperation({
      toolCallId: "READ-AFTER-ACTIVE-GOAL-INPUT", toolName: "read",
      input: { path: "src/example.ts" }, cwd,
    })).toMatchObject({ allow: true, managed: false });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-AFTER-ACTIVE-GOAL-INPUT", toolName: "write",
      input: { path: "src/example.ts", content: "must remain fenced" }, cwd,
    })).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/user turn|classification|change/i),
    });
  });

  it("allows only a running Worker terminal transition while active-Goal classification is pending", () => {
    const { session, cwd, ctx } = fixture("ACTIVE-GOAL-WORKER-ABORT");
    admit(session, cwd, ctx);
    session.createHarnessRun({
      topology: "MULTI", createdByHostHmac: sha256Hex("host"),
      configSha256: sha256Hex("config"), decisionSha256: sha256Hex("decision"),
    });
    session.defineHarnessShards([{
      key: "implement", role: "IMPLEMENTER", outcome: "Update the bounded source",
      read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], oracle: {},
    }]);
    const modelFingerprintHmacByRole = Object.fromEntries(workerRoles.map((role) => [
      role, sha256Hex(`model:${role}`),
    ])) as Readonly<Record<typeof workerRoles[number], string>>;
    const execution = session.startNextHarnessWorker({
      modelFingerprintHmacByRole, ownerHmac: sha256Hex("worker-owner"),
    });
    expect(session.startFromInput("Also preserve the adjacent parser.", ctx)).toBeNull();

    expect(() => session.failHarnessWorker(execution, new Error("User changed the active Goal"), {
      input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null,
      cost: null, turns: 1, wallTimeMs: 1,
    }, "ABORTED")).not.toThrow();
    expect(session.harnessView()).toMatchObject({
      unresolvedWorkerRunIds: [],
      shards: [{ status: "FAILED" }],
    });
  });

  it("preserves exact active-Goal input bytes and restores its mutation fence after restart", () => {
    const { root, session, cwd, ctx } = fixture("ACTIVE-GOAL-USER-TURN-RECOVERY");
    admit(session, cwd, ctx);
    const source = "Preserve CRLF exactly.\r\nAlso cover the adjacent parser.";

    expect(session.startFromInput(source, ctx)).toBeNull();
    const authority = session.resources()!.authority;
    const pending = authority.readPendingActiveGoalUserTurns(session.current()!.goalId);
    expect(pending).toHaveLength(1);
    expect(Buffer.from(authority.readActiveGoalUserTurn(pending[0]!.user_turn_id)!.source_bytes).toString("utf8"))
      .toBe(source);
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(ctx);
    expect(resumed.current()).toMatchObject({ blocker: expect.stringMatching(/typed classification/i) });
    expect(resumed.resources()!.authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalUserTurns: 1,
      activeGoalInputClassifications: 0,
      activeGoalChangeRequests: 0,
      activeGoalChangeTransitions: 0,
    });
    expect(resumed.prepareToolOperation({
      toolCallId: "WRITE-AFTER-ACTIVE-GOAL-RESTART", toolName: "write",
      input: { path: "src/example.ts", content: "still fenced" }, cwd,
    })).toMatchObject({ allow: false, reason: expect.stringMatching(/classification/i) });
  });

  it("resumes the unchanged BUILD authorization only after a DISCUSSION_ONLY classification", () => {
    const { session, cwd, ctx } = fixture("ACTIVE-GOAL-DISCUSSION");
    admit(session, cwd, ctx);
    expect(session.startFromInput("What evidence currently proves the parser behavior?", ctx)).toBeNull();
    const pending = session.resources()!.authority.readPendingActiveGoalUserTurns(session.current()!.goalId);
    expect(pending).toHaveLength(1);

    expect(session.classifyActiveGoalInput({
      user_turn_id: pending[0]!.user_turn_id,
      expected_user_turn_sha256: pending[0]!.record_sha256,
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
    })).toMatch(/discussion_only.*recorded/i);
    expect(session.resources()!.authority.readPendingActiveGoalUserTurns(session.current()!.goalId)).toHaveLength(0);
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-AFTER-DISCUSSION", toolName: "write",
      input: { path: "src/example.ts", content: "authorization resumed" }, cwd,
    })).toMatchObject({ allow: true, managed: true });
  });

  it("atomically binds all same-base material turns to one successor and commits their event root", () => {
    const { root, session, cwd, ctx } = fixture("ACTIVE-GOAL-MATERIAL-CHANGE");
    admit(session, cwd, ctx);
    const source = "Also update the adjacent parser and preserve its existing callers.";
    expect(session.startFromInput(source, ctx)).toBeNull();
    expect(session.startFromInput("Also preserve the parser's public error contract.", ctx)).toBeNull();
    const authority = session.resources()!.authority;
    const [pending, secondPending] = authority.readPendingActiveGoalUserTurns(session.current()!.goalId);
    if (!pending || !secondPending) throw new TypeError("Expected two pending material turns");
    const changedSubjects = authority.readTaskFlowPlanV2(session.current()!.goalId)!.subjects;

    expect(session.classifyActiveGoalInput({
      user_turn_id: pending.user_turn_id,
      expected_user_turn_sha256: pending.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "SCOPE",
      changed_subjects: changedSubjects.map(({ kind, id }) => ({ kind, id })),
    })).toMatch(/change_request.*recorded/i);
    expect(session.current()).toMatchObject({ blocker: expect.stringMatching(/typed classification/i) });
    expect(session.classifyActiveGoalInput({
      user_turn_id: secondPending.user_turn_id,
      expected_user_turn_sha256: secondPending.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "BEHAVIOR",
      changed_subjects: changedSubjects.map(({ kind, id }) => ({ kind, id })),
    })).toMatch(/change_request.*recorded/i);
    expect(session.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "SUBMIT_CONTRACT" });
    const material = authority.readActiveGoalChangeRequestByTurn(pending.user_turn_id)!;
    const secondMaterial = authority.readActiveGoalChangeRequestByTurn(secondPending.user_turn_id)!;
    expect(material.classification).toMatchObject({
      classification: "CHANGE_REQUEST",
      changed_subject_count: changedSubjects.length,
    });
    expect(material.change.request).toMatchObject({
      classification: "CHANGE_REQUEST",
      content_sha256: pending.content_sha256,
      changed_subject_count: changedSubjects.length,
    });
    expect(material.binding).toMatchObject({
      user_turn_id: pending.user_turn_id,
      user_turn_sha256: pending.record_sha256,
      change_request_id: material.change.request.change_request_id,
    });
    expect(session.prepareToolOperation({
      toolCallId: "READ-AFTER-MATERIAL-CHANGE", toolName: "read",
      input: { path: "src/example.ts" }, cwd,
    })).toMatchObject({ allow: true, managed: false });
    expect(session.prepareToolOperation({
      toolCallId: "READ-OUTSIDE-ROUTE-AFTER-MATERIAL-CHANGE", toolName: "read",
      input: { path: "outside.ts" }, cwd,
    })).toMatchObject({
      allow: false,
      reason: "Read target is outside the frozen Route read scope.",
    });
    expect(session.prepareToolOperation({
      toolCallId: "WRITE-AFTER-MATERIAL-CHANGE", toolName: "write",
      input: { path: "src/example.ts", content: "old authorization must stay revoked" }, cwd,
    })).toMatchObject({ allow: false });

    session.submitContract({ ...contract, scope: ["src/example.ts", "src/adjacent-parser.ts"] });
    approvePendingContract(session);
    session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "material-change-revision" }],
      near_horizon: ["material-change-revision"],
      goal_fit_assessment: passingMaterialChangeGoalFitAssessment(),
    });
    const transition = authority.readActiveGoalChangeTransitionByTurn(pending.user_turn_id)!;
    const secondTransition = authority.readActiveGoalChangeTransitionByTurn(secondPending.user_turn_id)!;
    expect(transition).toMatchObject({
      binding_id: material.binding.binding_id,
      base_plan_revision_id: pending.plan_revision_id,
      successor_plan_revision_id: authority.readTaskFlowPlanV2(session.current()!.goalId)!.revision.plan_revision_id,
      successor_stage_gate_receipt_id: authority
        .readTaskFlowPlanStageGateV2(session.current()!.goalId, "MATERIAL_CHANGE")!.stage_gate_receipt_id,
    });
    expect(secondTransition).toMatchObject({
      binding_id: secondMaterial.binding.binding_id,
      base_plan_revision_id: secondPending.plan_revision_id,
      successor_plan_revision_id: transition.successor_plan_revision_id,
      successor_stage_gate_receipt_id: transition.successor_stage_gate_receipt_id,
    });
    const read = openAuthorityConnection({ path: authorityDatabasePath(root, cwd) });
    try {
      const event = read.prepare(`SELECT payload_json FROM events
        WHERE goal_id=? AND event_type='PLAN_FROZEN' ORDER BY sequence DESC LIMIT 1`)
        .get(session.current()!.goalId) as { payload_json?: unknown } | undefined;
      if (typeof event?.payload_json !== "string") throw new TypeError("Expected PLAN_FROZEN event payload");
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      const members = [transition, secondTransition].map((entry) => ({
        transition_id: entry.transition_id, record_sha256: entry.record_sha256,
      })).sort((left, right) => left.transition_id.localeCompare(right.transition_id));
      expect(payload).toMatchObject({
        activeGoalChangeTransitionCount: 2,
        activeGoalChangeTransitionRootSha256: canonicalJsonSha256({
          domain: "PCH-ACTIVE-GOAL-CHANGE-TRANSITION-ROOT-V2", members,
        }),
      });
    } finally {
      closeAuthorityConnection(read);
    }
    expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalUserTurns: 2,
      activeGoalInputClassifications: 2,
      activeGoalChangeRequests: 2,
      activeGoalChangeTransitions: 2,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
    });

    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);
    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(ctx);
    expect(resumed.resources()!.authority.readActiveGoalChangeTransitionByTurn(pending.user_turn_id)?.record_sha256)
      .toBe(transition.record_sha256);
    expect(resumed.resources()!.authority.readActiveGoalChangeTransitionByTurn(secondPending.user_turn_id)?.record_sha256)
      .toBe(secondTransition.record_sha256);
    expect(resumed.resources()!.authority.verifyTaskFlowPlanV2Integrity())
      .toMatchObject({
        activeGoalChangeTransitions: 2,
        decisionPlanBindings: 1,
        changeAcceptances: 1,
        headMismatches: 0,
      });

    const resumedAuthority = resumed.resources()!.authority;
    const firstSuccessor = resumedAuthority.readTaskFlowPlanV2(resumed.current()!.goalId)!;
    const firstMaterialGate = resumedAuthority
      .readTaskFlowPlanStageGateV2(resumed.current()!.goalId, "MATERIAL_CHANGE")!;
    expect(resumed.startFromInput("Also extend the second adjacent parser without losing prior changes.", ctx)).toBeNull();
    const [nextTurn] = resumedAuthority.readPendingActiveGoalUserTurns(resumed.current()!.goalId);
    if (!nextTurn) throw new TypeError("Expected the next material turn after restart");
    expect(nextTurn.stage_gate_sha256).toBe(firstMaterialGate.record_sha256);
    expect(resumed.classifyActiveGoalInput({
      user_turn_id: nextTurn.user_turn_id,
      expected_user_turn_sha256: nextTurn.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "SCOPE",
      changed_subjects: firstSuccessor.subjects.map(({ kind, id }) => ({ kind, id })),
    })).toMatch(/change_request.*recorded/i);
    resumed.submitContract({
      ...contract,
      scope: ["src/example.ts", "src/adjacent-parser.ts", "src/second-adjacent-parser.ts"],
    });
    approvePendingContract(resumed);
    resumed.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "second-material-change-revision" }],
      near_horizon: ["second-material-change-revision"],
      goal_fit_assessment: passingMaterialChangeGoalFitAssessment(),
    });
    const secondSuccessor = resumedAuthority.readTaskFlowPlanV2(resumed.current()!.goalId)!;
    const nextTransition = resumedAuthority.readActiveGoalChangeTransitionByTurn(nextTurn.user_turn_id)!;
    expect(secondSuccessor.revision).toMatchObject({
      parent_plan_revision_id: firstSuccessor.revision.plan_revision_id,
      parent_plan_revision_sha256: firstSuccessor.revision.record_sha256,
    });
    expect(nextTransition).toMatchObject({
      base_plan_revision_id: firstSuccessor.revision.plan_revision_id,
      successor_plan_revision_id: secondSuccessor.revision.plan_revision_id,
      successor_stage_gate_receipt_id: resumedAuthority
        .readTaskFlowPlanStageGateV2(resumed.current()!.goalId, "MATERIAL_CHANGE")!.stage_gate_receipt_id,
    });
    expect(resumedAuthority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalChangeTransitions: 3,
      decisionPlanBindings: 2,
      changeAcceptances: 2,
      headMismatches: 0,
    });
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

  it("resumes a staged MATERIAL_CHANGE gate without duplicating its acceptance closure", () => {
    const { root, cwd, session, ctx } = fixture("MATERIAL-GATE-RECOVERY");
    admit(session, cwd, ctx);
    expect(session.startFromInput("Also revise the adjacent parser contract.", ctx)).toBeNull();
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const [turn] = authority.readPendingActiveGoalUserTurns(goalId);
    const basePlan = authority.readTaskFlowPlanV2(goalId)!;
    if (!turn) throw new TypeError("Expected one pending material turn");
    session.classifyActiveGoalInput({
      user_turn_id: turn.user_turn_id,
      expected_user_turn_sha256: turn.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "SCOPE",
      changed_subjects: basePlan.subjects.map(({ kind, id }) => ({ kind, id })),
    });
    session.submitContract({ ...contract, scope: ["src/example.ts", "src/adjacent-parser.ts"] });
    approvePendingContract(session);
    crashBeforePendingAuthorityReconciliation(session, "MATERIAL_GATE_RECOVERY");
    expect(() => session.submitRoute({
      ...route,
      work_cells: [{ ...route.work_cells[0]!, key: "material-gate-recovery" }],
      near_horizon: ["material-gate-recovery"],
      goal_fit_assessment: passingMaterialChangeGoalFitAssessment(),
    })).toThrow("SIMULATED_CRASH_MATERIAL_GATE_RECOVERY");
    authority.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId },
      session.binding()!.mutation("TEST-MATERIAL-GATE-RECOVERY:finalize"));
    expect(authority.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "COMMIT_PLAN_GATE",
    });
    expect(authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalChangeTransitions: 0,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
    });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(ctx);
    const resumedAuthority = resumed.resources()!.authority;
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
    expect(resumedAuthority.readTaskFlowPlanStageGateV2(goalId, "MATERIAL_CHANGE")).not.toBeNull();
    expect(resumedAuthority.readActiveGoalChangeTransitionByTurn(turn.user_turn_id)).not.toBeNull();
    expect(resumedAuthority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalChangeTransitions: 1,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
      headMismatches: 0,
    });
  });

  it("rolls back the whole MATERIAL_CHANGE gate when the second transition faults", () => {
    const { root, cwd, session, ctx } = fixture("MATERIAL-TRANSITION-FAULT");
    admit(session, cwd, ctx);
    expect(session.startFromInput("Also revise the adjacent parser contract.", ctx)).toBeNull();
    expect(session.startFromInput("Also preserve its public error contract.", ctx)).toBeNull();
    const authority = session.resources()!.authority;
    const goalId = session.current()!.goalId;
    const [firstTurn, secondTurn] = authority.readPendingActiveGoalUserTurns(goalId);
    const basePlan = authority.readTaskFlowPlanV2(goalId)!;
    if (!firstTurn || !secondTurn) throw new TypeError("Expected two pending material turns");
    for (const [index, turn] of [firstTurn, secondTurn].entries()) {
      session.classifyActiveGoalInput({
        user_turn_id: turn.user_turn_id,
        expected_user_turn_sha256: turn.record_sha256,
        classification: "CHANGE_REQUEST",
        materiality: "HIGH",
        change_kind: index === 0 ? "SCOPE" : "BEHAVIOR",
        changed_subjects: basePlan.subjects.map(({ kind, id }) => ({ kind, id })),
      });
    }
    session.submitContract({ ...contract, scope: ["src/example.ts", "src/adjacent-parser.ts"] });
    approvePendingContract(session);

    const databasePath = authorityDatabasePath(root, cwd);
    const beforeFault = openAuthorityConnection({ path: databasePath });
    let planFrozenEventCount: number;
    try {
      const row = beforeFault.prepare(`SELECT count(*) count FROM events
        WHERE goal_id=? AND event_type='PLAN_FROZEN'`).get(goalId) as { readonly count: number };
      planFrozenEventCount = row.count;
    } finally {
      closeAuthorityConnection(beforeFault);
    }
    const faultConnection = openAuthorityConnection({ path: databasePath });
    try {
      faultConnection.exec(`CREATE TRIGGER fault_second_active_goal_transition
        BEFORE INSERT ON active_goal_change_transitions_v2
        WHEN (SELECT count(*) FROM active_goal_change_transitions_v2)=1
        BEGIN SELECT RAISE(ABORT,'faulted second active Goal transition'); END`);
    } finally {
      closeAuthorityConnection(faultConnection);
    }
    try {
      expect(() => session.submitRoute({
        ...route,
        work_cells: [{ ...route.work_cells[0]!, key: "material-transition-fault" }],
        near_horizon: ["material-transition-fault"],
        goal_fit_assessment: passingMaterialChangeGoalFitAssessment(),
      })).toThrow(/faulted second active Goal transition/u);
    } finally {
      const cleanup = openAuthorityConnection({ path: databasePath });
      try { cleanup.exec("DROP TRIGGER fault_second_active_goal_transition"); }
      finally { closeAuthorityConnection(cleanup); }
    }

    expect(authority.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "COMMIT_PLAN_GATE",
    });
    expect(authority.readTaskFlowPlanStageGateV2(goalId, "MATERIAL_CHANGE")).toBeNull();
    expect(authority.readActiveGoalChangeTransitionByTurn(firstTurn.user_turn_id)).toBeNull();
    expect(authority.readActiveGoalChangeTransitionByTurn(secondTurn.user_turn_id)).toBeNull();
    const read = openAuthorityConnection({ path: databasePath });
    try {
      expect(read.prepare(`SELECT count(*) count FROM events
        WHERE goal_id=? AND event_type='PLAN_FROZEN'`).get(goalId)).toEqual({ count: planFrozenEventCount });
    } finally {
      closeAuthorityConnection(read);
    }
    expect(authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalChangeTransitions: 0,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
      headMismatches: 0,
    });

    authority.transactTaskFlow(
      { type: "COMMIT_TASK_FLOW_PLAN_GATE", goalId },
      session.binding()!.mutation("TEST-MATERIAL-TRANSITION-FAULT:retry"),
    );
    expect(authority.readTaskFlowPlanStageGateV2(goalId, "MATERIAL_CHANGE")).not.toBeNull();
    expect(authority.readActiveGoalChangeTransitionByTurn(firstTurn.user_turn_id)).not.toBeNull();
    expect(authority.readActiveGoalChangeTransitionByTurn(secondTurn.user_turn_id)).not.toBeNull();
    expect(authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
      activeGoalChangeTransitions: 2,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
      headMismatches: 0,
    });
  });

  it("resumes FINALIZE_INTAKE after the USER review commit without another user turn", () => {
    const { root, cwd, session, ctx } = fixture("FINALIZE-INTAKE-RECOVERY");
    expect(session.startFromInput("build: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    const review = session.contractReview();
    if (!review) throw new TypeError("Test fixture expected a pending Goal Contract review");
    crashBeforePendingAuthorityReconciliation(session, "FINALIZE_INTAKE");
    expect(() => session.resolveContractReview({
      expectedDecisionRequirementRevisionId: review.decisionRequirementRevisionId,
      expectedRequirementRevisionSha256: review.requirementRevisionSha256,
      expectedDecisionFrontierSha256: review.decisionFrontierSha256,
      action: "APPROVE",
      selectedValue: true,
      turnId: "TEST-FINALIZE-INTAKE-RECOVERY",
    })).toThrow("SIMULATED_CRASH_FINALIZE_INTAKE");
    expect(session.current()).toMatchObject({ phase: "CONTRACTING", nextAction: "FINALIZE_INTAKE" });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-FINALIZE-INTAKE-RECOVERY"));
    expect(resumed.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE" });
    expect(resumed.contractReview()).toBeNull();
  });

  it("resumes FINALIZE_PLAN after the Route commit and restores executable BUILD state", () => {
    const { root, cwd, session, ctx } = fixture("FINALIZE-PLAN-RECOVERY");
    expect(session.startFromInput("build: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    approvePendingContract(session);
    crashBeforePendingAuthorityReconciliation(session, "FINALIZE_PLAN");
    expect(() => session.submitRoute(route)).toThrow("SIMULATED_CRASH_FINALIZE_PLAN");
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "FINALIZE_PLAN" });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-FINALIZE-PLAN-RECOVERY"));
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
  });

  it("resumes COMMIT_PLAN_GATE after Plan and Goal Fit commit without repeating review", () => {
    const { root, cwd, session, ctx } = fixture("COMMIT-PLAN-GATE-RECOVERY");
    expect(session.startFromInput("build: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    approvePendingContract(session);
    crashBeforePendingAuthorityReconciliation(session, "BEFORE_PLAN_REVIEW");
    expect(() => session.submitRoute(route)).toThrow("SIMULATED_CRASH_BEFORE_PLAN_REVIEW");
    const goalId = session.current()!.goalId;
    const authority = session.resources()!.authority;
    const lease = authority.acquireLease(goalId, "SESSION-COMMIT-PLAN-GATE-RECOVERY", config().execution.lease_ttl_ms);
    authority.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId }, {
      expectedVersion: authority.readTaskFlowGoalVersion(goalId),
      idempotencyKey: "TEST-COMMIT-PLAN-GATE-RECOVERY:review-plan",
      actor: "RUNTIME",
      lease,
    });
    expect(authority.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "COMMIT_PLAN_GATE",
    });
    session.shutdown();
    sessions.splice(sessions.indexOf(session), 1);

    const resumed = new TaskFlowSession({
      config: config(), packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    sessions.push(resumed);
    resumed.initialize(context(cwd, "SESSION-COMMIT-PLAN-GATE-RECOVERY"));
    expect(resumed.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
  });

  it("survives restart at PLAN continuation and enters BUILD only after the user choice", async () => {
    const { root, cwd, session, ctx } = fixture("PLAN");
    expect(session.startFromInput("plan: 修改 src/example.ts 并运行测试", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    approvePendingContract(session);
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
    approvePendingContract(session);
    session.submitRoute(route);
    expect(session.resolvePlanContinuation("KEEP", session.planReview()!)).toMatch(/kept without implementation/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(session.harnessView()).toMatchObject({ status: "SUCCEEDED" });
    expect(session.startFromInput("build: start the next bounded task", ctx)).toMatchObject({ action: "transform" });
    expect(createHarnessRun(session, "PLAN-KEEP-NEXT")).toMatchObject({ status: "ACTIVE" });
  });

  it("rejects a delayed continuation after the frozen Plan closure changes", () => {
    let nowMs = Date.parse("2026-07-24T12:00:00.000Z");
    const { session, ctx } = fixture("PLAN-STALE-CONTINUATION", () => nowMs++);
    expect(session.startFromInput("plan: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    approvePendingContract(session);
    session.submitRoute(route);
    const stale = session.planReview()!;
    const authority = session.resources()!.authority;
    const initialGate = authority.readTaskFlowPlanStageGateV2(session.current()!.goalId, "PLAN_ENTRY")!;

    expect(session.resolvePlanContinuation("REVISE", stale)).toMatch(/submit a revised RouteSkeleton/u);
    session.submitRouteRevision(withGoalFitAssessment({
      work_cells: [{ ...route.work_cells[0]!, key: "bounded-change-revised" }],
    }));
    const revisedGate = authority.readTaskFlowPlanStageGateV2(session.current()!.goalId, "PLAN_ENTRY")!;
    expect(revisedGate).toMatchObject({
      decision_closure_id: initialGate.decision_closure_id,
      decision_closure_sha256: initialGate.decision_closure_sha256,
    });
    expect(revisedGate.goal_fit_review_id).not.toBe(initialGate.goal_fit_review_id);
    expect(revisedGate.goal_fit_review_sha256).not.toBe(initialGate.goal_fit_review_sha256);
    expect(revisedGate.created_at_ms).toBeGreaterThan(initialGate.created_at_ms);
    expect(session.planReview()?.routeSha256).not.toBe(stale.routeSha256);
    expect(() => session.resolvePlanContinuation("BUILD", stale)).toThrow(/stale|closure|binding/iu);
    expect(session.current()).toMatchObject({ phase: "WAITING_USER", nextAction: "PLAN_CONTINUATION" });
  });

  it("expands deferred outcomes through a RouteRevision without revising the GoalContract", () => {
    const { session, cwd, ctx } = fixture("DEFERRED");
    expect(session.startFromInput("build: update src/example.ts and verify", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(withAcceptanceV2({
      ...contract,
      obligations: [
        { key: "implemented", priority: "MUST", statement: "The bounded change is implemented", oracle: { command: "npm test" } },
        { key: "verified", priority: "MUST", statement: "The final workspace is verified", oracle: { command: "npm test" } },
      ],
    }));
    approvePendingContract(session);
    session.submitRoute(withGoalFitAssessment({
      outcomes: ["Implement and then verify"],
      work_cells: [{
        ...route.work_cells[0]!, key: "implement", obligation_keys: ["implemented"],
      }],
      deferred_outcomes: [{
        key: "final-verification", outcome: "Verify the final workspace", obligation_keys: ["verified"],
        dependencies: ["implement"], expansion_trigger: "WORK_CELL_CLOSED", commitment: "REVERSIBLE",
      }],
    }));
    expect(session.current()).toMatchObject({ phase: "BUILDING", routeHealth: "H0_CONTINUE" });
    const beforeGraph = session.resources()!.authority.readTaskFlowGoalVersion(session.current()!.goalId);
    expect(session.detail("graph")).toMatch(/\[DEFERRED:WORK_CELL_CLOSED\]/u);
    expect(session.resources()!.authority.readTaskFlowGoalVersion(session.current()!.goalId)).toBe(beforeGraph);
    validate(session, cwd, "VALIDATE-DEFERRED-1");
    expect(session.current()).toMatchObject({ phase: "PLANNING", nextAction: "SUBMIT_ROUTE" });
    session.submitRoute(withGoalFitAssessment({
      lane: "DIRECT_CELL", outcomes: ["Revalidate final acceptance"],
      work_cells: [{
        ...route.work_cells[0]!, key: "final-verification", obligation_keys: ["implemented", "verified"],
      }],
    }));
    validate(session, cwd, "VALIDATE-DEFERRED-2");
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
  });

  it("promotes a directory-scoped DirectCell hint before authorization", () => {
    const { session, ctx } = fixture("DIRECTORY-PROMOTION");
    expect(session.startFromInput("build: update src and run tests", ctx)).toMatchObject({ action: "transform" });
    session.submitContract(contract);
    approvePendingContract(session);
    const result = session.submitRoute(withGoalFitAssessment({
      lane: "DIRECT_CELL", outcomes: ["Update the bounded source directory"],
      work_cells: [{ ...route.work_cells[0]!, read_roots: ["src"], write_roots: ["src"] }],
    }));
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
    approvePendingContract(linkedFixture.session);
    expect(() => linkedFixture.session.submitRoute(withGoalFitAssessment({
      outcomes: ["Update linked scope"],
      work_cells: [{ ...route.work_cells[0]!, read_roots: ["src", "linked"], write_roots: ["src", "linked"] }],
    }))).toThrow(/unsafe link/u);
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
    approvePendingContract(session);
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
    expect(() => session.submitRouteRevision(withGoalFitAssessment({
      work_cells: route.work_cells,
    }))).toThrow(/does not change the effective Route execution semantics/u);
    expect(session.resources()!.authority.readTaskFlowView(session.current()!.goalId)!.route?.route_id)
      .toBe(previousRoute.route_id);
    session.submitRouteRevision(withGoalFitAssessment({
      work_cells: [{ ...route.work_cells[0]!, key: "bounded-repair" }],
    }));
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
    expect(submitApprovedBuild(session, contract, route)).toMatch(/authorization preflight reframed/u);
    expect(session.current()).toMatchObject({
      phase: "PLANNING", nextAction: "SUBMIT_ROUTE", routeHealth: "H3_REFRAME",
      blocker: expect.stringContaining("simulated unsafe baseline race"),
    });
    capture.mockRestore();
    session.submitRouteRevision(withGoalFitAssessment({
      work_cells: [{ ...route.work_cells[0]!, key: "bounded-preflight-retry" }],
    }));
    expect(session.current()).toMatchObject({
      phase: "BUILDING", nextAction: "EXECUTE_WORK", routeHealth: "H0_CONTINUE", blocker: null,
    });
  });

  it("rejects an oversized baseline manifest during authorization preflight", () => {
    const { session, cwd, ctx } = fixture("BASELINE-MANIFEST-BUDGET");
    for (let index = 0; index < 1_600; index += 1) {
      writeFileSync(resolve(cwd, "src", `fixture-${index.toString().padStart(4, "0")}.ts`), "", "utf8");
    }
    session.startFromInput("build: update the bounded src tree and verify", ctx);
    expect(submitApprovedBuild(session, contract, {
      ...route,
      work_cells: [{ ...route.work_cells[0]!, read_roots: ["src"], write_roots: ["src/example.ts"] }],
    })).toMatch(/authorization preflight reframed/u);
    expect(session.current()).toMatchObject({
      phase: "PLANNING", nextAction: "SUBMIT_ROUTE", routeHealth: "H3_REFRAME",
      blocker: expect.stringContaining("manifest budget"),
    });
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
    const performanceGoal = withGoalFitAssessment(withAcceptanceV2({
      user_outcomes: ["Parser latency improves without correctness regression"], scope: ["src/example.ts"],
      non_goals: ["No deployment"], constraints: ["Keep the patch reversible"],
      obligations: [{ key: "correctness", priority: "MUST" as const, statement: "Tests pass", oracle: { command: "npm test" } }],
      acceptance_policy: { all_must: true, performance_contract: performanceContract },
      authorization_ceiling: "LOCAL_REVERSIBLE" as const,
    }));
    const performanceRoute = withGoalFitAssessment({
      lane: "ADAPTIVE_ROUTE" as const, outcomes: ["Baseline measured", "Candidate improved", "Holdout passed"],
      work_cells: [
        {
          key: "baseline", outcome: "Measure frozen baseline", obligation_keys: ["correctness"],
          read_roots: ["src/example.ts"], write_roots: [], effect_classes: ["LOCAL_REVERSIBLE" as const],
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
          read_roots: ["src/example.ts"], write_roots: [], effect_classes: ["LOCAL_REVERSIBLE" as const],
          oracle: { commands: ["npm test", "npm run bench:holdout"] },
          risk: "LOW" as const, reversible: true, budget: { max_attempts: 1, performance_phase: "HOLDOUT" },
        },
      ],
    });
    const benchmark = (key: string, value: number) => `PCH_BENCHMARK_RESULT_V1=${JSON.stringify({
      schema_version: 1, workload_key: key, environment_sha256: "a".repeat(64),
      sample_count: 30, metrics: { latency_p95: value },
    })}`;
    const run = (id: string, command: string, output: string): string => {
      const admission = session.prepareToolOperation({ toolCallId: id, toolName: "bash", input: { command }, cwd });
      expect(admission, `${id} (${command}): ${admission.reason ?? "no reason"}`)
        .toMatchObject({ allow: true, managed: true });
      return session.observeToolResult(id, false, output)!;
    };

    expect(session.startFromInput("build: optimize parser performance and latency", ctx)).toMatchObject({ action: "transform" });
    submitApprovedBuild(session, performanceGoal, performanceRoute);
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
    expect(final).toMatch(/Fresh oracle closure is ready/u);
    expect(session.completeWork()).toMatch(/Goal .* closed by current evidence/u);
    expect(session.current()).toMatchObject({ phase: "SUCCEEDED", nextAction: "NONE" });
    expect(session.resources()!.authority.readTargetPerformanceMeasurements(session.current()!.goalId, "BASELINE_PROFILE"))
      .toHaveLength(3);
  }, 15_000);
});
