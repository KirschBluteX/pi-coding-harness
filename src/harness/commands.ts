import type {
  ExecutionSubjectRefV2,
  IntegrationReceiptRecord,
  ManagedRunRecord,
  MemoryVisibilityBindingRecord,
  PatchSetRecord,
  ShardLeaseGenerationRecord,
  TaskPacketRecord,
  TopologyRevisionRecord,
  WorkerResultRecord,
  WorkerRunRecord,
  WorkerRunTransitionRecord,
  WorkShardRecord,
} from "./domain.js";
import type { ArtifactMetadata } from "../authority/repositories/common.js";

export interface CreateManagedRunCommand {
  readonly type: "CREATE_MANAGED_RUN";
  readonly goalId: string;
  readonly run: ManagedRunRecord;
  readonly topology: TopologyRevisionRecord;
}

export interface ReviseTopologyCommand {
  readonly type: "REVISE_HARNESS_TOPOLOGY";
  readonly goalId: string;
  readonly topology: TopologyRevisionRecord;
}

export interface DefineWorkShardsCommand {
  readonly type: "DEFINE_WORK_SHARDS";
  readonly goalId: string;
  readonly runId: string;
  readonly workCellId: string;
  readonly shards: readonly WorkShardRecord[];
}

export interface LeaseWorkShardCommand {
  readonly type: "LEASE_WORK_SHARD";
  readonly goalId: string;
  readonly packet: TaskPacketRecord;
  readonly subject: ExecutionSubjectRefV2;
  readonly lease: ShardLeaseGenerationRecord;
}

export interface StartWorkerRunCommand {
  readonly type: "START_WORKER_RUN";
  readonly goalId: string;
  readonly worker: WorkerRunRecord;
  readonly subject: ExecutionSubjectRefV2;
  readonly transition: WorkerRunTransitionRecord;
}

export interface TransitionWorkerRunCommand {
  readonly type: "TRANSITION_WORKER_RUN";
  readonly goalId: string;
  readonly transition: WorkerRunTransitionRecord;
}

export interface RecoverWorkerRunCommand {
  readonly type: "RECOVER_WORKER_RUN";
  readonly goalId: string;
  readonly transition: WorkerRunTransitionRecord;
}

export interface RequeueWorkShardCommand {
  readonly type: "REQUEUE_WORK_SHARD";
  readonly goalId: string;
  readonly runId: string;
  readonly shardId: string;
  readonly reasonSha256: string;
  readonly routeDecisionSha256: string;
}

export interface SubmitWorkerResultCommand {
  readonly type: "SUBMIT_WORKER_RESULT";
  readonly goalId: string;
  readonly result: WorkerResultRecord;
  readonly transition: WorkerRunTransitionRecord;
  readonly patchSet: PatchSetRecord | null;
  readonly artifacts: readonly ArtifactMetadata[];
}

export interface RecordIntegrationCommand {
  readonly type: "RECORD_HARNESS_INTEGRATION";
  readonly goalId: string;
  readonly receipt: IntegrationReceiptRecord;
}

export interface PreparePatchTransactionCommand {
  readonly type: "PREPARE_PATCH_TRANSACTION";
  readonly goalId: string;
  readonly runId: string;
  readonly shardId: string;
  readonly patchSetId: string;
  readonly journalSha256: string;
  readonly journalArtifact: ArtifactMetadata;
  readonly preimageArtifacts: readonly ArtifactMetadata[];
}

export interface TransitionSingleShardCommand {
  readonly type: "TRANSITION_SINGLE_SHARD";
  readonly goalId: string;
  readonly runId: string;
  readonly shardId: string;
  readonly action: "START" | "SUCCEED" | "FAIL" | "CANCEL";
  readonly resultSha256: string | null;
}

export interface ControlManagedRunCommand {
  readonly type: "CONTROL_MANAGED_RUN";
  readonly goalId: string;
  readonly runId: string;
  readonly action: "PAUSE" | "RESUME" | "CANCEL" | "SUCCEED" | "FAIL";
  readonly reasonSha256: string;
}

export interface BindMemoryVisibilityCommand {
  readonly type: "BIND_MEMORY_VISIBILITY";
  readonly goalId: string;
  readonly runId: string;
  readonly binding: MemoryVisibilityBindingRecord;
}

export type HarnessAuthorityCommand =
  | CreateManagedRunCommand
  | ReviseTopologyCommand
  | DefineWorkShardsCommand
  | LeaseWorkShardCommand
  | StartWorkerRunCommand
  | TransitionWorkerRunCommand
  | RecoverWorkerRunCommand
  | RequeueWorkShardCommand
  | SubmitWorkerResultCommand
  | PreparePatchTransactionCommand
  | RecordIntegrationCommand
  | TransitionSingleShardCommand
  | ControlManagedRunCommand
  | BindMemoryVisibilityCommand;
