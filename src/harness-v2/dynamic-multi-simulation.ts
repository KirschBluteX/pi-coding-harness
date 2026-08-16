import {
  simulateOrchBenchV1,
  type OrchBenchNodeV1,
  type OrchBenchScenarioV1,
} from "../benchmarks/orchbench/simulator.js";
import type { StrongSingleRolloutReceiptV1 } from "./strong-single-rollout.js";

export interface DynamicMultiSimulationNodeV1 {
  readonly node_id: string;
  readonly capability: string;
  readonly dependency_ids: readonly string[];
  readonly patch_proposal: boolean;
  readonly work_weight: number;
  readonly exact_input_sha256s: readonly string[];
}

export interface DynamicMultiAdmissionSimulationV1 {
  readonly correctness: "PASS" | "FAIL";
  readonly estimated_quality_basis_points: number;
  readonly estimated_wall_time_ms: number;
  readonly estimated_provider_requests: number;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly estimated_user_interventions: number;
  readonly estimated_safety_events: number;
}

function workerCount(value: number): 1 | 2 | 4 | 8 {
  if (value >= 8) return 8;
  if (value >= 4) return 4;
  if (value >= 2) return 2;
  return 1;
}

export function simulateDynamicMultiAdmissionV1(input: {
  readonly baseline: StrongSingleRolloutReceiptV1;
  readonly graph_proposal_sha256: string;
  readonly independent_node_count: number;
  readonly nodes: readonly DynamicMultiSimulationNodeV1[];
}): DynamicMultiAdmissionSimulationV1 {
  const { baseline, nodes } = input;
  if (nodes.length < 2 || baseline.correctness !== "PASS" || baseline.wall_time_ms < nodes.length
    || nodes.some((node) => !Number.isSafeInteger(node.work_weight) || node.work_weight < 1)) {
    return {
      correctness: "FAIL",
      estimated_quality_basis_points: baseline.quality_basis_points,
      estimated_wall_time_ms: baseline.wall_time_ms,
      estimated_provider_requests: nodes.length,
      estimated_input_tokens: baseline.input_tokens,
      estimated_output_tokens: baseline.output_tokens,
      estimated_user_interventions: baseline.user_interventions,
      estimated_safety_events: baseline.safety_events,
    };
  }
  const patchCount = nodes.filter((node) => node.patch_proposal).length;
  const perPatchIntegrationMs = patchCount === 0 ? 0
    : Math.max(1, Math.ceil(baseline.wall_time_ms / 100 / patchCount));
  const integrationMs = perPatchIntegrationMs * patchCount;
  const computeBudget = baseline.wall_time_ms - integrationMs;
  if (computeBudget < nodes.length) return {
    correctness: "FAIL",
    estimated_quality_basis_points: baseline.quality_basis_points,
    estimated_wall_time_ms: baseline.wall_time_ms + integrationMs,
    estimated_provider_requests: nodes.length,
    estimated_input_tokens: baseline.input_tokens,
    estimated_output_tokens: baseline.output_tokens,
    estimated_user_interventions: baseline.user_interventions,
    estimated_safety_events: baseline.safety_events,
  };
  const totalWeight = nodes.reduce((sum, node) => sum + node.work_weight, 0);
  let remainingMs = computeBudget;
  let remainingWeight = totalWeight;
  const scenarioNodes: OrchBenchNodeV1[] = nodes.map((node, index) => {
    const remainingNodes = nodes.length - index;
    const computeMs = remainingNodes === 1
      ? remainingMs
      : Math.max(1, Math.floor(remainingMs * node.work_weight / remainingWeight));
    remainingMs -= computeMs;
    remainingWeight -= node.work_weight;
    return {
      node_id: node.node_id,
      capability: node.capability,
      dependency_ids: node.dependency_ids,
      compute_ms: computeMs,
      integration_ms: node.patch_proposal ? perPatchIntegrationMs : 0,
    };
  });
  const scenario: OrchBenchScenarioV1 = {
    scenario_id: `PCH-DYNAMIC-MULTI-${input.graph_proposal_sha256}`,
    nodes: scenarioNodes,
  };
  const result = simulateOrchBenchV1(scenario, {
    workers: workerCount(Math.min(nodes.length, input.independent_node_count)),
    scheduling: "CONTINUOUS",
    coordination: "VERIFIED_QUEUE",
    topology: "DYNAMIC_CAPABILITY",
    central_dispatch_ms: 1,
    verified_queue_claim_ms: 1,
    fixed_role_count: 5,
    fixed_role_startup_ms: 1,
    capability_startup_ms: 1,
  });
  const allInputRefs = nodes.flatMap((node) => node.exact_input_sha256s);
  const duplicateInputRefs = allInputRefs.length - new Set(allInputRefs).size;
  const duplicatePenalty = allInputRefs.length === 0 ? 0
    : Math.ceil(baseline.input_tokens * duplicateInputRefs / allInputRefs.length);
  return {
    correctness: result.completed_nodes === nodes.length && result.stopped_nodes === 0 ? "PASS" : "FAIL",
    estimated_quality_basis_points: baseline.quality_basis_points,
    estimated_wall_time_ms: result.makespan_ms,
    estimated_provider_requests: nodes.length,
    estimated_input_tokens: baseline.input_tokens + duplicatePenalty,
    estimated_output_tokens: baseline.output_tokens,
    estimated_user_interventions: baseline.user_interventions,
    estimated_safety_events: baseline.safety_events,
  };
}
