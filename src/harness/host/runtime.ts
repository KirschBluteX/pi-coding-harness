import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import { assertWalRuntimeSafe } from "../../authority/sqlite-runtime.js";
import { loadConfig } from "../../config/load-config.js";
import { resolveHarnessRuntimeConfig, type HarnessRuntimeResolution } from "../../config/runtime-resolution.js";
import { normalizeToolEffect, type ToolInvocation } from "../../effects/normalize.js";
import type { ContextProjectionDelta } from "../../input-context/projection-delta.js";
import type { ClarificationDecision } from "../../planning/clarification.js";
import { hmacSha256Hex } from "../../foundation/crypto.js";
import { TaskFlowSession, type HarnessShardProposal, type TaskFlowAttestationInput } from "../../runtime/task-flow-session.js";
import type { GoalContractProposal, RouteProposal } from "../../task-flow/finalize.js";
import type { RouteRevisionPatch } from "../../task-flow/route-revision.js";
import type { ExecutionTopology } from "../domain.js";
import type { MultiWorkerExecutor } from "../worker/executor.js";
import { HarnessContextRuntime } from "./context-runtime.js";
import { CacheV2Runtime } from "../../cache-v2/runtime.js";
import type { ContextToolRequest } from "../../input-context/context-tool.js";
import type { MemoryCommandRequest } from "../../memory/commands.js";
import { assertCurrentControlFrame } from "../../control/control-frame.js";
import {
  GenerationGovernor, type GenerationFrontier,
} from "../../control/generation-governor.js";
import {
  parseHostApplicationRequest,
  validateHostApplicationResult,
  type HostMethod,
  type HostParams,
  type HostResult,
} from "./application-protocol.js";

export interface CodingHarnessHostOptions {
  readonly packageRoot: string;
  readonly configPath: string;
  readonly hostSecret: Uint8Array;
  readonly dataRoot?: string;
  readonly now?: () => number;
}

interface EnterParams {
  readonly cwd: string;
  readonly session_id: string;
  readonly objective: string;
  readonly intent: "PLAN" | "BUILD";
  readonly topology: ExecutionTopology;
  readonly runtime: {
    readonly provider: string;
    readonly api: string;
    readonly base_url?: string;
    readonly model: string;
    readonly thinking_level: string;
    readonly context_window: number;
  };
}

interface SelectedClarification extends ClarificationDecision {
  readonly selectedOptionId: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 131_072): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function integer(value: unknown, label: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function enterParams(value: unknown): EnterParams {
  const row = record(value, "enter params");
  const cwd = text(row.cwd, "cwd", 4_096);
  if (!isAbsolute(cwd)) throw new TypeError("cwd must be absolute");
  const runtime = record(row.runtime, "runtime");
  return {
    cwd: resolve(cwd), session_id: text(row.session_id, "session_id", 256), objective: text(row.objective, "objective"),
    intent: oneOf(row.intent, ["PLAN", "BUILD"] as const, "intent"),
    topology: oneOf(row.topology, ["SINGLE", "MULTI"] as const, "topology"),
    runtime: {
      provider: text(runtime.provider, "runtime.provider", 256), api: text(runtime.api, "runtime.api", 256),
      ...(runtime.base_url === undefined ? {} : { base_url: text(runtime.base_url, "runtime.base_url", 2_048) }),
      model: text(runtime.model, "runtime.model", 512),
      thinking_level: text(runtime.thinking_level, "runtime.thinking_level", 64),
      context_window: integer(runtime.context_window, "runtime.context_window", 1),
    },
  };
}

export class CodingHarnessHostRuntime {
  private session: TaskFlowSession | null = null;
  private contextRuntime: HarnessContextRuntime | null = null;
  private runtimeResolution: HarnessRuntimeResolution | null = null;
  private cacheRuntime: CacheV2Runtime | null = null;
  private readonly generationGovernor = new GenerationGovernor();
  private entered: EnterParams | null = null;
  private stopping = false;
  private leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  private workers: Promise<MultiWorkerExecutor> | null = null;
  private workerJob: {
    readonly id: string;
    readonly aborts: readonly AbortController[];
    readonly workerCount: number;
    readonly startedAtMs: number;
    state: "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED";
    result: unknown;
    error: string | null;
    completion: Promise<void>;
  } | null = null;

  constructor(private readonly options: CodingHarnessHostOptions) {}

  dispatch<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>;
  dispatch(method: string, params: unknown): Promise<unknown>;
  async dispatch(method: string, params: unknown): Promise<unknown> {
    const request = parseHostApplicationRequest(method, params);
    const result = await this.handleApplicationRequest(request.method, request.params);
    return validateHostApplicationResult(request.method, result);
  }

  private async handleApplicationRequest(method: HostMethod, params: unknown): Promise<unknown> {
    if (method === "status") return this.status();
    if (method === "shutdown") {
      this.stopping = true;
      await this.shutdownGracefully();
      return { stopped: true };
    }
    if (this.stopping) throw new TypeError("Coding Harness Host is stopping");
    if (method === "enter") return this.enter(params);
    const session = this.requiredSession();
    if (method === "update_runtime") {
      const row = record(params, "runtime update");
      const current = this.entered!;
      this.entered = enterParams({ ...current, runtime: row });
      this.contextRuntime?.updateRuntime(this.entered.runtime);
      return { runtime: this.entered.runtime };
    }
    if (method === "worker_start") {
      return this.startWorkerJob(session, this.boundParams(params, "worker_start"));
    }
    if (method === "worker_poll") return this.pollWorkerJob(params);
    if (method === "worker_abort") return this.abortWorkerJob(params);
    if (method === "turn_projection") {
      const row = record(params, "turn_projection params");
      const activeTools = stringArray(row.active_tools, "active_tools");
      const allTools = stringArray(row.all_tools, "all_tools");
      const currentInputTokens = row.current_input_tokens === null || row.current_input_tokens === undefined
        ? null : integer(row.current_input_tokens, "current_input_tokens", 0);
      const prepared = this.requiredContext().prepare({
        systemPromptSha256: text(row.system_prompt_sha256, "system_prompt_sha256", 64),
        ...(row.system_prompt === undefined ? {} : { systemPrompt: text(row.system_prompt, "system_prompt", 2_097_152) }),
        currentInputTokens, activeTools, allTools,
      });
      this.startLeaseHeartbeat(session);
      const generationGovernor = this.generationGovernor.beginAgentRun(
        text(row.agent_run_id, "agent_run_id", 256), this.generationFrontier(),
      );
      return { ...prepared, generation_governor: generationGovernor };
    }
    if (method === "context_project") {
      const row = record(params, "context_project params");
      const deltaRow = record(row.delta, "context projection delta");
      if (deltaRow.schema_version !== 1) throw new TypeError("context projection delta schema_version must be 1");
      if (!Array.isArray(deltaRow.append) || deltaRow.append.length > 16_384) throw new TypeError("delta append must be a bounded array");
      const append = deltaRow.append.map((item, index) => {
        const descriptor = record(item, `descriptor ${index}`);
        const contentSha256 = text(descriptor.content_sha256, `descriptor ${index} content_sha256`, 64);
        if (!/^[a-f0-9]{64}$/u.test(contentSha256)) throw new TypeError(`descriptor ${index} content_sha256 is invalid`);
        return {
          contentSha256,
          role: text(descriptor.role, `descriptor ${index} role`, 128),
          customType: descriptor.custom_type === null ? null : text(descriptor.custom_type, `descriptor ${index} custom_type`, 256),
        };
      });
      const lineageId = text(deltaRow.lineage_id, "delta.lineage_id", 64);
      const previousRoot = text(deltaRow.previous_sequence_root, "delta.previous_sequence_root", 64);
      const newRoot = text(deltaRow.new_sequence_root, "delta.new_sequence_root", 64);
      if (![lineageId, previousRoot, newRoot].every((value) => /^[a-f0-9]{64}$/u.test(value))) {
        throw new TypeError("context projection delta hashes are invalid");
      }
      if (typeof deltaRow.full_reconcile !== "boolean") throw new TypeError("delta.full_reconcile must be boolean");
      const delta: ContextProjectionDelta = {
        schema_version: 1, lineage_id: lineageId, previous_sequence_root: previousRoot,
        previous_count: integer(deltaRow.previous_count, "delta.previous_count", 0, 16_384),
        append, new_sequence_root: newRoot,
        new_count: integer(deltaRow.new_count, "delta.new_count", 0, 16_384),
        full_reconcile: deltaRow.full_reconcile,
      };
      const removed = integer(row.removed_persisted_messages, "removed_persisted_messages", 0);
      return this.requiredContext().projectDescriptorDelta(delta, removed);
    }
    if (method === "context_fetch") {
      const row = this.boundParams(params, "context_fetch");
      const keys = Object.keys(row);
      if (typeof row.cursor === "string") {
        if (keys.length !== 1 || row.cursor.length < 1 || row.cursor.length > 16_384) {
          throw new TypeError("context cursor request is invalid");
        }
        const response = await this.requiredContext().context({ cursor: row.cursor });
        this.recordGenerationEvidence("context_fetch", response);
        return response;
      }
      if (keys.some((key) => !["selector", "candidate_ids", "representation"].includes(key))) {
        throw new TypeError("context selection contains unknown fields");
      }
      const selector = oneOf(row.selector, ["CURRENT_ON_DEMAND", "CURRENT_WORKING_SET"] as const, "selector");
      const representation = row.representation === undefined
        ? undefined : oneOf(row.representation, ["EXACT", "STRUCTURAL"] as const, "representation");
      const candidateIds = row.candidate_ids === undefined ? undefined : stringArray(row.candidate_ids, "candidate_ids");
      if (candidateIds && (candidateIds.length < 1 || candidateIds.length > 10)) {
        throw new TypeError("candidate_ids must contain 1..10 current candidate IDs");
      }
      const request: ContextToolRequest = {
        selector,
        ...(candidateIds === undefined ? {} : { candidate_ids: candidateIds }),
        ...(representation === undefined ? {} : { representation }),
      };
      const response = await this.requiredContext().context(request);
      this.recordGenerationEvidence("context_fetch", response);
      return response;
    }
    if (method === "provider_begin") {
      const row = record(params, "provider_begin params");
      const historyRow = record(row.history, "provider history");
      const shape = text(row.payload_shape_sha256, "payload_shape_sha256", 64);
      const root = text(historyRow.descriptor_root_sha256, "descriptor_root_sha256", 64);
      if (!/^[a-f0-9]{64}$/u.test(shape) || !/^[a-f0-9]{64}$/u.test(root)) {
        throw new TypeError("provider request hashes are invalid");
      }
      const boundedCount = (value: unknown, label: string): number => {
        const result = integer(value, label, 0);
        if (result > 1_000_000_000) throw new TypeError(`${label} exceeds its bound`);
        return result;
      };
      const recorded = this.requiredContext().beginProviderTurn({
        payloadShapeSha256: shape,
        history: {
          descriptorRootSha256: root,
          messageCount: boundedCount(historyRow.message_count, "history.message_count"),
          logicalBytes: boundedCount(historyRow.logical_bytes, "history.logical_bytes"),
          userBytes: boundedCount(historyRow.user_bytes, "history.user_bytes"),
          assistantBytes: boundedCount(historyRow.assistant_bytes, "history.assistant_bytes"),
          otherBytes: boundedCount(historyRow.other_bytes, "history.other_bytes"),
        },
        toolSchemaBytes: boundedCount(row.tool_schema_bytes, "tool_schema_bytes"),
      });
      let cacheRequestId: string | null = null;
      if (this.cacheRuntime && this.entered) {
        try { cacheRequestId = this.cacheRuntime.prepare(this.entered.runtime, this.requiredContext().cacheSeed()); }
        catch { cacheRequestId = null; }
      }
      return { recorded, cache_request_id: cacheRequestId };
    }
    if (method === "provider_settle") {
      const row = record(params, "provider_settle params");
      const number = (value: unknown, label: string): number => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} is invalid`);
        return value;
      };
      const nullableNumber = (value: unknown, label: string): number | null => value === null ? null : number(value, label);
      const status = row.response_status === null ? null : integer(row.response_status, "response_status", 100);
      const latency = row.latency_ms === null ? null : number(row.latency_ms, "latency_ms");
      const parsedUsage = row.usage === null ? null : (() => {
        const usage = record(row.usage, "provider usage");
        return {
          input: nullableNumber(usage.input, "usage.input"), output: nullableNumber(usage.output, "usage.output"),
          cacheRead: nullableNumber(usage.cacheRead, "usage.cacheRead"), cacheWrite: nullableNumber(usage.cacheWrite, "usage.cacheWrite"),
          reasoning: nullableNumber(usage.reasoning, "usage.reasoning"),
        };
      })();
      const ledgerSha256 = this.requiredContext().settleProviderTurn({
        usage: parsedUsage,
        responseStatus: status,
        outcome: oneOf(row.outcome, ["RESPONDED", "FAILED", "OUTCOME_UNKNOWN"] as const, "outcome"),
        assistantTextBytes: integer(row.assistant_text_bytes, "assistant_text_bytes", 0),
        toolArgumentBytes: integer(row.tool_argument_bytes, "tool_argument_bytes", 0),
      });
      this.generationGovernor.recordProviderTurn();
      let cache: unknown = null;
      const cacheRequestId = row.cache_request_id === null ? null : text(row.cache_request_id, "cache_request_id", 256);
      if (cacheRequestId !== null && this.cacheRuntime) {
        const cacheUsage = parsedUsage ?? { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
        try { cache = this.cacheRuntime.settle(cacheRequestId, { usage: cacheUsage, responseStatus: status, latencyMs: latency }); }
        catch { cache = null; }
      }
      return { ledger_sha256: ledgerSha256, cache };
    }
    if (method === "generation_turn") {
      const row = record(params, "generation_turn params");
      return this.generationGovernor.observeTurn(
        integer(row.turn_index, "turn_index", 0, 1_000_000), this.generationFrontier(),
      );
    }
    if (method === "generation_settled") {
      if (params !== null && (typeof params !== "object" || Array.isArray(params))) {
        throw new TypeError("generation_settled params must be null or an object");
      }
      try {
        return this.generationGovernor.settleAgentRun(this.generationFrontier());
      } finally {
        this.stopLeaseHeartbeat();
      }
    }
    if (method === "cache_diagnostic") {
      const resources = session.resources();
      const harness = session.harnessView();
      const configured = this.runtimeResolution?.config.modules.cache;
      const effective = this.cacheRuntime && this.entered
        ? this.cacheRuntime.effective(this.entered.runtime)
        : { arm: "C0" as const, providerIntegration: null, reason: "DISABLED" as const };
      const summary = resources && harness ? resources.authority.cacheV2Summary(harness.runId) : null;
      const effectiveInput = summary
        ? summary.uncachedInputTokens + summary.cacheReadTokens + summary.cacheWriteTokens : 0;
      const tokenReadShare = effectiveInput > 0 ? summary!.cacheReadTokens / effectiveInput : null;
      return {
        message: `Cache v2 configured=${configured?.enabled ? 1 : 0} configuredArm=${configured?.arm ?? "C0"}`
          + ` effectiveArm=${effective.arm} providerIntegration=${effective.providerIntegration ?? "none"}`
          + ` reason=${effective.reason} requests=${summary?.prepared ?? 0} settled=${summary?.settled ?? 0}`
          + ` pending=${summary?.pending ?? 0} confirmedHits=${summary?.confirmedHits ?? 0}`
          + ` unobservable=${summary?.unobservable ?? 0} errors=${summary?.errors ?? 0}`
          + ` cacheReadTokens=${summary?.cacheReadTokens ?? 0}`
          + ` tokenReadShare=${tokenReadShare === null ? "unknown" : tokenReadShare.toFixed(4)}. `
          + "Zero cacheRead remains unknown; confirmedHits is not a request hit-rate denominator.",
      };
    }
    if (method === "memory_observe") {
      const row = record(params, "memory_observe params");
      const value = text(row.text, "memory_observe.text", 16_384);
      session.observeMemoryInput(value, row.goal_intake === true);
      return { observed: true };
    }
    if (method === "memory_command") {
      return { message: session.memoryCommand(record(params, "memory command") as unknown as MemoryCommandRequest) };
    }
    if (method === "submit_build") {
      const row = this.boundParams(params, "submit_build");
      return {
        message: session.submitBuild(
          record(row.contract, "build contract") as unknown as GoalContractProposal,
          record(row.route, "build route") as unknown as RouteProposal,
        ),
        status: this.status(),
      };
    }
    if (method === "submit_contract") {
      const row = this.boundParams(params, "submit_contract");
      return { message: session.submitContract(row as unknown as GoalContractProposal), status: this.status() };
    }
    if (method === "submit_route") {
      const row = this.boundParams(params, "submit_route");
      return { message: session.submitRoute(row as unknown as RouteProposal), status: this.status() };
    }
    if (method === "submit_route_revision") {
      const row = this.boundParams(params, "submit_route_revision");
      return { message: session.submitRouteRevision(row as unknown as RouteRevisionPatch), status: this.status() };
    }
    if (method === "continue_plan") {
      const row = record(params, "continue_plan params");
      return { message: session.resolvePlanContinuation(oneOf(row.choice, ["BUILD", "KEEP", "REVISE"] as const, "choice")), status: this.status() };
    }
    if (method === "define_shards") {
      const row = this.boundParams(params, "define_shards");
      if (!Array.isArray(row.shards)) throw new TypeError("shards must be an array");
      return { harness: session.defineHarnessShards(row.shards as unknown as readonly HarnessShardProposal[]), status: this.status() };
    }
    if (method === "tool_preflight") {
      const invocation = this.boundParams(params, "tool_preflight") as unknown as ToolInvocation;
      const normalized = normalizeToolEffect(invocation);
      const harness = session.harnessView();
      if (harness?.effectiveTopology === "MULTI"
        && normalized.effectClass !== "READ_ONLY"
        && normalized.classificationReason !== "ALLOWLISTED_LOCAL_VALIDATION") {
        return { allow: false, managed: true, capture: false, reason: "MULTI_CANONICAL_MUTATION_REQUIRES_HOST_INTEGRATION" };
      }
      const contextAdmission = this.requiredContext().guard(invocation);
      if (!contextAdmission.allow) return { ...contextAdmission, managed: false, capture: false };
      const admission = session.prepareToolOperation(invocation);
      return {
        ...admission,
        capture: admission.allow && this.requiredContext().capturesToolResults(),
        ...this.controlFrameReceipt(),
      };
    }
    if (method === "tool_result") {
      const row = record(params, "tool_result params");
      const result = text(row.text, "text", 1_048_576);
      const outputSha256 = row.output_sha256 === undefined ? undefined : text(row.output_sha256, "output_sha256", 64);
      if (outputSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(outputSha256)) {
        throw new TypeError("output_sha256 must be a lowercase SHA-256");
      }
      const operationId = session.observeToolResult(
        text(row.tool_call_id, "tool_call_id", 256), row.is_error === true, result, outputSha256,
      );
      try {
        this.requiredContext().capture({
          toolName: text(row.tool_name, "tool_name", 256),
          toolInput: record(row.tool_input, "tool_input"), result, isError: row.is_error === true,
        });
      } catch {
        // Optional evidence capture cannot invalidate the authoritative tool outcome.
      }
      this.recordGenerationEvidence("tool_result", {
        tool_name: text(row.tool_name, "tool_name", 256),
        tool_input_sha256: canonicalJsonSha256(record(row.tool_input, "tool_input")),
        output_sha256: outputSha256 ?? canonicalJsonSha256({ result }),
        is_error: row.is_error === true,
      });
      return { operation_id: operationId, ...this.controlFrameReceipt() };
    }
    if (method === "tool_end") {
      const row = record(params, "tool_end params");
      session.endToolOperation(text(row.tool_call_id, "tool_call_id", 256), row.is_error === true, text(row.text, "text", 1_048_576));
      return { status: this.status(), ...this.controlFrameReceipt() };
    }
    if (method === "attest") {
      return { message: session.attest(this.boundParams(params, "attest") as unknown as TaskFlowAttestationInput), status: this.status() };
    }
    if (method === "complete") {
      this.boundParams(params, "complete");
      return { message: session.completeWork(), status: this.status() };
    }
    if (method === "reconcile") {
      const row = this.boundParams(params, "reconcile");
      return { message: session.reconcileOperations(typeof row.operation_id === "string" ? row.operation_id : undefined), status: this.status() };
    }
    if (method === "control") {
      const raw = record(params, "control params");
      const row = raw.control_frame_sha256 === undefined ? raw : this.boundParams(params, "control");
      const action = oneOf(row.action, ["pause", "resume", "cancel", "replan"] as const, "action");
      const message = session.mutate(action, typeof row.reason === "string" ? row.reason : undefined);
      if (action === "cancel") this.abortRunningWorkerJob();
      return { message, status: this.status() };
    }
    if (method === "compaction") {
      const row = record(params, "compaction params");
      const phase = oneOf(row.phase, ["before", "after"] as const, "phase");
      if (phase === "before" && this.workerJob?.state === "RUNNING") throw new TypeError("Compaction cannot start while a worker job is running");
      if (phase === "before") return { checkpoint_sha256: session.prepareCompaction() };
      session.verifyCompaction();
      return { verified: true };
    }
    if (method === "clarify_selected") {
      const row = this.boundParams(params, "clarify_selected");
      if (!Array.isArray(row.decisions)) throw new TypeError("decisions must be an array");
      return { message: session.resolveClarificationSelections(row.decisions as unknown as readonly SelectedClarification[]), status: this.status() };
    }
    throw Object.assign(new TypeError(`Unknown Coding Harness Host method: ${String(method)}`), { code: "HOST_METHOD_UNKNOWN" });
  }

  close(): void {
    this.stopLeaseHeartbeat();
    for (const abort of this.workerJob?.aborts ?? []) abort.abort();
    this.contextRuntime?.shutdown();
    this.contextRuntime = null;
    this.cacheRuntime = null;
    this.session?.shutdown();
    this.session = null;
    this.entered = null;
    this.runtimeResolution = null;
  }

  private startLeaseHeartbeat(session: TaskFlowSession): void {
    this.stopLeaseHeartbeat();
    const ttlMs = this.runtimeResolution?.config.execution.lease_ttl_ms;
    if (!ttlMs) return;
    const intervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
    this.leaseHeartbeat = setInterval(() => {
      if (this.session !== session || this.stopping) {
        this.stopLeaseHeartbeat();
        return;
      }
      try {
        session.keepActiveLeaseAlive();
      } catch {
        this.stopLeaseHeartbeat();
      }
    }, intervalMs);
    this.leaseHeartbeat.unref();
  }

  private stopLeaseHeartbeat(): void {
    if (this.leaseHeartbeat === null) return;
    clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = null;
  }

  private async shutdownGracefully(): Promise<void> {
    const job = this.workerJob;
    if (job?.state === "RUNNING") {
      for (const abort of job.aborts) abort.abort();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          job.completion,
          new Promise<void>((resolveWait) => { timer = setTimeout(resolveWait, 1_000); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.close();
  }

  private async startWorkerJob(session: TaskFlowSession, params: unknown): Promise<unknown> {
    if (!this.entered || this.entered.topology !== "MULTI") throw new TypeError("Worker jobs require MULTI topology");
    if (this.workerJob?.state === "RUNNING") throw new TypeError("A worker job is already running");
    const row = params === null ? {} : record(params, "worker_start params");
    const configuredParallel = this.runtimeResolution?.config.execution.max_parallel_workers ?? 4;
    const requested = row.max_parallel === undefined ? configuredParallel : integer(row.max_parallel, "max_parallel", 1);
    const maxParallel = Math.min(8, configuredParallel, requested);
    const workerTimeoutMs = this.runtimeResolution?.config.execution.worker_timeout_ms ?? 900_000;
    const workers = await this.multiWorkers();
    const runtimes = await workers.resolveRuntimes(
      this.entered.runtime,
      this.runtimeResolution?.config.execution.worker_runtime,
    );
    const id = `WORKER_JOB-${Date.now()}-${process.pid}`;
    const aborts: AbortController[] = [];
    const tasks: Promise<unknown>[] = [];
    for (let index = 0; index < maxParallel && session.harnessView()?.nextReadyShardId; index += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      tasks.push(workers.runReady(session, runtimes, abort.signal, workerTimeoutMs));
    }
    if (tasks.length === 0) throw new TypeError("No authority-ready worker shard is available");
    const job = {
      id, aborts, state: "RUNNING" as const as "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED",
      workerCount: tasks.length, startedAtMs: (this.options.now ?? Date.now)(),
      result: null as unknown, error: null as string | null, completion: Promise.resolve(),
    };
    this.workerJob = job;
    job.completion = Promise.allSettled(tasks).then((settled) => {
      const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const fulfilled = settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<MultiWorkerExecutor["runReady"]>>> => item.status === "fulfilled");
      const integrationFailures = fulfilled.filter((item) => item.value.integrationResult !== null
        && item.value.integrationResult !== "APPLIED");
      job.state = failures.length === 0 && integrationFailures.length === 0
        ? "SUCCEEDED" : aborts.some((abort) => abort.signal.aborted) ? "ABORTED" : "FAILED";
      job.result = fulfilled
        .map((item) => ({
           worker_run_id: item.value.execution.worker.worker_run_id, role: item.value.execution.worker.role,
           shard_id: item.value.execution.shard.shard_id, result_kind: item.value.submitted.result.result_kind,
           integration_result: item.value.integrationResult, usage: item.value.usage,
           runtime_source: item.value.runtimeResolution.source,
           runtime_fallback_reason: item.value.runtimeResolution.fallback_reason,
        }));
      const messages = [
        ...failures.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)),
        ...integrationFailures.map((item) => `Integration ${item.value.integrationResult} for shard ${item.value.execution.shard.shard_id}`),
      ];
      job.error = messages.length === 0 ? null : messages.join("; ").slice(0, 4_096);
    });
    return { job_id: id, state: job.state, worker_count: tasks.length };
  }

  private multiWorkers(): Promise<MultiWorkerExecutor> {
    this.workers ??= import("../worker/executor.js").then(({ MultiWorkerExecutor }) => new MultiWorkerExecutor({
      hostSecret: this.options.hostSecret,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    }));
    return this.workers;
  }

  private pollWorkerJob(params: unknown): unknown {
    const row = record(params, "worker_poll params");
    const id = text(row.job_id, "job_id", 256);
    if (!this.workerJob || this.workerJob.id !== id) throw new TypeError("Worker job is unknown");
    return {
      job_id: id, state: this.workerJob.state, result: this.workerJob.result, error: this.workerJob.error,
      worker_count: this.workerJob.workerCount,
      elapsed_ms: Math.max(0, (this.options.now ?? Date.now)() - this.workerJob.startedAtMs),
    };
  }

  private abortWorkerJob(params: unknown): unknown {
    const row = record(params, "worker_abort params");
    const id = text(row.job_id, "job_id", 256);
    if (!this.workerJob || this.workerJob.id !== id) throw new TypeError("Worker job is unknown");
    this.abortRunningWorkerJob();
    return { job_id: id, abort_requested: true };
  }

  private abortRunningWorkerJob(): void {
    if (this.workerJob?.state === "RUNNING") for (const abort of this.workerJob.aborts) abort.abort();
  }

  private enter(value: unknown): unknown {
    const input = enterParams(value);
    if (this.entered) {
      if (canonicalJsonSha256(this.entered) !== canonicalJsonSha256(input)) throw new TypeError("Coding Harness Host is already bound to a different entry contract");
      return this.status();
    }
    assertWalRuntimeSafe();
    const resolution = resolveHarnessRuntimeConfig(this.options.configPath, loadConfig(this.options.configPath));
    const config = resolution.config;
    const session = new TaskFlowSession({
      config, packageRoot: this.options.packageRoot,
      migrationPath: resolve(this.options.packageRoot, "schemas", "sql", "001_core.sql"),
      harnessMigrationPath: resolve(this.options.packageRoot, "schemas", "sql", "013_coding_harness_v1.sql"),
      memoryRecallEnabled: resolution.memoryRecallError === null,
      memoryRecallFallbackReason: resolution.memoryRecallError,
      ...(this.options.dataRoot === undefined ? {} : { dataRoot: this.options.dataRoot }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    const context = {
      cwd: input.cwd,
      sessionManager: { getSessionId: () => input.session_id },
      ui: { notify: () => undefined },
    } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
    try {
      session.initialize(context);
      const recovered = session.entryBinding();
      if (recovered && (recovered.objective !== input.objective.normalize("NFC").trim()
        || recovered.intent !== input.intent)) {
        throw new TypeError(`Recovered Goal ${recovered.goalId} is bound to a different objective or intent; enter with its original contract or cancel it first`);
      }
      if (!recovered) {
        const admitted = session.startFromInput(`${input.intent === "PLAN" ? "plan" : "build"}: ${input.objective}`, context);
        if (admitted?.action !== "transform") throw new TypeError("Coding Harness objective was not admitted");
      }
      session.createHarnessRun({
        topology: input.topology,
        createdByHostHmac: hmacSha256Hex(this.options.hostSecret, `host:${process.pid}`),
        configSha256: canonicalJsonSha256(config),
        decisionSha256: canonicalJsonSha256({ intent: input.intent, topology: input.topology, runtime: input.runtime }),
      });
      const contextRuntime = new HarnessContextRuntime({
        session, config, runtimeSelection: input.runtime,
      });
      const resources = session.resources();
      const harness = session.harnessView();
      if (config.modules.cache.enabled && resources && harness) {
        resources.authority.reconcilePendingCacheV2(harness.runId, this.options.now?.() ?? Date.now());
      }
      const cacheRuntime = config.modules.cache.enabled && resources && harness ? new CacheV2Runtime({
        config: config.modules.cache, runId: harness.runId, secret: this.options.hostSecret,
        repository: {
          prepare: (partition, family, request) => resources.authority.prepareCacheV2(partition, family, request),
          settle: (value) => resources.authority.settleCacheV2(value),
        },
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      }) : null;
      this.session = session;
      this.contextRuntime = contextRuntime;
      this.cacheRuntime = cacheRuntime;
      this.runtimeResolution = resolution;
      this.entered = input;
      return this.status();
    } catch (error) {
      session.shutdown();
      throw error;
    }
  }

  private status(): unknown {
    const configuredCache = this.runtimeResolution?.config.modules.cache;
    const effectiveCache = this.cacheRuntime && this.entered
      ? this.cacheRuntime.effective(this.entered.runtime)
      : { arm: "C0" as const, providerIntegration: null, reason: "DISABLED" as const };
    const planReview = this.session?.planReview() ?? null;
    return {
      active: this.session !== null,
      flow: this.session?.current() ?? null,
      harness: this.session?.harnessView() ?? null,
      execution_subject: this.session?.executionSubject() ?? null,
      context: this.runtimeResolution === null ? null : {
        input_context_error: this.runtimeResolution.inputContextError,
        memory_recall_error: this.runtimeResolution.memoryRecallError,
        memory_capture_error: this.runtimeResolution.memoryCaptureError,
        provider_turn_ledger_enabled: this.runtimeResolution.config.modules.input_context.enabled,
      },
      cache: {
        configured: configuredCache?.enabled ?? false,
        enabled: effectiveCache.arm !== "C0",
        arm: configuredCache?.arm ?? "C0",
        effective_arm: effectiveCache.arm,
        provider_integration: effectiveCache.providerIntegration,
        reason: effectiveCache.reason,
      },
      output: { enabled: this.runtimeResolution?.config.modules.output.enabled ?? false, mode: this.runtimeResolution?.config.modules.output.mode ?? "NORMAL" },
      ui: this.runtimeResolution?.config.ui ?? { widget: false, status: false, debounce_ms: 250, max_widget_lines: 4 },
      open_clarifications: this.session?.openClarifications() ?? [],
      plan_review: planReview === null ? null : {
        summary: planReview.summary, artifact_path: planReview.artifactPath, route_sha256: planReview.routeSha256,
      },
      generation_governor: (() => {
        const frontier = this.optionalGenerationFrontier();
        return frontier ? this.generationGovernor.current(frontier) : null;
      })(),
      runtime: this.entered?.runtime ?? null,
      intent: this.entered?.intent ?? null,
      topology: this.entered?.topology ?? null,
      control_frame: this.contextRuntime?.currentControlFrame() ?? null,
    };
  }

  private boundParams(params: unknown, label: string): Record<string, unknown> {
    const row = record(params, `${label} params`);
    const frame = this.requiredContext().currentControlFrame();
    if (!frame) throw new TypeError("PCH_CONTROL_FRAME_REQUIRED: start a fresh model turn before using managed tools");
    assertCurrentControlFrame(text(row.control_frame_sha256, `${label}.control_frame_sha256`, 64), frame);
    const { control_frame_sha256: _frame, ...payload } = row;
    void _frame;
    const { toolCallId: _toolCallId, tool_call_id: _toolCallIdSnake, ...routePayload } = payload;
    void _toolCallId;
    void _toolCallIdSnake;
    const routeDecision = this.generationGovernor.registerRoute(canonicalJsonSha256({
      domain: "PCH-GENERATION-ROUTE-V1", label, payload: routePayload,
    }));
    if (!routeDecision.allow) throw new TypeError(routeDecision.reason ?? "PCH_GENERATION_ROUTE_STALLED");
    return payload;
  }

  private controlFrameReceipt(): { readonly control_frame: { readonly control_frame_sha256: string } } {
    const frame = this.requiredContext().currentControlFrame();
    if (!frame) throw new TypeError("PCH_CONTROL_FRAME_REQUIRED: prepare a Harness turn before managed execution");
    return { control_frame: { control_frame_sha256: frame.control_frame_sha256 } };
  }

  private generationFrontier(): GenerationFrontier {
    const frontier = this.optionalGenerationFrontier();
    if (!frontier) throw new TypeError("PCH_CONTROL_FRAME_REQUIRED: prepare a Harness turn before generation governance");
    return frontier;
  }

  private optionalGenerationFrontier(): GenerationFrontier | null {
    const frame = this.contextRuntime?.currentControlFrame() ?? null;
    if (!frame || !this.session) return null;
    const flow = this.requiredSession().current();
    return {
      controlFrameSha256: frame.control_frame_sha256,
      terminal: flow?.phase === "SUCCEEDED" || flow?.phase === "FAILED" || flow?.phase === "CANCELED",
      userDecisionRequired: flow?.phase === "CLARIFYING" || flow?.phase === "WAITING_USER"
        || flow?.nextAction === "ASK_USER" || flow?.nextAction === "PLAN_CONTINUATION",
    };
  }

  private recordGenerationEvidence(kind: string, value: unknown): void {
    this.generationGovernor.recordEvidence(canonicalJsonSha256({
      domain: "PCH-GENERATION-EVIDENCE-OBSERVATION-V1", kind, value,
    }));
  }

  private requiredSession(): TaskFlowSession {
    if (!this.session) throw Object.assign(new TypeError("Enter Coding Harness before invoking this method"), { code: "HOST_NOT_ENTERED" });
    return this.session;
  }

  private requiredContext(): HarnessContextRuntime {
    if (!this.contextRuntime) throw Object.assign(new TypeError("Coding Harness context is unavailable"), { code: "HOST_CONTEXT_UNAVAILABLE" });
    return this.contextRuntime;
  }
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 4_096) throw new TypeError(`${label} must be a bounded string array`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 512) throw new TypeError(`${label} must be a bounded string array`);
    result.push(item);
  }
  return result;
}
