import { dirname, resolve } from "node:path";
import type { Clock } from "../foundation/clock.js";
import { systemClock } from "../foundation/clock.js";
import { idFromSha256 } from "../foundation/ids.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, VersionConflictError } from "../foundation/errors.js";
import type { PlanPackage, RequirementPackage } from "../planning/types.js";
import { validatePlanFinalizationReport, type PlanFinalizationReport } from "../planning/plan-finalization.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection, runImmediateTransaction, type AuthorityConnection } from "./database.js";
import { type EventType } from "./event-chain.js";
import {
  AuthorityTransactionKernel,
  type AuthorityTransactionFaultPoint,
  type AuthorityTransactionMeta,
} from "./authority-transaction-kernel.js";
import { LeaseManager, type LeaseToken } from "./lease.js";
import { migrateCoreStore } from "./migrate.js";
import { migrateExperimentStore } from "./experiment-migrate.js";
import { migrateMemoryStore, type MemoryMigrationOptions } from "./memory-migrate.js";
import { migrateInputContextStore } from "../input-context/migrate.js";
import { migrateTaskFlowStore } from "../task-flow/migrate.js";
import { migrateHarnessStore } from "../harness/migrate.js";
import { migrateHarnessPostStore } from "../harness/post-migrate.js";
import { HarnessCompactionRepository, type HarnessCompactionHead } from "../context/compaction-v21/repository.js";
import type { HarnessCompactionAttempt, HarnessCompactionTransition } from "../context/compaction-v21/domain.js";
import { CacheV2Repository } from "../cache-v2/repository.js";
import type { CacheLogicalRequestPrepareV2, CacheLogicalRequestV2, CacheRequestAttributionV2, CacheSecurityPartitionV2, StablePrefixFamilyV2 } from "../cache-v2/domain.js";
import { HarnessRepository, type HarnessCurrentView, type HarnessIntegritySummary, type HarnessShardExecutionView } from "../harness/repository.js";
import type { HarnessAuthorityCommand } from "../harness/commands.js";
import { buildAcceptanceLedger } from "../task-flow/acceptance-ledger.js";
import {
  TaskFlowRepository, type ActiveTaskFlowGoal, type TaskFlowCurrentView,
  type TaskFlowIntegritySummary, type TaskFlowOperationSnapshot,
} from "../task-flow/repository.js";
import type { TaskFlowAuthorityCommand } from "../task-flow/commands.js";
import {
  InputContextRepository, type InputContextIntegritySummary, type WorkingSetEnvelopeRecord,
} from "../input-context/repository.js";
import type {
  ContextCompileReceiptRecord, ContextEnvelopeRecord, ContextLayoutManifestRecord,
  ContextProjectionReceiptRecord, ContextRetentionRootRecord, ContextWorkingSetRecord,
  EvidenceValidityTransitionRecord, ProjectKnowledgeClaimRecord, ProjectSourceManifestRecord,
  ProviderTurnAttemptRecord, ProviderTurnLedgerRecord, ProviderTurnRequestRecord,
  ReadEvidenceReceiptRecord, ToolSurfacePlanRecord,
} from "../input-context/domain.js";
import { rebuildGoalSnapshot, verifyAuthorityIntegrity, type GoalSnapshot } from "./projections.js";
import { AuthorityRepository, type GoalRow, type PersistedCommandResult } from "./repositories.js";
import { registerArtifact, type ArtifactMetadata } from "./repositories/common.js";
import { DecisionRepository, type DecisionRequestRecord, type DecisionResolutionRecord, type StoredDecision } from "./repositories/decisions.js";
import { EffectRepository, type PreparedEffectRecord, type StoredEffectOutcome } from "./repositories/effects.js";
import { PlanRepository, type FrozenPlanArtifacts } from "./repositories/plans.js";
import { ReceiptRepository } from "./repositories/receipts.js";
import { RequirementRepository, type FrozenRequirementArtifacts } from "./repositories/requirements.js";
import {
  CheckpointRepository, checkpointSemanticSha256, type CheckpointInsert,
} from "./repositories/checkpoints.js";
import { RecoveryRepository, type AuthorityRecoveryMaterial } from "./repositories/recovery.js";
import { ExperimentRepository, type ActivePerformanceTrialMaterial, type ExperimentEpochInput } from "./repositories/experiments.js";
import { EvidenceRepository, type EvidenceLookup } from "./repositories/evidence.js";
import type { TrialPairSample } from "../performance/benchmark-harness.js";
import type { OpportunityAdmission } from "../performance/opportunities.js";
import type { PerformanceTrialSpec, PerformanceVerdictRecord } from "../performance/trial-types.js";
import { TargetPerformanceRepository } from "../performance/task-flow-repository.js";
import type {
  TargetPerformanceMeasurementRecord, TargetPerformanceVerdictRecord,
} from "../performance/task-flow-measurements.js";
import type { TargetPerformancePhase } from "../performance/task-flow-policy.js";
import { MemoryRepository } from "./repositories/memory.js";
import {
  MemoryV3Repository, type MemoryCaptureCommandResult, type MemoryCaptureFaultPoint,
  type MemoryV3ActionCommandResult, type MemoryV3ActionInput, type MemoryV3CaptureEvent,
  type MemoryV3CandidateHeadMatch, type MemoryV3ClaimCommandResult, type MemoryV3ClaimHeadRecord, type MemoryV3ClaimRecord,
  type MemoryV3WorkspaceStatus,
  type MemoryV3MutationFaultPoint, type MemoryV3StoreClaimInput,
  type MemoryV3PurgeIntentInput, type MemoryV3PurgeIntentRecord, type MemoryV3PurgeIntentResult,
} from "./repositories/memory-v3.js";
import {
  MemoryCaptureV31Repository, type MemoryCaptureV31CommitResult, type MemoryCaptureV31IntentRecord,
  type MemoryCaptureV31IntentResult, type MemoryCaptureV31Limits, type MemoryCaptureV31PreparedRecord,
  type MemoryCaptureV31ReceiptRecord,
  type MemoryCaptureV31VaultInput, type MemoryCandidateClusterV31Record, type MemoryObservationV31Record,
  type MemoryProposalV31Record,
} from "./repositories/memory-capture-v31.js";
import type { MemoryCaptureDecision } from "../memory/capture.js";
import type {
  EffectiveMemoryClaim, MemoryCandidateRank, MemoryClaimActionInput, MemoryClaimActionRecord,
  MemoryCheckpointSnapshotRecord, MemoryClaimVersionInput, MemoryClaimVersionRecord, MemoryIndexDrainResult,
  MemoryRecallObservation, MemoryReceiptAttestationSource,
} from "../memory/types.js";
import type { PromptGenerationRecord } from "../context/prompt-generation.js";
import type { PromptRequestRecord } from "../context/prompt-request.js";
import type { CacheEpochPreregistration, CacheObservationRecord } from "../cache/telemetry.js";
import { PlanHealthRepository, type StoredRouteDecisionRecord } from "./repositories/plan-health.js";
import { WorkflowRepository, type WorkflowAdvance, type WorkflowState } from "./repositories/workflow.js";
import type { GoalStatus } from "./state-machines.js";
import {
  validateGoalClassificationCompatibility,
  validateIntakeClassificationRecord,
  type IntakeClassificationRecord,
} from "../planning/intake-classifier.js";

export type { AuthorityActor } from "./authority-transaction-kernel.js";

export interface MutationMeta extends AuthorityTransactionMeta {
  readonly lease?: LeaseToken;
}

export interface CreateGoalCommand {
  readonly type: "CREATE_GOAL";
  readonly goalId: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspaceHmac: string;
    readonly filesystemKind: string;
    readonly localLockingVerified: true;
  };
  readonly originSessionId: string;
  readonly objective: string;
  readonly intent: "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
  readonly requirementProfile: "TASK_SPEC" | "PRD";
  readonly planningDepth: "LIGHT" | "STANDARD" | "FULL";
  readonly classification: IntakeClassificationRecord;
}

export interface AppendEventCommand {
  readonly type: "APPEND_EVENT";
  readonly goalId: string;
  readonly eventType: EventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FreezeRequirementCommand {
  readonly type: "FREEZE_REQUIREMENT";
  readonly goalId: string;
  readonly requirement: RequirementPackage;
  readonly artifacts: FrozenRequirementArtifacts;
  readonly triggerType: string;
  readonly triggerEvidenceSha256: string;
}

export interface FreezePlanCommand {
  readonly type: "FREEZE_PLAN";
  readonly goalId: string;
  readonly plan: PlanPackage;
  readonly artifacts: FrozenPlanArtifacts;
  readonly triggerType: string;
  readonly triggerEvidenceSha256: string;
  readonly rationale: string;
  readonly finalization: PlanFinalizationReport;
}

export interface AuthorizeStageCommand {
  readonly type: "AUTHORIZE_STAGE";
  readonly goalId: string;
  readonly planId: string;
  readonly stageId: string;
  readonly reasonCode: string;
}

export interface CompleteStageCommand {
  readonly type: "COMPLETE_STAGE";
  readonly goalId: string;
  readonly planId: string;
  readonly stageId: string;
  readonly completionSummarySha256: string;
}

export interface TransitionGoalCommand {
  readonly type: "TRANSITION_GOAL";
  readonly goalId: string;
  readonly action: "pause" | "resume" | "cancel" | "plan_complete" | "complete" | "wait_user" | "decision_resolved" | "plan_continue";
  readonly fromStatus: GoalStatus;
  readonly toStatus: GoalStatus;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly planId: string | null;
  readonly stageId: string | null;
  readonly reason: string | null;
}

export interface InvalidateRouteCommand {
  readonly type: "INVALIDATE_ROUTE";
  readonly goalId: string;
  readonly planId: string;
  readonly causeId: string;
  readonly evidenceSha256: string;
  readonly reason: string;
  readonly revisionKind: "PLAN" | "REQUIREMENT";
}

export interface RequestDecisionCommand extends DecisionRequestRecord {
  readonly type: "REQUEST_DECISION";
}

export interface ResolveDecisionCommand extends DecisionResolutionRecord {
  readonly type: "RESOLVE_DECISION";
  readonly goalId: string;
}

export interface PrepareEffectCommand extends PreparedEffectRecord {
  readonly type: "PREPARE_EFFECT";
  readonly inputClosureSha256: string;
  readonly approvalResolutionId: string | null;
  readonly approvalResolutionSha256: string | null;
}

export interface RecordEffectOutcomeCommand {
  readonly type: "RECORD_EFFECT_OUTCOME";
  readonly goalId: string;
  readonly effectId: string;
  readonly outcomeId: string;
  readonly outcomeReceiptId: string;
  readonly outcome: StoredEffectOutcome;
  readonly inputClosureSha256: string;
  readonly outputSha256: string | null;
  readonly targetReadbackSha256: string | null;
  readonly failureSignatureSha256: string | null;
}

export interface RecordArtifactObservationCommand {
  readonly type: "RECORD_ARTIFACT_OBSERVATION";
  readonly goalId: string;
  readonly observationId: string;
  readonly observationType: "PROMPT_GENERATION" | "PROMPT_REQUEST" | "OUTPUT_OBSERVATION" | "TOOL_RESULT_PROJECTION";
  readonly artifact: ArtifactMetadata;
  readonly promptGeneration?: PromptGenerationRecord;
  readonly promptRequest?: PromptRequestRecord;
  readonly inputClosureSha256: string;
}

export interface RecordCacheObservationCommand {
  readonly type: "RECORD_CACHE_OBSERVATION";
  readonly goalId: string;
  readonly epoch: { readonly record: CacheEpochPreregistration; readonly artifact: ArtifactMetadata };
  readonly generations: readonly {
    readonly record: PromptGenerationRecord;
    readonly artifact: ArtifactMetadata;
    readonly epochId: string | null;
  }[];
  readonly requests: readonly { readonly record: PromptRequestRecord; readonly artifact: ArtifactMetadata }[];
  readonly observation: { readonly record: CacheObservationRecord; readonly artifact: ArtifactMetadata };
  readonly inputClosureSha256: string;
}

export interface CreateCheckpointCommand {
  readonly type: "CREATE_CHECKPOINT";
  readonly goalId: string;
  readonly checkpoint: CheckpointInsert;
}

export interface RecordRouteDecisionCommand {
  readonly type: "RECORD_ROUTE_DECISION";
  readonly goalId: string;
  readonly decision: StoredRouteDecisionRecord;
}

export interface RecordPerformanceEvidenceCommand {
  readonly type: "RECORD_PERFORMANCE_EVIDENCE";
  readonly goalId: string;
  readonly receiptId: string;
  readonly evidenceKind: "BASELINE_CORRECTNESS" | "CANDIDATE_CORRECTNESS" | "HOLDOUT_CORRECTNESS" | "PROFILE" | "STATIC_ANALYSIS";
  readonly subjectId: string;
  readonly result: "SUCCEEDED" | "FAILED";
  readonly inputClosureSha256: string;
  readonly artifact: ArtifactMetadata;
}

export interface AuthorizePerformanceTrialCommand {
  readonly type: "AUTHORIZE_PERFORMANCE_TRIAL";
  readonly goalId: string;
  readonly spec: PerformanceTrialSpec;
  readonly admission: OpportunityAdmission;
  readonly epoch: ExperimentEpochInput;
  readonly attempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly leaseGeneration: number;
    readonly fencingToken: number;
  };
  readonly artifacts: {
    readonly preregistration: ArtifactMetadata;
    readonly contract: ArtifactMetadata;
    readonly trialSpec: ArtifactMetadata;
    readonly admission: ArtifactMetadata;
    readonly candidatePatch: ArtifactMetadata;
  };
}

export interface RecordPerformanceSamplesCommand {
  readonly type: "RECORD_PERFORMANCE_SAMPLES";
  readonly goalId: string;
  readonly spec: PerformanceTrialSpec;
  readonly samples: readonly TrialPairSample[];
  readonly sampleSetArtifact: ArtifactMetadata;
}

export interface RecordPerformanceVerdictCommand {
  readonly type: "RECORD_PERFORMANCE_VERDICT";
  readonly goalId: string;
  readonly verdict: PerformanceVerdictRecord;
  readonly correctnessReceiptId: string | null;
  readonly holdoutReceiptId: string | null;
  readonly artifacts: {
    readonly sampleSet: ArtifactMetadata;
    readonly baselineSet: ArtifactMetadata;
    readonly candidateSet: ArtifactMetadata;
    readonly statistics: ArtifactMetadata;
    readonly verdict: ArtifactMetadata;
  };
}

export interface AppendMemoryClaimCommand {
  readonly type: "APPEND_MEMORY_CLAIM";
  readonly goalId: string;
  readonly record: MemoryClaimVersionInput;
}

export interface AppendMemoryActionCommand {
  readonly type: "APPEND_MEMORY_ACTION";
  readonly goalId: string;
  readonly memoryAction: MemoryClaimActionInput;
}

export type AuthorityCommand =
  | CreateGoalCommand
  | AppendEventCommand
  | FreezeRequirementCommand
  | FreezePlanCommand
  | AuthorizeStageCommand
  | CompleteStageCommand
  | TransitionGoalCommand
  | InvalidateRouteCommand
  | RequestDecisionCommand
  | ResolveDecisionCommand
  | PrepareEffectCommand
  | RecordEffectOutcomeCommand
  | RecordArtifactObservationCommand
  | RecordCacheObservationCommand
  | RecordRouteDecisionCommand
  | CreateCheckpointCommand
  | RecordPerformanceEvidenceCommand
  | AuthorizePerformanceTrialCommand
  | RecordPerformanceSamplesCommand
  | RecordPerformanceVerdictCommand
  | AppendMemoryClaimCommand
  | AppendMemoryActionCommand;
export type TransactionFaultPoint = AuthorityTransactionFaultPoint;

export interface CommandResult extends PersistedCommandResult {
  readonly reused: boolean;
}

export interface AuthorityStoreOptions {
  readonly databasePath: string;
  readonly migrationPath?: string;
  readonly experimentsMigrationPath?: string | false;
  readonly memoryMigrations?: MemoryMigrationOptions | false;
  readonly taskFlowMigrationPath?: string | false;
  readonly inputContextMigrationPath?: string | false;
  readonly harnessMigrationPath?: string | false;
  readonly busyTimeoutMs?: number;
  readonly clock?: Clock;
}

function commandGoalId(command: AuthorityCommand): string {
  return command.goalId;
}

export class AuthorityStore {
  private readonly repository: AuthorityRepository;
  private readonly transactionKernel: AuthorityTransactionKernel;
  private readonly leases: LeaseManager;
  private readonly requirements: RequirementRepository;
  private readonly plans: PlanRepository;
  private readonly receipts: ReceiptRepository;
  private readonly decisions: DecisionRepository;
  private readonly effects: EffectRepository;
  private readonly checkpoints: CheckpointRepository;
  private readonly planHealth: PlanHealthRepository;
  private readonly workflow: WorkflowRepository;
  private readonly recovery: RecoveryRepository;
  private readonly experiments: ExperimentRepository;
  private readonly evidence: EvidenceRepository;
  private readonly memories: MemoryRepository;
  private readonly memoriesV3: MemoryV3Repository;
  private readonly memoryCaptureV31: MemoryCaptureV31Repository;
  private readonly taskFlow: TaskFlowRepository;
  private readonly inputContext: InputContextRepository;
  private readonly harness: HarnessRepository;
  private readonly harnessCompaction: HarnessCompactionRepository;
  private readonly cacheV2: CacheV2Repository;
  private readonly targetPerformance: TargetPerformanceRepository;
  private readonly clock: Clock;
  private startupIntegrityDataVersion: number | null = null;

  private constructor(private readonly connection: AuthorityConnection, clock: Clock) {
    this.repository = new AuthorityRepository(connection);
    this.transactionKernel = new AuthorityTransactionKernel(connection, clock);
    this.leases = new LeaseManager(connection);
    this.requirements = new RequirementRepository(connection);
    this.plans = new PlanRepository(connection);
    this.receipts = new ReceiptRepository(connection);
    this.decisions = new DecisionRepository(connection);
    this.effects = new EffectRepository(connection);
    this.checkpoints = new CheckpointRepository(connection);
    this.planHealth = new PlanHealthRepository(connection);
    this.workflow = new WorkflowRepository(connection);
    this.recovery = new RecoveryRepository(connection);
    this.experiments = new ExperimentRepository(connection);
    this.evidence = new EvidenceRepository(connection);
    this.memories = new MemoryRepository(connection);
    this.memoriesV3 = new MemoryV3Repository(connection);
    this.memoryCaptureV31 = new MemoryCaptureV31Repository(connection);
    this.taskFlow = new TaskFlowRepository(connection);
    this.inputContext = new InputContextRepository(connection);
    this.harness = new HarnessRepository(connection);
    this.harnessCompaction = new HarnessCompactionRepository(connection);
    this.cacheV2 = new CacheV2Repository(connection);
    this.targetPerformance = new TargetPerformanceRepository(connection);
    this.clock = clock;
  }

  static open(options: AuthorityStoreOptions): AuthorityStore {
    const databaseOptions = options.busyTimeoutMs === undefined
      ? { path: options.databasePath }
      : { path: options.databasePath, busyTimeoutMs: options.busyTimeoutMs };
    const connection = openAuthorityConnection(databaseOptions);
    try {
      migrateCoreStore(connection, options.migrationPath ?? resolve("schemas", "sql", "001_core.sql"));
      if (options.experimentsMigrationPath !== false) {
        migrateExperimentStore(connection, options.experimentsMigrationPath ?? resolve("schemas", "sql", "002_experiments.sql"));
      }
      if (options.memoryMigrations !== false && options.memoryMigrations !== undefined) {
        migrateMemoryStore(connection, options.memoryMigrations);
      }
      if (options.taskFlowMigrationPath !== false && options.taskFlowMigrationPath !== undefined) {
        migrateTaskFlowStore(connection, options.taskFlowMigrationPath);
      }
      if (options.inputContextMigrationPath !== false && options.inputContextMigrationPath !== undefined) {
        migrateInputContextStore(connection, options.inputContextMigrationPath);
      }
      if (options.harnessMigrationPath !== false && options.harnessMigrationPath !== undefined) {
        migrateHarnessStore(connection, options.harnessMigrationPath);
        migrateHarnessPostStore(connection, dirname(resolve(options.harnessMigrationPath)), (options.clock ?? systemClock).now());
      }
      verifyAuthorityIntegrity(connection);
      const store = new AuthorityStore(connection, options.clock ?? systemClock);
      store.memoriesV3.verifyIntegrity();
      store.memoryCaptureV31.verifyIntegrity();
      if (store.taskFlow.available()) store.taskFlow.verifyIntegrity();
      if (store.inputContext.available()) store.inputContext.verifyIntegrity();
      if (store.harness.available()) {
        store.harness.verifyIntegrity();
        store.harnessCompaction.verifyIntegrity();
      }
      store.targetPerformance.verifyIntegrity();
      store.captureStartupIntegrityReceipt();
      return store;
    } catch (error) {
      closeAuthorityConnection(connection);
      throw error;
    }
  }

  close(): void {
    closeAuthorityConnection(this.connection);
  }

  acquireLease(goalId: string, ownerSessionId: string, ttlMs: number): LeaseToken {
    return this.leases.acquire(goalId, ownerSessionId, this.clock.now(), ttlMs);
  }

  renewLease(token: LeaseToken, ttlMs: number, lastProgressEventSequence: number): LeaseToken {
    return this.leases.renew(token, this.clock.now(), ttlMs, lastProgressEventSequence);
  }

  withLeaseFence<T>(token: LeaseToken, effect: () => T): T {
    return runImmediateTransaction(this.connection, () => {
      this.leases.assertCurrent(token, this.clock.now());
      return effect();
    });
  }

  transact(command: AuthorityCommand, meta: MutationMeta, onFault?: (point: TransactionFaultPoint) => void): CommandResult {
    const goalId = commandGoalId(command);
    // Checkpoint IDs and timestamps are locally regenerated on a retry; their validated semantic closure is stable.
    const commandSha256 = command.type === "CREATE_CHECKPOINT"
      ? checkpointSemanticSha256(command.checkpoint)
      : canonicalJsonSha256(command);
    return this.transactionKernel.execute(
      { goalId, commandSha256, meta },
      {
        mutate: ({ currentVersion, nowMs, sequence }) => {
          let workflowAdvance: WorkflowAdvance | null = null;
          let invalidatedIds: readonly string[] = [];
      if (command.type === "CREATE_GOAL") {
        if (currentVersion !== 0 || this.repository.goalExists(goalId)) throw new VersionConflictError(0, Math.max(1, currentVersion));
        if (!/^[a-f0-9]{64}$/u.test(command.workspace.workspaceHmac)) throw new AuthorityIntegrityError("workspaceHmac must be lowercase SHA-256");
        const objective = command.objective.normalize("NFC");
        if (!objective) throw new AuthorityIntegrityError("Goal objective cannot be empty");
        const classificationIssues = validateIntakeClassificationRecord(command.classification);
        if (classificationIssues.length > 0) throw new AuthorityIntegrityError(`Goal intake classification is invalid: ${classificationIssues.join("; ")}`);
        const compatibilityIssues = validateGoalClassificationCompatibility(command.classification, command.requirementProfile, command.planningDepth);
        if (compatibilityIssues.length > 0) throw new AuthorityIntegrityError(`Goal intake classification is inconsistent: ${compatibilityIssues.join("; ")}`);
        this.repository.insertWorkspace({ ...command.workspace, createdAtMs: nowMs });
        const goal: GoalRow = {
          goalId, workspaceId: command.workspace.workspaceId, originSessionId: command.originSessionId,
          objective, objectiveSha256: sha256Hex(objective), intent: command.intent,
          requirementProfile: command.requirementProfile, planningDepth: command.planningDepth, createdAtMs: nowMs,
        };
        this.repository.insertGoal(goal);
      } else {
        if (!meta.lease) throw new AuthorityIntegrityError(`${command.type} requires a lease token`);
        if (meta.lease.goalId !== goalId) throw new AuthorityIntegrityError("Mutation lease Goal substitution");
        this.leases.assertCurrent(meta.lease, nowMs);
      }
      if (command.type === "FREEZE_REQUIREMENT") {
        if (command.goalId !== command.requirement.package.goal_id) throw new AuthorityIntegrityError("Requirement command Goal substitution");
        const goal = this.repository.goal(goalId);
        if (command.requirement.package.profile !== goal.requirementProfile) {
          throw new AuthorityIntegrityError("Requirement profile substitution against Goal admission");
        }
        const validationReceiptId = idFromSha256("RCP", sha256Hex(`REQUIREMENT_VALIDATION\0${command.requirement.integrity.requirements_payload_sha256}`));
        this.receipts.insert({
          receiptId: validationReceiptId, goalId, receiptType: "REQUIREMENT_VALIDATION", subjectType: "REQUIREMENT",
          subjectId: command.requirement.package.requirement_id, result: "SUCCEEDED",
          inputClosureSha256: command.requirement.package.source_intake_sha256,
          outputSha256: command.requirement.integrity.requirements_payload_sha256,
          body: { additionalModelRequests: 0, requirementId: command.requirement.package.requirement_id, valid: true },
          issuer: "PlanningEngine", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.requirements.insertFrozen(command.requirement, command.artifacts, validationReceiptId, command.triggerType, command.triggerEvidenceSha256, nowMs, sequence);
      } else if (command.type === "FREEZE_PLAN") {
        if (command.goalId !== command.plan.package.goal_id) throw new AuthorityIntegrityError("Plan command Goal substitution");
        const goal = this.repository.goal(goalId);
        if (command.plan.plan.planning_depth !== goal.planningDepth) {
          throw new AuthorityIntegrityError("Plan planning-depth substitution against Goal admission");
        }
        try {
          validatePlanFinalizationReport(command.finalization, command.plan);
        } catch (error) {
          throw new AuthorityIntegrityError(error instanceof Error ? error.message : "Plan finalization report is invalid");
        }
        const validationReceiptId = idFromSha256("RCP", sha256Hex(`PLAN_VALIDATION\0${command.plan.integrity.plan_payload_sha256}`));
        this.receipts.insert({
          receiptId: validationReceiptId, goalId, receiptType: "PLAN_VALIDATION", subjectType: "PLAN",
          subjectId: command.plan.package.plan_id, result: "SUCCEEDED",
          inputClosureSha256: command.plan.package.requirement_payload_sha256,
          outputSha256: command.plan.integrity.plan_payload_sha256,
          body: { additionalModelRequests: 0, planId: command.plan.package.plan_id, valid: true, finalization: command.finalization },
          issuer: "PlanningEngine", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.plans.insertFrozen(command.plan, command.artifacts, validationReceiptId, command.triggerType, command.triggerEvidenceSha256, command.rationale, nowMs, sequence);
        this.workflow.initializePlan(command.plan, sequence);
      } else if (command.type === "AUTHORIZE_STAGE") {
        this.workflow.authorize(goalId, command.planId, command.stageId, sequence);
      } else if (command.type === "COMPLETE_STAGE") {
        if (!/^[a-f0-9]{64}$/u.test(command.completionSummarySha256)) throw new AuthorityIntegrityError("Stage completion summary hash is invalid");
        workflowAdvance = this.workflow.complete(
          goalId, command.planId, command.stageId, command.completionSummarySha256, nowMs, sequence,
        );
      } else if (command.type === "TRANSITION_GOAL") {
        this.workflow.transitionGoal(command, sequence);
      } else if (command.type === "INVALIDATE_ROUTE") {
        invalidatedIds = this.workflow.invalidateRoute(
          goalId, command.planId, command.causeId, command.evidenceSha256, command.reason, sequence,
        );
      } else if (command.type === "REQUEST_DECISION") {
        this.decisions.insertRequest(command, sequence);
      } else if (command.type === "RESOLVE_DECISION") {
        this.decisions.insertResolution(command, goalId, sequence);
        const receiptId = idFromSha256("RCP", sha256Hex(`DECISION\0${command.resolutionSha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "DECISION", subjectType: "DECISION", subjectId: command.decisionId,
          result: "SUCCEEDED", inputClosureSha256: canonicalJsonSha256({ decisionId: command.decisionId }),
          outputSha256: command.resolutionSha256,
          body: { resolutionId: command.resolutionId, selectedOptionId: command.selectedOptionId, source: command.source },
          issuer: command.source === "USER" ? "USER" : "RUNTIME", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
      } else if (command.type === "PREPARE_EFFECT") {
        if (!meta.lease) throw new AuthorityIntegrityError("PREPARE_EFFECT requires a lease token");
        if (command.attempt.leaseGeneration !== meta.lease.generation || command.attempt.fencingToken !== meta.lease.fencingToken) {
          throw new AuthorityIntegrityError("Effect attempt fencing does not match the current lease");
        }
        if (command.workItem.effectClass === "IRREVERSIBLE") {
          const expectedBindingSha256 = canonicalJsonSha256({
            effectClass: command.workItem.effectClass,
            normalizedPayloadSha256: command.effect.normalizedPayloadSha256,
            normalizedTargetSha256: command.effect.normalizedTargetSha256,
          });
          const approval = command.approvalResolutionId ? this.decisions.approval(command.approvalResolutionId) : null;
          if (!command.approvalResolutionId || !command.approvalResolutionSha256
            || approval?.resolutionSha256 !== command.approvalResolutionSha256
            || approval.bindingSha256 !== expectedBindingSha256) {
            throw new AuthorityIntegrityError("Irreversible effect requires an exact Decision resolution receipt");
          }
        }
        this.effects.insertWorkItemAndAttempt(command, nowMs, sequence);
        this.receipts.insert({
          receiptId: command.effect.intentReceiptId, goalId, receiptType: "EFFECT_INTENT", subjectType: "EFFECT",
          subjectId: command.effect.effectId, attemptId: command.attempt.attemptId, result: "SUCCEEDED",
          inputClosureSha256: command.inputClosureSha256, outputSha256: command.workItem.specSha256,
          body: {
            approvalResolutionId: command.approvalResolutionId,
            approvalResolutionSha256: command.approvalResolutionSha256,
            effectClass: command.workItem.effectClass,
            idempotencyKeyHmac: command.effect.idempotencyKeyHmac,
            normalizedPayloadSha256: command.effect.normalizedPayloadSha256,
            normalizedTargetSha256: command.effect.normalizedTargetSha256,
          },
          issuer: "RUNTIME", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.effects.insertEffect(command, sequence);
      } else if (command.type === "RECORD_EFFECT_OUTCOME") {
        const attemptId = this.effects.attemptId(command.effectId, goalId);
        const receiptResult = command.outcome === "COMMITTED" || command.outcome === "RECONCILED_COMMITTED" ? "SUCCEEDED"
          : command.outcome === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "FAILED";
        this.receipts.insert({
          receiptId: command.outcomeReceiptId, goalId, receiptType: "EFFECT_OUTCOME", subjectType: "EFFECT",
          subjectId: command.effectId, attemptId, result: receiptResult,
          inputClosureSha256: command.inputClosureSha256, outputSha256: command.outputSha256,
          failureSignatureSha256: command.failureSignatureSha256,
          body: { outcome: command.outcome, targetReadbackSha256: command.targetReadbackSha256 },
          issuer: "TOOL_ADAPTER", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.effects.insertOutcome(command, nowMs, sequence);
      } else if (command.type === "RECORD_ARTIFACT_OBSERVATION") {
        registerArtifact(this.connection, command.artifact, nowMs);
        if (command.observationType === "PROMPT_GENERATION") {
          if (!command.promptGeneration || command.promptRequest
            || command.promptGeneration.prompt_generation_id !== command.observationId) {
            throw new AuthorityIntegrityError("PromptGeneration observation binding is incomplete or substituted");
          }
          this.experiments.insertPromptGeneration(
            command.goalId, command.promptGeneration, command.artifact, null,
          );
        } else if (command.observationType === "PROMPT_REQUEST") {
          if (!command.promptRequest || command.promptGeneration
            || command.promptRequest.prompt_request_id !== command.observationId) {
            throw new AuthorityIntegrityError("PromptRequest observation binding is incomplete or substituted");
          }
          this.experiments.insertPromptRequest(command.promptRequest, command.artifact);
        } else if (command.promptGeneration || command.promptRequest) {
          throw new AuthorityIntegrityError("Non-prompt observation cannot carry a prompt transport record");
        }
        const receiptId = idFromSha256("RCP", sha256Hex([
          "OBSERVATION", goalId, command.observationId, command.observationType, command.artifact.sha256,
        ].join("\0")));
        this.receipts.insert({
          receiptId, goalId, receiptType: "VALIDATION", subjectType: "ARTIFACT", subjectId: command.observationId,
          result: "SUCCEEDED", inputClosureSha256: command.inputClosureSha256,
          outputSha256: command.artifact.sha256,
          body: { artifactId: command.artifact.artifactId, observationId: command.observationId, observationType: command.observationType },
          issuer: "RUNTIME", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(receiptId, command.artifact.artifactId, command.observationType);
      } else if (command.type === "RECORD_CACHE_OBSERVATION") {
        const currentGeneration = command.generations.at(-1)?.record;
        const currentRequest = command.requests.at(-1)?.record;
        const observation = command.observation.record;
        if (!currentGeneration || !currentRequest || observation.epoch_id !== command.epoch.record.epoch_id
          || observation.prompt_generation_id !== currentGeneration.prompt_generation_id
          || observation.prompt_request_id !== currentRequest.prompt_request_id) {
          throw new AuthorityIntegrityError("Cache observation command closure is incomplete or substituted");
        }
        const recordArtifacts = [command.epoch, ...command.generations, ...command.requests, command.observation];
        for (const item of recordArtifacts) {
          if (item.artifact.sha256 !== canonicalJsonSha256(item.record)) {
            throw new AuthorityIntegrityError("Cache authority artifact does not bind its typed record");
          }
          registerArtifact(this.connection, item.artifact, nowMs);
        }
        this.experiments.insertCacheObservation({
          goalId, epoch: command.epoch, generations: command.generations,
          requests: command.requests, observation: command.observation,
        }, nowMs, sequence);
        const receiptId = idFromSha256("RCP", sha256Hex(`CACHE_OBSERVATION\0${observation.observation_id}\0${command.observation.artifact.sha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "CACHE_OBSERVATION", subjectType: "CACHE_OBSERVATION",
          subjectId: observation.observation_id, result: observation.state === "ERROR" ? "FAILED" : "SUCCEEDED",
          inputClosureSha256: command.inputClosureSha256, outputSha256: command.observation.artifact.sha256,
          body: {
            epochId: observation.epoch_id, promptGenerationId: observation.prompt_generation_id,
            promptRequestId: observation.prompt_request_id, state: observation.state,
          }, issuer: "CacheCoordinator", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(receiptId, command.epoch.artifact.artifactId, "CACHE_EPOCH_PREREGISTRATION");
        this.receipts.linkArtifact(receiptId, command.generations.at(-1)!.artifact.artifactId, "PROMPT_GENERATION");
        this.receipts.linkArtifact(receiptId, command.requests.at(-1)!.artifact.artifactId, "PROMPT_REQUEST");
        this.receipts.linkArtifact(receiptId, command.observation.artifact.artifactId, "CACHE_OBSERVATION");
      } else if (command.type === "RECORD_ROUTE_DECISION") {
        if (command.decision.goalId !== goalId) throw new AuthorityIntegrityError("RouteDecision command Goal substitution");
        this.planHealth.insertRouteDecision(command.decision, sequence);
      } else if (command.type === "CREATE_CHECKPOINT") {
        const record = command.checkpoint.record;
        if (record.goal_id !== goalId || record.goal_version !== sequence || record.event_sequence !== sequence) {
          throw new AuthorityIntegrityError("Checkpoint Goal or event sequence substitution");
        }
        if (!meta.lease || record.protected_state.lease_generation !== meta.lease.generation) {
          throw new AuthorityIntegrityError("Checkpoint lease generation does not match the current mutation lease");
        }
        this.checkpoints.insert(command.checkpoint, nowMs);
        if (command.checkpoint.memorySnapshot) onFault?.("after-memory-checkpoint-write");
        const receiptId = idFromSha256("RCP", sha256Hex(`CHECKPOINT\0${record.record_sha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "CHECKPOINT", subjectType: "MILESTONE_CHECKPOINT",
          subjectId: record.record_id, result: "SUCCEEDED", inputClosureSha256: record.protected_state_sha256,
          outputSha256: record.record_sha256, body: {
            reason: record.reason, snapshotId: command.checkpoint.snapshotId,
            memorySnapshotId: command.checkpoint.memorySnapshot?.record_id ?? null,
            memorySnapshotSha256: command.checkpoint.memorySnapshot?.record_sha256 ?? null,
          },
          issuer: "RUNTIME", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
      } else if (command.type === "RECORD_PERFORMANCE_EVIDENCE") {
        registerArtifact(this.connection, command.artifact, nowMs);
        this.receipts.insert({
          receiptId: command.receiptId, goalId, receiptType: `PERFORMANCE_${command.evidenceKind}`,
          subjectType: "PERFORMANCE_EVIDENCE", subjectId: command.subjectId, result: command.result,
          inputClosureSha256: command.inputClosureSha256,
          outputSha256: command.result === "SUCCEEDED" ? command.artifact.sha256 : null,
          body: { artifactId: command.artifact.artifactId, evidenceKind: command.evidenceKind },
          issuer: "PerformanceCoordinator", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(command.receiptId, command.artifact.artifactId, command.evidenceKind);
      } else if (command.type === "AUTHORIZE_PERFORMANCE_TRIAL") {
        if (!meta.lease || command.attempt.leaseGeneration !== meta.lease.generation
          || command.attempt.fencingToken !== meta.lease.fencingToken) {
          throw new AuthorityIntegrityError("PerformanceTrial Attempt fencing does not match the current lease");
        }
        if (command.spec.goal_id !== goalId || command.spec.epoch_id !== command.epoch.epochId
          || command.spec.environment_fingerprint_sha256 !== command.epoch.runtimeFingerprintSha256) {
          throw new AuthorityIntegrityError("PerformanceTrial Goal, epoch, or environment substitution");
        }
        if (command.artifacts.trialSpec.sha256 !== canonicalJsonSha256(command.spec)
          || command.artifacts.contract.sha256 !== command.spec.performance_contract_sha256
          || command.artifacts.admission.sha256 !== canonicalJsonSha256(command.admission)
          || command.artifacts.candidatePatch.sha256 !== command.spec.candidate_patch_sha256
          || command.artifacts.preregistration.sha256 !== command.spec.protocol_sha256) {
          throw new AuthorityIntegrityError("PerformanceTrial artifact binding failed");
        }
        for (const artifact of Object.values(command.artifacts)) registerArtifact(this.connection, artifact, nowMs);
        this.experiments.insertTrial(command.spec, command.admission, command.epoch, command.attempt, {
          contractId: command.artifacts.contract.artifactId,
          trialSpecId: command.artifacts.trialSpec.artifactId,
          admissionId: command.artifacts.admission.artifactId,
          candidatePatchId: command.artifacts.candidatePatch.artifactId,
        }, nowMs, sequence);
        const receiptId = idFromSha256("RCP", sha256Hex(`PERFORMANCE_TRIAL_AUTHORIZATION\0${command.spec.trial_id}\0${command.artifacts.trialSpec.sha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "PERFORMANCE_TRIAL_AUTHORIZATION", subjectType: "PERFORMANCE_TRIAL",
          subjectId: command.spec.trial_id, attemptId: command.attempt.attemptId, result: "SUCCEEDED",
          inputClosureSha256: command.spec.performance_contract_sha256, outputSha256: command.artifacts.trialSpec.sha256,
          body: { admissionArtifactId: command.artifacts.admission.artifactId, epochId: command.spec.epoch_id, workItemId: command.spec.work_item_id },
          issuer: "PerformanceCoordinator", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(receiptId, command.artifacts.trialSpec.artifactId, "TRIAL_SPEC");
      } else if (command.type === "RECORD_PERFORMANCE_SAMPLES") {
        if (command.spec.goal_id !== goalId || command.sampleSetArtifact.sha256 !== canonicalJsonSha256(command.samples)) {
          throw new AuthorityIntegrityError("Performance sample-set binding failed");
        }
        registerArtifact(this.connection, command.sampleSetArtifact, nowMs);
        this.experiments.insertSamples(command.spec, command.samples, nowMs);
        const receiptId = idFromSha256("RCP", sha256Hex(`PERFORMANCE_SAMPLE_SET\0${command.spec.trial_id}\0${command.sampleSetArtifact.sha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "PERFORMANCE_SAMPLE_SET", subjectType: "PERFORMANCE_TRIAL",
          subjectId: command.spec.trial_id, result: "SUCCEEDED",
          inputClosureSha256: command.spec.protocol_sha256, outputSha256: command.sampleSetArtifact.sha256,
          body: { pairSampleCount: command.samples.length, sampleSetArtifactId: command.sampleSetArtifact.artifactId },
          issuer: "PerformanceCoordinator", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(receiptId, command.sampleSetArtifact.artifactId, "RAW_SAMPLE_SET");
      } else if (command.type === "RECORD_PERFORMANCE_VERDICT") {
        if (command.verdict.trial_id.length === 0
          || command.artifacts.sampleSet.sha256 !== command.verdict.sample_set_sha256
          || command.artifacts.statistics.sha256 !== command.verdict.statistics_sha256
          || command.artifacts.verdict.sha256 !== canonicalJsonSha256(command.verdict)) {
          throw new AuthorityIntegrityError("Performance verdict artifact binding failed");
        }
        for (const artifact of Object.values(command.artifacts)) registerArtifact(this.connection, artifact, nowMs);
        this.experiments.insertVerdict({
          goalId,
          verdict: command.verdict,
          sampleSetArtifactId: command.artifacts.sampleSet.artifactId,
          baselineSetArtifactId: command.artifacts.baselineSet.artifactId,
          candidateSetArtifactId: command.artifacts.candidateSet.artifactId,
          statisticsArtifactId: command.artifacts.statistics.artifactId,
          correctnessReceiptId: command.correctnessReceiptId,
          holdoutReceiptId: command.holdoutReceiptId,
        }, nowMs, sequence);
        const result = command.verdict.verdict === "PROMOTE" ? "SUCCEEDED"
          : command.verdict.verdict === "NEED_MORE_EVIDENCE" ? "BLOCKED" : "FAILED";
        const receiptId = idFromSha256("RCP", sha256Hex(`PERFORMANCE_VERDICT\0${command.verdict.verdict_id}\0${command.artifacts.verdict.sha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "PERFORMANCE_VERDICT", subjectType: "PERFORMANCE_TRIAL",
          subjectId: command.verdict.trial_id, result,
          inputClosureSha256: command.verdict.sample_set_sha256, outputSha256: command.artifacts.verdict.sha256,
          body: { verdict: command.verdict.verdict, verdictId: command.verdict.verdict_id },
          issuer: "Evaluator", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
        this.receipts.linkArtifact(receiptId, command.artifacts.verdict.artifactId, "VERDICT");
      } else if (command.type === "APPEND_MEMORY_CLAIM") {
        this.memories.insertClaim(command.record, goalId, sequence, onFault);
        const receiptId = idFromSha256("RCP", sha256Hex(`MEMORY_CLAIM\0${command.record.claimId}\0${command.record.version}\0${command.record.claimSha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "MEMORY_CLAIM", subjectType: "MEMORY_CLAIM", subjectId: command.record.claimId,
          result: "SUCCEEDED", inputClosureSha256: canonicalJsonSha256({
            attestationSha256: command.record.sourceAttestation.attestationSha256,
            claimId: command.record.claimId, supersedesVersion: command.record.supersedesVersion,
          }), outputSha256: command.record.claimSha256,
          body: {
            channel: command.record.channel, classification: command.record.classification, scope: command.record.scope,
            status: command.record.status, version: command.record.version,
          }, issuer: "MemoryEngine", issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
      } else if (command.type === "APPEND_MEMORY_ACTION") {
        this.memories.insertAction(command.memoryAction, goalId, sequence, onFault);
        const receiptId = idFromSha256("RCP", sha256Hex(`MEMORY_ACTION\0${command.memoryAction.actionId}\0${command.memoryAction.actionSha256}`));
        this.receipts.insert({
          receiptId, goalId, receiptType: "MEMORY_ACTION", subjectType: "MEMORY_ACTION", subjectId: command.memoryAction.actionId,
          result: "SUCCEEDED", inputClosureSha256: canonicalJsonSha256({
            claimId: command.memoryAction.claimId, targetVersion: command.memoryAction.targetVersion,
            predecessorActionId: command.memoryAction.predecessorActionId,
          }), outputSha256: command.memoryAction.actionSha256,
          body: { actionType: command.memoryAction.actionType, claimId: command.memoryAction.claimId },
          issuer: command.memoryAction.actionType === "ENDORSE" || command.memoryAction.actionType === "FORGET"
            ? "USER" : "MemoryEngine",
          issuedAtMs: nowMs, issuedEventSequence: sequence,
        });
      }
          return { workflowAdvance, invalidatedIds };
        },
        event: ({ workflowAdvance, invalidatedIds }) => {
          const eventType: EventType = command.type === "CREATE_GOAL" ? "GOAL_ADMITTED"
        : command.type === "FREEZE_REQUIREMENT" ? "REQUIREMENT_FROZEN"
          : command.type === "FREEZE_PLAN" ? "PLAN_FROZEN"
            : command.type === "AUTHORIZE_STAGE" ? "STAGE_AUTHORIZED"
              : command.type === "COMPLETE_STAGE" ? "STAGE_TRANSITIONED"
                : command.type === "TRANSITION_GOAL" ? "GOAL_TRANSITIONED"
                  : command.type === "INVALIDATE_ROUTE" ? "DEPENDENCY_INVALIDATED"
            : command.type === "REQUEST_DECISION" ? "DECISION_REQUESTED"
              : command.type === "RESOLVE_DECISION" ? "DECISION_RESOLVED"
                : command.type === "PREPARE_EFFECT" ? "EFFECT_PREPARED"
                  : command.type === "RECORD_EFFECT_OUTCOME" ? "EFFECT_RECONCILED"
                    : command.type === "RECORD_ARTIFACT_OBSERVATION" ? "RECEIPT_ATTACHED"
                    : command.type === "RECORD_CACHE_OBSERVATION" ? "RECEIPT_ATTACHED"
                      : command.type === "RECORD_ROUTE_DECISION" ? "ROUTE_DECIDED"
                      : command.type === "CREATE_CHECKPOINT" ? "MILESTONE_CHECKPOINTED"
                        : command.type === "RECORD_PERFORMANCE_EVIDENCE" ? "RECEIPT_ATTACHED"
                          : command.type === "AUTHORIZE_PERFORMANCE_TRIAL" ? "EXPERIMENT_EPOCH_CHANGED"
                            : command.type === "RECORD_PERFORMANCE_SAMPLES" ? "EXPERIMENT_EPOCH_CHANGED"
                              : command.type === "RECORD_PERFORMANCE_VERDICT" ? "EXPERIMENT_EPOCH_CHANGED"
                                : command.type === "APPEND_MEMORY_CLAIM" ? "MEMORY_CLAIMED"
                                  : command.type === "APPEND_MEMORY_ACTION" ? "MEMORY_ACTIONED"
                      : command.eventType;
          if (command.type === "APPEND_EVENT"
            && (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload))) {
            throw new AuthorityIntegrityError("Event payload must be an object");
          }
          const payload = command.type === "CREATE_GOAL"
        ? { classification: command.classification, goalId, intent: command.intent, objective: command.objective.normalize("NFC"), planningDepth: command.planningDepth, requirementProfile: command.requirementProfile, workspaceId: command.workspace.workspaceId }
        : command.type === "FREEZE_REQUIREMENT"
          ? { requirementId: command.requirement.package.requirement_id, payloadSha256: command.requirement.integrity.requirements_payload_sha256, revision: command.requirement.package.revision }
          : command.type === "FREEZE_PLAN"
            ? { planId: command.plan.package.plan_id, payloadSha256: command.plan.integrity.plan_payload_sha256, requirementId: command.plan.package.requirement_id, revision: command.plan.package.revision }
            : command.type === "AUTHORIZE_STAGE"
              ? { planId: command.planId, reasonCode: command.reasonCode, stageId: command.stageId, to: "BUILDING" }
              : command.type === "COMPLETE_STAGE"
                ? {
                  acceptanceReceiptIds: workflowAdvance?.acceptanceReceiptIds ?? [],
                  deliveryReceiptId: workflowAdvance?.deliveryReceiptId ?? null,
                  from: "RUNNING", nextStageId: workflowAdvance?.nextStageId ?? null,
                  planId: command.planId, stageId: command.stageId,
                  stageReceiptId: workflowAdvance?.stageReceiptId ?? null,
                  terminal: workflowAdvance?.terminal ?? false, to: "SUCCEEDED",
                  validationReceiptIds: workflowAdvance?.validationReceiptIds ?? [],
                }
                : command.type === "TRANSITION_GOAL"
                  ? {
                    action: command.action, from: command.fromPhase, fromStatus: command.fromStatus,
                    planId: command.planId, reason: command.reason, stageId: command.stageId,
                    to: command.toPhase, toStatus: command.toStatus,
                  }
                  : command.type === "INVALIDATE_ROUTE"
                    ? {
                      action: command.revisionKind === "REQUIREMENT" ? "revise_requirement" : "replan",
                      causeId: command.causeId, evidenceSha256: command.evidenceSha256,
                      invalidatedIds, planId: command.planId, reason: command.reason,
                      to: command.revisionKind === "REQUIREMENT" ? "SPECIFYING" : "PLANNING",
                    }
            : command.type === "REQUEST_DECISION"
              ? { decisionId: command.decisionId, materiality: command.materiality, recommendedOptionId: command.recommendedOptionId, reversible: command.reversible }
              : command.type === "RESOLVE_DECISION"
                ? { decisionId: command.decisionId, resolutionId: command.resolutionId, resolutionSha256: command.resolutionSha256, selectedOptionId: command.selectedOptionId, source: command.source }
                : command.type === "PREPARE_EFFECT"
                  ? { attemptId: command.attempt.attemptId, effectClass: command.workItem.effectClass, effectId: command.effect.effectId, intentReceiptId: command.effect.intentReceiptId, normalizedPayloadSha256: command.effect.normalizedPayloadSha256, normalizedTargetSha256: command.effect.normalizedTargetSha256, workItemId: command.workItem.workItemId }
                  : command.type === "RECORD_EFFECT_OUTCOME"
                    ? { effectId: command.effectId, outcome: command.outcome, outcomeId: command.outcomeId, outcomeReceiptId: command.outcomeReceiptId, targetReadbackSha256: command.targetReadbackSha256 }
                    : command.type === "RECORD_ARTIFACT_OBSERVATION"
                      ? { artifactId: command.artifact.artifactId, artifactSha256: command.artifact.sha256, observationId: command.observationId, observationType: command.observationType }
                      : command.type === "RECORD_CACHE_OBSERVATION"
                        ? { cacheObservationId: command.observation.record.observation_id, cacheState: command.observation.record.state, epochId: command.epoch.record.epoch_id, promptGenerationId: command.observation.record.prompt_generation_id, promptRequestId: command.observation.record.prompt_request_id }
                      : command.type === "RECORD_ROUTE_DECISION"
                        ? { routeDecisionId: command.decision.routeDecisionId, planHealthStatus: command.decision.planHealthStatus, correctionLevel: command.decision.correctionLevel, triggerSha256: command.decision.triggerSha256, selectedRouteId: command.decision.selectedRouteId }
                      : command.type === "CREATE_CHECKPOINT"
                        ? { checkpointId: command.checkpoint.record.record_id, checkpointSha256: command.checkpoint.record.record_sha256, protectedStateSha256: command.checkpoint.record.protected_state_sha256, reason: command.checkpoint.record.reason, snapshotId: command.checkpoint.snapshotId, memorySnapshotId: command.checkpoint.memorySnapshot?.record_id ?? null, memorySnapshotSha256: command.checkpoint.memorySnapshot?.record_sha256 ?? null }
                        : command.type === "RECORD_PERFORMANCE_EVIDENCE"
                          ? { artifactId: command.artifact.artifactId, evidenceKind: command.evidenceKind, receiptId: command.receiptId, result: command.result, subjectId: command.subjectId }
                          : command.type === "AUTHORIZE_PERFORMANCE_TRIAL"
                            ? { epochId: command.spec.epoch_id, opportunityId: command.spec.opportunity_id, trialId: command.spec.trial_id, trialSpecSha256: command.artifacts.trialSpec.sha256, workItemId: command.spec.work_item_id }
                            : command.type === "RECORD_PERFORMANCE_SAMPLES"
                              ? { sampleCount: command.samples.length, sampleSetSha256: command.sampleSetArtifact.sha256, trialId: command.spec.trial_id }
                              : command.type === "RECORD_PERFORMANCE_VERDICT"
                                ? { trialId: command.verdict.trial_id, verdict: command.verdict.verdict, verdictId: command.verdict.verdict_id, verdictSha256: command.artifacts.verdict.sha256 }
                                 : command.type === "APPEND_MEMORY_CLAIM"
                                   ? { claimId: command.record.claimId, version: command.record.version, claimSha256: command.record.claimSha256, channel: command.record.channel, scope: command.record.scope, status: command.record.status }
                                   : command.type === "APPEND_MEMORY_ACTION"
                                     ? { actionId: command.memoryAction.actionId, claimId: command.memoryAction.claimId, targetVersion: command.memoryAction.targetVersion, actionType: command.memoryAction.actionType, actionSha256: command.memoryAction.actionSha256 }
                       : command.payload;
          return { eventType, payload };
        },
      },
      onFault,
    );
  }

  transactTaskFlow(command: TaskFlowAuthorityCommand, meta: MutationMeta, onFault?: (point: TransactionFaultPoint) => void): CommandResult {
    const goalId = command.goalId;
    const commandSha256 = canonicalJsonSha256(command);
    return this.transactionKernel.execute(
      { goalId, commandSha256, meta },
      {
        mutate: ({ currentVersion, nowMs, sequence }) => {
          let acceptanceLedgerSha256: string | null = null;
          if (command.type === "ADMIT_TASK_FLOW") {
            if (currentVersion !== 0 || this.repository.goalExists(goalId)) throw new VersionConflictError(0, Math.max(1, currentVersion));
            if (!/^[a-f0-9]{64}$/u.test(command.workspace.workspaceHmac)) throw new AuthorityIntegrityError("workspaceHmac must be lowercase SHA-256");
            const objective = command.objective.normalize("NFC").trim();
            if (!objective) throw new AuthorityIntegrityError("Goal objective cannot be empty");
            const classificationIssues = validateIntakeClassificationRecord(command.classification);
            if (classificationIssues.length > 0) throw new AuthorityIntegrityError(`Goal intake classification is invalid: ${classificationIssues.join("; ")}`);
            const compatibilityIssues = validateGoalClassificationCompatibility(command.classification, command.requirementProfile, command.planningDepth);
            if (compatibilityIssues.length > 0) throw new AuthorityIntegrityError(`Goal intake classification is inconsistent: ${compatibilityIssues.join("; ")}`);
            if (!Number.isSafeInteger(command.acceptanceFacetMinimum)
              || command.acceptanceFacetMinimum < 1 || command.acceptanceFacetMinimum > 6) {
              throw new AuthorityIntegrityError("Goal acceptanceFacetMinimum must be an integer from 1 through 6");
            }
            if (command.classification.specificationRoute === "PRD" && command.lane !== "ADAPTIVE_ROUTE") {
              throw new AuthorityIntegrityError("PRD Task Flow admission requires ADAPTIVE_ROUTE");
            }
            this.repository.insertWorkspace({ ...command.workspace, createdAtMs: nowMs });
            this.repository.insertGoal({
              goalId, workspaceId: command.workspace.workspaceId, originSessionId: command.originSessionId,
              objective, objectiveSha256: sha256Hex(objective), intent: command.intent === "PLAN" ? "PLAN_ONLY" : "BUILD",
              requirementProfile: command.requirementProfile, planningDepth: command.planningDepth, createdAtMs: nowMs,
            });
            this.taskFlow.activateGoal({
              goalId, intent: command.intent, lane: command.lane, sourceIntakeSha256: command.sourceIntakeSha256,
              activationSha256: command.activationSha256, nowMs,
            });
            const sourceText = command.sourceText?.normalize("NFC") ?? objective;
            if (!sourceText || sourceText.length > 131_072) throw new AuthorityIntegrityError("Task Flow source intake text is invalid");
            if (command.sourceText !== undefined && sha256Hex(sourceText) !== command.sourceIntakeSha256) {
              throw new AuthorityIntegrityError("Task Flow source intake bytes do not match sourceIntakeSha256");
            }
            this.taskFlow.insertIntakeEvidence({
              goalId, sourceIntakeSha256: command.sourceIntakeSha256, sourceText,
              fidelity: command.sourceText === undefined ? "LEGACY_HASH_ONLY" : "EXACT", eventSequence: sequence,
            });
          } else {
            if (!meta.lease || meta.lease.goalId !== goalId) throw new AuthorityIntegrityError(`${command.type} requires the current Goal lease`);
            this.leases.assertCurrent(meta.lease, nowMs);
            this.taskFlow.assertMutableGoal(goalId);
            if (command.type === "SUBMIT_GOAL_CONTRACT") {
              const intake = this.taskFlow.intakeEvidence(goalId);
              const acceptanceLedger = buildAcceptanceLedger({
                source: intake.sourceText, sourceFidelity: intake.fidelity, contract: command.contract,
              });
              this.taskFlow.insertContract(command.contract, acceptanceLedger, sequence);
              acceptanceLedgerSha256 = acceptanceLedger.record_sha256;
            } else if (command.type === "OPEN_GOAL_CONTRACT_REVISION") {
              if (!/^[a-f0-9]{64}$/u.test(command.reasonSha256)) throw new AuthorityIntegrityError("Contract revision reason hash is invalid");
              this.taskFlow.openContractRevision(goalId, sequence, nowMs);
            } else if (command.type === "SUBMIT_ROUTE_SKELETON") this.taskFlow.insertRoute(command.route, command.contract, sequence);
            else if (command.type === "RECORD_WORKSPACE_BASELINE") this.taskFlow.insertBaseline(command.baseline, sequence);
            else if (command.type === "AUTHORIZE_WORK_CELL") {
              if (command.authorization.lease_generation !== meta.lease.generation || command.authorization.fencing_token !== meta.lease.fencingToken) throw new AuthorityIntegrityError("ExecutionAuthorization fencing differs from the current lease");
              this.taskFlow.authorize(command.authorization, sequence);
            } else if (command.type === "PREPARE_OPERATION" || command.type === "PREPARE_AND_DISPATCH_OPERATION") {
              this.taskFlow.insertOperation(command.attempt, command.prepared, command.reconcileLocator, sequence, {
                leaseGeneration: meta.lease.generation,
                fencingToken: meta.lease.fencingToken,
                nowMs,
              }, command.type === "PREPARE_AND_DISPATCH_OPERATION" ? command.dispatched : null);
            } else if (command.type === "TRANSITION_OPERATION") {
              this.taskFlow.assertOperationAuthorizationCurrent(command.transition.attempt_id, goalId, {
                leaseGeneration: meta.lease.generation,
                fencingToken: meta.lease.fencingToken,
                nowMs,
              });
              this.taskFlow.insertOperationTransition(command.transition, sequence);
            }
            else if (command.type === "ATTEST_EVIDENCE") this.taskFlow.insertEvidence(command.attestation, sequence);
            else if (command.type === "RECORD_TASK_FLOW_HEALTH") this.taskFlow.insertRouteHealth(command.health, sequence);
            else if (command.type === "RECORD_TASK_DECISION") this.taskFlow.insertDecision(command.decision, sequence);
            else if (command.type === "CONTROL_TASK_FLOW") this.taskFlow.controlGoal(command.action, command.decision, sequence, nowMs);
            else if (command.type === "RECONCILE_OPERATION") this.taskFlow.settleReconciliation(command.transition, command.disposition, sequence, nowMs);
            else if (command.type === "RESOLVE_PLAN_CONTINUATION") this.taskFlow.resolvePlanContinuation({
              goalId, decision: command.decision, choice: command.choice, eventSequence: sequence, nowMs,
            });
            else if (command.type === "COMPLETE_WORK_CELL") this.taskFlow.completeWorkCell(goalId, command.workCellId, command.completionSummarySha256, sequence, nowMs);
            else if (command.type === "CLOSE_TASK_FLOW_GOAL") this.taskFlow.insertDeliverable(command.deliverable, sequence);
          }
          return acceptanceLedgerSha256;
        },
        event: (acceptanceLedgerSha256) => {
          const eventType: EventType = command.type === "ADMIT_TASK_FLOW" ? "GOAL_ADMITTED"
        : command.type === "SUBMIT_GOAL_CONTRACT" ? "GOAL_CONTRACT_FROZEN"
          : command.type === "OPEN_GOAL_CONTRACT_REVISION" ? "CONTRACT_REVISION_OPENED"
          : command.type === "SUBMIT_ROUTE_SKELETON" ? "ROUTE_SKELETON_FROZEN"
            : command.type === "RECORD_WORKSPACE_BASELINE" ? "WORKSPACE_BASELINE_RECORDED"
              : command.type === "AUTHORIZE_WORK_CELL" ? "WORK_CELL_AUTHORIZED"
                : command.type === "PREPARE_OPERATION" ? "OPERATION_PREPARED"
                  : command.type === "PREPARE_AND_DISPATCH_OPERATION" ? "OPERATION_TRANSITIONED"
                  : command.type === "TRANSITION_OPERATION" ? "OPERATION_TRANSITIONED"
                    : command.type === "ATTEST_EVIDENCE" ? "EVIDENCE_ATTESTED"
                      : command.type === "RECORD_TASK_FLOW_HEALTH" ? "ROUTE_HEALTH_EVALUATED"
                        : command.type === "RECORD_TASK_DECISION" ? command.decision.state === "RESOLVED" ? "DECISION_RESOLVED" : "DECISION_REQUESTED"
                          : command.type === "CONTROL_TASK_FLOW" ? "GOAL_TRANSITIONED"
                            : command.type === "RECONCILE_OPERATION" ? "OPERATION_TRANSITIONED"
                        : command.type === "RESOLVE_PLAN_CONTINUATION" ? "PLAN_CONTINUATION_RESOLVED"
                          : command.type === "COMPLETE_WORK_CELL" ? "WORK_CELL_TRANSITIONED" : "DELIVERABLE_CLOSED";
          const payload = command.type === "ADMIT_TASK_FLOW" ? {
        goalId, intent: command.intent, lane: command.lane,
        specificationRoute: command.classification.specificationRoute,
        requirementProfile: command.requirementProfile, planningDepth: command.planningDepth,
        acceptanceFacetMinimum: command.acceptanceFacetMinimum,
        sourceIntakeSha256: command.sourceIntakeSha256,
      }
        : command.type === "SUBMIT_GOAL_CONTRACT" ? {
          contractId: command.contract.contract_id, contractSha256: command.contract.record_sha256,
          acceptanceLedgerSha256,
          version: command.contract.version,
        }
          : command.type === "OPEN_GOAL_CONTRACT_REVISION" ? { revisionKind: command.revisionKind, reasonSha256: command.reasonSha256 }
          : command.type === "SUBMIT_ROUTE_SKELETON" ? { routeId: command.route.route_id, routeSha256: command.route.record_sha256, revision: command.route.revision }
            : command.type === "RECORD_WORKSPACE_BASELINE" ? { baselineId: command.baseline.baseline_id, baselineSha256: command.baseline.record_sha256 }
              : command.type === "AUTHORIZE_WORK_CELL" ? { authorizationId: command.authorization.authorization_id, workCellId: command.authorization.work_cell_id }
                : command.type === "PREPARE_OPERATION" ? { attemptId: command.attempt.attempt_id, operationId: command.attempt.operation_id, transitionSha256: command.prepared.transition_sha256 }
                  : command.type === "PREPARE_AND_DISPATCH_OPERATION" ? {
                    attemptId: command.attempt.attempt_id,
                    operationId: command.attempt.operation_id,
                    state: command.dispatched.state,
                    preparedTransitionSha256: command.prepared.transition_sha256,
                    transitionSha256: command.dispatched.transition_sha256,
                  }
                  : command.type === "TRANSITION_OPERATION" ? { attemptId: command.transition.attempt_id, state: command.transition.state, transitionSha256: command.transition.transition_sha256 }
                    : command.type === "ATTEST_EVIDENCE" ? { attestationId: command.attestation.attestation_id, result: command.attestation.result, workCellId: command.attestation.work_cell_id }
                      : command.type === "RECORD_TASK_FLOW_HEALTH" ? { healthId: command.health.health_id, level: command.health.level, reasonCode: command.health.reason_code }
                        : command.type === "RECORD_TASK_DECISION" ? { decisionEntryId: command.decision.decision_entry_id, state: command.decision.state, decisionKey: command.decision.decision_key }
                          : command.type === "CONTROL_TASK_FLOW" ? { action: command.action, decisionEntryId: command.decision.decision_entry_id }
                            : command.type === "RECONCILE_OPERATION" ? { attemptId: command.transition.attempt_id, state: command.transition.state, disposition: command.disposition }
                        : command.type === "RESOLVE_PLAN_CONTINUATION" ? { choice: command.choice, decisionEntryId: command.decision.decision_entry_id }
                          : command.type === "COMPLETE_WORK_CELL" ? { completionSummarySha256: command.completionSummarySha256, workCellId: command.workCellId }
                          : { deliverableId: command.deliverable.deliverable_id, result: command.deliverable.result };
          return { eventType, payload };
        },
      },
      onFault,
    );
  }

  transactHarness(command: HarnessAuthorityCommand, meta: MutationMeta, onFault?: (point: TransactionFaultPoint) => void): CommandResult {
    const goalId = command.goalId;
    const commandSha256 = canonicalJsonSha256(command);
    return this.transactionKernel.execute(
      { goalId, commandSha256, meta },
      {
        beforeMutation: ({ nowMs }) => {
          if (!meta.lease || meta.lease.goalId !== goalId) {
            throw new AuthorityIntegrityError(`${command.type} requires the current Goal lease`);
          }
          this.leases.assertCurrent(meta.lease, nowMs);
        },
        mutate: ({ sequence, nowMs }) => {
          if (command.type === "CREATE_MANAGED_RUN") this.harness.createRun(command.run, command.topology, sequence);
          else if (command.type === "REVISE_HARNESS_TOPOLOGY") this.harness.reviseTopology(command.topology, sequence);
          else if (command.type === "DEFINE_WORK_SHARDS") this.harness.defineShards(command.runId, goalId, command.workCellId, command.shards, sequence);
          else if (command.type === "LEASE_WORK_SHARD") this.harness.leaseShard(command.packet, command.subject, command.lease, sequence, nowMs);
          else if (command.type === "START_WORKER_RUN") this.harness.startWorker(command.worker, command.subject, command.transition, sequence, nowMs);
          else if (command.type === "TRANSITION_WORKER_RUN") this.harness.transitionWorker(command.transition, sequence, nowMs);
          else if (command.type === "RECOVER_WORKER_RUN") this.harness.recoverWorker(command.transition, sequence, nowMs);
          else if (command.type === "REQUEUE_WORK_SHARD") this.harness.requeueShard(command.runId, goalId, command.shardId, command.reasonSha256, command.routeDecisionSha256, sequence);
          else if (command.type === "SUBMIT_WORKER_RESULT") this.harness.submitWorkerResult(command.result, command.transition, command.patchSet, command.artifacts, sequence, nowMs);
          else if (command.type === "PREPARE_PATCH_TRANSACTION") this.harness.preparePatchTransaction({
            goalId, runId: command.runId, shardId: command.shardId, patchSetId: command.patchSetId,
            journalSha256: command.journalSha256, journalArtifact: command.journalArtifact,
            preimageArtifacts: command.preimageArtifacts,
          }, sequence, nowMs);
          else if (command.type === "RECORD_HARNESS_INTEGRATION") this.harness.recordIntegration(command.receipt, sequence);
          else if (command.type === "TRANSITION_SINGLE_SHARD") this.harness.transitionSingle(command.runId, goalId, command.shardId, command.action, command.resultSha256, sequence, nowMs);
          else if (command.type === "CONTROL_MANAGED_RUN") this.harness.controlRun(command.runId, goalId, command.action, command.reasonSha256, sequence, nowMs);
          else if (command.type === "BIND_MEMORY_VISIBILITY") this.harness.bindMemory(command.runId, goalId, command.binding, sequence);
        },
        event: () => {
          const eventType: EventType = command.type === "CREATE_MANAGED_RUN" ? "MANAGED_RUN_CREATED"
            : command.type === "REVISE_HARNESS_TOPOLOGY" ? "HARNESS_TOPOLOGY_REVISED"
              : command.type === "DEFINE_WORK_SHARDS" ? "WORK_SHARDS_DEFINED"
                : command.type === "LEASE_WORK_SHARD" ? "WORK_SHARD_LEASED"
                  : command.type === "START_WORKER_RUN" ? "WORKER_RUN_STARTED"
                    : command.type === "TRANSITION_WORKER_RUN" || command.type === "RECOVER_WORKER_RUN" ? "WORKER_RUN_TRANSITIONED"
                      : command.type === "REQUEUE_WORK_SHARD" ? "WORK_SHARD_REQUEUED"
                        : command.type === "SUBMIT_WORKER_RESULT" ? "WORKER_RESULT_SUBMITTED"
                          : command.type === "PREPARE_PATCH_TRANSACTION" ? "PATCH_TRANSACTION_PREPARED"
                            : command.type === "RECORD_HARNESS_INTEGRATION" ? "HARNESS_INTEGRATION_RECORDED"
                              : command.type === "TRANSITION_SINGLE_SHARD" ? "SINGLE_SHARD_TRANSITIONED"
                                : command.type === "CONTROL_MANAGED_RUN" ? "MANAGED_RUN_CONTROLLED" : "MEMORY_VISIBILITY_BOUND";
          const payload: Readonly<Record<string, unknown>> = command.type === "CREATE_MANAGED_RUN"
            ? { runId: command.run.run_id, topology: command.topology.effective_topology, topologyRevision: command.topology.revision }
            : command.type === "REVISE_HARNESS_TOPOLOGY"
              ? { runId: command.topology.run_id, topology: command.topology.effective_topology, topologyRevision: command.topology.revision }
              : command.type === "DEFINE_WORK_SHARDS"
                ? { runId: command.runId, workCellId: command.workCellId, shardIds: command.shards.map((shard) => shard.shard_id) }
                : command.type === "LEASE_WORK_SHARD"
                  ? { runId: command.packet.run_id, shardId: command.packet.shard_id, packetId: command.packet.packet_id, attempt: command.packet.attempt, leaseGeneration: command.lease.generation }
                  : command.type === "START_WORKER_RUN"
                    ? { runId: command.worker.run_id, shardId: command.worker.shard_id, workerRunId: command.worker.worker_run_id, role: command.worker.role }
                    : command.type === "TRANSITION_WORKER_RUN" || command.type === "RECOVER_WORKER_RUN"
                      ? { workerRunId: command.transition.worker_run_id, state: command.transition.state, ordinal: command.transition.ordinal }
                      : command.type === "REQUEUE_WORK_SHARD"
                        ? { runId: command.runId, shardId: command.shardId, routeDecisionSha256: command.routeDecisionSha256 }
                        : command.type === "SUBMIT_WORKER_RESULT"
                          ? { runId: command.result.run_id, shardId: command.result.shard_id, workerRunId: command.result.worker_run_id, resultKind: command.result.result_kind }
                          : command.type === "PREPARE_PATCH_TRANSACTION"
                            ? { runId: command.runId, shardId: command.shardId, patchSetId: command.patchSetId, journalSha256: command.journalSha256 }
                            : command.type === "RECORD_HARNESS_INTEGRATION"
                              ? { runId: command.receipt.run_id, shardId: command.receipt.shard_id, result: command.receipt.result, receiptSha256: command.receipt.receipt_sha256 }
                              : command.type === "TRANSITION_SINGLE_SHARD"
                                ? { runId: command.runId, shardId: command.shardId, action: command.action, resultSha256: command.resultSha256 }
                                : command.type === "CONTROL_MANAGED_RUN"
                                  ? { runId: command.runId, action: command.action, reasonSha256: command.reasonSha256 }
                                  : { runId: command.runId, claimId: command.binding.claim_id, claimVersion: command.binding.claim_version, audience: command.binding.audience };
          return { eventType, payload };
        },
      },
      onFault,
    );
  }

  transactTaskFlowHarness(
    taskFlowCommand: Extract<TaskFlowAuthorityCommand, { readonly type: "CONTROL_TASK_FLOW" | "RESOLVE_PLAN_CONTINUATION" }>,
    harnessCommand: Extract<HarnessAuthorityCommand, { readonly type: "CONTROL_MANAGED_RUN" }>,
    meta: MutationMeta,
  ): CommandResult {
    if (taskFlowCommand.goalId !== harnessCommand.goalId) {
      throw new AuthorityIntegrityError("Task Flow and ManagedRun transaction Goal binding differs");
    }
    return runImmediateTransaction(this.connection, () => {
      const taskFlow = this.transactTaskFlow(taskFlowCommand, {
        ...meta, idempotencyKey: `${meta.idempotencyKey}:task-flow`,
      });
      return this.transactHarness(harnessCommand, {
        ...meta, expectedVersion: taskFlow.goalVersion,
        idempotencyKey: `${meta.idempotencyKey}:managed-run`,
      });
    });
  }

  readSnapshot(goalId: string): GoalSnapshot {
    return rebuildGoalSnapshot(this.connection, goalId);
  }

  readGoalForSession(workspaceId: string, originSessionId: string): GoalRow | null {
    return this.repository.goalForSession(workspaceId, originSessionId);
  }

  readEffectOutcome(effectId: string): StoredEffectOutcome | null {
    return this.effects.terminalOutcome(effectId);
  }

  readLatestCheckpoint(goalId: string): CheckpointInsert | null {
    return this.checkpoints.latest(goalId);
  }

  readCheckpointAtVersion(goalId: string, goalVersion: number): CheckpointInsert | null {
    return this.checkpoints.atVersion(goalId, goalVersion);
  }

  readMemoryCheckpointSnapshot(checkpointId: string): MemoryCheckpointSnapshotRecord | null {
    return this.checkpoints.memorySnapshot(checkpointId);
  }

  recordMemoryCaptureDecision(
    decision: MemoryCaptureDecision,
    idempotencyKey: string,
    onFault?: (point: MemoryCaptureFaultPoint) => void,
  ): MemoryCaptureCommandResult {
    return runImmediateTransaction(this.connection, () => this.memoriesV3.appendCaptureDecision(
      decision, idempotencyKey, this.clock.now(), onFault,
    ));
  }

  beginMemoryV31Capture(
    decision: MemoryCaptureDecision,
    idempotencyKey: string,
    limits?: MemoryCaptureV31Limits,
    onFault?: (point: MemoryCaptureFaultPoint) => void,
  ): MemoryCaptureV31IntentResult {
    return runImmediateTransaction(this.connection, () => {
      const capture = this.memoriesV3.appendCaptureDecision(decision, idempotencyKey, this.clock.now(), onFault);
      return this.memoryCaptureV31.begin(decision, capture, idempotencyKey, this.clock.now(), limits);
    });
  }

  markMemoryV31CaptureVaultPrepared(intentId: string, prepared: MemoryCaptureV31VaultInput): void {
    runImmediateTransaction(this.connection, () => this.memoryCaptureV31.markVaultPrepared(intentId, prepared, this.clock.now()));
  }

  commitMemoryV31Observation(
    intentId: string,
    prepared: MemoryCaptureV31VaultInput,
    limits?: MemoryCaptureV31Limits,
  ): MemoryCaptureV31CommitResult {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.commitObservation(
      intentId, prepared, this.clock.now(), limits,
    ));
  }

  commitMemoryV31Claim(intentId: string, claimId: string, result: "ACTIVE" | "PROPOSED"): MemoryCaptureV31CommitResult {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.commitClaim(
      intentId, claimId, result, this.clock.now(),
    ));
  }

  abortMemoryV31Capture(intentId: string, reasonCode: string): MemoryCaptureV31ReceiptRecord {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.abort(intentId, reasonCode, this.clock.now()));
  }

  registerMemoryV31Proposal(
    workspaceId: string,
    conceptSha256: string,
    claimId: string,
    sourceIntentId: string,
    evidenceManifestSha256: string,
    limits?: MemoryCaptureV31Limits,
  ): MemoryProposalV31Record | null {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.registerProposal(
      workspaceId, conceptSha256, claimId, sourceIntentId, evidenceManifestSha256, this.clock.now(), limits,
    ));
  }

  linkMemoryV31ActiveClaim(workspaceId: string, conceptSha256: string, claimId: string): void {
    runImmediateTransaction(this.connection, () => this.memoryCaptureV31.linkActiveClaim(workspaceId, conceptSha256, claimId));
  }

  resolveMemoryV31Proposal(
    proposalId: string,
    result: "APPROVED" | "REJECTED" | "EXPIRED" | "PURGED",
    actionId: string | null,
  ): void {
    runImmediateTransaction(this.connection, () => this.memoryCaptureV31.resolveProposal(
      proposalId, result, actionId, this.clock.now(),
    ));
  }

  retireExpiredMemoryV31Observations(workspaceId: string, limit = 128): MemoryObservationV31Record[] {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.retireExpiredObservations(
      workspaceId, this.clock.now(), limit,
    ));
  }

  retireMemoryV31ConceptObservations(
    workspaceId: string,
    conceptSha256: string,
    reason: "QUOTA" | "USER_REJECTED" | "PURGED",
    limit = 512,
  ): MemoryObservationV31Record[] {
    return runImmediateTransaction(this.connection, () => this.memoryCaptureV31.retireConceptObservations(
      workspaceId, conceptSha256, reason, this.clock.now(), limit,
    ));
  }

  readMemoryV31EligibleClusters(workspaceId: string, limits?: MemoryCaptureV31Limits): MemoryCandidateClusterV31Record[] {
    return this.memoryCaptureV31.eligibleClusters(workspaceId, limits);
  }

  readLatestMemoryV31Observation(workspaceId: string, conceptSha256: string): MemoryObservationV31Record | null {
    return this.memoryCaptureV31.latestActiveObservation(workspaceId, conceptSha256, this.clock.now());
  }

  readActiveMemoryV31Observations(workspaceId: string, conceptSha256: string, limit = 512): MemoryObservationV31Record[] {
    return this.memoryCaptureV31.activeObservations(workspaceId, conceptSha256, this.clock.now(), limit);
  }

  readMemoryV31ActiveProposals(
    workspaceId: string,
    limit: number,
    afterProposalId: string | null = null,
  ): MemoryProposalV31Record[] {
    return this.memoryCaptureV31.activeProposals(workspaceId, this.clock.now(), limit, afterProposalId);
  }

  readExpiredMemoryV31Proposals(workspaceId: string, limit = 128): MemoryProposalV31Record[] {
    return this.memoryCaptureV31.expiredProposals(workspaceId, this.clock.now(), limit);
  }

  readMemoryV31ProposalForClaim(claimId: string): MemoryProposalV31Record | null {
    return this.memoryCaptureV31.proposalForClaim(claimId);
  }

  readMemoryV31ClusterForClaim(workspaceId: string, claimId: string): MemoryCandidateClusterV31Record | null {
    return this.memoryCaptureV31.clusterForClaim(workspaceId, claimId);
  }

  readPendingMemoryV31CaptureIntents(workspaceId: string, limit = 100): MemoryCaptureV31IntentRecord[] {
    return this.memoryCaptureV31.pendingIntents(workspaceId, limit);
  }

  readMemoryV31PreparedVault(intentId: string): MemoryCaptureV31PreparedRecord | null {
    return this.memoryCaptureV31.preparedVault(intentId);
  }

  readMemoryV31StoredClaimForIntent(intentId: string): { readonly claimId: string; readonly status: "PROPOSED" | "ACTIVE" } | null {
    return this.memoryCaptureV31.storedClaimForIntent(intentId);
  }

  readMemoryV31CaptureReceipt(intentId: string): MemoryCaptureV31ReceiptRecord | null {
    return this.memoryCaptureV31.receipt(intentId);
  }

  readMemoryV31CaptureIntent(intentId: string): MemoryCaptureV31IntentRecord | null {
    return this.memoryCaptureV31.intent(intentId);
  }

  readMemoryV31Observation(observationId: string): MemoryObservationV31Record | null {
    return this.memoryCaptureV31.observation(observationId);
  }

  readMemoryV31VaultReferences(workspaceId: string): {
    readonly vaultRefSha256: ReadonlySet<string>;
    readonly keyRefSha256: ReadonlySet<string>;
  } {
    return this.memoryCaptureV31.vaultReferences(workspaceId);
  }

  recordMemoryV3Claim(
    input: MemoryV3StoreClaimInput,
    idempotencyKey: string,
    onFault?: (point: MemoryV3MutationFaultPoint) => void,
  ): MemoryV3ClaimCommandResult {
    return runImmediateTransaction(this.connection, () => this.memoriesV3.appendClaim(
      input, idempotencyKey, this.clock.now(), onFault,
    ));
  }

  recordMemoryV3Action(
    input: MemoryV3ActionInput,
    idempotencyKey: string,
    onFault?: (point: MemoryV3MutationFaultPoint) => void,
  ): MemoryV3ActionCommandResult {
    return runImmediateTransaction(this.connection, () => this.memoriesV3.appendAction(
      input, idempotencyKey, this.clock.now(), onFault,
    ));
  }

  prepareMemoryV3PurgeIntent(input: MemoryV3PurgeIntentInput, idempotencyKey: string): MemoryV3PurgeIntentResult {
    return runImmediateTransaction(this.connection, () => this.memoriesV3.preparePurgeIntent(
      input, idempotencyKey, this.clock.now(),
    ));
  }

  readPendingMemoryV3PurgeIntents(workspaceId: string, limit = 100): MemoryV3PurgeIntentRecord[] {
    return this.memoriesV3.pendingPurgeIntents(workspaceId, limit);
  }

  readMemoryV3Claim(claimId: string, version?: number): MemoryV3ClaimRecord | null {
    return this.memoriesV3.claim(claimId, version);
  }

  readMemoryV3ClaimHead(claimId: string): MemoryV3ClaimHeadRecord | null {
    return this.memoriesV3.claimHead(claimId);
  }

  readMemoryV3ClaimVersions(claimId: string): MemoryV3ClaimRecord[] {
    return this.memoriesV3.claimVersions(claimId);
  }

  readMemoryV3CandidateHeads(workspaceId: string, goalId: string | null, limit: number): MemoryV3ClaimHeadRecord[] {
    return this.memoriesV3.candidateHeads(workspaceId, goalId, limit);
  }

  readMemoryV3MatchingHeads(
    workspaceId: string,
    goalId: string | null,
    channel: MemoryCandidateRank["channel"],
    termHmacs: readonly string[],
    includeUnmatched: boolean,
    limit: number,
  ): MemoryV3CandidateHeadMatch[] {
    return this.memoriesV3.matchingHeads(workspaceId, goalId, channel, termHmacs, includeUnmatched, limit);
  }

  readMemoryV3SemanticPolicyHeads(
    workspaceId: string,
    goalId: string | null,
    scope: MemoryV3ClaimHeadRecord["scope"],
    semanticTermHmac: string,
    limit: number,
  ): { readonly matches: readonly MemoryV3ClaimHeadRecord[]; readonly total: number } {
    return this.memoriesV3.semanticPolicyHeads(workspaceId, goalId, scope, semanticTermHmac, limit);
  }

  readMemoryV3WorkspaceHeads(
    workspaceId: string,
    beforeStreamSequence: number | null,
    limit: number,
  ): MemoryV3ClaimHeadRecord[] {
    return this.memoriesV3.workspaceHeads(workspaceId, beforeStreamSequence, limit);
  }

  readMemoryV3WorkspaceStatus(workspaceId: string): MemoryV3WorkspaceStatus {
    return this.memoriesV3.workspaceStatus(workspaceId);
  }

  readMemoryV3VaultReferences(workspaceId: string): {
    readonly vaultRefSha256: ReadonlySet<string>;
    readonly keyRefSha256: ReadonlySet<string>;
  } {
    return this.memoriesV3.vaultReferences(workspaceId);
  }

  readMemoryV3Events(workspaceId: string, limit = 100): MemoryV3CaptureEvent[] {
    return this.memoriesV3.events(workspaceId, limit);
  }

  readMemoryV3StreamHead(workspaceId: string): { readonly streamSequence: number; readonly lastEventSha256: string } | null {
    return this.memoriesV3.streamHead(workspaceId);
  }

  verifyMemoryV3Integrity(): void {
    this.memoriesV3.verifyIntegrity();
  }

  inputContextAvailable(): boolean {
    return this.inputContext.available();
  }

  verifyInputContextIntegrity(): InputContextIntegritySummary {
    return this.inputContext.verifyIntegrity();
  }

  insertInputContextReadEvidence(receipt: ReadEvidenceReceiptRecord) {
    return this.inputContext.insertReadEvidenceReceipt(receipt);
  }

  insertReadEvidenceReceipt(receipt: ReadEvidenceReceiptRecord) {
    return this.inputContext.insertReadEvidenceReceipt(receipt);
  }

  readInputContextEvidence(receiptId: string): ReadEvidenceReceiptRecord | null {
    return this.inputContext.readEvidenceReceipt(receiptId);
  }

  readEvidenceReceipt(receiptId: string): ReadEvidenceReceiptRecord | null {
    return this.inputContext.readEvidenceReceipt(receiptId);
  }

  appendInputContextValidity(transition: EvidenceValidityTransitionRecord) {
    return this.inputContext.appendEvidenceValidityTransition(transition);
  }

  appendEvidenceValidityTransition(transition: EvidenceValidityTransitionRecord) {
    return this.inputContext.appendEvidenceValidityTransition(transition);
  }

  readInputContextValidity(receiptId: string): EvidenceValidityTransitionRecord[] {
    return this.inputContext.readEvidenceValidityTransitions(receiptId);
  }

  readEvidenceValidityTransitions(receiptId: string): EvidenceValidityTransitionRecord[] {
    return this.inputContext.readEvidenceValidityTransitions(receiptId);
  }

  storeInputContextWorkingSet(
    workingSet: ContextWorkingSetRecord,
    envelope: ContextEnvelopeRecord,
  ): { readonly reused: boolean; readonly record: WorkingSetEnvelopeRecord } {
    return this.inputContext.storeWorkingSetEnvelope(workingSet, envelope);
  }

  insertInputContextCompileReceipt(receipt: ContextCompileReceiptRecord) {
    return this.inputContext.insertCompileReceipt(receipt);
  }

  insertInputContextRetentionRoot(root: ContextRetentionRootRecord) {
    return this.inputContext.insertRetentionRoot(root);
  }

  insertInputContextToolSurfacePlan(plan: ToolSurfacePlanRecord) {
    return this.inputContext.insertToolSurfacePlan(plan);
  }

  insertInputContextLayoutManifest(manifest: ContextLayoutManifestRecord) {
    return this.inputContext.insertLayoutManifest(manifest);
  }

  appendInputContextProjection(receipt: ContextProjectionReceiptRecord) {
    return this.inputContext.appendProjectionTransition(receipt);
  }

  latestInputContextProjection(projectionId: string): ContextProjectionReceiptRecord | null {
    return this.inputContext.latestProjection(projectionId);
  }

  insertProviderTurnLedger(ledger: ProviderTurnLedgerRecord) {
    return this.inputContext.insertProviderTurnLedger(ledger);
  }

  insertProviderTurnRequest(request: ProviderTurnRequestRecord) {
    return this.inputContext.insertProviderTurnRequest(request);
  }

  readLatestProviderTurnRequest(promptGenerationId: string): ProviderTurnRequestRecord | null {
    return this.inputContext.readLatestProviderTurnRequest(promptGenerationId);
  }

  readProviderTurnLedger(promptRequestId: string): ProviderTurnLedgerRecord | null {
    return this.inputContext.readProviderTurnLedger(promptRequestId);
  }

  appendProviderTurnAttempt(attempt: ProviderTurnAttemptRecord) {
    return this.inputContext.appendProviderTurnAttempt(attempt);
  }

  beginProviderTurn(request: ProviderTurnRequestRecord, started: ProviderTurnAttemptRecord) {
    return this.inputContext.beginProviderTurn(request, started);
  }

  readProviderTurnAttempts(promptRequestId: string, limit?: number): ProviderTurnAttemptRecord[] {
    return this.inputContext.readProviderTurnAttempts(promptRequestId, limit);
  }

  readPendingProviderTurns(limit?: number) {
    return this.inputContext.readPendingProviderTurns(limit);
  }

  completeProviderTurn(ledger: ProviderTurnLedgerRecord, terminal: ProviderTurnAttemptRecord) {
    return this.inputContext.completeProviderTurn(ledger, terminal);
  }

  insertTargetPerformanceMeasurements(records: readonly TargetPerformanceMeasurementRecord[]): void {
    this.targetPerformance.insertMeasurements(records);
  }

  readTargetPerformanceMeasurements(goalId: string, phase: TargetPerformancePhase): TargetPerformanceMeasurementRecord[] {
    return this.targetPerformance.measurements(goalId, phase);
  }

  insertTargetPerformanceVerdict(verdict: TargetPerformanceVerdictRecord): void {
    this.targetPerformance.insertVerdict(verdict);
  }

  insertProjectSourceManifest(manifest: ProjectSourceManifestRecord) {
    return this.inputContext.insertProjectSourceManifest(manifest);
  }

  insertProjectKnowledgeClaim(claim: ProjectKnowledgeClaimRecord) {
    return this.inputContext.insertProjectKnowledgeClaim(claim);
  }

  verifyTaskFlowIntegrity(): TaskFlowIntegritySummary {
    return this.taskFlow.verifyIntegrity();
  }

  verifyHarnessIntegrity(): HarnessIntegritySummary {
    return this.harness.verifyIntegrity();
  }

  readHarnessView(goalId: string): HarnessCurrentView | null {
    return this.harness.currentView(goalId);
  }

  readActiveHarnessRunForWorkspace(workspaceId: string) {
    return this.harness.activeRunForWorkspace(workspaceId);
  }

  readHarnessShard(goalId: string, shardId: string): HarnessShardExecutionView | null {
    return this.harness.shardExecutionView(goalId, shardId);
  }

  readHarnessWorkerRecovery(goalId: string, workerRunId: string) {
    return this.harness.workerRecoveryView(goalId, workerRunId);
  }

  readOpenPatchTransactions(goalId: string) {
    return this.harness.openPatchTransactions(goalId);
  }

  prepareHarnessCompaction(
    attempt: HarnessCompactionAttempt,
    prepared: HarnessCompactionTransition,
    piOwned: HarnessCompactionTransition,
    lease: LeaseToken,
  ): HarnessCompactionHead {
    if (lease.goalId !== attempt.goal_id) throw new AuthorityIntegrityError("Compaction lease belongs to another Goal");
    this.leases.assertCurrent(lease, this.clock.now());
    return this.harnessCompaction.prepare(attempt, prepared, piOwned);
  }

  transitionHarnessCompaction(value: HarnessCompactionTransition, lease: LeaseToken): HarnessCompactionHead {
    const current = this.harnessCompaction.byId(value.attempt_id);
    if (!current || lease.goalId !== current.attempt.goal_id) throw new AuthorityIntegrityError("Compaction transition lease is invalid");
    this.leases.assertCurrent(lease, this.clock.now());
    return this.harnessCompaction.transition(value);
  }

  readOpenHarnessCompaction(runId: string): HarnessCompactionHead | null {
    return this.harnessCompaction.openForRun(runId);
  }

  prepareCacheV2(partition: CacheSecurityPartitionV2, family: StablePrefixFamilyV2, request: CacheLogicalRequestPrepareV2): CacheLogicalRequestV2 {
    return this.cacheV2.prepare(partition, family, request);
  }
  settleCacheV2(value: CacheRequestAttributionV2): void { this.cacheV2.settle(value); }
  pendingCacheV2Requests(runId: string): number { return this.cacheV2.pending(runId); }
  reconcilePendingCacheV2(runId: string, now: number): number { return this.cacheV2.reconcilePending(runId, now); }
  cacheV2Summary(runId: string) { return this.cacheV2.summary(runId); }

  hasVerifiedSharedHarnessMemory(runId: string): boolean {
    return this.harness.hasVerifiedSharedMemory(runId);
  }

  readVerifiedSharedHarnessMemoryBindings(
    runId: string,
    candidates: readonly { readonly claimId: string; readonly version: number }[],
  ): ReadonlyMap<string, string> {
    return this.harness.verifiedSharedMemoryBindings(runId, candidates);
  }

  readTaskFlowView(goalId: string): TaskFlowCurrentView | null {
    return this.taskFlow.currentView(goalId);
  }

  readTaskFlowRecoveryView(goalId: string): TaskFlowCurrentView | null {
    if (!this.startupIntegrityReceiptIsFresh()) {
      this.verifyIntegrity();
      try {
        this.verifyTaskFlowIntegrity();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Task Flow current-view integrity failed") throw error;
        this.rebuildTaskFlowGoal(goalId);
        this.verifyTaskFlowIntegrity();
      }
      this.captureStartupIntegrityReceipt();
    }
    return this.readTaskFlowView(goalId);
  }

  readTaskFlowAcceptanceLedger(contractId: string): ReturnType<TaskFlowRepository["acceptanceLedger"]> {
    return this.taskFlow.acceptanceLedger(contractId);
  }

  readLatestTaskFlowRouteRef(goalId: string): ReturnType<TaskFlowRepository["latestRouteRef"]> {
    return this.taskFlow.latestRouteRef(goalId);
  }

  readActiveTaskFlowGoal(workspaceId: string, originSessionId?: string): ActiveTaskFlowGoal | null {
    return this.taskFlow.activeGoal(workspaceId, originSessionId);
  }

  readTaskFlowGoalVersion(goalId: string): number {
    return this.taskFlow.goalVersion(goalId);
  }

  readNextTaskFlowWorkCell(goalId: string): ReturnType<TaskFlowRepository["nextReadyWorkCell"]> {
    return this.taskFlow.nextReadyWorkCell(goalId);
  }

  readTaskFlowOperation(goalId: string, operationId: string): TaskFlowOperationSnapshot | null {
    return this.taskFlow.operationSnapshot(goalId, operationId);
  }

  readTaskFlowOperationAttemptCount(goalId: string, operationId: string): number {
    return this.taskFlow.operationAttemptCount(goalId, operationId);
  }

  readOpenTaskFlowDecisionCount(goalId: string): number {
    return this.taskFlow.openDecisionCount(goalId);
  }

  readOpenTaskFlowClarifications(goalId: string): ReturnType<TaskFlowRepository["openClarificationDecisions"]> {
    return this.taskFlow.openClarificationDecisions(goalId);
  }

  readTaskFlowFailureOccurrence(goalId: string, signatureSha256: string): number {
    return this.taskFlow.failureSignatureOccurrence(goalId, signatureSha256);
  }

  readUnresolvedTaskFlowOperations(goalId: string): ReturnType<TaskFlowRepository["unresolvedOperations"]> {
    return this.taskFlow.unresolvedOperations(goalId);
  }

  readLatestTaskFlowBaseline(goalId: string): ReturnType<TaskFlowRepository["latestBaseline"]> {
    return this.taskFlow.latestBaseline(goalId);
  }

  readTaskFlowBaseline(baselineId: string): ReturnType<TaskFlowRepository["baseline"]> {
    return this.taskFlow.baseline(baselineId);
  }

  readTaskFlowEvidenceRoot(goalId: string, baselineSha256?: string): string {
    return this.taskFlow.evidenceRoot(goalId, baselineSha256);
  }

  rebuildTaskFlowGoal(goalId: string): TaskFlowCurrentView {
    runImmediateTransaction(this.connection, () => this.taskFlow.rebuildGoalHeads(goalId));
    this.taskFlow.verifyIntegrity();
    const view = this.taskFlow.currentView(goalId);
    if (!view) throw new AuthorityIntegrityError(`Task Flow Goal ${goalId} disappeared during rebuild`);
    return view;
  }

  readRecoveryMaterial(goalId: string): AuthorityRecoveryMaterial {
    return this.recovery.read(goalId);
  }

  readActivePerformanceTrial(goalId: string): ActivePerformanceTrialMaterial | null {
    return this.experiments.activeTrial(goalId);
  }

  readWorkflowState(goalId: string, planId: string): WorkflowState {
    return this.workflow.state(goalId, planId);
  }

  readPlanRevisionHead(goalId: string): { readonly planId: string; readonly revision: number } | null {
    return this.plans.head(goalId);
  }

  readGoalStatus(goalId: string): GoalStatus {
    return this.workflow.goalStatus(goalId);
  }

  readDecision(decisionId: string): StoredDecision | null {
    return this.decisions.read(decisionId);
  }

  performanceSampleCount(trialId: string): number {
    return this.experiments.sampleCount(trialId);
  }

  performanceVerdictCount(trialId: string): number {
    return this.experiments.verdictCount(trialId);
  }

  cacheObservationCount(goalId: string): number {
    return this.experiments.cacheObservationCount(goalId);
  }

  readCacheDiagnostic(goalId: string): ReturnType<ExperimentRepository["cacheDiagnostic"]> {
    return this.experiments.cacheDiagnostic(goalId);
  }

  readEvidence(goalId: string, evidenceId: string): EvidenceLookup {
    return this.evidence.read(goalId, evidenceId);
  }

  readMemoryClaim(claimId: string): MemoryClaimVersionRecord | null {
    return this.memories.current(claimId);
  }

  readMemoryCandidates(
    workspaceId: string,
    goalId: string | null,
    channels: readonly string[],
    limit: number,
  ): EffectiveMemoryClaim[] {
    return this.memories.candidates(workspaceId, goalId, channels, limit);
  }

  readMemoryByIds(workspaceId: string, goalId: string | null, claimIds: readonly string[]): EffectiveMemoryClaim[] {
    return this.memories.byIds(workspaceId, goalId, claimIds);
  }

  memoryIndexMode(): "TAG_PATH" | "FTS5" {
    return this.memories.indexMode();
  }

  memoryFtsMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryCandidateRank["channel"][],
    query: string,
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    return this.memories.ftsMatches(workspaceId, goalId, channels, query, terms, limit);
  }

  memoryStructuredMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryCandidateRank["channel"][],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    return this.memories.structuredMatches(workspaceId, goalId, channels, terms, limit);
  }

  readEndorsedMemories(
    workspaceId: string,
    goalId: string | null,
    channels: readonly string[],
    limit: number,
  ): EffectiveMemoryClaim[] {
    return this.memories.endorsedCandidates(workspaceId, goalId, channels, limit);
  }

  readPendingMemoryCandidates(workspaceId: string, goalId: string | null, limit: number): EffectiveMemoryClaim[] {
    return this.memories.pendingCandidates(workspaceId, goalId, limit);
  }

  memoryPendingMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly string[],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    return this.memories.pendingMatches(workspaceId, goalId, channels, terms, limit);
  }

  memoryPendingIndexCount(workspaceId?: string): number {
    return this.memories.pendingIndexCount(workspaceId);
  }

  memoryIndexWatermark(workspaceId: string): number {
    return this.memories.indexWatermark(workspaceId);
  }

  recordMemoryRecallObservations(observations: readonly MemoryRecallObservation[]): number {
    return this.memories.insertRecallObservations(observations);
  }

  flushMemoryIndex(limit: number, nowMs: number): MemoryIndexDrainResult {
    return this.memories.flushIndex(limit, nowMs);
  }

  readMemoryActionHead(claimId: string, family: MemoryClaimActionRecord["actionFamily"]): MemoryClaimActionRecord | null {
    return this.memories.actionHead(claimId, family);
  }

  verifyMemoryClaimAuthority(record: MemoryClaimVersionRecord): void {
    this.memories.verifyClaimAuthority(record);
  }

  readMemoryReceiptAttestation(receiptId: string, workspaceId: string): MemoryReceiptAttestationSource | null {
    return this.memories.receiptAttestation(receiptId, workspaceId);
  }

  memoryLegacyDispositionCount(workspaceId: string): number {
    return this.memories.legacyDispositionCount(workspaceId);
  }

  verifyCheckpointChain(goalId: string): { count: number; headSha256: string | null } {
    return this.checkpoints.verifyChain(goalId);
  }

  verifyIntegrity(): { goalCount: number; eventCount: number } {
    return verifyAuthorityIntegrity(this.connection);
  }

  private startupIntegrityReceiptIsFresh(): boolean {
    if (this.startupIntegrityDataVersion === null) return false;
    const row = this.connection.prepare("PRAGMA data_version").get() as { data_version?: unknown } | undefined;
    return Number(row?.data_version) === this.startupIntegrityDataVersion;
  }

  private captureStartupIntegrityReceipt(): void {
    const row = this.connection.prepare("PRAGMA data_version").get() as { data_version?: unknown } | undefined;
    const value = Number(row?.data_version);
    if (!Number.isSafeInteger(value) || value < 1) throw new AuthorityIntegrityError("SQLite data_version is invalid");
    this.startupIntegrityDataVersion = value;
  }
}
