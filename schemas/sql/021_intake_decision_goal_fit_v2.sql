-- Intake/Decision/Goal Fit V2 is additive. Provider and Worker output may only
-- become typed proposals; every row below is Host-finalized and immutable.

CREATE TABLE requirement_revisions_v2 (
  requirement_revision_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
  contract_revision INTEGER NOT NULL CHECK(contract_revision BETWEEN 1 AND 1000000),
  parent_requirement_revision_id TEXT REFERENCES requirement_revisions_v2(requirement_revision_id),
  parent_requirement_revision_sha256 TEXT CHECK(parent_requirement_revision_sha256 IS NULL OR length(parent_requirement_revision_sha256)=64),
  proposal_origin TEXT NOT NULL CHECK(proposal_origin IN (
    'CURRENT_AGENT_TYPED_PROPOSAL','PROVIDER_TYPED_PROPOSAL','WORKER_TYPED_PROPOSAL'
  )),
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  span_root_sha256 TEXT NOT NULL CHECK(length(span_root_sha256)=64),
  facet_root_sha256 TEXT NOT NULL CHECK(length(facet_root_sha256)=64),
  requirements_root_sha256 TEXT NOT NULL CHECK(length(requirements_root_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 512),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((revision=1 AND parent_requirement_revision_id IS NULL AND parent_requirement_revision_sha256 IS NULL)
    OR (revision>1 AND parent_requirement_revision_id IS NOT NULL AND parent_requirement_revision_sha256 IS NOT NULL)),
  CHECK(contract_revision<=revision),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(source_revision_id,goal_id,contract_id)
    REFERENCES acceptance_source_revisions_v2(source_revision_id,goal_id,contract_id),
  UNIQUE(goal_id,revision),
  UNIQUE(contract_id,contract_revision),
  UNIQUE(requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_requirement_revision_authority_v2
BEFORE INSERT ON requirement_revisions_v2
WHEN NOT EXISTS (
  SELECT 1 FROM acceptance_authority_roots_v2 a
  WHERE a.authority_root_id=NEW.authority_root_id AND a.goal_id=NEW.goal_id
    AND a.contract_id=NEW.contract_id AND a.source_revision_id=NEW.source_revision_id
    AND a.source_root_sha256=NEW.source_root_sha256 AND a.span_root_sha256=NEW.span_root_sha256
    AND a.facet_root_sha256=NEW.facet_root_sha256
)
BEGIN SELECT RAISE(ABORT,'Requirement V2 Acceptance authority mismatch'); END;

CREATE TRIGGER validate_requirement_revision_parent_v2
BEFORE INSERT ON requirement_revisions_v2
WHEN NEW.parent_requirement_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM requirement_revisions_v2 p
  JOIN goal_contract_versions_v1 c ON c.contract_id=NEW.contract_id
  WHERE p.requirement_revision_id=NEW.parent_requirement_revision_id AND p.goal_id=NEW.goal_id
    AND p.revision=NEW.revision-1
    AND p.record_sha256=NEW.parent_requirement_revision_sha256
    AND ((p.contract_id=NEW.contract_id AND NEW.contract_revision=p.contract_revision+1)
      OR (p.contract_id<>NEW.contract_id AND NEW.contract_revision=1 AND c.parent_contract_id=p.contract_id))
)
BEGIN SELECT RAISE(ABORT,'Requirement V2 parent mismatch'); END;

CREATE TABLE requirement_items_v2 (
  requirement_item_revision_id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind IN ('OUTCOME','CONSTRAINT','NON_GOAL','QUALITY','PERFORMANCE','SECURITY','RECOVERY','UX')),
  priority TEXT NOT NULL CHECK(priority IN ('MUST','SHOULD','MAY')),
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 32768),
  facet_ids_json TEXT NOT NULL CHECK(json_valid(facet_ids_json) AND json_type(facet_ids_json)='array'),
  facet_ids_root_sha256 TEXT NOT NULL CHECK(length(facet_ids_root_sha256)=64),
  source_span_ids_json TEXT NOT NULL CHECK(json_valid(source_span_ids_json) AND json_type(source_span_ids_json)='array'),
  source_span_ids_root_sha256 TEXT NOT NULL CHECK(length(source_span_ids_root_sha256)=64),
  trace_root_sha256 TEXT NOT NULL CHECK(length(trace_root_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(requirement_revision_id,semantic_key),
  UNIQUE(requirement_id,requirement_revision_id),
  UNIQUE(requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(requirement_item_revision_id,requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TABLE requirement_item_facet_members_v2 (
  requirement_item_revision_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  facet_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(requirement_item_revision_id,facet_id),
  UNIQUE(requirement_item_revision_id,ordinal),
  FOREIGN KEY(requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_items_v2(requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(facet_id,goal_id,contract_id)
    REFERENCES acceptance_facets_v2(facet_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_requirement_item_facet_authority_v2
BEFORE INSERT ON requirement_item_facet_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM acceptance_authority_facet_members_v2 m
  WHERE m.authority_root_id=NEW.authority_root_id AND m.facet_id=NEW.facet_id
    AND m.goal_id=NEW.goal_id AND m.contract_id=NEW.contract_id
)
BEGIN SELECT RAISE(ABORT,'Requirement V2 facet is outside Acceptance authority'); END;

CREATE TABLE requirement_item_span_members_v2 (
  requirement_item_revision_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(requirement_item_revision_id,span_id),
  UNIQUE(requirement_item_revision_id,ordinal),
  FOREIGN KEY(requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_items_v2(requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(span_id,goal_id,contract_id)
    REFERENCES acceptance_source_spans_v2(span_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_requirement_item_span_authority_v2
BEFORE INSERT ON requirement_item_span_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM acceptance_authority_span_members_v2 m
  WHERE m.authority_root_id=NEW.authority_root_id AND m.span_id=NEW.span_id
    AND m.goal_id=NEW.goal_id AND m.contract_id=NEW.contract_id
)
BEGIN SELECT RAISE(ABORT,'Requirement V2 span is outside Acceptance authority'); END;

CREATE TABLE decision_requirements_v2 (
  decision_requirement_revision_id TEXT PRIMARY KEY,
  decision_requirement_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_key TEXT NOT NULL CHECK(length(decision_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind IN ('MATERIAL_UNKNOWN','DRAFT_REVIEW','ARCHITECTURE','ACCEPTANCE','RISK')),
  question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 8192),
  materiality TEXT NOT NULL CHECK(materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
  affected_requirement_ids_json TEXT NOT NULL CHECK(json_valid(affected_requirement_ids_json) AND json_type(affected_requirement_ids_json)='array'),
  affected_requirement_root_sha256 TEXT NOT NULL CHECK(length(affected_requirement_root_sha256)=64),
  source_span_ids_json TEXT NOT NULL CHECK(json_valid(source_span_ids_json) AND json_type(source_span_ids_json)='array'),
  source_span_root_sha256 TEXT NOT NULL CHECK(length(source_span_root_sha256)=64),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('IMMEDIATE','STAGE_ENTRY','EVIDENCE_CHANGE','CHANGE_REQUEST')),
  trigger_sha256 TEXT NOT NULL CHECK(length(trigger_sha256)=64),
  latest_resolution_stage TEXT NOT NULL CHECK(latest_resolution_stage IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  default_action TEXT NOT NULL CHECK(default_action IN ('APPROVE','REJECT')),
  default_value_json TEXT NOT NULL CHECK(json_valid(default_value_json)),
  default_sha256 TEXT NOT NULL CHECK(length(default_sha256)=64),
  reversibility TEXT NOT NULL CHECK(reversibility IN ('REVERSIBLE','EXPENSIVE_TO_REVERSE','IRREVERSIBLE')),
  affected_work_cell_ids_json TEXT NOT NULL CHECK(json_valid(affected_work_cell_ids_json) AND json_type(affected_work_cell_ids_json)='array'),
  affected_work_cell_root_sha256 TEXT NOT NULL CHECK(length(affected_work_cell_root_sha256)=64),
  proposal_origin TEXT NOT NULL CHECK(proposal_origin IN (
    'CURRENT_AGENT_TYPED_PROPOSAL','PROVIDER_TYPED_PROPOSAL','WORKER_TYPED_PROPOSAL'
  )),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(reversibility<>'IRREVERSIBLE' OR (
    blocking=1 AND default_action='REJECT' AND latest_resolution_stage IN (
      'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE'
    )
  )),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(requirement_revision_id,decision_key),
  UNIQUE(decision_requirement_id,requirement_revision_id),
  UNIQUE(decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TABLE decision_requirement_item_members_v2 (
  decision_requirement_revision_id TEXT NOT NULL,
  decision_requirement_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  requirement_item_revision_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 511),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(decision_requirement_revision_id,requirement_item_revision_id),
  UNIQUE(decision_requirement_revision_id,ordinal),
  FOREIGN KEY(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(requirement_item_revision_id,requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_items_v2(requirement_item_revision_id,requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE decision_requirement_span_members_v2 (
  decision_requirement_revision_id TEXT NOT NULL,
  decision_requirement_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(decision_requirement_revision_id,span_id),
  UNIQUE(decision_requirement_revision_id,ordinal),
  FOREIGN KEY(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(span_id,goal_id,contract_id)
    REFERENCES acceptance_source_spans_v2(span_id,goal_id,contract_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_decision_requirement_span_authority_v2
BEFORE INSERT ON decision_requirement_span_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM acceptance_authority_span_members_v2 m
  WHERE m.authority_root_id=NEW.authority_root_id AND m.span_id=NEW.span_id
    AND m.goal_id=NEW.goal_id AND m.contract_id=NEW.contract_id
) OR NOT EXISTS (
  SELECT 1 FROM decision_requirement_item_members_v2 di
  JOIN requirement_item_span_members_v2 rs
    ON rs.requirement_item_revision_id=di.requirement_item_revision_id
      AND rs.requirement_revision_id=di.requirement_revision_id
  WHERE di.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND rs.span_id=NEW.span_id
)
BEGIN SELECT RAISE(ABORT,'Decision V2 span is outside Acceptance authority'); END;

CREATE TABLE decision_due_event_receipts_v2 (
  due_event_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_requirement_revision_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  purpose TEXT NOT NULL CHECK(purpose IN ('DEFAULT_DEADLINE','DEFERRED_TRIGGER')),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('STAGE_ENTRY','EVIDENCE_CHANGE','CHANGE_REQUEST')),
  trigger_sha256 TEXT NOT NULL CHECK(length(trigger_sha256)=64),
  at_gate TEXT NOT NULL CHECK(at_gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  event_evidence_sha256 TEXT NOT NULL CHECK(length(event_evidence_sha256)=64),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  predecessor_resolution_sha256 TEXT NOT NULL CHECK(length(predecessor_resolution_sha256)=64),
  captured_by TEXT NOT NULL CHECK(captured_by='HOST'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(due_event_receipt_id,decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_decision_due_event_v2
BEFORE INSERT ON decision_due_event_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_requirements_v2 d JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=d.requirement_revision_id
  WHERE d.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND ((NEW.purpose='DEFAULT_DEADLINE' AND NEW.trigger_kind='STAGE_ENTRY'
      AND NEW.at_gate=d.latest_resolution_stage)
      OR (NEW.purpose='DEFERRED_TRIGGER' AND d.trigger_kind<>'IMMEDIATE'
        AND NEW.trigger_kind=d.trigger_kind AND NEW.trigger_sha256=d.trigger_sha256))
)
BEGIN SELECT RAISE(ABORT,'Decision V2 due event is outside its frozen trigger'); END;

CREATE TRIGGER validate_decision_due_event_predecessor_v2
BEFORE INSERT ON decision_due_event_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.goal_id=NEW.goal_id AND e.sequence=NEW.created_event_sequence-1
    AND e.event_sha256=NEW.event_head_sha256
) OR NEW.predecessor_resolution_sha256<>COALESCE((
  SELECT r.record_sha256 FROM decision_resolutions_v2 r
  WHERE r.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND r.created_event_sequence<NEW.created_event_sequence
  ORDER BY r.resolution_revision DESC LIMIT 1
),'0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT,'Decision V2 due event predecessor mismatch'); END;

CREATE TABLE decision_authority_inputs_v2 (
  authority_input_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_requirement_revision_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  decision_frontier_sha256 TEXT NOT NULL CHECK(length(decision_frontier_sha256)=64),
  action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','EDIT','DEFER')),
  action_payload_sha256 TEXT NOT NULL CHECK(length(action_payload_sha256)=64),
  at_gate TEXT NOT NULL CHECK(at_gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  authority_actor TEXT NOT NULL CHECK(authority_actor IN ('USER','HOST_DEFAULT')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('USER_TURN','HOST_DEFAULT_DUE')),
  session_id TEXT,
  turn_id TEXT,
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  due_event_receipt_id TEXT REFERENCES decision_due_event_receipts_v2(due_event_receipt_id),
  source_bytes BLOB NOT NULL CHECK(typeof(source_bytes)='blob'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 131072),
  encoding TEXT NOT NULL CHECK(encoding='UTF-8'),
  fidelity TEXT NOT NULL CHECK(fidelity='EXACT'),
  captured_by TEXT NOT NULL CHECK(captured_by='HOST'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(length(source_bytes)=byte_length),
  CHECK((authority_actor='USER' AND source_kind='USER_TURN' AND session_id IS NOT NULL AND turn_id IS NOT NULL AND due_event_receipt_id IS NULL)
    OR (authority_actor='HOST_DEFAULT' AND source_kind='HOST_DEFAULT_DUE' AND session_id IS NULL AND turn_id IS NULL AND due_event_receipt_id IS NOT NULL)),
  FOREIGN KEY(decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(authority_input_receipt_id,decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id,authority_actor)
) STRICT;

CREATE TRIGGER validate_decision_authority_input_v2
BEFORE INSERT ON decision_authority_inputs_v2
WHEN NOT EXISTS (
  SELECT 1 FROM requirement_revisions_v2 r
  WHERE r.requirement_revision_id=NEW.requirement_revision_id AND r.record_sha256=NEW.requirement_revision_sha256
) OR (NEW.authority_actor='HOST_DEFAULT' AND NOT EXISTS (
  SELECT 1 FROM decision_due_event_receipts_v2 e
  WHERE e.due_event_receipt_id=NEW.due_event_receipt_id
    AND e.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND e.requirement_revision_id=NEW.requirement_revision_id
    AND e.requirement_revision_sha256=NEW.requirement_revision_sha256
    AND e.purpose='DEFAULT_DEADLINE'
))
BEGIN SELECT RAISE(ABORT,'Decision V2 authority input binding mismatch'); END;

CREATE TRIGGER validate_decision_authority_input_event_head_v2
BEFORE INSERT ON decision_authority_inputs_v2
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.goal_id=NEW.goal_id AND e.sequence=NEW.created_event_sequence-1
    AND e.event_sha256=NEW.event_head_sha256
)
BEGIN SELECT RAISE(ABORT,'Decision V2 authority input event head mismatch'); END;

CREATE TABLE decision_resolutions_v2 (
  decision_resolution_id TEXT PRIMARY KEY,
  decision_requirement_revision_id TEXT NOT NULL,
  decision_requirement_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  resolution_revision INTEGER NOT NULL CHECK(resolution_revision BETWEEN 1 AND 1000000),
  parent_resolution_id TEXT REFERENCES decision_resolutions_v2(decision_resolution_id),
  action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','EDIT','DEFER')),
  authority_actor TEXT NOT NULL CHECK(authority_actor IN ('USER','HOST_DEFAULT')),
  at_stage TEXT NOT NULL CHECK(at_stage IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  decision_frontier_sha256 TEXT NOT NULL CHECK(length(decision_frontier_sha256)=64),
  action_payload_sha256 TEXT NOT NULL CHECK(length(action_payload_sha256)=64),
  authority_input_receipt_id TEXT NOT NULL,
  due_event_receipt_id TEXT REFERENCES decision_due_event_receipts_v2(due_event_receipt_id),
  resolution_input_sha256 TEXT NOT NULL CHECK(length(resolution_input_sha256)=64),
  authority_source_span_id TEXT,
  selected_value_json TEXT NOT NULL CHECK(json_valid(selected_value_json)),
  selected_value_sha256 TEXT NOT NULL CHECK(length(selected_value_sha256)=64),
  edited_requirement_revision_id TEXT REFERENCES requirement_revisions_v2(requirement_revision_id),
  deferred_trigger_sha256 TEXT CHECK(deferred_trigger_sha256 IS NULL OR length(deferred_trigger_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((resolution_revision=1 AND parent_resolution_id IS NULL) OR (resolution_revision>1 AND parent_resolution_id IS NOT NULL)),
  CHECK((action='EDIT' AND edited_requirement_revision_id IS NOT NULL AND deferred_trigger_sha256 IS NULL)
    OR (action='DEFER' AND edited_requirement_revision_id IS NULL AND deferred_trigger_sha256 IS NOT NULL)
    OR (action IN ('APPROVE','REJECT') AND edited_requirement_revision_id IS NULL AND deferred_trigger_sha256 IS NULL)),
  FOREIGN KEY(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  CHECK((authority_actor='USER' AND due_event_receipt_id IS NULL)
    OR (authority_actor='HOST_DEFAULT' AND due_event_receipt_id IS NOT NULL)),
  FOREIGN KEY(authority_input_receipt_id,decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id,authority_actor)
    REFERENCES decision_authority_inputs_v2(authority_input_receipt_id,decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id,authority_actor),
  FOREIGN KEY(authority_source_span_id,goal_id,contract_id)
    REFERENCES acceptance_source_spans_v2(span_id,goal_id,contract_id),
  UNIQUE(decision_requirement_revision_id,resolution_revision),
  UNIQUE(authority_input_receipt_id),
  UNIQUE(due_event_receipt_id),
  UNIQUE(decision_resolution_id,decision_requirement_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_decision_default_resolution_head_v2
BEFORE INSERT ON decision_resolutions_v2
WHEN NEW.authority_actor='HOST_DEFAULT' AND (
  EXISTS (
    SELECT 1 FROM decision_requirements_v2 d
    WHERE d.decision_requirement_revision_id=NEW.decision_requirement_revision_id
      AND d.reversibility='IRREVERSIBLE'
  ) OR NOT EXISTS (
    SELECT 1 FROM decision_due_event_receipts_v2 e
    WHERE e.due_event_receipt_id=NEW.due_event_receipt_id
      AND e.predecessor_resolution_sha256=COALESCE((
        SELECT r.record_sha256 FROM decision_resolutions_v2 r
        WHERE r.decision_requirement_revision_id=NEW.decision_requirement_revision_id
        ORDER BY r.resolution_revision DESC LIMIT 1
      ),'0000000000000000000000000000000000000000000000000000000000000000')
  )
)
BEGIN SELECT RAISE(ABORT,'Decision V2 Host default resolution head is stale'); END;

CREATE TRIGGER validate_decision_resolution_authority_v2
BEFORE INSERT ON decision_resolutions_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_authority_inputs_v2 i
  WHERE i.authority_input_receipt_id=NEW.authority_input_receipt_id
    AND i.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND i.requirement_revision_id=NEW.requirement_revision_id
    AND i.action=NEW.action AND i.action_payload_sha256=NEW.action_payload_sha256
    AND i.at_gate=NEW.at_stage
    AND i.decision_frontier_sha256=NEW.decision_frontier_sha256
    AND i.authority_actor=NEW.authority_actor
    AND i.content_sha256=NEW.resolution_input_sha256
    AND i.due_event_receipt_id IS NEW.due_event_receipt_id
)
BEGIN SELECT RAISE(ABORT,'Decision V2 resolution authority binding mismatch'); END;

CREATE TRIGGER validate_decision_resolution_parent_v2
BEFORE INSERT ON decision_resolutions_v2
WHEN NEW.parent_resolution_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM decision_resolutions_v2 p
  WHERE p.decision_resolution_id=NEW.parent_resolution_id
    AND p.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND p.resolution_revision=NEW.resolution_revision-1
)
BEGIN SELECT RAISE(ABORT,'Decision V2 resolution parent mismatch'); END;

CREATE TRIGGER validate_decision_resolution_edit_v2
BEFORE INSERT ON decision_resolutions_v2
WHEN NEW.edited_requirement_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM requirement_revisions_v2 r JOIN requirement_revisions_v2 previous
    ON previous.requirement_revision_id=NEW.requirement_revision_id
  WHERE r.requirement_revision_id=NEW.edited_requirement_revision_id
    AND r.goal_id=NEW.goal_id
    AND r.parent_requirement_revision_id=previous.requirement_revision_id AND r.revision=previous.revision+1
)
BEGIN SELECT RAISE(ABORT,'Decision V2 EDIT does not bind the next Requirement revision'); END;

CREATE TRIGGER validate_decision_resolution_span_authority_v2
BEFORE INSERT ON decision_resolutions_v2
WHEN NEW.authority_source_span_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM acceptance_authority_span_members_v2 m
  WHERE m.authority_root_id=NEW.authority_root_id AND m.span_id=NEW.authority_source_span_id
    AND m.goal_id=NEW.goal_id AND m.contract_id=NEW.contract_id
)
BEGIN SELECT RAISE(ABORT,'Decision V2 resolution span is outside Acceptance authority'); END;

CREATE TABLE decision_closures_v2 (
  decision_closure_id TEXT PRIMARY KEY,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  decision_root_sha256 TEXT NOT NULL CHECK(length(decision_root_sha256)=64),
  resolution_root_sha256 TEXT NOT NULL CHECK(length(resolution_root_sha256)=64),
  member_root_sha256 TEXT NOT NULL CHECK(length(member_root_sha256)=64),
  unresolved_ids_json TEXT NOT NULL CHECK(json_valid(unresolved_ids_json) AND json_type(unresolved_ids_json)='array'),
  rejected_ids_json TEXT NOT NULL CHECK(json_valid(rejected_ids_json) AND json_type(rejected_ids_json)='array'),
  edited_ids_json TEXT NOT NULL CHECK(json_valid(edited_ids_json) AND json_type(edited_ids_json)='array'),
  deferred_ids_json TEXT NOT NULL CHECK(json_valid(deferred_ids_json) AND json_type(deferred_ids_json)='array'),
  due_deferred_ids_json TEXT NOT NULL CHECK(json_valid(due_deferred_ids_json) AND json_type(due_deferred_ids_json)='array'),
  draft_review_approved INTEGER NOT NULL CHECK(draft_review_approved IN (0,1)),
  qualified INTEGER NOT NULL CHECK(qualified IN (0,1)),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(requirement_revision_id,gate,resolution_root_sha256),
  UNIQUE(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TABLE decision_closure_members_v2 (
  decision_closure_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_requirement_revision_id TEXT NOT NULL,
  decision_requirement_id TEXT NOT NULL,
  decision_resolution_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('APPROVED','REJECTED','EDITED','DEFERRED','DUE_DEFERRED','UNRESOLVED')),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(decision_closure_id,decision_requirement_revision_id),
  UNIQUE(decision_closure_id,ordinal),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_resolution_id) REFERENCES decision_resolutions_v2(decision_resolution_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_decision_closure_resolution_v2
BEFORE INSERT ON decision_closure_members_v2
WHEN (NEW.state='UNRESOLVED' AND NEW.decision_resolution_id IS NOT NULL)
  OR (NEW.state<>'UNRESOLVED' AND NOT EXISTS (
    SELECT 1 FROM decision_resolutions_v2 r
    WHERE r.decision_resolution_id=NEW.decision_resolution_id
      AND r.decision_requirement_revision_id=NEW.decision_requirement_revision_id
      AND r.requirement_revision_id=NEW.requirement_revision_id AND r.goal_id=NEW.goal_id
      AND r.contract_id=NEW.contract_id AND r.authority_root_id=NEW.authority_root_id
  ))
BEGIN SELECT RAISE(ABORT,'Decision V2 closure resolution mismatch'); END;

CREATE TABLE goal_fit_reviews_v2 (
  goal_fit_review_id TEXT PRIMARY KEY,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  verdict TEXT NOT NULL CHECK(verdict IN ('FIT','ASK_USER','REFRAME','REJECT')),
  review_owner TEXT NOT NULL CHECK(review_owner='HOST'),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
  reason_code_root_sha256 TEXT NOT NULL CHECK(length(reason_code_root_sha256)=64),
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  requirement_root_sha256 TEXT NOT NULL CHECK(length(requirement_root_sha256)=64),
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(requirement_revision_id,gate,decision_closure_id),
  UNIQUE(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_goal_fit_review_closure_v2
BEFORE INSERT ON goal_fit_reviews_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_closures_v2 d JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=d.requirement_revision_id
  WHERE d.decision_closure_id=NEW.decision_closure_id AND d.gate=NEW.gate
    AND d.record_sha256=NEW.decision_closure_sha256
    AND r.source_root_sha256=NEW.source_root_sha256 AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND (NEW.verdict<>'FIT' OR d.qualified=1)
    AND NEW.verdict=CASE
      WHEN d.rejected_ids_json<>'[]' THEN 'REJECT'
      WHEN d.edited_ids_json<>'[]' THEN 'REFRAME'
      WHEN d.qualified=0 OR d.unresolved_ids_json<>'[]' OR d.due_deferred_ids_json<>'[]' THEN 'ASK_USER'
      ELSE 'FIT'
    END
    AND NEW.reason_codes_json=CASE
      WHEN d.rejected_ids_json<>'[]' THEN '["DECISION_REJECTED"]'
      WHEN d.edited_ids_json<>'[]' THEN '["REQUIREMENT_EDIT_REQUIRED"]'
      WHEN d.qualified=0 OR d.unresolved_ids_json<>'[]' OR d.due_deferred_ids_json<>'[]'
        THEN '["MATERIAL_DECISION_PENDING"]'
      ELSE '["REQUIREMENT_TRACE_COMPLETE","USER_VALUE_CONFIRMED"]'
    END
  )
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 closure mismatch'); END;

CREATE TABLE contract_freeze_receipts_v2 (
  contract_freeze_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  goal_fit_review_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 1000000),
  predecessor_freeze_sha256 TEXT NOT NULL CHECK(length(predecessor_freeze_sha256)=64),
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256)=64),
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  facet_root_sha256 TEXT NOT NULL CHECK(length(facet_root_sha256)=64),
  requirement_root_sha256 TEXT NOT NULL CHECK(length(requirement_root_sha256)=64),
  decision_root_sha256 TEXT NOT NULL CHECK(length(decision_root_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(authority_root_id,goal_id,contract_id)
    REFERENCES acceptance_authority_roots_v2(authority_root_id,goal_id,contract_id),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES goal_fit_reviews_v2(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(goal_id,generation),
  UNIQUE(contract_id),
  UNIQUE(contract_freeze_receipt_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_contract_freeze_receipt_v2
BEFORE INSERT ON contract_freeze_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_contract_versions_v1 c
  JOIN acceptance_authority_roots_v2 a ON a.authority_root_id=NEW.authority_root_id
  JOIN requirement_revisions_v2 r ON r.requirement_revision_id=NEW.requirement_revision_id
  JOIN decision_closures_v2 d ON d.decision_closure_id=NEW.decision_closure_id
  JOIN goal_fit_reviews_v2 g ON g.goal_fit_review_id=NEW.goal_fit_review_id
  WHERE c.contract_id=NEW.contract_id AND c.goal_id=NEW.goal_id AND c.record_sha256=NEW.contract_sha256
    AND a.contract_sha256=NEW.contract_sha256 AND a.source_root_sha256=NEW.source_root_sha256
    AND a.facet_root_sha256=NEW.facet_root_sha256
    AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND d.decision_root_sha256=NEW.decision_root_sha256 AND d.gate='CONTRACT_FREEZE'
    AND d.qualified=1 AND d.draft_review_approved=1
    AND g.gate='CONTRACT_FREEZE' AND g.verdict='FIT' AND g.decision_closure_id=d.decision_closure_id
    AND NOT EXISTS (
      SELECT 1 FROM acceptance_authority_facet_members_v2 af
      WHERE af.authority_root_id=NEW.authority_root_id AND NOT EXISTS (
        SELECT 1 FROM requirement_item_facet_members_v2 rf
        WHERE rf.requirement_revision_id=NEW.requirement_revision_id AND rf.facet_id=af.facet_id
      )
    )
    AND EXISTS (
      SELECT 1 FROM decision_closure_members_v2 m
      JOIN decision_requirements_v2 dr ON dr.decision_requirement_revision_id=m.decision_requirement_revision_id
      JOIN decision_resolutions_v2 rr ON rr.decision_resolution_id=m.decision_resolution_id
      JOIN decision_authority_inputs_v2 ai ON ai.authority_input_receipt_id=rr.authority_input_receipt_id
      WHERE m.decision_closure_id=d.decision_closure_id AND m.state='APPROVED'
        AND dr.kind='DRAFT_REVIEW' AND rr.authority_actor='USER' AND rr.action='APPROVE'
        AND ai.requirement_revision_sha256=r.record_sha256
        AND ai.decision_frontier_sha256=d.decision_root_sha256 AND ai.action='APPROVE'
    )
)
BEGIN SELECT RAISE(ABORT,'Contract freeze V2 authority closure mismatch'); END;

CREATE TRIGGER validate_contract_freeze_predecessor_v2
BEFORE INSERT ON contract_freeze_receipts_v2
WHEN (NEW.generation=1 AND NEW.predecessor_freeze_sha256<>'0000000000000000000000000000000000000000000000000000000000000000')
  OR (NEW.generation>1 AND NOT EXISTS (
    SELECT 1 FROM contract_freeze_receipts_v2 p
    WHERE p.goal_id=NEW.goal_id AND p.generation=NEW.generation-1
      AND p.record_sha256=NEW.predecessor_freeze_sha256
  ))
BEGIN SELECT RAISE(ABORT,'Contract freeze V2 predecessor CAS mismatch'); END;

CREATE INDEX ix_requirement_revision_goal_v2 ON requirement_revisions_v2(goal_id,revision);
CREATE INDEX ix_requirement_item_revision_v2 ON requirement_items_v2(requirement_revision_id,semantic_key);
CREATE INDEX ix_decision_requirement_revision_v2 ON decision_requirements_v2(requirement_revision_id,decision_key);
CREATE INDEX ix_decision_resolution_requirement_v2 ON decision_resolutions_v2(decision_requirement_revision_id,resolution_revision);
CREATE INDEX ix_decision_due_event_requirement_v2 ON decision_due_event_receipts_v2(decision_requirement_revision_id,created_event_sequence);
CREATE INDEX ix_decision_closure_requirement_v2 ON decision_closures_v2(requirement_revision_id,gate,created_event_sequence);
CREATE INDEX ix_goal_fit_review_goal_v2 ON goal_fit_reviews_v2(goal_id,gate,created_event_sequence);

CREATE TRIGGER no_update_requirement_revisions_v2 BEFORE UPDATE ON requirement_revisions_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 revisions are immutable'); END;
CREATE TRIGGER no_delete_requirement_revisions_v2 BEFORE DELETE ON requirement_revisions_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 revisions are immutable'); END;
CREATE TRIGGER no_update_requirement_items_v2 BEFORE UPDATE ON requirement_items_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 items are immutable'); END;
CREATE TRIGGER no_delete_requirement_items_v2 BEFORE DELETE ON requirement_items_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 items are immutable'); END;
CREATE TRIGGER no_update_requirement_item_facet_members_v2 BEFORE UPDATE ON requirement_item_facet_members_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 facet members are immutable'); END;
CREATE TRIGGER no_delete_requirement_item_facet_members_v2 BEFORE DELETE ON requirement_item_facet_members_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 facet members are immutable'); END;
CREATE TRIGGER no_update_requirement_item_span_members_v2 BEFORE UPDATE ON requirement_item_span_members_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 span members are immutable'); END;
CREATE TRIGGER no_delete_requirement_item_span_members_v2 BEFORE DELETE ON requirement_item_span_members_v2 BEGIN SELECT RAISE(ABORT,'Requirement V2 span members are immutable'); END;
CREATE TRIGGER no_update_decision_requirements_v2 BEFORE UPDATE ON decision_requirements_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 requirements are immutable'); END;
CREATE TRIGGER no_delete_decision_requirements_v2 BEFORE DELETE ON decision_requirements_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 requirements are immutable'); END;
CREATE TRIGGER no_update_decision_requirement_item_members_v2 BEFORE UPDATE ON decision_requirement_item_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 item members are immutable'); END;
CREATE TRIGGER no_delete_decision_requirement_item_members_v2 BEFORE DELETE ON decision_requirement_item_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 item members are immutable'); END;
CREATE TRIGGER no_update_decision_requirement_span_members_v2 BEFORE UPDATE ON decision_requirement_span_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 span members are immutable'); END;
CREATE TRIGGER no_delete_decision_requirement_span_members_v2 BEFORE DELETE ON decision_requirement_span_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 span members are immutable'); END;
CREATE TRIGGER no_update_decision_authority_inputs_v2 BEFORE UPDATE ON decision_authority_inputs_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 authority inputs are immutable'); END;
CREATE TRIGGER no_delete_decision_authority_inputs_v2 BEFORE DELETE ON decision_authority_inputs_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 authority inputs are immutable'); END;
CREATE TRIGGER no_update_decision_due_event_receipts_v2 BEFORE UPDATE ON decision_due_event_receipts_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 due events are immutable'); END;
CREATE TRIGGER no_delete_decision_due_event_receipts_v2 BEFORE DELETE ON decision_due_event_receipts_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 due events are immutable'); END;
CREATE TRIGGER no_update_decision_resolutions_v2 BEFORE UPDATE ON decision_resolutions_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 resolutions are immutable'); END;
CREATE TRIGGER no_delete_decision_resolutions_v2 BEFORE DELETE ON decision_resolutions_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 resolutions are immutable'); END;
CREATE TRIGGER no_update_decision_closures_v2 BEFORE UPDATE ON decision_closures_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 closures are immutable'); END;
CREATE TRIGGER no_delete_decision_closures_v2 BEFORE DELETE ON decision_closures_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 closures are immutable'); END;
CREATE TRIGGER no_update_decision_closure_members_v2 BEFORE UPDATE ON decision_closure_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 closure members are immutable'); END;
CREATE TRIGGER no_delete_decision_closure_members_v2 BEFORE DELETE ON decision_closure_members_v2 BEGIN SELECT RAISE(ABORT,'Decision V2 closure members are immutable'); END;
CREATE TRIGGER no_update_goal_fit_reviews_v2 BEFORE UPDATE ON goal_fit_reviews_v2 BEGIN SELECT RAISE(ABORT,'Goal Fit V2 reviews are immutable'); END;
CREATE TRIGGER no_delete_goal_fit_reviews_v2 BEFORE DELETE ON goal_fit_reviews_v2 BEGIN SELECT RAISE(ABORT,'Goal Fit V2 reviews are immutable'); END;
CREATE TRIGGER no_update_contract_freeze_receipts_v2 BEFORE UPDATE ON contract_freeze_receipts_v2 BEGIN SELECT RAISE(ABORT,'Contract freeze V2 receipts are immutable'); END;
CREATE TRIGGER no_delete_contract_freeze_receipts_v2 BEFORE DELETE ON contract_freeze_receipts_v2 BEGIN SELECT RAISE(ABORT,'Contract freeze V2 receipts are immutable'); END;
