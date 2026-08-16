import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnCodingHarnessHost, type HostRpcClient, type SpawnHostOptions } from "../harness/host/client.js";
import type { HostGoalDiscovery, HostStatus } from "../harness/host/application-protocol.js";
import {
  parseSessionGoalBindingMarker,
  SESSION_GOAL_BINDING_CUSTOM_TYPE,
  type SessionGoalBindingMarkerV1,
} from "../task-flow/session-binding.js";
import { sha256Hex } from "../foundation/crypto.js";
import {
  applyContextProjection, stripOwnedProviderContextMessages,
} from "../input-context/pi-context-projector.js";
import { retainedContextDescriptor, type RetainedContextDescriptor } from "../input-context/retained-ledger.js";
import { ProjectionDeltaLedger, type ContextProjectionDelta } from "../input-context/projection-delta.js";
import { registerMemoryCommands } from "../memory/commands.js";
import {
  generationGovernorMessageType, type GenerationGovernorSnapshot,
} from "../control/generation-governor.js";

const harnessTools = ["coding_flow", "coding_clarify", "coding_delegate", "coding_context"] as const;
const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface HostClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodingHarnessBridgeOptions {
  readonly packageRoot?: string;
  readonly configPath?: string;
  readonly hostEntryPath?: string;
  readonly dataRoot?: string;
  readonly spawnHost?: (options: SpawnHostOptions) => HostClient;
}

interface ActiveBridge {
  readonly client: HostClient;
  readonly cwd: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly sentSystemPrompts: Set<string>;
  readonly providerLifecycleEnabled: boolean;
  readonly managedToolCalls: Set<string>;
  readonly captureToolCalls: Set<string>;
  readonly projectionLedger: ProjectionDeltaLedger;
  readonly messageDescriptors: WeakMap<object, CompactMessageDescriptor>;
  contextProjectionActive: boolean;
  contextRecoveryScanRequired: boolean;
  hasContextOverlays: boolean;
  cacheStartedAt: number | null;
  cacheResponseStatus: number | null;
  providerTurnStarted: boolean;
  providerBegin: Promise<{
    readonly recorded: boolean;
    readonly provider_attempt_id: string | null;
    readonly cache_request_id: string | null;
  } | null> | null;
  providerTail: Promise<void>;
  toolObservationTail: Promise<void>;
  activeInputCaptureTail: Promise<void>;
  providerHistory: ProviderHistorySummary;
  toolSchemaBytes: number;
  lastStatusText: string | null;
  pendingStatusProjection: { readonly text: string; readonly widgetLines: readonly string[] } | null;
  statusProjectionTimer: ReturnType<typeof setTimeout> | null;
  ui: NonNullable<HostStatus["ui"]>;
  turnControlFrameSha256: string | null;
  agentRunSequence: number;
  governorDirective: string | null;
  governorMessage: Readonly<Record<string, unknown>> | null;
  governorDecision: GenerationGovernorSnapshot["decision"];
  runtime: RuntimeSelection;
  readonly pendingClarifications: Map<string, BridgeClarificationDecision>;
  lastBindingReceiptSha256: string | null;
}

interface BridgeClarificationDecision {
  readonly id: string;
  readonly question: string;
  readonly whyItMatters: string;
  readonly changeKind: "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE";
  readonly materiality: "LOW" | "MEDIUM" | "HIGH";
  readonly reversible: boolean;
  readonly privacyRelated: boolean;
  readonly options: readonly { readonly id: string; readonly label: string; readonly impact: string }[];
  readonly recommendedOptionId: string;
  readonly recommendationReason: string;
  readonly dependsOnDecisionIds: readonly string[];
}

interface ProviderHistorySummary {
  readonly descriptor_root_sha256: string;
  readonly message_count: number;
  readonly logical_bytes: number;
  readonly user_bytes: number;
  readonly assistant_bytes: number;
  readonly other_bytes: number;
}

interface RuntimeSelection {
  readonly provider: string;
  readonly api: string;
  readonly base_url?: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
}

const emptyProviderHistory: ProviderHistorySummary = {
  descriptor_root_sha256: sha256Hex("PCH-PROVIDER-HISTORY-V2:EMPTY"),
  message_count: 0, logical_bytes: 0, user_bytes: 0, assistant_bytes: 0, other_bytes: 0,
};

interface CompactMessageDescriptor extends RetainedContextDescriptor { readonly logicalBytes: number }

function serializedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); }
  catch { return 0; }
}

function compactMessageDescriptor(message: unknown, descriptor?: RetainedContextDescriptor): CompactMessageDescriptor {
  return { ...(descriptor ?? retainedContextDescriptor(message)), logicalBytes: serializedBytes(message) };
}

function cachedMessageDescriptor(message: unknown, cache: WeakMap<object, CompactMessageDescriptor>): CompactMessageDescriptor {
  if (typeof message !== "object" || message === null) return compactMessageDescriptor(message);
  const cached = cache.get(message);
  if (cached) return cached;
  const descriptor = compactMessageDescriptor(message);
  cache.set(message, descriptor);
  return descriptor;
}

function transportDelta(delta: ContextProjectionDelta): Readonly<Record<string, unknown>> {
  return {
    schema_version: delta.schema_version, lineage_id: delta.lineage_id,
    previous_sequence_root: delta.previous_sequence_root, previous_count: delta.previous_count,
    append: delta.append.map((descriptor) => ({
      content_sha256: descriptor.contentSha256, role: descriptor.role, custom_type: descriptor.customType,
    })),
    new_sequence_root: delta.new_sequence_root, new_count: delta.new_count,
    full_reconcile: delta.full_reconcile,
  };
}

function summarizeDescriptors(descriptors: readonly CompactMessageDescriptor[]): ProviderHistorySummary {
  let logicalBytes = 0; let userBytes = 0; let assistantBytes = 0; let otherBytes = 0;
  for (const descriptor of descriptors) {
    logicalBytes += descriptor.logicalBytes;
    if (descriptor.role === "user") userBytes += descriptor.logicalBytes;
    else if (descriptor.role === "assistant") assistantBytes += descriptor.logicalBytes;
    else otherBytes += descriptor.logicalBytes;
  }
  return {
    descriptor_root_sha256: sha256Hex(JSON.stringify(descriptors.map((entry) => ({
      sha256: entry.contentSha256, role: entry.role, customType: entry.customType, bytes: entry.logicalBytes,
    })))),
    message_count: descriptors.length, logical_bytes: logicalBytes,
    user_bytes: userBytes, assistant_bytes: assistantBytes, other_bytes: otherBytes,
  };
}

function payloadShapeSha256(payload: unknown): string {
  const seen = new WeakSet<object>();
  const shape = (value: unknown, depth = 0): unknown => {
    if (value === null) return "null";
    if (Array.isArray(value)) return { type: "array", length: value.length };
    if (typeof value !== "object") return typeof value;
    if (seen.has(value)) return "cycle";
    seen.add(value);
    if (depth >= 2) return "object";
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, 256);
    return { type: "object", keys: keys.map((key) => [key, shape((value as Record<string, unknown>)[key], depth + 1)]) };
  };
  return sha256Hex(JSON.stringify(shape(payload)));
}

function assistantOutputBytes(message: unknown): { readonly text: number; readonly toolArguments: number } {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return { text: 0, toolArguments: 0 };
  const row = message as Record<string, unknown>;
  if (typeof row.content === "string") return { text: Buffer.byteLength(row.content, "utf8"), toolArguments: 0 };
  if (!Array.isArray(row.content)) return { text: 0, toolArguments: 0 };
  let textBytes = 0; let toolArgumentBytes = 0;
  for (const item of row.content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const content = item as Record<string, unknown>;
    if (content.type === "text" && typeof content.text === "string") textBytes += Buffer.byteLength(content.text, "utf8");
    if (content.type === "toolCall" || content.type === "tool_call") {
      toolArgumentBytes += serializedBytes(content.arguments ?? content.input ?? content.args ?? null);
    }
  }
  return { text: textBytes, toolArguments: toolArgumentBytes };
}

function makeGovernorMessage(directive: string | null): Readonly<Record<string, unknown>> | null {
  if (!directive) return null;
  return {
    role: "custom", customType: generationGovernorMessageType, content: directive,
    display: false, timestamp: Date.now(),
    details: { persistence: "EPHEMERAL_PROVIDER_CONTEXT", source: "PCH_GENERATION_GOVERNOR_V1" },
  };
}

function governorOverlay(message: Readonly<Record<string, unknown>> | null, insertionIndex: number): readonly { insertionIndex: number; message: unknown }[] {
  return message ? [{ insertionIndex, message }] : [];
}

function compactStatus(status: HostStatus): string {
  if (!status.active || !status.flow) return "Coding Harness inactive";
  const title = status.session_binding?.goal_title ?? status.flow.objective.split(/\r?\n/u, 1)[0]!.slice(0, 96);
  const state = status.presentation?.presentation_state_code ?? "AUTHORITY_UNAVAILABLE";
  const attention = status.presentation?.attention && status.presentation.attention !== "NONE"
    ? ` attention=${status.presentation.attention}` : "";
  const blocker = status.flow.blocker ? ` blocker=${status.flow.blocker}` : "";
  return `Coding Harness ${state} goal=${JSON.stringify(title)}${attention}${blocker}`;
}

function headlessClarificationChoices(bridge: ActiveBridge): string {
  return [...bridge.pendingClarifications.values()].map((decision) =>
    `${decision.id}=<${decision.options.map((option) => option.id).join("|")}>`).join(", ");
}

function clarificationLabels(decision: BridgeClarificationDecision): string[] {
  return decision.options.map((option) => option.id === decision.recommendedOptionId
    ? `[Recommended] ${option.label} - ${option.impact}` : `${option.label} - ${option.impact}`);
}

function statusWidgetLines(status: HostStatus): readonly string[] {
  if (!status.active || !status.flow) return ["Coding Harness inactive"];
  const title = status.session_binding?.goal_title ?? status.flow.objective.split(/\r?\n/u, 1)[0]!.slice(0, 96);
  const presentation = status.presentation;
  const currentWork = status.current_work_cell?.title ?? "No current work cell";
  if (!presentation) return [`Goal: ${title}`, "Authority projection unavailable"];
  const attention = presentation.attention === "NONE" ? presentation.primary_target
    : `${presentation.attention} · ${presentation.primary_target}`;
  const execution = status.decision_inbox?.evidence;
  return [
    `Goal: ${title}`,
    `${presentation.presentation_state_code} · ${presentation.lifecycle.current_stage} r${presentation.lifecycle.revision}`,
    `Current: ${currentWork}`,
    ...(status.flow.blocker ? [`Blocker: ${status.flow.blocker}`]
      : status.decision_inbox?.pending.length ? [`${attention} · ${status.decision_inbox.pending.length} pending`]
        : execution?.execution_status ? [`${attention} · ${execution.execution_status}`]
          : [`Next: ${presentation.primary_target}`]),
  ];
}

function accepted(text: string) {
  return { content: [{ type: "text" as const, text }], details: { status: "SUCCEEDED" as const, reason: null } };
}

function rejected(code: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `${code}: ${message}` }], details: { status: "REJECTED" as const, reason: message } };
}

function resultMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const row = value as { message?: unknown; status?: unknown };
  const message = typeof row.message === "string" ? row.message : "Coding Harness transition accepted.";
  if (!row.status || typeof row.status !== "object") return message;
  const status = row.status as HostStatus;
  if (!status.active || !status.flow) return message === "Coding Harness transition accepted." ? "Coding Harness inactive" : message;
  const hints = [
    ...(message.includes(`next=${status.flow.nextAction}`) ? [] : [`next=${status.flow.nextAction}`]),
    ...(!["H0_CONTINUE", "HEALTHY"].includes(status.flow.routeHealth) ? [`health=${status.flow.routeHealth}`] : []),
    ...(status.harness?.nextReadyShardId ? [`ready=${status.harness.nextReadyShardId}`] : []),
    ...(status.flow.blocker ? [`blocker=${status.flow.blocker}`] : []),
  ];
  if (message === "Coding Harness transition accepted.") return hints.join(" ") || message;
  return hints.length > 0 ? `${message}\n${hints.join(" ")}` : message;
}

function resultText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  const value = content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
  return value || "[non-text tool result]";
}

function boundedResult(content: readonly { readonly type: string; readonly text?: string }[]): { readonly text: string; readonly sha256: string } {
  const full = resultText(content);
  const sha256 = sha256Hex(full);
  const bytes = Buffer.from(full, "utf8");
  if (bytes.byteLength <= 262_144) return { text: full, sha256 };
  return {
    text: `${bytes.subarray(0, 262_144).toString("utf8")}\n[PCH tool result truncated for IPC; full_sha256=${sha256}]`,
    sha256,
  };
}

function runtimeSelection(pi: ExtensionAPI, ctx: ExtensionContext): RuntimeSelection {
  if (!ctx.model) throw new TypeError("Select a Pi model before entering Coding Harness");
  return {
    provider: ctx.model.provider,
    api: "api" in ctx.model && typeof ctx.model.api === "string" ? ctx.model.api : "unconfigured",
    base_url: "baseUrl" in ctx.model && typeof ctx.model.baseUrl === "string" ? ctx.model.baseUrl : "unconfigured",
    model: ctx.model.id,
    thinking_level: ctx.thinkingLevel ?? pi.getThinkingLevel(),
    context_window: ctx.model.contextWindow,
  };
}

type CodingCommandAction = "status" | "cache" | "continue" | "review" | "clarify" | "pause" | "resume" | "cancel" | "replan" | "rename" | "exit";
type CodingEntryMode = "HUB" | "NEW" | "RECOVER";

function parseCommand(args: string): {
  topology?: "SINGLE" | "MULTI";
  intent?: "PLAN" | "BUILD";
  objective?: string;
  action?: CodingCommandAction;
  reason?: string;
  choice?: "BUILD" | "KEEP" | "REVISE";
  reviewDecision?: "APPROVE" | "REJECT";
  confirmed?: boolean;
  clarificationSelections?: readonly { readonly questionId: string; readonly optionId: string }[];
  entryMode?: CodingEntryMode;
  goalId?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return { entryMode: "HUB" };
  const recoverEntry = /^recover(?:\s+([A-Za-z][A-Za-z0-9_-]{0,255}))?$/iu.exec(trimmed);
  if (recoverEntry) return { entryMode: "RECOVER", ...(recoverEntry[1] ? { goalId: recoverEntry[1] } : {}) };
  const newEntry = /^new(?:\s+([\s\S]+))?$/iu.exec(trimmed);
  if (newEntry) {
    const match = /^(?:(single|multi)\s+)?(?:(plan|build)\s+)?([\s\S]*)$/iu.exec(newEntry[1]?.trim() ?? "");
    return {
      entryMode: "NEW",
      ...(match?.[1] ? { topology: match[1].toUpperCase() as "SINGLE" | "MULTI" } : {}),
      ...(match?.[2] ? { intent: match[2].toUpperCase() as "PLAN" | "BUILD" } : {}),
      ...(match?.[3]?.trim() ? { objective: match[3].trim() } : {}),
    };
  }
  const rename = /^rename\s+([\s\S]+)$/iu.exec(trimmed);
  if (rename) return { action: "rename", reason: rename[1]!.trim() };
  const continuation = /^continue(?:\s+(build|keep|revise))?$/iu.exec(trimmed);
  if (continuation) return {
    action: "continue", ...(continuation[1] ? { choice: continuation[1].toUpperCase() as "BUILD" | "KEEP" | "REVISE" } : {}),
  };
  const review = /^review\s+(approve|reject)(?:\s+([\s\S]+))?$/iu.exec(trimmed);
  if (review) return {
    action: "review",
    reviewDecision: review[1]!.toUpperCase() as "APPROVE" | "REJECT",
    ...(review[2]?.trim() ? { reason: review[2].trim() } : {}),
  };
  const clarification = /^clarify\s+([\s\S]+)$/iu.exec(trimmed);
  if (clarification) {
    const selections = clarification[1]!.split(",").map((entry) => {
      const match = /^([A-Za-z][A-Za-z0-9_.:-]{0,159})=([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})$/u.exec(entry.trim());
      if (!match) throw new TypeError("Clarification syntax: /coding clarify <question_id>=<option_id>[,...]");
      return { questionId: match[1]!, optionId: match[2]! };
    });
    if (selections.length < 1 || selections.length > 5) throw new TypeError("Clarification command requires 1..5 selections");
    return { action: "clarify", clarificationSelections: selections };
  }
  const cancel = /^cancel(?:\s+(--confirm))?(?:\s+([\s\S]+))?$/iu.exec(trimmed);
  if (cancel) return {
    action: "cancel", ...(cancel[1] ? { confirmed: true } : {}), ...(cancel[2]?.trim() ? { reason: cancel[2].trim() } : {}),
  };
  if (/^(?:status|cache|pause|resume|exit)$/iu.test(trimmed)) {
    return { action: trimmed.toLowerCase() as Exclude<CodingCommandAction, "replan"> };
  }
  const replan = /^replan(?:\s+([\s\S]+))?$/iu.exec(trimmed);
  if (replan) return { action: "replan", ...(replan[1]?.trim() ? { reason: replan[1].trim() } : {}) };
  const match = /^(?:(single|multi)\s+)?(?:(plan|build)\s+)?([\s\S]*)$/iu.exec(trimmed);
  return {
    entryMode: "NEW",
    ...(match?.[1] ? { topology: match[1].toUpperCase() as "SINGLE" | "MULTI" } : {}),
    ...(match?.[2] ? { intent: match[2].toUpperCase() as "PLAN" | "BUILD" } : {}),
    ...(match?.[3]?.trim() ? { objective: match[3].trim() } : {}),
  };
}

type SessionBindingScan =
  | { readonly kind: "NONE" }
  | { readonly kind: "INVALID" }
  | { readonly kind: "FOREIGN"; readonly marker: SessionGoalBindingMarkerV1 }
  | { readonly kind: "CURRENT"; readonly marker: SessionGoalBindingMarkerV1 };

function scanCurrentSessionBinding(ctx: Pick<ExtensionContext, "sessionManager">): SessionBindingScan {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as unknown as { readonly type?: unknown; readonly customType?: unknown; readonly data?: unknown };
    if (entry.type !== "custom" || entry.customType !== SESSION_GOAL_BINDING_CUSTOM_TYPE) continue;
    const marker = parseSessionGoalBindingMarker(entry.data);
    if (!marker) return { kind: "INVALID" };
    if (marker.session_id !== ctx.sessionManager.getSessionId()) return { kind: "FOREIGN", marker };
    return { kind: "CURRENT", marker };
  }
  return { kind: "NONE" };
}

async function chooseEntry(args: string, ctx: ExtensionCommandContext) {
  const parsed = parseCommand(args);
  if (parsed.action) return {
    action: parsed.action,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    ...(parsed.choice ? { choice: parsed.choice } : {}),
    ...(parsed.reviewDecision ? { reviewDecision: parsed.reviewDecision } : {}),
    ...(parsed.confirmed ? { confirmed: true } : {}),
    ...(parsed.clarificationSelections ? { clarificationSelections: parsed.clarificationSelections } : {}),
  } as const;
  if (!ctx.hasUI && (!parsed.topology || !parsed.intent || !parsed.objective)) {
    throw new TypeError("Non-interactive usage: /coding <single|multi> <plan|build> <objective>");
  }
  let topology = parsed.topology;
  if (!topology) {
    const selected = await ctx.ui.select("Execution topology", [
      "[Recommended] Single - lowest overhead for tightly coupled work",
      "Multi - parallel role-isolated workers for decomposable work",
    ]);
    if (selected === undefined) throw new TypeError("Coding Harness entry canceled");
    topology = selected?.startsWith("Multi") ? "MULTI" : "SINGLE";
  }
  let intent = parsed.intent;
  if (!intent) {
    const selected = await ctx.ui.select("Starting mode", [
      "[Recommended] Build - use a minimal contract and implement",
      "Plan - produce and review a route, then ask before build",
    ]);
    if (selected === undefined) throw new TypeError("Coding Harness entry canceled");
    intent = selected?.startsWith("Plan") ? "PLAN" : "BUILD";
  }
  const objective = parsed.objective ?? await ctx.ui.editor("Coding objective");
  if (!objective?.trim()) throw new TypeError("Coding objective cannot be empty");
  return { kind: "NEW" as const, topology, intent, objective: objective.trim() };
}

async function continuePlan(
  client: HostClient,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  explicitChoice?: "BUILD" | "KEEP" | "REVISE",
  suppliedStatus?: HostStatus,
): Promise<unknown> {
  const status = suppliedStatus ?? await client.request("status", null, 2_000) as HostStatus;
  const review = status.plan_review ?? null;
  const controlFrameSha256 = status.control_frame?.control_frame_sha256;
  if (!review || !controlFrameSha256) throw new TypeError("Plan continuation requires a current Plan review and ControlFrame");
  if (!explicitChoice && !ctx.hasUI) throw new TypeError("Non-interactive Plan continuation requires: /coding continue <build|keep|revise>");
  const title = review
    ? `Frozen Plan\n${review.summary}\nArtifact: ${review.artifact_path}\nSHA-256: ${review.route_sha256}`
    : "Frozen Plan";
  const selected = explicitChoice ?? await ctx.ui.select(title, [
    "[Recommended] Enter BUILD", "Keep plan only", "Revise technical route",
  ]).then((value) => value?.startsWith("[Recommended]") ? "BUILD" : value?.startsWith("Keep") ? "KEEP" : value ? "REVISE" : undefined);
  if (!selected) throw new TypeError("Plan continuation canceled");
  return client.request("continue_plan", {
    control_frame_sha256: controlFrameSha256,
    expected_route_sha256: review.route_sha256,
    expected_plan_revision_sha256: review.plan_revision_sha256,
    expected_stage_gate_sha256: review.stage_gate_sha256,
    choice: selected,
  });
}

function contractReviewTitle(review: NonNullable<HostStatus["contract_review"]>): string {
  const rendered = JSON.stringify({
    contract_changes: review.contract_diff,
    requirement_changes: review.requirement_diff,
  }, null, 2);
  const bounded = rendered.length <= 24_000 ? rendered : `${rendered.slice(0, 24_000)}\n[display truncated]`;
  return `Goal Contract review\nRequirement SHA-256: ${review.requirement_revision_sha256}\n${bounded}`;
}

async function resolveContractReview(
  client: HostClient,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  review: NonNullable<HostStatus["contract_review"]>,
  explicit?: { readonly action: "APPROVE" | "REJECT"; readonly feedback?: string },
): Promise<unknown> {
  let action = explicit?.action;
  let selectedValue: unknown = action === "APPROVE" ? true : explicit?.feedback ?? false;
  if (!action) {
    if (!ctx.hasUI) throw new TypeError("Non-interactive Contract review requires: /coding review <approve|reject> [feedback]");
    const selected = await ctx.ui.select(contractReviewTitle(review), [
      "[Recommended] Approve Goal Contract",
      "Request changes",
      "Reject current draft",
      "Decide later",
    ]);
    if (!selected || selected === "Decide later") return null;
    if (selected.startsWith("[Recommended]")) {
      action = "APPROVE";
      selectedValue = true;
    } else {
      action = "REJECT";
      if (selected === "Request changes") {
        const feedback = (await ctx.ui.editor("Required Goal Contract changes"))?.trim();
        if (!feedback) return null;
        selectedValue = { disposition: "REQUEST_CHANGES", feedback };
      } else {
        selectedValue = false;
      }
    }
  }
  return client.request("resolve_contract_review", {
    expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
    expected_requirement_revision_sha256: review.requirement_revision_sha256,
    expected_decision_frontier_sha256: review.decision_frontier_sha256,
    action,
    selected_value: selectedValue,
  });
}

export function registerCodingHarness(pi: ExtensionAPI, options: CodingHarnessBridgeOptions = {}): void {
  const packageRoot = options.packageRoot ?? defaultPackageRoot;
  const configPath = options.configPath ?? resolve(packageRoot, "config", "default.json");
  const hostEntryPath = options.hostEntryPath ?? resolve(packageRoot, "dist", "harness", "host", "entry.js");
  const dataRoot = options.dataRoot ?? "~/.pi/agent/coding-harness";
  const spawnHost = options.spawnHost ?? ((input: SpawnHostOptions): HostRpcClient => spawnCodingHarnessHost(input));
  let active: ActiveBridge | null = null;
  let recoveryFailure: { readonly marker: SessionGoalBindingMarkerV1 | null; readonly message: string } | null = null;
  const removeHarnessTools = (): void => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !harnessTools.includes(name as typeof harnessTools[number])));
  };
  const enableHarnessTools = (): void => {
    const current = pi.getActiveTools().filter((name) => !harnessTools.includes(name as typeof harnessTools[number]));
    pi.setActiveTools([...current, ...harnessTools]);
  };
  const deactivate = async (): Promise<void> => {
    const prior = active;
    active = null;
    removeHarnessTools();
    if (prior) {
      if (prior.statusProjectionTimer) clearTimeout(prior.statusProjectionTimer);
      if (prior.providerTurnStarted) settleProviderTurn(prior, {
        usage: null, responseStatus: null, outcome: "OUTCOME_UNKNOWN",
        assistantTextBytes: 0, toolArgumentBytes: 0,
      });
      await Promise.all([
        prior.providerTail.catch(() => undefined),
        prior.toolObservationTail.catch(() => undefined),
        prior.activeInputCaptureTail.catch(() => undefined),
      ]);
      await prior.client.close();
    }
  };

  const settleProviderTurn = (bridge: ActiveBridge, input: {
    readonly usage: Record<string, number | null> | null;
    readonly responseStatus: number | null;
    readonly outcome: "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
    readonly assistantTextBytes: number;
    readonly toolArgumentBytes: number;
  }): void => {
    const begin = bridge.providerBegin;
    const startedAt = bridge.cacheStartedAt;
    bridge.providerTurnStarted = false;
    bridge.providerBegin = null;
    bridge.cacheStartedAt = null;
    bridge.cacheResponseStatus = null;
    if (!begin) return;
    const settled = begin.then(async (result) => {
      if (!result || (!result.recorded && result.cache_request_id === null)) return;
      await bridge.client.request("provider_settle", {
        provider_attempt_id: result.provider_attempt_id,
        cache_request_id: result.cache_request_id,
        usage: input.usage,
        response_status: input.responseStatus,
        latency_ms: startedAt === null ? null : Math.max(0, performance.now() - startedAt),
        outcome: input.outcome,
        assistant_text_bytes: input.assistantTextBytes,
        tool_argument_bytes: input.toolArgumentBytes,
      }, 2_000);
    }).catch(() => undefined);
    bridge.providerTail = settled;
    void settled;
  };
  const settleAssistantProviderTurn = (bridge: ActiveBridge, messageValue: unknown): void => {
    if (!bridge.providerTurnStarted || typeof messageValue !== "object" || messageValue === null) return;
    const message = messageValue as { role?: unknown; usage?: Record<string, unknown> };
    if (message.role !== "assistant") return;
    const numeric = (value: unknown): number | null => typeof value === "number"
      && Number.isFinite(value) && value >= 0 ? value : null;
    const outputBytes = assistantOutputBytes(messageValue);
    settleProviderTurn(bridge, {
      usage: {
        input: numeric(message.usage?.input), output: numeric(message.usage?.output),
        cacheRead: numeric(message.usage?.cacheRead), cacheWrite: numeric(message.usage?.cacheWrite),
        reasoning: numeric(message.usage?.reasoning),
      },
      responseStatus: bridge.cacheResponseStatus,
      outcome: bridge.cacheResponseStatus === null ? "OUTCOME_UNKNOWN"
        : bridge.cacheResponseStatus >= 400 ? "FAILED" : "RESPONDED",
      assistantTextBytes: outputBytes.text, toolArgumentBytes: outputBytes.toolArguments,
    });
  };
  const required = (): ActiveBridge => {
    if (!active) throw new TypeError("Enter Coding Harness with /coding first");
    return active;
  };
  const controlled = (bridge: ActiveBridge, payload: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => {
    if (!bridge.turnControlFrameSha256) {
      throw new TypeError("PCH_CONTROL_FRAME_REQUIRED: wait for a fresh Coding Harness model turn");
    }
    return { ...payload, control_frame_sha256: bridge.turnControlFrameSha256 };
  };
  const setProjectedStatus = (ctx: ExtensionContext, status: HostStatus): void => {
    const bridge = required();
    const binding = status.session_binding === undefined || status.session_binding === null
      ? null : parseSessionGoalBindingMarker(status.session_binding);
    if (status.session_binding !== undefined && status.session_binding !== null && !binding) {
      throw new TypeError("Host returned an invalid session Goal binding marker");
    }
    if (binding && binding.session_id !== bridge.sessionId) {
      throw new TypeError("Host returned a session Goal binding for another Pi session");
    }
    if (binding && binding.binding_receipt_sha256 !== bridge.lastBindingReceiptSha256) {
      pi.appendEntry(SESSION_GOAL_BINDING_CUSTOM_TYPE, binding);
      bridge.lastBindingReceiptSha256 = binding.binding_receipt_sha256;
    }
    if (status.open_clarifications !== undefined) {
      bridge.pendingClarifications.clear();
      for (const decision of status.open_clarifications) bridge.pendingClarifications.set(decision.id, decision);
    }
    const controlFrameSha256 = status.control_frame?.control_frame_sha256;
    if (typeof controlFrameSha256 === "string" && /^[a-f0-9]{64}$/u.test(controlFrameSha256)) {
      bridge.turnControlFrameSha256 = controlFrameSha256;
    }
    const text = compactStatus(status);
    if (bridge.lastStatusText === text || bridge.pendingStatusProjection?.text === text) return;
    const projection = { text, widgetLines: statusWidgetLines(status).slice(0, bridge.ui.max_widget_lines) };
    const apply = (): void => {
      bridge.statusProjectionTimer = null;
      bridge.pendingStatusProjection = null;
      bridge.lastStatusText = projection.text;
      ctx.ui.setStatus("coding-harness", bridge.ui.status ? projection.text : undefined);
      ctx.ui.setWidget("coding-harness", bridge.ui.widget ? [...projection.widgetLines] : undefined);
    };
    if (bridge.lastStatusText === null) { apply(); return; }
    bridge.pendingStatusProjection = projection;
    if (bridge.statusProjectionTimer) clearTimeout(bridge.statusProjectionTimer);
    bridge.statusProjectionTimer = setTimeout(apply, bridge.ui.debounce_ms);
    bridge.statusProjectionTimer.unref();
  };
  const projectResultStatus = (ctx: ExtensionContext, value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false;
    const status = (value as { status?: unknown }).status;
    if (typeof status !== "object" || status === null) return false;
    setProjectedStatus(ctx, status as HostStatus);
    return true;
  };
  const projectResultControlFrame = (bridge: ActiveBridge, value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const controlFrame = (value as { control_frame?: unknown }).control_frame;
    if (typeof controlFrame !== "object" || controlFrame === null) return;
    const sha256 = (controlFrame as { control_frame_sha256?: unknown }).control_frame_sha256;
    if (typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256)) bridge.turnControlFrameSha256 = sha256;
  };
  const showStatus = async (ctx: ExtensionContext): Promise<HostStatus> => {
    const status = await required().client.request("status", null, 2_000) as HostStatus;
    setProjectedStatus(ctx, status);
    return status;
  };

  const spawnBridgeHost = (ctx: Pick<ExtensionContext, "cwd">): HostClient => {
    if (!existsSync(hostEntryPath)) {
      throw new TypeError("Coding Harness Host build is missing; run npm run build:runtime in the package root");
    }
    return spawnHost({
      entryPath: hostEntryPath, cwd: ctx.cwd, packageRoot, configPath, dataRoot,
      timeoutMs: 8_000, maxPending: 32,
    });
  };

  const activateBridge = (
    client: HostClient,
    status: HostStatus,
    ctx: ExtensionContext,
    runtime: RuntimeSelection,
    alreadyPersistedReceiptSha256: string | null,
  ): ActiveBridge => {
    if (!status.active || !status.flow) throw new TypeError("Coding Harness Host did not return an active Goal");
    const bridge: ActiveBridge = {
      client, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), objective: status.flow.objective,
      sentSystemPrompts: new Set(), runtime,
      providerLifecycleEnabled: status.context?.provider_turn_ledger_enabled === true || status.cache?.configured === true,
      projectionLedger: new ProjectionDeltaLedger(`${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`),
      messageDescriptors: new WeakMap(),
      contextProjectionActive: false,
      managedToolCalls: new Set(), captureToolCalls: new Set(),
      contextRecoveryScanRequired: true, hasContextOverlays: false,
      cacheStartedAt: null, cacheResponseStatus: null,
      providerTurnStarted: false, providerBegin: null, providerTail: Promise.resolve(),
      toolObservationTail: Promise.resolve(), activeInputCaptureTail: Promise.resolve(),
      providerHistory: emptyProviderHistory, toolSchemaBytes: 0, lastStatusText: null,
      pendingStatusProjection: null, statusProjectionTimer: null,
      ui: status.ui ?? { widget: true, status: true, debounce_ms: 250, max_widget_lines: 4 },
      turnControlFrameSha256: null, agentRunSequence: 0,
      governorDirective: null, governorMessage: null, governorDecision: "CONTINUE",
      pendingClarifications: new Map(),
      lastBindingReceiptSha256: alreadyPersistedReceiptSha256,
    };
    active = bridge;
    enableHarnessTools();
    setProjectedStatus(ctx, status);
    recoveryFailure = null;
    return bridge;
  };

  pi.registerTool({
    name: "coding_flow",
    label: "Advance Coding Harness",
    description: "Advance only the authority-backed next action. Normal validation auto-attests; call complete once after final preservation review. Status, attest, and reconcile remain recovery operations.",
    promptSnippet: "Follow next= from the latest result; do not poll status or probe PI_MODEL/PI_SESSION; after final fresh validation review preservation outcomes and call complete once",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("status") }, { additionalProperties: false, description: "Recovery inspection only; every transition result already includes compact status." }),
      Type.Object({ action: Type.Literal("submit_contract"), contract: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("classify_active_input"),
        user_turn_id: Type.String(),
        expected_user_turn_sha256: Type.String(),
        classification: Type.Union([
          Type.Literal("CORRECT_CURRENT"), Type.Literal("QUEUE_NEXT"), Type.Literal("CHANGE_REQUEST"),
          Type.Literal("NEW_GOAL"), Type.Literal("INTERRUPT_NOW"), Type.Literal("DISCUSSION_ONLY"),
        ]),
        materiality: Type.Union([Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH"), Type.Literal("CRITICAL")]),
        change_kind: Type.Union([
          Type.Literal("BEHAVIOR"), Type.Literal("SCOPE"), Type.Literal("ACCEPTANCE"),
          Type.Literal("USER_PREFERENCE"), Type.Null(),
        ]),
        changed_subjects: Type.Array(Type.Object({
          kind: Type.Union([Type.Literal("REQUIREMENT"), Type.Literal("DECISION"), Type.Literal("WORK_CELL")]),
          id: Type.String(),
        }, { additionalProperties: false }), { maxItems: 512 }),
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("submit_route"), route: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("submit_route_revision"), patch: Type.Record(Type.String(), Type.Unknown()) }, {
        additionalProperties: false,
        description: "RouteRevision only after next=SUBMIT_ROUTE and a prior Route exists; submit replacement current/near WorkCells plus only changed metadata.",
      }),
      Type.Object({ action: Type.Literal("attest"), operation_id: Type.String(), obligation_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false, description: "Crash recovery only when a committed PASS Operation lacks its automatic attestation." }),
      Type.Object({
        action: Type.Literal("complete"),
        outcome_evidence: Type.Optional(Type.Array(Type.Object({
          obligation_key: Type.String(), operation_id: Type.String(),
          witnesses: Type.Array(Type.Object({ path: Type.String(), locator: Type.String() }, { additionalProperties: false })),
        }, { additionalProperties: false }))),
      }, {
        additionalProperties: false,
        description: "Close once after fresh oracle evidence. When OutcomeEvidenceRequired is shown, bind each key to its PASS validation Operation and a distinct current test locator; omit outcome_evidence otherwise. Also recovers CLOSE_GOAL after a crash.",
      }),
      Type.Object({ action: Type.Literal("reconcile"), operation_id: Type.Optional(Type.String()) }, { additionalProperties: false, description: "Use only for RECONCILE_OPERATION; omit operation_id to reconcile every unresolved Operation." }),
      Type.Object({ action: Type.Literal("control"), control: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("replan")]), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ]),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const bridge = required();
        await bridge.activeInputCaptureTail;
        if (params.action === "status") return accepted(compactStatus(await showStatus(ctx)));
        let result: unknown;
        if (params.action === "classify_active_input") {
          result = await bridge.client.request("classify_active_goal_input", controlled(bridge, {
            user_turn_id: params.user_turn_id,
            expected_user_turn_sha256: params.expected_user_turn_sha256,
            classification: params.classification,
            materiality: params.materiality,
            change_kind: params.change_kind,
            changed_subjects: params.changed_subjects,
          }));
        } else if (params.action === "submit_contract") {
          result = await bridge.client.request("submit_contract", controlled(bridge, params.contract));
          const review = (result as { status?: HostStatus }).status?.contract_review;
          if (review && ctx.hasUI) result = await resolveContractReview(bridge.client, ctx, review) ?? result;
        }
        else if (params.action === "submit_route") {
          result = await bridge.client.request("submit_route", controlled(bridge, params.route));
          const status = (result as { status?: HostStatus }).status;
          if (status?.flow?.nextAction === "PLAN_CONTINUATION" && ctx.hasUI) {
            result = await continuePlan(bridge.client, ctx, undefined, status);
          }
        } else if (params.action === "submit_route_revision") {
          result = await bridge.client.request("submit_route_revision", controlled(bridge, params.patch));
        } else if (params.action === "attest") result = await bridge.client.request("attest", controlled(bridge, {
          operation_id: params.operation_id,
          ...(params.obligation_keys === undefined ? {} : { obligation_keys: params.obligation_keys }),
        }));
        else if (params.action === "complete") result = await bridge.client.request("complete", controlled(bridge,
          params.outcome_evidence === undefined ? {} : { outcome_evidence: params.outcome_evidence }));
        else if (params.action === "reconcile") result = await bridge.client.request(
          "reconcile", controlled(bridge, params.operation_id === undefined ? {} : { operation_id: params.operation_id }),
        );
        else result = await bridge.client.request("control", controlled(bridge, {
          action: params.control, ...(params.reason === undefined ? {} : { reason: params.reason }),
        }));
        projectResultStatus(ctx, result);
        return accepted(resultMessage(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const status = await showStatus(ctx);
          return rejected("CODING_FLOW_REJECTED", `${message}\n${compactStatus(status)}`);
        } catch {
          return rejected("CODING_FLOW_REJECTED", message);
        }
      }
    },
  });

  pi.registerTool({
    name: "coding_clarify",
    label: "Ask Material Coding Decisions",
    description: "Ask one bounded batch of material user choices in Pi UI, showing a recommendation, then persist only explicit selections.",
    promptSnippet: "Ask only material behavior, scope, acceptance, privacy, cost, or preference choices",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        id: Type.String(), question: Type.String(), why_it_matters: Type.String(),
        change_kind: Type.Union([Type.Literal("BEHAVIOR"), Type.Literal("SCOPE"), Type.Literal("ACCEPTANCE"), Type.Literal("USER_PREFERENCE")]),
        materiality: Type.Union([Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH")]),
        reversible: Type.Boolean(), privacy_related: Type.Boolean(),
        options: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), impact: Type.String() }, { additionalProperties: false }), { minItems: 2, maxItems: 3 }),
        recommended_option_id: Type.String(), recommendation_reason: Type.String(),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 5 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const bridge = required();
        const selections: (BridgeClarificationDecision & { readonly selectedOptionId: string | null })[] = [];
        for (const question of params.questions) {
          const decision: BridgeClarificationDecision = {
            id: question.id, question: question.question, whyItMatters: question.why_it_matters,
            changeKind: question.change_kind, materiality: question.materiality, reversible: question.reversible,
            privacyRelated: question.privacy_related, options: question.options,
            recommendedOptionId: question.recommended_option_id, recommendationReason: question.recommendation_reason,
            dependsOnDecisionIds: [],
          };
          if (!ctx.hasUI) {
            const opened = await bridge.client.request("clarify_selected", controlled(bridge, {
              decisions: [{ ...decision, selectedOptionId: null }],
            }));
            projectResultStatus(ctx, opened);
            bridge.pendingClarifications.set(decision.id, decision);
            continue;
          }
          const labels = clarificationLabels(decision);
          const selected = await ctx.ui.select(`${question.question}\n${question.why_it_matters}`, labels);
          const index = selected === undefined ? -1 : labels.indexOf(selected);
          selections.push({ ...decision, selectedOptionId: index < 0 ? null : question.options[index]!.id });
          if (index < 0) break;
        }
        if (!ctx.hasUI) {
          const choices = headlessClarificationChoices(bridge);
          return accepted(`Awaiting explicit user choice. Run /coding clarify ${choices}`);
        }
        const result = await bridge.client.request("clarify_selected", controlled(bridge, { decisions: selections }));
        for (const selection of selections) {
          if (selection.selectedOptionId === null) bridge.pendingClarifications.set(selection.id, selection);
          else bridge.pendingClarifications.delete(selection.id);
        }
        projectResultStatus(ctx, result);
        return accepted(resultMessage(result));
      } catch (error) { return rejected("CODING_CLARIFICATION_REJECTED", error); }
    },
  });

  pi.registerTool({
    name: "coding_delegate",
    label: "Delegate Coding Shards",
    description: "Propose the bounded dependency graph while requested Multi is pending, or execute authority-ready isolated Worker nodes after admission.",
    promptSnippet: "Use define in PENDING_MULTI_PROPOSAL; use run_ready only after the Host admits effective Multi",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("define"), shards: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("run_ready"), max_parallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }),
    ]),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const bridge = required();
        let result: unknown;
        if (params.action === "run_ready") {
          const started = await bridge.client.request("worker_start", controlled(bridge, { max_parallel: params.max_parallel ?? 4 }), 4_000) as { job_id: string };
          let aborted = false;
          const requestAbort = (): void => {
            aborted = true;
            void bridge.client.request("worker_abort", { job_id: started.job_id }, 2_000).catch(() => undefined);
          };
          _signal?.addEventListener("abort", requestAbort, { once: true });
          try {
            let pollDelayMs = 100;
            for (;;) {
              const polled = await bridge.client.request("worker_poll", { job_id: started.job_id }, 2_000) as {
                state: "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED"; result: unknown; error: string | null;
                worker_count: number; elapsed_ms: number;
              };
              if (polled.state === "SUCCEEDED") { result = { message: `Worker completed: ${JSON.stringify(polled.result)}` }; break; }
              if (polled.state !== "RUNNING") throw new TypeError(polled.error ?? `Worker ${polled.state.toLowerCase()}`);
              if (bridge.ui.status) ctx.ui.setStatus("coding-harness", `Coding Harness MULTI workers=${polled.worker_count} state=RUNNING elapsed=${Math.floor(polled.elapsed_ms / 1_000)}s`);
              if (aborted) throw new TypeError("Worker cancellation requested");
              await new Promise<void>((resolveWait) => {
                const wake = (): void => { clearTimeout(timer); resolveWait(); };
                const timer = setTimeout(() => {
                  _signal?.removeEventListener("abort", wake);
                  resolveWait();
                }, pollDelayMs);
                if (_signal?.aborted) wake();
                else _signal?.addEventListener("abort", wake, { once: true });
              });
              pollDelayMs = Math.min(1_000, pollDelayMs * 2);
            }
          } finally { _signal?.removeEventListener("abort", requestAbort); }
        } else result = await bridge.client.request("define_shards", controlled(bridge, { shards: params.shards }));
        if (!projectResultStatus(ctx, result)) await showStatus(ctx);
        return accepted(resultMessage(result));
      } catch (error) { return rejected("CODING_DELEGATION_REJECTED", error); }
    },
  });

  pi.registerTool({
    name: "coding_context",
    label: "Retrieve Deferred Coding Context",
    description: "Retrieve exact or structural evidence from the current Input Context envelope when evidence was deferred instead of injected.",
    promptSnippet: "Retrieve only the deferred evidence needed for the current coding decision",
    parameters: Type.Union([
      Type.Object({
        selector: Type.Union([Type.Literal("CURRENT_ON_DEMAND"), Type.Literal("CURRENT_WORKING_SET")]),
        candidate_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        representation: Type.Optional(Type.Union([Type.Literal("EXACT"), Type.Literal("STRUCTURAL")])),
      }, { additionalProperties: false }),
      Type.Object({ cursor: Type.String({ minLength: 1, maxLength: 16_384 }) }, { additionalProperties: false }),
    ]),
    executionMode: "sequential",
    async execute(_id, params) {
      try {
        const bridge = required();
        const result = await bridge.client.request("context_fetch", controlled(bridge, params), 5_000);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `CODING_CONTEXT_REJECTED: ${error instanceof Error ? error.message : String(error)}` }],
          details: undefined,
        };
      }
    },
  });

  registerMemoryCommands(pi, {
    execute: async (request) => {
      const result = await required().client.request("memory_command", request, 4_000) as { message?: unknown };
      return typeof result.message === "string" ? result.message : "Memory command completed.";
    },
  });

  const chooseGoalEntry = async (
    parsed: ReturnType<typeof parseCommand>,
    ctx: ExtensionCommandContext,
    client: HostClient,
  ): Promise<
    | { readonly kind: "NEW"; readonly topology: "SINGLE" | "MULTI"; readonly intent: "PLAN" | "BUILD"; readonly objective: string }
    | { readonly kind: "RESUME"; readonly marker: SessionGoalBindingMarkerV1 }
    | { readonly kind: "RECOVER"; readonly goalId: string; readonly allowTransfer: boolean; readonly goalTitle: string }
  > => {
    const discovery = await client.request("discover_goals", {
      cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId(),
    }, 4_000) as HostGoalDiscovery;
    const current = discovery.current_session_binding;
    const candidates = discovery.recoverable;
    if (parsed.entryMode === "HUB" && current && !ctx.hasUI) return { kind: "RESUME", marker: current };

    let selectedGoalId = parsed.goalId;
    if (parsed.entryMode === "HUB" && ctx.hasUI) {
      const choices: { readonly label: string; readonly goalId: string | null }[] = [];
      if (current) {
        const candidate = candidates.find((item) => item.goal_id === current.goal_id);
        choices.push({
          label: `Continue ${current.goal_title} - ${candidate?.status ?? "last known"}`,
          goalId: current.goal_id,
        });
      }
      for (const candidate of candidates) {
        if (candidate.goal_id === current?.goal_id) continue;
        const availability = candidate.controller_live ? "In use" : "Recover";
        choices.push({ label: `${availability} ${candidate.goal_title} - ${candidate.status}`, goalId: candidate.goal_id });
      }
      choices.push({ label: "Start a new Goal", goalId: null });
      const selected = await ctx.ui.select("Coding Goals", choices.map((choice) => choice.label));
      if (!selected) throw new TypeError("Coding Harness entry canceled");
      const choice = choices.find((item) => item.label === selected);
      if (!choice) throw new TypeError("Coding Harness Goal selection is invalid");
      if (choice.goalId === null) {
        const fresh = await chooseEntry("new", ctx);
        if ("action" in fresh) throw new TypeError("Coding Harness new Goal selection is invalid");
        return fresh;
      }
      selectedGoalId = choice.goalId;
    }
    if (parsed.entryMode === "HUB" && !ctx.hasUI && !current) {
      throw new TypeError("Non-interactive usage: /coding recover <goal-id> or /coding new <single|multi> <plan|build> <objective>");
    }
    if (!selectedGoalId && parsed.entryMode === "RECOVER") {
      if (!ctx.hasUI) throw new TypeError("Non-interactive recovery requires: /coding recover <goal-id>");
      const choices = candidates.map((candidate) => `${candidate.goal_title} - ${candidate.status} - ${candidate.goal_id}`);
      const selected = await ctx.ui.select("Recover Coding Goal", choices);
      if (!selected) throw new TypeError("Coding Harness recovery canceled");
      selectedGoalId = candidates[choices.indexOf(selected)]?.goal_id;
    }
    if (!selectedGoalId) throw new TypeError("No recoverable Coding Harness Goal was selected");
    if (current?.goal_id === selectedGoalId) return { kind: "RESUME", marker: current };
    const candidate = candidates.find((item) => item.goal_id === selectedGoalId);
    if (!candidate) throw new TypeError(`Goal ${selectedGoalId} is not recoverable in this workspace`);
    const allowTransfer = candidate.controller_session_id !== null
      && candidate.controller_session_id !== ctx.sessionManager.getSessionId();
    if (allowTransfer && candidate.controller_live) {
      throw new TypeError(`Goal ${selectedGoalId} is controlled by another live session`);
    }
    if (allowTransfer && ctx.hasUI) {
      const confirmed = await ctx.ui.confirm(
        "Transfer Coding Goal control?",
        `${candidate.goal_title} will stop auto-resuming in its previous Pi session.`,
      );
      if (!confirmed) throw new TypeError("Coding Harness control transfer canceled");
    }
    return { kind: "RECOVER", goalId: candidate.goal_id, allowTransfer, goalTitle: candidate.goal_title };
  };

  pi.registerCommand("coding", {
    description: "Enter, inspect, or exit Pi Coding Harness",
    handler: async (args, ctx) => {
      const parsedCommand = parseCommand(args);
      const commandAction = parsedCommand.action;
      let preparedClient: HostClient | null = null;
      try {
        if (!commandAction && active) {
          try { await active.client.request("status", null, 2_000); }
          catch { await deactivate(); }
        }
        if (!commandAction && active) {
          throw new TypeError("Coding Harness is already active; use /coding status or /coding exit");
        }
        let entry;
        if (commandAction) {
          entry = await chooseEntry(args, ctx);
        } else if (parsedCommand.entryMode === "HUB" || parsedCommand.entryMode === "RECOVER") {
          preparedClient = spawnBridgeHost(ctx);
          try {
            entry = await chooseGoalEntry(parsedCommand, ctx, preparedClient);
          } catch (error) {
            await preparedClient.close();
            preparedClient = null;
            throw error;
          }
        } else {
          entry = await chooseEntry(args, ctx);
        }
        if ("action" in entry && entry.action === "status") {
          if (!active) ctx.ui.notify("Coding Harness is inactive", "info");
          else ctx.ui.notify(compactStatus(await showStatus(ctx)), "info");
          return;
        }
        if ("action" in entry && entry.action === "cache") {
          if (!active) throw new TypeError("Enter Coding Harness before requesting Cache diagnostics");
          const result = await active.client.request("cache_diagnostic", null, 2_000) as { message?: unknown };
          ctx.ui.notify(typeof result.message === "string" ? result.message : "Cache diagnostic unavailable", "info");
          return;
        }
        if ("action" in entry && entry.action === "continue") {
          if (!active) throw new TypeError("Enter Coding Harness before continuing a Plan");
          const result = await continuePlan(active.client, ctx, entry.choice);
          projectResultStatus(ctx, result);
          ctx.ui.notify(resultMessage(result), "info");
          return;
        }
        if ("action" in entry && entry.action === "review") {
          if (!active) throw new TypeError("Enter Coding Harness before reviewing a Goal Contract");
          const status = await showStatus(ctx);
          if (!status.contract_review) throw new TypeError("No Goal Contract review is pending");
          const result = await resolveContractReview(active.client, ctx, status.contract_review, {
            action: entry.reviewDecision!, ...(entry.reason ? { feedback: entry.reason } : {}),
          });
          if (result === null) return;
          projectResultStatus(ctx, result);
          ctx.ui.notify(resultMessage(result), "info");
          pi.sendUserMessage(entry.reason
            ? `Goal Contract review feedback: ${entry.reason}\nContinue from the current Coding Harness authority state.`
            : "Continue from the current Coding Harness authority state.");
          return;
        }
        if ("action" in entry && entry.action === "clarify") {
          if (!active) throw new TypeError("Enter Coding Harness before resolving a clarification");
          const decisions = (entry.clarificationSelections ?? []).map(({ questionId, optionId }) => {
            const pending = active!.pendingClarifications.get(questionId);
            if (!pending) throw new TypeError(`Clarification ${questionId} is not pending in this Pi session`);
            if (!pending.options.some((option) => option.id === optionId)) {
              throw new TypeError(`Clarification ${questionId} option must be one of: ${pending.options.map((option) => option.id).join(", ")}`);
            }
            return { ...pending, selectedOptionId: optionId };
          });
          const result = await active.client.request("clarify_selected", controlled(active, { decisions }));
          for (const { questionId } of entry.clarificationSelections ?? []) active.pendingClarifications.delete(questionId);
          projectResultStatus(ctx, result);
          ctx.ui.notify(resultMessage(result), "info");
          if (active.pendingClarifications.size === 0) pi.sendUserMessage(active.objective);
          return;
        }
        if ("action" in entry && ["pause", "resume", "cancel", "replan"].includes(entry.action)) {
          if (!active) throw new TypeError("Enter Coding Harness before changing execution state");
          if (entry.action === "cancel") {
            if (!entry.confirmed) {
              if (!ctx.hasUI) throw new TypeError("Non-interactive cancel requires: /coding cancel --confirm [reason]");
              const selected = await ctx.ui.select("Cancel the active Coding Harness Goal?", [
                "[Recommended] Keep running",
                "Cancel Goal and revoke pending execution",
              ]);
              if (selected !== "Cancel Goal and revoke pending execution") {
                ctx.ui.notify("Coding Harness cancellation was not applied", "info");
                return;
              }
            }
          }
          let reason = entry.reason;
          if (entry.action === "replan" && !reason) {
            if (!ctx.hasUI) throw new TypeError("Non-interactive replan requires: /coding replan <reason>");
            reason = (await ctx.ui.editor("Why must the technical route change?"))?.trim();
            if (!reason) throw new TypeError("Replan reason cannot be empty");
          }
          const result = await active.client.request("control", { action: entry.action, ...(reason ? { reason } : {}) });
          projectResultStatus(ctx, result);
          ctx.ui.notify(resultMessage(result), "info");
          return;
        }
        if ("action" in entry && entry.action === "rename") {
          if (!active) throw new TypeError("Enter Coding Harness before renaming its Goal");
          const status = await showStatus(ctx);
          const receipt = status.session_binding?.binding_receipt_sha256;
          if (!receipt) throw new TypeError("Active Goal has no current session binding");
          const renamed = await active.client.request("rename_goal", {
            goal_title: entry.reason, expected_binding_receipt_sha256: receipt,
          }) as HostStatus;
          setProjectedStatus(ctx, renamed);
          ctx.ui.notify(`Coding Goal renamed to ${entry.reason}`, "info");
          return;
        }
        if ("action" in entry && entry.action === "exit") {
          if (!active && recoveryFailure) {
            throw new TypeError("Cannot unbind the Goal until authority recovery succeeds; retry /coding first or open a new Pi session");
          }
          if (active) {
            const status = await showStatus(ctx);
            const receipt = status.session_binding?.binding_receipt_sha256;
            if (receipt && status.session_binding?.state === "BOUND") {
              const exited = await active.client.request("unbind_session", {
                expected_binding_receipt_sha256: receipt,
              }) as HostStatus;
              setProjectedStatus(ctx, exited);
            }
          }
          await deactivate();
          recoveryFailure = null;
          ctx.ui.setStatus("coding-harness", undefined);
          ctx.ui.setWidget("coding-harness", undefined);
          ctx.ui.notify("Coding Harness exited", "info");
          return;
        }
        if ("action" in entry) throw new TypeError("Unknown /coding action");
        const runtime = runtimeSelection(pi, ctx);
        const client = preparedClient ?? spawnBridgeHost(ctx);
        preparedClient = null;
        try {
          const enterParams = entry.kind === "NEW" ? {
            entry_mode: "NEW",
            cwd: ctx.cwd,
            session_id: ctx.sessionManager.getSessionId(),
            objective: entry.objective,
            intent: entry.intent,
            topology: entry.topology,
            runtime,
          } : entry.kind === "RESUME" ? {
            entry_mode: "RESUME",
            cwd: ctx.cwd,
            session_id: ctx.sessionManager.getSessionId(),
            binding_marker: entry.marker,
            runtime,
          } : {
            entry_mode: "RECOVER",
            cwd: ctx.cwd,
            session_id: ctx.sessionManager.getSessionId(),
            goal_id: entry.goalId,
            allow_transfer: entry.allowTransfer,
            runtime,
          };
          const status = await client.request("enter", enterParams) as HostStatus;
          const branchBinding = scanCurrentSessionBinding(ctx);
          const persistedReceipt = entry.kind === "RESUME" && branchBinding.kind === "CURRENT"
            && branchBinding.marker.binding_receipt_sha256 === entry.marker.binding_receipt_sha256
            ? entry.marker.binding_receipt_sha256 : null;
          activateBridge(client, status, ctx, runtime, persistedReceipt);
          if (entry.kind !== "NEW") {
            const title = status.session_binding?.goal_title ?? status.flow?.objective ?? "Coding Goal";
            const next = status.flow?.nextAction ?? "status";
            ctx.ui.notify(`Coding Harness attached to ${title}; next=${next}`, "info");
            return;
          }
          if (status.contract_review) {
            if (!ctx.hasUI) {
              ctx.ui.notify("Recovered Goal Contract review. Run /coding review <approve|reject> [feedback]", "info");
              return;
            }
            const result = await resolveContractReview(required().client, ctx, status.contract_review);
            if (result === null) {
              ctx.ui.notify("Recovered Goal Contract review remains pending.", "info");
              return;
            }
            projectResultStatus(ctx, result);
            ctx.ui.notify(resultMessage(result), "info");
          }
          if (required().pendingClarifications.size > 0) {
            if (!ctx.hasUI) {
              ctx.ui.notify(`Recovered clarification choices. Run /coding clarify ${headlessClarificationChoices(required())}`, "info");
              return;
            }
            const selections: (BridgeClarificationDecision & { readonly selectedOptionId: string })[] = [];
            for (const decision of required().pendingClarifications.values()) {
              const labels = clarificationLabels(decision);
              const selected = await ctx.ui.select(`${decision.question}\n${decision.whyItMatters}`, labels);
              const index = selected === undefined ? -1 : labels.indexOf(selected);
              if (index < 0) break;
              selections.push({ ...decision, selectedOptionId: decision.options[index]!.id });
            }
            if (selections.length > 0) {
              const result = await required().client.request("clarify_selected", controlled(required(), { decisions: selections }));
              for (const selection of selections) required().pendingClarifications.delete(selection.id);
              projectResultStatus(ctx, result);
              ctx.ui.notify(resultMessage(result), "info");
            }
            if (required().pendingClarifications.size > 0) {
              ctx.ui.notify("Recovered clarification remains pending; Coding Harness will not start a model turn until it is resolved.", "info");
              return;
            }
          }
          pi.sendUserMessage(entry.objective);
        } catch (error) {
          if (active?.client === client) await deactivate();
          else await client.close();
          throw error;
        }
      } catch (error) {
        const scope = commandAction ? `${commandAction} command` : "entry";
        ctx.ui.notify(`Coding Harness ${scope} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    removeHarnessTools();
    recoveryFailure = null;
    const scan = scanCurrentSessionBinding(ctx);
    if (scan.kind === "NONE" || scan.kind === "FOREIGN") return;
    if (scan.kind === "INVALID") {
      recoveryFailure = { marker: null, message: "The current PCH session marker is invalid" };
      ctx.ui.setStatus("coding-harness", "Coding Harness recovery blocked: invalid session marker");
      ctx.ui.notify("Coding Harness recovery is blocked because the current session marker is invalid. Use /coding to retry diagnostics or open a new Pi session.", "error");
      return;
    }
    const marker = scan.marker;
    if (marker.state !== "BOUND" || !marker.auto_resume) return;
    ctx.ui.setStatus("coding-harness", "Coding Harness recovery validating");
    ctx.ui.setWidget("coding-harness", ["Recovery Guard · validating Goal authority"]);
    let client: HostClient | null = null;
    try {
      const runtime = runtimeSelection(pi, ctx);
      client = spawnBridgeHost(ctx);
      const status = await client.request("enter", {
        entry_mode: "RESUME",
        cwd: ctx.cwd,
        session_id: ctx.sessionManager.getSessionId(),
        binding_marker: marker,
        runtime,
      }) as HostStatus;
      activateBridge(client, status, ctx, runtime, marker.binding_receipt_sha256);
      const next = status.flow?.nextAction ?? "status";
      ctx.ui.notify(`Coding Harness restored ${marker.goal_title}; next=${next}`, "info");
    } catch (error) {
      if (client && active?.client === client) await deactivate().catch(() => undefined);
      else if (client) await client.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      recoveryFailure = { marker, message };
      removeHarnessTools();
      ctx.ui.setStatus("coding-harness", "Coding Harness recovery blocked");
      ctx.ui.setWidget("coding-harness", undefined);
      ctx.ui.notify(`Coding Harness recovery failed: ${message}. Ordinary model input is blocked in this bound session; use /coding to retry or open a new Pi session.`, "error");
    }
  });
  pi.on("input", (event, ctx) => {
    if (!active) {
      if (recoveryFailure) {
        ctx.ui.notify(`Coding Harness recovery remains blocked: ${recoveryFailure.message}`, "error");
        return { action: "handled" as const };
      }
      return;
    }
    if (event.source === "extension") return;
    const bridge = active;
    const captureInput = async () => {
      if (Buffer.byteLength(event.text, "utf8") > 131_072) {
        throw new TypeError("Active Goal input exceeds the 131072-byte authority limit");
      }
      const result = await bridge.client.request("active_goal_input", { text: event.text }, 4_000);
      if (active === bridge) projectResultStatus(ctx, result);
    };
    const capture = bridge.activeInputCaptureTail.then(captureInput, captureInput);
    bridge.activeInputCaptureTail = capture;
    void capture.catch(() => undefined);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!active) return;
    try {
      const bridge = active;
      await bridge.activeInputCaptureTail;
      if (active !== bridge) return;
      const systemPromptSha256 = sha256Hex(event.systemPrompt);
      const firstDelivery = !bridge.sentSystemPrompts.has(systemPromptSha256);
      const usage = ctx.getContextUsage();
      const activeToolNames = new Set(pi.getActiveTools());
      const allTools = pi.getAllTools();
      bridge.toolSchemaBytes = serializedBytes(allTools.filter((tool) => activeToolNames.has(tool.name)).map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
      })));
      const result = await bridge.client.request("turn_projection", {
        agent_run_id: `AGENT-RUN-${++bridge.agentRunSequence}-${sha256Hex(typeof event.prompt === "string" ? event.prompt : "").slice(0, 16)}`,
        system_prompt_sha256: systemPromptSha256,
        ...(firstDelivery ? { system_prompt: event.systemPrompt } : {}),
        current_input_tokens: usage?.tokens ?? null,
        active_tools: [...activeToolNames], all_tools: allTools.map((tool) => tool.name),
      }, 4_000) as {
        system_prompt: string; changed: boolean; context_projection_active: boolean;
        control_frame: { control_frame_sha256: string };
        generation_governor?: GenerationGovernorSnapshot;
      };
      bridge.contextProjectionActive = result.context_projection_active === true;
      bridge.turnControlFrameSha256 = result.control_frame.control_frame_sha256;
      bridge.governorDirective = result.generation_governor?.directive ?? null;
      bridge.governorMessage = makeGovernorMessage(bridge.governorDirective);
      bridge.governorDecision = result.generation_governor?.decision ?? "CONTINUE";
      if (firstDelivery) {
        bridge.sentSystemPrompts.add(systemPromptSha256);
        while (bridge.sentSystemPrompts.size > 2) bridge.sentSystemPrompts.delete(bridge.sentSystemPrompts.values().next().value!);
      }
      return result.changed ? { systemPrompt: result.system_prompt } : undefined;
    } catch (error) {
      ctx.ui.notify(`Coding Harness Host unavailable: ${error instanceof Error ? error.message : String(error)}. Managed tools are fail-closed.`, "error");
      throw error;
    }
  });
  pi.on("context", async (event) => {
    if (!active) return;
    const spine = stripOwnedProviderContextMessages(event.messages);
    const baseDescriptors = spine.baseMessages.map((message) => cachedMessageDescriptor(message, active!.messageDescriptors));
    const descriptors = baseDescriptors.map((descriptor) => ({
      contentSha256: descriptor.contentSha256, role: descriptor.role, customType: descriptor.customType,
    }));
    active.providerHistory = summarizeDescriptors(baseDescriptors);
    const governed = governorOverlay(active.governorMessage, spine.baseMessages.length);
    if (!active.contextProjectionActive) {
      if (!active.contextRecoveryScanRequired && !active.hasContextOverlays && governed.length === 0) return;
      active.contextRecoveryScanRequired = false;
      active.hasContextOverlays = governed.length > 0;
      if (spine.removedPersistedHarnessMessages === 0 && governed.length === 0) return undefined;
      const messages = applyContextProjection(spine.baseMessages, { overlays: governed });
      active.providerHistory = summarizeDescriptors(messages.map((message) => compactMessageDescriptor(message)));
      return { messages };
    }
    try {
      type ProjectionResponse = {
        changed: boolean; overlays: readonly { insertionIndex: number; message: unknown }[];
        projection_ack: { accepted: boolean; reconcile_required: boolean };
      };
      let delta = active.projectionLedger.plan(descriptors);
      const request = (value: ContextProjectionDelta) => active!.client.request("context_project", {
        delta: transportDelta(value), removed_persisted_messages: spine.removedPersistedHarnessMessages,
      }, 4_000) as Promise<ProjectionResponse>;
      let projected = await request(delta);
      if (projected.projection_ack.reconcile_required) {
        delta = active.projectionLedger.plan(descriptors, true);
        projected = await request(delta);
      }
      if (!projected.projection_ack.accepted) throw new TypeError("Host rejected a full Context projection reconcile");
      active.projectionLedger.commit(delta);
      active.contextRecoveryScanRequired = false;
      const overlays = [...projected.overlays, ...governorOverlay(active.governorMessage, spine.baseMessages.length)];
      active.hasContextOverlays = overlays.length > 0;
      if (!projected.changed && overlays.length === 0) return undefined;
      const messages = applyContextProjection(spine.baseMessages, { overlays });
      const descriptorProjection = {
        overlays: overlays.map((overlay) => ({
          insertionIndex: overlay.insertionIndex,
          message: compactMessageDescriptor(overlay.message),
        })),
      };
      active.providerHistory = summarizeDescriptors(applyContextProjection(baseDescriptors, descriptorProjection));
      return { messages };
    } catch {
      active.providerHistory = summarizeDescriptors(event.messages.map((message) => compactMessageDescriptor(message)));
      return undefined;
    }
  });
  pi.on("before_provider_request", (event) => {
    if (!active?.providerLifecycleEnabled) return;
    const bridge = active;
    if (bridge.providerTurnStarted) settleProviderTurn(bridge, {
      usage: null, responseStatus: bridge.cacheResponseStatus, outcome: "OUTCOME_UNKNOWN",
      assistantTextBytes: 0, toolArgumentBytes: 0,
    });
    const predecessor = bridge.providerTail;
    bridge.providerTurnStarted = true;
    bridge.cacheStartedAt = performance.now();
    bridge.cacheResponseStatus = null;
    bridge.providerBegin = predecessor.then(async () => {
      const result = await bridge.client.request("provider_begin", {
        payload_shape_sha256: payloadShapeSha256(event.payload),
        history: bridge.providerHistory,
        tool_schema_bytes: bridge.toolSchemaBytes,
      }, 2_000) as {
        recorded: boolean;
        provider_attempt_id: string | null;
        cache_request_id: string | null;
      };
      return result;
    }).catch(() => null);
    bridge.providerTail = bridge.providerBegin.then(() => undefined);
    void bridge.providerBegin;
  });
  pi.on("after_provider_response", (event) => {
    if (active?.providerLifecycleEnabled) active.cacheResponseStatus = event.status;
  });
  pi.on("message_end", (event) => {
    if (active) settleAssistantProviderTurn(active, event.message);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!active || harnessTools.includes(event.toolName as typeof harnessTools[number])) return;
    try {
      await active.activeInputCaptureTail;
      const admission = await active.client.request("tool_preflight", {
        toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, cwd: ctx.cwd,
        control_frame_sha256: active.turnControlFrameSha256,
      }, 2_000) as {
        allow: boolean; managed: boolean; capture: boolean; reason: string | null;
        oracle_policy?: { timeout_ms: number };
        control_frame?: { control_frame_sha256: string };
      };
      projectResultControlFrame(active, admission);
      if (!admission.allow) return { block: true, reason: admission.reason ?? "Coding Harness denied the operation" };
      if (event.toolName === "bash" && admission.oracle_policy) {
        event.input.timeout = admission.oracle_policy.timeout_ms / 1_000;
      }
      if (admission.managed) active.managedToolCalls.add(event.toolCallId);
      if (admission.capture) active.captureToolCalls.add(event.toolCallId);
      return undefined;
    } catch (error) {
      return { block: true, reason: `Coding Harness authority unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.on("tool_result", async (event) => {
    if (!active || harnessTools.includes(event.toolName as typeof harnessTools[number])) return;
    const managed = active.managedToolCalls.has(event.toolCallId);
    const capture = active.captureToolCalls.has(event.toolCallId);
    if (!managed && !capture) return;
    const projection = boundedResult(event.content);
    const bridge = active;
    const request = bridge.client.request("tool_result", {
      tool_call_id: event.toolCallId, tool_name: event.toolName, tool_input: event.input,
      is_error: event.isError, text: projection.text, output_sha256: projection.sha256,
    }, 4_000) as Promise<{
      operation_id: string | null;
      control_frame?: { control_frame_sha256: string };
    }>;
    const observedRequest = request.then((result) => {
      if (active === bridge) projectResultControlFrame(bridge, result);
      return result;
    });
    bridge.toolObservationTail = Promise.all([
      bridge.toolObservationTail,
      observedRequest.then(() => undefined).catch(() => undefined),
    ]).then(() => undefined);
    active.captureToolCalls.delete(event.toolCallId);
    if (!managed) {
      void observedRequest.catch(() => undefined);
      return;
    }
    const observed = await observedRequest;
    active.managedToolCalls.delete(event.toolCallId);
    if (!observed.operation_id || !event.isError) return;
    return { content: [...event.content, { type: "text" as const, text: `[Coding Harness operation: ${observed.operation_id}]` }] };
  });
  pi.on("tool_execution_end", async (event) => {
    if (!active || !active.managedToolCalls.has(event.toolCallId)
      || harnessTools.includes(event.toolName as typeof harnessTools[number])) return;
    const projection = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null);
    const bridge = active;
    const result = await bridge.client.request("tool_end", {
      tool_call_id: event.toolCallId, is_error: event.isError,
      text: projection.length <= 262_144 ? projection : `${projection.slice(0, 262_144)}\n[PCH tool end payload truncated]`,
    }, 2_000);
    if (active === bridge) projectResultControlFrame(bridge, result);
    bridge.managedToolCalls.delete(event.toolCallId);
    bridge.captureToolCalls.delete(event.toolCallId);
  });
  pi.on("turn_end", async (event) => {
    const bridge = active;
    if (!bridge) return;
    // Pi 0.82.x can omit an extension-visible message_end after recovery. turn_end is the
    // last complete assistant-message surface before another provider request.
    settleAssistantProviderTurn(bridge, event.message);
    await bridge.toolObservationTail.catch(() => undefined);
    try {
      const result = await bridge.client.request("generation_turn", { turn_index: event.turnIndex }, 2_000) as GenerationGovernorSnapshot;
      if (active !== bridge) return;
      if (bridge.governorDirective !== result.directive) {
        bridge.governorDirective = result.directive;
        bridge.governorMessage = makeGovernorMessage(result.directive);
        bridge.contextRecoveryScanRequired = true;
      }
      bridge.governorDecision = result.decision;
    } catch {
      // Advisory governance failure cannot replace Task Flow authority or normal Pi execution.
    }
  });
  pi.on("agent_settled", async () => {
    const bridge = active;
    if (!bridge) return;
    bridge.governorDirective = null;
    bridge.governorMessage = null;
    bridge.contextRecoveryScanRequired = true;
    try {
      const result = await bridge.client.request("generation_settled", null, 2_000) as GenerationGovernorSnapshot;
      if (active === bridge) bridge.governorDecision = result.decision;
    } catch {
      // A Host restart safely resets this non-authoritative optimization state.
    }
  });
  pi.on("session_before_compact", async () => {
    if (!active) return;
    await active.client.request("compaction", { phase: "before" }, 4_000);
  });
  pi.on("session_compact", async (_event, ctx) => {
    if (!active) return;
    try {
      await active.client.request("compaction", { phase: "after" }, 4_000);
      active.projectionLedger.rotate();
    } catch (error) {
      ctx.ui.notify(`Coding Harness compaction verification failed: ${error instanceof Error ? error.message : String(error)}. Managed mutation is paused; use /coding resume to reconcile.`, "error");
      try { setProjectedStatus(ctx, await active.client.request("status", null, 2_000) as HostStatus); } catch { /* Original error remains decisive. */ }
      throw error;
    }
  });
  pi.on("model_select", async (event) => {
    if (!active) return;
    active.runtime = {
      ...active.runtime, provider: event.model.provider,
      api: "api" in event.model && typeof event.model.api === "string" ? event.model.api : "unconfigured",
      base_url: "baseUrl" in event.model && typeof event.model.baseUrl === "string" ? event.model.baseUrl : "unconfigured",
      model: event.model.id, context_window: event.model.contextWindow,
    };
    await active.client.request("update_runtime", active.runtime, 2_000);
  });
  pi.on("thinking_level_select", async (event) => {
    if (!active) return;
    active.runtime = { ...active.runtime, thinking_level: event.level };
    await active.client.request("update_runtime", active.runtime, 2_000);
  });
  pi.on("session_shutdown", async () => deactivate());
}
