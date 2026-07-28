PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS store_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  store_generation INTEGER NOT NULL CHECK(store_generation >= 1),
  leader_epoch INTEGER NOT NULL CHECK(leader_epoch >= 1),
  created_at_ms INTEGER NOT NULL,
  last_integrity_check_at_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  workspace_hmac TEXT NOT NULL UNIQUE CHECK(length(workspace_hmac) = 64),
  canonical_path_ciphertext BLOB,
  filesystem_kind TEXT NOT NULL,
  local_locking_verified INTEGER NOT NULL CHECK(local_locking_verified IN (0, 1)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  media_type TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'SECRET')),
  locator TEXT NOT NULL UNIQUE,
  encryption_key_id TEXT,
  created_at_ms INTEGER NOT NULL,
  retention_class TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS goals (
  goal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  origin_session_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK(length(objective) > 0),
  objective_sha256 TEXT NOT NULL CHECK(length(objective_sha256) = 64),
  intent TEXT NOT NULL CHECK(intent IN ('PLAN_ONLY', 'BUILD', 'PLAN_THEN_BUILD')),
  requirement_profile TEXT NOT NULL CHECK(requirement_profile IN ('TASK_SPEC', 'PRD')),
  planning_depth TEXT NOT NULL CHECK(planning_depth IN ('LIGHT', 'STANDARD', 'FULL')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS goal_constraints (
  constraint_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('SYSTEM', 'DEVELOPER', 'USER', 'PROJECT', 'RUNTIME')),
  source_locator TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  precedence INTEGER NOT NULL CHECK(precedence >= 0),
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'SECRET')),
  text_value TEXT,
  text_sha256 TEXT NOT NULL CHECK(length(text_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  criterion_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  statement TEXT NOT NULL CHECK(length(statement) > 0),
  criterion_class TEXT NOT NULL,
  required INTEGER NOT NULL CHECK(required = 1),
  spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS requirement_revisions (
  requirement_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  parent_requirement_id TEXT REFERENCES requirement_revisions(requirement_id),
  profile TEXT NOT NULL CHECK(profile IN ('TASK_SPEC', 'PRD')),
  status TEXT NOT NULL CHECK(status IN ('DRAFT', 'VALIDATED', 'FROZEN', 'SUPERSEDED')),
  trigger_type TEXT NOT NULL,
  trigger_evidence_sha256 TEXT NOT NULL CHECK(length(trigger_evidence_sha256) = 64),
  requirements_payload_sha256 TEXT NOT NULL CHECK(length(requirements_payload_sha256) = 64),
  requirements_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  markdown_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  validation_receipt_id TEXT,
  created_at_ms INTEGER NOT NULL,
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(goal_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS requirement_items (
  requirement_item_id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirement_revisions(requirement_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  category TEXT NOT NULL CHECK(category IN ('OUTCOME', 'FUNCTIONAL', 'QUALITY', 'USER_FLOW', 'CONSTRAINT', 'NON_GOAL')),
  priority TEXT CHECK(priority IS NULL OR priority IN ('MUST', 'SHOULD', 'COULD')),
  statement TEXT NOT NULL,
  item_sha256 TEXT NOT NULL CHECK(length(item_sha256) = 64),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  UNIQUE(requirement_id, category, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS requirement_acceptance_coverage (
  requirement_id TEXT NOT NULL REFERENCES requirement_revisions(requirement_id),
  requirement_item_id TEXT NOT NULL REFERENCES requirement_items(requirement_item_id),
  criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(criterion_id),
  PRIMARY KEY(requirement_id, requirement_item_id, criterion_id)
) STRICT;

CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  requirement_id TEXT NOT NULL REFERENCES requirement_revisions(requirement_id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  parent_plan_id TEXT REFERENCES plan_revisions(plan_id),
  trigger_type TEXT NOT NULL,
  trigger_evidence_sha256 TEXT NOT NULL CHECK(length(trigger_evidence_sha256) = 64),
  rationale TEXT NOT NULL,
  plan_payload_sha256 TEXT NOT NULL CHECK(length(plan_payload_sha256) = 64),
  plan_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  markdown_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  validation_receipt_id TEXT,
  created_at_ms INTEGER NOT NULL,
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(goal_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS plan_stages (
  stage_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  logical_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_horizon TEXT NOT NULL CHECK(detail_horizon IN ('CURRENT', 'NEAR', 'LATER')),
  risk TEXT NOT NULL CHECK(risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  entry_criteria_json TEXT NOT NULL CHECK(json_valid(entry_criteria_json)),
  exit_criteria_json TEXT NOT NULL CHECK(json_valid(exit_criteria_json)),
  outputs_json TEXT NOT NULL CHECK(json_valid(outputs_json)),
  failure_routes_json TEXT NOT NULL CHECK(json_valid(failure_routes_json)),
  spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256) = 64),
  UNIQUE(plan_id, logical_key),
  UNIQUE(plan_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS stage_dependencies (
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  depends_on_stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  PRIMARY KEY(plan_id, stage_id, depends_on_stage_id),
  CHECK(stage_id <> depends_on_stage_id)
) STRICT;

CREATE TABLE IF NOT EXISTS acceptance_stage_coverage (
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(criterion_id),
  stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  proof_rule TEXT NOT NULL,
  PRIMARY KEY(plan_id, criterion_id, stage_id)
) STRICT;

CREATE TABLE IF NOT EXISTS work_items (
  work_item_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  logical_key TEXT NOT NULL,
  action_spec_json TEXT NOT NULL CHECK(json_valid(action_spec_json)),
  effect_class TEXT NOT NULL CHECK(effect_class IN ('READ_ONLY', 'LOCAL_REVERSIBLE_WRITE', 'EXTERNAL_IDEMPOTENT_WRITE', 'EXTERNAL_UNKNOWN_WRITE', 'IRREVERSIBLE')),
  spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256) = 64),
  declared_input_closure_sha256 TEXT CHECK(declared_input_closure_sha256 IS NULL OR length(declared_input_closure_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(plan_id, stage_id, logical_key)
) STRICT;

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN_OUTCOME')),
  failure_signature_sha256 TEXT CHECK(failure_signature_sha256 IS NULL OR length(failure_signature_sha256) = 64),
  UNIQUE(work_item_id, attempt_number)
) STRICT;

CREATE TABLE IF NOT EXISTS assumptions (
  assumption_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  plan_id TEXT REFERENCES plan_revisions(plan_id),
  statement TEXT NOT NULL CHECK(length(statement) > 0),
  impact TEXT NOT NULL CHECK(impact IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  source_locator TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  initial_status TEXT NOT NULL CHECK(initial_status IN ('UNVERIFIED', 'SUPPORTED', 'REFUTED')),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS dependency_edges (
  edge_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  source_type TEXT NOT NULL CHECK(source_type IN ('REQUIREMENT', 'ASSUMPTION', 'RECEIPT', 'ARTIFACT', 'STAGE', 'WORK_ITEM', 'DECISION')),
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('REQUIREMENT', 'ASSUMPTION', 'RECEIPT', 'ARTIFACT', 'STAGE', 'WORK_ITEM', 'DECISION')),
  target_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL,
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(goal_id, source_type, source_id, target_type, target_id, dependency_kind)
) STRICT;

CREATE TABLE IF NOT EXISTS invalidations (
  invalidation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  cause_type TEXT NOT NULL,
  cause_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('REQUIREMENT', 'ASSUMPTION', 'RECEIPT', 'ARTIFACT', 'STAGE', 'WORK_ITEM', 'PLAN')),
  target_id TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
  reason TEXT NOT NULL,
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(goal_id, cause_type, cause_id, target_type, target_id, evidence_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  question TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK(json_valid(options_json)),
  recommended_option_id TEXT NOT NULL,
  recommendation_reason TEXT NOT NULL,
  materiality TEXT NOT NULL CHECK(materiality IN ('LOW', 'MEDIUM', 'HIGH')),
  reversible INTEGER NOT NULL CHECK(reversible IN (0, 1)),
  default_option_id TEXT,
  requested_event_sequence INTEGER NOT NULL CHECK(requested_event_sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS decision_resolutions (
  resolution_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  selected_option_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('USER', 'LOW_RISK_DEFAULT')),
  principal_locator TEXT,
  resolution_sha256 TEXT NOT NULL CHECK(length(resolution_sha256) = 64),
  resolved_event_sequence INTEGER NOT NULL CHECK(resolved_event_sequence >= 1),
  UNIQUE(decision_id)
) STRICT;

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  receipt_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(attempt_id),
  result TEXT NOT NULL CHECK(result IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'UNKNOWN_OUTCOME', 'WAIVED')),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256) = 64),
  output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256) = 64),
  failure_signature_sha256 TEXT CHECK(failure_signature_sha256 IS NULL OR length(failure_signature_sha256) = 64),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  issuer TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  issued_event_sequence INTEGER NOT NULL CHECK(issued_event_sequence >= 1),
  UNIQUE(goal_id, receipt_type, subject_type, subject_id, input_closure_sha256, result)
) STRICT;

CREATE TABLE IF NOT EXISTS receipt_artifacts (
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  role TEXT NOT NULL,
  PRIMARY KEY(receipt_id, artifact_id, role)
) STRICT;

CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  effect_class TEXT NOT NULL,
  normalized_target_sha256 TEXT NOT NULL CHECK(length(normalized_target_sha256) = 64),
  normalized_payload_sha256 TEXT NOT NULL CHECK(length(normalized_payload_sha256) = 64),
  idempotency_key_hmac TEXT NOT NULL CHECK(length(idempotency_key_hmac) = 64),
  precondition_sha256 TEXT CHECK(precondition_sha256 IS NULL OR length(precondition_sha256) = 64),
  intent_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(idempotency_key_hmac)
) STRICT;

CREATE TABLE IF NOT EXISTS effect_outcomes (
  outcome_id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL REFERENCES effects(effect_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('COMMITTED', 'FAILED', 'UNKNOWN_OUTCOME', 'RECONCILED_COMMITTED', 'RECONCILED_FAILED')),
  outcome_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  target_readback_sha256 TEXT CHECK(target_readback_sha256 IS NULL OR length(target_readback_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(effect_id)
) STRICT;

CREATE TABLE IF NOT EXISTS route_decisions (
  route_decision_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  plan_health_status TEXT NOT NULL CHECK(plan_health_status IN ('HEALTHY', 'DEGRADED', 'INVALID', 'NEEDS_USER', 'RECONCILING')),
  correction_level TEXT NOT NULL CHECK(correction_level IN ('L0', 'L1', 'L2', 'L3', 'L4', 'L5')),
  trigger_sha256 TEXT NOT NULL CHECK(length(trigger_sha256) = 64),
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
  selected_route_id TEXT NOT NULL,
  lexicographic_evidence_json TEXT NOT NULL CHECK(json_valid(lexicographic_evidence_json)),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS failure_signatures (
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  stage_id TEXT NOT NULL REFERENCES plan_stages(stage_id),
  signature_sha256 TEXT NOT NULL CHECK(length(signature_sha256) = 64),
  occurrence_count INTEGER NOT NULL CHECK(occurrence_count >= 1),
  last_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  highest_correction_level TEXT NOT NULL CHECK(highest_correction_level IN ('L1', 'L2', 'L3', 'L4', 'L5')),
  PRIMARY KEY(goal_id, stage_id, signature_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS execution_leases (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  owner_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_progress_event_sequence INTEGER NOT NULL CHECK(last_progress_event_sequence >= 1),
  row_version INTEGER NOT NULL CHECK(row_version >= 1),
  CHECK(expires_at_ms > acquired_at_ms)
) STRICT;

CREATE TABLE IF NOT EXISTS progress_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  goal_version INTEGER NOT NULL CHECK(goal_version >= 1),
  event_sequence INTEGER NOT NULL CHECK(event_sequence >= 1),
  reason TEXT NOT NULL,
  protected_state_json TEXT NOT NULL CHECK(json_valid(protected_state_json)),
  protected_state_sha256 TEXT NOT NULL CHECK(length(protected_state_sha256) = 64),
  snapshot_sha256 TEXT NOT NULL UNIQUE CHECK(length(snapshot_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(goal_id, event_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS milestone_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  snapshot_id TEXT NOT NULL REFERENCES progress_snapshots(snapshot_id),
  reason TEXT NOT NULL,
  prev_checkpoint_sha256 TEXT CHECK(prev_checkpoint_sha256 IS NULL OR length(prev_checkpoint_sha256) = 64),
  checkpoint_sha256 TEXT NOT NULL UNIQUE CHECK(length(checkpoint_sha256) = 64),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  event_type TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256) = 64),
  actor TEXT NOT NULL CHECK(actor IN ('USER', 'AGENT', 'RUNTIME', 'VALIDATOR')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  prev_event_sha256 TEXT CHECK(prev_event_sha256 IS NULL OR length(prev_event_sha256) = 64),
  event_sha256 TEXT NOT NULL UNIQUE CHECK(length(event_sha256) = 64),
  store_generation INTEGER NOT NULL CHECK(store_generation >= 1),
  leader_epoch INTEGER NOT NULL CHECK(leader_epoch >= 1),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(goal_id, sequence),
  UNIQUE(goal_id, command_id)
) STRICT;

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256) = 64),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256) = 64),
  expected_goal_version INTEGER NOT NULL CHECK(expected_goal_version >= 0),
  committed_goal_version INTEGER NOT NULL CHECK(committed_goal_version >= 1),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256) = 64),
  committed_event_sequence INTEGER NOT NULL CHECK(committed_event_sequence >= 1),
  UNIQUE(goal_id, idempotency_key_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  delivered_at_ms INTEGER,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts >= 0)
) STRICT;

-- Rebuildable heads. These tables optimize reads but are never sufficient proof.
CREATE TABLE IF NOT EXISTS goal_heads (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  goal_version INTEGER NOT NULL CHECK(goal_version >= 1),
  event_sequence INTEGER NOT NULL CHECK(event_sequence >= 1),
  status TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('PLAN', 'BUILD')),
  execution_phase TEXT NOT NULL CHECK(execution_phase IN ('CLARIFYING', 'SPECIFYING', 'PLANNING', 'BUILDING', 'VERIFYING', 'TERMINAL')),
  current_requirement_id TEXT NOT NULL REFERENCES requirement_revisions(requirement_id),
  current_plan_id TEXT NOT NULL REFERENCES plan_revisions(plan_id),
  current_stage_id TEXT REFERENCES plan_stages(stage_id),
  next_action TEXT NOT NULL,
  route_decision_id TEXT REFERENCES route_decisions(route_decision_id),
  latest_checkpoint_id TEXT REFERENCES milestone_checkpoints(checkpoint_id),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256) = 64)
) STRICT;

CREATE TABLE IF NOT EXISTS stage_heads (
  stage_id TEXT PRIMARY KEY REFERENCES plan_stages(stage_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  status TEXT NOT NULL CHECK(status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING_USER', 'BLOCKED', 'RECOVERING', 'NEEDS_RECONCILIATION', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'INVALIDATED')),
  row_version INTEGER NOT NULL CHECK(row_version >= 1),
  last_event_sequence INTEGER NOT NULL CHECK(last_event_sequence >= 1)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_running_stage_per_goal
  ON stage_heads(goal_id) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS ix_events_goal_sequence ON events(goal_id, sequence);
CREATE INDEX IF NOT EXISTS ix_receipts_subject ON receipts(goal_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS ix_invalidations_target ON invalidations(goal_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS ix_dependencies_source ON dependency_edges(goal_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_dependencies_target ON dependency_edges(goal_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(delivered_at_ms, created_event_sequence);

-- Immutable authority rows are append-only. Corrections use new rows and events.
CREATE TRIGGER IF NOT EXISTS no_update_schema_migrations BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_schema_migrations BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS protect_store_meta_identity BEFORE UPDATE ON store_meta
  WHEN NEW.singleton IS NOT OLD.singleton OR NEW.store_id IS NOT OLD.store_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.created_at_ms IS NOT OLD.created_at_ms
  BEGIN SELECT RAISE(ABORT, 'store identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_store_meta BEFORE DELETE ON store_meta BEGIN SELECT RAISE(ABORT, 'store metadata cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_update_workspaces BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'workspaces are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_workspaces BEFORE DELETE ON workspaces BEGIN SELECT RAISE(ABORT, 'workspaces are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_goals BEFORE UPDATE ON goals BEGIN SELECT RAISE(ABORT, 'goals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_goals BEFORE DELETE ON goals BEGIN SELECT RAISE(ABORT, 'goals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_goal_constraints BEFORE UPDATE ON goal_constraints BEGIN SELECT RAISE(ABORT, 'goal constraints are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_goal_constraints BEFORE DELETE ON goal_constraints BEGIN SELECT RAISE(ABORT, 'goal constraints are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_acceptance_criteria BEFORE UPDATE ON acceptance_criteria BEGIN SELECT RAISE(ABORT, 'acceptance criteria are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_acceptance_criteria BEFORE DELETE ON acceptance_criteria BEGIN SELECT RAISE(ABORT, 'acceptance criteria are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_events BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_events BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_receipts BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_receipts BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_receipt_artifacts BEFORE UPDATE ON receipt_artifacts BEGIN SELECT RAISE(ABORT, 'receipt artifact links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_receipt_artifacts BEFORE DELETE ON receipt_artifacts BEGIN SELECT RAISE(ABORT, 'receipt artifact links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_plans BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_plans BEFORE DELETE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_requirements BEFORE UPDATE ON requirement_revisions BEGIN SELECT RAISE(ABORT, 'requirement revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_requirements BEFORE DELETE ON requirement_revisions BEGIN SELECT RAISE(ABORT, 'requirement revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_requirement_items BEFORE UPDATE ON requirement_items BEGIN SELECT RAISE(ABORT, 'requirement items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_requirement_items BEFORE DELETE ON requirement_items BEGIN SELECT RAISE(ABORT, 'requirement items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_requirement_coverage BEFORE UPDATE ON requirement_acceptance_coverage BEGIN SELECT RAISE(ABORT, 'requirement coverage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_requirement_coverage BEFORE DELETE ON requirement_acceptance_coverage BEGIN SELECT RAISE(ABORT, 'requirement coverage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_stage_specs BEFORE UPDATE ON plan_stages BEGIN SELECT RAISE(ABORT, 'stage specifications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_stage_specs BEFORE DELETE ON plan_stages BEGIN SELECT RAISE(ABORT, 'stage specifications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_stage_dependencies BEFORE UPDATE ON stage_dependencies BEGIN SELECT RAISE(ABORT, 'stage dependencies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_stage_dependencies BEFORE DELETE ON stage_dependencies BEGIN SELECT RAISE(ABORT, 'stage dependencies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_acceptance_stage_coverage BEFORE UPDATE ON acceptance_stage_coverage BEGIN SELECT RAISE(ABORT, 'acceptance stage coverage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_acceptance_stage_coverage BEFORE DELETE ON acceptance_stage_coverage BEGIN SELECT RAISE(ABORT, 'acceptance stage coverage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_work_items BEFORE UPDATE ON work_items BEGIN SELECT RAISE(ABORT, 'work items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_work_items BEFORE DELETE ON work_items BEGIN SELECT RAISE(ABORT, 'work items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS protect_attempt_identity BEFORE UPDATE ON attempts
  WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.work_item_id IS NOT OLD.work_item_id OR NEW.attempt_number IS NOT OLD.attempt_number OR NEW.lease_generation IS NOT OLD.lease_generation OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.started_at_ms IS NOT OLD.started_at_ms
  BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_attempts BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT, 'attempts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_update_assumptions BEFORE UPDATE ON assumptions BEGIN SELECT RAISE(ABORT, 'assumptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_assumptions BEFORE DELETE ON assumptions BEGIN SELECT RAISE(ABORT, 'assumptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_dependency_edges BEFORE UPDATE ON dependency_edges BEGIN SELECT RAISE(ABORT, 'dependency edges are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_dependency_edges BEFORE DELETE ON dependency_edges BEGIN SELECT RAISE(ABORT, 'dependency edges are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_invalidations BEFORE UPDATE ON invalidations BEGIN SELECT RAISE(ABORT, 'invalidations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_invalidations BEFORE DELETE ON invalidations BEGIN SELECT RAISE(ABORT, 'invalidations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_decisions BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_decisions BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_decision_resolutions BEFORE UPDATE ON decision_resolutions BEGIN SELECT RAISE(ABORT, 'decision resolutions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_decision_resolutions BEFORE DELETE ON decision_resolutions BEGIN SELECT RAISE(ABORT, 'decision resolutions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_effects BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'effects are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_effects BEFORE DELETE ON effects BEGIN SELECT RAISE(ABORT, 'effects are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_effect_outcomes BEFORE UPDATE ON effect_outcomes BEGIN SELECT RAISE(ABORT, 'effect outcomes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_effect_outcomes BEFORE DELETE ON effect_outcomes BEGIN SELECT RAISE(ABORT, 'effect outcomes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_route_decisions BEFORE UPDATE ON route_decisions BEGIN SELECT RAISE(ABORT, 'route decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_route_decisions BEFORE DELETE ON route_decisions BEGIN SELECT RAISE(ABORT, 'route decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_snapshots BEFORE UPDATE ON progress_snapshots BEGIN SELECT RAISE(ABORT, 'progress snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_snapshots BEFORE DELETE ON progress_snapshots BEGIN SELECT RAISE(ABORT, 'progress snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_checkpoints BEFORE UPDATE ON milestone_checkpoints BEGIN SELECT RAISE(ABORT, 'milestone checkpoints are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_checkpoints BEFORE DELETE ON milestone_checkpoints BEGIN SELECT RAISE(ABORT, 'milestone checkpoints are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_artifacts BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_artifacts BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_command_receipts BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_command_receipts BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS protect_failure_signature_identity BEFORE UPDATE ON failure_signatures
  WHEN NEW.goal_id IS NOT OLD.goal_id OR NEW.stage_id IS NOT OLD.stage_id OR NEW.signature_sha256 IS NOT OLD.signature_sha256
  BEGIN SELECT RAISE(ABORT, 'failure signature identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_failure_signatures BEFORE DELETE ON failure_signatures BEGIN SELECT RAISE(ABORT, 'failure signatures cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS protect_lease_goal BEFORE UPDATE ON execution_leases
  WHEN NEW.goal_id IS NOT OLD.goal_id
  BEGIN SELECT RAISE(ABORT, 'lease goal identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_execution_leases BEFORE DELETE ON execution_leases BEGIN SELECT RAISE(ABORT, 'lease generations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS protect_outbox_payload BEFORE UPDATE ON outbox
  WHEN NEW.outbox_id IS NOT OLD.outbox_id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.topic IS NOT OLD.topic OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.created_event_sequence IS NOT OLD.created_event_sequence
  BEGIN SELECT RAISE(ABORT, 'outbox payload is immutable'); END;

COMMIT;
