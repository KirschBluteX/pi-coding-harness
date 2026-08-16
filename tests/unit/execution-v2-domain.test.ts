import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  assertTaskPacketV2,
  assertWorkerPatchSetV2,
  createTaskPacketV2,
  executionNodeInputClosureV2,
  finalizeExecutionGraphTerminalReceiptV2,
  finalizeExecutionIntegrationAttemptV2,
  finalizeExecutionStopV2,
  finalizeHostOracleReceiptV2,
  finalizeHostNodeReceiptV2,
  finalizeWorkerPatchSetV2,
  finalizeWorkerProposalV2,
  sealExecutionV2,
  type ExecutionNodeSpecV2,
  type HostNodeReceiptV2,
} from "../../src/harness/execution-v2/domain.js";
import {
  finalizeExecutionGraphV2,
  readyExecutionNodeIdsV2,
  successfulExecutionNodeIdsV2,
} from "../../src/harness/execution-v2/dag.js";

const sha = (value: string): string => sha256Hex(value);

function node(
  id: string,
  input: Partial<Omit<ExecutionNodeSpecV2, "schema_version" | "node_id" | "record_sha256">> = {},
): Omit<ExecutionNodeSpecV2, "record_sha256"> {
  const task = `Inspect the exact source and return typed evidence for ${id}`;
  const requirementIds = ["REQ-001"];
  const obligationIds = ["OBL-001"];
  const outputSchema = sha(`output:${id}`);
  const oracle = sha(`oracle:${id}`);
  const providerProfile = sha("provider-profile");
  return {
    schema_version: 2,
    node_id: id,
    logical_key: id.toLowerCase(),
    task,
    capabilities: ["SOURCE_DISCOVERY"],
    effect_ceiling: "READ_ONLY",
    requirement_ids: requirementIds,
    obligation_ids: obligationIds,
    read_roots: ["src"],
    write_roots: [],
    exact_input_refs: [],
    decision_refs: [],
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
    input_closure_sha256: executionNodeInputClosureV2({
      task, requirement_ids: requirementIds, obligation_ids: obligationIds,
      exact_input_refs: [], decision_refs: [], output_schema_sha256: outputSchema,
      oracle_sha256: oracle, provider_profile_sha256: providerProfile,
    }),
    output_schema_sha256: outputSchema,
    oracle_sha256: oracle,
    provider_profile_sha256: providerProfile,
    privacy_class: "INTERNAL",
    taint_classes: [],
    max_turns: 4,
    max_tool_calls: 16,
    max_input_tokens: 32_000,
    max_output_tokens: 8_000,
    max_retries: 1,
    no_progress_limit: 2,
    deadline_ms: 1_800_000_000_000,
    ...input,
  };
}

const graphClosure = {
  goal_id: "GOAL-EXECUTION-V2-001",
  run_id: "RUN-EXECUTION-V2-001",
  work_cell_id: "CELL-EXECUTION-V2-001",
  plan_revision_id: "PLAN-REVISION-EXECUTION-V2-001",
  plan_revision_sha256: sha("plan"),
  topology_gate_receipt_id: "TOPOLOGY-GATE-EXECUTION-V2-001",
  topology_gate_receipt_sha256: sha("topology-gate"),
  authorization_id: "AUTHORIZATION-EXECUTION-V2-001",
  authorization_sha256: sha("authorization"),
  baseline_sha256: sha("baseline"),
  baseline_content_root_sha256: sha("baseline-content-root"),
  environment_sha256: sha("environment"),
  input_closure_sha256: sha("graph-input"),
  oracle_set_sha256: sha("oracle-set"),
  config_sha256: sha("config"),
  runtime_fingerprint_sha256: sha("runtime"),
  predecessor_authority_head_sha256: sha("event-head"),
  graph_revision: 1,
  stop_generation: 0,
  created_at_ms: 1_790_000_000_000,
} as const;

describe("Dynamic Multi execution domain", () => {
  it("rejects cycles and parallel write-scope conflicts before a graph can be sealed", () => {
    expect(() => finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [
        node("NODE-A", { capabilities: ["PATCH_PROPOSE"], effect_ceiling: "PATCH_PROPOSAL", write_roots: ["src/shared"] }),
        node("NODE-B", { capabilities: ["PATCH_PROPOSE"], effect_ceiling: "PATCH_PROPOSAL", write_roots: ["src/shared/file.ts"] }),
      ],
      edges: [],
    })).toThrow(/parallel write scopes overlap/u);

    expect(() => finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [node("NODE-A"), node("NODE-B")],
      edges: [
        { from_node_id: "NODE-A", to_node_id: "NODE-B", condition: "EVIDENCE_ACCEPTED" },
        { from_node_id: "NODE-B", to_node_id: "NODE-A", condition: "ORACLE_PASSED" },
      ],
    })).toThrow(/cycle/u);
  });

  it("rejects a graph whose durable source refs differ from its node input closure", () => {
    expect(() => finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [{
        ...node("NODE-A"),
        exact_input_refs: [{ path: "src/a.ts", sha256: sha("source-a"), classification: "INTERNAL" }],
        decision_refs: [],
        provider_call_plan_id: null,
        provider_call_plan_sha256: null,
      } as never],
      edges: [],
    })).toThrow(/input closure/u);
  });

  it("continuously backfills the highest critical-path ready node", () => {
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [node("NODE-A"), node("NODE-B"), node("NODE-C"), node("NODE-D")],
      edges: [
        { from_node_id: "NODE-A", to_node_id: "NODE-C", condition: "EVIDENCE_ACCEPTED" },
        { from_node_id: "NODE-B", to_node_id: "NODE-C", condition: "ORACLE_PASSED" },
      ],
    });
    expect(readyExecutionNodeIdsV2(graph, [], [], 2)).toEqual(["NODE-A", "NODE-B"]);

    const accepted = finalizeHostNodeReceiptV2({
      graph,
      node_id: "NODE-A",
      packet_id: "PACKET-A",
      packet_sha256: sha("packet-a"),
      proposal_id: "PROPOSAL-A",
      proposal_sha256: sha("proposal-a"),
      kind: "EVIDENCE_ACCEPTED",
      evidence_sha256: sha("evidence-a"),
      preimage_root_sha256: null,
      postimage_root_sha256: null,
      stop_generation: 0,
      predecessor_authority_head_sha256: sha("receipt-head"),
      created_at_ms: 1_790_000_000_010,
    });
    expect(readyExecutionNodeIdsV2(graph, [accepted], ["NODE-B"], 1)).toEqual(["NODE-D"]);
    expect(successfulExecutionNodeIdsV2(graph, [accepted])).toEqual([]);
    const passed = finalizeHostNodeReceiptV2({
      graph,
      node_id: "NODE-A",
      packet_id: "PACKET-A",
      packet_sha256: sha("packet-a"),
      proposal_id: "PROPOSAL-A",
      proposal_sha256: sha("proposal-a"),
      kind: "ORACLE_PASSED",
      evidence_sha256: sha("host-oracle-a"),
      preimage_root_sha256: null,
      postimage_root_sha256: null,
      stop_generation: 0,
      predecessor_authority_head_sha256: sha("oracle-receipt-head"),
      created_at_ms: 1_790_000_000_011,
    });
    expect(successfulExecutionNodeIdsV2(graph, [accepted, passed])).toEqual(["NODE-A"]);
  });

  it("uses the earliest deadline before stable ID when ready nodes have equal critical paths", () => {
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [
        node("NODE-A", { deadline_ms: 1_800_000_000_000 }),
        node("NODE-B", { deadline_ms: 1_799_000_000_000 }),
      ],
      edges: [],
    });
    expect(readyExecutionNodeIdsV2(graph, [], [], 1)).toEqual(["NODE-B"]);
  });

  it("binds the complete TaskPacket to its capability HMAC and current stop generation", () => {
    const exactInputRefs = [{ path: "src/index.ts", sha256: sha("source"), classification: "INTERNAL" as const }];
    const decisionRefs = [{ decision_id: "DECISION-001", sha256: sha("decision") }];
    const baseNode = node("NODE-A");
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [{
        ...baseNode,
        exact_input_refs: exactInputRefs,
        decision_refs: decisionRefs,
        input_closure_sha256: executionNodeInputClosureV2({
          task: baseNode.task,
          requirement_ids: baseNode.requirement_ids,
          obligation_ids: baseNode.obligation_ids,
          exact_input_refs: exactInputRefs,
          decision_refs: decisionRefs,
          output_schema_sha256: baseNode.output_schema_sha256,
          oracle_sha256: baseNode.oracle_sha256,
          provider_profile_sha256: baseNode.provider_profile_sha256,
        }),
      }],
      edges: [],
    });
    const packet = createTaskPacketV2({
      graph,
      node_id: "NODE-A",
      attempt: 1,
      lease_generation: 3,
      fencing_token: 7,
      exact_input_refs: exactInputRefs,
      decision_refs: decisionRefs,
      provider_call_plan_id: null,
      provider_call_plan_sha256: null,
      deadline_ms: 1_790_000_100_000,
      created_at_ms: 1_790_000_000_020,
    }, "test-capability-key");

    expect(() => assertTaskPacketV2(packet, "test-capability-key", {
      graph_sha256: graph.record_sha256,
      authorization_sha256: graph.authorization_sha256,
      stop_generation: 0,
      now_ms: 1_790_000_000_021,
    })).not.toThrow();
    expect(() => assertTaskPacketV2(packet, "wrong-capability-key", {
      graph_sha256: graph.record_sha256,
      authorization_sha256: graph.authorization_sha256,
      stop_generation: 0,
      now_ms: 1_790_000_000_021,
    })).toThrow(/HMAC/u);
    expect(() => assertTaskPacketV2(packet, "test-capability-key", {
      graph_sha256: graph.record_sha256,
      authorization_sha256: graph.authorization_sha256,
      stop_generation: 1,
      now_ms: 1_790_000_000_021,
    })).toThrow(/stop generation/u);
  });

  it("accepts only one schema-valid typed Worker proposal and never narrative authority", () => {
    const graph = finalizeExecutionGraphV2({ ...graphClosure, nodes: [node("NODE-A")], edges: [] });
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      exact_input_refs: [], decision_refs: [], provider_call_plan_id: null, provider_call_plan_sha256: null,
      deadline_ms: 1_790_000_100_000, created_at_ms: 1_790_000_000_020,
    }, "test-capability-key");
    const proposal = finalizeWorkerProposalV2({
      packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("artifact"), classification: "INTERNAL" }] },
      created_at_ms: 1_790_000_000_030,
    });
    expect(proposal.trust).toBe("UNVERIFIED_PROPOSAL");

    expect(() => finalizeWorkerProposalV2({
      packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("artifact"), classification: "INTERNAL" }] },
      created_at_ms: 1_790_000_000_030,
      narrative: "oracle passed",
    } as never)).toThrow(/unexpected field/u);
  });

  it("derives PatchSet identity and rejects paths outside the packet write grant", () => {
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [node("NODE-A", {
        capabilities: ["PATCH_PROPOSE"], effect_ceiling: "PATCH_PROPOSAL", write_roots: ["src/allowed"],
      })],
      edges: [],
    });
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      exact_input_refs: [], decision_refs: [], provider_call_plan_id: null, provider_call_plan_sha256: null,
      deadline_ms: 1_790_000_100_000, created_at_ms: 1_790_000_000_020,
    }, "test-capability-key");
    for (const path of ["/outside.ts", "C:/outside.ts", "src/other.ts"]) {
      expect(() => finalizeWorkerPatchSetV2({
        packet, patches: [{ operation: "CREATE", path, beforeSha256: null, content: Buffer.from("x") }],
        created_at_ms: 1_790_000_000_030,
      })).toThrow(/write scope|identity/u);
    }
    const patchSet = finalizeWorkerPatchSetV2({
      packet,
      patches: [{ operation: "CREATE", path: "src/allowed/new.ts", beforeSha256: null, content: Buffer.from("x") }],
      created_at_ms: 1_790_000_000_030,
    });
    const { record_sha256: _originalPatchSetHash, ...patchSetBody } = patchSet;
    void _originalPatchSetHash;
    const forged = sealExecutionV2("PCH-WORKER-PATCH-SET-V2", {
      ...patchSetBody,
      proposed_postimage_root_sha256: sha("forged-postimage"),
    });
    expect(() => assertWorkerPatchSetV2(forged as never)).toThrow(/derived identity|unexpected field/u);
  });

  it("rebases serial integration authority without rewriting a Worker PatchSet baseline", () => {
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [node("NODE-A", {
        capabilities: ["PATCH_PROPOSE"], effect_ceiling: "PATCH_PROPOSAL", write_roots: ["src/allowed"],
      })],
      edges: [],
    });
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      exact_input_refs: [], decision_refs: [], provider_call_plan_id: null, provider_call_plan_sha256: null,
      deadline_ms: 1_790_000_100_000, created_at_ms: 1_790_000_000_020,
    }, "test-capability-key");
    const patchSet = finalizeWorkerPatchSetV2({
      packet,
      patches: [{ operation: "CREATE", path: "src/allowed/new.ts", beforeSha256: null, content: Buffer.from("x") }],
      created_at_ms: 1_790_000_000_030,
    });
    const proposal = finalizeWorkerProposalV2({
      packet,
      kind: "PATCH_PROPOSAL",
      payload: {
        patch_set_id: patchSet.patch_set_id,
        patch_set_sha256: patchSet.record_sha256,
        affected_paths: patchSet.affected_paths,
        preimage_root_sha256: patchSet.baseline_sha256,
        proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
      },
      created_at_ms: 1_790_000_000_030,
    });
    const rebasedPreimage = sha("canonical-root-after-prior-disjoint-patch");
    expect(finalizeExecutionIntegrationAttemptV2({
      graph,
      node_id: "NODE-A",
      proposal,
      patch_set: patchSet,
      authorization_sha256: graph.authorization_sha256,
      expected_preimage_root_sha256: rebasedPreimage,
      lease_generation: 1,
      fencing_token: 1,
      owner_hmac: sha("integrator-owner"),
      expires_at_ms: 1_790_000_090_000,
      created_at_ms: 1_790_000_000_040,
    }).attempt.expected_preimage_root_sha256).toBe(rebasedPreimage);
  });

  it("binds ORACLE_PASSED to Host-owned validation receipts rather than an opaque hash", () => {
    const graph = finalizeExecutionGraphV2({ ...graphClosure, nodes: [node("NODE-A")], edges: [] });
    const oracle = finalizeHostOracleReceiptV2({
      graph,
      node_id: "NODE-A",
      packet_id: "PACKET-A",
      packet_sha256: sha("packet-a"),
      proposal_id: "PROPOSAL-A",
      proposal_sha256: sha("proposal-a"),
      postimage_root_sha256: sha("postimage-a"),
      covered_obligation_ids: ["OBL-001"],
      validation_evidence: [{
        obligation_id: "OBL-001",
        oracle_pass_receipt_id: "ORACLE-PASS-A",
        oracle_pass_receipt_sha256: sha("oracle-pass-a"),
        evidence_requirement_id: "EVIDENCE-REQUIREMENT-A",
        operation_attempt_id: "OPERATION-ATTEMPT-A",
        operation_attempt_sha256: sha("operation-attempt-a"),
        terminal_transition_id: "OPERATION-TRANSITION-A",
        terminal_transition_sha256: sha("operation-transition-a"),
      }],
      predecessor_authority_head_sha256: sha("oracle-head"),
      created_at_ms: 1_790_000_000_040,
    });
    expect(oracle).toMatchObject({
      result: "PASS",
      freshness: "CURRENT",
      oracle_sha256: graph.nodes[0]!.oracle_sha256,
      oracle_set_sha256: graph.oracle_set_sha256,
      environment_sha256: graph.environment_sha256,
      covered_obligation_ids: ["OBL-001"],
      trust: "HOST_DERIVED",
    });
  });

  it("allows a successful graph terminal receipt only after every node is ORACLE_PASSED", () => {
    const graph = finalizeExecutionGraphV2({
      ...graphClosure,
      nodes: [node("NODE-A"), node("NODE-B")],
      edges: [],
    });
    const terminal = {
      graph,
      terminal_status: "CLOSED" as const,
      reason_code: "ALL_CURRENT_NODES_ORACLE_PASSED",
      current_postimage_root_sha256: graph.baseline_content_root_sha256,
      integration_frontier_sha256: sha("integration-frontier"),
      failure_evidence_sha256: null,
      predecessor_authority_head_sha256: sha("terminal-head"),
      created_at_ms: 1_790_000_000_050,
    };

    for (const intermediate of ["EVIDENCE_ACCEPTED", "PATCH_INTEGRATED"] as const) {
      expect(() => finalizeExecutionGraphTerminalReceiptV2({
        ...terminal,
        node_frontier: [
          { node_id: "NODE-A", status: intermediate as never, evidence_sha256: sha(`intermediate:${intermediate}`) },
          { node_id: "NODE-B", status: "ORACLE_PASSED", evidence_sha256: sha("oracle-passed:b") },
        ],
      })).toThrow(/ORACLE_PASSED|terminal node status is invalid/u);
    }

    expect(() => finalizeExecutionGraphTerminalReceiptV2({
      ...terminal,
      node_frontier: graph.nodes.map((member) => ({
        node_id: member.node_id,
        status: "ORACLE_PASSED" as const,
        evidence_sha256: sha(`oracle-passed:${member.node_id}`),
      })),
    })).not.toThrow();
  });

  it("requires Host receipts for readiness and fences late results with a durable stop", () => {
    const graph = finalizeExecutionGraphV2({ ...graphClosure, nodes: [node("NODE-A")], edges: [] });
    const stop = finalizeExecutionStopV2({
      graph,
      stop_generation: 1,
      scope: "GRAPH_STOP",
      reason: "USER_CANCEL",
      affected_node_ids: ["NODE-A"],
      predecessor_authority_head_sha256: sha("stop-head"),
      created_at_ms: 1_790_000_000_040,
    });
    expect(stop).toMatchObject({ stop_generation: 1, reason: "USER_CANCEL", affected_node_ids: ["NODE-A"] });

    const forged = {
      kind: "ORACLE_PASSED",
      graph_revision_sha256: graph.record_sha256,
      node_id: "NODE-A",
      stop_generation: 0,
    } as unknown as HostNodeReceiptV2;
    expect(() => readyExecutionNodeIdsV2(graph, [forged], [], 1)).toThrow(/Host receipt/u);
  });
});
