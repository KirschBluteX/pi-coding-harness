import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import { responseClassBudgets } from "./stable-policy.js";

export type MandatorySlot = "RESULT" | "QUESTION" | "RECOMMENDATION" | "DECISION" | "FAILURE" | "BLOCKER" | "RISK" | "EVIDENCE" | "VERIFICATION" | "ARTIFACT" | "UNCERTAINTY" | "LIMITATIONS" | "NEXT_ACTION";
export type ResponseOrigin = "USER_REQUEST" | "LOCAL_COMMAND" | "LOCAL_PROGRESS" | "ROUTINE_CHECKPOINT" | "TELEMETRY" | "STAGE_TRANSITION" | "FAILURE" | "FINALIZATION";
export type ResponseClass = "SILENT_LOCAL" | "TOOL_ACTION" | "ACK" | "QUESTION" | "STATUS" | "RESULT" | "AUDIT" | "USER_FORMAT";

export interface ResponseEvent {
  readonly eventId: string;
  readonly goalId?: string | null;
  readonly origin: ResponseOrigin;
  readonly executionPath: "LOCAL_ONLY" | "AGENT_TURN";
  readonly kind?: "EMISSION" | "TOOL_ACTION";
  readonly informationDelta: "NO_CHANGE" | "MATERIAL" | "FINAL" | "USER_REQUIRED";
  readonly requestedFormat?: boolean;
  readonly question?: boolean;
  readonly recommendationRequired?: boolean;
  readonly failure?: boolean;
  readonly audit?: boolean;
  readonly artifactExpected?: boolean;
  readonly policyDelta?: boolean;
  readonly pendingToolObligation?: boolean;
  readonly duplicateProjection?: boolean;
  readonly mandatorySlots?: readonly MandatorySlot[];
  readonly estimatedRequiredTextTokens?: number;
  readonly dedupeKeyHmacSha256?: string | null;
  readonly reason: string;
}

export interface ResponseContract {
  readonly schema_version: 3;
  readonly contract_id: string;
  readonly goal_id?: string | null;
  readonly origin: ResponseOrigin;
  readonly execution_path: "LOCAL_ONLY" | "AGENT_TURN";
  readonly response_class: ResponseClass;
  readonly completion_requirement: "NONE" | "TOOL_THEN_RESULT" | "RESULT_NOW";
  readonly channel: "NONE" | "TOOL_CALL" | "WIDGET" | "CHAT" | "ARTIFACT_POINTER" | "CHAT_AND_ARTIFACT";
  readonly status_delivery: "WIDGET_FIRST" | "CHAT_REQUIRED" | "NOT_APPLICABLE";
  readonly mandatory_slots: readonly MandatorySlot[];
  readonly soft_text_token_budget: number | null;
  readonly budget_basis: "CLASS_DEFAULT" | "MANDATORY_SLOT_ESTIMATE" | "USER_REQUEST" | "UNBOUNDED_REQUIRED";
  readonly text_policy: "NO_PROSE_PREFERRED" | "CONCISE_COMPLETE" | "USER_CONTROLLED";
  readonly information_delta: ResponseEvent["informationDelta"];
  readonly dedupe_key_hmac_sha256?: string | null;
  readonly artifact_policy: "NONE" | "WHEN_LARGE" | "ARTIFACT_FIRST" | "USER_DECIDES";
  readonly directive_placement: "NONE" | "STABLE_POLICY_ONLY" | "DYNAMIC_SUFFIX";
  readonly budget_behavior: "EXPAND_FOR_REQUIRED_CONTENT";
  readonly goal_level_rebound_guard: true;
  readonly generated_content_accounting: "PROVIDER_OUTPUT_WITH_REASONING_AND_TOOL_ARGUMENT_ATTRIBUTION";
  readonly tool_result_projection_policy: "EVIDENCE_LIVENESS_ROUTED";
  readonly preserve_user_requested_format: true;
  readonly suppress_when: readonly ("NO_STATE_CHANGE" | "DUPLICATE_PROJECTION" | "ROUTINE_CHECKPOINT" | "NONCRITICAL_TELEMETRY")[];
  readonly hard_truncation_allowed: false;
  readonly rewrite_request_allowed: false;
  readonly reason: string;
}

function uniqueSlots(slots: readonly MandatorySlot[]): MandatorySlot[] {
  return [...new Set(slots)];
}

function classify(event: ResponseEvent): { responseClass: ResponseClass; slots: MandatorySlot[] } {
  if (event.kind === "TOOL_ACTION") return { responseClass: "TOOL_ACTION", slots: [] };
  const localSilent = event.executionPath === "LOCAL_ONLY"
    && ["LOCAL_PROGRESS", "ROUTINE_CHECKPOINT", "TELEMETRY", "STAGE_TRANSITION"].includes(event.origin)
    && event.informationDelta === "NO_CHANGE"
    && !event.pendingToolObligation;
  if (localSilent) return { responseClass: "SILENT_LOCAL", slots: [] };
  const slots = [...(event.mandatorySlots ?? [])];
  if (event.question) slots.push("QUESTION");
  if (event.recommendationRequired) slots.push("RECOMMENDATION");
  if (event.failure) slots.push("FAILURE");
  if (event.pendingToolObligation || event.origin === "FINALIZATION") slots.push("RESULT");
  if (event.artifactExpected) slots.push("ARTIFACT");
  if (event.requestedFormat) return { responseClass: "USER_FORMAT", slots: uniqueSlots(slots) };
  if (event.question) return { responseClass: "QUESTION", slots: uniqueSlots(slots) };
  if (event.audit) return { responseClass: "AUDIT", slots: uniqueSlots(slots) };
  if (event.failure || event.pendingToolObligation || event.origin === "FINALIZATION" || event.informationDelta === "FINAL") return { responseClass: "RESULT", slots: uniqueSlots(slots) };
  if (event.origin === "USER_REQUEST") return { responseClass: "ACK", slots: uniqueSlots(slots) };
  return { responseClass: "STATUS", slots: uniqueSlots(slots) };
}

export function compileResponseContract(event: ResponseEvent): ResponseContract {
  if (event.origin === "USER_REQUEST" && event.executionPath !== "AGENT_TURN") throw new TypeError("A user request must execute through an Agent turn");
  if (event.kind === "TOOL_ACTION" && event.executionPath !== "AGENT_TURN") throw new TypeError("TOOL_ACTION requires an Agent turn");
  if (event.estimatedRequiredTextTokens !== undefined && (!Number.isSafeInteger(event.estimatedRequiredTextTokens) || event.estimatedRequiredTextTokens < 0)) throw new TypeError("Estimated required text tokens must be a non-negative safe integer");
  const { responseClass, slots } = classify(event);
  const localOnly = event.executionPath === "LOCAL_ONLY";
  const silent = responseClass === "SILENT_LOCAL";
  const tool = responseClass === "TOOL_ACTION";
  const userFormat = responseClass === "USER_FORMAT";
  const completion = tool ? "TOOL_THEN_RESULT" : event.pendingToolObligation || event.origin === "FINALIZATION" ? "RESULT_NOW" : "NONE";
  const classBudget = responseClass in responseClassBudgets ? responseClassBudgets[responseClass as keyof typeof responseClassBudgets] : 0;
  const requiredBudget = event.estimatedRequiredTextTokens ?? 0;
  const softBudget = silent || tool ? 0 : userFormat ? null : Math.max(classBudget, requiredBudget);
  const budgetBasis = userFormat ? "USER_REQUEST" : requiredBudget > classBudget ? "MANDATORY_SLOT_ESTIMATE" : "CLASS_DEFAULT";
  const contractCore = {
    eventId: event.eventId,
    origin: event.origin,
    responseClass,
    informationDelta: event.informationDelta,
    slots,
    policyDelta: event.policyDelta ?? false,
  };
  const suppressWhen = [
    ...(event.informationDelta === "NO_CHANGE" ? ["NO_STATE_CHANGE" as const] : []),
    ...(event.duplicateProjection ? ["DUPLICATE_PROJECTION" as const] : []),
    ...(event.origin === "ROUTINE_CHECKPOINT" ? ["ROUTINE_CHECKPOINT" as const] : []),
    ...(event.origin === "TELEMETRY" ? ["NONCRITICAL_TELEMETRY" as const] : []),
  ];
  return {
    schema_version: 3,
    contract_id: idFromSha256("RESP", canonicalJsonSha256(contractCore)),
    ...(event.goalId === undefined ? {} : { goal_id: event.goalId }),
    origin: event.origin,
    execution_path: event.executionPath,
    response_class: responseClass,
    completion_requirement: completion,
    channel: silent ? "NONE" : tool ? "TOOL_CALL" : localOnly ? "WIDGET" : event.artifactExpected ? "CHAT_AND_ARTIFACT" : "CHAT",
    status_delivery: responseClass === "STATUS" ? "WIDGET_FIRST" : silent || tool ? "NOT_APPLICABLE" : "CHAT_REQUIRED",
    mandatory_slots: slots,
    soft_text_token_budget: softBudget,
    budget_basis: budgetBasis,
    text_policy: silent || tool ? "NO_PROSE_PREFERRED" : userFormat ? "USER_CONTROLLED" : "CONCISE_COMPLETE",
    information_delta: event.informationDelta,
    ...(event.dedupeKeyHmacSha256 === undefined ? {} : { dedupe_key_hmac_sha256: event.dedupeKeyHmacSha256 }),
    artifact_policy: tool || silent ? "NONE" : event.artifactExpected ? "ARTIFACT_FIRST" : "WHEN_LARGE",
    directive_placement: localOnly ? "NONE" : event.policyDelta ? "DYNAMIC_SUFFIX" : "STABLE_POLICY_ONLY",
    budget_behavior: "EXPAND_FOR_REQUIRED_CONTENT",
    goal_level_rebound_guard: true,
    generated_content_accounting: "PROVIDER_OUTPUT_WITH_REASONING_AND_TOOL_ARGUMENT_ATTRIBUTION",
    tool_result_projection_policy: "EVIDENCE_LIVENESS_ROUTED",
    preserve_user_requested_format: true,
    suppress_when: suppressWhen,
    hard_truncation_allowed: false,
    rewrite_request_allowed: false,
    reason: event.reason,
  };
}
