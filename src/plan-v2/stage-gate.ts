import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { DecisionClosureBundleV2, GoalFitReviewV2 } from "../intake-v2/domain.js";
import type { PlanRevisionV2 } from "./finalize.js";

export type PlanStageGateV2 =
  | "PLAN_ENTRY"
  | "IRREVERSIBLE_ARCHITECTURE"
  | "REPEATED_FAILURE"
  | "MATERIAL_CHANGE"
  | "FINAL_CLOSURE";

export interface StageGateReceiptV2 {
  readonly schema_version: 2;
  readonly stage_gate_receipt_id: string;
  readonly goal_id: string;
  readonly plan_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly contract_freeze_receipt_id: string;
  readonly contract_freeze_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly decision_closure_id: string;
  readonly decision_closure_sha256: string;
  readonly goal_fit_review_id: string;
  readonly goal_fit_review_sha256: string;
  readonly gate: PlanStageGateV2;
  readonly event_head_sha256: string;
  readonly review_owner: "HOST";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

const gates = new Set<PlanStageGateV2>([
  "PLAN_ENTRY", "IRREVERSIBLE_ARCHITECTURE", "REPEATED_FAILURE", "MATERIAL_CHANGE", "FINAL_CLOSURE",
]);
const shaPattern = /^[a-f0-9]{64}$/u;

function sha(value: string, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Stage gate timestamp is invalid");
  return value;
}

export function finalizeStageGateReceiptV2(input: {
  readonly plan: PlanRevisionV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly goal_fit_review: GoalFitReviewV2;
  readonly gate: PlanStageGateV2;
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
}): StageGateReceiptV2 {
  if (!gates.has(input.gate)) throw new TypeError("Plan stage gate is invalid");
  const closure = input.decision_closure.closure;
  const review = input.goal_fit_review;
  if (review.review_owner !== "HOST" || review.verdict !== "FIT" || review.gate !== input.gate
    || !closure.qualified || closure.gate !== input.gate
    || review.decision_closure_id !== closure.decision_closure_id
    || review.decision_closure_sha256 !== closure.record_sha256
    || review.requirement_revision_id !== input.plan.requirement_revision_id
    || closure.requirement_revision_id !== input.plan.requirement_revision_id
    || review.goal_id !== input.plan.goal_id || review.contract_id !== input.plan.contract_id
    || review.authority_root_id !== input.plan.authority_root_id) {
    throw new TypeError("Stage gate requires a fresh matching Host Goal Fit review");
  }
  const eventHeadSha256 = sha(input.event_head_sha256, "Stage gate event head");
  const createdAtMs = timestamp(input.created_at_ms);
  const stageGateReceiptId = idFromSha256("STAGE_GATE", canonicalJsonSha256({
    plan_revision_id: input.plan.plan_revision_id,
    plan_revision_sha256: input.plan.record_sha256,
    gate: input.gate,
    goal_fit_review_sha256: review.record_sha256,
    event_head_sha256: eventHeadSha256,
  }));
  const body = {
    schema_version: 2 as const,
    stage_gate_receipt_id: stageGateReceiptId,
    goal_id: input.plan.goal_id,
    plan_id: input.plan.plan_id,
    plan_revision_id: input.plan.plan_revision_id,
    plan_revision_sha256: input.plan.record_sha256,
    contract_id: input.plan.contract_id,
    authority_root_id: input.plan.authority_root_id,
    contract_freeze_receipt_id: input.plan.contract_freeze_receipt_id,
    contract_freeze_sha256: input.plan.contract_freeze_sha256,
    requirement_revision_id: input.plan.requirement_revision_id,
    requirement_revision_sha256: input.plan.requirement_revision_sha256,
    decision_closure_id: closure.decision_closure_id,
    decision_closure_sha256: closure.record_sha256,
    goal_fit_review_id: review.goal_fit_review_id,
    goal_fit_review_sha256: review.record_sha256,
    gate: input.gate,
    event_head_sha256: eventHeadSha256,
    review_owner: "HOST" as const,
    created_at_ms: createdAtMs,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-STAGE-GATE-RECEIPT-V2", ...body }) };
}
