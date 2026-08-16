import type { GenerationGovernorSnapshot } from "../../control/generation-governor.js";
import type { CurrentControlFrame } from "../../control/control-frame.js";
import type { ToolInvocation } from "../../effects/normalize.js";
import type { ContextToolResponse } from "../../input-context/context-tool.js";
import type { MemoryCommandRequest } from "../../memory/commands.js";
import type { ClarificationDecision } from "../../planning/clarification.js";
import {
  parseSessionGoalBindingMarker,
  type SessionGoalBindingMarkerV1,
} from "../../task-flow/session-binding.js";
import {
  validateDecisionInboxProjectionV2,
  type DecisionInboxProjectionV2,
} from "./decision-inbox.js";

type JsonRecord = Readonly<Record<string, unknown>>;

export interface HostRuntimeSelection {
  readonly provider: string;
  readonly api: string;
  readonly base_url?: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
}

interface HostEnterBase {
  readonly cwd: string;
  readonly session_id: string;
  readonly runtime: HostRuntimeSelection;
}

export interface HostNewEnterParams extends HostEnterBase {
  readonly entry_mode?: "LEGACY" | "NEW";
  readonly objective: string;
  readonly intent: "PLAN" | "BUILD";
  readonly topology: "SINGLE" | "MULTI";
}

export interface HostResumeEnterParams extends HostEnterBase {
  readonly entry_mode: "RESUME";
  readonly binding_marker: SessionGoalBindingMarkerV1;
}

export interface HostRecoverEnterParams extends HostEnterBase {
  readonly entry_mode: "RECOVER";
  readonly goal_id: string;
  readonly allow_transfer: boolean;
}

export type HostEnterParams = HostNewEnterParams | HostResumeEnterParams | HostRecoverEnterParams;

export interface HostGoalCandidate {
  readonly goal_id: string;
  readonly goal_title: string;
  readonly objective: string;
  readonly intent: "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
  readonly status: string;
  readonly next_action_code: string;
  readonly binding_state: "BOUND" | "UNBOUND" | "TERMINAL";
  readonly controller_session_id: string | null;
  readonly controller_live: boolean;
  readonly binding_receipt_sha256: string | null;
}

export interface HostGoalDiscovery {
  readonly current_session_binding: SessionGoalBindingMarkerV1 | null;
  readonly recoverable: readonly HostGoalCandidate[];
}

export interface HostFlowStatus extends JsonRecord {
  readonly goalId: string;
  readonly objective: string;
  readonly mode: "PLAN" | "BUILD";
  readonly phase: string;
  readonly workCell: string | null;
  readonly routeHealth: string;
  readonly nextAction: string;
  readonly blocker: string | null;
  readonly unresolvedOperationIds: readonly string[];
}

export interface HostHarnessStatus extends JsonRecord {
  readonly runId: string;
  readonly status: string;
  readonly nextReadyShardId: string | null;
  readonly requestedTopology: "SINGLE" | "MULTI";
  readonly effectiveTopology: "SINGLE" | "MULTI";
  readonly topologyReasonCode: string;
  readonly shards: readonly (JsonRecord & { readonly role: string; readonly status: string })[];
}

export interface HostPresentationV2 {
  readonly schema_version: 2;
  readonly presentation_state_code:
    | "DEFINING_GOAL" | "PLANNING" | "WAITING_FOR_YOU" | "BUILDING" | "VERIFYING"
    | "PAUSED" | "RECONCILING" | "COMPLETED" | "FAILED" | "CANCELED";
  readonly attention: "NONE" | "ACTION_REQUIRED" | "BLOCKING";
  readonly primary_target:
    | "CONTRACT_REVIEW" | "CLARIFICATION" | "PLAN_CONTINUATION" | "RECONCILE"
    | "WORK" | "VERIFY" | "DELIVERABLE";
  readonly authority_event_sequence: number;
  readonly lifecycle: {
    readonly revision: number;
    readonly current_stage: "INTAKE" | "CONTRACT" | "PLAN" | "BUILD" | "VERIFY" | "DELIVER";
    readonly steps: readonly {
      readonly code: "INTAKE" | "CONTRACT" | "PLAN" | "BUILD" | "VERIFY" | "DELIVER";
      readonly state: "COMPLETE" | "ACTIVE" | "PENDING";
    }[];
  };
}

export interface HostChangedFileV2 {
  readonly path: string;
  readonly change: "CREATED" | "MODIFIED" | "DELETED" | "MOVED";
  readonly operation_id: string;
  readonly work_cell_id: string;
  readonly before_sha256: string;
  readonly after_sha256: string | null;
  readonly authority_event_sequence: number;
}

export interface HostStatus {
  readonly active: boolean;
  readonly flow: HostFlowStatus | null;
  readonly harness: HostHarnessStatus | null;
  readonly execution_subject: unknown;
  readonly context: null | {
    readonly input_context_error: string | null;
    readonly memory_recall_error: string | null;
    readonly memory_capture_error: string | null;
    readonly provider_turn_ledger_enabled: boolean;
  };
  readonly cache: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly arm: string;
    readonly effective_arm: string;
    readonly provider_integration: string | null;
    readonly reason: string;
  };
  readonly output: { readonly enabled: boolean; readonly mode: string };
  readonly ui?: {
    readonly widget: boolean;
    readonly status: boolean;
    readonly debounce_ms: number;
    readonly max_widget_lines: number;
  };
  readonly open_clarifications?: readonly ClarificationDecision[];
  readonly decision_inbox: DecisionInboxProjectionV2 | null;
  readonly generation_governor: GenerationGovernorSnapshot | null;
  readonly runtime: HostRuntimeSelection | null;
  readonly intent: "PLAN" | "BUILD" | null;
  readonly topology: "SINGLE" | "MULTI" | null;
  readonly control_frame: CurrentControlFrame | null;
  readonly session_binding?: SessionGoalBindingMarkerV1 | null;
  readonly presentation?: HostPresentationV2 | null;
  readonly current_work_cell?: null | {
    readonly work_cell_id: string;
    readonly title: string;
    readonly status: string | null;
    readonly revision: number;
  };
  readonly changed_files?: readonly HostChangedFileV2[];
  readonly plan_review?: null | {
    readonly summary: string;
    readonly artifact_path: string;
    readonly route_sha256: string;
    readonly plan_revision_sha256: string;
    readonly stage_gate_sha256: string;
  };
  readonly contract_review?: null | {
    readonly decision_requirement_revision_id: string;
    readonly requirement_revision_sha256: string;
    readonly decision_frontier_sha256: string;
    readonly contract_diff: JsonRecord;
    readonly requirement_diff: JsonRecord;
  };
}

export interface HostControlFrameParam {
  readonly control_frame_sha256: string;
}

export interface HostControlFrameReceipt {
  readonly control_frame: { readonly control_frame_sha256: string };
}

export interface HostTurnProjectionParams {
  readonly agent_run_id: string;
  readonly system_prompt_sha256: string;
  readonly system_prompt?: string;
  readonly current_input_tokens: number | null;
  readonly active_tools: readonly string[];
  readonly all_tools: readonly string[];
}

export interface HostTurnProjectionResult {
  readonly system_prompt: string;
  readonly changed: boolean;
  readonly context_projection_active: boolean;
  readonly mode: string;
  readonly fit_disposition: string;
  readonly fallback: string | null;
  readonly memory_projected: boolean;
  readonly subject_binding_sha256: string;
  readonly control_frame: CurrentControlFrame;
  readonly generation_governor: GenerationGovernorSnapshot;
}

export interface HostContextProjectionParams {
  readonly delta: {
    readonly schema_version: 1;
    readonly lineage_id: string;
    readonly previous_sequence_root: string;
    readonly previous_count: number;
    readonly append: readonly {
      readonly content_sha256: string;
      readonly role: string;
      readonly custom_type: string | null;
    }[];
    readonly new_sequence_root: string;
    readonly new_count: number;
    readonly full_reconcile: boolean;
  };
  readonly removed_persisted_messages: number;
}

export interface HostContextProjectionResult {
  readonly changed: boolean;
  readonly overlays: readonly { readonly insertionIndex: number; readonly message: unknown }[];
  readonly projectedSegmentCount: number;
  readonly removedPersistedHarnessMessages: number;
  readonly fallback: string;
  readonly projection_ack: {
    readonly accepted: boolean;
    readonly reconcile_required: boolean;
    readonly sequence_root: string;
    readonly count: number;
  };
}

export interface HostProviderHistorySummary {
  readonly descriptor_root_sha256: string;
  readonly message_count: number;
  readonly logical_bytes: number;
  readonly user_bytes: number;
  readonly assistant_bytes: number;
  readonly other_bytes: number;
}

export interface HostProviderUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
}

export interface HostWorkerStatus {
  readonly job_id: string;
  readonly state: "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED";
  readonly result: unknown;
  readonly error: string | null;
  readonly worker_count: number;
  readonly elapsed_ms: number;
}

export interface HostStateResult {
  readonly message: string;
  readonly status: HostStatus;
}

export interface HostApplicationMethods {
  readonly status: { readonly params: null; readonly result: HostStatus };
  readonly shutdown: { readonly params: null; readonly result: { readonly stopped: true } };
  readonly enter: { readonly params: HostEnterParams; readonly result: HostStatus };
  readonly discover_goals: {
    readonly params: { readonly cwd: string; readonly session_id: string };
    readonly result: HostGoalDiscovery;
  };
  readonly unbind_session: {
    readonly params: { readonly expected_binding_receipt_sha256: string };
    readonly result: HostStatus;
  };
  readonly rename_goal: {
    readonly params: { readonly goal_title: string; readonly expected_binding_receipt_sha256: string };
    readonly result: HostStatus;
  };
  readonly update_runtime: {
    readonly params: HostRuntimeSelection;
    readonly result: { readonly runtime: HostRuntimeSelection };
  };
  readonly worker_start: {
    readonly params: HostControlFrameParam & { readonly max_parallel?: number };
    readonly result: { readonly job_id: string; readonly state: "RUNNING"; readonly worker_count: number };
  };
  readonly worker_poll: { readonly params: { readonly job_id: string }; readonly result: HostWorkerStatus };
  readonly worker_abort: {
    readonly params: { readonly job_id: string };
    readonly result: { readonly job_id: string; readonly abort_requested: true };
  };
  readonly turn_projection: { readonly params: HostTurnProjectionParams; readonly result: HostTurnProjectionResult };
  readonly context_project: { readonly params: HostContextProjectionParams; readonly result: HostContextProjectionResult };
  readonly context_fetch: {
    readonly params: HostControlFrameParam & ({
      readonly selector: "CURRENT_ON_DEMAND" | "CURRENT_WORKING_SET";
      readonly candidate_ids?: readonly string[];
      readonly representation?: "EXACT" | "STRUCTURAL";
      readonly cursor?: never;
    } | {
      readonly cursor: string;
      readonly selector?: never;
      readonly candidate_ids?: never;
      readonly representation?: never;
    });
    readonly result: ContextToolResponse;
  };
  readonly provider_begin: {
    readonly params: {
      readonly payload_shape_sha256: string;
      readonly history: HostProviderHistorySummary;
      readonly tool_schema_bytes: number;
    };
    readonly result: {
      readonly recorded: boolean;
      readonly provider_attempt_id: string | null;
      readonly cache_request_id: string | null;
    };
  };
  readonly provider_settle: {
    readonly params: {
      readonly provider_attempt_id: string | null;
      readonly cache_request_id: string | null;
      readonly usage: HostProviderUsage | null;
      readonly response_status: number | null;
      readonly latency_ms: number | null;
      readonly outcome: "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
      readonly assistant_text_bytes: number;
      readonly tool_argument_bytes: number;
    };
    readonly result: { readonly ledger_sha256: string | null; readonly cache: unknown };
  };
  readonly generation_turn: {
    readonly params: { readonly turn_index: number };
    readonly result: GenerationGovernorSnapshot;
  };
  readonly generation_settled: { readonly params: null | JsonRecord; readonly result: GenerationGovernorSnapshot };
  readonly cache_diagnostic: { readonly params: null; readonly result: { readonly message: string } };
  readonly memory_observe: {
    readonly params: { readonly text: string; readonly goal_intake: boolean };
    readonly result: { readonly observed: true };
  };
  readonly active_goal_input: {
    readonly params: { readonly text: string };
    readonly result: HostStateResult;
  };
  readonly classify_active_goal_input: {
    readonly params: HostControlFrameParam & {
      readonly user_turn_id: string;
      readonly expected_user_turn_sha256: string;
      readonly classification: "CORRECT_CURRENT" | "QUEUE_NEXT" | "CHANGE_REQUEST" | "NEW_GOAL" | "INTERRUPT_NOW" | "DISCUSSION_ONLY";
      readonly materiality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      readonly change_kind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE" | null;
      readonly changed_subjects: readonly { readonly kind: "REQUIREMENT" | "DECISION" | "WORK_CELL"; readonly id: string }[];
    };
    readonly result: HostStateResult;
  };
  readonly memory_command: { readonly params: MemoryCommandRequest; readonly result: { readonly message: string } };
  readonly submit_contract: { readonly params: HostControlFrameParam & JsonRecord; readonly result: HostStateResult };
  readonly resolve_contract_review: {
    readonly params: {
      readonly expected_decision_requirement_revision_id: string;
      readonly expected_requirement_revision_sha256: string;
      readonly expected_decision_frontier_sha256: string;
      readonly action: "APPROVE" | "REJECT" | "EDIT" | "DEFER";
      readonly selected_value: unknown;
      readonly edited_requirement_revision_id?: string;
      readonly deferred_trigger_sha256?: string;
    };
    readonly result: HostStateResult;
  };
  readonly submit_route: { readonly params: HostControlFrameParam & JsonRecord; readonly result: HostStateResult };
  readonly submit_route_revision: { readonly params: HostControlFrameParam & JsonRecord; readonly result: HostStateResult };
  readonly continue_plan: {
    readonly params: HostControlFrameParam & {
      readonly expected_route_sha256: string;
      readonly expected_plan_revision_sha256: string;
      readonly expected_stage_gate_sha256: string;
      readonly choice: "BUILD" | "KEEP" | "REVISE";
    };
    readonly result: HostStateResult;
  };
  readonly define_shards: {
    readonly params: HostControlFrameParam & { readonly shards: readonly JsonRecord[] };
    readonly result: { readonly harness: JsonRecord; readonly status: HostStatus };
  };
  readonly tool_preflight: {
    readonly params: HostControlFrameParam & ToolInvocation;
    readonly result: {
      readonly allow: boolean;
      readonly managed: boolean;
      readonly capture: boolean;
      readonly reason: string | null;
      readonly oracle_policy?: JsonRecord;
      readonly control_frame?: { readonly control_frame_sha256: string };
    };
  };
  readonly tool_result: {
    readonly params: {
      readonly tool_call_id: string;
      readonly tool_name: string;
      readonly tool_input: JsonRecord;
      readonly is_error: boolean;
      readonly text: string;
      readonly output_sha256?: string;
    };
    readonly result: { readonly operation_id: string | null } & HostControlFrameReceipt;
  };
  readonly tool_end: {
    readonly params: { readonly tool_call_id: string; readonly is_error: boolean; readonly text: string };
    readonly result: { readonly status: HostStatus } & HostControlFrameReceipt;
  };
  readonly attest: {
    readonly params: HostControlFrameParam & { readonly operation_id: string; readonly obligation_keys?: readonly string[] };
    readonly result: HostStateResult;
  };
  readonly complete: {
    readonly params: HostControlFrameParam & { readonly outcome_evidence?: readonly JsonRecord[] };
    readonly result: HostStateResult;
  };
  readonly reconcile: {
    readonly params: HostControlFrameParam & { readonly operation_id?: string };
    readonly result: HostStateResult;
  };
  readonly control: {
    readonly params: {
      readonly action: "pause" | "resume" | "cancel" | "replan";
      readonly reason?: string;
      readonly control_frame_sha256?: string;
    };
    readonly result: HostStateResult;
  };
  readonly compaction: {
    readonly params: { readonly phase: "before" | "after" };
    readonly result: { readonly checkpoint_sha256: string } | { readonly verified: true };
  };
  readonly clarify_selected: {
    readonly params: HostControlFrameParam & { readonly decisions: readonly JsonRecord[] };
    readonly result: HostStateResult;
  };
}

export type HostMethod = keyof HostApplicationMethods;
export type HostParams<M extends HostMethod> = HostApplicationMethods[M]["params"];
export type HostResult<M extends HostMethod> = HostApplicationMethods[M]["result"];
export type HostApplicationRequest = {
  readonly [M in HostMethod]: { readonly method: M; readonly params: HostParams<M> }
}[HostMethod];

type ParamsKind = "NULL" | "RECORD" | "NULL_OR_RECORD";
type ResultKind =
  | "STATUS" | "STOPPED" | "RUNTIME" | "WORKER_STARTED" | "WORKER_STATUS" | "WORKER_ABORTED"
  | "TURN_PROJECTION" | "CONTEXT_PROJECTION" | "CONTEXT_RESPONSE" | "PROVIDER_BEGIN" | "PROVIDER_SETTLE"
  | "GENERATION" | "MESSAGE" | "OBSERVED" | "STATE" | "SHARDS" | "TOOL_PREFLIGHT"
  | "TOOL_RESULT" | "TOOL_END" | "COMPACTION" | "GOAL_DISCOVERY";

/** The one executable registry of every Bridge-to-Host application operation. */
export const HOST_APPLICATION_PROTOCOL = Object.freeze({
  status: { params: "NULL", result: "STATUS" },
  shutdown: { params: "NULL", result: "STOPPED" },
  enter: { params: "RECORD", result: "STATUS" },
  discover_goals: { params: "RECORD", result: "GOAL_DISCOVERY" },
  unbind_session: { params: "RECORD", result: "STATUS" },
  rename_goal: { params: "RECORD", result: "STATUS" },
  update_runtime: { params: "RECORD", result: "RUNTIME" },
  worker_start: { params: "RECORD", result: "WORKER_STARTED" },
  worker_poll: { params: "RECORD", result: "WORKER_STATUS" },
  worker_abort: { params: "RECORD", result: "WORKER_ABORTED" },
  turn_projection: { params: "RECORD", result: "TURN_PROJECTION" },
  context_project: { params: "RECORD", result: "CONTEXT_PROJECTION" },
  context_fetch: { params: "RECORD", result: "CONTEXT_RESPONSE" },
  provider_begin: { params: "RECORD", result: "PROVIDER_BEGIN" },
  provider_settle: { params: "RECORD", result: "PROVIDER_SETTLE" },
  generation_turn: { params: "RECORD", result: "GENERATION" },
  generation_settled: { params: "NULL_OR_RECORD", result: "GENERATION" },
  cache_diagnostic: { params: "NULL", result: "MESSAGE" },
  memory_observe: { params: "RECORD", result: "OBSERVED" },
  active_goal_input: { params: "RECORD", result: "STATE" },
  classify_active_goal_input: { params: "RECORD", result: "STATE" },
  memory_command: { params: "RECORD", result: "MESSAGE" },
  submit_contract: { params: "RECORD", result: "STATE" },
  resolve_contract_review: { params: "RECORD", result: "STATE" },
  submit_route: { params: "RECORD", result: "STATE" },
  submit_route_revision: { params: "RECORD", result: "STATE" },
  continue_plan: { params: "RECORD", result: "STATE" },
  define_shards: { params: "RECORD", result: "SHARDS" },
  tool_preflight: { params: "RECORD", result: "TOOL_PREFLIGHT" },
  tool_result: { params: "RECORD", result: "TOOL_RESULT" },
  tool_end: { params: "RECORD", result: "TOOL_END" },
  attest: { params: "RECORD", result: "STATE" },
  complete: { params: "RECORD", result: "STATE" },
  reconcile: { params: "RECORD", result: "STATE" },
  control: { params: "RECORD", result: "STATE" },
  compaction: { params: "RECORD", result: "COMPACTION" },
  clarify_selected: { params: "RECORD", result: "STATE" },
} as const satisfies Readonly<Record<HostMethod, { readonly params: ParamsKind; readonly result: ResultKind }>>);

export const HOST_METHODS = Object.freeze(Object.keys(HOST_APPLICATION_PROTOCOL) as HostMethod[]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => own(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim().length > 0 && value === value.normalize("NFC");
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

function rawByteBoundedText(value: unknown, maximumBytes: number): boolean {
  return typeof value === "string" && value.trim().length > 0
    && wellFormedUnicode(value) && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function nonnegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedStringArray(value: unknown, maximum = 4_096, requireOne = false): boolean {
  return Array.isArray(value) && value.length <= maximum && (!requireOne || value.length > 0)
    && value.every((item) => boundedText(item, 512));
}

function runtimeSelection(value: unknown): value is HostRuntimeSelection {
  if (!record(value) || !exactKeys(value,
    ["provider", "api", "model", "thinking_level", "context_window"], ["base_url"])) return false;
  return boundedText(value.provider, 256) && boundedText(value.api, 256)
    && (value.base_url === undefined || boundedText(value.base_url, 2_048))
    && boundedText(value.model, 512) && boundedText(value.thinking_level, 64)
    && safeInteger(value.context_window, 1);
}

function providerHistory(value: unknown): value is HostProviderHistorySummary {
  if (!record(value) || !exactKeys(value, [
    "descriptor_root_sha256", "message_count", "logical_bytes", "user_bytes", "assistant_bytes", "other_bytes",
  ])) return false;
  return sha256(value.descriptor_root_sha256)
    && [value.message_count, value.logical_bytes, value.user_bytes, value.assistant_bytes, value.other_bytes]
      .every((item) => safeInteger(item, 0, 1_000_000_000));
}

function providerUsage(value: unknown): value is HostProviderUsage {
  if (!record(value) || !exactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "reasoning"])) return false;
  return [value.input, value.output, value.cacheRead, value.cacheWrite, value.reasoning]
    .every((item) => item === null || nonnegativeNumber(item));
}

function controlFrameParams(value: unknown): value is Record<string, unknown> & HostControlFrameParam {
  return record(value) && sha256(value.control_frame_sha256);
}

function outcomeEvidence(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every((entry) => {
    if (!record(entry) || !exactKeys(entry, ["obligation_key", "operation_id", "witnesses"])
      || !boundedText(entry.obligation_key, 160) || !boundedText(entry.operation_id, 256)
      || !Array.isArray(entry.witnesses) || entry.witnesses.length < 1 || entry.witnesses.length > 16) return false;
    return entry.witnesses.every((witness) => record(witness) && exactKeys(witness, ["path", "locator"])
      && boundedText(witness.path, 4_096) && boundedText(witness.locator, 512));
  });
}

function clarification(value: unknown): value is ClarificationDecision {
  if (!record(value) || !exactKeys(value, [
    "id", "question", "whyItMatters", "changeKind", "materiality", "reversible", "privacyRelated",
    "options", "recommendedOptionId", "recommendationReason", "dependsOnDecisionIds",
  ])) return false;
  if (!boundedText(value.id, 160) || !boundedText(value.question, 8_192) || !boundedText(value.whyItMatters, 8_192)
    || !["BEHAVIOR", "SCOPE", "ACCEPTANCE", "USER_PREFERENCE"].includes(String(value.changeKind))
    || !["LOW", "MEDIUM", "HIGH"].includes(String(value.materiality))
    || typeof value.reversible !== "boolean" || typeof value.privacyRelated !== "boolean"
    || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 3
    || value.options.some((option) => !record(option) || !exactKeys(option, ["id", "label", "impact"])
      || !boundedText(option.id, 160) || !boundedText(option.label, 512) || !boundedText(option.impact, 2_048))
    || !boundedText(value.recommendedOptionId, 160) || !boundedText(value.recommendationReason, 8_192)
    || !boundedStringArray(value.dependsOnDecisionIds, 5)) return false;
  const optionIds = new Set(value.options.map((option) => String((option as Record<string, unknown>).id)));
  return optionIds.size === value.options.length && optionIds.has(String(value.recommendedOptionId));
}

function contextProjectionDelta(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    "schema_version", "lineage_id", "previous_sequence_root", "previous_count", "append",
    "new_sequence_root", "new_count", "full_reconcile",
  ])) return false;
  if (value.schema_version !== 1 || !sha256(value.lineage_id) || !sha256(value.previous_sequence_root)
    || !sha256(value.new_sequence_root) || !safeInteger(value.previous_count, 0, 16_384)
    || !safeInteger(value.new_count, 0, 16_384) || typeof value.full_reconcile !== "boolean"
    || !Array.isArray(value.append) || value.append.length > 16_384) return false;
  return value.append.every((item) => record(item) && exactKeys(item, ["content_sha256", "role", "custom_type"])
    && sha256(item.content_sha256) && boundedText(item.role, 128)
    && (item.custom_type === null || boundedText(item.custom_type, 256)));
}

function paramsError(method: HostMethod, value: unknown): string | null {
  if (method === "status" || method === "shutdown" || method === "cache_diagnostic") {
    return value === null ? null : "params must be null";
  }
  if (method === "generation_settled") return value === null || record(value) ? null : "params must be null or an object";
  if (!record(value)) return "params must be an object";

  if (method === "enter") {
    const base = boundedText(value.cwd, 4_096) && boundedText(value.session_id, 256) && runtimeSelection(value.runtime);
    if (!base) return "entry contract is invalid";
    if (value.entry_mode === "RESUME") {
      const marker = parseSessionGoalBindingMarker(value.binding_marker);
      return exactKeys(value, ["cwd", "session_id", "runtime", "entry_mode", "binding_marker"])
        && marker !== null && marker.session_id === value.session_id && marker.state === "BOUND" && marker.auto_resume
        ? null : "resume entry contract is invalid";
    }
    if (value.entry_mode === "RECOVER") {
      return exactKeys(value, ["cwd", "session_id", "runtime", "entry_mode", "goal_id", "allow_transfer"])
        && boundedText(value.goal_id, 256) && typeof value.allow_transfer === "boolean"
        ? null : "recover entry contract is invalid";
    }
    return exactKeys(value, ["cwd", "session_id", "objective", "intent", "topology", "runtime"], ["entry_mode"])
      && (value.entry_mode === undefined || value.entry_mode === "LEGACY" || value.entry_mode === "NEW")
      && boundedText(value.objective, 131_072)
      && (value.intent === "PLAN" || value.intent === "BUILD")
      && (value.topology === "SINGLE" || value.topology === "MULTI")
      ? null : "entry contract is invalid";
  }
  if (method === "discover_goals") {
    return exactKeys(value, ["cwd", "session_id"]) && boundedText(value.cwd, 4_096)
      && boundedText(value.session_id, 256) ? null : "goal discovery contract is invalid";
  }
  if (method === "unbind_session") {
    return exactKeys(value, ["expected_binding_receipt_sha256"]) && sha256(value.expected_binding_receipt_sha256)
      ? null : "session unbind contract is invalid";
  }
  if (method === "rename_goal") {
    return exactKeys(value, ["goal_title", "expected_binding_receipt_sha256"])
      && boundedText(value.goal_title, 128) && sha256(value.expected_binding_receipt_sha256)
      ? null : "Goal rename contract is invalid";
  }
  if (method === "update_runtime") return runtimeSelection(value) ? null : "runtime selection is invalid";
  // Authority-bound payload semantics stay in the Host handler, after ControlFrame
  // and GenerationGovernor registration. The protocol edge checks only transport
  // structure for these methods so an invalid repeated route cannot bypass governance.
  if (method === "worker_start") return controlFrameParams(value) ? null : "worker_start params are invalid";
  if (method === "worker_poll" || method === "worker_abort") {
    return exactKeys(value, ["job_id"]) && boundedText(value.job_id, 256) ? null : `${method} params are invalid`;
  }
  if (method === "turn_projection") {
    return exactKeys(value, [
      "agent_run_id", "system_prompt_sha256", "current_input_tokens", "active_tools", "all_tools",
    ], ["system_prompt"])
      && boundedText(value.agent_run_id, 256) && sha256(value.system_prompt_sha256)
      && (value.system_prompt === undefined || boundedText(value.system_prompt, 2_097_152))
      && (value.current_input_tokens === null || safeInteger(value.current_input_tokens, 0))
      && boundedStringArray(value.active_tools) && boundedStringArray(value.all_tools)
      ? null : "turn_projection params are invalid";
  }
  if (method === "context_project") {
    return exactKeys(value, ["delta", "removed_persisted_messages"])
      && contextProjectionDelta(value.delta) && safeInteger(value.removed_persisted_messages, 0)
      ? null : "context_project params are invalid";
  }
  if (method === "context_fetch") return null;
  if (method === "provider_begin") {
    return exactKeys(value, ["payload_shape_sha256", "history", "tool_schema_bytes"])
      && sha256(value.payload_shape_sha256) && providerHistory(value.history)
      && safeInteger(value.tool_schema_bytes, 0, 1_000_000_000) ? null : "provider_begin params are invalid";
  }
  if (method === "provider_settle") {
    return exactKeys(value, [
      "provider_attempt_id", "cache_request_id", "usage", "response_status", "latency_ms", "outcome",
      "assistant_text_bytes", "tool_argument_bytes",
    ])
      && (value.provider_attempt_id === null || boundedText(value.provider_attempt_id, 256))
      && (value.cache_request_id === null || boundedText(value.cache_request_id, 256))
      && (value.usage === null || providerUsage(value.usage))
      && (value.response_status === null || safeInteger(value.response_status, 100))
      && (value.latency_ms === null || nonnegativeNumber(value.latency_ms))
      && (value.outcome === "RESPONDED" || value.outcome === "FAILED" || value.outcome === "OUTCOME_UNKNOWN")
      && safeInteger(value.assistant_text_bytes, 0) && safeInteger(value.tool_argument_bytes, 0)
      ? null : "provider_settle params are invalid";
  }
  if (method === "generation_turn") {
    return exactKeys(value, ["turn_index"]) && safeInteger(value.turn_index, 0, 1_000_000)
      ? null : "generation_turn params are invalid";
  }
  if (method === "memory_observe") {
    return exactKeys(value, ["text", "goal_intake"]) && boundedText(value.text, 16_384)
      && typeof value.goal_intake === "boolean" ? null : "memory_observe params are invalid";
  }
  if (method === "active_goal_input") {
    return exactKeys(value, ["text"]) && rawByteBoundedText(value.text, 131_072)
      ? null : "active_goal_input params are invalid";
  }
  if (method === "classify_active_goal_input") {
    if (!controlFrameParams(value) || !exactKeys(value, [
      "control_frame_sha256", "user_turn_id", "expected_user_turn_sha256", "classification",
      "materiality", "change_kind", "changed_subjects",
    ]) || !boundedText(value.user_turn_id, 160) || !sha256(value.expected_user_turn_sha256)
      || !["CORRECT_CURRENT", "QUEUE_NEXT", "CHANGE_REQUEST", "NEW_GOAL", "INTERRUPT_NOW", "DISCUSSION_ONLY"]
        .includes(String(value.classification))
      || !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(value.materiality))
      || (value.change_kind !== null
        && (typeof value.change_kind !== "string"
          || !["BEHAVIOR", "SCOPE", "ACCEPTANCE", "USER_PREFERENCE"].includes(value.change_kind)))
      || !Array.isArray(value.changed_subjects) || value.changed_subjects.length > 512) {
      return "classify_active_goal_input params are invalid";
    }
    return value.changed_subjects.every((subject) => record(subject) && exactKeys(subject, ["kind", "id"])
      && ["REQUIREMENT", "DECISION", "WORK_CELL"].includes(String(subject.kind))
      && boundedText(subject.id, 160)) ? null : "classify_active_goal_input params are invalid";
  }
  if (method === "memory_command") return null;
  if (method === "resolve_contract_review") {
    const common = exactKeys(value, [
      "expected_decision_requirement_revision_id", "expected_requirement_revision_sha256",
      "expected_decision_frontier_sha256", "action", "selected_value",
    ], ["edited_requirement_revision_id", "deferred_trigger_sha256"])
      && boundedText(value.expected_decision_requirement_revision_id, 160)
      && sha256(value.expected_requirement_revision_sha256) && sha256(value.expected_decision_frontier_sha256)
      && own(value, "selected_value")
      && ["APPROVE", "REJECT", "EDIT", "DEFER"].includes(String(value.action));
    const actionFields = value.action === "EDIT"
      ? boundedText(value.edited_requirement_revision_id, 160) && value.deferred_trigger_sha256 === undefined
      : value.action === "DEFER"
        ? sha256(value.deferred_trigger_sha256) && value.edited_requirement_revision_id === undefined
        : value.edited_requirement_revision_id === undefined && value.deferred_trigger_sha256 === undefined;
    return common && actionFields ? null : "resolve_contract_review params are invalid";
  }
  if (method === "submit_contract" || method === "submit_route" || method === "submit_route_revision"
    || method === "tool_preflight") return controlFrameParams(value) ? null : `${method} params are invalid`;
  if (method === "continue_plan") {
    return controlFrameParams(value) && exactKeys(value, [
      "control_frame_sha256", "expected_route_sha256", "expected_plan_revision_sha256",
      "expected_stage_gate_sha256", "choice",
    ]) && sha256(value.expected_route_sha256) && sha256(value.expected_plan_revision_sha256)
      && sha256(value.expected_stage_gate_sha256)
      && (value.choice === "BUILD" || value.choice === "KEEP" || value.choice === "REVISE")
      ? null : "continue_plan params are invalid";
  }
  if (method === "define_shards") {
    return controlFrameParams(value) ? null : "define_shards params are invalid";
  }
  if (method === "tool_result") {
    return exactKeys(value, ["tool_call_id", "tool_name", "tool_input", "is_error", "text"], ["output_sha256"])
      && boundedText(value.tool_call_id, 256) && boundedText(value.tool_name, 256) && record(value.tool_input)
      && typeof value.is_error === "boolean" && boundedText(value.text, 1_048_576)
      && (value.output_sha256 === undefined || sha256(value.output_sha256)) ? null : "tool_result params are invalid";
  }
  if (method === "tool_end") {
    return exactKeys(value, ["tool_call_id", "is_error", "text"]) && boundedText(value.tool_call_id, 256)
      && typeof value.is_error === "boolean" && boundedText(value.text, 1_048_576) ? null : "tool_end params are invalid";
  }
  if (method === "attest") {
    return controlFrameParams(value) ? null : "attest params are invalid";
  }
  if (method === "complete") {
    return controlFrameParams(value) && exactKeys(value, ["control_frame_sha256"], ["outcome_evidence"])
      && outcomeEvidence(value.outcome_evidence) ? null : "complete params are invalid";
  }
  if (method === "reconcile") {
    return controlFrameParams(value) ? null : "reconcile params are invalid";
  }
  if (method === "control") {
    return exactKeys(value, ["action"], ["reason", "control_frame_sha256"])
      && ["pause", "resume", "cancel", "replan"].includes(String(value.action))
      && (value.reason === undefined || boundedText(value.reason, 131_072))
      && (value.control_frame_sha256 === undefined || sha256(value.control_frame_sha256)) ? null : "control params are invalid";
  }
  if (method === "compaction") {
    return exactKeys(value, ["phase"]) && (value.phase === "before" || value.phase === "after")
      ? null : "compaction params are invalid";
  }
  if (method === "clarify_selected") {
    return controlFrameParams(value) ? null : "clarify_selected params are invalid";
  }
  return "params are invalid";
}

function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function controlFrame(value: unknown): boolean {
  return record(value) && typeof value.control_frame_sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.control_frame_sha256);
}

function generation(value: unknown): value is GenerationGovernorSnapshot {
  if (!record(value)) return false;
  return value.schema_version === 1
    && ["CONTINUE", "NUDGE", "HALT_AUTOMATION", "WAIT_USER", "TERMINAL"].includes(String(value.decision))
    && typeof value.material_progress === "boolean" && typeof value.authority_progress === "boolean"
    && typeof value.evidence_progress === "boolean" && safeInteger(value.no_progress_turns)
    && safeInteger(value.provider_turns) && safeInteger(value.unique_evidence)
    && safeInteger(value.blocked_repeated_routes) && sha256(value.frontier_sha256)
    && nullableString(value.directive) && typeof value.reason_code === "string";
}

function presentationV2(value: unknown): value is HostPresentationV2 {
  if (!record(value) || !exactKeys(value, [
    "schema_version", "presentation_state_code", "attention", "primary_target",
    "authority_event_sequence", "lifecycle",
  ]) || value.schema_version !== 2
    || ![
      "DEFINING_GOAL", "PLANNING", "WAITING_FOR_YOU", "BUILDING", "VERIFYING", "PAUSED",
      "RECONCILING", "COMPLETED", "FAILED", "CANCELED",
    ].includes(String(value.presentation_state_code))
    || !["NONE", "ACTION_REQUIRED", "BLOCKING"].includes(String(value.attention))
    || ![
      "CONTRACT_REVIEW", "CLARIFICATION", "PLAN_CONTINUATION", "RECONCILE", "WORK", "VERIFY", "DELIVERABLE",
    ].includes(String(value.primary_target))
    || !safeInteger(value.authority_event_sequence, 1) || !record(value.lifecycle)
    || !exactKeys(value.lifecycle, ["revision", "current_stage", "steps"])
    || !safeInteger(value.lifecycle.revision, 1)
    || !["INTAKE", "CONTRACT", "PLAN", "BUILD", "VERIFY", "DELIVER"].includes(String(value.lifecycle.current_stage))
    || !Array.isArray(value.lifecycle.steps) || value.lifecycle.steps.length !== 6) return false;
  const expected = ["INTAKE", "CONTRACT", "PLAN", "BUILD", "VERIFY", "DELIVER"];
  return value.lifecycle.steps.every((step, index) => record(step) && exactKeys(step, ["code", "state"])
    && step.code === expected[index] && ["COMPLETE", "ACTIVE", "PENDING"].includes(String(step.state)));
}

function changedFileV2(value: unknown): value is HostChangedFileV2 {
  return record(value) && exactKeys(value, [
    "path", "change", "operation_id", "work_cell_id", "before_sha256", "after_sha256", "authority_event_sequence",
  ]) && boundedText(value.path, 4_096) && ["CREATED", "MODIFIED", "DELETED", "MOVED"].includes(String(value.change))
    && boundedText(value.operation_id, 256) && boundedText(value.work_cell_id, 256)
    && sha256(value.before_sha256) && (value.after_sha256 === null || sha256(value.after_sha256))
    && safeInteger(value.authority_event_sequence, 1);
}

function status(value: unknown): value is HostStatus {
  if (!record(value) || typeof value.active !== "boolean") return false;
  if (value.intent !== null && value.intent !== "PLAN" && value.intent !== "BUILD") return false;
  if (value.topology !== null && value.topology !== "SINGLE" && value.topology !== "MULTI") return false;
  if (value.flow !== null && (!record(value.flow) || typeof value.flow.goalId !== "string"
    || typeof value.flow.objective !== "string"
    || (value.flow.mode !== "PLAN" && value.flow.mode !== "BUILD") || typeof value.flow.phase !== "string"
    || !nullableString(value.flow.workCell) || typeof value.flow.routeHealth !== "string"
    || typeof value.flow.nextAction !== "string" || !nullableString(value.flow.blocker)
    || !Array.isArray(value.flow.unresolvedOperationIds) || value.flow.unresolvedOperationIds.length > 512
    || value.flow.unresolvedOperationIds.some((operationId) => !boundedText(operationId, 256)))) return false;
  if (value.harness !== null && (!record(value.harness) || typeof value.harness.runId !== "string"
    || typeof value.harness.status !== "string"
    || !["SINGLE", "MULTI"].includes(String(value.harness.requestedTopology))
    || !["SINGLE", "MULTI"].includes(String(value.harness.effectiveTopology))
    || !boundedText(value.harness.topologyReasonCode, 256)
    || !nullableString(value.harness.nextReadyShardId) || !Array.isArray(value.harness.shards)
    || value.harness.shards.some((shard) => !record(shard) || typeof shard.role !== "string" || typeof shard.status !== "string"))) return false;
  if (value.context !== null && (!record(value.context) || !nullableString(value.context.input_context_error)
    || !nullableString(value.context.memory_recall_error) || !nullableString(value.context.memory_capture_error)
    || typeof value.context.provider_turn_ledger_enabled !== "boolean")) return false;
  if (!record(value.cache) || typeof value.cache.configured !== "boolean" || typeof value.cache.enabled !== "boolean"
    || typeof value.cache.arm !== "string" || typeof value.cache.effective_arm !== "string"
    || !nullableString(value.cache.provider_integration) || typeof value.cache.reason !== "string") return false;
  if (!record(value.output) || typeof value.output.enabled !== "boolean" || typeof value.output.mode !== "string") return false;
  if (value.ui !== undefined && (!record(value.ui) || typeof value.ui.widget !== "boolean"
    || typeof value.ui.status !== "boolean" || !safeInteger(value.ui.debounce_ms, 50, 2_000)
    || !safeInteger(value.ui.max_widget_lines, 1, 6))) return false;
  if (value.open_clarifications !== undefined && (!Array.isArray(value.open_clarifications)
    || value.open_clarifications.length > 5 || value.open_clarifications.some((item) => !clarification(item)))) return false;
  if (!("decision_inbox" in value)
    || (value.decision_inbox !== null && !validateDecisionInboxProjectionV2(value.decision_inbox))) return false;
  if (value.generation_governor !== null && !generation(value.generation_governor)) return false;
  if (value.runtime !== null && !runtimeSelection(value.runtime)) return false;
  if (value.plan_review !== undefined && value.plan_review !== null
    && (!record(value.plan_review) || !exactKeys(value.plan_review, [
      "summary", "artifact_path", "route_sha256", "plan_revision_sha256", "stage_gate_sha256",
    ]) || typeof value.plan_review.summary !== "string"
      || typeof value.plan_review.artifact_path !== "string" || !sha256(value.plan_review.route_sha256)
      || !sha256(value.plan_review.plan_revision_sha256) || !sha256(value.plan_review.stage_gate_sha256))) return false;
  if (value.contract_review !== undefined && value.contract_review !== null
    && (!record(value.contract_review) || !exactKeys(value.contract_review, [
      "decision_requirement_revision_id", "requirement_revision_sha256", "decision_frontier_sha256",
      "contract_diff", "requirement_diff",
    ]) || !boundedText(value.contract_review.decision_requirement_revision_id, 160)
      || !sha256(value.contract_review.requirement_revision_sha256)
      || !sha256(value.contract_review.decision_frontier_sha256)
      || !record(value.contract_review.contract_diff) || !record(value.contract_review.requirement_diff))) return false;
  if (value.session_binding !== undefined && value.session_binding !== null
    && parseSessionGoalBindingMarker(value.session_binding) === null) return false;
  if (value.presentation !== undefined && value.presentation !== null && !presentationV2(value.presentation)) return false;
  if (value.current_work_cell !== undefined && value.current_work_cell !== null
    && (!record(value.current_work_cell) || !exactKeys(value.current_work_cell, ["work_cell_id", "title", "status", "revision"])
      || !boundedText(value.current_work_cell.work_cell_id, 256) || !boundedText(value.current_work_cell.title, 8_192)
      || !nullableString(value.current_work_cell.status) || !safeInteger(value.current_work_cell.revision, 1))) return false;
  if (value.changed_files !== undefined && (!Array.isArray(value.changed_files)
    || value.changed_files.length > 4_096 || value.changed_files.some((file) => !changedFileV2(file)))) return false;
  return (value.control_frame === null || controlFrame(value.control_frame)) && "execution_subject" in value;
}

function state(value: unknown): value is HostStateResult {
  return record(value) && typeof value.message === "string" && status(value.status);
}

function goalDiscovery(value: unknown): value is HostGoalDiscovery {
  if (!record(value) || !exactKeys(value, ["current_session_binding", "recoverable"])) return false;
  if (value.current_session_binding !== null && parseSessionGoalBindingMarker(value.current_session_binding) === null) return false;
  return Array.isArray(value.recoverable) && value.recoverable.length <= 1_024 && value.recoverable.every((candidate) =>
    record(candidate) && exactKeys(candidate, [
      "goal_id", "goal_title", "objective", "intent", "status", "next_action_code", "binding_state",
      "controller_session_id", "controller_live", "binding_receipt_sha256",
    ]) && boundedText(candidate.goal_id, 256) && boundedText(candidate.goal_title, 128)
      && boundedText(candidate.objective, 131_072)
      && ["PLAN_ONLY", "BUILD", "PLAN_THEN_BUILD"].includes(String(candidate.intent))
      && boundedText(candidate.status, 128) && boundedText(candidate.next_action_code, 128)
      && ["BOUND", "UNBOUND", "TERMINAL"].includes(String(candidate.binding_state))
      && nullableString(candidate.controller_session_id) && typeof candidate.controller_live === "boolean"
      && (candidate.binding_receipt_sha256 === null || sha256(candidate.binding_receipt_sha256)));
}

function workerStatus(value: unknown): value is HostWorkerStatus {
  return record(value) && typeof value.job_id === "string"
    && ["RUNNING", "SUCCEEDED", "FAILED", "ABORTED"].includes(String(value.state))
    && nullableString(value.error) && safeInteger(value.worker_count) && nonnegativeNumber(value.elapsed_ms)
    && "result" in value;
}

function validResult(kind: ResultKind, value: unknown): boolean {
  if (kind === "STATUS") return status(value);
  if (kind === "STOPPED") return record(value) && value.stopped === true;
  if (kind === "RUNTIME") return record(value) && exactKeys(value, ["runtime"]) && runtimeSelection(value.runtime);
  if (kind === "GOAL_DISCOVERY") return goalDiscovery(value);
  if (kind === "WORKER_STARTED") return record(value) && typeof value.job_id === "string" && value.state === "RUNNING"
    && Number.isSafeInteger(value.worker_count);
  if (kind === "WORKER_STATUS") return workerStatus(value);
  if (kind === "WORKER_ABORTED") return record(value) && typeof value.job_id === "string" && value.abort_requested === true;
  if (kind === "TURN_PROJECTION") return record(value) && typeof value.system_prompt === "string" && typeof value.changed === "boolean"
    && typeof value.context_projection_active === "boolean" && typeof value.mode === "string" && typeof value.fit_disposition === "string"
    && nullableString(value.fallback) && typeof value.memory_projected === "boolean" && sha256(value.subject_binding_sha256)
    && controlFrame(value.control_frame) && generation(value.generation_governor);
  if (kind === "CONTEXT_PROJECTION") return record(value) && typeof value.changed === "boolean" && Array.isArray(value.overlays)
    && value.overlays.every((entry) => record(entry) && Number.isSafeInteger(entry.insertionIndex) && "message" in entry)
    && safeInteger(value.projectedSegmentCount) && safeInteger(value.removedPersistedHarnessMessages)
    && typeof value.fallback === "string" && record(value.projection_ack) && typeof value.projection_ack.accepted === "boolean"
    && typeof value.projection_ack.reconcile_required === "boolean" && sha256(value.projection_ack.sequence_root)
    && safeInteger(value.projection_ack.count);
  if (kind === "CONTEXT_RESPONSE") return record(value) && ["OK", "NO_ACTIVE_WORKING_SET", "CURSOR_INVALID", "SELECTION_INVALID"].includes(String(value.status))
    && Array.isArray(value.items) && nullableString(value.continuation) && (value.fallback === "NONE" || value.fallback === "NORMAL_READ_SEARCH");
  if (kind === "PROVIDER_BEGIN") return record(value) && typeof value.recorded === "boolean" && nullableString(value.cache_request_id);
  if (kind === "PROVIDER_SETTLE") return record(value)
    && (value.ledger_sha256 === null || sha256(value.ledger_sha256)) && "cache" in value;
  if (kind === "GENERATION") return generation(value);
  if (kind === "MESSAGE") return record(value) && typeof value.message === "string";
  if (kind === "OBSERVED") return record(value) && value.observed === true;
  if (kind === "STATE") return state(value);
  if (kind === "SHARDS") return record(value) && record(value.harness) && status(value.status);
  if (kind === "TOOL_PREFLIGHT") return record(value) && typeof value.allow === "boolean" && typeof value.managed === "boolean"
    && typeof value.capture === "boolean" && nullableString(value.reason)
    && (value.control_frame === undefined || controlFrame(value.control_frame));
  if (kind === "TOOL_RESULT") return record(value) && nullableString(value.operation_id) && controlFrame(value.control_frame);
  if (kind === "TOOL_END") return record(value) && status(value.status) && controlFrame(value.control_frame);
  return record(value) && ((boundedText(value.checkpoint_sha256, 256)) !== (value.verified === true));
}

function protocolError(code: "HOST_METHOD_UNKNOWN" | "HOST_PARAMS_INVALID" | "HOST_RESULT_INVALID", message: string): Error {
  return Object.assign(new TypeError(message), { code });
}

export function parseHostApplicationRequest(method: string, params: unknown): HostApplicationRequest {
  if (!Object.prototype.hasOwnProperty.call(HOST_APPLICATION_PROTOCOL, method)) {
    throw protocolError("HOST_METHOD_UNKNOWN", `Unknown Coding Harness Host method: ${method}`);
  }
  const typedMethod = method as HostMethod;
  const kind = HOST_APPLICATION_PROTOCOL[typedMethod].params;
  const valid = kind === "NULL" ? params === null : kind === "RECORD" ? record(params) : params === null || record(params);
  if (!valid) throw protocolError("HOST_PARAMS_INVALID", `Invalid Coding Harness Host params: ${method}`);
  const detail = paramsError(typedMethod, params);
  if (detail !== null) throw protocolError("HOST_PARAMS_INVALID", `Invalid Coding Harness Host params: ${method}: ${detail}`);
  return { method: typedMethod, params } as HostApplicationRequest;
}

export function validateHostApplicationResult<M extends HostMethod>(method: M, value: unknown): HostResult<M> {
  if (!validResult(HOST_APPLICATION_PROTOCOL[method].result, value)) {
    throw protocolError("HOST_RESULT_INVALID", `Invalid Coding Harness Host result: ${method}`);
  }
  return value as HostResult<M>;
}

export interface HostApplicationTransport {
  request<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs?: number): Promise<unknown>;
}

export async function requestHostApplication<M extends HostMethod>(
  transport: HostApplicationTransport,
  method: M,
  params: HostParams<M>,
  timeoutMs?: number,
): Promise<HostResult<M>> {
  parseHostApplicationRequest(method, params);
  const result = await transport.request(method, params, timeoutMs);
  return validateHostApplicationResult(method, result);
}
