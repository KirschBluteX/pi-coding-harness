import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export const comparableWorkloadDimensionsV1 = [
  "work_cell_semantics_sha256",
  "requirement_content_root_sha256",
  "obligation_content_root_sha256",
  "decision_content_root_sha256",
  "oracle_set_sha256",
  "scope_sha256",
  "effect_policy_sha256",
  "input_content_root_sha256",
  "environment_sha256",
  "runtime_fingerprint_sha256",
  "comparison_config_sha256",
  "provider_profile_sha256",
  "cache_epoch_sha256",
] as const;

export type ComparableWorkloadDimensionV1 = typeof comparableWorkloadDimensionsV1[number];
export type ComparableWorkloadDimensionsV1 = Readonly<Record<ComparableWorkloadDimensionV1, string>>;

export interface ComparableWorkloadV1 extends ComparableWorkloadDimensionsV1 {
  readonly schema_version: 1;
  readonly workload_key_sha256: string;
}

export interface StrongSingleWorkloadBindingV1 extends ComparableWorkloadV1 {
  readonly strong_single_workload_binding_id: string;
  readonly source_goal_id: string;
  readonly source_run_id: string;
  readonly source_work_cell_id: string;
  readonly source_rollout_receipt_id: string;
  readonly source_rollout_receipt_sha256: string;
  readonly source_topology_revision: number;
  readonly source_topology_revision_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface WorkloadComparabilityReceiptV1 extends ComparableWorkloadV1 {
  readonly workload_comparability_receipt_id: string;
  readonly target_goal_id: string;
  readonly target_run_id: string;
  readonly target_work_cell_id: string;
  readonly target_plan_revision_id: string;
  readonly target_plan_revision_sha256: string;
  readonly target_topology_revision: number;
  readonly target_topology_revision_sha256: string;
  readonly target_authorization_id: string;
  readonly target_authorization_sha256: string;
  readonly target_baseline_sha256: string;
  readonly target_input_closure_sha256: string;
  readonly source_binding_id: string;
  readonly source_binding_sha256: string;
  readonly source_rollout_receipt_id: string;
  readonly source_rollout_receipt_sha256: string;
  readonly source_workload_key_sha256: string;
  readonly current_workload_key_sha256: string;
  readonly verdict: "EXACT_MATCH";
  readonly selection_policy: "LATEST_PRIOR_COMPLETE_V1";
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
}

function dimensions(input: ComparableWorkloadDimensionsV1): ComparableWorkloadDimensionsV1 {
  for (const field of comparableWorkloadDimensionsV1) {
    sha256(input[field], field === "cache_epoch_sha256" ? "Comparable workload cache epoch" : `Comparable workload ${field}`);
  }
  return Object.fromEntries(comparableWorkloadDimensionsV1.map((field) => [field, input[field]])) as ComparableWorkloadDimensionsV1;
}

export function finalizeComparableWorkloadV1(
  input: ComparableWorkloadDimensionsV1 & Partial<Pick<ComparableWorkloadV1, "schema_version" | "workload_key_sha256">>,
): ComparableWorkloadV1 {
  const normalized = dimensions(input);
  const workloadKeySha256 = canonicalJsonSha256({
    domain: "PCH-COMPARABLE-WORKLOAD-V1",
    ...normalized,
  });
  if (input.schema_version !== undefined && input.schema_version !== 1) {
    throw new TypeError("Comparable workload schema version is invalid");
  }
  if (input.workload_key_sha256 !== undefined && input.workload_key_sha256 !== workloadKeySha256) {
    throw new TypeError("Comparable workload key is invalid");
  }
  return { schema_version: 1, ...normalized, workload_key_sha256: workloadKeySha256 };
}

export function finalizeStrongSingleWorkloadBindingV1(input: {
  readonly source_goal_id: string;
  readonly source_run_id: string;
  readonly source_work_cell_id: string;
  readonly source_rollout_receipt_id: string;
  readonly source_rollout_receipt_sha256: string;
  readonly source_topology_revision: number;
  readonly source_topology_revision_sha256: string;
  readonly workload: ComparableWorkloadV1;
  readonly created_at_ms: number;
}): StrongSingleWorkloadBindingV1 {
  for (const [value, label] of [
    [input.source_goal_id, "Strong Single workload Goal"],
    [input.source_run_id, "Strong Single workload run"],
    [input.source_work_cell_id, "Strong Single workload WorkCell"],
    [input.source_rollout_receipt_id, "Strong Single workload rollout"],
  ] as const) identifier(value, label);
  sha256(input.source_rollout_receipt_sha256, "Strong Single workload rollout hash");
  sha256(input.source_topology_revision_sha256, "Strong Single workload topology hash");
  if (!Number.isSafeInteger(input.source_topology_revision) || input.source_topology_revision < 1) {
    throw new TypeError("Strong Single workload topology revision is invalid");
  }
  nonNegativeInteger(input.created_at_ms, "Strong Single workload binding time");
  const workload = finalizeComparableWorkloadV1(input.workload);
  const identity = canonicalJsonSha256({
    rollout: input.source_rollout_receipt_sha256,
    workload: workload.workload_key_sha256,
  });
  const body = {
    schema_version: 1 as const,
    strong_single_workload_binding_id: idFromSha256("SINGLE_WORKLOAD", identity),
    source_goal_id: input.source_goal_id,
    source_run_id: input.source_run_id,
    source_work_cell_id: input.source_work_cell_id,
    source_rollout_receipt_id: input.source_rollout_receipt_id,
    source_rollout_receipt_sha256: input.source_rollout_receipt_sha256,
    source_topology_revision: input.source_topology_revision,
    source_topology_revision_sha256: input.source_topology_revision_sha256,
    ...dimensions(workload),
    workload_key_sha256: workload.workload_key_sha256,
    created_at_ms: input.created_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-STRONG-SINGLE-WORKLOAD-BINDING-V1", ...body }),
  };
}

export function finalizeWorkloadComparabilityReceiptV1(input: {
  readonly target_goal_id: string;
  readonly target_run_id: string;
  readonly target_work_cell_id: string;
  readonly target_plan_revision_id: string;
  readonly target_plan_revision_sha256: string;
  readonly target_topology_revision: number;
  readonly target_topology_revision_sha256: string;
  readonly target_authorization_id: string;
  readonly target_authorization_sha256: string;
  readonly target_baseline_sha256: string;
  readonly target_input_closure_sha256: string;
  readonly source: StrongSingleWorkloadBindingV1;
  readonly current_workload: ComparableWorkloadV1;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): WorkloadComparabilityReceiptV1 {
  for (const [value, label] of [
    [input.target_goal_id, "Comparable target Goal"], [input.target_run_id, "Comparable target run"],
    [input.target_work_cell_id, "Comparable target WorkCell"], [input.target_plan_revision_id, "Comparable target Plan"],
    [input.target_authorization_id, "Comparable target authorization"],
  ] as const) identifier(value, label);
  for (const [value, label] of [
    [input.target_plan_revision_sha256, "Comparable target Plan hash"],
    [input.target_topology_revision_sha256, "Comparable target topology hash"],
    [input.target_authorization_sha256, "Comparable target authorization hash"],
    [input.target_baseline_sha256, "Comparable target baseline hash"],
    [input.target_input_closure_sha256, "Comparable target input closure"],
    [input.predecessor_authority_head_sha256, "Comparable target authority head"],
    [input.source.record_sha256, "Comparable source binding hash"],
  ] as const) sha256(value, label);
  if (!Number.isSafeInteger(input.target_topology_revision) || input.target_topology_revision < 1) {
    throw new TypeError("Comparable target topology revision is invalid");
  }
  nonNegativeInteger(input.created_at_ms, "Comparable receipt time");
  const current = finalizeComparableWorkloadV1(input.current_workload);
  for (const field of comparableWorkloadDimensionsV1) {
    if (input.source[field] !== current[field]) throw new TypeError(`Comparable workload dimension mismatch: ${field}`);
  }
  if (input.source.workload_key_sha256 !== current.workload_key_sha256) {
    throw new TypeError("Comparable workload key mismatch");
  }
  const identity = canonicalJsonSha256({
    target: input.target_authorization_sha256,
    source: input.source.record_sha256,
    workload: current.workload_key_sha256,
  });
  const body = {
    schema_version: 1 as const,
    workload_comparability_receipt_id: idFromSha256("WORKLOAD_COMPARABILITY", identity),
    target_goal_id: input.target_goal_id,
    target_run_id: input.target_run_id,
    target_work_cell_id: input.target_work_cell_id,
    target_plan_revision_id: input.target_plan_revision_id,
    target_plan_revision_sha256: input.target_plan_revision_sha256,
    target_topology_revision: input.target_topology_revision,
    target_topology_revision_sha256: input.target_topology_revision_sha256,
    target_authorization_id: input.target_authorization_id,
    target_authorization_sha256: input.target_authorization_sha256,
    target_baseline_sha256: input.target_baseline_sha256,
    target_input_closure_sha256: input.target_input_closure_sha256,
    source_binding_id: input.source.strong_single_workload_binding_id,
    source_binding_sha256: input.source.record_sha256,
    source_rollout_receipt_id: input.source.source_rollout_receipt_id,
    source_rollout_receipt_sha256: input.source.source_rollout_receipt_sha256,
    ...dimensions(current),
    workload_key_sha256: current.workload_key_sha256,
    source_workload_key_sha256: input.source.workload_key_sha256,
    current_workload_key_sha256: current.workload_key_sha256,
    verdict: "EXACT_MATCH" as const,
    selection_policy: "LATEST_PRIOR_COMPLETE_V1" as const,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-WORKLOAD-COMPARABILITY-RECEIPT-V1", ...body }),
  };
}
