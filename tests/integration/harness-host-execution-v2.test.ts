import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { computeEventSha256 } from "../../src/authority/event-chain.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeWorkerProposalV2 } from "../../src/harness/execution-v2/domain.js";
import type { HostWorkerStatus } from "../../src/harness/host/application-protocol.js";
import {
  CodingHarnessHostRuntime,
  type CodingHarnessHostOptions,
} from "../../src/harness/host/runtime.js";
import { createProductionDynamicMultiHostPortsFactory } from "../../src/harness/host/production-dynamic-multi.js";
import type {
  WorkerAttemptExecuteInputV2,
  WorkerAttemptResultV2,
} from "../../src/harness/worker/attempt-executor-v2.js";
import type { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { piRuntimeFingerprintSha256 } from "../../src/harness/runtime-fingerprint.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "pch-host-execution-v2-"));
  roots.push(root);
  const cwd = resolve(root, "workspace");
  mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "input.ts"), "export const input = 1;\n", "utf8");
  writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
  return {
    cwd,
    options: {
      packageRoot,
      configPath: resolve(packageRoot, "config", "default.json"),
      dataRoot: resolve(root, "data"),
      hostSecret: Buffer.alloc(32, 23),
      now: () => 10_000,
    },
  };
}

function authorityDatabasePath(dataRoot: string, cwd: string): string {
  const installKey = readFileSync(resolve(dataRoot, "install.key"));
  const workspaceHmac = hmacSha256Hex(
    installKey,
    resolve(cwd).replaceAll("\\", "/").toLowerCase().normalize("NFC"),
  );
  return resolve(dataRoot, "workspaces", workspaceHmac, "authority.sqlite");
}

function hostEntry(cwd: string, topology: "SINGLE" | "MULTI" = "MULTI", sessionId = "SESSION-HOST-EXECUTION-V2") {
  return {
    cwd,
    session_id: sessionId,
    objective: "Inspect three independent source concerns and combine the accepted evidence",
    intent: "BUILD" as const,
    topology,
    runtime: {
      provider: "configured-provider",
      api: "configured-api",
      model: "configured-model",
      thinking_level: "configured",
      context_window: 65_536,
    },
  };
}

async function authorizeWorkCell(
  host: CodingHarnessHostRuntime,
  cwd: string,
  topology: "SINGLE" | "MULTI" = "MULTI",
  sessionId = "SESSION-HOST-EXECUTION-V2",
): Promise<{
  readonly controlFrameSha256: string;
  readonly goalId: string;
  readonly runId: string;
}> {
  await host.dispatch("enter", hostEntry(cwd, topology, sessionId));
  const projected = await host.dispatch("turn_projection", {
    agent_run_id: "AGENT-RUN-HOST-EXECUTION-V2",
    system_prompt_sha256: sha256Hex("BASE"),
    system_prompt: "BASE",
    current_input_tokens: 10,
    active_tools: ["coding_flow", "coding_delegate"],
    all_tools: ["coding_flow", "coding_delegate"],
  }) as { control_frame: { control_frame_sha256: string } };
  const drafted = await host.dispatch("submit_contract", {
    ...withAcceptanceV2({
      user_outcomes: ["The three source concerns are inspected with accepted evidence"],
      scope: ["src/input.ts"],
      non_goals: ["No external side effects"],
      constraints: ["Keep worker execution read-only"],
      obligations: [{
        key: "verified-evidence",
        priority: "MUST",
        statement: "The source evidence is independently accepted",
        oracle: { command: "npm test" },
      }],
      authorization_ceiling: "LOCAL_REVERSIBLE",
    }),
    control_frame_sha256: projected.control_frame.control_frame_sha256,
  }) as {
    status: {
      contract_review: {
        decision_requirement_revision_id: string;
        requirement_revision_sha256: string;
        decision_frontier_sha256: string;
      };
    };
  };
  const review = drafted.status.contract_review;
  const approved = await host.dispatch("resolve_contract_review", {
    expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
    expected_requirement_revision_sha256: review.requirement_revision_sha256,
    expected_decision_frontier_sha256: review.decision_frontier_sha256,
    action: "APPROVE",
    selected_value: true,
  }) as { status: { control_frame: { control_frame_sha256: string } } };
  const routed = await host.dispatch("submit_route", {
    outcomes: ["Accepted evidence covers the authorized WorkCell"],
    goal_fit_assessment: passingGoalFitAssessment(),
    work_cells: [{
      key: "inspect-evidence",
      outcome: "Inspect and validate the three source concerns",
      obligation_keys: ["verified-evidence"],
      read_roots: ["src/input.ts"],
      write_roots: ["src/input.ts"],
      effect_classes: ["LOCAL_REVERSIBLE"],
      oracle: { command: "npm test" },
      risk: "LOW",
      reversible: true,
    }],
    near_horizon: ["inspect-evidence"],
    control_frame_sha256: approved.status.control_frame.control_frame_sha256,
  }) as {
    status: {
      flow: { goalId: string };
      harness: { runId: string };
      control_frame: { control_frame_sha256: string };
    };
  };
  return {
    controlFrameSha256: routed.status.control_frame.control_frame_sha256,
    goalId: routed.status.flow.goalId,
    runId: routed.status.harness.runId,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Coding Harness Host Execution V2 route", () => {
  it("fences canonical mutation while a requested Multi DAG is still pending", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      const authorized = await authorizeWorkCell(host, cwd);
      const session = (host as unknown as { session: TaskFlowSession }).session;
      expect(session.workflowPrompt()).toContain("Next=PENDING_MULTI_PROPOSAL");
      await expect(host.dispatch("tool_preflight", {
        toolCallId: "PENDING-MULTI-WRITE",
        toolName: "write",
        input: { path: "src/input.ts", content: "export const input = 2;\n" },
        cwd,
        control_frame_sha256: authorized.controlFrameSha256,
      })).resolves.toMatchObject({
        allow: false,
        managed: true,
        reason: "MULTI_PROPOSAL_REQUIRED_BEFORE_CANONICAL_MUTATION",
      });
      expect(session.resources()!.authority.readExecutionV2(authorized.runId, 1)).toBeNull();
    } finally {
      host.close();
    }
  });

  it("uses a prior comparable Strong Single epoch in the production Multi gate", async () => {
    const { cwd, options } = fixture();
    let nowMs = 10_000;
    const timedOptions = { ...options, now: () => nowMs };
    const single = new CodingHarnessHostRuntime(timedOptions);
    try {
      await authorizeWorkCell(single, cwd, "SINGLE", "SESSION-HOST-STRONG-SINGLE-QUALIFICATION");
      const session = (single as unknown as { session: TaskFlowSession }).session;
      expect(session.prepareToolOperation({
        toolCallId: "QUALIFICATION-EDIT",
        toolName: "edit",
        input: { path: "src/input.ts", oldText: "input = 1", newText: "input = 2" },
        cwd,
      })).toMatchObject({ allow: true, managed: true });
      writeFileSync(resolve(cwd, "src", "input.ts"), "export const input = 2;\n", "utf8");
      session.observeToolResult("QUALIFICATION-EDIT", false, "edited qualification input");
      nowMs = 20_000;
      expect(session.prepareToolOperation({
        toolCallId: "QUALIFICATION-ORACLE",
        toolName: "bash",
        input: { command: "npm test" },
        cwd,
      })).toMatchObject({ allow: true, managed: true });
      expect(session.observeToolResult("QUALIFICATION-ORACLE", false, "tests passed"))
        .toMatch(/Fresh oracle closure is ready/u);
      await single.dispatch("generation_settled", null);
      expect(session.resources()!.authority.verifyExecutionV2Integrity()).toMatchObject({
        strongSingleRollouts: 1,
        strongSingleWorkloadBindings: 1,
        workloadComparabilityReceipts: 0,
        mismatches: 0,
      });
    } finally {
      single.close();
    }

    writeFileSync(resolve(cwd, "src", "input.ts"), "export const input = 1;\n", "utf8");
    nowMs = 30_000;
    const multi = new CodingHarnessHostRuntime({
      ...timedOptions,
      dynamicMulti: createProductionDynamicMultiHostPortsFactory(),
    });
    try {
      const authorized = await authorizeWorkCell(multi, cwd, "MULTI", "SESSION-HOST-COMPARABLE-MULTI");
      const session = (multi as unknown as { session: TaskFlowSession }).session;
      const sourceSha256 = sha256Hex("export const input = 1;\n");
      const shared = {
        task: "Inspect the exact authorized source and submit typed evidence",
        capabilities: ["SOURCE_DISCOVERY"],
        effect_ceiling: "READ_ONLY",
        read_roots: ["src/input.ts"],
        write_roots: [],
        exact_input_refs: [{ path: "src/input.ts", sha256: sourceSha256, classification: "INTERNAL" }],
        decision_refs: [],
        output_schema_sha256: sha256Hex("comparable-multi-output"),
        privacy_class: "INTERNAL",
        taint_classes: ["INTERNAL"],
        max_turns: 2,
        max_tool_calls: 8,
        max_input_tokens: 8_000,
        max_output_tokens: 2_000,
        max_retries: 1,
        no_progress_limit: 2,
        deadline_ms: 60_000,
      } as const;
      const defined = await multi.dispatch("define_shards", {
        control_frame_sha256: authorized.controlFrameSha256,
        shards: [
          { ...shared, key: "A", dependencies: [] },
          { ...shared, key: "B", dependencies: [] },
        ],
      });
      expect(defined).toMatchObject({
        harness: { effective_topology: "SINGLE", reason: "COST_OR_SAFETY_REGRESSION" },
      });
      expect(session.resources()!.authority.verifyExecutionV2Integrity()).toMatchObject({
        strongSingleRollouts: 1,
        strongSingleWorkloadBindings: 1,
        workloadComparabilityReceipts: 1,
        dynamicMultiProposals: 1,
        topologyMeasurementEvidence: 2,
        topologyMeasurements: 2,
        graphs: 0,
        mismatches: 0,
      });
      expect(session.resources()!.authority.readExecutionV2(authorized.runId, 1)).toBeNull();
    } finally {
      multi.close();
    }
  });

  it("resumes a persisted Multi proposal after a Host crash without asking for another DAG", async () => {
    const { cwd, options } = fixture();
    const crashing = new CodingHarnessHostRuntime({
      ...options,
      dynamicMulti: createProductionDynamicMultiHostPortsFactory({
        measure: () => { throw new Error("SIMULATED_CRASH_AFTER_PROPOSAL"); },
      }),
    });
    const authorized = await authorizeWorkCell(crashing, cwd);
    const sourceSha256 = sha256Hex("export const input = 1;\n");
    const node = {
      task: "Inspect the exact authorized source and submit typed evidence",
      capabilities: ["SOURCE_DISCOVERY"],
      effect_ceiling: "READ_ONLY",
      read_roots: ["src/input.ts"],
      write_roots: [],
      exact_input_refs: [{ path: "src/input.ts", sha256: sourceSha256, classification: "INTERNAL" }],
      decision_refs: [],
      output_schema_sha256: sha256Hex("proposal-recovery-output"),
      privacy_class: "INTERNAL",
      taint_classes: ["INTERNAL"],
      max_turns: 2,
      max_tool_calls: 8,
      max_input_tokens: 8_000,
      max_output_tokens: 2_000,
      max_retries: 1,
      no_progress_limit: 2,
      deadline_ms: 70_000,
    } as const;
    await expect(crashing.dispatch("define_shards", {
      control_frame_sha256: authorized.controlFrameSha256,
      shards: [
        { ...node, key: "A", dependencies: [] },
        { ...node, key: "B", dependencies: [] },
      ],
    })).rejects.toThrow("SIMULATED_CRASH_AFTER_PROPOSAL");
    const crashedSession = (crashing as unknown as { session: TaskFlowSession }).session;
    expect(crashedSession.resources()!.authority.readDynamicMultiProposal(authorized.runId,
      crashedSession.binding()!.authorizedWorkCellId!)).not.toBeNull();
    crashing.close();

    const resumed = new CodingHarnessHostRuntime({
      ...options,
      dynamicMulti: createProductionDynamicMultiHostPortsFactory(),
    });
    try {
      await expect(resumed.dispatch("enter", hostEntry(cwd))).resolves.toMatchObject({
        harness: {
          requestedTopology: "MULTI",
          effectiveTopology: "SINGLE",
          topologyReasonCode: "STRONG_SINGLE_BASELINE_REQUIRED",
        },
      });
      const session = (resumed as unknown as { session: TaskFlowSession }).session;
      expect(session.workflowPrompt()).not.toContain("PENDING_MULTI_PROPOSAL");
      expect(session.workflowPrompt()).not.toContain("coding_delegate action=define");
      expect(session.resources()!.authority.verifyExecutionV2Integrity()).toMatchObject({
        dynamicMultiProposals: 1,
        topologyMeasurementEvidence: 0,
        topologyMeasurements: 0,
        graphs: 0,
        mismatches: 0,
      });
      const attacker = openAuthorityConnection({ path: authorityDatabasePath(options.dataRoot, cwd) });
      try {
        const original = attacker.prepare(`SELECT e.*,sm.store_id FROM events e CROSS JOIN store_meta sm
          WHERE sm.singleton=1 AND e.event_type='DYNAMIC_MULTI_PROPOSAL_RECORDED'`).get() as Record<string, unknown>;
        if (typeof original.event_id !== "string" || typeof original.goal_id !== "string"
          || typeof original.event_type !== "string" || typeof original.command_id !== "string"
          || typeof original.payload_json !== "string" || typeof original.payload_sha256 !== "string"
          || typeof original.event_sha256 !== "string" || typeof original.store_id !== "string") {
          throw new TypeError("Dynamic Multi proposal event fixture is incomplete");
        }
        const injectedPayload = {
          ...(JSON.parse(original.payload_json) as Record<string, unknown>),
          injected: "untrusted-extra-field",
        };
        const payloadJson = canonicalJson(injectedPayload);
        const payloadSha256 = canonicalJsonSha256(injectedPayload);
        const eventSha256 = computeEventSha256({
          storeId: original.store_id, goalId: original.goal_id,
          sequence: Number(original.sequence), eventType: original.event_type,
          commandId: original.command_id, payloadSha256,
          prevEventSha256: typeof original.prev_event_sha256 === "string" ? original.prev_event_sha256 : null,
          storeGeneration: Number(original.store_generation), leaderEpoch: Number(original.leader_epoch),
        });
        attacker.exec("DROP TRIGGER no_update_events");
        attacker.prepare("UPDATE events SET payload_json=?,payload_sha256=?,event_sha256=? WHERE event_id=?")
          .run(payloadJson, payloadSha256, eventSha256, original.event_id);
        expect(() => session.resources()!.authority.verifyExecutionV2Integrity()).toThrow(/1 mismatch/u);
        attacker.prepare("UPDATE events SET payload_json=?,payload_sha256=?,event_sha256=? WHERE event_id=?")
          .run(original.payload_json, original.payload_sha256, original.event_sha256, original.event_id);
        expect(session.resources()!.authority.verifyExecutionV2Integrity().mismatches).toBe(0);

        attacker.exec("DROP TRIGGER no_update_workspace_baselines_v1");
        attacker.prepare("UPDATE workspace_baselines_v1 SET content_root_sha256=? WHERE baseline_id=(SELECT baseline_id FROM execution_authorizations_v1 LIMIT 1)")
          .run(sha256Hex("tampered-proposal-baseline"));
        expect(() => session.resources()!.authority.verifyExecutionV2Integrity()).toThrow(/1 mismatch/u);
      } finally {
        closeAuthorityConnection(attacker);
      }
    } finally {
      resumed.close();
    }
  });

  it("admits and continuously backfills A/B/C through the real Host authority", async () => {
    const { cwd, options } = fixture();
    const startedLogicalKeys: string[] = [];
    const logicalKeyByNodeId = new Map<string, string>();
    const blockedB: { release: (() => void) | null } = { release: null };
    const runtime = {
      provider: "configured-provider",
      api: "configured-api",
      model: "configured-model",
      thinking_level: "configured",
      context_window: 65_536,
    } as const;
    const sourceSha256 = sha256Hex("export const input = 1;\n");
    const resultFor = (input: WorkerAttemptExecuteInputV2): WorkerAttemptResultV2 => {
      const proposal = finalizeWorkerProposalV2({
        packet: input.packet,
        kind: "EVIDENCE_PROPOSAL",
        payload: {
          artifact_refs: [{
            sha256: sourceSha256,
            classification: "INTERNAL",
          }],
        },
        created_at_ms: 10_000,
      });
      return {
        status: "PROPOSED",
        proposal,
        patch_set: null,
        stopped: null,
        protocol: {
          schema_version: 2,
          reason_code: null,
          submission_count: 1,
          assistant_text_is_display_only: true,
        },
        display_text: "",
        patches: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost: 0,
          turns: 1,
          tool_calls: 1,
          wall_time_ms: 1,
        },
        runtime_resolution: { runtime, source: "SUPERVISOR_INHERITED", fallback_reason: null },
      };
    };
    const hostOptions: CodingHarnessHostOptions = {
      ...options,
      dynamicMulti: createProductionDynamicMultiHostPortsFactory({
        measure: () => ({
          strong_single: {
            correctness: "PASS" as const,
            quality_basis_points: 10_000,
            wall_time_ms: 10_000,
            provider_requests: 3,
            input_tokens: 12_000,
            output_tokens: 3_000,
            user_interventions: 0,
            safety_events: 0,
            source_evidence_sha256: sha256Hex("host-strong-single-evidence"),
          },
          candidate: {
            correctness: "PASS" as const,
            estimated_quality_basis_points: 10_000,
            estimated_wall_time_ms: 7_000,
            estimated_provider_requests: 3,
            estimated_input_tokens: 12_000,
            estimated_output_tokens: 3_000,
            estimated_user_interventions: 0,
            estimated_safety_events: 0,
            source_evidence_sha256: sha256Hex("host-dynamic-multi-simulator"),
          },
        }),
        worker: {
          execute(input: WorkerAttemptExecuteInputV2): Promise<WorkerAttemptResultV2> {
            const logicalKey = logicalKeyByNodeId.get(input.packet.node_id);
            if (!logicalKey) return Promise.reject(new TypeError("Host dispatched a node outside its committed graph"));
            startedLogicalKeys.push(logicalKey);
            if (logicalKey !== "B") return Promise.resolve(resultFor(input));
            return new Promise((resolveB) => { blockedB.release = () => resolveB(resultFor(input)); });
          },
        },
        runOracle: () => Promise.resolve({ exitCode: 0, output: "production Host oracle PASS" }),
      }),
    };
    const host = new CodingHarnessHostRuntime(hostOptions);
    try {
      const authorized = await authorizeWorkCell(host, cwd);
      const session = (host as unknown as { session: TaskFlowSession }).session;
      const preparation = session.resources()!.authority.readExecutionV2Preparation(authorized.goalId, authorized.runId);
      const runtimeFingerprintSha256 = piRuntimeFingerprintSha256(runtime);
      const shared = {
        task: "Inspect the exact authorized source and submit typed evidence",
        capabilities: ["SOURCE_DISCOVERY"],
        effect_ceiling: "READ_ONLY",
        read_roots: ["src/input.ts"],
        write_roots: [],
        exact_input_refs: [{ path: "src/input.ts", sha256: sourceSha256, classification: "INTERNAL" }],
        decision_refs: [],
        output_schema_sha256: sha256Hex("host-execution-v2-output"),
        oracle_sha256: preparation.workCellOracleSha256,
        provider_profile_sha256: runtimeFingerprintSha256,
        privacy_class: "INTERNAL",
        taint_classes: ["INTERNAL"],
        max_turns: 2,
        max_tool_calls: 8,
        max_input_tokens: 8_000,
        max_output_tokens: 2_000,
        max_retries: 1,
        no_progress_limit: 2,
        deadline_ms: 70_000,
      } as const;
      const defined = await host.dispatch("define_shards", {
        control_frame_sha256: authorized.controlFrameSha256,
        shards: [
          { ...shared, key: "A", dependencies: [] },
          { ...shared, key: "B", dependencies: [] },
          { ...shared, key: "C", dependencies: [{ key: "A", condition: "EVIDENCE_ACCEPTED" }] },
        ],
      }) as { status: { control_frame: { control_frame_sha256: string } } };

      expect(session.resources()!.authority.verifyExecutionV2Integrity()).toMatchObject({
        topologyMeasurementEvidence: 2,
        topologyMeasurements: 2,
        mismatches: 0,
      });

      const projection = session.resources()!.authority.readExecutionV2(authorized.runId, 2);
      for (const node of projection?.graph.nodes ?? []) logicalKeyByNodeId.set(node.node_id, node.logical_key);
      expect(projection).toMatchObject({
        status: "RUNNING",
        graph: {
          goal_id: authorized.goalId,
          run_id: authorized.runId,
          edges: [expect.objectContaining({ condition: "EVIDENCE_ACCEPTED" })],
        },
      });
      expect(projection?.graph.nodes.map((node) => node.logical_key).sort()).toEqual(["A", "B", "C"]);
      expect(projection?.graph.nodes.every((node) => node.capabilities.includes("SOURCE_DISCOVERY"))).toBe(true);
      expect(projection?.readyNodeIds.map((nodeId) => logicalKeyByNodeId.get(nodeId))).toEqual(["A", "B"]);
      expect(session.workflowPrompt()).toContain("coding_delegate action=run_ready");
      expect(session.workflowPrompt()).not.toContain("coding_delegate action=define");
      await expect(host.dispatch("update_runtime", {
        ...runtime,
        base_url: "http://127.0.0.1:58493/v1",
      })).rejects.toThrow("committed Execution V2 graph");
      expect(startedLogicalKeys).toEqual([]);

      const job = await host.dispatch("worker_start", {
        control_frame_sha256: defined.status.control_frame.control_frame_sha256,
        max_parallel: 2,
      }) as { job_id: string };
      for (let attempt = 0; attempt < 100 && !startedLogicalKeys.includes("C"); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(startedLogicalKeys.slice(0, 3)).toEqual(["A", "B", "C"]);
      expect(blockedB.release).not.toBeNull();
      blockedB.release?.();
      let terminal: HostWorkerStatus | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        terminal = await host.dispatch("worker_poll", { job_id: job.job_id });
        if (terminal?.state !== "RUNNING") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(terminal?.error).toBeNull();
      expect(terminal).toMatchObject({ state: "SUCCEEDED", worker_count: 2 });
      expect(session.resources()!.authority.readExecutionV2(authorized.runId, 2)).toMatchObject({
        status: "CLOSED",
        completedNodeIds: expect.arrayContaining([...logicalKeyByNodeId.keys()]),
      });

      host.close();
      const resumed = new CodingHarnessHostRuntime(hostOptions);
      try {
        await expect(resumed.dispatch("enter", hostEntry(cwd))).resolves.toMatchObject({
          harness: { requestedTopology: "MULTI", effectiveTopology: "MULTI" },
        });
        await expect(resumed.dispatch("worker_poll", { job_id: job.job_id })).resolves.toMatchObject({
          state: "SUCCEEDED",
          result: { graph_status: "CLOSED" },
        });
      } finally {
        resumed.close();
      }
    } finally {
      host.close();
    }
  });

  it.each(["ACTIVE_GOAL_INPUT", "CANCEL", "RECOVERED_ABORT"] as const)(
    "durably stops Execution V2 through %s",
    async (trigger) => {
      const { cwd, options } = fixture();
      const runtime = {
        provider: "configured-provider",
        api: "configured-api",
        model: "configured-model",
        thinking_level: "configured",
        context_window: 65_536,
      } as const;
      let authorityStatusAtAbort: string | null = null;
      let session: TaskFlowSession | null = null;
      const hostOptions = {
        ...options,
        dynamicMulti: {
          measure: () => ({
            strong_single: {
              correctness: "PASS" as const,
              quality_basis_points: 10_000,
              wall_time_ms: 10_000,
              provider_requests: 1,
              input_tokens: 4_000,
              output_tokens: 1_000,
              user_interventions: 0,
              safety_events: 0,
              source_evidence_sha256: sha256Hex(`host-stop-single:${trigger}`),
            },
            candidate: {
              correctness: "PASS" as const,
              estimated_quality_basis_points: 10_000,
              estimated_wall_time_ms: 5_000,
              estimated_provider_requests: 1,
              estimated_input_tokens: 4_000,
              estimated_output_tokens: 1_000,
              estimated_user_interventions: 0,
              estimated_safety_events: 0,
              source_evidence_sha256: sha256Hex(`host-stop-multi:${trigger}`),
            },
          }),
          worker: {
            execute(input: WorkerAttemptExecuteInputV2): Promise<WorkerAttemptResultV2> {
              return new Promise((resolveResult, rejectResult) => {
                if (!input.signal) return rejectResult(new TypeError("Host worker signal is missing"));
                input.signal.addEventListener("abort", () => {
                  const projection = session?.resources()?.authority.readExecutionV2(
                    session.harnessView()!.runId,
                    1,
                  );
                  authorityStatusAtAbort = projection?.status ?? null;
                  const proposal = finalizeWorkerProposalV2({
                    packet: input.packet,
                    kind: "EVIDENCE_PROPOSAL",
                    payload: {
                      artifact_refs: [{
                        sha256: sha256Hex(`host-stop-late:${input.packet.node_id}`),
                        classification: "INTERNAL",
                      }],
                    },
                    created_at_ms: 10_000,
                  });
                  resolveResult({
                    status: "PROPOSED",
                    proposal,
                    patch_set: null,
                    stopped: null,
                    protocol: {
                      schema_version: 2,
                      reason_code: null,
                      submission_count: 1,
                      assistant_text_is_display_only: true,
                    },
                    display_text: "",
                    patches: [],
                    usage: {
                      input_tokens: 1,
                      output_tokens: 1,
                      cache_read_tokens: 0,
                      cache_write_tokens: 0,
                      cost: 0,
                      turns: 1,
                      tool_calls: 1,
                      wall_time_ms: 1,
                    },
                    runtime_resolution: { runtime, source: "SUPERVISOR_INHERITED", fallback_reason: null },
                  });
                }, { once: true });
              });
            },
          },
          evidence: {
            accept: async ({ proposal }: { readonly proposal: { readonly proposal_id: string } }) => ({
              evidence_sha256: sha256Hex(`host-stop-accepted:${proposal.proposal_id}`),
            }),
          },
          oracle: {
            validate: async () => {
              throw new TypeError("Stopped Host execution must not invoke the oracle");
            },
          },
        },
      };
      let host = new CodingHarnessHostRuntime(hostOptions);
      try {
        const authorized = await authorizeWorkCell(host, cwd);
        session = (host as unknown as { session: TaskFlowSession }).session;
        let authority = session.resources()!.authority;
        const preparation = authority.readExecutionV2Preparation(authorized.goalId, authorized.runId);
        const runtimeFingerprintSha256 = piRuntimeFingerprintSha256(runtime);
        const stopShard = {
            key: "STOP-A",
            dependencies: [],
            task: "Wait until the Host fences this exact worker attempt",
            capabilities: ["SOURCE_DISCOVERY"],
            effect_ceiling: "READ_ONLY",
            read_roots: ["src/input.ts"],
            write_roots: [],
            exact_input_refs: [{
              path: "src/input.ts",
              sha256: sha256Hex("export const input = 1;\n"),
              classification: "INTERNAL",
            }],
            decision_refs: [],
            output_schema_sha256: sha256Hex("host-stop-output"),
            oracle_sha256: preparation.workCellOracleSha256,
            provider_profile_sha256: runtimeFingerprintSha256,
            privacy_class: "INTERNAL",
            taint_classes: ["INTERNAL"],
            max_turns: 2,
            max_tool_calls: 8,
            max_input_tokens: 4_000,
            max_output_tokens: 1_000,
            max_retries: 1,
            no_progress_limit: 2,
            deadline_ms: 70_000,
        } as const;
        const defined = await host.dispatch("define_shards", {
          control_frame_sha256: authorized.controlFrameSha256,
          shards: [stopShard, { ...stopShard, key: "STOP-B" }],
        }) as { status: { control_frame: { control_frame_sha256: string } } };
        let job: { readonly job_id: string };
        if (trigger === "RECOVERED_ABORT") {
          host.close();
          host = new CodingHarnessHostRuntime(hostOptions);
          await host.dispatch("enter", hostEntry(cwd));
          session = (host as unknown as { session: TaskFlowSession }).session;
          authority = session.resources()!.authority;
          job = { job_id: `EXECUTION-V2-${authorized.runId}` };
        } else {
          job = await host.dispatch("worker_start", {
            control_frame_sha256: defined.status.control_frame.control_frame_sha256,
            max_parallel: 1,
          }) as { job_id: string };
          const runningStatus = await host.dispatch("status", null) as unknown as {
            decision_inbox: { evidence: {
              execution_status: string;
              ready_work_count: number;
              active_work_count: number;
              completed_work_count: number;
            } };
          };
          expect(runningStatus.decision_inbox.evidence).toMatchObject({
            execution_status: "RUNNING",
            ready_work_count: 1,
            active_work_count: 1,
            completed_work_count: 0,
          });
        }

        if (trigger === "ACTIVE_GOAL_INPUT") {
          await host.dispatch("active_goal_input", { text: "Preserve the adjacent parser before continuing." });
          expect(authority.readPendingActiveGoalUserTurns(authorized.goalId)).toHaveLength(1);
        } else if (trigger === "CANCEL") {
          await host.dispatch("control", { action: "cancel", reason: "User confirmed cancellation" });
        } else {
          await host.dispatch("worker_abort", { job_id: job.job_id });
        }

        expect(authorityStatusAtAbort).toBe(trigger === "RECOVERED_ABORT" ? null : "STOPPED");
        expect(authority.readExecutionV2(authorized.runId, 1)).toMatchObject({ status: "STOPPED" });
        await expect(host.dispatch("worker_poll", { job_id: job.job_id })).resolves.toMatchObject({
          state: "ABORTED",
          result: { graph_status: "STOPPED" },
        });
        expect(authority.verifyExecutionV2Integrity()).toMatchObject({
          stops: 1,
          proposals: 0,
          hostReceipts: 0,
          mismatches: 0,
        });
      } finally {
        await host.dispatch("shutdown", null).catch(() => undefined);
      }
    },
  );
});
