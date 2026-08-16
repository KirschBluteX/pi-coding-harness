-- Standard Provider Invocation Protocol. Every PCH-added Worker provider
-- session is planned and fenced in the same authority event that leases its
-- TaskPacket. Provider output remains an unverified proposal until a fresh
-- Host oracle accepts it.

CREATE TEMP TABLE provider_v2_upgrade_guard(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO provider_v2_upgrade_guard(ok)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM execution_node_heads_v2 WHERE status IN ('LEASED','PROPOSAL_SUBMITTED')
) THEN 0 ELSE 1 END;
DROP TABLE provider_v2_upgrade_guard;

CREATE TABLE provider_redaction_receipts_v1 (
  redaction_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  node_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  minimum_input_closure_sha256 TEXT NOT NULL CHECK(length(minimum_input_closure_sha256)=64),
  privacy_class TEXT NOT NULL CHECK(privacy_class IN ('PUBLIC','INTERNAL','SENSITIVE','SECRET')),
  allowed_fields_root_sha256 TEXT NOT NULL CHECK(length(allowed_fields_root_sha256)=64),
  decision TEXT NOT NULL CHECK(decision='ALLOW'),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(packet_id) REFERENCES task_packets_v2(packet_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(redaction_receipt_id,goal_id,run_id,packet_id,record_sha256)
) STRICT;

CREATE TABLE provider_call_plans_v1 (
  provider_call_plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  logical_request_id TEXT NOT NULL CHECK(length(logical_request_id) BETWEEN 1 AND 256),
  plan_nonce_sha256 TEXT NOT NULL CHECK(length(plan_nonce_sha256)=64),
  request_class TEXT NOT NULL CHECK(request_class IN ('WORKER','EVALUATOR','EXPLORATORY')),
  purpose_kind TEXT NOT NULL CHECK(purpose_kind IN (
    'TASK_EXECUTION','UNCERTAINTY_REDUCTION','INDEPENDENT_EVALUATION',
    'INDEPENDENT_CRITIQUE','CANDIDATE_DIVERSIFICATION'
  )),
  uncertainty_id TEXT NOT NULL CHECK(length(uncertainty_id) BETWEEN 1 AND 256),
  uncertainty_sha256 TEXT NOT NULL CHECK(length(uncertainty_sha256)=64),
  expected_information_gain_basis_points INTEGER NOT NULL
    CHECK(expected_information_gain_basis_points BETWEEN 1 AND 10000),
  expected_information_gain_evidence_sha256 TEXT NOT NULL CHECK(length(expected_information_gain_evidence_sha256)=64),
  expected_loss_if_skipped_basis_points INTEGER NOT NULL
    CHECK(expected_loss_if_skipped_basis_points BETWEEN 1 AND 10000),
  expected_loss_if_skipped_evidence_sha256 TEXT NOT NULL CHECK(length(expected_loss_if_skipped_evidence_sha256)=64),
  minimum_input_closure_sha256 TEXT NOT NULL CHECK(length(minimum_input_closure_sha256)=64),
  privacy_class TEXT NOT NULL CHECK(privacy_class IN ('PUBLIC','INTERNAL','SENSITIVE','SECRET')),
  allowed_fields_root_sha256 TEXT NOT NULL CHECK(length(allowed_fields_root_sha256)=64),
  allowed_field_count INTEGER NOT NULL CHECK(allowed_field_count BETWEEN 1 AND 256),
  redaction_receipt_id TEXT NOT NULL,
  redaction_receipt_sha256 TEXT NOT NULL CHECK(length(redaction_receipt_sha256)=64),
  provider_profile_source TEXT NOT NULL
    CHECK(provider_profile_source IN ('SUPERVISOR_INHERITED','PI_CONFIG','SUPERVISOR_FALLBACK')),
  provider_source_profile_id TEXT CHECK(provider_source_profile_id IS NULL OR length(provider_source_profile_id) BETWEEN 1 AND 256),
  provider_fallback_reason TEXT CHECK(provider_fallback_reason IS NULL OR provider_fallback_reason IN ('MODEL_NOT_FOUND','AUTH_NOT_CONFIGURED')),
  provider_profile_sha256 TEXT NOT NULL CHECK(length(provider_profile_sha256)=64),
  current_pi_config_sha256 TEXT NOT NULL CHECK(length(current_pi_config_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  budget_envelope_sha256 TEXT NOT NULL CHECK(length(budget_envelope_sha256)=64),
  soft_max_requests INTEGER NOT NULL CHECK(soft_max_requests BETWEEN 1 AND 256),
  soft_max_input_tokens INTEGER NOT NULL CHECK(soft_max_input_tokens BETWEEN 1 AND 10000000),
  soft_max_output_tokens INTEGER NOT NULL CHECK(soft_max_output_tokens BETWEEN 1 AND 10000000),
  soft_max_cost_microusd INTEGER NOT NULL CHECK(soft_max_cost_microusd>=0),
  soft_max_latency_ms INTEGER NOT NULL CHECK(soft_max_latency_ms BETWEEN 1 AND 86400000),
  deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>=1),
  admission_reason TEXT NOT NULL CHECK(admission_reason IN (
    'REDUCE_MATERIAL_UNCERTAINTY','INDEPENDENT_RISK_COVERAGE',
    'PARALLEL_CRITICAL_PATH','DIVERSE_CANDIDATES_WITH_EXPECTED_GAIN'
  )),
  cache_mode TEXT NOT NULL CHECK(cache_mode IN ('C0','C1')),
  cache_lineage_sha256 TEXT CHECK(cache_lineage_sha256 IS NULL OR length(cache_lineage_sha256)=64),
  cache_adapter_integration_id TEXT CHECK(cache_adapter_integration_id IS NULL OR length(cache_adapter_integration_id) BETWEEN 1 AND 256),
  cache_adapter_security_epoch TEXT CHECK(cache_adapter_security_epoch IS NULL OR length(cache_adapter_security_epoch) BETWEEN 1 AND 256),
  cache_adapter_usage_semantics_id TEXT NOT NULL CHECK(length(cache_adapter_usage_semantics_id) BETWEEN 1 AND 256),
  session_capability TEXT NOT NULL CHECK(session_capability IN ('NONE','ADAPTER_DECLARED_AFFINITY')),
  session_capability_sha256 TEXT CHECK(session_capability_sha256 IS NULL OR length(session_capability_sha256)=64),
  success_evidence_kind TEXT NOT NULL CHECK(success_evidence_kind IN (
    'TYPED_WORKER_PROPOSAL','TYPED_EVALUATION_PROPOSAL','TYPED_EXPLORATION_PROPOSAL'
  )),
  success_output_schema_sha256 TEXT NOT NULL CHECK(length(success_output_schema_sha256)=64),
  success_evidence_requirement_sha256 TEXT NOT NULL CHECK(length(success_evidence_requirement_sha256)=64),
  local_oracle_owner TEXT NOT NULL CHECK(local_oracle_owner='HOST'),
  local_oracle_sha256 TEXT NOT NULL CHECK(length(local_oracle_sha256)=64),
  fallback_kind TEXT NOT NULL CHECK(fallback_kind IN ('LOCAL_REPLAN','ASK_USER','DEFER','ABORT_BRANCH')),
  fallback_evidence_sha256 TEXT NOT NULL CHECK(length(fallback_evidence_sha256)=64),
  attempt_limit INTEGER NOT NULL CHECK(attempt_limit BETWEEN 1 AND 16),
  transport_request_limit INTEGER NOT NULL CHECK(transport_request_limit BETWEEN 1 AND 256),
  fan_out_limit INTEGER NOT NULL CHECK(fan_out_limit BETWEEN 1 AND 8),
  fan_out_independence_evidence_sha256 TEXT
    CHECK(fan_out_independence_evidence_sha256 IS NULL OR length(fan_out_independence_evidence_sha256)=64),
  fan_out_branch_count INTEGER NOT NULL CHECK(fan_out_branch_count BETWEEN 0 AND 8),
  no_progress_limit INTEGER NOT NULL CHECK(no_progress_limit BETWEEN 1 AND 16),
  evidence_saturation_sha256 TEXT NOT NULL CHECK(length(evidence_saturation_sha256)=64),
  stop_condition_count INTEGER NOT NULL CHECK(stop_condition_count=7),
  provider_output_authority TEXT NOT NULL CHECK(provider_output_authority='UNVERIFIED_PROPOSAL'),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  record_json TEXT NOT NULL CHECK(
    json_valid(record_json) AND json_type(record_json)='object' AND length(record_json)<=1048576
  ),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(packet_id) REFERENCES task_packets_v2(packet_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(redaction_receipt_id,goal_id,run_id,packet_id,redaction_receipt_sha256)
    REFERENCES provider_redaction_receipts_v1(redaction_receipt_id,goal_id,run_id,packet_id,record_sha256),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(provider_call_plan_id,goal_id,run_id,packet_id,record_sha256),
  CHECK((provider_profile_source='SUPERVISOR_INHERITED'
      AND provider_source_profile_id IS NULL AND provider_fallback_reason IS NULL)
    OR (provider_profile_source='PI_CONFIG'
      AND provider_source_profile_id IS NOT NULL AND provider_fallback_reason IS NULL)
    OR (provider_profile_source='SUPERVISOR_FALLBACK'
      AND provider_source_profile_id IS NOT NULL AND provider_fallback_reason IS NOT NULL)),
  CHECK((cache_mode='C0' AND cache_lineage_sha256 IS NULL
      AND cache_adapter_integration_id IS NULL AND cache_adapter_security_epoch IS NULL
      AND session_capability='NONE' AND session_capability_sha256 IS NULL)
    OR (cache_mode='C1' AND cache_lineage_sha256 IS NOT NULL
      AND cache_adapter_integration_id IS NOT NULL AND cache_adapter_security_epoch IS NOT NULL
      AND ((session_capability='NONE' AND session_capability_sha256 IS NULL)
        OR (session_capability='ADAPTER_DECLARED_AFFINITY' AND session_capability_sha256 IS NOT NULL)))),
  CHECK((fan_out_limit=1 AND fan_out_independence_evidence_sha256 IS NULL AND fan_out_branch_count=0)
    OR (fan_out_limit>1 AND fan_out_independence_evidence_sha256 IS NOT NULL
      AND fan_out_branch_count=fan_out_limit
      AND purpose_kind IN ('INDEPENDENT_EVALUATION','INDEPENDENT_CRITIQUE','CANDIDATE_DIVERSIFICATION'))),
  CHECK(no_progress_limit<=transport_request_limit
    AND attempt_limit*transport_request_limit*fan_out_limit<=4096),
  CHECK(soft_max_requests>=fan_out_limit AND soft_max_requests<=transport_request_limit),
  CHECK(deadline_at_ms>created_at_ms AND soft_max_latency_ms<=deadline_at_ms-created_at_ms),
  CHECK((request_class='WORKER' AND success_evidence_kind='TYPED_WORKER_PROPOSAL'
      AND purpose_kind IN ('TASK_EXECUTION','UNCERTAINTY_REDUCTION','CANDIDATE_DIVERSIFICATION'))
    OR (request_class='EVALUATOR' AND success_evidence_kind='TYPED_EVALUATION_PROPOSAL'
      AND purpose_kind IN ('INDEPENDENT_EVALUATION','INDEPENDENT_CRITIQUE'))
    OR (request_class='EXPLORATORY' AND success_evidence_kind='TYPED_EXPLORATION_PROPOSAL'
      AND purpose_kind IN ('UNCERTAINTY_REDUCTION','INDEPENDENT_CRITIQUE','CANDIDATE_DIVERSIFICATION'))),
  CHECK((purpose_kind='CANDIDATE_DIVERSIFICATION' AND admission_reason='DIVERSE_CANDIDATES_WITH_EXPECTED_GAIN')
    OR (purpose_kind IN ('INDEPENDENT_EVALUATION','INDEPENDENT_CRITIQUE')
      AND admission_reason='INDEPENDENT_RISK_COVERAGE')
    OR (purpose_kind='UNCERTAINTY_REDUCTION' AND admission_reason='REDUCE_MATERIAL_UNCERTAINTY')
    OR (purpose_kind='TASK_EXECUTION' AND admission_reason IN ('REDUCE_MATERIAL_UNCERTAINTY','PARALLEL_CRITICAL_PATH'))),
  CHECK(json_type(record_json,'$.schema_version')='integer' AND json_extract(record_json,'$.schema_version')=1),
  CHECK(json_type(record_json,'$.provider_call_plan_id')='text'
    AND json_extract(record_json,'$.provider_call_plan_id')=provider_call_plan_id),
  CHECK(json_type(record_json,'$.goal_id')='text' AND json_extract(record_json,'$.goal_id')=goal_id),
  CHECK(json_type(record_json,'$.run_id')='text' AND json_extract(record_json,'$.run_id')=run_id),
  CHECK(json_type(record_json,'$.graph_revision_id')='text'
    AND json_extract(record_json,'$.graph_revision_id')=execution_graph_revision_id),
  CHECK(json_type(record_json,'$.node_id')='text' AND json_extract(record_json,'$.node_id')=node_id),
  CHECK(json_type(record_json,'$.packet_id')='text' AND json_extract(record_json,'$.packet_id')=packet_id),
  CHECK(json_type(record_json,'$.record_sha256')='text' AND json_extract(record_json,'$.record_sha256')=record_sha256),
  CHECK(json_type(record_json,'$.provider_profile_sha256')='text'
    AND json_extract(record_json,'$.provider_profile_sha256')=provider_profile_sha256),
  CHECK(json_type(record_json,'$.provider_output_authority')='text'
    AND json_extract(record_json,'$.provider_output_authority')='UNVERIFIED_PROPOSAL'),
  CHECK(json_type(record_json,'$.allowed_fields')='array'
    AND json_array_length(json_extract(record_json,'$.allowed_fields'))=allowed_field_count),
  CHECK(json_type(record_json,'$.fan_out_branch_information_sha256s')='array'
    AND json_array_length(json_extract(record_json,'$.fan_out_branch_information_sha256s'))=fan_out_branch_count),
  CHECK(json_type(record_json,'$.stop_conditions')='array'
    AND json_array_length(json_extract(record_json,'$.stop_conditions'))=stop_condition_count)
) STRICT;

CREATE TABLE provider_invocation_transitions_v1 (
  provider_invocation_id TEXT NOT NULL,
  provider_call_plan_id TEXT NOT NULL,
  provider_call_plan_sha256 TEXT NOT NULL CHECK(length(provider_call_plan_sha256)=64),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  node_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  ordinal INTEGER NOT NULL CHECK(ordinal IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','SETTLED','OUTCOME_UNKNOWN')),
  request_count INTEGER CHECK(request_count IS NULL OR request_count>=0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens>=0),
  cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens>=0),
  cost_microusd INTEGER CHECK(cost_microusd IS NULL OR cost_microusd>=0),
  wall_time_ms INTEGER CHECK(wall_time_ms IS NULL OR wall_time_ms>=0),
  cache_lineage_sha256 TEXT CHECK(cache_lineage_sha256 IS NULL OR length(cache_lineage_sha256)=64),
  success_evidence_sha256 TEXT CHECK(success_evidence_sha256 IS NULL OR length(success_evidence_sha256)=64),
  failure_sha256 TEXT CHECK(failure_sha256 IS NULL OR length(failure_sha256)=64),
  predecessor_transition_sha256 TEXT CHECK(predecessor_transition_sha256 IS NULL OR length(predecessor_transition_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(provider_invocation_id,ordinal),
  FOREIGN KEY(provider_call_plan_id,goal_id,run_id,packet_id,provider_call_plan_sha256)
    REFERENCES provider_call_plans_v1(provider_call_plan_id,goal_id,run_id,packet_id,record_sha256),
  FOREIGN KEY(packet_id,execution_graph_revision_id,node_id,packet_sha256)
    REFERENCES task_packets_v2(packet_id,execution_graph_revision_id,node_id,packet_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((state='PREPARED' AND ordinal=0 AND request_count IS NULL AND input_tokens IS NULL
      AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
      AND cost_microusd IS NULL AND wall_time_ms IS NULL AND cache_lineage_sha256 IS NULL
      AND success_evidence_sha256 IS NULL AND failure_sha256 IS NULL AND predecessor_transition_sha256 IS NULL)
    OR (state='SETTLED' AND ordinal=1 AND request_count IS NOT NULL AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL
      AND wall_time_ms IS NOT NULL AND predecessor_transition_sha256 IS NOT NULL
      AND (success_evidence_sha256 IS NULL)<>(failure_sha256 IS NULL)
      AND (success_evidence_sha256 IS NULL OR request_count>0))
    OR (state='OUTCOME_UNKNOWN' AND ordinal=1 AND request_count IS NULL AND input_tokens IS NULL
      AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
      AND cost_microusd IS NULL AND wall_time_ms IS NULL AND cache_lineage_sha256 IS NULL
      AND success_evidence_sha256 IS NULL AND failure_sha256 IS NOT NULL
      AND predecessor_transition_sha256 IS NOT NULL)),
  UNIQUE(provider_invocation_id,packet_id,ordinal,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_provider_redaction_authority_v1
BEFORE INSERT ON provider_redaction_receipts_v1
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 h
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=h.execution_graph_revision_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.sequence=NEW.created_event_sequence-1
  WHERE h.run_id=NEW.run_id AND h.goal_id=NEW.goal_id AND h.status='RUNNING'
    AND h.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND n.input_closure_sha256=NEW.minimum_input_closure_sha256
    AND n.privacy_class=NEW.privacy_class
    AND e.event_sha256=NEW.predecessor_authority_head_sha256
    AND NOT EXISTS (SELECT 1 FROM events later
      WHERE later.goal_id=NEW.goal_id AND later.sequence>=NEW.created_event_sequence)
)
BEGIN SELECT RAISE(ABORT,'Provider redaction receipt is not bound to current execution authority'); END;

CREATE TRIGGER validate_provider_call_plan_authority_v1
BEFORE INSERT ON provider_call_plans_v1
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_graph_heads_v2 h
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=h.execution_graph_revision_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN topology_revisions_v1 t ON t.run_id=h.run_id AND t.revision=(
    SELECT revision FROM topology_revisions_v1 WHERE run_id=h.run_id ORDER BY revision DESC LIMIT 1
  )
  JOIN events e ON e.goal_id=NEW.goal_id AND e.sequence=NEW.created_event_sequence-1
  WHERE h.run_id=NEW.run_id AND h.goal_id=NEW.goal_id AND h.status='RUNNING'
    AND h.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND h.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND g.record_sha256=NEW.execution_graph_revision_sha256
    AND n.record_sha256=NEW.node_spec_sha256
    AND n.input_closure_sha256=NEW.minimum_input_closure_sha256
    AND n.output_schema_sha256=NEW.success_output_schema_sha256
    AND n.oracle_sha256=NEW.local_oracle_sha256
    AND n.privacy_class=NEW.privacy_class
    AND n.provider_profile_sha256=NEW.runtime_fingerprint_sha256
    AND g.config_sha256=NEW.current_pi_config_sha256
    AND t.config_sha256=NEW.current_pi_config_sha256
    AND e.event_sha256=NEW.predecessor_authority_head_sha256
    AND NEW.created_at_ms<NEW.deadline_at_ms
    AND NOT EXISTS (SELECT 1 FROM events later
      WHERE later.goal_id=NEW.goal_id AND later.sequence>=NEW.created_event_sequence)
)
BEGIN SELECT RAISE(ABORT,'ProviderCallPlan is not bound to current Pi and execution authority'); END;

CREATE TRIGGER require_task_packet_provider_call_plan_v1
BEFORE INSERT ON task_packets_v2
WHEN NEW.provider_call_plan_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM provider_call_plans_v1 p
  JOIN provider_redaction_receipts_v1 r ON r.redaction_receipt_id=p.redaction_receipt_id
  WHERE p.provider_call_plan_id=NEW.provider_call_plan_id
    AND p.record_sha256=NEW.provider_call_plan_sha256
    AND p.goal_id=NEW.goal_id AND p.run_id=NEW.run_id
    AND p.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND p.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND p.node_id=NEW.node_id AND p.node_spec_sha256=NEW.node_spec_sha256
    AND p.packet_id=NEW.packet_id AND p.request_class='WORKER'
    AND p.minimum_input_closure_sha256=NEW.input_closure_sha256
    AND p.success_output_schema_sha256=NEW.output_schema_sha256
    AND p.local_oracle_sha256=NEW.oracle_sha256
    AND p.privacy_class=NEW.privacy_class
    AND p.current_pi_config_sha256=NEW.config_sha256
    AND p.runtime_fingerprint_sha256=NEW.provider_profile_sha256
    AND p.attempt=NEW.attempt AND p.lease_generation=NEW.lease_generation
    AND p.fencing_token=NEW.fencing_token
    AND NEW.created_at_ms>=p.created_at_ms AND NEW.created_at_ms<p.deadline_at_ms
    AND NEW.deadline_ms<=p.deadline_at_ms
    AND r.goal_id=NEW.goal_id AND r.run_id=NEW.run_id AND r.packet_id=NEW.packet_id
    AND r.record_sha256=p.redaction_receipt_sha256
    AND r.minimum_input_closure_sha256=NEW.input_closure_sha256
    AND r.privacy_class=NEW.privacy_class
    AND r.allowed_fields_root_sha256=p.allowed_fields_root_sha256
)
BEGIN SELECT RAISE(ABORT,'TaskPacket V2 lacks its exact ProviderCallPlan'); END;

CREATE TRIGGER validate_provider_invocation_transition_v1
BEFORE INSERT ON provider_invocation_transitions_v1
WHEN NOT EXISTS (
  SELECT 1 FROM provider_call_plans_v1 p
  JOIN task_packets_v2 packet ON packet.packet_id=p.packet_id
  WHERE p.provider_call_plan_id=NEW.provider_call_plan_id
    AND p.record_sha256=NEW.provider_call_plan_sha256
    AND p.goal_id=NEW.goal_id AND p.run_id=NEW.run_id
    AND p.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND p.node_id=NEW.node_id AND p.packet_id=NEW.packet_id
    AND p.attempt=NEW.attempt AND p.lease_generation=NEW.lease_generation
    AND p.fencing_token=NEW.fencing_token AND packet.packet_sha256=NEW.packet_sha256
    AND ((NEW.ordinal=0 AND NEW.state='PREPARED'
          AND NEW.created_event_sequence=packet.created_event_sequence)
      OR (NEW.ordinal=1 AND NEW.state IN ('SETTLED','OUTCOME_UNKNOWN')
          AND EXISTS (SELECT 1 FROM provider_invocation_transitions_v1 prepared
            WHERE prepared.provider_invocation_id=NEW.provider_invocation_id
              AND prepared.ordinal=0 AND prepared.state='PREPARED'
              AND prepared.record_sha256=NEW.predecessor_transition_sha256)
          AND NEW.created_at_ms>=p.created_at_ms))
)
BEGIN SELECT RAISE(ABORT,'Provider invocation transition exceeds its exact plan authority'); END;

CREATE TRIGGER validate_provider_lease_event_v1
AFTER INSERT ON events
WHEN NEW.event_type='EXECUTION_NODE_LEASED' AND (
  json_type(NEW.payload_json,'$.providerCallPlanId') IS NOT 'text'
  OR json_type(NEW.payload_json,'$.providerCallPlanSha256') IS NOT 'text'
  OR json_type(NEW.payload_json,'$.redactionReceiptId') IS NOT 'text'
  OR json_type(NEW.payload_json,'$.redactionReceiptSha256') IS NOT 'text'
  OR json_type(NEW.payload_json,'$.providerInvocationId') IS NOT 'text'
  OR json_type(NEW.payload_json,'$.providerInvocationPreparedSha256') IS NOT 'text'
  OR NOT EXISTS (
    SELECT 1 FROM task_packets_v2 packet
    JOIN provider_call_plans_v1 p ON p.provider_call_plan_id=packet.provider_call_plan_id
    JOIN provider_redaction_receipts_v1 r ON r.redaction_receipt_id=p.redaction_receipt_id
    JOIN provider_invocation_transitions_v1 i ON i.provider_call_plan_id=p.provider_call_plan_id
    WHERE packet.goal_id=NEW.goal_id AND packet.created_event_sequence=NEW.sequence
      AND packet.packet_id=json_extract(NEW.payload_json,'$.packetId')
      AND p.provider_call_plan_id=json_extract(NEW.payload_json,'$.providerCallPlanId')
      AND p.record_sha256=json_extract(NEW.payload_json,'$.providerCallPlanSha256')
      AND p.created_event_sequence=NEW.sequence
      AND r.redaction_receipt_id=json_extract(NEW.payload_json,'$.redactionReceiptId')
      AND r.record_sha256=json_extract(NEW.payload_json,'$.redactionReceiptSha256')
      AND r.created_event_sequence=NEW.sequence
      AND i.provider_invocation_id=json_extract(NEW.payload_json,'$.providerInvocationId')
      AND i.record_sha256=json_extract(NEW.payload_json,'$.providerInvocationPreparedSha256')
      AND i.ordinal=0 AND i.state='PREPARED' AND i.created_event_sequence=NEW.sequence
  )
)
BEGIN SELECT RAISE(ABORT,'Execution node lease event lacks exact Provider Invocation authority'); END;

CREATE TRIGGER validate_provider_terminal_event_v1
AFTER INSERT ON events
WHEN (NEW.event_type='PROVIDER_INVOCATION_TRANSITIONED'
  OR (NEW.event_type='EXECUTION_WORKER_PROPOSAL_SUBMITTED'
    AND json_type(NEW.payload_json,'$.providerInvocationId')='text')
  OR EXISTS (
  SELECT 1 FROM provider_invocation_transitions_v1 i
  WHERE i.goal_id=NEW.goal_id AND i.created_event_sequence=NEW.sequence AND i.ordinal=1
)) AND NOT EXISTS (
  SELECT 1 FROM provider_invocation_transitions_v1 i
  WHERE NEW.event_type IN ('PROVIDER_INVOCATION_TRANSITIONED','EXECUTION_WORKER_PROPOSAL_SUBMITTED')
    AND i.goal_id=NEW.goal_id AND i.created_event_sequence=NEW.sequence
    AND i.ordinal=1
    AND i.provider_invocation_id=json_extract(NEW.payload_json,'$.providerInvocationId')
    AND i.record_sha256=json_extract(NEW.payload_json,'$.providerInvocationTransitionSha256')
    AND i.state=json_extract(NEW.payload_json,'$.state')
)
BEGIN SELECT RAISE(ABORT,'Provider invocation terminal event lacks its exact transition authority'); END;

CREATE TRIGGER require_worker_proposal_provider_settlement_v1
BEFORE INSERT ON worker_proposals_v2
WHEN NOT EXISTS (
  SELECT 1 FROM provider_invocation_transitions_v1 i
  JOIN provider_call_plans_v1 p ON p.provider_call_plan_id=i.provider_call_plan_id
  WHERE i.packet_id=NEW.packet_id AND i.packet_sha256=NEW.packet_sha256
    AND i.ordinal=1 AND i.state='SETTLED'
    AND i.success_evidence_sha256=NEW.record_sha256
    AND i.request_count<=p.soft_max_requests AND i.request_count<=p.transport_request_limit
    AND i.input_tokens<=p.soft_max_input_tokens AND i.output_tokens<=p.soft_max_output_tokens
    AND (i.cost_microusd IS NULL OR i.cost_microusd<=p.soft_max_cost_microusd)
    AND i.wall_time_ms<=p.soft_max_latency_ms
    AND ((p.cache_mode='C0' AND i.cache_lineage_sha256 IS NULL)
      OR (p.cache_mode='C1' AND i.cache_lineage_sha256=p.cache_lineage_sha256))
)
BEGIN SELECT RAISE(ABORT,'Worker proposal lacks a settled Provider invocation receipt'); END;

CREATE TRIGGER require_attempt_outcome_provider_terminal_v1
BEFORE INSERT ON execution_node_attempt_outcomes_v2
WHEN NOT EXISTS (
  SELECT 1 FROM provider_invocation_transitions_v1 i
  WHERE i.packet_id=NEW.packet_id AND i.packet_sha256=NEW.packet_sha256
    AND i.ordinal=1 AND i.state IN ('SETTLED','OUTCOME_UNKNOWN')
)
BEGIN SELECT RAISE(ABORT,'Execution attempt outcome lacks terminal Provider invocation authority'); END;

CREATE INDEX ix_provider_call_plans_v1_run
  ON provider_call_plans_v1(run_id,created_event_sequence);
CREATE UNIQUE INDEX ux_provider_call_plans_v1_request
  ON provider_call_plans_v1(run_id,logical_request_id);
CREATE INDEX ix_provider_call_plans_v1_closure
  ON provider_call_plans_v1(goal_id,minimum_input_closure_sha256,runtime_fingerprint_sha256);
CREATE INDEX ix_provider_invocation_transitions_v1_packet
  ON provider_invocation_transitions_v1(packet_id,ordinal);
CREATE INDEX ix_provider_invocation_transitions_v1_pending
  ON provider_invocation_transitions_v1(run_id,state,ordinal);

CREATE TRIGGER no_update_provider_redaction_receipts_v1 BEFORE UPDATE ON provider_redaction_receipts_v1
BEGIN SELECT RAISE(ABORT,'Provider redaction receipts are immutable'); END;
CREATE TRIGGER no_delete_provider_redaction_receipts_v1 BEFORE DELETE ON provider_redaction_receipts_v1
BEGIN SELECT RAISE(ABORT,'Provider redaction receipts are immutable'); END;
CREATE TRIGGER no_update_provider_call_plans_v1 BEFORE UPDATE ON provider_call_plans_v1
BEGIN SELECT RAISE(ABORT,'ProviderCallPlans V1 are immutable'); END;
CREATE TRIGGER no_delete_provider_call_plans_v1 BEFORE DELETE ON provider_call_plans_v1
BEGIN SELECT RAISE(ABORT,'ProviderCallPlans V1 are immutable'); END;
CREATE TRIGGER no_update_provider_invocation_transitions_v1 BEFORE UPDATE ON provider_invocation_transitions_v1
BEGIN SELECT RAISE(ABORT,'Provider invocation transitions are immutable'); END;
CREATE TRIGGER no_delete_provider_invocation_transitions_v1 BEFORE DELETE ON provider_invocation_transitions_v1
BEGIN SELECT RAISE(ABORT,'Provider invocation transitions are immutable'); END;
