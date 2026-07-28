PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS experiment_epochs (
  epoch_id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK(module IN ('MEMORY', 'COMPACTION', 'CACHE', 'PLANNING', 'PROJECTION', 'PERFORMANCE', 'OUTPUT')),
  arm TEXT NOT NULL,
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256) = 64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64),
  preregistration_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  created_event_sequence INTEGER CHECK(created_event_sequence IS NULL OR created_event_sequence >= 1),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS experiment_epoch_transitions (
  epoch_id TEXT NOT NULL REFERENCES experiment_epochs(epoch_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  status TEXT NOT NULL CHECK(status IN ('DRAFT', 'RUNNING', 'PASSED', 'FAILED', 'STOPPED', 'STALE', 'INCONCLUSIVE')),
  reason_code TEXT NOT NULL,
  evidence_artifact_id TEXT REFERENCES artifacts(artifact_id),
  created_event_sequence INTEGER CHECK(created_event_sequence IS NULL OR created_event_sequence >= 1),
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY(epoch_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS performance_trials (
  trial_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL REFERENCES experiment_epochs(epoch_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  contract_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  trial_spec_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  opportunity_admission_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  baseline_revision_sha256 TEXT NOT NULL CHECK(length(baseline_revision_sha256) = 64),
  baseline_correctness_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  baseline_metric_evidence_sha256 TEXT NOT NULL CHECK(length(baseline_metric_evidence_sha256) = 64),
  candidate_patch_sha256 TEXT NOT NULL CHECK(length(candidate_patch_sha256) = 64),
  candidate_patch_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  protocol_sha256 TEXT NOT NULL CHECK(length(protocol_sha256) = 64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256) = 64),
  candidate_family_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL CHECK(candidate_index BETWEEN 1 AND 3),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(epoch_id, candidate_family_id, candidate_index)
) STRICT;

CREATE TABLE IF NOT EXISTS telemetry_samples (
  sample_id TEXT PRIMARY KEY,
  epoch_id TEXT REFERENCES experiment_epochs(epoch_id),
  trial_id TEXT REFERENCES performance_trials(trial_id),
  goal_id TEXT REFERENCES goals(goal_id),
  cohort_id TEXT NOT NULL,
  sample_cluster_id TEXT NOT NULL,
  request_sequence INTEGER CHECK(request_sequence IS NULL OR request_sequence >= 0),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256) = 64),
  metric_scope TEXT NOT NULL CHECK(metric_scope IN ('RUNTIME_OVERHEAD', 'TARGET_PROJECT', 'CACHE', 'OUTPUT', 'MEMORY', 'COMPACTION')),
  sample_role TEXT NOT NULL CHECK(sample_role IN ('BASELINE', 'CANDIDATE', 'OBSERVATION')),
  workload_id TEXT,
  metric_id TEXT,
  pair_id TEXT,
  sample_index INTEGER NOT NULL CHECK(sample_index >= 0),
  order_in_pair TEXT NOT NULL CHECK(order_in_pair IN ('BASELINE_FIRST', 'CANDIDATE_FIRST', 'NOT_PAIRED')),
  task_class TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  metrics_sha256 TEXT NOT NULL CHECK(length(metrics_sha256) = 64),
  quality_gate TEXT NOT NULL CHECK(quality_gate IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  recorded_at_ms INTEGER NOT NULL,
  CHECK(
    (sample_role = 'OBSERVATION' AND order_in_pair = 'NOT_PAIRED') OR
    (sample_role IN ('BASELINE', 'CANDIDATE') AND trial_id IS NOT NULL AND workload_id IS NOT NULL AND metric_id IS NOT NULL AND pair_id IS NOT NULL AND order_in_pair <> 'NOT_PAIRED')
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_telemetry_paired_role
ON telemetry_samples(trial_id, workload_id, metric_id, pair_id, sample_role)
WHERE sample_role IN ('BASELINE', 'CANDIDATE');

CREATE TABLE IF NOT EXISTS performance_trial_verdicts (
  verdict_id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES performance_trials(trial_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  sample_set_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  baseline_set_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  candidate_set_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  statistics_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  correctness_receipt_id TEXT REFERENCES receipts(receipt_id),
  holdout_receipt_id TEXT REFERENCES receipts(receipt_id),
  confidence_gate TEXT NOT NULL CHECK(confidence_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  practical_effect_gate TEXT NOT NULL CHECK(practical_effect_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  end_to_end_gate TEXT NOT NULL CHECK(end_to_end_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  regression_gate TEXT NOT NULL CHECK(regression_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  holdout_gate TEXT NOT NULL CHECK(holdout_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  benefit_horizon_gate TEXT NOT NULL CHECK(benefit_horizon_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  environment_gate TEXT NOT NULL CHECK(environment_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  budget_gate TEXT NOT NULL CHECK(budget_gate IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  verdict TEXT NOT NULL CHECK(verdict IN ('PROMOTE', 'REJECT', 'NEED_MORE_EVIDENCE', 'CANCELED')),
  verdict_sha256 TEXT NOT NULL CHECK(length(verdict_sha256) = 64),
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE(trial_id, sequence),
  CHECK(verdict <> 'PROMOTE' OR (correctness_receipt_id IS NOT NULL AND holdout_receipt_id IS NOT NULL AND confidence_gate = 'PASS' AND practical_effect_gate = 'PASS' AND end_to_end_gate = 'PASS' AND regression_gate = 'PASS' AND holdout_gate = 'PASS' AND benefit_horizon_gate = 'PASS' AND environment_gate = 'PASS' AND budget_gate = 'PASS'))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_performance_trial_terminal_verdict
ON performance_trial_verdicts(trial_id)
WHERE verdict IN ('PROMOTE', 'REJECT', 'CANCELED');

CREATE TABLE IF NOT EXISTS prompt_generations (
  prompt_generation_id TEXT PRIMARY KEY,
  parent_prompt_generation_id TEXT REFERENCES prompt_generations(prompt_generation_id),
  epoch_id TEXT REFERENCES experiment_epochs(epoch_id),
  goal_id TEXT REFERENCES goals(goal_id),
  logical_session_hmac_sha256 TEXT NOT NULL CHECK(length(logical_session_hmac_sha256) = 64),
  transport_epoch_hmac_sha256 TEXT NOT NULL CHECK(length(transport_epoch_hmac_sha256) = 64),
  cache_lineage_hmac_sha256 TEXT NOT NULL CHECK(length(cache_lineage_hmac_sha256) = 64),
  lineage_action TEXT NOT NULL CHECK(lineage_action IN ('CREATE', 'CONTINUE', 'ROTATE')),
  prefix_generation INTEGER NOT NULL CHECK(prefix_generation >= 1),
  generation_action TEXT NOT NULL CHECK(generation_action IN ('START', 'INCREMENT')),
  boundary_reason TEXT NOT NULL CHECK(boundary_reason IN ('INITIAL', 'PROVIDER_CHANGED', 'MODEL_CHANGED', 'BASE_URL_OR_API_CHANGED', 'TENANT_OR_SECURITY_EPOCH_CHANGED', 'CACHE_NAMESPACE_CHANGED', 'INSTRUCTION_PRECEDENCE_CHANGED', 'TOOL_SURFACE_CHANGED', 'PLAN_BUILD_SURFACE_CHANGED', 'PROMPT_CONTRACT_CHANGED', 'COMPACTION_REBASE', 'CONTEXT_REPAIR')),
  boundary_policy TEXT NOT NULL CHECK(boundary_policy IN ('IMMEDIATE_REQUIRED', 'STAGE_BOUNDARY_COALESCED', 'NATURAL_COMPACTION')),
  coalesced_change_count INTEGER NOT NULL CHECK(coalesced_change_count >= 1),
  stable_contract_prefix_hmac_sha256 TEXT NOT NULL CHECK(length(stable_contract_prefix_hmac_sha256) = 64),
  provider_prompt_contract_prefix_hmac_sha256 TEXT CHECK(provider_prompt_contract_prefix_hmac_sha256 IS NULL OR length(provider_prompt_contract_prefix_hmac_sha256) = 64),
  prefix_segment_manifest_sha256 TEXT NOT NULL CHECK(length(prefix_segment_manifest_sha256) = 64),
  stable_policy_tokens INTEGER NOT NULL CHECK(stable_policy_tokens >= 0),
  tool_schema_tokens INTEGER NOT NULL CHECK(tool_schema_tokens >= 0),
  generation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE(cache_lineage_hmac_sha256, prefix_generation),
  CHECK(
    (lineage_action = 'CREATE' AND parent_prompt_generation_id IS NULL AND prefix_generation = 1 AND generation_action = 'START' AND boundary_reason = 'INITIAL') OR
    (lineage_action = 'ROTATE' AND parent_prompt_generation_id IS NOT NULL AND prefix_generation = 1 AND generation_action = 'START' AND boundary_reason IN ('PROVIDER_CHANGED', 'MODEL_CHANGED', 'BASE_URL_OR_API_CHANGED', 'TENANT_OR_SECURITY_EPOCH_CHANGED', 'CACHE_NAMESPACE_CHANGED')) OR
    (lineage_action = 'CONTINUE' AND parent_prompt_generation_id IS NOT NULL AND generation_action = 'INCREMENT' AND boundary_reason IN ('INSTRUCTION_PRECEDENCE_CHANGED', 'TOOL_SURFACE_CHANGED', 'PLAN_BUILD_SURFACE_CHANGED', 'PROMPT_CONTRACT_CHANGED', 'COMPACTION_REBASE', 'CONTEXT_REPAIR'))
  ),
  CHECK(boundary_policy <> 'STAGE_BOUNDARY_COALESCED' OR (boundary_reason = 'PROMPT_CONTRACT_CHANGED' AND coalesced_change_count >= 2)),
  CHECK(boundary_policy <> 'NATURAL_COMPACTION' OR boundary_reason = 'COMPACTION_REBASE'),
  CHECK(boundary_reason NOT IN ('INITIAL', 'PROVIDER_CHANGED', 'MODEL_CHANGED', 'BASE_URL_OR_API_CHANGED', 'TENANT_OR_SECURITY_EPOCH_CHANGED', 'CACHE_NAMESPACE_CHANGED', 'INSTRUCTION_PRECEDENCE_CHANGED', 'TOOL_SURFACE_CHANGED', 'PLAN_BUILD_SURFACE_CHANGED', 'CONTEXT_REPAIR') OR boundary_policy = 'IMMEDIATE_REQUIRED')
) STRICT;

CREATE TABLE IF NOT EXISTS prompt_requests (
  prompt_request_id TEXT PRIMARY KEY,
  prompt_generation_id TEXT NOT NULL REFERENCES prompt_generations(prompt_generation_id),
  previous_prompt_request_id TEXT REFERENCES prompt_requests(prompt_request_id),
  request_sequence INTEGER NOT NULL CHECK(request_sequence >= 0),
  history_action TEXT NOT NULL CHECK(history_action IN ('FIRST', 'APPEND', 'RETRY_EQUIVALENT')),
  append_only_verification TEXT NOT NULL CHECK(append_only_verification IN ('VERIFIED', 'UNOBSERVABLE', 'FAILED')),
  logical_request_hmac_sha256 TEXT NOT NULL CHECK(length(logical_request_hmac_sha256) = 64),
  logical_reusable_prefix_hmac_sha256 TEXT CHECK(logical_reusable_prefix_hmac_sha256 IS NULL OR length(logical_reusable_prefix_hmac_sha256) = 64),
  provider_prompt_hmac_sha256 TEXT CHECK(provider_prompt_hmac_sha256 IS NULL OR length(provider_prompt_hmac_sha256) = 64),
  provider_prompt_reusable_prefix_hmac_sha256 TEXT CHECK(provider_prompt_reusable_prefix_hmac_sha256 IS NULL OR length(provider_prompt_reusable_prefix_hmac_sha256) = 64),
  provider_prompt_contract_sha256 TEXT NOT NULL CHECK(length(provider_prompt_contract_sha256) = 64),
  provider_prompt_observability TEXT NOT NULL CHECK(provider_prompt_observability IN ('EXACT_AFTER_HOOK', 'PROVIDER_DECLARED', 'UNOBSERVABLE')),
  reusable_prefix_method TEXT NOT NULL CHECK(reusable_prefix_method IN ('EXACT_PROVIDER_PROMPT_SEQUENCE_LCP', 'PROVIDER_DECLARED_EQUIVALENT', 'UNOBSERVABLE')),
  total_input_tokens INTEGER CHECK(total_input_tokens IS NULL OR total_input_tokens >= 0),
  provider_prompt_tokens INTEGER CHECK(provider_prompt_tokens IS NULL OR provider_prompt_tokens >= 0),
  stable_contract_prefix_tokens INTEGER CHECK(stable_contract_prefix_tokens IS NULL OR stable_contract_prefix_tokens >= 0),
  provider_prompt_lcp_tokens INTEGER CHECK(provider_prompt_lcp_tokens IS NULL OR provider_prompt_lcp_tokens >= 0),
  dynamic_suffix_tokens INTEGER CHECK(dynamic_suffix_tokens IS NULL OR dynamic_suffix_tokens >= 0),
  response_directive_input_tokens INTEGER NOT NULL CHECK(response_directive_input_tokens >= 0),
  tokenizer_source TEXT NOT NULL CHECK(tokenizer_source IN ('PROVIDER', 'PI_NORMALIZED', 'LOCAL_ESTIMATE', 'UNOBSERVABLE')),
  response_contract_artifact_id TEXT REFERENCES artifacts(artifact_id),
  directive_profile TEXT NOT NULL CHECK(directive_profile IN ('STABLE_POLICY_ONLY', 'COMPACT_SUFFIX', 'USER_FORMAT')),
  observation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE(prompt_generation_id, request_sequence),
  UNIQUE(previous_prompt_request_id),
  CHECK(provider_prompt_lcp_tokens IS NULL OR provider_prompt_tokens IS NULL OR provider_prompt_lcp_tokens <= provider_prompt_tokens),
  CHECK(provider_prompt_tokens IS NULL OR total_input_tokens IS NULL OR provider_prompt_tokens <= total_input_tokens),
  CHECK(
    (history_action = 'FIRST' AND previous_prompt_request_id IS NULL AND coalesce(provider_prompt_lcp_tokens, 0) = 0 AND logical_reusable_prefix_hmac_sha256 IS NULL AND provider_prompt_reusable_prefix_hmac_sha256 IS NULL) OR
    (history_action IN ('APPEND', 'RETRY_EQUIVALENT') AND previous_prompt_request_id IS NOT NULL)
  ),
  CHECK(history_action <> 'RETRY_EQUIVALENT' OR append_only_verification = 'VERIFIED'),
  CHECK(reusable_prefix_method <> 'EXACT_PROVIDER_PROMPT_SEQUENCE_LCP' OR (provider_prompt_observability = 'EXACT_AFTER_HOOK' AND provider_prompt_hmac_sha256 IS NOT NULL AND provider_prompt_reusable_prefix_hmac_sha256 IS NOT NULL AND tokenizer_source <> 'UNOBSERVABLE'))
) STRICT;

CREATE TABLE IF NOT EXISTS cache_observations (
  observation_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES experiment_epochs(epoch_id),
  goal_id TEXT REFERENCES goals(goal_id),
  prompt_generation_id TEXT NOT NULL REFERENCES prompt_generations(prompt_generation_id),
  prompt_request_id TEXT NOT NULL REFERENCES prompt_requests(prompt_request_id),
  request_sequence INTEGER NOT NULL CHECK(request_sequence >= 0),
  provider_fingerprint_hmac_sha256 TEXT NOT NULL CHECK(length(provider_fingerprint_hmac_sha256) = 64),
  model_fingerprint_hmac_sha256 TEXT NOT NULL CHECK(length(model_fingerprint_hmac_sha256) = 64),
  cache_lineage_hmac_sha256 TEXT NOT NULL CHECK(length(cache_lineage_hmac_sha256) = 64),
  prefix_generation INTEGER NOT NULL CHECK(prefix_generation >= 1),
  stable_contract_prefix_hmac_sha256 TEXT NOT NULL CHECK(length(stable_contract_prefix_hmac_sha256) = 64),
  provider_prompt_reusable_prefix_hmac_sha256 TEXT CHECK(provider_prompt_reusable_prefix_hmac_sha256 IS NULL OR length(provider_prompt_reusable_prefix_hmac_sha256) = 64),
  fingerprint_method TEXT NOT NULL CHECK(fingerprint_method = 'HMAC_SHA256_INSTALL_SCOPED'),
  transport_contract_sha256 TEXT NOT NULL CHECK(length(transport_contract_sha256) = 64),
  state TEXT NOT NULL CHECK(state IN ('INELIGIBLE', 'COLD_START', 'HIT', 'MISS', 'UNOBSERVABLE', 'ERROR')),
  eligibility_reason TEXT NOT NULL CHECK(eligibility_reason IN ('SUPPORTED_WARM', 'FIRST_GENERATION_REQUEST', 'PROVIDER_UNSUPPORTED', 'MODEL_UNSUPPORTED', 'BELOW_MINIMUM', 'REQUEST_TYPE', 'TRANSPORT_RETRY', 'PREFIX_CHANGED', 'RETENTION_EXPIRED', 'AFFINITY_UNPROVEN', 'USAGE_UNPROVEN', 'TRANSPORT_UNOBSERVABLE')),
  eligible INTEGER NOT NULL CHECK(eligible IN (0, 1)),
  append_only_verified INTEGER NOT NULL CHECK(append_only_verified IN (0, 1)),
  total_input_tokens INTEGER CHECK(total_input_tokens IS NULL OR total_input_tokens >= 0),
  provider_prompt_lcp_tokens INTEGER CHECK(provider_prompt_lcp_tokens IS NULL OR provider_prompt_lcp_tokens >= 0),
  eligible_prefix_tokens INTEGER CHECK(eligible_prefix_tokens IS NULL OR eligible_prefix_tokens >= 0),
  provider_minimum_tokens INTEGER CHECK(provider_minimum_tokens IS NULL OR provider_minimum_tokens >= 0),
  provider_granularity_tokens INTEGER CHECK(provider_granularity_tokens IS NULL OR provider_granularity_tokens >= 1),
  denominator_method TEXT NOT NULL CHECK(denominator_method IN ('PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED', 'PROVIDER_DECLARED_EQUIVALENT', 'UNOBSERVABLE')),
  retention_contract_receipt_sha256 TEXT CHECK(retention_contract_receipt_sha256 IS NULL OR length(retention_contract_receipt_sha256) = 64),
  retention_mode TEXT NOT NULL CHECK(retention_mode IN ('UNKNOWN', 'PROVIDER_EPHEMERAL', 'VERIFIED_TTL', 'VERIFIED_SESSION')),
  verified_min_ttl_ms INTEGER CHECK(verified_min_ttl_ms IS NULL OR verified_min_ttl_ms >= 0),
  inter_request_gap_ms INTEGER CHECK(inter_request_gap_ms IS NULL OR inter_request_gap_ms >= 0),
  within_verified_window INTEGER CHECK(within_verified_window IS NULL OR within_verified_window IN (0, 1)),
  usage_contract_receipt_sha256 TEXT CHECK(usage_contract_receipt_sha256 IS NULL OR length(usage_contract_receipt_sha256) = 64),
  total_input_definition TEXT NOT NULL CHECK(total_input_definition IN ('INCLUDES_CACHE_READ', 'UNCACHED_PLUS_CACHE_READ_AND_WRITE', 'UNKNOWN')),
  cache_read_scope TEXT NOT NULL CHECK(cache_read_scope IN ('PROVIDER_PROMPT_REUSABLE_PREFIX', 'UNKNOWN')),
  uncached_input_tokens INTEGER CHECK(uncached_input_tokens IS NULL OR uncached_input_tokens >= 0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  usage_observable INTEGER NOT NULL CHECK(usage_observable IN (0, 1)),
  pi_compatible_latest_hit_rate REAL CHECK(pi_compatible_latest_hit_rate IS NULL OR pi_compatible_latest_hit_rate BETWEEN 0 AND 1),
  warm_eligible_token_hit_rate REAL CHECK(warm_eligible_token_hit_rate IS NULL OR warm_eligible_token_hit_rate BETWEEN 0 AND 1),
  miss_attribution TEXT NOT NULL CHECK(miss_attribution IN ('NOT_APPLICABLE', 'PROVIDER_EVICTION_OR_CAPACITY', 'AFFINITY_OR_ROUTING', 'PROVIDER_POLICY', 'UNKNOWN')),
  latency_ms REAL CHECK(latency_ms IS NULL OR latency_ms >= 0),
  quality_gate TEXT NOT NULL CHECK(quality_gate IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  observation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE(epoch_id, prompt_request_id),
  CHECK(eligible_prefix_tokens IS NULL OR provider_prompt_lcp_tokens IS NULL OR eligible_prefix_tokens <= provider_prompt_lcp_tokens),
  CHECK(provider_prompt_lcp_tokens IS NULL OR total_input_tokens IS NULL OR provider_prompt_lcp_tokens <= total_input_tokens),
  CHECK(state NOT IN ('HIT', 'MISS') OR (eligible = 1 AND append_only_verified = 1 AND eligibility_reason = 'SUPPORTED_WARM' AND usage_observable = 1 AND usage_contract_receipt_sha256 IS NOT NULL AND retention_contract_receipt_sha256 IS NOT NULL AND within_verified_window = 1 AND cache_read_scope = 'PROVIDER_PROMPT_REUSABLE_PREFIX' AND denominator_method <> 'UNOBSERVABLE')),
  CHECK(state <> 'HIT' OR cache_read_tokens > 0),
  CHECK(state <> 'MISS' OR cache_read_tokens = 0),
  CHECK(state <> 'UNOBSERVABLE' OR usage_observable = 0),
  CHECK(state <> 'INELIGIBLE' OR eligible = 0),
  CHECK(eligibility_reason <> 'TRANSPORT_RETRY' OR (eligible = 0 AND state = 'INELIGIBLE')),
  CHECK(cache_read_tokens IS NULL OR eligible_prefix_tokens IS NULL OR cache_read_scope <> 'PROVIDER_PROMPT_REUSABLE_PREFIX' OR cache_read_tokens <= eligible_prefix_tokens),
  CHECK((state = 'MISS' AND miss_attribution <> 'NOT_APPLICABLE') OR (state <> 'MISS' AND miss_attribution = 'NOT_APPLICABLE'))
) STRICT;

CREATE TABLE IF NOT EXISTS output_observations (
  observation_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES experiment_epochs(epoch_id),
  goal_id TEXT REFERENCES goals(goal_id),
  response_contract_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  prompt_request_id TEXT REFERENCES prompt_requests(prompt_request_id),
  emission_origin TEXT NOT NULL CHECK(emission_origin IN ('USER_REQUEST', 'LOCAL_COMMAND', 'LOCAL_PROGRESS', 'ROUTINE_CHECKPOINT', 'TELEMETRY', 'STAGE_TRANSITION', 'FAILURE', 'FINALIZATION')),
  execution_path TEXT NOT NULL CHECK(execution_path IN ('LOCAL_ONLY', 'AGENT_TURN')),
  response_class TEXT NOT NULL CHECK(response_class IN ('SILENT_LOCAL', 'TOOL_ACTION', 'ACK', 'QUESTION', 'STATUS', 'RESULT', 'AUDIT', 'USER_FORMAT')),
  provider_requests INTEGER NOT NULL CHECK(provider_requests >= 0),
  generation_accounting TEXT NOT NULL CHECK(generation_accounting IN ('PROVIDER_SPLIT', 'PROVIDER_TOTAL_LOCAL_SPLIT_ESTIMATE', 'INCOMPLETE', 'NOT_APPLICABLE')),
  generated_output_tokens INTEGER CHECK(generated_output_tokens IS NULL OR generated_output_tokens >= 0),
  assistant_text_tokens INTEGER CHECK(assistant_text_tokens IS NULL OR assistant_text_tokens >= 0),
  tool_call_argument_tokens INTEGER CHECK(tool_call_argument_tokens IS NULL OR tool_call_argument_tokens >= 0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  unattributed_output_tokens INTEGER CHECK(unattributed_output_tokens IS NULL OR unattributed_output_tokens >= 0),
  provider_output_includes_reasoning INTEGER CHECK(provider_output_includes_reasoning IS NULL OR provider_output_includes_reasoning IN (0, 1)),
  stop_reason TEXT NOT NULL CHECK(stop_reason IN ('stop', 'length', 'toolUse', 'error', 'aborted', 'LOCAL_NOT_APPLICABLE')),
  completion_gate TEXT NOT NULL CHECK(completion_gate IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  user_answer_obligation TEXT NOT NULL CHECK(user_answer_obligation IN ('NONE', 'PENDING', 'FULFILLED')),
  completion_evidence_artifact_id TEXT REFERENCES artifacts(artifact_id),
  response_directive_input_tokens INTEGER CHECK(response_directive_input_tokens IS NULL OR response_directive_input_tokens >= 0),
  tool_result_source_tokens INTEGER CHECK(tool_result_source_tokens IS NULL OR tool_result_source_tokens >= 0),
  tool_context_tokens INTEGER CHECK(tool_context_tokens IS NULL OR tool_context_tokens >= 0),
  tool_context_avoided_tokens INTEGER CHECK(tool_context_avoided_tokens IS NULL OR tool_context_avoided_tokens >= 0),
  rendered_output_chars INTEGER NOT NULL CHECK(rendered_output_chars >= 0),
  artifact_bytes INTEGER NOT NULL CHECK(artifact_bytes >= 0),
  suppressed_progress_events INTEGER NOT NULL CHECK(suppressed_progress_events >= 0),
  duplicate_output_tokens_estimate INTEGER CHECK(duplicate_output_tokens_estimate IS NULL OR duplicate_output_tokens_estimate >= 0),
  first_pass_acceptance_closed INTEGER CHECK(first_pass_acceptance_closed IS NULL OR first_pass_acceptance_closed IN (0, 1)),
  omission_followup_count INTEGER NOT NULL CHECK(omission_followup_count >= 0),
  reopen_count INTEGER NOT NULL CHECK(reopen_count >= 0),
  quality_gate TEXT NOT NULL CHECK(quality_gate IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  recorded_at_ms INTEGER NOT NULL,
  CHECK(response_class <> 'SILENT_LOCAL' OR (execution_path = 'LOCAL_ONLY' AND provider_requests = 0 AND generation_accounting = 'NOT_APPLICABLE' AND generated_output_tokens IS NULL AND assistant_text_tokens IS NULL AND tool_call_argument_tokens IS NULL AND reasoning_tokens IS NULL AND unattributed_output_tokens IS NULL AND provider_output_includes_reasoning IS NULL AND prompt_request_id IS NULL AND stop_reason = 'LOCAL_NOT_APPLICABLE' AND user_answer_obligation = 'NONE')),
  CHECK(generation_accounting NOT IN ('PROVIDER_SPLIT', 'PROVIDER_TOTAL_LOCAL_SPLIT_ESTIMATE') OR (provider_output_includes_reasoning = 1 AND generated_output_tokens = assistant_text_tokens + tool_call_argument_tokens + reasoning_tokens + unattributed_output_tokens)),
  CHECK(stop_reason <> 'length' OR (completion_gate = 'FAIL' AND user_answer_obligation <> 'FULFILLED'))
) STRICT;

CREATE TABLE IF NOT EXISTS tool_result_projections (
  projection_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  tool_result_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  classification TEXT NOT NULL CHECK(classification IN ('AUTHORITATIVE_REQUIRED', 'REQUERYABLE', 'BULK_EVIDENCE', 'ERROR', 'UNKNOWN')),
  evidence_liveness TEXT NOT NULL CHECK(evidence_liveness IN ('LIVE', 'CLOSED', 'UNKNOWN')),
  strategy TEXT NOT NULL CHECK(strategy IN ('INLINE_FULL', 'INLINE_BOUNDED_WITH_CAS', 'CAS_POINTER', 'REQUERY_POINTER')),
  source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
  estimated_source_tokens INTEGER CHECK(estimated_source_tokens IS NULL OR estimated_source_tokens >= 0),
  projected_tokens INTEGER CHECK(projected_tokens IS NULL OR projected_tokens >= 0),
  avoided_tokens INTEGER CHECK(avoided_tokens IS NULL OR avoided_tokens >= 0),
  artifact_id TEXT REFERENCES artifacts(artifact_id),
  projection_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  quality_gate TEXT NOT NULL CHECK(quality_gate IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  recorded_at_ms INTEGER NOT NULL,
  CHECK(strategy NOT IN ('INLINE_BOUNDED_WITH_CAS', 'CAS_POINTER') OR artifact_id IS NOT NULL),
  CHECK(strategy <> 'REQUERY_POINTER' OR (classification = 'REQUERYABLE' AND evidence_liveness = 'CLOSED'))
) STRICT;

CREATE TABLE IF NOT EXISTS performance_windows (
  window_id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('BYPASS', 'LIGHT', 'STANDARD', 'FULL')),
  sample_count INTEGER NOT NULL CHECK(sample_count >= 1),
  p50_ms REAL NOT NULL CHECK(p50_ms >= 0),
  p95_ms REAL NOT NULL CHECK(p95_ms >= 0),
  budget_result TEXT NOT NULL CHECK(budget_result IN ('PASS', 'FAIL', 'INSUFFICIENT')),
  action TEXT NOT NULL CHECK(action IN ('CONTINUE', 'BYPASS_OPTIONAL', 'DISABLE_OPTIONAL', 'BLOCK_PROMOTION')),
  metrics_sha256 TEXT NOT NULL CHECK(length(metrics_sha256) = 64),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS no_update_experiment_epochs BEFORE UPDATE ON experiment_epochs BEGIN SELECT RAISE(ABORT, 'experiment epochs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_experiment_epochs BEFORE DELETE ON experiment_epochs BEGIN SELECT RAISE(ABORT, 'experiment epochs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_experiment_epoch_transitions BEFORE UPDATE ON experiment_epoch_transitions BEGIN SELECT RAISE(ABORT, 'experiment epoch transitions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_experiment_epoch_transitions BEFORE DELETE ON experiment_epoch_transitions BEGIN SELECT RAISE(ABORT, 'experiment epoch transitions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_telemetry_samples BEFORE UPDATE ON telemetry_samples BEGIN SELECT RAISE(ABORT, 'telemetry samples are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_telemetry_samples BEFORE DELETE ON telemetry_samples BEGIN SELECT RAISE(ABORT, 'telemetry samples are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_performance_trials BEFORE UPDATE ON performance_trials BEGIN SELECT RAISE(ABORT, 'performance trials are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_performance_trials BEFORE DELETE ON performance_trials BEGIN SELECT RAISE(ABORT, 'performance trials are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_performance_trial_verdicts BEFORE UPDATE ON performance_trial_verdicts BEGIN SELECT RAISE(ABORT, 'performance trial verdicts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_performance_trial_verdicts BEFORE DELETE ON performance_trial_verdicts BEGIN SELECT RAISE(ABORT, 'performance trial verdicts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_prompt_generations BEFORE UPDATE ON prompt_generations BEGIN SELECT RAISE(ABORT, 'prompt generations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_prompt_generations BEFORE DELETE ON prompt_generations BEGIN SELECT RAISE(ABORT, 'prompt generations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_prompt_requests BEFORE UPDATE ON prompt_requests BEGIN SELECT RAISE(ABORT, 'prompt requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_prompt_requests BEFORE DELETE ON prompt_requests BEGIN SELECT RAISE(ABORT, 'prompt requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_cache_observations BEFORE UPDATE ON cache_observations BEGIN SELECT RAISE(ABORT, 'cache observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_cache_observations BEFORE DELETE ON cache_observations BEGIN SELECT RAISE(ABORT, 'cache observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_output_observations BEFORE UPDATE ON output_observations BEGIN SELECT RAISE(ABORT, 'output observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_output_observations BEFORE DELETE ON output_observations BEGIN SELECT RAISE(ABORT, 'output observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_tool_result_projections BEFORE UPDATE ON tool_result_projections BEGIN SELECT RAISE(ABORT, 'tool result projections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_tool_result_projections BEFORE DELETE ON tool_result_projections BEGIN SELECT RAISE(ABORT, 'tool result projections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_performance_windows BEFORE UPDATE ON performance_windows BEGIN SELECT RAISE(ABORT, 'performance windows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_performance_windows BEFORE DELETE ON performance_windows BEGIN SELECT RAISE(ABORT, 'performance windows are immutable'); END;

CREATE INDEX IF NOT EXISTS ix_epoch_transitions_status ON experiment_epoch_transitions(status, recorded_at_ms);
CREATE INDEX IF NOT EXISTS ix_telemetry_epoch ON telemetry_samples(epoch_id, cohort_id, recorded_at_ms);
CREATE INDEX IF NOT EXISTS ix_trials_goal_stage ON performance_trials(goal_id, stage_id, created_at_ms);
CREATE INDEX IF NOT EXISTS ix_trial_verdicts_trial ON performance_trial_verdicts(trial_id, sequence);
CREATE INDEX IF NOT EXISTS ix_prompt_generation_goal ON prompt_generations(goal_id, recorded_at_ms);
CREATE INDEX IF NOT EXISTS ix_prompt_request_generation ON prompt_requests(prompt_generation_id, request_sequence);
CREATE INDEX IF NOT EXISTS ix_cache_epoch_state ON cache_observations(epoch_id, state, recorded_at_ms);
CREATE INDEX IF NOT EXISTS ix_output_epoch_class ON output_observations(epoch_id, response_class, recorded_at_ms);
CREATE INDEX IF NOT EXISTS ix_tool_result_projection_goal ON tool_result_projections(goal_id, recorded_at_ms);

COMMIT;
