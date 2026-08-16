import { resolve } from "node:path";
import type { MemoryMigrationOptions } from "../../src/authority/memory-migrate.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { legacyIntakeClassification } from "../../src/planning/intake-classifier.js";
import { sealTaskFlowRecord, type ExecutionAuthorizationRecord, type GoalContractRecord, type RouteSkeletonRecord, type TaskObligationRecord, type WorkCellRecord, type WorkspaceBaselineRecord } from "../../src/task-flow/domain.js";
import { createTestAuthority, type TestAuthority } from "./authority.js";
import type { AcceptanceFacetProposalV2 } from "../../src/acceptance-v2/domain.js";
import type { GoalContractProposal } from "../../src/task-flow/finalize.js";
import { decisionFrontierSha256V2 } from "../../src/intake-v2/finalize.js";

export const taskFlowMemoryMigrations: MemoryMigrationOptions = {
  structuredPath: resolve("schemas", "sql", "003_memory.sql"),
  ftsPath: resolve("schemas", "sql", "004_memory_fts.sql"),
  claimsPath: resolve("schemas", "sql", "005_memory_claims.sql"),
  claimsFtsPath: resolve("schemas", "sql", "006_memory_claims_fts.sql"),
  checkpointPath: resolve("schemas", "sql", "007_memory_checkpoint.sql"),
  vaultPath: resolve("schemas", "sql", "008_memory_v3_vault.sql"),
  lifecyclePath: resolve("schemas", "sql", "009_memory_v3_lifecycle.sql"),
  captureV31Path: resolve("schemas", "sql", "010_memory_v3_1_capture.sql"),
  forceIndexMode: "TAG_PATH",
  nowMs: 1_800_000_000_000,
};

export function createTaskFlowAuthority(): TestAuthority {
  return createTestAuthority({
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
  });
}

type TaskFlowLease = ReturnType<TestAuthority["store"]["acquireLease"]>;

export function reviewAndFinalizeTaskFlowContract(
  authority: TestAuthority,
  goalId: string,
  lease: TaskFlowLease,
  expectedVersion: number,
  keyPrefix: string,
): number {
  const intake = authority.store.readTaskFlowIntakeV2(goalId);
  const review = intake?.decisions.find((decision) => decision.kind === "DRAFT_REVIEW");
  if (!intake || !review) throw new Error("Task Flow fixture lacks its draft review Decision");
  authority.store.transactTaskFlowUserInput({
    type: "RESOLVE_GOAL_CONTRACT_REVIEW",
    goalId,
    expectedDecisionRequirementRevisionId: review.decision_requirement_revision_id,
    expectedRequirementRevisionSha256: intake.requirement.revision.record_sha256,
    expectedDecisionFrontierSha256: decisionFrontierSha256V2(intake.decisions),
    action: "APPROVE",
    selectedValue: true,
  }, {
    expectedVersion,
    idempotencyKey: `${keyPrefix}:review`,
    lease,
    sessionId: lease.ownerSessionId,
    turnId: `${keyPrefix}:review-turn`,
  });
  authority.store.transactTaskFlow({
    type: "FINALIZE_GOAL_CONTRACT_INTAKE",
    goalId,
  }, {
    expectedVersion: expectedVersion + 1,
    idempotencyKey: `${keyPrefix}:finalize-intake`,
    actor: "RUNTIME",
    lease,
  });
  return expectedVersion + 2;
}

export function finalizeTaskFlowPlan(
  authority: TestAuthority,
  goalId: string,
  lease: TaskFlowLease,
  expectedVersion: number,
  keyPrefix: string,
): { readonly nextVersion: number; readonly decisionClosureSha256: string } {
  authority.store.transactTaskFlow({
    type: "FINALIZE_TASK_FLOW_PLAN",
    goalId,
  }, {
    expectedVersion,
    idempotencyKey: `${keyPrefix}:review-plan`,
    actor: "RUNTIME",
    lease,
  });
  authority.store.transactTaskFlow({ type: "COMMIT_TASK_FLOW_PLAN_GATE", goalId }, {
    expectedVersion: expectedVersion + 1,
    idempotencyKey: `${keyPrefix}:commit-plan-gate`,
    actor: "RUNTIME",
    lease,
  });
  const gate = authority.store.readTaskFlowPlanStageGateV2(goalId, "PLAN_ENTRY");
  if (!gate) throw new Error("Task Flow fixture lacks its PLAN_ENTRY StageGate");
  return { nextVersion: expectedVersion + 2, decisionClosureSha256: gate.decision_closure_sha256 };
}

export function taskAdmissionMetadata(lane: "DIRECT_CELL" | "ADAPTIVE_ROUTE") {
  const planningDepth = lane === "DIRECT_CELL" ? "LIGHT" as const : "STANDARD" as const;
  return {
    requirementProfile: "TASK_SPEC" as const,
    planningDepth,
    classification: legacyIntakeClassification("TASK_SPEC", planningDepth),
  };
}

export function taskContract(goalId: string, nowMs: number, intent: "PLAN" | "BUILD" = "BUILD", lane: "DIRECT_CELL" | "ADAPTIVE_ROUTE" = "DIRECT_CELL"): GoalContractRecord {
  const contractId = "CONTRACT-TEST-001";
  const obligation = sealTaskFlowRecord<TaskObligationRecord, "record_sha256">("PCH-TASK-OBLIGATION-V1", {
    obligation_id: "OBLIGATION-TEST-001", contract_id: contractId, goal_id: goalId,
    semantic_key: "verified-output", priority: "MUST" as const, statement: "The bounded output passes its oracle",
    oracle: { command: "npm test" }, dependencies: [] as string[], ordinal: 0,
  }, "record_sha256");
  return sealTaskFlowRecord<GoalContractRecord, "record_sha256">("PCH-GOAL-CONTRACT-V1", {
    schema_version: 1 as const, contract_id: contractId, goal_id: goalId, version: 1,
    parent_contract_id: null, intent, lane,
    objective: "Produce one verified local result", user_outcomes: ["Verified result"], scope: ["src/example.ts"],
    non_goals: ["External deployment"], constraints: ["Single Agent"], assumption_refs: [], decision_refs: [],
    obligations: [obligation], acceptance_policy: { all_must: true }, authorization_ceiling: "LOCAL_REVERSIBLE" as const,
    source_intake_sha256: sha256Hex("task-flow-intake"), created_at_ms: nowMs,
  }, "record_sha256");
}

export function taskContractProposal(): GoalContractProposal {
  return {
    user_outcomes: ["Verified result"],
    scope: ["src/example.ts"],
    non_goals: ["External deployment"],
    constraints: ["Single Agent"],
    assumption_refs: [],
    decision_refs: [],
    obligations: [{
      key: "verified-output",
      priority: "MUST",
      statement: "The bounded output passes its oracle",
      oracle: { command: "npm test" },
    }],
    acceptance_policy: { all_must: true },
    authorization_ceiling: "LOCAL_REVERSIBLE",
  };
}

export function taskAcceptanceFacets(): readonly AcceptanceFacetProposalV2[] {
  return [
    {
      key: "verified-result",
      kind: "OUTCOME",
      subject: { kind: "USER_OUTCOME", index: 0 },
      source_binding: "ENTIRE_INTAKE",
      obligation_keys: ["verified-output"],
    },
    {
      key: "single-agent-constraint",
      kind: "CONSTRAINT",
      subject: { kind: "CONSTRAINT", index: 0 },
      source_binding: "ENTIRE_INTAKE",
      obligation_keys: ["verified-output"],
    },
    {
      key: "external-deployment-bound",
      kind: "NON_GOAL",
      subject: { kind: "NON_GOAL", index: 0 },
      source_binding: "ENTIRE_INTAKE",
      obligation_keys: ["verified-output"],
    },
  ];
}

export function taskRoute(
  contract: GoalContractRecord,
  nowMs: number,
  roots: { readonly readRoots?: readonly string[]; readonly writeRoots?: readonly string[] } = {},
): RouteSkeletonRecord {
  const obligationId = contract.obligations[0]?.obligation_id;
  if (!obligationId) throw new TypeError("Task Flow fixture contract requires one obligation");
  const cell = sealTaskFlowRecord<WorkCellRecord, "spec_sha256">("PCH-WORK-CELL-V1", {
    schema_version: 1 as const, work_cell_id: "CELL-TEST-001", goal_id: contract.goal_id,
    contract_id: contract.contract_id, route_id: "ROUTE-TEST-001", logical_key: "bounded-change", ordinal: 0,
    horizon: "CURRENT" as const, outcome: "Local result implemented and verified",
    obligation_ids: [obligationId], dependencies: [] as string[], read_roots: roots.readRoots ?? ["src"],
    write_roots: roots.writeRoots ?? ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE" as const],
    oracle: { command: "npm test" }, risk: "LOW" as const, reversible: true, budget: { max_attempts: 2 },
  }, "spec_sha256");
  return sealTaskFlowRecord<RouteSkeletonRecord, "record_sha256">("PCH-ROUTE-SKELETON-V1", {
    schema_version: 1 as const, route_id: "ROUTE-TEST-001", goal_id: contract.goal_id,
    contract_id: contract.contract_id, revision: 1, parent_route_id: null, lane: contract.lane,
    outcomes: ["Verified result"], assumptions: [], risks: [], alternatives: [],
    acceptance_coverage: { [obligationId]: ["CELL-TEST-001"] }, work_cells: [cell],
    near_horizon: ["CELL-TEST-001"], created_at_ms: nowMs,
  }, "record_sha256");
}

export function taskBaseline(goalId: string, nowMs: number): WorkspaceBaselineRecord {
  return sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
    schema_version: 1 as const, baseline_id: "BASELINE-TEST-001", workspace_id: "WS-TEST-001", goal_id: goalId,
    filesystem_identity_hmac: sha256Hex("filesystem"), content_root_sha256: sha256Hex("content-root"),
    environment_sha256: sha256Hex("environment"), oracle_set_sha256: sha256Hex("oracles"),
    scope_manifest: [{ root: "src/example.ts" }], created_at_ms: nowMs,
  }, "record_sha256");
}

export function taskAuthorization(
  goalId: string,
  contract: GoalContractRecord,
  baseline: WorkspaceBaselineRecord,
  generation: number,
  fencingToken: number,
  nowMs: number,
  decisionClosureSha256 = sha256Hex("decisions"),
  ttlMs = 60_000,
): ExecutionAuthorizationRecord {
  return sealTaskFlowRecord<ExecutionAuthorizationRecord, "record_sha256">("PCH-EXECUTION-AUTHORIZATION-V1", {
    schema_version: 1 as const, authorization_id: "AUTHORIZATION-TEST-001", goal_id: goalId,
    contract_id: contract.contract_id, route_id: "ROUTE-TEST-001", work_cell_id: "CELL-TEST-001",
    baseline_id: baseline.baseline_id, lease_generation: generation, fencing_token: fencingToken,
    effect_ceiling: "LOCAL_REVERSIBLE" as const, decision_closure_sha256: decisionClosureSha256,
    allowed_scope_sha256: sha256Hex("src/example.ts"), expires_at_ms: nowMs + ttlMs, created_at_ms: nowMs,
  }, "record_sha256");
}
