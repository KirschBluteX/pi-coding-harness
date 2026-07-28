import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

export interface ProtectedRef {
  readonly id: string;
  readonly sha256: string;
}

export type ProtectedExecutionPhase = "CLARIFYING" | "SPECIFYING" | "PLANNING" | "BUILDING" | "VERIFYING" | "TERMINAL";

export interface ProtectedTaskState {
  readonly objective: string;
  readonly acceptance_contract: ProtectedRef;
  readonly constraints: readonly ProtectedRef[];
  readonly latest_correction: ProtectedRef | null;
  readonly assumptions: readonly ProtectedRef[];
  readonly requirement_revision: ProtectedRef | null;
  readonly plan_revision: ProtectedRef | null;
  readonly execution_phase: ProtectedExecutionPhase;
  readonly current_stage: ProtectedRef | null;
  readonly next_action: string;
  readonly pending_effects: readonly ProtectedRef[];
  readonly receipts: readonly ProtectedRef[];
  readonly failure_signatures: readonly string[];
  readonly route_decision: ProtectedRef | null;
  readonly active_performance_trial: ProtectedRef | null;
  readonly prompt_generation: ProtectedRef | null;
  readonly prompt_request: ProtectedRef | null;
  readonly cache_lineage: ProtectedRef | null;
  readonly response_contract: ProtectedRef | null;
  readonly evidence_frontier: readonly ProtectedRef[];
  readonly lease_generation: number;
}

export interface ProtectedProjection {
  readonly schema_version: 2;
  readonly protected_state: ProtectedTaskState;
  readonly protected_state_sha256: string;
  readonly canonical_json: string;
  readonly rendered: string;
  readonly byte_length: number;
  readonly estimated_tokens: number;
}

const idPattern = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;

function assertRef(value: ProtectedRef, field: string): void {
  if (!idPattern.test(value.id) || !shaPattern.test(value.sha256)) {
    throw new AuthorityIntegrityError(`Invalid protected reference at ${field}`);
  }
}

function assertRefList(values: readonly ProtectedRef[], field: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    assertRef(value, `${field}[${index}]`);
    if (seen.has(value.id)) throw new AuthorityIntegrityError(`Duplicate protected reference at ${field}: ${value.id}`);
    seen.add(value.id);
  }
}

export function validateProtectedState(state: ProtectedTaskState): void {
  if (!state.objective || !state.next_action) throw new AuthorityIntegrityError("Protected objective and next action are required");
  if (!Number.isSafeInteger(state.lease_generation) || state.lease_generation < 1) throw new AuthorityIntegrityError("Protected lease generation is invalid");
  assertRef(state.acceptance_contract, "acceptance_contract");
  assertRefList(state.constraints, "constraints");
  assertRefList(state.assumptions, "assumptions");
  assertRefList(state.pending_effects, "pending_effects");
  assertRefList(state.receipts, "receipts");
  assertRefList(state.evidence_frontier, "evidence_frontier");
  for (const [field, value] of [
    ["latest_correction", state.latest_correction], ["requirement_revision", state.requirement_revision],
    ["plan_revision", state.plan_revision], ["current_stage", state.current_stage],
    ["route_decision", state.route_decision], ["active_performance_trial", state.active_performance_trial],
    ["prompt_generation", state.prompt_generation], ["prompt_request", state.prompt_request],
    ["cache_lineage", state.cache_lineage], ["response_contract", state.response_contract],
  ] as const) if (value) assertRef(value, field);
  if (new Set(state.failure_signatures).size !== state.failure_signatures.length
    || state.failure_signatures.some((value) => !shaPattern.test(value))) {
    throw new AuthorityIntegrityError("Protected failure signatures are invalid or duplicated");
  }
}

export function projectProtectedState(state: ProtectedTaskState): ProtectedProjection {
  validateProtectedState(state);
  const canonical = canonicalJson(state);
  const hash = canonicalJsonSha256(state);
  const rendered = `[PCH-PROTECTED-STATE-V2 sha256=${hash}]\n${canonical}\n[/PCH-PROTECTED-STATE-V2]`;
  return {
    schema_version: 2,
    protected_state: state,
    protected_state_sha256: hash,
    canonical_json: canonical,
    rendered,
    byte_length: Buffer.byteLength(rendered, "utf8"),
    estimated_tokens: Math.ceil(Buffer.byteLength(rendered, "utf8") / 4),
  };
}

export function verifyProtectedProjection(projection: ProtectedProjection): void {
  validateProtectedState(projection.protected_state);
  if (canonicalJson(projection.protected_state) !== projection.canonical_json
    || canonicalJsonSha256(projection.protected_state) !== projection.protected_state_sha256) {
    throw new AuthorityIntegrityError("Protected projection canonical hash mismatch");
  }
}
