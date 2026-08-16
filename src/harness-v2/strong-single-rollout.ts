import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface StrongSingleRolloutPreparationV1 {
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly input_closure_sha256: string;
  readonly topology_revision: number;
  readonly topology_revision_sha256: string;
  readonly config_sha256: string;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly started_at_ms: number;
}

export interface StrongSingleRolloutReceiptV1 extends StrongSingleRolloutPreparationV1 {
  readonly schema_version: 1;
  readonly rollout_receipt_id: string;
  readonly runtime_fingerprint_sha256: string;
  readonly completion_receipt_id: string;
  readonly completion_receipt_sha256: string;
  readonly correctness: "PASS";
  readonly quality_basis_points: 10_000;
  readonly wall_time_ms: number;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly provider_accounting_completeness: "COMPLETE";
  readonly provider_receipt_refs: readonly string[];
  readonly provider_receipt_root_sha256: string;
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly completed_at_ms: number;
  readonly record_sha256: string;
}

export interface StrongSingleRolloutLookupV1 {
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
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function count(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
}

export function finalizeStrongSingleRolloutReceiptV1(input: StrongSingleRolloutPreparationV1 & {
  readonly runtime_fingerprint_sha256: string;
  readonly completion_receipt_id: string;
  readonly completion_receipt_sha256: string;
  readonly provider_requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly provider_receipt_refs: readonly string[];
  readonly user_interventions: number;
  readonly safety_events: number;
  readonly completed_at_ms: number;
}): StrongSingleRolloutReceiptV1 {
  for (const [value, label] of [
    [input.goal_id, "Strong Single Goal"], [input.run_id, "Strong Single run"],
    [input.work_cell_id, "Strong Single WorkCell"], [input.plan_revision_id, "Strong Single Plan"],
    [input.authorization_id, "Strong Single authorization"],
    [input.completion_receipt_id, "Strong Single completion receipt"],
  ] as const) identifier(value, label);
  for (const [value, label] of [
    [input.plan_revision_sha256, "Strong Single Plan hash"],
    [input.input_closure_sha256, "Strong Single input closure"],
    [input.runtime_fingerprint_sha256, "Strong Single runtime"],
    [input.topology_revision_sha256, "Strong Single topology"],
    [input.config_sha256, "Strong Single config"],
    [input.authorization_sha256, "Strong Single authorization hash"],
    [input.baseline_sha256, "Strong Single baseline"],
    [input.baseline_content_root_sha256, "Strong Single baseline root"],
    [input.environment_sha256, "Strong Single environment"],
    [input.completion_receipt_sha256, "Strong Single completion receipt hash"],
  ] as const) sha256(value, label);
  for (const [value, label] of [
    [input.provider_requests, "Strong Single provider requests"],
    [input.input_tokens, "Strong Single input tokens"],
    [input.output_tokens, "Strong Single output tokens"],
    [input.cache_read_tokens, "Strong Single cache-read tokens"],
    [input.user_interventions, "Strong Single user interventions"],
    [input.safety_events, "Strong Single safety events"],
    [input.started_at_ms, "Strong Single start"], [input.completed_at_ms, "Strong Single completion"],
  ] as const) count(value, label);
  if (!Number.isSafeInteger(input.topology_revision) || input.topology_revision < 1
    || input.completed_at_ms < input.started_at_ms) {
    throw new TypeError("Strong Single rollout time or topology revision is invalid");
  }
  const providerReceiptRefs = [...input.provider_receipt_refs].sort();
  if (providerReceiptRefs.length > 8_192 || new Set(providerReceiptRefs).size !== providerReceiptRefs.length) {
    throw new TypeError("Strong Single provider receipt refs are invalid");
  }
  providerReceiptRefs.forEach((value) => sha256(value, "Strong Single provider receipt ref"));
  const providerReceiptRootSha256 = canonicalJsonSha256({
    domain: "PCH-STRONG-SINGLE-PROVIDER-RECEIPTS-V1",
    refs: providerReceiptRefs,
  });
  const identity = canonicalJsonSha256({
    goal: input.goal_id,
    run: input.run_id,
    workCell: input.work_cell_id,
    authorization: input.authorization_sha256,
    runtime: input.runtime_fingerprint_sha256,
    completion: input.completion_receipt_sha256,
  });
  const body = {
    schema_version: 1 as const,
    rollout_receipt_id: idFromSha256("STRONG_SINGLE_ROLLOUT", identity),
    goal_id: input.goal_id,
    run_id: input.run_id,
    work_cell_id: input.work_cell_id,
    plan_revision_id: input.plan_revision_id,
    plan_revision_sha256: input.plan_revision_sha256,
    input_closure_sha256: input.input_closure_sha256,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
    topology_revision: input.topology_revision,
    topology_revision_sha256: input.topology_revision_sha256,
    config_sha256: input.config_sha256,
    authorization_id: input.authorization_id,
    authorization_sha256: input.authorization_sha256,
    baseline_sha256: input.baseline_sha256,
    baseline_content_root_sha256: input.baseline_content_root_sha256,
    environment_sha256: input.environment_sha256,
    completion_receipt_id: input.completion_receipt_id,
    completion_receipt_sha256: input.completion_receipt_sha256,
    correctness: "PASS" as const,
    quality_basis_points: 10_000 as const,
    wall_time_ms: input.completed_at_ms - input.started_at_ms,
    provider_requests: input.provider_requests,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    provider_accounting_completeness: "COMPLETE" as const,
    provider_receipt_refs: providerReceiptRefs,
    provider_receipt_root_sha256: providerReceiptRootSha256,
    user_interventions: input.user_interventions,
    safety_events: input.safety_events,
    started_at_ms: input.started_at_ms,
    completed_at_ms: input.completed_at_ms,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-STRONG-SINGLE-ROLLOUT-RECEIPT-V1", ...body }),
  };
}

export function assertStrongSingleRolloutReceiptV1(receipt: StrongSingleRolloutReceiptV1): void {
  const expected = finalizeStrongSingleRolloutReceiptV1({
    goal_id: receipt.goal_id,
    run_id: receipt.run_id,
    work_cell_id: receipt.work_cell_id,
    plan_revision_id: receipt.plan_revision_id,
    plan_revision_sha256: receipt.plan_revision_sha256,
    input_closure_sha256: receipt.input_closure_sha256,
    runtime_fingerprint_sha256: receipt.runtime_fingerprint_sha256,
    topology_revision: receipt.topology_revision,
    topology_revision_sha256: receipt.topology_revision_sha256,
    config_sha256: receipt.config_sha256,
    authorization_id: receipt.authorization_id,
    authorization_sha256: receipt.authorization_sha256,
    baseline_sha256: receipt.baseline_sha256,
    baseline_content_root_sha256: receipt.baseline_content_root_sha256,
    environment_sha256: receipt.environment_sha256,
    completion_receipt_id: receipt.completion_receipt_id,
    completion_receipt_sha256: receipt.completion_receipt_sha256,
    provider_requests: receipt.provider_requests,
    input_tokens: receipt.input_tokens,
    output_tokens: receipt.output_tokens,
    cache_read_tokens: receipt.cache_read_tokens,
    provider_receipt_refs: receipt.provider_receipt_refs,
    user_interventions: receipt.user_interventions,
    safety_events: receipt.safety_events,
    started_at_ms: receipt.started_at_ms,
    completed_at_ms: receipt.completed_at_ms,
  });
  if (receipt.schema_version !== 1 || receipt.correctness !== "PASS"
    || receipt.quality_basis_points !== 10_000 || receipt.provider_accounting_completeness !== "COMPLETE"
    || receipt.rollout_receipt_id !== expected.rollout_receipt_id
    || receipt.provider_receipt_root_sha256 !== expected.provider_receipt_root_sha256
    || receipt.wall_time_ms !== expected.wall_time_ms || receipt.record_sha256 !== expected.record_sha256) {
    throw new TypeError("Strong Single rollout receipt integrity failed");
  }
}
