-- Control-plane v2 additions are append-only. GoalContract and AcceptanceLedger
-- are committed by one AuthorityStore transaction.

CREATE TABLE task_flow_intake_evidence_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  source_intake_sha256 TEXT NOT NULL CHECK(length(source_intake_sha256)=64),
  source_content_sha256 TEXT NOT NULL CHECK(length(source_content_sha256)=64),
  source_text TEXT NOT NULL CHECK(length(source_text) BETWEEN 1 AND 131072),
  fidelity TEXT NOT NULL CHECK(fidelity IN ('EXACT','LEGACY_HASH_ONLY')),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(fidelity<>'EXACT' OR source_intake_sha256=source_content_sha256)
) STRICT;

CREATE TABLE acceptance_ledgers_v1 (
  ledger_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL UNIQUE REFERENCES goal_contract_versions_v1(contract_id),
  source_intake_sha256 TEXT NOT NULL CHECK(length(source_intake_sha256)=64),
  source_content_sha256 TEXT NOT NULL CHECK(length(source_content_sha256)=64),
  source_fidelity TEXT NOT NULL CHECK(source_fidelity IN ('EXACT','LEGACY_HASH_ONLY')),
  source_length INTEGER NOT NULL CHECK(source_length BETWEEN 1 AND 32768),
  ledger_json TEXT NOT NULL CHECK(json_valid(ledger_json) AND json_type(ledger_json)='object' AND length(ledger_json)<=1048576),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(source_fidelity<>'EXACT' OR source_intake_sha256=source_content_sha256)
) STRICT;

CREATE INDEX ix_acceptance_ledgers_goal_v1 ON acceptance_ledgers_v1(goal_id,created_event_sequence);

CREATE TRIGGER no_update_task_flow_intake_evidence_v1 BEFORE UPDATE ON task_flow_intake_evidence_v1
BEGIN SELECT RAISE(ABORT, 'Task Flow intake evidence is immutable'); END;
CREATE TRIGGER no_delete_task_flow_intake_evidence_v1 BEFORE DELETE ON task_flow_intake_evidence_v1
BEGIN SELECT RAISE(ABORT, 'Task Flow intake evidence is immutable'); END;

CREATE TRIGGER no_update_acceptance_ledgers_v1 BEFORE UPDATE ON acceptance_ledgers_v1
BEGIN SELECT RAISE(ABORT, 'Acceptance ledgers are immutable'); END;
CREATE TRIGGER no_delete_acceptance_ledgers_v1 BEFORE DELETE ON acceptance_ledgers_v1
BEGIN SELECT RAISE(ABORT, 'Acceptance ledgers are immutable'); END;
