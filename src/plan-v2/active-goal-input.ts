import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanSubjectV2,
  type PlanSubjectRefV2,
} from "./graph.js";
import {
  changedSubjectRootSha256V2,
  planChangeImpactIdV2,
  type ChangeRequestPlanImpactV2,
  type ChangeRequestClassificationV2,
  type ChangeRequestMaterialityV2,
  type UserChangeRequestV2,
} from "./change-request.js";
import type { PlanRevisionV2 } from "./finalize.js";
import type { StageGateReceiptV2 } from "./stage-gate.js";

const shaPattern = /^[a-f0-9]{64}$/u;

export interface ActiveGoalInputClosureV2 {
  readonly goal_id: string;
  readonly goal_version: number;
  readonly contract_sha256: string | null;
  readonly route_sha256: string | null;
  readonly plan_revision_id: string | null;
  readonly plan_revision_sha256: string | null;
  readonly stage_gate_sha256: string | null;
  readonly execution_authorization_sha256: string | null;
}

export interface ActiveGoalUserTurnV2 extends ActiveGoalInputClosureV2 {
  readonly schema_version: 2;
  readonly user_turn_id: string;
  readonly input_closure_sha256: string;
  readonly source_kind: "USER_TURN";
  readonly session_id: string;
  readonly turn_id: string;
  readonly event_head_sha256: string;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly encoding: "UTF-8";
  readonly fidelity: "EXACT";
  readonly captured_by: "HOST";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ActiveGoalUserTurnBundleV2 {
  readonly turn: ActiveGoalUserTurnV2;
  readonly source_bytes: Uint8Array;
}

export type ActiveGoalChangeKindV2 = "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE";

export interface ActiveGoalUserTurnClassificationV2 {
  readonly schema_version: 2;
  readonly classification_id: string;
  readonly user_turn_id: string;
  readonly user_turn_sha256: string;
  readonly goal_id: string;
  readonly base_plan_revision_id: string | null;
  readonly base_plan_revision_sha256: string | null;
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly change_kind: ActiveGoalChangeKindV2 | null;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly changed_subject_root_sha256: string;
  readonly changed_subject_count: number;
  readonly proposal_origin: "CURRENT_AGENT_TURN";
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ActiveGoalChangeRequestBindingV2 {
  readonly schema_version: 2;
  readonly binding_id: string;
  readonly classification_id: string;
  readonly classification_sha256: string;
  readonly user_turn_id: string;
  readonly user_turn_sha256: string;
  readonly raw_content_sha256: string;
  readonly change_request_id: string;
  readonly change_request_sha256: string;
  readonly plan_change_impact_id: string;
  readonly plan_change_impact_sha256: string;
  readonly goal_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ActiveGoalChangeTransitionV2 {
  readonly schema_version: 2;
  readonly transition_id: string;
  readonly binding_id: string;
  readonly binding_sha256: string;
  readonly classification_id: string;
  readonly change_request_id: string;
  readonly plan_change_impact_id: string;
  readonly goal_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly successor_plan_revision_id: string;
  readonly successor_plan_revision_sha256: string;
  readonly successor_stage_gate_receipt_id: string;
  readonly successor_stage_gate_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

const classifications = new Set<ChangeRequestClassificationV2>([
  "CORRECT_CURRENT", "QUEUE_NEXT", "CHANGE_REQUEST", "NEW_GOAL", "INTERRUPT_NOW", "DISCUSSION_ONLY",
]);
const materialities = new Set<ChangeRequestMaterialityV2>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const changeKinds = new Set<ActiveGoalChangeKindV2>(["BEHAVIOR", "SCOPE", "ACCEPTANCE", "USER_PREFERENCE"]);
const currentChangeClassifications = new Set<ChangeRequestClassificationV2>([
  "CORRECT_CURRENT", "CHANGE_REQUEST", "INTERRUPT_NOW",
]);

function boundedId(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 160) throw new TypeError(`${label} must contain 1..160 characters`);
  return normalized;
}

function optionalSha(value: string | null, label: string): string | null {
  if (value !== null && !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 or null`);
  return value;
}

export function activeGoalInputClosureSha256V2(input: ActiveGoalInputClosureV2): string {
  const goalId = boundedId(input.goal_id, "Active Goal input goal ID");
  if (!Number.isSafeInteger(input.goal_version) || input.goal_version < 1) {
    throw new TypeError("Active Goal input version must be a positive integer");
  }
  const planRevisionId = input.plan_revision_id === null
    ? null : boundedId(input.plan_revision_id, "Active Goal input Plan revision ID");
  const planRevisionSha256 = optionalSha(input.plan_revision_sha256, "Active Goal input Plan revision SHA-256");
  if ((planRevisionId === null) !== (planRevisionSha256 === null)) {
    throw new TypeError("Active Goal input Plan revision ID and SHA-256 must both be present or absent");
  }
  return canonicalJsonSha256({
    domain: "PCH-ACTIVE-GOAL-INPUT-CLOSURE-V2",
    goal_id: goalId,
    goal_version: input.goal_version,
    contract_sha256: optionalSha(input.contract_sha256, "Active Goal input contract SHA-256"),
    route_sha256: optionalSha(input.route_sha256, "Active Goal input route SHA-256"),
    plan_revision_id: planRevisionId,
    plan_revision_sha256: planRevisionSha256,
    stage_gate_sha256: optionalSha(input.stage_gate_sha256, "Active Goal input StageGate SHA-256"),
    execution_authorization_sha256: optionalSha(
      input.execution_authorization_sha256, "Active Goal input authorization SHA-256",
    ),
  });
}

export function finalizeActiveGoalUserTurnV2(input: {
  readonly closure: ActiveGoalInputClosureV2;
  readonly source: string | Uint8Array;
  readonly session_id: string;
  readonly turn_id: string;
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
}): ActiveGoalUserTurnBundleV2 {
  const inputClosureSha256 = activeGoalInputClosureSha256V2(input.closure);
  const sessionId = boundedId(input.session_id, "Active Goal input session ID");
  const turnId = boundedId(input.turn_id, "Active Goal input turn ID");
  if (!shaPattern.test(input.event_head_sha256)) throw new TypeError("Active Goal input event head must be a lowercase SHA-256");
  if (!Number.isSafeInteger(input.created_at_ms) || input.created_at_ms < 0) {
    throw new TypeError("Active Goal input timestamp is invalid");
  }
  const sourceBytes = typeof input.source === "string" ? Buffer.from(input.source, "utf8") : Buffer.from(input.source);
  if (sourceBytes.length < 1 || sourceBytes.length > 131_072) {
    throw new TypeError("Active Goal input must contain 1..131072 bytes");
  }
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); } catch {
    throw new TypeError("Active Goal input must contain exact UTF-8 bytes");
  }
  if (typeof input.source === "string" && decoded !== input.source) {
    throw new TypeError("Active Goal input must contain exact UTF-8 bytes");
  }
  if (!decoded.trim()) throw new TypeError("Active Goal input must contain non-whitespace UTF-8 text");
  const contentSha256 = sha256Hex(sourceBytes);
  const userTurnId = idFromSha256("USER_TURN", canonicalJsonSha256({
    goal_id: input.closure.goal_id,
    session_id: sessionId,
    turn_id: turnId,
    event_head_sha256: input.event_head_sha256,
    content_sha256: contentSha256,
  }));
  const body = {
    schema_version: 2 as const,
    user_turn_id: userTurnId,
    ...input.closure,
    input_closure_sha256: inputClosureSha256,
    source_kind: "USER_TURN" as const,
    session_id: sessionId,
    turn_id: turnId,
    event_head_sha256: input.event_head_sha256,
    content_sha256: contentSha256,
    byte_length: sourceBytes.length,
    encoding: "UTF-8" as const,
    fidelity: "EXACT" as const,
    captured_by: "HOST" as const,
    created_at_ms: input.created_at_ms,
  };
  return {
    turn: { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-ACTIVE-GOAL-USER-TURN-V2", ...body }) },
    source_bytes: sourceBytes,
  };
}

export function finalizeActiveGoalUserTurnClassificationV2(input: {
  readonly turn: ActiveGoalUserTurnV2;
  readonly plan_subjects: readonly PlanSubjectRefV2[];
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly change_kind: ActiveGoalChangeKindV2 | null;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
}): ActiveGoalUserTurnClassificationV2 {
  if (!classifications.has(input.classification)) throw new TypeError("Active Goal input classification is invalid");
  if (!materialities.has(input.materiality)) throw new TypeError("Active Goal input materiality is invalid");
  if (input.change_kind !== null && !changeKinds.has(input.change_kind)) {
    throw new TypeError("Active Goal input change kind is invalid");
  }
  const changesCurrent = currentChangeClassifications.has(input.classification);
  if (changesCurrent !== (input.change_kind !== null)) {
    throw new TypeError("Only a current-Goal change classification may carry a change kind");
  }
  if (!shaPattern.test(input.event_head_sha256)) {
    throw new TypeError("Active Goal input classification event head must be a lowercase SHA-256");
  }
  if (!Number.isSafeInteger(input.created_at_ms) || input.created_at_ms < 0) {
    throw new TypeError("Active Goal input classification timestamp is invalid");
  }
  const available = new Map(input.plan_subjects.map((subject, index) => {
    const valid = validatePlanSubjectV2(subject, `Active Goal Plan subject ${index}`);
    return [planSubjectKeyV2(valid), valid] as const;
  }));
  const changed = input.changed_subjects.map((subject, index) => {
    const valid = validatePlanSubjectV2(subject, `Active Goal changed subject ${index}`);
    const current = available.get(planSubjectKeyV2(valid));
    if (!current || current.revision_sha256 !== valid.revision_sha256) {
      throw new TypeError("Active Goal classification subject is outside the captured Plan revision");
    }
    return current;
  }).sort(comparePlanSubjectsV2);
  if (changed.length > 512 || new Set(changed.map(planSubjectKeyV2)).size !== changed.length) {
    throw new TypeError("Active Goal classification changed subjects are duplicated or exceed 512");
  }
  if (changesCurrent !== (changed.length > 0)) {
    throw new TypeError("A current-Goal change classification requires changed subjects; other classifications forbid them");
  }
  if (input.turn.plan_revision_id === null && (input.plan_subjects.length > 0 || changed.length > 0)) {
    throw new TypeError("Active Goal input without a captured Plan cannot classify Plan subjects");
  }
  const changedSubjectRootSha256 = changedSubjectRootSha256V2(changed);
  const classificationId = idFromSha256("INPUT_CLASSIFICATION", canonicalJsonSha256({
    user_turn_id: input.turn.user_turn_id,
    user_turn_sha256: input.turn.record_sha256,
    classification: input.classification,
    materiality: input.materiality,
    change_kind: input.change_kind,
    changed_subject_root_sha256: changedSubjectRootSha256,
    event_head_sha256: input.event_head_sha256,
  }));
  const body = {
    schema_version: 2 as const,
    classification_id: classificationId,
    user_turn_id: input.turn.user_turn_id,
    user_turn_sha256: input.turn.record_sha256,
    goal_id: input.turn.goal_id,
    base_plan_revision_id: input.turn.plan_revision_id,
    base_plan_revision_sha256: input.turn.plan_revision_sha256,
    classification: input.classification,
    materiality: input.materiality,
    change_kind: input.change_kind,
    changed_subjects: changed,
    changed_subject_root_sha256: changedSubjectRootSha256,
    changed_subject_count: changed.length,
    proposal_origin: "CURRENT_AGENT_TURN" as const,
    event_head_sha256: input.event_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-ACTIVE-GOAL-USER-TURN-CLASSIFICATION-V2", ...body }),
  };
}

export function finalizeActiveGoalChangeRequestBindingV2(input: {
  readonly turn: ActiveGoalUserTurnV2;
  readonly classification: ActiveGoalUserTurnClassificationV2;
  readonly request: UserChangeRequestV2;
  readonly impact: ChangeRequestPlanImpactV2;
}): ActiveGoalChangeRequestBindingV2 {
  if (!currentChangeClassifications.has(input.classification.classification)
    || input.classification.user_turn_id !== input.turn.user_turn_id
    || input.classification.user_turn_sha256 !== input.turn.record_sha256
    || input.request.goal_id !== input.turn.goal_id
    || input.request.base_plan_revision_id !== input.turn.plan_revision_id
    || input.request.base_plan_revision_sha256 !== input.turn.plan_revision_sha256
    || input.request.classification !== input.classification.classification
    || input.request.materiality !== input.classification.materiality
    || input.request.content_sha256 !== input.turn.content_sha256
    || input.impact.plan_revision_id !== input.request.base_plan_revision_id
    || input.impact.plan_revision_sha256 !== input.request.base_plan_revision_sha256) {
    throw new TypeError("Active Goal ChangeRequest binding closures do not match");
  }
  const impactId = planChangeImpactIdV2(input.impact);
  const bindingId = idFromSha256("CHANGE_BINDING", canonicalJsonSha256({
    classification_id: input.classification.classification_id,
    user_turn_id: input.turn.user_turn_id,
    change_request_id: input.request.change_request_id,
    plan_change_impact_id: impactId,
  }));
  const body = {
    schema_version: 2 as const,
    binding_id: bindingId,
    classification_id: input.classification.classification_id,
    classification_sha256: input.classification.record_sha256,
    user_turn_id: input.turn.user_turn_id,
    user_turn_sha256: input.turn.record_sha256,
    raw_content_sha256: input.turn.content_sha256,
    change_request_id: input.request.change_request_id,
    change_request_sha256: input.request.record_sha256,
    plan_change_impact_id: impactId,
    plan_change_impact_sha256: input.impact.record_sha256,
    goal_id: input.turn.goal_id,
    base_plan_revision_id: input.request.base_plan_revision_id,
    base_plan_revision_sha256: input.request.base_plan_revision_sha256,
    created_at_ms: input.classification.created_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-ACTIVE-GOAL-CHANGE-REQUEST-BINDING-V2", ...body }),
  };
}

export function finalizeActiveGoalChangeTransitionV2(input: {
  readonly binding: ActiveGoalChangeRequestBindingV2;
  readonly successor_plan: PlanRevisionV2;
  readonly successor_stage_gate: StageGateReceiptV2;
}): ActiveGoalChangeTransitionV2 {
  if (input.successor_plan.goal_id !== input.binding.goal_id
    || input.successor_plan.parent_plan_revision_id !== input.binding.base_plan_revision_id
    || input.successor_plan.parent_plan_revision_sha256 !== input.binding.base_plan_revision_sha256
    || input.successor_stage_gate.goal_id !== input.binding.goal_id
    || input.successor_stage_gate.plan_revision_id !== input.successor_plan.plan_revision_id
    || input.successor_stage_gate.plan_revision_sha256 !== input.successor_plan.record_sha256
    || input.successor_stage_gate.gate !== "MATERIAL_CHANGE") {
    throw new TypeError("Active Goal change successor Plan/StageGate does not directly descend from its base Plan");
  }
  const transitionId = idFromSha256("CHANGE_TRANSITION", canonicalJsonSha256({
    binding_id: input.binding.binding_id,
    successor_plan_revision_id: input.successor_plan.plan_revision_id,
    successor_stage_gate_receipt_id: input.successor_stage_gate.stage_gate_receipt_id,
  }));
  const body = {
    schema_version: 2 as const,
    transition_id: transitionId,
    binding_id: input.binding.binding_id,
    binding_sha256: input.binding.record_sha256,
    classification_id: input.binding.classification_id,
    change_request_id: input.binding.change_request_id,
    plan_change_impact_id: input.binding.plan_change_impact_id,
    goal_id: input.binding.goal_id,
    base_plan_revision_id: input.binding.base_plan_revision_id,
    base_plan_revision_sha256: input.binding.base_plan_revision_sha256,
    successor_plan_revision_id: input.successor_plan.plan_revision_id,
    successor_plan_revision_sha256: input.successor_plan.record_sha256,
    successor_stage_gate_receipt_id: input.successor_stage_gate.stage_gate_receipt_id,
    successor_stage_gate_sha256: input.successor_stage_gate.record_sha256,
    created_at_ms: input.successor_stage_gate.created_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-ACTIVE-GOAL-CHANGE-TRANSITION-V2", ...body }),
  };
}
