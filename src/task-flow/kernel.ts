import type {
  AuthorityStore, CommandResult, HostTaskFlowUserInputMeta, MutationMeta,
} from "../authority/transactions.js";
import type { CodingHarnessConfig } from "../config/types.js";
import type { Clock } from "../foundation/clock.js";
import { systemClock } from "../foundation/clock.js";
import { createId } from "../foundation/ids.js";
import { classifyGoalIntake } from "../planning/intake-classifier.js";
import { classifyTaskFlowInput, type TaskFlowAdmission } from "./admission.js";
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
  TaskDecisionEntryRecord,
  WorkspaceBaselineRecord,
} from "./domain.js";
import { sealTaskFlowRecord } from "./domain.js";
import { assessRouteHealth, type DeterministicRouteDecision, type RouteHealthInput } from "./health.js";
import type { TaskFlowCurrentView } from "./repository.js";
import type { AcceptanceFacetProposalV2 } from "../acceptance-v2/domain.js";
import type { GoalContractProposal } from "./finalize.js";
import type { GoalFitAssessmentProposalV2 } from "../intake-v2/domain.js";
import type {
  CaptureActiveGoalUserTurnCommand, ClassifyActiveGoalUserTurnCommand, ResolveGoalContractReviewCommand,
} from "./commands.js";

export interface TaskFlowAdmissionContext {
  readonly workspaceId: string;
  readonly workspaceHmac: string;
  readonly filesystemKind: string;
  readonly originSessionId: string;
  readonly goalId: string;
  readonly sourceIntakeSha256: string;
  readonly activationSha256: string;
}

export interface TaskFlowAdmissionResult {
  readonly admission: TaskFlowAdmission;
  readonly authority: CommandResult | null;
}

export interface TaskFlowRecoveryProjection {
  readonly view: TaskFlowCurrentView;
  readonly exactNextAction: string;
  readonly requiresReconciliation: boolean;
  readonly additionalModelRequests: 0;
}

export class TaskFlowKernel {
  constructor(private readonly authority: AuthorityStore, private readonly clock: Clock = systemClock) {}

  admit(text: string, config: CodingHarnessConfig, context: TaskFlowAdmissionContext): TaskFlowAdmissionResult {
    const admission = classifyTaskFlowInput(text, config);
    if (admission.action !== "MANAGED" || admission.intent === null || admission.lane === null) return { admission, authority: null };
    const selection = classifyGoalIntake(admission.taskText, config);
    if (selection.specificationRoute === "BYPASS") {
      throw new TypeError("Managed Coding Harness admission cannot use BYPASS planning depth");
    }
    const lane = selection.specificationRoute === "PRD" ? "ADAPTIVE_ROUTE" : admission.lane;
    const authority = this.authority.transactTaskFlow({
      type: "ADMIT_TASK_FLOW", goalId: context.goalId,
      workspace: {
        workspaceId: context.workspaceId, workspaceHmac: context.workspaceHmac,
        filesystemKind: context.filesystemKind, localLockingVerified: true,
      },
      originSessionId: context.originSessionId, objective: admission.objective,
      intent: admission.intent, lane,
      requirementProfile: selection.requirementProfile, planningDepth: selection.planningDepth,
      classification: selection.classification,
      sourceIntakeSha256: context.sourceIntakeSha256,
      sourceText: admission.taskText,
      activationSha256: context.activationSha256,
    }, { expectedVersion: 0, idempotencyKey: `task-flow:admit:${context.activationSha256}`, actor: "USER" });
    return { admission, authority };
  }

  submitContract(
    goalId: string,
    proposal: GoalContractProposal,
    acceptanceFacets: readonly AcceptanceFacetProposalV2[],
    goalFitAssessment: GoalFitAssessmentProposalV2,
    mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT", goalId, proposal, acceptanceFacets, goalFitAssessment,
    }, mutation);
  }

  resolveContractReview(
    command: ResolveGoalContractReviewCommand,
    input: HostTaskFlowUserInputMeta,
  ): CommandResult {
    return this.authority.transactTaskFlowUserInput(command, input);
  }

  captureActiveGoalUserTurn(
    command: CaptureActiveGoalUserTurnCommand,
    input: HostTaskFlowUserInputMeta,
  ): CommandResult {
    return this.authority.transactTaskFlowUserInput(command, input);
  }

  classifyActiveGoalUserTurn(command: ClassifyActiveGoalUserTurnCommand, input: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow(command, input);
  }

  finalizeContractIntake(goalId: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({
      type: "FINALIZE_GOAL_CONTRACT_INTAKE", goalId,
    }, mutation);
  }

  openContractRevision(
    goalId: string,
    revisionKind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE",
    reasonSha256: string,
    mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlow({
      type: "OPEN_GOAL_CONTRACT_REVISION", goalId, revisionKind, reasonSha256,
    }, mutation);
  }

  submitRoute(
    goalId: string, route: RouteSkeletonRecord, contract: GoalContractRecord,
    goalFitAssessment: GoalFitAssessmentProposalV2, mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract, goalFitAssessment,
    }, mutation);
  }

  finalizePlan(goalId: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId }, mutation);
  }

  commitPlanGate(goalId: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "COMMIT_TASK_FLOW_PLAN_GATE", goalId }, mutation);
  }

  recordBaseline(goalId: string, baseline: WorkspaceBaselineRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, mutation);
  }

  authorize(goalId: string, authorization: ExecutionAuthorizationRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, mutation);
  }

  prepareOperation(goalId: string, attempt: OperationAttemptRecord, prepared: OperationTransitionRecord, reconcileLocator: OperationReconcileLocatorRecord | null, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({
      type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator, oracleExecution: null,
    }, mutation);
  }

  transitionOperation(goalId: string, transition: OperationTransitionRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition }, mutation);
  }

  attest(goalId: string, attestation: EvidenceAttestationRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "ATTEST_EVIDENCE", goalId, attestation }, mutation);
  }

  deriveAcceptanceEvidenceV2(
    goalId: string,
    attemptId: string,
    terminalTransitionId: string,
    mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId,
      attemptId,
      terminalTransitionId,
    }, mutation);
  }

  assess(goalId: string, routeId: string, workCellId: string | null, input: RouteHealthInput, mutation: MutationMeta): { readonly decision: DeterministicRouteDecision; readonly health: RouteHealthRecord; readonly authority: CommandResult } {
    const decision = assessRouteHealth(input);
    const health = sealTaskFlowRecord<RouteHealthRecord, "record_sha256">("PCH-ROUTE-HEALTH-V1", {
      schema_version: 1, health_id: createId("HEALTH"), goal_id: goalId, route_id: routeId,
      work_cell_id: workCellId, trigger_sha256: decision.triggerSha256,
      failure_signature_sha256: input.failureSignatureSha256, occurrence: input.failureOccurrence,
      level: decision.level, reason_code: decision.reasonCode, selected_route_id: null,
      created_at_ms: this.clock.now(),
    }, "record_sha256");
    const authority = this.authority.transactTaskFlow({ type: "RECORD_TASK_FLOW_HEALTH", goalId, health }, mutation);
    return { decision, health, authority };
  }

  recordDecision(goalId: string, decision: TaskDecisionEntryRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "RECORD_TASK_DECISION", goalId, decision }, mutation);
  }

  control(goalId: string, action: "PAUSE" | "RESUME" | "CANCEL", decision: TaskDecisionEntryRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "CONTROL_TASK_FLOW", goalId, action, decision }, mutation);
  }

  controlWithManagedRun(
    goalId: string,
    runId: string,
    action: "PAUSE" | "RESUME" | "CANCEL",
    decision: TaskDecisionEntryRecord,
    mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlowHarness(
      { type: "CONTROL_TASK_FLOW", goalId, action, decision },
      { type: "CONTROL_MANAGED_RUN", goalId, runId, action, reasonSha256: decision.record_sha256 },
      mutation,
    );
  }

  reconcile(goalId: string, transition: OperationTransitionRecord, disposition: "NOT_DISPATCHED" | "APPLIED" | "NOT_APPLIED" | "APPLIED_UNVERIFIED" | "SAFE_TO_RETRY", mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "RECONCILE_OPERATION", goalId, transition, disposition }, mutation);
  }

  completeWork(goalId: string, workCellId: string, completionSummarySha256: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "COMPLETE_WORK_CELL", goalId, workCellId, completionSummarySha256 }, mutation);
  }

  completeWorkV2(goalId: string, workCellId: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "COMPLETE_WORK_CELL_V2", goalId, workCellId }, mutation);
  }

  resolvePlanContinuation(goalId: string, choice: "BUILD" | "KEEP" | "REVISE", decision: TaskDecisionEntryRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({
      type: "RESOLVE_PLAN_CONTINUATION", goalId, choice, decision,
    }, mutation);
  }


  keepPlanAndCloseManagedRun(
    goalId: string,
    runId: string,
    decision: TaskDecisionEntryRecord,
    mutation: MutationMeta,
  ): CommandResult {
    return this.authority.transactTaskFlowHarness(
      { type: "RESOLVE_PLAN_CONTINUATION", goalId, choice: "KEEP", decision },
      { type: "CONTROL_MANAGED_RUN", goalId, runId, action: "SUCCEED", reasonSha256: decision.record_sha256 },
      mutation,
    );
  }

  closeGoal(goalId: string, deliverable: DeliverableManifestRecord, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "CLOSE_TASK_FLOW_GOAL", goalId, deliverable }, mutation);
  }

  closeGoalV2(goalId: string, mutation: MutationMeta): CommandResult {
    return this.authority.transactTaskFlow({ type: "CLOSE_TASK_FLOW_GOAL_V2", goalId }, mutation);
  }

  recover(goalId: string): TaskFlowRecoveryProjection {
    const view = this.authority.readTaskFlowRecoveryView(goalId);
    if (!view) throw new TypeError(`Task Flow Goal ${goalId} is not available`);
    const requiresReconciliation = view.unresolvedOperationIds.length > 0 || view.status === "RECONCILING";
    return {
      view,
      exactNextAction: requiresReconciliation ? "RECONCILE_OPERATION" : view.nextActionCode,
      requiresReconciliation,
      additionalModelRequests: 0,
    };
  }
}
