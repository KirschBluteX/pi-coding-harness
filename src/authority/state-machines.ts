import { AuthorityIntegrityError } from "../foundation/errors.js";

export type GoalStatus = "ACTIVE" | "WAITING_USER" | "PAUSED" | "RECOVERING" | "NEEDS_RECONCILIATION" | "BLOCKED" | "SUCCEEDED" | "FAILED" | "CANCELED";
export type StageStatus = "PLANNED" | "READY" | "RUNNING" | "WAITING_USER" | "BLOCKED" | "RECOVERING" | "NEEDS_RECONCILIATION" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "INVALIDATED";

const goalTransitions: Readonly<Record<GoalStatus, ReadonlySet<GoalStatus>>> = {
  ACTIVE: new Set(["WAITING_USER", "PAUSED", "RECOVERING", "BLOCKED", "SUCCEEDED", "FAILED", "CANCELED"]),
  WAITING_USER: new Set(["ACTIVE", "CANCELED"]),
  PAUSED: new Set(["ACTIVE", "CANCELED"]),
  RECOVERING: new Set(["ACTIVE", "NEEDS_RECONCILIATION", "BLOCKED", "FAILED"]),
  NEEDS_RECONCILIATION: new Set(["RECOVERING", "ACTIVE", "BLOCKED", "FAILED"]),
  BLOCKED: new Set(["ACTIVE", "RECOVERING", "FAILED", "CANCELED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELED: new Set(),
};

const stageTransitions: Readonly<Record<StageStatus, ReadonlySet<StageStatus>>> = {
  PLANNED: new Set(["READY", "SKIPPED", "INVALIDATED"]),
  READY: new Set(["RUNNING", "WAITING_USER", "BLOCKED", "INVALIDATED"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED", "WAITING_USER", "BLOCKED", "RECOVERING", "NEEDS_RECONCILIATION", "INVALIDATED"]),
  WAITING_USER: new Set(["READY", "RUNNING", "BLOCKED", "INVALIDATED"]),
  BLOCKED: new Set(["READY", "RECOVERING", "FAILED", "INVALIDATED"]),
  RECOVERING: new Set(["READY", "RUNNING", "NEEDS_RECONCILIATION", "BLOCKED", "FAILED", "INVALIDATED"]),
  NEEDS_RECONCILIATION: new Set(["RECOVERING", "RUNNING", "BLOCKED", "FAILED", "INVALIDATED"]),
  SUCCEEDED: new Set(["INVALIDATED"]),
  FAILED: new Set(["INVALIDATED"]),
  SKIPPED: new Set(["INVALIDATED"]),
  INVALIDATED: new Set(),
};

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!goalTransitions[from].has(to)) throw new AuthorityIntegrityError(`Invalid Goal transition ${from} -> ${to}`);
}

export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  if (!stageTransitions[from].has(to)) throw new AuthorityIntegrityError(`Invalid Stage transition ${from} -> ${to}`);
}
