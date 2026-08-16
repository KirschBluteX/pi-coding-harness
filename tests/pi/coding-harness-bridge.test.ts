import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodingHarness } from "../../src/bridge/register.js";
import { SESSION_GOAL_BINDING_CUSTOM_TYPE } from "../../src/task-flow/session-binding.js";

function bindingMarker(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schema_version: 1 as const,
    binding_id: "GOAL_BINDING-1",
    goal_id: "GOAL-1",
    workspace_id: "WS-1",
    revision: 1,
    session_id: "SESSION-1",
    state: "BOUND" as const,
    auto_resume: true,
    goal_title: "Fixture Goal",
    binding_receipt_sha256: "a".repeat(64),
    ...overrides,
  };
}

function fixture() {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void }>();
  const tools: { name: string }[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["read", "write", "other_extension_tool", "coding_flow"];
  const sent: unknown[] = [];
  const entries: { readonly type: "custom"; readonly customType: string; readonly data: unknown }[] = [];
  const calls: { method: string; params: unknown }[] = [];
  let closed = 0;
  let contextProjectionActive = false;
  let generationTurnResult: { decision: string; directive: string | null } = { decision: "CONTINUE", directive: null };
  const status = {
    active: true, intent: "BUILD", topology: "SINGLE",
    flow: {
      goalId: "GOAL-1", objective: "fixture objective", mode: "BUILD", phase: "CONTRACTING",
      workCell: null, routeHealth: "H0_CONTINUE", nextAction: "SUBMIT_CONTRACT", blocker: null,
      unresolvedOperationIds: [],
    },
    harness: {
      runId: "RUN-1", status: "ACTIVE", nextReadyShardId: null,
      requestedTopology: "SINGLE", effectiveTopology: "SINGLE", topologyReasonCode: "REQUESTED_SINGLE",
      shards: [],
    },
    context: { provider_turn_ledger_enabled: true },
    presentation: {
      schema_version: 2 as const,
      presentation_state_code: "DEFINING_GOAL" as string,
      attention: "NONE" as const,
      primary_target: "WORK" as const,
      authority_event_sequence: 2,
      lifecycle: {
        revision: 1,
        current_stage: "CONTRACT" as string,
        steps: [
          { code: "INTAKE", state: "COMPLETE" }, { code: "CONTRACT", state: "ACTIVE" },
          { code: "PLAN", state: "PENDING" }, { code: "BUILD", state: "PENDING" },
          { code: "VERIFY", state: "PENDING" }, { code: "DELIVER", state: "PENDING" },
        ],
      },
    },
    current_work_cell: null,
    changed_files: [],
    control_frame: { control_frame_sha256: "d".repeat(64) },
    ui: { widget: true, status: true, debounce_ms: 250, max_widget_lines: 4 },
  };
  const client = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "turn_projection") return {
        system_prompt: "BASE\n\n[PI-CODING-HARNESS-V1]\nFollow the current authority state.",
        changed: true, context_projection_active: contextProjectionActive,
        control_frame: { control_frame_sha256: "c".repeat(64) },
        generation_governor: { decision: "CONTINUE", directive: null },
      };
      if (method === "context_project") {
        const delta = (params as { delta: { new_sequence_root: string; new_count: number } }).delta;
        return {
          changed: true,
          overlays: [{ insertionIndex: 1, message: { role: "custom", customType: "pch-input-context-v1", content: "bounded" } }],
          projection_ack: {
            accepted: true, reconcile_required: false,
            sequence_root: delta.new_sequence_root, count: delta.new_count,
          },
        };
      }
      if (method === "context_fetch") return { status: "OK", items: [], continuation: null, fallback: "NONE" };
      if (method === "provider_begin") {
        return { recorded: true, provider_attempt_id: "IC_ATTEMPT-BRIDGE-001", cache_request_id: null };
      }
      if (method === "provider_settle") return { ledger_sha256: "a".repeat(64), cache: null };
      if (method === "generation_turn") return generationTurnResult;
      if (method === "generation_settled") return { decision: "CONTINUE", directive: null };
      if (method === "discover_goals") {
        const binding = (status as typeof status & { session_binding?: ReturnType<typeof bindingMarker> }).session_binding ?? null;
        return {
          current_session_binding: binding,
          recoverable: binding ? [{
            goal_id: binding.goal_id,
            goal_title: binding.goal_title,
            objective: status.flow.objective,
            intent: "BUILD",
            status: status.flow.phase,
            next_action_code: status.flow.nextAction,
            binding_state: binding.state,
            controller_session_id: binding.session_id,
            controller_live: false,
            binding_receipt_sha256: binding.binding_receipt_sha256,
          }] : [],
        };
      }
      if (method === "status" || method === "enter") return status;
      if (method === "unbind_session") {
        const binding = (status as typeof status & { session_binding?: Record<string, unknown> }).session_binding;
        if (binding) {
          (status as typeof status & { session_binding?: Record<string, unknown> }).session_binding = {
            ...binding,
            revision: Number(binding.revision ?? 1) + 1,
            state: "UNBOUND",
            auto_resume: false,
            binding_receipt_sha256: "b".repeat(64),
          };
        }
        return status;
      }
      if (method === "rename_goal") {
        const binding = (status as typeof status & { session_binding?: Record<string, unknown> }).session_binding;
        if (binding) {
          (status as typeof status & { session_binding?: Record<string, unknown> }).session_binding = {
            ...binding,
            revision: Number(binding.revision ?? 1) + 1,
            goal_title: (params as { goal_title: string }).goal_title,
            binding_receipt_sha256: "c".repeat(64),
          };
        }
        return status;
      }
      if (method === "clarify_selected") {
        const selected = new Set(((params as { decisions?: readonly { id: string; selectedOptionId: string | null }[] }).decisions ?? [])
          .filter((decision) => decision.selectedOptionId !== null).map((decision) => decision.id));
        const open = (status as typeof status & { open_clarifications?: readonly { id: string }[] }).open_clarifications;
        return {
          message: "ok",
          status: { ...status, ...(open === undefined ? {} : { open_clarifications: open.filter((decision) => !selected.has(decision.id)) }) },
        };
      }
      if (method === "tool_preflight") {
        const toolName = (params as { toolName?: unknown }).toolName;
        return {
          allow: true, managed: toolName === "write" || toolName === "bash", capture: true, reason: null,
          ...(toolName === "bash" ? { oracle_policy: { timeout_ms: 120_000 } } : {}),
        };
      }
      return { message: "ok", status };
    },
    async close() { closed += 1; },
  };
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.push(tool),
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (value: string[]) => { activeTools = [...value]; },
    getAllTools: () => tools,
    getThinkingLevel: () => "high",
    sendUserMessage: (value: unknown) => sent.push(value),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  registerCodingHarness(pi, {
    packageRoot: "X:/package", configPath: "X:/package/config/default.json",
    hostEntryPath: import.meta.filename, dataRoot: "X:/data", spawnHost: () => client,
  });
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const statusWrites: { key: string; value: string | undefined }[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const widgetWrites: { key: string; value: string[] | undefined }[] = [];
  const ctx = {
    cwd: "X:/workspace", hasUI: true, mode: "tui",
    model: {
      provider: "geekspace", api: "openai-completions", baseUrl: "https://geekspace.cloud/v1",
      id: "user-selected-model", contextWindow: 100_000,
    }, thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 0.001 }),
    sessionManager: { getSessionId: () => "SESSION-1", getBranch: () => [...entries] },
    ui: {
      notify: (message: string) => notices.push(message), setStatus: (key: string, value: string | undefined) => {
        statuses.set(key, value); statusWrites.push({ key, value });
      },
      setWidget: (key: string, value: string[] | undefined) => {
        widgets.set(key, value); widgetWrites.push({ key, value });
      },
      select: async () => undefined, editor: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  return {
    commands, tools, handlers, sent, entries, calls, client, ctx, notices, statuses, statusWrites, widgets, widgetWrites, status,
    getActiveTools: () => activeTools, getClosed: () => closed,
    setContextProjectionActive: (value: boolean) => { contextProjectionActive = value; },
    setGenerationTurnResult: (value: { decision: string; directive: string | null }) => { generationTurnResult = value; },
  };
}

describe("passive Coding Harness Bridge", () => {
  it("performs no Host call or prompt injection before explicit entry", async () => {
    const f = fixture();
    expect(f.tools.map((tool) => tool.name)).toEqual(["coding_flow", "coding_clarify", "coding_delegate", "coding_context"]);
    expect([...f.commands.keys()]).toEqual(["memory", "coding"]);
    f.handlers.get("session_start")!({}, f.ctx as unknown as ExtensionContext);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
    f.handlers.get("input")!({ text: "remember nothing while inactive", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    const result = await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    expect(result).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("auto-attaches an exact same-session marker without starting a model turn", async () => {
    const f = fixture();
    const marker = bindingMarker();
    (f.status as typeof f.status & { session_binding: typeof marker }).session_binding = marker;
    f.entries.push({ type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker });

    await f.handlers.get("session_start")!({ reason: "resume" }, f.ctx as unknown as ExtensionContext);

    expect(f.calls).toEqual([expect.objectContaining({
      method: "enter",
      params: expect.objectContaining({
        entry_mode: "RESUME",
        session_id: "SESSION-1",
        binding_marker: marker,
      }),
    })]);
    expect(JSON.stringify(f.calls[0]?.params)).not.toContain("objective");
    expect(f.sent).toEqual([]);
    expect(f.entries).toHaveLength(1);
    expect(f.getActiveTools()).toContain("coding_flow");
    expect(f.statusWrites[0]).toEqual({ key: "coding-harness", value: "Coding Harness recovery validating" });
    expect(f.widgetWrites[0]).toEqual({ key: "coding-harness", value: ["Recovery Guard · validating Goal authority"] });
    expect(f.statuses.get("coding-harness")).toContain("DEFINING_GOAL");
    expect(f.widgets.get("coding-harness")?.[0]).toBe("Goal: Fixture Goal");
  });

  it("keeps Recovery Guard fail-closed when authority attach fails", async () => {
    const f = fixture();
    const marker = bindingMarker();
    f.entries.push({ type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker });
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    mutable.request = async (method, params) => {
      if (method === "enter") throw new Error("authority marker mismatch");
      return original(method, params);
    };

    await f.handlers.get("session_start")!({ reason: "resume" }, f.ctx as unknown as ExtensionContext);

    expect(f.statusWrites.map((entry) => entry.value)).toEqual([
      "Coding Harness recovery validating",
      "Coding Harness recovery blocked",
    ]);
    expect(f.widgets.get("coding-harness")).toBeUndefined();
    expect(f.handlers.get("input")!({ text: "ordinary model input", source: "interactive" }, f.ctx as unknown as ExtensionContext))
      .toEqual({ action: "handled" });
    expect(f.sent).toEqual([]);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
  });

  it("opens the Goal hub and restores its authority marker without sending the objective", async () => {
    const f = fixture();
    const marker = bindingMarker();
    (f.status as typeof f.status & { session_binding: typeof marker }).session_binding = marker;
    (f.ctx.ui as unknown as { select(title: string, choices: string[]): Promise<string | undefined> }).select = async (_title, choices) => choices[0];

    await f.commands.get("coding")!.handler("", f.ctx);

    expect(f.calls.map((call) => call.method).slice(0, 2)).toEqual(["discover_goals", "enter"]);
    expect(f.calls.find((call) => call.method === "enter")?.params).toMatchObject({
      entry_mode: "RESUME",
      binding_marker: marker,
    });
    expect(f.sent).toEqual([]);
    expect(f.entries).toEqual([{ type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker }]);
  });

  it("requires an explicit recover command before transferring an idle Goal", async () => {
    const f = fixture();
    const transferred = bindingMarker({
      binding_id: "GOAL_BINDING-2-TRANSFER",
      goal_id: "GOAL-2",
      revision: 2,
      goal_title: "Transferred Goal",
      binding_receipt_sha256: "d".repeat(64),
    });
    f.status.flow.goalId = "GOAL-2";
    (f.status as typeof f.status & { session_binding: typeof transferred }).session_binding = transferred;
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    mutable.request = async (method, params) => {
      if (method === "discover_goals") {
        f.calls.push({ method, params });
        return {
          current_session_binding: null,
          recoverable: [{
            goal_id: "GOAL-2",
            goal_title: "Transferred Goal",
            objective: "fixture objective",
            intent: "BUILD",
            status: "CONTRACTING",
            next_action_code: "SUBMIT_CONTRACT",
            binding_state: "BOUND",
            controller_session_id: "SESSION-OTHER",
            controller_live: false,
            binding_receipt_sha256: "e".repeat(64),
          }],
        };
      }
      return original(method, params);
    };
    (f.ctx.ui as unknown as { confirm(title: string, message: string): Promise<boolean> }).confirm = async () => true;

    await f.commands.get("coding")!.handler("recover GOAL-2", f.ctx);

    expect(f.calls.find((call) => call.method === "enter")?.params).toMatchObject({
      entry_mode: "RECOVER",
      goal_id: "GOAL-2",
      allow_transfer: true,
    });
    expect(f.sent).toEqual([]);
    expect(f.entries.at(-1)?.data).toMatchObject({ goal_id: "GOAL-2", session_id: "SESSION-1" });
  });

  it("recovers an explicitly selected legacy Goal with no binding receipt", async () => {
    const f = fixture();
    const marker = bindingMarker({
      binding_id: "GOAL_BINDING-LEGACY-FIRST",
      goal_id: "GOAL-LEGACY-UNBOUND",
      goal_title: "Legacy unbound Goal",
      binding_receipt_sha256: "f".repeat(64),
    });
    f.status.flow.goalId = marker.goal_id;
    (f.status as typeof f.status & { session_binding: typeof marker }).session_binding = marker;
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    mutable.request = async (method, params) => {
      if (method === "discover_goals") {
        f.calls.push({ method, params });
        return {
          current_session_binding: null,
          recoverable: [{
            goal_id: marker.goal_id,
            goal_title: marker.goal_title,
            objective: "fixture objective",
            intent: "BUILD",
            status: "CONTRACTING",
            next_action_code: "SUBMIT_CONTRACT",
            binding_state: "UNBOUND",
            controller_session_id: null,
            controller_live: false,
            binding_receipt_sha256: null,
          }],
        };
      }
      return original(method, params);
    };

    await f.commands.get("coding")!.handler(`recover ${marker.goal_id}`, f.ctx);

    expect(f.calls.find((call) => call.method === "enter")?.params).toMatchObject({
      entry_mode: "RECOVER",
      goal_id: marker.goal_id,
      allow_transfer: false,
    });
    expect(f.sent).toEqual([]);
    expect(f.entries.at(-1)?.data).toMatchObject({
      goal_id: marker.goal_id,
      revision: 1,
      session_id: "SESSION-1",
      state: "BOUND",
    });
  });

  it("ignores a fork-inherited marker from another session", async () => {
    const f = fixture();
    const marker = bindingMarker({ session_id: "SESSION-PARENT" });
    f.entries.push({ type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker });

    await f.handlers.get("session_start")!({ reason: "fork" }, f.ctx as unknown as ExtensionContext);

    expect(f.calls).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
  });

  it("blocks ordinary input when a same-branch marker or authority resume is invalid", async () => {
    const invalid = fixture();
    invalid.entries.push({
      type: "custom",
      customType: SESSION_GOAL_BINDING_CUSTOM_TYPE,
      data: { schema_version: 1, session_id: "SESSION-1", state: "BOUND" },
    });
    await invalid.handlers.get("session_start")!({ reason: "resume" }, invalid.ctx as unknown as ExtensionContext);
    expect(invalid.calls).toEqual([]);
    expect(invalid.handlers.get("input")!({
      text: "Do not silently start a normal model turn", source: "interactive",
    }, invalid.ctx as unknown as ExtensionContext)).toEqual({ action: "handled" });

    const failed = fixture();
    const marker = bindingMarker();
    (failed.status as typeof failed.status & { session_binding: typeof marker }).session_binding = marker;
    failed.entries.push({ type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker });
    const mutable = failed.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    mutable.request = async (method, params) => {
      failed.calls.push({ method, params });
      if (method === "enter") throw new Error("authority marker mismatch");
      return failed.status;
    };
    await failed.handlers.get("session_start")!({ reason: "resume" }, failed.ctx as unknown as ExtensionContext);
    expect(failed.handlers.get("input")!({
      text: "Still do not start a model turn", source: "interactive",
    }, failed.ctx as unknown as ExtensionContext)).toEqual({ action: "handled" });
    expect(failed.sent).toEqual([]);
    expect(failed.getClosed()).toBe(1);
  });

  it("persists binding projections and makes /coding exit append an authority-backed UNBOUND marker", async () => {
    const f = fixture();
    const marker = bindingMarker();
    (f.status as typeof f.status & { session_binding: Record<string, unknown> }).session_binding = marker;

    await f.commands.get("coding")!.handler("new single build implement the bounded change", f.ctx);
    expect(f.entries).toEqual([
      { type: "custom", customType: SESSION_GOAL_BINDING_CUSTOM_TYPE, data: marker },
    ]);
    await f.commands.get("coding")!.handler("exit", f.ctx);
    expect(f.calls.some((call) => call.method === "unbind_session")).toBe(true);
    expect(f.entries).toHaveLength(2);
    expect(f.entries[1]?.data).toMatchObject({ state: "UNBOUND", auto_resume: false, revision: 2 });
  });

  it("starts lazily, injects one workflow prompt, and preserves unrelated tool changes on exit", async () => {
    const f = fixture();
    f.handlers.get("session_start")!({}, f.ctx as unknown as ExtensionContext);
    await f.commands.get("coding")!.handler("single build implement the bounded change", f.ctx);
    expect(f.calls[0]?.method).toBe("enter");
    expect(f.calls[0]?.params).toMatchObject({ runtime: {
      provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1",
      model: "user-selected-model", thinking_level: "high", context_window: 100_000,
    } });
    expect(f.sent).toEqual(["implement the bounded change"]);
    expect(f.statuses.get("coding-harness")).toBe("Coding Harness DEFINING_GOAL goal=\"fixture objective\"");
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool", "coding_flow", "coding_clarify", "coding_delegate", "coding_context"]);
    const memoryCalls = () => f.calls.filter((call) => call.method === "memory_observe").length;
    const activeGoalInputCalls = () => f.calls.filter((call) => call.method === "active_goal_input").length;
    f.handlers.get("input")!({ text: "continue the ordinary task", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    await Promise.resolve();
    expect(activeGoalInputCalls()).toBe(1);
    expect(memoryCalls()).toBe(0);
    f.handlers.get("input")!({ text: "remember that I prefer the local test", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    const projected = await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext) as { systemPrompt: string };
    expect(activeGoalInputCalls()).toBe(2);
    expect(memoryCalls()).toBe(0);
    await f.commands.get("memory")!.handler("status", f.ctx);
    expect(f.calls.some((call) => call.method === "memory_command")).toBe(true);
    expect(projected.systemPrompt).toContain("[PI-CODING-HARNESS-V1]");
    expect(projected.systemPrompt).toContain("Follow the current authority state.");
    await f.commands.get("coding")!.handler("exit", f.ctx);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
    expect(f.getClosed()).toBe(1);
  });

  it("captures active-Goal input before projecting the Agent turn", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build protect mid-task changes", f.ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mutable.request = async (method, params) => {
      if (method === "active_goal_input") {
        f.calls.push({ method, params });
        await pending;
        return { captured: true };
      }
      return original(method, params);
    };
    f.calls.length = 0;

    f.handlers.get("input")!({ text: "Also preserve the adjacent parser.", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    const projecting = f.handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "Also preserve the adjacent parser." }, f.ctx as unknown as ExtensionContext) as Promise<unknown>;
    await Promise.resolve();
    expect(f.calls.map((call) => call.method)).toEqual(["active_goal_input"]);
    release();
    await projecting;
    expect(f.calls.map((call) => call.method)).toEqual(["active_goal_input", "turn_projection"]);
    expect(f.calls[0]!.params).toEqual({ text: "Also preserve the adjacent parser." });
  });

  it("fails closed for one active-Goal capture attempt and recovers the capture queue", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build protect captured authority", f.ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    let rejectCapture = true;
    mutable.request = async (method, params) => {
      if (method === "active_goal_input") {
        f.calls.push({ method, params });
        if (rejectCapture) throw new Error("active Goal capture failed");
        return { captured: true };
      }
      return original(method, params);
    };
    f.calls.length = 0;

    f.handlers.get("input")!({ text: "First captured correction.", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    await expect(f.handlers.get("before_agent_start")!({
      systemPrompt: "BASE", prompt: "First captured correction.",
    }, f.ctx as unknown as ExtensionContext)).rejects.toThrow("active Goal capture failed");
    expect(f.calls.map((call) => call.method)).toEqual(["active_goal_input"]);

    rejectCapture = false;
    f.handlers.get("input")!({ text: "Second captured correction.", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    await expect(f.handlers.get("before_agent_start")!({
      systemPrompt: "BASE", prompt: "Second captured correction.",
    }, f.ctx as unknown as ExtensionContext)).resolves.toEqual(expect.objectContaining({
      systemPrompt: expect.stringContaining("[PI-CODING-HARNESS-V1]"),
    }));
    expect(f.calls.map((call) => call.method)).toEqual([
      "active_goal_input", "active_goal_input", "turn_projection",
    ]);
    expect(f.calls[1]!.params).toEqual({ text: "Second captured correction." });
  });

  it("restarts a failed Host when the same explicit entry is repeated", async () => {
    const f = fixture();
    const command = "single build recover the interrupted goal";
    await f.commands.get("coding")!.handler(command, f.ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    let failStatus = true;
    mutable.request = async (method, params) => {
      if (method === "status" && failStatus) {
        failStatus = false;
        throw new Error("Coding Harness Host exited");
      }
      return original(method, params);
    };
    await f.commands.get("coding")!.handler(command, f.ctx);
    expect(f.calls.filter((call) => call.method === "enter")).toHaveLength(2);
    expect(f.getClosed()).toBe(1);
    expect(f.notices.join("\n")).not.toMatch(/already active/u);
  });

  it("skips inactive Context IPC and sends only a compact message spine when projection is active", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build optimize context transport", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const large = { role: "user", content: "x".repeat(100_000) };
    expect(await f.handlers.get("context")!({ messages: [large] }, f.ctx as unknown as ExtensionContext)).toBeUndefined();
    expect(f.calls.some((call) => call.method === "context_project")).toBe(false);

    f.setContextProjectionActive(true);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const result = await f.handlers.get("context")!({ messages: [large] }, f.ctx as unknown as ExtensionContext) as { messages: unknown[] };
    const call = f.calls.findLast((item) => item.method === "context_project");
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      delta: {
        full_reconcile: true,
        append: [{ content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), role: "user", custom_type: null }],
        previous_count: 0, new_count: 1,
      },
      removed_persisted_messages: 0,
    });
    expect(JSON.stringify(call?.params)).not.toContain("x".repeat(1_000));
    expect(result.messages).toEqual([
      large, { role: "custom", customType: "pch-input-context-v1", content: "bounded" },
    ]);
    const next = { role: "assistant", content: "done" };
    await f.handlers.get("context")!({ messages: [large, next] }, f.ctx as unknown as ExtensionContext);
    expect(f.calls.findLast((item) => item.method === "context_project")?.params).toMatchObject({
      delta: { full_reconcile: false, previous_count: 1, new_count: 2, append: [{ role: "assistant" }] },
    });
  });

  it("uses blocking preflight for dispatch and omits redundant lifecycle IPC", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build optimize tool transport", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    f.calls.length = 0;
    await f.handlers.get("tool_call")!({ toolCallId: "READ-1", toolName: "read", input: { path: "src/a.ts" } }, f.ctx);
    await f.handlers.get("tool_result")!({
      toolCallId: "READ-1", toolName: "read", input: { path: "src/a.ts" }, isError: false,
      content: [{ type: "text", text: "content" }],
    });
    await Promise.resolve();
    await f.handlers.get("tool_execution_end")!({ toolCallId: "READ-1", toolName: "read", isError: false, result: "content" });
    expect(f.calls.map((call) => call.method)).toEqual(["tool_preflight", "tool_result"]);

    f.calls.length = 0;
    await f.handlers.get("tool_call")!({ toolCallId: "WRITE-1", toolName: "write", input: { path: "src/a.ts", content: "next" } }, f.ctx);
    const writeResult = await f.handlers.get("tool_result")!({
      toolCallId: "WRITE-1", toolName: "write", input: { path: "src/a.ts", content: "next" }, isError: false,
      content: [{ type: "text", text: "wrote" }],
    });
    await f.handlers.get("tool_execution_end")!({ toolCallId: "WRITE-1", toolName: "write", isError: false, result: "wrote" });
    expect(f.calls.map((call) => call.method)).toEqual(["tool_preflight", "tool_result"]);
    expect(f.calls.at(-1)?.params).toMatchObject({ output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(writeResult).toBeUndefined();
  });

  it("exposes deferred Input Context through a bounded Harness tool", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build retrieve deferred evidence", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_context") as unknown as {
      execute(id: string, params: unknown): Promise<{ content: readonly { text?: string }[] }>;
    };
    const result = await tool.execute("CTX-1", { selector: "CURRENT_ON_DEMAND", representation: "EXACT" });
    expect(f.calls.at(-1)).toMatchObject({
      method: "context_fetch",
      params: { selector: "CURRENT_ON_DEMAND", control_frame_sha256: "c".repeat(64) },
    });
    expect(result.content[0]?.text).toContain('"status":"OK"');
  });

  it("returns only the authority next-action delta instead of duplicating Widget status", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build keep transition output compact", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown): Promise<{ content: readonly { text?: string }[] }>;
    };
    const result = await tool.execute("FLOW-1", { action: "complete" });
    expect(result.content[0]?.text).toBe("ok\nnext=SUBMIT_CONTRACT");
    expect(result.content[0]?.text).not.toContain("phase=");
  });

  it("forwards structured outcome evidence only on explicit completion", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build preserve multiple consumers", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown): Promise<unknown>;
    };
    const outcomeEvidence = [{
      obligation_key: "browser-clients", operation_id: "OPERATION-1",
      witnesses: [{ path: "tests/browser.test.ts", locator: "browser clients retain behavior" }],
    }];
    await tool.execute("FLOW-EVIDENCE", { action: "complete", outcome_evidence: outcomeEvidence });
    expect(f.calls.findLast((call) => call.method === "complete")?.params).toEqual({
      outcome_evidence: outcomeEvidence, control_frame_sha256: "c".repeat(64),
    });
    expect(JSON.stringify((f.tools.find((entry) => entry.name === "coding_flow") as unknown as { parameters: unknown }).parameters))
      .toContain("OutcomeEvidenceRequired");
  });

  it("refreshes the ControlFrame after a same-turn authority transition", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build advance twice", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    await tool.execute("FLOW-CONTRACT", { action: "submit_contract", contract: {} }, undefined, undefined, f.ctx);
    await tool.execute("FLOW-ROUTE", { action: "submit_route", route: {} }, undefined, undefined, f.ctx);
    expect(f.calls.find((call) => call.method === "submit_contract")?.params).toMatchObject({
      control_frame_sha256: "c".repeat(64),
    });
    expect(f.calls.find((call) => call.method === "submit_route")?.params).toMatchObject({
      control_frame_sha256: "d".repeat(64),
    });
  });

  it("does not expose combined build or USER review authority to the model-visible tool", () => {
    const f = fixture();
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as { parameters: unknown };
    expect(JSON.stringify(tool.parameters)).not.toContain("submit_build");
    expect(JSON.stringify(tool.parameters)).not.toContain("resolve_contract_review");
  });

  it("submits only typed active-Goal classification fields through the current ControlFrame", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build classify a mid-task turn", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    await tool.execute("FLOW-CLASSIFY", {
      action: "classify_active_input",
      user_turn_id: "USER_TURN-1",
      expected_user_turn_sha256: "a".repeat(64),
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
    }, undefined, undefined, f.ctx);
    expect(f.calls.find((call) => call.method === "classify_active_goal_input")?.params).toEqual({
      user_turn_id: "USER_TURN-1",
      expected_user_turn_sha256: "a".repeat(64),
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
      control_frame_sha256: "c".repeat(64),
    });
  });

  it("captures interactive Contract approval through the Host-only review method", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build review the contract", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const review = {
      decision_requirement_revision_id: "DECISION-REVISION-1",
      requirement_revision_sha256: "a".repeat(64),
      decision_frontier_sha256: "b".repeat(64),
      contract_diff: { scope: { before: null, after: ["src/example.ts"] } },
      requirement_diff: { fromRevisionId: null, toRevisionId: "REQUIREMENT-REVISION-1", added: [], changed: [], removed: [] },
    };
    (f.status as typeof f.status & { contract_review?: typeof review }).contract_review = review;
    f.status.flow.phase = "WAITING_USER";
    f.status.flow.nextAction = "REVIEW_CONTRACT";
    (f.ctx.ui as unknown as { select: () => Promise<string> }).select = async () => "[Recommended] Approve Goal Contract";
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    await tool.execute("FLOW-CONTRACT-REVIEW", { action: "submit_contract", contract: {} }, undefined, undefined, f.ctx);
    expect(f.calls.findLast((call) => call.method === "resolve_contract_review")?.params).toEqual({
      expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
      expected_requirement_revision_sha256: review.requirement_revision_sha256,
      expected_decision_frontier_sha256: review.decision_frontier_sha256,
      action: "APPROVE",
      selected_value: true,
    });
  });

  it("keeps irreversible cancel out of the model-visible control tool", () => {
    const f = fixture();
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as { parameters: unknown };
    expect(JSON.stringify(tool.parameters)).not.toContain('"const":"cancel"');
  });

  it("shows the frozen Plan summary before applying the interactive continuation", async () => {
    const f = fixture();
    const status = await f.client.request("status", null) as {
      flow: { nextAction: string };
      plan_review?: {
        summary: string; artifact_path: string; route_sha256: string;
        plan_revision_sha256: string; stage_gate_sha256: string;
      };
    };
    status.flow.nextAction = "PLAN_CONTINUATION";
    status.plan_review = {
      summary: "Goal GOAL-1\n[READY] bounded-change",
      artifact_path: "X:/workspace/.coding-harness/task-flow/route-skeleton.ROUTE-1.md",
      route_sha256: "a".repeat(64),
      plan_revision_sha256: "b".repeat(64),
      stage_gate_sha256: "c".repeat(64),
    };
    let title = "";
    (f.ctx.ui as unknown as { select: (value: string, options: string[]) => Promise<string | undefined> }).select = async (value) => {
      title = value;
      return "Keep plan only";
    };
    await f.commands.get("coding")!.handler("single plan review the bounded route", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    await tool.execute("FLOW-PLAN", { action: "submit_route", route: {} }, undefined, undefined, f.ctx);
    expect(title).toContain("[READY] bounded-change");
    expect(title).toContain("route-skeleton.ROUTE-1.md");
    expect(f.calls.findLast((call) => call.method === "continue_plan")?.params).toEqual({
      control_frame_sha256: "d".repeat(64),
      expected_route_sha256: "a".repeat(64),
      expected_plan_revision_sha256: "b".repeat(64),
      expected_stage_gate_sha256: "c".repeat(64),
      choice: "KEEP",
    });
  });

  it("refreshes the ControlFrame across managed tool prepare, dispatch, and commit", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build execute two writes", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const mutableClient = f.client as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    };
    const request = mutableClient.request.bind(mutableClient);
    mutableClient.request = async (method: string, params: unknown) => {
      const result = await request(method, params) as Record<string, unknown>;
      if (method === "tool_preflight") return { ...result, control_frame: { control_frame_sha256: "e".repeat(64) } };
      if (method === "tool_result") return {
        operation_id: "OPERATION-1", control_frame: { control_frame_sha256: "f".repeat(64) },
      };
      return result;
    };
    const first = { toolCallId: "WRITE-1", toolName: "write", input: { path: "src/a.ts", content: "first" } };
    await f.handlers.get("tool_call")!(first, f.ctx);
    await f.handlers.get("tool_result")!({ ...first, isError: false, content: [{ type: "text", text: "wrote" }] });
    const second = { toolCallId: "WRITE-2", toolName: "write", input: { path: "src/b.ts", content: "second" } };
    await f.handlers.get("tool_call")!(second, f.ctx);
    const preflights = f.calls.filter((call) => call.method === "tool_preflight");
    expect(preflights[0]?.params).toMatchObject({ control_frame_sha256: "c".repeat(64) });
    expect(preflights[1]?.params).toMatchObject({ control_frame_sha256: "f".repeat(64) });
  });

  it("applies the Host Oracle timeout before Pi executes a validation command", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build validate with a bounded oracle", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const input: { command: string; timeout?: number } = { command: "npm test", timeout: 1_200 };
    const result = await f.handlers.get("tool_call")!({
      toolCallId: "VALIDATE-BOUNDED", toolName: "bash", input,
    }, f.ctx);
    expect(result).toBeUndefined();
    expect(input.timeout).toBe(120);
  });

  it("omits absent optional flow parameters instead of sending non-canonical undefined values", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build recover operations", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    f.calls.length = 0;
    await tool.execute("FLOW-1", { action: "reconcile" }, undefined, undefined, f.ctx);
    expect(f.calls.find((call) => call.method === "reconcile")?.params).toEqual({ control_frame_sha256: "c".repeat(64) });
    await tool.execute("FLOW-2", { action: "attest", operation_id: "OPERATION-1" }, undefined, undefined, f.ctx);
    expect(f.calls.findLast((call) => call.method === "attest")?.params).toEqual({
      operation_id: "OPERATION-1", control_frame_sha256: "d".repeat(64),
    });
  });

  it("projects transition status without a status IPC and deduplicates identical Widget text", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build avoid redundant status traffic", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    f.calls.length = 0;
    const writesBefore = f.statusWrites.length;
    await tool.execute("FLOW-STATUS", { action: "submit_contract", contract: {} }, undefined, undefined, f.ctx);
    expect(f.calls.map((call) => call.method)).toEqual(["submit_contract"]);
    expect(f.statusWrites).toHaveLength(writesBefore);
  });

  it("honors Host-projected UI switches, widget line bounds, and debounce", async () => {
    const f = fixture();
    f.status.ui = { widget: true, status: false, debounce_ms: 50, max_widget_lines: 2 };
    await f.commands.get("coding")!.handler("single build honor UI configuration", f.ctx);
    expect(f.statuses.get("coding-harness")).toBeUndefined();
    expect(f.widgets.get("coding-harness")).toEqual([
      "Goal: fixture objective",
      "DEFINING_GOAL · CONTRACT r1",
    ]);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    const writesBefore = f.widgetWrites.length;
    f.status.flow.phase = "PLANNING";
    f.status.presentation.presentation_state_code = "PLANNING";
    f.status.presentation.lifecycle.current_stage = "PLAN";
    await tool.execute("FLOW-UI", { action: "submit_contract", contract: {} }, undefined, undefined, f.ctx);
    expect(f.widgetWrites).toHaveLength(writesBefore);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(f.widgetWrites).toHaveLength(writesBefore + 1);
    expect(f.widgets.get("coding-harness")?.[1]).toContain("PLANNING");
  });

  it("routes pause, resume, replan, and confirmed cancel through the local Host", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build exercise local controls", f.ctx);
    f.calls.length = 0;

    await f.commands.get("coding")!.handler("pause", f.ctx);
    await f.commands.get("coding")!.handler("resume", f.ctx);
    await f.commands.get("coding")!.handler("replan invalidated API assumption", f.ctx);
    (f.ctx.ui as { select: (title: string, options: string[]) => Promise<string | undefined> }).select = async (_title, options) => options[1];
    await f.commands.get("coding")!.handler("cancel", f.ctx);

    expect(f.calls.filter((call) => call.method === "control").map((call) => call.params)).toEqual([
      { action: "pause" },
      { action: "resume" },
      { action: "replan", reason: "invalidated API assumption" },
      { action: "cancel" },
    ]);
  });

  it("supports explicit non-interactive Plan continuation and cancel confirmation", async () => {
    const f = fixture();
    (f.status as typeof f.status & { plan_review?: {
      summary: string; artifact_path: string; route_sha256: string;
      plan_revision_sha256: string; stage_gate_sha256: string;
    } }).plan_review = {
      summary: "Frozen bounded route", artifact_path: "X:/workspace/route.md",
      route_sha256: "a".repeat(64), plan_revision_sha256: "b".repeat(64), stage_gate_sha256: "c".repeat(64),
    };
    const ctx = { ...f.ctx, hasUI: false } as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single plan automate the bounded route", ctx);
    f.calls.length = 0;
    await f.commands.get("coding")!.handler("continue keep", ctx);
    await f.commands.get("coding")!.handler("cancel", ctx);
    expect(f.calls.some((call) => call.method === "control")).toBe(false);
    expect(f.notices.at(-1)).toMatch(/cancel command failed.*--confirm/u);
    await f.commands.get("coding")!.handler("cancel --confirm superseded objective", ctx);
    expect(f.calls.findLast((call) => call.method === "continue_plan")?.params).toEqual({
      control_frame_sha256: "d".repeat(64), expected_route_sha256: "a".repeat(64),
      expected_plan_revision_sha256: "b".repeat(64), expected_stage_gate_sha256: "c".repeat(64), choice: "KEEP",
    });
    expect(f.calls.findLast((call) => call.method === "control")?.params).toEqual({
      action: "cancel", reason: "superseded objective",
    });
  });

  it("persists headless clarification questions and resolves only an explicit slash-command choice", async () => {
    const f = fixture();
    const ctx = { ...f.ctx, hasUI: false } as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single build resolve a headless decision", ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    const responseFrames = ["e".repeat(64), "f".repeat(64), "a".repeat(64)];
    mutable.request = async (method, params) => {
      if (method !== "clarify_selected") return original(method, params);
      f.calls.push({ method, params });
      return {
        message: "ok",
        status: { ...f.status, control_frame: { control_frame_sha256: responseFrames.shift() } },
      };
    };
    const tool = f.tools.find((entry) => entry.name === "coding_clarify") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, context: ExtensionCommandContext): Promise<unknown>;
    };
    f.calls.length = 0;
    await tool.execute("CLARIFY-HEADLESS", { questions: [
      {
        id: "FORMAT", question: "Which output format?", why_it_matters: "It changes the public contract",
        change_kind: "BEHAVIOR", materiality: "HIGH", reversible: false, privacy_related: false,
        options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
        recommended_option_id: "json", recommendation_reason: "Stable schema",
      },
      {
        id: "COMPAT", question: "Which compatibility policy?", why_it_matters: "It changes accepted inputs",
        change_kind: "BEHAVIOR", materiality: "HIGH", reversible: false, privacy_related: false,
        options: [{ id: "strict", label: "Strict", impact: "Reject legacy inputs" }, { id: "legacy", label: "Legacy", impact: "Accept legacy inputs" }],
        recommended_option_id: "strict", recommendation_reason: "One public contract",
      },
    ] }, undefined, undefined, ctx);
    await f.commands.get("coding")!.handler("clarify FORMAT=json,COMPAT=strict", ctx);
    expect(f.calls.filter((call) => call.method === "clarify_selected").map((call) => call.params)).toMatchObject([
      { decisions: [{ id: "FORMAT", selectedOptionId: null }], control_frame_sha256: "d".repeat(64) },
      { decisions: [{ id: "COMPAT", selectedOptionId: null }], control_frame_sha256: "e".repeat(64) },
      {
        decisions: [{ id: "FORMAT", selectedOptionId: "json" }, { id: "COMPAT", selectedOptionId: "strict" }],
        control_frame_sha256: "f".repeat(64),
      },
    ]);
  });

  it("restores headless clarification choices from Host authority after Bridge restart", async () => {
    const f = fixture();
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    (f.status as typeof f.status & { open_clarifications: readonly typeof decision[] }).open_clarifications = [decision];
    const ctx = { ...f.ctx, hasUI: false } as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single build recover a headless decision", ctx);
    expect(f.sent).toEqual([]);
    f.calls.length = 0;
    await f.commands.get("coding")!.handler("clarify FORMAT=json", ctx);
    expect(f.calls.findLast((call) => call.method === "clarify_selected")?.params).toMatchObject({
      decisions: [{ id: "FORMAT", selectedOptionId: "json" }],
    });
    expect(f.sent).toEqual(["fixture objective"]);
    expect(f.notices.some((notice) => /Recovered clarification.*FORMAT=<json\|text>/u.test(notice))).toBe(true);
  });

  it("resolves recovered interactive clarification locally before starting one productive model turn", async () => {
    const f = fixture();
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    (f.status as typeof f.status & { open_clarifications: readonly typeof decision[] }).open_clarifications = [decision];
    const prompts: string[] = [];
    const ctx = {
      ...f.ctx,
      ui: {
        ...f.ctx.ui,
        select: async (prompt: string, options: string[]) => {
          prompts.push(prompt);
          return options[0];
        },
      },
    } as unknown as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single build resume after a durable choice", ctx);
    expect(prompts).toEqual(["Which output format?\nIt changes the public contract"]);
    expect(f.calls.findLast((call) => call.method === "clarify_selected")?.params).toMatchObject({
      decisions: [{ id: "FORMAT", selectedOptionId: "json" }],
    });
    expect(f.sent).toEqual(["resume after a durable choice"]);
  });

  it("keeps a canceled recovered clarification pending without starting a model turn", async () => {
    const f = fixture();
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    (f.status as typeof f.status & { open_clarifications: readonly typeof decision[] }).open_clarifications = [decision];
    await f.commands.get("coding")!.handler("single build wait for an explicit choice", f.ctx);
    expect(f.calls.some((call) => call.method === "clarify_selected")).toBe(false);
    expect(f.sent).toEqual([]);
    expect(f.notices.some((notice) => /remains pending.*will not start a model turn/u.test(notice))).toBe(true);
  });

  it("deactivates cleanly when recovered clarification submission fails", async () => {
    const f = fixture();
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    (f.status as typeof f.status & { open_clarifications: readonly typeof decision[] }).open_clarifications = [decision];
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    mutable.request = async (method, params) => {
      if (method === "clarify_selected") throw new Error("clarification write failed");
      return original(method, params);
    };
    const ctx = {
      ...f.ctx,
      ui: { ...f.ctx.ui, select: async (_prompt: string, options: string[]) => options[0] },
    } as unknown as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single build preserve recovery after failure", ctx);
    expect(f.sent).toEqual([]);
    expect(f.getClosed()).toBe(1);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
    expect(f.notices.at(-1)).toMatch(/entry failed.*clarification write failed/u);
  });

  it("polls Multi workers without occupying the Host long-poll lane", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("multi build execute independent shards", f.ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    mutable.request = async (method, params) => {
      if (method === "worker_start") { f.calls.push({ method, params }); return { job_id: "WORKER-JOB-1", state: "RUNNING", worker_count: 1 }; }
      if (method === "worker_poll") {
        f.calls.push({ method, params });
        return { job_id: "WORKER-JOB-1", state: "SUCCEEDED", result: [], error: null, worker_count: 1, elapsed_ms: 10 };
      }
      return original(method, params);
    };
    const tool = f.tools.find((entry) => entry.name === "coding_delegate") as unknown as {
      execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    f.calls.length = 0;
    await tool.execute("DELEGATE-POLL", { action: "run_ready", max_parallel: 1 }, undefined, undefined, f.ctx);
    expect(f.calls.map((call) => call.method)).toContain("worker_poll");
    expect(f.calls.map((call) => call.method)).not.toContain("worker_wait");
  });

  it("waits for pending Memory observation before closing the Host", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build flush local observations", f.ctx);
    const mutable = f.client as unknown as { request(method: string, params: unknown): Promise<unknown> };
    const original = mutable.request.bind(mutable);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mutable.request = async (method, params) => {
      if (method === "memory_observe") { await pending; return { observed: true }; }
      return original(method, params);
    };
    f.handlers.get("input")!({ text: "remember that local verification is required", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    const exiting = f.commands.get("coding")!.handler("exit", f.ctx) as Promise<void>;
    await Promise.resolve();
    expect(f.getClosed()).toBe(0);
    release();
    await exiting;
    expect(f.getClosed()).toBe(1);
  });

  it("accounts one provider turn through compact begin/settle IPC without transporting content", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build verify provider accounting", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    const secretInput = "provider-input-must-not-cross-ipc";
    await f.handlers.get("context")!({ messages: [{ role: "user", content: secretInput }] }, f.ctx as unknown as ExtensionContext);
    f.calls.length = 0;
    await f.handlers.get("before_provider_request")!({
      payload: { messages: [{ role: "user", content: secretInput }], tools: [{ secretInput }] },
    }, f.ctx as unknown as ExtensionContext);
    f.handlers.get("after_provider_response")!({ status: 200, headers: {} }, f.ctx as unknown as ExtensionContext);
    const secretOutput = "provider-output-must-not-cross-ipc";
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: secretOutput },
        { type: "toolCall", name: "write", arguments: { content: secretOutput } },
      ],
      usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, reasoning: 5 },
    };
    await f.handlers.get("message_end")!({
      message: assistantMessage,
    }, f.ctx as unknown as ExtensionContext);
    await f.handlers.get("turn_end")!({
      turnIndex: 1, message: assistantMessage, toolResults: [],
    }, f.ctx as unknown as ExtensionContext);
    await f.commands.get("coding")!.handler("exit", f.ctx);
    const providerCalls = f.calls.filter((call) => call.method.startsWith("provider_"));
    expect(providerCalls.map((call) => call.method)).toEqual(["provider_begin", "provider_settle"]);
    expect(providerCalls[0]?.params).toMatchObject({
      payload_shape_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      history: { message_count: 1, descriptor_root_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(providerCalls[1]?.params).toMatchObject({
      provider_attempt_id: "IC_ATTEMPT-BRIDGE-001",
      cache_request_id: null, response_status: 200, outcome: "RESPONDED",
      assistant_text_bytes: Buffer.byteLength(secretOutput),
      tool_argument_bytes: expect.any(Number),
    });
    expect(JSON.stringify(f.calls)).not.toContain(secretInput);
    expect(JSON.stringify(f.calls)).not.toContain(secretOutput);
  });

  it("settles provider usage at turn_end when recovery omits an extension-visible message_end", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build recover provider accounting", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext);
    await f.handlers.get("context")!({ messages: [{ role: "user", content: "recover" }] }, f.ctx as unknown as ExtensionContext);
    f.calls.length = 0;
    await f.handlers.get("before_provider_request")!({ payload: { messages: [] } }, f.ctx as unknown as ExtensionContext);
    f.handlers.get("after_provider_response")!({ status: 200, headers: {} }, f.ctx as unknown as ExtensionContext);
    await f.handlers.get("turn_end")!({
      turnIndex: 1,
      message: {
        role: "assistant", content: [{ type: "text", text: "done" }],
        usage: { input: 90, output: 10, cacheRead: 30, cacheWrite: 0, reasoning: 4 },
      },
      toolResults: [],
    }, f.ctx as unknown as ExtensionContext);
    await f.commands.get("coding")!.handler("exit", f.ctx);
    const providerCalls = f.calls.filter((call) => call.method.startsWith("provider_"));
    expect(providerCalls.map((call) => call.method)).toEqual(["provider_begin", "provider_settle"]);
    expect(providerCalls[1]?.params).toMatchObject({
      usage: { input: 90, output: 10, cacheRead: 30, reasoning: 4 },
      response_status: 200, outcome: "RESPONDED",
    });
  });

  it("projects a bounded no-progress directive without starting an automatic follow-up", async () => {
    const f = fixture();
    await f.commands.get("coding")!.handler("single build govern repeated routes", f.ctx);
    await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "govern repeated routes" }, f.ctx as unknown as ExtensionContext);
    f.setGenerationTurnResult({ decision: "NUDGE", directive: "Use a changed authority-backed route." });
    await f.handlers.get("turn_end")!({ turnIndex: 1, message: {}, toolResults: [] }, f.ctx as unknown as ExtensionContext);

    const projected = await f.handlers.get("context")!({
      messages: [{ role: "user", content: "task" }],
    }, f.ctx as unknown as ExtensionContext) as { messages: Array<{ customType?: string; content?: string; timestamp?: number }> };
    expect(projected.messages.at(-1)).toMatchObject({
      customType: "pch-generation-governor-v1", content: "Use a changed authority-backed route.",
    });
    const repeated = await f.handlers.get("context")!({ messages: projected.messages }, f.ctx as unknown as ExtensionContext) as { messages: Array<{ timestamp?: number }> };
    expect(repeated.messages.at(-1)?.timestamp).toBe(projected.messages.at(-1)?.timestamp);
    expect(f.sent).toEqual(["govern repeated routes"]);

    await f.handlers.get("agent_settled")!({}, f.ctx as unknown as ExtensionContext);
    const cleaned = await f.handlers.get("context")!({ messages: repeated.messages }, f.ctx as unknown as ExtensionContext) as { messages: unknown[] };
    expect(cleaned.messages).toEqual([{ role: "user", content: "task" }]);
    expect(f.calls.some((call) => call.method === "generation_turn")).toBe(true);
    expect(f.calls.some((call) => call.method === "generation_settled")).toBe(true);
  });
});
