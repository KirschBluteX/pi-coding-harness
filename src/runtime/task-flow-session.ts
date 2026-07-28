import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import { canonicalJson, canonicalJsonSha256, omitProperty } from "../authority/canonical-json.js";
import type { LeaseToken } from "../authority/lease.js";
import type { MutationMeta } from "../authority/transactions.js";
import type { TaskFlowDetail, TaskFlowStatusView } from "./task-flow-view.js";
import type { ToolInvocation } from "../effects/normalize.js";
import {
  applyPatchFile, journalPreimage, patchTransactionArtifacts, preparePatchTransaction,
  readPatchTransactionJournal, removePatchCreatedDirectories, restorePatchTransactionPreimage,
  type PatchTransactionJournalEntry,
} from "../effects/patch-transaction.js";
import { buildMemoryWorkingSet, memoryContextMessage, type MemoryContextMessage } from "../memory/context-projector.js";
import type { MemoryCommandRequest } from "../memory/commands.js";
import type { InputContextSeed } from "../input-context/runtime.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { createId, idFromSha256 } from "../foundation/ids.js";
import { recoverPromptGenerationObservation } from "./recovery.js";
import {
  CodingHarnessServices, type CodingHarnessResources, type CodingHarnessServiceOptions,
} from "./coding-harness-services.js";
import type { PromptGenerationRecord } from "../context/prompt-generation.js";
import type { ActiveGoalBinding } from "./active-goal.js";
import { classifyTaskFlowInput } from "../task-flow/admission.js";
import {
  makeExecutionSubjectRef, sealTaskFlowRecord, type DeliverableManifestRecord,
  type ExecutionAuthorizationRecord, type ExecutionSubjectRef, type GoalContractRecord, type RouteSkeletonRecord,
  type TaskDecisionEntryRecord, type WorkCellRecord, type WorkspaceBaselineRecord,
} from "../task-flow/domain.js";
import {
  finalizeGoalContract, finalizeRoute, type GoalContractProposal, type RouteProposal,
} from "../task-flow/finalize.js";
import {
  applyRouteRevisionPatch, routeExecutionSemanticsSha256, type RouteRevisionPatch,
} from "../task-flow/route-revision.js";
import { TaskFlowKernel } from "../task-flow/kernel.js";
import type { TaskFlowCurrentView } from "../task-flow/repository.js";
import type { RouteHealthInput } from "../task-flow/health.js";
import {
  TaskFlowOperationLifecycle,
  type TaskFlowAttestationInput,
  type TaskFlowOperationAdapter,
  type TaskFlowOperationAdmission,
} from "../task-flow/operation-lifecycle.js";
import { createClarificationBatch, type ClarificationDecision } from "../planning/clarification.js";
import { inferAcceptanceFacetMinimum } from "../planning/intake-classifier.js";
import {
  makeExecutionSubjectRefV2, packetContentSha256, sealHarnessRecord,
  type IntegrationReceiptRecord, type PatchEntry, type PatchSetRecord,
  type ShardLeaseGenerationRecord, type TaskPacketRecord, type WorkerResultRecord,
  type WorkerRunRecord, type WorkerRunTransitionRecord, type WorkerUsage,
  type ExecutionTopology,
  type ManagedRunRecord,
  type TopologyRevisionRecord,
  type WorkerRole,
  type WorkShardRecord,
} from "../harness/domain.js";
import type { HarnessCurrentView, OpenPatchTransactionView } from "../harness/repository.js";
import type { ArtifactRecord } from "../artifacts/artifact-store.js";
import {
  compactionCapsuleSha256, compactionTransitionSha256,
  type HarnessCompactionAttempt, type HarnessCompactionCapsule, type HarnessCompactionTransition,
} from "../context/compaction-v21/domain.js";
import {
  targetPerformanceContract, targetPerformancePhase, targetPerformancePrompt,
} from "../performance/task-flow-policy.js";
import { createCurrentControlFrame, type CurrentControlFrame } from "../control/control-frame.js";

const secretPattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|authorization\s*["']?\s*[:=]\s*["']?(?:bearer\s+)?\S{8,}|(?:api[_-]?key|password|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?\S{8,})/iu;
const ignoredBaselineDirectories = new Set([".git", ".coding-harness", "node_modules", "dist", "build", ".cache"]);
const maximumBaselineFiles = 4_096;
const maximumBaselineBytes = 64 * 1024 * 1024;
const maximumDirectBaselineFiles = 128;
const maximumDirectBaselineBytes = 8 * 1024 * 1024;
const maximumDependencyEvidenceBytes = 24 * 1024;
const maximumDependencyEvidenceItemBytes = 8 * 1024;
const maximumAuthorityProposalBytes = 256 * 1024;
const maximumWorkerNarrativeBytes = 256 * 1024;
const maximumWorkerPatchBytes = 64 * 1024 * 1024;
const goalContractProposalGuide = "GoalContract proposal shape (submit only these proposal fields, not frozen IDs/schema): {\"user_outcomes\":[\"...\"],\"scope\":[\"relative/path\"],\"non_goals\":[],\"constraints\":[],\"assumption_refs\":[],\"decision_refs\":[],\"obligations\":[{\"key\":\"stable-key\",\"priority\":\"MUST\",\"statement\":\"...\",\"oracle\":{\"commands\":[\"<exact local command>\"]},\"dependencies\":[]}],\"acceptance_policy\":{},\"authorization_ceiling\":\"LOCAL_REVERSIBLE\"}.";
const routeProposalGuide = "Route proposal shape (submit only these fields; obligation_keys reference GoalContract keys): {\"lane\":\"DIRECT_CELL|ADAPTIVE_ROUTE\",\"outcomes\":[\"...\"],\"work_cells\":[{\"key\":\"change\",\"outcome\":\"...\",\"obligation_keys\":[\"stable-key\"],\"dependencies\":[],\"read_roots\":[\"relative/path\"],\"write_roots\":[\"relative/path\"],\"effect_classes\":[\"LOCAL_REVERSIBLE\"],\"oracle\":{\"commands\":[\"<same exact local command>\"]},\"risk\":\"LOW\",\"reversible\":true}],\"near_horizon\":[\"change\"],\"assumptions\":[{\"key\":\"...\",\"statement\":\"...\",\"status\":\"SUPPORTED|OPEN|INVALIDATED\",\"evidence_refs\":[]}],\"risks\":[{\"key\":\"...\",\"statement\":\"...\",\"likelihood\":\"LOW|MEDIUM|HIGH\",\"impact\":\"LOW|MEDIUM|HIGH|CRITICAL\",\"mitigation\":\"...\",\"evidence_refs\":[]}],\"alternatives\":[{\"key\":\"...\",\"summary\":\"...\",\"disposition\":\"SELECTED|RESERVE|REJECTED\",\"reason\":\"...\",\"evidence_refs\":[]}],\"deferred_outcomes\":[{\"key\":\"...\",\"outcome\":\"...\",\"obligation_keys\":[\"stable-key\"],\"dependencies\":[],\"expansion_trigger\":\"WORK_CELL_CLOSED|EVIDENCE_CHANGED|DECISION_RESOLVED\",\"commitment\":\"REVERSIBLE|EXPENSIVE_TO_REVERSE|USER_AUTHORITY_REQUIRED\",\"evidence_refs\":[]}]}. Optional arrays may be omitted when empty; do not invent fields such as evidence, failure_recovery, scope, performance_cost or waiting_cost.";
const routeRevisionPatchGuide = "RouteRevision patch shape: {\"work_cells\":[{\"key\":\"repaired-current-work\",\"outcome\":\"...\",\"obligation_keys\":[\"stable-key\"],\"dependencies\":[],\"read_roots\":[\"relative/path\"],\"write_roots\":[\"relative/path\"],\"effect_classes\":[\"LOCAL_REVERSIBLE\"],\"oracle\":{\"commands\":[\"<exact local command>\"]},\"risk\":\"LOW\",\"reversible\":true}],\"assumptions\":[{\"key\":\"replacement-assumption\",\"statement\":\"...\",\"status\":\"SUPPORTED\",\"evidence_refs\":[]}]}. work_cells replaces the old active horizon; omitted outcomes/risks/alternatives/deferred_outcomes are preserved. near_horizon defaults to the submitted WorkCell keys. Host expands this patch and reruns every full RouteSkeleton check.";

interface BaselineHashEntry {
  readonly stamp: string;
  readonly sha256: string;
}

interface ActiveTaskFlowState {
  readonly goalId: string;
  readonly objective: string;
  readonly objectiveSha256: string;
  readonly sourceIntakeSha256: string;
  readonly acceptanceFacetMinimum: number;
  version: number;
  lease: LeaseToken;
  view: TaskFlowCurrentView;
  blocker: string | null;
  contractRevisionRequested: boolean;
}

export type { TaskFlowAttestationInput, TaskFlowOperationAdmission };

export interface ClarificationSelection extends ClarificationDecision {
  readonly selectedOptionId: string | null;
}

export interface HarnessShardProposal {
  readonly key: string;
  readonly role: WorkerRole;
  readonly outcome: string;
  readonly dependencies?: readonly string[];
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly packet_budget?: Readonly<Record<string, unknown>>;
}

export interface HarnessWorkerExecution {
  readonly shard: WorkShardRecord;
  readonly packet: TaskPacketRecord;
  readonly lease: ShardLeaseGenerationRecord;
  readonly worker: WorkerRunRecord;
  readonly runningTransitionSha256: string;
  readonly baselineSha256: string;
  readonly baselineContentRootSha256: string;
  readonly dependencyEvidence: readonly {
    readonly shardId: string;
    readonly role: WorkShardRecord["role"];
    readonly resultKind: WorkerResultRecord["result_kind"];
    readonly artifactSha256: string;
    readonly trust: WorkerResultRecord["trust"];
    readonly content: string;
  }[];
}

export interface HarnessWorkerPatchInput {
  readonly operation: PatchEntry["operation"];
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly content: Uint8Array | null;
}

export interface HarnessWorkerSubmission {
  readonly execution: HarnessWorkerExecution;
  readonly output: string;
  readonly usage: WorkerUsage;
  readonly patches: readonly HarnessWorkerPatchInput[];
}

export interface HarnessSubmittedResult {
  readonly result: WorkerResultRecord;
  readonly patchSet: PatchSetRecord | null;
  readonly integrated: boolean;
}

function contained(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function normalizedRelativeRoot(workspace: string, value: string): { readonly relative: string; readonly absolute: string } {
  const text = value.normalize("NFC").trim().replaceAll("\\", "/");
  if (!text || isAbsolute(text)) throw new TypeError(`Task Flow scope must be workspace-relative: ${value}`);
  const absolute = resolve(workspace, text);
  if (!contained(workspace, absolute)) throw new TypeError(`Task Flow scope escapes the workspace: ${value}`);
  if (existsSync(absolute)) {
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink() || !contained(workspace, realpathSync(absolute))) {
      throw new TypeError(`Task Flow scope resolves through or to an unsafe link: ${value}`);
    }
  }
  return { relative: relative(workspace, absolute).replaceAll("\\", "/") || ".", absolute };
}

function publishImmutable(path: string, value: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value) throw new AuthorityIntegrityError(`Immutable Task Flow projection differs: ${path}`);
    return;
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function statusMode(view: TaskFlowCurrentView): "PLAN" | "BUILD" {
  return view.status === "BUILDING" ? "BUILD" : "PLAN";
}

function routeHealth(view: TaskFlowCurrentView): string {
  return view.latestHealth?.level ?? (view.status === "RECONCILING" ? "H5_RECONCILE_OR_STOP" : "H0_CONTINUE");
}

function artifactMetadata(record: ArtifactRecord): Omit<ArtifactRecord, "created"> {
  return omitProperty(record, "created");
}

function emptyWorkerUsage(): WorkerUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, cost: null, turns: 0, wallTimeMs: 0 };
}

function assertSafeAuthorityPayload(value: unknown, label: string, maximumBytes = maximumAuthorityProposalBytes): void {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new TypeError(`${label} exceeds its bounded persistence budget`);
  if (secretPattern.test(serialized)) throw new TypeError(`${label} contains secret-like material and cannot be persisted`);
}

export class TaskFlowSession {
  private readonly now: () => number;
  private readonly services: CodingHarnessServices;
  private active: ActiveTaskFlowState | null = null;
  private cwd: string | null = null;
  private sessionId: string | null = null;
  private workspaceId: string | null = null;
  private kernel: TaskFlowKernel | null = null;
  private operationLifecycle: TaskFlowOperationLifecycle | null = null;
  private pendingCompactionAttemptId: string | null = null;
  private compactionRecoveryRequired = false;
  private readonly baselineHashCache = new Map<string, BaselineHashEntry>();

  constructor(private readonly options: CodingHarnessServiceOptions) {
    this.now = options.now ?? Date.now;
    this.services = new CodingHarnessServices({
      ...options,
      inputContextMigrationPath: resolve(options.packageRoot, "schemas", "sql", "012_input_context_v1.sql"),
      harnessMigrationPath: options.harnessMigrationPath
        ?? resolve(options.packageRoot, "schemas", "sql", "013_coding_harness_v1.sql"),
    });
  }

  initialize(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
    if (this.kernel) return;
    this.services.initialize(ctx);
    const resources = this.requiredResources();
    this.cwd = resolve(ctx.cwd);
    this.sessionId = ctx.sessionManager.getSessionId();
    const workspaceHmac = hmacSha256Hex(resources.workspaceSecret, this.cwd.replaceAll("\\", "/").toLowerCase().normalize("NFC"));
    this.workspaceId = idFromSha256("WS", workspaceHmac);
    this.kernel = new TaskFlowKernel(resources.authority, { now: this.now, monotonicNow: this.now });
    this.operationLifecycle = this.createOperationLifecycle(resources);
    this.reconcileTerminalManagedRun(resources);
    const existing = resources.authority.readActiveTaskFlowGoal(this.workspaceId, this.sessionId)
      ?? resources.authority.readActiveTaskFlowGoal(this.workspaceId);
    if (existing) {
      const lease = resources.authority.acquireLease(existing.goalId, this.sessionId, this.options.config.execution.lease_ttl_ms);
      const recovered = this.kernel.recover(existing.goalId);
      this.active = {
        goalId: existing.goalId, objective: existing.objective, objectiveSha256: existing.objectiveSha256,
        sourceIntakeSha256: recovered.view.contract?.source_intake_sha256 ?? sha256Hex(existing.objective),
        acceptanceFacetMinimum: existing.acceptanceFacetMinimum,
        version: existing.version, lease, view: recovered.view, blocker: recovered.requiresReconciliation ? "Operation outcome requires reconciliation." : null,
        contractRevisionRequested: recovered.view.contract !== null
          && recovered.view.status === "CONTRACTING"
          && recovered.view.nextActionCode === "SUBMIT_CONTRACT",
      };
      const harness = resources.authority.readHarnessView(existing.goalId);
      const openCompaction = harness ? resources.authority.readOpenHarnessCompaction(harness.runId) : null;
      if (openCompaction) {
        this.pendingCompactionAttemptId = openCompaction.attempt.attempt_id;
        this.compactionRecoveryRequired = true;
        this.active.blocker = "Compaction recovery required; use /coding resume or coding_flow control=resume before continuing.";
      }
      this.recoverOpenPatchTransactions();
      this.syncMemoryContext();
    }
  }

  resources(): CodingHarnessResources | null { return this.services.resources(); }

  createHarnessRun(input: {
    readonly topology: ExecutionTopology;
    readonly createdByHostHmac: string;
    readonly configSha256: string;
    readonly decisionSha256: string;
  }): HarnessCurrentView {
    const state = this.requiredActive();
    const resources = this.requiredResources();
    const existing = resources.authority.readHarnessView(state.goalId);
    if (existing) {
      if (existing.effectiveTopology !== input.topology) throw new TypeError("Recovered Harness topology differs from the requested topology");
      this.recoverHarnessWorkers(existing);
      return resources.authority.readHarnessView(state.goalId)!;
    }
    this.ensureLease();
    const run = sealHarnessRecord<ManagedRunRecord, "record_sha256">("PCH-MANAGED-RUN-V1", {
      schema_version: 1, run_id: idFromSha256("RUN", sha256Hex(`${state.goalId}\0PCH`)), goal_id: state.goalId,
      workspace_id: this.requiredWorkspaceId(), created_by_host_hmac: input.createdByHostHmac,
      initial_config_sha256: input.configSha256, created_at_ms: this.now(),
    }, "record_sha256");
    const topology = sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
      schema_version: 1, run_id: run.run_id, revision: 1, requested_topology: input.topology,
      effective_topology: input.topology, reason_code: "USER_SELECTED", decision_sha256: input.decisionSha256,
      config_sha256: input.configSha256, created_at_ms: this.now(),
    }, "record_sha256");
    const result = resources.authority.transactHarness({ type: "CREATE_MANAGED_RUN", goalId: state.goalId, run, topology },
      this.mutation(`coding-harness:create:${run.record_sha256}`));
    state.version = result.goalVersion;
    return resources.authority.readHarnessView(state.goalId)!;
  }

  harnessView(): HarnessCurrentView | null {
    return this.active ? this.requiredResources().authority.readHarnessView(this.active.goalId) : null;
  }

  openClarifications(): readonly ClarificationDecision[] {
    const state = this.active;
    if (!state) return [];
    return this.requiredResources().authority.readOpenTaskFlowClarifications(state.goalId).map((record) => {
      const stored = record.recommendation.clarification;
      if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
        throw new TypeError(`Clarification ${record.decision_key} cannot be recovered from authority`);
      }
      const decision = stored as unknown as ClarificationDecision;
      const batch = createClarificationBatch([decision]);
      if (batch.decisions.length !== 1
        || record.decision_key !== `CLARIFICATION:${decision.id}`.slice(0, 160)
        || record.materiality !== decision.materiality || record.reversible !== decision.reversible
        || record.privacy_related !== decision.privacyRelated
        || record.question_hmac !== hmacSha256Hex(this.requiredResources().workspaceSecret, decision.question)
        || record.recommendation.option_id !== decision.recommendedOptionId
        || record.recommendation.reason !== decision.recommendationReason) {
        throw new TypeError(`Clarification ${record.decision_key} authority binding is invalid`);
      }
      const bindingSha256 = canonicalJsonSha256({
        goal: state.goalId, contract: state.view.contract?.record_sha256 ?? null,
        route: state.view.route?.record_sha256 ?? null, decision,
      });
      if (record.binding_sha256 !== bindingSha256) throw new TypeError(`Clarification ${decision.id} is stale or corrupted`);
      return decision;
    });
  }

  workspaceRoot(): string { return this.requiredCwd(); }

  defineHarnessShards(proposals: readonly HarnessShardProposal[]): HarnessCurrentView {
    const state = this.requiredActive();
    const resources = this.requiredResources();
    const harness = resources.authority.readHarnessView(state.goalId);
    const cell = this.currentCell();
    if (!harness || harness.effectiveTopology !== "MULTI" || !cell || state.view.workCellId !== cell.work_cell_id) {
      throw new TypeError("Multi shard definition requires the current authorized WorkCell");
    }
    if (harness.shards.some((shard) => shard.workCellId === cell.work_cell_id)) throw new TypeError("Current WorkCell already has a shard graph");
    if (proposals.length === 0 || proposals.length > 32) throw new TypeError("Multi WorkCell requires 1..32 bounded shard proposals");
    const ids = new Map(proposals.map((proposal) => [proposal.key, idFromSha256("SHARD", sha256Hex(`${harness.runId}\0${cell.work_cell_id}\0${proposal.key}`))]));
    if (ids.size !== proposals.length) throw new TypeError("Shard proposal keys must be unique");
    const shards = proposals.map((proposal, ordinal) => sealHarnessRecord<WorkShardRecord, "spec_sha256">("PCH-WORK-SHARD-V1", {
      schema_version: 1, shard_id: ids.get(proposal.key)!, run_id: harness.runId, goal_id: state.goalId,
      work_cell_id: cell.work_cell_id, logical_key: proposal.key, ordinal, role: proposal.role, outcome: proposal.outcome,
      dependencies: (proposal.dependencies ?? []).map((key) => {
        const id = ids.get(key); if (!id) throw new TypeError(`Unknown shard dependency ${key}`); return id;
      }),
      read_roots: proposal.read_roots, write_roots: proposal.write_roots, oracle: proposal.oracle,
      packet_budget: proposal.packet_budget ?? { max_attempts: 2 },
    }, "spec_sha256"));
    const result = resources.authority.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: state.goalId, runId: harness.runId, workCellId: cell.work_cell_id, shards,
    }, this.mutation(`coding-harness:multi:define:${canonicalJsonSha256(shards.map((shard) => shard.spec_sha256))}`));
    state.version = result.goalVersion;
    return resources.authority.readHarnessView(state.goalId)!;
  }

  startNextHarnessWorker(input: {
    readonly modelFingerprintHmacByRole: Readonly<Record<WorkerRole, string>>;
    readonly ownerHmac: string;
  }): HarnessWorkerExecution {
    const state = this.requiredActive();
    const resources = this.requiredResources();
    const harness = resources.authority.readHarnessView(state.goalId);
    const contract = state.view.contract; const route = state.view.route; const authorization = state.view.authorization;
    if (!harness || harness.effectiveTopology !== "MULTI" || !harness.nextReadyShardId || !contract || !route || !authorization) {
      throw new TypeError("No authority-ready MULTI WorkShard is available");
    }
    const detail = resources.authority.readHarnessShard(state.goalId, harness.nextReadyShardId);
    const baseline = resources.authority.readLatestTaskFlowBaseline(state.goalId);
    const currentCell = this.currentCell();
    if (!detail || detail.status !== "READY" || detail.spec.role === "SUPERVISOR" || !baseline
      || !currentCell || currentCell.work_cell_id !== detail.spec.work_cell_id) {
      throw new AuthorityIntegrityError("Ready WorkShard execution closure is incomplete");
    }
    const attempt = detail.attemptCount + 1;
    const workerTimeoutMs = this.options.config.execution.worker_timeout_ms ?? 900_000;
    const expiresAtMs = Math.min(
      authorization.expires_at_ms,
      this.now() + Math.max(this.options.config.execution.lease_ttl_ms, workerTimeoutMs + 5_000),
    );
    if (expiresAtMs <= this.now()) throw new TypeError("WorkShard authorization has expired");
    const subject = makeExecutionSubjectRefV2({
      kind: "WORK_SHARD", run_id: harness.runId, goal_id: state.goalId, work_cell_id: detail.spec.work_cell_id,
      shard_id: detail.spec.shard_id, worker_run_id: null, role: detail.spec.role,
      topology_revision: harness.topologyRevision, attempt, goal_contract_sha256: contract.record_sha256,
      route_sha256: route.record_sha256, authorization_sha256: authorization.record_sha256,
    });
    const packetId = idFromSha256("PACKET", sha256Hex(`${detail.spec.shard_id}\0${attempt}\0${subject.binding_sha256}`));
    const sharedMemory = this.sharedWorkerMemory(harness.runId, detail.spec.outcome);
    let remainingDependencyBytes = maximumDependencyEvidenceBytes;
    const dependencyEvidence = detail.dependencyEvidence.map((evidence) => {
      const bytes = Buffer.from(resources.artifacts.open(`pch-cas://sha256/${evidence.artifactSha256}`));
      const included = Math.min(bytes.byteLength, maximumDependencyEvidenceItemBytes, remainingDependencyBytes);
      remainingDependencyBytes -= included;
      const decoded = included === 0 ? "" : bytes.subarray(0, included).toString("utf8");
      return {
        ...evidence,
        content: included === bytes.byteLength ? decoded
          : `${decoded}${decoded ? "\n" : ""}[dependency output omitted after bounded evidence budget]`,
      };
    });
    const packetContent = {
      schema_version: 1 as const, packet_id: packetId, run_id: harness.runId, shard_id: detail.spec.shard_id, attempt,
      subject_binding_sha256: subject.binding_sha256, task: detail.spec.outcome,
      goal_contract_sha256: contract.record_sha256, route_sha256: route.record_sha256,
      work_cell_sha256: currentCell.spec_sha256,
      evidence_refs: [...new Set([
        ...dependencyEvidence.map((evidence) => evidence.artifactSha256),
        ...(sharedMemory?.binding_sha256s ?? []),
      ])], shared_memory: sharedMemory,
      failure_signatures: [], expires_at_ms: expiresAtMs,
    };
    const packetSha256 = packetContentSha256(packetContent);
    const packet: TaskPacketRecord = {
      ...packetContent, packet_sha256: packetSha256,
      capability_hmac: hmacSha256Hex(resources.workspaceSecret, `packet:${packetSha256}`),
    };
    const lease = sealHarnessRecord<ShardLeaseGenerationRecord, "lease_sha256">("PCH-SHARD-LEASE-V1", {
      schema_version: 1, shard_id: detail.spec.shard_id, generation: detail.latestLeaseGeneration + 1,
      fencing_token: detail.latestFencingToken + 1, owner_hmac: input.ownerHmac, expires_at_ms: expiresAtMs,
    }, "lease_sha256");
    let result = resources.authority.transactHarness({ type: "LEASE_WORK_SHARD", goalId: state.goalId, packet, subject, lease },
      this.mutation(`coding-harness:worker:lease:${packet.packet_sha256}`));
    state.version = result.goalVersion;
    const workerId = idFromSha256("WORKER", sha256Hex(`${packet.packet_sha256}\0${lease.lease_sha256}`));
    const worker = sealHarnessRecord<WorkerRunRecord, "record_sha256">("PCH-WORKER-RUN-V1", {
      schema_version: 1, worker_run_id: workerId, run_id: harness.runId, shard_id: detail.spec.shard_id,
      packet_id: packet.packet_id, role: detail.spec.role, attempt, lease_generation: lease.generation,
      fencing_token: lease.fencing_token, sandbox_kind: "SCOPED_MIRROR",
      model_fingerprint_hmac: input.modelFingerprintHmacByRole[detail.spec.role],
      created_at_ms: this.now(),
    }, "record_sha256");
    const workerSubject = makeExecutionSubjectRefV2({
      ...subject, kind: "WORKER_RUN", worker_run_id: workerId,
    });
    const starting = this.workerTransition(workerId, 0, "STARTING", null, emptyWorkerUsage(), null, null);
    result = resources.authority.transactHarness({ type: "START_WORKER_RUN", goalId: state.goalId, worker, subject: workerSubject, transition: starting },
      this.mutation(`coding-harness:worker:start:${worker.record_sha256}`));
    state.version = result.goalVersion;
    const running = this.workerTransition(workerId, 1, "RUNNING", null, emptyWorkerUsage(), null, starting.transition_sha256);
    result = resources.authority.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: state.goalId, transition: running },
      this.mutation(`coding-harness:worker:running:${running.transition_sha256}`));
    state.version = result.goalVersion;
    return {
      shard: detail.spec, packet, lease, worker, runningTransitionSha256: running.transition_sha256,
      baselineSha256: baseline.record_sha256, baselineContentRootSha256: baseline.content_root_sha256,
      dependencyEvidence,
    };
  }

  submitHarnessWorkerResult(input: HarnessWorkerSubmission): HarnessSubmittedResult {
    const state = this.requiredActive(); const resources = this.requiredResources();
    const execution = input.execution;
    if (Buffer.byteLength(input.output, "utf8") > maximumWorkerNarrativeBytes) throw new TypeError("Coding Harness Worker narrative exceeds its bounded persistence budget");
    if (secretPattern.test(input.output)) throw new TypeError("Coding Harness rejected secret-like Worker output before persistence");
    if (input.patches.length > 256) throw new TypeError("Coding Harness Worker patch count exceeds its bound");
    let patchBytes = 0;
    const patchPaths = new Set<string>();
    for (const patch of input.patches) {
      if (!/^(?:CREATE|MODIFY|DELETE)$/u.test(patch.operation)) throw new TypeError("Coding Harness Worker patch operation is invalid");
      if (patch.beforeSha256 !== null && !/^[a-f0-9]{64}$/u.test(patch.beforeSha256)) throw new TypeError("Coding Harness Worker patch preimage is invalid");
      if (patch.operation === "CREATE" && patch.beforeSha256 !== null) throw new TypeError("CREATE patch cannot carry a preimage");
      if (patch.operation !== "CREATE" && patch.beforeSha256 === null) throw new TypeError(`${patch.operation} patch requires a preimage`);
      if ((patch.operation === "DELETE") !== (patch.content === null)) throw new TypeError(`${patch.operation} patch content contract is invalid`);
      const normalized = normalizedRelativeRoot(this.requiredCwd(), patch.path);
      if (!this.targetWithinRoots(normalized.absolute, execution.shard.write_roots)) {
        throw new TypeError("Coding Harness rejected a Worker patch outside its shard write scope before persistence");
      }
      if (patchPaths.has(normalized.relative)) throw new TypeError("Coding Harness Worker patch contains duplicate paths");
      patchPaths.add(normalized.relative);
      patchBytes += patch.content?.byteLength ?? 0;
      if ((patch.content?.byteLength ?? 0) > 8 * 1024 * 1024) throw new TypeError("Coding Harness Worker patch file exceeds its bound");
      if (patchBytes > maximumWorkerPatchBytes) throw new TypeError("Coding Harness Worker patch exceeds its bounded persistence budget");
    }
    const outputArtifact = resources.artifacts.put(input.output || "[worker produced no narrative output]", {
      mediaType: "text/markdown", classification: "INTERNAL", retentionClass: "GOAL",
    });
    const artifacts: ArtifactRecord[] = [outputArtifact];
    const patchEntries: PatchEntry[] = input.patches.map((patch) => {
      if (patch.operation === "DELETE") {
        if (patch.content !== null) throw new TypeError("DELETE patch cannot carry postimage content");
        return { operation: patch.operation, path: patch.path, before_sha256: patch.beforeSha256, after_sha256: null, content_locator: null, byte_length: 0 };
      }
      if (patch.content === null) throw new TypeError(`${patch.operation} patch requires postimage content`);
      if (secretPattern.test(Buffer.from(patch.content).toString("utf8"))) {
        throw new TypeError("Coding Harness rejected secret-like Worker patch content before persistence");
      }
      const artifact = resources.artifacts.put(patch.content, {
        mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
      });
      artifacts.push(artifact);
      return {
        operation: patch.operation, path: patch.path, before_sha256: patch.beforeSha256,
        after_sha256: artifact.sha256, content_locator: artifact.locator, byte_length: artifact.byteLength,
      };
    });
    const patchSet = patchEntries.length === 0 ? null : sealHarnessRecord<PatchSetRecord, "patch_sha256">("PCH-PATCH-SET-V1", {
      schema_version: 1, patch_set_id: idFromSha256("PATCH", sha256Hex(`${execution.worker.worker_run_id}\0${canonicalJsonSha256(patchEntries)}`)),
      run_id: execution.worker.run_id, shard_id: execution.shard.shard_id, worker_run_id: execution.worker.worker_run_id,
      baseline_sha256: execution.baselineSha256, entries: patchEntries, created_at_ms: this.now(),
    }, "patch_sha256");
    const resultKind: WorkerResultRecord["result_kind"] = patchSet
      ? execution.worker.role === "INTEGRATOR" ? "INTEGRATION" : "PATCH"
      : execution.worker.role === "PLANNER" ? "PLAN" : execution.worker.role === "EXPLORER" ? "ANALYSIS"
        : execution.worker.role === "VERIFIER" ? "VERIFICATION" : "NO_CHANGES";
    const workerResult = sealHarnessRecord<WorkerResultRecord, "record_sha256">("PCH-WORKER-RESULT-V1", {
      schema_version: 1, result_id: idFromSha256("RESULT", sha256Hex(`${execution.worker.worker_run_id}\0${outputArtifact.sha256}`)),
      worker_run_id: execution.worker.worker_run_id, run_id: execution.worker.run_id, shard_id: execution.shard.shard_id,
      result_kind: resultKind, artifact_sha256: outputArtifact.sha256,
      artifact_locator_hmac: hmacSha256Hex(resources.workspaceSecret, outputArtifact.locator), trust: "UNVERIFIED", created_at_ms: this.now(),
    }, "record_sha256");
    const succeeded = this.workerTransition(execution.worker.worker_run_id, 2, "SUCCEEDED", outputArtifact.sha256,
      input.usage, null, execution.runningTransitionSha256);
    const authority = resources.authority.transactHarness({
      type: "SUBMIT_WORKER_RESULT", goalId: state.goalId, result: workerResult, transition: succeeded, patchSet,
      artifacts: artifacts.map(artifactMetadata),
    }, this.mutation(`coding-harness:worker:result:${workerResult.record_sha256}`));
    state.version = authority.goalVersion;
    if (!patchSet) {
      this.recordHarnessIntegration(execution, null, "NO_CHANGES", execution.baselineContentRootSha256, [], []);
      return { result: workerResult, patchSet: null, integrated: true };
    }
    return { result: workerResult, patchSet, integrated: false };
  }

  integrateHarnessPatch(execution: HarnessWorkerExecution, patchSet: PatchSetRecord): IntegrationReceiptRecord {
    const resources = this.requiredResources(); const cwd = this.requiredCwd(); const state = this.requiredActive();
    const prepared = preparePatchTransaction({
      cwd, goalId: state.goalId, preimageRootSha256: execution.baselineContentRootSha256,
      patchSet, artifacts: resources.artifacts,
    });
    const preparation = resources.authority.transactHarness({
      type: "PREPARE_PATCH_TRANSACTION", goalId: state.goalId, runId: patchSet.run_id,
      shardId: patchSet.shard_id, patchSetId: patchSet.patch_set_id,
      journalSha256: prepared.journalArtifact.sha256,
      journalArtifact: artifactMetadata(prepared.journalArtifact),
      preimageArtifacts: patchTransactionArtifacts(prepared).slice(1),
    }, this.mutation(`coding-harness:patch-transaction:prepare:${prepared.journalArtifact.sha256}`));
    state.version = preparation.goalVersion;
    this.refresh();
    this.options.onPatchTransactionFault?.("AFTER_PREPARE", null);
    if (prepared.journal.conflict_paths.length > 0) {
      const receipt = this.recordHarnessIntegration(
        execution, patchSet, "CONFLICT", null, prepared.journal.conflict_paths, [], prepared.journalArtifact.sha256,
      );
      this.assessHarnessIntegrationFailure(execution, receipt);
      return receipt;
    }
    const operationIds: string[] = [];
    const applied: PatchTransactionJournalEntry[] = [];
    let applyError: Error | null = null;
    let uncertainOutcome = false;
    for (const entry of prepared.journal.entries) {
      const content = prepared.postimages.get(entry.path) ?? null;
      const absolute = normalizedRelativeRoot(cwd, entry.path).absolute;
      const expectedPreimage = entry.observed_before_sha256 ?? sha256Hex("PCH-ABSENT-V1");
      const callId = idFromSha256("CALL", sha256Hex(`${patchSet.patch_sha256}\0APPLY\0${entry.path}`));
      const admission = this.prepareHarnessPatchOperation(callId, cwd, entry.operation, entry.path, entry.expected_after_sha256);
      if (!admission.allow) { applyError = new Error(admission.reason ?? "Patch integration was rejected"); break; }
      try {
        this.ensureLease();
        resources.authority.withLeaseFence(this.requiredActive().lease, () => {
          if (this.hashTarget(absolute) !== expectedPreimage) {
            throw new AuthorityIntegrityError(`Patch transaction preimage changed after prepare: ${entry.path}`);
          }
          applyPatchFile(absolute, entry.operation, content);
        });
      } catch (error) {
        applyError = error instanceof Error ? error : new Error(String(error));
        this.observeToolResult(callId, true, applyError.message);
        break;
      }
      this.options.onPatchTransactionFault?.("AFTER_APPLY", entry.path);
      const note = this.observeToolResult(callId, false, patchSet.patch_sha256) ?? "";
      const operationId = /operation=([^;\s]+)/u.exec(note)?.[1];
      if (!operationId) {
        applyError = new AuthorityIntegrityError("Deterministic integration did not commit its canonical operation");
        uncertainOutcome = true;
        break;
      }
      operationIds.push(operationId);
      applied.push(entry);
    }
    if (applyError) {
      if (uncertainOutcome) {
        const receipt = this.recordHarnessIntegration(
          execution, patchSet, "OUTCOME_UNKNOWN", null, prepared.journal.entries.map((entry) => entry.path),
          operationIds, prepared.journalArtifact.sha256,
        );
        this.assessHarnessIntegrationFailure(execution, receipt);
        return receipt;
      }
      let rollbackFailed = false;
      for (const entry of [...applied].reverse()) {
        const before = journalPreimage(resources.artifacts, entry);
        const absolute = normalizedRelativeRoot(cwd, entry.path).absolute;
        const inverse: PatchEntry["operation"] = before === null ? "DELETE" : existsSync(absolute) ? "MODIFY" : "CREATE";
        const callId = idFromSha256("CALL", sha256Hex(`${patchSet.patch_sha256}\0COMPENSATE\0${entry.path}`));
        const admission = this.prepareHarnessPatchOperation(callId, cwd, inverse, entry.path, before === null ? null : sha256Hex(before));
        if (!admission.allow) { rollbackFailed = true; continue; }
        try {
          this.ensureLease();
          resources.authority.withLeaseFence(this.requiredActive().lease, () => applyPatchFile(absolute, inverse, before));
          const note = this.observeToolResult(callId, false, `COMPENSATED:${patchSet.patch_sha256}`) ?? "";
          const operationId = /operation=([^;\s]+)/u.exec(note)?.[1];
          if (operationId && this.hashTarget(absolute) === (entry.observed_before_sha256 ?? sha256Hex("PCH-ABSENT-V1"))) {
            operationIds.push(operationId);
          } else rollbackFailed = true;
        } catch (error) {
          rollbackFailed = true;
          this.observeToolResult(callId, true, error instanceof Error ? error.message : String(error));
        }
      }
      this.ensureLease();
      resources.authority.withLeaseFence(this.requiredActive().lease, () => {
        if (removePatchCreatedDirectories(cwd, prepared.journal).length > 0) rollbackFailed = true;
      });
      const receipt = this.recordHarnessIntegration(
        execution, patchSet, rollbackFailed ? "OUTCOME_UNKNOWN" : "REJECTED", null,
        rollbackFailed ? patchSet.entries.map((entry) => entry.path) : [], operationIds,
        prepared.journalArtifact.sha256,
      );
      this.assessHarnessIntegrationFailure(execution, receipt);
      return receipt;
    }
    const postimage = this.captureBaseline(this.currentCell()!).content_root_sha256;
    return this.recordHarnessIntegration(
      execution, patchSet, "APPLIED", postimage, [], operationIds, prepared.journalArtifact.sha256,
    );
  }

  failHarnessWorker(
    execution: HarnessWorkerExecution,
    error: unknown,
    usage: WorkerUsage,
    stateName: "FAILED" | "ABORTED" | "TIMED_OUT" | "FENCED" = "FAILED",
  ): void {
    const state = this.requiredActive(); const resources = this.requiredResources();
    const failure = this.workerFailureSignature(execution.worker.role, error, stateName);
    let terminalState: typeof stateName = stateName;
    let transition = this.workerTransition(execution.worker.worker_run_id, 2, terminalState, null, usage, failure, execution.runningTransitionSha256);
    try {
      const result = resources.authority.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: state.goalId, transition },
        this.mutation(`coding-harness:worker:failure:${transition.transition_sha256}`));
      state.version = result.goalVersion;
    } catch (errorValue) {
      const unresolved = resources.authority.readHarnessWorkerRecovery(state.goalId, execution.worker.worker_run_id);
      if (!unresolved || terminalState === "FENCED") throw errorValue;
      terminalState = "FENCED";
      transition = this.workerTransition(execution.worker.worker_run_id, unresolved.ordinal + 1, "FENCED", null, usage,
        failure, unresolved.transitionSha256);
      const fenced = resources.authority.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: state.goalId, transition },
        this.mutation(`coding-harness:worker:fenced:${transition.transition_sha256}`));
      state.version = fenced.goalVersion;
    }
    if (!state.view.route) { this.refresh(); return; }
    const health = this.requiredKernel().assess(state.goalId, state.view.route.route_id, execution.shard.work_cell_id, {
      ...this.healthyAssessment(), failureSignatureSha256: failure, failureOccurrence: execution.worker.attempt,
      transientFailure: terminalState !== "FENCED", localRepairAvailable: false,
    }, this.mutation(`coding-harness:worker:health:${failure}:${execution.worker.attempt}`));
    state.version = health.authority.goalVersion;
    if (health.decision.retryAllowed) {
      const requeued = this.requiredResources().authority.transactHarness({
        type: "REQUEUE_WORK_SHARD", goalId: state.goalId, runId: execution.worker.run_id,
        shardId: execution.shard.shard_id, reasonSha256: failure, routeDecisionSha256: health.health.record_sha256,
      }, this.mutation(`coding-harness:worker:requeue:${execution.shard.shard_id}:${execution.worker.attempt}`));
      state.version = requeued.goalVersion;
    }
    this.refresh();
  }

  private recoverHarnessWorkers(harness: HarnessCurrentView): void {
    if (harness.unresolvedWorkerRunIds.length === 0) return;
    const state = this.requiredActive(); const resources = this.requiredResources();
    this.ensureLease();
    for (const workerRunId of harness.unresolvedWorkerRunIds) {
      const worker = resources.authority.readHarnessWorkerRecovery(state.goalId, workerRunId);
      if (!worker) continue;
      const failure = canonicalJsonSha256({
        domain: "PCH-ORPHANED-WORKER-V1", reason: "HOST_RESTART", runId: worker.runId, shardId: worker.shardId,
      });
      const transition = this.workerTransition(
        worker.workerRunId, worker.ordinal + 1, "FENCED", null, emptyWorkerUsage(), failure, worker.transitionSha256,
      );
      const recovered = resources.authority.transactHarness({
        type: "RECOVER_WORKER_RUN", goalId: state.goalId, transition,
      }, this.mutation(`coding-harness:worker:recover:${transition.transition_sha256}`));
      state.version = recovered.goalVersion;
    }
    this.refresh();
  }

  private recoverOpenPatchTransactions(): void {
    const state = this.requiredActive();
    const resources = this.requiredResources();
    const transactions = resources.authority.readOpenPatchTransactions(state.goalId);
    if (transactions.length === 0) return;
    this.ensureLease();
    for (const transaction of transactions) {
      let result: "REJECTED" | "OUTCOME_UNKNOWN" = "OUTCOME_UNKNOWN";
      let affected = [...transaction.affectedPaths].sort();
      try {
        const journal = readPatchTransactionJournal(resources.artifacts, transaction.journalLocator);
        if (journal.goal_id !== state.goalId || journal.run_id !== transaction.runId
          || journal.shard_id !== transaction.shardId || journal.patch_set_id !== transaction.patchSetId
          || journal.patch_sha256 !== transaction.patchSha256
          || journal.preimage_root_sha256 !== transaction.preimageRootSha256) {
          throw new AuthorityIntegrityError("Recovered PatchTransaction journal binding differs from authority");
        }
        const recovery = restorePatchTransactionPreimage({
          cwd: this.requiredCwd(), journal, artifacts: resources.artifacts,
          withMutationFence: (effect) => {
            this.ensureLease();
            resources.authority.withLeaseFence(this.requiredActive().lease, effect);
          },
          afterRestore: (path) => this.options.onPatchTransactionFault?.("AFTER_RECOVERY_APPLY", path),
        });
        affected = recovery.outcome === "OUTCOME_UNKNOWN"
          ? [...new Set([...affected, ...recovery.uncertain_paths])].sort() : [];
        if (recovery.outcome === "RESTORED") {
          if (resources.authority.readUnresolvedTaskFlowOperations(state.goalId).length > 0) {
            this.reconcileOperations(undefined, false);
          }
          result = "REJECTED";
        }
      } catch {
        result = "OUTCOME_UNKNOWN";
      }
      this.ensureLease();
      const receipt = this.recordRecoveredPatchTransaction(transaction, result, affected);
      const shard = resources.authority.readHarnessShard(state.goalId, transaction.shardId);
      this.assessHarnessIntegrationResult(shard?.spec.role ?? "INTEGRATOR", receipt);
      if (result === "OUTCOME_UNKNOWN") state.blocker = "PatchTransaction outcome requires manual reconciliation.";
    }
  }

  private workerFailureSignature(role: WorkerRole, error: unknown, state: string): string {
    const raw = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const normalized = raw.normalize("NFC").trim().toLowerCase()
      .replace(/[a-z]:[\\/][^\s]+/giu, "<path>")
      .replace(/(?:worker|packet|shard|run)-[a-z0-9_-]+/giu, "<runtime-id>")
      .replace(/\b\d{4,}\b/gu, "<number>")
      .slice(0, 1_024);
    return canonicalJsonSha256({ domain: "PCH-WORKER-FAILURE-SIGNATURE-V1", role, state, normalized });
  }

  current(): TaskFlowStatusView | null {
    const state = this.active;
    if (!state) return null;
    return {
      goalId: state.goalId, objective: state.objective, mode: statusMode(state.view), phase: state.view.status,
      stage: null, workCell: state.view.workCellId, routeHealth: routeHealth(state.view),
      nextAction: this.compactionRecoveryRequired ? "RECONCILE_COMPACTION" : state.view.nextActionCode,
      blocker: state.blocker,
    };
  }

  entryBinding(): { readonly goalId: string; readonly objective: string; readonly intent: "PLAN" | "BUILD" } | null {
    const state = this.active;
    return state ? { goalId: state.goalId, objective: state.objective, intent: state.view.intent } : null;
  }

  planReview(): { readonly summary: string; readonly artifactPath: string; readonly routeSha256: string } | null {
    const route = this.active?.view.route;
    if (!route || !this.planContinuationPending()) return null;
    return {
      summary: this.renderGoalGraph(),
      artifactPath: resolve(this.requiredCwd(), ".coding-harness", "task-flow", `route-skeleton.${route.route_id}.md`),
      routeSha256: route.record_sha256,
    };
  }

  executionSubject(): ExecutionSubjectRef {
    const state = this.active;
    if (!state?.view.contract) return makeExecutionSubjectRef({
      kind: "NONE", goalId: null, subjectId: null, routeRevision: null,
      goalContractSha256: null, executionAuthorizationSha256: null,
    });
    if (state.view.workCellId && state.view.route && state.view.authorization) return makeExecutionSubjectRef({
      kind: "WORK_CELL", goalId: state.goalId, subjectId: state.view.workCellId,
      routeRevision: state.view.route.revision, goalContractSha256: state.view.contract.record_sha256,
      executionAuthorizationSha256: state.view.authorization.record_sha256,
    });
    return makeExecutionSubjectRef({
      kind: "GOAL", goalId: state.goalId, subjectId: state.goalId,
      routeRevision: state.view.route?.revision ?? null, goalContractSha256: state.view.contract.record_sha256,
      executionAuthorizationSha256: null,
    });
  }

  binding(): ActiveGoalBinding | null {
    const state = this.active;
    if (!state || !this.cwd) return null;
    const cell = this.currentCell();
    return {
      goalId: state.goalId, mode: statusMode(state.view), planId: null, authorizedStageId: null,
      authorizedWorkCellId: state.view.workCellId,
      authorizedWriteRoots: cell?.write_roots.map((root) => normalizedRelativeRoot(this.cwd!, root).absolute) ?? [],
      workspaceRoot: this.cwd, view: this.current()!, executionSubject: this.executionSubject(),
      inputClosureSha256: canonicalJsonSha256({
        goalId: state.goalId, contract: state.view.contract?.record_sha256 ?? null,
        route: state.view.route?.record_sha256 ?? null, authorization: state.view.authorization?.record_sha256 ?? null,
      }),
      mutation: (idempotencyKey) => this.mutation(idempotencyKey),
      advanceVersion: (version) => { state.version = version; this.refresh(); },
    };
  }

  startFromInput(text: string, ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">): InputEventResult | null {
    if (this.active && !["SUCCEEDED", "FAILED", "CANCELED"].includes(this.active.view.status)
      && !/^\s*(?:plan|build)\s*:/iu.test(text)) {
      this.services.observeTaskFlowMemoryInput(text, false);
      return null;
    }
    const classified = classifyTaskFlowInput(text, this.options.config);
    if (classified.action === "BYPASS") {
      this.services.observeTaskFlowMemoryInput(text, false);
      return null;
    }
    this.initialize(ctx);
    if (secretPattern.test(classified.taskText)) throw new TypeError("PCH rejected secret-like task text before persistence");
    if (this.active && !["SUCCEEDED", "FAILED", "CANCELED"].includes(this.active.view.status)) {
      throw new TypeError("An active PCH Goal already exists in this workspace; finish or cancel it first");
    }
    if (!classified.intent || !classified.lane) throw new AuthorityIntegrityError("Managed admission lacks intent or lane");
    const goalId = createId("GOAL");
    const sourceIntakeSha256 = sha256Hex(classified.taskText);
    const acceptanceFacetMinimum = inferAcceptanceFacetMinimum(classified.taskText);
    const activationSha256 = canonicalJsonSha256({
      contract: "PCH-TASK-FLOW-KERNEL-V1", goalId, sourceIntakeSha256,
      intent: classified.intent, lane: classified.lane, acceptanceFacetMinimum,
    });
    const admitted = this.requiredKernel().admit(text, this.options.config, {
      goalId, workspaceId: this.requiredWorkspaceId(),
      workspaceHmac: hmacSha256Hex(this.requiredResources().workspaceSecret, this.requiredCwd().replaceAll("\\", "/").toLowerCase().normalize("NFC")),
      filesystemKind: "LOCAL", originSessionId: this.requiredSessionId(), sourceIntakeSha256, activationSha256,
    });
    if (!admitted.authority) throw new AuthorityIntegrityError("Managed Task Flow admission did not commit authority");
    const lease = this.requiredResources().authority.acquireLease(goalId, this.requiredSessionId(), this.options.config.execution.lease_ttl_ms);
    const view = this.requiredKernel().recover(goalId).view;
    this.active = {
      goalId, objective: classified.objective, objectiveSha256: sha256Hex(classified.objective),
      sourceIntakeSha256, acceptanceFacetMinimum,
      version: admitted.authority.goalVersion, lease, view, blocker: null,
      contractRevisionRequested: false,
    };
    this.syncMemoryContext();
    this.services.observeTaskFlowMemoryInput(text, true);
    return { action: "transform", text: classified.taskText };
  }

  submitContract(proposal: GoalContractProposal): string {
    const state = this.requiredActive();
    assertSafeAuthorityPayload(proposal, "GoalContract proposal");
    this.ensureLease();
    const current = state.view.contract;
    if (current && !state.contractRevisionRequested) throw new TypeError("Current GoalContract is frozen; request a contract revision first");
    const contract = finalizeGoalContract({
      goalId: state.goalId, objective: state.objective, intent: state.view.intent, lane: state.view.lane,
      sourceIntakeSha256: state.sourceIntakeSha256, version: (current?.version ?? 0) + 1,
      parentContractId: current?.contract_id ?? null,
      acceptanceFacetMinimum: state.acceptanceFacetMinimum, proposal, createdAtMs: this.now(),
    });
    const result = this.requiredKernel().submitContract(
      state.goalId, contract,
      this.mutation(`task-flow:contract:${contract.record_sha256}`),
    );
    state.version = result.goalVersion;
    state.contractRevisionRequested = false;
    state.blocker = null;
    this.refresh();
    this.publish("goal-contract", contract.contract_id, contract);
    const acceptanceLedger = this.requiredResources().authority.readTaskFlowAcceptanceLedger(contract.contract_id);
    if (!acceptanceLedger) throw new AuthorityIntegrityError("Frozen GoalContract is missing its AcceptanceLedger");
    this.publish("acceptance-ledger", acceptanceLedger.ledger_id, acceptanceLedger);
    return `GoalContract ${contract.contract_id} v${contract.version} frozen; next=${state.view.nextActionCode}.`;
  }

  submitBuild(contractProposal: GoalContractProposal, routeProposal: RouteProposal): string {
    const state = this.requiredActive();
    if (state.view.intent !== "BUILD" || state.view.contract || state.view.route) {
      throw new TypeError("Combined BUILD submission is available only at a fresh BUILD contract boundary");
    }
    assertSafeAuthorityPayload(contractProposal, "GoalContract proposal");
    assertSafeAuthorityPayload(routeProposal, "Route proposal");
    this.ensureLease();
    const contract = finalizeGoalContract({
      goalId: state.goalId, objective: state.objective, intent: state.view.intent, lane: state.view.lane,
      sourceIntakeSha256: state.sourceIntakeSha256, version: 1, parentContractId: null,
      acceptanceFacetMinimum: state.acceptanceFacetMinimum,
      proposal: contractProposal, createdAtMs: this.now(),
    });
    const route = this.finalizeRouteProposal(contract, routeProposal);
    const contractResult = this.requiredKernel().submitContract(
      state.goalId, contract,
      this.mutation(`task-flow:contract:${contract.record_sha256}`),
    );
    state.version = contractResult.goalVersion;
    this.publish("goal-contract", contract.contract_id, contract);
    const acceptanceLedger = this.requiredResources().authority.readTaskFlowAcceptanceLedger(contract.contract_id);
    if (!acceptanceLedger) throw new AuthorityIntegrityError("Frozen BUILD contract is missing its AcceptanceLedger");
    this.publish("acceptance-ledger", acceptanceLedger.ledger_id, acceptanceLedger);
    const routeResult = this.requiredKernel().submitRoute(
      state.goalId, route, contract, this.mutation(`task-flow:route:${route.record_sha256}`),
    );
    state.version = routeResult.goalVersion;
    state.contractRevisionRequested = false;
    state.blocker = null;
    this.refresh();
    this.publish("route", route.route_id, route);
    const authorized = this.authorizeNextWork();
    return authorized
      ? `BUILD contract and route frozen in one submission; WorkCell ${state.view.workCellId} authorized.`
      : `BUILD contract and route frozen, but authorization preflight reframed the route; next=${state.view.nextActionCode}.`;
  }

  submitRoute(proposal: RouteProposal): string {
    const state = this.requiredActive();
    if (state.view.status !== "PLANNING" || state.view.nextActionCode !== "SUBMIT_ROUTE") {
      throw new TypeError(`Route submission is not authorized while next=${state.view.nextActionCode}; reframe the current route first`);
    }
    assertSafeAuthorityPayload(proposal, "Route proposal");
    this.ensureLease();
    const contract = state.view.contract;
    if (!contract) throw new TypeError("Route submission requires a frozen GoalContract");
    const route = this.finalizeRouteProposal(contract, proposal);
    return this.persistFinalizedRoute(route, contract);
  }

  private persistFinalizedRoute(route: RouteSkeletonRecord, contract: GoalContractRecord): string {
    const state = this.requiredActive();
    const result = this.requiredKernel().submitRoute(state.goalId, route, contract, this.mutation(`task-flow:route:${route.record_sha256}`));
    state.version = result.goalVersion;
    this.refresh();
    this.publish("route", route.route_id, route);
    if (state.view.intent === "BUILD") this.authorizeNextWork();
    const qualification = route.qualification
      ? ` admission=${route.qualification.admission_lane_hint} requested=${route.qualification.requested_lane} selected=${route.qualification.selected_lane}`
      : "";
    return `RouteSkeleton ${route.route_id} r${route.revision} frozen; lane=${route.lane}${qualification} deferred=${route.deferred_outcomes?.length ?? 0} next=${state.view.nextActionCode}.`;
  }

  submitRouteRevision(patch: RouteRevisionPatch): string {
    const state = this.requiredActive();
    if (state.view.status !== "PLANNING" || state.view.nextActionCode !== "SUBMIT_ROUTE" || !state.view.route) {
      throw new TypeError(`RouteRevision patch is not authorized while next=${state.view.nextActionCode}`);
    }
    const contract = state.view.contract;
    if (!contract) throw new TypeError("RouteRevision patch requires a frozen GoalContract");
    assertSafeAuthorityPayload(patch, "RouteRevision patch");
    this.ensureLease();
    const route = this.finalizeRouteProposal(
      contract, applyRouteRevisionPatch({ contract, priorRoute: state.view.route, patch }),
    );
    if (routeExecutionSemanticsSha256(contract, route)
      === routeExecutionSemanticsSha256(contract, state.view.route)) {
      throw new TypeError("RouteRevision patch does not change the effective Route execution semantics");
    }
    return this.persistFinalizedRoute(route, contract);
  }

  planContinuationPending(): boolean {
    return this.active?.view.intent === "PLAN" && this.active.view.nextActionCode === "PLAN_CONTINUATION";
  }

  async continueFromPlan(ctx: Pick<ExtensionCommandContext, "hasUI" | "mode" | "ui">): Promise<string> {
    const state = this.requiredActive();
    const contract = state.view.contract;
    const route = state.view.route;
    if (!contract || !route || !this.planContinuationPending()) throw new TypeError("No frozen PLAN continuation is open");
    if (!ctx.hasUI) return "Plan is frozen. An interactive Pi UI is required to choose BUILD, keep, or revise; no default was applied.";
    const options = [
      "[Recommended] Enter BUILD - implement the frozen contract and route now",
      "Keep plan only - finish without modifying target project files",
      "Revise route - preserve the contract and replace the technical route",
    ];
    const selected = await ctx.ui.select("Plan passed local finalization. What should PCH do next?", options);
    if (!selected) return "Plan continuation canceled; the frozen contract and route remain unchanged.";
    const choice = selected === options[0] ? "BUILD" : selected === options[1] ? "KEEP" : "REVISE";
    return this.resolvePlanContinuation(choice);
  }

  resolvePlanContinuation(choice: "BUILD" | "KEEP" | "REVISE"): string {
    const state = this.requiredActive();
    const contract = state.view.contract;
    const route = state.view.route;
    if (!contract || !route || !this.planContinuationPending()) throw new TypeError("No frozen PLAN continuation is open");
    const bindingSha256 = sha256Hex(`${contract.record_sha256}:${route.record_sha256}`);
    const decisionId = idFromSha256("DECISION", sha256Hex(`${state.goalId}\0PLAN_CONTINUATION\0${bindingSha256}\0${choice}`));
    const decision = sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1, decision_entry_id: decisionId, goal_id: state.goalId,
      contract_id: contract.contract_id, route_id: route.route_id, decision_key: "PLAN_CONTINUATION",
      authority_actor: "USER", materiality: "HIGH", reversible: true, privacy_related: false,
      question_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, "PLAN_CONTINUATION"),
      recommendation: { recommended: "BUILD" }, selection: { choice }, state: "RESOLVED",
      binding_sha256: bindingSha256, created_at_ms: this.now(), expires_at_ms: null,
    }, "record_sha256");
    const mutation = this.mutation(`task-flow:plan-continuation:${bindingSha256}:${choice}`);
    const harness = choice === "KEEP" ? this.requiredResources().authority.readHarnessView(state.goalId) : null;
    const result = choice === "KEEP" && harness && ["ACTIVE", "PAUSED"].includes(harness.status)
      ? this.requiredKernel().keepPlanAndCloseManagedRun(state.goalId, harness.runId, decision, mutation)
      : this.requiredKernel().resolvePlanContinuation(state.goalId, choice, decision, mutation);
    state.version = result.goalVersion;
    this.refresh();
    const authorized = choice === "BUILD" ? this.authorizeNextWork() : false;
    return choice === "BUILD" ? (authorized
      ? `PLAN continuation resolved: BUILD authorized for WorkCell ${state.view.workCellId}.`
      : `PLAN continuation resolved, but authorization preflight requires RouteRevision ${((state.view.route?.revision ?? 0) + 1)}.`)
      : choice === "KEEP" ? "PLAN continuation resolved: frozen plan kept without implementation."
        : "PLAN continuation resolved: submit a revised RouteSkeleton; valid contract evidence is preserved.";
  }

  prepareToolOperation(invocation: ToolInvocation): TaskFlowOperationAdmission {
    return this.operationLifecycle?.prepare(invocation) ?? { allow: true, managed: false, reason: null };
  }

  observeToolResult(toolCallId: string, isError: boolean, text: string, reportedOutputSha256?: string): string | null {
    return this.operationLifecycle?.observe(toolCallId, isError, text, reportedOutputSha256) ?? null;
  }

  endToolOperation(toolCallId: string, isError: boolean, text: string): void {
    this.operationLifecycle?.finish(toolCallId, isError, text);
  }

  reconcileOperations(operationId?: string, authorizeNext = true): string {
    this.requiredActive();
    return this.requiredOperationLifecycle().reconcile(operationId, authorizeNext);
  }

  attest(input: TaskFlowAttestationInput): string {
    this.requiredActive();
    return this.requiredOperationLifecycle().attest(input);
  }

  completeWork(): string {
    const state = this.requiredActive();
    const cellId = state.view.workCellId;
    if (!cellId) {
      if (state.view.nextActionCode !== "CLOSE_GOAL") throw new TypeError("No authorized WorkCell is running");
      this.closeSucceededGoal();
      return `Goal ${state.goalId} closed by current evidence.`;
    }
    const harnessBefore = this.requiredResources().authority.readHarnessView(state.goalId);
    const singleShard = harnessBefore?.effectiveTopology === "SINGLE"
      ? harnessBefore.shards.find((shard) => shard.workCellId === cellId && shard.status === "RUNNING") ?? null
      : null;
    const summary = canonicalJsonSha256({ cellId, view: state.view.nextActionCode, completedAtMs: this.now() });
    const result = this.requiredKernel().completeWork(state.goalId, cellId, summary, this.mutation(`task-flow:complete:${cellId}:${summary}`));
    state.version = result.goalVersion;
    this.refresh();
    if (singleShard && harnessBefore) {
      const synchronized = this.requiredResources().authority.transactHarness({
        type: "TRANSITION_SINGLE_SHARD", goalId: state.goalId, runId: harnessBefore.runId,
        shardId: singleShard.shardId, action: "SUCCEED", resultSha256: summary,
      }, this.mutation(`coding-harness:single:succeed:${singleShard.shardId}:${summary}`));
      state.version = synchronized.goalVersion;
      this.refresh();
    }
    if (state.view.nextActionCode === "AUTHORIZE_WORK") {
      this.authorizeNextWork();
    }
    if (state.view.nextActionCode === "CLOSE_GOAL") this.closeSucceededGoal();
    return state.view.status === "SUCCEEDED"
      ? `WorkCell ${cellId} and Goal ${state.goalId} closed by current evidence.`
      : `WorkCell ${cellId} closed; next=${state.view.workCellId ?? state.view.nextActionCode}.`;
  }

  workflowPrompt(): string | null {
    const state = this.active;
    if (!state) return null;
    const prefix = `[PCH-TASK-FLOW-V1]\nGoal=${state.goalId} Intent=${state.view.intent} Lane=${state.view.lane} State=${state.view.status}`;
    if (this.compactionRecoveryRequired) {
      return `${prefix}\nNext=RECONCILE_COMPACTION. Do not mutate. Call coding_flow action=control control=resume once to rebuild the current authority projection.`;
    }
    if (state.view.nextActionCode === "SUBMIT_CONTRACT") return [
      prefix, `Objective=${state.objective}`,
      state.view.intent === "BUILD"
        ? "Create the smallest complete GoalContract and 1..3 current/near WorkCells in this turn, review them locally, then call coding_flow action=submit_build once."
        : "Create the smallest complete GoalContract for this task in the current normal turn, then call coding_flow action=submit_contract once.",
      goalContractProposalGuide,
      `AcceptanceFacetMinimum=${state.acceptanceFacetMinimum}; represent each explicit facet as a distinct user_outcome and MUST obligation.`,
      state.view.intent === "BUILD" ? routeProposalGuide : null,
      "Do not add acceptance_policy.performance_contract unless this prompt contains an explicit TargetPerformance= line; ordinary correctness and non-regression belong in obligations and local oracles.",
      targetPerformancePrompt(null, state.objective),
      "Every MUST needs a decidable local oracle. Allowed forms: npm test; npm run test|lint|build|verify|check|typecheck|bench:*; npx --no-install or direct node_modules/.bin for eslint/tsc/vitest/jest/mocha/karma/prettier/esbuild/microbundle. npm exec, watch/serve modes and shell composition are forbidden. oracle.commands only separates individually allowed commands. Ask only material user choices with coding_clarify; do not add a critic or planner request.",
      "Runtime selection is already bound by PCH; do not probe PI_MODEL, PI_SESSION, provider, model, thinking, or context-window environment/config values.",
    ].filter((line): line is string => line !== null).join("\n");
    if (state.view.nextActionCode === "SUBMIT_ROUTE") return [
      prefix, `Contract=${state.view.contract?.contract_id ?? "missing"}`,
      state.view.route
        ? "Check coverage, recovery, scope, performance and waiting cost, then call coding_flow action=submit_route_revision once with only the changed horizon and changed metadata."
        : "Check coverage, recovery, scope, performance and waiting cost before submission. Persist only decision-relevant typed entries from the exact proposal shape, then call coding_flow action=submit_route once.",
      state.view.route
        ? "This is a RouteRevision: preserve valid workspace changes and artifacts. Do not recreate completed mutation WorkCells merely to retain a dependency; bind still-required final oracles to the smallest current WorkCell and rerun only evidence that must be fresh after the last mutation."
        : null,
      state.view.route ? routeRevisionPatchGuide : routeProposalGuide,
      targetPerformancePrompt(state.view.contract, state.objective),
      "Oracle forms: npm test; npm run test|lint|build|verify|check|typecheck|bench:*; npx --no-install or direct node_modules/.bin for eslint/tsc/vitest/jest/mocha/karma/prettier/esbuild/microbundle. npm exec, watch/serve modes and shell composition are forbidden; oracle.commands only separates individually allowed commands.",
      "Submit only 1..3 current/near WorkCells. Represent later accepted work as typed deferred_outcomes; do not pre-expand a full plan. Route qualification may promote a DirectCell hint locally.",
    ].filter((line): line is string => line !== null).join("\n");
    if (state.view.nextActionCode === "PLAN_CONTINUATION") return `${prefix}\nThe plan is frozen. Do not modify target files; use the Pi choice shown by Coding Harness or /coding continue.`;
    if (state.view.nextActionCode === "EXECUTE_WORK") {
      const cell = this.currentCell();
      const harness = this.requiredResources().authority.readHarnessView(state.goalId);
      if (harness?.effectiveTopology === "MULTI") {
        const shards = harness.shards.filter((shard) => shard.workCellId === cell?.work_cell_id);
        if (shards.length === 0) return [
          prefix, `WorkCell=${cell?.work_cell_id ?? "missing"} Outcome=${cell?.outcome ?? "missing"}`,
          `ReadScope=${cell?.read_roots.join(",") ?? ""} WriteScope=${cell?.write_roots.join(",") ?? ""}`,
          "Define the smallest useful role-isolated shard DAG with coding_delegate action=define. Parallel shards must have disjoint read/write conflicts; each downstream TaskPacket receives bounded hash-bound dependency output.",
          "Do not modify canonical project files directly in Multi. Use only roles that add value; a single IMPLEMENTER shard is valid when extra roles would add overhead.",
        ].join("\n");
        if (shards.some((shard) => shard.status === "READY")) return [
          prefix, `WorkCell=${cell?.work_cell_id ?? "missing"} ReadyShards=${shards.filter((shard) => shard.status === "READY").length}`,
          "Run the authority-ready isolated shard batch with coding_delegate action=run_ready. Do not duplicate Worker work or modify canonical project files directly.",
        ].join("\n");
        if (shards.every((shard) => shard.status === "SUCCEEDED")) return [
          prefix, `WorkCell=${cell?.work_cell_id ?? "missing"} Shards=SUCCEEDED`, `Oracle=${canonicalJson(cell?.oracle ?? {})}`,
          "Oracle commands are exact allowlisted strings: run each verbatim once in the canonical workspace without added flags, wrappers, chaining or cwd changes. PCH locally attests and closes after the final fresh PASS; then stop all tool calls and return at most one short result line. Worker narrative is untrusted and never substitutes for this oracle.",
        ].join("\n");
        if (shards.some((shard) => ["REJECTED", "FAILED"].includes(shard.status))) return [
          prefix, `WorkCell=${cell?.work_cell_id ?? "missing"} Shards=REJECTED_OR_FAILED`,
          "Do not retry or mutate around a rejected shard. Follow RouteHealth: submit a repaired RouteSkeleton when H3, reconcile when H5, or run only a legitimately requeued READY shard.",
        ].join("\n");
        return `${prefix}\nMulti Worker execution is in progress. Do not duplicate it or mutate canonical project files.`;
      }
      const performance = state.view.contract ? targetPerformanceContract(state.view.contract) : null;
      const performancePhase = cell ? targetPerformancePhase(cell) : null;
      return [
        prefix, `WorkCell=${cell?.work_cell_id ?? "missing"} Outcome=${cell?.outcome ?? "missing"}`,
        performance && performancePhase
          ? `TargetPerformance=${performance.mode} Phase=${performancePhase}; obey the frozen workload commands and budget before advancing.`
          : null,
        `ReadScope=${cell?.read_roots.join(",") ?? ""} WriteScope=${cell?.write_roots.join(",") ?? ""}`,
        `Oracle=${canonicalJson(cell?.oracle ?? {})}`,
        "Reuse current evidence; read only when the needed fact is absent or stale. Serialize writes and validation. Merge all edits to the same file in one turn into one edit call after the fresh read; after a successful edit, reread before any later edit to that path because its source version changed. PCH prepares and readbacks each mutation automatically.",
        "After the final write, run every Oracle command exactly as shown, once, with no added flags, wrappers, chaining or cwd changes. PCH locally attests and closes after the final fresh PASS; then stop all tool calls and return at most one short result line.",
      ].filter((line): line is string => line !== null).join("\n");
    }
    if (state.view.status === "RECONCILING") return `${prefix}\nStop mutation. Reconcile the unresolved Operation outcome before any retry.`;
    return `${prefix}\nNext=${state.view.nextActionCode}. Follow only the current authority-backed action.`;
  }

  protectedProjection(): string | null {
    const state = this.active;
    if (!state) return null;
    const protectedState = {
      schema: "PCH-TASK-FLOW-PROTECTED-V1", goal_id: state.goalId, objective_sha256: state.objectiveSha256,
      intent: state.view.intent, lane: state.view.lane, status: state.view.status,
      contract_sha256: state.view.contract?.record_sha256 ?? null, route_sha256: state.view.route?.record_sha256 ?? null,
      subject: this.executionSubject(), pending_operation_ids: state.view.unresolvedOperationIds,
      latest_health_sha256: state.view.latestHealth?.record_sha256 ?? null,
      lease_generation: state.lease.generation,
      next_action: this.compactionRecoveryRequired ? "RECONCILE_COMPACTION" : state.view.nextActionCode,
    };
    const hash = canonicalJsonSha256(protectedState);
    return `[PCH-TASK-FLOW-PROTECTED-V1 sha256=${hash}]\n${canonicalJson(protectedState)}\n[/PCH-TASK-FLOW-PROTECTED-V1]`;
  }

  controlFrame(toolSurfaceSha256: string): CurrentControlFrame {
    this.ensureLease();
    const state = this.requiredActive();
    return createCurrentControlFrame({
      goal_id: state.goalId, authority_version: state.version,
      goal_contract_sha256: state.view.contract?.record_sha256 ?? null,
      route_sha256: state.view.route?.record_sha256 ?? null,
      work_cell_id: state.view.workCellId,
      execution_authorization_sha256: state.view.authorization?.record_sha256 ?? null,
      lease_generation: state.lease.generation, fencing_token: state.lease.fencingToken,
      tool_surface_sha256: toolSurfaceSha256,
    });
  }

  keepActiveLeaseAlive(): void {
    this.ensureLease();
  }

  memoryProjection(): MemoryContextMessage | null { return this.services.memoryProjection(); }

  private sharedWorkerMemory(runId: string, task: string): TaskPacketRecord["shared_memory"] {
    const authority = this.requiredResources().authority;
    if (!authority.hasVerifiedSharedHarnessMemory(runId)) return null;
    const retrieval = this.services.memoryRetrievalFor(task);
    if (!retrieval) return null;
    const candidates = retrieval.selected.map((entry) => ({ claimId: entry.claimId, version: entry.version }));
    const bindings = authority.readVerifiedSharedHarnessMemoryBindings(runId, candidates);
    const selected = retrieval.selected.filter((entry) => bindings.has(`${entry.claimId}:${entry.version}`));
    if (selected.length === 0) return null;
    const workingSet = buildMemoryWorkingSet(
      selected.filter((entry) => entry.channel === "POLICY"),
      selected.filter((entry) => entry.channel === "EVIDENCE"),
      selected.filter((entry) => entry.channel === "EXPERIENCE"),
      [], [],
    );
    const content = memoryContextMessage(workingSet).content;
    return {
      schema_version: 1, audience: "VERIFIED_SHARED", content,
      manifest_sha256: workingSet.manifestSha256,
      binding_sha256s: selected.map((entry) => bindings.get(`${entry.claimId}:${entry.version}`)!),
    };
  }
  inputContextSeed(): InputContextSeed | null {
    if (!this.workspaceId) return null;
    const subject = this.executionSubject();
    const state = this.active;
    if (!state?.view.contract || subject.kind === "NONE") {
      return {
        workspaceId: this.workspaceId, subject, obligations: [], nextActionSha256: null,
        sourceClosureRootSha256: null, acceptanceClosureRootSha256: null,
      };
    }
    const cell = this.currentCell();
    const eligible = cell ? new Set(cell.obligation_ids) : null;
    const obligations = state.view.contract.obligations
      .filter((obligation) => eligible === null || eligible.has(obligation.obligation_id))
      .slice(0, 128)
      .map((obligation) => ({
        obligation_id: obligation.obligation_id,
        role: "ACCEPTANCE" as const,
        confidence: obligation.priority === "MUST" ? "PROVEN_REQUIRED" as const
          : obligation.priority === "SHOULD" ? "LIKELY_RELEVANT" as const : "UNKNOWN_DISCOVERY" as const,
        source_refs: obligation.dependencies,
        must_be_current: subject.kind === "WORK_CELL",
        must_be_exact: obligation.priority === "MUST",
        authorization_scope_sha256: subject.bindingSha256,
        semantic_scope_sha256: obligation.record_sha256,
      }));
    return {
      workspaceId: this.workspaceId,
      subject,
      obligations,
      nextActionSha256: sha256Hex(state.view.nextActionCode),
      sourceClosureRootSha256: state.view.contract.record_sha256,
      acceptanceClosureRootSha256: canonicalJsonSha256(obligations.map((entry) => entry.semantic_scope_sha256)),
    };
  }
  memoryCommand(request: MemoryCommandRequest): string { return this.services.memoryCommand(request); }
  observeMemoryInput(text: string, goalIntake: boolean): void { void this.services.observeTaskFlowMemoryInput(text, goalIntake); }
  recoveredPromptGeneration(): PromptGenerationRecord | null {
    const state = this.active;
    if (!state) return null;
    const resources = this.requiredResources();
    return recoverPromptGenerationObservation(
      resources.authority.readRecoveryMaterial(state.goalId),
      resources.artifacts,
    );
  }
  isManagedDraft(path: string): boolean { void path; return false; }

  prepareCompaction(): string | null {
    if (!this.active) return null;
    this.ensureLease();
    const state = this.requiredActive(); const resources = this.requiredResources();
    const harness = resources.authority.readHarnessView(state.goalId);
    if (!harness) throw new AuthorityIntegrityError("Compaction requires an active ManagedRun");
    const existing = resources.authority.readOpenHarnessCompaction(harness.runId);
    if (existing) {
      if (this.compactionRecoveryRequired) {
        throw new AuthorityIntegrityError("Compaction recovery requires an explicit resume before another compaction boundary");
      }
      const actual = compactionCapsuleSha256(this.compactionCapsule(harness));
      if (actual !== existing.attempt.pre_capsule_sha256) throw new AuthorityIntegrityError("Open compaction attempt requires state reconciliation");
      const recoveredState = existing.state === "RECOVERY_REQUIRED" ? "RECONCILED" : "VERIFIED";
      const reconciled = this.compactionTransition(existing.attempt.attempt_id, existing.ordinal + 1, recoveredState,
        "NEXT_BOUNDARY_RECONCILED", actual, existing.transitionSha256);
      resources.authority.transitionHarnessCompaction(reconciled, state.lease);
    }
    const capsule = this.compactionCapsule(harness);
    if (capsule.pending_operation_ids.length > 0 || capsule.unresolved_worker_run_ids.length > 0) {
      throw new AuthorityIntegrityError("Compaction requires zero pending Operations and worker runs");
    }
    const capsuleSha256 = compactionCapsuleSha256(capsule);
    const checkpointId = createId("HCP");
    const checkpointSha256 = canonicalJsonSha256({
      domain: "PCH-COMPACTION-CHECKPOINT-V21", checkpointId, capsuleSha256,
      leaseGeneration: state.lease.generation, fencingToken: state.lease.fencingToken,
    });
    const attemptId = idFromSha256("COMPACTION", sha256Hex(`${harness.runId}\0${checkpointId}\0${capsuleSha256}`));
    const attempt: HarnessCompactionAttempt = {
      schema_version: 1, attempt_id: attemptId, run_id: harness.runId, goal_id: state.goalId,
      checkpoint_id: checkpointId, checkpoint_sha256: checkpointSha256, pre_capsule: capsule,
      pre_capsule_sha256: capsuleSha256, strategy: "NATIVE_GUARDED", created_at_ms: this.now(),
    };
    const prepared = this.compactionTransition(attemptId, 0, "PREPARED", "NATIVE_PREFLIGHT_PASS", null, null);
    const piOwned = this.compactionTransition(attemptId, 1, "PI_OWNED", "PI_NATIVE_INTERVAL", null, prepared.transition_sha256);
    resources.authority.prepareHarnessCompaction(attempt, prepared, piOwned, state.lease);
    this.pendingCompactionAttemptId = attemptId;
    this.compactionRecoveryRequired = false;
    return attemptId;
  }

  verifyCompaction(): void {
    if (!this.active) return;
    const state = this.requiredActive(); const resources = this.requiredResources();
    const harness = resources.authority.readHarnessView(state.goalId);
    if (!harness) throw new AuthorityIntegrityError("Compaction ManagedRun is unavailable");
    const open = this.pendingCompactionAttemptId
      ? resources.authority.readOpenHarnessCompaction(harness.runId)
      : resources.authority.readOpenHarnessCompaction(harness.runId);
    if (!open || (this.pendingCompactionAttemptId && open.attempt.attempt_id !== this.pendingCompactionAttemptId)) {
      throw new AuthorityIntegrityError("Compaction completed without a durable preflight attempt");
    }
    this.refresh(true);
    const refreshedHarness = resources.authority.readHarnessView(state.goalId);
    if (!refreshedHarness) throw new AuthorityIntegrityError("Compaction ManagedRun disappeared during verification");
    const actual = compactionCapsuleSha256(this.compactionCapsule(refreshedHarness));
    const matches = actual === open.attempt.pre_capsule_sha256;
    const transition = this.compactionTransition(open.attempt.attempt_id, open.ordinal + 1,
      matches ? (open.state === "RECOVERY_REQUIRED" ? "RECONCILED" : "VERIFIED") : "RECOVERY_REQUIRED",
      matches ? "EXACT_FRONTIER_RESTORED" : "SEMANTIC_FRONTIER_MISMATCH", actual, open.transitionSha256);
    resources.authority.transitionHarnessCompaction(transition, state.lease);
    this.pendingCompactionAttemptId = null;
    if (!matches) {
      this.compactionRecoveryRequired = true;
      this.failClosed("Compaction semantic frontier changed; reconcile before continuing.");
      throw new AuthorityIntegrityError("Task Flow or Harness state changed across compaction");
    }
    this.compactionRecoveryRequired = false;
    if (state.blocker?.startsWith("Compaction ")) state.blocker = null;
  }

  private reconcileCompaction(): string | null {
    if (!this.pendingCompactionAttemptId && !this.compactionRecoveryRequired) return null;
    this.ensureLease();
    const state = this.requiredActive();
    const resources = this.requiredResources();
    const harness = resources.authority.readHarnessView(state.goalId);
    if (!harness) throw new AuthorityIntegrityError("Compaction recovery requires an active ManagedRun");
    let open = resources.authority.readOpenHarnessCompaction(harness.runId);
    if (!open) {
      this.pendingCompactionAttemptId = null;
      this.compactionRecoveryRequired = false;
      if (state.blocker?.startsWith("Compaction ")) state.blocker = null;
      return "Compaction recovery found no open durable attempt; current authority projection is active.";
    }
    this.refresh(true);
    const currentHarness = resources.authority.readHarnessView(state.goalId);
    if (!currentHarness) throw new AuthorityIntegrityError("Compaction ManagedRun disappeared during recovery");
    const actual = compactionCapsuleSha256(this.compactionCapsule(currentHarness));
    if (open.state === "PI_OWNED") {
      const matches = actual === open.attempt.pre_capsule_sha256;
      open = resources.authority.transitionHarnessCompaction(this.compactionTransition(
        open.attempt.attempt_id, open.ordinal + 1, matches ? "VERIFIED" : "RECOVERY_REQUIRED",
        matches ? "RECOVERY_EXACT_FRONTIER" : "RECOVERY_FRONTIER_MISMATCH", actual, open.transitionSha256,
      ), state.lease);
    }
    if (open.state === "PREPARED") {
      open = resources.authority.transitionHarnessCompaction(this.compactionTransition(
        open.attempt.attempt_id, open.ordinal + 1, "ABORTED", "RECOVERY_BEFORE_PI_OWNERSHIP",
        actual, open.transitionSha256,
      ), state.lease);
    } else if (open.state === "RECOVERY_REQUIRED") {
      open = resources.authority.transitionHarnessCompaction(this.compactionTransition(
        open.attempt.attempt_id, open.ordinal + 1, "RECONCILED", "AUTHORITY_FRONTIER_REPROJECTED",
        actual, open.transitionSha256,
      ), state.lease);
    }
    this.pendingCompactionAttemptId = null;
    this.compactionRecoveryRequired = false;
    if (state.blocker?.startsWith("Compaction ")) state.blocker = null;
    return `Compaction ${open.state.toLowerCase()} from durable authority; managed mutation may continue.`;
  }

  private compactionCapsule(harness: HarnessCurrentView): HarnessCompactionCapsule {
    const state = this.requiredActive();
    const subject = this.executionSubject();
    const seed = this.inputContextSeed();
    return {
      schema_version: 1, run_id: harness.runId, goal_id: state.goalId,
      task_flow_sha256: canonicalJsonSha256({
        status: state.view.status, contract: state.view.contract?.record_sha256 ?? null,
        route: state.view.route?.record_sha256 ?? null, workCellId: state.view.workCellId,
        workCellStatus: state.view.workCellStatus, authorization: state.view.authorization?.record_sha256 ?? null,
        health: state.view.latestHealth?.record_sha256 ?? null,
      }),
      harness_frontier_sha256: canonicalJsonSha256({
        topologyRevision: harness.topologyRevision, status: harness.status,
        shards: harness.shards.map((entry) => ({ id: entry.shardId, status: entry.status, attempts: entry.attemptCount,
          worker: entry.latestWorkerRunId, result: entry.resultSha256 })),
      }),
      execution_subject_sha256: subject.bindingSha256,
      input_context_seed_sha256: canonicalJsonSha256(seed),
      next_action_sha256: sha256Hex(state.view.nextActionCode),
      pending_operation_ids: [...state.view.unresolvedOperationIds].sort(),
      unresolved_worker_run_ids: [...harness.unresolvedWorkerRunIds].sort(),
    };
  }

  private compactionTransition(
    attemptId: string, ordinal: number, state: HarnessCompactionTransition["state"], reasonCode: string,
    observedCapsuleSha256: string | null, predecessorSha256: string | null,
  ): HarnessCompactionTransition {
    const core = {
      schema_version: 1 as const, transition_id: idFromSha256("HCT", sha256Hex(`${attemptId}\0${ordinal}\0${state}`)),
      attempt_id: attemptId, ordinal, state, reason_code: reasonCode,
      observed_capsule_sha256: observedCapsuleSha256, predecessor_sha256: predecessorSha256, created_at_ms: this.now(),
    };
    return { ...core, transition_sha256: compactionTransitionSha256(core) };
  }

  failClosed(reason: string): void {
    if (!this.active) return;
    this.active.blocker = reason;
  }

  detail(kind: TaskFlowDetail): string {
    const state = this.active;
    if (!state) return "No active PCH Goal.";
    if (kind === "prd") return state.view.contract ? JSON.stringify(state.view.contract, null, 2) : "GoalContract is not frozen.";
    if (kind === "plan") return state.view.route ? JSON.stringify(state.view.route, null, 2) : "RouteSkeleton is not frozen.";
    if (kind === "assumptions") return JSON.stringify(state.view.route?.assumptions ?? [], null, 2);
    if (kind === "risks") return JSON.stringify(state.view.route?.risks ?? [], null, 2);
    if (kind === "changes") return `Contract v${state.view.contract?.version ?? 0}; Route r${state.view.route?.revision ?? 0}; Health=${routeHealth(state.view)}.`;
    if (kind === "graph") return this.renderGoalGraph();
    if (kind === "why") return state.view.route?.qualification
      ? `Intent=${state.view.intent} Hint=${state.view.route.qualification.admission_lane_hint} Lane=${state.view.lane} Reasons=${state.view.route.qualification.reason_codes.join(",")} Next=${state.view.nextActionCode}.`
      : `Intent=${state.view.intent} LaneHint=${state.view.lane} Next=${state.view.nextActionCode}; route qualification is pending.`;
    if (kind === "performance" || kind === "efficiency") {
      const performance = state.view.contract ? targetPerformanceContract(state.view.contract) : null;
      const phase = this.currentCell() ? targetPerformancePhase(this.currentCell()!) : null;
      return `Task Flow local control requests=0; lane=${state.view.lane}; targetPerformance=${performance?.mode ?? "OFF"}; phase=${phase ?? "NONE"}; unresolvedOperations=${state.view.unresolvedOperationIds.length}.`;
    }
    return "Unsupported Goal detail.";
  }

  mutate(action: "pause" | "resume" | "cancel" | "replan", reason?: string): string {
    const state = this.requiredActive();
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(state.view.status)) {
      throw new TypeError(`Terminal Task Flow Goal ${state.goalId} cannot accept ${action}`);
    }
    const compactionRecovery = action === "resume" ? this.reconcileCompaction() : null;
    if (compactionRecovery && state.view.nextActionCode !== "RESUME") return compactionRecovery;
    if (action === "resume" && state.view.status === "RECONCILING") return this.reconcileOperations();
    if (action !== "replan") {
      const control = action === "pause" ? "PAUSE" : action === "resume" ? "RESUME" : "CANCEL";
      const decision = this.controlDecision(control, reason);
      const mutation = this.mutation(`task-flow:control:${decision.record_sha256}`);
      const harness = this.requiredResources().authority.readHarnessView(state.goalId);
      const managedStateMatches = harness !== null && (
        (control === "PAUSE" && ["ACTIVE", "RECONCILING"].includes(harness.status))
        || (control === "RESUME" && harness.status === "PAUSED")
        || (control === "CANCEL" && !["SUCCEEDED", "FAILED", "CANCELED"].includes(harness.status))
      );
      const result = managedStateMatches
        ? this.requiredKernel().controlWithManagedRun(state.goalId, harness.runId, control, decision, mutation)
        : this.requiredKernel().control(state.goalId, control, decision, mutation);
      state.version = result.goalVersion;
      this.refresh();
      if (control === "RESUME" && state.view.nextActionCode === "AUTHORIZE_WORK") this.authorizeNextWork();
      const resultMessage = `Task Flow ${control.toLowerCase()} committed at authority version ${state.version}; next=${state.view.nextActionCode}.`;
      return compactionRecovery ? `${compactionRecovery} ${resultMessage}` : resultMessage;
    }
    if (!state.view.route) throw new TypeError("Route reframe requires a current RouteSkeleton");
    const trigger = (reason?.trim().normalize("NFC") || "user requested reframe").replace(/\s+/gu, " ").slice(0, 320);
    const priorRoute = state.view.route;
    const failure = canonicalJsonSha256({ action, reason: trigger, route: priorRoute.record_sha256 });
    const decision = this.requiredKernel().assess(state.goalId, state.view.route.route_id, state.view.workCellId, {
      ...this.healthyAssessment(), assumptionInvalidated: true, failureSignatureSha256: failure, failureOccurrence: 1,
    }, this.mutation(`task-flow:user-reframe:${failure}`));
    state.version = decision.authority.goalVersion;
    this.refresh();
    return `Route r${priorRoute.revision} reframed at authority version ${state.version}. Trigger: ${trigger}. `
      + `Invalidated: active authorization and nonterminal WorkCells on ${priorRoute.route_id}. `
      + `Preserved: GoalContract, succeeded WorkCells, and immutable operation/evidence receipts. `
      + `Submit RouteRevision ${priorRoute.revision + 1}.`;
  }

  reviseRequirement(kind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE", reason: string): string {
    const state = this.requiredActive();
    this.ensureLease();
    const normalizedReason = reason.trim().normalize("NFC");
    if (!normalizedReason) throw new TypeError("GoalContract revision reason cannot be empty");
    const reasonSha256 = sha256Hex(normalizedReason);
    const result = this.requiredKernel().openContractRevision(
      state.goalId, kind, reasonSha256,
      this.mutation(`task-flow:contract-revision:${kind}:${reasonSha256}`),
    );
    state.version = result.goalVersion;
    state.contractRevisionRequested = true;
    state.blocker = `Contract revision requested: ${normalizedReason}`;
    this.refresh();
    return `GoalContract revision opened at authority version ${state.version}. Submit the revised contract before any further BUILD mutation.`;
  }

  async resolveClarifications(
    decisions: readonly ClarificationDecision[],
    ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
  ): Promise<string> {
    this.requiredActive();
    if (!ctx.hasUI) throw new TypeError("Material clarification requires interactive Pi UI; no recommendation was accepted automatically");
    const selections: ClarificationSelection[] = [];
    for (const decision of decisions) {
      const labels = decision.options.map((option) => option.id === decision.recommendedOptionId
        ? `[Recommended] ${option.label} - ${option.impact}` : `${option.label} - ${option.impact}`);
      const selected = await ctx.ui.select(`${decision.question}\n${decision.whyItMatters}`, labels);
      const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
      const selectedOptionId = selectedIndex < 0 ? null : decision.options[selectedIndex]!.id;
      selections.push({ ...decision, selectedOptionId });
      if (selectedOptionId === null) break;
    }
    return this.resolveClarificationSelections(selections);
  }

  resolveClarificationSelections(decisions: readonly ClarificationSelection[]): string {
    const state = this.requiredActive();
    if (decisions.length < 1 || decisions.length > 5) throw new TypeError("Clarification batch requires 1..5 decisions");
    assertSafeAuthorityPayload(decisions, "Clarification batch", 64 * 1024);
    if (state.view.route && state.view.status === "BUILDING") {
      const assessment = this.requiredKernel().assess(state.goalId, state.view.route.route_id, state.view.workCellId, {
        ...this.healthyAssessment(), materialDecisionOpen: true,
      }, this.mutation(`task-flow:health:material-decision:${canonicalJsonSha256(decisions)}`));
      state.version = assessment.authority.goalVersion;
      this.refresh();
    }
    const resolved: string[] = [];
    for (const decision of decisions) {
      if (decision.selectedOptionId !== null && !decision.options.some((option) => option.id === decision.selectedOptionId)) {
        throw new TypeError(`Clarification ${decision.id} selected an unknown option`);
      }
      const record = this.clarificationDecision(decision, decision.selectedOptionId);
      const authority = this.requiredKernel().recordDecision(state.goalId, record,
        this.mutation(`task-flow:clarify:${record.record_sha256}`));
      state.version = authority.goalVersion;
      if (record.state !== "RESOLVED" || !decision.selectedOptionId) {
        this.refresh();
        return `Clarification ${decision.id} remains OPEN; no default was applied and BUILD remains unauthorized.`;
      }
      resolved.push(`${record.decision_entry_id}=${decision.selectedOptionId}`);
    }
    if (state.view.route) this.reviseRequirement(
      "USER_PREFERENCE", "Resolved material Decisions must be bound into a revised GoalContract.",
    );
    this.refresh();
    return `Decisions resolved: ${resolved.join(", ")}. Bind these Decision IDs in the GoalContract decision_refs.`;
  }

  shutdown(): void {
    this.operationLifecycle = null;
    this.baselineHashCache.clear();
    this.services.setTaskFlowMemoryContext(null);
    this.services.shutdown();
    this.active = null;
    this.kernel = null;
  }

  private authorizeNextWork(): boolean {
    const state = this.requiredActive();
    this.ensureLease();
    this.refresh();
    if (state.view.nextActionCode !== "AUTHORIZE_WORK") return false;
    const contract = state.view.contract;
    const route = state.view.route;
    const cell = this.requiredResources().authority.readNextTaskFlowWorkCell(state.goalId);
    if (!contract || !route || !cell) throw new AuthorityIntegrityError("No eligible WorkCell for authorization");
    if (cell.effect_classes.some((effect) => effect === "IRREVERSIBLE_REQUIRES_USER" || effect === "EXTERNAL_IDEMPOTENT")) {
      throw new TypeError("External or irreversible WorkCell requires a resolved user Decision before authorization");
    }
    let baseline: WorkspaceBaselineRecord;
    try {
      baseline = this.captureBaseline(cell);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      const message = error.message.normalize("NFC").slice(0, 512);
      const failure = canonicalJsonSha256({
        domain: "PCH-AUTHORIZATION-PREFLIGHT-FAILURE-V1",
        workCellSpec: cell.spec_sha256,
        reason: message,
      });
      const assessment = this.requiredKernel().assess(state.goalId, route.route_id, cell.work_cell_id, {
        ...this.healthyAssessment(), assumptionInvalidated: true,
        failureSignatureSha256: failure, failureOccurrence: 1,
      }, this.mutation(`task-flow:authorization-preflight:${failure}`));
      state.version = assessment.authority.goalVersion;
      this.refresh();
      state.blocker = `Authorization preflight invalidated the route: ${message}`;
      return false;
    }
    const baselineResult = this.requiredKernel().recordBaseline(state.goalId, baseline, this.mutation(`task-flow:baseline:authorize:${baseline.record_sha256}`));
    state.version = baselineResult.goalVersion;
    this.ensureLease();
    const authorization = sealTaskFlowRecord<ExecutionAuthorizationRecord, "record_sha256">("PCH-EXECUTION-AUTHORIZATION-V1", {
      schema_version: 1,
      authorization_id: idFromSha256("AUTHORIZATION", sha256Hex(`${state.goalId}\0${cell.work_cell_id}\0${baseline.record_sha256}\0${state.lease.generation}`)),
      goal_id: state.goalId, contract_id: contract.contract_id, route_id: route.route_id,
      work_cell_id: cell.work_cell_id, baseline_id: baseline.baseline_id,
      lease_generation: state.lease.generation, fencing_token: state.lease.fencingToken,
      effect_ceiling: contract.authorization_ceiling,
      decision_closure_sha256: canonicalJsonSha256({ decisions: contract.decision_refs, route: route.record_sha256 }),
      allowed_scope_sha256: canonicalJsonSha256({ read: cell.read_roots, write: cell.write_roots, effects: cell.effect_classes }),
      expires_at_ms: this.now() + Math.max(3_600_000, this.options.config.execution.lease_ttl_ms * 120),
      created_at_ms: this.now(),
    }, "record_sha256");
    const result = this.requiredKernel().authorize(state.goalId, authorization, this.mutation(`task-flow:authorize:${authorization.record_sha256}`));
    state.version = result.goalVersion;
    this.refresh();
    return true;
  }

  private closeSucceededGoal(): void {
    const state = this.requiredActive();
    const contract = state.view.contract;
    const route = state.view.route;
    const baseline = this.requiredResources().authority.readLatestTaskFlowBaseline(state.goalId);
    if (!contract || !route || !baseline) throw new AuthorityIntegrityError("Goal closure lacks contract, route, or final baseline");
    const evidenceRoot = this.requiredResources().authority.readTaskFlowEvidenceRoot(state.goalId, baseline.record_sha256);
    const deliverable = sealTaskFlowRecord<DeliverableManifestRecord, "record_sha256">("PCH-DELIVERABLE-MANIFEST-V1", {
      schema_version: 1,
      deliverable_id: idFromSha256("DELIVERABLE", sha256Hex(`${state.goalId}\0${contract.record_sha256}\0${route.record_sha256}\0${baseline.record_sha256}\0${evidenceRoot}`)),
      goal_id: state.goalId, contract_id: contract.contract_id, route_id: route.route_id,
      final_baseline_id: baseline.baseline_id,
      obligation_closure_sha256: canonicalJsonSha256(contract.obligations.map((entry) => entry.record_sha256)),
      evidence_root_sha256: evidenceRoot, artifacts: [], result: "SUCCEEDED", created_at_ms: this.now(),
    }, "record_sha256");
    const result = this.requiredKernel().closeGoal(state.goalId, deliverable, this.mutation(`task-flow:deliverable:${deliverable.record_sha256}`));
    state.version = result.goalVersion;
    this.refresh();
    const harness = this.requiredResources().authority.readHarnessView(state.goalId);
    if (harness?.status === "ACTIVE" && harness.shards.every((shard) => ["SUCCEEDED", "SUPERSEDED"].includes(shard.status))) {
      const closed = this.requiredResources().authority.transactHarness({
        type: "CONTROL_MANAGED_RUN", goalId: state.goalId, runId: harness.runId,
        action: "SUCCEED", reasonSha256: deliverable.record_sha256,
      }, this.mutation(`coding-harness:run:succeed:${deliverable.record_sha256}`));
      state.version = closed.goalVersion;
    }
  }

  private captureBaseline(cell: WorkCellRecord): WorkspaceBaselineRecord {
    const normalizedRoots = [...new Set([...cell.read_roots, ...cell.write_roots])]
      .map((root) => normalizedRelativeRoot(this.requiredCwd(), root))
      .sort((left, right) => left.absolute.length - right.absolute.length || left.relative.localeCompare(right.relative));
    const roots = normalizedRoots.filter((root, index) => !normalizedRoots.slice(0, index).some((parent) => contained(parent.absolute, root.absolute)));
    const manifest: Array<Readonly<Record<string, unknown>>> = [];
    let fileCount = 0;
    let byteCount = 0;
    const direct = this.requiredActive().view.route?.lane === "DIRECT_CELL";
    const fileLimit = direct ? maximumDirectBaselineFiles : maximumBaselineFiles;
    const byteLimit = direct ? maximumDirectBaselineBytes : maximumBaselineBytes;
    const visit = (absolute: string, relativePath: string): void => {
      if (fileCount >= fileLimit || byteCount > byteLimit) {
        throw new TypeError("WorkCell baseline exceeds the bounded snapshot budget; narrow its read/write roots");
      }
      if (!existsSync(absolute)) {
        manifest.push({ path_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, relativePath), kind: "ABSENT" });
        return;
      }
      const entry = lstatSync(absolute);
      if (entry.isSymbolicLink() || !contained(this.requiredCwd(), realpathSync(absolute))) throw new TypeError(`Unsafe baseline link at ${relativePath}`);
      if (entry.isDirectory()) {
        manifest.push({ path_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, relativePath), kind: "DIRECTORY" });
        for (const child of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
          if (ignoredBaselineDirectories.has(child.name)) continue;
          visit(resolve(absolute, child.name), relativePath === "." ? child.name : `${relativePath}/${child.name}`);
        }
        return;
      }
      if (!entry.isFile()) throw new TypeError(`Unsupported baseline entry at ${relativePath}`);
      fileCount += 1;
      byteCount += entry.size;
      if (fileCount > fileLimit || byteCount > byteLimit) throw new TypeError("WorkCell baseline exceeds the bounded snapshot budget; narrow its read/write roots");
      manifest.push({
        path_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, relativePath), kind: "FILE",
        bytes: entry.size, sha256: this.baselineFileHash(absolute, entry),
      });
    };
    for (const root of roots) {
      visit(root.absolute, root.relative);
    }
    const environmentSha256 = canonicalJsonSha256({ node: process.version, platform: process.platform, arch: process.arch });
    const contentRootSha256 = canonicalJsonSha256(manifest);
    const baselineId = createId("BASELINE");
    return sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
      schema_version: 1, baseline_id: baselineId, workspace_id: this.requiredWorkspaceId(), goal_id: this.requiredActive().goalId,
      filesystem_identity_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, this.requiredCwd().replaceAll("\\", "/").toLowerCase()),
      content_root_sha256: contentRootSha256, environment_sha256: environmentSha256,
      oracle_set_sha256: canonicalJsonSha256(cell.oracle), scope_manifest: manifest, created_at_ms: this.now(),
    }, "record_sha256");
  }

  private baselineFileHash(path: string, entry: NonNullable<ReturnType<typeof lstatSync>>): string {
    const stamp = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`;
    const cached = this.baselineHashCache.get(path);
    if (cached?.stamp === stamp) return cached.sha256;
    const value = sha256Hex(readFileSync(path));
    this.baselineHashCache.delete(path);
    this.baselineHashCache.set(path, { stamp, sha256: value });
    while (this.baselineHashCache.size > maximumBaselineFiles) this.baselineHashCache.delete(this.baselineHashCache.keys().next().value!);
    return value;
  }
  private workerTransition(
    workerRunId: string, ordinal: number, state: WorkerRunTransitionRecord["state"], outputSha256: string | null,
    usage: WorkerUsage, failureSignatureSha256: string | null, predecessorSha256: string | null,
  ): WorkerRunTransitionRecord {
    return sealHarnessRecord<WorkerRunTransitionRecord, "transition_sha256">("PCH-WORKER-TRANSITION-V1", {
      schema_version: 1, transition_id: idFromSha256("WORKER_TRANSITION", sha256Hex(`${workerRunId}\0${ordinal}\0${state}`)),
      worker_run_id: workerRunId, ordinal, state, output_sha256: outputSha256, usage,
      failure_signature_sha256: failureSignatureSha256, predecessor_sha256: predecessorSha256, created_at_ms: this.now(),
    }, "transition_sha256");
  }

  private prepareHarnessPatchOperation(
    callId: string,
    cwd: string,
    operation: PatchEntry["operation"],
    path: string,
    contentSha256: string | null,
  ): TaskFlowOperationAdmission {
    return this.prepareToolOperation({
      toolCallId: callId, toolName: "coding_integrate", cwd,
      input: { path, operation, ...(contentSha256 === null ? {} : { content_sha256: contentSha256 }) },
    });
  }

  private recordHarnessIntegration(
    execution: HarnessWorkerExecution, patchSet: PatchSetRecord | null, resultName: IntegrationReceiptRecord["result"],
    postimageRootSha256: string | null, conflictPaths: readonly string[], operationIds: readonly string[],
    transactionJournalSha256: string | null = null,
  ): IntegrationReceiptRecord {
    const state = this.requiredActive();
    const receipt = sealHarnessRecord<IntegrationReceiptRecord, "receipt_sha256">("PCH-INTEGRATION-RECEIPT-V1", {
      schema_version: 1,
      integration_id: idFromSha256("INTEGRATION", sha256Hex(`${execution.worker.worker_run_id}\0${patchSet?.patch_sha256 ?? "NO_PATCH"}\0${resultName}`)),
      run_id: execution.worker.run_id, shard_id: execution.shard.shard_id, patch_set_id: patchSet?.patch_set_id ?? null,
      transaction_journal_sha256: transactionJournalSha256,
      result: resultName, preimage_root_sha256: execution.baselineContentRootSha256,
      postimage_root_sha256: postimageRootSha256, conflict_paths: conflictPaths, operation_ids: operationIds, created_at_ms: this.now(),
    }, "receipt_sha256");
    const authority = this.requiredResources().authority.transactHarness({
      type: "RECORD_HARNESS_INTEGRATION", goalId: state.goalId, receipt,
    }, this.mutation(`coding-harness:integration:${receipt.receipt_sha256}`));
    state.version = authority.goalVersion;
    this.refresh();
    return receipt;
  }

  private recordRecoveredPatchTransaction(
    transaction: OpenPatchTransactionView,
    resultName: "REJECTED" | "OUTCOME_UNKNOWN",
    affectedPaths: readonly string[],
  ): IntegrationReceiptRecord {
    const state = this.requiredActive();
    const receipt = sealHarnessRecord<IntegrationReceiptRecord, "receipt_sha256">("PCH-INTEGRATION-RECEIPT-V1", {
      schema_version: 1,
      integration_id: idFromSha256("INTEGRATION", sha256Hex(`${transaction.patchSetId}\0${transaction.journalSha256}\0RECOVERY\0${resultName}`)),
      run_id: transaction.runId, shard_id: transaction.shardId, patch_set_id: transaction.patchSetId,
      transaction_journal_sha256: transaction.journalSha256, result: resultName,
      preimage_root_sha256: transaction.preimageRootSha256, postimage_root_sha256: null,
      conflict_paths: resultName === "OUTCOME_UNKNOWN" ? affectedPaths : [], operation_ids: [], created_at_ms: this.now(),
    }, "receipt_sha256");
    const authority = this.requiredResources().authority.transactHarness({
      type: "RECORD_HARNESS_INTEGRATION", goalId: state.goalId, receipt,
    }, this.mutation(`coding-harness:patch-transaction:recover:${receipt.receipt_sha256}`));
    state.version = authority.goalVersion;
    this.refresh();
    return receipt;
  }
  private assessHarnessIntegrationFailure(
    execution: HarnessWorkerExecution,
    receipt: IntegrationReceiptRecord,
  ): void {
    this.assessHarnessIntegrationResult(execution.worker.role, receipt);
  }

  private assessHarnessIntegrationResult(
    role: WorkShardRecord["role"],
    receipt: IntegrationReceiptRecord,
  ): void {
    const state = this.requiredActive();
    const route = state.view.route;
    if (!route || !["CONFLICT", "REJECTED", "OUTCOME_UNKNOWN"].includes(receipt.result)) return;
    const shard = this.requiredResources().authority.readHarnessShard(state.goalId, receipt.shard_id);
    const unknownEffect = receipt.result === "OUTCOME_UNKNOWN";
    const signature = canonicalJsonSha256({
      domain: "PCH-INTEGRATION-FAILURE-V1",
      result: receipt.result,
      role,
      paths: [...receipt.conflict_paths].sort(),
    });
    const assessment: RouteHealthInput = {
      ...this.healthyAssessment(),
      unknownEffect,
      assumptionInvalidated: !unknownEffect,
      failureSignatureSha256: signature,
      failureOccurrence: Math.max(1, shard?.attemptCount ?? 1),
      transientFailure: false,
      localRepairAvailable: false,
      routeAlternativeAvailable: true,
    };
    const result = this.requiredKernel().assess(
      state.goalId, route.route_id, shard?.spec.work_cell_id ?? state.view.workCellId, assessment,
      this.mutation(`coding-harness:integration-health:${receipt.receipt_sha256}`),
    );
    state.version = result.authority.goalVersion;
    this.refresh();
  }
  private healthyAssessment(): RouteHealthInput {
    const state = this.active;
    const contract = state?.view.contract;
    const route = state?.view.route;
    const currentRecordCount = (contract ? 1 + contract.obligations.length : 0)
      + (route ? 1 + route.work_cells.length : 0)
      + (state?.view.authorization ? 1 : 0)
      + (state?.view.latestHealth ? 1 : 0);
    return {
      activeObligationCount: contract?.obligations.length ?? 0, currentRecordCount,
      unknownEffect: false, authorityIntegrityFailure: false, materialDecisionOpen: false,
      assumptionInvalidated: false, acceptanceUnreachable: false, failureSignatureSha256: null,
      failureOccurrence: 0, retryLimit: Math.max(1, this.options.config.execution.same_failure_retry_limit),
      transientFailure: false, localRepairAvailable: false, routeAlternativeAvailable: true, progressObserved: false,
    };
  }

  private targetWithinRoots(target: string, roots: readonly string[]): boolean {
    const absolute = resolve(target);
    return roots.some((root) => {
      const candidate = normalizedRelativeRoot(this.requiredCwd(), root).absolute;
      return contained(candidate, absolute);
    });
  }

  private finalizeRouteProposal(contract: GoalContractRecord, proposal: RouteProposal): RouteSkeletonRecord {
    const state = this.requiredActive();
    const prior = state.view.route ?? this.requiredResources().authority.readLatestTaskFlowRouteRef(state.goalId);
    const proposedRoots = proposal.work_cells.flatMap((cell) => [...cell.read_roots, ...cell.write_roots]);
    const normalizedRoots = proposedRoots.map((root) => normalizedRelativeRoot(this.requiredCwd(), root));
    const boundedScope = normalizedRoots.length > 0 && normalizedRoots.length <= 32 && normalizedRoots.every((normalized) => {
      return normalized.relative !== "." && (!existsSync(normalized.absolute) || lstatSync(normalized.absolute).isFile());
    });
    return finalizeRoute({
      contract, revision: (prior?.revision ?? 0) + 1, parentRouteId: prior?.route_id ?? null,
      proposal, createdAtMs: this.now(),
      materialDecisionOpen: this.requiredResources().authority.readOpenTaskFlowDecisionCount(state.goalId) > 0,
      boundedScopeOverride: boundedScope,
      priorRoute: state.view.route,
    });
  }
  private clarificationDecision(decision: ClarificationDecision, selectedOptionId: string | null): TaskDecisionEntryRecord {
    const state = this.requiredActive();
    const { selectedOptionId: _selection, ...decisionBinding } = decision as ClarificationSelection;
    void _selection;
    const bindingSha256 = canonicalJsonSha256({
      goal: state.goalId, contract: state.view.contract?.record_sha256 ?? null,
      route: state.view.route?.record_sha256 ?? null, decision: decisionBinding,
    });
    const decisionState = selectedOptionId === null ? "OPEN" as const : "RESOLVED" as const;
    const selection = selectedOptionId === null ? null : { option_id: selectedOptionId };
    const decisionEntryId = idFromSha256("DECISION", sha256Hex(`${bindingSha256}\0${decisionState}\0${selectedOptionId ?? "NONE"}`));
    return sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1, decision_entry_id: decisionEntryId, goal_id: state.goalId,
      contract_id: state.view.contract?.contract_id ?? null, route_id: state.view.route?.route_id ?? null,
      decision_key: `CLARIFICATION:${decision.id}`.slice(0, 160), authority_actor: "USER",
      materiality: decision.materiality, reversible: decision.reversible, privacy_related: decision.privacyRelated,
      question_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, decision.question),
      recommendation: {
        option_id: decision.recommendedOptionId, reason: decision.recommendationReason,
        clarification: decisionBinding,
      },
      selection, state: decisionState, binding_sha256: bindingSha256,
      created_at_ms: this.now(), expires_at_ms: null,
    }, "record_sha256");
  }

  private controlDecision(action: "PAUSE" | "RESUME" | "CANCEL", reason?: string): TaskDecisionEntryRecord {
    const state = this.requiredActive();
    const reasonSha256 = sha256Hex((reason ?? "user requested control").normalize("NFC"));
    const selection = { action, reason_sha256: reasonSha256, prior_status: state.view.status, prior_next_action: state.view.nextActionCode };
    const bindingSha256 = canonicalJsonSha256({ goal: state.goalId, selection, version: state.version });
    return sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1,
      decision_entry_id: idFromSha256("DECISION", sha256Hex(`${bindingSha256}\0${action}`)),
      goal_id: state.goalId, contract_id: state.view.contract?.contract_id ?? null,
      route_id: state.view.route?.route_id ?? null, decision_key: "USER_CONTROL", authority_actor: "USER",
      materiality: action === "CANCEL" ? "HIGH" : "MEDIUM", reversible: action !== "CANCEL",
      privacy_related: false, question_hmac: hmacSha256Hex(this.requiredResources().workspaceSecret, `USER_CONTROL:${action}`),
      recommendation: { recommended: action }, selection, state: "RESOLVED",
      binding_sha256: bindingSha256, created_at_ms: this.now(), expires_at_ms: null,
    }, "record_sha256");
  }

  private hashTarget(path: string): string {
    if (!contained(this.requiredCwd(), path)) throw new TypeError("Readback target escapes workspace");
    if (!existsSync(path)) return sha256Hex("PCH-ABSENT-V1");
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || !contained(this.requiredCwd(), realpathSync(path))) throw new TypeError("Readback target is not a safe regular file");
    const size = statSync(path).size;
    if (size > maximumBaselineBytes) throw new TypeError("Readback target exceeds bounded hash budget");
    return sha256Hex(readFileSync(path));
  }

  private currentCell(): WorkCellRecord | null {
    const state = this.active;
    const id = state?.view.workCellId;
    return id ? state.view.route?.work_cells.find((cell) => cell.work_cell_id === id) ?? null : null;
  }

  private createOperationLifecycle(resources: CodingHarnessResources): TaskFlowOperationLifecycle {
    const adapter: TaskFlowOperationAdapter = {
      current: () => this.active,
      workspaceRoot: () => this.requiredCwd(),
      workspaceSecret: () => resources.workspaceSecret,
      executionSubject: () => this.executionSubject(),
      ensureLease: () => this.ensureLease(),
      mutation: (idempotencyKey) => this.mutation(idempotencyKey),
      accept: (result) => {
        const state = this.requiredActive();
        state.version = result.goalVersion;
        this.refresh();
      },
      targetWithinRoots: (target, roots) => this.targetWithinRoots(target, roots),
      hashTarget: (path) => this.hashTarget(path),
      captureBaseline: (cell) => this.captureBaseline(cell),
      completeWork: () => this.completeWork(),
      authorizeNextWork: () => this.authorizeNextWork(),
      clearBlocker: () => { this.requiredActive().blocker = null; },
      retryLimit: () => this.options.config.execution.same_failure_retry_limit,
    };
    return new TaskFlowOperationLifecycle(
      resources.authority,
      { now: this.now, monotonicNow: this.now },
      adapter,
    );
  }

  private renderGoalGraph(): string {
    const state = this.requiredActive();
    const route = state.view.route;
    if (!route) return `Goal ${state.goalId}\nContract=${state.view.contract?.contract_id ?? "pending"}\nRoute=pending`;
    const lines = [
      `Goal ${state.goalId}`,
      `Contract ${route.contract_id} -> Route ${route.route_id} r${route.revision} (${route.lane})`,
    ];
    for (const cell of route.work_cells) {
      const marker = cell.work_cell_id === state.view.workCellId ? "RUNNING" : cell.horizon;
      lines.push(`${cell.work_cell_id} [${marker}] <- ${cell.dependencies.join(",") || "root"}`);
    }
    const deferred = route.deferred_outcomes ?? [];
    for (const item of deferred.slice(0, 32)) lines.push(`${item.deferred_outcome_id} [DEFERRED:${item.expansion_trigger}] <- ${item.dependencies.join(",") || "root"}`);
    if (deferred.length > 32) lines.push(`... ${deferred.length - 32} deferred outcomes omitted by display bound`);
    lines.push(`Next=${state.view.nextActionCode} Health=${routeHealth(state.view)}`);
    return lines.join("\n");
  }

  private publish(kind: string, id: string, value: object): void {
    const root = resolve(this.requiredCwd(), ".coding-harness", "task-flow");
    const json = `${JSON.stringify(value, null, 2)}\n`;
    publishImmutable(resolve(root, `${kind}.${id}.json`), json);
    const markdown = `# ${kind === "goal-contract" ? "Goal Contract" : "Route Skeleton"}\n\n- ID: \`${id}\`\n- SHA-256: \`${"record_sha256" in value ? String((value as { record_sha256: unknown }).record_sha256) : canonicalJsonSha256(value)}\`\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
    publishImmutable(resolve(root, `${kind}.${id}.md`), markdown);
  }

  private reconcileTerminalManagedRun(resources: CodingHarnessResources): void {
    const activeRun = resources.authority.readActiveHarnessRunForWorkspace(this.requiredWorkspaceId());
    const terminal = activeRun?.taskFlowTerminalStatus;
    if (!activeRun || terminal === null) return;
    const action = terminal === "SUCCEEDED" ? "SUCCEED" : terminal === "FAILED" ? "FAIL" : "CANCEL";
    const lease = resources.authority.acquireLease(
      activeRun.goalId, this.requiredSessionId(), this.options.config.execution.lease_ttl_ms,
    );
    resources.authority.transactHarness({
      type: "CONTROL_MANAGED_RUN", goalId: activeRun.goalId, runId: activeRun.runId,
      action, reasonSha256: canonicalJsonSha256({ terminal, repair: "TERMINAL_TASK_FLOW_MANAGED_RUN" }),
    }, {
      expectedVersion: resources.authority.readTaskFlowGoalVersion(activeRun.goalId),
      idempotencyKey: `coding-harness:repair-terminal-run:${activeRun.runId}:${terminal}`,
      actor: "RUNTIME", lease,
    });
  }

  private refresh(recover = false): void {
    const state = this.requiredActive();
    state.view = recover ? this.requiredKernel().recover(state.goalId).view
      : this.requiredResources().authority.readTaskFlowView(state.goalId) ?? state.view;
    state.version = this.requiredResources().authority.readTaskFlowGoalVersion(state.goalId);
    this.syncMemoryContext();
  }

  private syncMemoryContext(): void {
    const state = this.active;
    this.services.setTaskFlowMemoryContext(state ? {
      goalId: state.goalId, objectiveSha256: state.objectiveSha256,
      contractSha256: state.view.contract?.record_sha256 ?? null,
      routeSha256: state.view.route?.record_sha256 ?? null,
      workCellId: state.view.workCellId, mode: statusMode(state.view),
    } : null);
  }

  private ensureLease(): void {
    const state = this.requiredActive();
    const authority = this.requiredResources().authority;
    const now = this.now();
    const ttlMs = this.options.config.execution.lease_ttl_ms;
    if (state.lease.expiresAtMs <= now) {
      state.lease = authority.acquireLease(state.goalId, this.requiredSessionId(), ttlMs);
    } else if (state.lease.expiresAtMs - now <= Math.floor(ttlMs / 2)) {
      state.lease = authority.renewLease(state.lease, ttlMs, Math.max(1, state.version));
    }
  }

  private mutation(idempotencyKey: string): MutationMeta {
    if (this.pendingCompactionAttemptId || this.compactionRecoveryRequired) {
      throw new AuthorityIntegrityError("Authority mutation is blocked while the compaction frontier is unresolved; resume to reconcile compaction");
    }
    this.ensureLease();
    const state = this.requiredActive();
    return { expectedVersion: state.version, idempotencyKey, actor: "RUNTIME", lease: state.lease };
  }

  private requiredResources(): CodingHarnessResources {
    const resources = this.services.resources();
    if (!resources) throw new TypeError("Task Flow runtime is not initialized");
    return resources;
  }

  private requiredKernel(): TaskFlowKernel { if (!this.kernel) throw new TypeError("Task Flow kernel is not initialized"); return this.kernel; }
  private requiredOperationLifecycle(): TaskFlowOperationLifecycle {
    if (!this.operationLifecycle) throw new TypeError("Task Flow operation lifecycle is not initialized");
    return this.operationLifecycle;
  }
  private requiredActive(): ActiveTaskFlowState { if (!this.active) throw new TypeError("No active Task Flow Goal"); return this.active; }
  private requiredCwd(): string { if (!this.cwd) throw new TypeError("Task Flow workspace is unavailable"); return this.cwd; }
  private requiredSessionId(): string { if (!this.sessionId) throw new TypeError("Task Flow session ID is unavailable"); return this.sessionId; }
  private requiredWorkspaceId(): string { if (!this.workspaceId) throw new TypeError("Task Flow workspace ID is unavailable"); return this.workspaceId; }
}
