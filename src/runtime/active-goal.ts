import type { MutationMeta } from "../authority/transactions.js";
import type { TaskFlowStatusView } from "./task-flow-view.js";
import type { CorrectionLevel, PlanHealthStatus, RouteDecision } from "../planning/plan-health.js";
import type { ExecutionSubjectRef } from "../task-flow/domain.js";

export interface ActiveGoalFailure {
  readonly signatureSha256: string;
  readonly reasonCode: string;
  readonly toolName: string;
  readonly toolPayloadSha256: string;
  readonly failureClassSha256: string;
  readonly guidance: string;
  readonly localRepairAvailable: boolean;
  readonly replanAvailable: boolean;
}

export interface ActiveGoalFailureDecision {
  readonly occurrence: number;
  readonly limit: number;
  readonly status: PlanHealthStatus;
  readonly level: CorrectionLevel;
  readonly action: RouteDecision["action"];
  readonly reasonCode: string;
}

export interface ActiveGoalBinding {
  readonly goalId: string;
  readonly mode: "PLAN" | "BUILD";
  readonly planId?: string | null;
  readonly authorizedStageId: string | null;
  readonly authorizedWorkCellId?: string | null;
  readonly authorizedWriteRoots?: readonly string[];
  readonly executionSubject?: ExecutionSubjectRef;
  readonly workspaceRoot: string;
  readonly view: TaskFlowStatusView;
  readonly inputClosureSha256: string;
  readonly progressMarker?: string | null;
  readonly failureOccurrences?: Readonly<Record<string, number>>;
  mutation(idempotencyKey: string): MutationMeta;
  advanceVersion(version: number): void;
  recordFailure?(failure: ActiveGoalFailure): ActiveGoalFailureDecision;
  markProgress?(marker: string): void;
}
