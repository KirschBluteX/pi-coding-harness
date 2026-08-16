-- Authority/Acceptance V2 is additive. Migration 020 performs no business DML:
-- V1 history remains immutable and unfinished V1 Goals must requalify explicitly.

CREATE TABLE acceptance_source_revisions_v2 (
  source_revision_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL UNIQUE REFERENCES goal_contract_versions_v1(contract_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  parent_source_revision_id TEXT REFERENCES acceptance_source_revisions_v2(source_revision_id),
  source_bytes BLOB NOT NULL CHECK(typeof(source_bytes)='blob'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 131072),
  encoding TEXT NOT NULL CHECK(encoding='UTF-8'),
  fidelity TEXT NOT NULL CHECK(fidelity='EXACT'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(length(source_bytes)=byte_length),
  CHECK((revision=1 AND parent_source_revision_id IS NULL) OR (revision>1 AND parent_source_revision_id IS NOT NULL)),
  UNIQUE(goal_id,revision),
  UNIQUE(source_revision_id,goal_id,contract_id)
) STRICT;

CREATE TRIGGER validate_acceptance_source_contract_v2
BEFORE INSERT ON acceptance_source_revisions_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_contract_versions_v1 c
  WHERE c.contract_id=NEW.contract_id AND c.goal_id=NEW.goal_id
    AND c.version=NEW.revision AND c.source_intake_sha256=NEW.content_sha256
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 source/contract identity mismatch'); END;

CREATE TRIGGER validate_acceptance_source_parent_v2
BEFORE INSERT ON acceptance_source_revisions_v2
WHEN NEW.parent_source_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM acceptance_source_revisions_v2 p
  JOIN goal_contract_versions_v1 c ON c.contract_id=NEW.contract_id
  WHERE p.source_revision_id=NEW.parent_source_revision_id
    AND p.goal_id=NEW.goal_id AND p.revision=NEW.revision-1
    AND p.contract_id=c.parent_contract_id
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 source parent identity mismatch'); END;

CREATE TABLE acceptance_source_spans_v2 (
  span_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  start_byte INTEGER NOT NULL CHECK(start_byte>=0),
  end_byte_exclusive INTEGER NOT NULL CHECK(end_byte_exclusive>start_byte),
  quote_bytes BLOB NOT NULL CHECK(typeof(quote_bytes)='blob'),
  quote_sha256 TEXT NOT NULL CHECK(length(quote_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(length(quote_bytes)=end_byte_exclusive-start_byte),
  FOREIGN KEY(source_revision_id,goal_id,contract_id)
    REFERENCES acceptance_source_revisions_v2(source_revision_id,goal_id,contract_id),
  UNIQUE(span_id,goal_id,contract_id),
  UNIQUE(span_id,goal_id,contract_id,source_revision_id),
  UNIQUE(source_revision_id,start_byte,end_byte_exclusive,quote_sha256)
) STRICT;

CREATE TRIGGER validate_acceptance_span_slice_v2
BEFORE INSERT ON acceptance_source_spans_v2
WHEN NOT EXISTS (
  SELECT 1 FROM acceptance_source_revisions_v2 s
  WHERE s.source_revision_id=NEW.source_revision_id
    AND s.content_sha256=NEW.source_sha256
    AND NEW.end_byte_exclusive<=s.byte_length
    AND substr(s.source_bytes,NEW.start_byte+1,NEW.end_byte_exclusive-NEW.start_byte)=NEW.quote_bytes
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 span does not match exact source bytes'); END;

CREATE TABLE acceptance_facets_v2 (
  facet_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind IN ('OUTCOME','INVARIANT','QUALITY','CONSTRAINT','NON_GOAL')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('USER_OUTCOME','CONSTRAINT','NON_GOAL')),
  subject_index INTEGER NOT NULL CHECK(subject_index>=0),
  semantic_statement TEXT NOT NULL CHECK(length(semantic_statement) BETWEEN 1 AND 4096),
  derivation TEXT NOT NULL CHECK(derivation='CURRENT_AGENT_TYPED_PROPOSAL'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(contract_id,semantic_key),
  UNIQUE(facet_id,goal_id,contract_id)
) STRICT;

CREATE TRIGGER validate_acceptance_facet_contract_v2
BEFORE INSERT ON acceptance_facets_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_contract_versions_v1 c
  WHERE c.contract_id=NEW.contract_id AND c.goal_id=NEW.goal_id
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 facet/contract identity mismatch'); END;

CREATE TABLE acceptance_facet_span_members_v2 (
  facet_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(facet_id,span_id),
  UNIQUE(facet_id,ordinal),
  FOREIGN KEY(facet_id,goal_id,contract_id)
    REFERENCES acceptance_facets_v2(facet_id,goal_id,contract_id),
  FOREIGN KEY(span_id,goal_id,contract_id,source_revision_id)
    REFERENCES acceptance_source_spans_v2(span_id,goal_id,contract_id,source_revision_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE acceptance_obligations_v2 (
  acceptance_obligation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  task_obligation_id TEXT NOT NULL UNIQUE REFERENCES task_obligations_v1(obligation_id),
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 160),
  priority TEXT NOT NULL CHECK(priority IN ('MUST','SHOULD','MAY')),
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 32768),
  frozen_oracle_sha256 TEXT NOT NULL CHECK(length(frozen_oracle_sha256)=64),
  dependency_ids_json TEXT NOT NULL CHECK(json_valid(dependency_ids_json) AND json_type(dependency_ids_json)='array'),
  dependency_root_sha256 TEXT NOT NULL CHECK(length(dependency_root_sha256)=64),
  task_obligation_sha256 TEXT NOT NULL CHECK(length(task_obligation_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(contract_id,semantic_key),
  UNIQUE(acceptance_obligation_id,goal_id,contract_id)
) STRICT;

CREATE TRIGGER validate_acceptance_obligation_v2
BEFORE INSERT ON acceptance_obligations_v2
WHEN NOT EXISTS (
  SELECT 1 FROM task_obligations_v1 o
  WHERE o.obligation_id=NEW.task_obligation_id AND o.goal_id=NEW.goal_id
    AND o.contract_id=NEW.contract_id AND o.semantic_key=NEW.semantic_key
    AND o.priority=NEW.priority AND o.record_sha256=NEW.task_obligation_sha256
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 obligation/V1 identity mismatch'); END;

CREATE TABLE facet_obligation_bindings_v2 (
  binding_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  facet_id TEXT NOT NULL,
  acceptance_obligation_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('SATISFIES','CONSTRAINS','BOUNDS')),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(facet_id,goal_id,contract_id)
    REFERENCES acceptance_facets_v2(facet_id,goal_id,contract_id),
  FOREIGN KEY(acceptance_obligation_id,goal_id,contract_id)
    REFERENCES acceptance_obligations_v2(acceptance_obligation_id,goal_id,contract_id),
  UNIQUE(facet_id,acceptance_obligation_id,relation),
  UNIQUE(binding_id,goal_id,contract_id)
) STRICT;

CREATE TABLE evidence_requirements_v2 (
  evidence_requirement_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL CHECK(requirement_kind IN ('HOST_ORACLE','PRESERVATION_REVIEW','OPERATION_CLOSURE')),
  frozen_oracle_sha256 TEXT NOT NULL CHECK(length(frozen_oracle_sha256)=64),
  required_inputs_json TEXT NOT NULL CHECK(json_valid(required_inputs_json) AND json_type(required_inputs_json)='array'),
  required_inputs_sha256 TEXT NOT NULL CHECK(length(required_inputs_sha256)=64),
  freshness_policy TEXT NOT NULL CHECK(freshness_policy='CURRENT_POSTIMAGE'),
  execution_owner TEXT NOT NULL CHECK(execution_owner='HOST'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(binding_id,goal_id,contract_id)
    REFERENCES facet_obligation_bindings_v2(binding_id,goal_id,contract_id),
  UNIQUE(binding_id,requirement_kind),
  UNIQUE(evidence_requirement_id,goal_id,contract_id)
) STRICT;

CREATE TABLE acceptance_authority_roots_v2 (
  authority_root_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL UNIQUE REFERENCES goal_contract_versions_v1(contract_id),
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256)=64),
  generation INTEGER NOT NULL CHECK(generation>=1),
  qualification_basis TEXT NOT NULL CHECK(qualification_basis IN ('NATIVE_EXACT','LEGACY_REQUALIFIED')),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  legacy_event_head_sha256 TEXT CHECK(legacy_event_head_sha256 IS NULL OR length(legacy_event_head_sha256)=64),
  requalification_receipt_sha256 TEXT CHECK(requalification_receipt_sha256 IS NULL OR length(requalification_receipt_sha256)=64),
  source_revision_id TEXT NOT NULL,
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  span_root_sha256 TEXT NOT NULL CHECK(length(span_root_sha256)=64),
  facet_root_sha256 TEXT NOT NULL CHECK(length(facet_root_sha256)=64),
  obligation_root_sha256 TEXT NOT NULL CHECK(length(obligation_root_sha256)=64),
  binding_root_sha256 TEXT NOT NULL CHECK(length(binding_root_sha256)=64),
  evidence_requirement_root_sha256 TEXT NOT NULL CHECK(length(evidence_requirement_root_sha256)=64),
  facet_count INTEGER NOT NULL CHECK(facet_count BETWEEN 1 AND 256),
  obligation_count INTEGER NOT NULL CHECK(obligation_count BETWEEN 1 AND 256),
  binding_count INTEGER NOT NULL CHECK(binding_count BETWEEN 1 AND 4096),
  evidence_requirement_count INTEGER NOT NULL CHECK(evidence_requirement_count BETWEEN 1 AND 4096),
  unresolved_material_count INTEGER NOT NULL CHECK(unresolved_material_count=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(source_revision_id,goal_id,contract_id)
    REFERENCES acceptance_source_revisions_v2(source_revision_id,goal_id,contract_id),
  CHECK((qualification_basis='NATIVE_EXACT' AND legacy_event_head_sha256 IS NULL AND requalification_receipt_sha256 IS NULL)
    OR (qualification_basis='LEGACY_REQUALIFIED' AND legacy_event_head_sha256 IS NOT NULL AND requalification_receipt_sha256 IS NOT NULL)),
  UNIQUE(goal_id,generation),
  UNIQUE(authority_root_id,goal_id,contract_id)
) STRICT;

CREATE TRIGGER validate_acceptance_authority_contract_v2
BEFORE INSERT ON acceptance_authority_roots_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_contract_versions_v1 c
  WHERE c.contract_id=NEW.contract_id AND c.goal_id=NEW.goal_id
    AND c.version=NEW.generation AND c.record_sha256=NEW.contract_sha256
)
BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority/contract identity mismatch'); END;

CREATE TABLE acceptance_authority_span_members_v2 (
  authority_root_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(authority_root_id,span_id),
  UNIQUE(authority_root_id,ordinal),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(span_id,goal_id,contract_id)
    REFERENCES acceptance_source_spans_v2(span_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE acceptance_authority_facet_members_v2 (
  authority_root_id TEXT NOT NULL,
  facet_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(authority_root_id,facet_id),
  UNIQUE(authority_root_id,ordinal),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(facet_id,goal_id,contract_id)
    REFERENCES acceptance_facets_v2(facet_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE acceptance_authority_obligation_members_v2 (
  authority_root_id TEXT NOT NULL,
  acceptance_obligation_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(authority_root_id,acceptance_obligation_id),
  UNIQUE(authority_root_id,ordinal),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(acceptance_obligation_id,goal_id,contract_id)
    REFERENCES acceptance_obligations_v2(acceptance_obligation_id,goal_id,contract_id),
  UNIQUE(authority_root_id,acceptance_obligation_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE acceptance_authority_binding_members_v2 (
  authority_root_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(authority_root_id,binding_id),
  UNIQUE(authority_root_id,ordinal),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(binding_id,goal_id,contract_id)
    REFERENCES facet_obligation_bindings_v2(binding_id,goal_id,contract_id),
  UNIQUE(authority_root_id,binding_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE acceptance_authority_requirement_members_v2 (
  authority_root_id TEXT NOT NULL,
  evidence_requirement_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(authority_root_id,evidence_requirement_id),
  UNIQUE(authority_root_id,ordinal),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(evidence_requirement_id,goal_id,contract_id)
    REFERENCES evidence_requirements_v2(evidence_requirement_id,goal_id,contract_id),
  UNIQUE(authority_root_id,evidence_requirement_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE legacy_authority_dispositions_v2 (
  disposition_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  disposition TEXT NOT NULL CHECK(disposition IN ('LEGACY_TERMINAL_READ_ONLY','LEGACY_REQUALIFICATION_REQUIRED','BLOCKED_RECONCILIATION')),
  legacy_event_head_sha256 TEXT NOT NULL CHECK(length(legacy_event_head_sha256)=64),
  reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(goal_id,legacy_event_head_sha256)
) STRICT;

CREATE TABLE oracle_execution_descriptors_v2 (
  descriptor_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES operation_attempts_v1(attempt_id),
  command_text TEXT NOT NULL CHECK(length(command_text) BETWEEN 1 AND 8192),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64),
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('FROZEN_ORACLE','SUPPLEMENTAL_VALIDATION')),
  work_cell_oracle_sha256 TEXT NOT NULL CHECK(length(work_cell_oracle_sha256)=64),
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
  execution_fingerprint_sha256 TEXT NOT NULL CHECK(length(execution_fingerprint_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(descriptor_id,goal_id,work_cell_id,attempt_id)
) STRICT;

CREATE TRIGGER validate_oracle_execution_descriptor_v2
BEFORE INSERT ON oracle_execution_descriptors_v2
WHEN NOT EXISTS (
  SELECT 1 FROM operation_attempts_v1 a
  JOIN work_cells_v1 c ON c.work_cell_id=a.work_cell_id
  WHERE a.attempt_id=NEW.attempt_id AND a.goal_id=NEW.goal_id
    AND a.work_cell_id=NEW.work_cell_id AND a.operation_kind='VALIDATION'
    AND a.oracle_sha256=NEW.work_cell_oracle_sha256
    AND a.execution_fingerprint_sha256=NEW.execution_fingerprint_sha256
)
BEGIN SELECT RAISE(ABORT,'Oracle execution descriptor is not bound to a Host validation attempt'); END;

CREATE TABLE oracle_execution_observations_v2 (
  observation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES operation_attempts_v1(attempt_id),
  terminal_transition_id TEXT NOT NULL UNIQUE REFERENCES operation_transitions_v1(transition_id),
  terminal_transition_sha256 TEXT NOT NULL CHECK(length(terminal_transition_sha256)=64),
  observed_postcondition TEXT NOT NULL CHECK(observed_postcondition IN ('PASS','FAIL','UNKNOWN')),
  output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(observation_id,goal_id,work_cell_id,attempt_id,terminal_transition_id)
) STRICT;

CREATE TRIGGER validate_oracle_observation_terminal_v2
BEFORE INSERT ON oracle_execution_observations_v2
WHEN NOT EXISTS (
  SELECT 1 FROM operation_attempts_v1 a
  JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
  WHERE a.attempt_id=NEW.attempt_id AND a.goal_id=NEW.goal_id
    AND a.work_cell_id=NEW.work_cell_id AND a.operation_kind='VALIDATION'
    AND t.transition_id=NEW.terminal_transition_id
    AND t.transition_sha256=NEW.terminal_transition_sha256
    AND t.state IN ('COMMITTED','FAILED','RECONCILED')
    AND t.postcondition=NEW.observed_postcondition
)
BEGIN SELECT RAISE(ABORT,'Oracle observation is not a terminal Host validation transition'); END;

CREATE TABLE oracle_pass_receipts_v2 (
  pass_receipt_id TEXT PRIMARY KEY,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  evidence_requirement_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  terminal_transition_id TEXT NOT NULL,
  terminal_transition_sha256 TEXT NOT NULL CHECK(length(terminal_transition_sha256)=64),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  postimage_root_sha256 TEXT NOT NULL CHECK(length(postimage_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  integration_root_sha256 TEXT NOT NULL CHECK(length(integration_root_sha256)=64),
  topology_revision_sha256 TEXT NOT NULL CHECK(length(topology_revision_sha256)=64),
  observation_root_sha256 TEXT NOT NULL CHECK(length(observation_root_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(authority_root_id,evidence_requirement_id,goal_id,contract_id)
    REFERENCES acceptance_authority_requirement_members_v2(authority_root_id,evidence_requirement_id,goal_id,contract_id),
  FOREIGN KEY(observation_id,goal_id,work_cell_id,attempt_id,terminal_transition_id)
    REFERENCES oracle_execution_observations_v2(observation_id,goal_id,work_cell_id,attempt_id,terminal_transition_id),
  UNIQUE(observation_id,evidence_requirement_id),
  UNIQUE(pass_receipt_id,authority_root_id,goal_id,contract_id,work_cell_id,evidence_requirement_id)
) STRICT;

CREATE TRIGGER validate_oracle_pass_receipt_v2
BEFORE INSERT ON oracle_pass_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM oracle_execution_observations_v2 o
  JOIN operation_attempts_v1 a ON a.attempt_id=o.attempt_id
  JOIN execution_authorizations_v1 z ON z.authorization_id=a.authorization_id
  WHERE o.observation_id=NEW.observation_id AND o.observed_postcondition='PASS'
    AND o.output_sha256=NEW.observation_root_sha256
    AND a.authorization_id=NEW.authorization_id AND z.goal_id=NEW.goal_id
    AND z.contract_id=NEW.contract_id AND z.route_id=NEW.route_id
    AND z.work_cell_id=NEW.work_cell_id AND z.record_sha256=NEW.authorization_sha256
    AND z.lease_generation=NEW.lease_generation AND z.fencing_token=NEW.fencing_token
    AND a.environment_sha256=NEW.environment_sha256
)
BEGIN SELECT RAISE(ABORT,'Oracle PASS receipt cannot be derived from the bound Host observation'); END;

CREATE TABLE acceptance_evidence_bindings_v2 (
  evidence_binding_id TEXT PRIMARY KEY,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  facet_obligation_binding_id TEXT NOT NULL,
  evidence_requirement_id TEXT NOT NULL,
  pass_receipt_id TEXT NOT NULL,
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  witness_root_sha256 TEXT NOT NULL CHECK(length(witness_root_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(authority_root_id,facet_obligation_binding_id,goal_id,contract_id)
    REFERENCES acceptance_authority_binding_members_v2(authority_root_id,binding_id,goal_id,contract_id),
  FOREIGN KEY(authority_root_id,evidence_requirement_id,goal_id,contract_id)
    REFERENCES acceptance_authority_requirement_members_v2(authority_root_id,evidence_requirement_id,goal_id,contract_id),
  FOREIGN KEY(pass_receipt_id,authority_root_id,goal_id,contract_id,work_cell_id,evidence_requirement_id)
    REFERENCES oracle_pass_receipts_v2(pass_receipt_id,authority_root_id,goal_id,contract_id,work_cell_id,evidence_requirement_id),
  UNIQUE(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
) STRICT;

CREATE INDEX ix_acceptance_evidence_latest_v2
  ON acceptance_evidence_bindings_v2(work_cell_id,evidence_requirement_id,created_event_sequence DESC);

CREATE TABLE acceptance_evidence_witness_members_v2 (
  evidence_binding_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  path_hmac TEXT NOT NULL CHECK(length(path_hmac)=64),
  locator_sha256 TEXT NOT NULL CHECK(length(locator_sha256)=64),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(evidence_binding_id,ordinal),
  FOREIGN KEY(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
    REFERENCES acceptance_evidence_bindings_v2(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE work_cell_completion_receipts_v2 (
  completion_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  final_postimage_root_sha256 TEXT NOT NULL CHECK(length(final_postimage_root_sha256)=64),
  operation_closure_sha256 TEXT NOT NULL CHECK(length(operation_closure_sha256)=64),
  integration_root_sha256 TEXT NOT NULL CHECK(length(integration_root_sha256)=64),
  preservation_review_sha256 TEXT NOT NULL CHECK(length(preservation_review_sha256)=64),
  evidence_binding_root_sha256 TEXT NOT NULL CHECK(length(evidence_binding_root_sha256)=64),
  obligation_root_sha256 TEXT NOT NULL CHECK(length(obligation_root_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(work_cell_id) REFERENCES work_cells_v1(work_cell_id),
  FOREIGN KEY(route_id) REFERENCES route_skeleton_versions_v1(route_id),
  UNIQUE(work_cell_id,revision),
  UNIQUE(completion_receipt_id,goal_id,contract_id,route_id,work_cell_id),
  UNIQUE(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id),
  UNIQUE(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id)
) STRICT;

CREATE TRIGGER validate_work_cell_completion_authorization_v2
BEFORE INSERT ON work_cell_completion_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_authorizations_v1 z
  WHERE z.authorization_id=NEW.authorization_id AND z.goal_id=NEW.goal_id
    AND z.contract_id=NEW.contract_id AND z.route_id=NEW.route_id
    AND z.work_cell_id=NEW.work_cell_id AND z.record_sha256=NEW.authorization_sha256
)
BEGIN SELECT RAISE(ABORT,'Completion receipt authorization identity mismatch'); END;

CREATE TABLE work_cell_completion_evidence_members_v2 (
  completion_receipt_id TEXT NOT NULL,
  evidence_binding_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(completion_receipt_id,evidence_binding_id),
  UNIQUE(completion_receipt_id,ordinal),
  FOREIGN KEY(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id)
    REFERENCES work_cell_completion_receipts_v2(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id),
  FOREIGN KEY(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
    REFERENCES acceptance_evidence_bindings_v2(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE work_cell_completion_obligation_members_v2 (
  completion_receipt_id TEXT NOT NULL,
  acceptance_obligation_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(completion_receipt_id,acceptance_obligation_id),
  UNIQUE(completion_receipt_id,ordinal),
  FOREIGN KEY(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id)
    REFERENCES work_cell_completion_receipts_v2(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id),
  FOREIGN KEY(authority_root_id,acceptance_obligation_id,goal_id,contract_id)
    REFERENCES acceptance_authority_obligation_members_v2(authority_root_id,acceptance_obligation_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE deliverable_manifests_v2 (
  deliverable_manifest_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  authority_root_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  final_baseline_id TEXT NOT NULL REFERENCES workspace_baselines_v1(baseline_id),
  final_postimage_root_sha256 TEXT NOT NULL CHECK(length(final_postimage_root_sha256)=64),
  completion_root_sha256 TEXT NOT NULL CHECK(length(completion_root_sha256)=64),
  evidence_root_sha256 TEXT NOT NULL CHECK(length(evidence_root_sha256)=64),
  artifact_root_sha256 TEXT NOT NULL CHECK(length(artifact_root_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  UNIQUE(goal_id,revision),
  UNIQUE(deliverable_manifest_id,goal_id,contract_id,route_id),
  UNIQUE(deliverable_manifest_id,authority_root_id,goal_id,contract_id,route_id)
) STRICT;

CREATE TABLE deliverable_completion_members_v2 (
  deliverable_manifest_id TEXT NOT NULL,
  completion_receipt_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(deliverable_manifest_id,completion_receipt_id),
  UNIQUE(deliverable_manifest_id,ordinal),
  FOREIGN KEY(deliverable_manifest_id,authority_root_id,goal_id,contract_id,route_id)
    REFERENCES deliverable_manifests_v2(deliverable_manifest_id,authority_root_id,goal_id,contract_id,route_id),
  FOREIGN KEY(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id)
    REFERENCES work_cell_completion_receipts_v2(completion_receipt_id,authority_root_id,goal_id,contract_id,route_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE deliverable_evidence_members_v2 (
  deliverable_manifest_id TEXT NOT NULL,
  evidence_binding_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  work_cell_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(deliverable_manifest_id,evidence_binding_id),
  UNIQUE(deliverable_manifest_id,ordinal),
  FOREIGN KEY(deliverable_manifest_id,authority_root_id,goal_id,contract_id,route_id)
    REFERENCES deliverable_manifests_v2(deliverable_manifest_id,authority_root_id,goal_id,contract_id,route_id),
  FOREIGN KEY(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
    REFERENCES acceptance_evidence_bindings_v2(evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE deliverable_artifact_members_v2 (
  deliverable_manifest_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(deliverable_manifest_id,artifact_id),
  UNIQUE(deliverable_manifest_id,ordinal),
  FOREIGN KEY(deliverable_manifest_id,goal_id,contract_id,route_id)
    REFERENCES deliverable_manifests_v2(deliverable_manifest_id,goal_id,contract_id,route_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_deliverable_artifact_v2
BEFORE INSERT ON deliverable_artifact_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM artifacts a
  WHERE a.artifact_id=NEW.artifact_id AND a.sha256=NEW.artifact_sha256
)
BEGIN SELECT RAISE(ABORT,'Deliverable V2 artifact identity mismatch'); END;

CREATE INDEX ix_acceptance_source_goal_v2 ON acceptance_source_revisions_v2(goal_id,revision);
CREATE INDEX ix_acceptance_spans_source_v2 ON acceptance_source_spans_v2(source_revision_id,start_byte,end_byte_exclusive);
CREATE INDEX ix_acceptance_facets_contract_v2 ON acceptance_facets_v2(contract_id,subject_kind,subject_index);
CREATE INDEX ix_acceptance_bindings_contract_v2 ON facet_obligation_bindings_v2(contract_id,facet_id);
CREATE INDEX ix_acceptance_requirements_contract_v2 ON evidence_requirements_v2(contract_id,binding_id);
CREATE INDEX ix_oracle_observation_goal_v2 ON oracle_execution_observations_v2(goal_id,work_cell_id,created_event_sequence);
CREATE INDEX ix_oracle_pass_goal_v2 ON oracle_pass_receipts_v2(goal_id,work_cell_id,created_event_sequence);
CREATE INDEX ix_oracle_descriptor_goal_v2 ON oracle_execution_descriptors_v2(goal_id,work_cell_id,created_event_sequence);
CREATE INDEX ix_acceptance_evidence_goal_v2 ON acceptance_evidence_bindings_v2(goal_id,work_cell_id,created_event_sequence);
CREATE INDEX ix_completion_goal_v2 ON work_cell_completion_receipts_v2(goal_id,route_id,created_event_sequence);

CREATE TRIGGER no_update_acceptance_source_revisions_v2 BEFORE UPDATE ON acceptance_source_revisions_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 sources are immutable'); END;
CREATE TRIGGER no_delete_acceptance_source_revisions_v2 BEFORE DELETE ON acceptance_source_revisions_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 sources are immutable'); END;
CREATE TRIGGER no_update_acceptance_source_spans_v2 BEFORE UPDATE ON acceptance_source_spans_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 spans are immutable'); END;
CREATE TRIGGER no_delete_acceptance_source_spans_v2 BEFORE DELETE ON acceptance_source_spans_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 spans are immutable'); END;
CREATE TRIGGER no_update_acceptance_facets_v2 BEFORE UPDATE ON acceptance_facets_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 facets are immutable'); END;
CREATE TRIGGER no_delete_acceptance_facets_v2 BEFORE DELETE ON acceptance_facets_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 facets are immutable'); END;
CREATE TRIGGER no_update_acceptance_facet_span_members_v2 BEFORE UPDATE ON acceptance_facet_span_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 facet span members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_facet_span_members_v2 BEFORE DELETE ON acceptance_facet_span_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 facet span members are immutable'); END;
CREATE TRIGGER no_update_acceptance_obligations_v2 BEFORE UPDATE ON acceptance_obligations_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 obligations are immutable'); END;
CREATE TRIGGER no_delete_acceptance_obligations_v2 BEFORE DELETE ON acceptance_obligations_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 obligations are immutable'); END;
CREATE TRIGGER no_update_facet_obligation_bindings_v2 BEFORE UPDATE ON facet_obligation_bindings_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 bindings are immutable'); END;
CREATE TRIGGER no_delete_facet_obligation_bindings_v2 BEFORE DELETE ON facet_obligation_bindings_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 bindings are immutable'); END;
CREATE TRIGGER no_update_evidence_requirements_v2 BEFORE UPDATE ON evidence_requirements_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 evidence requirements are immutable'); END;
CREATE TRIGGER no_delete_evidence_requirements_v2 BEFORE DELETE ON evidence_requirements_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 evidence requirements are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_roots_v2 BEFORE UPDATE ON acceptance_authority_roots_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority roots are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_roots_v2 BEFORE DELETE ON acceptance_authority_roots_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority roots are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_span_members_v2 BEFORE UPDATE ON acceptance_authority_span_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority span members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_span_members_v2 BEFORE DELETE ON acceptance_authority_span_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority span members are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_facet_members_v2 BEFORE UPDATE ON acceptance_authority_facet_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority facet members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_facet_members_v2 BEFORE DELETE ON acceptance_authority_facet_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority facet members are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_obligation_members_v2 BEFORE UPDATE ON acceptance_authority_obligation_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority obligation members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_obligation_members_v2 BEFORE DELETE ON acceptance_authority_obligation_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority obligation members are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_binding_members_v2 BEFORE UPDATE ON acceptance_authority_binding_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority binding members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_binding_members_v2 BEFORE DELETE ON acceptance_authority_binding_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority binding members are immutable'); END;
CREATE TRIGGER no_update_acceptance_authority_requirement_members_v2 BEFORE UPDATE ON acceptance_authority_requirement_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority requirement members are immutable'); END;
CREATE TRIGGER no_delete_acceptance_authority_requirement_members_v2 BEFORE DELETE ON acceptance_authority_requirement_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance V2 authority requirement members are immutable'); END;
CREATE TRIGGER no_update_legacy_authority_dispositions_v2 BEFORE UPDATE ON legacy_authority_dispositions_v2 BEGIN SELECT RAISE(ABORT,'Legacy authority dispositions are immutable'); END;
CREATE TRIGGER no_delete_legacy_authority_dispositions_v2 BEFORE DELETE ON legacy_authority_dispositions_v2 BEGIN SELECT RAISE(ABORT,'Legacy authority dispositions are immutable'); END;
CREATE TRIGGER no_update_oracle_execution_observations_v2 BEFORE UPDATE ON oracle_execution_observations_v2 BEGIN SELECT RAISE(ABORT,'Oracle observations are immutable'); END;
CREATE TRIGGER no_delete_oracle_execution_observations_v2 BEFORE DELETE ON oracle_execution_observations_v2 BEGIN SELECT RAISE(ABORT,'Oracle observations are immutable'); END;
CREATE TRIGGER no_update_oracle_execution_descriptors_v2 BEFORE UPDATE ON oracle_execution_descriptors_v2 BEGIN SELECT RAISE(ABORT,'Oracle execution descriptors are immutable'); END;
CREATE TRIGGER no_delete_oracle_execution_descriptors_v2 BEFORE DELETE ON oracle_execution_descriptors_v2 BEGIN SELECT RAISE(ABORT,'Oracle execution descriptors are immutable'); END;
CREATE TRIGGER no_update_oracle_pass_receipts_v2 BEFORE UPDATE ON oracle_pass_receipts_v2 BEGIN SELECT RAISE(ABORT,'Oracle PASS receipts are immutable'); END;
CREATE TRIGGER no_delete_oracle_pass_receipts_v2 BEFORE DELETE ON oracle_pass_receipts_v2 BEGIN SELECT RAISE(ABORT,'Oracle PASS receipts are immutable'); END;
CREATE TRIGGER no_update_acceptance_evidence_bindings_v2 BEFORE UPDATE ON acceptance_evidence_bindings_v2 BEGIN SELECT RAISE(ABORT,'Acceptance evidence bindings are immutable'); END;
CREATE TRIGGER no_delete_acceptance_evidence_bindings_v2 BEFORE DELETE ON acceptance_evidence_bindings_v2 BEGIN SELECT RAISE(ABORT,'Acceptance evidence bindings are immutable'); END;
CREATE TRIGGER no_update_acceptance_evidence_witness_members_v2 BEFORE UPDATE ON acceptance_evidence_witness_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance evidence witnesses are immutable'); END;
CREATE TRIGGER no_delete_acceptance_evidence_witness_members_v2 BEFORE DELETE ON acceptance_evidence_witness_members_v2 BEGIN SELECT RAISE(ABORT,'Acceptance evidence witnesses are immutable'); END;
CREATE TRIGGER no_update_work_cell_completion_receipts_v2 BEFORE UPDATE ON work_cell_completion_receipts_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion receipts are immutable'); END;
CREATE TRIGGER no_delete_work_cell_completion_receipts_v2 BEFORE DELETE ON work_cell_completion_receipts_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion receipts are immutable'); END;
CREATE TRIGGER no_update_work_cell_completion_evidence_members_v2 BEFORE UPDATE ON work_cell_completion_evidence_members_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion evidence members are immutable'); END;
CREATE TRIGGER no_delete_work_cell_completion_evidence_members_v2 BEFORE DELETE ON work_cell_completion_evidence_members_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion evidence members are immutable'); END;
CREATE TRIGGER no_update_work_cell_completion_obligation_members_v2 BEFORE UPDATE ON work_cell_completion_obligation_members_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion obligation members are immutable'); END;
CREATE TRIGGER no_delete_work_cell_completion_obligation_members_v2 BEFORE DELETE ON work_cell_completion_obligation_members_v2 BEGIN SELECT RAISE(ABORT,'WorkCell completion obligation members are immutable'); END;
CREATE TRIGGER no_update_deliverable_manifests_v2 BEFORE UPDATE ON deliverable_manifests_v2 BEGIN SELECT RAISE(ABORT,'Deliverable V2 manifests are immutable'); END;
CREATE TRIGGER no_delete_deliverable_manifests_v2 BEFORE DELETE ON deliverable_manifests_v2 BEGIN SELECT RAISE(ABORT,'Deliverable V2 manifests are immutable'); END;
CREATE TRIGGER no_update_deliverable_completion_members_v2 BEFORE UPDATE ON deliverable_completion_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable completion members are immutable'); END;
CREATE TRIGGER no_delete_deliverable_completion_members_v2 BEFORE DELETE ON deliverable_completion_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable completion members are immutable'); END;
CREATE TRIGGER no_update_deliverable_evidence_members_v2 BEFORE UPDATE ON deliverable_evidence_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable evidence members are immutable'); END;
CREATE TRIGGER no_delete_deliverable_evidence_members_v2 BEFORE DELETE ON deliverable_evidence_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable evidence members are immutable'); END;
CREATE TRIGGER no_update_deliverable_artifact_members_v2 BEFORE UPDATE ON deliverable_artifact_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable artifact members are immutable'); END;
CREATE TRIGGER no_delete_deliverable_artifact_members_v2 BEFORE DELETE ON deliverable_artifact_members_v2 BEGIN SELECT RAISE(ABORT,'Deliverable artifact members are immutable'); END;
