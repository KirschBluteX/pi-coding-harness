-- Transaction ownership belongs to migrateHarnessStore so schema bytes and the
-- schema_migrations record commit atomically.

CREATE TABLE managed_runs_v1 (
  run_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL UNIQUE REFERENCES goals(goal_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  created_by_host_hmac TEXT NOT NULL CHECK(length(created_by_host_hmac)=64),
  initial_config_sha256 TEXT NOT NULL CHECK(length(initial_config_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE managed_run_heads_v1 (
  run_id TEXT PRIMARY KEY REFERENCES managed_runs_v1(run_id),
  requested_topology TEXT NOT NULL CHECK(requested_topology IN ('SINGLE','MULTI')),
  effective_topology TEXT NOT NULL CHECK(effective_topology IN ('SINGLE','MULTI')),
  topology_revision INTEGER NOT NULL CHECK(topology_revision>=1),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','RECONCILING','SUCCEEDED','FAILED','CANCELED')),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE TABLE topology_revisions_v1 (
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  requested_topology TEXT NOT NULL CHECK(requested_topology IN ('SINGLE','MULTI')),
  effective_topology TEXT NOT NULL CHECK(effective_topology IN ('SINGLE','MULTI')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 160),
  decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(run_id,revision)
) WITHOUT ROWID, STRICT;

CREATE TABLE work_shards_v1 (
  shard_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  logical_key TEXT NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 160),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),
  role TEXT NOT NULL CHECK(role IN ('SUPERVISOR','PLANNER','EXPLORER','IMPLEMENTER','VERIFIER','INTEGRATOR')),
  outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 32768),
  read_roots_json TEXT NOT NULL CHECK(json_valid(read_roots_json) AND json_type(read_roots_json)='array' AND length(read_roots_json)<=131072),
  write_roots_json TEXT NOT NULL CHECK(json_valid(write_roots_json) AND json_type(write_roots_json)='array' AND length(write_roots_json)<=131072),
  oracle_json TEXT NOT NULL CHECK(json_valid(oracle_json) AND json_type(oracle_json)='object' AND length(oracle_json)<=32768),
  packet_budget_json TEXT NOT NULL CHECK(json_valid(packet_budget_json) AND json_type(packet_budget_json)='object' AND length(packet_budget_json)<=32768),
  spec_sha256 TEXT NOT NULL UNIQUE CHECK(length(spec_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(run_id,work_cell_id,logical_key),
  UNIQUE(run_id,work_cell_id,ordinal)
) STRICT;

CREATE TABLE work_shard_dependencies_v1 (
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  depends_on_shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  PRIMARY KEY(shard_id,depends_on_shard_id),
  CHECK(shard_id<>depends_on_shard_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE work_shard_heads_v1 (
  shard_id TEXT PRIMARY KEY REFERENCES work_shards_v1(shard_id),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED','READY','LEASED','RUNNING','RESULT_SUBMITTED','INTEGRATING','SUCCEEDED','REJECTED','CANCELED','SUPERSEDED','FAILED')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
  latest_worker_run_id TEXT,
  result_sha256 TEXT CHECK(result_sha256 IS NULL OR length(result_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE TABLE task_packets_v1 (
  packet_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND json_type(packet_json)='object' AND length(packet_json)<=1048576),
  packet_sha256 TEXT NOT NULL UNIQUE CHECK(length(packet_sha256)=64),
  capability_hmac TEXT NOT NULL CHECK(length(capability_hmac)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(shard_id,attempt)
) STRICT;

CREATE TABLE shard_lease_generations_v1 (
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  owner_hmac TEXT NOT NULL CHECK(length(owner_hmac)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),
  lease_sha256 TEXT NOT NULL UNIQUE CHECK(length(lease_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(shard_id,generation),
  UNIQUE(shard_id,fencing_token)
) WITHOUT ROWID, STRICT;

CREATE TABLE shard_lease_heads_v1 (
  shard_id TEXT PRIMARY KEY REFERENCES work_shards_v1(shard_id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  owner_hmac TEXT NOT NULL CHECK(length(owner_hmac)=64),
  worker_run_id TEXT,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),
  released_at_ms INTEGER CHECK(released_at_ms IS NULL OR released_at_ms>=0),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  FOREIGN KEY(shard_id,generation) REFERENCES shard_lease_generations_v1(shard_id,generation)
) STRICT;

CREATE TABLE worker_runs_v1 (
  worker_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  packet_id TEXT NOT NULL REFERENCES task_packets_v1(packet_id),
  role TEXT NOT NULL CHECK(role IN ('PLANNER','EXPLORER','IMPLEMENTER','VERIFIER','INTEGRATOR')),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  sandbox_kind TEXT NOT NULL CHECK(sandbox_kind IN ('NONE_READ_ONLY','SCOPED_MIRROR','DIRECTORY_CLONE','GIT_WORKTREE','CONTAINER_OVERLAY')),
  model_fingerprint_hmac TEXT NOT NULL CHECK(length(model_fingerprint_hmac)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(shard_id,attempt),
  FOREIGN KEY(shard_id,lease_generation) REFERENCES shard_lease_generations_v1(shard_id,generation)
) STRICT;

CREATE TABLE worker_run_transitions_v1 (
  transition_id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL REFERENCES worker_runs_v1(worker_run_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','SUCCEEDED','FAILED','ABORTED','TIMED_OUT','FENCED')),
  output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256)=64),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json) AND json_type(usage_json)='object' AND length(usage_json)<=32768),
  failure_signature_sha256 TEXT CHECK(failure_signature_sha256 IS NULL OR length(failure_signature_sha256)=64),
  predecessor_sha256 TEXT CHECK(predecessor_sha256 IS NULL OR length(predecessor_sha256)=64),
  transition_sha256 TEXT NOT NULL UNIQUE CHECK(length(transition_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(worker_run_id,ordinal)
) STRICT;

CREATE TABLE worker_results_v1 (
  result_id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL UNIQUE REFERENCES worker_runs_v1(worker_run_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  result_kind TEXT NOT NULL CHECK(result_kind IN ('ANALYSIS','PLAN','PATCH','VERIFICATION','INTEGRATION','NO_CHANGES')),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  artifact_locator_hmac TEXT NOT NULL CHECK(length(artifact_locator_hmac)=64),
  trust TEXT NOT NULL CHECK(trust IN ('UNVERIFIED','VERIFIED','REJECTED')),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE patch_sets_v1 (
  patch_set_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  worker_run_id TEXT NOT NULL UNIQUE REFERENCES worker_runs_v1(worker_run_id),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json) AND json_type(entries_json)='array' AND length(entries_json)<=1048576),
  patch_sha256 TEXT NOT NULL UNIQUE CHECK(length(patch_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE integration_receipts_v1 (
  integration_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  patch_set_id TEXT REFERENCES patch_sets_v1(patch_set_id),
  result TEXT NOT NULL CHECK(result IN ('APPLIED','NO_CHANGES','CONFLICT','REJECTED','OUTCOME_UNKNOWN')),
  preimage_root_sha256 TEXT NOT NULL CHECK(length(preimage_root_sha256)=64),
  postimage_root_sha256 TEXT CHECK(postimage_root_sha256 IS NULL OR length(postimage_root_sha256)=64),
  conflict_paths_json TEXT NOT NULL CHECK(json_valid(conflict_paths_json) AND json_type(conflict_paths_json)='array' AND length(conflict_paths_json)<=131072),
  operation_ids_json TEXT NOT NULL CHECK(json_valid(operation_ids_json) AND json_type(operation_ids_json)='array' AND length(operation_ids_json)<=131072),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE execution_subject_bindings_v2 (
  binding_sha256 TEXT PRIMARY KEY CHECK(length(binding_sha256)=64),
  run_id TEXT REFERENCES managed_runs_v1(run_id),
  goal_id TEXT REFERENCES goals(goal_id),
  work_cell_id TEXT REFERENCES work_cells_v1(work_cell_id),
  shard_id TEXT REFERENCES work_shards_v1(shard_id),
  worker_run_id TEXT REFERENCES worker_runs_v1(worker_run_id),
  role TEXT CHECK(role IS NULL OR role IN ('SUPERVISOR','PLANNER','EXPLORER','IMPLEMENTER','VERIFIER','INTEGRATOR')),
  topology_revision INTEGER CHECK(topology_revision IS NULL OR topology_revision>=1),
  attempt INTEGER CHECK(attempt IS NULL OR attempt>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json)='object' AND length(record_json)<=32768),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE memory_visibility_bindings_v1 (
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK(claim_version>=1),
  audience TEXT NOT NULL CHECK(audience IN ('SUPERVISOR_PRIVATE','ROLE_LOCAL','VERIFIED_SHARED')),
  role TEXT CHECK(role IS NULL OR role IN ('PLANNER','EXPLORER','IMPLEMENTER','VERIFIER','INTEGRATOR')),
  module_key TEXT CHECK(module_key IS NULL OR length(module_key) BETWEEN 1 AND 160),
  verifier_receipt_sha256 TEXT CHECK(verifier_receipt_sha256 IS NULL OR length(verifier_receipt_sha256)=64),
  binding_sha256 TEXT NOT NULL UNIQUE CHECK(length(binding_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(claim_id,claim_version),
  FOREIGN KEY(claim_id,claim_version) REFERENCES memory_v3_claim_versions(claim_id,version),
  CHECK((audience='ROLE_LOCAL' AND role IS NOT NULL) OR (audience<>'ROLE_LOCAL' AND role IS NULL)),
  CHECK((audience='VERIFIED_SHARED' AND verifier_receipt_sha256 IS NOT NULL) OR audience<>'VERIFIED_SHARED')
) WITHOUT ROWID, STRICT;

CREATE INDEX work_shards_ready_v1 ON work_shard_heads_v1(status,updated_event_sequence);
CREATE INDEX worker_runs_by_run_v1 ON worker_runs_v1(run_id,created_event_sequence);
CREATE INDEX worker_transitions_by_run_v1 ON worker_run_transitions_v1(worker_run_id,ordinal DESC);
CREATE INDEX integrations_by_run_v1 ON integration_receipts_v1(run_id,created_event_sequence);

CREATE TRIGGER no_update_managed_runs_v1 BEFORE UPDATE ON managed_runs_v1 BEGIN SELECT RAISE(ABORT,'managed run facts are immutable'); END;
CREATE TRIGGER no_delete_managed_runs_v1 BEFORE DELETE ON managed_runs_v1 BEGIN SELECT RAISE(ABORT,'managed run facts cannot be deleted'); END;
CREATE TRIGGER no_update_topology_revisions_v1 BEFORE UPDATE ON topology_revisions_v1 BEGIN SELECT RAISE(ABORT,'topology revisions are immutable'); END;
CREATE TRIGGER no_delete_topology_revisions_v1 BEFORE DELETE ON topology_revisions_v1 BEGIN SELECT RAISE(ABORT,'topology revisions cannot be deleted'); END;
CREATE TRIGGER no_update_work_shards_v1 BEFORE UPDATE ON work_shards_v1 BEGIN SELECT RAISE(ABORT,'work shards are immutable'); END;
CREATE TRIGGER no_delete_work_shards_v1 BEFORE DELETE ON work_shards_v1 BEGIN SELECT RAISE(ABORT,'work shards cannot be deleted'); END;
CREATE TRIGGER no_update_task_packets_v1 BEFORE UPDATE ON task_packets_v1 BEGIN SELECT RAISE(ABORT,'task packets are immutable'); END;
CREATE TRIGGER no_delete_task_packets_v1 BEFORE DELETE ON task_packets_v1 BEGIN SELECT RAISE(ABORT,'task packets cannot be deleted'); END;
CREATE TRIGGER no_update_shard_lease_generations_v1 BEFORE UPDATE ON shard_lease_generations_v1 BEGIN SELECT RAISE(ABORT,'shard lease generations are immutable'); END;
CREATE TRIGGER no_delete_shard_lease_generations_v1 BEFORE DELETE ON shard_lease_generations_v1 BEGIN SELECT RAISE(ABORT,'shard lease generations cannot be deleted'); END;
CREATE TRIGGER no_update_worker_runs_v1 BEFORE UPDATE ON worker_runs_v1 BEGIN SELECT RAISE(ABORT,'worker runs are immutable'); END;
CREATE TRIGGER no_delete_worker_runs_v1 BEFORE DELETE ON worker_runs_v1 BEGIN SELECT RAISE(ABORT,'worker runs cannot be deleted'); END;
CREATE TRIGGER no_update_worker_run_transitions_v1 BEFORE UPDATE ON worker_run_transitions_v1 BEGIN SELECT RAISE(ABORT,'worker transitions are immutable'); END;
CREATE TRIGGER no_delete_worker_run_transitions_v1 BEFORE DELETE ON worker_run_transitions_v1 BEGIN SELECT RAISE(ABORT,'worker transitions cannot be deleted'); END;
CREATE TRIGGER no_update_worker_results_v1 BEFORE UPDATE ON worker_results_v1 BEGIN SELECT RAISE(ABORT,'worker results are immutable'); END;
CREATE TRIGGER no_delete_worker_results_v1 BEFORE DELETE ON worker_results_v1 BEGIN SELECT RAISE(ABORT,'worker results cannot be deleted'); END;
CREATE TRIGGER no_update_patch_sets_v1 BEFORE UPDATE ON patch_sets_v1 BEGIN SELECT RAISE(ABORT,'patch sets are immutable'); END;
CREATE TRIGGER no_delete_patch_sets_v1 BEFORE DELETE ON patch_sets_v1 BEGIN SELECT RAISE(ABORT,'patch sets cannot be deleted'); END;
CREATE TRIGGER no_update_integration_receipts_v1 BEFORE UPDATE ON integration_receipts_v1 BEGIN SELECT RAISE(ABORT,'integration receipts are immutable'); END;
CREATE TRIGGER no_delete_integration_receipts_v1 BEFORE DELETE ON integration_receipts_v1 BEGIN SELECT RAISE(ABORT,'integration receipts cannot be deleted'); END;
CREATE TRIGGER no_update_execution_subject_bindings_v2 BEFORE UPDATE ON execution_subject_bindings_v2 BEGIN SELECT RAISE(ABORT,'execution subject bindings are immutable'); END;
CREATE TRIGGER no_delete_execution_subject_bindings_v2 BEFORE DELETE ON execution_subject_bindings_v2 BEGIN SELECT RAISE(ABORT,'execution subject bindings cannot be deleted'); END;
CREATE TRIGGER no_update_memory_visibility_bindings_v1 BEFORE UPDATE ON memory_visibility_bindings_v1 BEGIN SELECT RAISE(ABORT,'memory visibility bindings are immutable'); END;
CREATE TRIGGER no_delete_memory_visibility_bindings_v1 BEFORE DELETE ON memory_visibility_bindings_v1 BEGIN SELECT RAISE(ABORT,'memory visibility bindings cannot be deleted'); END;
