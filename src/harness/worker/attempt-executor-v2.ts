import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import {
  assertTaskPacketV2,
  finalizeWorkerPatchSetV2,
  finalizeWorkerProposalV2,
  type TaskPacketV2,
  type WorkerProposalPayloadV2,
  type WorkerProposalV2,
  type WorkerPatchSetV2,
} from "../execution-v2/domain.js";
import type { HarnessWorkerPatchInput } from "../../runtime/task-flow-session.js";
import { createSandboxedWorkerTools } from "./executor.js";
import { ScopedWorkerMirror } from "./scoped-mirror.js";
import type { ResolvedWorkerRuntime, WorkerRuntimeSelection } from "./runtime-policy.js";
import { piRuntimeFingerprintSha256 } from "../runtime-fingerprint.js";
import { assertProviderCallPlanV1, type ProviderCallPlanV1 } from "../../provider-v2/domain.js";
import {
  assertProviderInvocationTransitionV1,
  type ProviderInvocationTransitionV1,
} from "../../provider-v2/invocation.js";

export interface WorkerAttemptAgentStatsV2 {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly cost: number;
  readonly toolCalls: number;
}

export type WorkerAttemptAgentEventV2 =
  | { readonly type: "TURN_END" }
  | { readonly type: "TOOL_START"; readonly tool_call_id: string; readonly tool_name: string; readonly input: unknown }
  | { readonly type: "TOOL_END"; readonly tool_call_id: string; readonly tool_name: string; readonly result: unknown; readonly is_error: boolean };

export interface WorkerAttemptAgentV2 {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: WorkerAttemptAgentEventV2) => void): () => void;
  getLastAssistantText(): string | undefined;
  getSessionStats(): WorkerAttemptAgentStatsV2;
}

export interface WorkerAttemptAgentInputV2 {
  readonly cwd: string;
  readonly packet: TaskPacketV2;
  readonly tools: readonly string[];
  readonly writeRoots: readonly string[];
  readonly customTools: readonly ToolDefinition[];
  readonly systemPrompt: string;
  readonly runtime: WorkerRuntimeSelection;
}

export type WorkerAttemptAgentFactoryV2 = (input: WorkerAttemptAgentInputV2) => Promise<WorkerAttemptAgentV2>;

export type WorkerAttemptRuntimeResolverV2 = (input: {
  readonly packet: TaskPacketV2;
  readonly supervisor: WorkerRuntimeSelection;
}) => Promise<ResolvedWorkerRuntime>;

export interface WorkerAttemptExecutorOptionsV2 {
  readonly createWorker?: WorkerAttemptAgentFactoryV2;
  readonly resolveRuntime?: WorkerAttemptRuntimeResolverV2;
  readonly agentDir?: string;
  readonly now?: () => number;
}

export interface WorkerAttemptExecuteInputV2 {
  readonly workspace: string;
  readonly packet: TaskPacketV2;
  readonly capabilityKey: string;
  readonly current: {
    readonly graph_sha256: string;
    readonly authorization_sha256: string;
    readonly stop_generation: number;
  };
  readonly supervisorRuntime: WorkerRuntimeSelection;
  readonly providerPlan?: ProviderCallPlanV1;
  readonly providerInvocation?: ProviderInvocationTransitionV1;
  readonly signal?: AbortSignal;
}

export interface WorkerAttemptProtocolV2 {
  readonly schema_version: 2;
  readonly reason_code:
    | "MISSING_SUBMISSION"
    | "DUPLICATE_SUBMISSION"
    | "INVALID_SUBMISSION"
    | "CAPABILITY_VIOLATION"
    | "PATCH_PROTOCOL_MISMATCH"
    | "UNAUTHORIZED_MUTATION"
    | "AGENT_FAILURE"
    | null;
  readonly submission_count: number;
  readonly assistant_text_is_display_only: true;
}

export interface WorkerAttemptUsageV2 {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cost: number | null;
  readonly turns: number;
  readonly tool_calls: number;
  readonly wall_time_ms: number;
}

export type WorkerAttemptStopReasonV2 =
  | "ABORTED"
  | "AUTHORITY_STALE"
  | "INPUT_CLOSURE_STALE"
  | "STOP_GENERATION_CHANGED"
  | "DEADLINE_EXCEEDED"
  | "TURN_LIMIT_EXCEEDED"
  | "TOOL_LIMIT_EXCEEDED"
  | "INPUT_TOKEN_LIMIT_EXCEEDED"
  | "OUTPUT_TOKEN_LIMIT_EXCEEDED"
  | "RETRY_LIMIT_EXCEEDED"
  | "NO_PROGRESS_LIMIT_EXCEEDED";

export interface WorkerAttemptStoppedV2 {
  readonly schema_version: 2;
  readonly source: "ADAPTER_BUDGET" | "WORKER_PROPOSAL";
  readonly reason_code: string;
  readonly observed_stop_generation: number;
  readonly stopped_at_ms: number;
}

export interface WorkerAttemptResultV2 {
  readonly status: "PROPOSED" | "PROTOCOL_FAILURE" | "STOPPED";
  readonly proposal: WorkerProposalV2 | null;
  readonly patch_set: WorkerPatchSetV2 | null;
  readonly stopped: WorkerAttemptStoppedV2 | null;
  readonly protocol: WorkerAttemptProtocolV2;
  readonly display_text: string;
  readonly patches: readonly HarnessWorkerPatchInput[];
  readonly usage: WorkerAttemptUsageV2;
  readonly runtime_resolution: ResolvedWorkerRuntime | null;
}

const sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const idSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Z][A-Z0-9_:-]*$" });
const privacySchema = Type.Union([
  Type.Literal("PUBLIC"), Type.Literal("INTERNAL"), Type.Literal("SENSITIVE"), Type.Literal("SECRET"),
]);
const submitWorkerResultV2Schema = Type.Union([
  Type.Object({
    kind: Type.Literal("EVIDENCE_PROPOSAL"),
    payload: Type.Object({
      artifact_refs: Type.Array(Type.Object({
        sha256: sha256Schema,
        classification: privacySchema,
      }, { additionalProperties: false }), { minItems: 1, maxItems: 256 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("PATCH_PROPOSAL"),
    payload: Type.Object({}, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("DECISION_REQUEST"),
    payload: Type.Object({
      decision_schema_sha256: sha256Schema,
      blocking: Type.Boolean(),
      question_hmac: sha256Schema,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("CONFLICT_PROPOSAL"),
    payload: Type.Object({
      conflict_sha256: sha256Schema,
      candidate_patch_sha256: Type.Union([sha256Schema, Type.Null()]),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("BLOCKED"),
    payload: Type.Object({
      reason_code: idSchema,
      evidence_refs: Type.Array(sha256Schema, { maxItems: 256, uniqueItems: true }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("STOPPED"),
    payload: Type.Object({
      reason_code: idSchema,
      observed_stop_generation: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

type SubmitWorkerResultV2Input = Static<typeof submitWorkerResultV2Schema>;

function submitWorkerResultTool(
  submit: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "submit_worker_result_v2",
    label: "Submit worker result",
    description: "Submit exactly one schema-valid typed proposal for this TaskPacket V2 attempt.",
    promptSnippet: "Submit exactly one typed Worker result",
    promptGuidelines: ["Call this tool exactly once after completing local work. Free-form text is display-only."],
    parameters: submitWorkerResultV2Schema,
    executionMode: "sequential",
    execute(_toolCallId, input) {
      submit(input);
      return Promise.resolve({
        content: [{ type: "text" as const, text: "Typed result recorded locally as an unverified proposal." }],
        details: undefined,
      });
    },
  }) as ToolDefinition;
}

function inheritedRuntime(supervisor: WorkerRuntimeSelection): ResolvedWorkerRuntime {
  return { runtime: supervisor, source: "SUPERVISOR_INHERITED", fallback_reason: null };
}

function systemPrompt(packet: TaskPacketV2): string {
  return [
    "Execute exactly one immutable TaskPacket V2 attempt inside the scoped mirror.",
    `Node: ${packet.node_id}`,
    `Task: ${packet.task}`,
    `Requirements: ${packet.requirement_ids.join(", ")}`,
    `Obligations: ${packet.obligation_ids.join(", ")}`,
    `Capabilities: ${packet.capabilities.join(", ")}`,
    `Read roots: ${packet.read_roots.join(", ") || "none"}`,
    `Write roots: ${packet.write_roots.join(", ") || "none"}`,
    `Exact inputs: ${packet.exact_input_refs.map((ref) => `${ref.path}@${ref.sha256}[${ref.classification}]`).join(", ") || "none"}`,
    `Decisions: ${packet.decision_refs.map((ref) => `${ref.decision_id}@${ref.sha256}`).join(", ") || "none"}`,
    `Output schema: ${packet.output_schema_sha256}`,
    `Oracle: ${packet.oracle_sha256}`,
    `Provider profile: ${packet.provider_profile_sha256}`,
    "Free-form assistant text is display-only and cannot complete the node.",
  ].join("\n");
}

function usage(agent: WorkerAttemptAgentV2, turns: number, startedAt: number, now: () => number): WorkerAttemptUsageV2 {
  const stats = agent.getSessionStats();
  return {
    input_tokens: stats.tokens.input,
    output_tokens: stats.tokens.output,
    cache_read_tokens: stats.tokens.cacheRead,
    cache_write_tokens: stats.tokens.cacheWrite,
    cost: Number.isFinite(stats.cost) ? stats.cost : null,
    turns,
    tool_calls: stats.toolCalls,
    wall_time_ms: Math.max(0, now() - startedAt),
  };
}

function stoppedResult(input: {
  readonly packet: TaskPacketV2;
  readonly reason: WorkerAttemptStopReasonV2;
  readonly stoppedAt: number;
  readonly submissionCount?: number;
  readonly displayText?: string;
  readonly patches?: readonly HarnessWorkerPatchInput[];
  readonly usage?: WorkerAttemptUsageV2;
  readonly runtimeResolution?: ResolvedWorkerRuntime | null;
}): WorkerAttemptResultV2 {
  return {
    status: "STOPPED",
    proposal: null,
    patch_set: null,
    stopped: {
      schema_version: 2,
      source: "ADAPTER_BUDGET",
      reason_code: input.reason,
      observed_stop_generation: input.packet.stop_generation,
      stopped_at_ms: input.stoppedAt,
    },
    protocol: {
      schema_version: 2,
      reason_code: null,
      submission_count: input.submissionCount ?? 0,
      assistant_text_is_display_only: true,
    },
    display_text: input.displayText ?? "",
    patches: input.patches ?? [],
    usage: input.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: null,
      turns: 0,
      tool_calls: 0,
      wall_time_ms: 0,
    },
    runtime_resolution: input.runtimeResolution ?? null,
  };
}

function assertProviderAuthority(input: WorkerAttemptExecuteInputV2): asserts input is WorkerAttemptExecuteInputV2 & {
  readonly providerPlan: ProviderCallPlanV1;
  readonly providerInvocation: ProviderInvocationTransitionV1;
} {
  if (!input.providerPlan || !input.providerInvocation) {
    throw new TypeError("Worker provider execution requires durable Provider Invocation authority");
  }
  assertProviderCallPlanV1(input.providerPlan);
  assertProviderInvocationTransitionV1(input.providerInvocation);
  const packet = input.packet;
  const plan = input.providerPlan;
  const invocation = input.providerInvocation;
  if (packet.provider_call_plan_id !== plan.provider_call_plan_id
    || packet.provider_call_plan_sha256 !== plan.record_sha256
    || plan.goal_id !== packet.goal_id || plan.run_id !== packet.run_id
    || plan.graph_revision_id !== packet.graph_revision_id
    || plan.graph_revision_sha256 !== packet.graph_revision_sha256
    || plan.node_id !== packet.node_id || plan.node_spec_sha256 !== packet.node_spec_sha256
    || plan.packet_id !== packet.packet_id || plan.attempt !== packet.attempt
    || plan.lease_generation !== packet.lease_generation || plan.fencing_token !== packet.fencing_token
    || plan.minimum_input_closure_sha256 !== packet.input_closure_sha256
    || plan.success_evidence.output_schema_sha256 !== packet.output_schema_sha256
    || plan.local_oracle.oracle_sha256 !== packet.oracle_sha256
    || plan.privacy_class !== packet.privacy_class
    || plan.provider_profile.runtime_fingerprint_sha256 !== packet.provider_profile_sha256
    || plan.provider_profile.current_pi_config_sha256 !== packet.config_sha256
    || packet.deadline_ms > plan.request_budget.deadline_at_ms
    || packet.created_at_ms < plan.created_at_ms) {
    throw new TypeError("Worker ProviderCallPlan does not bind the exact TaskPacket authority");
  }
  if (invocation.state !== "PREPARED" || invocation.ordinal !== 0
    || invocation.provider_call_plan_id !== plan.provider_call_plan_id
    || invocation.provider_call_plan_sha256 !== plan.record_sha256
    || invocation.packet_id !== packet.packet_id || invocation.packet_sha256 !== packet.packet_sha256
    || invocation.node_id !== packet.node_id || invocation.attempt !== packet.attempt
    || invocation.lease_generation !== packet.lease_generation || invocation.fencing_token !== packet.fencing_token) {
    throw new TypeError("Worker Provider invocation does not bind the exact TaskPacket attempt");
  }
  const expectedFields = new Map<string, string>([
    ["/packet/capabilities", canonicalJsonSha256(packet.capabilities)],
    ["/packet/decision_refs", canonicalJsonSha256(packet.decision_refs)],
    ["/packet/exact_input_refs", canonicalJsonSha256(packet.exact_input_refs)],
    ["/packet/node_id", canonicalJsonSha256(packet.node_id)],
    ["/packet/obligation_ids", canonicalJsonSha256(packet.obligation_ids)],
    ["/packet/oracle_sha256", canonicalJsonSha256(packet.oracle_sha256)],
    ["/packet/output_schema_sha256", canonicalJsonSha256(packet.output_schema_sha256)],
    ["/packet/packet_id", canonicalJsonSha256(packet.packet_id)],
    ["/packet/provider_profile_sha256", canonicalJsonSha256(packet.provider_profile_sha256)],
    ["/packet/read_roots", canonicalJsonSha256(packet.read_roots)],
    ["/packet/requirement_ids", canonicalJsonSha256(packet.requirement_ids)],
    ["/packet/task", canonicalJsonSha256(packet.task)],
    ["/packet/write_roots", canonicalJsonSha256(packet.write_roots)],
    ["/tool_policy/scoped_mirror_reads", canonicalJsonSha256({
      read_roots: packet.read_roots,
      exact_input_refs: packet.exact_input_refs,
      privacy_class: packet.privacy_class,
    })],
  ]);
  if (plan.allowed_fields.length !== expectedFields.size || plan.allowed_fields.some((field) =>
    expectedFields.get(field.field_path) !== field.content_sha256
    || field.classification !== packet.privacy_class)) {
    throw new TypeError("Worker ProviderCallPlan allowed fields differ from the TaskPacket payload");
  }
}

type DispatchPhaseResultV2<T> =
  | { readonly state: "VALUE"; readonly value: T }
  | { readonly state: "ERROR"; readonly error: unknown }
  | { readonly state: "STOPPED"; readonly reason: "ABORTED" | "DEADLINE_EXCEEDED" };

function dispatchPhaseV2<T>(input: {
  readonly operation: Promise<T>;
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly onLateValue?: (value: T) => void;
}): Promise<DispatchPhaseResultV2<T>> {
  return new Promise((resolvePhase) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: DispatchPhaseResultV2<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolvePhase(result);
    };
    const abort = (): void => finish({ state: "STOPPED", reason: "ABORTED" });
    input.signal?.addEventListener("abort", abort, { once: true });
    const remaining = input.deadlineMs - input.now();
    if (input.signal?.aborted) abort();
    else if (remaining <= 0) finish({ state: "STOPPED", reason: "DEADLINE_EXCEEDED" });
    else timer = setTimeout(() => finish({ state: "STOPPED", reason: "DEADLINE_EXCEEDED" }), Math.min(remaining, 2_147_483_647));
    void input.operation.then(
      (value) => {
        if (settled) input.onLateValue?.(value);
        else finish({ state: "VALUE", value });
      },
      (error: unknown) => { if (!settled) finish({ state: "ERROR", error }); },
    );
  });
}

export class WorkerAttemptExecutor {
  private readonly now: () => number;
  private readonly createWorker: WorkerAttemptAgentFactoryV2;
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;

  constructor(private readonly options: WorkerAttemptExecutorOptionsV2) {
    this.now = options.now ?? Date.now;
    this.createWorker = options.createWorker ?? ((input) => this.createSdkWorker(input));
  }

  async execute(input: WorkerAttemptExecuteInputV2): Promise<WorkerAttemptResultV2> {
    const startedAt = this.now();
    assertTaskPacketV2(input.packet, input.capabilityKey, {
      graph_sha256: input.packet.graph_revision_sha256,
      authorization_sha256: input.packet.authorization_sha256,
      stop_generation: input.packet.stop_generation,
      now_ms: Math.min(startedAt, input.packet.deadline_ms - 1),
    });
    assertProviderAuthority(input);
    let preflightStop: WorkerAttemptStopReasonV2 | null = null;
    if (input.current.stop_generation !== input.packet.stop_generation) preflightStop = "STOP_GENERATION_CHANGED";
    else if (input.current.graph_sha256 !== input.packet.graph_revision_sha256
      || input.current.authorization_sha256 !== input.packet.authorization_sha256) preflightStop = "AUTHORITY_STALE";
    else if (input.packet.attempt > input.packet.max_retries + 1) preflightStop = "RETRY_LIMIT_EXCEEDED";
    else if (startedAt >= input.packet.deadline_ms) preflightStop = "DEADLINE_EXCEEDED";
    else if (input.signal?.aborted) preflightStop = "ABORTED";
    if (preflightStop !== null) {
      return stoppedResult({ packet: input.packet, reason: preflightStop, stoppedAt: startedAt });
    }
    let mirror: ScopedWorkerMirror;
    try {
      mirror = ScopedWorkerMirror.create(
        input.workspace, input.packet.read_roots, input.packet.write_roots, input.packet.exact_input_refs,
      );
    } catch {
      return stoppedResult({ packet: input.packet, reason: "INPUT_CLOSURE_STALE", stoppedAt: this.now() });
    }
    let agent: WorkerAttemptAgentV2 | null = null;
    let unsubscribe = (): void => undefined;
    try {
      const resolvingRuntime = this.options.resolveRuntime
        ? this.options.resolveRuntime({ packet: input.packet, supervisor: input.supervisorRuntime })
        : Promise.resolve(inheritedRuntime(input.supervisorRuntime));
      const runtimePhase = await dispatchPhaseV2({
        operation: resolvingRuntime, deadlineMs: input.packet.deadline_ms, now: this.now,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (runtimePhase.state === "STOPPED") {
        return stoppedResult({ packet: input.packet, reason: runtimePhase.reason, stoppedAt: this.now() });
      }
      if (runtimePhase.state === "ERROR") throw runtimePhase.error;
      const runtimeResolution = runtimePhase.value;
      if (piRuntimeFingerprintSha256(runtimeResolution.runtime) !== input.packet.provider_profile_sha256) {
        throw new TypeError("Resolved Worker runtime differs from the authority-bound provider profile");
      }
      const profile = input.providerPlan.provider_profile;
      if (runtimeResolution.source !== profile.source
        || (runtimeResolution.source_profile_id ?? null) !== profile.source_profile_id
        || runtimeResolution.fallback_reason !== profile.fallback_reason
        || runtimeResolution.runtime.provider !== profile.provider
        || runtimeResolution.runtime.api !== profile.api
        || (runtimeResolution.runtime.base_url ?? null) !== profile.base_url
        || runtimeResolution.runtime.model !== profile.model
        || runtimeResolution.runtime.thinking_level !== profile.thinking_level
        || runtimeResolution.runtime.context_window !== profile.context_window) {
        throw new TypeError("Resolved Worker runtime differs from the exact ProviderCallPlan profile");
      }
      const writable = input.packet.effect_ceiling === "PATCH_PROPOSAL";
      const proposalState: { current: WorkerProposalV2 | null } = { current: null };
      const patchSetState: { current: WorkerPatchSetV2 | null } = { current: null };
      let submissionCount = 0;
      let protocolReason: WorkerAttemptProtocolV2["reason_code"] = null;
      let stopReason: WorkerAttemptStopReasonV2 | null = null;
      let stoppedAt = startedAt;
      const submitTool = submitWorkerResultTool((candidate) => {
        submissionCount += 1;
        if (submissionCount > 1) {
          protocolReason = "DUPLICATE_SUBMISSION";
          throw new TypeError("submit_worker_result_v2 may be called exactly once");
        }
        if (!Value.Check(submitWorkerResultV2Schema, candidate)) {
          protocolReason = "INVALID_SUBMISSION";
          throw new TypeError("submit_worker_result_v2 input does not match its schema");
        }
        const value: SubmitWorkerResultV2Input = candidate;
        if ((value.kind === "PATCH_PROPOSAL"
          && (input.packet.effect_ceiling !== "PATCH_PROPOSAL" || !input.packet.capabilities.includes("PATCH_PROPOSE")))
          || (value.kind === "CONFLICT_PROPOSAL" && !input.packet.capabilities.includes("CONFLICT_PROPOSE"))) {
          protocolReason = "CAPABILITY_VIOLATION";
          throw new TypeError("Worker proposal exceeds the TaskPacket capability grant");
        }
        try {
          let payload = value.payload as WorkerProposalPayloadV2;
          if (value.kind === "PATCH_PROPOSAL") {
            const patchSet = finalizeWorkerPatchSetV2({
              packet: input.packet,
              patches: mirror.diff(),
              created_at_ms: this.now(),
            });
            patchSetState.current = patchSet;
            payload = {
              patch_set_id: patchSet.patch_set_id,
              patch_set_sha256: patchSet.record_sha256,
              affected_paths: patchSet.affected_paths,
              preimage_root_sha256: patchSet.baseline_sha256,
              proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
            };
          }
          proposalState.current = finalizeWorkerProposalV2({
            packet: input.packet,
            kind: value.kind,
            payload,
            created_at_ms: this.now(),
          });
        } catch (error) {
          protocolReason = "INVALID_SUBMISSION";
          throw error;
        }
      });
      const creatingWorker = this.createWorker({
        cwd: mirror.root,
        packet: input.packet,
        tools: ["read", "grep", "find", "ls", ...(writable ? ["edit", "write"] : [])],
        writeRoots: mirror.writeRoots,
        customTools: [submitTool],
        systemPrompt: systemPrompt(input.packet),
        runtime: runtimeResolution.runtime,
      });
      const workerPhase = await dispatchPhaseV2({
        operation: creatingWorker, deadlineMs: input.packet.deadline_ms, now: this.now,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        onLateValue: (late) => { void late.abort().catch(() => undefined); late.dispose(); },
      });
      if (workerPhase.state === "STOPPED") {
        return stoppedResult({
          packet: input.packet, reason: workerPhase.reason, stoppedAt: this.now(), runtimeResolution,
        });
      }
      if (workerPhase.state === "ERROR") throw workerPhase.error;
      agent = workerPhase.value;
      let turns = 0;
      let toolCalls = 0;
      let noProgressStreak = 0;
      let turnMadeProgress = false;
      const toolInputs = new Map<string, unknown>();
      const progressSignatures = new Set<string>();
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveStopped!: () => void;
      const stoppedPromise = new Promise<void>((resolveStoppedPromise) => { resolveStopped = resolveStoppedPromise; });
      const stop = (reason: WorkerAttemptStopReasonV2): void => {
        if (stopReason !== null) return;
        stopReason = reason;
        stoppedAt = this.now();
        resolveStopped();
        void agent?.abort().catch(() => undefined);
      };
      unsubscribe = agent.subscribe((event) => {
        if (event.type === "TURN_END") {
          turns += 1;
          if (proposalState.current === null) {
            noProgressStreak = turnMadeProgress ? 0 : noProgressStreak + 1;
            if (noProgressStreak >= input.packet.no_progress_limit) stop("NO_PROGRESS_LIMIT_EXCEEDED");
          }
          turnMadeProgress = false;
          if (turns >= input.packet.max_turns && proposalState.current === null) stop("TURN_LIMIT_EXCEEDED");
        } else if (event.type === "TOOL_START") {
          toolCalls += 1;
          toolInputs.set(event.tool_call_id, event.input);
          if (toolCalls > input.packet.max_tool_calls) stop("TOOL_LIMIT_EXCEEDED");
        } else if (!event.is_error) {
          const signature = canonicalJsonSha256({
            tool_name: event.tool_name,
            input: toolInputs.get(event.tool_call_id) ?? null,
            result: event.result,
          });
          if (!progressSignatures.has(signature)) {
            progressSignatures.add(signature);
            turnMadeProgress = true;
          }
        }
        const stats = agent?.getSessionStats();
        if (stats && stats.tokens.input > input.packet.max_input_tokens) stop("INPUT_TOKEN_LIMIT_EXCEEDED");
        if (stats && stats.tokens.output > input.packet.max_output_tokens) stop("OUTPUT_TOKEN_LIMIT_EXCEEDED");
      });
      const armDeadline = (): void => {
        const remaining = input.packet.deadline_ms - this.now();
        if (remaining <= 0) {
          stop("DEADLINE_EXCEEDED");
          return;
        }
        deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
      };
      const abort = (): void => stop("ABORTED");
      input.signal?.addEventListener("abort", abort, { once: true });
      armDeadline();
      const prompted = agent.prompt(`Execute TaskPacket ${input.packet.packet_id} and submit one typed result.`)
        .then(() => ({ state: "SETTLED" as const }), (error: unknown) => ({ state: "FAILED" as const, error }));
      const outcome = await Promise.race([
        prompted,
        stoppedPromise.then(() => ({ state: "STOPPED" as const })),
      ]);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener("abort", abort);
      if (outcome.state === "FAILED" && stopReason === null) {
        protocolReason = "AGENT_FAILURE";
        void outcome.error;
      }
      let patches: readonly HarnessWorkerPatchInput[] = [];
      try {
        patches = mirror.diff();
      } catch {
        protocolReason ??= "UNAUTHORIZED_MUTATION";
      }
      const submittedProposal = proposalState.current;
      if (stopReason === null && submittedProposal !== null && protocolReason === null) {
        if (submittedProposal.kind === "PATCH_PROPOSAL") {
          const patchSet = patchSetState.current;
          let currentPatchSet: WorkerPatchSetV2 | null = null;
          try {
            currentPatchSet = patchSet === null ? null : finalizeWorkerPatchSetV2({
              packet: input.packet, patches, created_at_ms: patchSet.created_at_ms,
            });
          } catch {
            currentPatchSet = null;
          }
          if (patchSet === null || currentPatchSet?.record_sha256 !== patchSet.record_sha256) {
            protocolReason = "PATCH_PROTOCOL_MISMATCH";
          }
        } else if (patches.length > 0 && submittedProposal.kind !== "CONFLICT_PROPOSAL") {
          protocolReason = "UNAUTHORIZED_MUTATION";
        }
      }
      if (stopReason !== null) {
        return stoppedResult({
          packet: input.packet,
          reason: stopReason,
          stoppedAt,
          submissionCount,
          displayText: agent.getLastAssistantText() ?? "",
          patches,
          usage: usage(agent, turns, startedAt, this.now),
          runtimeResolution,
        });
      }
      const succeeded = submittedProposal !== null && protocolReason === null;
      if (!succeeded && protocolReason === null) protocolReason = "MISSING_SUBMISSION";
      if (succeeded && submittedProposal.kind === "STOPPED") {
        const payload = submittedProposal.payload as { readonly reason_code: string; readonly observed_stop_generation: number };
        return {
          status: "STOPPED",
          proposal: submittedProposal,
          patch_set: null,
          stopped: {
            schema_version: 2,
            source: "WORKER_PROPOSAL",
            reason_code: payload.reason_code,
            observed_stop_generation: payload.observed_stop_generation,
            stopped_at_ms: submittedProposal.created_at_ms,
          },
          protocol: {
            schema_version: 2,
            reason_code: null,
            submission_count: submissionCount,
            assistant_text_is_display_only: true,
          },
          display_text: agent.getLastAssistantText() ?? "",
          patches,
          usage: usage(agent, turns, startedAt, this.now),
          runtime_resolution: runtimeResolution,
        };
      }
      return {
        status: succeeded ? "PROPOSED" : "PROTOCOL_FAILURE",
        proposal: succeeded ? submittedProposal : null,
        patch_set: succeeded && submittedProposal?.kind === "PATCH_PROPOSAL" ? patchSetState.current : null,
        stopped: null,
        protocol: {
          schema_version: 2,
          reason_code: protocolReason,
          submission_count: submissionCount,
          assistant_text_is_display_only: true,
        },
        display_text: agent.getLastAssistantText() ?? "",
        patches,
        usage: usage(agent, turns, startedAt, this.now),
        runtime_resolution: runtimeResolution,
      };
    } finally {
      unsubscribe();
      agent?.dispose();
      mirror.dispose();
    }
  }

  private async createSdkWorker(input: WorkerAttemptAgentInputV2): Promise<WorkerAttemptAgentV2> {
    const agentDir = this.options.agentDir ?? resolve(homedir(), ".pi", "agent");
    this.modelRuntimePromise ??= ModelRuntime.create();
    const modelRuntime = await this.modelRuntimePromise;
    const model = modelRuntime.getModel(input.runtime.provider, input.runtime.model);
    if (!model) {
      throw new TypeError(`Configured Pi model is unavailable to Worker: ${input.runtime.provider}/${input.runtime.model}`);
    }
    const loader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: input.systemPrompt,
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: input.runtime.thinking_level as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>,
      tools: [...input.tools],
      customTools: [
        ...createSandboxedWorkerTools(input.cwd, input.writeRoots, input.tools),
        ...input.customTools,
      ],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(input.cwd),
    });
    const listeners = new Set<(event: WorkerAttemptAgentEventV2) => void>();
    const emit = (event: WorkerAttemptAgentEventV2): void => {
      for (const listener of listeners) listener(event);
    };
    const unsubscribeSdk = result.session.subscribe((event) => {
      if (event.type === "turn_end") emit({ type: "TURN_END" });
      else if (event.type === "tool_execution_start") {
        emit({
          type: "TOOL_START",
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          input: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        emit({
          type: "TOOL_END",
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          result: event.result,
          is_error: event.isError,
        });
      }
    });
    let disposed = false;
    return {
      prompt: (text) => result.session.prompt(text),
      abort: () => result.session.abort(),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        unsubscribeSdk();
        listeners.clear();
        result.session.dispose();
      },
      subscribe: (listener) => {
        if (disposed) throw new TypeError("Worker Agent is disposed");
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      getLastAssistantText: () => result.session.getLastAssistantText(),
      getSessionStats: () => result.session.getSessionStats(),
    };
  }
}
