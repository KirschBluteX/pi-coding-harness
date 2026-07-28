-- Transaction ownership belongs to migrateInputContextStore so schema bytes and
-- the schema_migrations hash are committed atomically.

CREATE TABLE read_evidence_receipts_v1 (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('AUTHORITY','FILE_RANGE','QUERY','TOOL_RESULT','ARTIFACT','MEMORY','STRUCTURAL_MAP','OUTPUT_DIRECTIVE')),
  capture_kind TEXT NOT NULL CHECK(capture_kind IN ('FULL_FILE','BYTE_RANGE','LINE_RANGE','QUERY_SCOPE','TOOL_OUTPUT','IMMUTABLE_ARTIFACT','STRUCTURAL_EXTRACT')),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  artifact_ref_hmac TEXT CHECK(artifact_ref_hmac IS NULL OR length(artifact_ref_hmac)=64),
  dependency_signature_sha256 TEXT NOT NULL CHECK(length(dependency_signature_sha256)=64),
  source_scope_hmac TEXT NOT NULL CHECK(length(source_scope_hmac)=64),
  source_version_handle_hmac TEXT CHECK(source_version_handle_hmac IS NULL OR length(source_version_handle_hmac)=64),
  query_completeness TEXT NOT NULL CHECK(query_completeness IN ('COMPLETE','PARTIAL','NOT_APPLICABLE','UNKNOWN')),
  content_freshness TEXT NOT NULL CHECK(content_freshness IN ('HASH_CURRENT','CHANGE_WITNESS_CURRENT','STALE','UNKNOWN','NOT_APPLICABLE')),
  scope_authorization TEXT NOT NULL CHECK(scope_authorization IN ('AUTHORIZED','DENIED','UNKNOWN')),
  semantic_applicability TEXT NOT NULL CHECK(semantic_applicability IN ('CURRENT','SUPERSEDED','UNKNOWN','NOT_APPLICABLE')),
  representation_fidelity TEXT NOT NULL CHECK(representation_fidelity IN ('EXACT_RAW','EXACT_DECODED','TYPED_EXTRACT','LOSSY_EXCERPT','OPAQUE','UNKNOWN')),
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL','SENSITIVE')),
  adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  CHECK((source_kind='QUERY' AND capture_kind='QUERY_SCOPE') OR (source_kind<>'QUERY' AND capture_kind<>'QUERY_SCOPE')),
  CHECK(source_kind='QUERY' OR query_completeness='NOT_APPLICABLE'),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL)),
  CHECK(content_freshness NOT IN ('HASH_CURRENT','CHANGE_WITNESS_CURRENT')
    OR source_kind IN ('AUTHORITY','ARTIFACT') OR source_version_handle_hmac IS NOT NULL)
) STRICT;

CREATE TABLE evidence_validity_transitions_v1 (
  transition_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES read_evidence_receipts_v1(receipt_id),
  axis TEXT NOT NULL CHECK(axis IN ('CONTENT_FRESHNESS','SCOPE_AUTHORIZATION','SEMANTIC_APPLICABILITY','REPRESENTATION_FIDELITY')),
  value TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 96),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  transition_sha256 TEXT NOT NULL UNIQUE CHECK(length(transition_sha256)=64),
  CHECK((axis='CONTENT_FRESHNESS' AND value IN ('HASH_CURRENT','CHANGE_WITNESS_CURRENT','STALE','UNKNOWN','NOT_APPLICABLE'))
    OR (axis='SCOPE_AUTHORIZATION' AND value IN ('AUTHORIZED','DENIED','UNKNOWN'))
    OR (axis='SEMANTIC_APPLICABILITY' AND value IN ('CURRENT','SUPERSEDED','UNKNOWN','NOT_APPLICABLE'))
    OR (axis='REPRESENTATION_FIDELITY' AND value IN ('EXACT_RAW','EXACT_DECODED','TYPED_EXTRACT','LOSSY_EXCERPT','OPAQUE','UNKNOWN')))
) STRICT;

CREATE TABLE context_working_sets_v1 (
  working_set_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  profile TEXT NOT NULL CHECK(profile IN ('PASS_THROUGH','RETAINED_DELTA','TARGETED_EVIDENCE','STRUCTURAL_DISCOVERY','RECOVERY')),
  prompt_generation_id TEXT REFERENCES prompt_generations(prompt_generation_id),
  context_demand_sha256 TEXT NOT NULL CHECK(length(context_demand_sha256)=64),
  retained_root_sha256 TEXT NOT NULL CHECK(length(retained_root_sha256)=64),
  source_closure_root_sha256 TEXT CHECK(source_closure_root_sha256 IS NULL OR length(source_closure_root_sha256)=64),
  acceptance_closure_root_sha256 TEXT CHECK(acceptance_closure_root_sha256 IS NULL OR length(acceptance_closure_root_sha256)=64),
  mandatory_coverage_root_sha256 TEXT NOT NULL CHECK(length(mandatory_coverage_root_sha256)=64),
  estimated_projected_tokens INTEGER NOT NULL CHECK(estimated_projected_tokens>=0),
  fit_disposition TEXT NOT NULL CHECK(fit_disposition IN ('FIT','FIT_WITH_ON_DEMAND','BASELINE_FALLBACK','RECOVERY_REQUIRED')),
  working_set_sha256 TEXT NOT NULL UNIQUE CHECK(length(working_set_sha256)=64),
  envelope_sha256 TEXT NOT NULL UNIQUE CHECK(length(envelope_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL)),
  CHECK((profile='PASS_THROUGH' AND subject_kind='NONE') OR (profile<>'PASS_THROUGH' AND subject_kind<>'NONE'))
) STRICT;

CREATE TABLE context_working_set_items_v1 (
  working_set_id TEXT NOT NULL REFERENCES context_working_sets_v1(working_set_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),
  candidate_id TEXT NOT NULL,
  obligation_ids_json TEXT NOT NULL CHECK(json_valid(obligation_ids_json) AND json_type(obligation_ids_json)='array' AND length(obligation_ids_json)<=16384),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  disposition TEXT NOT NULL CHECK(disposition IN ('MANDATORY_INLINE','ALREADY_RETAINED','INLINE_EXACT','INLINE_TYPED_EXTRACT','ON_DEMAND','REREAD_REQUIRED','HISTORICAL_ONLY','OMIT_CLOSED','OMIT_UNAUTHORIZED','OMIT_BUDGET_OPTIONAL')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 96),
  ordinal_class TEXT NOT NULL CHECK(ordinal_class IN ('STABLE_POLICY','CONTROL','EVIDENCE','DIRECTIVE')),
  content_identity_hmac TEXT NOT NULL CHECK(length(content_identity_hmac)=64),
  retained_entry_id TEXT,
  source_version_handle_hmac TEXT CHECK(source_version_handle_hmac IS NULL OR length(source_version_handle_hmac)=64),
  projected_tokens INTEGER NOT NULL CHECK(projected_tokens>=0),
  PRIMARY KEY(working_set_id,ordinal),
  UNIQUE(working_set_id,candidate_id),
  CHECK(disposition<>'ALREADY_RETAINED' OR retained_entry_id IS NOT NULL)
) WITHOUT ROWID, STRICT;

CREATE TABLE context_compile_receipts_v1 (
  compile_receipt_id TEXT PRIMARY KEY,
  working_set_id TEXT NOT NULL REFERENCES context_working_sets_v1(working_set_id),
  envelope_sha256 TEXT NOT NULL REFERENCES context_working_sets_v1(envelope_sha256),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  mandatory_obligation_count INTEGER NOT NULL CHECK(mandatory_obligation_count BETWEEN 0 AND 128),
  mandatory_covered_count INTEGER NOT NULL CHECK(mandatory_covered_count BETWEEN 0 AND mandatory_obligation_count),
  discovery_debt_count INTEGER NOT NULL CHECK(discovery_debt_count BETWEEN 0 AND 128),
  omitted_optional_count INTEGER NOT NULL CHECK(omitted_optional_count BETWEEN 0 AND 4096),
  fallback TEXT NOT NULL CHECK(fallback IN ('NONE','PI_BASELINE','FRESH_READ','NATIVE_RECOVERY')),
  duration_micros INTEGER NOT NULL CHECK(duration_micros BETWEEN 0 AND 60000000),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  CHECK(fallback<>'NONE' OR mandatory_covered_count=mandatory_obligation_count)
) STRICT;

CREATE TABLE context_retention_roots_v1 (
  retention_root_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  retention_class TEXT NOT NULL CHECK(retention_class IN ('TURN','STAGE','GOAL','RECOVERY')),
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms>=0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  root_sha256 TEXT NOT NULL UNIQUE CHECK(length(root_sha256)=64),
  CHECK(expires_at_ms IS NULL OR expires_at_ms>created_at_ms),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL))
) STRICT;

CREATE TABLE context_tool_surface_plans_v1 (
  tool_surface_plan_id TEXT PRIMARY KEY,
  context_envelope_sha256 TEXT NOT NULL REFERENCES context_working_sets_v1(envelope_sha256),
  strategy TEXT NOT NULL CHECK(strategy IN ('PRESERVE_USER_FULL','PCH_CORE_DEFERRED','ADDITIVE_TASK_DISCOVERY','TASK_SCOPED_REPLACEMENT')),
  user_tool_configuration_sha256 TEXT NOT NULL CHECK(length(user_tool_configuration_sha256)=64),
  active_tool_manifest_sha256 TEXT NOT NULL CHECK(length(active_tool_manifest_sha256)=64),
  deferred_tool_manifest_sha256 TEXT CHECK(deferred_tool_manifest_sha256 IS NULL OR length(deferred_tool_manifest_sha256)=64),
  capability_epoch_sha256 TEXT NOT NULL CHECK(length(capability_epoch_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  CHECK(strategy<>'PRESERVE_USER_FULL' OR deferred_tool_manifest_sha256 IS NULL)
) STRICT;

CREATE TABLE context_layout_manifests_v1 (
  layout_manifest_id TEXT PRIMARY KEY,
  context_envelope_sha256 TEXT NOT NULL REFERENCES context_working_sets_v1(envelope_sha256),
  prompt_generation_id TEXT REFERENCES prompt_generations(prompt_generation_id),
  ordered_segment_root_sha256 TEXT NOT NULL CHECK(length(ordered_segment_root_sha256)=64),
  segment_count INTEGER NOT NULL CHECK(segment_count BETWEEN 0 AND 256),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json) AND json_type(entries_json)='array' AND length(entries_json)<=131072),
  canonical_encoder_version TEXT NOT NULL CHECK(length(canonical_encoder_version) BETWEEN 1 AND 64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64)
) STRICT;

CREATE TABLE context_projection_receipts_v1 (
  projection_id TEXT NOT NULL,
  transition_ordinal INTEGER NOT NULL CHECK(transition_ordinal BETWEEN 0 AND 32),
  context_envelope_sha256 TEXT NOT NULL REFERENCES context_working_sets_v1(envelope_sha256),
  tool_surface_plan_sha256 TEXT NOT NULL REFERENCES context_tool_surface_plans_v1(record_sha256),
  layout_manifest_sha256 TEXT NOT NULL REFERENCES context_layout_manifests_v1(record_sha256),
  retained_root_sha256 TEXT NOT NULL CHECK(length(retained_root_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  prompt_generation_id TEXT REFERENCES prompt_generations(prompt_generation_id),
  projection_state TEXT NOT NULL CHECK(projection_state IN ('PREPARED','APPLIED','REQUEST_OBSERVED','OUTCOME_UNKNOWN','COMPLETED','ABANDONED')),
  idempotency_key_hmac TEXT NOT NULL CHECK(length(idempotency_key_hmac)=64),
  finality TEXT NOT NULL CHECK(finality IN ('PCH_HOOK_INPUT','PCH_HOOK_OUTPUT','EXTENSION_CHAIN_FINAL','WIRE_SERIALIZED')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  PRIMARY KEY(projection_id,transition_ordinal),
  UNIQUE(idempotency_key_hmac,transition_ordinal),
  CHECK(transition_ordinal<>0 OR projection_state='PREPARED'),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TABLE context_query_scope_heads_v1 (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  source_scope_hmac TEXT NOT NULL CHECK(length(source_scope_hmac)=64),
  receipt_id TEXT NOT NULL REFERENCES read_evidence_receipts_v1(receipt_id),
  dependency_signature_sha256 TEXT NOT NULL CHECK(length(dependency_signature_sha256)=64),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  head_sha256 TEXT NOT NULL CHECK(length(head_sha256)=64),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),
  PRIMARY KEY(workspace_id,source_scope_hmac)
) WITHOUT ROWID, STRICT;

CREATE TABLE project_source_manifests_v1 (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json) AND json_type(entries_json)='array' AND length(entries_json)<=262144),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL))
) STRICT;

CREATE TABLE project_knowledge_claims_v1 (
  claim_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL REFERENCES project_source_manifests_v1(manifest_id),
  source_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('NONE','GOAL','WORK_CELL')),
  subject_goal_id TEXT REFERENCES goals(goal_id),
  subject_id TEXT,
  subject_route_revision INTEGER CHECK(subject_route_revision IS NULL OR subject_route_revision>=1),
  subject_goal_contract_sha256 TEXT CHECK(subject_goal_contract_sha256 IS NULL OR length(subject_goal_contract_sha256)=64),
  subject_execution_authorization_sha256 TEXT CHECK(subject_execution_authorization_sha256 IS NULL OR length(subject_execution_authorization_sha256)=64),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 160),
  statement_sha256 TEXT NOT NULL CHECK(length(statement_sha256)=64),
  source_range_sha256 TEXT NOT NULL CHECK(length(source_range_sha256)=64),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  trust TEXT NOT NULL CHECK(trust IN ('AUTHORITY','VERIFIED_EVIDENCE','UNTRUSTED_CONTEXT')),
  content_freshness TEXT NOT NULL CHECK(content_freshness IN ('HASH_CURRENT','CHANGE_WITNESS_CURRENT','STALE','UNKNOWN','NOT_APPLICABLE')),
  scope_authorization TEXT NOT NULL CHECK(scope_authorization IN ('AUTHORIZED','DENIED','UNKNOWN')),
  semantic_applicability TEXT NOT NULL CHECK(semantic_applicability IN ('CURRENT','SUPERSEDED','UNKNOWN','NOT_APPLICABLE')),
  representation_fidelity TEXT NOT NULL CHECK(representation_fidelity IN ('EXACT_RAW','EXACT_DECODED','TYPED_EXTRACT','LOSSY_EXCERPT','OPAQUE','UNKNOWN')),
  authority_status TEXT NOT NULL CHECK(authority_status IN ('EVIDENCE_ONLY','FROZEN_IN_GOAL_CONTRACT')),
  frozen_goal_contract_sha256 TEXT CHECK(frozen_goal_contract_sha256 IS NULL OR length(frozen_goal_contract_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  CHECK((authority_status='EVIDENCE_ONLY' AND frozen_goal_contract_sha256 IS NULL)
    OR (authority_status='FROZEN_IN_GOAL_CONTRACT' AND frozen_goal_contract_sha256 IS NOT NULL
      AND frozen_goal_contract_sha256=subject_goal_contract_sha256)),
  CHECK((subject_kind='NONE' AND subject_goal_id IS NULL AND subject_id IS NULL
      AND subject_route_revision IS NULL AND subject_goal_contract_sha256 IS NULL
      AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='GOAL' AND subject_goal_id IS NOT NULL AND subject_id=subject_goal_id
      AND subject_goal_contract_sha256 IS NOT NULL AND subject_execution_authorization_sha256 IS NULL)
    OR (subject_kind='WORK_CELL' AND subject_goal_id IS NOT NULL AND subject_id IS NOT NULL
      AND subject_route_revision IS NOT NULL AND subject_goal_contract_sha256 IS NOT NULL
      AND subject_execution_authorization_sha256 IS NOT NULL))
) STRICT;

CREATE TABLE provider_turn_ledgers_v1 (
  prompt_request_id TEXT PRIMARY KEY REFERENCES prompt_requests(prompt_request_id),
  prompt_generation_id TEXT REFERENCES prompt_generations(prompt_generation_id),
  context_envelope_sha256 TEXT CHECK(context_envelope_sha256 IS NULL OR length(context_envelope_sha256)=64),
  layout_manifest_sha256 TEXT CHECK(layout_manifest_sha256 IS NULL OR length(layout_manifest_sha256)=64),
  provider_uncached_input_tokens INTEGER CHECK(provider_uncached_input_tokens IS NULL OR provider_uncached_input_tokens>=0),
  provider_cache_read_tokens INTEGER CHECK(provider_cache_read_tokens IS NULL OR provider_cache_read_tokens>=0),
  provider_cache_write_tokens INTEGER CHECK(provider_cache_write_tokens IS NULL OR provider_cache_write_tokens>=0),
  provider_generated_output_tokens INTEGER CHECK(provider_generated_output_tokens IS NULL OR provider_generated_output_tokens>=0),
  provider_reasoning_tokens INTEGER CHECK(provider_reasoning_tokens IS NULL OR provider_reasoning_tokens>=0),
  attributed_input_tokens INTEGER CHECK(attributed_input_tokens IS NULL OR attributed_input_tokens>=0),
  unattributed_input_tokens INTEGER CHECK(unattributed_input_tokens IS NULL OR unattributed_input_tokens>=0),
  attributed_output_tokens INTEGER CHECK(attributed_output_tokens IS NULL OR attributed_output_tokens>=0),
  unattributed_output_tokens INTEGER CHECK(unattributed_output_tokens IS NULL OR unattributed_output_tokens>=0),
  accounting_completeness TEXT NOT NULL CHECK(accounting_completeness IN ('COMPLETE','PARTIAL','UNOBSERVABLE')),
  additional_model_requests INTEGER NOT NULL CHECK(additional_model_requests=0),
  additional_provider_requests INTEGER NOT NULL CHECK(additional_provider_requests=0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  CHECK(provider_reasoning_tokens IS NULL OR provider_generated_output_tokens IS NULL OR provider_reasoning_tokens<=provider_generated_output_tokens)
) STRICT;

CREATE TABLE provider_turn_attempts_v1 (
  attempt_id TEXT NOT NULL,
  prompt_request_id TEXT NOT NULL REFERENCES prompt_requests(prompt_request_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 1024),
  transition_ordinal INTEGER NOT NULL CHECK(transition_ordinal IN (0,1)),
  request_identity_hmac TEXT NOT NULL CHECK(length(request_identity_hmac)=64),
  payload_identity_hmac TEXT CHECK(payload_identity_hmac IS NULL OR length(payload_identity_hmac)=64),
  payload_finality TEXT NOT NULL CHECK(payload_finality IN ('PCH_HOOK_INPUT','PCH_HOOK_OUTPUT','EXTENSION_CHAIN_FINAL','WIRE_SERIALIZED')),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms>=started_at_ms),
  response_status INTEGER CHECK(response_status IS NULL OR response_status BETWEEN 0 AND 999),
  outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','RESPONDED','FAILED','OUTCOME_UNKNOWN')),
  usage_contribution_sha256 TEXT CHECK(usage_contribution_sha256 IS NULL OR length(usage_contribution_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  PRIMARY KEY(attempt_id,transition_ordinal),
  UNIQUE(prompt_request_id,attempt_number,transition_ordinal),
  CHECK((transition_ordinal=0 AND outcome='STARTED') OR (transition_ordinal=1 AND outcome<>'STARTED')),
  CHECK((outcome='STARTED' AND completed_at_ms IS NULL) OR (outcome<>'STARTED' AND completed_at_ms IS NOT NULL)),
  CHECK(outcome<>'RESPONDED' OR response_status IS NOT NULL)
) STRICT;

CREATE TABLE provider_turn_contributions_v1 (
  contribution_id TEXT PRIMARY KEY,
  prompt_request_id TEXT NOT NULL REFERENCES provider_turn_ledgers_v1(prompt_request_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
  owner TEXT NOT NULL CHECK(owner IN ('PI','INPUT_CONTEXT','MEMORY','OUTPUT','COMPACTION','USER','PROVIDER')),
  input_surface TEXT CHECK(input_surface IS NULL OR input_surface IN ('PI_BASE_SYSTEM','PCH_STABLE_POLICY','PCH_WORKFLOW_CONTROL','PCH_PROTECTED_AUTHORITY','PCH_MEMORY','PCH_EVIDENCE','PCH_TOOL_RESULT','PCH_RESPONSE_DIRECTIVE','PCH_RECOVERY_CAPSULE','PI_NATIVE_COMPACTION_SUMMARY','USER_HISTORY','ASSISTANT_HISTORY','TOOL_SCHEMAS','PROVIDER_FRAMING','UNATTRIBUTED_INPUT')),
  output_surface TEXT CHECK(output_surface IS NULL OR output_surface IN ('ASSISTANT_TEXT','TOOL_CALL_ARGUMENTS','REASONING','NATIVE_COMPACTION_SUMMARY','CUSTOM_COMPACTION_SUMMARY','UNATTRIBUTED_OUTPUT')),
  segment_identity_hmac TEXT CHECK(segment_identity_hmac IS NULL OR length(segment_identity_hmac)=64),
  logical_bytes INTEGER CHECK(logical_bytes IS NULL OR logical_bytes>=0),
  tokens INTEGER CHECK(tokens IS NULL OR tokens>=0),
  evidence TEXT NOT NULL CHECK(evidence IN ('PROVIDER_REPORTED','SERIALIZER_PROVEN','TOKENIZER_PROVEN','LOCAL_ESTIMATE','UNOBSERVABLE')),
  included INTEGER NOT NULL CHECK(included IN (0,1)),
  duplicate_of TEXT REFERENCES provider_turn_contributions_v1(contribution_id),
  contribution_sha256 TEXT NOT NULL UNIQUE CHECK(length(contribution_sha256)=64),
  UNIQUE(prompt_request_id,ordinal),
  CHECK((input_surface IS NULL)<>(output_surface IS NULL)),
  CHECK(duplicate_of IS NULL OR included=0),
  CHECK(evidence<>'UNOBSERVABLE' OR tokens IS NULL)
) STRICT;

CREATE UNIQUE INDEX ux_provider_turn_included_segment_v1
  ON provider_turn_contributions_v1(prompt_request_id,segment_identity_hmac)
  WHERE included=1 AND segment_identity_hmac IS NOT NULL;
CREATE INDEX ix_read_evidence_scope_v1 ON read_evidence_receipts_v1(workspace_id,source_scope_hmac,observed_at_ms DESC,receipt_id DESC);
CREATE INDEX ix_evidence_validity_receipt_v1 ON evidence_validity_transitions_v1(receipt_id,created_at_ms,transition_id);
CREATE INDEX ix_context_working_set_subject_v1 ON context_working_sets_v1(subject_goal_id,subject_kind,subject_id,created_at_ms DESC,working_set_id DESC);
CREATE INDEX ix_context_compile_envelope_v1 ON context_compile_receipts_v1(envelope_sha256,created_at_ms DESC);
CREATE INDEX ix_context_retention_expiry_v1 ON context_retention_roots_v1(workspace_id,expires_at_ms,retention_root_id);
CREATE INDEX ix_context_projection_latest_v1 ON context_projection_receipts_v1(projection_id,transition_ordinal DESC);
CREATE INDEX ix_project_source_subject_v1 ON project_source_manifests_v1(workspace_id,subject_binding_sha256,created_at_ms DESC);
CREATE INDEX ix_project_knowledge_semantic_v1 ON project_knowledge_claims_v1(manifest_id,semantic_key,created_at_ms DESC);
CREATE INDEX ix_provider_turn_attempt_request_v1 ON provider_turn_attempts_v1(prompt_request_id,attempt_number,transition_ordinal);
CREATE INDEX ix_provider_turn_contribution_request_v1 ON provider_turn_contributions_v1(prompt_request_id,ordinal);

CREATE TRIGGER no_update_read_evidence_receipts_v1 BEFORE UPDATE ON read_evidence_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context read evidence receipts are immutable'); END;
CREATE TRIGGER no_delete_read_evidence_receipts_v1 BEFORE DELETE ON read_evidence_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context read evidence receipts are immutable'); END;
CREATE TRIGGER no_update_evidence_validity_transitions_v1 BEFORE UPDATE ON evidence_validity_transitions_v1 BEGIN SELECT RAISE(ABORT, 'Input Context evidence validity transitions are immutable'); END;
CREATE TRIGGER no_delete_evidence_validity_transitions_v1 BEFORE DELETE ON evidence_validity_transitions_v1 BEGIN SELECT RAISE(ABORT, 'Input Context evidence validity transitions are immutable'); END;
CREATE TRIGGER no_update_context_working_sets_v1 BEFORE UPDATE ON context_working_sets_v1 BEGIN SELECT RAISE(ABORT, 'Input Context working sets are immutable'); END;
CREATE TRIGGER no_delete_context_working_sets_v1 BEFORE DELETE ON context_working_sets_v1 BEGIN SELECT RAISE(ABORT, 'Input Context working sets are immutable'); END;
CREATE TRIGGER no_update_context_working_set_items_v1 BEFORE UPDATE ON context_working_set_items_v1 BEGIN SELECT RAISE(ABORT, 'Input Context working set items are immutable'); END;
CREATE TRIGGER no_delete_context_working_set_items_v1 BEFORE DELETE ON context_working_set_items_v1 BEGIN SELECT RAISE(ABORT, 'Input Context working set items are immutable'); END;
CREATE TRIGGER no_update_context_compile_receipts_v1 BEFORE UPDATE ON context_compile_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context compile receipts are immutable'); END;
CREATE TRIGGER no_delete_context_compile_receipts_v1 BEFORE DELETE ON context_compile_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context compile receipts are immutable'); END;
CREATE TRIGGER no_update_context_retention_roots_v1 BEFORE UPDATE ON context_retention_roots_v1 BEGIN SELECT RAISE(ABORT, 'Input Context retention roots are immutable'); END;
CREATE TRIGGER no_delete_context_retention_roots_v1 BEFORE DELETE ON context_retention_roots_v1 BEGIN SELECT RAISE(ABORT, 'Input Context retention roots are immutable'); END;
CREATE TRIGGER no_update_context_tool_surface_plans_v1 BEFORE UPDATE ON context_tool_surface_plans_v1 BEGIN SELECT RAISE(ABORT, 'Input Context tool-surface plans are immutable'); END;
CREATE TRIGGER no_delete_context_tool_surface_plans_v1 BEFORE DELETE ON context_tool_surface_plans_v1 BEGIN SELECT RAISE(ABORT, 'Input Context tool-surface plans are immutable'); END;
CREATE TRIGGER no_update_context_layout_manifests_v1 BEFORE UPDATE ON context_layout_manifests_v1 BEGIN SELECT RAISE(ABORT, 'Input Context layout manifests are immutable'); END;
CREATE TRIGGER no_delete_context_layout_manifests_v1 BEFORE DELETE ON context_layout_manifests_v1 BEGIN SELECT RAISE(ABORT, 'Input Context layout manifests are immutable'); END;
CREATE TRIGGER no_update_context_projection_receipts_v1 BEFORE UPDATE ON context_projection_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context projection receipts are immutable'); END;
CREATE TRIGGER no_delete_context_projection_receipts_v1 BEFORE DELETE ON context_projection_receipts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context projection receipts are immutable'); END;
CREATE TRIGGER no_update_project_source_manifests_v1 BEFORE UPDATE ON project_source_manifests_v1 BEGIN SELECT RAISE(ABORT, 'Input Context project source manifests are immutable'); END;
CREATE TRIGGER no_delete_project_source_manifests_v1 BEFORE DELETE ON project_source_manifests_v1 BEGIN SELECT RAISE(ABORT, 'Input Context project source manifests are immutable'); END;
CREATE TRIGGER no_update_project_knowledge_claims_v1 BEFORE UPDATE ON project_knowledge_claims_v1 BEGIN SELECT RAISE(ABORT, 'Input Context project knowledge claims are immutable'); END;
CREATE TRIGGER no_delete_project_knowledge_claims_v1 BEFORE DELETE ON project_knowledge_claims_v1 BEGIN SELECT RAISE(ABORT, 'Input Context project knowledge claims are immutable'); END;
CREATE TRIGGER no_update_provider_turn_ledgers_v1 BEFORE UPDATE ON provider_turn_ledgers_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn ledgers are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_ledgers_v1 BEFORE DELETE ON provider_turn_ledgers_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn ledgers are immutable'); END;
CREATE TRIGGER no_update_provider_turn_attempts_v1 BEFORE UPDATE ON provider_turn_attempts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn attempts are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_attempts_v1 BEFORE DELETE ON provider_turn_attempts_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn attempts are immutable'); END;
CREATE TRIGGER no_update_provider_turn_contributions_v1 BEFORE UPDATE ON provider_turn_contributions_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn contributions are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_contributions_v1 BEFORE DELETE ON provider_turn_contributions_v1 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn contributions are immutable'); END;
