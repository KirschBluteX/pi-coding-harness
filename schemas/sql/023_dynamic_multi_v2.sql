-- Dynamic Multi V2 is additive. A requested MULTI topology is permission only;
-- these Host-derived records determine whether it becomes effective.

CREATE TABLE strong_single_baselines_v2 (
  strong_single_baseline_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  correctness TEXT NOT NULL CHECK(correctness IN ('PASS','FAIL')),
  quality_basis_points INTEGER NOT NULL CHECK(quality_basis_points BETWEEN 0 AND 10000),
  wall_time_ms INTEGER NOT NULL CHECK(wall_time_ms>=0),
  provider_requests INTEGER NOT NULL CHECK(provider_requests>=0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  user_interventions INTEGER NOT NULL CHECK(user_interventions>=0),
  safety_events INTEGER NOT NULL CHECK(safety_events>=0),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(strong_single_baseline_id,goal_id,plan_revision_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_strong_single_plan_v2
BEFORE INSERT ON strong_single_baselines_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  WHERE p.plan_revision_id=NEW.plan_revision_id AND p.goal_id=NEW.goal_id
    AND p.record_sha256=NEW.plan_revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Strong Single baseline Plan closure mismatch'); END;

CREATE TABLE dynamic_multi_candidates_v2 (
  multi_candidate_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64),
  total_node_count INTEGER NOT NULL CHECK(total_node_count BETWEEN 0 AND 4096),
  independent_node_count INTEGER NOT NULL CHECK(independent_node_count BETWEEN 0 AND total_node_count),
  cross_partition_dependency_count INTEGER NOT NULL CHECK(cross_partition_dependency_count BETWEEN 0 AND 32768),
  write_scope_conflict_count INTEGER NOT NULL CHECK(write_scope_conflict_count BETWEEN 0 AND 32768),
  task_packets_complete INTEGER NOT NULL CHECK(task_packets_complete IN (0,1)),
  independent_validation INTEGER NOT NULL CHECK(independent_validation IN (0,1)),
  estimated_quality_basis_points INTEGER NOT NULL CHECK(estimated_quality_basis_points BETWEEN 0 AND 10000),
  estimated_wall_time_ms INTEGER NOT NULL CHECK(estimated_wall_time_ms>=0),
  estimated_provider_requests INTEGER NOT NULL CHECK(estimated_provider_requests>=0),
  estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens>=0),
  estimated_output_tokens INTEGER NOT NULL CHECK(estimated_output_tokens>=0),
  estimated_user_interventions INTEGER NOT NULL CHECK(estimated_user_interventions>=0),
  estimated_safety_events INTEGER NOT NULL CHECK(estimated_safety_events>=0),
  simulator_receipt_sha256 TEXT NOT NULL CHECK(length(simulator_receipt_sha256)=64),
  estimated_at_ms INTEGER NOT NULL CHECK(estimated_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(multi_candidate_id,goal_id,plan_revision_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_dynamic_multi_plan_v2
BEFORE INSERT ON dynamic_multi_candidates_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  WHERE p.plan_revision_id=NEW.plan_revision_id AND p.goal_id=NEW.goal_id
    AND p.record_sha256=NEW.plan_revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Dynamic Multi candidate Plan closure mismatch'); END;

CREATE TABLE topology_gate_receipts_v2 (
  topology_gate_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  requested_topology TEXT NOT NULL CHECK(requested_topology IN ('SINGLE','MULTI')),
  effective_topology TEXT NOT NULL CHECK(effective_topology IN ('SINGLE','MULTI')),
  verdict TEXT NOT NULL CHECK(verdict IN ('ALLOW','DENY')),
  reason_code TEXT NOT NULL CHECK(reason_code IN (
    'SINGLE_REQUESTED','STRONG_SINGLE_BASELINE_REQUIRED','STRONG_SINGLE_BASELINE_FAILED',
    'MULTI_CANDIDATE_REQUIRED','INSUFFICIENT_PARALLELISM','TASK_PACKET_CLOSURE_INCOMPLETE',
    'WRITE_SCOPE_CONFLICT','INDEPENDENT_VALIDATION_REQUIRED','NO_NET_BENEFIT',
    'COST_OR_SAFETY_REGRESSION','MULTI_NET_BENEFIT_PROVEN'
  )),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  strong_single_baseline_id TEXT,
  strong_single_baseline_sha256 TEXT CHECK(strong_single_baseline_sha256 IS NULL OR length(strong_single_baseline_sha256)=64),
  multi_candidate_id TEXT,
  multi_candidate_sha256 TEXT CHECK(multi_candidate_sha256 IS NULL OR length(multi_candidate_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((strong_single_baseline_id IS NULL)=(strong_single_baseline_sha256 IS NULL)),
  CHECK((multi_candidate_id IS NULL)=(multi_candidate_sha256 IS NULL)),
  CHECK((requested_topology='SINGLE' AND effective_topology='SINGLE' AND verdict='ALLOW'
      AND reason_code='SINGLE_REQUESTED' AND strong_single_baseline_id IS NULL AND multi_candidate_id IS NULL)
    OR (requested_topology='MULTI' AND effective_topology='SINGLE' AND verdict='DENY'
      AND reason_code<>'MULTI_NET_BENEFIT_PROVEN')
    OR (requested_topology='MULTI' AND effective_topology='MULTI' AND verdict='ALLOW'
      AND reason_code='MULTI_NET_BENEFIT_PROVEN'
      AND strong_single_baseline_id IS NOT NULL AND multi_candidate_id IS NOT NULL)),
  FOREIGN KEY(run_id) REFERENCES managed_runs_v1(run_id),
  FOREIGN KEY(plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(strong_single_baseline_id,goal_id,plan_revision_id,strong_single_baseline_sha256)
    REFERENCES strong_single_baselines_v2(strong_single_baseline_id,goal_id,plan_revision_id,record_sha256),
  FOREIGN KEY(multi_candidate_id,goal_id,plan_revision_id,multi_candidate_sha256)
    REFERENCES dynamic_multi_candidates_v2(multi_candidate_id,goal_id,plan_revision_id,record_sha256),
  UNIQUE(topology_gate_receipt_id,goal_id,run_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_topology_gate_closure_v2
BEFORE INSERT ON topology_gate_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM managed_runs_v1 r
  JOIN plan_revisions_v2 p ON p.plan_revision_id=NEW.plan_revision_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE r.run_id=NEW.run_id AND r.goal_id=NEW.goal_id
    AND p.goal_id=NEW.goal_id AND p.record_sha256=NEW.plan_revision_sha256
    AND e.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Topology Gate V2 authority closure mismatch'); END;

CREATE TABLE topology_revision_gate_bindings_v2 (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  goal_id TEXT NOT NULL,
  topology_revision_sha256 TEXT NOT NULL CHECK(length(topology_revision_sha256)=64),
  topology_gate_receipt_id TEXT NOT NULL,
  topology_gate_receipt_sha256 TEXT NOT NULL CHECK(length(topology_gate_receipt_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(run_id,revision),
  FOREIGN KEY(run_id,revision) REFERENCES topology_revisions_v1(run_id,revision),
  FOREIGN KEY(topology_gate_receipt_id,goal_id,run_id,topology_gate_receipt_sha256)
    REFERENCES topology_gate_receipts_v2(topology_gate_receipt_id,goal_id,run_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_topology_revision_gate_binding_v2
BEFORE INSERT ON topology_revision_gate_bindings_v2
WHEN NOT EXISTS (
  SELECT 1 FROM topology_revisions_v1 t
  JOIN topology_gate_receipts_v2 g ON g.topology_gate_receipt_id=NEW.topology_gate_receipt_id
  WHERE t.run_id=NEW.run_id AND t.revision=NEW.revision
    AND t.record_sha256=NEW.topology_revision_sha256
    AND g.goal_id=NEW.goal_id AND g.run_id=NEW.run_id
    AND g.record_sha256=NEW.topology_gate_receipt_sha256
    AND g.requested_topology=t.requested_topology AND g.effective_topology=t.effective_topology
    AND g.config_sha256=t.config_sha256
    AND t.created_event_sequence=NEW.created_event_sequence
    AND g.created_event_sequence=NEW.created_event_sequence
)
BEGIN SELECT RAISE(ABORT,'Topology revision lacks its exact Gate V2 receipt'); END;

CREATE INDEX ix_strong_single_baselines_v2_closure
  ON strong_single_baselines_v2(goal_id,plan_revision_id,input_closure_sha256,runtime_fingerprint_sha256);
CREATE INDEX ix_dynamic_multi_candidates_v2_closure
  ON dynamic_multi_candidates_v2(goal_id,plan_revision_id,input_closure_sha256,runtime_fingerprint_sha256);
CREATE INDEX ix_topology_gate_receipts_v2_run
  ON topology_gate_receipts_v2(run_id,created_event_sequence);

CREATE TRIGGER no_update_strong_single_baselines_v2 BEFORE UPDATE ON strong_single_baselines_v2
BEGIN SELECT RAISE(ABORT,'Strong Single baselines V2 are immutable'); END;
CREATE TRIGGER no_delete_strong_single_baselines_v2 BEFORE DELETE ON strong_single_baselines_v2
BEGIN SELECT RAISE(ABORT,'Strong Single baselines V2 are immutable'); END;
CREATE TRIGGER no_update_dynamic_multi_candidates_v2 BEFORE UPDATE ON dynamic_multi_candidates_v2
BEGIN SELECT RAISE(ABORT,'Dynamic Multi candidates V2 are immutable'); END;
CREATE TRIGGER no_delete_dynamic_multi_candidates_v2 BEFORE DELETE ON dynamic_multi_candidates_v2
BEGIN SELECT RAISE(ABORT,'Dynamic Multi candidates V2 are immutable'); END;
CREATE TRIGGER no_update_topology_gate_receipts_v2 BEFORE UPDATE ON topology_gate_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology Gate receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_topology_gate_receipts_v2 BEFORE DELETE ON topology_gate_receipts_v2
BEGIN SELECT RAISE(ABORT,'Topology Gate receipts V2 are immutable'); END;
CREATE TRIGGER no_update_topology_revision_gate_bindings_v2 BEFORE UPDATE ON topology_revision_gate_bindings_v2
BEGIN SELECT RAISE(ABORT,'Topology Gate bindings V2 are immutable'); END;
CREATE TRIGGER no_delete_topology_revision_gate_bindings_v2 BEFORE DELETE ON topology_revision_gate_bindings_v2
BEGIN SELECT RAISE(ABORT,'Topology Gate bindings V2 are immutable'); END;
