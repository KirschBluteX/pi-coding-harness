import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Z][A-Z0-9_:-]{0,255}$/u;

export interface ProviderRedactionReceiptV1 {
  readonly schema_version: 1;
  readonly redaction_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly node_id: string;
  readonly packet_id: string;
  readonly minimum_input_closure_sha256: string;
  readonly privacy_class: "PUBLIC" | "INTERNAL" | "SENSITIVE" | "SECRET";
  readonly allowed_fields_root_sha256: string;
  readonly decision: "ALLOW";
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProviderInvocationTransitionV1 {
  readonly schema_version: 1;
  readonly provider_invocation_id: string;
  readonly provider_call_plan_id: string;
  readonly provider_call_plan_sha256: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly node_id: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly ordinal: 0 | 1;
  readonly state: "PREPARED" | "SETTLED" | "OUTCOME_UNKNOWN";
  readonly request_count: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly cost_microusd: number | null;
  readonly wall_time_ms: number | null;
  readonly cache_lineage_sha256: string | null;
  readonly success_evidence_sha256: string | null;
  readonly failure_sha256: string | null;
  readonly predecessor_transition_sha256: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

type RedactionDraftV1 = Omit<ProviderRedactionReceiptV1, "schema_version" | "redaction_receipt_id" | "decision" | "record_sha256">;
type InvocationPreparedDraftV1 = Pick<
  ProviderInvocationTransitionV1,
  | "provider_call_plan_id"
  | "provider_call_plan_sha256"
  | "goal_id"
  | "run_id"
  | "graph_revision_id"
  | "node_id"
  | "packet_id"
  | "packet_sha256"
  | "attempt"
  | "lease_generation"
  | "fencing_token"
  | "created_at_ms"
>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const remaining = new Set(keys);
  for (const key of Object.keys(value)) if (!remaining.delete(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  if (remaining.size > 0) throw new TypeError(`${label} is missing field ${[...remaining][0]}`);
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : sha(value, label);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

export function finalizeProviderRedactionReceiptV1(input: RedactionDraftV1): ProviderRedactionReceiptV1 {
  const identity = canonicalJsonSha256({
    domain: "PCH-PROVIDER-REDACTION-IDENTITY-V1",
    goal_id: input.goal_id,
    run_id: input.run_id,
    packet_id: input.packet_id,
    allowed_fields_root_sha256: input.allowed_fields_root_sha256,
  });
  const body: Omit<ProviderRedactionReceiptV1, "record_sha256"> = {
    schema_version: 1,
    redaction_receipt_id: idFromSha256("PROVIDER_REDACTION", identity),
    ...input,
    decision: "ALLOW",
  };
  const result = {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-PROVIDER-REDACTION-RECEIPT-V1", ...body }),
  };
  assertProviderRedactionReceiptV1(result);
  return Object.freeze(result);
}

export function assertProviderRedactionReceiptV1(value: ProviderRedactionReceiptV1): void {
  const row = record(value, "Provider redaction receipt");
  exactKeys(row, [
    "schema_version", "redaction_receipt_id", "goal_id", "run_id", "graph_revision_id", "node_id",
    "packet_id", "minimum_input_closure_sha256", "privacy_class", "allowed_fields_root_sha256", "decision",
    "predecessor_authority_head_sha256", "created_at_ms", "record_sha256",
  ], "Provider redaction receipt");
  if (value.schema_version !== 1 || value.decision !== "ALLOW") throw new TypeError("Provider redaction receipt state is invalid");
  for (const [label, member] of [
    ["ID", value.redaction_receipt_id], ["Goal", value.goal_id], ["run", value.run_id],
    ["graph", value.graph_revision_id], ["node", value.node_id], ["packet", value.packet_id],
  ] as const) id(member, `Provider redaction ${label}`);
  for (const [label, member] of [
    ["input closure", value.minimum_input_closure_sha256], ["allowed-fields root", value.allowed_fields_root_sha256],
    ["predecessor", value.predecessor_authority_head_sha256],
  ] as const) sha(member, `Provider redaction ${label}`);
  if (!["PUBLIC", "INTERNAL", "SENSITIVE", "SECRET"].includes(value.privacy_class)) {
    throw new TypeError("Provider redaction privacy class is invalid");
  }
  integer(value.created_at_ms, "Provider redaction creation time");
  const { record_sha256: actual, ...body } = value;
  if (sha(actual, "Provider redaction hash")
    !== canonicalJsonSha256({ domain: "PCH-PROVIDER-REDACTION-RECEIPT-V1", ...body })) {
    throw new TypeError("Provider redaction receipt hash mismatch");
  }
}

export function finalizeProviderInvocationPreparedV1(
  input: InvocationPreparedDraftV1,
): ProviderInvocationTransitionV1 {
  const identity = canonicalJsonSha256({
    domain: "PCH-PROVIDER-INVOCATION-IDENTITY-V1",
    plan: input.provider_call_plan_sha256,
    packet: input.packet_sha256,
  });
  return sealInvocation({
    schema_version: 1,
    provider_invocation_id: idFromSha256("PROVIDER_INVOCATION", identity),
    ...input,
    ordinal: 0,
    state: "PREPARED",
    request_count: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_microusd: null,
    wall_time_ms: null,
    cache_lineage_sha256: null,
    success_evidence_sha256: null,
    failure_sha256: null,
    predecessor_transition_sha256: null,
  });
}

export function finalizeProviderInvocationTerminalV1(input: {
  readonly prepared: ProviderInvocationTransitionV1;
  readonly state: "SETTLED" | "OUTCOME_UNKNOWN";
  readonly request_count?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly cost_microusd?: number | null;
  readonly wall_time_ms?: number;
  readonly cache_lineage_sha256?: string | null;
  readonly success_evidence_sha256?: string | null;
  readonly failure_sha256?: string | null;
  readonly created_at_ms: number;
}): ProviderInvocationTransitionV1 {
  assertProviderInvocationTransitionV1(input.prepared);
  if (input.prepared.state !== "PREPARED") throw new TypeError("Provider invocation terminal requires PREPARED authority");
  const settled = input.state === "SETTLED";
  return sealInvocation({
    ...input.prepared,
    ordinal: 1,
    state: input.state,
    request_count: settled ? input.request_count ?? 0 : null,
    input_tokens: settled ? input.input_tokens ?? 0 : null,
    output_tokens: settled ? input.output_tokens ?? 0 : null,
    cache_read_tokens: settled ? input.cache_read_tokens ?? 0 : null,
    cache_write_tokens: settled ? input.cache_write_tokens ?? 0 : null,
    cost_microusd: settled ? input.cost_microusd ?? null : null,
    wall_time_ms: settled ? input.wall_time_ms ?? 0 : null,
    cache_lineage_sha256: settled ? input.cache_lineage_sha256 ?? null : null,
    success_evidence_sha256: settled ? input.success_evidence_sha256 ?? null : null,
    failure_sha256: input.failure_sha256 ?? null,
    predecessor_transition_sha256: input.prepared.record_sha256,
    created_at_ms: input.created_at_ms,
    record_sha256: undefined as never,
  });
}

function sealInvocation(
  input: Omit<ProviderInvocationTransitionV1, "record_sha256"> & { readonly record_sha256?: never },
): ProviderInvocationTransitionV1 {
  const { record_sha256: _record, ...body } = input;
  void _record;
  const result = {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-PROVIDER-INVOCATION-TRANSITION-V1", ...body }),
  } as ProviderInvocationTransitionV1;
  assertProviderInvocationTransitionV1(result);
  return Object.freeze(result);
}

export function assertProviderInvocationTransitionV1(value: ProviderInvocationTransitionV1): void {
  const row = record(value, "Provider invocation transition");
  exactKeys(row, [
    "schema_version", "provider_invocation_id", "provider_call_plan_id", "provider_call_plan_sha256", "goal_id",
    "run_id", "graph_revision_id", "node_id", "packet_id", "packet_sha256", "attempt", "lease_generation",
    "fencing_token", "ordinal", "state", "request_count", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "cost_microusd", "wall_time_ms", "cache_lineage_sha256", "success_evidence_sha256",
    "failure_sha256", "predecessor_transition_sha256", "created_at_ms", "record_sha256",
  ], "Provider invocation transition");
  if (value.schema_version !== 1 || !["PREPARED", "SETTLED", "OUTCOME_UNKNOWN"].includes(value.state)) {
    throw new TypeError("Provider invocation transition state is invalid");
  }
  for (const [label, member] of [
    ["ID", value.provider_invocation_id], ["plan", value.provider_call_plan_id], ["Goal", value.goal_id],
    ["run", value.run_id], ["graph", value.graph_revision_id], ["node", value.node_id], ["packet", value.packet_id],
  ] as const) id(member, `Provider invocation ${label}`);
  sha(value.provider_call_plan_sha256, "Provider invocation plan hash");
  sha(value.packet_sha256, "Provider invocation packet hash");
  integer(value.attempt, "Provider invocation attempt", 1);
  integer(value.lease_generation, "Provider invocation lease generation", 1);
  integer(value.fencing_token, "Provider invocation fencing token", 1);
  integer(value.created_at_ms, "Provider invocation creation time");
  const metrics = [
    value.request_count, value.input_tokens, value.output_tokens, value.cache_read_tokens,
    value.cache_write_tokens, value.wall_time_ms,
  ];
  if (value.state === "PREPARED") {
    if (value.ordinal !== 0 || metrics.some((metric) => metric !== null) || value.cost_microusd !== null
      || value.cache_lineage_sha256 !== null || value.success_evidence_sha256 !== null || value.failure_sha256 !== null
      || value.predecessor_transition_sha256 !== null) {
      throw new TypeError("Prepared Provider invocation contains terminal evidence");
    }
  } else {
    if (value.ordinal !== 1 || value.predecessor_transition_sha256 === null) {
      throw new TypeError("Terminal Provider invocation lacks its prepared predecessor");
    }
    sha(value.predecessor_transition_sha256, "Provider invocation predecessor");
    if (value.state === "SETTLED") {
      for (const metric of metrics) integer(metric, "Provider invocation usage");
      if (value.cost_microusd !== null) integer(value.cost_microusd, "Provider invocation cost");
      const succeeded = value.success_evidence_sha256 !== null;
      const failed = value.failure_sha256 !== null;
      if (succeeded === failed || (succeeded && value.request_count === 0)) {
        throw new TypeError("Settled Provider invocation must carry exactly one success or failure outcome");
      }
    } else if (metrics.some((metric) => metric !== null) || value.cost_microusd !== null
      || value.cache_lineage_sha256 !== null || value.success_evidence_sha256 !== null || value.failure_sha256 === null) {
      throw new TypeError("Unknown Provider outcome cannot claim usage or success evidence");
    }
  }
  nullableSha(value.cache_lineage_sha256, "Provider invocation cache lineage");
  nullableSha(value.success_evidence_sha256, "Provider invocation success evidence");
  nullableSha(value.failure_sha256, "Provider invocation failure");
  const { record_sha256: actual, ...body } = value;
  if (sha(actual, "Provider invocation hash")
    !== canonicalJsonSha256({ domain: "PCH-PROVIDER-INVOCATION-TRANSITION-V1", ...body })) {
    throw new TypeError("Provider invocation transition hash mismatch");
  }
}
