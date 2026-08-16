import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../../foundation/crypto.js";
import { idFromSha256 } from "../../foundation/ids.js";
import {
  assertTopologyMeasurementReceiptV2,
  finalizeDynamicMultiCandidateV2,
  finalizeStrongSingleBaselineV2,
  finalizeTopologyGateV2,
  type DynamicMultiCandidateV2,
  type StrongSingleBaselineV2,
  type TopologyMeasurementReceiptV2,
  type TopologyGateReceiptV2,
} from "../../harness-v2/topology-gate.js";
import { sealHarnessRecord, type TopologyRevisionRecord } from "../domain.js";
import type { ComparableWorkloadV1, WorkloadComparabilityReceiptV1 } from "../../harness-v2/workload-comparability.js";
import { scopesMayOverlap, scopeContains, scopePathKey } from "../scope-path.js";
import { finalizeExecutionGraphV2 } from "../execution-v2/dag.js";
import {
  executionNodeInputClosureV2,
  type ExecutionCapabilityV2,
  type ExecutionEdgeConditionV2,
  type ExecutionGraphRevisionV2,
  type ExecutionPrivacyClassV2,
  type TaskPacketArtifactRefV2,
} from "../execution-v2/domain.js";
import type { ExecutionV2Preparation } from "../execution-v2/repository.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const capabilities = new Set<ExecutionCapabilityV2>([
  "SOURCE_DISCOVERY", "REQUIREMENT_ANALYSIS", "PATCH_PROPOSE", "CONFLICT_PROPOSE", "ORACLE_REQUEST",
]);
const conditions = new Set<ExecutionEdgeConditionV2>([
  "EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED",
]);

export interface HostDynamicMultiDependencyProposalV2 {
  readonly key: string;
  readonly condition: ExecutionEdgeConditionV2;
}

export interface HostDynamicMultiNodeProposalV2 {
  readonly key: string;
  readonly task: string;
  readonly capabilities: readonly ExecutionCapabilityV2[];
  readonly effect_ceiling: "READ_ONLY" | "PATCH_PROPOSAL";
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly unknown[];
  readonly output_schema_sha256: string;
  readonly provider_call_plan_id?: string | null;
  readonly provider_call_plan_sha256?: string | null;
  readonly privacy_class: ExecutionPrivacyClassV2;
  readonly taint_classes: readonly string[];
  readonly max_turns: number;
  readonly max_tool_calls: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_retries: number;
  readonly no_progress_limit: number;
  readonly deadline_ms: number;
  readonly dependencies: readonly HostDynamicMultiDependencyProposalV2[];
}

export interface HostDynamicMultiAdmissionEvidenceV2 {
  readonly comparability?: WorkloadComparabilityReceiptV1;
  readonly strong_single: {
    readonly correctness: "PASS" | "FAIL";
    readonly quality_basis_points: number;
    readonly wall_time_ms: number;
    readonly provider_requests: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly user_interventions: number;
    readonly safety_events: number;
  };
  readonly candidate: {
    readonly correctness: "PASS" | "FAIL";
    readonly estimated_quality_basis_points: number;
    readonly estimated_wall_time_ms: number;
    readonly estimated_provider_requests: number;
    readonly estimated_input_tokens: number;
    readonly estimated_output_tokens: number;
    readonly estimated_user_interventions: number;
    readonly estimated_safety_events: number;
  };
}

export interface HostDynamicMultiAdmissionRequestV2 {
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly config_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly workload: ComparableWorkloadV1;
  readonly graph_proposal_sha256: string;
  readonly total_node_count: number;
  readonly independent_node_count: number;
  readonly cross_partition_dependency_count: number;
  readonly write_scope_conflict_count: number;
  readonly task_packets_complete: boolean;
  readonly independent_validation: boolean;
}

export interface DynamicMultiAdmissionPortV2 {
  measure(input: HostDynamicMultiAdmissionRequestV2):
    Promise<HostDynamicMultiAdmissionEvidenceV2 | null> | HostDynamicMultiAdmissionEvidenceV2 | null;
}

export interface DurableDynamicMultiAdmissionEvidenceV2 {
  readonly strong_single: TopologyMeasurementReceiptV2;
  readonly candidate: TopologyMeasurementReceiptV2;
}

export interface LoweredDynamicMultiV2 {
  readonly request: HostDynamicMultiAdmissionRequestV2;
  readonly baseline: StrongSingleBaselineV2 | null;
  readonly candidate: DynamicMultiCandidateV2 | null;
  readonly gate: TopologyGateReceiptV2;
  readonly topology: TopologyRevisionRecord;
  readonly graph: ExecutionGraphRevisionV2 | null;
}

export interface DynamicMultiLoweringInputV2 {
  readonly workspace: string;
  readonly workspaceSecret: Uint8Array;
  readonly preparation: ExecutionV2Preparation;
  readonly currentTopologyRevision: number;
  readonly runtimeFingerprintSha256: string;
  readonly comparableWorkload: ComparableWorkloadV1;
  readonly shards: readonly unknown[];
  readonly admissionEvidence: DurableDynamicMultiAdmissionEvidenceV2 | null;
  readonly independentValidation: boolean;
  readonly nowMs: number;
}

export interface InspectedDynamicMultiProposalV2 {
  readonly nodes: readonly HostDynamicMultiNodeProposalV2[];
  readonly request: HostDynamicMultiAdmissionRequestV2;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const remaining = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!remaining.delete(key)) throw new TypeError(`Dynamic Multi node has unexpected field ${key}`);
  for (const key of required) if (!(key in value)) throw new TypeError(`Dynamic Multi node is missing field ${key}`);
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return Number(value);
}

function strings(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${label} is invalid`);
  const result = value.map((entry) => string(entry, label, 1_024));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function normalizedWorkspace(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) {
    throw new TypeError("Dynamic Multi workspace is not a safe directory");
  }
  return realpathSync(absolute);
}

function contained(root: string, target: string): boolean {
  const member = relative(root, target);
  return member === "" || (!member.startsWith("..") && !isAbsolute(member));
}

interface BaselineFileV2 {
  readonly bytes: number;
  readonly sha256: string;
}

function baselineFileIndex(
  preparation: ExecutionV2Preparation,
): ReadonlyMap<string, BaselineFileV2> {
  if (canonicalJsonSha256(preparation.baselineScopeManifest) !== preparation.baselineContentRootSha256) {
    throw new TypeError("Dynamic Multi authorized baseline manifest root is invalid");
  }
  const files = new Map<string, BaselineFileV2>();
  for (const value of preparation.baselineScopeManifest) {
    const row = object(value, "Dynamic Multi baseline member");
    const pathHmac = string(row.path_hmac, "Dynamic Multi baseline path HMAC", 64);
    if (!sha256Pattern.test(pathHmac)) throw new TypeError("Dynamic Multi baseline path HMAC is invalid");
    if (row.kind !== "FILE") continue;
    const bytes = integer(row.bytes, "Dynamic Multi baseline byte length", 0, 4 * 1024 * 1024);
    const digest = string(row.sha256, "Dynamic Multi baseline file hash", 64);
    if (!sha256Pattern.test(digest) || files.has(pathHmac)) {
      throw new TypeError("Dynamic Multi baseline file member is invalid");
    }
    files.set(pathHmac, { bytes, sha256: digest });
  }
  return files;
}

function verifiedInputRef(
  workspace: string,
  workspaceSecret: Uint8Array,
  baselineFiles: ReadonlyMap<string, BaselineFileV2>,
  value: unknown,
  readRoots: readonly string[],
): TaskPacketArtifactRefV2 {
  const ref = object(value, "Dynamic Multi exact input ref");
  exactKeys(ref, ["path", "sha256", "classification"]);
  const path = scopePathKey(string(ref.path, "Dynamic Multi exact input path", 1_024)).normalized;
  if (!readRoots.some((root) => scopeContains(root, path))) {
    throw new TypeError(`Dynamic Multi exact input ${path} is outside the node read scope`);
  }
  const claimed = string(ref.sha256, "Dynamic Multi exact input hash", 64);
  if (!sha256Pattern.test(claimed)) throw new TypeError("Dynamic Multi exact input hash is invalid");
  if (ref.classification !== "PUBLIC" && ref.classification !== "INTERNAL") {
    throw new TypeError("Dynamic Multi cannot dispatch SENSITIVE or SECRET exact inputs without a verified privacy Adapter");
  }
  const absolute = resolve(workspace, ...path.split("/"));
  if (!contained(workspace, absolute) || !existsSync(absolute)) throw new TypeError(`Dynamic Multi exact input is unavailable: ${path}`);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 4 * 1024 * 1024) {
    throw new TypeError(`Dynamic Multi exact input is not a bounded regular file: ${path}`);
  }
  const actual = realpathSync(absolute);
  if (!contained(workspace, actual) || resolve(actual) !== resolve(absolute)) {
    throw new TypeError(`Dynamic Multi exact input traverses a link or junction: ${path}`);
  }
  const digest = sha256Hex(readFileSync(actual));
  if (digest !== claimed) throw new TypeError(`Dynamic Multi exact input hash is stale: ${path}`);
  const baseline = baselineFiles.get(hmacSha256Hex(workspaceSecret, path));
  if (!baseline || baseline.sha256 !== digest || baseline.bytes !== entry.size) {
    throw new TypeError(`Dynamic Multi exact input is outside the authorized baseline: ${path}`);
  }
  if (ref.classification !== "INTERNAL") {
    throw new TypeError("Dynamic Multi exact input classification is not backed by a verified privacy Adapter");
  }
  return { path, sha256: digest, classification: "INTERNAL" };
}

function parseNode(workspace: string, workspaceSecret: Uint8Array, baselineFiles: ReadonlyMap<string, BaselineFileV2>,
  value: unknown, preparation: ExecutionV2Preparation, runtimeSha256: string, nowMs: number): HostDynamicMultiNodeProposalV2 {
  const row = object(value, "Dynamic Multi node");
  exactKeys(row, [
    "key", "task", "capabilities", "effect_ceiling", "read_roots", "write_roots", "exact_input_refs",
    "decision_refs", "output_schema_sha256", "privacy_class", "taint_classes", "max_turns", "max_tool_calls",
    "max_input_tokens", "max_output_tokens", "max_retries", "no_progress_limit", "deadline_ms", "dependencies",
  ], ["provider_call_plan_id", "provider_call_plan_sha256", "oracle_sha256", "provider_profile_sha256"]);
  const key = string(row.key, "Dynamic Multi node key", 160);
  const readRoots = strings(row.read_roots, "Dynamic Multi read roots", 256).map((root) => scopePathKey(root).normalized);
  const writeRoots = strings(row.write_roots, "Dynamic Multi write roots", 256).map((root) => scopePathKey(root).normalized);
  if (readRoots.length === 0) throw new TypeError("Dynamic Multi node requires an exact read scope");
  const allowedReadRoots = [...preparation.workCellReadRoots, ...preparation.workCellWriteRoots];
  if (readRoots.some((root) => !allowedReadRoots.some((allowed) => scopeContains(allowed, root)))
    || writeRoots.some((root) => !preparation.workCellWriteRoots.some((allowed) => scopeContains(allowed, root)))) {
    throw new TypeError("Dynamic Multi node scope exceeds the frozen WorkCell");
  }
  const exactInputValues = Array.isArray(row.exact_input_refs) ? row.exact_input_refs : null;
  if (!exactInputValues || exactInputValues.length === 0 || exactInputValues.length > 512) {
    throw new TypeError("Dynamic Multi node requires bounded exact input refs");
  }
  const exactInputRefs = exactInputValues.map((ref) => verifiedInputRef(
    workspace, workspaceSecret, baselineFiles, ref, readRoots,
  ));
  if (new Set(exactInputRefs.map((ref) => ref.path)).size !== exactInputRefs.length
    || readRoots.some((root) => !exactInputRefs.some((ref) => ref.path === root))) {
    throw new TypeError("Dynamic Multi read roots must be exact regular-file refs");
  }
  if (!Array.isArray(row.decision_refs) || row.decision_refs.length !== 0) {
    throw new TypeError("Dynamic Multi Decision refs require a verified authority resolver");
  }
  if ((row.provider_call_plan_id ?? null) !== null || (row.provider_call_plan_sha256 ?? null) !== null) {
    throw new TypeError("Dynamic Multi ProviderCallPlan refs require the Provider V2 authority Adapter");
  }
  const nodeCapabilities = strings(row.capabilities, "Dynamic Multi capabilities", 5) as readonly ExecutionCapabilityV2[];
  if (nodeCapabilities.length === 0 || nodeCapabilities.some((entry) => !capabilities.has(entry))) {
    throw new TypeError("Dynamic Multi capabilities are invalid");
  }
  if (row.effect_ceiling !== "READ_ONLY" && row.effect_ceiling !== "PATCH_PROPOSAL") {
    throw new TypeError("Dynamic Multi effect ceiling is invalid");
  }
  if (row.effect_ceiling === "READ_ONLY" && writeRoots.length > 0) {
    throw new TypeError("Dynamic Multi read-only node cannot write");
  }
  const dependenciesValue = Array.isArray(row.dependencies) ? row.dependencies : null;
  if (!dependenciesValue || dependenciesValue.length > 512) throw new TypeError("Dynamic Multi dependencies are invalid");
  const dependencies = dependenciesValue.map((entry): HostDynamicMultiDependencyProposalV2 => {
    const dependency = object(entry, "Dynamic Multi dependency");
    exactKeys(dependency, ["key", "condition"]);
    const condition = dependency.condition as ExecutionEdgeConditionV2;
    if (!conditions.has(condition)) throw new TypeError("Dynamic Multi dependency condition is invalid");
    return { key: string(dependency.key, "Dynamic Multi dependency key", 160), condition };
  });
  const deadlineMs = integer(row.deadline_ms, "Dynamic Multi deadline", nowMs + 1, Number.MAX_SAFE_INTEGER);
  const privacyClass = row.privacy_class;
  if (privacyClass !== "PUBLIC" && privacyClass !== "INTERNAL") {
    throw new TypeError("Dynamic Multi node privacy class requires a verified privacy Adapter");
  }
  const actualPrivacy: ExecutionPrivacyClassV2 = exactInputRefs.some((ref) => ref.classification === "INTERNAL")
    ? "INTERNAL" : "PUBLIC";
  if (privacyClass !== actualPrivacy) throw new TypeError("Dynamic Multi node privacy class understates or overstates its exact inputs");
  const taintClasses = actualPrivacy === "INTERNAL" ? ["INTERNAL"] : [];
  strings(row.taint_classes, "Dynamic Multi taint classes", 64);
  const outputSchemaSha256 = string(row.output_schema_sha256, "Dynamic Multi output schema", 64);
  if (!sha256Pattern.test(outputSchemaSha256)) throw new TypeError("Dynamic Multi output schema hash is invalid");
  if (row.oracle_sha256 !== undefined && !sha256Pattern.test(string(row.oracle_sha256, "Dynamic Multi caller oracle", 64))) {
    throw new TypeError("Dynamic Multi caller oracle hash is invalid");
  }
  if (row.provider_profile_sha256 !== undefined
    && !sha256Pattern.test(string(row.provider_profile_sha256, "Dynamic Multi caller provider profile", 64))) {
    throw new TypeError("Dynamic Multi caller provider profile hash is invalid");
  }
  return {
    key,
    task: string(row.task, "Dynamic Multi task", 16_384),
    capabilities: nodeCapabilities,
    effect_ceiling: row.effect_ceiling,
    read_roots: readRoots,
    write_roots: writeRoots,
    exact_input_refs: exactInputRefs,
    decision_refs: [],
    output_schema_sha256: outputSchemaSha256,
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
    privacy_class: actualPrivacy,
    taint_classes: taintClasses,
    max_turns: integer(row.max_turns, "Dynamic Multi turn budget", 1, 64),
    max_tool_calls: integer(row.max_tool_calls, "Dynamic Multi tool budget", 1, 1_024),
    max_input_tokens: integer(row.max_input_tokens, "Dynamic Multi input budget", 1, 1_000_000),
    max_output_tokens: integer(row.max_output_tokens, "Dynamic Multi output budget", 1, 250_000),
    max_retries: integer(row.max_retries, "Dynamic Multi retry budget", 0, 4),
    no_progress_limit: integer(row.no_progress_limit, "Dynamic Multi no-progress budget", 1, 8),
    deadline_ms: deadlineMs,
    dependencies,
  };
}

function structuralMetrics(nodes: readonly HostDynamicMultiNodeProposalV2[]): {
  readonly independentNodeCount: number;
  readonly edgeCount: number;
  readonly writeConflictCount: number;
} {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  if (byKey.size !== nodes.length) throw new TypeError("Dynamic Multi node keys must be unique");
  const predecessors = new Map(nodes.map((node) => [node.key, new Set<string>()]));
  for (const node of nodes) for (const dependency of node.dependencies) {
    if (!byKey.has(dependency.key) || dependency.key === node.key) throw new TypeError("Dynamic Multi dependency is invalid");
    predecessors.get(node.key)!.add(dependency.key);
  }
  const remaining = new Set(nodes.map((node) => node.key));
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const level = [...remaining].filter((key) => [...predecessors.get(key)!].every((dependency) => !remaining.has(dependency))).sort();
    if (level.length === 0) throw new TypeError("Dynamic Multi graph contains a dependency cycle");
    levels.push(level);
    for (const key of level) remaining.delete(key);
  }
  const reachable = (from: string, target: string): boolean => {
    const pending = [from];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!seen.add(current)) continue;
      for (const node of nodes) if (node.dependencies.some((dependency) => dependency.key === current)) {
        if (node.key === target) return true;
        pending.push(node.key);
      }
    }
    return false;
  };
  let writeConflictCount = 0;
  for (let left = 0; left < nodes.length; left += 1) for (let right = left + 1; right < nodes.length; right += 1) {
    const a = nodes[left]!; const b = nodes[right]!;
    if (reachable(a.key, b.key) || reachable(b.key, a.key)) continue;
    if (a.write_roots.some((aRoot) => b.write_roots.some((bRoot) => scopesMayOverlap(aRoot, bRoot)))) writeConflictCount += 1;
  }
  return {
    independentNodeCount: Math.max(...levels.map((level) => level.length)),
    edgeCount: nodes.reduce((total, node) => total + node.dependencies.length, 0),
    writeConflictCount,
  };
}

export function inspectDynamicMultiProposalV2(
  input: Omit<DynamicMultiLoweringInputV2, "admissionEvidence">,
): InspectedDynamicMultiProposalV2 {
  if (!sha256Pattern.test(input.runtimeFingerprintSha256)) throw new TypeError("Dynamic Multi runtime fingerprint is invalid");
  if (!Array.isArray(input.shards) || input.shards.length < 2 || input.shards.length > 32) {
    throw new TypeError("Dynamic Multi requires 2..32 bounded nodes");
  }
  const workspace = normalizedWorkspace(input.workspace);
  const baselineFiles = baselineFileIndex(input.preparation);
  const nodes = input.shards.map((node) => parseNode(
    workspace, input.workspaceSecret, baselineFiles, node, input.preparation,
    input.runtimeFingerprintSha256, input.nowMs,
  ));
  const metrics = structuralMetrics(nodes);
  const graphProposalSha256 = canonicalJsonSha256({
    domain: "PCH-HOST-DYNAMIC-MULTI-GRAPH-PROPOSAL-V2",
    goal: input.preparation.goalId,
    run: input.preparation.runId,
    workCell: input.preparation.workCellSha256,
    nodes,
  });
  return {
    nodes,
    request: {
      goal_id: input.preparation.goalId,
      run_id: input.preparation.runId,
      work_cell_id: input.preparation.workCellId,
      plan_revision_id: input.preparation.planRevisionId,
      plan_revision_sha256: input.preparation.planRevisionSha256,
      input_closure_sha256: input.preparation.inputClosureSha256,
      runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
      config_sha256: input.preparation.configSha256,
      baseline_sha256: input.preparation.baselineSha256,
      baseline_content_root_sha256: input.preparation.baselineContentRootSha256,
      environment_sha256: input.preparation.environmentSha256,
      workload: input.comparableWorkload,
      graph_proposal_sha256: graphProposalSha256,
      total_node_count: nodes.length,
      independent_node_count: metrics.independentNodeCount,
      cross_partition_dependency_count: metrics.edgeCount,
      write_scope_conflict_count: metrics.writeConflictCount,
      task_packets_complete: nodes.every((node) => node.read_roots.length === node.exact_input_refs.length),
      independent_validation: input.independentValidation,
    },
  };
}

export function lowerInspectedDynamicMultiV2(input: Omit<DynamicMultiLoweringInputV2, "shards"> & {
  readonly inspected: InspectedDynamicMultiProposalV2;
}): LoweredDynamicMultiV2 {
  const inspected = input.inspected;
  const expectedRequestClosure = {
    goal_id: input.preparation.goalId,
    run_id: input.preparation.runId,
    work_cell_id: input.preparation.workCellId,
    plan_revision_id: input.preparation.planRevisionId,
    plan_revision_sha256: input.preparation.planRevisionSha256,
    input_closure_sha256: input.preparation.inputClosureSha256,
    runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
    config_sha256: input.preparation.configSha256,
    baseline_sha256: input.preparation.baselineSha256,
    baseline_content_root_sha256: input.preparation.baselineContentRootSha256,
    environment_sha256: input.preparation.environmentSha256,
  };
  for (const [key, value] of Object.entries(expectedRequestClosure)) {
    if (inspected.request[key as keyof typeof expectedRequestClosure] !== value) {
      throw new TypeError("Dynamic Multi inspected proposal closure is stale");
    }
  }
  if (canonicalJsonSha256(inspected.request.workload) !== canonicalJsonSha256(input.comparableWorkload)) {
    throw new TypeError("Dynamic Multi comparable workload closure is stale");
  }
  const closure = {
    goal_id: input.preparation.goalId,
    plan_revision_id: input.preparation.planRevisionId,
    plan_revision_sha256: input.preparation.planRevisionSha256,
    input_closure_sha256: input.preparation.inputClosureSha256,
    runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
  } as const;
  const measurementMatches = (receipt: TopologyMeasurementReceiptV2, kind: TopologyMeasurementReceiptV2["kind"]): boolean => {
    try { assertTopologyMeasurementReceiptV2(receipt); }
    catch { return false; }
    return receipt.kind === kind && receipt.goal_id === inspected.request.goal_id
      && receipt.run_id === inspected.request.run_id && receipt.work_cell_id === inspected.request.work_cell_id
      && receipt.plan_revision_id === inspected.request.plan_revision_id
      && receipt.plan_revision_sha256 === inspected.request.plan_revision_sha256
      && receipt.input_closure_sha256 === inspected.request.input_closure_sha256
      && receipt.runtime_fingerprint_sha256 === inspected.request.runtime_fingerprint_sha256
      && receipt.config_sha256 === inspected.request.config_sha256
      && receipt.baseline_sha256 === inspected.request.baseline_sha256
      && receipt.baseline_content_root_sha256 === inspected.request.baseline_content_root_sha256
      && receipt.environment_sha256 === inspected.request.environment_sha256;
  };
  const strongMeasurement = input.admissionEvidence?.strong_single ?? null;
  const simulationMeasurement = input.admissionEvidence?.candidate ?? null;
  const durableEvidence = strongMeasurement !== null && simulationMeasurement !== null
    && measurementMatches(strongMeasurement, "STRONG_SINGLE")
    && strongMeasurement.graph_proposal_sha256 === null
    && measurementMatches(simulationMeasurement, "DYNAMIC_MULTI_SIMULATION")
    && simulationMeasurement.graph_proposal_sha256 === inspected.request.graph_proposal_sha256;
  const baseline = !durableEvidence ? null : finalizeStrongSingleBaselineV2({
    ...closure,
    correctness: strongMeasurement.correctness,
    quality_basis_points: strongMeasurement.quality_basis_points,
    wall_time_ms: strongMeasurement.wall_time_ms,
    provider_requests: strongMeasurement.provider_requests,
    input_tokens: strongMeasurement.input_tokens,
    output_tokens: strongMeasurement.output_tokens,
    user_interventions: strongMeasurement.user_interventions,
    safety_events: strongMeasurement.safety_events,
    evidence_sha256: strongMeasurement.record_sha256,
    observed_at_ms: strongMeasurement.observed_at_ms,
  });
  const candidate = !durableEvidence || simulationMeasurement.correctness !== "PASS"
    ? null : finalizeDynamicMultiCandidateV2({
    ...closure,
    graph_sha256: inspected.request.graph_proposal_sha256,
    total_node_count: inspected.request.total_node_count,
    independent_node_count: inspected.request.independent_node_count,
    cross_partition_dependency_count: inspected.request.cross_partition_dependency_count,
    write_scope_conflict_count: inspected.request.write_scope_conflict_count,
    task_packets_complete: inspected.request.task_packets_complete,
    independent_validation: inspected.request.independent_validation,
    estimated_quality_basis_points: simulationMeasurement.quality_basis_points,
    estimated_wall_time_ms: simulationMeasurement.wall_time_ms,
    estimated_provider_requests: simulationMeasurement.provider_requests,
    estimated_input_tokens: simulationMeasurement.input_tokens,
    estimated_output_tokens: simulationMeasurement.output_tokens,
    estimated_user_interventions: simulationMeasurement.user_interventions,
    estimated_safety_events: simulationMeasurement.safety_events,
    simulator_receipt_sha256: simulationMeasurement.record_sha256,
    estimated_at_ms: simulationMeasurement.observed_at_ms,
  });
  const gate = finalizeTopologyGateV2({
    ...closure,
    run_id: input.preparation.runId,
    requested_topology: "MULTI",
    config_sha256: input.preparation.configSha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: input.preparation.predecessorAuthorityHeadSha256,
    created_at_ms: input.nowMs,
  });
  const topology = sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
    schema_version: 1,
    run_id: input.preparation.runId,
    revision: input.currentTopologyRevision + 1,
    requested_topology: "MULTI",
    effective_topology: gate.effective_topology,
    reason_code: gate.reason_code,
    decision_sha256: gate.record_sha256,
    config_sha256: input.preparation.configSha256,
    created_at_ms: input.nowMs,
  }, "record_sha256");
  if (gate.verdict !== "ALLOW") return { ...inspected, baseline, candidate, gate, topology, graph: null };
  const nodeIds = new Map(inspected.nodes.map((node) => [
    node.key,
    idFromSha256("EXECUTION_NODE_V2", canonicalJsonSha256({
      goal: input.preparation.goalId,
      run: input.preparation.runId,
      workCell: input.preparation.workCellId,
      logicalKey: node.key,
    })),
  ]));
  const graph = finalizeExecutionGraphV2({
    goal_id: input.preparation.goalId,
    run_id: input.preparation.runId,
    work_cell_id: input.preparation.workCellId,
    plan_revision_id: input.preparation.planRevisionId,
    plan_revision_sha256: input.preparation.planRevisionSha256,
    topology_gate_receipt_id: gate.topology_gate_receipt_id,
    topology_gate_receipt_sha256: gate.record_sha256,
    authorization_id: input.preparation.authorizationId,
    authorization_sha256: input.preparation.authorizationSha256,
    baseline_sha256: input.preparation.baselineSha256,
    baseline_content_root_sha256: input.preparation.baselineContentRootSha256,
    environment_sha256: input.preparation.environmentSha256,
    input_closure_sha256: input.preparation.inputClosureSha256,
    oracle_set_sha256: input.preparation.oracleSetSha256,
    config_sha256: input.preparation.configSha256,
    runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
    predecessor_authority_head_sha256: input.preparation.predecessorAuthorityHeadSha256,
    graph_revision: 1,
    stop_generation: 0,
    nodes: inspected.nodes.map((node) => {
      const requirementIds = input.preparation.workCellRequirementIds;
      const obligationIds = input.preparation.workCellObligationIds;
      const inputClosureSha256 = executionNodeInputClosureV2({
        task: node.task,
        requirement_ids: requirementIds,
        obligation_ids: obligationIds,
        exact_input_refs: node.exact_input_refs,
        decision_refs: input.preparation.workCellDecisionRefs,
        output_schema_sha256: node.output_schema_sha256,
        oracle_sha256: input.preparation.workCellOracleSha256,
        provider_profile_sha256: input.runtimeFingerprintSha256,
      });
      return {
        schema_version: 2 as const,
        node_id: nodeIds.get(node.key)!,
        logical_key: node.key,
        task: node.task,
        capabilities: node.capabilities,
        effect_ceiling: node.effect_ceiling,
        requirement_ids: requirementIds,
        obligation_ids: obligationIds,
        read_roots: node.read_roots,
        write_roots: node.write_roots,
        exact_input_refs: node.exact_input_refs,
        decision_refs: input.preparation.workCellDecisionRefs,
        provider_call_plan_id: null,
        provider_call_plan_sha256: null,
        input_closure_sha256: inputClosureSha256,
        output_schema_sha256: node.output_schema_sha256,
        oracle_sha256: input.preparation.workCellOracleSha256,
        provider_profile_sha256: input.runtimeFingerprintSha256,
        privacy_class: node.privacy_class,
        taint_classes: node.taint_classes,
        max_turns: node.max_turns,
        max_tool_calls: node.max_tool_calls,
        max_input_tokens: node.max_input_tokens,
        max_output_tokens: node.max_output_tokens,
        max_retries: node.max_retries,
        no_progress_limit: node.no_progress_limit,
        deadline_ms: node.deadline_ms,
      };
    }),
    edges: inspected.nodes.flatMap((node) => node.dependencies.map((dependency) => ({
      from_node_id: nodeIds.get(dependency.key)!,
      to_node_id: nodeIds.get(node.key)!,
      condition: dependency.condition,
    }))),
    created_at_ms: input.nowMs,
  });
  return { ...inspected, baseline, candidate, gate, topology, graph };
}

export function lowerDynamicMultiV2(input: DynamicMultiLoweringInputV2): LoweredDynamicMultiV2 {
  const inspected = inspectDynamicMultiProposalV2(input);
  const { shards: _shards, ...closure } = input;
  void _shards;
  return lowerInspectedDynamicMultiV2({ ...closure, inspected });
}
