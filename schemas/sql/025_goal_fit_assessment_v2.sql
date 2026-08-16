-- Goal Fit is qualified by a typed Agent assessment plus an exact Host gate
-- instance. Legacy reviews remain immutable history and cannot authorize new
-- Contract or Stage gates without a fresh assessment binding.

CREATE TABLE goal_fit_gate_instances_v2 (
  gate_instance_receipt_id TEXT PRIMARY KEY,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  gate_subject_kind TEXT NOT NULL CHECK(gate_subject_kind IN (
    'REQUIREMENT_REVISION','PLAN_REVISION','CHANGE_ACCEPTANCE_CLOSURE','FAILURE_RECEIPT','DELIVERABLE_MANIFEST'
  )),
  gate_subject_id TEXT NOT NULL CHECK(length(gate_subject_id) BETWEEN 1 AND 160),
  gate_subject_sha256 TEXT NOT NULL CHECK(length(gate_subject_sha256)=64),
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  host_evidence_sha256s_json TEXT NOT NULL
    CHECK(json_valid(host_evidence_sha256s_json) AND json_type(host_evidence_sha256s_json)='array'),
  host_evidence_root_sha256 TEXT NOT NULL CHECK(length(host_evidence_root_sha256)=64),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id)
) STRICT;

CREATE TRIGGER validate_goal_fit_gate_instance_v2
BEFORE INSERT ON goal_fit_gate_instances_v2
WHEN NOT EXISTS (
  SELECT 1 FROM requirement_revisions_v2 r JOIN decision_closures_v2 d
    ON d.requirement_revision_id=r.requirement_revision_id
  WHERE r.requirement_revision_id=NEW.requirement_revision_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND d.decision_closure_id=NEW.decision_closure_id
    AND d.record_sha256=NEW.decision_closure_sha256 AND d.gate=NEW.gate
    AND r.goal_id=NEW.goal_id AND r.contract_id=NEW.contract_id AND r.authority_root_id=NEW.authority_root_id
) OR NOT EXISTS (
  SELECT 1 FROM events e WHERE e.goal_id=NEW.goal_id
    AND e.sequence=NEW.created_event_sequence-1 AND e.event_sha256=NEW.event_head_sha256
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.host_evidence_sha256s_json)
  WHERE type<>'text' OR length(value)<>64
) OR json_array_length(NEW.host_evidence_sha256s_json) NOT BETWEEN 1 AND 256
OR (
  NEW.gate IN ('CONTRACT_REVIEW','CONTRACT_FREEZE')
  AND (NEW.gate_subject_kind<>'REQUIREMENT_REVISION'
    OR NEW.gate_subject_id<>NEW.requirement_revision_id
    OR NEW.gate_subject_sha256<>NEW.requirement_revision_sha256)
) OR (
  NEW.gate IN ('PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE')
  AND (NEW.gate_subject_kind<>'PLAN_REVISION' OR NOT EXISTS (
    SELECT 1 FROM plan_revisions_v2 p
    WHERE p.plan_revision_id=NEW.gate_subject_id AND p.record_sha256=NEW.gate_subject_sha256
      AND p.requirement_revision_id=NEW.requirement_revision_id AND p.goal_id=NEW.goal_id
      AND p.contract_id=NEW.contract_id AND p.authority_root_id=NEW.authority_root_id
  ))
) OR NEW.gate IN ('REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE')
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 gate instance closure mismatch or unsupported gate'); END;

CREATE TABLE goal_fit_assessments_v2 (
  goal_fit_assessment_id TEXT PRIMARY KEY,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  gate_instance_receipt_id TEXT NOT NULL,
  gate_instance_receipt_sha256 TEXT NOT NULL CHECK(length(gate_instance_receipt_sha256)=64),
  proposal_origin TEXT NOT NULL CHECK(proposal_origin IN (
    'CURRENT_AGENT_TYPED_PROPOSAL','PROVIDER_TYPED_PROPOSAL','WORKER_TYPED_PROPOSAL'
  )),
  outcome_fidelity_json TEXT NOT NULL CHECK(json_valid(outcome_fidelity_json) AND json_type(outcome_fidelity_json)='object'),
  obligation_coverage_json TEXT NOT NULL CHECK(json_valid(obligation_coverage_json) AND json_type(obligation_coverage_json)='object'),
  unnecessary_design_json TEXT NOT NULL CHECK(json_valid(unnecessary_design_json) AND json_type(unnecessary_design_json)='object'),
  current_decisions_json TEXT NOT NULL CHECK(json_valid(current_decisions_json) AND json_type(current_decisions_json)='object'),
  invalidations_json TEXT NOT NULL CHECK(json_valid(invalidations_json) AND json_type(invalidations_json)='object'),
  gate_specific_evidence_json TEXT NOT NULL
    CHECK(json_valid(gate_specific_evidence_json) AND json_type(gate_specific_evidence_json)='object'),
  plan_revision_sha256 TEXT CHECK(plan_revision_sha256 IS NULL OR length(plan_revision_sha256)=64),
  decision_plan_binding_root_sha256 TEXT
    CHECK(decision_plan_binding_root_sha256 IS NULL OR length(decision_plan_binding_root_sha256)=64),
  change_acceptance_closure_sha256 TEXT
    CHECK(change_acceptance_closure_sha256 IS NULL OR length(change_acceptance_closure_sha256)=64),
  invalidation_root_sha256 TEXT CHECK(invalidation_root_sha256 IS NULL OR length(invalidation_root_sha256)=64),
  oracle_evidence_root_sha256 TEXT CHECK(oracle_evidence_root_sha256 IS NULL OR length(oracle_evidence_root_sha256)=64),
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
  FOREIGN KEY(gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id)
    REFERENCES goal_fit_gate_instances_v2(
      gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id
    ),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(goal_fit_assessment_id,gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_goal_fit_assessment_v2
BEFORE INSERT ON goal_fit_assessments_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_fit_gate_instances_v2 g JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=g.requirement_revision_id
  WHERE g.gate_instance_receipt_id=NEW.gate_instance_receipt_id
    AND g.record_sha256=NEW.gate_instance_receipt_sha256
    AND g.requirement_revision_id=NEW.requirement_revision_id
    AND g.decision_closure_id=NEW.decision_closure_id AND g.gate=NEW.gate
    AND g.goal_id=NEW.goal_id AND g.contract_id=NEW.contract_id AND g.authority_root_id=NEW.authority_root_id
    AND r.source_root_sha256=NEW.source_root_sha256
    AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND g.decision_closure_sha256=NEW.decision_closure_sha256
) OR json_extract(NEW.gate_specific_evidence_json,'$.status')='NOT_APPLICABLE'
OR NOT EXISTS (
  SELECT 1 FROM json_each(json_extract(NEW.gate_specific_evidence_json,'$.evidence_receipt_sha256s'))
  WHERE value=NEW.gate_instance_receipt_sha256
)
OR EXISTS (
  SELECT 1 FROM (SELECT NEW.outcome_fidelity_json value UNION ALL SELECT NEW.obligation_coverage_json
    UNION ALL SELECT NEW.unnecessary_design_json UNION ALL SELECT NEW.current_decisions_json
    UNION ALL SELECT NEW.invalidations_json UNION ALL SELECT NEW.gate_specific_evidence_json)
  WHERE json_extract(value,'$.status') NOT IN ('PASS','NOT_APPLICABLE','ASK_USER','REFRAME','REJECT')
    OR json_type(value,'$.reason_codes')<>'array'
    OR json_type(value,'$.subject_ids')<>'array'
    OR json_type(value,'$.evidence_receipt_sha256s')<>'array'
)
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 assessment closure mismatch'); END;

CREATE TABLE goal_fit_review_assessment_bindings_v2 (
  goal_fit_review_id TEXT PRIMARY KEY,
  goal_fit_review_sha256 TEXT NOT NULL CHECK(length(goal_fit_review_sha256)=64),
  goal_fit_assessment_id TEXT NOT NULL UNIQUE,
  goal_fit_assessment_sha256 TEXT NOT NULL CHECK(length(goal_fit_assessment_sha256)=64),
  gate_instance_receipt_id TEXT NOT NULL UNIQUE,
  gate_instance_receipt_sha256 TEXT NOT NULL CHECK(length(gate_instance_receipt_sha256)=64),
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  derived_verdict TEXT NOT NULL CHECK(derived_verdict IN ('FIT','ASK_USER','REFRAME','REJECT')),
  derived_reason_codes_json TEXT NOT NULL
    CHECK(json_valid(derived_reason_codes_json) AND json_type(derived_reason_codes_json)='array'),
  derived_reason_code_root_sha256 TEXT NOT NULL CHECK(length(derived_reason_code_root_sha256)=64),
  qualification_status TEXT NOT NULL CHECK(qualification_status='CURRENT_ASSESSED'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES goal_fit_reviews_v2(
      goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id
    ),
  FOREIGN KEY(goal_fit_assessment_id,gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES goal_fit_assessments_v2(
      goal_fit_assessment_id,gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id
    ),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER validate_goal_fit_review_assessment_binding_v2
BEFORE INSERT ON goal_fit_review_assessment_bindings_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_fit_reviews_v2 r
  JOIN goal_fit_assessments_v2 a ON a.goal_fit_assessment_id=NEW.goal_fit_assessment_id
  JOIN goal_fit_gate_instances_v2 g ON g.gate_instance_receipt_id=NEW.gate_instance_receipt_id
  JOIN decision_closures_v2 d ON d.decision_closure_id=NEW.decision_closure_id
  WHERE r.goal_fit_review_id=NEW.goal_fit_review_id AND r.record_sha256=NEW.goal_fit_review_sha256
    AND a.record_sha256=NEW.goal_fit_assessment_sha256
    AND g.record_sha256=NEW.gate_instance_receipt_sha256
    AND r.requirement_revision_id=NEW.requirement_revision_id
    AND r.decision_closure_id=NEW.decision_closure_id AND r.gate=NEW.gate
    AND a.requirement_revision_id=NEW.requirement_revision_id
    AND a.decision_closure_id=NEW.decision_closure_id AND a.gate=NEW.gate
    AND g.requirement_revision_id=NEW.requirement_revision_id
    AND g.decision_closure_id=NEW.decision_closure_id AND g.gate=NEW.gate
    AND r.goal_id=NEW.goal_id AND r.contract_id=NEW.contract_id AND r.authority_root_id=NEW.authority_root_id
    AND r.verdict=NEW.derived_verdict AND r.reason_codes_json=NEW.derived_reason_codes_json
    AND NEW.derived_verdict=CASE
      WHEN d.rejected_ids_json<>'[]' THEN 'REJECT'
      WHEN d.edited_ids_json<>'[]' THEN 'REFRAME'
      WHEN d.qualified=0 OR d.unresolved_ids_json<>'[]' OR d.due_deferred_ids_json<>'[]' THEN 'ASK_USER'
      WHEN json_extract(a.outcome_fidelity_json,'$.status')='REJECT'
        OR json_extract(a.obligation_coverage_json,'$.status')='REJECT'
        OR json_extract(a.unnecessary_design_json,'$.status')='REJECT'
        OR json_extract(a.current_decisions_json,'$.status')='REJECT'
        OR json_extract(a.invalidations_json,'$.status')='REJECT'
        OR json_extract(a.gate_specific_evidence_json,'$.status')='REJECT' THEN 'REJECT'
      WHEN json_extract(a.outcome_fidelity_json,'$.status')='REFRAME'
        OR json_extract(a.obligation_coverage_json,'$.status')='REFRAME'
        OR json_extract(a.unnecessary_design_json,'$.status')='REFRAME'
        OR json_extract(a.current_decisions_json,'$.status')='REFRAME'
        OR json_extract(a.invalidations_json,'$.status')='REFRAME'
        OR json_extract(a.gate_specific_evidence_json,'$.status')='REFRAME' THEN 'REFRAME'
      WHEN json_extract(a.outcome_fidelity_json,'$.status')='ASK_USER'
        OR json_extract(a.obligation_coverage_json,'$.status')='ASK_USER'
        OR json_extract(a.unnecessary_design_json,'$.status')='ASK_USER'
        OR json_extract(a.current_decisions_json,'$.status')='ASK_USER'
        OR json_extract(a.invalidations_json,'$.status')='ASK_USER'
        OR json_extract(a.gate_specific_evidence_json,'$.status')='ASK_USER' THEN 'ASK_USER'
      ELSE 'FIT'
    END
)
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 assessed review binding mismatch'); END;

DROP TRIGGER validate_goal_fit_review_closure_v2;
CREATE TRIGGER validate_goal_fit_review_closure_v2
BEFORE INSERT ON goal_fit_reviews_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_closures_v2 d JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=d.requirement_revision_id
  WHERE d.decision_closure_id=NEW.decision_closure_id AND d.gate=NEW.gate
    AND d.record_sha256=NEW.decision_closure_sha256
    AND r.source_root_sha256=NEW.source_root_sha256
    AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND (NEW.verdict<>'FIT' OR d.qualified=1)
)
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 closure mismatch'); END;

CREATE TRIGGER require_assessed_goal_fit_contract_freeze_v2
BEFORE INSERT ON contract_freeze_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_fit_review_assessment_bindings_v2 b
  WHERE b.goal_fit_review_id=NEW.goal_fit_review_id
    AND b.goal_id=NEW.goal_id AND b.contract_id=NEW.contract_id
    AND b.requirement_revision_id=NEW.requirement_revision_id
    AND b.decision_closure_id=NEW.decision_closure_id
    AND b.gate='CONTRACT_FREEZE' AND b.derived_verdict='FIT'
    AND b.created_event_sequence=NEW.created_event_sequence
    AND b.created_at_ms=NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT,'Contract freeze V2 requires a current assessed Goal Fit binding'); END;

CREATE TRIGGER require_assessed_goal_fit_stage_gate_v2
BEFORE INSERT ON stage_gate_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_fit_review_assessment_bindings_v2 b
  WHERE b.goal_fit_review_id=NEW.goal_fit_review_id
    AND b.goal_id=NEW.goal_id AND b.contract_id=NEW.contract_id
    AND b.requirement_revision_id=NEW.requirement_revision_id
    AND b.decision_closure_id=NEW.decision_closure_id
    AND b.gate=NEW.gate AND b.derived_verdict='FIT'
    AND b.created_event_sequence<NEW.created_event_sequence
)
BEGIN SELECT RAISE(ABORT,'Stage gate V2 requires a current assessed Goal Fit binding'); END;

CREATE INDEX ix_goal_fit_gate_instances_v2_goal
  ON goal_fit_gate_instances_v2(goal_id,gate,created_event_sequence);
CREATE INDEX ix_goal_fit_assessments_v2_goal
  ON goal_fit_assessments_v2(goal_id,gate,created_event_sequence);
CREATE INDEX ix_goal_fit_review_bindings_v2_goal
  ON goal_fit_review_assessment_bindings_v2(goal_id,gate,created_event_sequence);

CREATE TRIGGER no_update_goal_fit_gate_instances_v2 BEFORE UPDATE ON goal_fit_gate_instances_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 gate instances are immutable'); END;
CREATE TRIGGER no_delete_goal_fit_gate_instances_v2 BEFORE DELETE ON goal_fit_gate_instances_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 gate instances are immutable'); END;
CREATE TRIGGER no_update_goal_fit_assessments_v2 BEFORE UPDATE ON goal_fit_assessments_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 assessments are immutable'); END;
CREATE TRIGGER no_delete_goal_fit_assessments_v2 BEFORE DELETE ON goal_fit_assessments_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 assessments are immutable'); END;
CREATE TRIGGER no_update_goal_fit_review_assessment_bindings_v2
BEFORE UPDATE ON goal_fit_review_assessment_bindings_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 review bindings are immutable'); END;
CREATE TRIGGER no_delete_goal_fit_review_assessment_bindings_v2
BEFORE DELETE ON goal_fit_review_assessment_bindings_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 review bindings are immutable'); END;
