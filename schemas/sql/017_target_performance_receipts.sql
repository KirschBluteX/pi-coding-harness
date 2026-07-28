CREATE TABLE target_performance_measurements_v1 (
  measurement_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  performance_contract_sha256 TEXT NOT NULL CHECK(length(performance_contract_sha256)=64),
  phase TEXT NOT NULL CHECK(phase IN ('BASELINE','BASELINE_PROFILE','CANDIDATE','REGRESSION','HOLDOUT')),
  operation_id TEXT NOT NULL,
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64),
  output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
  workload_key TEXT NOT NULL CHECK(length(workload_key) BETWEEN 1 AND 160),
  metric_key TEXT NOT NULL CHECK(length(metric_key) BETWEEN 1 AND 160),
  value REAL NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  sample_count INTEGER NOT NULL CHECK(sample_count>=1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  UNIQUE(operation_id,workload_key,metric_key)
) STRICT;

CREATE TABLE target_performance_verdicts_v1 (
  verdict_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  performance_contract_sha256 TEXT NOT NULL CHECK(length(performance_contract_sha256)=64),
  phase TEXT NOT NULL CHECK(phase IN ('BASELINE','BASELINE_PROFILE','CANDIDATE','REGRESSION','HOLDOUT')),
  measurement_root_sha256 TEXT NOT NULL CHECK(length(measurement_root_sha256)=64),
  baseline_root_sha256 TEXT CHECK(baseline_root_sha256 IS NULL OR length(baseline_root_sha256)=64),
  verdict TEXT NOT NULL CHECK(verdict IN ('PASS','FAIL')),
  reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json) AND json_type(reasons_json)='array' AND length(reasons_json)<=65536),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64)
) STRICT;

CREATE INDEX ix_target_performance_measurement_phase_v1
  ON target_performance_measurements_v1(goal_id,phase,created_at_ms,measurement_id);
CREATE INDEX ix_target_performance_verdict_cell_v1
  ON target_performance_verdicts_v1(work_cell_id,created_at_ms,verdict_id);

CREATE TRIGGER no_update_target_performance_measurements_v1 BEFORE UPDATE ON target_performance_measurements_v1 BEGIN SELECT RAISE(ABORT, 'Target performance measurements are immutable'); END;
CREATE TRIGGER no_delete_target_performance_measurements_v1 BEFORE DELETE ON target_performance_measurements_v1 BEGIN SELECT RAISE(ABORT, 'Target performance measurements are immutable'); END;
CREATE TRIGGER no_update_target_performance_verdicts_v1 BEFORE UPDATE ON target_performance_verdicts_v1 BEGIN SELECT RAISE(ABORT, 'Target performance verdicts are immutable'); END;
CREATE TRIGGER no_delete_target_performance_verdicts_v1 BEFORE DELETE ON target_performance_verdicts_v1 BEGIN SELECT RAISE(ABORT, 'Target performance verdicts are immutable'); END;
