import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodingHarness } from "../../src/bridge/register.js";

function fixture() {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void }>();
  const tools: { name: string }[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["read", "write", "other_extension_tool", "coding_flow"];
  const sent: unknown[] = [];
  const calls: { method: string; params: unknown }[] = [];
  let closed = 0;
  let contextProjectionActive = false;
  let generationTurnResult: { decision: string; directive: string | null } = { decision: "CONTINUE", directive: null };
  const status = {
    active: true, intent: "BUILD", topology: "SINGLE",
    flow: { goalId: "GOAL-1", mode: "BUILD", phase: "CONTRACTING", workCell: null, routeHealth: "H0_CONTINUE", nextAction: "SUBMIT_CONTRACT", blocker: null },
    harness: { status: "ACTIVE", nextReadyShardId: null, shards: [] },
    context: { provider_turn_ledger_enabled: true },
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
      if (method === "provider_begin") return { recorded: true, cache_request_id: null };
      if (method === "provider_settle") return { ledger_sha256: "a".repeat(64), cache: null };
      if (method === "generation_turn") return generationTurnResult;
      if (method === "generation_settled") return { decision: "CONTINUE", directive: null };
      if (method === "status" || method === "enter") return status;
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
    sessionManager: { getSessionId: () => "SESSION-1" },
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
    commands, tools, handlers, sent, calls, client, ctx, notices, statuses, statusWrites, widgets, widgetWrites, status,
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
    expect(f.statuses.get("coding-harness")).toContain("goal=GOAL-1");
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool", "coding_flow", "coding_clarify", "coding_delegate", "coding_context"]);
    const memoryCalls = () => f.calls.filter((call) => call.method === "memory_observe").length;
    f.handlers.get("input")!({ text: "continue the ordinary task", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    await Promise.resolve();
    expect(memoryCalls()).toBe(0);
    f.handlers.get("input")!({ text: "remember that I prefer the local test", source: "interactive" }, f.ctx as unknown as ExtensionContext);
    await Promise.resolve();
    expect(memoryCalls()).toBe(1);
    await f.commands.get("memory")!.handler("status", f.ctx);
    expect(f.calls.some((call) => call.method === "memory_command")).toBe(true);
    const projected = await f.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx as unknown as ExtensionContext) as { systemPrompt: string };
    expect(projected.systemPrompt).toContain("[PI-CODING-HARNESS-V1]");
    expect(projected.systemPrompt).toContain("Follow the current authority state.");
    await f.commands.get("coding")!.handler("exit", f.ctx);
    expect(f.getActiveTools()).toEqual(["read", "write", "other_extension_tool"]);
    expect(f.getClosed()).toBe(1);
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

  it("marks submit_build as initial-only in the model-visible tool contract", () => {
    const f = fixture();
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as { parameters: unknown };
    expect(JSON.stringify(tool.parameters)).toContain("Combined initial freeze only while phase=CONTRACTING");
    expect(JSON.stringify(tool.parameters)).toContain("never use after next=SUBMIT_ROUTE or next=EXECUTE_WORK");
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
      plan_review?: { summary: string; artifact_path: string; route_sha256: string };
    };
    status.flow.nextAction = "PLAN_CONTINUATION";
    status.plan_review = {
      summary: "Goal GOAL-1\n[READY] bounded-change",
      artifact_path: "X:/workspace/.coding-harness/task-flow/route-skeleton.ROUTE-1.md",
      route_sha256: "a".repeat(64),
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
    expect(f.calls.findLast((call) => call.method === "continue_plan")?.params).toEqual({ choice: "KEEP" });
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
    expect(f.widgets.get("coding-harness")).toHaveLength(2);
    const tool = f.tools.find((entry) => entry.name === "coding_flow") as unknown as {
      execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionCommandContext): Promise<unknown>;
    };
    const writesBefore = f.widgetWrites.length;
    f.status.flow.phase = "PLANNING";
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
    const ctx = { ...f.ctx, hasUI: false } as ExtensionCommandContext;
    await f.commands.get("coding")!.handler("single plan automate the bounded route", ctx);
    f.calls.length = 0;
    await f.commands.get("coding")!.handler("continue keep", ctx);
    await f.commands.get("coding")!.handler("cancel", ctx);
    expect(f.calls.some((call) => call.method === "control")).toBe(false);
    expect(f.notices.at(-1)).toMatch(/cancel command failed.*--confirm/u);
    await f.commands.get("coding")!.handler("cancel --confirm superseded objective", ctx);
    expect(f.calls.findLast((call) => call.method === "continue_plan")?.params).toEqual({ choice: "KEEP" });
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
    expect(f.sent).toEqual(["recover a headless decision"]);
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
