import type { ArtifactStore } from "../../artifacts/artifact-store.js";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import type { ArtifactMetadata } from "../../authority/repositories/common.js";
import type { AuthorityStore, CommandResult } from "../../authority/transactions.js";
import { hmacSha256Hex } from "../../foundation/crypto.js";
import type { WorkerRuntimeSelection } from "../worker/runtime-policy.js";
import { createWorkerProviderDispatchAuthorityV1 } from "../../provider-v2/worker-plan.js";
import { finalizeProviderInvocationTerminalV1, type ProviderInvocationTransitionV1 } from "../../provider-v2/invocation.js";
import type { ProviderCallPlanV1 } from "../../provider-v2/domain.js";
import type {
  WorkerAttemptExecuteInputV2,
  WorkerAttemptResultV2,
} from "../worker/attempt-executor-v2.js";
import {
  finalizeExecutionGraphTerminalReceiptV2,
  finalizeHostOracleReceiptV2,
  finalizeExecutionIntegrationAttemptV2,
  finalizeExecutionIntegrationTransitionV2,
  finalizeExecutionNodeAttemptOutcomeV2,
  finalizeExecutionNodeLeaseV2,
  finalizeExecutionStopV2,
  finalizeHostNodeReceiptV2,
  type ExecutionGraphRevisionV2,
  type ExecutionIntegrationTransitionV2,
  type HostNodeReceiptV2,
  type HostOracleEvidenceV2,
  type TaskPacketArtifactRefV2,
  type TaskPacketDecisionRefV2,
  type TaskPacketV2,
  type WorkerProposalV2,
  type WorkerPatchSetV2,
} from "./domain.js";
import {
  finalizeExecutionIntegrationJournalV2,
  type ExecutionIntegrationJournalV2,
  type PreparedExecutionIntegrationJournalV2,
} from "./integration-journal.js";

export interface DynamicMultiWorkerPortV2 {
  execute(input: WorkerAttemptExecuteInputV2): Promise<WorkerAttemptResultV2>;
}

export interface DynamicMultiEvidencePortV2 {
  accept(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
  }): Promise<{ readonly evidence_sha256: string }>;
}

export interface DynamicMultiOraclePortV2 {
  validate(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
    readonly postimage_root_sha256: string;
    readonly oracle_sha256: string;
    readonly oracle_set_sha256: string;
    readonly environment_sha256: string;
    readonly covered_obligation_ids: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly validation_evidence: readonly Omit<HostOracleEvidenceV2, "schema_version" | "record_sha256">[];
  }>;
}

export interface DynamicMultiPatchArtifactV2 {
  readonly path: string;
  readonly metadata: ArtifactMetadata;
  readonly bytes: Uint8Array;
}

export type DynamicMultiIntegrationResultV2 =
  | { readonly status: "APPLIED"; readonly postimage_root_sha256: string }
  | { readonly status: "REJECTED"; readonly failure_sha256: string }
  | { readonly status: "OUTCOME_UNKNOWN"; readonly failure_sha256: string };

export type DynamicMultiIntegrationObservationV2 =
  | { readonly status: "APPLIED"; readonly postimage_root_sha256: string }
  | { readonly status: "NOT_APPLIED"; readonly current_postimage_root_sha256: string; readonly failure_sha256: string }
  | { readonly status: "CONFLICT"; readonly current_postimage_root_sha256: string; readonly failure_sha256: string };

export interface DynamicMultiIntegrationPortV2 {
  prepare(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
    readonly patch_set: WorkerPatchSetV2;
    readonly artifacts: readonly DynamicMultiPatchArtifactV2[];
    readonly expected_preimage_root_sha256: string;
    readonly signal: AbortSignal;
  }): Promise<PreparedExecutionIntegrationJournalV2>;
  integrate(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
    readonly patch_set: WorkerPatchSetV2;
    readonly artifacts: readonly DynamicMultiPatchArtifactV2[];
    readonly journal: ExecutionIntegrationJournalV2;
    readonly expected_preimage_root_sha256: string;
    readonly signal: AbortSignal;
  }): Promise<DynamicMultiIntegrationResultV2>;
  observe(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
    readonly patch_set: WorkerPatchSetV2;
    readonly artifacts: readonly DynamicMultiPatchArtifactV2[];
    readonly journal: ExecutionIntegrationJournalV2;
    readonly integration_attempt_id: string;
    readonly expected_preimage_root_sha256: string;
    readonly proposed_postimage_root_sha256: string;
    readonly signal: AbortSignal;
  }): Promise<DynamicMultiIntegrationObservationV2>;
}

export interface DynamicMultiPacketClosureV2 {
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly TaskPacketDecisionRefV2[];
  readonly provider_call_plan_id: string | null;
  readonly provider_call_plan_sha256: string | null;
}

export interface DynamicMultiCoordinatorOptionsV2 {
  readonly authority: AuthorityStore;
  readonly mutation: {
    transact(
      command: Parameters<AuthorityStore["transactExecutionV2"]>[0],
      idempotencyKey: string,
    ): CommandResult;
  };
  readonly runId: string;
  readonly workspace: string;
  readonly capabilityKey: string;
  readonly supervisorRuntime: WorkerRuntimeSelection;
  readonly worker: DynamicMultiWorkerPortV2;
  readonly evidence: DynamicMultiEvidencePortV2;
  readonly oracle: DynamicMultiOraclePortV2;
  readonly integration?: DynamicMultiIntegrationPortV2;
  readonly packetClosure?: (graph: ExecutionGraphRevisionV2, nodeId: string) => DynamicMultiPacketClosureV2;
  readonly artifactStore?: ArtifactStore;
  readonly now?: () => number;
  readonly nodeLeaseTtlMs?: number;
  readonly schedulerTickMs?: number;
  readonly onIntegrationFault?: (
    point: "AFTER_PREPARE" | "AFTER_DISPATCH" | "AFTER_OBSERVE" | "AFTER_COMMIT",
  ) => void;
}

function providerTerminalWithinPlan(
  plan: ProviderCallPlanV1,
  terminal: ProviderInvocationTransitionV1,
): boolean {
  if (terminal.state !== "SETTLED") return true;
  if (terminal.request_count === null || terminal.input_tokens === null
    || terminal.output_tokens === null || terminal.wall_time_ms === null) return false;
  return terminal.request_count <= plan.request_budget.soft_max_requests
    && terminal.request_count <= plan.transport_request_limit
    && terminal.input_tokens <= plan.request_budget.soft_max_input_tokens
    && terminal.output_tokens <= plan.request_budget.soft_max_output_tokens
    && (terminal.cost_microusd === null
      || terminal.cost_microusd <= plan.request_budget.soft_max_cost_microusd)
    && terminal.wall_time_ms <= plan.request_budget.soft_max_latency_ms
    && (plan.cache.mode === "C0"
      ? terminal.cache_lineage_sha256 === null
      : terminal.cache_lineage_sha256 === plan.cache.lineage_sha256);
}

export interface DynamicMultiJobViewV2 {
  readonly job_id: string;
  readonly state: "RUNNING" | "SUCCEEDED" | "FAILED" | "STOPPED";
  readonly graph_status: "RUNNING" | "STOPPED" | "CLOSED" | "FAILED";
  readonly ready_node_ids: readonly string[];
  readonly active_node_ids: readonly string[];
  readonly completed_node_ids: readonly string[];
  readonly oracle_pending_node_ids: readonly string[];
  readonly active_worker_count: number;
  readonly peak_worker_count: number;
  readonly error: string | null;
}

export class DynamicMultiCoordinator {
  readonly jobId: string;
  private readonly now: () => number;
  private readonly active = new Map<string, { readonly abort: AbortController; readonly task: Promise<void> }>();
  private readonly hostProcesses = new Map<string, { readonly abort: AbortController; readonly task: Promise<void> }>();
  private mutationTail: Promise<void> = Promise.resolve();
  private integrationTail: Promise<void> = Promise.resolve();
  private completion: Promise<void> | null = null;
  private maxParallel = 1;
  private peakWorkers = 0;
  private terminalError: string | null = null;
  private stopRequested = false;
  private crashRequested = false;
  private hostProcessError: Error | null = null;

  constructor(private readonly options: DynamicMultiCoordinatorOptionsV2) {
    if (options.nodeLeaseTtlMs !== undefined
      && (!Number.isSafeInteger(options.nodeLeaseTtlMs) || options.nodeLeaseTtlMs < 1 || options.nodeLeaseTtlMs > 60_000)) {
      throw new TypeError("Dynamic Multi node lease TTL is invalid");
    }
    this.jobId = `EXECUTION-V2-${options.runId}`;
    this.now = options.now ?? Date.now;
  }

  async start(maxParallel: number): Promise<DynamicMultiJobViewV2> {
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
      throw new TypeError("Dynamic Multi maxParallel is invalid");
    }
    if (this.completion) throw new TypeError("Dynamic Multi coordinator is already started");
    this.maxParallel = maxParallel;
    let resolveStarted!: () => void;
    let announced = false;
    const startedPromise = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const announceStarted = (): void => {
      if (announced) return;
      announced = true;
      resolveStarted();
    };
    this.completion = this.run(announceStarted).catch(async (error: unknown) => {
      this.terminalError = error instanceof Error ? error.message : String(error);
      if (!this.stopRequested && !this.crashRequested) {
        try {
          await this.stopGraph("NO_PROGRESS");
          await this.closeGraph();
        } catch (closureError) {
          const detail = closureError instanceof Error ? closureError.message : String(closureError);
          this.terminalError = `${this.terminalError}; failed to close graph: ${detail}`;
        }
      }
    }).finally(announceStarted);
    await startedPromise;
    return this.poll();
  }

  async wait(): Promise<DynamicMultiJobViewV2> {
    if (!this.completion) throw new TypeError("Dynamic Multi coordinator is not started");
    await this.completion;
    return this.poll();
  }

  poll(): DynamicMultiJobViewV2 {
    const projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
    if (!projection) throw new TypeError("Dynamic Multi execution graph is unavailable");
    const state = projection.status === "CLOSED" ? "SUCCEEDED"
      : projection.status === "FAILED" ? "FAILED"
        : projection.status === "STOPPED" ? "STOPPED"
          : this.terminalError === null ? "RUNNING" : "FAILED";
    return {
      job_id: this.jobId,
      state,
      graph_status: projection.status,
      ready_node_ids: projection.readyNodeIds,
      active_node_ids: projection.activeNodeIds,
      completed_node_ids: projection.completedNodeIds,
      oracle_pending_node_ids: projection.oraclePendingNodeIds,
      active_worker_count: this.active.size,
      peak_worker_count: this.peakWorkers,
      error: this.terminalError,
    };
  }

  async stop(): Promise<DynamicMultiJobViewV2> {
    this.stopRequested = true;
    await this.stopGraph("USER_CANCEL");
    for (const current of this.active.values()) current.abort.abort();
    for (const current of this.hostProcesses.values()) current.abort.abort();
    await Promise.allSettled([
      ...this.active.values(),
      ...this.hostProcesses.values(),
    ].map((current) => current.task));
    return this.poll();
  }

  private async run(started: () => void): Promise<void> {
    while (true) {
      if (this.crashRequested) return;
      if (this.hostProcessError) throw this.hostProcessError;
      await this.serialIntegration(async () => {
        if (this.crashRequested) return;
        await this.reconcileIntegration();
      });
      if (this.crashRequested) return;
      await this.reconcileExpiredAttempts();
      let projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
      if (!projection) throw new TypeError("Dynamic Multi execution graph is unavailable");
      if (projection.status !== "RUNNING") {
        started();
        return;
      }
      while (!this.stopRequested && this.active.size < this.maxParallel && projection.readyDispatches.length > 0) {
        const dispatch = projection.readyDispatches.find((candidate) => !this.active.has(candidate.nodeId));
        if (!dispatch) break;
        await this.launch(projection.graph, dispatch);
        projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel)!;
      }
      started();
      if (this.active.size === 0 && this.hostProcesses.size === 0) {
        if (projection.completedNodeIds.length === projection.graph.nodes.length) {
          await this.closeGraph();
          return;
        }
        const oracleNodeId = projection.oraclePendingNodeIds[0];
        if (oracleNodeId) {
          const pending = this.options.authority.readExecutionNodeOraclePreparation(this.options.runId, oracleNodeId);
          const abort = new AbortController();
          await this.serialIntegration(() => this.validateNode(
            pending.graph,
            pending.packet,
            pending.proposal,
            abort.signal,
          ));
          continue;
        }
        if (projection.readyNodeIds.length === 0 && projection.activeNodeIds.length === 0) {
          await this.stopGraph("NO_PROGRESS");
          await this.closeGraph();
          return;
        }
      }
      const tick = new Promise<void>((resolveTick) => {
        const timer = setTimeout(resolveTick, this.options.schedulerTickMs ?? 100);
        timer.unref?.();
      });
      await Promise.race([
        ...this.active.values(),
        ...this.hostProcesses.values(),
      ].map((current) => current.task).concat(tick));
    }
  }

  private async launch(
    graph: ExecutionGraphRevisionV2,
    dispatch: { readonly nodeId: string; readonly attempt: number; readonly leaseGeneration: number;
      readonly fencingToken: number; readonly stopGeneration: number },
  ): Promise<void> {
    const node = graph.nodes.find((candidate) => candidate.node_id === dispatch.nodeId);
    if (!node) throw new TypeError("Dynamic Multi dispatch node is missing");
    const persistedClosure: DynamicMultiPacketClosureV2 = {
      exact_input_refs: node.exact_input_refs,
      decision_refs: node.decision_refs,
      provider_call_plan_id: node.provider_call_plan_id,
      provider_call_plan_sha256: node.provider_call_plan_sha256,
    };
    const closure = this.options.packetClosure?.(graph, dispatch.nodeId) ?? persistedClosure;
    if (canonicalJsonSha256(closure) !== canonicalJsonSha256(persistedClosure)) {
      throw new TypeError("Dynamic Multi packet closure differs from the committed execution node");
    }
    if (closure.provider_call_plan_id !== null || closure.provider_call_plan_sha256 !== null) {
      throw new TypeError("Dynamic Multi provider authority is Host-generated per TaskPacket attempt");
    }
    const dispatched = await this.withMutation(() => {
      const now = this.now();
      const preparation = this.options.authority.readExecutionV2Preparation(graph.goal_id, graph.run_id);
      const provider = createWorkerProviderDispatchAuthorityV1({
        graph,
        node,
        attempt: dispatch.attempt,
        leaseGeneration: dispatch.leaseGeneration,
        fencingToken: dispatch.fencingToken,
        deadlineMs: Math.min(node.deadline_ms, now + Math.max(1, node.deadline_ms - now)),
        createdAtMs: now,
        predecessorAuthorityHeadSha256: preparation.predecessorAuthorityHeadSha256,
        capabilityKey: this.options.capabilityKey,
        runtime: {
          runtime: this.options.supervisorRuntime,
          source: "SUPERVISOR_INHERITED",
          fallback_reason: null,
        },
      });
      const lease = finalizeExecutionNodeLeaseV2({
        packet: provider.packet,
        owner_hmac: hmacSha256Hex(
          Buffer.from(this.options.capabilityKey, "utf8"),
          `${this.jobId}:${provider.packet.packet_id}`,
        ),
        expires_at_ms: this.options.nodeLeaseTtlMs === undefined
          ? provider.packet.deadline_ms
          : Math.min(provider.packet.deadline_ms, now + this.options.nodeLeaseTtlMs),
        created_at_ms: now,
      });
      this.commit({
        type: "LEASE_EXECUTION_NODE_V2", goalId: graph.goal_id, packet: provider.packet, lease,
        providerPlan: provider.plan, redaction: provider.redaction, invocation: provider.invocation,
      }, `dynamic-multi:${provider.packet.packet_id}:lease`);
      return { provider, lease };
    });
    const { provider, lease } = dispatched;
    const packet = provider.packet;
    const abort = new AbortController();
    const task = this.executeWorker(graph, packet, lease, provider.plan, provider.invocation, abort)
      .finally(() => { this.active.delete(packet.node_id); });
    this.active.set(packet.node_id, { abort, task });
    this.peakWorkers = Math.max(this.peakWorkers, this.active.size);
  }

  private async executeWorker(
    graph: ExecutionGraphRevisionV2,
    packet: TaskPacketV2,
    lease: ReturnType<typeof finalizeExecutionNodeLeaseV2>,
    providerPlan: ProviderCallPlanV1,
    providerInvocation: ProviderInvocationTransitionV1,
    abort: AbortController,
  ): Promise<void> {
    let result: WorkerAttemptResultV2;
    try {
      result = await this.options.worker.execute({
        workspace: this.options.workspace,
        packet,
        capabilityKey: this.options.capabilityKey,
        current: {
          graph_sha256: graph.record_sha256,
          authorization_sha256: graph.authorization_sha256,
          stop_generation: packet.stop_generation,
        },
        supervisorRuntime: this.options.supervisorRuntime,
        providerPlan,
        providerInvocation,
        signal: abort.signal,
      });
    } catch (error) {
      await this.recordProviderInvocationTerminal(providerInvocation, null, error);
      if (!this.isCurrentRunningPacket(packet)) return;
      await this.recordAttemptFailure(graph, packet, lease, error);
      return;
    }
    if (result.status === "PROPOSED" && result.proposal !== null) {
      const candidateTerminal = this.finalizeProviderInvocationTerminal(providerInvocation, result, null, this.now());
      if (!providerTerminalWithinPlan(providerPlan, candidateTerminal)) {
        await this.recordProviderInvocationTerminal(providerInvocation, result, null);
        if (!this.isCurrentRunningPacket(packet)) return;
        await this.recordAttemptFailure(
          graph,
          packet,
          lease,
          new TypeError("Provider invocation exceeded its authority-bound budget or cache policy"),
        );
        return;
      }
      if (!this.isCurrentRunningPacket(packet)) {
        await this.recordProviderInvocationTerminal(providerInvocation, result, null);
        return;
      }
      const task = this.processResult(graph, packet, lease, result, providerInvocation, abort.signal)
        .catch((error: unknown) => {
          this.hostProcessError = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => { this.hostProcesses.delete(packet.node_id); });
      this.hostProcesses.set(packet.node_id, { abort, task });
      return;
    }
    await this.recordProviderInvocationTerminal(providerInvocation, result, null);
    if (!this.isCurrentRunningPacket(packet)) return;
    await this.recordAttemptFailure(graph, packet, lease, result);
  }

  private isCurrentRunningPacket(packet: TaskPacketV2): boolean {
    return this.options.authority.isCurrentExecutionNodePacket(packet);
  }

  private async processResult(
    graph: ExecutionGraphRevisionV2,
    packet: TaskPacketV2,
    lease: ReturnType<typeof finalizeExecutionNodeLeaseV2>,
    result: WorkerAttemptResultV2,
    providerInvocation: ProviderInvocationTransitionV1,
    signal: AbortSignal,
  ): Promise<void> {
    if (result.status !== "PROPOSED" || result.proposal === null) {
      await this.recordAttemptFailure(graph, packet, lease, result);
      return;
    }
    const artifacts = this.patchArtifacts(result);
    await this.withMutation(() => {
      const existing = this.options.authority.readProviderInvocation(providerInvocation.provider_invocation_id);
      if (existing?.ordinal === 1) {
        throw new TypeError("Provider settlement exists without its atomic Worker proposal");
      }
      if (!existing || existing.record_sha256 !== providerInvocation.record_sha256 || existing.state !== "PREPARED") {
        throw new TypeError("Provider invocation prepared authority is unavailable");
      }
      const providerTerminal = this.finalizeProviderInvocationTerminal(
        providerInvocation, result, null, this.now(),
      );
      this.commit({
        type: "SUBMIT_WORKER_PROPOSAL_V2",
        goalId: graph.goal_id,
        proposal: result.proposal!,
        patchSet: result.patch_set,
        artifacts,
        providerTerminal,
      }, `dynamic-multi:${result.proposal!.proposal_id}:provider-settlement-proposal`);
    });
    if (result.proposal.kind === "PATCH_PROPOSAL") {
      await this.serialIntegration(() => this.integratePatch(graph, packet, lease, result, signal));
      return;
    }
    if (result.proposal.kind !== "EVIDENCE_PROPOSAL") {
      throw new TypeError(`Dynamic Multi proposal kind ${result.proposal.kind} requires a typed Host Adapter`);
    }
    const accepted = await this.options.evidence.accept({ graph, packet, proposal: result.proposal });
    await this.recordHostReceipt({
      graph, packet, proposal: result.proposal, kind: "EVIDENCE_ACCEPTED",
      evidenceSha256: accepted.evidence_sha256, preimageRootSha256: null, postimageRootSha256: null,
    });
    await this.serialIntegration(() => this.validateNode(graph, packet, result.proposal!, signal));
  }

  private patchArtifacts(result: WorkerAttemptResultV2): readonly ArtifactMetadata[] {
    if (result.patch_set === null) return [];
    if (!this.options.artifactStore) throw new TypeError("Dynamic Multi PatchSet requires an ArtifactStore Adapter");
    const artifacts = new Map<string, ArtifactMetadata>();
    for (const patch of result.patches) {
      if (patch.content === null) continue;
      const artifact = this.options.artifactStore.put(patch.content, {
        mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
      });
      artifacts.set(artifact.sha256, artifact);
    }
    return [...artifacts.values()];
  }

  private async integratePatch(
    graph: ExecutionGraphRevisionV2,
    packet: TaskPacketV2,
    lease: ReturnType<typeof finalizeExecutionNodeLeaseV2>,
    result: WorkerAttemptResultV2,
    signal: AbortSignal,
  ): Promise<void> {
    if (!result.proposal || !result.patch_set) {
      throw new TypeError("Dynamic Multi Patch proposal lacks its PatchSet closure");
    }
    if (!this.options.integration || !this.options.artifactStore) {
      throw new TypeError("Dynamic Multi Patch proposal requires Host integration and ArtifactStore Adapters");
    }
    const durable = this.options.authority.readWorkerPatchSetClosure(result.patch_set.patch_set_id);
    if (!durable || durable.patchSet.record_sha256 !== result.patch_set.record_sha256
      || durable.proposalId !== result.proposal.proposal_id
      || durable.proposalSha256 !== result.proposal.record_sha256) {
      throw new TypeError("Dynamic Multi durable PatchSet closure differs from the Worker proposal");
    }
    const artifacts = this.integrationArtifacts(durable);
    const projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
    if (!projection || projection.status !== "RUNNING" || projection.graph.record_sha256 !== graph.record_sha256) return;
    if (["PREPARED", "OBSERVED"].includes(projection.integrationState)) {
      throw new TypeError("Dynamic Multi integration authority has an unresolved attempt");
    }
    const node = graph.nodes.find((candidate) => candidate.node_id === packet.node_id)!;
    const createdAt = this.now();
    let journalPreparation: PreparedExecutionIntegrationJournalV2;
    try {
      journalPreparation = await this.options.integration.prepare({
        graph,
        packet,
        proposal: result.proposal,
        patch_set: durable.patchSet,
        artifacts,
        expected_preimage_root_sha256: projection.currentPostimageRootSha256,
        signal,
      });
    } catch (error) {
      await this.recordAttemptFailure(graph, packet, lease, canonicalJsonSha256({
        domain: "PCH-DYNAMIC-MULTI-INTEGRATION-PREPARE-FAILED-V2",
        proposal: result.proposal.record_sha256,
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    const { attempt, prepared } = finalizeExecutionIntegrationAttemptV2({
      graph,
      node_id: packet.node_id,
      proposal: result.proposal,
      patch_set: durable.patchSet,
      authorization_sha256: graph.authorization_sha256,
      expected_preimage_root_sha256: projection.currentPostimageRootSha256,
      lease_generation: projection.integrationLeaseGeneration + 1,
      fencing_token: projection.integrationFencingToken + 1,
      owner_hmac: hmacSha256Hex(
        Buffer.from(this.options.capabilityKey, "utf8"),
        `${this.jobId}:${result.proposal.proposal_id}:integration`,
      ),
      expires_at_ms: Math.min(node.deadline_ms, createdAt + 60_000),
      created_at_ms: createdAt,
    });
    const journal = finalizeExecutionIntegrationJournalV2({
      integration_attempt_id: attempt.integration_attempt_id,
      prepared: journalPreparation,
    });
    await this.transact({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: graph.goal_id, attempt, prepared, journal,
    }, `dynamic-multi:${attempt.integration_attempt_id}:prepared`);
    this.integrationFault("AFTER_PREPARE");

    let integrated: DynamicMultiIntegrationResultV2;
    try {
      integrated = await this.options.integration.integrate({
        graph,
        packet,
        proposal: result.proposal,
        patch_set: durable.patchSet,
        artifacts,
        journal,
        expected_preimage_root_sha256: attempt.expected_preimage_root_sha256,
        signal,
      });
    } catch (error) {
      integrated = {
        status: "OUTCOME_UNKNOWN",
        failure_sha256: canonicalJsonSha256({
          domain: "PCH-DYNAMIC-MULTI-INTEGRATION-THROW-V2",
          attempt: attempt.record_sha256,
          error: String(error),
        }),
      };
    }
    this.integrationFault("AFTER_DISPATCH");
    if (integrated.status === "OUTCOME_UNKNOWN") {
      await this.reconcileIntegration();
      return;
    }
    if (integrated.status === "REJECTED") {
      const rejected = finalizeExecutionIntegrationTransitionV2({
        attempt, ordinal: 1, state: "REJECTED", predecessor_transition_sha256: prepared.record_sha256,
        postimage_root_sha256: null, failure_sha256: integrated.failure_sha256, created_at_ms: this.now(),
      });
      await this.transact({
        type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: graph.goal_id, transition: rejected,
      }, `dynamic-multi:${rejected.integration_transition_id}:rejected`);
      await this.recordAttemptFailure(graph, packet, lease, integrated.failure_sha256);
      return;
    }
    const observed = finalizeExecutionIntegrationTransitionV2({
      attempt, ordinal: 1, state: "OBSERVED", predecessor_transition_sha256: prepared.record_sha256,
      postimage_root_sha256: integrated.postimage_root_sha256, failure_sha256: null, created_at_ms: this.now(),
    });
    await this.transact({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: graph.goal_id, transition: observed,
    }, `dynamic-multi:${observed.integration_transition_id}:observed`);
    this.integrationFault("AFTER_OBSERVE");
    const committed = finalizeExecutionIntegrationTransitionV2({
      attempt, ordinal: 2, state: "COMMITTED", predecessor_transition_sha256: observed.record_sha256,
      postimage_root_sha256: integrated.postimage_root_sha256, failure_sha256: null, created_at_ms: this.now(),
    });
    await this.transact({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: graph.goal_id, transition: committed,
    }, `dynamic-multi:${committed.integration_transition_id}:committed`);
    this.integrationFault("AFTER_COMMIT");
    await this.recordHostReceipt({
      graph, packet, proposal: result.proposal, kind: "PATCH_INTEGRATED",
      evidenceSha256: committed.record_sha256,
      preimageRootSha256: attempt.expected_preimage_root_sha256,
      postimageRootSha256: integrated.postimage_root_sha256,
    });
    await this.validateNode(graph, packet, result.proposal, signal);
  }

  private integrationArtifacts(
    closure: ReturnType<AuthorityStore["readWorkerPatchSetClosure"]> & {},
  ): readonly DynamicMultiPatchArtifactV2[] {
    if (!this.options.artifactStore) throw new TypeError("Dynamic Multi integration recovery requires an ArtifactStore Adapter");
    return closure.artifacts.map((member): DynamicMultiPatchArtifactV2 => {
      const bytes = this.options.artifactStore!.open(member.artifact.locator);
      if (bytes.byteLength !== member.artifact.byteLength) {
        throw new TypeError(`Dynamic Multi PatchSet artifact length differs at ${member.path}`);
      }
      return { path: member.path, metadata: member.artifact, bytes };
    });
  }

  private integrationFault(
    point: "AFTER_PREPARE" | "AFTER_DISPATCH" | "AFTER_OBSERVE" | "AFTER_COMMIT",
  ): void {
    try {
      this.options.onIntegrationFault?.(point);
    } catch (error) {
      this.crashRequested = true;
      this.terminalError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async reconcileIntegration(): Promise<void> {
    const recovery = this.options.authority.readExecutionIntegrationRecovery(this.options.runId);
    if (!recovery) return;
    const integration = this.options.integration;
    if (!integration || !this.options.artifactStore) {
      throw new TypeError("Dynamic Multi unresolved integration requires Host integration and ArtifactStore Adapters");
    }
    if (recovery.currentAuthorizationSha256 !== recovery.attempt.authorization_sha256
      || recovery.authorizationRevokedAtMs !== null
      || recovery.authorizationExpiresAtMs <= this.now()) {
      const failureSha256 = canonicalJsonSha256({
        domain: "PCH-DYNAMIC-MULTI-INTEGRATION-AUTHORIZATION-STALE-V2",
        attempt: recovery.attempt.record_sha256,
        currentAuthorizationSha256: recovery.currentAuthorizationSha256,
        revokedAtMs: recovery.authorizationRevokedAtMs,
        expiresAtMs: recovery.authorizationExpiresAtMs,
      });
      if (recovery.latestTransition.state === "COMMITTED") {
        await this.stopGraph("AUTHORIZATION_REVOKED");
        await this.closeGraph();
      } else {
        await this.fenceRecoveredIntegration(recovery, failureSha256, "AUTHORIZATION_REVOKED");
      }
      return;
    }
    if (recovery.latestTransition.state === "COMMITTED") {
      await this.finishRecoveredIntegration(recovery, recovery.latestTransition);
      return;
    }
    if (recovery.attempt.expires_at_ms <= this.now()) {
      await this.fenceRecoveredIntegration(recovery, canonicalJsonSha256({
        domain: "PCH-DYNAMIC-MULTI-INTEGRATION-RECOVERY-EXPIRED-V2",
        attempt: recovery.attempt.record_sha256,
      }));
      return;
    }
    const abort = new AbortController();
    let observation: DynamicMultiIntegrationObservationV2;
    try {
      observation = await integration.observe({
        graph: recovery.graph,
        packet: recovery.packet,
        proposal: recovery.proposal,
        patch_set: recovery.patchClosure.patchSet,
        artifacts: this.integrationArtifacts(recovery.patchClosure),
        journal: recovery.journal,
        integration_attempt_id: recovery.attempt.integration_attempt_id,
        expected_preimage_root_sha256: recovery.attempt.expected_preimage_root_sha256,
        proposed_postimage_root_sha256: recovery.patchClosure.patchSet.proposed_postimage_root_sha256,
        signal: abort.signal,
      });
    } catch (error) {
      await this.fenceRecoveredIntegration(recovery, canonicalJsonSha256({
        domain: "PCH-DYNAMIC-MULTI-INTEGRATION-OBSERVE-FAILED-V2",
        attempt: recovery.attempt.record_sha256,
        error: String(error),
      }));
      return;
    }
    if (observation.status === "APPLIED") {
      let latest = recovery.latestTransition;
      if (latest.state === "PREPARED") {
        const observed = finalizeExecutionIntegrationTransitionV2({
          attempt: recovery.attempt,
          ordinal: 1,
          state: "OBSERVED",
          predecessor_transition_sha256: latest.record_sha256,
          postimage_root_sha256: observation.postimage_root_sha256,
          failure_sha256: null,
          created_at_ms: this.now(),
        });
        await this.transact({
          type: "TRANSITION_EXECUTION_INTEGRATION_V2",
          goalId: recovery.graph.goal_id,
          transition: observed,
        }, `dynamic-multi:${observed.integration_transition_id}:reconciled-observed`);
        latest = observed;
      } else if (latest.state !== "OBSERVED" || latest.postimage_root_sha256 !== observation.postimage_root_sha256) {
        await this.fenceRecoveredIntegration(recovery, canonicalJsonSha256({
          domain: "PCH-DYNAMIC-MULTI-INTEGRATION-OBSERVATION-CONFLICT-V2",
          attempt: recovery.attempt.record_sha256,
          durable: latest.postimage_root_sha256,
          observed: observation.postimage_root_sha256,
        }));
        return;
      }
      const committed = finalizeExecutionIntegrationTransitionV2({
        attempt: recovery.attempt,
        ordinal: latest.ordinal + 1,
        state: "COMMITTED",
        predecessor_transition_sha256: latest.record_sha256,
        postimage_root_sha256: observation.postimage_root_sha256,
        failure_sha256: null,
        created_at_ms: this.now(),
      });
      await this.transact({
        type: "TRANSITION_EXECUTION_INTEGRATION_V2",
        goalId: recovery.graph.goal_id,
        transition: committed,
      }, `dynamic-multi:${committed.integration_transition_id}:reconciled-committed`);
      await this.finishRecoveredIntegration(recovery, committed);
      return;
    }
    if (observation.status === "NOT_APPLIED"
      && recovery.latestTransition.state === "PREPARED"
      && observation.current_postimage_root_sha256 === recovery.attempt.expected_preimage_root_sha256) {
      const rejected = finalizeExecutionIntegrationTransitionV2({
        attempt: recovery.attempt,
        ordinal: 1,
        state: "REJECTED",
        predecessor_transition_sha256: recovery.latestTransition.record_sha256,
        postimage_root_sha256: null,
        failure_sha256: observation.failure_sha256,
        created_at_ms: this.now(),
      });
      await this.transact({
        type: "TRANSITION_EXECUTION_INTEGRATION_V2",
        goalId: recovery.graph.goal_id,
        transition: rejected,
      }, `dynamic-multi:${rejected.integration_transition_id}:reconciled-rejected`);
      await this.recordAttemptFailure(recovery.graph, recovery.packet, recovery.lease, observation.failure_sha256);
      return;
    }
    await this.fenceRecoveredIntegration(recovery, observation.failure_sha256);
  }

  private async finishRecoveredIntegration(
    recovery: NonNullable<ReturnType<AuthorityStore["readExecutionIntegrationRecovery"]>>,
    committed: ExecutionIntegrationTransitionV2,
  ): Promise<void> {
    await this.recordHostReceipt({
      graph: recovery.graph,
      packet: recovery.packet,
      proposal: recovery.proposal,
      kind: "PATCH_INTEGRATED",
      evidenceSha256: committed.record_sha256,
      preimageRootSha256: recovery.attempt.expected_preimage_root_sha256,
      postimageRootSha256: committed.postimage_root_sha256,
    });
    await this.validateNode(recovery.graph, recovery.packet, recovery.proposal, new AbortController().signal);
  }

  private async fenceRecoveredIntegration(
    recovery: NonNullable<ReturnType<AuthorityStore["readExecutionIntegrationRecovery"]>>,
    failureSha256: string,
    stopReason: "INTEGRATION_RECONCILIATION_REQUIRED" | "AUTHORIZATION_REVOKED" = "INTEGRATION_RECONCILIATION_REQUIRED",
  ): Promise<void> {
    const fenced = finalizeExecutionIntegrationTransitionV2({
      attempt: recovery.attempt,
      ordinal: recovery.latestTransition.ordinal + 1,
      state: "FENCED",
      predecessor_transition_sha256: recovery.latestTransition.record_sha256,
      postimage_root_sha256: null,
      failure_sha256: failureSha256,
      created_at_ms: this.now(),
    });
    await this.transact({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2",
      goalId: recovery.graph.goal_id,
      transition: fenced,
    }, `dynamic-multi:${fenced.integration_transition_id}:reconciliation-fenced`);
    await this.stopGraph(stopReason);
    await this.closeGraph();
  }

  private async recordHostReceipt(input: {
    readonly graph: ExecutionGraphRevisionV2;
    readonly packet: TaskPacketV2;
    readonly proposal: WorkerProposalV2;
    readonly kind: "EVIDENCE_ACCEPTED" | "PATCH_INTEGRATED";
    readonly evidenceSha256: string;
    readonly preimageRootSha256: string | null;
    readonly postimageRootSha256: string | null;
  }): Promise<HostNodeReceiptV2> {
    return this.withMutation(() => {
      const closure = this.options.authority.readExecutionV2Preparation(input.graph.goal_id, input.graph.run_id);
      const receipt = finalizeHostNodeReceiptV2({
        graph: input.graph,
        node_id: input.packet.node_id,
        packet_id: input.packet.packet_id,
        packet_sha256: input.packet.packet_sha256,
        proposal_id: input.proposal.proposal_id,
        proposal_sha256: input.proposal.record_sha256,
        kind: input.kind,
        evidence_sha256: input.evidenceSha256,
        preimage_root_sha256: input.preimageRootSha256,
        postimage_root_sha256: input.postimageRootSha256,
        stop_generation: input.packet.stop_generation,
        predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: input.graph.goal_id, receipt,
      }, `dynamic-multi:${receipt.host_node_receipt_id}:receipt`);
      return receipt;
    });
  }

  private async validateNode(
    graph: ExecutionGraphRevisionV2,
    packet: TaskPacketV2,
    proposal: WorkerProposalV2,
    signal: AbortSignal,
  ): Promise<void> {
    const oracle = this.options.oracle;
    const projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
    if (!projection || projection.status !== "RUNNING" || projection.graph.record_sha256 !== graph.record_sha256) return;
    const node = graph.nodes.find((candidate) => candidate.node_id === packet.node_id);
    if (!node) throw new TypeError("Dynamic Multi oracle node is missing");
    const postimageRootSha256 = projection.currentPostimageRootSha256;
    const validation = await oracle.validate({
      graph,
      packet,
      proposal,
      postimage_root_sha256: postimageRootSha256,
      oracle_sha256: node.oracle_sha256,
      oracle_set_sha256: graph.oracle_set_sha256,
      environment_sha256: graph.environment_sha256,
      covered_obligation_ids: node.obligation_ids,
      signal,
    });
    await this.withMutation(() => {
      const current = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
      if (!current || current.status !== "RUNNING" || current.graph.record_sha256 !== graph.record_sha256
        || current.currentPostimageRootSha256 !== postimageRootSha256) {
        throw new TypeError("Dynamic Multi Host oracle result is stale");
      }
      let closure = this.options.authority.readExecutionV2Preparation(graph.goal_id, graph.run_id);
      const oracleReceipt = finalizeHostOracleReceiptV2({
        graph,
        node_id: packet.node_id,
        packet_id: packet.packet_id,
        packet_sha256: packet.packet_sha256,
        proposal_id: proposal.proposal_id,
        proposal_sha256: proposal.record_sha256,
        postimage_root_sha256: postimageRootSha256,
        covered_obligation_ids: node.obligation_ids,
        validation_evidence: validation.validation_evidence,
        predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "RECORD_HOST_ORACLE_RECEIPT_V2", goalId: graph.goal_id, receipt: oracleReceipt,
      }, `dynamic-multi:${oracleReceipt.host_oracle_receipt_id}:oracle`);
      closure = this.options.authority.readExecutionV2Preparation(graph.goal_id, graph.run_id);
      const passed = finalizeHostNodeReceiptV2({
        graph,
        node_id: packet.node_id,
        packet_id: packet.packet_id,
        packet_sha256: packet.packet_sha256,
        proposal_id: proposal.proposal_id,
        proposal_sha256: proposal.record_sha256,
        kind: "ORACLE_PASSED",
        evidence_sha256: oracleReceipt.record_sha256,
        preimage_root_sha256: null,
        postimage_root_sha256: null,
        stop_generation: packet.stop_generation,
        predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: graph.goal_id, receipt: passed,
      }, `dynamic-multi:${passed.host_node_receipt_id}:receipt`);
    });
  }

  private async serialIntegration<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.integrationTail;
    let release!: () => void;
    this.integrationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await action(); }
    finally { release(); }
  }

  private async recordAttemptFailure(
    graph: ExecutionGraphRevisionV2,
    packet: TaskPacketV2,
    lease: ReturnType<typeof finalizeExecutionNodeLeaseV2>,
    error: unknown,
  ): Promise<void> {
    await this.withMutation(() => {
      const retry = packet.attempt <= packet.max_retries;
      const closure = this.options.authority.readExecutionV2Preparation(graph.goal_id, graph.run_id);
      const outcome = finalizeExecutionNodeAttemptOutcomeV2({
        graph,
        packet,
        lease,
        basis: "WORKER_FAILURE",
        disposition: retry ? "REQUEUED" : "FAILED",
        reason_code: retry ? "WORKER_ATTEMPT_RETRY" : "WORKER_ATTEMPTS_EXHAUSTED",
        failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-WORKER-FAILURE-V2", error: String(error) }),
        predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: graph.goal_id, outcome,
      }, `dynamic-multi:${outcome.execution_node_attempt_outcome_id}:outcome`);
    });
  }

  private finalizeProviderInvocationTerminal(
    prepared: ProviderInvocationTransitionV1,
    result: WorkerAttemptResultV2 | null,
    error: unknown,
    createdAtMs: number,
  ): ProviderInvocationTransitionV1 {
    const known = result !== null;
    const costMicrousd = !known || result.usage.cost === null
      ? null
      : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(result.usage.cost * 1_000_000)));
    const failureSha256 = result?.status === "PROPOSED"
      ? null
      : canonicalJsonSha256({
        domain: "PCH-PROVIDER-WORKER-TERMINAL-FAILURE-V1",
        error: error === null ? null : error instanceof Error ? error.message
          : typeof error === "string" ? error : "UNKNOWN_FAILURE",
        status: result?.status ?? "OUTCOME_UNKNOWN",
        protocol: result?.protocol ?? null,
        stopped: result?.stopped ?? null,
      });
    return finalizeProviderInvocationTerminalV1({
      prepared,
      state: known ? "SETTLED" : "OUTCOME_UNKNOWN",
      ...(known ? {
        request_count: result.usage.turns,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_tokens,
        cache_write_tokens: result.usage.cache_write_tokens,
        cost_microusd: costMicrousd,
        wall_time_ms: result.usage.wall_time_ms,
        cache_lineage_sha256: null,
        success_evidence_sha256: result.status === "PROPOSED" ? result.proposal?.record_sha256 ?? null : null,
      } : {}),
      failure_sha256: failureSha256,
      created_at_ms: createdAtMs,
    });
  }

  private async recordProviderInvocationTerminal(
    prepared: ProviderInvocationTransitionV1,
    result: WorkerAttemptResultV2 | null,
    error: unknown,
  ): Promise<ProviderInvocationTransitionV1> {
    return this.withMutation(() => {
      const existing = this.options.authority.readProviderInvocation(prepared.provider_invocation_id);
      if (existing?.ordinal === 1) return existing;
      if (!existing || existing.record_sha256 !== prepared.record_sha256 || existing.state !== "PREPARED") {
        throw new TypeError("Provider invocation prepared authority is unavailable");
      }
      const terminal = this.finalizeProviderInvocationTerminal(prepared, result, error, this.now());
      this.commit({
        type: "RECORD_PROVIDER_INVOCATION_TRANSITION_V1",
        goalId: prepared.goal_id,
        transition: terminal,
      }, `dynamic-multi:${terminal.provider_invocation_id}:provider-terminal`);
      return terminal;
    });
  }

  private async reconcileExpiredAttempts(): Promise<void> {
    const expired = this.options.authority.readExpiredExecutionNodeAttempts(this.options.runId, this.now());
    for (const current of expired) {
      // A locally owned attempt remains single-flight until its Worker/Host processing settles.
      // A replacement process has no such live handle and may reclaim the durable expired lease.
      if (this.active.has(current.packet.node_id) || this.hostProcesses.has(current.packet.node_id)) continue;
      await this.withMutation(() => {
        const projection = this.options.authority.readExecutionV2(this.options.runId, this.maxParallel);
        if (!projection || projection.status !== "RUNNING") return;
        const providerInvocation = this.options.authority.readProviderInvocationByPacket(current.packet.packet_id);
        if (!providerInvocation) throw new TypeError("Expired TaskPacket lacks Provider invocation authority");
        if (providerInvocation.state === "PREPARED") {
          const terminal = finalizeProviderInvocationTerminalV1({
            prepared: providerInvocation,
            state: "OUTCOME_UNKNOWN",
            failure_sha256: canonicalJsonSha256({
              domain: "PCH-PROVIDER-INVOCATION-LEASE-EXPIRY-V1",
              packet: current.packet.packet_sha256,
              lease: current.lease.record_sha256,
            }),
            created_at_ms: this.now(),
          });
          this.commit({
            type: "RECORD_PROVIDER_INVOCATION_TRANSITION_V1",
            goalId: current.packet.goal_id,
            transition: terminal,
          }, `dynamic-multi:${terminal.provider_invocation_id}:provider-expired`);
        }
        const closure = this.options.authority.readExecutionV2Preparation(projection.graph.goal_id, this.options.runId);
        const outcome = finalizeExecutionNodeAttemptOutcomeV2({
          graph: projection.graph,
          packet: current.packet,
          lease: current.lease,
          basis: "LEASE_EXPIRED",
          disposition: "REQUEUED",
          reason_code: "LEASE_TTL_ELAPSED",
          failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-LEASE-EXPIRY-V2", lease: current.lease.record_sha256 }),
          predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
          created_at_ms: this.now(),
        });
        this.commit({
          type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: projection.graph.goal_id, outcome,
        }, `dynamic-multi:${outcome.execution_node_attempt_outcome_id}:expired`);
      });
    }
  }

  private async closeGraph(): Promise<void> {
    await this.withMutation(() => {
      const preparation = this.options.authority.readExecutionGraphTerminalPreparation(this.options.runId);
      const receipt = finalizeExecutionGraphTerminalReceiptV2({
        graph: preparation.graph,
        terminal_status: preparation.terminalStatus,
        reason_code: preparation.terminalStatus === "CLOSED" ? "ALL_CURRENT_NODES_ORACLE_PASSED" : "EXECUTION_ROUTE_EXHAUSTED",
        current_postimage_root_sha256: preparation.currentPostimageRootSha256,
        integration_frontier_sha256: preparation.integrationFrontierSha256,
        node_frontier: preparation.nodeFrontier,
        failure_evidence_sha256: preparation.failureEvidenceSha256,
        predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "RECORD_EXECUTION_GRAPH_TERMINAL_V2", goalId: preparation.graph.goal_id, receipt,
      }, `dynamic-multi:${receipt.execution_graph_terminal_receipt_id}:terminal`);
    });
  }

  private async stopGraph(
    reason: "USER_CANCEL" | "NO_PROGRESS" | "INTEGRATION_RECONCILIATION_REQUIRED" | "AUTHORIZATION_REVOKED",
  ): Promise<void> {
    await this.withMutation(() => {
      const preparation = this.options.authority.readExecutionStopPreparation(this.options.runId);
      if (!preparation) return;
      const stop = finalizeExecutionStopV2({
        graph: preparation.graph,
        stop_generation: preparation.stopGeneration + 1,
        scope: "GRAPH_STOP",
        reason,
        affected_node_ids: preparation.graph.nodes.map((node) => node.node_id),
        predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
        created_at_ms: this.now(),
      });
      this.commit({
        type: "STOP_EXECUTION_V2", goalId: preparation.graph.goal_id, stop,
      }, `dynamic-multi:${stop.execution_stop_id}:stop`);
    });
  }

  private async transact(
    command: Parameters<AuthorityStore["transactExecutionV2"]>[0],
    idempotencyKey: string,
  ): Promise<CommandResult> {
    return this.withMutation(() => this.commit(command, idempotencyKey));
  }

  private commit(
    command: Parameters<AuthorityStore["transactExecutionV2"]>[0],
    idempotencyKey: string,
  ): CommandResult {
    return this.options.mutation.transact(command, idempotencyKey);
  }

  private async withMutation<T>(action: () => T | Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
