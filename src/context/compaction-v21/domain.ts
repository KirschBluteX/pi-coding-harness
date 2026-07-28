import { canonicalJsonSha256, omitProperty } from "../../authority/canonical-json.js";

export type HarnessCompactionState = "PREPARED" | "PI_OWNED" | "VERIFIED" | "ABORTED" | "RECOVERY_REQUIRED" | "RECONCILED";

export interface HarnessCompactionCapsule {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly goal_id: string;
  readonly task_flow_sha256: string;
  readonly harness_frontier_sha256: string;
  readonly execution_subject_sha256: string;
  readonly input_context_seed_sha256: string;
  readonly next_action_sha256: string;
  readonly pending_operation_ids: readonly string[];
  readonly unresolved_worker_run_ids: readonly string[];
}

export interface HarnessCompactionAttempt {
  readonly schema_version: 1;
  readonly attempt_id: string;
  readonly run_id: string;
  readonly goal_id: string;
  readonly checkpoint_id: string;
  readonly checkpoint_sha256: string;
  readonly pre_capsule: HarnessCompactionCapsule;
  readonly pre_capsule_sha256: string;
  readonly strategy: "NATIVE_GUARDED" | "FAST_STRUCTURED";
  readonly created_at_ms: number;
}

export interface HarnessCompactionTransition {
  readonly schema_version: 1;
  readonly transition_id: string;
  readonly attempt_id: string;
  readonly ordinal: number;
  readonly state: HarnessCompactionState;
  readonly reason_code: string;
  readonly observed_capsule_sha256: string | null;
  readonly predecessor_sha256: string | null;
  readonly created_at_ms: number;
  readonly transition_sha256: string;
}

const sha = /^[a-f0-9]{64}$/u;
const id = /^[A-Z][A-Z0-9_:-]{0,159}$/u;

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !id.test(value)) throw new TypeError(`${label} is invalid`);
}

export function compactionCapsuleSha256(value: HarnessCompactionCapsule): string {
  return canonicalJsonSha256({ domain: "PCH-COMPACTION-CAPSULE-V21", ...value });
}

export function assertHarnessCompactionCapsule(value: HarnessCompactionCapsule): void {
  if (value.schema_version !== 1) throw new TypeError("Compaction capsule schema version is invalid");
  assertId(value.run_id, "Compaction capsule run"); assertId(value.goal_id, "Compaction capsule goal");
  for (const [label, hash] of [
    ["task flow", value.task_flow_sha256], ["Harness frontier", value.harness_frontier_sha256],
    ["execution subject", value.execution_subject_sha256], ["Input Context seed", value.input_context_seed_sha256],
    ["next action", value.next_action_sha256],
  ] as const) assertHash(hash, `Compaction capsule ${label}`);
  if (value.pending_operation_ids.length > 256 || value.unresolved_worker_run_ids.length > 64) throw new TypeError("Compaction capsule frontier is too large");
  value.pending_operation_ids.forEach((entry) => assertId(entry, "Compaction pending operation"));
  value.unresolved_worker_run_ids.forEach((entry) => assertId(entry, "Compaction unresolved worker"));
}

export function assertHarnessCompactionAttempt(value: HarnessCompactionAttempt): void {
  if (value.schema_version !== 1) throw new TypeError("Compaction attempt schema version is invalid");
  assertId(value.attempt_id, "Compaction attempt"); assertId(value.run_id, "Compaction run");
  assertId(value.goal_id, "Compaction goal"); assertId(value.checkpoint_id, "Compaction checkpoint");
  assertHash(value.checkpoint_sha256, "Compaction checkpoint hash"); assertHash(value.pre_capsule_sha256, "Compaction capsule hash");
  assertHarnessCompactionCapsule(value.pre_capsule);
  if (value.pre_capsule_sha256 !== compactionCapsuleSha256(value.pre_capsule)) throw new TypeError("Compaction capsule hash mismatch");
  if (!Number.isSafeInteger(value.created_at_ms) || value.created_at_ms < 0) throw new TypeError("Compaction timestamp is invalid");
}

export function compactionTransitionSha256(value: Omit<HarnessCompactionTransition, "transition_sha256">): string {
  return canonicalJsonSha256({ domain: "PCH-COMPACTION-TRANSITION-V21", ...value });
}

export function assertHarnessCompactionTransition(value: HarnessCompactionTransition): void {
  assertId(value.transition_id, "Compaction transition"); assertId(value.attempt_id, "Compaction transition attempt");
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0) throw new TypeError("Compaction transition ordinal is invalid");
  if (!["PREPARED", "PI_OWNED", "VERIFIED", "ABORTED", "RECOVERY_REQUIRED", "RECONCILED"].includes(value.state)) throw new TypeError("Compaction transition state is invalid");
  if (!value.reason_code || value.reason_code.length > 160) throw new TypeError("Compaction transition reason is invalid");
  if (value.observed_capsule_sha256 !== null) assertHash(value.observed_capsule_sha256, "Compaction observed capsule");
  if (value.predecessor_sha256 !== null) assertHash(value.predecessor_sha256, "Compaction predecessor");
  assertHash(value.transition_sha256, "Compaction transition hash");
  const core = omitProperty(value, "transition_sha256");
  if (value.transition_sha256 !== compactionTransitionSha256(core)) throw new TypeError("Compaction transition hash mismatch");
}
