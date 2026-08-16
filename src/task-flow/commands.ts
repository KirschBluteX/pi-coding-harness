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
import type { AcceptanceFacetProposalV2 } from "../acceptance-v2/domain.js";
import type { CanonicalJson } from "../authority/canonical-json.js";
import type { DecisionActionV2, GoalFitAssessmentProposalV2 } from "../intake-v2/domain.js";
import type { GoalContractProposal } from "./finalize.js";
import type { PlanSubjectRefV2 } from "../plan-v2/graph.js";
import type {
  ChangeRequestClassificationV2, ChangeRequestMaterialityV2,
} from "../plan-v2/change-request.js";
import type { ActiveGoalChangeKindV2 } from "../plan-v2/active-goal-input.js";

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
  readonly sourceIntakeSha256: string;
  readonly sourceText?: string;
  readonly activationSha256: string;
}

export interface SubmitGoalContractCommand {
  readonly type: "SUBMIT_GOAL_CONTRACT";
  readonly goalId: string;
  readonly proposal: GoalContractProposal;
  readonly acceptanceFacets: readonly AcceptanceFacetProposalV2[];
  readonly goalFitAssessment: GoalFitAssessmentProposalV2;
}

export interface OpenGoalContractRevisionCommand {
  readonly type: "OPEN_GOAL_CONTRACT_REVISION";
  readonly goalId: string;
  readonly revisionKind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE";
  readonly reasonSha256: string;
}

export type ResolveGoalContractReviewCommand = {
  readonly type: "RESOLVE_GOAL_CONTRACT_REVIEW";
  readonly goalId: string;
  readonly expectedDecisionRequirementRevisionId: string;
  readonly expectedRequirementRevisionSha256: string;
  readonly expectedDecisionFrontierSha256: string;
  readonly selectedValue: CanonicalJson;
} & (
  | { readonly action: Extract<DecisionActionV2, "APPROVE" | "REJECT"> }
  | { readonly action: "EDIT"; readonly editedRequirementRevisionId: string }
  | { readonly action: "DEFER"; readonly deferredTriggerSha256: string }
);

export interface CaptureActiveGoalUserTurnCommand {
  readonly type: "CAPTURE_ACTIVE_GOAL_USER_TURN";
  readonly goalId: string;
  readonly sourceText: string;
  readonly expectedInputClosureSha256: string;
}

export interface ClassifyActiveGoalUserTurnCommand {
  readonly type: "CLASSIFY_ACTIVE_GOAL_USER_TURN";
  readonly goalId: string;
  readonly userTurnId: string;
  readonly expectedUserTurnSha256: string;
  readonly classification: ChangeRequestClassificationV2;
  readonly materiality: ChangeRequestMaterialityV2;
  readonly changeKind: ActiveGoalChangeKindV2 | null;
  readonly changedSubjects: readonly PlanSubjectRefV2[];
}

export type HostTaskFlowUserInputCommand = ResolveGoalContractReviewCommand | CaptureActiveGoalUserTurnCommand;

export interface FinalizeGoalContractIntakeCommand {
  readonly type: "FINALIZE_GOAL_CONTRACT_INTAKE";
  readonly goalId: string;
}

export interface SubmitRouteSkeletonCommand {
  readonly type: "SUBMIT_ROUTE_SKELETON";
  readonly goalId: string;
  readonly route: RouteSkeletonRecord;
  readonly contract: GoalContractRecord;
  readonly goalFitAssessment: GoalFitAssessmentProposalV2;
}

export interface FinalizeTaskFlowPlanCommand {
  readonly type: "FINALIZE_TASK_FLOW_PLAN";
  readonly goalId: string;
}

export interface CommitTaskFlowPlanGateCommand {
  readonly type: "COMMIT_TASK_FLOW_PLAN_GATE";
  readonly goalId: string;
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

export interface OracleExecutionDescriptorProposalV2 {
  readonly command: string;
  readonly policySha256: string;
}

export interface PrepareOperationCommand {
  readonly type: "PREPARE_OPERATION";
  readonly goalId: string;
  readonly attempt: OperationAttemptRecord;
  readonly prepared: OperationTransitionRecord;
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
  readonly oracleExecution: OracleExecutionDescriptorProposalV2 | null;
}

export interface PrepareAndDispatchOperationCommand {
  readonly type: "PREPARE_AND_DISPATCH_OPERATION";
  readonly goalId: string;
  readonly attempt: OperationAttemptRecord;
  readonly prepared: OperationTransitionRecord;
  readonly dispatched: OperationTransitionRecord;
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
  readonly oracleExecution: OracleExecutionDescriptorProposalV2 | null;
}

export interface PreparedOperationDispatch {
  readonly attempt: OperationAttemptRecord;
  readonly prepared: OperationTransitionRecord;
  readonly dispatched: OperationTransitionRecord;
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
  readonly oracleExecution: OracleExecutionDescriptorProposalV2 | null;
}

export interface PrepareAndDispatchOperationBatchCommand {
  readonly type: "PREPARE_AND_DISPATCH_OPERATION_BATCH";
  readonly goalId: string;
  readonly operations: readonly PreparedOperationDispatch[];
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

export interface DeriveAcceptanceEvidenceV2Command {
  readonly type: "DERIVE_ACCEPTANCE_EVIDENCE_V2";
  readonly goalId: string;
  readonly attemptId: string;
  readonly terminalTransitionId: string;
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

export interface CompleteWorkCellV2Command {
  readonly type: "COMPLETE_WORK_CELL_V2";
  readonly goalId: string;
  readonly workCellId: string;
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

export interface CloseTaskFlowGoalV2Command {
  readonly type: "CLOSE_TASK_FLOW_GOAL_V2";
  readonly goalId: string;
}

export type TaskFlowAuthorityCommand =
  | AdmitTaskFlowCommand
  | SubmitGoalContractCommand
  | FinalizeGoalContractIntakeCommand
  | OpenGoalContractRevisionCommand
  | ClassifyActiveGoalUserTurnCommand
  | SubmitRouteSkeletonCommand
  | FinalizeTaskFlowPlanCommand
  | CommitTaskFlowPlanGateCommand
  | RecordWorkspaceBaselineCommand
  | AuthorizeWorkCellCommand
  | PrepareOperationCommand
  | PrepareAndDispatchOperationCommand
  | PrepareAndDispatchOperationBatchCommand
  | TransitionOperationCommand
  | AttestEvidenceCommand
  | DeriveAcceptanceEvidenceV2Command
  | RecordTaskFlowHealthCommand
  | RecordTaskDecisionCommand
  | ControlTaskFlowCommand
  | ReconcileOperationCommand
  | ResolvePlanContinuationCommand
  | CompleteWorkCellCommand
  | CompleteWorkCellV2Command
  | CloseTaskFlowGoalCommand
  | CloseTaskFlowGoalV2Command;
