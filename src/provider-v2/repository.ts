import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson, parseCanonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import {
  assertProviderCallPlanV1,
  type ProviderCallPlanV1,
} from "./domain.js";
import {
  assertProviderInvocationTransitionV1,
  assertProviderRedactionReceiptV1,
  type ProviderInvocationTransitionV1,
  type ProviderRedactionReceiptV1,
} from "./invocation.js";

export interface ProviderCallPlanIntegritySummaryV1 {
  readonly available: boolean;
  readonly plans: number;
  readonly plannedTaskPackets: number;
  readonly activeUnplannedTaskPackets: number;
  readonly mismatches: number;
}

export interface ProviderGoalUsageSummaryV1 {
  readonly requests: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cost_microusd: number | null;
  readonly accounting_completeness: "COMPLETE" | "PARTIAL" | "UNOBSERVABLE";
  readonly budget_state: "UNKNOWN" | "WITHIN" | "EXCEEDED";
  readonly receipt_refs: readonly string[];
}

let savepointSequence = 0;

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare(
    "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { readonly count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityIntegrityError(`ProviderCallPlan ${key} is invalid`);
  }
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`ProviderCallPlan ${key} is invalid`);
  return value;
}

function assertTransaction(connection: AuthorityConnection): void {
  if (!connection.isTransaction) {
    throw new AuthorityIntegrityError("ProviderCallPlan must be recorded inside the authority transaction");
  }
}

function inSavepoint<T>(connection: AuthorityConnection, action: () => T): T {
  const name = `provider_v2_${++savepointSequence}`;
  connection.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    connection.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function expectedColumns(plan: ProviderCallPlanV1): Readonly<Record<string, string | number | null>> {
  return {
    provider_call_plan_id: plan.provider_call_plan_id,
    goal_id: plan.goal_id,
    run_id: plan.run_id,
    execution_graph_revision_id: plan.graph_revision_id,
    execution_graph_revision_sha256: plan.graph_revision_sha256,
    node_id: plan.node_id,
    node_spec_sha256: plan.node_spec_sha256,
    packet_id: plan.packet_id,
    attempt: plan.attempt,
    lease_generation: plan.lease_generation,
    fencing_token: plan.fencing_token,
    logical_request_id: plan.logical_request_id,
    plan_nonce_sha256: plan.plan_nonce_sha256,
    request_class: plan.request_class,
    purpose_kind: plan.purpose_kind,
    uncertainty_id: plan.uncertainty_id,
    uncertainty_sha256: plan.uncertainty_sha256,
    expected_information_gain_basis_points: plan.expected_information_gain.basis_points,
    expected_information_gain_evidence_sha256: plan.expected_information_gain.evidence_sha256,
    expected_loss_if_skipped_basis_points: plan.expected_loss_if_skipped.basis_points,
    expected_loss_if_skipped_evidence_sha256: plan.expected_loss_if_skipped.evidence_sha256,
    minimum_input_closure_sha256: plan.minimum_input_closure_sha256,
    privacy_class: plan.privacy_class,
    allowed_fields_root_sha256: plan.allowed_fields_root_sha256,
    allowed_field_count: plan.allowed_fields.length,
    redaction_receipt_id: plan.redaction_receipt_id,
    redaction_receipt_sha256: plan.redaction_receipt_sha256,
    provider_profile_source: plan.provider_profile.source,
    provider_source_profile_id: plan.provider_profile.source_profile_id,
    provider_fallback_reason: plan.provider_profile.fallback_reason,
    provider_profile_sha256: plan.provider_profile_sha256,
    current_pi_config_sha256: plan.provider_profile.current_pi_config_sha256,
    runtime_fingerprint_sha256: plan.provider_profile.runtime_fingerprint_sha256,
    budget_envelope_sha256: plan.request_budget.budget_envelope_sha256,
    soft_max_requests: plan.request_budget.soft_max_requests,
    soft_max_input_tokens: plan.request_budget.soft_max_input_tokens,
    soft_max_output_tokens: plan.request_budget.soft_max_output_tokens,
    soft_max_cost_microusd: plan.request_budget.soft_max_cost_microusd,
    soft_max_latency_ms: plan.request_budget.soft_max_latency_ms,
    deadline_at_ms: plan.request_budget.deadline_at_ms,
    admission_reason: plan.admission_reason,
    cache_mode: plan.cache.mode,
    cache_lineage_sha256: plan.cache.lineage_sha256,
    cache_adapter_integration_id: plan.cache.adapter_integration_id,
    cache_adapter_security_epoch: plan.cache.adapter_security_epoch,
    cache_adapter_usage_semantics_id: plan.cache.adapter_usage_semantics_id,
    session_capability: plan.cache.session_capability,
    session_capability_sha256: plan.cache.session_capability_sha256,
    success_evidence_kind: plan.success_evidence.kind,
    success_output_schema_sha256: plan.success_evidence.output_schema_sha256,
    success_evidence_requirement_sha256: plan.success_evidence.evidence_requirement_sha256,
    local_oracle_owner: plan.local_oracle.owner,
    local_oracle_sha256: plan.local_oracle.oracle_sha256,
    fallback_kind: plan.fallback.kind,
    fallback_evidence_sha256: plan.fallback.evidence_sha256,
    attempt_limit: plan.attempt_limit,
    transport_request_limit: plan.transport_request_limit,
    fan_out_limit: plan.fan_out_limit,
    fan_out_independence_evidence_sha256: plan.fan_out_independence_evidence_sha256,
    fan_out_branch_count: plan.fan_out_branch_information_sha256s.length,
    no_progress_limit: plan.no_progress_limit,
    evidence_saturation_sha256: plan.evidence_saturation_sha256,
    stop_condition_count: plan.stop_conditions.length,
    provider_output_authority: plan.provider_output_authority,
    predecessor_authority_head_sha256: plan.predecessor_authority_head_sha256,
    record_json: canonicalJson(plan),
    record_sha256: plan.record_sha256,
    created_at_ms: plan.created_at_ms,
  };
}

function assertRowBinding(row: Record<string, unknown>, plan: ProviderCallPlanV1): void {
  for (const [key, expected] of Object.entries(expectedColumns(plan))) {
    const actual = typeof expected === "number"
      ? integer(row, key)
      : expected === null
        ? nullableText(row, key)
        : text(row, key);
    if (actual !== expected) throw new AuthorityIntegrityError(`ProviderCallPlan ${key} binding mismatch`);
  }
  const storedJson = text(row, "record_json");
  if (storedJson !== canonicalJson(plan)) throw new AuthorityIntegrityError("ProviderCallPlan record JSON is not exact authority");
  const eventSequence = integer(row, "created_event_sequence");
  if (eventSequence < 1) throw new AuthorityIntegrityError("ProviderCallPlan event sequence is invalid");
}

function assertCreatedEvent(
  connection: AuthorityConnection,
  goalId: string,
  eventSequence: number,
  eventType: string | readonly string[],
  expectedPayload: Readonly<Record<string, string>>,
): void {
  const event = connection.prepare(
    "SELECT event_type,payload_json FROM events WHERE goal_id=? AND sequence=?",
  ).get(goalId, eventSequence) as Record<string, unknown> | undefined;
  const allowed = typeof eventType === "string" ? [eventType] : eventType;
  if (!event || !allowed.includes(text(event, "event_type"))) {
    throw new AuthorityIntegrityError("Provider authority creation event type is invalid");
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text(event, "payload_json")) as Record<string, unknown>; }
  catch (error) { throw new AuthorityIntegrityError("Provider authority event payload is invalid", error); }
  for (const [key, expected] of Object.entries(expectedPayload)) {
    if (payload[key] !== expected) throw new AuthorityIntegrityError(`Provider authority event payload ${key} mismatch`);
  }
}

function redactionFromRow(row: Record<string, unknown>): ProviderRedactionReceiptV1 {
  const value: ProviderRedactionReceiptV1 = {
    schema_version: 1,
    redaction_receipt_id: text(row, "redaction_receipt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    node_id: text(row, "node_id"),
    packet_id: text(row, "packet_id"),
    minimum_input_closure_sha256: text(row, "minimum_input_closure_sha256"),
    privacy_class: text(row, "privacy_class") as ProviderRedactionReceiptV1["privacy_class"],
    allowed_fields_root_sha256: text(row, "allowed_fields_root_sha256"),
    decision: text(row, "decision") as "ALLOW",
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertProviderRedactionReceiptV1(value);
  return value;
}

function invocationFromRow(row: Record<string, unknown>): ProviderInvocationTransitionV1 {
  const nullableInteger = (key: string): number | null => row[key] === null ? null : integer(row, key);
  const value: ProviderInvocationTransitionV1 = {
    schema_version: 1,
    provider_invocation_id: text(row, "provider_invocation_id"),
    provider_call_plan_id: text(row, "provider_call_plan_id"),
    provider_call_plan_sha256: text(row, "provider_call_plan_sha256"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    node_id: text(row, "node_id"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    attempt: integer(row, "attempt"),
    lease_generation: integer(row, "lease_generation"),
    fencing_token: integer(row, "fencing_token"),
    ordinal: integer(row, "ordinal") as 0 | 1,
    state: text(row, "state") as ProviderInvocationTransitionV1["state"],
    request_count: nullableInteger("request_count"),
    input_tokens: nullableInteger("input_tokens"),
    output_tokens: nullableInteger("output_tokens"),
    cache_read_tokens: nullableInteger("cache_read_tokens"),
    cache_write_tokens: nullableInteger("cache_write_tokens"),
    cost_microusd: nullableInteger("cost_microusd"),
    wall_time_ms: nullableInteger("wall_time_ms"),
    cache_lineage_sha256: nullableText(row, "cache_lineage_sha256"),
    success_evidence_sha256: nullableText(row, "success_evidence_sha256"),
    failure_sha256: nullableText(row, "failure_sha256"),
    predecessor_transition_sha256: nullableText(row, "predecessor_transition_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertProviderInvocationTransitionV1(value);
  return value;
}

export class ProviderCallPlanV1Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "provider_call_plans_v1");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Provider Invocation migration 029 is not available");
  }

  recordRedaction(receipt: ProviderRedactionReceiptV1, eventSequence: number): void {
    this.assertAvailable();
    assertTransaction(this.connection);
    assertProviderRedactionReceiptV1(receipt);
    this.connection.prepare(`INSERT INTO provider_redaction_receipts_v1(
      redaction_receipt_id,goal_id,run_id,execution_graph_revision_id,node_id,packet_id,
      minimum_input_closure_sha256,privacy_class,allowed_fields_root_sha256,decision,
      predecessor_authority_head_sha256,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.redaction_receipt_id, receipt.goal_id, receipt.run_id, receipt.graph_revision_id,
      receipt.node_id, receipt.packet_id, receipt.minimum_input_closure_sha256, receipt.privacy_class,
      receipt.allowed_fields_root_sha256, receipt.decision, receipt.predecessor_authority_head_sha256,
      receipt.created_at_ms, receipt.record_sha256, eventSequence,
    );
    const stored = this.connection.prepare(
      "SELECT * FROM provider_redaction_receipts_v1 WHERE redaction_receipt_id=?",
    ).get(receipt.redaction_receipt_id) as Record<string, unknown> | undefined;
    if (!stored || redactionFromRow(stored).record_sha256 !== receipt.record_sha256) {
      throw new AuthorityIntegrityError("Provider redaction receipt did not round-trip");
    }
  }

  readRedaction(redactionReceiptId: string): ProviderRedactionReceiptV1 | null {
    this.assertAvailable();
    const row = this.connection.prepare(
      "SELECT * FROM provider_redaction_receipts_v1 WHERE redaction_receipt_id=?",
    ).get(redactionReceiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const receipt = redactionFromRow(row);
    const sequence = integer(row, "created_event_sequence");
    assertCreatedEvent(this.connection, receipt.goal_id, sequence, "EXECUTION_NODE_LEASED", {
      redactionReceiptId: receipt.redaction_receipt_id,
      redactionReceiptSha256: receipt.record_sha256,
    });
    return receipt;
  }

  recordInvocation(transition: ProviderInvocationTransitionV1, eventSequence: number): void {
    this.assertAvailable();
    assertTransaction(this.connection);
    assertProviderInvocationTransitionV1(transition);
    this.connection.prepare(`INSERT INTO provider_invocation_transitions_v1(
      provider_invocation_id,provider_call_plan_id,provider_call_plan_sha256,goal_id,run_id,
      execution_graph_revision_id,node_id,packet_id,packet_sha256,attempt,lease_generation,fencing_token,
      ordinal,state,request_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
      cost_microusd,wall_time_ms,cache_lineage_sha256,success_evidence_sha256,failure_sha256,
      predecessor_transition_sha256,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(${Array.from({ length: 28 }, () => "?").join(",")})`).run(
      transition.provider_invocation_id, transition.provider_call_plan_id, transition.provider_call_plan_sha256,
      transition.goal_id, transition.run_id, transition.graph_revision_id, transition.node_id,
      transition.packet_id, transition.packet_sha256, transition.attempt, transition.lease_generation,
      transition.fencing_token, transition.ordinal, transition.state, transition.request_count,
      transition.input_tokens, transition.output_tokens, transition.cache_read_tokens,
      transition.cache_write_tokens, transition.cost_microusd, transition.wall_time_ms,
      transition.cache_lineage_sha256, transition.success_evidence_sha256, transition.failure_sha256,
      transition.predecessor_transition_sha256, transition.created_at_ms, transition.record_sha256,
      eventSequence,
    );
    const row = this.connection.prepare(`SELECT * FROM provider_invocation_transitions_v1
      WHERE provider_invocation_id=? AND ordinal=?`).get(
      transition.provider_invocation_id, transition.ordinal,
    ) as Record<string, unknown> | undefined;
    if (!row || invocationFromRow(row).record_sha256 !== transition.record_sha256) {
      throw new AuthorityIntegrityError("Provider invocation transition did not round-trip");
    }
  }

  readInvocation(providerInvocationId: string, ordinal?: 0 | 1): ProviderInvocationTransitionV1 | null {
    this.assertAvailable();
    const row = (ordinal === undefined
      ? this.connection.prepare(`SELECT * FROM provider_invocation_transitions_v1
          WHERE provider_invocation_id=? ORDER BY ordinal DESC LIMIT 1`).get(providerInvocationId)
      : this.connection.prepare(`SELECT * FROM provider_invocation_transitions_v1
          WHERE provider_invocation_id=? AND ordinal=?`).get(providerInvocationId, ordinal)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const transition = invocationFromRow(row);
    const sequence = integer(row, "created_event_sequence");
    assertCreatedEvent(
      this.connection,
      transition.goal_id,
      sequence,
      transition.state === "PREPARED"
        ? "EXECUTION_NODE_LEASED"
        : ["PROVIDER_INVOCATION_TRANSITIONED", "EXECUTION_WORKER_PROPOSAL_SUBMITTED"],
      transition.state === "PREPARED"
        ? {
          providerInvocationId: transition.provider_invocation_id,
          providerInvocationPreparedSha256: transition.record_sha256,
        }
        : {
          providerInvocationId: transition.provider_invocation_id,
          providerInvocationTransitionSha256: transition.record_sha256,
        },
    );
    return transition;
  }

  readInvocationByPacket(packetId: string): ProviderInvocationTransitionV1 | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT provider_invocation_id FROM provider_invocation_transitions_v1
      WHERE packet_id=? ORDER BY ordinal DESC LIMIT 1`).get(packetId) as Record<string, unknown> | undefined;
    return row ? this.readInvocation(text(row, "provider_invocation_id")) : null;
  }

  readGoalUsageSummary(goalId: string): ProviderGoalUsageSummaryV1 {
    this.assertAvailable();
    const prepared = this.connection.prepare(`SELECT count(*) count
      FROM provider_invocation_transitions_v1 WHERE goal_id=? AND ordinal=0`).get(goalId) as
      Record<string, unknown> | undefined;
    const rows = this.connection.prepare(`SELECT terminal.*,plan.soft_max_requests,plan.soft_max_input_tokens,
        plan.soft_max_output_tokens,plan.soft_max_cost_microusd
      FROM provider_invocation_transitions_v1 terminal
      JOIN provider_call_plans_v1 plan ON plan.provider_call_plan_id=terminal.provider_call_plan_id
      WHERE terminal.goal_id=? AND terminal.ordinal=1
      ORDER BY terminal.created_event_sequence,terminal.provider_invocation_id`).all(goalId) as Record<string, unknown>[];
    const preparedCount = Number(prepared?.count ?? 0);
    const transitions = rows.map(invocationFromRow);
    const settled = transitions.filter((transition) => transition.state === "SETTLED");
    const incomplete = transitions.length !== preparedCount || transitions.some((transition) => transition.state !== "SETTLED"
      || transition.request_count === null || transition.input_tokens === null || transition.output_tokens === null
      || transition.cache_read_tokens === null || transition.cache_write_tokens === null || transition.wall_time_ms === null);
    const completeness: ProviderGoalUsageSummaryV1["accounting_completeness"] = preparedCount === 0 && transitions.length === 0
      ? "COMPLETE"
      : incomplete ? (settled.length > 0 ? "PARTIAL" : "UNOBSERVABLE") : "COMPLETE";
    const complete = completeness === "COMPLETE";
    const sum = (pick: (transition: ProviderInvocationTransitionV1) => number | null): number | null => {
      const values = transitions.map(pick);
      return complete && values.every((value): value is number => value !== null)
        ? values.reduce((total, value) => total + value, 0)
        : null;
    };
    const costs = transitions.map((transition) => transition.cost_microusd);
    const cost = complete && costs.every((value): value is number => value !== null)
      ? costs.reduce((total, value) => total + value, 0)
      : null;
    const exceeded = complete && rows.some((row) =>
      integer(row, "request_count") > integer(row, "soft_max_requests")
      || integer(row, "input_tokens") > integer(row, "soft_max_input_tokens")
      || integer(row, "output_tokens") > integer(row, "soft_max_output_tokens")
      || (row.cost_microusd !== null && integer(row, "cost_microusd") > integer(row, "soft_max_cost_microusd")));
    return {
      requests: sum((transition) => transition.request_count),
      input_tokens: sum((transition) => transition.input_tokens),
      output_tokens: sum((transition) => transition.output_tokens),
      cache_read_tokens: sum((transition) => transition.cache_read_tokens),
      cost_microusd: cost,
      accounting_completeness: completeness,
      budget_state: complete ? (exceeded ? "EXCEEDED" : "WITHIN") : "UNKNOWN",
      receipt_refs: transitions.map((transition) => transition.record_sha256),
    };
  }

  readRunInvocationCount(goalId: string, runId: string): number {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT count(*) count
      FROM provider_invocation_transitions_v1
      WHERE goal_id=? AND run_id=? AND ordinal=0`).get(goalId, runId) as Record<string, unknown> | undefined;
    return integer(row ?? {}, "count");
  }

  record(plan: ProviderCallPlanV1, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
      throw new AuthorityIntegrityError("ProviderCallPlan event sequence is invalid");
    }
    try { assertProviderCallPlanV1(plan); }
    catch (error) { throw new AuthorityIntegrityError("ProviderCallPlan is invalid", error); }

    return inSavepoint(this.connection, () => {
      const existing = this.connection.prepare(
        "SELECT record_sha256 FROM provider_call_plans_v1 WHERE provider_call_plan_id=?",
      ).get(plan.provider_call_plan_id) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.record_sha256 !== plan.record_sha256) {
          throw new AuthorityIntegrityError("ProviderCallPlan ID substitution");
        }
        const original = this.connection.prepare(
          "SELECT created_event_sequence FROM provider_call_plans_v1 WHERE provider_call_plan_id=?",
        ).get(plan.provider_call_plan_id) as Record<string, unknown> | undefined;
        if (!original || integer(original, "created_event_sequence") !== eventSequence) {
          throw new AuthorityIntegrityError("ProviderCallPlan cannot be reused by another authority event");
        }
        const stored = this.connection.prepare(
          "SELECT * FROM provider_call_plans_v1 WHERE provider_call_plan_id=?",
        ).get(plan.provider_call_plan_id) as Record<string, unknown> | undefined;
        if (!stored || text(stored, "record_json") !== canonicalJson(plan)) {
          throw new AuthorityIntegrityError("ProviderCallPlan cannot be reconstructed exactly");
        }
        assertRowBinding(stored, plan);
        return true;
      }

      const columns = expectedColumns(plan);
      const values = Object.values(columns);
      this.connection.prepare(`INSERT INTO provider_call_plans_v1(
        provider_call_plan_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
        node_id,node_spec_sha256,packet_id,attempt,lease_generation,fencing_token,
        logical_request_id,plan_nonce_sha256,request_class,
        purpose_kind,uncertainty_id,uncertainty_sha256,expected_information_gain_basis_points,
        expected_information_gain_evidence_sha256,expected_loss_if_skipped_basis_points,
        expected_loss_if_skipped_evidence_sha256,minimum_input_closure_sha256,privacy_class,
        allowed_fields_root_sha256,allowed_field_count,redaction_receipt_id,redaction_receipt_sha256,
        provider_profile_source,provider_source_profile_id,provider_fallback_reason,provider_profile_sha256,
        current_pi_config_sha256,runtime_fingerprint_sha256,budget_envelope_sha256,soft_max_requests,
        soft_max_input_tokens,soft_max_output_tokens,soft_max_cost_microusd,soft_max_latency_ms,
        deadline_at_ms,admission_reason,cache_mode,cache_lineage_sha256,cache_adapter_integration_id,
        cache_adapter_security_epoch,cache_adapter_usage_semantics_id,session_capability,
        session_capability_sha256,success_evidence_kind,success_output_schema_sha256,
        success_evidence_requirement_sha256,local_oracle_owner,local_oracle_sha256,fallback_kind,
        fallback_evidence_sha256,attempt_limit,transport_request_limit,fan_out_limit,fan_out_independence_evidence_sha256,
        fan_out_branch_count,no_progress_limit,evidence_saturation_sha256,stop_condition_count,
        provider_output_authority,predecessor_authority_head_sha256,record_json,record_sha256,
        created_at_ms,created_event_sequence
      ) VALUES(${Array.from({ length: values.length + 1 }, () => "?").join(",")})`).run(
        ...values,
        eventSequence,
      );
      const stored = this.connection.prepare(
        "SELECT * FROM provider_call_plans_v1 WHERE provider_call_plan_id=?",
      ).get(plan.provider_call_plan_id) as Record<string, unknown> | undefined;
      if (!stored) {
        throw new AuthorityIntegrityError("ProviderCallPlan write did not round-trip exactly");
      }
      assertRowBinding(stored, plan);
      return false;
    });
  }

  read(providerCallPlanId: string): ProviderCallPlanV1 | null {
    this.assertAvailable();
    const row = this.connection.prepare(
      "SELECT * FROM provider_call_plans_v1 WHERE provider_call_plan_id=?",
    ).get(providerCallPlanId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let plan: ProviderCallPlanV1;
    try {
      plan = parseCanonicalJson(text(row, "record_json")) as unknown as ProviderCallPlanV1;
      assertProviderCallPlanV1(plan);
    } catch (error) {
      throw new AuthorityIntegrityError("Stored ProviderCallPlan cannot be reconstructed", error);
    }
    assertRowBinding(row, plan);
    const eventSequence = integer(row, "created_event_sequence");
    const predecessor = this.connection.prepare(
      "SELECT event_sha256 FROM events WHERE goal_id=? AND sequence=?",
    ).get(plan.goal_id, eventSequence - 1) as Record<string, unknown> | undefined;
    if (!predecessor || predecessor.event_sha256 !== plan.predecessor_authority_head_sha256) {
      throw new AuthorityIntegrityError("ProviderCallPlan predecessor event binding is invalid");
    }
    const config = this.connection.prepare(`SELECT 1 FROM topology_revisions_v1
      WHERE run_id=? AND config_sha256=? AND created_event_sequence<=? LIMIT 1`).get(
      plan.run_id, plan.provider_profile.current_pi_config_sha256, eventSequence,
    );
    if (!config) throw new AuthorityIntegrityError("ProviderCallPlan Pi config provenance is missing");
    assertCreatedEvent(this.connection, plan.goal_id, eventSequence, "EXECUTION_NODE_LEASED", {
      providerCallPlanId: plan.provider_call_plan_id,
      providerCallPlanSha256: plan.record_sha256,
    });
    const packet = this.connection.prepare(`SELECT 1 FROM task_packets_v2
      WHERE packet_id=? AND goal_id=? AND run_id=? AND execution_graph_revision_id=?
        AND node_id=? AND provider_call_plan_id=? AND provider_call_plan_sha256=?
        AND attempt=? AND lease_generation=? AND fencing_token=?`).get(
      plan.packet_id, plan.goal_id, plan.run_id, plan.graph_revision_id, plan.node_id,
      plan.provider_call_plan_id, plan.record_sha256, plan.attempt, plan.lease_generation, plan.fencing_token,
    );
    if (!packet) throw new AuthorityIntegrityError("ProviderCallPlan TaskPacket binding is missing");
    const redaction = this.readRedaction(plan.redaction_receipt_id);
    if (!redaction || redaction.record_sha256 !== plan.redaction_receipt_sha256
      || redaction.allowed_fields_root_sha256 !== plan.allowed_fields_root_sha256) {
      throw new AuthorityIntegrityError("ProviderCallPlan redaction authority is missing");
    }
    return plan;
  }

  verifyIntegrity(): ProviderCallPlanIntegritySummaryV1 {
    if (!this.available()) {
      return {
        available: false,
        plans: 0,
        plannedTaskPackets: 0,
        activeUnplannedTaskPackets: 0,
        mismatches: 0,
      };
    }
    const count = (sql: string): number => integer(
      (this.connection.prepare(sql).get() as Record<string, unknown> | undefined) ?? {},
      "count",
    );
    const ids = this.connection.prepare(
      "SELECT provider_call_plan_id FROM provider_call_plans_v1 ORDER BY provider_call_plan_id",
    ).all() as Record<string, unknown>[];
    let mismatches = 0;
    for (const row of ids) {
      try { this.read(text(row, "provider_call_plan_id")); }
      catch { mismatches += 1; }
    }
    const redactionIds = this.connection.prepare(
      "SELECT redaction_receipt_id FROM provider_redaction_receipts_v1 ORDER BY redaction_receipt_id",
    ).all() as Record<string, unknown>[];
    for (const row of redactionIds) {
      try { this.readRedaction(text(row, "redaction_receipt_id")); }
      catch { mismatches += 1; }
    }
    const invocationIds = this.connection.prepare(
      "SELECT DISTINCT provider_invocation_id FROM provider_invocation_transitions_v1 ORDER BY provider_invocation_id",
    ).all() as Record<string, unknown>[];
    for (const row of invocationIds) {
      try {
        const providerInvocationId = text(row, "provider_invocation_id");
        this.readInvocation(providerInvocationId, 0);
        const terminal = this.connection.prepare(`SELECT 1 FROM provider_invocation_transitions_v1
          WHERE provider_invocation_id=? AND ordinal=1`).get(providerInvocationId);
        if (terminal) this.readInvocation(providerInvocationId, 1);
      } catch { mismatches += 1; }
    }
    const plannedTaskPackets = tableExists(this.connection, "task_packets_v2")
      ? count("SELECT count(*) count FROM task_packets_v2 WHERE provider_call_plan_id IS NOT NULL")
      : 0;
    const packetMismatches = tableExists(this.connection, "task_packets_v2")
      ? count(`SELECT count(*) count
        FROM task_packets_v2 p
        LEFT JOIN provider_call_plans_v1 c ON c.provider_call_plan_id=p.provider_call_plan_id
        LEFT JOIN execution_nodes_v2 n
          ON n.execution_graph_revision_id=p.execution_graph_revision_id AND n.node_id=p.node_id
        WHERE p.provider_call_plan_id IS NOT NULL AND (
          c.provider_call_plan_id IS NULL OR c.record_sha256<>p.provider_call_plan_sha256
          OR c.goal_id<>p.goal_id OR c.run_id<>p.run_id OR c.request_class<>'WORKER'
          OR c.execution_graph_revision_id<>p.execution_graph_revision_id
          OR c.execution_graph_revision_sha256<>p.execution_graph_revision_sha256
          OR c.node_id<>p.node_id OR c.node_spec_sha256<>p.node_spec_sha256
          OR c.packet_id<>p.packet_id OR c.attempt<>p.attempt
          OR c.lease_generation<>p.lease_generation OR c.fencing_token<>p.fencing_token
          OR c.minimum_input_closure_sha256<>p.input_closure_sha256
          OR c.success_output_schema_sha256<>p.output_schema_sha256
          OR c.local_oracle_sha256<>p.oracle_sha256 OR c.privacy_class<>p.privacy_class
          OR c.runtime_fingerprint_sha256<>n.provider_profile_sha256
          OR c.current_pi_config_sha256<>p.config_sha256
          OR p.deadline_ms>c.deadline_at_ms OR p.created_at_ms<c.created_at_ms
        )`)
      : 0;
    const activeUnplannedTaskPackets = tableExists(this.connection, "task_packets_v2")
      ? count(`SELECT count(*) count
        FROM execution_node_heads_v2 h
        JOIN task_packets_v2 p ON p.packet_id=h.latest_packet_id
        WHERE h.status IN ('LEASED','PROPOSAL_SUBMITTED') AND p.provider_call_plan_id IS NULL`)
      : 0;
    const proposalMismatches = count(`SELECT count(*) count FROM worker_proposals_v2 proposal
      WHERE NOT EXISTS (SELECT 1 FROM provider_invocation_transitions_v1 invocation
        JOIN provider_call_plans_v1 plan ON plan.provider_call_plan_id=invocation.provider_call_plan_id
        WHERE invocation.packet_id=proposal.packet_id AND invocation.packet_sha256=proposal.packet_sha256
          AND invocation.ordinal=1 AND invocation.state='SETTLED'
          AND invocation.success_evidence_sha256=proposal.record_sha256
          AND invocation.request_count<=plan.soft_max_requests
          AND invocation.request_count<=plan.transport_request_limit
          AND invocation.input_tokens<=plan.soft_max_input_tokens
          AND invocation.output_tokens<=plan.soft_max_output_tokens
          AND (invocation.cost_microusd IS NULL OR invocation.cost_microusd<=plan.soft_max_cost_microusd)
          AND invocation.wall_time_ms<=plan.soft_max_latency_ms
          AND ((plan.cache_mode='C0' AND invocation.cache_lineage_sha256 IS NULL)
            OR (plan.cache_mode='C1' AND invocation.cache_lineage_sha256=plan.cache_lineage_sha256)))`);
    const outcomeMismatches = count(`SELECT count(*) count FROM execution_node_attempt_outcomes_v2 outcome
      WHERE NOT EXISTS (SELECT 1 FROM provider_invocation_transitions_v1 invocation
        WHERE invocation.packet_id=outcome.packet_id AND invocation.packet_sha256=outcome.packet_sha256
          AND invocation.ordinal=1 AND invocation.state IN ('SETTLED','OUTCOME_UNKNOWN'))`);
    mismatches += packetMismatches + activeUnplannedTaskPackets + proposalMismatches + outcomeMismatches;
    if (mismatches > 0) {
      throw new AuthorityIntegrityError(`Provider Invocation integrity failed with ${mismatches} mismatch(es)`);
    }
    return {
      available: true,
      plans: ids.length,
      plannedTaskPackets,
      activeUnplannedTaskPackets,
      mismatches,
    };
  }
}
