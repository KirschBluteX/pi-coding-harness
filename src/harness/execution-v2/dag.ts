import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { scopesMayOverlap } from "../scope-path.js";
import {
  assertHostNodeReceiptV2,
  boundedIdV2,
  exactKeysV2,
  executionNodeInputClosureV2,
  integerV2,
  sealExecutionV2,
  sha256V2,
  type ExecutionCapabilityV2,
  type ExecutionEdgeConditionV2,
  type ExecutionEdgeV2,
  type ExecutionGraphRevisionV2,
  type ExecutionNodeSpecV2,
  type HostNodeReceiptV2,
} from "./domain.js";

const capabilitySet: ReadonlySet<string> = new Set<ExecutionCapabilityV2>([
  "SOURCE_DISCOVERY", "REQUIREMENT_ANALYSIS", "PATCH_PROPOSE", "CONFLICT_PROPOSE", "ORACLE_REQUEST",
]);
const edgeConditionSet: ReadonlySet<string> = new Set<ExecutionEdgeConditionV2>([
  "EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED",
]);

type NodeInput = Omit<ExecutionNodeSpecV2,
  "record_sha256" | "exact_input_refs" | "decision_refs" | "provider_call_plan_id" | "provider_call_plan_sha256">
  & Partial<Pick<ExecutionNodeSpecV2,
    "exact_input_refs" | "decision_refs" | "provider_call_plan_id" | "provider_call_plan_sha256">>;
type EdgeInput = Omit<ExecutionEdgeV2, "record_sha256">;

function stringArray(value: readonly string[], label: string, options: { readonly nonEmpty?: boolean } = {}): readonly string[] {
  const entries: readonly unknown[] = value;
  if (!Array.isArray(entries) || (options.nonEmpty === true && entries.length === 0)
    || entries.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 1_024)
    || new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} is invalid`);
  }
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new TypeError(`${label} is invalid`);
    return entry;
  });
}

function finalizeNode(input: NodeInput): ExecutionNodeSpecV2 {
  const value = {
    ...input,
    exact_input_refs: input.exact_input_refs ?? [],
    decision_refs: input.decision_refs ?? [],
    provider_call_plan_id: input.provider_call_plan_id ?? null,
    provider_call_plan_sha256: input.provider_call_plan_sha256 ?? null,
  };
  exactKeysV2(value, [
    "schema_version", "node_id", "logical_key", "task", "capabilities", "effect_ceiling",
    "requirement_ids", "obligation_ids", "read_roots", "write_roots", "exact_input_refs",
    "decision_refs", "provider_call_plan_id", "provider_call_plan_sha256", "input_closure_sha256",
    "output_schema_sha256", "oracle_sha256", "provider_profile_sha256", "privacy_class",
    "taint_classes", "max_turns", "max_tool_calls", "max_input_tokens", "max_output_tokens",
    "max_retries", "no_progress_limit", "deadline_ms",
  ], "Execution node");
  boundedIdV2(value.node_id, "Execution node");
  if (!value.logical_key || value.logical_key.length > 160) throw new TypeError("Execution node logical key is invalid");
  if (!value.task || value.task.length > 16_384 || value.task !== value.task.normalize("NFC")) {
    throw new TypeError("Execution node task is invalid");
  }
  const capabilities: readonly unknown[] = value.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0
    || capabilities.some((entry) => typeof entry !== "string" || !capabilitySet.has(entry))
    || new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("Execution node capabilities are invalid");
  }
  const requirements = stringArray(value.requirement_ids, "Execution node requirements", { nonEmpty: true });
  const obligations = stringArray(value.obligation_ids, "Execution node obligations", { nonEmpty: true });
  const readRoots = stringArray(value.read_roots, "Execution node read roots", { nonEmpty: true });
  const writeRoots = stringArray(value.write_roots, "Execution node write roots");
  const taints = stringArray(value.taint_classes, "Execution node taints");
  if (value.effect_ceiling === "READ_ONLY" && writeRoots.length > 0) throw new TypeError("Read-only execution node cannot have write roots");
  if (value.effect_ceiling === "PATCH_PROPOSAL" && !value.capabilities.includes("PATCH_PROPOSE")
    && !value.capabilities.includes("CONFLICT_PROPOSE")) {
    throw new TypeError("Patch execution node lacks a patch capability");
  }
  sha256V2(value.input_closure_sha256, "Execution node input closure");
  sha256V2(value.output_schema_sha256, "Execution node output schema");
  sha256V2(value.oracle_sha256, "Execution node oracle");
  sha256V2(value.provider_profile_sha256, "Execution node provider profile");
  if ((value.provider_call_plan_id === null) !== (value.provider_call_plan_sha256 === null)) {
    throw new TypeError("Execution node ProviderCallPlan identity is incomplete");
  }
  if (value.provider_call_plan_id !== null) {
    boundedIdV2(value.provider_call_plan_id, "Execution node ProviderCallPlan");
    sha256V2(value.provider_call_plan_sha256, "Execution node ProviderCallPlan hash");
  }
  const exactInputRefs = [...value.exact_input_refs].sort((left, right) => left.path.localeCompare(right.path));
  const decisionRefs = [...value.decision_refs].sort((left, right) => left.decision_id.localeCompare(right.decision_id));
  const rebuiltInputClosure = executionNodeInputClosureV2({
    task: value.task,
    requirement_ids: requirements,
    obligation_ids: obligations,
    exact_input_refs: exactInputRefs,
    decision_refs: decisionRefs,
    output_schema_sha256: value.output_schema_sha256,
    oracle_sha256: value.oracle_sha256,
    provider_profile_sha256: value.provider_profile_sha256,
  });
  if (rebuiltInputClosure !== value.input_closure_sha256) throw new TypeError("Execution node input closure is stale");
  integerV2(value.max_turns, "Execution node turn bound", 1, 1_024);
  integerV2(value.max_tool_calls, "Execution node tool bound", 1, 16_384);
  integerV2(value.max_input_tokens, "Execution node input token bound", 1, 10_000_000);
  integerV2(value.max_output_tokens, "Execution node output token bound", 1, 10_000_000);
  integerV2(value.max_retries, "Execution node retry bound", 0, 32);
  integerV2(value.no_progress_limit, "Execution node no-progress bound", 1, 32);
  integerV2(value.deadline_ms, "Execution node deadline", 1);
  return sealExecutionV2("PCH-EXECUTION-NODE-SPEC-V2", {
    ...value,
    requirement_ids: [...requirements].sort(),
    obligation_ids: [...obligations].sort(),
    read_roots: [...readRoots].sort(),
    write_roots: [...writeRoots].sort(),
    exact_input_refs: exactInputRefs,
    decision_refs: decisionRefs,
    taint_classes: [...taints].sort(),
  });
}

function finalizeEdge(input: EdgeInput, nodeIds: ReadonlySet<string>): ExecutionEdgeV2 {
  boundedIdV2(input.from_node_id, "Execution edge source");
  boundedIdV2(input.to_node_id, "Execution edge destination");
  if (input.from_node_id === input.to_node_id || !nodeIds.has(input.from_node_id) || !nodeIds.has(input.to_node_id)) {
    throw new TypeError("Execution edge references an invalid node");
  }
  if (!edgeConditionSet.has(input.condition)) throw new TypeError("Execution edge condition is invalid");
  return sealExecutionV2("PCH-EXECUTION-EDGE-V2", input);
}

function adjacency(nodes: readonly ExecutionNodeSpecV2[], edges: readonly ExecutionEdgeV2[]): Map<string, string[]> {
  const result = new Map(nodes.map((node) => [node.node_id, [] as string[]]));
  for (const edge of edges) result.get(edge.from_node_id)!.push(edge.to_node_id);
  for (const targets of result.values()) targets.sort();
  return result;
}

function assertAcyclic(graph: ReadonlyMap<string, readonly string[]>): void {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (nodeId: string): void => {
    const current = state.get(nodeId) ?? 0;
    if (current === 1) throw new TypeError("Execution graph contains a cycle");
    if (current === 2) return;
    state.set(nodeId, 1);
    for (const successor of graph.get(nodeId) ?? []) visit(successor);
    state.set(nodeId, 2);
  };
  for (const nodeId of graph.keys()) visit(nodeId);
}

function reaches(graph: ReadonlyMap<string, readonly string[]>, from: string, target: string): boolean {
  const pending = [...(graph.get(from) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

function assertParallelWriteScopes(nodes: readonly ExecutionNodeSpecV2[], graph: ReadonlyMap<string, readonly string[]>): void {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      if (reaches(graph, left.node_id, right.node_id) || reaches(graph, right.node_id, left.node_id)) continue;
      if (left.write_roots.some((leftRoot) => right.write_roots.some((rightRoot) => scopesMayOverlap(leftRoot, rightRoot)))) {
        throw new TypeError(`Execution graph parallel write scopes overlap: ${left.node_id}/${right.node_id}`);
      }
    }
  }
}

export function finalizeExecutionGraphV2(input: {
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly topology_gate_receipt_id: string;
  readonly topology_gate_receipt_sha256: string;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly input_closure_sha256: string;
  readonly oracle_set_sha256: string;
  readonly config_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly graph_revision: number;
  readonly stop_generation: number;
  readonly nodes: readonly NodeInput[];
  readonly edges: readonly EdgeInput[];
  readonly created_at_ms: number;
}): ExecutionGraphRevisionV2 {
  boundedIdV2(input.goal_id, "Execution graph Goal");
  boundedIdV2(input.run_id, "Execution graph run");
  boundedIdV2(input.work_cell_id, "Execution graph WorkCell");
  boundedIdV2(input.plan_revision_id, "Execution graph Plan revision");
  boundedIdV2(input.topology_gate_receipt_id, "Execution graph topology gate");
  boundedIdV2(input.authorization_id, "Execution graph authorization");
  for (const [value, label] of [
    [input.plan_revision_sha256, "Plan revision"], [input.topology_gate_receipt_sha256, "topology gate"],
    [input.authorization_sha256, "authorization"], [input.baseline_sha256, "baseline"],
    [input.baseline_content_root_sha256, "baseline content root"],
    [input.environment_sha256, "environment"], [input.input_closure_sha256, "input closure"],
    [input.oracle_set_sha256, "oracle set"], [input.config_sha256, "config"],
    [input.runtime_fingerprint_sha256, "runtime"], [input.predecessor_authority_head_sha256, "predecessor"],
  ] as const) sha256V2(value, `Execution graph ${label}`);
  integerV2(input.graph_revision, "Execution graph revision", 1, 65_535);
  integerV2(input.stop_generation, "Execution graph stop generation", 0);
  integerV2(input.created_at_ms, "Execution graph creation time");
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > 4_096) {
    throw new TypeError("Execution graph nodes are invalid");
  }
  const nodes = input.nodes.map(finalizeNode).sort((left, right) => left.node_id.localeCompare(right.node_id));
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  if (nodeIds.size !== nodes.length) throw new TypeError("Execution graph contains duplicate nodes");
  const edges = input.edges.map((edge) => finalizeEdge(edge, nodeIds)).sort((left, right) =>
    left.from_node_id.localeCompare(right.from_node_id)
      || left.to_node_id.localeCompare(right.to_node_id)
      || left.condition.localeCompare(right.condition));
  const edgeKeys = edges.map((edge) => `${edge.from_node_id}\0${edge.to_node_id}\0${edge.condition}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) throw new TypeError("Execution graph contains duplicate edges");
  const graphMap = adjacency(nodes, edges);
  assertAcyclic(graphMap);
  assertParallelWriteScopes(nodes, graphMap);
  const nodeRoot = canonicalJsonSha256({ domain: "PCH-EXECUTION-NODE-ROOT-V2", members: nodes.map((node) => node.record_sha256) });
  const edgeRoot = canonicalJsonSha256({ domain: "PCH-EXECUTION-EDGE-ROOT-V2", members: edges.map((edge) => edge.record_sha256) });
  const graphSha = canonicalJsonSha256({ domain: "PCH-EXECUTION-GRAPH-V2", nodes: nodeRoot, edges: edgeRoot });
  const identity = canonicalJsonSha256({
    goal: input.goal_id, run: input.run_id, cell: input.work_cell_id, revision: input.graph_revision,
    plan: input.plan_revision_sha256, gate: input.topology_gate_receipt_sha256,
    authorization: input.authorization_sha256, baselineContent: input.baseline_content_root_sha256,
    graph: graphSha, stop: input.stop_generation,
    predecessor: input.predecessor_authority_head_sha256,
  });
  return sealExecutionV2("PCH-EXECUTION-GRAPH-REVISION-V2", {
    schema_version: 2 as const,
    execution_graph_revision_id: idFromSha256("EXECUTION_GRAPH_V2", identity),
    goal_id: input.goal_id,
    run_id: input.run_id,
    work_cell_id: input.work_cell_id,
    plan_revision_id: input.plan_revision_id,
    plan_revision_sha256: input.plan_revision_sha256,
    topology_gate_receipt_id: input.topology_gate_receipt_id,
    topology_gate_receipt_sha256: input.topology_gate_receipt_sha256,
    authorization_id: input.authorization_id,
    authorization_sha256: input.authorization_sha256,
    baseline_sha256: input.baseline_sha256,
    baseline_content_root_sha256: input.baseline_content_root_sha256,
    environment_sha256: input.environment_sha256,
    input_closure_sha256: input.input_closure_sha256,
    oracle_set_sha256: input.oracle_set_sha256,
    config_sha256: input.config_sha256,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    graph_revision: input.graph_revision,
    stop_generation: input.stop_generation,
    node_root_sha256: nodeRoot,
    edge_root_sha256: edgeRoot,
    graph_sha256: graphSha,
    nodes,
    edges,
    created_at_ms: input.created_at_ms,
  });
}

export function assertExecutionGraphSemanticsV2(graph: ExecutionGraphRevisionV2): void {
  const rebuilt = finalizeExecutionGraphV2({
    goal_id: graph.goal_id,
    run_id: graph.run_id,
    work_cell_id: graph.work_cell_id,
    plan_revision_id: graph.plan_revision_id,
    plan_revision_sha256: graph.plan_revision_sha256,
    topology_gate_receipt_id: graph.topology_gate_receipt_id,
    topology_gate_receipt_sha256: graph.topology_gate_receipt_sha256,
    authorization_id: graph.authorization_id,
    authorization_sha256: graph.authorization_sha256,
    baseline_sha256: graph.baseline_sha256,
    baseline_content_root_sha256: graph.baseline_content_root_sha256,
    environment_sha256: graph.environment_sha256,
    input_closure_sha256: graph.input_closure_sha256,
    oracle_set_sha256: graph.oracle_set_sha256,
    config_sha256: graph.config_sha256,
    runtime_fingerprint_sha256: graph.runtime_fingerprint_sha256,
    predecessor_authority_head_sha256: graph.predecessor_authority_head_sha256,
    graph_revision: graph.graph_revision,
    stop_generation: graph.stop_generation,
    nodes: graph.nodes.map(({ record_sha256, ...node }) => {
      void record_sha256;
      return node;
    }),
    edges: graph.edges.map(({ record_sha256, ...edge }) => {
      void record_sha256;
      return edge;
    }),
    created_at_ms: graph.created_at_ms,
  });
  if (rebuilt.execution_graph_revision_id !== graph.execution_graph_revision_id
    || rebuilt.record_sha256 !== graph.record_sha256) {
    throw new TypeError("Execution graph semantic reconstruction failed");
  }
}

function longestPathByNode(graph: ExecutionGraphRevisionV2): ReadonlyMap<string, number> {
  const outgoing = adjacency(graph.nodes, graph.edges);
  const memo = new Map<string, number>();
  const visit = (nodeId: string): number => {
    const current = memo.get(nodeId);
    if (current !== undefined) return current;
    const value = 1 + Math.max(0, ...(outgoing.get(nodeId) ?? []).map(visit));
    memo.set(nodeId, value);
    return value;
  };
  for (const node of graph.nodes) visit(node.node_id);
  return memo;
}

export function readyExecutionNodeIdsV2(
  graph: ExecutionGraphRevisionV2,
  receipts: readonly HostNodeReceiptV2[],
  activeNodeIds: readonly string[],
  availableSlots: number,
): readonly string[] {
  integerV2(availableSlots, "Execution scheduler slots", 0, 1_024);
  const nodeIds = new Set(graph.nodes.map((node) => node.node_id));
  const active = new Set(activeNodeIds);
  if (active.size !== activeNodeIds.length || [...active].some((nodeId) => !nodeIds.has(nodeId))) {
    throw new TypeError("Execution scheduler active nodes are invalid");
  }
  const acceptedByNode = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    assertHostNodeReceiptV2(receipt, graph);
    const kinds = acceptedByNode.get(receipt.node_id) ?? new Set<string>();
    kinds.add(receipt.kind);
    acceptedByNode.set(receipt.node_id, kinds);
  }
  const completed = new Set([...acceptedByNode.entries()]
    .filter(([, kinds]) => [...kinds].some((kind) => kind !== "NODE_REJECTED"))
    .map(([nodeId]) => nodeId));
  const incoming = new Map<string, ExecutionEdgeV2[]>();
  for (const node of graph.nodes) incoming.set(node.node_id, []);
  for (const edge of graph.edges) incoming.get(edge.to_node_id)!.push(edge);
  const criticalPath = longestPathByNode(graph);
  return graph.nodes
    .filter((node) => !active.has(node.node_id) && !completed.has(node.node_id))
    .filter((node) => (incoming.get(node.node_id) ?? []).every((edge) =>
      acceptedByNode.get(edge.from_node_id)?.has(edge.condition) === true))
    .sort((left, right) => (criticalPath.get(right.node_id) ?? 0) - (criticalPath.get(left.node_id) ?? 0)
      || left.deadline_ms - right.deadline_ms
      || left.node_id.localeCompare(right.node_id))
    .slice(0, availableSlots)
    .map((node) => node.node_id);
}

export function successfulExecutionNodeIdsV2(
  graph: ExecutionGraphRevisionV2,
  receipts: readonly HostNodeReceiptV2[],
): readonly string[] {
  const passed = new Set<string>();
  for (const receipt of receipts) {
    assertHostNodeReceiptV2(receipt, graph);
    if (receipt.kind === "ORACLE_PASSED") passed.add(receipt.node_id);
  }
  return graph.nodes.filter((node) => passed.has(node.node_id)).map((node) => node.node_id);
}
