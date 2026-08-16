import type {
  ExecutionGraphRevisionV2,
  ExecutionGraphTerminalReceiptV2,
  ExecutionIntegrationAttemptV2,
  ExecutionIntegrationTransitionV2,
  ExecutionNodeAttemptOutcomeV2,
  ExecutionNodeLeaseV2,
  ExecutionStopV2,
  HostOracleReceiptV2,
  HostNodeReceiptV2,
  TaskPacketV2,
  WorkerProposalV2,
  WorkerPatchSetV2,
} from "./domain.js";
import type { ArtifactMetadata } from "../../authority/repositories/common.js";
import type { TopologyRevisionRecord } from "../domain.js";
import type {
  DynamicMultiCandidateV2,
  StrongSingleBaselineV2,
  TopologyMeasurementEvidenceReceiptV2,
  TopologyMeasurementReceiptV2,
  TopologyGateReceiptV2,
} from "../../harness-v2/topology-gate.js";
import type { ProviderCallPlanV1 } from "../../provider-v2/domain.js";
import type {
  ProviderInvocationTransitionV1,
  ProviderRedactionReceiptV1,
} from "../../provider-v2/invocation.js";
import type { ExecutionIntegrationJournalV2 } from "./integration-journal.js";
import type { StrongSingleRolloutReceiptV1 } from "../../harness-v2/strong-single-rollout.js";
import type { StrongSingleWorkloadBindingV1 } from "../../harness-v2/workload-comparability.js";
import type { WorkloadComparabilityReceiptV1 } from "../../harness-v2/workload-comparability.js";
import type { DynamicMultiProposalReceiptV2 } from "../../harness-v2/dynamic-multi-proposal.js";

export interface RecordDynamicMultiProposalV2Command {
  readonly type: "RECORD_DYNAMIC_MULTI_PROPOSAL_V2";
  readonly goalId: string;
  readonly proposal: DynamicMultiProposalReceiptV2;
}

export interface RecordTopologyMeasurementsV2Command {
  readonly type: "RECORD_TOPOLOGY_MEASUREMENTS_V2";
  readonly goalId: string;
  readonly evidenceReceipts: readonly TopologyMeasurementEvidenceReceiptV2[];
  readonly receipts: readonly TopologyMeasurementReceiptV2[];
  readonly comparability?: WorkloadComparabilityReceiptV1;
}

export interface RecordTopologyAdmissionV2Command {
  readonly type: "RECORD_TOPOLOGY_ADMISSION_V2";
  readonly goalId: string;
  readonly baseline: StrongSingleBaselineV2 | null;
  readonly candidate: DynamicMultiCandidateV2 | null;
  readonly gate: TopologyGateReceiptV2;
  readonly topology: TopologyRevisionRecord;
}

export interface CommitExecutionGraphV2Command {
  readonly type: "COMMIT_EXECUTION_GRAPH_V2";
  readonly goalId: string;
  readonly graph: ExecutionGraphRevisionV2;
}

export interface AdmitAndCommitExecutionGraphV2Command {
  readonly type: "ADMIT_AND_COMMIT_EXECUTION_GRAPH_V2";
  readonly goalId: string;
  readonly baseline: StrongSingleBaselineV2 | null;
  readonly candidate: DynamicMultiCandidateV2 | null;
  readonly gate: TopologyGateReceiptV2;
  readonly topology: TopologyRevisionRecord;
  readonly graph: ExecutionGraphRevisionV2;
}

export interface LeaseExecutionNodeV2Command {
  readonly type: "LEASE_EXECUTION_NODE_V2";
  readonly goalId: string;
  readonly packet: TaskPacketV2;
  readonly lease: ExecutionNodeLeaseV2;
  readonly providerPlan: ProviderCallPlanV1;
  readonly redaction: ProviderRedactionReceiptV1;
  readonly invocation: ProviderInvocationTransitionV1;
}

export interface RecordProviderInvocationTransitionV1Command {
  readonly type: "RECORD_PROVIDER_INVOCATION_TRANSITION_V1";
  readonly goalId: string;
  readonly transition: ProviderInvocationTransitionV1;
}

export interface SubmitWorkerProposalV2Command {
  readonly type: "SUBMIT_WORKER_PROPOSAL_V2";
  readonly goalId: string;
  readonly proposal: WorkerProposalV2;
  readonly patchSet: WorkerPatchSetV2 | null;
  readonly artifacts: readonly ArtifactMetadata[];
  readonly providerTerminal?: ProviderInvocationTransitionV1;
}

export interface RecordExecutionNodeAttemptOutcomeV2Command {
  readonly type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2";
  readonly goalId: string;
  readonly outcome: ExecutionNodeAttemptOutcomeV2;
}

export interface RecordHostNodeReceiptV2Command {
  readonly type: "RECORD_HOST_NODE_RECEIPT_V2";
  readonly goalId: string;
  readonly receipt: HostNodeReceiptV2;
}

export interface RecordHostOracleReceiptV2Command {
  readonly type: "RECORD_HOST_ORACLE_RECEIPT_V2";
  readonly goalId: string;
  readonly receipt: HostOracleReceiptV2;
}

export interface StopExecutionV2Command {
  readonly type: "STOP_EXECUTION_V2";
  readonly goalId: string;
  readonly stop: ExecutionStopV2;
}

export interface RecordExecutionGraphTerminalV2Command {
  readonly type: "RECORD_EXECUTION_GRAPH_TERMINAL_V2";
  readonly goalId: string;
  readonly receipt: ExecutionGraphTerminalReceiptV2;
}

export interface PrepareExecutionIntegrationV2Command {
  readonly type: "PREPARE_EXECUTION_INTEGRATION_V2";
  readonly goalId: string;
  readonly attempt: ExecutionIntegrationAttemptV2;
  readonly prepared: ExecutionIntegrationTransitionV2;
  readonly journal: ExecutionIntegrationJournalV2;
}

export interface TransitionExecutionIntegrationV2Command {
  readonly type: "TRANSITION_EXECUTION_INTEGRATION_V2";
  readonly goalId: string;
  readonly transition: ExecutionIntegrationTransitionV2;
}

export interface RecordStrongSingleRolloutV1Command {
  readonly type: "RECORD_STRONG_SINGLE_ROLLOUT_V1";
  readonly goalId: string;
  readonly receipt: StrongSingleRolloutReceiptV1;
  readonly workloadBinding?: StrongSingleWorkloadBindingV1;
}

export type ExecutionV2AuthorityCommand =
  | RecordDynamicMultiProposalV2Command
  | RecordTopologyMeasurementsV2Command
  | RecordTopologyAdmissionV2Command
  | CommitExecutionGraphV2Command
  | AdmitAndCommitExecutionGraphV2Command
  | LeaseExecutionNodeV2Command
  | RecordProviderInvocationTransitionV1Command
  | RecordExecutionNodeAttemptOutcomeV2Command
  | SubmitWorkerProposalV2Command
  | RecordHostOracleReceiptV2Command
  | RecordHostNodeReceiptV2Command
  | StopExecutionV2Command
  | RecordExecutionGraphTerminalV2Command
  | PrepareExecutionIntegrationV2Command
  | TransitionExecutionIntegrationV2Command
  | RecordStrongSingleRolloutV1Command;
