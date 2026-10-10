import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import type {
  HostEnterParams, HostProviderHistorySummary, HostRuntimeSelection, HostStatus, HostStateResult,
  HostTurnProjectionResult,
} from "../harness/host/application-protocol.js";
import type { ChatMessage, ChatModel, ChatTool, ModelToolCall, ModelTurn } from "./provider.js";
import { executeControlledTool, type ToolHost } from "./tools.js";

export type SingleRunStatus = "COMPLETED" | "WAIT_USER" | "STOPPED";

export interface SingleRunResult {
  readonly status: SingleRunStatus;
  readonly reason: string;
  readonly hostStatus: HostStatus;
  readonly messages: readonly ChatMessage[];
  readonly turns: number;
}

export interface SingleRunOptions {
  readonly host: ToolHost;
  readonly model: ChatModel;
  readonly cwd: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly intent: "PLAN" | "BUILD";
  readonly runtime: HostRuntimeSelection;
  readonly recoverGoalId?: string;
  readonly initialMessages?: readonly ChatMessage[];
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  readonly credentialEnvName?: string;
  readonly approveContract?: (review: NonNullable<HostStatus["contract_review"]>) => Promise<{
    readonly action: "APPROVE" | "REJECT"; readonly feedback?: string;
  } | null>;
  readonly choosePlan?: (review: NonNullable<HostStatus["plan_review"]>) => Promise<"BUILD" | "KEEP" | "REVISE" | null>;
  readonly chooseClarification?: (question: NonNullable<HostStatus["open_clarifications"]>[number]) => Promise<string | null>;
  readonly saveMessages?: (messages: readonly ChatMessage[], status: HostStatus) => void | Promise<void>;
  readonly onStatus?: (status: HostStatus) => void;
  readonly onAssistantText?: (text: string) => void;
}

const prompt = "You are PCH Single. Follow the current Host workflow prompt and next action. "
  + "Only Host tools can authorize effects; USER reviews and choices are never yours to approve. "
  + "Search before reading exact ranges; use edit for existing files and write only for new files. "
  + "Run the frozen local oracle and review preservation outcomes before completing. "
  + "Do not repeat a tool call or claim completion from prose alone.";

const codingFlow: ChatTool = {
  type: "function",
  function: {
    name: "coding_flow",
    description: "Advance only the Host-authorized next action. Contract and Route proposals are locally validated; complete only after fresh evidence.",
    parameters: {
      type: "object", required: ["action"], additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["submit_contract", "submit_route", "submit_route_revision", "attest", "complete", "reconcile"] },
        contract: { type: "object" }, route: { type: "object" }, patch: { type: "object" },
        operation_id: { type: "string" }, obligation_keys: { type: "array", items: { type: "string" } },
        outcome_evidence: { type: "array", items: { type: "object" } },
      },
    },
  },
};

const readTools: readonly ChatTool[] = [
  { type: "function", function: { name: "find", description: "List bounded file paths under a workspace-relative path.",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "ls", description: "List up to 200 entries in a workspace-relative directory.",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "grep", description: "Search text in a workspace-relative path with bounded output.",
    parameters: { type: "object", required: ["path", "pattern"], properties: {
      path: { type: "string" }, pattern: { type: "string" },
    }, additionalProperties: false } } },
  { type: "function", function: { name: "read", description: "Read an exact line range from a workspace-relative file.",
    parameters: { type: "object", required: ["path"], properties: {
      path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
    }, additionalProperties: false } } },
];

const writeTools: readonly ChatTool[] = [
  { type: "function", function: { name: "write", description: "Create one new file only, after Host authorization.",
    parameters: { type: "object", required: ["path", "content"], properties: {
      path: { type: "string" }, content: { type: "string" },
    }, additionalProperties: false } } },
  { type: "function", function: { name: "edit", description: "Replace one unique exact oldText in an existing file, after Host authorization.",
    parameters: { type: "object", required: ["path", "oldText", "newText"], properties: {
      path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
    }, additionalProperties: false } } },
  { type: "function", function: { name: "bash", description: "Run only Host-classified local probes, validation or bounded formatter commands.",
    parameters: { type: "object", required: ["command"], properties: {
      command: { type: "string" }, timeout: { type: "integer" },
    }, additionalProperties: false } } },
];

function toolsFor(status: HostStatus): readonly ChatTool[] {
  const next = status.flow?.nextAction;
  if (next === "RECONCILE_OPERATION") return [codingFlow];
  if (next === "EXECUTE_WORK" || next === "VALIDATE_WORK" || next === "COMPLETE_WORK") {
    return [codingFlow, ...readTools, ...writeTools];
  }
  return [codingFlow, ...readTools];
}

function terminal(status: HostStatus): boolean {
  return status.flow?.nextAction === "NONE" || ["SUCCEEDED", "FAILED", "CANCELED"].includes(status.flow?.phase ?? "");
}

function currentFrame(status: HostStatus): string {
  const value = status.control_frame?.control_frame_sha256;
  if (!value) throw new TypeError("Host has no current ControlFrame");
  return value;
}

function objectField(input: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  const value = input[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function compactState(status: HostStatus): string {
  const flow = status.flow;
  return flow ? `next=${flow.nextAction} phase=${flow.phase}${flow.blocker ? ` blocker=${flow.blocker}` : ""}` : "Host inactive";
}

function historySummary(messages: readonly ChatMessage[]): HostProviderHistorySummary {
  const totals = { user: 0, assistant: 0, other: 0 };
  const descriptors = messages.map((message) => {
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (message.role === "user") totals.user += bytes;
    else if (message.role === "assistant") totals.assistant += bytes;
    else totals.other += bytes;
    return { role: message.role, bytes, sha256: canonicalJsonSha256(message) };
  });
  return {
    descriptor_root_sha256: canonicalJsonSha256(descriptors), message_count: messages.length,
    logical_bytes: totals.user + totals.assistant + totals.other,
    user_bytes: totals.user, assistant_bytes: totals.assistant, other_bytes: totals.other,
  };
}

function outputForModel(text: string, workflowPrompt: string | null, status: HostStatus): string {
  const full = `${text}\n${compactState(status)}${workflowPrompt ? `\n${workflowPrompt}` : ""}`;
  return Buffer.byteLength(full, "utf8") <= 32_768 ? full : `${full.slice(0, 32_768)}\n[PCH model view truncated]`;
}

function missingTrailingToolResults(messages: readonly ChatMessage[]): readonly string[] {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") { assistantIndex = index; break; }
  }
  if (assistantIndex < 0) return [];
  const assistant = messages[assistantIndex];
  if (!assistant || assistant.role !== "assistant" || !assistant.tool_calls?.length) return [];
  const completed = new Set(messages.slice(assistantIndex + 1).flatMap((message) => message.role === "tool"
    ? [message.tool_call_id] : []));
  return assistant.tool_calls.map((call) => call.id).filter((id) => !completed.has(id));
}

async function flowCall(host: ToolHost, call: ModelToolCall, status: HostStatus, frame: string): Promise<{
  readonly text: string; readonly status: HostStatus; readonly workflowPrompt: string | null;
}> {
  const input = call.arguments;
  const action = input.action;
  if (typeof action !== "string") throw new TypeError("coding_flow action is required");
  let method: string;
  let params: Readonly<Record<string, unknown>>;
  if (action === "submit_contract") { method = "submit_contract"; params = { ...objectField(input, "contract"), control_frame_sha256: frame }; }
  else if (action === "submit_route") { method = "submit_route"; params = { ...objectField(input, "route"), control_frame_sha256: frame }; }
  else if (action === "submit_route_revision") { method = "submit_route_revision"; params = { ...objectField(input, "patch"), control_frame_sha256: frame }; }
  else if (action === "attest") {
    if (typeof input.operation_id !== "string") throw new TypeError("attest requires operation_id");
    method = "attest"; params = { control_frame_sha256: frame, operation_id: input.operation_id,
      ...(input.obligation_keys === undefined ? {} : { obligation_keys: input.obligation_keys }) };
  } else if (action === "complete") {
    method = "complete"; params = { control_frame_sha256: frame,
      ...(input.outcome_evidence === undefined ? {} : { outcome_evidence: input.outcome_evidence }) };
  } else if (action === "reconcile") {
    method = "reconcile"; params = { control_frame_sha256: frame,
      ...(input.operation_id === undefined ? {} : { operation_id: input.operation_id }) };
  } else throw new TypeError(`Unsupported coding_flow action: ${action}`);
  const result = await host.request(method, params) as HostStateResult;
  return { text: result.message, status: result.status, workflowPrompt: result.workflow_prompt ?? null };
}

async function settleProvider(host: ToolHost, begin: {
  readonly provider_attempt_id: string | null; readonly cache_request_id: string | null;
}, turn: ModelTurn | null, started: number): Promise<void> {
  await host.request("provider_settle", {
    provider_attempt_id: begin.provider_attempt_id,
    cache_request_id: begin.cache_request_id,
    usage: turn?.usage ?? null,
    response_status: null,
    latency_ms: Math.round(performance.now() - started),
    outcome: turn ? "RESPONDED" : "OUTCOME_UNKNOWN",
    assistant_text_bytes: turn ? Buffer.byteLength(turn.text, "utf8") : 0,
    tool_argument_bytes: turn ? turn.toolCalls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments), "utf8"), 0) : 0,
  });
}

async function pendingUserChoice(options: SingleRunOptions, status: HostStatus): Promise<HostStatus | null> {
  const review = status.contract_review;
  if (review) {
    const decision = await options.approveContract?.(review) ?? null;
    if (!decision) return null;
    const result = await options.host.request("resolve_contract_review", {
      expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
      expected_requirement_revision_sha256: review.requirement_revision_sha256,
      expected_decision_frontier_sha256: review.decision_frontier_sha256,
      action: decision.action,
      selected_value: decision.action === "APPROVE" ? true : decision.feedback ?? false,
    }) as HostStateResult;
    return result.status;
  }
  if (status.flow?.nextAction === "PLAN_CONTINUATION" && status.plan_review) {
    const choice = await options.choosePlan?.(status.plan_review) ?? null;
    if (!choice) return null;
    const review = status.plan_review;
    const result = await options.host.request("continue_plan", {
      control_frame_sha256: currentFrame(status),
      expected_route_sha256: review.route_sha256,
      expected_plan_revision_sha256: review.plan_revision_sha256,
      expected_stage_gate_sha256: review.stage_gate_sha256,
      choice,
    }) as HostStateResult;
    return result.status;
  }
  const clarifications = status.open_clarifications ?? [];
  if (clarifications.length > 0) {
    if (!options.chooseClarification) return null;
    const selections = [];
    for (const question of clarifications) {
      const selectedOptionId = await options.chooseClarification(question);
      if (!selectedOptionId) return null;
      selections.push({ ...question, selectedOptionId });
    }
    const result = await options.host.request("clarify_selected", {
      control_frame_sha256: currentFrame(status), decisions: selections,
    }) as HostStateResult;
    return result.status;
  }
  return status;
}

export async function runSingle(options: SingleRunOptions): Promise<SingleRunResult> {
  const entry: HostEnterParams = options.recoverGoalId ? {
    entry_mode: "RECOVER", cwd: options.cwd, session_id: options.sessionId,
    goal_id: options.recoverGoalId, allow_transfer: false, runtime: options.runtime,
  } : {
    entry_mode: "NEW", cwd: options.cwd, session_id: options.sessionId,
    objective: options.objective, intent: options.intent, topology: "SINGLE", runtime: options.runtime,
  };
  let status = await options.host.request("enter", entry) as HostStatus;
  const messages: ChatMessage[] = [...(options.initialMessages ?? [])];
  const result = (state: SingleRunStatus, reason: string, turns: number): SingleRunResult => ({
    status: state, reason, hostStatus: status, messages, turns,
  });
  options.onStatus?.(status);
  if (status.contract_review && !options.approveContract) return result("WAIT_USER", "Goal Contract review requires a user decision", 0);
  let projected = false;
  let turns = 0;
  const finish = async (state: SingleRunStatus, reason: string, count: number): Promise<SingleRunResult> => {
    if (projected) {
      await options.host.request("generation_settled", null);
      projected = false;
    }
    status = await options.host.request("status", null) as HostStatus;
    return terminal(status) ? result("COMPLETED", "Host Goal is terminal", count) : result(state, reason, count);
  };
  try {
    const systemPromptSha256 = sha256Hex(prompt);
    const projection = await options.host.request("turn_projection", {
      agent_run_id: `AGENT-RUN-${randomUUID()}`,
      system_prompt_sha256: systemPromptSha256, system_prompt: prompt,
      current_input_tokens: null,
      active_tools: ["coding_flow", ...readTools.map((tool) => tool.function.name), ...writeTools.map((tool) => tool.function.name)],
      all_tools: ["coding_flow", ...readTools.map((tool) => tool.function.name), ...writeTools.map((tool) => tool.function.name)],
    }) as HostTurnProjectionResult;
    projected = true;
    if (messages.length === 0) {
      messages.push({ role: "system", content: projection.system_prompt }, { role: "user", content: options.objective });
    } else {
      if (messages[0]?.role !== "system") throw new TypeError("Saved conversation lacks a system message");
      messages[0] = { role: "system", content: projection.system_prompt };
    }
    await options.saveMessages?.(messages, status);
    for (; turns < (options.maxTurns ?? 24); turns += 1) {
      if (options.signal?.aborted) return await finish("STOPPED", "Run canceled; pending effects require Host inspection", turns);
      status = await options.host.request("status", null) as HostStatus;
      if (terminal(status)) return await finish("COMPLETED", "Host Goal is terminal", turns);
      if (status.flow?.unresolvedOperationIds.length) {
        const reconciled = await options.host.request("reconcile", {
          control_frame_sha256: currentFrame(status),
        }) as HostStateResult;
        status = reconciled.status;
        if (status.flow?.unresolvedOperationIds.length) {
          return await finish("STOPPED", "An operation outcome remains unknown; review Host reconciliation before continuing", turns);
        }
      }
      for (const toolCallId of missingTrailingToolResults(messages)) {
        messages.push({ role: "tool", tool_call_id: toolCallId,
          content: "ERROR: This tool result was lost during interruption. Host effects were inspected; do not replay the call. Re-read current workspace evidence before proceeding." });
        await options.saveMessages?.(messages, status);
      }
      const afterChoice = await pendingUserChoice(options, status);
      if (!afterChoice) return await finish("WAIT_USER", "A review or clarification requires a user decision", turns);
      status = afterChoice;
      options.onStatus?.(status);
      if (terminal(status)) return await finish("COMPLETED", "Host Goal is terminal", turns);
      if (status.decision_inbox?.pending.length && status.decision_inbox.pending.some((item) => item.kind !== "CONTRACT_REVIEW")) {
        return await finish("WAIT_USER", "Host decision inbox requires user attention", turns);
      }
      const tools = toolsFor(status);
      const began = await options.host.request("provider_begin", {
        payload_shape_sha256: canonicalJsonSha256({ model: options.runtime.model, messages, tools }),
        history: historySummary(messages), tool_schema_bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
      }) as { readonly provider_attempt_id: string | null; readonly cache_request_id: string | null };
      const started = performance.now();
      let turn: ModelTurn;
      try { turn = await options.model.turn(messages, tools, options.signal); }
      catch (error) {
        await settleProvider(options.host, began, null, started);
        throw error;
      }
      await settleProvider(options.host, began, turn, started);
      const assistant: ChatMessage = {
        role: "assistant", content: turn.text || null,
        ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map((call) => ({
          id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}),
      };
      messages.push(assistant);
      await options.saveMessages?.(messages, status);
      if (turn.text.trim()) options.onAssistantText?.(turn.text);
      if (turn.toolCalls.length === 0) {
        await options.host.request("generation_turn", { turn_index: turns });
        status = await options.host.request("status", null) as HostStatus;
        return await finish("STOPPED", `Agent stopped before Host completion: ${compactState(status)}`, turns + 1);
      }
      const seen = new Set(messages.slice(0, -1).flatMap((message) => message.role === "assistant"
        ? (message.tool_calls ?? []).map((call) => call.id) : []));
      let frame = currentFrame(status);
      let userDecisionPending = false;
      for (const call of turn.toolCalls) {
        if (seen.has(call.id)) throw new TypeError(`Repeated provider tool ID ${call.id}; effect was not replayed`);
        seen.add(call.id);
        let text: string;
        let isError = false;
        if (userDecisionPending) {
          isError = true;
          text = "Skipped because an explicit user decision is pending; no effect was dispatched.";
        } else if (call.name === "coding_flow") {
          try {
            const value = await flowCall(options.host, call, status, frame);
            status = value.status;
            frame = currentFrame(status);
            text = outputForModel(value.text, value.workflowPrompt, status);
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
            if (!(error instanceof TypeError) && code !== "HOST_METHOD_FAILED") throw error;
            isError = true;
            text = error instanceof Error ? error.message : String(error);
          }
        } else {
          const value = await executeControlledTool({
            host: options.host, cwd: options.cwd, controlFrameSha256: frame, call,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.credentialEnvName === undefined ? {} : { credentialEnvName: options.credentialEnvName }),
          });
          frame = value.controlFrameSha256;
          if (value.status) status = value.status;
          isError = value.isError;
          text = outputForModel(value.text, value.workflowPrompt, status);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: isError ? `ERROR: ${text}` : text });
        await options.saveMessages?.(messages, status);
        options.onStatus?.(status);
        if (status.contract_review || status.flow?.nextAction === "PLAN_CONTINUATION") userDecisionPending = true;
      }
      const governor = await options.host.request("generation_turn", { turn_index: turns }) as {
        readonly decision: string; readonly directive: string | null;
      };
      if (governor.decision === "HALT_AUTOMATION") {
        return await finish("STOPPED", governor.directive ?? "Host stopped a no-progress route", turns + 1);
      }
      if (governor.decision === "TERMINAL" || terminal(status)) {
        return await finish("COMPLETED", "Host Goal is terminal", turns + 1);
      }
      if (governor.decision === "WAIT_USER"
        && !(status.contract_review && options.approveContract)
        && !(status.flow?.nextAction === "PLAN_CONTINUATION" && options.choosePlan)
        && !((status.open_clarifications?.length ?? 0) > 0 && options.chooseClarification)) {
        return await finish("WAIT_USER", "Host requires a user decision", turns + 1);
      }
      if (governor.directive) {
        messages.push({ role: "user", content: governor.directive });
        await options.saveMessages?.(messages, status);
      }
    }
    return await finish("STOPPED", "Bounded model turn limit reached", turns);
  } finally {
    if (projected) {
      await options.host.request("generation_settled", null).catch(() => undefined);
    }
  }
}
