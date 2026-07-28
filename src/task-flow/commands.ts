import type {
  DeliverableManifestRecord,
  EvidenceAttestationRecord,
  ExecutionAuthorizationRecord,
  GoalContractRecord,
  OperationAttemptRecord,
  OperationReconcileLocatorRecord,
  OperationTransitionRecord,
  RouteHealthRecord,
  RouteSkeletonRecord,
  TaskFlowIntent,
  TaskFlowLane,
  TaskDecisionEntryRecord,
  WorkspaceBaselineRecord,
} from "./domain.js";
import type {
  IntakeClassificationRecord, RuntimePlanningDepth, RuntimeRequirementProfile,
} from "../planning/intake-classifier.js";

export interface AdmitTaskFlowCommand {
  readonly type: "ADMIT_TASK_FLOW";
  readonly goalId: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspaceHmac: string;
    readonly filesystemKind: string;
    readonly localLockingVerified: true;
  };
  readonly originSessionId: string;
  readonly objective: string;
  readonly intent: TaskFlowIntent;
  readonly lane: TaskFlowLane;
  readonly requirementProfile: RuntimeRequirementProfile;
  readonly planningDepth: RuntimePlanningDepth;
  readonly classification: IntakeClassificationRecord;
  readonly acceptanceFacetMinimum: number;
  readonly sourceIntakeSha256: string;
  readonly sourceText?: string;
  readonly activationSha256: string;
}

export interface SubmitGoalContractCommand {
  readonly type: "SUBMIT_GOAL_CONTRACT";
  readonly goalId: string;
  readonly contract: GoalContractRecord;
}

export interface OpenGoalContractRevisionCommand {
  readonly type: "OPEN_GOAL_CONTRACT_REVISION";
  readonly goalId: string;
  readonly revisionKind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE";
  readonly reasonSha256: string;
}

export interface SubmitRouteSkeletonCommand {
  readonly type: "SUBMIT_ROUTE_SKELETON";
  readonly goalId: string;
  readonly route: RouteSkeletonRecord;
  readonly contract: GoalContractRecord;
}

export interface RecordWorkspaceBaselineCommand {
  readonly type: "RECORD_WORKSPACE_BASELINE";
  readonly goalId: string;
  readonly baseline: WorkspaceBaselineRecord;
}

export interface AuthorizeWorkCellCommand {
  readonly type: "AUTHORIZE_WORK_CELL";
  readonly goalId: string;
  readonly authorization: ExecutionAuthorizationRecord;
}

export interface PrepareOperationCommand {
  readonly type: "PREPARE_OPERATION";
  readonly goalId: string;
  readonly attempt: OperationAttemptRecord;
  readonly prepared: OperationTransitionRecord;
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
}

export interface PrepareAndDispatchOperationCommand {
  readonly type: "PREPARE_AND_DISPATCH_OPERATION";
  readonly goalId: string;
  readonly attempt: OperationAttemptRecord;
  readonly prepared: OperationTransitionRecord;
  readonly dispatched: OperationTransitionRecord;
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
}

export interface TransitionOperationCommand {
  readonly type: "TRANSITION_OPERATION";
  readonly goalId: string;
  readonly transition: OperationTransitionRecord;
}

export interface AttestEvidenceCommand {
  readonly type: "ATTEST_EVIDENCE";
  readonly goalId: string;
  readonly attestation: EvidenceAttestationRecord;
}

export interface RecordTaskFlowHealthCommand {
  readonly type: "RECORD_TASK_FLOW_HEALTH";
  readonly goalId: string;
  readonly health: RouteHealthRecord;
}

export interface CompleteWorkCellCommand {
  readonly type: "COMPLETE_WORK_CELL";
  readonly goalId: string;
  readonly workCellId: string;
  readonly completionSummarySha256: string;
}

export interface ResolvePlanContinuationCommand {
  readonly type: "RESOLVE_PLAN_CONTINUATION";
  readonly goalId: string;
  readonly choice: "BUILD" | "KEEP" | "REVISE";
  readonly decision: TaskDecisionEntryRecord;
}

export interface RecordTaskDecisionCommand {
  readonly type: "RECORD_TASK_DECISION";
  readonly goalId: string;
  readonly decision: TaskDecisionEntryRecord;
}

export interface ControlTaskFlowCommand {
  readonly type: "CONTROL_TASK_FLOW";
  readonly goalId: string;
  readonly action: "PAUSE" | "RESUME" | "CANCEL";
  readonly decision: TaskDecisionEntryRecord;
}

export interface ReconcileOperationCommand {
  readonly type: "RECONCILE_OPERATION";
  readonly goalId: string;
  readonly transition: OperationTransitionRecord;
  readonly disposition: "NOT_DISPATCHED" | "APPLIED" | "NOT_APPLIED" | "APPLIED_UNVERIFIED" | "SAFE_TO_RETRY";
}

export interface CloseTaskFlowGoalCommand {
  readonly type: "CLOSE_TASK_FLOW_GOAL";
  readonly goalId: string;
  readonly deliverable: DeliverableManifestRecord;
}

export type TaskFlowAuthorityCommand =
  | AdmitTaskFlowCommand
  | SubmitGoalContractCommand
  | OpenGoalContractRevisionCommand
  | SubmitRouteSkeletonCommand
  | RecordWorkspaceBaselineCommand
  | AuthorizeWorkCellCommand
  | PrepareOperationCommand
  | PrepareAndDispatchOperationCommand
  | TransitionOperationCommand
  | AttestEvidenceCommand
  | RecordTaskFlowHealthCommand
  | RecordTaskDecisionCommand
  | ControlTaskFlowCommand
  | ReconcileOperationCommand
  | ResolvePlanContinuationCommand
  | CompleteWorkCellCommand
  | CloseTaskFlowGoalCommand;
