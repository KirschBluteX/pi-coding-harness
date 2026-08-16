import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { PlanRevisionV2 } from "./finalize.js";

export type CorrectionFamilyV2 =
  | "LOCAL_REPAIR"
  | "REPLAN"
  | "ASK_USER"
  | "RECONCILE"
  | "WORKER_RETRY"
  | "HANDOFF"
  | "PROVIDER_FANOUT";

export type CorrectionAttemptResultV2 = "CONTINUE" | "SUCCEEDED" | "FAILED";
export type CorrectionStopActionV2 = "CONTINUE" | "SUCCEEDED" | "REPLAN" | "ASK_USER" | "RECONCILE" | "STOP";

export interface CorrectionBudgetV2 {
  readonly schema_version: 2;
  readonly correction_budget_id: string;
  readonly goal_id: string;
  readonly origin_plan_revision_id: string;
  readonly origin_plan_revision_sha256: string;
  readonly family: CorrectionFamilyV2;
  readonly maximum_attempts: number;
  readonly maximum_no_progress: number;
  readonly policy_source_sha256: string;
  readonly record_sha256: string;
}

export interface CorrectionAttemptReceiptV2 {
  readonly schema_version: 2;
  readonly correction_attempt_id: string;
  readonly correction_budget_id: string;
  readonly goal_id: string;
  readonly current_plan_revision_id: string;
  readonly current_plan_revision_sha256: string;
  readonly family: CorrectionFamilyV2;
  readonly attempt_number: number;
  readonly parent_attempt_id: string | null;
  readonly parent_attempt_sha256: string | null;
  readonly observation_event_sequence: number;
  readonly observation_event_sha256: string;
  readonly observation_signature_sha256: string;
  readonly progress_changed: boolean;
  readonly no_progress_streak: number;
  readonly result: CorrectionAttemptResultV2;
  readonly stop_action: CorrectionStopActionV2;
  readonly stop_reason: "NONE" | "SUCCEEDED" | "ATTEMPT_BUDGET_EXHAUSTED" | "NO_PROGRESS_BUDGET_EXHAUSTED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export const correctionFamiliesV2: readonly CorrectionFamilyV2[] = [
  "LOCAL_REPAIR", "REPLAN", "ASK_USER", "RECONCILE", "WORKER_RETRY", "HANDOFF", "PROVIDER_FANOUT",
];

const shaPattern = /^[a-f0-9]{64}$/u;
const maximumByFamily: Readonly<Record<CorrectionFamilyV2, number>> = {
  LOCAL_REPAIR: 8,
  REPLAN: 4,
  ASK_USER: 3,
  RECONCILE: 4,
  WORKER_RETRY: 8,
  HANDOFF: 4,
  PROVIDER_FANOUT: 8,
};
const escalation: Readonly<Record<CorrectionFamilyV2, CorrectionStopActionV2>> = {
  LOCAL_REPAIR: "REPLAN",
  REPLAN: "ASK_USER",
  ASK_USER: "STOP",
  RECONCILE: "STOP",
  WORKER_RETRY: "REPLAN",
  HANDOFF: "STOP",
  PROVIDER_FANOUT: "STOP",
};

function sha(value: string, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

export function finalizeCorrectionBudgetV2(input: {
  readonly plan: PlanRevisionV2;
  readonly family: CorrectionFamilyV2;
  readonly maximum_attempts: number;
  readonly maximum_no_progress: number;
  readonly policy_source_sha256: string;
}): CorrectionBudgetV2 {
  if (!correctionFamiliesV2.includes(input.family)) throw new TypeError("Correction budget family is invalid");
  const maximumAttempts = positiveInteger(
    input.maximum_attempts, `${input.family} maximum attempts`, maximumByFamily[input.family],
  );
  const maximumNoProgress = positiveInteger(
    input.maximum_no_progress, `${input.family} maximum no-progress`, Math.min(3, maximumAttempts),
  );
  const policySourceSha256 = sha(input.policy_source_sha256, "Correction budget policy source");
  const body = {
    schema_version: 2 as const,
    correction_budget_id: idFromSha256("CORRECTION_BUDGET", canonicalJsonSha256({
      goal_id: input.plan.goal_id,
      family: input.family,
      policy_source_sha256: policySourceSha256,
    })),
    goal_id: input.plan.goal_id,
    origin_plan_revision_id: input.plan.plan_revision_id,
    origin_plan_revision_sha256: input.plan.record_sha256,
    family: input.family,
    maximum_attempts: maximumAttempts,
    maximum_no_progress: maximumNoProgress,
    policy_source_sha256: policySourceSha256,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-CORRECTION-BUDGET-V2", ...body }) };
}

export function finalizeCorrectionAttemptV2(input: {
  readonly budget: CorrectionBudgetV2;
  readonly current_plan: PlanRevisionV2;
  readonly previous: CorrectionAttemptReceiptV2 | null;
  readonly observation_event_sequence: number;
  readonly observation_event_sha256: string;
  readonly observation_signature_sha256: string;
  readonly result: CorrectionAttemptResultV2;
  readonly created_at_ms: number;
}): CorrectionAttemptReceiptV2 {
  if (!(["CONTINUE", "SUCCEEDED", "FAILED"] as const).includes(input.result)) {
    throw new TypeError("Correction attempt result is invalid");
  }
  if (input.current_plan.goal_id !== input.budget.goal_id) throw new TypeError("Correction attempt Plan is foreign");
  const attemptNumber = (input.previous?.attempt_number ?? 0) + 1;
  positiveInteger(attemptNumber, "Correction attempt number", input.budget.maximum_attempts);
  if (input.previous && (input.previous.correction_budget_id !== input.budget.correction_budget_id
    || input.previous.goal_id !== input.budget.goal_id || input.previous.family !== input.budget.family)) {
    throw new TypeError("Correction attempt predecessor is outside its budget");
  }
  const observationEventSequence = positiveInteger(input.observation_event_sequence, "Correction observation sequence", 2_147_483_647);
  const observationEventSha256 = sha(input.observation_event_sha256, "Correction observation event");
  const observationSignatureSha256 = sha(input.observation_signature_sha256, "Correction observation signature");
  const progressChanged = input.previous === null
    || input.previous.observation_signature_sha256 !== observationSignatureSha256;
  const noProgressStreak = progressChanged ? 0 : input.previous.no_progress_streak + 1;
  let stopAction: CorrectionStopActionV2 = "CONTINUE";
  let stopReason: CorrectionAttemptReceiptV2["stop_reason"] = "NONE";
  if (input.result === "SUCCEEDED") {
    stopAction = "SUCCEEDED";
    stopReason = "SUCCEEDED";
  } else if (noProgressStreak >= input.budget.maximum_no_progress) {
    stopAction = escalation[input.budget.family];
    stopReason = "NO_PROGRESS_BUDGET_EXHAUSTED";
  } else if (attemptNumber >= input.budget.maximum_attempts) {
    stopAction = escalation[input.budget.family];
    stopReason = "ATTEMPT_BUDGET_EXHAUSTED";
  }
  if (!Number.isSafeInteger(input.created_at_ms) || input.created_at_ms < 0) {
    throw new TypeError("Correction attempt timestamp is invalid");
  }
  const body = {
    schema_version: 2 as const,
    correction_attempt_id: idFromSha256("CORRECTION_ATTEMPT", canonicalJsonSha256({
      correction_budget_id: input.budget.correction_budget_id,
      attempt_number: attemptNumber,
      parent_attempt_sha256: input.previous?.record_sha256 ?? null,
      observation_event_sha256: observationEventSha256,
      result: input.result,
    })),
    correction_budget_id: input.budget.correction_budget_id,
    goal_id: input.budget.goal_id,
    current_plan_revision_id: input.current_plan.plan_revision_id,
    current_plan_revision_sha256: input.current_plan.record_sha256,
    family: input.budget.family,
    attempt_number: attemptNumber,
    parent_attempt_id: input.previous?.correction_attempt_id ?? null,
    parent_attempt_sha256: input.previous?.record_sha256 ?? null,
    observation_event_sequence: observationEventSequence,
    observation_event_sha256: observationEventSha256,
    observation_signature_sha256: observationSignatureSha256,
    progress_changed: progressChanged,
    no_progress_streak: noProgressStreak,
    result: input.result,
    stop_action: stopAction,
    stop_reason: stopReason,
    created_at_ms: input.created_at_ms,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-CORRECTION-ATTEMPT-V2", ...body }) };
}
