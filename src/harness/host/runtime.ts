import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalJsonSha256, type CanonicalJson } from "../../authority/canonical-json.js";
import { assertWalRuntimeSafe } from "../../authority/sqlite-runtime.js";
import { loadConfig } from "../../config/load-config.js";
import { resolveHarnessRuntimeConfig, type HarnessRuntimeResolution } from "../../config/runtime-resolution.js";
import { normalizeToolEffect, type ToolInvocation } from "../../effects/normalize.js";
import type { ContextProjectionDelta } from "../../input-context/projection-delta.js";
import type { ClarificationDecision } from "../../planning/clarification.js";
import { hmacSha256Hex } from "../../foundation/crypto.js";
import { createId } from "../../foundation/ids.js";
import {
  TaskFlowSession, type OutcomeEvidenceReviewInput, type TaskFlowAttestationInput,
} from "../../runtime/task-flow-session.js";
import type { GoalContractAuthorityProposalV2, RouteAuthorityProposalV2 } from "../../task-flow/finalize.js";
import {
  parseSessionGoalBindingMarker,
  toSessionGoalBindingMarker,
  type SessionGoalBindingMarkerV1,
} from "../../task-flow/session-binding.js";
import type { RouteRevisionAuthorityPatchV2 } from "../../task-flow/route-revision.js";
import type { ExecutionTopology } from "../domain.js";
import { piRuntimeFingerprintSha256 } from "../runtime-fingerprint.js";
import {
  DynamicMultiCoordinator,
  type DynamicMultiEvidencePortV2,
  type DynamicMultiIntegrationPortV2,
  type DynamicMultiJobViewV2,
  type DynamicMultiOraclePortV2,
  type DynamicMultiWorkerPortV2,
} from "../execution-v2/coordinator.js";
import { finalizeExecutionStopV2 } from "../execution-v2/domain.js";
import {
  finalizeTopologyMeasurementEvidenceReceiptV2,
  finalizeTopologyMeasurementReceiptV2,
} from "../../harness-v2/topology-gate.js";
import {
  finalizeStrongSingleRolloutReceiptV1,
  type StrongSingleRolloutPreparationV1,
} from "../../harness-v2/strong-single-rollout.js";
import {
  finalizeStrongSingleWorkloadBindingV1,
  type ComparableWorkloadV1,
} from "../../harness-v2/workload-comparability.js";
import { finalizeDynamicMultiProposalReceiptV2 } from "../../harness-v2/dynamic-multi-proposal.js";
import {
  inspectDynamicMultiProposalV2,
  lowerInspectedDynamicMultiV2,
  type HostDynamicMultiAdmissionEvidenceV2,
  type HostDynamicMultiAdmissionRequestV2,
  type InspectedDynamicMultiProposalV2,
} from "./dynamic-multi-lowering.js";
import { projectDecisionInboxV2 } from "./decision-inbox.js";
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
  type HostStatus,
  type HostPresentationV2,
} from "./application-protocol.js";

export interface CodingHarnessHostOptions {
  readonly packageRoot: string;
  readonly configPath: string;
  readonly hostSecret: Uint8Array;
  readonly dataRoot?: string;
  readonly now?: () => number;
  readonly dynamicMulti?: DynamicMultiHostPortsV2 | DynamicMultiHostPortsFactoryV2;
}

export type DynamicMultiAdmissionAssessmentV2 = HostDynamicMultiAdmissionEvidenceV2;
export type DynamicMultiAdmissionInputV2 = HostDynamicMultiAdmissionRequestV2;

export interface DynamicMultiHostPortsV2 {
  measure(input: DynamicMultiAdmissionInputV2, inspected?: InspectedDynamicMultiProposalV2):
    DynamicMultiAdmissionAssessmentV2 | null | Promise<DynamicMultiAdmissionAssessmentV2 | null>;
  readonly worker: DynamicMultiWorkerPortV2;
  readonly evidence: DynamicMultiEvidencePortV2;
  readonly oracle: DynamicMultiOraclePortV2;
  readonly integration?: DynamicMultiIntegrationPortV2;
}

export interface DynamicMultiHostPortsFactoryV2 {
  create(input: {
    readonly session: TaskFlowSession;
    readonly workspace: string;
    readonly now: () => number;
  }): DynamicMultiHostPortsV2;
}

interface RuntimeParams {
  readonly provider: string;
  readonly api: string;
  readonly base_url?: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
}

interface EnterParams {
  readonly cwd: string;
  readonly session_id: string;
  readonly entry_mode: "LEGACY" | "NEW" | "RESUME" | "RECOVER";
  readonly objective: string;
  readonly intent: "PLAN" | "BUILD";
  readonly topology: ExecutionTopology;
  readonly runtime: RuntimeParams;
}

type EnterRequest =
  | (Omit<EnterParams, "entry_mode"> & { readonly entry_mode: "LEGACY" | "NEW" })
  | { readonly cwd: string; readonly session_id: string; readonly entry_mode: "RESUME";
      readonly binding_marker: SessionGoalBindingMarkerV1; readonly runtime: RuntimeParams }
  | { readonly cwd: string; readonly session_id: string; readonly entry_mode: "RECOVER";
      readonly goal_id: string; readonly allow_transfer: boolean; readonly runtime: RuntimeParams };

interface StrongSingleRolloutCaptureV1 {
  readonly preparation: StrongSingleRolloutPreparationV1;
  readonly runtimeFingerprintSha256: string;
  readonly workload: ComparableWorkloadV1;
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

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function rawByteBoundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.trim() || !wellFormedUnicode(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
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

function runtimeParams(value: unknown): RuntimeParams {
  const runtime = record(value, "runtime");
  return {
    provider: text(runtime.provider, "runtime.provider", 256), api: text(runtime.api, "runtime.api", 256),
    ...(runtime.base_url === undefined ? {} : { base_url: text(runtime.base_url, "runtime.base_url", 2_048) }),
    model: text(runtime.model, "runtime.model", 512),
    thinking_level: text(runtime.thinking_level, "runtime.thinking_level", 64),
    context_window: integer(runtime.context_window, "runtime.context_window", 1),
  };
}

const lifecycleStages = ["INTAKE", "CONTRACT", "PLAN", "BUILD", "VERIFY", "DELIVER"] as const;

function projectHostPresentation(input: {
  readonly phase: string;
  readonly nextAction: string;
  readonly blocker: string | null;
  readonly harnessStatus: string | null;
  readonly pendingKinds: readonly string[];
  readonly authorityEventSequence: number;
  readonly revision: number;
}): HostPresentationV2 {
  const terminal = input.phase === "SUCCEEDED" ? "COMPLETED" as const
    : input.phase === "FAILED" ? "FAILED" as const
      : input.phase === "CANCELED" ? "CANCELED" as const : null;
  const verification = /(?:VERIFY|VALIDAT|ATTEST|EVIDENCE|COMPLETE|PRESERV|CLOSE)/iu.test(input.nextAction);
  const hasContract = input.pendingKinds.includes("CONTRACT_REVIEW") || input.nextAction === "REVIEW_CONTRACT";
  const hasClarification = input.pendingKinds.includes("CLARIFICATION") || input.nextAction === "ASK_USER";
  const hasPlan = input.pendingKinds.includes("PLAN_CONTINUATION") || input.nextAction === "PLAN_CONTINUATION";
  const reconcile = input.phase === "RECONCILING" || /RECONCILE/iu.test(input.nextAction);
  const currentStage: HostPresentationV2["lifecycle"]["current_stage"] = terminal ? "DELIVER"
    : input.phase === "CONTRACTING" || hasContract ? "CONTRACT"
      : input.phase === "PLANNING" || hasPlan ? "PLAN"
        : verification ? "VERIFY"
          : input.phase === "BUILDING" || reconcile || input.harnessStatus === "PAUSED" ? "BUILD" : "INTAKE";
  const currentIndex = lifecycleStages.indexOf(currentStage);
  const presentationState: HostPresentationV2["presentation_state_code"] = terminal
    ?? (input.harnessStatus === "PAUSED" ? "PAUSED"
      : reconcile ? "RECONCILING"
        : hasContract || hasClarification || hasPlan ? "WAITING_FOR_YOU"
          : input.phase === "PLANNING" ? "PLANNING"
            : input.phase === "BUILDING" && verification ? "VERIFYING"
              : input.phase === "BUILDING" ? "BUILDING" : "DEFINING_GOAL");
  const attention: HostPresentationV2["attention"] = input.blocker !== null || reconcile ? "BLOCKING"
    : hasContract || hasClarification || hasPlan ? "ACTION_REQUIRED" : "NONE";
  const primaryTarget: HostPresentationV2["primary_target"] = hasContract ? "CONTRACT_REVIEW"
    : hasClarification ? "CLARIFICATION"
      : hasPlan ? "PLAN_CONTINUATION"
        : reconcile ? "RECONCILE"
          : terminal ? "DELIVERABLE"
            : verification ? "VERIFY" : "WORK";
  return {
    schema_version: 2,
    presentation_state_code: presentationState,
    attention,
    primary_target: primaryTarget,
    authority_event_sequence: input.authorityEventSequence,
    lifecycle: {
      revision: Math.max(1, input.revision),
      current_stage: currentStage,
      steps: lifecycleStages.map((code, index) => ({
        code,
        state: input.phase === "SUCCEEDED" || index < currentIndex ? "COMPLETE"
          : index === currentIndex ? "ACTIVE" : "PENDING",
      })),
    },
  };
}

function enterParams(value: unknown): EnterRequest {
  const row = record(value, "enter params");
  const cwd = text(row.cwd, "cwd", 4_096);
  if (!isAbsolute(cwd)) throw new TypeError("cwd must be absolute");
  const common = {
    cwd: resolve(cwd), session_id: text(row.session_id, "session_id", 256), runtime: runtimeParams(row.runtime),
  };
  if (row.entry_mode === "RESUME") {
    const marker = parseSessionGoalBindingMarker(row.binding_marker);
    if (!marker) throw new TypeError("binding_marker is invalid");
    return { ...common, entry_mode: "RESUME", binding_marker: marker };
  }
  if (row.entry_mode === "RECOVER") {
    if (typeof row.allow_transfer !== "boolean") throw new TypeError("allow_transfer is invalid");
    return {
      ...common, entry_mode: "RECOVER", goal_id: text(row.goal_id, "goal_id", 256),
      allow_transfer: row.allow_transfer,
    };
  }
  return {
    ...common,
    entry_mode: row.entry_mode === "NEW" ? "NEW" : "LEGACY",
    objective: text(row.objective, "objective"),
    intent: oneOf(row.intent, ["PLAN", "BUILD"] as const, "intent"),
    topology: oneOf(row.topology, ["SINGLE", "MULTI"] as const, "topology"),
  };
}

export class CodingHarnessHostRuntime {
  private session: TaskFlowSession | null = null;
  private contextRuntime: HarnessContextRuntime | null = null;
  private runtimeResolution: HarnessRuntimeResolution | null = null;
  private cacheRuntime: CacheV2Runtime | null = null;
  private readonly generationGovernor = new GenerationGovernor();
  private readonly runtimeInstanceId = createId("HOST_INSTANCE");
  private entered: EnterParams | null = null;
  private entryRequestSha256: string | null = null;
  private stopping = false;
  private leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  private dynamicMultiPortsValue: DynamicMultiHostPortsV2 | null | undefined;
  private workerJob: {
    readonly id: string;
    readonly aborts: readonly AbortController[];
    workerCount: number;
    readonly startedAtMs: number;
    readonly coordinator?: DynamicMultiCoordinator;
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
    if (method === "discover_goals") return this.discoverGoals(params);
    const session = this.requiredSession();
    if (method === "unbind_session") {
      const row = record(params, "session unbind");
      const current = session.sessionGoalBinding();
      if (!current || current.bindingReceiptSha256 !== text(
        row.expected_binding_receipt_sha256, "expected_binding_receipt_sha256", 64,
      )) throw new TypeError("Session binding changed before exit");
      session.unbindCurrentGoal();
      return this.status();
    }
    if (method === "rename_goal") {
      const row = record(params, "Goal rename");
      const current = session.sessionGoalBinding();
      if (!current || current.bindingReceiptSha256 !== text(
        row.expected_binding_receipt_sha256, "expected_binding_receipt_sha256", 64,
      )) throw new TypeError("Session binding changed before rename");
      session.renameCurrentGoal(text(row.goal_title, "goal_title", 128));
      return this.status();
    }
    if (method === "update_runtime") {
      const row = record(params, "runtime update");
      const current = this.entered!;
      const next = { ...current, runtime: runtimeParams(row) };
      const harness = session.harnessView();
      const execution = harness === null
        ? null
        : session.resources()?.authority.readExecutionV2(harness.runId, 1) ?? null;
      if (execution && execution.graph.runtime_fingerprint_sha256 !== piRuntimeFingerprintSha256(next.runtime)) {
        throw new TypeError("Pi runtime cannot change after a committed Execution V2 graph");
      }
      this.entered = next;
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
      const providerAttemptId = this.requiredContext().beginProviderTurn({
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
      return {
        recorded: providerAttemptId !== null,
        provider_attempt_id: providerAttemptId,
        cache_request_id: cacheRequestId,
      };
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
      const providerAttemptId = row.provider_attempt_id === null
        ? null : text(row.provider_attempt_id, "provider_attempt_id", 256);
      const ledgerSha256 = this.requiredContext().settleProviderTurn({
        ...(providerAttemptId === null ? {} : { attemptId: providerAttemptId }),
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
        const rollout = this.captureStrongSingleRollout(session);
        const settled = session.settleReadyWork();
        if (settled !== null) this.recordStrongSingleRollout(session, rollout);
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
    if (method === "active_goal_input") {
      const row = record(params, "active_goal_input params");
      await this.stopRunningWorkerJob();
      const captured = session.captureActiveGoalInput(rawByteBoundedText(row.text, "active_goal_input.text", 131_072));
      return {
        message: `Active Goal user turn ${captured.user_turn_id} captured; mutation is fenced pending typed classification.`,
        status: this.status(),
      };
    }
    if (method === "classify_active_goal_input") {
      const row = this.boundParams(params, "classify_active_goal_input");
      if (!Array.isArray(row.changed_subjects)) throw new TypeError("changed_subjects must be an array");
      const changedSubjects = row.changed_subjects.map((entry, index) => {
        const subject = record(entry, `changed_subjects[${index}]`);
        return {
          kind: oneOf(subject.kind, ["REQUIREMENT", "DECISION", "WORK_CELL"] as const, "subject kind"),
          id: text(subject.id, "subject id", 160),
        };
      });
      return {
        message: session.classifyActiveGoalInput({
          user_turn_id: text(row.user_turn_id, "user_turn_id", 160),
          expected_user_turn_sha256: text(row.expected_user_turn_sha256, "expected_user_turn_sha256", 64),
          classification: oneOf(row.classification, [
            "CORRECT_CURRENT", "QUEUE_NEXT", "CHANGE_REQUEST", "NEW_GOAL", "INTERRUPT_NOW", "DISCUSSION_ONLY",
          ] as const, "classification"),
          materiality: oneOf(row.materiality, ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const, "materiality"),
          change_kind: row.change_kind === null ? null : oneOf(
            row.change_kind, ["BEHAVIOR", "SCOPE", "ACCEPTANCE", "USER_PREFERENCE"] as const, "change_kind",
          ),
          changed_subjects: changedSubjects,
        }),
        status: this.status(),
      };
    }
    if (method === "memory_command") {
      return { message: session.memoryCommand(record(params, "memory command") as unknown as MemoryCommandRequest) };
    }
    if (method === "submit_contract") {
      const row = this.boundParams(params, "submit_contract");
      return { message: session.submitContract(row as unknown as GoalContractAuthorityProposalV2), status: this.status() };
    }
    if (method === "resolve_contract_review") {
      const row = record(params, "resolve_contract_review params");
      const action = oneOf(row.action, ["APPROVE", "REJECT", "EDIT", "DEFER"] as const, "action");
      const expectedDecisionRequirementRevisionId = text(
        row.expected_decision_requirement_revision_id, "expected_decision_requirement_revision_id", 160,
      );
      const expectedRequirementRevisionSha256 = text(
        row.expected_requirement_revision_sha256, "expected_requirement_revision_sha256", 64,
      );
      const expectedDecisionFrontierSha256 = text(
        row.expected_decision_frontier_sha256, "expected_decision_frontier_sha256", 64,
      );
      const selectedValue = row.selected_value as CanonicalJson;
      const editedRequirementRevisionId = action === "EDIT"
        ? text(row.edited_requirement_revision_id, "edited_requirement_revision_id", 160) : undefined;
      const deferredTriggerSha256 = action === "DEFER"
        ? text(row.deferred_trigger_sha256, "deferred_trigger_sha256", 64) : undefined;
      const turnId = canonicalJsonSha256({
        domain: "PCH-HOST-CONTRACT-REVIEW-INPUT-V1",
        session_id: this.entered!.session_id,
        expected_decision_requirement_revision_id: expectedDecisionRequirementRevisionId,
        expected_requirement_revision_sha256: expectedRequirementRevisionSha256,
        expected_decision_frontier_sha256: expectedDecisionFrontierSha256,
        action,
        selected_value: selectedValue,
        edited_requirement_revision_id: editedRequirementRevisionId ?? null,
        deferred_trigger_sha256: deferredTriggerSha256 ?? null,
      });
      return {
        message: session.resolveContractReview({
          expectedDecisionRequirementRevisionId, expectedRequirementRevisionSha256,
          expectedDecisionFrontierSha256, action, selectedValue,
          ...(editedRequirementRevisionId === undefined ? {} : { editedRequirementRevisionId }),
          ...(deferredTriggerSha256 === undefined ? {} : { deferredTriggerSha256 }),
          turnId,
        }),
        status: this.status(),
      };
    }
    if (method === "submit_route") {
      const row = this.boundParams(params, "submit_route");
      return { message: session.submitRoute(row as unknown as RouteAuthorityProposalV2), status: this.status() };
    }
    if (method === "submit_route_revision") {
      const row = this.boundParams(params, "submit_route_revision");
      return { message: session.submitRouteRevision(row as unknown as RouteRevisionAuthorityPatchV2), status: this.status() };
    }
    if (method === "continue_plan") {
      const row = this.boundParams(params, "continue_plan");
      return {
        message: session.resolvePlanContinuation(
          oneOf(row.choice, ["BUILD", "KEEP", "REVISE"] as const, "choice"),
          {
            routeSha256: text(row.expected_route_sha256, "expected_route_sha256", 64),
            planRevisionSha256: text(row.expected_plan_revision_sha256, "expected_plan_revision_sha256", 64),
            stageGateSha256: text(row.expected_stage_gate_sha256, "expected_stage_gate_sha256", 64),
          },
        ),
        status: this.status(),
      };
    }
    if (method === "define_shards") {
      const row = this.boundParams(params, "define_shards");
      if (!Array.isArray(row.shards)) throw new TypeError("shards must be an array");
      return this.defineDynamicMultiGraph(session, row.shards);
    }
    if (method === "tool_preflight") {
      const invocation = this.boundParams(params, "tool_preflight") as unknown as ToolInvocation;
      const normalized = normalizeToolEffect(invocation);
      const harness = session.harnessView();
      if (harness?.requestedTopology === "MULTI" && harness.effectiveTopology === "SINGLE"
        && harness.topologyReasonCode === "MULTI_BENEFIT_EVIDENCE_REQUIRED"
        && normalized.effectClass !== "READ_ONLY") {
        return {
          allow: false,
          managed: true,
          capture: false,
          reason: "MULTI_PROPOSAL_REQUIRED_BEFORE_CANONICAL_MUTATION",
        };
      }
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
      const row = this.boundParams(params, "complete");
      const rollout = this.captureStrongSingleRollout(session);
      const message = session.completeWork(row as unknown as OutcomeEvidenceReviewInput);
      this.recordStrongSingleRollout(session, rollout);
      return { message, status: this.status() };
    }
    if (method === "reconcile") {
      const row = this.boundParams(params, "reconcile");
      return { message: session.reconcileOperations(typeof row.operation_id === "string" ? row.operation_id : undefined), status: this.status() };
    }
    if (method === "control") {
      const raw = record(params, "control params");
      const row = raw.control_frame_sha256 === undefined ? raw : this.boundParams(params, "control");
      const action = oneOf(row.action, ["pause", "resume", "cancel", "replan"] as const, "action");
      if (action === "cancel") await this.stopRunningWorkerJob();
      const message = session.mutate(action, typeof row.reason === "string" ? row.reason : undefined);
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
      await this.stopRunningWorkerJob();
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

  private async defineDynamicMultiGraph(session: TaskFlowSession, source: readonly unknown[]): Promise<unknown> {
    {
      if (!this.entered || this.entered.topology !== "MULTI") {
        throw new TypeError("Dynamic Multi requires requested MULTI topology");
      }
      const ports = this.dynamicMultiPorts(session);
      const resources = session.resources();
      const harness = session.harnessView();
      const binding = session.binding();
      if (!resources || !harness || !binding?.authorizedWorkCellId) {
        throw new TypeError("Dynamic Multi requires the current authorized WorkCell");
      }
      const existingExecution = resources.authority.readExecutionV2(harness.runId, 1);
      if (existingExecution?.graph.work_cell_id === binding.authorizedWorkCellId) {
        throw new TypeError("The current WorkCell already has an Execution V2 graph");
      }
      let preparation = resources.authority.readExecutionV2Preparation(binding.goalId, harness.runId);
      const runtimeFingerprintSha256 = this.runtimeFingerprintSha256();
      let comparableWorkload = resources.authority.readComparableWorkload(preparation, {
        runtimeFingerprintSha256,
        providerProfileSha256: runtimeFingerprintSha256,
        cacheEpochSha256: this.cacheQualificationEpochSha256(),
      });
      const proposalNowMs = (this.options.now ?? Date.now)();
      let loweringClosure = {
        workspace: this.entered.cwd,
        workspaceSecret: resources.workspaceSecret,
        preparation,
        currentTopologyRevision: harness.topologyRevision,
        runtimeFingerprintSha256,
        comparableWorkload,
        independentValidation: ports !== undefined,
        nowMs: proposalNowMs,
      } as const;
      let inspected = inspectDynamicMultiProposalV2({ ...loweringClosure, shards: source });
      const existingProposal = resources.authority.readDynamicMultiProposal(harness.runId, preparation.workCellId);
      if (existingProposal) {
        if (existingProposal.goal_id !== preparation.goalId
          || existingProposal.plan_revision_id !== preparation.planRevisionId
          || existingProposal.plan_revision_sha256 !== preparation.planRevisionSha256
          || existingProposal.authorization_id !== preparation.authorizationId
          || existingProposal.authorization_sha256 !== preparation.authorizationSha256
          || existingProposal.input_closure_sha256 !== preparation.inputClosureSha256
          || existingProposal.baseline_sha256 !== preparation.baselineSha256
          || existingProposal.baseline_content_root_sha256 !== preparation.baselineContentRootSha256
          || existingProposal.environment_sha256 !== preparation.environmentSha256
          || existingProposal.runtime_fingerprint_sha256 !== runtimeFingerprintSha256
          || existingProposal.config_sha256 !== preparation.configSha256) {
          throw new TypeError("Persisted Dynamic Multi proposal is stale for the current authority closure");
        }
        inspected = inspectDynamicMultiProposalV2({ ...loweringClosure, shards: existingProposal.source });
        if (inspected.request.graph_proposal_sha256 !== existingProposal.graph_proposal_sha256) {
          throw new TypeError("Persisted Dynamic Multi proposal graph hash is invalid");
        }
      } else {
        const proposal = finalizeDynamicMultiProposalReceiptV2({
          goal_id: preparation.goalId,
          run_id: preparation.runId,
          work_cell_id: preparation.workCellId,
          plan_revision_id: preparation.planRevisionId,
          plan_revision_sha256: preparation.planRevisionSha256,
          authorization_id: preparation.authorizationId,
          authorization_sha256: preparation.authorizationSha256,
          input_closure_sha256: preparation.inputClosureSha256,
          baseline_sha256: preparation.baselineSha256,
          baseline_content_root_sha256: preparation.baselineContentRootSha256,
          environment_sha256: preparation.environmentSha256,
          runtime_fingerprint_sha256: runtimeFingerprintSha256,
          config_sha256: preparation.configSha256,
          graph_proposal_sha256: inspected.request.graph_proposal_sha256,
          source: inspected.nodes as unknown as readonly Readonly<Record<string, unknown>>[],
          predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
          created_at_ms: proposalNowMs,
        });
        const proposed = resources.authority.transactExecutionV2({
          type: "RECORD_DYNAMIC_MULTI_PROPOSAL_V2",
          goalId: binding.goalId,
          proposal,
        }, binding.mutation(`host:execution-v2:proposal:${proposal.record_sha256}`));
        binding.advanceVersion(proposed.goalVersion);
      }
      preparation = resources.authority.readExecutionV2Preparation(binding.goalId, harness.runId);
      comparableWorkload = resources.authority.readComparableWorkload(preparation, {
        runtimeFingerprintSha256,
        providerProfileSha256: runtimeFingerprintSha256,
        cacheEpochSha256: this.cacheQualificationEpochSha256(),
      });
      const nowMs = (this.options.now ?? Date.now)();
      loweringClosure = {
        ...loweringClosure,
        preparation,
        comparableWorkload,
        nowMs,
      };
      const persistedProposal = resources.authority.readDynamicMultiProposal(harness.runId, preparation.workCellId);
      if (!persistedProposal) throw new TypeError("Dynamic Multi proposal persistence failed");
      inspected = inspectDynamicMultiProposalV2({ ...loweringClosure, shards: persistedProposal.source });
      if (inspected.request.graph_proposal_sha256 !== persistedProposal.graph_proposal_sha256) {
        throw new TypeError("Dynamic Multi proposal changed after persistence");
      }
       const observation = ports ? await ports.measure(inspected.request, inspected) : null;
      if (observation !== null) {
        const measurementClosure = {
          goal_id: inspected.request.goal_id,
          run_id: inspected.request.run_id,
          work_cell_id: inspected.request.work_cell_id,
          plan_revision_id: inspected.request.plan_revision_id,
          plan_revision_sha256: inspected.request.plan_revision_sha256,
          input_closure_sha256: inspected.request.input_closure_sha256,
          runtime_fingerprint_sha256: inspected.request.runtime_fingerprint_sha256,
          config_sha256: inspected.request.config_sha256,
          baseline_sha256: inspected.request.baseline_sha256,
          baseline_content_root_sha256: inspected.request.baseline_content_root_sha256,
          environment_sha256: inspected.request.environment_sha256,
        } as const;
        const strongSingleEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
          ...measurementClosure,
          kind: "STRONG_SINGLE",
          graph_proposal_sha256: null,
          derivation: "HOST_STRONG_SINGLE_ROLLOUT",
          source_observation_sha256: observation.comparability?.record_sha256 ?? canonicalJsonSha256({
            domain: "PCH-HOST-STRONG-SINGLE-OBSERVATION-V2",
            request: inspected.request,
            observation: observation.strong_single,
          }),
          correctness: observation.strong_single.correctness,
          quality_basis_points: observation.strong_single.quality_basis_points,
          wall_time_ms: observation.strong_single.wall_time_ms,
          provider_requests: observation.strong_single.provider_requests,
          input_tokens: observation.strong_single.input_tokens,
          output_tokens: observation.strong_single.output_tokens,
          user_interventions: observation.strong_single.user_interventions,
          safety_events: observation.strong_single.safety_events,
          predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
          observed_at_ms: nowMs,
        });
        const candidateEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
          ...measurementClosure,
          kind: "DYNAMIC_MULTI_SIMULATION",
          graph_proposal_sha256: inspected.request.graph_proposal_sha256,
          derivation: "HOST_DETERMINISTIC_DAG_SIMULATION",
          source_observation_sha256: canonicalJsonSha256({
            domain: "PCH-HOST-DYNAMIC-MULTI-SIMULATION-V2",
            request: inspected.request,
            observation: observation.candidate,
          }),
          correctness: observation.candidate.correctness,
          quality_basis_points: observation.candidate.estimated_quality_basis_points,
          wall_time_ms: observation.candidate.estimated_wall_time_ms,
          provider_requests: observation.candidate.estimated_provider_requests,
          input_tokens: observation.candidate.estimated_input_tokens,
          output_tokens: observation.candidate.estimated_output_tokens,
          user_interventions: observation.candidate.estimated_user_interventions,
          safety_events: observation.candidate.estimated_safety_events,
          predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
          observed_at_ms: nowMs,
        });
        const evidenceReceipts = [strongSingleEvidence, candidateEvidence] as const;
        const receipts = [
          finalizeTopologyMeasurementReceiptV2({
            ...measurementClosure,
            kind: "STRONG_SINGLE",
            graph_proposal_sha256: null,
            correctness: observation.strong_single.correctness,
            quality_basis_points: observation.strong_single.quality_basis_points,
            wall_time_ms: observation.strong_single.wall_time_ms,
            provider_requests: observation.strong_single.provider_requests,
            input_tokens: observation.strong_single.input_tokens,
            output_tokens: observation.strong_single.output_tokens,
            user_interventions: observation.strong_single.user_interventions,
            safety_events: observation.strong_single.safety_events,
            source_evidence_sha256: strongSingleEvidence.record_sha256,
            predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
            observed_at_ms: nowMs,
          }),
          finalizeTopologyMeasurementReceiptV2({
            ...measurementClosure,
            kind: "DYNAMIC_MULTI_SIMULATION",
            graph_proposal_sha256: inspected.request.graph_proposal_sha256,
            correctness: observation.candidate.correctness,
            quality_basis_points: observation.candidate.estimated_quality_basis_points,
            wall_time_ms: observation.candidate.estimated_wall_time_ms,
            provider_requests: observation.candidate.estimated_provider_requests,
            input_tokens: observation.candidate.estimated_input_tokens,
            output_tokens: observation.candidate.estimated_output_tokens,
            user_interventions: observation.candidate.estimated_user_interventions,
            safety_events: observation.candidate.estimated_safety_events,
            source_evidence_sha256: candidateEvidence.record_sha256,
            predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
            observed_at_ms: nowMs,
          }),
        ] as const;
        const measured = resources.authority.transactExecutionV2({
          type: "RECORD_TOPOLOGY_MEASUREMENTS_V2",
          goalId: binding.goalId,
          evidenceReceipts,
          receipts,
          ...(observation.comparability === undefined ? {} : { comparability: observation.comparability }),
        }, binding.mutation(`host:execution-v2:measurements:${canonicalJsonSha256({ evidenceReceipts, receipts })}`));
        binding.advanceVersion(measured.goalVersion);
        preparation = resources.authority.readExecutionV2Preparation(binding.goalId, harness.runId);
      }
      const admissionEvidence = resources.authority.readTopologyAdmissionMeasurements({
        goal_id: inspected.request.goal_id,
        run_id: inspected.request.run_id,
        work_cell_id: inspected.request.work_cell_id,
        plan_revision_id: inspected.request.plan_revision_id,
        plan_revision_sha256: inspected.request.plan_revision_sha256,
        input_closure_sha256: inspected.request.input_closure_sha256,
        runtime_fingerprint_sha256: inspected.request.runtime_fingerprint_sha256,
        config_sha256: inspected.request.config_sha256,
        baseline_sha256: inspected.request.baseline_sha256,
        baseline_content_root_sha256: inspected.request.baseline_content_root_sha256,
        environment_sha256: inspected.request.environment_sha256,
        graph_proposal_sha256: inspected.request.graph_proposal_sha256,
      });
      const lowered = lowerInspectedDynamicMultiV2({
        ...loweringClosure,
        preparation,
        admissionEvidence,
        inspected,
      });
      const mutation = binding.mutation(`host:execution-v2:admission:${lowered.gate.record_sha256}`);
      const result = lowered.graph === null
        ? resources.authority.transactExecutionV2({
          type: "RECORD_TOPOLOGY_ADMISSION_V2",
          goalId: binding.goalId,
          baseline: lowered.baseline,
          candidate: lowered.candidate,
          gate: lowered.gate,
          topology: lowered.topology,
        }, mutation)
        : resources.authority.transactExecutionV2({
          type: "ADMIT_AND_COMMIT_EXECUTION_GRAPH_V2",
          goalId: binding.goalId,
          baseline: lowered.baseline,
          candidate: lowered.candidate,
          gate: lowered.gate,
          topology: lowered.topology,
          graph: lowered.graph,
        }, mutation);
      binding.advanceVersion(result.goalVersion);
      return {
        harness: {
          schema_version: 2,
          run_id: harness.runId,
          effective_topology: lowered.gate.effective_topology,
          reason: lowered.gate.reason_code,
          execution_graph_revision_id: lowered.graph?.execution_graph_revision_id ?? null,
          graph_sha256: lowered.graph?.record_sha256 ?? null,
          ready_node_ids: resources.authority.readExecutionV2(harness.runId, 8)?.readyNodeIds ?? [],
        },
        status: this.status(),
      };
    }
  }

  private captureStrongSingleRollout(session: TaskFlowSession): StrongSingleRolloutCaptureV1 | null {
    const harness = session.harnessView();
    const resources = session.resources();
    if (!harness || !resources || harness.effectiveTopology !== "SINGLE") return null;
    try {
      const preparation = resources.authority.readStrongSingleRolloutPreparation(harness.goalId, harness.runId);
      if (preparation === null) return null;
      const executionPreparation = resources.authority.readExecutionV2Preparation(harness.goalId, harness.runId);
      if (executionPreparation.workCellId !== preparation.work_cell_id
        || executionPreparation.authorizationSha256 !== preparation.authorization_sha256) return null;
      const runtimeFingerprintSha256 = this.runtimeFingerprintSha256();
      return {
        preparation,
        runtimeFingerprintSha256,
        workload: resources.authority.readComparableWorkload(executionPreparation, {
          runtimeFingerprintSha256,
          providerProfileSha256: runtimeFingerprintSha256,
          cacheEpochSha256: this.cacheQualificationEpochSha256(),
        }),
      };
    } catch {
      return null;
    }
  }

  private recordStrongSingleRollout(
    session: TaskFlowSession,
    capture: StrongSingleRolloutCaptureV1 | null,
  ): void {
    if (capture === null) return;
    const resources = session.resources();
    if (!resources) return;
    try {
      const completion = resources.authority.readStrongSingleRolloutCompletion(capture.preparation);
      if (completion === null || resources.authority.readProviderRunInvocationCount(
        capture.preparation.goal_id, capture.preparation.run_id,
      ) !== 0) return;
      const usage = resources.authority.readRunProviderTurnUsage({
        goal_id: capture.preparation.goal_id,
        run_id: capture.preparation.run_id,
        started_at_ms: capture.preparation.started_at_ms,
        completed_at_ms: completion.completed_at_ms,
      });
      if (usage.accounting_completeness !== "COMPLETE") return;
      const receipt = finalizeStrongSingleRolloutReceiptV1({
        ...capture.preparation,
        runtime_fingerprint_sha256: capture.runtimeFingerprintSha256,
        completion_receipt_id: completion.completion_receipt_id,
        completion_receipt_sha256: completion.completion_receipt_sha256,
        provider_requests: usage.requests,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        provider_receipt_refs: usage.receipt_refs,
        user_interventions: completion.user_interventions,
        safety_events: completion.safety_events,
        completed_at_ms: completion.completed_at_ms,
      });
      const binding = session.binding();
      if (!binding || binding.goalId !== receipt.goal_id) return;
      const workloadBinding = finalizeStrongSingleWorkloadBindingV1({
        source_goal_id: receipt.goal_id,
        source_run_id: receipt.run_id,
        source_work_cell_id: receipt.work_cell_id,
        source_rollout_receipt_id: receipt.rollout_receipt_id,
        source_rollout_receipt_sha256: receipt.record_sha256,
        source_topology_revision: receipt.topology_revision,
        source_topology_revision_sha256: receipt.topology_revision_sha256,
        workload: capture.workload,
        created_at_ms: receipt.completed_at_ms,
      });
      const result = resources.authority.transactExecutionV2({
        type: "RECORD_STRONG_SINGLE_ROLLOUT_V1",
        goalId: receipt.goal_id,
        receipt,
        workloadBinding,
      }, binding.mutation(`host:strong-single-rollout:${receipt.record_sha256}`));
      binding.advanceVersion(result.goalVersion);
    } catch {
      // Rollout telemetry is fail-closed for Multi admission and must not alter a completed WorkCell outcome.
    }
  }

  private runtimeFingerprintSha256(): string {
    const runtime = this.entered?.runtime;
    if (!runtime) throw new TypeError("Dynamic Multi Supervisor runtime is unavailable");
    return piRuntimeFingerprintSha256(runtime);
  }

  private cacheQualificationEpochSha256(): string {
    const configured = this.runtimeResolution?.config.modules.cache;
    const effective = this.cacheRuntime && this.entered
      ? this.cacheRuntime.effective(this.entered.runtime)
      : { arm: "C0" as const, providerIntegration: null, reason: "DISABLED" as const };
    return canonicalJsonSha256({
      domain: "PCH-CACHE-QUALIFICATION-EPOCH-V1",
      configured: configured ? {
        enabled: configured.enabled,
        epoch: configured.epoch,
        arm: configured.arm,
        provider_integration: configured.provider_integration ?? null,
      } : null,
      effective,
    });
  }

  private dynamicMultiPorts(session: TaskFlowSession): DynamicMultiHostPortsV2 | undefined {
    if (this.dynamicMultiPortsValue !== undefined) return this.dynamicMultiPortsValue ?? undefined;
    const configured = this.options.dynamicMulti;
    if (configured === undefined) {
      this.dynamicMultiPortsValue = null;
      return undefined;
    }
    this.dynamicMultiPortsValue = "create" in configured
      ? configured.create({ session, workspace: session.workspaceRoot(), now: this.options.now ?? Date.now })
      : configured;
    return this.dynamicMultiPortsValue;
  }

  private async startWorkerJob(session: TaskFlowSession, params: unknown): Promise<unknown> {
    if (!this.entered || this.entered.topology !== "MULTI") throw new TypeError("Worker jobs require MULTI topology");
    if (this.workerJob?.state === "RUNNING") throw new TypeError("A worker job is already running");
    const row = params === null ? {} : record(params, "worker_start params");
    const configuredParallel = this.runtimeResolution?.config.execution.max_parallel_workers ?? 4;
    const requested = row.max_parallel === undefined ? configuredParallel : integer(row.max_parallel, "max_parallel", 1);
    const maxParallel = Math.min(8, configuredParallel, requested);
    const ports = this.dynamicMultiPorts(session);
    if (!ports) throw new TypeError("Dynamic Multi Host ports are unavailable");
    const resources = session.resources();
    const harness = session.harnessView();
    const binding = session.binding();
    if (!resources || !harness || !binding) throw new TypeError("Dynamic Multi authority is unavailable");
    const projection = resources.authority.readExecutionV2(harness.runId, maxParallel);
    if (!projection) throw new TypeError("No admitted Execution V2 graph is available");
    if (projection.status !== "RUNNING") throw new TypeError(`Execution V2 graph is ${projection.status.toLowerCase()}`);
    if (harness.effectiveTopology !== "MULTI" || projection.graph.runtime_fingerprint_sha256 !== this.runtimeFingerprintSha256()) {
      throw new TypeError("Dynamic Multi graph is not bound to the current effective topology and Pi runtime");
    }
    const coordinator = new DynamicMultiCoordinator({
      authority: resources.authority,
      mutation: {
        transact: (command, idempotencyKey) => {
          const result = resources.authority.transactExecutionV2(command, binding.mutation(idempotencyKey));
          binding.advanceVersion(result.goalVersion);
          return result;
        },
      },
      runId: harness.runId,
      workspace: this.entered.cwd,
      capabilityKey: hmacSha256Hex(this.options.hostSecret, `execution-v2:${projection.graph.record_sha256}`),
      supervisorRuntime: this.entered.runtime,
      worker: ports.worker,
      evidence: ports.evidence,
      oracle: ports.oracle,
      ...(ports.integration === undefined ? {} : { integration: ports.integration }),
      artifactStore: resources.artifacts,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    const started = await coordinator.start(maxParallel);
    const id = started.job_id;
    const job = {
      id, aborts: [] as readonly AbortController[], coordinator,
      state: "RUNNING" as const as "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED",
      workerCount: Math.max(started.active_worker_count, started.peak_worker_count),
      startedAtMs: projection.graph.created_at_ms,
      result: null as unknown, error: null as string | null, completion: Promise.resolve(),
    };
    this.workerJob = job;
    job.completion = coordinator.wait().then((terminal) => {
      job.state = this.workerState(terminal);
      job.workerCount = Math.max(job.workerCount, terminal.peak_worker_count);
      job.result = this.workerResult(terminal);
      job.error = terminal.error;
    });
    return { job_id: id, state: "RUNNING", worker_count: job.workerCount };
  }

  private pollWorkerJob(params: unknown): unknown {
    const row = record(params, "worker_poll params");
    const id = text(row.job_id, "job_id", 256);
    if (this.workerJob?.id === id && this.workerJob.coordinator) {
      const view = this.workerJob.coordinator.poll();
      this.workerJob.state = this.workerState(view);
      this.workerJob.workerCount = Math.max(this.workerJob.workerCount, view.peak_worker_count);
      this.workerJob.result = this.workerResult(view);
      this.workerJob.error = view.error;
    }
    if (!this.workerJob || this.workerJob.id !== id) {
      const session = this.requiredSession();
      const harness = session.harnessView();
      const projection = harness ? session.resources()?.authority.readExecutionV2(harness.runId, 8) : null;
      if (!projection || id !== `EXECUTION-V2-${projection.graph.run_id}`) throw new TypeError("Worker job is unknown");
      const state = projection.status === "CLOSED" ? "SUCCEEDED"
        : projection.status === "FAILED" ? "FAILED"
          : projection.status === "STOPPED" ? "ABORTED" : "RUNNING";
      return {
        job_id: id,
        state,
        result: {
          graph_status: projection.status,
          ready_node_ids: projection.readyNodeIds,
          active_node_ids: projection.activeNodeIds,
          completed_node_ids: projection.completedNodeIds,
        },
        error: null,
        worker_count: projection.activeNodeIds.length,
        elapsed_ms: Math.max(0, (this.options.now ?? Date.now)() - projection.graph.created_at_ms),
      };
    }
    return {
      job_id: id, state: this.workerJob.state, result: this.workerJob.result, error: this.workerJob.error,
      worker_count: this.workerJob.workerCount,
      elapsed_ms: Math.max(0, (this.options.now ?? Date.now)() - this.workerJob.startedAtMs),
    };
  }

  private async abortWorkerJob(params: unknown): Promise<unknown> {
    const row = record(params, "worker_abort params");
    const id = text(row.job_id, "job_id", 256);
    if (this.workerJob?.id === id) {
      await this.stopRunningWorkerJob();
      return { job_id: id, abort_requested: true };
    }
    const session = this.requiredSession();
    const harness = session.harnessView();
    const resources = session.resources();
    const binding = session.binding();
    if (!harness || !resources) throw new TypeError("Worker job is unknown");
    const projection = resources.authority.readExecutionV2(harness.runId, 8);
    if (!projection || id !== `EXECUTION-V2-${projection.graph.run_id}`) throw new TypeError("Worker job is unknown");
    if (projection.status === "RUNNING") {
      if (!binding) throw new TypeError("Dynamic Multi Goal binding is unavailable");
      const preparation = resources.authority.readExecutionStopPreparation(harness.runId);
      if (!preparation) return { job_id: id, abort_requested: true };
      const stop = finalizeExecutionStopV2({
        graph: preparation.graph,
        stop_generation: preparation.stopGeneration + 1,
        scope: "GRAPH_STOP",
        reason: "USER_CANCEL",
        affected_node_ids: preparation.graph.nodes.map((node) => node.node_id),
        predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
        created_at_ms: (this.options.now ?? Date.now)(),
      });
      const result = resources.authority.transactExecutionV2({
        type: "STOP_EXECUTION_V2",
        goalId: preparation.graph.goal_id,
        stop,
      }, binding.mutation(`host:execution-v2:${stop.execution_stop_id}:recovered-stop`));
      binding.advanceVersion(result.goalVersion);
    }
    return { job_id: id, abort_requested: true };
  }

  private async stopRunningWorkerJob(): Promise<void> {
    if (this.workerJob?.state !== "RUNNING") return;
    if (this.workerJob.coordinator) {
      const stopped = await this.workerJob.coordinator.stop();
      this.workerJob.state = this.workerState(stopped);
      this.workerJob.workerCount = Math.max(this.workerJob.workerCount, stopped.peak_worker_count);
      this.workerJob.result = this.workerResult(stopped);
      this.workerJob.error = stopped.error;
    }
    for (const abort of this.workerJob.aborts) abort.abort();
  }

  private workerState(view: DynamicMultiJobViewV2): "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" {
    return view.state === "STOPPED" ? "ABORTED" : view.state;
  }

  private workerResult(view: DynamicMultiJobViewV2): unknown {
    return {
      graph_status: view.graph_status,
      ready_node_ids: view.ready_node_ids,
      active_node_ids: view.active_node_ids,
      completed_node_ids: view.completed_node_ids,
      peak_worker_count: view.peak_worker_count,
    };
  }

  private createSession(resolution: HarnessRuntimeResolution): TaskFlowSession {
    return new TaskFlowSession({
      config: resolution.config, packageRoot: this.options.packageRoot,
      migrationPath: resolve(this.options.packageRoot, "schemas", "sql", "001_core.sql"),
      harnessMigrationPath: resolve(this.options.packageRoot, "schemas", "sql", "013_coding_harness_v1.sql"),
      memoryRecallEnabled: resolution.memoryRecallError === null,
      memoryRecallFallbackReason: resolution.memoryRecallError,
      ...(this.options.dataRoot === undefined ? {} : { dataRoot: this.options.dataRoot }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
  }

  private sessionContext(cwd: string, sessionId: string): Pick<ExtensionContext, "cwd" | "sessionManager" | "ui"> {
    return {
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: () => undefined },
    } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">;
  }

  private discoverGoals(value: unknown): HostResult<"discover_goals"> {
    const row = record(value, "goal discovery params");
    const cwd = text(row.cwd, "cwd", 4_096);
    if (!isAbsolute(cwd)) throw new TypeError("cwd must be absolute");
    const sessionId = text(row.session_id, "session_id", 256);
    assertWalRuntimeSafe();
    const resolution = resolveHarnessRuntimeConfig(this.options.configPath, loadConfig(this.options.configPath));
    const session = this.createSession(resolution);
    try {
      session.initialize(this.sessionContext(resolve(cwd), sessionId), {
        recovery: { kind: "NONE" }, runtimeInstanceId: this.runtimeInstanceId,
      });
      const now = this.options.now?.() ?? Date.now();
      const current = session.currentSessionGoalBinding();
      return {
        current_session_binding: current ? toSessionGoalBindingMarker(current) : null,
        recoverable: session.recoverableSessionGoals().map((candidate) => ({
          goal_id: candidate.goalId,
          goal_title: candidate.goalTitle,
          objective: candidate.objective,
          intent: candidate.intent,
          status: candidate.status,
          next_action_code: candidate.nextActionCode,
          binding_state: candidate.state,
          controller_session_id: candidate.controllerSessionId,
          controller_live: candidate.leaseReleasedAtMs === null
            && candidate.leaseExpiresAtMs !== null && candidate.leaseExpiresAtMs > now,
          binding_receipt_sha256: candidate.bindingReceiptSha256,
        })),
      };
    } finally {
      session.shutdown();
    }
  }

  private async enter(value: unknown): Promise<unknown> {
    const input = enterParams(value);
    const requestSha256 = canonicalJsonSha256(input);
    if (this.entered) {
      if (this.entryRequestSha256 !== requestSha256) {
        throw new TypeError("Coding Harness Host is already bound to a different entry contract");
      }
      return this.status();
    }
    assertWalRuntimeSafe();
    const resolution = resolveHarnessRuntimeConfig(this.options.configPath, loadConfig(this.options.configPath));
    const config = resolution.config;
    const session = this.createSession(resolution);
    const context = this.sessionContext(input.cwd, input.session_id);
    try {
      if (input.entry_mode === "RESUME") {
        session.initialize(context, {
          recovery: { kind: "BOUND_MARKER", marker: input.binding_marker },
          runtimeInstanceId: this.runtimeInstanceId,
        });
      } else if (input.entry_mode === "RECOVER") {
        session.initialize(context, {
          recovery: { kind: "GOAL_ID", goalId: input.goal_id },
          runtimeInstanceId: this.runtimeInstanceId,
        });
      } else {
        session.initialize(context, {
          recovery: input.entry_mode === "NEW" ? { kind: "NONE" } : { kind: "LEGACY_LATEST" },
          runtimeInstanceId: this.runtimeInstanceId,
        });
      }

      let recovered = session.entryBinding();
      if ((input.entry_mode === "LEGACY" || input.entry_mode === "NEW") && recovered
        && (recovered.objective !== input.objective.normalize("NFC").trim() || recovered.intent !== input.intent)) {
        throw new TypeError(`Recovered Goal ${recovered.goalId} is bound to a different objective or intent; enter with its original contract or cancel it first`);
      }
      if (!recovered && (input.entry_mode === "LEGACY" || input.entry_mode === "NEW")) {
        const admitted = session.startFromInput(`${input.intent === "PLAN" ? "plan" : "build"}: ${input.objective}`, context);
        if (admitted?.action !== "transform") throw new TypeError("Coding Harness objective was not admitted");
        recovered = session.entryBinding();
      }
      if (!recovered) throw new TypeError("Coding Harness entry did not resolve an active Goal");

      const recoveredHarness = session.harnessView();
      const selectedIntent = input.entry_mode === "LEGACY" || input.entry_mode === "NEW" ? input.intent : recovered.intent;
      const requestedTopology = input.entry_mode === "LEGACY" || input.entry_mode === "NEW"
        ? input.topology : recoveredHarness?.requestedTopology;
      if (!requestedTopology) throw new TypeError("Recovered Goal has no Harness topology authority");
      if (input.entry_mode === "RECOVER") {
        session.bindCurrentGoal({ allowTransfer: input.allow_transfer });
      } else if (input.entry_mode !== "RESUME") {
        session.bindCurrentGoal();
      }

      const effectiveTopology = recoveredHarness?.effectiveTopology
        ?? (requestedTopology === "MULTI" ? "SINGLE" : requestedTopology);
      session.createHarnessRun({
        topology: effectiveTopology,
        requestedTopology,
        reasonCode: requestedTopology !== effectiveTopology ? "MULTI_BENEFIT_EVIDENCE_REQUIRED" : "USER_SELECTED",
        createdByHostHmac: hmacSha256Hex(this.options.hostSecret, `host:${process.pid}`),
        configSha256: canonicalJsonSha256(config),
        decisionSha256: canonicalJsonSha256({
          intent: selectedIntent, requested_topology: requestedTopology,
          effective_topology: effectiveTopology,
          admission: requestedTopology !== effectiveTopology ? "MULTI_BENEFIT_EVIDENCE_REQUIRED" : "USER_SELECTED",
          runtime: input.runtime,
        }),
      });
      const selected: EnterParams = {
        cwd: input.cwd,
        session_id: input.session_id,
        entry_mode: input.entry_mode,
        objective: recovered.objective,
        intent: selectedIntent,
        topology: requestedTopology,
        runtime: input.runtime,
      };
      const contextRuntime = new HarnessContextRuntime({
        session, config, runtimeSelection: selected.runtime, sessionId: selected.session_id,
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
          settle: (settlement) => resources.authority.settleCacheV2(settlement),
        },
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      }) : null;
      this.session = session;
      this.contextRuntime = contextRuntime;
      this.cacheRuntime = cacheRuntime;
      this.runtimeResolution = resolution;
      this.entered = selected;
      this.entryRequestSha256 = requestSha256;
      const currentHarness = session.harnessView();
      const currentBinding = session.binding();
      if (currentHarness?.requestedTopology === "MULTI" && currentHarness.effectiveTopology === "SINGLE"
        && currentHarness.topologyReasonCode === "MULTI_BENEFIT_EVIDENCE_REQUIRED"
        && currentBinding?.authorizedWorkCellId) {
        const proposal = resources?.authority.readDynamicMultiProposal(
          currentHarness.runId, currentBinding.authorizedWorkCellId,
        );
        if (proposal) await this.defineDynamicMultiGraph(session, proposal.source);
      }
      return this.status();
    } catch (error) {
      session.shutdown();
      throw error;
    }
  }

  private status(): HostStatus {
    const configuredCache = this.runtimeResolution?.config.modules.cache;
    const effectiveCache = this.cacheRuntime && this.entered
      ? this.cacheRuntime.effective(this.entered.runtime)
      : { arm: "C0" as const, providerIntegration: null, reason: "DISABLED" as const };
    const planReview = this.session?.planReview() ?? null;
    const contractReview = this.session?.contractReview() ?? null;
    const flow = this.session?.current() ?? null;
    const harness = this.session?.harnessView() ?? null;
    const sessionBinding = this.session?.sessionGoalBinding() ?? null;
    const openClarifications = this.session?.openClarifications() ?? [];
    const authority = this.session?.resources()?.authority ?? null;
    const executionV2 = harness === null
      ? null
      : authority?.readExecutionV2(harness.runId, 8) ?? null;
    const execution = executionV2 === null
      ? harness === null ? null : {
        status: harness.status,
        ready: harness.shards.filter((shard) => shard.status === "READY").length,
        active: harness.shards.filter((shard) => shard.status === "RUNNING").length,
        completed: harness.shards.filter((shard) => shard.status === "SUCCEEDED").length,
      }
      : {
        status: executionV2.status,
        ready: executionV2.readyNodeIds.length,
        active: executionV2.activeNodeIds.length,
        completed: executionV2.completedNodeIds.length,
      };
    const recentChanges = flow === null || authority === null
      ? [] : authority.readRecentTaskFlowChangesV2(flow.goalId, 16);
    const currentPlan = flow === null || authority === null ? null : authority.readTaskFlowPlanV2(flow.goalId);
    const acceptance = currentPlan === null || authority === null
      ? null : authority.readTaskFlowAcceptanceV2(currentPlan.revision.contract_id);
    const completion = flow === null || authority === null
      ? { acceptance_obligation_ids: [] as readonly string[], receipt_refs: [] as readonly string[] }
      : authority.readTaskFlowCompletionEvidenceV2(flow.goalId);
    const mustObligationIds = acceptance?.obligations
      .filter((obligation) => obligation.priority === "MUST")
      .map((obligation) => obligation.acceptance_obligation_id) ?? null;
    const satisfiedObligations = new Set(completion.acceptance_obligation_ids);
    const supervisorProvider = flow === null || authority === null ? null : authority.readGoalProviderTurnUsage(flow.goalId);
    const workerProvider = flow === null || authority === null ? null : authority.readProviderGoalUsageSummary(flow.goalId);
    const providerCompleteness = supervisorProvider === null || workerProvider === null
      ? "UNOBSERVABLE" as const
      : supervisorProvider.accounting_completeness === "COMPLETE" && workerProvider.accounting_completeness === "COMPLETE"
        ? "COMPLETE" as const
        : supervisorProvider.accounting_completeness === "UNOBSERVABLE"
          && workerProvider.accounting_completeness === "UNOBSERVABLE"
          ? "UNOBSERVABLE" as const : "PARTIAL" as const;
    const addKnown = (left: number | null, right: number | null): number | null =>
      left === null || right === null ? null : left + right;
    const decisionInbox = flow === null ? null : projectDecisionInboxV2({
      goalId: flow.goalId,
      phase: flow.phase,
      nextAction: flow.nextAction,
      workCellId: flow.workCell ?? null,
      routeHealth: flow.routeHealth,
      blocker: flow.blocker,
      clarifications: openClarifications.map((clarification) => ({
        id: clarification.id,
        reversible: clarification.reversible,
        record: clarification as unknown as Readonly<Record<string, unknown>>,
      })),
      contractReview,
      planReview,
      execution,
      changes: {
        recent: recentChanges.map((change) => ({
          change_request_id: change.request.change_request_id,
          classification: change.request.classification,
          materiality: change.request.materiality,
          changed_subject_count: change.impact.changed_subjects.length,
          invalidated_subject_count: change.impact.invalidated_subjects.length,
          reusable_subject_count: change.impact.reusable_subjects.length,
          authority_ref_sha256: change.request.record_sha256,
          created_at_ms: change.request.created_at_ms,
        })),
        invalidatedWork: recentChanges.flatMap((change) => change.impact.invalidated_subjects.map((subject) => ({
          subject_kind: subject.kind,
          subject_id: subject.id,
          revision_sha256: subject.revision_sha256,
          authority_ref_sha256: change.impact.record_sha256,
        }))).slice(0, 512),
        reusedWork: recentChanges.flatMap((change) => change.reuse_receipts.map((receipt) => ({
          subject_kind: receipt.subject.kind,
          subject_id: receipt.subject.id,
          revision_sha256: receipt.subject.revision_sha256,
          authority_ref_sha256: receipt.record_sha256,
        }))).slice(0, 512),
      },
      acceptance: {
        mustTotal: mustObligationIds?.length ?? null,
        mustSatisfied: mustObligationIds === null ? null
          : mustObligationIds.filter((id) => satisfiedObligations.has(id)).length,
        currentReceiptRefs: completion.receipt_refs,
      },
      provider: {
        requests: supervisorProvider === null || workerProvider === null || workerProvider.requests === null
          ? null : supervisorProvider.requests + workerProvider.requests,
        inputTokens: supervisorProvider === null || workerProvider === null
          ? null : addKnown(supervisorProvider.input_tokens, workerProvider.input_tokens),
        outputTokens: supervisorProvider === null || workerProvider === null
          ? null : addKnown(supervisorProvider.output_tokens, workerProvider.output_tokens),
        cacheReadTokens: supervisorProvider === null || workerProvider === null
          ? null : addKnown(supervisorProvider.cache_read_tokens, workerProvider.cache_read_tokens),
        costUsd: supervisorProvider === null || workerProvider === null || supervisorProvider.requests > 0
          || workerProvider.cost_microusd === null ? null : workerProvider.cost_microusd / 1_000_000,
        budgetState: supervisorProvider !== null && supervisorProvider.requests === 0 && workerProvider !== null
          ? workerProvider.budget_state : "UNKNOWN",
        accountingCompleteness: providerCompleteness,
        scope: "GOAL_BOUND_OBSERVED",
        receiptRefs: [...new Set([
          ...(supervisorProvider?.receipt_refs ?? []), ...(workerProvider?.receipt_refs ?? []),
        ])].sort(),
      },
    });
    const taskFlowView = flow === null || authority === null ? null : authority.readTaskFlowView(flow.goalId);
    const authorityEventSequence = flow === null || authority === null ? null : authority.readTaskFlowGoalVersion(flow.goalId);
    const workCell = taskFlowView?.route?.work_cells.find((candidate) => candidate.work_cell_id === flow?.workCell) ?? null;
    const currentWorkCell = workCell === null ? null : {
      work_cell_id: workCell.work_cell_id,
      title: workCell.outcome,
      status: taskFlowView?.workCellStatus ?? null,
      revision: taskFlowView?.route?.revision ?? 1,
    };
    const presentation = flow === null || authorityEventSequence === null ? null : projectHostPresentation({
      phase: flow.phase,
      nextAction: flow.nextAction,
      blocker: flow.blocker,
      harnessStatus: harness?.status ?? null,
      pendingKinds: decisionInbox?.pending.map((item) => item.kind) ?? [],
      authorityEventSequence,
      revision: taskFlowView?.route?.revision ?? taskFlowView?.contract?.version ?? sessionBinding?.revision ?? 1,
    });
    const changedFiles = flow === null || authority === null ? [] : authority.readTaskFlowChangedFiles(flow.goalId).map((file) => ({
      path: file.path,
      change: file.change,
      operation_id: file.operationId,
      work_cell_id: file.workCellId,
      before_sha256: file.beforeSha256,
      after_sha256: file.afterSha256,
      authority_event_sequence: file.authorityEventSequence,
    }));
    return {
      active: this.session !== null,
      flow: flow === null ? null : {
        goalId: flow.goalId,
        objective: flow.objective,
        mode: flow.mode,
        phase: flow.phase,
        workCell: flow.workCell ?? null,
         routeHealth: flow.routeHealth,
         nextAction: flow.nextAction,
         blocker: flow.blocker,
         unresolvedOperationIds: flow.unresolvedOperationIds,
       },
      harness: harness === null ? null : {
        runId: harness.runId,
        status: harness.status,
        nextReadyShardId: harness.nextReadyShardId,
        requestedTopology: harness.requestedTopology,
        effectiveTopology: harness.effectiveTopology,
        topologyReasonCode: harness.topologyReasonCode,
        shards: harness.shards.map((shard) => ({ ...shard, role: shard.role, status: shard.status })),
      },
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
      open_clarifications: openClarifications,
      decision_inbox: decisionInbox,
      plan_review: planReview === null ? null : {
        summary: planReview.summary, artifact_path: planReview.artifactPath, route_sha256: planReview.routeSha256,
        plan_revision_sha256: planReview.planRevisionSha256, stage_gate_sha256: planReview.stageGateSha256,
      },
      contract_review: contractReview === null ? null : {
        decision_requirement_revision_id: contractReview.decisionRequirementRevisionId,
        requirement_revision_sha256: contractReview.requirementRevisionSha256,
        decision_frontier_sha256: contractReview.decisionFrontierSha256,
        contract_diff: contractReview.contractDiff,
        requirement_diff: contractReview.requirementDiff,
      },
      generation_governor: (() => {
        const frontier = this.optionalGenerationFrontier();
        return frontier ? this.generationGovernor.current(frontier) : null;
      })(),
      runtime: this.entered?.runtime ?? null,
      intent: this.entered?.intent ?? null,
      topology: this.entered?.topology ?? null,
      control_frame: this.contextRuntime?.currentControlFrame() ?? null,
      session_binding: sessionBinding ? toSessionGoalBindingMarker(sessionBinding) : null,
      presentation,
      current_work_cell: currentWorkCell,
      changed_files: changedFiles,
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
