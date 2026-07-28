import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnCodingHarnessHost, type HostRpcClient, type SpawnHostOptions } from "../harness/host/client.js";
import { sha256Hex } from "../foundation/crypto.js";
import {
  applyContextProjection, stripOwnedProviderContextMessages,
} from "../input-context/pi-context-projector.js";
import { retainedContextDescriptor, type RetainedContextDescriptor } from "../input-context/retained-ledger.js";
import { ProjectionDeltaLedger, type ContextProjectionDelta } from "../input-context/projection-delta.js";
import { registerMemoryCommands } from "../memory/commands.js";
import { hasPotentialUserMemorySignal } from "../memory/capture-signal.js";
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
  providerBegin: Promise<{ readonly recorded: boolean; readonly cache_request_id: string | null } | null> | null;
  providerTail: Promise<void>;
  toolObservationTail: Promise<void>;
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

interface HostStatus {
  readonly active: boolean;
  readonly intent: "PLAN" | "BUILD" | null;
  readonly topology: "SINGLE" | "MULTI" | null;
  readonly flow: null | {
    readonly goalId: string;
    readonly mode: "PLAN" | "BUILD";
    readonly phase: string;
    readonly workCell: string | null;
    readonly routeHealth: string;
    readonly nextAction: string;
    readonly blocker: string | null;
  };
  readonly harness: null | {
    readonly status: string;
    readonly nextReadyShardId: string | null;
    readonly shards: readonly { readonly role: string; readonly status: string }[];
  };
  readonly cache?: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly arm: string;
    readonly effective_arm: string;
    readonly provider_integration: string | null;
    readonly reason: string;
  };
  readonly output?: { readonly enabled: boolean; readonly mode: string };
  readonly ui?: {
    readonly widget: boolean;
    readonly status: boolean;
    readonly debounce_ms: number;
    readonly max_widget_lines: number;
  };
  readonly context?: { readonly provider_turn_ledger_enabled?: boolean };
  readonly control_frame?: { readonly control_frame_sha256?: string } | null;
  readonly generation_governor?: GenerationGovernorSnapshot | null;
  readonly open_clarifications?: readonly BridgeClarificationDecision[];
  readonly plan_review?: null | {
    readonly summary: string;
    readonly artifact_path: string;
    readonly route_sha256: string;
  };
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
  const goal = ` goal=${status.flow.goalId}`;
  const cell = status.flow.workCell ? ` cell=${status.flow.workCell}` : "";
  const shard = status.harness?.nextReadyShardId ? ` ready=${status.harness.nextReadyShardId}` : "";
  const blocker = status.flow.blocker ? ` blocker=${status.flow.blocker}` : "";
  const governor = status.generation_governor && !["CONTINUE", "TERMINAL"].includes(status.generation_governor.decision)
    ? ` generation=${status.generation_governor.decision}` : "";
  const clarifications = status.open_clarifications?.length ? ` clarifications=${status.open_clarifications.length}` : "";
  return `Coding Harness ${status.intent}/${status.topology}${goal}${cell} phase=${status.flow.phase} health=${status.flow.routeHealth} next=${status.flow.nextAction}${shard}${governor}${clarifications}${blocker}`;
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
  return [
    `Goal ${status.flow.goalId} · ${status.intent}/${status.topology}`,
    `Phase ${status.flow.phase} · WorkCell ${status.flow.workCell ?? "none"}`,
    `Route ${status.flow.routeHealth} · Next ${status.flow.nextAction}`,
    ...(status.flow.blocker ? [`Blocker ${status.flow.blocker}`] : []),
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

type CodingCommandAction = "status" | "cache" | "continue" | "clarify" | "pause" | "resume" | "cancel" | "replan" | "exit";

function parseCommand(args: string): {
  topology?: "SINGLE" | "MULTI";
  intent?: "PLAN" | "BUILD";
  objective?: string;
  action?: CodingCommandAction;
  reason?: string;
  choice?: "BUILD" | "KEEP" | "REVISE";
  confirmed?: boolean;
  clarificationSelections?: readonly { readonly questionId: string; readonly optionId: string }[];
} {
  const trimmed = args.trim();
  const continuation = /^continue(?:\s+(build|keep|revise))?$/iu.exec(trimmed);
  if (continuation) return {
    action: "continue", ...(continuation[1] ? { choice: continuation[1].toUpperCase() as "BUILD" | "KEEP" | "REVISE" } : {}),
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
    ...(match?.[1] ? { topology: match[1].toUpperCase() as "SINGLE" | "MULTI" } : {}),
    ...(match?.[2] ? { intent: match[2].toUpperCase() as "PLAN" | "BUILD" } : {}),
    ...(match?.[3]?.trim() ? { objective: match[3].trim() } : {}),
  };
}

async function chooseEntry(args: string, ctx: ExtensionCommandContext) {
  const parsed = parseCommand(args);
  if (parsed.action) return {
    action: parsed.action,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    ...(parsed.choice ? { choice: parsed.choice } : {}),
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
  return { topology, intent, objective: objective.trim() } as const;
}

async function continuePlan(
  client: HostClient,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  explicitChoice?: "BUILD" | "KEEP" | "REVISE",
  suppliedReview?: HostStatus["plan_review"],
): Promise<unknown> {
  if (explicitChoice) return client.request("continue_plan", { choice: explicitChoice });
  if (!ctx.hasUI) throw new TypeError("Non-interactive Plan continuation requires: /coding continue <build|keep|revise>");
  const review = suppliedReview ?? ((await client.request("status", null, 2_000) as HostStatus).plan_review ?? null);
  const title = review
    ? `Frozen Plan\n${review.summary}\nArtifact: ${review.artifact_path}\nSHA-256: ${review.route_sha256}`
    : "Frozen Plan";
  const selected = await ctx.ui.select(title, [
    "[Recommended] Enter BUILD",
    "Keep plan only",
    "Revise technical route",
  ]);
  if (!selected) throw new TypeError("Plan continuation canceled");
  const choice = selected.startsWith("[Recommended]") ? "BUILD" : selected.startsWith("Keep") ? "KEEP" : "REVISE";
  return client.request("continue_plan", { choice });
}

export function registerCodingHarness(pi: ExtensionAPI, options: CodingHarnessBridgeOptions = {}): void {
  const packageRoot = options.packageRoot ?? defaultPackageRoot;
  const configPath = options.configPath ?? resolve(packageRoot, "config", "default.json");
  const hostEntryPath = options.hostEntryPath ?? resolve(packageRoot, "dist", "harness", "host", "entry.js");
  const dataRoot = options.dataRoot ?? "~/.pi/agent/coding-harness";
  const spawnHost = options.spawnHost ?? ((input: SpawnHostOptions): HostRpcClient => spawnCodingHarnessHost(input));
  let active: ActiveBridge | null = null;
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

  pi.registerTool({
    name: "coding_flow",
    label: "Advance Coding Harness",
    description: "Advance only the authority-backed next action. Normal validation auto-attests and auto-closes; status, attest, complete, and reconcile are recovery operations, not routine steps.",
    promptSnippet: "Follow next= from the latest result; do not poll status, probe PI_MODEL/PI_SESSION, or manually attest/complete normal validation",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("status") }, { additionalProperties: false, description: "Recovery inspection only; every transition result already includes compact status." }),
      Type.Object({ action: Type.Literal("submit_build"), contract: Type.Record(Type.String(), Type.Unknown()), route: Type.Record(Type.String(), Type.Unknown()) }, {
        additionalProperties: false,
        description: "Combined initial freeze only while phase=CONTRACTING before any Contract or Route exists; never use after next=SUBMIT_ROUTE or next=EXECUTE_WORK.",
      }),
      Type.Object({ action: Type.Literal("submit_contract"), contract: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("submit_route"), route: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("submit_route_revision"), patch: Type.Record(Type.String(), Type.Unknown()) }, {
        additionalProperties: false,
        description: "RouteRevision only after next=SUBMIT_ROUTE and a prior Route exists; submit replacement current/near WorkCells plus only changed metadata.",
      }),
      Type.Object({ action: Type.Literal("attest"), operation_id: Type.String(), obligation_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false, description: "Crash recovery only when a committed PASS Operation lacks its automatic attestation." }),
      Type.Object({ action: Type.Literal("complete") }, { additionalProperties: false, description: "Crash recovery only when authority explicitly remains at CLOSE_GOAL after evidence closure." }),
      Type.Object({ action: Type.Literal("reconcile"), operation_id: Type.Optional(Type.String()) }, { additionalProperties: false, description: "Use only for RECONCILE_OPERATION; omit operation_id to reconcile every unresolved Operation." }),
      Type.Object({ action: Type.Literal("control"), control: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("replan")]), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ]),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const bridge = required();
        if (params.action === "status") return accepted(compactStatus(await showStatus(ctx)));
        let result: unknown;
        if (params.action === "submit_build") result = await bridge.client.request("submit_build", controlled(bridge, { contract: params.contract, route: params.route }));
        else if (params.action === "submit_contract") result = await bridge.client.request("submit_contract", controlled(bridge, params.contract));
        else if (params.action === "submit_route") {
          result = await bridge.client.request("submit_route", controlled(bridge, params.route));
          const status = (result as { status?: HostStatus }).status;
          if (status?.flow?.nextAction === "PLAN_CONTINUATION" && ctx.hasUI) {
            result = await continuePlan(bridge.client, ctx, undefined, status.plan_review);
          }
        } else if (params.action === "submit_route_revision") {
          result = await bridge.client.request("submit_route_revision", controlled(bridge, params.patch));
        } else if (params.action === "attest") result = await bridge.client.request("attest", controlled(bridge, {
          operation_id: params.operation_id,
          ...(params.obligation_keys === undefined ? {} : { obligation_keys: params.obligation_keys }),
        }));
        else if (params.action === "complete") result = await bridge.client.request("complete", controlled(bridge));
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
    description: "Define the bounded dependency graph for Multi topology or execute the next authority-ready isolated worker shard.",
    promptSnippet: "Use only in Multi topology after the current WorkCell is authorized",
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

  pi.registerCommand("coding", {
    description: "Enter, inspect, or exit Pi Coding Harness",
    handler: async (args, ctx) => {
      const commandAction = parseCommand(args).action;
      try {
        const entry = await chooseEntry(args, ctx);
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
        if ("action" in entry && entry.action === "exit") {
          await deactivate();
          ctx.ui.setStatus("coding-harness", undefined);
          ctx.ui.setWidget("coding-harness", undefined);
          ctx.ui.notify("Coding Harness exited", "info");
          return;
        }
        if ("action" in entry) throw new TypeError("Unknown /coding action");
        if (active) {
          try { await active.client.request("status", null, 2_000); }
          catch { await deactivate(); }
        }
        if (active) throw new TypeError("Coding Harness is already active; use /coding status or /coding exit");
        if (!existsSync(hostEntryPath)) throw new TypeError("Coding Harness Host build is missing; run npm run build:runtime in the package root");
        const runtime = runtimeSelection(pi, ctx);
        const client = spawnHost({
          entryPath: hostEntryPath, cwd: ctx.cwd, packageRoot, configPath, dataRoot,
          timeoutMs: 8_000, maxPending: 32,
        });
        try {
          const status = await client.request("enter", {
            cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId(), objective: entry.objective,
            intent: entry.intent, topology: entry.topology, runtime,
          }) as HostStatus;
          active = {
            client, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), objective: entry.objective,
            sentSystemPrompts: new Set(), runtime,
            providerLifecycleEnabled: status.context?.provider_turn_ledger_enabled === true || status.cache?.configured === true,
            projectionLedger: new ProjectionDeltaLedger(`${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`),
            messageDescriptors: new WeakMap(),
            contextProjectionActive: false,
            managedToolCalls: new Set(), captureToolCalls: new Set(),
            contextRecoveryScanRequired: true, hasContextOverlays: false,
            cacheStartedAt: null, cacheResponseStatus: null,
            providerTurnStarted: false, providerBegin: null, providerTail: Promise.resolve(),
            toolObservationTail: Promise.resolve(),
            providerHistory: emptyProviderHistory, toolSchemaBytes: 0, lastStatusText: null,
            pendingStatusProjection: null, statusProjectionTimer: null,
            ui: status.ui ?? { widget: true, status: true, debounce_ms: 250, max_widget_lines: 4 },
            turnControlFrameSha256: null, agentRunSequence: 0,
            governorDirective: null, governorMessage: null, governorDecision: "CONTINUE",
            pendingClarifications: new Map(),
          };
          enableHarnessTools();
          setProjectedStatus(ctx, status);
          if (active.pendingClarifications.size > 0) {
            if (!ctx.hasUI) {
              ctx.ui.notify(`Recovered clarification choices. Run /coding clarify ${headlessClarificationChoices(active)}`, "info");
              return;
            }
            const selections: (BridgeClarificationDecision & { readonly selectedOptionId: string })[] = [];
            for (const decision of active.pendingClarifications.values()) {
              const labels = clarificationLabels(decision);
              const selected = await ctx.ui.select(`${decision.question}\n${decision.whyItMatters}`, labels);
              const index = selected === undefined ? -1 : labels.indexOf(selected);
              if (index < 0) break;
              selections.push({ ...decision, selectedOptionId: decision.options[index]!.id });
            }
            if (selections.length > 0) {
              const result = await active.client.request("clarify_selected", controlled(active, { decisions: selections }));
              for (const selection of selections) active.pendingClarifications.delete(selection.id);
              projectResultStatus(ctx, result);
              ctx.ui.notify(resultMessage(result), "info");
            }
            if (active.pendingClarifications.size > 0) {
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

  pi.on("session_start", () => removeHarnessTools());
  pi.on("input", (event) => {
    if (!active || event.source === "extension" || event.text.length > 16_384
      || !hasPotentialUserMemorySignal(event.text)) return;
    const bridge = active;
    const observation = bridge.client.request("memory_observe", { text: event.text, goal_intake: false }, 2_000)
      .then(() => undefined).catch(() => undefined);
    bridge.toolObservationTail = Promise.all([bridge.toolObservationTail, observation]).then(() => undefined);
    void observation;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!active) return;
    try {
      const systemPromptSha256 = sha256Hex(event.systemPrompt);
      const firstDelivery = !active.sentSystemPrompts.has(systemPromptSha256);
      const usage = ctx.getContextUsage();
      const activeToolNames = new Set(pi.getActiveTools());
      const allTools = pi.getAllTools();
      active.toolSchemaBytes = serializedBytes(allTools.filter((tool) => activeToolNames.has(tool.name)).map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
      })));
      const result = await active.client.request("turn_projection", {
        agent_run_id: `AGENT-RUN-${++active.agentRunSequence}-${sha256Hex(typeof event.prompt === "string" ? event.prompt : "").slice(0, 16)}`,
        system_prompt_sha256: systemPromptSha256,
        ...(firstDelivery ? { system_prompt: event.systemPrompt } : {}),
        current_input_tokens: usage?.tokens ?? null,
        active_tools: [...activeToolNames], all_tools: allTools.map((tool) => tool.name),
      }, 4_000) as {
        system_prompt: string; changed: boolean; context_projection_active: boolean;
        control_frame: { control_frame_sha256: string };
        generation_governor?: GenerationGovernorSnapshot;
      };
      active.contextProjectionActive = result.context_projection_active === true;
      active.turnControlFrameSha256 = result.control_frame.control_frame_sha256;
      active.governorDirective = result.generation_governor?.directive ?? null;
      active.governorMessage = makeGovernorMessage(active.governorDirective);
      active.governorDecision = result.generation_governor?.decision ?? "CONTINUE";
      if (firstDelivery) {
        active.sentSystemPrompts.add(systemPromptSha256);
        while (active.sentSystemPrompts.size > 2) active.sentSystemPrompts.delete(active.sentSystemPrompts.values().next().value!);
      }
      return result.changed ? { systemPrompt: result.system_prompt } : undefined;
    } catch (error) {
      ctx.ui.notify(`Coding Harness Host unavailable: ${error instanceof Error ? error.message : String(error)}. Managed tools are fail-closed.`, "error");
      return undefined;
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
      }, 2_000) as { recorded: boolean; cache_request_id: string | null };
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
