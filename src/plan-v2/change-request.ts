import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { PlanChangeImpactV2 } from "./change-impact.js";
import type { PlanRevisionV2 } from "./finalize.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanGraphV2,
  validatePlanSubjectV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";

export type ChangeRequestClassificationV2 =
  | "CORRECT_CURRENT"
  | "QUEUE_NEXT"
  | "CHANGE_REQUEST"
  | "NEW_GOAL"
  | "INTERRUPT_NOW"
  | "DISCUSSION_ONLY";

export type ChangeRequestMaterialityV2 = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface UserChangeRequestV2 {
  readonly schema_version: 2;
  readonly change_request_id: string;
  readonly goal_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly request_payload: CanonicalJson;
  readonly request_payload_sha256: string;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly changed_subject_root_sha256: string;
  readonly changed_subject_count: number;
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

export interface UserChangeRequestBundleV2 {
  readonly request: UserChangeRequestV2;
  readonly source_bytes: Uint8Array;
}

export interface HostCapturedChangeRequestSourceV2 {
  readonly user_turn_id: string;
  readonly user_turn_sha256: string;
  readonly content_sha256: string;
}

export interface ChangeRequestPlanImpactV2 extends Omit<PlanChangeImpactV2, "record_sha256"> {
  readonly impact_closure_sha256: string;
  readonly record_sha256: string;
}

export interface PlanReuseReceiptV2 {
  readonly schema_version: 2;
  readonly reuse_receipt_id: string;
  readonly change_request_id: string;
  readonly plan_change_impact_id: string;
  readonly plan_change_impact_sha256: string;
  readonly goal_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly subject: PlanSubjectRefV2;
  readonly reuse_scope: "PLAN_SUBJECT_ONLY";
  readonly requires_fresh_effect_oracle: true;
  readonly record_sha256: string;
}

const classifications = new Set<ChangeRequestClassificationV2>([
  "CORRECT_CURRENT", "QUEUE_NEXT", "CHANGE_REQUEST", "NEW_GOAL", "INTERRUPT_NOW", "DISCUSSION_ONLY",
]);
const materialities = new Set<ChangeRequestMaterialityV2>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const shaPattern = /^[a-f0-9]{64}$/u;

function boundedText(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new TypeError(`${label} must contain 1..160 characters`);
  }
  return value;
}

function sha(value: string, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Change Request timestamp is invalid");
  return value;
}

export function changeRequestPayloadSha256V2(payload: CanonicalJson): string {
  return canonicalJsonSha256({ domain: "PCH-CHANGE-REQUEST-PAYLOAD-V2", payload });
}

export function changedSubjectRootSha256V2(subjects: readonly PlanSubjectRefV2[]): string {
  const normalized = subjects.map((subject, index) => validatePlanSubjectV2(subject, `Changed subject ${index}`))
    .sort(comparePlanSubjectsV2);
  if (new Set(normalized.map(planSubjectKeyV2)).size !== normalized.length) {
    throw new TypeError("Change Request repeats a changed subject");
  }
  return canonicalJsonSha256({ domain: "PCH-CHANGE-REQUEST-SUBJECT-ROOT-V2", members: normalized });
}

export function userChangeRequestAuthoritySourceV2(input: {
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly request_payload_sha256: string;
  readonly changed_subject_root_sha256: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly event_head_sha256: string;
}): string {
  return canonicalJson({ domain: "PCH-USER-CHANGE-REQUEST-V2", ...input });
}

export function finalizeUserChangeRequestV2(input: {
  readonly plan: PlanRevisionV2;
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly request_payload: CanonicalJson;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly source: string | Uint8Array;
  readonly session_id: string;
  readonly turn_id: string;
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
  readonly source_authority?: HostCapturedChangeRequestSourceV2;
}): UserChangeRequestBundleV2 {
  if (!classifications.has(input.classification)) throw new TypeError("Change Request classification is invalid");
  if (!materialities.has(input.materiality)) throw new TypeError("Change Request materiality is invalid");
  const graph = validatePlanGraphV2(input.subjects, input.edges);
  if (input.changed_subjects.length > 512) throw new TypeError("Change Request exceeds 512 changed subjects");
  const changed = input.changed_subjects.map((candidate, index) => {
    const subject = validatePlanSubjectV2(candidate, `Changed subject ${index}`);
    const current = graph.subjects_by_key.get(planSubjectKeyV2(subject));
    if (!current || current.revision_sha256 !== subject.revision_sha256) {
      throw new TypeError(`Change Request subject ${subject.id} is outside the current Plan revision`);
    }
    return current;
  }).sort(comparePlanSubjectsV2);
  if (new Set(changed.map(planSubjectKeyV2)).size !== changed.length) {
    throw new TypeError("Change Request repeats a changed subject");
  }
  if (["CORRECT_CURRENT", "CHANGE_REQUEST", "INTERRUPT_NOW"].includes(input.classification)
    && changed.length === 0) {
    throw new TypeError(`${input.classification} requires at least one current Plan subject`);
  }
  const requestPayloadJson = canonicalJson(input.request_payload);
  if (Buffer.byteLength(requestPayloadJson, "utf8") > 131_072) throw new TypeError("Change Request payload is too large");
  const requestPayload = JSON.parse(requestPayloadJson) as CanonicalJson;
  const requestPayloadSha256 = changeRequestPayloadSha256V2(requestPayload);
  const changedSubjectRootSha256 = changedSubjectRootSha256V2(changed);
  const sessionId = boundedText(input.session_id, "Change Request session ID");
  const turnId = boundedText(input.turn_id, "Change Request turn ID");
  const eventHeadSha256 = sha(input.event_head_sha256, "Change Request event head");
  const expectedSource = userChangeRequestAuthoritySourceV2({
    plan_revision_id: input.plan.plan_revision_id,
    plan_revision_sha256: input.plan.record_sha256,
    classification: input.classification,
    materiality: input.materiality,
    request_payload_sha256: requestPayloadSha256,
    changed_subject_root_sha256: changedSubjectRootSha256,
    session_id: sessionId,
    turn_id: turnId,
    event_head_sha256: eventHeadSha256,
  });
  const sourceBytes = typeof input.source === "string" ? Buffer.from(input.source, "utf8") : Buffer.from(input.source);
  if (sourceBytes.length < 1 || sourceBytes.length > 131_072) throw new TypeError("Change Request source must contain 1..131072 bytes");
  try { new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); } catch {
    throw new TypeError("Change Request source must contain exact UTF-8 bytes");
  }
  const contentSha256 = sha256Hex(sourceBytes);
  if (input.source_authority === undefined) {
    if (!sourceBytes.equals(Buffer.from(expectedSource, "utf8"))) {
      throw new TypeError("Change Request bytes do not match the exact structured Change Request envelope");
    }
  } else if (!boundedText(input.source_authority.user_turn_id, "Change Request source turn ID")
    || !shaPattern.test(input.source_authority.user_turn_sha256)
    || sha(input.source_authority.content_sha256, "Change Request source content") !== contentSha256) {
    throw new TypeError("Change Request raw source does not match its Host-captured turn authority");
  }
  const createdAtMs = timestamp(input.created_at_ms);
  const changeRequestId = idFromSha256("CHANGE_REQUEST", canonicalJsonSha256({
    base_plan_revision_id: input.plan.plan_revision_id,
    classification: input.classification,
    request_payload_sha256: requestPayloadSha256,
    changed_subject_root_sha256: changedSubjectRootSha256,
    session_id: sessionId,
    turn_id: turnId,
    event_head_sha256: eventHeadSha256,
  }));
  const body = {
    schema_version: 2 as const,
    change_request_id: changeRequestId,
    goal_id: input.plan.goal_id,
    base_plan_revision_id: input.plan.plan_revision_id,
    base_plan_revision_sha256: input.plan.record_sha256,
    classification: input.classification,
    materiality: input.materiality,
    request_payload: requestPayload,
    request_payload_sha256: requestPayloadSha256,
    changed_subjects: changed,
    changed_subject_root_sha256: changedSubjectRootSha256,
    changed_subject_count: changed.length,
    source_kind: "USER_TURN" as const,
    session_id: sessionId,
    turn_id: turnId,
    event_head_sha256: eventHeadSha256,
    content_sha256: contentSha256,
    byte_length: sourceBytes.length,
    encoding: "UTF-8" as const,
    fidelity: "EXACT" as const,
    captured_by: "HOST" as const,
    created_at_ms: createdAtMs,
  };
  return {
    request: { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-USER-CHANGE-REQUEST-V2", ...body }) },
    source_bytes: sourceBytes,
  };
}

export function bindPlanChangeImpactV2(
  request: UserChangeRequestV2,
  impact: PlanChangeImpactV2,
): ChangeRequestPlanImpactV2 {
  if (impact.plan_revision_id !== request.base_plan_revision_id
    || impact.plan_revision_sha256 !== request.base_plan_revision_sha256) {
    throw new TypeError("Plan change impact does not match its Change Request base Plan");
  }
  const impactClosureSha256 = impact.record_sha256;
  return {
    ...impact,
    impact_closure_sha256: impactClosureSha256,
    record_sha256: canonicalJsonSha256({
      domain: "PCH-CHANGE-REQUEST-PLAN-IMPACT-V2",
      change_request_id: request.change_request_id,
      change_request_sha256: request.record_sha256,
      impact_closure_sha256: impactClosureSha256,
    }),
  };
}

export function planChangeImpactIdV2(impact: ChangeRequestPlanImpactV2): string {
  return idFromSha256("PLAN_CHANGE_IMPACT", impact.record_sha256);
}

export function finalizePlanReuseReceiptV2(input: {
  readonly request: UserChangeRequestV2;
  readonly impact: ChangeRequestPlanImpactV2;
  readonly subject: PlanSubjectRefV2;
}): PlanReuseReceiptV2 {
  const subject = validatePlanSubjectV2(input.subject, "Reuse subject");
  if (input.impact.plan_revision_id !== input.request.base_plan_revision_id
    || input.impact.plan_revision_sha256 !== input.request.base_plan_revision_sha256
    || !input.impact.reusable_subjects.some((candidate) => planSubjectKeyV2(candidate) === planSubjectKeyV2(subject)
      && candidate.revision_sha256 === subject.revision_sha256)) {
    throw new TypeError("Plan reuse receipt is outside the exact Change Request impact closure");
  }
  const impactId = planChangeImpactIdV2(input.impact);
  const body = {
    schema_version: 2 as const,
    reuse_receipt_id: idFromSha256("PLAN_REUSE", canonicalJsonSha256({
      change_request_id: input.request.change_request_id,
      plan_change_impact_id: impactId,
      subject,
    })),
    change_request_id: input.request.change_request_id,
    plan_change_impact_id: impactId,
    plan_change_impact_sha256: input.impact.record_sha256,
    goal_id: input.request.goal_id,
    base_plan_revision_id: input.request.base_plan_revision_id,
    base_plan_revision_sha256: input.request.base_plan_revision_sha256,
    subject,
    reuse_scope: "PLAN_SUBJECT_ONLY" as const,
    requires_fresh_effect_oracle: true as const,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-PLAN-REUSE-RECEIPT-V2", ...body }) };
}
