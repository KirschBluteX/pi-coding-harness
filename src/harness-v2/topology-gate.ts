import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface StrongSingleBaselineV2 {
  readonly schema_version: 2;
  readonly strong_single_baseline_id: string;
  readonly goal_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly evidence_sha256: string;
  readonly observed_at_ms: number;
  readonly record_sha256: string;
}

export interface DynamicMultiCandidateV2 {
  readonly schema_version: 2;
  readonly multi_candidate_id: string;
  readonly goal_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly graph_sha256: string;
  readonly total_node_count: number;
  readonly independent_node_count: number;
  readonly cross_partition_dependency_count: number;
  readonly write_scope_conflict_count: number;
  readonly task_packets_complete: boolean;
  readonly independent_validation: boolean;
  readonly estimated_quality_basis_points: number;
  readonly estimated_wall_time_ms: number;
  readonly estimated_provider_requests: number;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly estimated_user_interventions: number;
  readonly estimated_safety_events: number;
  readonly simulator_receipt_sha256: string;
  readonly estimated_at_ms: number;
  readonly record_sha256: string;
}

export type TopologyGateReasonV2 =
  | "SINGLE_REQUESTED"
  | "STRONG_SINGLE_BASELINE_REQUIRED"
  | "STRONG_SINGLE_BASELINE_FAILED"
  | "MULTI_CANDIDATE_REQUIRED"
  | "INSUFFICIENT_PARALLELISM"
  | "TASK_PACKET_CLOSURE_INCOMPLETE"
  | "WRITE_SCOPE_CONFLICT"
  | "INDEPENDENT_VALIDATION_REQUIRED"
  | "NO_NET_BENEFIT"
  | "COST_OR_SAFETY_REGRESSION"
  | "MULTI_NET_BENEFIT_PROVEN";

export interface TopologyGateReceiptV2 {
  readonly schema_version: 2;
  readonly topology_gate_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly requested_topology: "SINGLE" | "MULTI";
  readonly effective_topology: "SINGLE" | "MULTI";
  readonly verdict: "ALLOW" | "DENY";
  readonly reason_code: TopologyGateReasonV2;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly config_sha256: string;
  readonly strong_single_baseline_id: string | null;
  readonly strong_single_baseline_sha256: string | null;
  readonly multi_candidate_id: string | null;
  readonly multi_candidate_sha256: string | null;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

interface ClosureInputV2 {
  readonly goal_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly runtime_fingerprint_sha256: string;
}

export type TopologyMeasurementKindV2 = "STRONG_SINGLE" | "DYNAMIC_MULTI_SIMULATION";
export type TopologyMeasurementDerivationV2 =
  | "HOST_STRONG_SINGLE_ROLLOUT"
  | "HOST_DETERMINISTIC_DAG_SIMULATION";

export interface TopologyMeasurementClosureV2 extends ClosureInputV2 {
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly config_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
}

export interface TopologyMeasurementReceiptV2 extends TopologyMeasurementClosureV2 {
  readonly schema_version: 2;
  readonly topology_measurement_receipt_id: string;
  readonly kind: TopologyMeasurementKindV2;
  readonly graph_proposal_sha256: string | null;
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly source_evidence_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly trust: "HOST_DERIVED";
  readonly observed_at_ms: number;
  readonly record_sha256: string;
}

export interface TopologyMeasurementEvidenceReceiptV2 extends TopologyMeasurementClosureV2 {
  readonly schema_version: 2;
  readonly topology_measurement_evidence_receipt_id: string;
  readonly kind: TopologyMeasurementKindV2;
  readonly graph_proposal_sha256: string | null;
  readonly derivation: TopologyMeasurementDerivationV2;
  readonly source_observation_sha256: string;
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly predecessor_authority_head_sha256: string;
  readonly observed_at_ms: number;
  readonly record_sha256: string;
}

function id(value: string, label: string): string {
  if (!value || value.length > 256) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha(value: string, label: string): string {
  if (!sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function count(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.delete(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  }
  if (expected.size > 0) throw new TypeError(`${label} is missing field ${[...expected][0]}`);
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertClosure(value: ClosureInputV2): void {
  id(value.goal_id, "Topology gate Goal");
  id(value.plan_revision_id, "Topology gate Plan revision ID");
  sha(value.plan_revision_sha256, "Topology gate Plan revision");
  sha(value.input_closure_sha256, "Topology gate input closure");
  sha(value.runtime_fingerprint_sha256, "Topology gate runtime fingerprint");
}

export function finalizeStrongSingleBaselineV2(input: ClosureInputV2 & {
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly evidence_sha256: string;
  readonly observed_at_ms: number;
}): StrongSingleBaselineV2 {
  exactKeys(input, [
    "goal_id", "plan_revision_id", "plan_revision_sha256", "input_closure_sha256", "runtime_fingerprint_sha256",
    "correctness", "quality_basis_points", "wall_time_ms", "provider_requests", "input_tokens", "output_tokens",
    "user_interventions", "safety_events", "evidence_sha256", "observed_at_ms",
  ], "Strong Single baseline");
  assertClosure(input);
  if (input.correctness !== "PASS" && input.correctness !== "FAIL") throw new TypeError("Strong Single correctness is invalid");
  count(input.quality_basis_points, "Strong Single quality", 10_000);
  count(input.wall_time_ms, "Strong Single wall time");
  count(input.provider_requests, "Strong Single provider requests");
  count(input.input_tokens, "Strong Single input tokens");
  count(input.output_tokens, "Strong Single output tokens");
  count(input.user_interventions, "Strong Single user interventions");
  count(input.safety_events, "Strong Single safety events");
  sha(input.evidence_sha256, "Strong Single evidence");
  count(input.observed_at_ms, "Strong Single observation time");
  const identity = canonicalJsonSha256({ domain: "PCH-STRONG-SINGLE-BASELINE-V2", ...input });
  return sealed("PCH-STRONG-SINGLE-BASELINE-V2", {
    schema_version: 2 as const,
    strong_single_baseline_id: idFromSha256("SINGLE_BASELINE_V2", identity),
    ...input,
  });
}

export function finalizeTopologyMeasurementReceiptV2(input: TopologyMeasurementClosureV2 & {
  readonly kind: TopologyMeasurementKindV2;
  readonly graph_proposal_sha256: string | null;
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly source_evidence_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly observed_at_ms: number;
}): TopologyMeasurementReceiptV2 {
  exactKeys(input, [
    "goal_id", "run_id", "work_cell_id", "plan_revision_id", "plan_revision_sha256",
    "input_closure_sha256", "runtime_fingerprint_sha256", "config_sha256", "baseline_sha256",
    "baseline_content_root_sha256", "environment_sha256", "kind", "graph_proposal_sha256",
    "correctness", "quality_basis_points", "wall_time_ms", "provider_requests", "input_tokens",
    "output_tokens", "user_interventions", "safety_events", "source_evidence_sha256",
    "predecessor_authority_head_sha256", "observed_at_ms",
  ], "Topology measurement receipt");
  assertClosure(input);
  id(input.run_id, "Topology measurement Run");
  id(input.work_cell_id, "Topology measurement WorkCell");
  sha(input.config_sha256, "Topology measurement config");
  sha(input.baseline_sha256, "Topology measurement baseline");
  sha(input.baseline_content_root_sha256, "Topology measurement baseline content root");
  sha(input.environment_sha256, "Topology measurement environment");
  if (input.kind !== "STRONG_SINGLE" && input.kind !== "DYNAMIC_MULTI_SIMULATION") {
    throw new TypeError("Topology measurement kind is invalid");
  }
  if ((input.kind === "STRONG_SINGLE") !== (input.graph_proposal_sha256 === null)) {
    throw new TypeError("Topology measurement graph binding is invalid");
  }
  if (input.graph_proposal_sha256 !== null) sha(input.graph_proposal_sha256, "Topology measurement graph proposal");
  if (input.correctness !== "PASS" && input.correctness !== "FAIL") {
    throw new TypeError("Topology measurement correctness is invalid");
  }
  count(input.quality_basis_points, "Topology measurement quality", 10_000);
  count(input.wall_time_ms, "Topology measurement wall time");
  count(input.provider_requests, "Topology measurement provider requests");
  count(input.input_tokens, "Topology measurement input tokens");
  count(input.output_tokens, "Topology measurement output tokens");
  count(input.user_interventions, "Topology measurement user interventions");
  count(input.safety_events, "Topology measurement safety events");
  sha(input.source_evidence_sha256, "Topology measurement source evidence");
  sha(input.predecessor_authority_head_sha256, "Topology measurement predecessor authority head");
  count(input.observed_at_ms, "Topology measurement observation time");
  const identity = canonicalJsonSha256({ domain: "PCH-TOPOLOGY-MEASUREMENT-RECEIPT-V2", ...input });
  return sealed("PCH-TOPOLOGY-MEASUREMENT-RECEIPT-V2", {
    schema_version: 2 as const,
    topology_measurement_receipt_id: idFromSha256("TOPOLOGY_MEASUREMENT_V2", identity),
    ...input,
    trust: "HOST_DERIVED" as const,
  });
}

export function finalizeTopologyMeasurementEvidenceReceiptV2(input: TopologyMeasurementClosureV2 & {
  readonly kind: TopologyMeasurementKindV2;
  readonly graph_proposal_sha256: string | null;
  readonly derivation: TopologyMeasurementDerivationV2;
  readonly source_observation_sha256: string;
  readonly correctness: "PASS" | "FAIL";
  readonly quality_basis_points: number;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly predecessor_authority_head_sha256: string;
  readonly observed_at_ms: number;
}): TopologyMeasurementEvidenceReceiptV2 {
  exactKeys(input, [
    "goal_id", "run_id", "work_cell_id", "plan_revision_id", "plan_revision_sha256",
    "input_closure_sha256", "runtime_fingerprint_sha256", "config_sha256", "baseline_sha256",
    "baseline_content_root_sha256", "environment_sha256", "kind", "graph_proposal_sha256",
    "derivation", "source_observation_sha256", "correctness", "quality_basis_points", "wall_time_ms",
    "provider_requests", "input_tokens", "output_tokens", "user_interventions", "safety_events",
    "predecessor_authority_head_sha256", "observed_at_ms",
  ], "Topology measurement evidence receipt");
  assertClosure(input);
  id(input.run_id, "Topology measurement evidence Run");
  id(input.work_cell_id, "Topology measurement evidence WorkCell");
  sha(input.config_sha256, "Topology measurement evidence config");
  sha(input.baseline_sha256, "Topology measurement evidence baseline");
  sha(input.baseline_content_root_sha256, "Topology measurement evidence baseline content root");
  sha(input.environment_sha256, "Topology measurement evidence environment");
  const expectedDerivation = input.kind === "STRONG_SINGLE"
    ? "HOST_STRONG_SINGLE_ROLLOUT" : "HOST_DETERMINISTIC_DAG_SIMULATION";
  if (input.derivation !== expectedDerivation
    || (input.kind === "STRONG_SINGLE") !== (input.graph_proposal_sha256 === null)) {
    throw new TypeError("Topology measurement evidence derivation is invalid");
  }
  if (input.graph_proposal_sha256 !== null) sha(input.graph_proposal_sha256, "Topology measurement evidence graph");
  sha(input.source_observation_sha256, "Topology measurement evidence source observation");
  if (input.correctness !== "PASS" && input.correctness !== "FAIL") {
    throw new TypeError("Topology measurement evidence correctness is invalid");
  }
  count(input.quality_basis_points, "Topology measurement evidence quality", 10_000);
  count(input.wall_time_ms, "Topology measurement evidence wall time");
  count(input.provider_requests, "Topology measurement evidence provider requests");
  count(input.input_tokens, "Topology measurement evidence input tokens");
  count(input.output_tokens, "Topology measurement evidence output tokens");
  count(input.user_interventions, "Topology measurement evidence user interventions");
  count(input.safety_events, "Topology measurement evidence safety events");
  sha(input.predecessor_authority_head_sha256, "Topology measurement evidence predecessor authority head");
  count(input.observed_at_ms, "Topology measurement evidence observation time");
  const identity = canonicalJsonSha256({ domain: "PCH-TOPOLOGY-MEASUREMENT-EVIDENCE-V2", ...input });
  return sealed("PCH-TOPOLOGY-MEASUREMENT-EVIDENCE-V2", {
    schema_version: 2 as const,
    topology_measurement_evidence_receipt_id: idFromSha256("TOPOLOGY_MEASUREMENT_EVIDENCE_V2", identity),
    ...input,
  });
}

export function finalizeDynamicMultiCandidateV2(input: ClosureInputV2 & {
  readonly graph_sha256: string;
  readonly total_node_count: number;
  readonly independent_node_count: number;
  readonly cross_partition_dependency_count: number;
  readonly write_scope_conflict_count: number;
  readonly task_packets_complete: boolean;
  readonly independent_validation: boolean;
  readonly estimated_quality_basis_points: number;
  readonly estimated_wall_time_ms: number;
  readonly estimated_provider_requests: number;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly estimated_user_interventions: number;
  readonly estimated_safety_events: number;
  readonly simulator_receipt_sha256: string;
  readonly estimated_at_ms: number;
}): DynamicMultiCandidateV2 {
  exactKeys(input, [
    "goal_id", "plan_revision_id", "plan_revision_sha256", "input_closure_sha256", "runtime_fingerprint_sha256",
    "graph_sha256", "total_node_count", "independent_node_count", "cross_partition_dependency_count",
    "write_scope_conflict_count", "task_packets_complete", "independent_validation", "estimated_quality_basis_points",
    "estimated_wall_time_ms", "estimated_provider_requests", "estimated_input_tokens", "estimated_output_tokens",
    "estimated_user_interventions", "estimated_safety_events", "simulator_receipt_sha256", "estimated_at_ms",
  ], "Dynamic Multi candidate");
  assertClosure(input);
  sha(input.graph_sha256, "Dynamic Multi graph");
  count(input.total_node_count, "Dynamic Multi node count", 4_096);
  count(input.independent_node_count, "Dynamic Multi independent node count", input.total_node_count);
  count(input.cross_partition_dependency_count, "Dynamic Multi cross-partition dependencies", 32_768);
  count(input.write_scope_conflict_count, "Dynamic Multi write conflicts", 32_768);
  if (typeof input.task_packets_complete !== "boolean" || typeof input.independent_validation !== "boolean") {
    throw new TypeError("Dynamic Multi evidence flags are invalid");
  }
  count(input.estimated_quality_basis_points, "Dynamic Multi quality", 10_000);
  count(input.estimated_wall_time_ms, "Dynamic Multi wall time");
  count(input.estimated_provider_requests, "Dynamic Multi provider requests");
  count(input.estimated_input_tokens, "Dynamic Multi input tokens");
  count(input.estimated_output_tokens, "Dynamic Multi output tokens");
  count(input.estimated_user_interventions, "Dynamic Multi user interventions");
  count(input.estimated_safety_events, "Dynamic Multi safety events");
  sha(input.simulator_receipt_sha256, "Dynamic Multi simulator receipt");
  count(input.estimated_at_ms, "Dynamic Multi estimate time");
  const identity = canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-CANDIDATE-V2", ...input });
  return sealed("PCH-DYNAMIC-MULTI-CANDIDATE-V2", {
    schema_version: 2 as const,
    multi_candidate_id: idFromSha256("MULTI_CANDIDATE_V2", identity),
    ...input,
  });
}

function assertSealed(domain: string, value: Readonly<Record<string, unknown>>): void {
  const { record_sha256: actual, ...body } = value;
  if (typeof actual !== "string" || canonicalJsonSha256({ domain, ...body }) !== actual) {
    throw new TypeError(`${domain} record hash mismatch`);
  }
}

export function assertTopologyMeasurementReceiptV2(value: TopologyMeasurementReceiptV2): void {
  assertSealed("PCH-TOPOLOGY-MEASUREMENT-RECEIPT-V2", value as unknown as Readonly<Record<string, unknown>>);
  const expected = finalizeTopologyMeasurementReceiptV2({
    goal_id: value.goal_id,
    run_id: value.run_id,
    work_cell_id: value.work_cell_id,
    plan_revision_id: value.plan_revision_id,
    plan_revision_sha256: value.plan_revision_sha256,
    input_closure_sha256: value.input_closure_sha256,
    runtime_fingerprint_sha256: value.runtime_fingerprint_sha256,
    config_sha256: value.config_sha256,
    baseline_sha256: value.baseline_sha256,
    baseline_content_root_sha256: value.baseline_content_root_sha256,
    environment_sha256: value.environment_sha256,
    kind: value.kind,
    graph_proposal_sha256: value.graph_proposal_sha256,
    correctness: value.correctness,
    quality_basis_points: value.quality_basis_points,
    wall_time_ms: value.wall_time_ms,
    provider_requests: value.provider_requests,
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    user_interventions: value.user_interventions,
    safety_events: value.safety_events,
    source_evidence_sha256: value.source_evidence_sha256,
    predecessor_authority_head_sha256: value.predecessor_authority_head_sha256,
    observed_at_ms: value.observed_at_ms,
  });
  if (value.trust !== "HOST_DERIVED"
    || expected.topology_measurement_receipt_id !== value.topology_measurement_receipt_id
    || expected.record_sha256 !== value.record_sha256) {
    throw new TypeError("Topology measurement receipt identity mismatch");
  }
}

export function assertTopologyMeasurementEvidenceReceiptV2(value: TopologyMeasurementEvidenceReceiptV2): void {
  assertSealed("PCH-TOPOLOGY-MEASUREMENT-EVIDENCE-V2", value as unknown as Readonly<Record<string, unknown>>);
  const expected = finalizeTopologyMeasurementEvidenceReceiptV2({
    goal_id: value.goal_id,
    run_id: value.run_id,
    work_cell_id: value.work_cell_id,
    plan_revision_id: value.plan_revision_id,
    plan_revision_sha256: value.plan_revision_sha256,
    input_closure_sha256: value.input_closure_sha256,
    runtime_fingerprint_sha256: value.runtime_fingerprint_sha256,
    config_sha256: value.config_sha256,
    baseline_sha256: value.baseline_sha256,
    baseline_content_root_sha256: value.baseline_content_root_sha256,
    environment_sha256: value.environment_sha256,
    kind: value.kind,
    graph_proposal_sha256: value.graph_proposal_sha256,
    derivation: value.derivation,
    source_observation_sha256: value.source_observation_sha256,
    correctness: value.correctness,
    quality_basis_points: value.quality_basis_points,
    wall_time_ms: value.wall_time_ms,
    provider_requests: value.provider_requests,
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    user_interventions: value.user_interventions,
    safety_events: value.safety_events,
    predecessor_authority_head_sha256: value.predecessor_authority_head_sha256,
    observed_at_ms: value.observed_at_ms,
  });
  if (expected.topology_measurement_evidence_receipt_id !== value.topology_measurement_evidence_receipt_id
    || expected.record_sha256 !== value.record_sha256) {
    throw new TypeError("Topology measurement evidence receipt identity mismatch");
  }
}

export function assertStrongSingleBaselineV2(value: StrongSingleBaselineV2): void {
  assertSealed("PCH-STRONG-SINGLE-BASELINE-V2", value as unknown as Readonly<Record<string, unknown>>);
  const expected = finalizeStrongSingleBaselineV2({
    goal_id: value.goal_id, plan_revision_id: value.plan_revision_id,
    plan_revision_sha256: value.plan_revision_sha256, input_closure_sha256: value.input_closure_sha256,
    runtime_fingerprint_sha256: value.runtime_fingerprint_sha256, correctness: value.correctness,
    quality_basis_points: value.quality_basis_points, wall_time_ms: value.wall_time_ms,
    provider_requests: value.provider_requests, input_tokens: value.input_tokens,
    output_tokens: value.output_tokens, user_interventions: value.user_interventions,
    safety_events: value.safety_events, evidence_sha256: value.evidence_sha256,
    observed_at_ms: value.observed_at_ms,
  });
  if (expected.strong_single_baseline_id !== value.strong_single_baseline_id || expected.record_sha256 !== value.record_sha256) {
    throw new TypeError("Strong Single baseline identity mismatch");
  }
}

export function assertDynamicMultiCandidateV2(value: DynamicMultiCandidateV2): void {
  assertSealed("PCH-DYNAMIC-MULTI-CANDIDATE-V2", value as unknown as Readonly<Record<string, unknown>>);
  const expected = finalizeDynamicMultiCandidateV2({
    goal_id: value.goal_id, plan_revision_id: value.plan_revision_id,
    plan_revision_sha256: value.plan_revision_sha256, input_closure_sha256: value.input_closure_sha256,
    runtime_fingerprint_sha256: value.runtime_fingerprint_sha256, graph_sha256: value.graph_sha256,
    total_node_count: value.total_node_count, independent_node_count: value.independent_node_count,
    cross_partition_dependency_count: value.cross_partition_dependency_count,
    write_scope_conflict_count: value.write_scope_conflict_count,
    task_packets_complete: value.task_packets_complete, independent_validation: value.independent_validation,
    estimated_quality_basis_points: value.estimated_quality_basis_points,
    estimated_wall_time_ms: value.estimated_wall_time_ms,
    estimated_provider_requests: value.estimated_provider_requests,
    estimated_input_tokens: value.estimated_input_tokens, estimated_output_tokens: value.estimated_output_tokens,
    estimated_user_interventions: value.estimated_user_interventions,
    estimated_safety_events: value.estimated_safety_events,
    simulator_receipt_sha256: value.simulator_receipt_sha256, estimated_at_ms: value.estimated_at_ms,
  });
  if (expected.multi_candidate_id !== value.multi_candidate_id || expected.record_sha256 !== value.record_sha256) {
    throw new TypeError("Dynamic Multi candidate identity mismatch");
  }
}

function assertSameClosure(input: ClosureInputV2, value: ClosureInputV2, label: string): void {
  assertClosure(value);
  if (value.goal_id !== input.goal_id || value.plan_revision_sha256 !== input.plan_revision_sha256
    || value.plan_revision_id !== input.plan_revision_id
    || value.input_closure_sha256 !== input.input_closure_sha256
    || value.runtime_fingerprint_sha256 !== input.runtime_fingerprint_sha256) {
    throw new TypeError(`${label} does not bind the current topology closure`);
  }
}

function gateDecision(
  requested: "SINGLE" | "MULTI",
  baseline: StrongSingleBaselineV2 | null,
  candidate: DynamicMultiCandidateV2 | null,
): { readonly effective: "SINGLE" | "MULTI"; readonly verdict: "ALLOW" | "DENY"; readonly reason: TopologyGateReasonV2 } {
  if (requested === "SINGLE") return { effective: "SINGLE", verdict: "ALLOW", reason: "SINGLE_REQUESTED" };
  if (!baseline) return { effective: "SINGLE", verdict: "DENY", reason: "STRONG_SINGLE_BASELINE_REQUIRED" };
  if (baseline.correctness !== "PASS") return { effective: "SINGLE", verdict: "DENY", reason: "STRONG_SINGLE_BASELINE_FAILED" };
  if (!candidate) return { effective: "SINGLE", verdict: "DENY", reason: "MULTI_CANDIDATE_REQUIRED" };
  if (candidate.total_node_count < 2 || candidate.independent_node_count < 2) {
    return { effective: "SINGLE", verdict: "DENY", reason: "INSUFFICIENT_PARALLELISM" };
  }
  if (!candidate.task_packets_complete) return { effective: "SINGLE", verdict: "DENY", reason: "TASK_PACKET_CLOSURE_INCOMPLETE" };
  if (candidate.write_scope_conflict_count > 0) return { effective: "SINGLE", verdict: "DENY", reason: "WRITE_SCOPE_CONFLICT" };
  if (!candidate.independent_validation) return { effective: "SINGLE", verdict: "DENY", reason: "INDEPENDENT_VALIDATION_REQUIRED" };
  if (candidate.cross_partition_dependency_count >= candidate.independent_node_count) {
    return { effective: "SINGLE", verdict: "DENY", reason: "NO_NET_BENEFIT" };
  }
  const regresses = candidate.estimated_quality_basis_points < baseline.quality_basis_points
    || candidate.estimated_wall_time_ms > baseline.wall_time_ms
    || candidate.estimated_provider_requests > baseline.provider_requests
    || candidate.estimated_input_tokens > baseline.input_tokens
    || candidate.estimated_output_tokens > baseline.output_tokens
    || candidate.estimated_user_interventions > baseline.user_interventions
    || candidate.estimated_safety_events > baseline.safety_events;
  if (regresses) return { effective: "SINGLE", verdict: "DENY", reason: "COST_OR_SAFETY_REGRESSION" };
  const improves = candidate.estimated_quality_basis_points > baseline.quality_basis_points
    || candidate.estimated_wall_time_ms < baseline.wall_time_ms
    || candidate.estimated_provider_requests < baseline.provider_requests
    || candidate.estimated_input_tokens < baseline.input_tokens
    || candidate.estimated_output_tokens < baseline.output_tokens
    || candidate.estimated_user_interventions < baseline.user_interventions
    || candidate.estimated_safety_events < baseline.safety_events;
  return improves
    ? { effective: "MULTI", verdict: "ALLOW", reason: "MULTI_NET_BENEFIT_PROVEN" }
    : { effective: "SINGLE", verdict: "DENY", reason: "NO_NET_BENEFIT" };
}

export function finalizeTopologyGateV2(input: ClosureInputV2 & {
  readonly run_id: string;
  readonly requested_topology: "SINGLE" | "MULTI";
  readonly config_sha256: string;
  readonly strong_single_baseline: StrongSingleBaselineV2 | null;
  readonly multi_candidate: DynamicMultiCandidateV2 | null;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): TopologyGateReceiptV2 {
  exactKeys(input, [
    "goal_id", "plan_revision_id", "plan_revision_sha256", "input_closure_sha256", "runtime_fingerprint_sha256",
    "run_id", "requested_topology", "config_sha256", "strong_single_baseline", "multi_candidate",
    "predecessor_authority_head_sha256", "created_at_ms",
  ], "Topology gate");
  assertClosure(input);
  id(input.run_id, "Topology gate Run");
  if (input.requested_topology !== "SINGLE" && input.requested_topology !== "MULTI") {
    throw new TypeError("Topology gate requested topology is invalid");
  }
  sha(input.config_sha256, "Topology gate config");
  sha(input.predecessor_authority_head_sha256, "Topology gate predecessor authority head");
  count(input.created_at_ms, "Topology gate creation time");
  if (input.requested_topology === "SINGLE" && (input.strong_single_baseline !== null || input.multi_candidate !== null)) {
    throw new TypeError("SINGLE topology cannot carry Multi admission evidence");
  }
  if (input.strong_single_baseline) {
    assertSealed("PCH-STRONG-SINGLE-BASELINE-V2", input.strong_single_baseline as unknown as Readonly<Record<string, unknown>>);
    assertSameClosure(input, input.strong_single_baseline, "Strong Single baseline");
  }
  if (input.multi_candidate) {
    assertSealed("PCH-DYNAMIC-MULTI-CANDIDATE-V2", input.multi_candidate as unknown as Readonly<Record<string, unknown>>);
    assertSameClosure(input, input.multi_candidate, "Dynamic Multi candidate");
  }
  const decision = gateDecision(input.requested_topology, input.strong_single_baseline, input.multi_candidate);
  const body = {
    schema_version: 2 as const,
    topology_gate_receipt_id: idFromSha256("TOPOLOGY_GATE_V2", canonicalJsonSha256({
      goal: input.goal_id, run: input.run_id, requested: input.requested_topology,
      baseline: input.strong_single_baseline?.record_sha256 ?? null,
      candidate: input.multi_candidate?.record_sha256 ?? null,
      planId: input.plan_revision_id, plan: input.plan_revision_sha256,
      closure: input.input_closure_sha256, runtime: input.runtime_fingerprint_sha256,
      config: input.config_sha256, predecessor: input.predecessor_authority_head_sha256,
      createdAtMs: input.created_at_ms,
    })),
    goal_id: input.goal_id,
    run_id: input.run_id,
    requested_topology: input.requested_topology,
    effective_topology: decision.effective,
    verdict: decision.verdict,
    reason_code: decision.reason,
    plan_revision_id: input.plan_revision_id,
    plan_revision_sha256: input.plan_revision_sha256,
    input_closure_sha256: input.input_closure_sha256,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
    config_sha256: input.config_sha256,
    strong_single_baseline_id: input.strong_single_baseline?.strong_single_baseline_id ?? null,
    strong_single_baseline_sha256: input.strong_single_baseline?.record_sha256 ?? null,
    multi_candidate_id: input.multi_candidate?.multi_candidate_id ?? null,
    multi_candidate_sha256: input.multi_candidate?.record_sha256 ?? null,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  return sealed("PCH-TOPOLOGY-GATE-RECEIPT-V2", body);
}

export function assertTopologyGateReceiptV2(
  value: TopologyGateReceiptV2,
  baseline: StrongSingleBaselineV2 | null,
  candidate: DynamicMultiCandidateV2 | null,
): void {
  assertSealed("PCH-TOPOLOGY-GATE-RECEIPT-V2", value as unknown as Readonly<Record<string, unknown>>);
  const expected = finalizeTopologyGateV2({
    goal_id: value.goal_id,
    plan_revision_id: value.plan_revision_id,
    plan_revision_sha256: value.plan_revision_sha256,
    input_closure_sha256: value.input_closure_sha256,
    runtime_fingerprint_sha256: value.runtime_fingerprint_sha256,
    run_id: value.run_id,
    requested_topology: value.requested_topology,
    config_sha256: value.config_sha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: value.predecessor_authority_head_sha256,
    created_at_ms: value.created_at_ms,
  });
  if (expected.topology_gate_receipt_id !== value.topology_gate_receipt_id
    || expected.record_sha256 !== value.record_sha256) {
    throw new TypeError("Topology gate receipt identity mismatch");
  }
}
