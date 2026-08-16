import { canonicalJsonSha256, omitProperty } from "../../authority/canonical-json.js";

export type DecisionInboxKindV2 =
  | "ACTIVE_GOAL_INPUT"
  | "CLARIFICATION"
  | "CONTRACT_REVIEW"
  | "PLAN_CONTINUATION"
  | "RECOVERY";

export interface DecisionInboxItemV2 {
  readonly kind: DecisionInboxKindV2;
  readonly stable_id: string;
  readonly blocking: boolean;
  readonly reversible: boolean;
  readonly allowed_actions: readonly string[];
  readonly authority_ref_sha256: string;
}

export interface DecisionInboxChangeSummaryV2 {
  readonly change_request_id: string;
  readonly classification: string;
  readonly materiality: string;
  readonly changed_subject_count: number;
  readonly invalidated_subject_count: number;
  readonly reusable_subject_count: number;
  readonly authority_ref_sha256: string;
  readonly created_at_ms: number;
}

export interface DecisionInboxWorkRefV2 {
  readonly subject_kind: "REQUIREMENT" | "DECISION" | "WORK_CELL" | "STAGE_GATE"
    | "EVIDENCE" | "PATCH_SET" | "ARTIFACT" | "AUTHORIZATION";
  readonly subject_id: string;
  readonly revision_sha256: string;
  readonly authority_ref_sha256: string;
}

export interface DecisionInboxProviderUsageV2 {
  readonly requests: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cost_usd: number | null;
  readonly budget_state: "UNKNOWN" | "WITHIN" | "EXCEEDED";
  readonly accounting_completeness: "COMPLETE" | "PARTIAL" | "UNOBSERVABLE";
  readonly scope: "GOAL_BOUND_OBSERVED";
  readonly receipt_refs: readonly string[];
}

export interface DecisionInboxProjectionV2 {
  readonly schema_version: 2;
  readonly authority: "DERIVED_READ_ONLY_PROJECTION";
  readonly goal_id: string;
  readonly pending: readonly DecisionInboxItemV2[];
  readonly diffs: {
    readonly contract_changed_fields: readonly string[];
    readonly requirement_added: number;
    readonly requirement_changed: number;
    readonly requirement_removed: number;
    readonly plan_revision_sha256: string | null;
  };
  readonly risks: readonly string[];
  readonly evidence: {
    readonly work_cell_id: string | null;
    readonly execution_status: string | null;
    readonly ready_work_count: number;
    readonly active_work_count: number;
    readonly completed_work_count: number;
    readonly must_total: number | null;
    readonly must_satisfied: number | null;
    readonly current_receipt_refs: readonly string[];
  };
  readonly changes: {
    readonly recent: readonly DecisionInboxChangeSummaryV2[];
    readonly invalidated_work: readonly DecisionInboxWorkRefV2[];
    readonly reused_work: readonly DecisionInboxWorkRefV2[];
  };
  readonly provider: DecisionInboxProviderUsageV2;
  readonly projection_sha256: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.normalize("NFC");
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableNonnegativeInteger(value: unknown): boolean {
  return value === null || nonnegativeInteger(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function sha256Array(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(sha256);
}

function changeSummary(value: unknown): value is DecisionInboxChangeSummaryV2 {
  if (!record(value) || Object.keys(value).length !== 8) return false;
  return boundedText(value.change_request_id, 256) && boundedText(value.classification, 64)
    && boundedText(value.materiality, 32) && nonnegativeInteger(value.changed_subject_count)
    && nonnegativeInteger(value.invalidated_subject_count) && nonnegativeInteger(value.reusable_subject_count)
    && sha256(value.authority_ref_sha256) && nonnegativeInteger(value.created_at_ms);
}

function workRef(value: unknown): value is DecisionInboxWorkRefV2 {
  if (!record(value) || Object.keys(value).length !== 4) return false;
  return ["REQUIREMENT", "DECISION", "WORK_CELL", "STAGE_GATE", "EVIDENCE", "PATCH_SET", "ARTIFACT", "AUTHORIZATION"]
    .includes(String(value.subject_kind))
    && boundedText(value.subject_id, 256) && sha256(value.revision_sha256) && sha256(value.authority_ref_sha256);
}

function providerUsage(value: unknown): value is DecisionInboxProviderUsageV2 {
  if (!record(value) || Object.keys(value).length !== 9) return false;
  return nullableNonnegativeInteger(value.requests) && nullableNonnegativeInteger(value.input_tokens)
    && nullableNonnegativeInteger(value.output_tokens) && nullableNonnegativeInteger(value.cache_read_tokens)
    && (value.cost_usd === null || (typeof value.cost_usd === "number" && Number.isFinite(value.cost_usd) && value.cost_usd >= 0))
    && ["UNKNOWN", "WITHIN", "EXCEEDED"].includes(String(value.budget_state))
    && ["COMPLETE", "PARTIAL", "UNOBSERVABLE"].includes(String(value.accounting_completeness))
    && value.scope === "GOAL_BOUND_OBSERVED" && sha256Array(value.receipt_refs, 512);
}

export function validateDecisionInboxProjectionV2(value: unknown): value is DecisionInboxProjectionV2 {
  if (!record(value) || value.schema_version !== 2 || value.authority !== "DERIVED_READ_ONLY_PROJECTION"
    || !boundedText(value.goal_id, 256) || !Array.isArray(value.pending) || value.pending.length > 512
    || !record(value.diffs) || !Array.isArray(value.risks) || value.risks.length > 256
    || !record(value.evidence) || !record(value.changes) || !providerUsage(value.provider)
    || typeof value.projection_sha256 !== "string"
    || !sha256Pattern.test(value.projection_sha256)) return false;
  const kinds = new Set<DecisionInboxKindV2>([
    "ACTIVE_GOAL_INPUT", "CLARIFICATION", "CONTRACT_REVIEW", "PLAN_CONTINUATION", "RECOVERY",
  ]);
  if (!value.pending.every((entry) => record(entry) && kinds.has(entry.kind as DecisionInboxKindV2)
    && boundedText(entry.stable_id, 256) && typeof entry.blocking === "boolean"
    && typeof entry.reversible === "boolean" && Array.isArray(entry.allowed_actions)
    && entry.allowed_actions.length > 0 && entry.allowed_actions.length <= 16
    && entry.allowed_actions.every((action) => boundedText(action, 64))
    && typeof entry.authority_ref_sha256 === "string" && sha256Pattern.test(entry.authority_ref_sha256))) return false;
  if (!Array.isArray(value.diffs.contract_changed_fields) || value.diffs.contract_changed_fields.length > 512
    || !value.diffs.contract_changed_fields.every((entry) => boundedText(entry, 256))
    || !nonnegativeInteger(value.diffs.requirement_added)
    || !nonnegativeInteger(value.diffs.requirement_changed)
    || !nonnegativeInteger(value.diffs.requirement_removed)
    || (value.diffs.plan_revision_sha256 !== null
      && (typeof value.diffs.plan_revision_sha256 !== "string" || !sha256Pattern.test(value.diffs.plan_revision_sha256)))) return false;
  if (!value.risks.every((risk) => boundedText(risk, 2_048))
    || (value.evidence.work_cell_id !== null && !boundedText(value.evidence.work_cell_id, 256))
    || (value.evidence.execution_status !== null && !boundedText(value.evidence.execution_status, 128))
    || !nonnegativeInteger(value.evidence.ready_work_count)
    || !nonnegativeInteger(value.evidence.active_work_count)
    || !nonnegativeInteger(value.evidence.completed_work_count)
    || !nullableNonnegativeInteger(value.evidence.must_total)
    || !nullableNonnegativeInteger(value.evidence.must_satisfied)
    || (typeof value.evidence.must_total === "number" && typeof value.evidence.must_satisfied === "number"
      && value.evidence.must_satisfied > value.evidence.must_total)
    || !sha256Array(value.evidence.current_receipt_refs, 512)
    || !Array.isArray(value.changes.recent) || value.changes.recent.length > 64
    || !value.changes.recent.every(changeSummary)
    || !Array.isArray(value.changes.invalidated_work) || value.changes.invalidated_work.length > 512
    || !value.changes.invalidated_work.every(workRef)
    || !Array.isArray(value.changes.reused_work) || value.changes.reused_work.length > 512
    || !value.changes.reused_work.every(workRef)) return false;
  const body = omitProperty(value, "projection_sha256");
  return canonicalJsonSha256(body) === value.projection_sha256;
}

export interface DecisionInboxSourceV2 {
  readonly goalId: string;
  readonly phase: string;
  readonly nextAction: string;
  readonly workCellId: string | null;
  readonly routeHealth: string;
  readonly blocker: string | null;
  readonly clarifications: readonly {
    readonly id: string;
    readonly reversible: boolean;
    readonly record: Readonly<Record<string, unknown>>;
  }[];
  readonly contractReview: null | {
    readonly decisionRequirementRevisionId: string;
    readonly requirementRevisionSha256: string;
    readonly decisionFrontierSha256: string;
    readonly contractDiff: Readonly<Record<string, unknown>>;
    readonly requirementDiff: {
      readonly added: readonly unknown[];
      readonly changed: readonly unknown[];
      readonly removed: readonly unknown[];
    };
  };
  readonly planReview: null | {
    readonly routeSha256: string;
    readonly planRevisionSha256: string;
    readonly stageGateSha256: string;
  };
  readonly execution: null | {
    readonly status: string;
    readonly ready: number;
    readonly active: number;
    readonly completed: number;
  };
  readonly changes: {
    readonly recent: readonly DecisionInboxChangeSummaryV2[];
    readonly invalidatedWork: readonly DecisionInboxWorkRefV2[];
    readonly reusedWork: readonly DecisionInboxWorkRefV2[];
  };
  readonly acceptance: {
    readonly mustTotal: number | null;
    readonly mustSatisfied: number | null;
    readonly currentReceiptRefs: readonly string[];
  };
  readonly provider: {
    readonly requests: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null;
    readonly costUsd: number | null;
    readonly budgetState: DecisionInboxProviderUsageV2["budget_state"];
    readonly accountingCompleteness: DecisionInboxProviderUsageV2["accounting_completeness"];
    readonly scope: DecisionInboxProviderUsageV2["scope"];
    readonly receiptRefs: readonly string[];
  };
}

function item(
  kind: DecisionInboxKindV2,
  stableId: string,
  blocking: boolean,
  reversible: boolean,
  allowedActions: readonly string[],
  authorityRef: Readonly<Record<string, unknown>>,
): DecisionInboxItemV2 {
  return {
    kind,
    stable_id: stableId,
    blocking,
    reversible,
    allowed_actions: allowedActions,
    authority_ref_sha256: canonicalJsonSha256(authorityRef),
  };
}

export function projectDecisionInboxV2(source: DecisionInboxSourceV2): DecisionInboxProjectionV2 {
  const pending: DecisionInboxItemV2[] = [];
  if (source.nextAction === "CLASSIFY_ACTIVE_GOAL_INPUT") pending.push(item(
    "ACTIVE_GOAL_INPUT", `${source.goalId}:ACTIVE_GOAL_INPUT`, true, false,
    ["CORRECT_CURRENT", "QUEUE_NEXT", "CHANGE_REQUEST", "NEW_GOAL", "INTERRUPT_NOW", "DISCUSSION_ONLY"],
    { goal_id: source.goalId, phase: source.phase, next_action: source.nextAction },
  ));
  for (const clarification of source.clarifications) pending.push(item(
    "CLARIFICATION", clarification.id, true, clarification.reversible, ["SELECT", "DEFER"], clarification.record,
  ));
  if (source.contractReview) pending.push(item(
    "CONTRACT_REVIEW", source.contractReview.decisionRequirementRevisionId, true, true,
    ["APPROVE", "EDIT", "REJECT"],
    {
      requirement_revision_sha256: source.contractReview.requirementRevisionSha256,
      decision_frontier_sha256: source.contractReview.decisionFrontierSha256,
    },
  ));
  if (source.planReview) pending.push(item(
    "PLAN_CONTINUATION", `${source.goalId}:PLAN_CONTINUATION`, true, true,
    ["BUILD", "KEEP", "REVISE"],
    {
      route_sha256: source.planReview.routeSha256,
      plan_revision_sha256: source.planReview.planRevisionSha256,
      stage_gate_sha256: source.planReview.stageGateSha256,
    },
  ));
  if (source.nextAction === "RECONCILE_COMPACTION" || source.nextAction === "RECONCILE_OPERATIONS") pending.push(item(
    "RECOVERY", `${source.goalId}:${source.nextAction}`, true, false, ["RECONCILE", "STOP"],
    { goal_id: source.goalId, phase: source.phase, next_action: source.nextAction },
  ));
  pending.sort((left, right) => left.kind.localeCompare(right.kind) || left.stable_id.localeCompare(right.stable_id));
  const risks = [
    ...(source.routeHealth === "H0_CONTINUE" || source.routeHealth === "HEALTHY" ? [] : [`ROUTE:${source.routeHealth}`]),
    ...(source.blocker ? [`BLOCKER:${source.blocker}`] : []),
  ];
  const body = {
    schema_version: 2 as const,
    authority: "DERIVED_READ_ONLY_PROJECTION" as const,
    goal_id: source.goalId,
    pending,
    diffs: {
      contract_changed_fields: Object.keys(source.contractReview?.contractDiff ?? {}).sort(),
      requirement_added: source.contractReview?.requirementDiff.added.length ?? 0,
      requirement_changed: source.contractReview?.requirementDiff.changed.length ?? 0,
      requirement_removed: source.contractReview?.requirementDiff.removed.length ?? 0,
      plan_revision_sha256: source.planReview?.planRevisionSha256 ?? null,
    },
    risks,
    evidence: {
      work_cell_id: source.workCellId,
      execution_status: source.execution?.status ?? null,
      ready_work_count: source.execution?.ready ?? 0,
      active_work_count: source.execution?.active ?? 0,
      completed_work_count: source.execution?.completed ?? 0,
      must_total: source.acceptance.mustTotal,
      must_satisfied: source.acceptance.mustSatisfied,
      current_receipt_refs: source.acceptance.currentReceiptRefs,
    },
    changes: {
      recent: source.changes.recent,
      invalidated_work: source.changes.invalidatedWork,
      reused_work: source.changes.reusedWork,
    },
    provider: {
      requests: source.provider.requests,
      input_tokens: source.provider.inputTokens,
      output_tokens: source.provider.outputTokens,
      cache_read_tokens: source.provider.cacheReadTokens,
      cost_usd: source.provider.costUsd,
      budget_state: source.provider.budgetState,
      accounting_completeness: source.provider.accountingCompleteness,
      scope: source.provider.scope,
      receipt_refs: source.provider.receiptRefs,
    },
  };
  return { ...body, projection_sha256: canonicalJsonSha256(body) };
}
