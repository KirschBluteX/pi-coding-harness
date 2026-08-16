import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  executionNodeInputClosureV2,
  type ExecutionNodeSpecV2,
  type TaskPacketV2,
} from "../../src/harness/execution-v2/domain.js";
import { finalizeExecutionGraphV2 } from "../../src/harness/execution-v2/dag.js";
import {
  WorkerAttemptExecutor,
  type WorkerAttemptAgentEventV2,
  type WorkerAttemptAgentInputV2,
  type WorkerAttemptAgentFactoryV2,
} from "../../src/harness/worker/attempt-executor-v2.js";
import type { WorkerRuntimeSelection } from "../../src/harness/worker/runtime-policy.js";
import { piRuntimeFingerprintSha256 } from "../../src/harness/runtime-fingerprint.js";
import { createWorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";
import type { WorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";

const roots: string[] = [];
const sha = (value: string): string => sha256Hex(value);
const nowMs = 1_790_000_000_000;
const capabilityKey = "worker-attempt-test-capability";
const sourceText = "export const value = 1;\n";
const supervisorRuntime: WorkerRuntimeSelection = {
  provider: "configured-provider",
  api: "configured-api",
  model: "configured-model",
  thinking_level: "high",
  context_window: 128_000,
};
const providerAuthorities = new Map<string, WorkerProviderDispatchAuthorityV1>();

function providerAuthority(taskPacket: TaskPacketV2) {
  const authority = providerAuthorities.get(taskPacket.packet_id);
  if (!authority) throw new Error("Test TaskPacket lacks Provider authority");
  return { providerPlan: authority.plan, providerInvocation: authority.invocation };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pch-worker-attempt-v2-"));
  roots.push(root);
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "src", "index.ts"), sourceText);
  return root;
}

function packet(overrides: Partial<Omit<ExecutionNodeSpecV2, "schema_version" | "node_id" | "record_sha256">> = {}): TaskPacketV2 {
  const task = "Inspect the exact source and return typed evidence";
  const exactInputRefs = [{ path: "src/index.ts", sha256: sha(sourceText), classification: "INTERNAL" as const }];
  const outputSchema = sha("output-schema");
  const oracle = sha("oracle");
  const providerProfile = piRuntimeFingerprintSha256(supervisorRuntime);
  const graph = finalizeExecutionGraphV2({
    goal_id: "GOAL-WORKER-ATTEMPT-V2",
    run_id: "RUN-WORKER-ATTEMPT-V2",
    work_cell_id: "CELL-WORKER-ATTEMPT-V2",
    plan_revision_id: "PLAN-REVISION-WORKER-ATTEMPT-V2",
    plan_revision_sha256: sha("plan"),
    topology_gate_receipt_id: "TOPOLOGY-GATE-WORKER-ATTEMPT-V2",
    topology_gate_receipt_sha256: sha("topology"),
    authorization_id: "AUTHORIZATION-WORKER-ATTEMPT-V2",
    authorization_sha256: sha("authorization"),
    baseline_sha256: sha("baseline"),
    baseline_content_root_sha256: sha("baseline-content-root"),
    environment_sha256: sha("environment"),
    input_closure_sha256: sha("graph-input"),
    oracle_set_sha256: sha("oracle-set"),
    config_sha256: sha("config"),
    runtime_fingerprint_sha256: providerProfile,
    predecessor_authority_head_sha256: sha("head"),
    graph_revision: 1,
    stop_generation: 0,
    nodes: [{
      schema_version: 2,
      node_id: "NODE-DISCOVER",
      logical_key: "discover",
      task,
      capabilities: ["SOURCE_DISCOVERY"],
      effect_ceiling: "READ_ONLY",
      requirement_ids: ["REQ-001"],
      obligation_ids: ["OBL-001"],
      read_roots: ["src/index.ts"],
      write_roots: [],
      exact_input_refs: exactInputRefs,
      decision_refs: [],
      provider_call_plan_id: null,
      provider_call_plan_sha256: null,
      input_closure_sha256: executionNodeInputClosureV2({
        task, requirement_ids: ["REQ-001"], obligation_ids: ["OBL-001"],
        exact_input_refs: exactInputRefs, decision_refs: [], output_schema_sha256: outputSchema,
        oracle_sha256: oracle, provider_profile_sha256: providerProfile,
      }),
      output_schema_sha256: outputSchema,
      oracle_sha256: oracle,
      provider_profile_sha256: providerProfile,
      privacy_class: "INTERNAL",
      taint_classes: [],
      max_turns: 4,
      max_tool_calls: 8,
      max_input_tokens: 16_000,
      max_output_tokens: 4_000,
      max_retries: 1,
      no_progress_limit: 2,
      deadline_ms: nowMs + 60_000,
      ...overrides,
    }],
    edges: [],
    created_at_ms: nowMs - 1_000,
  });
  const authority = createWorkerProviderDispatchAuthorityV1({
    graph,
    node: graph.nodes[0]!,
    attempt: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    deadlineMs: nowMs + 30_000,
    createdAtMs: nowMs - 500,
    predecessorAuthorityHeadSha256: sha("worker-provider-head"),
    capabilityKey,
    runtime: { runtime: supervisorRuntime, source: "SUPERVISOR_INHERITED", fallback_reason: null },
  });
  providerAuthorities.set(authority.packet.packet_id, authority);
  return authority.packet;
}

describe("WorkerAttemptExecutor V2", () => {
  it("treats assistant text as display-only and resolves only the dispatched packet runtime", async () => {
    const createWorker: WorkerAttemptAgentFactoryV2 = async () => ({
      prompt: async () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "The oracle passed.",
      getSessionStats: () => ({
        tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
        toolCalls: 0,
      }),
    });
    const resolveRuntime = vi.fn(async () => ({
      runtime: supervisorRuntime,
      source: "SUPERVISOR_INHERITED" as const,
      fallback_reason: null,
    }));
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({ createWorker, resolveRuntime, now: () => nowMs })
      .execute({
        workspace: workspace(),
        packet: taskPacket,
        capabilityKey,
        current: {
          graph_sha256: taskPacket.graph_revision_sha256,
          authorization_sha256: taskPacket.authorization_sha256,
          stop_generation: taskPacket.stop_generation,
        },
        supervisorRuntime,
        ...providerAuthority(taskPacket),
      });

    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(resolveRuntime).toHaveBeenCalledWith({ packet: taskPacket, supervisor: supervisorRuntime });
    expect(result).toMatchObject({
      status: "PROTOCOL_FAILURE",
      proposal: null,
      display_text: "The oracle passed.",
      protocol: {
        reason_code: "MISSING_SUBMISSION",
        submission_count: 0,
        assistant_text_is_display_only: true,
      },
    });
  });

  it("rejects a resolver runtime substitution before creating a provider session", async () => {
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>();
    const taskPacket = packet();
    const executor = new WorkerAttemptExecutor({
      createWorker,
      resolveRuntime: async () => ({
        runtime: { ...supervisorRuntime, base_url: "https://substituted.invalid/v1" },
        source: "SUPERVISOR_INHERITED",
        fallback_reason: null,
      }),
      now: () => nowMs,
    });

    await expect(executor.execute({
      workspace: workspace(),
      packet: taskPacket,
      capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    })).rejects.toThrow(/authority-bound provider profile/u);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("returns one schema-valid submit_worker_result_v2 call as an unverified proposal", async () => {
    const workerInputs: WorkerAttemptAgentInputV2[] = [];
    const createWorker: WorkerAttemptAgentFactoryV2 = async (input) => {
      workerInputs.push(input);
      return {
        prompt: async () => {
          const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2");
          if (!submit) throw new TypeError("Missing submit_worker_result_v2");
          await submit.execute("SUBMIT-1", {
            kind: "EVIDENCE_PROPOSAL",
            payload: { artifact_refs: [{ sha256: sha("artifact"), classification: "INTERNAL" }] },
          } as never, undefined, undefined, {} as never);
        },
        abort: async () => undefined,
        dispose: () => undefined,
        subscribe: () => () => undefined,
        getLastAssistantText: () => "Local display summary.",
        getSessionStats: () => ({
          tokens: { input: 120, output: 30, cacheRead: 20, cacheWrite: 0 },
          cost: 0.02,
          toolCalls: 1,
        }),
      };
    };
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(),
      packet: taskPacket,
      capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(workerInputs[0]?.customTools.map((tool) => tool.name)).toContain("submit_worker_result_v2");
    expect(workerInputs[0]?.systemPrompt).toContain("Inspect the exact source and return typed evidence");
    expect(workerInputs[0]?.systemPrompt).toContain("REQ-001");
    expect(workerInputs[0]?.systemPrompt).toContain("OBL-001");
    expect(workerInputs[0]?.systemPrompt).toContain(sha("output-schema"));
    expect(workerInputs[0]?.systemPrompt).toContain("src/index.ts");
    expect(result).toMatchObject({
      status: "PROPOSED",
      protocol: { reason_code: null, submission_count: 1, assistant_text_is_display_only: true },
      display_text: "Local display summary.",
      proposal: {
        schema_version: 2,
        packet_id: taskPacket.packet_id,
        packet_sha256: taskPacket.packet_sha256,
        kind: "EVIDENCE_PROPOSAL",
        trust: "UNVERIFIED_PROPOSAL",
        payload: { artifact_refs: [{ sha256: sha("artifact"), classification: "INTERNAL" }] },
      },
    });
  });

  it("stops before Worker creation when the exact source closure changed after packet creation", async () => {
    const root = workspace();
    const taskPacket = packet();
    writeFileSync(resolve(root, "src", "index.ts"), "export const value = 2;\n");
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>();

    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: root,
      packet: taskPacket,
      capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(createWorker).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "STOPPED",
      stopped: { source: "ADAPTER_BUDGET", reason_code: "INPUT_CLOSURE_STALE" },
    });
  });

  it("rechecks abort after asynchronous runtime resolution and never creates a Worker", async () => {
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolveGate) => { releaseRuntime = resolveGate; });
    const resolveRuntime = vi.fn(async () => {
      await runtimeGate;
      return { runtime: supervisorRuntime, source: "SUPERVISOR_INHERITED" as const, fallback_reason: null };
    });
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>();
    const abort = new AbortController();
    const taskPacket = packet();
    const pending = new WorkerAttemptExecutor({ createWorker, resolveRuntime, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
      signal: abort.signal,
    });
    abort.abort();
    releaseRuntime();

    await expect(pending).resolves.toMatchObject({
      status: "STOPPED",
      stopped: { reason_code: "ABORTED" },
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("invalidates the attempt when submit_worker_result_v2 is called more than once", async () => {
    const createWorker: WorkerAttemptAgentFactoryV2 = async (input) => ({
      prompt: async () => {
        const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2")!;
        const value = {
          kind: "BLOCKED",
          payload: { reason_code: "DEPENDENCY_MISSING", evidence_refs: [] },
        } as never;
        await submit.execute("SUBMIT-1", value, undefined, undefined, {} as never);
        try {
          await submit.execute("SUBMIT-2", value, undefined, undefined, {} as never);
        } catch {
          // The protocol result, not Worker exception handling, owns the terminal classification.
        }
      },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "I submitted twice.",
      getSessionStats: () => ({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 2,
      }),
    });
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(result).toMatchObject({
      status: "PROTOCOL_FAILURE",
      proposal: null,
      protocol: { reason_code: "DUPLICATE_SUBMISSION", submission_count: 2 },
    });
  });

  it("hard-stops a single attempt when its tool-call budget is exhausted", async () => {
    let aborts = 0;
    const createWorker: WorkerAttemptAgentFactoryV2 = async () => {
      let eventListener: ((event: WorkerAttemptAgentEventV2) => void) | null = null;
      return {
        prompt: async () => {
          eventListener?.({ type: "TOOL_START", tool_call_id: "READ-1", tool_name: "read", input: { path: "src/index.ts" } });
          eventListener?.({ type: "TOOL_END", tool_call_id: "READ-1", tool_name: "read", result: "one", is_error: false });
          eventListener?.({ type: "TOOL_START", tool_call_id: "READ-2", tool_name: "read", input: { path: "src/index.ts" } });
        },
        abort: async () => { aborts += 1; },
        dispose: () => undefined,
        subscribe: (next) => { eventListener = next; return () => { eventListener = null; }; },
        getLastAssistantText: () => "",
        getSessionStats: () => ({
          tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 2,
        }),
      };
    };
    const taskPacket = packet({ max_tool_calls: 1 });
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(aborts).toBe(1);
    expect(result).toMatchObject({
      status: "STOPPED",
      proposal: null,
      stopped: { reason_code: "TOOL_LIMIT_EXCEEDED", observed_stop_generation: 0 },
      protocol: { reason_code: null, submission_count: 0 },
    });
  });

  it("hard-stops after structurally unchanged turns reach the no-progress limit", async () => {
    let eventListener: ((event: WorkerAttemptAgentEventV2) => void) | null = null;
    const createWorker: WorkerAttemptAgentFactoryV2 = async () => ({
      prompt: async () => {
        eventListener?.({ type: "TURN_END" });
        eventListener?.({ type: "TURN_END" });
      },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: (next) => { eventListener = next; return () => { eventListener = null; }; },
      getLastAssistantText: () => "Repeated narrative only.",
      getSessionStats: () => ({
        tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0,
      }),
    });
    const taskPacket = packet({ max_turns: 10, no_progress_limit: 2 });
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(result).toMatchObject({
      status: "STOPPED",
      stopped: { reason_code: "NO_PROGRESS_LIMIT_EXCEEDED" },
    });
  });

  it("stops an expired packet before mirror creation, runtime lookup, or Worker creation", async () => {
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>();
    const resolveRuntime = vi.fn(async () => ({
      runtime: supervisorRuntime,
      source: "SUPERVISOR_INHERITED" as const,
      fallback_reason: null,
    }));
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({
      createWorker,
      resolveRuntime,
      now: () => taskPacket.deadline_ms,
    }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(createWorker).not.toHaveBeenCalled();
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "STOPPED",
      proposal: null,
      stopped: { reason_code: "DEADLINE_EXCEEDED" },
      patches: [],
      runtime_resolution: null,
    });
  });

  it("returns at the packet deadline even when the Agent prompt never settles", async () => {
    vi.useFakeTimers();
    let clock = nowMs;
    let aborts = 0;
    try {
      const createWorker: WorkerAttemptAgentFactoryV2 = async () => ({
        prompt: async () => new Promise<void>(() => undefined),
        abort: async () => { aborts += 1; },
        dispose: () => undefined,
        subscribe: () => () => undefined,
        getLastAssistantText: () => "",
        getSessionStats: () => ({
          tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0,
        }),
      });
      const taskPacket = packet();
      const running = new WorkerAttemptExecutor({ createWorker, now: () => clock }).execute({
        workspace: workspace(), packet: taskPacket, capabilityKey,
        current: {
          graph_sha256: taskPacket.graph_revision_sha256,
          authorization_sha256: taskPacket.authorization_sha256,
          stop_generation: taskPacket.stop_generation,
        },
        supervisorRuntime,
        ...providerAuthority(taskPacket),
      });
      await vi.advanceTimersByTimeAsync(0);
      clock = taskPacket.deadline_ms;
      await vi.advanceTimersByTimeAsync(taskPacket.deadline_ms - nowMs);
      const result = await Promise.race([running, Promise.resolve("PENDING" as const)]);

      expect(result).not.toBe("PENDING");
      expect(result).toMatchObject({ status: "STOPPED", stopped: { reason_code: "DEADLINE_EXCEEDED" } });
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a scoped Patch proposal without mutating or integrating the canonical workspace", async () => {
    const workerInputs: WorkerAttemptAgentInputV2[] = [];
    const createWorker: WorkerAttemptAgentFactoryV2 = async (input) => {
      workerInputs.push(input);
      return {
        prompt: async () => {
          writeFileSync(resolve(input.cwd, "src", "index.ts"), "export const value = 2;\n");
          const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2")!;
          await submit.execute("SUBMIT-PATCH", {
            kind: "PATCH_PROPOSAL",
            payload: {},
          } as never, undefined, undefined, {} as never);
        },
        abort: async () => undefined,
        dispose: () => undefined,
        subscribe: () => () => undefined,
        getLastAssistantText: () => "Patch proposed.",
        getSessionStats: () => ({
          tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 1,
        }),
      };
    };
    const root = workspace();
    const taskPacket = packet({
      capabilities: ["PATCH_PROPOSE"],
      effect_ceiling: "PATCH_PROPOSAL",
      write_roots: ["src/index.ts"],
    });
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: root, packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(workerInputs[0]?.tools).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
    expect(readFileSync(resolve(root, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(result).toMatchObject({
      status: "PROPOSED",
      proposal: {
        kind: "PATCH_PROPOSAL", trust: "UNVERIFIED_PROPOSAL",
        payload: {
          patch_set_id: expect.stringMatching(/^PATCH_SET_V2-/u),
          patch_set_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          affected_paths: ["src/index.ts"],
        },
      },
      patch_set: {
        patch_set_id: expect.stringMatching(/^PATCH_SET_V2-/u),
        entries: [{ operation: "MODIFY", path: "src/index.ts", before_sha256: sha(sourceText) }],
      },
      patches: [{ operation: "MODIFY", path: "src/index.ts" }],
    });
  });

  it("rejects a Patch proposal from a read-only capability packet", async () => {
    const createWorker: WorkerAttemptAgentFactoryV2 = async (input) => ({
      prompt: async () => {
        const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2")!;
        try {
          await submit.execute("SUBMIT-FORGED-PATCH", {
            kind: "PATCH_PROPOSAL",
            payload: {},
          } as never, undefined, undefined, {} as never);
        } catch {
          // The Adapter records the protocol violation independently of Worker behavior.
        }
      },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "Forged patch claim.",
      getSessionStats: () => ({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 1,
      }),
    });
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(result).toMatchObject({
      status: "PROTOCOL_FAILURE",
      proposal: null,
      protocol: { reason_code: "CAPABILITY_VIOLATION", submission_count: 1 },
    });
  });

  it("rejects a Patch proposal when the mirror changes after its typed submission", async () => {
    const createWorker: WorkerAttemptAgentFactoryV2 = async (input) => ({
      prompt: async () => {
        writeFileSync(resolve(input.cwd, "src", "index.ts"), "export const value = 2;\n");
        const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2")!;
        await submit.execute("SUBMIT-MISMATCH", {
          kind: "PATCH_PROPOSAL",
          payload: {},
        } as never, undefined, undefined, {} as never);
        writeFileSync(resolve(input.cwd, "src", "index.ts"), "export const value = 3;\n");
      },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "Mismatched patch.",
      getSessionStats: () => ({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 1,
      }),
    });
    const taskPacket = packet({
      capabilities: ["PATCH_PROPOSE"], effect_ceiling: "PATCH_PROPOSAL", write_roots: ["src/index.ts"],
    });
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(result).toMatchObject({
      status: "PROTOCOL_FAILURE",
      proposal: null,
      protocol: { reason_code: "PATCH_PROTOCOL_MISMATCH" },
      patches: [{ path: "src/index.ts" }],
    });
  });

  it("returns a Worker-submitted STOPPED variant without scheduling any retry", async () => {
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>(async (input) => ({
      prompt: async () => {
        const submit = input.customTools.find((tool) => tool.name === "submit_worker_result_v2")!;
        await submit.execute("SUBMIT-STOPPED", {
          kind: "STOPPED",
          payload: { reason_code: "DEPENDENCY_REVOKED", observed_stop_generation: input.packet.stop_generation },
        } as never, undefined, undefined, {} as never);
      },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "Stopped locally.",
      getSessionStats: () => ({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 1,
      }),
    }));
    const taskPacket = packet();
    const executor = new WorkerAttemptExecutor({ createWorker, now: () => nowMs });
    const result = await executor.execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "STOPPED",
      proposal: { kind: "STOPPED", trust: "UNVERIFIED_PROPOSAL" },
      stopped: { reason_code: "DEPENDENCY_REVOKED", observed_stop_generation: 0 },
      protocol: { reason_code: null, submission_count: 1 },
    });
  });

  it("returns one typed protocol failure when the Agent fails and never retries locally", async () => {
    const createWorker = vi.fn<WorkerAttemptAgentFactoryV2>(async () => ({
      prompt: async () => { throw new Error("provider failed"); },
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: () => () => undefined,
      getLastAssistantText: () => "partial display",
      getSessionStats: () => ({
        tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0,
      }),
    }));
    const taskPacket = packet();
    const result = await new WorkerAttemptExecutor({ createWorker, now: () => nowMs }).execute({
      workspace: workspace(), packet: taskPacket, capabilityKey,
      current: {
        graph_sha256: taskPacket.graph_revision_sha256,
        authorization_sha256: taskPacket.authorization_sha256,
        stop_generation: taskPacket.stop_generation,
      },
      supervisorRuntime,
      ...providerAuthority(taskPacket),
    });

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "PROTOCOL_FAILURE",
      proposal: null,
      protocol: { reason_code: "AGENT_FAILURE", submission_count: 0 },
      display_text: "partial display",
    });
  });
});
