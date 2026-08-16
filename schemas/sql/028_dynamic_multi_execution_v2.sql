-- Dynamic Multi V2 execution authority. Worker text and proposals are never
-- sufficient to advance a node; only Host-derived receipts satisfy edges.

CREATE TABLE topology_measurement_evidence_receipts_v2 (
  topology_measurement_evidence_receipt_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('STRONG_SINGLE','DYNAMIC_MULTI_SIMULATION')),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  graph_proposal_sha256 TEXT CHECK(graph_proposal_sha256 IS NULL OR length(graph_proposal_sha256)=64),
  derivation TEXT NOT NULL CHECK(derivation IN ('HOST_STRONG_SINGLE_ROLLOUT','HOST_DETERMINISTIC_DAG_SIMULATION')),
  source_observation_sha256 TEXT NOT NULL CHECK(length(source_observation_sha256)=64),
  correctness TEXT NOT NULL CHECK(correctness IN ('PASS','FAIL')),
  quality_basis_points INTEGER NOT NULL CHECK(quality_basis_points BETWEEN 0 AND 10000),
  wall_time_ms INTEGER NOT NULL CHECK(wall_time_ms>=0),
  provider_requests INTEGER NOT NULL CHECK(provider_requests>=0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  user_interventions INTEGER NOT NULL CHECK(user_interventions>=0),
  safety_events INTEGER NOT NULL CHECK(safety_events>=0),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='STRONG_SINGLE')=(graph_proposal_sha256 IS NULL)),
  CHECK((kind='STRONG_SINGLE')=(derivation='HOST_STRONG_SINGLE_ROLLOUT')),
  UNIQUE(record_sha256,goal_id,run_id,kind),
  UNIQUE(topology_measurement_evidence_receipt_id,goal_id,run_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_topology_measurement_evidence_authority_v2
BEFORE INSERT ON topology_measurement_evidence_receipts_v2
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_runs_v1 r
  JOIN managed_run_heads_v1 rh ON rh.run_id=r.run_id
  JOIN topology_revisions_v1 t ON t.run_id=r.run_id AND t.revision=rh.topology_revision
  JOIN work_cells_v1 c ON c.work_cell_id=NEW.work_cell_id
  JOIN work_cell_heads_v1 ch ON ch.work_cell_id=c.work_cell_id
  JOIN plan_revisions_v2 p ON p.plan_revision_id=NEW.plan_revision_id
  JOIN execution_authorizations_v1 a ON a.goal_id=NEW.goal_id AND a.work_cell_id=NEW.work_cell_id
    AND a.revoked_at_ms IS NULL
  JOIN workspace_baselines_v1 b ON b.baseline_id=a.baseline_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE r.run_id=NEW.run_id AND r.goal_id=NEW.goal_id
    AND rh.status='ACTIVE' AND t.requested_topology='MULTI' AND t.config_sha256=NEW.config_sha256
    AND c.goal_id=NEW.goal_id AND ch.status='RUNNING'
    AND p.goal_id=NEW.goal_id AND p.record_sha256=NEW.plan_revision_sha256
    AND b.record_sha256=NEW.baseline_sha256
    AND b.content_root_sha256=NEW.baseline_content_root_sha256
    AND b.environment_sha256=NEW.environment_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Topology measurement evidence authority closure mismatch'); END;

CREATE TABLE topology_measurement_receipts_v2 (
  topology_measurement_receipt_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('STRONG_SINGLE','DYNAMIC_MULTI_SIMULATION')),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  graph_proposal_sha256 TEXT CHECK(graph_proposal_sha256 IS NULL OR length(graph_proposal_sha256)=64),
  correctness TEXT NOT NULL CHECK(correctness IN ('PASS','FAIL')),
  quality_basis_points INTEGER NOT NULL CHECK(quality_basis_points BETWEEN 0 AND 10000),
  wall_time_ms INTEGER NOT NULL CHECK(wall_time_ms>=0),
  provider_requests INTEGER NOT NULL CHECK(provider_requests>=0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  user_interventions INTEGER NOT NULL CHECK(user_interventions>=0),
  safety_events INTEGER NOT NULL CHECK(safety_events>=0),
  source_evidence_sha256 TEXT NOT NULL CHECK(length(source_evidence_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  trust TEXT NOT NULL CHECK(trust='HOST_DERIVED'),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(source_evidence_sha256) REFERENCES topology_measurement_evidence_receipts_v2(record_sha256),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='STRONG_SINGLE')=(graph_proposal_sha256 IS NULL)),
  UNIQUE(topology_measurement_receipt_id,goal_id,run_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_topology_measurement_authority_v2
BEFORE INSERT ON topology_measurement_receipts_v2
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_runs_v1 r
  JOIN managed_run_heads_v1 rh ON rh.run_id=r.run_id
  JOIN topology_revisions_v1 t ON t.run_id=r.run_id AND t.revision=rh.topology_revision
  JOIN work_cells_v1 c ON c.work_cell_id=NEW.work_cell_id
  JOIN work_cell_heads_v1 ch ON ch.work_cell_id=c.work_cell_id
  JOIN plan_revisions_v2 p ON p.plan_revision_id=NEW.plan_revision_id
  JOIN execution_authorizations_v1 a ON a.goal_id=NEW.goal_id AND a.work_cell_id=NEW.work_cell_id
    AND a.revoked_at_ms IS NULL
  JOIN workspace_baselines_v1 b ON b.baseline_id=a.baseline_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE r.run_id=NEW.run_id AND r.goal_id=NEW.goal_id
    AND rh.status='ACTIVE' AND t.requested_topology='MULTI' AND t.config_sha256=NEW.config_sha256
    AND c.goal_id=NEW.goal_id AND ch.status='RUNNING'
    AND p.goal_id=NEW.goal_id AND p.record_sha256=NEW.plan_revision_sha256
    AND b.record_sha256=NEW.baseline_sha256
    AND b.content_root_sha256=NEW.baseline_content_root_sha256
    AND b.environment_sha256=NEW.environment_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Topology measurement authority closure mismatch'); END;

CREATE TRIGGER validate_topology_measurement_evidence_binding_v2
BEFORE INSERT ON topology_measurement_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM topology_measurement_evidence_receipts_v2 source
  WHERE source.record_sha256=NEW.source_evidence_sha256
    AND source.goal_id=NEW.goal_id AND source.run_id=NEW.run_id
    AND source.work_cell_id=NEW.work_cell_id AND source.plan_revision_id=NEW.plan_revision_id
    AND source.plan_revision_sha256=NEW.plan_revision_sha256
    AND source.input_closure_sha256=NEW.input_closure_sha256
    AND source.runtime_fingerprint_sha256=NEW.runtime_fingerprint_sha256
    AND source.config_sha256=NEW.config_sha256 AND source.baseline_sha256=NEW.baseline_sha256
    AND source.baseline_content_root_sha256=NEW.baseline_content_root_sha256
    AND source.environment_sha256=NEW.environment_sha256 AND source.kind=NEW.kind
    AND source.graph_proposal_sha256 IS NEW.graph_proposal_sha256
    AND source.correctness=NEW.correctness AND source.quality_basis_points=NEW.quality_basis_points
    AND source.wall_time_ms=NEW.wall_time_ms AND source.provider_requests=NEW.provider_requests
    AND source.input_tokens=NEW.input_tokens AND source.output_tokens=NEW.output_tokens
    AND source.user_interventions=NEW.user_interventions AND source.safety_events=NEW.safety_events
    AND source.predecessor_authority_head_sha256=NEW.predecessor_authority_head_sha256
    AND source.observed_at_ms=NEW.observed_at_ms
    AND source.created_event_sequence=NEW.created_event_sequence
)
BEGIN SELECT RAISE(ABORT,'Topology measurement lacks exact Host-derived source evidence'); END;

CREATE TRIGGER validate_topology_measurement_event_v2
AFTER INSERT ON events
WHEN (NEW.event_type='TOPOLOGY_MEASUREMENTS_RECORDED' OR EXISTS (
  SELECT 1 FROM topology_measurement_evidence_receipts_v2 source
  WHERE source.goal_id=NEW.goal_id AND source.created_event_sequence=NEW.sequence
) OR EXISTS (
  SELECT 1 FROM topology_measurement_receipts_v2 measurement
  WHERE measurement.goal_id=NEW.goal_id AND measurement.created_event_sequence=NEW.sequence
)) AND (
  NEW.event_type<>'TOPOLOGY_MEASUREMENTS_RECORDED'
  OR json_array_length(NEW.payload_json,'$.measurementEvidenceIds')<>2
  OR json_array_length(NEW.payload_json,'$.measurementEvidenceSha256s')<>2
  OR json_array_length(NEW.payload_json,'$.measurementIds')<>2
  OR json_array_length(NEW.payload_json,'$.measurementSha256s')<>2
  OR EXISTS (
    SELECT 1 FROM topology_measurement_evidence_receipts_v2 source
    WHERE source.goal_id=NEW.goal_id AND source.created_event_sequence=NEW.sequence
      AND (NOT EXISTS (SELECT 1 FROM json_each(NEW.payload_json,'$.measurementEvidenceIds') item
        WHERE item.value=source.topology_measurement_evidence_receipt_id)
      OR NOT EXISTS (SELECT 1 FROM json_each(NEW.payload_json,'$.measurementEvidenceSha256s') item
        WHERE item.value=source.record_sha256))
  )
  OR EXISTS (
    SELECT 1 FROM topology_measurement_receipts_v2 measurement
    WHERE measurement.goal_id=NEW.goal_id AND measurement.created_event_sequence=NEW.sequence
      AND (NOT EXISTS (SELECT 1 FROM json_each(NEW.payload_json,'$.measurementIds') item
        WHERE item.value=measurement.topology_measurement_receipt_id)
      OR NOT EXISTS (SELECT 1 FROM json_each(NEW.payload_json,'$.measurementSha256s') item
        WHERE item.value=measurement.record_sha256))
  )
)
BEGIN SELECT RAISE(ABORT,'Topology measurement event lacks exact Host-derived evidence'); END;

CREATE INDEX topology_measurements_by_closure_v2 ON topology_measurement_receipts_v2(
  goal_id,run_id,work_cell_id,plan_revision_id,input_closure_sha256,runtime_fingerprint_sha256,
  config_sha256,baseline_content_root_sha256,environment_sha256,kind,observed_at_ms
);
CREATE INDEX topology_measurement_evidence_by_closure_v2 ON topology_measurement_evidence_receipts_v2(
  goal_id,run_id,work_cell_id,plan_revision_id,input_closure_sha256,runtime_fingerprint_sha256,
  config_sha256,baseline_content_root_sha256,environment_sha256,kind,observed_at_ms
);

CREATE TABLE execution_graph_revisions_v2 (
  execution_graph_revision_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  topology_gate_receipt_id TEXT NOT NULL,
  topology_gate_receipt_sha256 TEXT NOT NULL CHECK(length(topology_gate_receipt_sha256)=64),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  graph_revision INTEGER NOT NULL CHECK(graph_revision BETWEEN 1 AND 65535),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  node_root_sha256 TEXT NOT NULL CHECK(length(node_root_sha256)=64),
  edge_root_sha256 TEXT NOT NULL CHECK(length(edge_root_sha256)=64),
  graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(topology_gate_receipt_id,goal_id,run_id,topology_gate_receipt_sha256)
    REFERENCES topology_gate_receipts_v2(topology_gate_receipt_id,goal_id,run_id,record_sha256),
  UNIQUE(run_id,work_cell_id,graph_revision),
  UNIQUE(execution_graph_revision_id,goal_id,run_id,work_cell_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_execution_graph_authority_v2
BEFORE INSERT ON execution_graph_revisions_v2
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_runs_v1 r
  JOIN work_cells_v1 c ON c.work_cell_id=NEW.work_cell_id
  JOIN work_cell_heads_v1 ch ON ch.work_cell_id=c.work_cell_id
  JOIN plan_revisions_v2 p ON p.plan_revision_id=NEW.plan_revision_id
  JOIN topology_gate_receipts_v2 g ON g.topology_gate_receipt_id=NEW.topology_gate_receipt_id
  JOIN execution_authorizations_v1 a ON a.authorization_id=NEW.authorization_id
  JOIN workspace_baselines_v1 b ON b.baseline_id=a.baseline_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE r.run_id=NEW.run_id AND r.goal_id=NEW.goal_id
    AND c.goal_id=NEW.goal_id AND ch.status='RUNNING'
    AND p.goal_id=NEW.goal_id AND p.record_sha256=NEW.plan_revision_sha256
    AND g.goal_id=NEW.goal_id AND g.run_id=NEW.run_id
    AND g.record_sha256=NEW.topology_gate_receipt_sha256
    AND g.plan_revision_id=NEW.plan_revision_id AND g.plan_revision_sha256=NEW.plan_revision_sha256
    AND g.effective_topology='MULTI' AND g.verdict='ALLOW'
    AND g.config_sha256=NEW.config_sha256
    AND a.goal_id=NEW.goal_id AND a.work_cell_id=NEW.work_cell_id
    AND a.record_sha256=NEW.authorization_sha256 AND a.revoked_at_ms IS NULL
    AND b.record_sha256=NEW.baseline_sha256
    AND b.content_root_sha256=NEW.baseline_content_root_sha256
    AND b.environment_sha256=NEW.environment_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Execution graph authority closure mismatch'); END;

CREATE TABLE execution_nodes_v2 (
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  node_id TEXT NOT NULL,
  logical_key TEXT NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 160),
  task_text TEXT NOT NULL CHECK(length(task_text) BETWEEN 1 AND 16384),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json) AND json_type(capabilities_json)='array' AND length(capabilities_json)<=32768),
  effect_ceiling TEXT NOT NULL CHECK(effect_ceiling IN ('READ_ONLY','PATCH_PROPOSAL')),
  requirement_ids_json TEXT NOT NULL CHECK(json_valid(requirement_ids_json) AND json_type(requirement_ids_json)='array' AND length(requirement_ids_json)<=65536),
  obligation_ids_json TEXT NOT NULL CHECK(json_valid(obligation_ids_json) AND json_type(obligation_ids_json)='array' AND length(obligation_ids_json)<=65536),
  read_roots_json TEXT NOT NULL CHECK(json_valid(read_roots_json) AND json_type(read_roots_json)='array' AND length(read_roots_json)<=131072),
  write_roots_json TEXT NOT NULL CHECK(json_valid(write_roots_json) AND json_type(write_roots_json)='array' AND length(write_roots_json)<=131072),
  exact_input_refs_json TEXT NOT NULL CHECK(json_valid(exact_input_refs_json) AND json_type(exact_input_refs_json)='array' AND length(exact_input_refs_json)<=1048576),
  decision_refs_json TEXT NOT NULL CHECK(json_valid(decision_refs_json) AND json_type(decision_refs_json)='array' AND length(decision_refs_json)<=1048576),
  provider_call_plan_id TEXT,
  provider_call_plan_sha256 TEXT CHECK(provider_call_plan_sha256 IS NULL OR length(provider_call_plan_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  output_schema_sha256 TEXT NOT NULL CHECK(length(output_schema_sha256)=64),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  provider_profile_sha256 TEXT NOT NULL CHECK(length(provider_profile_sha256)=64),
  privacy_class TEXT NOT NULL CHECK(privacy_class IN ('PUBLIC','INTERNAL','SENSITIVE','SECRET')),
  taint_classes_json TEXT NOT NULL CHECK(json_valid(taint_classes_json) AND json_type(taint_classes_json)='array' AND length(taint_classes_json)<=32768),
  max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 1024),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 1 AND 16384),
  max_input_tokens INTEGER NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 10000000),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 10000000),
  max_retries INTEGER NOT NULL CHECK(max_retries BETWEEN 0 AND 32),
  no_progress_limit INTEGER NOT NULL CHECK(no_progress_limit BETWEEN 1 AND 32),
  deadline_ms INTEGER NOT NULL CHECK(deadline_ms>=1),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(execution_graph_revision_id,node_id),
  CHECK((provider_call_plan_id IS NULL)=(provider_call_plan_sha256 IS NULL)),
  UNIQUE(execution_graph_revision_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE execution_edges_v2 (
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  condition TEXT NOT NULL CHECK(condition IN ('EVIDENCE_ACCEPTED','PATCH_INTEGRATED','ORACLE_PASSED')),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(execution_graph_revision_id,from_node_id,to_node_id,condition),
  FOREIGN KEY(execution_graph_revision_id,from_node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(execution_graph_revision_id,to_node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  CHECK(from_node_id<>to_node_id),
  UNIQUE(execution_graph_revision_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE execution_graph_heads_v2 (
  run_id TEXT PRIMARY KEY REFERENCES managed_runs_v1(run_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  graph_revision INTEGER NOT NULL CHECK(graph_revision>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  status TEXT NOT NULL CHECK(status IN ('RUNNING','STOPPED','CLOSED','FAILED')),
  current_postimage_root_sha256 TEXT NOT NULL CHECK(length(current_postimage_root_sha256)=64),
  terminal_receipt_id TEXT,
  terminal_receipt_sha256 TEXT CHECK(terminal_receipt_sha256 IS NULL OR length(terminal_receipt_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  CHECK((status IN ('CLOSED','FAILED'))=(terminal_receipt_id IS NOT NULL)),
  CHECK((terminal_receipt_id IS NULL)=(terminal_receipt_sha256 IS NULL)),
  UNIQUE(execution_graph_revision_id,execution_graph_revision_sha256)
) STRICT;

CREATE TABLE execution_node_heads_v2 (
  execution_graph_revision_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'READY','LEASED','PROPOSAL_SUBMITTED','EVIDENCE_ACCEPTED','PATCH_INTEGRATED',
    'ORACLE_PASSED','REJECTED','INVALIDATED','STOPPED','FAILED'
  )),
  attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  latest_packet_id TEXT,
  latest_packet_sha256 TEXT CHECK(latest_packet_sha256 IS NULL OR length(latest_packet_sha256)=64),
  latest_proposal_id TEXT,
  latest_proposal_sha256 TEXT CHECK(latest_proposal_sha256 IS NULL OR length(latest_proposal_sha256)=64),
  latest_host_receipt_id TEXT,
  latest_host_receipt_sha256 TEXT CHECK(latest_host_receipt_sha256 IS NULL OR length(latest_host_receipt_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  PRIMARY KEY(execution_graph_revision_id,node_id),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  CHECK((latest_packet_id IS NULL)=(latest_packet_sha256 IS NULL)),
  CHECK((latest_proposal_id IS NULL)=(latest_proposal_sha256 IS NULL)),
  CHECK((latest_host_receipt_id IS NULL)=(latest_host_receipt_sha256 IS NULL))
) WITHOUT ROWID, STRICT;

CREATE TABLE task_packets_v2 (
  packet_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  task_text TEXT NOT NULL CHECK(length(task_text) BETWEEN 1 AND 16384),
  requirement_ids_json TEXT NOT NULL CHECK(json_valid(requirement_ids_json) AND json_type(requirement_ids_json)='array' AND length(requirement_ids_json)<=65536),
  obligation_ids_json TEXT NOT NULL CHECK(json_valid(obligation_ids_json) AND json_type(obligation_ids_json)='array' AND length(obligation_ids_json)<=65536),
  output_schema_sha256 TEXT NOT NULL CHECK(length(output_schema_sha256)=64),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  provider_profile_sha256 TEXT NOT NULL CHECK(length(provider_profile_sha256)=64),
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  topology_gate_receipt_sha256 TEXT NOT NULL CHECK(length(topology_gate_receipt_sha256)=64),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json) AND json_type(capabilities_json)='array'),
  effect_ceiling TEXT NOT NULL CHECK(effect_ceiling IN ('READ_ONLY','PATCH_PROPOSAL')),
  read_roots_json TEXT NOT NULL CHECK(json_valid(read_roots_json) AND json_type(read_roots_json)='array'),
  write_roots_json TEXT NOT NULL CHECK(json_valid(write_roots_json) AND json_type(write_roots_json)='array'),
  privacy_class TEXT NOT NULL CHECK(privacy_class IN ('PUBLIC','INTERNAL','SENSITIVE','SECRET')),
  taint_classes_json TEXT NOT NULL CHECK(json_valid(taint_classes_json) AND json_type(taint_classes_json)='array'),
  max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 1024),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 1 AND 16384),
  max_input_tokens INTEGER NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 10000000),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 10000000),
  max_retries INTEGER NOT NULL CHECK(max_retries BETWEEN 0 AND 32),
  no_progress_limit INTEGER NOT NULL CHECK(no_progress_limit BETWEEN 1 AND 32),
  exact_input_refs_json TEXT NOT NULL CHECK(json_valid(exact_input_refs_json) AND json_type(exact_input_refs_json)='array' AND length(exact_input_refs_json)<=524288),
  decision_refs_json TEXT NOT NULL CHECK(json_valid(decision_refs_json) AND json_type(decision_refs_json)='array' AND length(decision_refs_json)<=131072),
  provider_call_plan_id TEXT,
  provider_call_plan_sha256 TEXT CHECK(provider_call_plan_sha256 IS NULL OR length(provider_call_plan_sha256)=64),
  deadline_ms INTEGER NOT NULL CHECK(deadline_ms>=1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  packet_sha256 TEXT NOT NULL UNIQUE CHECK(length(packet_sha256)=64),
  capability_hmac TEXT NOT NULL CHECK(length(capability_hmac)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  CHECK((provider_call_plan_id IS NULL)=(provider_call_plan_sha256 IS NULL)),
  UNIQUE(packet_id,execution_graph_revision_id,node_id,packet_sha256)
) STRICT;

CREATE TRIGGER validate_task_packet_current_v2
BEFORE INSERT ON task_packets_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=gh.execution_graph_revision_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
  JOIN execution_authorizations_v1 a ON a.authorization_id=g.authorization_id
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id AND gh.work_cell_id=NEW.work_cell_id
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND gh.status='RUNNING' AND nh.stop_generation=NEW.stop_generation
    AND g.record_sha256=NEW.execution_graph_revision_sha256
    AND n.record_sha256=NEW.node_spec_sha256 AND nh.status='READY'
    AND g.plan_revision_sha256=NEW.plan_revision_sha256
    AND g.topology_gate_receipt_sha256=NEW.topology_gate_receipt_sha256
    AND g.authorization_sha256=NEW.authorization_sha256
    AND g.baseline_sha256=NEW.baseline_sha256
    AND g.baseline_content_root_sha256=NEW.baseline_content_root_sha256
    AND g.environment_sha256=NEW.environment_sha256
    AND g.oracle_set_sha256=NEW.oracle_set_sha256 AND g.config_sha256=NEW.config_sha256
    AND g.runtime_fingerprint_sha256=NEW.runtime_fingerprint_sha256
    AND a.record_sha256=NEW.authorization_sha256 AND a.revoked_at_ms IS NULL
)
BEGIN SELECT RAISE(ABORT,'TaskPacket V2 is not bound to the current execution authority'); END;

CREATE TABLE execution_node_leases_v2 (
  execution_node_lease_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  generation INTEGER NOT NULL CHECK(generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  owner_hmac TEXT NOT NULL CHECK(length(owner_hmac)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(packet_id,execution_graph_revision_id,node_id,packet_sha256)
    REFERENCES task_packets_v2(packet_id,execution_graph_revision_id,node_id,packet_sha256),
  UNIQUE(execution_graph_revision_id,node_id,generation),
  UNIQUE(execution_graph_revision_id,node_id,fencing_token),
  UNIQUE(execution_node_lease_id,execution_graph_revision_id,node_id,record_sha256),
  UNIQUE(execution_node_lease_id,execution_graph_revision_id,node_id,packet_id,record_sha256)
) STRICT;

CREATE TABLE execution_node_lease_heads_v2 (
  execution_graph_revision_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  execution_node_lease_id TEXT NOT NULL,
  execution_node_lease_sha256 TEXT NOT NULL CHECK(length(execution_node_lease_sha256)=64),
  generation INTEGER NOT NULL CHECK(generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  owner_hmac TEXT NOT NULL CHECK(length(owner_hmac)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=1),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  PRIMARY KEY(execution_graph_revision_id,node_id),
  FOREIGN KEY(execution_node_lease_id,execution_graph_revision_id,node_id,execution_node_lease_sha256)
    REFERENCES execution_node_leases_v2(execution_node_lease_id,execution_graph_revision_id,node_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE execution_node_attempt_outcomes_v2 (
  execution_node_attempt_outcome_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  execution_node_lease_id TEXT NOT NULL,
  execution_node_lease_sha256 TEXT NOT NULL CHECK(length(execution_node_lease_sha256)=64),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  basis TEXT NOT NULL CHECK(basis IN ('WORKER_FAILURE','LEASE_EXPIRED','HOST_EPOCH_FENCED','ABORT_CONFIRMED')),
  disposition TEXT NOT NULL CHECK(disposition IN ('REQUEUED','FAILED','FENCED')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 256),
  failure_sha256 TEXT NOT NULL CHECK(length(failure_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  trust TEXT NOT NULL CHECK(trust='HOST_DERIVED'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(basis<>'LEASE_EXPIRED' OR disposition='REQUEUED'),
  CHECK(disposition<>'FAILED' OR basis='WORKER_FAILURE'),
  FOREIGN KEY(packet_id,execution_graph_revision_id,node_id,packet_sha256)
    REFERENCES task_packets_v2(packet_id,execution_graph_revision_id,node_id,packet_sha256),
  FOREIGN KEY(execution_node_lease_id,execution_graph_revision_id,node_id,packet_id,execution_node_lease_sha256)
    REFERENCES execution_node_leases_v2(execution_node_lease_id,execution_graph_revision_id,node_id,packet_id,record_sha256),
  UNIQUE(execution_graph_revision_id,node_id,attempt),
  UNIQUE(execution_node_attempt_outcome_id,execution_graph_revision_id,node_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_execution_node_attempt_outcome_v2
BEFORE INSERT ON execution_node_attempt_outcomes_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=NEW.execution_graph_revision_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
  JOIN execution_node_lease_heads_v2 lh ON lh.execution_graph_revision_id=n.execution_graph_revision_id AND lh.node_id=n.node_id
  JOIN execution_node_leases_v2 l ON l.execution_node_lease_id=lh.execution_node_lease_id
  JOIN task_packets_v2 p ON p.packet_id=l.packet_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id AND gh.status='RUNNING'
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND g.record_sha256=NEW.execution_graph_revision_sha256
    AND n.record_sha256=NEW.node_spec_sha256
    AND nh.status IN ('LEASED','PROPOSAL_SUBMITTED')
    AND nh.latest_packet_id=NEW.packet_id AND nh.latest_packet_sha256=NEW.packet_sha256
    AND lh.execution_node_lease_id=NEW.execution_node_lease_id
    AND lh.execution_node_lease_sha256=NEW.execution_node_lease_sha256
    AND lh.generation=NEW.lease_generation AND lh.fencing_token=NEW.fencing_token
    AND lh.stop_generation=NEW.stop_generation
    AND p.attempt=NEW.attempt AND p.packet_sha256=NEW.packet_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Execution node attempt outcome authority closure mismatch'); END;

CREATE TABLE worker_proposals_v2 (
  proposal_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  packet_id TEXT NOT NULL REFERENCES task_packets_v2(packet_id),
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  kind TEXT NOT NULL CHECK(kind IN ('EVIDENCE_PROPOSAL','PATCH_PROPOSAL','DECISION_REQUEST','CONFLICT_PROPOSAL','BLOCKED','STOPPED')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object' AND length(payload_json)<=524288),
  trust TEXT NOT NULL CHECK(trust='UNVERIFIED_PROPOSAL'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  UNIQUE(proposal_id,execution_graph_revision_id,node_id,packet_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_worker_proposal_lease_v2
BEFORE INSERT ON worker_proposals_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=NEW.execution_graph_revision_id
  JOIN execution_node_lease_heads_v2 lh
    ON lh.execution_graph_revision_id=NEW.execution_graph_revision_id AND lh.node_id=NEW.node_id
  JOIN execution_node_heads_v2 nh
    ON nh.execution_graph_revision_id=NEW.execution_graph_revision_id AND nh.node_id=NEW.node_id
  JOIN execution_node_leases_v2 l ON l.execution_node_lease_id=lh.execution_node_lease_id
  JOIN task_packets_v2 p ON p.packet_id=NEW.packet_id
  JOIN execution_authorizations_v1 a ON a.authorization_id=g.authorization_id
  WHERE gh.run_id=NEW.run_id AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND gh.status='RUNNING' AND nh.status='LEASED' AND nh.stop_generation=NEW.stop_generation
    AND lh.generation=NEW.lease_generation AND lh.fencing_token=NEW.fencing_token
    AND lh.stop_generation=NEW.stop_generation AND lh.expires_at_ms>NEW.created_at_ms
    AND l.packet_id=NEW.packet_id AND l.packet_sha256=NEW.packet_sha256
    AND p.packet_sha256=NEW.packet_sha256
    AND a.record_sha256=g.authorization_sha256 AND a.revoked_at_ms IS NULL
)
BEGIN SELECT RAISE(ABORT,'Worker proposal lacks a current execution lease'); END;

CREATE TABLE worker_patch_sets_v2 (
  patch_set_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL REFERENCES task_packets_v2(packet_id),
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  proposal_id TEXT NOT NULL REFERENCES worker_proposals_v2(proposal_id),
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  affected_paths_json TEXT NOT NULL CHECK(json_valid(affected_paths_json) AND json_type(affected_paths_json)='array' AND length(affected_paths_json)<=1048576),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json) AND json_type(entries_json)='array' AND length(entries_json)<=2097152),
  proposed_postimage_root_sha256 TEXT NOT NULL CHECK(length(proposed_postimage_root_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(proposal_id,execution_graph_revision_id,node_id,packet_id,proposal_sha256)
    REFERENCES worker_proposals_v2(proposal_id,execution_graph_revision_id,node_id,packet_id,record_sha256),
  UNIQUE(patch_set_id,proposal_id,record_sha256)
) STRICT;

CREATE TABLE worker_patch_set_artifacts_v2 (
  patch_set_id TEXT NOT NULL REFERENCES worker_patch_sets_v2(patch_set_id),
  path TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(patch_set_id,path),
  FOREIGN KEY(artifact_sha256) REFERENCES artifacts(sha256)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_worker_patch_set_artifact_identity_v2
BEFORE INSERT ON worker_patch_set_artifacts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM artifacts a WHERE a.artifact_id=NEW.artifact_id AND a.sha256=NEW.artifact_sha256
    AND a.byte_length=NEW.byte_length AND a.classification<>'SECRET'
)
BEGIN SELECT RAISE(ABORT,'Worker PatchSet artifact metadata identity mismatch'); END;

CREATE TRIGGER validate_worker_patch_set_v2
BEFORE INSERT ON worker_patch_sets_v2
WHEN NOT EXISTS (
  SELECT 1 FROM worker_proposals_v2 p
  JOIN task_packets_v2 t ON t.packet_id=p.packet_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=p.execution_graph_revision_id AND n.node_id=p.node_id
  WHERE p.proposal_id=NEW.proposal_id AND p.kind='PATCH_PROPOSAL'
    AND p.goal_id=NEW.goal_id AND p.run_id=NEW.run_id
    AND p.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND p.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND p.node_id=NEW.node_id AND n.record_sha256=NEW.node_spec_sha256
    AND p.packet_id=NEW.packet_id AND p.packet_sha256=NEW.packet_sha256
    AND p.record_sha256=NEW.proposal_sha256 AND t.baseline_content_root_sha256=NEW.baseline_sha256
)
BEGIN SELECT RAISE(ABORT,'Worker PatchSet lacks its exact proposal closure'); END;

CREATE TABLE host_oracle_receipts_v2 (
  host_oracle_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL REFERENCES task_packets_v2(packet_id),
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  proposal_id TEXT NOT NULL REFERENCES worker_proposals_v2(proposal_id),
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  postimage_root_sha256 TEXT NOT NULL CHECK(length(postimage_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  covered_obligation_ids_json TEXT NOT NULL CHECK(
    json_valid(covered_obligation_ids_json) AND json_type(covered_obligation_ids_json)='array'
    AND json_array_length(covered_obligation_ids_json)>=1 AND length(covered_obligation_ids_json)<=65536
  ),
  validation_evidence_root_sha256 TEXT NOT NULL CHECK(length(validation_evidence_root_sha256)=64),
  result TEXT NOT NULL CHECK(result='PASS'),
  freshness TEXT NOT NULL CHECK(freshness='CURRENT'),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  trust TEXT NOT NULL CHECK(trust='HOST_DERIVED'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(proposal_id,execution_graph_revision_id,node_id,packet_id,proposal_sha256)
    REFERENCES worker_proposals_v2(proposal_id,execution_graph_revision_id,node_id,packet_id,record_sha256),
  UNIQUE(host_oracle_receipt_id,goal_id,execution_graph_revision_id,node_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_host_oracle_receipt_v2
BEFORE INSERT ON host_oracle_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=gh.execution_graph_revision_id
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
  JOIN task_packets_v2 p ON p.packet_id=NEW.packet_id
  JOIN worker_proposals_v2 w ON w.proposal_id=NEW.proposal_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id AND gh.status='RUNNING'
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND nh.stop_generation=NEW.stop_generation
    AND n.record_sha256=NEW.node_spec_sha256 AND n.oracle_sha256=NEW.oracle_sha256
    AND g.oracle_set_sha256=NEW.oracle_set_sha256 AND g.environment_sha256=NEW.environment_sha256
    AND p.packet_sha256=NEW.packet_sha256 AND w.record_sha256=NEW.proposal_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Host OracleReceipt authority closure mismatch'); END;

CREATE TABLE host_oracle_evidence_members_v2 (
  host_oracle_receipt_id TEXT NOT NULL REFERENCES host_oracle_receipts_v2(host_oracle_receipt_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  obligation_id TEXT NOT NULL REFERENCES task_obligations_v1(obligation_id),
  oracle_pass_receipt_id TEXT NOT NULL REFERENCES oracle_pass_receipts_v2(pass_receipt_id),
  oracle_pass_receipt_sha256 TEXT NOT NULL CHECK(length(oracle_pass_receipt_sha256)=64),
  evidence_requirement_id TEXT NOT NULL REFERENCES evidence_requirements_v2(evidence_requirement_id),
  operation_attempt_id TEXT NOT NULL REFERENCES operation_attempts_v1(attempt_id),
  operation_attempt_sha256 TEXT NOT NULL CHECK(length(operation_attempt_sha256)=64),
  terminal_transition_id TEXT NOT NULL REFERENCES operation_transitions_v1(transition_id),
  terminal_transition_sha256 TEXT NOT NULL CHECK(length(terminal_transition_sha256)=64),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(host_oracle_receipt_id,ordinal),
  UNIQUE(host_oracle_receipt_id,oracle_pass_receipt_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_host_oracle_evidence_member_v2
BEFORE INSERT ON host_oracle_evidence_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM host_oracle_receipts_v2 h
  JOIN oracle_pass_receipts_v2 p ON p.pass_receipt_id=NEW.oracle_pass_receipt_id
  JOIN operation_attempts_v1 a ON a.attempt_id=NEW.operation_attempt_id
  JOIN operation_transitions_v1 t ON t.transition_id=NEW.terminal_transition_id AND t.attempt_id=a.attempt_id
  JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=NEW.evidence_requirement_id
  JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
  JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
  WHERE h.host_oracle_receipt_id=NEW.host_oracle_receipt_id
    AND p.goal_id=h.goal_id AND p.work_cell_id=(SELECT work_cell_id FROM execution_graph_revisions_v2
      WHERE execution_graph_revision_id=h.execution_graph_revision_id)
    AND p.record_sha256=NEW.oracle_pass_receipt_sha256
    AND p.evidence_requirement_id=NEW.evidence_requirement_id
    AND p.attempt_id=NEW.operation_attempt_id AND p.terminal_transition_id=NEW.terminal_transition_id
    AND p.terminal_transition_sha256=NEW.terminal_transition_sha256
    AND p.postimage_root_sha256=h.postimage_root_sha256 AND p.environment_sha256=h.environment_sha256
    AND a.record_sha256=NEW.operation_attempt_sha256 AND a.operation_kind='VALIDATION'
    AND a.oracle_sha256=h.oracle_sha256 AND t.transition_sha256=NEW.terminal_transition_sha256
    AND t.state IN ('COMMITTED','RECONCILED') AND t.postcondition='PASS'
    AND o.task_obligation_id=NEW.obligation_id
)
BEGIN SELECT RAISE(ABORT,'Host OracleReceipt evidence is not a real frozen Host validation PASS'); END;

CREATE TABLE host_node_receipts_v2 (
  host_node_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  packet_id TEXT NOT NULL REFERENCES task_packets_v2(packet_id),
  packet_sha256 TEXT NOT NULL CHECK(length(packet_sha256)=64),
  proposal_id TEXT NOT NULL REFERENCES worker_proposals_v2(proposal_id),
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
  kind TEXT NOT NULL CHECK(kind IN ('EVIDENCE_ACCEPTED','PATCH_INTEGRATED','ORACLE_PASSED','NODE_REJECTED')),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  preimage_root_sha256 TEXT CHECK(preimage_root_sha256 IS NULL OR length(preimage_root_sha256)=64),
  postimage_root_sha256 TEXT CHECK(postimage_root_sha256 IS NULL OR length(postimage_root_sha256)=64),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=0),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  trust TEXT NOT NULL CHECK(trust='HOST_DERIVED'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(proposal_id,execution_graph_revision_id,node_id,packet_id,proposal_sha256)
    REFERENCES worker_proposals_v2(proposal_id,execution_graph_revision_id,node_id,packet_id,record_sha256),
  CHECK((kind='PATCH_INTEGRATED' AND preimage_root_sha256 IS NOT NULL AND postimage_root_sha256 IS NOT NULL)
    OR (kind<>'PATCH_INTEGRATED' AND preimage_root_sha256 IS NULL AND postimage_root_sha256 IS NULL)),
  UNIQUE(host_node_receipt_id,execution_graph_revision_id,node_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_host_node_receipt_v2
BEFORE INSERT ON host_node_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=NEW.execution_graph_revision_id AND n.node_id=NEW.node_id
  JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
  JOIN task_packets_v2 p ON p.packet_id=NEW.packet_id
  JOIN worker_proposals_v2 w ON w.proposal_id=NEW.proposal_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND gh.status='RUNNING' AND nh.stop_generation=NEW.stop_generation
    AND n.record_sha256=NEW.node_spec_sha256
    AND p.packet_sha256=NEW.packet_sha256
    AND w.record_sha256=NEW.proposal_sha256 AND w.trust='UNVERIFIED_PROPOSAL'
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Host node receipt authority closure mismatch'); END;

CREATE TABLE execution_stops_v2 (
  execution_stop_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  stop_generation INTEGER NOT NULL CHECK(stop_generation>=1),
  scope TEXT NOT NULL CHECK(scope IN ('PARTIAL_INVALIDATION','GRAPH_STOP')),
  reason TEXT NOT NULL CHECK(reason IN (
    'USER_CANCEL','MATERIAL_CHANGE','AUTHORIZATION_REVOKED','NO_PROGRESS',
    'BUDGET_EXHAUSTED','SAFETY_FENCE','INTEGRATION_RECONCILIATION_REQUIRED','SUPERSEDED'
  )),
  affected_node_root_sha256 TEXT NOT NULL CHECK(length(affected_node_root_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(scope='GRAPH_STOP' OR reason IN ('MATERIAL_CHANGE','SUPERSEDED')),
  UNIQUE(run_id,execution_graph_revision_id,stop_generation),
  UNIQUE(execution_stop_id,execution_graph_revision_id,record_sha256)
) STRICT;

CREATE TABLE execution_stop_node_members_v2 (
  execution_stop_id TEXT NOT NULL REFERENCES execution_stops_v2(execution_stop_id),
  execution_graph_revision_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(execution_stop_id,node_id),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  UNIQUE(execution_stop_id,ordinal)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_execution_stop_v2
BEFORE INSERT ON execution_stops_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=gh.execution_graph_revision_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND gh.status='RUNNING' AND NEW.stop_generation=gh.stop_generation+1
    AND g.record_sha256=NEW.execution_graph_revision_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Execution stop authority closure mismatch'); END;

CREATE TABLE execution_graph_terminal_receipts_v2 (
  execution_graph_terminal_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  terminal_status TEXT NOT NULL CHECK(terminal_status IN ('CLOSED','FAILED')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 256),
  current_postimage_root_sha256 TEXT NOT NULL CHECK(length(current_postimage_root_sha256)=64),
  integration_frontier_sha256 TEXT NOT NULL CHECK(length(integration_frontier_sha256)=64),
  node_frontier_root_sha256 TEXT NOT NULL CHECK(length(node_frontier_root_sha256)=64),
  failure_evidence_sha256 TEXT CHECK(failure_evidence_sha256 IS NULL OR length(failure_evidence_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  trust TEXT NOT NULL CHECK(trust='HOST_DERIVED'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((terminal_status='CLOSED')=(failure_evidence_sha256 IS NULL)),
  UNIQUE(execution_graph_terminal_receipt_id,execution_graph_revision_id,record_sha256)
) STRICT;

CREATE TABLE execution_graph_terminal_node_members_v2 (
  execution_graph_terminal_receipt_id TEXT NOT NULL
    REFERENCES execution_graph_terminal_receipts_v2(execution_graph_terminal_receipt_id),
  execution_graph_revision_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  status TEXT NOT NULL CHECK(status IN (
    'EVIDENCE_ACCEPTED','PATCH_INTEGRATED','ORACLE_PASSED','REJECTED','INVALIDATED','STOPPED','FAILED'
  )),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(execution_graph_terminal_receipt_id,node_id),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  UNIQUE(execution_graph_terminal_receipt_id,ordinal)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_execution_graph_terminal_receipt_v2
BEFORE INSERT ON execution_graph_terminal_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_graph_heads_v2 gh
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE gh.run_id=NEW.run_id AND gh.goal_id=NEW.goal_id
    AND gh.execution_graph_revision_id=NEW.execution_graph_revision_id
    AND gh.execution_graph_revision_sha256=NEW.execution_graph_revision_sha256
    AND gh.status IN ('RUNNING','STOPPED')
    AND gh.current_postimage_root_sha256=NEW.current_postimage_root_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Execution graph terminal authority closure mismatch'); END;

CREATE TABLE execution_integration_attempts_v2 (
  integration_attempt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  execution_graph_revision_id TEXT NOT NULL REFERENCES execution_graph_revisions_v2(execution_graph_revision_id),
  execution_graph_revision_sha256 TEXT NOT NULL CHECK(length(execution_graph_revision_sha256)=64),
  node_id TEXT NOT NULL,
  node_spec_sha256 TEXT NOT NULL CHECK(length(node_spec_sha256)=64),
  proposal_id TEXT NOT NULL REFERENCES worker_proposals_v2(proposal_id),
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  expected_preimage_root_sha256 TEXT NOT NULL CHECK(length(expected_preimage_root_sha256)=64),
  patch_set_id TEXT NOT NULL,
  patch_set_sha256 TEXT NOT NULL CHECK(length(patch_set_sha256)=64),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  owner_hmac TEXT NOT NULL CHECK(length(owner_hmac)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=1),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(execution_graph_revision_id,node_id)
    REFERENCES execution_nodes_v2(execution_graph_revision_id,node_id),
  FOREIGN KEY(patch_set_id,proposal_id,patch_set_sha256)
    REFERENCES worker_patch_sets_v2(patch_set_id,proposal_id,record_sha256),
  UNIQUE(run_id,lease_generation),
  UNIQUE(run_id,fencing_token)
) STRICT;

CREATE TABLE execution_integration_transitions_v2 (
  integration_transition_id TEXT PRIMARY KEY,
  integration_attempt_id TEXT NOT NULL REFERENCES execution_integration_attempts_v2(integration_attempt_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','OBSERVED','COMMITTED','REJECTED','FENCED')),
  predecessor_transition_sha256 TEXT CHECK(predecessor_transition_sha256 IS NULL OR length(predecessor_transition_sha256)=64),
  postimage_root_sha256 TEXT CHECK(postimage_root_sha256 IS NULL OR length(postimage_root_sha256)=64),
  failure_sha256 TEXT CHECK(failure_sha256 IS NULL OR length(failure_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(integration_attempt_id,ordinal),
  CHECK((ordinal=0 AND state='PREPARED' AND predecessor_transition_sha256 IS NULL)
    OR (ordinal>0 AND state<>'PREPARED' AND predecessor_transition_sha256 IS NOT NULL)),
  CHECK((state IN ('OBSERVED','COMMITTED') AND postimage_root_sha256 IS NOT NULL)
    OR (state NOT IN ('OBSERVED','COMMITTED') AND postimage_root_sha256 IS NULL))
) STRICT;

CREATE TABLE execution_integration_heads_v2 (
  run_id TEXT PRIMARY KEY REFERENCES managed_runs_v1(run_id),
  integration_attempt_id TEXT REFERENCES execution_integration_attempts_v2(integration_attempt_id),
  latest_transition_sha256 TEXT CHECK(latest_transition_sha256 IS NULL OR length(latest_transition_sha256)=64),
  state TEXT NOT NULL CHECK(state IN ('IDLE','PREPARED','OBSERVED','COMMITTED','REJECTED','FENCED')),
  current_postimage_root_sha256 TEXT NOT NULL CHECK(length(current_postimage_root_sha256)=64),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=0),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=0),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  CHECK((state='IDLE' AND integration_attempt_id IS NULL AND latest_transition_sha256 IS NULL)
    OR (state<>'IDLE' AND integration_attempt_id IS NOT NULL AND latest_transition_sha256 IS NOT NULL))
) STRICT;

CREATE INDEX ix_execution_nodes_ready_v2 ON execution_node_heads_v2(execution_graph_revision_id,status,node_id);
CREATE INDEX ix_task_packets_node_v2 ON task_packets_v2(execution_graph_revision_id,node_id,attempt);
CREATE INDEX ix_execution_node_attempt_outcomes_v2
  ON execution_node_attempt_outcomes_v2(execution_graph_revision_id,node_id,attempt);
CREATE INDEX ix_worker_proposals_node_v2 ON worker_proposals_v2(execution_graph_revision_id,node_id,created_event_sequence);
CREATE INDEX ix_worker_patch_sets_proposal_v2 ON worker_patch_sets_v2(proposal_id,created_event_sequence);
CREATE INDEX ix_host_oracle_receipts_node_v2
  ON host_oracle_receipts_v2(execution_graph_revision_id,node_id,created_event_sequence);
CREATE INDEX ix_host_node_receipts_node_v2 ON host_node_receipts_v2(execution_graph_revision_id,node_id,kind,created_event_sequence);
CREATE INDEX ix_execution_graph_terminal_status_v2
  ON execution_graph_terminal_receipts_v2(run_id,terminal_status,created_event_sequence);
CREATE INDEX ix_execution_stops_graph_v2 ON execution_stops_v2(execution_graph_revision_id,stop_generation);

CREATE TRIGGER no_update_topology_measurement_evidence_receipts_v2 BEFORE UPDATE ON topology_measurement_evidence_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology measurement evidence receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_topology_measurement_evidence_receipts_v2 BEFORE DELETE ON topology_measurement_evidence_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology measurement evidence receipts V2 are immutable'); END;
CREATE TRIGGER no_update_topology_measurement_receipts_v2 BEFORE UPDATE ON topology_measurement_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology measurement receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_topology_measurement_receipts_v2 BEFORE DELETE ON topology_measurement_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology measurement receipts V2 are immutable'); END;
CREATE TRIGGER no_update_execution_graph_revisions_v2 BEFORE UPDATE ON execution_graph_revisions_v2
BEGIN SELECT RAISE(ABORT,'Execution graph revisions V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_graph_revisions_v2 BEFORE DELETE ON execution_graph_revisions_v2
BEGIN SELECT RAISE(ABORT,'Execution graph revisions V2 are immutable'); END;
CREATE TRIGGER no_update_execution_nodes_v2 BEFORE UPDATE ON execution_nodes_v2
BEGIN SELECT RAISE(ABORT,'Execution nodes V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_nodes_v2 BEFORE DELETE ON execution_nodes_v2
BEGIN SELECT RAISE(ABORT,'Execution nodes V2 are immutable'); END;
CREATE TRIGGER no_update_execution_edges_v2 BEFORE UPDATE ON execution_edges_v2
BEGIN SELECT RAISE(ABORT,'Execution edges V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_edges_v2 BEFORE DELETE ON execution_edges_v2
BEGIN SELECT RAISE(ABORT,'Execution edges V2 are immutable'); END;
CREATE TRIGGER no_update_task_packets_v2 BEFORE UPDATE ON task_packets_v2
BEGIN SELECT RAISE(ABORT,'TaskPackets V2 are immutable'); END;
CREATE TRIGGER no_delete_task_packets_v2 BEFORE DELETE ON task_packets_v2
BEGIN SELECT RAISE(ABORT,'TaskPackets V2 are immutable'); END;
CREATE TRIGGER no_update_execution_node_leases_v2 BEFORE UPDATE ON execution_node_leases_v2
BEGIN SELECT RAISE(ABORT,'Execution node leases V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_node_leases_v2 BEFORE DELETE ON execution_node_leases_v2
BEGIN SELECT RAISE(ABORT,'Execution node leases V2 are immutable'); END;
CREATE TRIGGER no_update_execution_node_attempt_outcomes_v2 BEFORE UPDATE ON execution_node_attempt_outcomes_v2
BEGIN SELECT RAISE(ABORT,'Execution node attempt outcomes V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_node_attempt_outcomes_v2 BEFORE DELETE ON execution_node_attempt_outcomes_v2
BEGIN SELECT RAISE(ABORT,'Execution node attempt outcomes V2 are immutable'); END;
CREATE TRIGGER no_update_worker_proposals_v2 BEFORE UPDATE ON worker_proposals_v2
BEGIN SELECT RAISE(ABORT,'Worker proposals V2 are immutable'); END;
CREATE TRIGGER no_delete_worker_proposals_v2 BEFORE DELETE ON worker_proposals_v2
BEGIN SELECT RAISE(ABORT,'Worker proposals V2 are immutable'); END;
CREATE TRIGGER no_update_worker_patch_sets_v2 BEFORE UPDATE ON worker_patch_sets_v2
BEGIN SELECT RAISE(ABORT,'Worker PatchSets V2 are immutable'); END;
CREATE TRIGGER no_delete_worker_patch_sets_v2 BEFORE DELETE ON worker_patch_sets_v2
BEGIN SELECT RAISE(ABORT,'Worker PatchSets V2 are immutable'); END;
CREATE TRIGGER no_update_worker_patch_set_artifacts_v2 BEFORE UPDATE ON worker_patch_set_artifacts_v2
BEGIN SELECT RAISE(ABORT,'Worker PatchSet artifacts V2 are immutable'); END;
CREATE TRIGGER no_delete_worker_patch_set_artifacts_v2 BEFORE DELETE ON worker_patch_set_artifacts_v2
BEGIN SELECT RAISE(ABORT,'Worker PatchSet artifacts V2 are immutable'); END;
CREATE TRIGGER no_update_host_oracle_receipts_v2 BEFORE UPDATE ON host_oracle_receipts_v2
BEGIN SELECT RAISE(ABORT,'Host OracleReceipts V2 are immutable'); END;
CREATE TRIGGER no_delete_host_oracle_receipts_v2 BEFORE DELETE ON host_oracle_receipts_v2
BEGIN SELECT RAISE(ABORT,'Host OracleReceipts V2 are immutable'); END;
CREATE TRIGGER no_update_host_oracle_evidence_members_v2 BEFORE UPDATE ON host_oracle_evidence_members_v2
BEGIN SELECT RAISE(ABORT,'Host OracleReceipt evidence V2 is immutable'); END;
CREATE TRIGGER no_delete_host_oracle_evidence_members_v2 BEFORE DELETE ON host_oracle_evidence_members_v2
BEGIN SELECT RAISE(ABORT,'Host OracleReceipt evidence V2 is immutable'); END;
CREATE TRIGGER no_update_host_node_receipts_v2 BEFORE UPDATE ON host_node_receipts_v2
BEGIN SELECT RAISE(ABORT,'Host node receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_host_node_receipts_v2 BEFORE DELETE ON host_node_receipts_v2
BEGIN SELECT RAISE(ABORT,'Host node receipts V2 are immutable'); END;
CREATE TRIGGER no_update_execution_stops_v2 BEFORE UPDATE ON execution_stops_v2
BEGIN SELECT RAISE(ABORT,'Execution stops V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_stops_v2 BEFORE DELETE ON execution_stops_v2
BEGIN SELECT RAISE(ABORT,'Execution stops V2 are immutable'); END;
CREATE TRIGGER no_update_execution_stop_node_members_v2 BEFORE UPDATE ON execution_stop_node_members_v2
BEGIN SELECT RAISE(ABORT,'Execution stop members V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_stop_node_members_v2 BEFORE DELETE ON execution_stop_node_members_v2
BEGIN SELECT RAISE(ABORT,'Execution stop members V2 are immutable'); END;
CREATE TRIGGER no_update_execution_graph_terminal_receipts_v2 BEFORE UPDATE ON execution_graph_terminal_receipts_v2
BEGIN SELECT RAISE(ABORT,'Execution graph terminal receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_graph_terminal_receipts_v2 BEFORE DELETE ON execution_graph_terminal_receipts_v2
BEGIN SELECT RAISE(ABORT,'Execution graph terminal receipts V2 are immutable'); END;
CREATE TRIGGER no_update_execution_graph_terminal_node_members_v2 BEFORE UPDATE ON execution_graph_terminal_node_members_v2
BEGIN SELECT RAISE(ABORT,'Execution graph terminal node members V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_graph_terminal_node_members_v2 BEFORE DELETE ON execution_graph_terminal_node_members_v2
BEGIN SELECT RAISE(ABORT,'Execution graph terminal node members V2 are immutable'); END;
CREATE TRIGGER no_update_execution_integration_attempts_v2 BEFORE UPDATE ON execution_integration_attempts_v2
BEGIN SELECT RAISE(ABORT,'Execution integration attempts V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_integration_attempts_v2 BEFORE DELETE ON execution_integration_attempts_v2
BEGIN SELECT RAISE(ABORT,'Execution integration attempts V2 are immutable'); END;
CREATE TRIGGER no_update_execution_integration_transitions_v2 BEFORE UPDATE ON execution_integration_transitions_v2
BEGIN SELECT RAISE(ABORT,'Execution integration transitions V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_integration_transitions_v2 BEFORE DELETE ON execution_integration_transitions_v2
BEGIN SELECT RAISE(ABORT,'Execution integration transitions V2 are immutable'); END;
