import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingHarnessHostRuntime } from "../../src/harness/host/runtime.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { ProjectionDeltaLedger, type ContextProjectionDelta } from "../../src/input-context/projection-delta.js";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];

function transportDelta(delta: ContextProjectionDelta) {
  return {
    schema_version: delta.schema_version, lineage_id: delta.lineage_id,
    previous_sequence_root: delta.previous_sequence_root, previous_count: delta.previous_count,
    append: delta.append.map((entry) => ({
      content_sha256: entry.contentSha256, role: entry.role, custom_type: entry.customType,
    })),
    new_sequence_root: delta.new_sequence_root, new_count: delta.new_count,
    full_reconcile: delta.full_reconcile,
  };
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "pch-host-"));
  roots.push(root);
  const cwd = resolve(root, "workspace");
  mkdirSync(cwd);
  const options = {
    packageRoot,
    configPath: resolve(packageRoot, "config", "default.json"),
    dataRoot: resolve(root, "data"),
    hostSecret: Buffer.alloc(32, 9),
    now: () => 10_000,
  };
  return { root, cwd, options };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Coding Harness Host runtime", () => {
  it("lazily enters a Single BUILD and recovers it after Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-001", objective: "Create a bounded local file", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    expect(await host.dispatch("status", null)).toMatchObject({ active: false });
    expect(await host.dispatch("enter", enter)).toMatchObject({ active: true, topology: "SINGLE", intent: "BUILD" });
    const first = await host.dispatch("status", null) as { flow: { goalId: string }; harness: { runId: string } };
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({
      active: true,
      flow: { goalId: first.flow.goalId },
      harness: { runId: first.harness.runId },
    });
    resumed.close();
  });

  it("dispatches an admitted managed tool before returning from blocking preflight", async () => {
    const { cwd, options } = fixture();
    mkdirSync(resolve(cwd, "src"));
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-TOOL-PREFLIGHT", objective: "Update and verify src/example.ts",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
      });
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-TOOL-PREFLIGHT", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["write"], all_tools: ["write"],
      }) as { control_frame: { control_frame_sha256: string } };
      const built = await host.dispatch("submit_build", {
        contract: {
          user_outcomes: ["The local file is updated and verified"], scope: ["src/example.ts"],
          non_goals: ["No external deployment"], constraints: ["Keep the change local"],
          obligations: [{ key: "verified-output", priority: "MUST", statement: "The final workspace passes npm test", oracle: { command: "npm test" } }],
          authorization_ceiling: "LOCAL_REVERSIBLE",
        },
        route: {
          outcomes: ["The bounded change is implemented"],
          work_cells: [{
            key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
            read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE"],
            oracle: { command: "npm test" }, risk: "LOW", reversible: true,
          }],
          near_horizon: ["bounded-change"],
        },
        control_frame_sha256: projected.control_frame.control_frame_sha256,
      }) as { status: { flow: { goalId: string }; control_frame: { control_frame_sha256: string } } };

      const admission = await host.dispatch("tool_preflight", {
        toolCallId: "EDIT-PREFLIGHT-1", toolName: "edit",
        input: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" }, cwd,
        control_frame_sha256: built.status.control_frame.control_frame_sha256,
      });
      expect(admission).toMatchObject({ allow: true, managed: true });
      const session = (host as unknown as { session: {
        resources(): { authority: { readUnresolvedTaskFlowOperations(goalId: string): readonly { state: string }[] } };
      } }).session;
      expect(session.resources().authority.readUnresolvedTaskFlowOperations(built.status.flow.goalId)).toMatchObject([
        { state: "DISPATCHED" },
      ]);
    } finally {
      host.close();
    }
  });

  it("recovers an OPEN clarification envelope after Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-CLARIFY", objective: "Resolve a durable output decision", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    const projected = await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CLARIFY-1", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
      current_input_tokens: 10, active_tools: ["coding_clarify"], all_tools: ["coding_clarify"],
    }) as { control_frame: { control_frame_sha256: string } };
    await host.dispatch("clarify_selected", {
      control_frame_sha256: projected.control_frame.control_frame_sha256,
      decisions: [{ ...decision, selectedOptionId: null }],
    });
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({ open_clarifications: [decision] });
    resumed.close();
  });

  it("rejects rebinding one Host to a different entry contract", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    const enter = {
      cwd, session_id: "SESSION-HOST-002", objective: "Inspect bounded sources", intent: "PLAN", topology: "MULTI",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    await host.dispatch("enter", enter);
    await expect(host.dispatch("enter", { ...enter, topology: "SINGLE" })).rejects.toThrow("different entry contract");
    host.close();
  });

  it("rejects a different objective or intent after Host restart instead of binding it to the recovered Goal", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-RECOVERY-BINDING", objective: "Preserve the original bounded objective",
      intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const first = new CodingHarnessHostRuntime(options);
    await first.dispatch("enter", enter);
    first.close();

    const resumed = new CodingHarnessHostRuntime(options);
    await expect(resumed.dispatch("enter", { ...enter, objective: "Silently replace the recovered objective" }))
      .rejects.toThrow(/different objective or intent/u);
    await expect(resumed.dispatch("enter", { ...enter, intent: "PLAN" }))
      .rejects.toThrow(/different objective or intent/u);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({
      active: true, intent: "BUILD", flow: { objective: enter.objective },
    });
    resumed.close();
  });

  it("persists and verifies a native compaction frontier across Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-COMPACTION", objective: "Inspect the bounded source", intent: "PLAN", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    const prepared = await host.dispatch("compaction", { phase: "before" }) as { checkpoint_sha256: string };
    expect(prepared.checkpoint_sha256).toMatch(/^COMPACTION-/u);
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    await resumed.dispatch("enter", enter);
    await expect(resumed.dispatch("compaction", { phase: "after" })).resolves.toEqual({ verified: true });
    await expect(resumed.dispatch("compaction", { phase: "after" })).rejects.toThrow("durable preflight");
    resumed.close();
  });

  it("blocks authority mutation during native compaction and exposes restart recovery", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-COMPACTION-GATE", objective: "Guard the compaction frontier",
      intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    await host.dispatch("compaction", { phase: "before" });
    await expect(host.dispatch("control", { action: "pause" })).rejects.toThrow("compaction");
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    const recovered = await resumed.dispatch("enter", enter) as { flow: { nextAction: string; blocker: string } };
    expect(recovered.flow).toMatchObject({
      nextAction: "RECONCILE_COMPACTION",
      blocker: expect.stringContaining("resume"),
    });
    await expect(resumed.dispatch("control", { action: "resume" })).resolves.toMatchObject({
      message: expect.stringContaining("Compaction"),
      status: { flow: { blocker: null } },
    });
    await expect(resumed.dispatch("control", { action: "pause" })).resolves.toMatchObject({
      status: { flow: { phase: "WAITING_USER", nextAction: "RESUME" } },
    });
    resumed.close();
  });

  it("aborts active Multi workers when cancellation becomes authoritative", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-CANCEL-WORKER", objective: "Cancel bounded worker execution",
      intent: "BUILD", topology: "MULTI",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    });
    const abort = new AbortController();
    (host as unknown as { workerJob: unknown }).workerJob = {
      id: "WORKER-JOB-CANCEL", aborts: [abort], state: "RUNNING", workerCount: 1,
      startedAtMs: 10_000, result: null, error: null, completion: new Promise<void>(() => undefined),
    };
    await host.dispatch("control", { action: "cancel", reason: "User confirmed cancellation" });
    expect(abort.signal.aborted).toBe(true);
    host.close();
  });

  it("persists a compact provider-turn ledger without prompt content", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-PROVIDER", objective: "Verify the provider ledger", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    });
    const systemPrompt = "BASE";
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CACHE-1",
      system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begun = await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex("shape"),
      history: {
        descriptor_root_sha256: sha256Hex("descriptors"), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    });
    expect(begun).toMatchObject({ recorded: true, cache_request_id: null });
    const settled = await host.dispatch("provider_settle", {
      cache_request_id: null,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5 },
      response_status: 200, latency_ms: 12, outcome: "RESPONDED",
      assistant_text_bytes: 24, tool_argument_bytes: 16,
    });
    expect(settled).toMatchObject({ ledger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), cache: null });
    host.close();
  });

  it("activates Cache C1 only for the verified provider contract and reports confirmed usage", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    const entered = await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-CACHE-C1", objective: "Verify Cache C1 attribution",
      intent: "BUILD", topology: "SINGLE",
      runtime: {
        provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      },
    });
    expect(entered).toMatchObject({
      cache: {
        configured: true, enabled: true, arm: "C1_PREFIX", effective_arm: "C1_PREFIX",
        provider_integration: "geekspace-openai-completions-positive-usage-v1", reason: "ACTIVE",
      },
    });
    const systemPrompt = "BASE";
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CACHE-2",
      system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begun = await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex("cache-shape"),
      history: {
        descriptor_root_sha256: sha256Hex("cache-descriptors"), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    }) as { cache_request_id: string };
    expect(begun.cache_request_id).toMatch(/^CACHE_REQ-/u);
    const settled = await host.dispatch("provider_settle", {
      cache_request_id: begun.cache_request_id,
      usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
      response_status: 200, latency_ms: 12, outcome: "RESPONDED",
      assistant_text_bytes: 24, tool_argument_bytes: 16,
    });
    expect(settled).toMatchObject({ cache: { observation_state: "HIT", evidence_level: "PROVIDER_USAGE" } });
    const diagnostic = await host.dispatch("cache_diagnostic", null) as { message: string };
    expect(diagnostic.message).toContain("effectiveArm=C1_PREFIX");
    expect(diagnostic.message).toContain("confirmedHits=1");
    expect(diagnostic.message).toContain("tokenReadShare=0.4444");
    host.close();
  });

  it("rejects ambiguous or unbounded deferred-context requests", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-CONTEXT-NEGATIVE", objective: "Inspect deferred evidence",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-1",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
      }) as { control_frame: { control_frame_sha256: string } };
      const frame = { control_frame_sha256: projected.control_frame.control_frame_sha256 };
      await expect(host.dispatch("context_fetch", { ...frame, cursor: "signed", selector: "CURRENT_ON_DEMAND" }))
        .rejects.toThrow("cursor request is invalid");
      await expect(host.dispatch("context_fetch", { ...frame, selector: "CURRENT_ON_DEMAND", candidate_ids: [] }))
        .rejects.toThrow("1..10");
      await expect(host.dispatch("context_fetch", { ...frame, selector: "CURRENT_ON_DEMAND", unknown: true }))
        .rejects.toThrow("unknown fields");
    } finally {
      host.close();
    }
  });

  it("rejects a ControlFrame after the bound authority state advances", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-STALE-FRAME", objective: "Fence stale model actions",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-2",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      }) as { control_frame: { control_frame_sha256: string } };
      const frame = projected.control_frame.control_frame_sha256;
      await expect(host.dispatch("control", { action: "pause", control_frame_sha256: frame })).resolves.toBeDefined();
      await expect(host.dispatch("control", { action: "resume", control_frame_sha256: frame }))
        .rejects.toThrow("PCH_STALE_CONTROL_FRAME");
    } finally {
      host.close();
    }
  });

  it("keeps one ControlFrame valid throughout a long active Agent run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime({ ...options, now: () => Date.now() });
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-LEASE-HEARTBEAT", objective: "Keep the active execution lease alive",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-LEASE-HEARTBEAT",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      }) as { control_frame: { control_frame_sha256: string } };
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(host.dispatch("control", {
        action: "pause", control_frame_sha256: projected.control_frame.control_frame_sha256,
      })).resolves.toBeDefined();
      const paused = await host.dispatch("status", null) as { control_frame: { control_frame_sha256: string } };
      await host.dispatch("generation_settled", null);
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(host.dispatch("control", {
        action: "resume", control_frame_sha256: paused.control_frame.control_frame_sha256,
      })).rejects.toThrow("PCH_STALE_CONTROL_FRAME");
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });

  it("governs repeated no-progress turns locally and resets after the Agent settles", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-GOVERNOR", objective: "Bound repeated generation routes",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-GOVERNOR-1",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read"],
      }) as { generation_governor: { decision: string } };
      expect(projected.generation_governor.decision).toBe("CONTINUE");
      expect(await host.dispatch("generation_turn", { turn_index: 0 })).toMatchObject({
        decision: "CONTINUE", no_progress_turns: 1,
      });
      expect(await host.dispatch("generation_turn", { turn_index: 1 })).toMatchObject({
        decision: "NUDGE", no_progress_turns: 2, directive: expect.any(String),
      });
      expect(await host.dispatch("generation_turn", { turn_index: 2 })).toMatchObject({
        decision: "HALT_AUTOMATION", no_progress_turns: 3,
      });
      expect(await host.dispatch("generation_settled", null)).toMatchObject({
        decision: "CONTINUE", directive: null,
      });
    } finally {
      host.close();
    }
  });

  it("settles an unknown provider outcome with null usage instead of leaving it pending", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-UNKNOWN-USAGE", objective: "Account an interrupted provider turn",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-UNKNOWN-USAGE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: [], all_tools: [],
      });
      await host.dispatch("provider_begin", {
        payload_shape_sha256: sha256Hex("shape"),
        history: {
          descriptor_root_sha256: sha256Hex("history"), message_count: 1,
          logical_bytes: 20, user_bytes: 20, assistant_bytes: 0, other_bytes: 0,
        },
        tool_schema_bytes: 0,
      });
      await expect(host.dispatch("provider_settle", {
        cache_request_id: null, usage: null, response_status: null, latency_ms: null,
        outcome: "OUTCOME_UNKNOWN", assistant_text_bytes: 0, tool_argument_bytes: 0,
      })).resolves.toMatchObject({ ledger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    } finally {
      host.close();
    }
  });

  it("requires a full projection reconcile after the Bridge and Host sequence roots diverge", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-PROJECTION-RECONCILE", objective: "Reconcile compact context deltas",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-RECONCILE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read"],
      });
      const bridge = new ProjectionDeltaLedger("projection-reconcile");
      const one = { contentSha256: sha256Hex("one"), role: "user", customType: null };
      const two = { contentSha256: sha256Hex("two"), role: "assistant", customType: null };
      const first = bridge.plan([one]);
      expect(await host.dispatch("context_project", {
        delta: transportDelta(first), removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: true, reconcile_required: false } });
      bridge.commit(first);

      const append = bridge.plan([one, two]);
      const mismatched = { ...transportDelta(append), previous_sequence_root: sha256Hex("host-mismatch") };
      expect(await host.dispatch("context_project", {
        delta: mismatched, removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: false, reconcile_required: true } });

      const reconciled = bridge.plan([one, two], true);
      expect(await host.dispatch("context_project", {
        delta: transportDelta(reconciled), removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: true, reconcile_required: false, count: 2 } });
    } finally {
      host.close();
    }
  });

  it("rejects an exact managed route only after two unchanged no-progress turns", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-STALLED-ROUTE", objective: "Stop a repeated invalid context route",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-STALLED-ROUTE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_context"], all_tools: ["coding_context"],
      }) as { control_frame: { control_frame_sha256: string } };
      const request = {
        control_frame_sha256: projected.control_frame.control_frame_sha256,
        selector: "CURRENT_ON_DEMAND", candidate_ids: [],
      };
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("1..10");
      await host.dispatch("generation_turn", { turn_index: 0 });
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("1..10");
      await host.dispatch("generation_turn", { turn_index: 1 });
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("PCH_GENERATION_ROUTE_STALLED");
    } finally {
      host.close();
    }
  });
});
