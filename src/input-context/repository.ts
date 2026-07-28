import type { AuthorityConnection } from "../authority/database.js";
import { runImmediateTransaction } from "../authority/database.js";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import {
  assertContextCompileReceipt,
  assertContextEnvelope,
  assertContextLayoutManifest,
  assertContextProjectionReceipt,
  assertContextRetentionRoot,
  assertContextWorkingSet,
  assertEvidenceValidityTransition,
  assertProviderTurnAttempt,
  assertProviderTurnLedger,
  assertProviderTurnRequest,
  assertProjectKnowledgeClaim,
  assertProjectSourceManifest,
  assertReadEvidenceReceipt,
  assertToolSurfacePlan,
  type ContextCompileReceiptRecord,
  type ContextEnvelopeRecord,
  type ContextIrItemRecord,
  type ContextLayoutManifestRecord,
  type ContextProjectionReceiptRecord,
  type ContextRetentionRootRecord,
  type ContextWorkingSetRecord,
  type EvidenceValidityTransitionRecord,
  type ProviderPayloadFinality,
  type ProviderTurnAttemptRecord,
  type ProviderTurnContributionRecord,
  type ProviderTurnLedgerRecord,
  type ProviderTurnRequestRecord,
  type ProjectKnowledgeClaimRecord,
  type ProjectSourceManifestRecord,
  type ReadEvidenceReceiptRecord,
  type ToolSurfacePlanRecord,
} from "./domain.js";
import { inputContextHashDomains } from "./canonical.js";
import type { ExecutionSubjectRef } from "../task-flow/domain.js";

type SqlRow = Record<string, unknown>;

export interface QueryScopeHeadRecord {
  readonly workspace_id: string;
  readonly source_scope_hmac: string;
  readonly receipt_id: string;
  readonly dependency_signature_sha256: string;
  readonly evidence_sha256: string;
  readonly updated_at_ms: number;
  readonly head_sha256: string;
}

export interface WorkingSetEnvelopeRecord {
  readonly workingSet: ContextWorkingSetRecord;
  readonly envelope: ContextEnvelopeRecord;
}

export interface PendingProviderTurnRecord {
  readonly started: ProviderTurnAttemptRecord;
  readonly promptGenerationId: string;
  readonly ledger: ProviderTurnLedgerRecord | null;
}

export interface InputContextIntegritySummary {
  readonly readEvidenceReceipts: number;
  readonly validityTransitions: number;
  readonly workingSets: number;
  readonly compileReceipts: number;
  readonly retentionRoots: number;
  readonly toolSurfacePlans: number;
  readonly layoutManifests: number;
  readonly projectionTransitions: number;
  readonly providerTurnLedgers: number;
  readonly providerTurnAttempts: number;
  readonly queryScopeHeads: number;
  readonly projectSourceManifests: number;
  readonly projectKnowledgeClaims: number;
}

const finalityOrder: Readonly<Record<ProviderPayloadFinality, number>> = {
  PCH_HOOK_INPUT: 0,
  PCH_HOOK_OUTPUT: 1,
  EXTENSION_CHAIN_FINAL: 2,
  WIRE_SERIALIZED: 3,
};

const projectionTransitions: Readonly<Record<ContextProjectionReceiptRecord["projection_state"], ReadonlySet<ContextProjectionReceiptRecord["projection_state"]>>> = {
  PREPARED: new Set(["APPLIED", "ABANDONED"]),
  APPLIED: new Set(["REQUEST_OBSERVED", "OUTCOME_UNKNOWN", "ABANDONED"]),
  REQUEST_OBSERVED: new Set(["COMPLETED"]),
  OUTCOME_UNKNOWN: new Set(["REQUEST_OBSERVED", "COMPLETED", "ABANDONED"]),
  COMPLETED: new Set(),
  ABANDONED: new Set(),
};

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityIntegrityError(`Input Context ${key} is invalid`);
  }
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Input Context ${key} is invalid`);
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AuthorityIntegrityError(`Input Context ${key} is invalid`);
  }
  return value;
}

function nullableInteger(row: SqlRow, key: string): number | null {
  if (row[key] === null) return null;
  return integer(row, key);
}

function boolean(row: SqlRow, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) throw new AuthorityIntegrityError(`Input Context ${key} is invalid`);
  return value === 1;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    const value = JSON.parse(raw) as T;
    if (canonicalJson(value) !== raw) throw new AuthorityIntegrityError(`${label} is not canonical JSON`);
    return value;
  } catch (error) {
    if (error instanceof AuthorityIntegrityError) throw error;
    throw new AuthorityIntegrityError(`${label} is invalid JSON`, error);
  }
}

function stored<T>(label: string, value: T, validator: (candidate: unknown) => void): T {
  try {
    validator(value);
    return value;
  } catch (error) {
    throw new AuthorityIntegrityError(`${label} failed semantic or hash verification`, error);
  }
}

function equalRecords(left: object, right: object): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSameRecord(label: string, storedRecord: object, requestedRecord: object): void {
  if (!equalRecords(storedRecord, requestedRecord)) {
    throw new AuthorityIntegrityError(`${label} identity was reused for different content`);
  }
}

function tableExists(connection: AuthorityConnection, name: string): boolean {
  const row = connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as SqlRow | undefined;
  return Number(row?.count ?? 0) === 1;
}

function atomic<T>(connection: AuthorityConnection, action: () => T): T {
  return connection.isTransaction ? action() : runImmediateTransaction(connection, action);
}

function decodeSubject(row: SqlRow): ExecutionSubjectRef {
  return {
    kind: text(row, "subject_kind") as ExecutionSubjectRef["kind"],
    goalId: nullableText(row, "subject_goal_id"),
    subjectId: nullableText(row, "subject_id"),
    routeRevision: nullableInteger(row, "subject_route_revision"),
    goalContractSha256: nullableText(row, "subject_goal_contract_sha256"),
    executionAuthorizationSha256: nullableText(row, "subject_execution_authorization_sha256"),
    bindingSha256: text(row, "subject_binding_sha256"),
  };
}

function subjectValues(subject: ExecutionSubjectRef): readonly (string | number | null)[] {
  return [
    subject.kind, subject.goalId, subject.subjectId, subject.routeRevision,
    subject.goalContractSha256, subject.executionAuthorizationSha256, subject.bindingSha256,
  ];
}

function decodeReadEvidence(row: SqlRow): ReadEvidenceReceiptRecord {
  const value: ReadEvidenceReceiptRecord = {
    schema_version: 1,
    receipt_id: text(row, "receipt_id"),
    workspace_id: text(row, "workspace_id"),
    subject: decodeSubject(row),
    source_kind: text(row, "source_kind") as ReadEvidenceReceiptRecord["source_kind"],
    capture_kind: text(row, "capture_kind") as ReadEvidenceReceiptRecord["capture_kind"],
    evidence_sha256: text(row, "evidence_sha256"),
    artifact_ref_hmac: nullableText(row, "artifact_ref_hmac"),
    dependency_signature_sha256: text(row, "dependency_signature_sha256"),
    source_scope_hmac: text(row, "source_scope_hmac"),
    source_version_handle_hmac: nullableText(row, "source_version_handle_hmac"),
    query_completeness: text(row, "query_completeness") as ReadEvidenceReceiptRecord["query_completeness"],
    content_freshness: text(row, "content_freshness") as ReadEvidenceReceiptRecord["content_freshness"],
    scope_authorization: text(row, "scope_authorization") as ReadEvidenceReceiptRecord["scope_authorization"],
    semantic_applicability: text(row, "semantic_applicability") as ReadEvidenceReceiptRecord["semantic_applicability"],
    representation_fidelity: text(row, "representation_fidelity") as ReadEvidenceReceiptRecord["representation_fidelity"],
    classification: text(row, "classification") as ReadEvidenceReceiptRecord["classification"],
    adapter_version: text(row, "adapter_version"),
    observed_at_ms: integer(row, "observed_at_ms"),
    receipt_sha256: text(row, "receipt_sha256"),
  };
  return stored(`ReadEvidenceReceipt ${value.receipt_id}`, value, assertReadEvidenceReceipt);
}

function decodeValidityTransition(row: SqlRow): EvidenceValidityTransitionRecord {
  const value: EvidenceValidityTransitionRecord = {
    transition_id: text(row, "transition_id"),
    receipt_id: text(row, "receipt_id"),
    axis: text(row, "axis") as EvidenceValidityTransitionRecord["axis"],
    value: text(row, "value") as EvidenceValidityTransitionRecord["value"],
    reason_code: text(row, "reason_code"),
    evidence_sha256: text(row, "evidence_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    transition_sha256: text(row, "transition_sha256"),
  };
  return stored(`EvidenceValidityTransition ${value.transition_id}`, value, assertEvidenceValidityTransition);
}

function decodeIrItem(row: SqlRow, expectedOrdinal: number): ContextIrItemRecord {
  const ordinal = integer(row, "ordinal");
  if (ordinal !== expectedOrdinal) throw new AuthorityIntegrityError("Context working-set ordinals are not contiguous");
  const obligationIds = parseJson<unknown>(text(row, "obligation_ids_json"), "Context obligation IDs");
  if (!Array.isArray(obligationIds) || obligationIds.some((entry) => typeof entry !== "string")) {
    throw new AuthorityIntegrityError("Context obligation IDs are invalid");
  }
  return {
    candidate_id: text(row, "candidate_id"),
    obligation_ids: obligationIds as string[],
    evidence_sha256: text(row, "evidence_sha256"),
    disposition: text(row, "disposition") as ContextIrItemRecord["disposition"],
    reason_code: text(row, "reason_code"),
    ordinal_class: text(row, "ordinal_class") as ContextIrItemRecord["ordinal_class"],
    content_identity_hmac: text(row, "content_identity_hmac"),
    retained_entry_id: nullableText(row, "retained_entry_id"),
    source_version_handle_hmac: nullableText(row, "source_version_handle_hmac"),
    projected_tokens: integer(row, "projected_tokens"),
  };
}

function decodeWorkingSetEnvelope(connection: AuthorityConnection, row: SqlRow): WorkingSetEnvelopeRecord {
  const workingSetId = text(row, "working_set_id");
  const itemRows = connection.prepare(`SELECT * FROM context_working_set_items_v1
    WHERE working_set_id=? ORDER BY ordinal LIMIT 4097`).all(workingSetId) as SqlRow[];
  if (itemRows.length > 4096) throw new AuthorityIntegrityError(`Context working set ${workingSetId} exceeds its item bound`);
  const items = itemRows.map((item, ordinal) => decodeIrItem(item, ordinal));
  const workingSet: ContextWorkingSetRecord = {
    schema_version: 1,
    working_set_id: workingSetId,
    subject: decodeSubject(row),
    profile: text(row, "profile") as ContextWorkingSetRecord["profile"],
    context_demand_sha256: text(row, "context_demand_sha256"),
    retained_root_sha256: text(row, "retained_root_sha256"),
    source_closure_root_sha256: nullableText(row, "source_closure_root_sha256"),
    acceptance_closure_root_sha256: nullableText(row, "acceptance_closure_root_sha256"),
    items,
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "working_set_sha256"),
  };
  const envelope: ContextEnvelopeRecord = {
    schema_version: 1,
    envelope_id: text(row, "envelope_id"),
    subject: workingSet.subject,
    profile: workingSet.profile,
    prompt_generation_id: nullableText(row, "prompt_generation_id"),
    retained_root_sha256: workingSet.retained_root_sha256,
    source_closure_root_sha256: workingSet.source_closure_root_sha256,
    acceptance_closure_root_sha256: workingSet.acceptance_closure_root_sha256,
    mandatory_coverage_root_sha256: text(row, "mandatory_coverage_root_sha256"),
    context_demand_root_sha256: workingSet.context_demand_sha256,
    items,
    estimated_projected_tokens: integer(row, "estimated_projected_tokens"),
    fit_disposition: text(row, "fit_disposition") as ContextEnvelopeRecord["fit_disposition"],
    record_sha256: text(row, "envelope_sha256"),
  };
  stored(`ContextWorkingSet ${workingSetId}`, workingSet, assertContextWorkingSet);
  stored(`ContextEnvelope ${envelope.envelope_id}`, envelope, assertContextEnvelope);
  return { workingSet, envelope };
}

function assertWorkingSetEnvelopeBinding(workingSet: ContextWorkingSetRecord, envelope: ContextEnvelopeRecord): void {
  assertContextWorkingSet(workingSet);
  assertContextEnvelope(envelope);
  const workingSetBinding = {
    subject: workingSet.subject,
    profile: workingSet.profile,
    retained_root_sha256: workingSet.retained_root_sha256,
    source_closure_root_sha256: workingSet.source_closure_root_sha256,
    acceptance_closure_root_sha256: workingSet.acceptance_closure_root_sha256,
    items: workingSet.items,
  };
  const envelopeBinding = {
    subject: envelope.subject,
    profile: envelope.profile,
    retained_root_sha256: envelope.retained_root_sha256,
    source_closure_root_sha256: envelope.source_closure_root_sha256,
    acceptance_closure_root_sha256: envelope.acceptance_closure_root_sha256,
    items: envelope.items,
  };
  if (!equalRecords(workingSetBinding, envelopeBinding)
    || workingSet.context_demand_sha256 !== envelope.context_demand_root_sha256) {
    throw new TypeError("ContextWorkingSet and ContextEnvelope do not share one frozen input closure");
  }
}

function decodeCompileReceipt(row: SqlRow): ContextCompileReceiptRecord {
  const value: ContextCompileReceiptRecord = {
    schema_version: 1,
    compile_receipt_id: text(row, "compile_receipt_id"),
    working_set_id: text(row, "working_set_id"),
    envelope_sha256: text(row, "envelope_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    mandatory_obligation_count: integer(row, "mandatory_obligation_count"),
    mandatory_covered_count: integer(row, "mandatory_covered_count"),
    discovery_debt_count: integer(row, "discovery_debt_count"),
    omitted_optional_count: integer(row, "omitted_optional_count"),
    fallback: text(row, "fallback") as ContextCompileReceiptRecord["fallback"],
    duration_micros: integer(row, "duration_micros"),
    created_at_ms: integer(row, "created_at_ms"),
    receipt_sha256: text(row, "receipt_sha256"),
  };
  return stored(`ContextCompileReceipt ${value.compile_receipt_id}`, value, assertContextCompileReceipt);
}

function decodeRetentionRoot(row: SqlRow): ContextRetentionRootRecord {
  const value: ContextRetentionRootRecord = {
    retention_root_id: text(row, "retention_root_id"),
    workspace_id: text(row, "workspace_id"),
    subject: decodeSubject(row),
    artifact_sha256: text(row, "artifact_sha256"),
    retention_class: text(row, "retention_class") as ContextRetentionRootRecord["retention_class"],
    expires_at_ms: nullableInteger(row, "expires_at_ms"),
    created_at_ms: integer(row, "created_at_ms"),
    root_sha256: text(row, "root_sha256"),
  };
  return stored(`ContextRetentionRoot ${value.retention_root_id}`, value, assertContextRetentionRoot);
}

function decodeToolSurfacePlan(row: SqlRow): ToolSurfacePlanRecord {
  const value: ToolSurfacePlanRecord = {
    schema_version: 1,
    tool_surface_plan_id: text(row, "tool_surface_plan_id"),
    context_envelope_sha256: text(row, "context_envelope_sha256"),
    strategy: text(row, "strategy") as ToolSurfacePlanRecord["strategy"],
    user_tool_configuration_sha256: text(row, "user_tool_configuration_sha256"),
    active_tool_manifest_sha256: text(row, "active_tool_manifest_sha256"),
    deferred_tool_manifest_sha256: nullableText(row, "deferred_tool_manifest_sha256"),
    capability_epoch_sha256: text(row, "capability_epoch_sha256"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ToolSurfacePlan ${value.tool_surface_plan_id}`, value, assertToolSurfacePlan);
}

function decodeLayoutManifest(row: SqlRow): ContextLayoutManifestRecord {
  const entries = parseJson<ContextLayoutManifestRecord["entries"]>(text(row, "entries_json"), "Context layout entries");
  const value: ContextLayoutManifestRecord = {
    schema_version: 1,
    layout_manifest_id: text(row, "layout_manifest_id"),
    context_envelope_sha256: text(row, "context_envelope_sha256"),
    prompt_generation_id: nullableText(row, "prompt_generation_id"),
    ordered_segment_root_sha256: text(row, "ordered_segment_root_sha256"),
    segment_count: integer(row, "segment_count"),
    entries,
    canonical_encoder_version: text(row, "canonical_encoder_version"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ContextLayoutManifest ${value.layout_manifest_id}`, value, assertContextLayoutManifest);
}

function decodeProjectionReceipt(row: SqlRow): ContextProjectionReceiptRecord {
  const value: ContextProjectionReceiptRecord = {
    schema_version: 1,
    projection_id: text(row, "projection_id"),
    transition_ordinal: integer(row, "transition_ordinal"),
    context_envelope_sha256: text(row, "context_envelope_sha256"),
    tool_surface_plan_sha256: text(row, "tool_surface_plan_sha256"),
    layout_manifest_sha256: text(row, "layout_manifest_sha256"),
    retained_root_sha256: text(row, "retained_root_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    subject: decodeSubject(row),
    prompt_generation_id: nullableText(row, "prompt_generation_id"),
    projection_state: text(row, "projection_state") as ContextProjectionReceiptRecord["projection_state"],
    idempotency_key_hmac: text(row, "idempotency_key_hmac"),
    finality: text(row, "finality") as ProviderPayloadFinality,
    created_at_ms: integer(row, "created_at_ms"),
    receipt_sha256: text(row, "receipt_sha256"),
  };
  return stored(`ContextProjectionReceipt ${value.projection_id}:${value.transition_ordinal}`, value, assertContextProjectionReceipt);
}

function decodeProjectSourceManifest(row: SqlRow): ProjectSourceManifestRecord {
  const value: ProjectSourceManifestRecord = {
    schema_version: 1,
    manifest_id: text(row, "manifest_id"),
    workspace_id: text(row, "workspace_id"),
    subject: decodeSubject(row),
    entries: parseJson<ProjectSourceManifestRecord["entries"]>(text(row, "entries_json"), "ProjectSourceManifest entries"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ProjectSourceManifest ${value.manifest_id}`, value, assertProjectSourceManifest);
}

function decodeProjectKnowledgeClaim(row: SqlRow): ProjectKnowledgeClaimRecord {
  const value: ProjectKnowledgeClaimRecord = {
    schema_version: 1,
    claim_id: text(row, "claim_id"),
    manifest_id: text(row, "manifest_id"),
    source_id: text(row, "source_id"),
    subject: decodeSubject(row),
    semantic_key: text(row, "semantic_key"),
    statement_sha256: text(row, "statement_sha256"),
    source_range_sha256: text(row, "source_range_sha256"),
    evidence_sha256: text(row, "evidence_sha256"),
    trust: text(row, "trust") as ProjectKnowledgeClaimRecord["trust"],
    content_freshness: text(row, "content_freshness") as ProjectKnowledgeClaimRecord["content_freshness"],
    scope_authorization: text(row, "scope_authorization") as ProjectKnowledgeClaimRecord["scope_authorization"],
    semantic_applicability: text(row, "semantic_applicability") as ProjectKnowledgeClaimRecord["semantic_applicability"],
    representation_fidelity: text(row, "representation_fidelity") as ProjectKnowledgeClaimRecord["representation_fidelity"],
    authority_status: text(row, "authority_status") as ProjectKnowledgeClaimRecord["authority_status"],
    frozen_goal_contract_sha256: nullableText(row, "frozen_goal_contract_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ProjectKnowledgeClaim ${value.claim_id}`, value, assertProjectKnowledgeClaim);
}

export function providerTurnContributionSha256(promptRequestId: string, ordinal: number, contribution: ProviderTurnContributionRecord): string {
  return canonicalJsonSha256({
    domain: inputContextHashDomains.providerTurnContribution,
    prompt_request_id: promptRequestId,
    ordinal,
    contribution,
  });
}

function decodeContribution(row: SqlRow, promptRequestId: string, expectedOrdinal: number): ProviderTurnContributionRecord {
  const ordinal = integer(row, "ordinal");
  if (ordinal !== expectedOrdinal) throw new AuthorityIntegrityError("Provider-turn contribution ordinals are not contiguous");
  const contribution: ProviderTurnContributionRecord = {
    contribution_id: text(row, "contribution_id"),
    owner: text(row, "owner") as ProviderTurnContributionRecord["owner"],
    input_surface: nullableText(row, "input_surface") as ProviderTurnContributionRecord["input_surface"],
    output_surface: nullableText(row, "output_surface") as ProviderTurnContributionRecord["output_surface"],
    segment_identity_hmac: nullableText(row, "segment_identity_hmac"),
    logical_bytes: nullableInteger(row, "logical_bytes"),
    tokens: nullableInteger(row, "tokens"),
    evidence: text(row, "evidence") as ProviderTurnContributionRecord["evidence"],
    included: boolean(row, "included"),
    duplicate_of: nullableText(row, "duplicate_of"),
  };
  if (text(row, "contribution_sha256") !== providerTurnContributionSha256(promptRequestId, ordinal, contribution)) {
    throw new AuthorityIntegrityError(`Provider-turn contribution ${contribution.contribution_id} failed hash verification`);
  }
  return contribution;
}

function decodeProviderTurnLedger(connection: AuthorityConnection, row: SqlRow): ProviderTurnLedgerRecord {
  const promptRequestId = text(row, "prompt_request_id");
  const contributionRows = connection.prepare(`SELECT * FROM provider_turn_contributions_v2
    WHERE prompt_request_id=? ORDER BY ordinal LIMIT 257`).all(promptRequestId) as SqlRow[];
  if (contributionRows.length > 256) throw new AuthorityIntegrityError(`ProviderTurnLedger ${promptRequestId} exceeds its contribution bound`);
  const contributions = contributionRows.map((entry, ordinal) => decodeContribution(entry, promptRequestId, ordinal));
  const value: ProviderTurnLedgerRecord = {
    schema_version: 1,
    prompt_request_id: promptRequestId,
    prompt_generation_id: nullableText(row, "prompt_generation_id"),
    context_envelope_sha256: nullableText(row, "context_envelope_sha256"),
    layout_manifest_sha256: nullableText(row, "layout_manifest_sha256"),
    contributions,
    provider_uncached_input_tokens: nullableInteger(row, "provider_uncached_input_tokens"),
    provider_cache_read_tokens: nullableInteger(row, "provider_cache_read_tokens"),
    provider_cache_write_tokens: nullableInteger(row, "provider_cache_write_tokens"),
    provider_generated_output_tokens: nullableInteger(row, "provider_generated_output_tokens"),
    provider_reasoning_tokens: nullableInteger(row, "provider_reasoning_tokens"),
    attributed_input_tokens: nullableInteger(row, "attributed_input_tokens"),
    unattributed_input_tokens: nullableInteger(row, "unattributed_input_tokens"),
    attributed_output_tokens: nullableInteger(row, "attributed_output_tokens"),
    unattributed_output_tokens: nullableInteger(row, "unattributed_output_tokens"),
    accounting_completeness: text(row, "accounting_completeness") as ProviderTurnLedgerRecord["accounting_completeness"],
    additional_model_requests: integer(row, "additional_model_requests") as 0,
    additional_provider_requests: integer(row, "additional_provider_requests") as 0,
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ProviderTurnLedger ${promptRequestId}`, value, assertProviderTurnLedger);
}

function decodeProviderTurnAttempt(row: SqlRow): ProviderTurnAttemptRecord {
  const value: ProviderTurnAttemptRecord = {
    schema_version: 1,
    attempt_id: text(row, "attempt_id"),
    prompt_request_id: text(row, "prompt_request_id"),
    attempt_number: integer(row, "attempt_number"),
    transition_ordinal: integer(row, "transition_ordinal"),
    request_identity_hmac: text(row, "request_identity_hmac"),
    payload_identity_hmac: nullableText(row, "payload_identity_hmac"),
    payload_finality: text(row, "payload_finality") as ProviderPayloadFinality,
    started_at_ms: integer(row, "started_at_ms"),
    completed_at_ms: nullableInteger(row, "completed_at_ms"),
    response_status: nullableInteger(row, "response_status"),
    outcome: text(row, "outcome") as ProviderTurnAttemptRecord["outcome"],
    usage_contribution_sha256: nullableText(row, "usage_contribution_sha256"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ProviderTurnAttempt ${value.attempt_id}:${value.transition_ordinal}`, value, assertProviderTurnAttempt);
}

function decodeProviderTurnRequest(row: SqlRow): ProviderTurnRequestRecord {
  const value: ProviderTurnRequestRecord = {
    schema_version: 1,
    prompt_request_id: text(row, "prompt_request_id"),
    prompt_generation_id: text(row, "prompt_generation_id"),
    previous_prompt_request_id: nullableText(row, "previous_prompt_request_id"),
    request_sequence: integer(row, "request_sequence"),
    logical_request_hmac_sha256: text(row, "logical_request_hmac_sha256"),
    payload_shape_sha256: text(row, "payload_shape_sha256"),
    message_descriptor_root_sha256: text(row, "message_descriptor_root_sha256"),
    message_count: integer(row, "message_count"),
    logical_message_bytes: integer(row, "logical_message_bytes"),
    user_history_bytes: integer(row, "user_history_bytes"),
    assistant_history_bytes: integer(row, "assistant_history_bytes"),
    other_history_bytes: integer(row, "other_history_bytes"),
    tool_schema_bytes: integer(row, "tool_schema_bytes"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  return stored(`ProviderTurnRequest ${value.prompt_request_id}`, value, assertProviderTurnRequest);
}

function queryScopeHeadSha256(record: Omit<QueryScopeHeadRecord, "head_sha256">): string {
  return canonicalJsonSha256({ domain: inputContextHashDomains.queryScopeHead, record });
}

function decodeQueryScopeHead(row: SqlRow): QueryScopeHeadRecord {
  const base: Omit<QueryScopeHeadRecord, "head_sha256"> = {
    workspace_id: text(row, "workspace_id"),
    source_scope_hmac: text(row, "source_scope_hmac"),
    receipt_id: text(row, "receipt_id"),
    dependency_signature_sha256: text(row, "dependency_signature_sha256"),
    evidence_sha256: text(row, "evidence_sha256"),
    updated_at_ms: integer(row, "updated_at_ms"),
  };
  const head_sha256 = text(row, "head_sha256");
  if (head_sha256 !== queryScopeHeadSha256(base)) {
    throw new AuthorityIntegrityError(`Query-scope head ${base.workspace_id}:${base.source_scope_hmac} failed hash verification`);
  }
  return { ...base, head_sha256 };
}

function validatePageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 4096) {
    throw new RangeError("Input Context integrity page size must be between 1 and 4096");
  }
}

export class InputContextRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "read_evidence_receipts_v1")
      && tableExists(this.connection, "provider_turn_ledgers_v1");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Input Context migration 012 is not available");
  }

  private providerTurnsAvailable(): boolean {
    return tableExists(this.connection, "input_context_prompt_requests_v2")
      && tableExists(this.connection, "provider_turn_ledgers_v2");
  }

  private assertProviderTurnsAvailable(): void {
    if (!this.providerTurnsAvailable()) {
      throw new AuthorityIntegrityError("Input Context provider-turn migration 016 is not available");
    }
  }

  insertReadEvidenceReceipt(receipt: ReadEvidenceReceiptRecord): { readonly reused: boolean; readonly record: ReadEvidenceReceiptRecord } {
    assertReadEvidenceReceipt(receipt);
    this.assertAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM read_evidence_receipts_v1 WHERE receipt_id=?")
        .get(receipt.receipt_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeReadEvidence(existing);
        assertSameRecord(`ReadEvidenceReceipt ${receipt.receipt_id}`, decoded, receipt);
        return { reused: true, record: decoded };
      }
      this.connection.prepare(`INSERT INTO read_evidence_receipts_v1(
        receipt_id,workspace_id,subject_kind,subject_goal_id,subject_id,subject_route_revision,
        subject_goal_contract_sha256,subject_execution_authorization_sha256,subject_binding_sha256,
        source_kind,capture_kind,evidence_sha256,artifact_ref_hmac,
        dependency_signature_sha256,source_scope_hmac,source_version_handle_hmac,query_completeness,
        content_freshness,scope_authorization,semantic_applicability,representation_fidelity,classification,
        adapter_version,observed_at_ms,receipt_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.receipt_id, receipt.workspace_id, ...subjectValues(receipt.subject), receipt.source_kind,
        receipt.capture_kind, receipt.evidence_sha256, receipt.artifact_ref_hmac,
        receipt.dependency_signature_sha256, receipt.source_scope_hmac, receipt.source_version_handle_hmac,
        receipt.query_completeness, receipt.content_freshness, receipt.scope_authorization,
        receipt.semantic_applicability, receipt.representation_fidelity, receipt.classification,
        receipt.adapter_version, receipt.observed_at_ms, receipt.receipt_sha256,
      );
      if (receipt.source_kind === "QUERY" && receipt.query_completeness === "COMPLETE") {
        this.rebuildQueryScope(receipt.workspace_id, receipt.source_scope_hmac);
      }
      return { reused: false, record: receipt };
    });
  }

  readEvidenceReceipt(receiptId: string): ReadEvidenceReceiptRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM read_evidence_receipts_v1 WHERE receipt_id=?")
      .get(receiptId) as SqlRow | undefined;
    return row ? decodeReadEvidence(row) : null;
  }

  appendEvidenceValidityTransition(transition: EvidenceValidityTransitionRecord): { readonly reused: boolean; readonly record: EvidenceValidityTransitionRecord } {
    assertEvidenceValidityTransition(transition);
    this.assertAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM evidence_validity_transitions_v1 WHERE transition_id=?")
        .get(transition.transition_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeValidityTransition(existing);
        assertSameRecord(`EvidenceValidityTransition ${transition.transition_id}`, decoded, transition);
        return { reused: true, record: decoded };
      }
      const receipt = this.readEvidenceReceipt(transition.receipt_id);
      if (!receipt) throw new TypeError(`Evidence receipt ${transition.receipt_id} does not exist`);
      this.connection.prepare(`INSERT INTO evidence_validity_transitions_v1(
        transition_id,receipt_id,axis,value,reason_code,evidence_sha256,created_at_ms,transition_sha256
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        transition.transition_id, transition.receipt_id, transition.axis, transition.value,
        transition.reason_code, transition.evidence_sha256, transition.created_at_ms, transition.transition_sha256,
      );
      if (receipt.source_kind === "QUERY" && receipt.query_completeness === "COMPLETE") {
        this.rebuildQueryScope(receipt.workspace_id, receipt.source_scope_hmac);
      }
      return { reused: false, record: transition };
    });
  }

  readEvidenceValidityTransitions(receiptId: string, limit = 128): EvidenceValidityTransitionRecord[] {
    this.assertAvailable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new RangeError("Evidence validity transition limit is invalid");
    const rows = this.connection.prepare(`SELECT * FROM evidence_validity_transitions_v1
      WHERE receipt_id=? ORDER BY created_at_ms,transition_id LIMIT ?`).all(receiptId, limit + 1) as SqlRow[];
    if (rows.length > limit) throw new AuthorityIntegrityError("Evidence validity transition read exceeded its declared bound");
    return rows.map(decodeValidityTransition);
  }

  readQueryScopeHead(workspaceId: string, sourceScopeHmac: string): QueryScopeHeadRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT * FROM context_query_scope_heads_v1
      WHERE workspace_id=? AND source_scope_hmac=?`).get(workspaceId, sourceScopeHmac) as SqlRow | undefined;
    return row ? decodeQueryScopeHead(row) : null;
  }

  storeWorkingSetEnvelope(
    workingSet: ContextWorkingSetRecord,
    envelope: ContextEnvelopeRecord,
  ): { readonly reused: boolean; readonly record: WorkingSetEnvelopeRecord } {
    assertWorkingSetEnvelopeBinding(workingSet, envelope);
    this.assertAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM context_working_sets_v1 WHERE working_set_id=?")
        .get(workingSet.working_set_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeWorkingSetEnvelope(this.connection, existing);
        assertSameRecord(`ContextWorkingSet ${workingSet.working_set_id}`, decoded.workingSet, workingSet);
        assertSameRecord(`ContextEnvelope ${envelope.envelope_id}`, decoded.envelope, envelope);
        return { reused: true, record: decoded };
      }
      this.connection.prepare(`INSERT INTO context_working_sets_v1(
        working_set_id,envelope_id,subject_kind,subject_goal_id,subject_id,subject_route_revision,
        subject_goal_contract_sha256,subject_execution_authorization_sha256,subject_binding_sha256,
        profile,prompt_generation_id,context_demand_sha256,
        retained_root_sha256,source_closure_root_sha256,acceptance_closure_root_sha256,
        mandatory_coverage_root_sha256,estimated_projected_tokens,fit_disposition,
        working_set_sha256,envelope_sha256,created_at_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workingSet.working_set_id, envelope.envelope_id, ...subjectValues(workingSet.subject),
        workingSet.profile, envelope.prompt_generation_id, workingSet.context_demand_sha256,
        workingSet.retained_root_sha256, workingSet.source_closure_root_sha256,
        workingSet.acceptance_closure_root_sha256, envelope.mandatory_coverage_root_sha256,
        envelope.estimated_projected_tokens, envelope.fit_disposition,
        workingSet.record_sha256, envelope.record_sha256,
        workingSet.created_at_ms,
      );
      const statement = this.connection.prepare(`INSERT INTO context_working_set_items_v1(
        working_set_id,ordinal,candidate_id,obligation_ids_json,evidence_sha256,disposition,reason_code,
        ordinal_class,content_identity_hmac,retained_entry_id,source_version_handle_hmac,projected_tokens
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      workingSet.items.forEach((item, ordinal) => statement.run(
        workingSet.working_set_id, ordinal, item.candidate_id, canonicalJson(item.obligation_ids),
        item.evidence_sha256, item.disposition, item.reason_code, item.ordinal_class,
        item.content_identity_hmac, item.retained_entry_id, item.source_version_handle_hmac,
        item.projected_tokens,
      ));
      return { reused: false, record: { workingSet, envelope } };
    });
  }

  readWorkingSetEnvelope(workingSetId: string): WorkingSetEnvelopeRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM context_working_sets_v1 WHERE working_set_id=?")
      .get(workingSetId) as SqlRow | undefined;
    return row ? decodeWorkingSetEnvelope(this.connection, row) : null;
  }

  readEnvelope(envelopeSha256: string): ContextEnvelopeRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM context_working_sets_v1 WHERE envelope_sha256=?")
      .get(envelopeSha256) as SqlRow | undefined;
    return row ? decodeWorkingSetEnvelope(this.connection, row).envelope : null;
  }

  insertCompileReceipt(receipt: ContextCompileReceiptRecord): { readonly reused: boolean; readonly record: ContextCompileReceiptRecord } {
    assertContextCompileReceipt(receipt);
    this.assertAvailable();
    const existing = this.connection.prepare("SELECT * FROM context_compile_receipts_v1 WHERE compile_receipt_id=?")
      .get(receipt.compile_receipt_id) as SqlRow | undefined;
    if (existing) {
      const decoded = decodeCompileReceipt(existing);
      assertSameRecord(`ContextCompileReceipt ${receipt.compile_receipt_id}`, decoded, receipt);
      return { reused: true, record: decoded };
    }
    this.connection.prepare(`INSERT INTO context_compile_receipts_v1(
      compile_receipt_id,working_set_id,envelope_sha256,input_closure_sha256,mandatory_obligation_count,
      mandatory_covered_count,discovery_debt_count,omitted_optional_count,fallback,duration_micros,
      created_at_ms,receipt_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.compile_receipt_id, receipt.working_set_id, receipt.envelope_sha256,
      receipt.input_closure_sha256, receipt.mandatory_obligation_count, receipt.mandatory_covered_count,
      receipt.discovery_debt_count, receipt.omitted_optional_count, receipt.fallback,
      receipt.duration_micros, receipt.created_at_ms, receipt.receipt_sha256,
    );
    return { reused: false, record: receipt };
  }

  insertRetentionRoot(root: ContextRetentionRootRecord): { readonly reused: boolean; readonly record: ContextRetentionRootRecord } {
    assertContextRetentionRoot(root);
    this.assertAvailable();
    const existing = this.connection.prepare("SELECT * FROM context_retention_roots_v1 WHERE retention_root_id=?")
      .get(root.retention_root_id) as SqlRow | undefined;
    if (existing) {
      const decoded = decodeRetentionRoot(existing);
      assertSameRecord(`ContextRetentionRoot ${root.retention_root_id}`, decoded, root);
      return { reused: true, record: decoded };
    }
    this.connection.prepare(`INSERT INTO context_retention_roots_v1(
      retention_root_id,workspace_id,subject_kind,subject_goal_id,subject_id,subject_route_revision,
      subject_goal_contract_sha256,subject_execution_authorization_sha256,subject_binding_sha256,
      artifact_sha256,retention_class,expires_at_ms,created_at_ms,root_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      root.retention_root_id, root.workspace_id, ...subjectValues(root.subject), root.artifact_sha256,
      root.retention_class, root.expires_at_ms, root.created_at_ms, root.root_sha256,
    );
    return { reused: false, record: root };
  }

  insertProjectSourceManifest(manifest: ProjectSourceManifestRecord): { readonly reused: boolean; readonly record: ProjectSourceManifestRecord } {
    assertProjectSourceManifest(manifest);
    this.assertAvailable();
    const existing = this.connection.prepare("SELECT * FROM project_source_manifests_v1 WHERE manifest_id=?")
      .get(manifest.manifest_id) as SqlRow | undefined;
    if (existing) {
      const decoded = decodeProjectSourceManifest(existing);
      assertSameRecord(`ProjectSourceManifest ${manifest.manifest_id}`, decoded, manifest);
      return { reused: true, record: decoded };
    }
    this.connection.prepare(`INSERT INTO project_source_manifests_v1(
      manifest_id,workspace_id,subject_kind,subject_goal_id,subject_id,subject_route_revision,
      subject_goal_contract_sha256,subject_execution_authorization_sha256,subject_binding_sha256,
      entries_json,created_at_ms,record_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      manifest.manifest_id, manifest.workspace_id, ...subjectValues(manifest.subject),
      canonicalJson(manifest.entries), manifest.created_at_ms, manifest.record_sha256,
    );
    return { reused: false, record: manifest };
  }

  readProjectSourceManifest(manifestId: string): ProjectSourceManifestRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM project_source_manifests_v1 WHERE manifest_id=?")
      .get(manifestId) as SqlRow | undefined;
    return row ? decodeProjectSourceManifest(row) : null;
  }

  insertProjectKnowledgeClaim(claim: ProjectKnowledgeClaimRecord): { readonly reused: boolean; readonly record: ProjectKnowledgeClaimRecord } {
    assertProjectKnowledgeClaim(claim);
    this.assertAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM project_knowledge_claims_v1 WHERE claim_id=?")
        .get(claim.claim_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeProjectKnowledgeClaim(existing);
        assertSameRecord(`ProjectKnowledgeClaim ${claim.claim_id}`, decoded, claim);
        return { reused: true, record: decoded };
      }
      const manifest = this.readProjectSourceManifest(claim.manifest_id);
      if (!manifest) throw new TypeError(`Project source manifest ${claim.manifest_id} does not exist`);
      if (!equalRecords(manifest.subject, claim.subject)) throw new TypeError("Project knowledge claim subject does not match its manifest");
      if (!manifest.entries.some((entry) => entry.source_id === claim.source_id)) throw new TypeError("Project knowledge claim source is absent from its manifest");
      this.connection.prepare(`INSERT INTO project_knowledge_claims_v1(
        claim_id,manifest_id,source_id,subject_kind,subject_goal_id,subject_id,subject_route_revision,
        subject_goal_contract_sha256,subject_execution_authorization_sha256,subject_binding_sha256,
        semantic_key,statement_sha256,source_range_sha256,evidence_sha256,trust,content_freshness,
        scope_authorization,semantic_applicability,representation_fidelity,authority_status,
        frozen_goal_contract_sha256,created_at_ms,record_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        claim.claim_id, claim.manifest_id, claim.source_id, ...subjectValues(claim.subject),
        claim.semantic_key, claim.statement_sha256, claim.source_range_sha256, claim.evidence_sha256,
        claim.trust, claim.content_freshness, claim.scope_authorization, claim.semantic_applicability,
        claim.representation_fidelity, claim.authority_status, claim.frozen_goal_contract_sha256,
        claim.created_at_ms, claim.record_sha256,
      );
      return { reused: false, record: claim };
    });
  }

  readProjectKnowledgeClaims(manifestId: string, limit = 256): ProjectKnowledgeClaimRecord[] {
    this.assertAvailable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new RangeError("Project knowledge claim limit is invalid");
    const rows = this.connection.prepare(`SELECT * FROM project_knowledge_claims_v1
      WHERE manifest_id=? ORDER BY claim_id LIMIT ?`).all(manifestId, limit + 1) as SqlRow[];
    if (rows.length > limit) throw new AuthorityIntegrityError("Project knowledge claim read exceeded its declared bound");
    return rows.map(decodeProjectKnowledgeClaim);
  }

  insertToolSurfacePlan(plan: ToolSurfacePlanRecord): { readonly reused: boolean; readonly record: ToolSurfacePlanRecord } {
    assertToolSurfacePlan(plan);
    this.assertAvailable();
    const existing = this.connection.prepare("SELECT * FROM context_tool_surface_plans_v1 WHERE tool_surface_plan_id=?")
      .get(plan.tool_surface_plan_id) as SqlRow | undefined;
    if (existing) {
      const decoded = decodeToolSurfacePlan(existing);
      assertSameRecord(`ToolSurfacePlan ${plan.tool_surface_plan_id}`, decoded, plan);
      return { reused: true, record: decoded };
    }
    this.connection.prepare(`INSERT INTO context_tool_surface_plans_v1(
      tool_surface_plan_id,context_envelope_sha256,strategy,user_tool_configuration_sha256,
      active_tool_manifest_sha256,deferred_tool_manifest_sha256,capability_epoch_sha256,record_sha256
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      plan.tool_surface_plan_id, plan.context_envelope_sha256, plan.strategy,
      plan.user_tool_configuration_sha256, plan.active_tool_manifest_sha256,
      plan.deferred_tool_manifest_sha256, plan.capability_epoch_sha256, plan.record_sha256,
    );
    return { reused: false, record: plan };
  }

  insertLayoutManifest(manifest: ContextLayoutManifestRecord): { readonly reused: boolean; readonly record: ContextLayoutManifestRecord } {
    assertContextLayoutManifest(manifest);
    this.assertAvailable();
    const existing = this.connection.prepare("SELECT * FROM context_layout_manifests_v1 WHERE layout_manifest_id=?")
      .get(manifest.layout_manifest_id) as SqlRow | undefined;
    if (existing) {
      const decoded = decodeLayoutManifest(existing);
      assertSameRecord(`ContextLayoutManifest ${manifest.layout_manifest_id}`, decoded, manifest);
      return { reused: true, record: decoded };
    }
    this.connection.prepare(`INSERT INTO context_layout_manifests_v1(
      layout_manifest_id,context_envelope_sha256,prompt_generation_id,ordered_segment_root_sha256,
      segment_count,entries_json,canonical_encoder_version,record_sha256
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      manifest.layout_manifest_id, manifest.context_envelope_sha256, manifest.prompt_generation_id,
      manifest.ordered_segment_root_sha256, manifest.segment_count, canonicalJson(manifest.entries),
      manifest.canonical_encoder_version, manifest.record_sha256,
    );
    return { reused: false, record: manifest };
  }

  appendProjectionTransition(receipt: ContextProjectionReceiptRecord): { readonly reused: boolean; readonly record: ContextProjectionReceiptRecord } {
    assertContextProjectionReceipt(receipt);
    this.assertAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare(`SELECT * FROM context_projection_receipts_v1
        WHERE projection_id=? AND transition_ordinal=?`).get(receipt.projection_id, receipt.transition_ordinal) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeProjectionReceipt(existing);
        assertSameRecord(`ContextProjectionReceipt ${receipt.projection_id}:${receipt.transition_ordinal}`, decoded, receipt);
        return { reused: true, record: decoded };
      }
      const idempotencyOwner = this.connection.prepare(`SELECT projection_id FROM context_projection_receipts_v1
        WHERE idempotency_key_hmac=? LIMIT 1`).get(receipt.idempotency_key_hmac) as SqlRow | undefined;
      if (idempotencyOwner && text(idempotencyOwner, "projection_id") !== receipt.projection_id) {
        throw new AuthorityIntegrityError("Projection idempotency identity is already bound to another projection");
      }
      if (receipt.transition_ordinal > 0) {
        const priorRow = this.connection.prepare(`SELECT * FROM context_projection_receipts_v1
          WHERE projection_id=? AND transition_ordinal=?`).get(receipt.projection_id, receipt.transition_ordinal - 1) as SqlRow | undefined;
        if (!priorRow) throw new AuthorityIntegrityError("Projection transition sequence contains a gap");
        const prior = decodeProjectionReceipt(priorRow);
        if (!projectionTransitions[prior.projection_state].has(receipt.projection_state)) {
          throw new AuthorityIntegrityError(`Invalid projection transition ${prior.projection_state} -> ${receipt.projection_state}`);
        }
        for (const key of [
          "context_envelope_sha256", "tool_surface_plan_sha256", "layout_manifest_sha256",
          "retained_root_sha256", "runtime_fingerprint_sha256",
          "prompt_generation_id", "idempotency_key_hmac",
        ] as const) {
          if (prior[key] !== receipt[key]) throw new AuthorityIntegrityError(`Projection binding ${key} changed across transitions`);
        }
        if (!equalRecords(prior.subject, receipt.subject)) throw new AuthorityIntegrityError("Projection subject changed across transitions");
        if (receipt.created_at_ms < prior.created_at_ms
          || finalityOrder[receipt.finality] < finalityOrder[prior.finality]) {
          throw new AuthorityIntegrityError("Projection time/finality regressed across transitions");
        }
      }
      this.connection.prepare(`INSERT INTO context_projection_receipts_v1(
        projection_id,transition_ordinal,context_envelope_sha256,tool_surface_plan_sha256,
        layout_manifest_sha256,retained_root_sha256,runtime_fingerprint_sha256,
        subject_kind,subject_goal_id,subject_id,subject_route_revision,subject_goal_contract_sha256,
        subject_execution_authorization_sha256,subject_binding_sha256,
        prompt_generation_id,projection_state,idempotency_key_hmac,finality,created_at_ms,receipt_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.projection_id, receipt.transition_ordinal, receipt.context_envelope_sha256,
        receipt.tool_surface_plan_sha256, receipt.layout_manifest_sha256, receipt.retained_root_sha256,
        receipt.runtime_fingerprint_sha256, ...subjectValues(receipt.subject), receipt.prompt_generation_id,
        receipt.projection_state, receipt.idempotency_key_hmac, receipt.finality,
        receipt.created_at_ms, receipt.receipt_sha256,
      );
      return { reused: false, record: receipt };
    });
  }

  latestProjection(projectionId: string): ContextProjectionReceiptRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT * FROM context_projection_receipts_v1
      WHERE projection_id=? ORDER BY transition_ordinal DESC LIMIT 1`).get(projectionId) as SqlRow | undefined;
    return row ? decodeProjectionReceipt(row) : null;
  }

  insertProviderTurnRequest(request: ProviderTurnRequestRecord): { readonly reused: boolean; readonly record: ProviderTurnRequestRecord } {
    assertProviderTurnRequest(request);
    this.assertProviderTurnsAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM input_context_prompt_requests_v2 WHERE prompt_request_id=?")
        .get(request.prompt_request_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeProviderTurnRequest(existing);
        assertSameRecord(`ProviderTurnRequest ${request.prompt_request_id}`, decoded, request);
        return { reused: true, record: decoded };
      }
      const latest = this.readLatestProviderTurnRequest(request.prompt_generation_id);
      if ((latest === null && (request.request_sequence !== 0 || request.previous_prompt_request_id !== null))
        || (latest !== null && (request.request_sequence !== latest.request_sequence + 1
          || request.previous_prompt_request_id !== latest.prompt_request_id))) {
        throw new AuthorityIntegrityError("Provider-turn request lineage is not append-only");
      }
      this.connection.prepare(`INSERT INTO input_context_prompt_requests_v2(
        prompt_request_id,prompt_generation_id,previous_prompt_request_id,request_sequence,
        logical_request_hmac_sha256,payload_shape_sha256,message_descriptor_root_sha256,
        message_count,logical_message_bytes,user_history_bytes,assistant_history_bytes,other_history_bytes,
        tool_schema_bytes,created_at_ms,record_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        request.prompt_request_id, request.prompt_generation_id, request.previous_prompt_request_id,
        request.request_sequence, request.logical_request_hmac_sha256, request.payload_shape_sha256,
        request.message_descriptor_root_sha256, request.message_count, request.logical_message_bytes,
        request.user_history_bytes, request.assistant_history_bytes, request.other_history_bytes,
        request.tool_schema_bytes, request.created_at_ms, request.record_sha256,
      );
      return { reused: false, record: request };
    });
  }

  readLatestProviderTurnRequest(promptGenerationId: string): ProviderTurnRequestRecord | null {
    this.assertProviderTurnsAvailable();
    const row = this.connection.prepare(`SELECT * FROM input_context_prompt_requests_v2
      WHERE prompt_generation_id=? ORDER BY request_sequence DESC LIMIT 1`).get(promptGenerationId) as SqlRow | undefined;
    return row ? decodeProviderTurnRequest(row) : null;
  }

  insertProviderTurnLedger(ledger: ProviderTurnLedgerRecord): { readonly reused: boolean; readonly record: ProviderTurnLedgerRecord } {
    assertProviderTurnLedger(ledger);
    this.assertProviderTurnsAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM provider_turn_ledgers_v2 WHERE prompt_request_id=?")
        .get(ledger.prompt_request_id) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeProviderTurnLedger(this.connection, existing);
        assertSameRecord(`ProviderTurnLedger ${ledger.prompt_request_id}`, decoded, ledger);
        return { reused: true, record: decoded };
      }
      const promptRequest = this.connection.prepare(`SELECT prompt_generation_id,logical_request_hmac_sha256
        FROM input_context_prompt_requests_v2 WHERE prompt_request_id=?`).get(ledger.prompt_request_id) as SqlRow | undefined;
      if (!promptRequest) throw new AuthorityIntegrityError("Provider-turn ledger has no logical PromptRequest parent");
      if (ledger.prompt_generation_id !== text(promptRequest, "prompt_generation_id")) {
        throw new AuthorityIntegrityError("Provider-turn ledger PromptGeneration binding does not match its logical request");
      }
      const started = this.connection.prepare(`SELECT count(*) AS count FROM provider_turn_attempts_v2
        WHERE prompt_request_id=? AND transition_ordinal=0`).get(ledger.prompt_request_id) as SqlRow | undefined;
      if (Number(started?.count ?? 0) < 1) {
        throw new AuthorityIntegrityError("Provider-turn ledger requires a persisted STARTED physical attempt");
      }
      this.connection.prepare(`INSERT INTO provider_turn_ledgers_v2(
        prompt_request_id,prompt_generation_id,context_envelope_sha256,layout_manifest_sha256,
        provider_uncached_input_tokens,provider_cache_read_tokens,provider_cache_write_tokens,
        provider_generated_output_tokens,provider_reasoning_tokens,attributed_input_tokens,
        unattributed_input_tokens,attributed_output_tokens,unattributed_output_tokens,
        accounting_completeness,additional_model_requests,additional_provider_requests,created_at_ms,record_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ledger.prompt_request_id, ledger.prompt_generation_id, ledger.context_envelope_sha256,
        ledger.layout_manifest_sha256, ledger.provider_uncached_input_tokens, ledger.provider_cache_read_tokens,
        ledger.provider_cache_write_tokens, ledger.provider_generated_output_tokens, ledger.provider_reasoning_tokens,
        ledger.attributed_input_tokens, ledger.unattributed_input_tokens, ledger.attributed_output_tokens,
        ledger.unattributed_output_tokens, ledger.accounting_completeness, ledger.additional_model_requests,
        ledger.additional_provider_requests, ledger.created_at_ms, ledger.record_sha256,
      );
      const byId = new Map(ledger.contributions.map((entry) => [entry.contribution_id, entry]));
      for (const contribution of ledger.contributions) {
        if (contribution.duplicate_of === null) continue;
        const target = byId.get(contribution.duplicate_of);
        if (!target?.included || target.duplicate_of !== null) {
          throw new TypeError("Provider-turn duplicate must reference one included canonical contribution");
        }
        if (contribution.segment_identity_hmac !== null
          && contribution.segment_identity_hmac !== target.segment_identity_hmac) {
          throw new TypeError("Provider-turn duplicate segment identity does not match its canonical contribution");
        }
      }
      const insertContribution = (contribution: ProviderTurnContributionRecord, ordinal: number): void => {
        this.connection.prepare(`INSERT INTO provider_turn_contributions_v2(
          contribution_id,prompt_request_id,ordinal,owner,input_surface,output_surface,segment_identity_hmac,
          logical_bytes,tokens,evidence,included,duplicate_of,contribution_sha256
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          contribution.contribution_id, ledger.prompt_request_id, ordinal, contribution.owner,
          contribution.input_surface, contribution.output_surface, contribution.segment_identity_hmac,
          contribution.logical_bytes, contribution.tokens, contribution.evidence, contribution.included ? 1 : 0,
          contribution.duplicate_of, providerTurnContributionSha256(ledger.prompt_request_id, ordinal, contribution),
        );
      };
      ledger.contributions.forEach((entry, ordinal) => { if (entry.duplicate_of === null) insertContribution(entry, ordinal); });
      ledger.contributions.forEach((entry, ordinal) => { if (entry.duplicate_of !== null) insertContribution(entry, ordinal); });
      return { reused: false, record: ledger };
    });
  }

  readProviderTurnLedger(promptRequestId: string): ProviderTurnLedgerRecord | null {
    this.assertProviderTurnsAvailable();
    const row = this.connection.prepare("SELECT * FROM provider_turn_ledgers_v2 WHERE prompt_request_id=?")
      .get(promptRequestId) as SqlRow | undefined;
    return row ? decodeProviderTurnLedger(this.connection, row) : null;
  }

  appendProviderTurnAttempt(attempt: ProviderTurnAttemptRecord): { readonly reused: boolean; readonly record: ProviderTurnAttemptRecord } {
    assertProviderTurnAttempt(attempt);
    this.assertProviderTurnsAvailable();
    return atomic(this.connection, () => {
      const existing = this.connection.prepare(`SELECT * FROM provider_turn_attempts_v2
        WHERE attempt_id=? AND transition_ordinal=?`).get(attempt.attempt_id, attempt.transition_ordinal) as SqlRow | undefined;
      if (existing) {
        const decoded = decodeProviderTurnAttempt(existing);
        assertSameRecord(`ProviderTurnAttempt ${attempt.attempt_id}:${attempt.transition_ordinal}`, decoded, attempt);
        return { reused: true, record: decoded };
      }
      const promptRequest = this.connection.prepare(`SELECT prompt_generation_id,logical_request_hmac_sha256
        FROM input_context_prompt_requests_v2 WHERE prompt_request_id=?`).get(attempt.prompt_request_id) as SqlRow | undefined;
      if (!promptRequest) throw new AuthorityIntegrityError("Provider-turn attempt has no logical PromptRequest parent");
      if (text(promptRequest, "logical_request_hmac_sha256") !== attempt.request_identity_hmac) {
        throw new AuthorityIntegrityError("Provider-turn attempt request identity does not match its logical request");
      }
      if (attempt.transition_ordinal === 0) {
        const prior = this.connection.prepare(`SELECT attempt_number,transition_ordinal FROM provider_turn_attempts_v2
          WHERE prompt_request_id=? ORDER BY attempt_number DESC,transition_ordinal DESC LIMIT 1`)
          .get(attempt.prompt_request_id) as SqlRow | undefined;
        if ((!prior && attempt.attempt_number !== 1)
          || (prior && (integer(prior, "attempt_number") + 1 !== attempt.attempt_number
            || integer(prior, "transition_ordinal") !== 1))) {
          throw new AuthorityIntegrityError("Provider-turn physical attempt sequence is not append-only");
        }
      } else {
        const ledger = this.readProviderTurnLedger(attempt.prompt_request_id);
        if (!ledger) throw new AuthorityIntegrityError(`Provider-turn ledger ${attempt.prompt_request_id} does not exist before terminal reconciliation`);
        const startRow = this.connection.prepare(`SELECT * FROM provider_turn_attempts_v2
          WHERE attempt_id=? AND transition_ordinal=0`).get(attempt.attempt_id) as SqlRow | undefined;
        if (!startRow) throw new AuthorityIntegrityError("Provider-turn terminal transition has no STARTED record");
        const started = decodeProviderTurnAttempt(startRow);
        if (started.prompt_request_id !== attempt.prompt_request_id
          || started.attempt_number !== attempt.attempt_number
          || started.request_identity_hmac !== attempt.request_identity_hmac
          || started.started_at_ms !== attempt.started_at_ms
          || (started.payload_identity_hmac !== null && started.payload_identity_hmac !== attempt.payload_identity_hmac)
          || finalityOrder[attempt.payload_finality] < finalityOrder[started.payload_finality]) {
          throw new AuthorityIntegrityError("Provider-turn attempt binding changed across transitions");
        }
      }
      if (attempt.usage_contribution_sha256 !== null) {
        const usage = this.connection.prepare(`SELECT count(*) AS count FROM provider_turn_contributions_v2
          WHERE prompt_request_id=? AND contribution_sha256=?`).get(
          attempt.prompt_request_id, attempt.usage_contribution_sha256,
        ) as SqlRow | undefined;
        if (Number(usage?.count ?? 0) !== 1) {
          throw new AuthorityIntegrityError("Provider-turn attempt usage contribution is not in its ledger");
        }
      }
      this.connection.prepare(`INSERT INTO provider_turn_attempts_v2(
        attempt_id,prompt_request_id,attempt_number,transition_ordinal,request_identity_hmac,
        payload_identity_hmac,payload_finality,started_at_ms,completed_at_ms,response_status,
        outcome,usage_contribution_sha256,record_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        attempt.attempt_id, attempt.prompt_request_id, attempt.attempt_number, attempt.transition_ordinal,
        attempt.request_identity_hmac, attempt.payload_identity_hmac, attempt.payload_finality,
        attempt.started_at_ms, attempt.completed_at_ms, attempt.response_status, attempt.outcome,
        attempt.usage_contribution_sha256, attempt.record_sha256,
      );
      return { reused: false, record: attempt };
    });
  }

  beginProviderTurn(
    request: ProviderTurnRequestRecord,
    started: ProviderTurnAttemptRecord,
  ): { readonly requestReused: boolean; readonly attemptReused: boolean } {
    this.assertProviderTurnsAvailable();
    if (started.prompt_request_id !== request.prompt_request_id || started.transition_ordinal !== 0
      || started.outcome !== "STARTED") {
      throw new AuthorityIntegrityError("Provider-turn begin binding is invalid");
    }
    return atomic(this.connection, () => {
      const requestResult = this.insertProviderTurnRequest(request);
      const attemptResult = this.appendProviderTurnAttempt(started);
      return { requestReused: requestResult.reused, attemptReused: attemptResult.reused };
    });
  }

  readProviderTurnAttempts(promptRequestId: string, limit = 1024): ProviderTurnAttemptRecord[] {
    this.assertProviderTurnsAvailable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2048) throw new RangeError("Provider-turn attempt limit is invalid");
    const rows = this.connection.prepare(`SELECT * FROM provider_turn_attempts_v2
      WHERE prompt_request_id=? ORDER BY attempt_number,transition_ordinal LIMIT ?`).all(promptRequestId, limit + 1) as SqlRow[];
    if (rows.length > limit) throw new AuthorityIntegrityError("Provider-turn attempt read exceeded its declared bound");
    return rows.map(decodeProviderTurnAttempt);
  }

  readPendingProviderTurns(limit = 64): PendingProviderTurnRecord[] {
    this.assertProviderTurnsAvailable();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Pending provider-turn limit is invalid");
    }
    const rows = this.connection.prepare(`SELECT started.*,request.prompt_generation_id AS parent_prompt_generation_id
      FROM provider_turn_attempts_v2 started
      JOIN input_context_prompt_requests_v2 request ON request.prompt_request_id=started.prompt_request_id
      WHERE started.transition_ordinal=0
        AND NOT EXISTS (SELECT 1 FROM provider_turn_attempts_v2 terminal
          WHERE terminal.attempt_id=started.attempt_id AND terminal.transition_ordinal=1)
      ORDER BY started.started_at_ms,started.attempt_id LIMIT ?`).all(limit) as SqlRow[];
    return rows.map((row) => {
      const started = decodeProviderTurnAttempt(row);
      const ledgerRow = this.connection.prepare("SELECT * FROM provider_turn_ledgers_v2 WHERE prompt_request_id=?")
        .get(started.prompt_request_id) as SqlRow | undefined;
      return {
        started,
        promptGenerationId: text(row, "parent_prompt_generation_id"),
        ledger: ledgerRow ? decodeProviderTurnLedger(this.connection, ledgerRow) : null,
      };
    });
  }

  completeProviderTurn(
    ledger: ProviderTurnLedgerRecord,
    terminal: ProviderTurnAttemptRecord,
  ): { readonly ledgerReused: boolean; readonly terminalReused: boolean } {
    this.assertProviderTurnsAvailable();
    if (terminal.prompt_request_id !== ledger.prompt_request_id || terminal.transition_ordinal !== 1) {
      throw new AuthorityIntegrityError("Provider-turn completion binding is invalid");
    }
    return atomic(this.connection, () => {
      const ledgerResult = this.insertProviderTurnLedger(ledger);
      const terminalResult = this.appendProviderTurnAttempt(terminal);
      return { ledgerReused: ledgerResult.reused, terminalReused: terminalResult.reused };
    });
  }

  rebuildQueryScopeHeads(pageSize = 256): { readonly scopes: number; readonly activeHeads: number } {
    this.assertAvailable();
    validatePageSize(pageSize);
    return atomic(this.connection, () => {
      this.connection.exec("DELETE FROM context_query_scope_heads_v1");
      let workspace = "";
      let scope = "";
      let scopes = 0;
      let activeHeads = 0;
      while (true) {
        const rows = this.connection.prepare(`SELECT DISTINCT workspace_id,source_scope_hmac
          FROM read_evidence_receipts_v1
          WHERE source_kind='QUERY' AND query_completeness='COMPLETE'
            AND (workspace_id>? OR (workspace_id=? AND source_scope_hmac>?))
          ORDER BY workspace_id,source_scope_hmac LIMIT ?`).all(workspace, workspace, scope, pageSize) as SqlRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          workspace = text(row, "workspace_id");
          scope = text(row, "source_scope_hmac");
          scopes += 1;
          if (this.rebuildQueryScope(workspace, scope)) activeHeads += 1;
        }
      }
      return { scopes, activeHeads };
    });
  }

  verifyQueryScopeHeads(pageSize = 256): number {
    this.assertAvailable();
    validatePageSize(pageSize);
    let workspace = "";
    let scope = "";
    let expectedHeads = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT DISTINCT workspace_id,source_scope_hmac
        FROM read_evidence_receipts_v1
        WHERE source_kind='QUERY' AND query_completeness='COMPLETE'
          AND (workspace_id>? OR (workspace_id=? AND source_scope_hmac>?))
        ORDER BY workspace_id,source_scope_hmac LIMIT ?`).all(workspace, workspace, scope, pageSize) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        workspace = text(row, "workspace_id");
        scope = text(row, "source_scope_hmac");
        const expected = this.expectedQueryScopeHead(workspace, scope);
        const actualRow = this.connection.prepare(`SELECT * FROM context_query_scope_heads_v1
          WHERE workspace_id=? AND source_scope_hmac=?`).get(workspace, scope) as SqlRow | undefined;
        const actual = actualRow ? decodeQueryScopeHead(actualRow) : null;
        if ((expected === null) !== (actual === null)
          || (expected && actual && !equalRecords(expected, actual))) {
          throw new AuthorityIntegrityError(`Query-scope head ${workspace}:${scope} does not match immutable evidence`);
        }
        if (expected) expectedHeads += 1;
      }
    }
    const count = this.connection.prepare("SELECT count(*) AS count FROM context_query_scope_heads_v1").get() as SqlRow | undefined;
    if (Number(count?.count ?? 0) !== expectedHeads) {
      throw new AuthorityIntegrityError("Query-scope head projection contains an unbacked row");
    }
    return expectedHeads;
  }

  private expectedQueryScopeHead(workspaceId: string, sourceScopeHmac: string): QueryScopeHeadRecord | null {
    const row = this.connection.prepare(`SELECT r.* FROM read_evidence_receipts_v1 r
      WHERE r.workspace_id=? AND r.source_scope_hmac=? AND r.source_kind='QUERY'
        AND r.query_completeness='COMPLETE'
        AND COALESCE((SELECT t.value FROM evidence_validity_transitions_v1 t
          WHERE t.receipt_id=r.receipt_id AND t.axis='CONTENT_FRESHNESS'
          ORDER BY t.created_at_ms DESC,t.transition_id DESC LIMIT 1),r.content_freshness)
          IN ('HASH_CURRENT','CHANGE_WITNESS_CURRENT')
        AND COALESCE((SELECT t.value FROM evidence_validity_transitions_v1 t
          WHERE t.receipt_id=r.receipt_id AND t.axis='SCOPE_AUTHORIZATION'
          ORDER BY t.created_at_ms DESC,t.transition_id DESC LIMIT 1),r.scope_authorization)='AUTHORIZED'
        AND COALESCE((SELECT t.value FROM evidence_validity_transitions_v1 t
          WHERE t.receipt_id=r.receipt_id AND t.axis='SEMANTIC_APPLICABILITY'
          ORDER BY t.created_at_ms DESC,t.transition_id DESC LIMIT 1),r.semantic_applicability)
          IN ('CURRENT','NOT_APPLICABLE')
        AND COALESCE((SELECT t.value FROM evidence_validity_transitions_v1 t
          WHERE t.receipt_id=r.receipt_id AND t.axis='REPRESENTATION_FIDELITY'
          ORDER BY t.created_at_ms DESC,t.transition_id DESC LIMIT 1),r.representation_fidelity)
          IN ('EXACT_RAW','EXACT_DECODED','TYPED_EXTRACT')
      ORDER BY r.observed_at_ms DESC,r.receipt_id DESC LIMIT 1`).get(workspaceId, sourceScopeHmac) as SqlRow | undefined;
    if (!row) return null;
    const receipt = decodeReadEvidence(row);
    const base: Omit<QueryScopeHeadRecord, "head_sha256"> = {
      workspace_id: receipt.workspace_id,
      source_scope_hmac: receipt.source_scope_hmac,
      receipt_id: receipt.receipt_id,
      dependency_signature_sha256: receipt.dependency_signature_sha256,
      evidence_sha256: receipt.evidence_sha256,
      updated_at_ms: receipt.observed_at_ms,
    };
    return { ...base, head_sha256: queryScopeHeadSha256(base) };
  }

  private rebuildQueryScope(workspaceId: string, sourceScopeHmac: string): QueryScopeHeadRecord | null {
    const expected = this.expectedQueryScopeHead(workspaceId, sourceScopeHmac);
    if (!expected) {
      this.connection.prepare(`DELETE FROM context_query_scope_heads_v1
        WHERE workspace_id=? AND source_scope_hmac=?`).run(workspaceId, sourceScopeHmac);
      return null;
    }
    this.connection.prepare(`INSERT INTO context_query_scope_heads_v1(
      workspace_id,source_scope_hmac,receipt_id,dependency_signature_sha256,evidence_sha256,head_sha256,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,source_scope_hmac) DO UPDATE SET
      receipt_id=excluded.receipt_id,dependency_signature_sha256=excluded.dependency_signature_sha256,
      evidence_sha256=excluded.evidence_sha256,head_sha256=excluded.head_sha256,updated_at_ms=excluded.updated_at_ms`).run(
      expected.workspace_id, expected.source_scope_hmac, expected.receipt_id,
      expected.dependency_signature_sha256, expected.evidence_sha256,
      expected.head_sha256, expected.updated_at_ms,
    );
    return expected;
  }

  verifyIntegrity(pageSize = 256): InputContextIntegritySummary {
    this.assertAvailable();
    validatePageSize(pageSize);
    if (this.providerTurnsAvailable()) this.verifyProviderTurnRequests(pageSize);
    const summary = {
      readEvidenceReceipts: this.verifyKeyset("read_evidence_receipts_v1", "receipt_id", decodeReadEvidence, pageSize),
      validityTransitions: this.verifyKeyset("evidence_validity_transitions_v1", "transition_id", decodeValidityTransition, pageSize),
      workingSets: this.verifyKeyset("context_working_sets_v1", "working_set_id", (row) => decodeWorkingSetEnvelope(this.connection, row), pageSize),
      compileReceipts: this.verifyKeyset("context_compile_receipts_v1", "compile_receipt_id", decodeCompileReceipt, pageSize),
      retentionRoots: this.verifyKeyset("context_retention_roots_v1", "retention_root_id", decodeRetentionRoot, pageSize),
      toolSurfacePlans: this.verifyKeyset("context_tool_surface_plans_v1", "tool_surface_plan_id", decodeToolSurfacePlan, pageSize),
      layoutManifests: this.verifyKeyset("context_layout_manifests_v1", "layout_manifest_id", decodeLayoutManifest, pageSize),
      projectionTransitions: this.verifyProjections(pageSize),
      providerTurnLedgers: this.providerTurnsAvailable() ? this.verifyProviderTurnLedgers(pageSize) : 0,
      providerTurnAttempts: this.providerTurnsAvailable() ? this.verifyAttempts(pageSize) : 0,
      queryScopeHeads: this.verifyQueryScopeHeads(pageSize),
      projectSourceManifests: this.verifyKeyset("project_source_manifests_v1", "manifest_id", decodeProjectSourceManifest, pageSize),
      projectKnowledgeClaims: this.verifyKeyset("project_knowledge_claims_v1", "claim_id", decodeProjectKnowledgeClaim, pageSize),
    } satisfies InputContextIntegritySummary;
    return summary;
  }

  private verifyKeyset(
    table: string,
    key: string,
    decode: (row: SqlRow) => unknown,
    pageSize: number,
  ): number {
    let cursor = "";
    let count = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT * FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT ?`)
        .all(cursor, pageSize) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        decode(row);
        cursor = text(row, key);
        count += 1;
      }
    }
    return count;
  }

  private verifyProjections(pageSize: number): number {
    let projectionId = "";
    let total = 0;
    while (true) {
      const ids = this.connection.prepare(`SELECT DISTINCT projection_id FROM context_projection_receipts_v1
        WHERE projection_id>? ORDER BY projection_id LIMIT ?`).all(projectionId, pageSize) as SqlRow[];
      if (ids.length === 0) break;
      for (const idRow of ids) {
        projectionId = text(idRow, "projection_id");
        const rows = this.connection.prepare(`SELECT * FROM context_projection_receipts_v1
          WHERE projection_id=? ORDER BY transition_ordinal LIMIT 34`).all(projectionId) as SqlRow[];
        if (rows.length > 33) throw new AuthorityIntegrityError(`Projection ${projectionId} exceeds transition bound`);
        let prior: ContextProjectionReceiptRecord | null = null;
        rows.forEach((row, ordinal) => {
          const current = decodeProjectionReceipt(row);
          if (current.transition_ordinal !== ordinal) throw new AuthorityIntegrityError(`Projection ${projectionId} contains a transition gap`);
          if (prior) {
            if (!projectionTransitions[prior.projection_state].has(current.projection_state)) {
              throw new AuthorityIntegrityError(`Projection ${projectionId} has an invalid stored transition`);
            }
            for (const key of [
              "context_envelope_sha256", "tool_surface_plan_sha256", "layout_manifest_sha256",
              "retained_root_sha256", "runtime_fingerprint_sha256",
              "prompt_generation_id", "idempotency_key_hmac",
            ] as const) if (prior[key] !== current[key]) throw new AuthorityIntegrityError(`Projection ${projectionId} binding changed`);
            if (!equalRecords(prior.subject, current.subject)) throw new AuthorityIntegrityError(`Projection ${projectionId} subject changed`);
            if (current.created_at_ms < prior.created_at_ms
              || finalityOrder[current.finality] < finalityOrder[prior.finality]) {
              throw new AuthorityIntegrityError(`Projection ${projectionId} time/finality regressed`);
            }
          }
          prior = current;
          total += 1;
        });
      }
    }
    return total;
  }

  private verifyProviderTurnRequests(pageSize: number): number {
    let promptRequestId = "";
    let total = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT * FROM input_context_prompt_requests_v2
        WHERE prompt_request_id>? ORDER BY prompt_request_id LIMIT ?`).all(promptRequestId, pageSize) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const request = decodeProviderTurnRequest(row);
        promptRequestId = request.prompt_request_id;
        if (request.previous_prompt_request_id !== null) {
          const previousRow = this.connection.prepare(`SELECT * FROM input_context_prompt_requests_v2
            WHERE prompt_request_id=?`).get(request.previous_prompt_request_id) as SqlRow | undefined;
          if (!previousRow) throw new AuthorityIntegrityError(`ProviderTurnRequest ${promptRequestId} predecessor is missing`);
          const previous = decodeProviderTurnRequest(previousRow);
          if (previous.prompt_generation_id !== request.prompt_generation_id
            || previous.request_sequence + 1 !== request.request_sequence) {
            throw new AuthorityIntegrityError(`ProviderTurnRequest ${promptRequestId} lineage is invalid`);
          }
        }
        total += 1;
      }
    }
    return total;
  }

  private verifyProviderTurnLedgers(pageSize: number): number {
    let promptRequestId = "";
    let total = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT * FROM provider_turn_ledgers_v2
        WHERE prompt_request_id>? ORDER BY prompt_request_id LIMIT ?`).all(promptRequestId, pageSize) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const ledger = decodeProviderTurnLedger(this.connection, row);
        promptRequestId = ledger.prompt_request_id;
        const prompt = this.connection.prepare(`SELECT prompt_generation_id FROM input_context_prompt_requests_v2
          WHERE prompt_request_id=?`).get(promptRequestId) as SqlRow | undefined;
        if (!prompt || ledger.prompt_generation_id !== text(prompt, "prompt_generation_id")) {
          throw new AuthorityIntegrityError(`ProviderTurnLedger ${promptRequestId} logical request binding is invalid`);
        }
        const started = this.connection.prepare(`SELECT count(*) AS count FROM provider_turn_attempts_v2
          WHERE prompt_request_id=? AND transition_ordinal=0`).get(promptRequestId) as SqlRow | undefined;
        if (Number(started?.count ?? 0) < 1) {
          throw new AuthorityIntegrityError(`ProviderTurnLedger ${promptRequestId} has no STARTED physical attempt`);
        }
        total += 1;
      }
    }
    return total;
  }

  private verifyAttempts(pageSize: number): number {
    let attemptId = "";
    let total = 0;
    while (true) {
      const ids = this.connection.prepare(`SELECT DISTINCT attempt_id FROM provider_turn_attempts_v2
        WHERE attempt_id>? ORDER BY attempt_id LIMIT ?`).all(attemptId, pageSize) as SqlRow[];
      if (ids.length === 0) break;
      for (const idRow of ids) {
        attemptId = text(idRow, "attempt_id");
        const rows = this.connection.prepare(`SELECT * FROM provider_turn_attempts_v2
          WHERE attempt_id=? ORDER BY transition_ordinal LIMIT 3`).all(attemptId) as SqlRow[];
        if (rows.length < 1 || rows.length > 2) throw new AuthorityIntegrityError(`Provider attempt ${attemptId} has invalid transition count`);
        const started = decodeProviderTurnAttempt(rows[0] as SqlRow);
        if (started.transition_ordinal !== 0) throw new AuthorityIntegrityError(`Provider attempt ${attemptId} has no STARTED record`);
        const prompt = this.connection.prepare(`SELECT logical_request_hmac_sha256 FROM input_context_prompt_requests_v2
          WHERE prompt_request_id=?`).get(started.prompt_request_id) as SqlRow | undefined;
        if (!prompt || text(prompt, "logical_request_hmac_sha256") !== started.request_identity_hmac) {
          throw new AuthorityIntegrityError(`Provider attempt ${attemptId} logical request binding is invalid`);
        }
        if (rows.length === 2) {
          const terminal = decodeProviderTurnAttempt(rows[1] as SqlRow);
          if (terminal.transition_ordinal !== 1 || terminal.prompt_request_id !== started.prompt_request_id
            || terminal.attempt_number !== started.attempt_number
            || terminal.request_identity_hmac !== started.request_identity_hmac
            || terminal.started_at_ms !== started.started_at_ms
            || (started.payload_identity_hmac !== null && terminal.payload_identity_hmac !== started.payload_identity_hmac)
            || finalityOrder[terminal.payload_finality] < finalityOrder[started.payload_finality]) {
            throw new AuthorityIntegrityError(`Provider attempt ${attemptId} terminal binding is invalid`);
          }
          const ledger = this.connection.prepare(`SELECT count(*) AS count FROM provider_turn_ledgers_v2
            WHERE prompt_request_id=?`).get(started.prompt_request_id) as SqlRow | undefined;
          if (Number(ledger?.count ?? 0) !== 1) {
            throw new AuthorityIntegrityError(`Provider attempt ${attemptId} terminal has no final ledger`);
          }
          if (terminal.usage_contribution_sha256 !== null) {
            const usage = this.connection.prepare(`SELECT count(*) AS count FROM provider_turn_contributions_v2
              WHERE prompt_request_id=? AND contribution_sha256=?`).get(
              terminal.prompt_request_id, terminal.usage_contribution_sha256,
            ) as SqlRow | undefined;
            if (Number(usage?.count ?? 0) !== 1) {
              throw new AuthorityIntegrityError(`Provider attempt ${attemptId} terminal usage binding is invalid`);
            }
          }
        }
        total += rows.length;
      }
    }
    return total;
  }
}
