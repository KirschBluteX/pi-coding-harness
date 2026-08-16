-- Change Acceptance V2 seals one direct successor Plan over every pending
-- material user turn captured against the same base Plan. Member rows are
-- written before their root seal; deferred foreign keys make the transaction
-- fail closed if the seal or any member is missing.

CREATE TABLE decision_plan_bindings_v2 (
  decision_plan_binding_id TEXT PRIMARY KEY,
  plan_revision_id TEXT NOT NULL UNIQUE,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  member_root_sha256 TEXT NOT NULL CHECK(length(member_root_sha256)=64),
  member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 1024),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id) REFERENCES plan_revisions_v2(plan_revision_id),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(decision_plan_binding_id,plan_revision_id,requirement_revision_id,goal_id,
    contract_id,authority_root_id,decision_closure_id)
) STRICT;

CREATE TABLE decision_plan_binding_members_v2 (
  decision_plan_binding_id TEXT NOT NULL,
  decision_plan_binding_member_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  decision_requirement_revision_id TEXT NOT NULL,
  decision_requirement_id TEXT NOT NULL CHECK(length(decision_requirement_id) BETWEEN 1 AND 160),
  decision_requirement_sha256 TEXT NOT NULL CHECK(length(decision_requirement_sha256)=64),
  decision_state TEXT NOT NULL CHECK(decision_state IN (
    'APPROVED','REJECTED','EDITED','DEFERRED','DUE_DEFERRED','UNRESOLVED'
  )),
  decision_resolution_id TEXT NOT NULL,
  decision_resolution_sha256 TEXT NOT NULL CHECK(length(decision_resolution_sha256)=64),
  target_root_sha256 TEXT NOT NULL CHECK(length(target_root_sha256)=64),
  target_count INTEGER NOT NULL CHECK(target_count BETWEEN 1 AND 8192),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 1023),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(decision_plan_binding_id,decision_plan_binding_member_id),
  FOREIGN KEY(decision_plan_binding_id,plan_revision_id,requirement_revision_id,goal_id,
    contract_id,authority_root_id,decision_closure_id)
    REFERENCES decision_plan_bindings_v2(decision_plan_binding_id,plan_revision_id,
      requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,
    goal_id,contract_id,authority_root_id)
    REFERENCES decision_requirements_v2(decision_requirement_revision_id,decision_requirement_id,
      requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_resolution_id) REFERENCES decision_resolutions_v2(decision_resolution_id),
  UNIQUE(decision_plan_binding_id,decision_requirement_revision_id),
  UNIQUE(decision_plan_binding_id,ordinal),
  UNIQUE(decision_plan_binding_id,record_sha256),
  UNIQUE(decision_plan_binding_member_id,decision_plan_binding_id,plan_revision_id,goal_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE decision_plan_binding_targets_v2 (
  decision_plan_binding_member_id TEXT NOT NULL,
  decision_plan_binding_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind='WORK_CELL'),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(decision_plan_binding_id,decision_plan_binding_member_id,subject_id),
  FOREIGN KEY(decision_plan_binding_member_id,decision_plan_binding_id,plan_revision_id,goal_id)
    REFERENCES decision_plan_binding_members_v2(decision_plan_binding_member_id,
      decision_plan_binding_id,plan_revision_id,goal_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(decision_plan_binding_id,decision_plan_binding_member_id,ordinal)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER reject_late_decision_plan_binding_member_v2
BEFORE INSERT ON decision_plan_binding_members_v2
WHEN EXISTS (
  SELECT 1 FROM decision_plan_bindings_v2 b
  WHERE b.decision_plan_binding_id=NEW.decision_plan_binding_id
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding members cannot be appended after the root seal'); END;

CREATE TRIGGER reject_late_decision_plan_binding_target_v2
BEFORE INSERT ON decision_plan_binding_targets_v2
WHEN EXISTS (
  SELECT 1 FROM decision_plan_bindings_v2 b
  WHERE b.decision_plan_binding_id=NEW.decision_plan_binding_id
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding targets cannot be appended after the root seal'); END;

CREATE TRIGGER validate_decision_plan_binding_target_v2
BEFORE INSERT ON decision_plan_binding_targets_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_subjects_v2 p
  WHERE p.plan_revision_id=NEW.plan_revision_id AND p.goal_id=NEW.goal_id
    AND p.subject_kind='WORK_CELL' AND p.subject_id=NEW.subject_id
    AND p.revision_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding target is not the exact Plan WorkCell revision'); END;

CREATE TRIGGER validate_decision_plan_binding_member_v2
BEFORE INSERT ON decision_plan_binding_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_requirements_v2 d
  JOIN decision_closure_members_v2 c
    ON c.decision_requirement_revision_id=d.decision_requirement_revision_id
      AND c.decision_requirement_id=d.decision_requirement_id
  JOIN decision_resolutions_v2 r ON r.decision_resolution_id=NEW.decision_resolution_id
  JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.plan_revision_id
    AND p.subject_kind='DECISION' AND p.subject_id=NEW.decision_requirement_id
  WHERE d.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND d.requirement_revision_id=NEW.requirement_revision_id
    AND d.goal_id=NEW.goal_id AND d.contract_id=NEW.contract_id
    AND d.authority_root_id=NEW.authority_root_id
    AND d.record_sha256=NEW.decision_requirement_sha256
    AND p.revision_sha256=NEW.decision_requirement_sha256 AND p.goal_id=NEW.goal_id
    AND c.decision_closure_id=NEW.decision_closure_id
    AND c.state=NEW.decision_state AND c.decision_resolution_id=NEW.decision_resolution_id
    AND r.decision_requirement_revision_id=NEW.decision_requirement_revision_id
    AND r.requirement_revision_id=NEW.requirement_revision_id
    AND r.goal_id=NEW.goal_id AND r.contract_id=NEW.contract_id
    AND r.authority_root_id=NEW.authority_root_id
    AND r.record_sha256=NEW.decision_resolution_sha256
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding member is outside the exact Decision closure'); END;

CREATE TRIGGER validate_decision_plan_binding_authority_v2
BEFORE INSERT ON decision_plan_bindings_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  JOIN requirement_revisions_v2 r ON r.requirement_revision_id=p.requirement_revision_id
  JOIN decision_closures_v2 d ON d.decision_closure_id=NEW.decision_closure_id
  WHERE p.plan_revision_id=NEW.plan_revision_id AND p.record_sha256=NEW.plan_revision_sha256
    AND p.requirement_revision_id=NEW.requirement_revision_id
    AND p.requirement_revision_sha256=NEW.requirement_revision_sha256
    AND p.goal_id=NEW.goal_id AND p.contract_id=NEW.contract_id
    AND p.authority_root_id=NEW.authority_root_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND d.requirement_revision_id=NEW.requirement_revision_id
    AND d.goal_id=NEW.goal_id AND d.contract_id=NEW.contract_id
    AND d.authority_root_id=NEW.authority_root_id
    AND d.gate='MATERIAL_CHANGE' AND d.qualified=1
    AND d.record_sha256=NEW.decision_closure_sha256
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding authority closure mismatch'); END;

CREATE TRIGGER validate_decision_plan_binding_completeness_v2
BEFORE INSERT ON decision_plan_bindings_v2
WHEN (SELECT count(*) FROM decision_plan_binding_members_v2 m
        WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id)<>NEW.member_count
  OR EXISTS (
    SELECT 1 FROM decision_plan_binding_members_v2 m
    WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR (SELECT count(*) FROM plan_subjects_v2 p
        WHERE p.plan_revision_id=NEW.plan_revision_id AND p.subject_kind='DECISION')<>NEW.member_count
  OR (SELECT count(*) FROM decision_closure_members_v2 c
        WHERE c.decision_closure_id=NEW.decision_closure_id)<>NEW.member_count
  OR EXISTS (
    SELECT 1 FROM decision_closure_members_v2 c
    WHERE c.decision_closure_id=NEW.decision_closure_id
      AND NOT EXISTS (
        SELECT 1 FROM decision_plan_binding_members_v2 m
        WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
          AND m.decision_requirement_revision_id=c.decision_requirement_revision_id
          AND m.decision_requirement_id=c.decision_requirement_id
          AND m.decision_state=c.state
          AND m.decision_resolution_id IS c.decision_resolution_id
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.plan_revision_id AND p.subject_kind='DECISION'
      AND NOT EXISTS (
        SELECT 1 FROM decision_plan_binding_members_v2 m
        WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
          AND m.decision_requirement_id=p.subject_id
          AND m.decision_requirement_sha256=p.revision_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM decision_plan_binding_members_v2 m
    WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
      AND (m.plan_revision_id<>NEW.plan_revision_id
        OR m.requirement_revision_id<>NEW.requirement_revision_id
        OR m.goal_id<>NEW.goal_id OR m.contract_id<>NEW.contract_id
        OR m.authority_root_id<>NEW.authority_root_id
        OR m.decision_closure_id<>NEW.decision_closure_id
        OR (SELECT count(*) FROM decision_plan_binding_targets_v2 t
              WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
                AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id)<>m.target_count
        OR EXISTS (
          SELECT 1 FROM decision_plan_binding_targets_v2 t
          WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
            AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id
            AND t.created_event_sequence<>NEW.created_event_sequence
        )
        OR (m.decision_state<>'APPROVED' AND EXISTS (
          SELECT 1 FROM plan_dependency_edges_v2 e
          WHERE e.plan_revision_id=NEW.plan_revision_id AND e.source_kind='DECISION'
            AND e.source_id=m.decision_requirement_id AND e.dependency_kind='AUTHORIZES'
        )))
  )
  OR EXISTS (
    SELECT 1 FROM decision_plan_binding_members_v2 m
  JOIN decision_requirements_v2 d
    ON d.decision_requirement_revision_id=m.decision_requirement_revision_id
  WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
    AND json_array_length(d.affected_work_cell_ids_json)>0
    AND (json_array_length(d.affected_work_cell_ids_json)<>m.target_count OR EXISTS (
      SELECT 1 FROM json_each(d.affected_work_cell_ids_json) j
      WHERE j.type<>'text' OR NOT EXISTS (
          SELECT 1 FROM decision_plan_binding_targets_v2 t
          WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
            AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id
            AND t.subject_id=j.value
        )
      ) OR EXISTS (
        SELECT 1 FROM decision_plan_binding_targets_v2 t
        WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
          AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id
          AND NOT EXISTS (
            SELECT 1 FROM json_each(d.affected_work_cell_ids_json) j WHERE j.value=t.subject_id
          )
      ))
  )
BEGIN SELECT RAISE(ABORT,'Decision Plan binding member or target closure is incomplete'); END;

CREATE TRIGGER validate_decision_plan_binding_derived_targets_v2
BEFORE INSERT ON decision_plan_bindings_v2
WHEN EXISTS (
  SELECT 1 FROM decision_plan_binding_members_v2 m
  JOIN decision_requirements_v2 d
    ON d.decision_requirement_revision_id=m.decision_requirement_revision_id
  WHERE m.decision_plan_binding_id=NEW.decision_plan_binding_id
    AND json_array_length(d.affected_work_cell_ids_json)=0
    AND (EXISTS (
      SELECT 1 FROM decision_plan_binding_targets_v2 t
      WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
        AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id
        AND NOT EXISTS (
          WITH RECURSIVE reachable(subject_kind,subject_id) AS (
            SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
            WHERE e.plan_revision_id=NEW.plan_revision_id
              AND e.source_kind='DECISION' AND e.source_id=m.decision_requirement_id
            UNION
            SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
            JOIN reachable r ON r.subject_kind=e.source_kind AND r.subject_id=e.source_id
            WHERE e.plan_revision_id=NEW.plan_revision_id
          )
          SELECT 1 FROM reachable r
          WHERE r.subject_kind='WORK_CELL' AND r.subject_id=t.subject_id
        )
    ) OR EXISTS (
      WITH RECURSIVE reachable(subject_kind,subject_id) AS (
        SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
        WHERE e.plan_revision_id=NEW.plan_revision_id
          AND e.source_kind='DECISION' AND e.source_id=m.decision_requirement_id
        UNION
        SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
        JOIN reachable r ON r.subject_kind=e.source_kind AND r.subject_id=e.source_id
        WHERE e.plan_revision_id=NEW.plan_revision_id
      )
      SELECT 1 FROM reachable r
      WHERE r.subject_kind='WORK_CELL' AND NOT EXISTS (
        SELECT 1 FROM decision_plan_binding_targets_v2 t
        WHERE t.decision_plan_binding_id=m.decision_plan_binding_id
          AND t.decision_plan_binding_member_id=m.decision_plan_binding_member_id
          AND t.subject_id=r.subject_id
      )
    ))
)
BEGIN SELECT RAISE(ABORT,'Decision Plan binding derived WorkCell closure is incomplete'); END;

CREATE TABLE change_invalidation_closures_v2 (
  invalidation_closure_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  successor_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_sha256 TEXT NOT NULL CHECK(length(successor_plan_revision_sha256)=64),
  revision_delta_sha256 TEXT NOT NULL CHECK(length(revision_delta_sha256)=64),
  request_impact_root_sha256 TEXT NOT NULL CHECK(length(request_impact_root_sha256)=64),
  local_root_sha256 TEXT NOT NULL CHECK(length(local_root_sha256)=64),
  upstream_root_sha256 TEXT NOT NULL CHECK(length(upstream_root_sha256)=64),
  structural_root_sha256 TEXT NOT NULL CHECK(length(structural_root_sha256)=64),
  invalidation_root_sha256 TEXT NOT NULL CHECK(length(invalidation_root_sha256)=64),
  reuse_root_sha256 TEXT NOT NULL CHECK(length(reuse_root_sha256)=64),
  invalidation_count INTEGER NOT NULL CHECK(invalidation_count BETWEEN 1 AND 8192),
  reuse_count INTEGER NOT NULL CHECK(reuse_count BETWEEN 0 AND 8192),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(base_plan_revision_id<>successor_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(successor_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(goal_id,base_plan_revision_id),
  UNIQUE(goal_id,successor_plan_revision_id),
  UNIQUE(invalidation_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
) STRICT;

CREATE TABLE change_invalidation_members_v2 (
  invalidation_closure_id TEXT NOT NULL,
  invalidation_member_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  local INTEGER NOT NULL CHECK(local IN (0,1)),
  upstream INTEGER NOT NULL CHECK(upstream IN (0,1)),
  structural INTEGER NOT NULL CHECK(structural IN (0,1)),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(local=1 OR upstream=1 OR structural=1),
  PRIMARY KEY(invalidation_closure_id,invalidation_member_id),
  FOREIGN KEY(invalidation_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_invalidation_closures_v2(invalidation_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(invalidation_closure_id,subject_kind,subject_id),
  UNIQUE(invalidation_closure_id,ordinal),
  UNIQUE(invalidation_closure_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE change_reuse_members_v2 (
  invalidation_closure_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(invalidation_closure_id,subject_kind,subject_id),
  FOREIGN KEY(invalidation_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_invalidation_closures_v2(invalidation_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  FOREIGN KEY(successor_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(invalidation_closure_id,ordinal)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER reject_late_change_invalidation_member_v2
BEFORE INSERT ON change_invalidation_members_v2
WHEN EXISTS (
  SELECT 1 FROM change_invalidation_closures_v2 c
  WHERE c.invalidation_closure_id=NEW.invalidation_closure_id
)
BEGIN SELECT RAISE(ABORT,'Change invalidation members cannot be appended after the root seal'); END;

CREATE TRIGGER reject_late_change_reuse_member_v2
BEFORE INSERT ON change_reuse_members_v2
WHEN EXISTS (
  SELECT 1 FROM change_invalidation_closures_v2 c
  WHERE c.invalidation_closure_id=NEW.invalidation_closure_id
)
BEGIN SELECT RAISE(ABORT,'Change reuse members cannot be appended after the root seal'); END;

CREATE TRIGGER validate_change_reuse_member_v2
BEFORE INSERT ON change_reuse_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_subjects_v2 b JOIN plan_subjects_v2 s
    ON s.plan_revision_id=NEW.successor_plan_revision_id
      AND s.subject_kind=b.subject_kind AND s.subject_id=b.subject_id
      AND s.goal_id=b.goal_id AND s.revision_sha256=b.revision_sha256
  WHERE b.plan_revision_id=NEW.base_plan_revision_id AND b.goal_id=NEW.goal_id
    AND b.subject_kind=NEW.subject_kind AND b.subject_id=NEW.subject_id
    AND b.revision_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Change reuse member is not byte-identical in the successor Plan'); END;

CREATE TRIGGER validate_plan_change_impact_member_revision_for_acceptance_v2
BEFORE INSERT ON plan_change_impact_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_subjects_v2 p
  WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
    AND p.subject_kind=NEW.subject_kind AND p.subject_id=NEW.subject_id
    AND p.revision_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan change impact member is not the exact base Plan subject revision'); END;

CREATE TRIGGER validate_change_invalidation_closure_v2
BEFORE INSERT ON change_invalidation_closures_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 b JOIN plan_revisions_v2 s
    ON s.parent_plan_revision_id=b.plan_revision_id
  WHERE b.plan_revision_id=NEW.base_plan_revision_id
    AND b.record_sha256=NEW.base_plan_revision_sha256 AND b.goal_id=NEW.goal_id
    AND s.plan_revision_id=NEW.successor_plan_revision_id
    AND s.record_sha256=NEW.successor_plan_revision_sha256 AND s.goal_id=NEW.goal_id
    AND s.parent_plan_revision_sha256=NEW.base_plan_revision_sha256
) OR (SELECT count(*) FROM change_invalidation_members_v2 m
        WHERE m.invalidation_closure_id=NEW.invalidation_closure_id)<>NEW.invalidation_count
  OR (SELECT count(*) FROM change_reuse_members_v2 m
        WHERE m.invalidation_closure_id=NEW.invalidation_closure_id)<>NEW.reuse_count
  OR EXISTS (
    SELECT 1 FROM change_invalidation_members_v2 m
    WHERE m.invalidation_closure_id=NEW.invalidation_closure_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR EXISTS (
    SELECT 1 FROM change_reuse_members_v2 m
    WHERE m.invalidation_closure_id=NEW.invalidation_closure_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR EXISTS (
    SELECT 1 FROM active_goal_change_request_bindings_v2 b
    LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
    WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
      AND t.transition_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revisions_v2 p JOIN plan_change_impacts_v2 i
          ON i.plan_change_impact_id=b.plan_change_impact_id
        WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
          AND p.record_sha256=NEW.base_plan_revision_sha256
          AND b.base_plan_revision_sha256=p.record_sha256
          AND i.change_request_id=b.change_request_id
          AND i.goal_id=NEW.goal_id AND i.base_plan_revision_id=NEW.base_plan_revision_id
          AND i.base_plan_revision_sha256=p.record_sha256
          AND i.record_sha256=b.plan_change_impact_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM active_goal_change_request_bindings_v2 b
    JOIN plan_change_impact_members_v2 m ON m.plan_change_impact_id=b.plan_change_impact_id
    LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
    WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
      AND t.transition_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM plan_subjects_v2 p
        WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
          AND p.subject_kind=m.subject_kind AND p.subject_id=m.subject_id
          AND p.revision_sha256=m.revision_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM change_invalidation_members_v2 i
    JOIN change_reuse_members_v2 r
      ON r.invalidation_closure_id=i.invalidation_closure_id
        AND r.subject_kind=i.subject_kind AND r.subject_id=i.subject_id
    WHERE i.invalidation_closure_id=NEW.invalidation_closure_id
  )
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.base_plan_revision_id
      AND NOT EXISTS (
        SELECT 1 FROM change_invalidation_members_v2 i
        WHERE i.invalidation_closure_id=NEW.invalidation_closure_id
          AND i.subject_kind=p.subject_kind AND i.subject_id=p.subject_id
          AND i.revision_sha256=p.revision_sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM change_reuse_members_v2 r
        WHERE r.invalidation_closure_id=NEW.invalidation_closure_id
          AND r.subject_kind=p.subject_kind AND r.subject_id=p.subject_id
          AND r.revision_sha256=p.revision_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.base_plan_revision_id
      AND (CASE WHEN EXISTS (
        SELECT 1 FROM active_goal_change_request_bindings_v2 b
        JOIN plan_change_impact_members_v2 m ON m.plan_change_impact_id=b.plan_change_impact_id
        LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
        WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
          AND b.base_plan_revision_sha256=NEW.base_plan_revision_sha256
          AND t.transition_id IS NULL AND m.disposition IN ('CHANGED','INVALIDATED')
          AND m.subject_kind=p.subject_kind AND m.subject_id=p.subject_id
          AND m.revision_sha256=p.revision_sha256
      ) THEN 1 ELSE 0 END)<>(CASE WHEN EXISTS (
        SELECT 1 FROM change_invalidation_members_v2 m
        WHERE m.invalidation_closure_id=NEW.invalidation_closure_id AND m.local=1
          AND m.subject_kind=p.subject_kind AND m.subject_id=p.subject_id
          AND m.revision_sha256=p.revision_sha256
      ) THEN 1 ELSE 0 END)
  )
  OR EXISTS (
    WITH RECURSIVE upstream(subject_kind,subject_id) AS (
      SELECT p.subject_kind,p.subject_id FROM plan_subjects_v2 p
      WHERE p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind IN ('REQUIREMENT','DECISION')
        AND NOT EXISTS (
          SELECT 1 FROM plan_subjects_v2 s
          WHERE s.plan_revision_id=NEW.successor_plan_revision_id
            AND s.subject_kind=p.subject_kind AND s.subject_id=p.subject_id
            AND s.revision_sha256=p.revision_sha256
        )
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      JOIN upstream u ON u.subject_kind=e.source_kind AND u.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND e.dependency_kind<>'AUTHORIZES'
    )
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.base_plan_revision_id
      AND (CASE WHEN EXISTS (
        SELECT 1 FROM upstream u
        WHERE u.subject_kind=p.subject_kind AND u.subject_id=p.subject_id
      ) THEN 1 ELSE 0 END)<>(CASE WHEN EXISTS (
        SELECT 1 FROM change_invalidation_members_v2 m
        WHERE m.invalidation_closure_id=NEW.invalidation_closure_id AND m.upstream=1
          AND m.subject_kind=p.subject_kind AND m.subject_id=p.subject_id
          AND m.revision_sha256=p.revision_sha256
      ) THEN 1 ELSE 0 END)
  )
  OR EXISTS (
    WITH RECURSIVE structural_seed(subject_kind,subject_id) AS (
      SELECT e.source_kind,e.source_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id
          AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id
          AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.source_kind AND p.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b
        WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id
          AND b.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.target_kind AND p.subject_id=e.target_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b
        WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id
          AND b.dependency_kind=e.dependency_kind
      )
    ), structural(subject_kind,subject_id) AS (
      SELECT subject_kind,subject_id FROM structural_seed
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      JOIN structural s ON s.subject_kind=e.source_kind AND s.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND e.dependency_kind<>'AUTHORIZES'
    )
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.base_plan_revision_id
      AND (CASE WHEN EXISTS (
        SELECT 1 FROM structural s
        WHERE s.subject_kind=p.subject_kind AND s.subject_id=p.subject_id
      ) THEN 1 ELSE 0 END)<>(CASE WHEN EXISTS (
        SELECT 1 FROM change_invalidation_members_v2 m
        WHERE m.invalidation_closure_id=NEW.invalidation_closure_id AND m.structural=1
          AND m.subject_kind=p.subject_kind AND m.subject_id=p.subject_id
          AND m.revision_sha256=p.revision_sha256
      ) THEN 1 ELSE 0 END)
  )
  OR EXISTS (
    WITH RECURSIVE structural_seed(subject_kind,subject_id) AS (
      SELECT e.source_kind,e.source_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.source_kind AND p.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id AND b.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.target_kind AND p.subject_id=e.target_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id AND b.dependency_kind=e.dependency_kind
      )
    ), delta(subject_kind,subject_id) AS (
      SELECT p.subject_kind,p.subject_id FROM plan_subjects_v2 p
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_subjects_v2 s
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.subject_kind=p.subject_kind AND s.subject_id=p.subject_id
          AND s.revision_sha256=p.revision_sha256
      )
      UNION
      SELECT subject_kind,subject_id FROM structural_seed
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      JOIN delta d ON d.subject_kind=e.source_kind AND d.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND e.dependency_kind<>'AUTHORIZES'
    )
    SELECT 1 FROM delta d WHERE NOT EXISTS (
      SELECT 1 FROM active_goal_change_request_bindings_v2 b
      JOIN plan_change_impact_members_v2 m ON m.plan_change_impact_id=b.plan_change_impact_id
      LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
      WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
        AND b.base_plan_revision_sha256=NEW.base_plan_revision_sha256
        AND t.transition_id IS NULL AND m.disposition IN ('CHANGED','INVALIDATED')
        AND m.subject_kind=d.subject_kind AND m.subject_id=d.subject_id
    )
  )
  OR EXISTS (
    WITH RECURSIVE structural_seed(subject_kind,subject_id) AS (
      SELECT e.source_kind,e.source_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 s WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.source_kind=e.source_kind AND s.source_id=e.source_id
          AND s.target_kind=e.target_kind AND s.target_id=e.target_id AND s.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.source_kind AND p.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id AND b.dependency_kind=e.dependency_kind
      )
      UNION
      SELECT p.subject_kind,p.subject_id FROM plan_dependency_edges_v2 e
      JOIN plan_subjects_v2 p ON p.plan_revision_id=NEW.base_plan_revision_id
        AND p.subject_kind=e.target_kind AND p.subject_id=e.target_id
      WHERE e.plan_revision_id=NEW.successor_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_dependency_edges_v2 b WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND b.source_kind=e.source_kind AND b.source_id=e.source_id
          AND b.target_kind=e.target_kind AND b.target_id=e.target_id AND b.dependency_kind=e.dependency_kind
      )
    ), delta(subject_kind,subject_id) AS (
      SELECT p.subject_kind,p.subject_id FROM plan_subjects_v2 p
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND NOT EXISTS (
        SELECT 1 FROM plan_subjects_v2 s
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND s.subject_kind=p.subject_kind AND s.subject_id=p.subject_id
          AND s.revision_sha256=p.revision_sha256
      )
      UNION
      SELECT subject_kind,subject_id FROM structural_seed
      UNION
      SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
      JOIN delta d ON d.subject_kind=e.source_kind AND d.subject_id=e.source_id
      WHERE e.plan_revision_id=NEW.base_plan_revision_id AND e.dependency_kind<>'AUTHORIZES'
    ), pending(binding_id,plan_change_impact_id) AS (
      SELECT request.binding_id,request.plan_change_impact_id
      FROM active_goal_change_request_bindings_v2 request
      LEFT JOIN active_goal_change_transitions_v2 transition ON transition.binding_id=request.binding_id
      WHERE request.goal_id=NEW.goal_id AND request.base_plan_revision_id=NEW.base_plan_revision_id
        AND transition.transition_id IS NULL
    )
    SELECT 1 FROM pending request
    LEFT JOIN plan_change_impact_members_v2 m
      ON m.plan_change_impact_id=request.plan_change_impact_id
        AND m.disposition IN ('CHANGED','INVALIDATED')
    LEFT JOIN delta d ON d.subject_kind=m.subject_kind AND d.subject_id=m.subject_id
    GROUP BY request.binding_id HAVING count(d.subject_id)=0
  )
BEGIN SELECT RAISE(ABORT,'Change invalidation closure is not the complete direct Plan delta'); END;

CREATE TABLE change_acceptance_closures_v2 (
  change_acceptance_closure_id TEXT PRIMARY KEY,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  successor_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_sha256 TEXT NOT NULL CHECK(length(successor_plan_revision_sha256)=64),
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  decision_plan_binding_id TEXT NOT NULL,
  decision_plan_binding_root_sha256 TEXT NOT NULL CHECK(length(decision_plan_binding_root_sha256)=64),
  request_root_sha256 TEXT NOT NULL CHECK(length(request_root_sha256)=64),
  request_count INTEGER NOT NULL CHECK(request_count BETWEEN 1 AND 1024),
  semantic_delta_root_sha256 TEXT NOT NULL CHECK(length(semantic_delta_root_sha256)=64),
  semantic_delta_count INTEGER NOT NULL CHECK(semantic_delta_count BETWEEN 1 AND 8192),
  invalidation_closure_id TEXT NOT NULL UNIQUE,
  invalidation_closure_sha256 TEXT NOT NULL CHECK(length(invalidation_closure_sha256)=64),
  invalidation_root_sha256 TEXT NOT NULL CHECK(length(invalidation_root_sha256)=64),
  invalidation_count INTEGER NOT NULL CHECK(invalidation_count BETWEEN 1 AND 8192),
  reuse_root_sha256 TEXT NOT NULL CHECK(length(reuse_root_sha256)=64),
  reuse_count INTEGER NOT NULL CHECK(reuse_count BETWEEN 0 AND 8192),
  oracle_evidence_root_sha256 TEXT NOT NULL CHECK(length(oracle_evidence_root_sha256)=64),
  oracle_count INTEGER NOT NULL CHECK(oracle_count BETWEEN 1 AND 8192),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(base_plan_revision_id<>successor_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(successor_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_plan_binding_id,successor_plan_revision_id,requirement_revision_id,
    goal_id,contract_id,authority_root_id,decision_closure_id)
    REFERENCES decision_plan_bindings_v2(decision_plan_binding_id,plan_revision_id,
      requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id),
  FOREIGN KEY(invalidation_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_invalidation_closures_v2(invalidation_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(goal_id,base_plan_revision_id),
  UNIQUE(goal_id,successor_plan_revision_id),
  UNIQUE(change_acceptance_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
) STRICT;

CREATE TABLE change_acceptance_request_members_v2 (
  change_acceptance_closure_id TEXT NOT NULL,
  request_member_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  change_request_id TEXT NOT NULL,
  change_request_sha256 TEXT NOT NULL CHECK(length(change_request_sha256)=64),
  plan_change_impact_id TEXT NOT NULL,
  impact_sha256 TEXT NOT NULL CHECK(length(impact_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 1023),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(change_acceptance_closure_id,request_member_id),
  FOREIGN KEY(change_acceptance_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_acceptance_closures_v2(change_acceptance_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(binding_id) REFERENCES active_goal_change_request_bindings_v2(binding_id),
  FOREIGN KEY(change_request_id) REFERENCES change_requests_v2(change_request_id),
  FOREIGN KEY(plan_change_impact_id) REFERENCES plan_change_impacts_v2(plan_change_impact_id),
  UNIQUE(change_acceptance_closure_id,binding_id),
  UNIQUE(change_acceptance_closure_id,change_request_id),
  UNIQUE(change_acceptance_closure_id,plan_change_impact_id),
  UNIQUE(change_acceptance_closure_id,ordinal),
  UNIQUE(change_acceptance_closure_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE change_acceptance_semantic_deltas_v2 (
  change_acceptance_closure_id TEXT NOT NULL,
  semantic_delta_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('ACCEPTANCE_FACET','REQUIREMENT')),
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 512),
  change_kind TEXT NOT NULL CHECK(change_kind IN ('ADD','MODIFY','REMOVE')),
  previous_entity_id TEXT,
  previous_entity_sha256 TEXT CHECK(previous_entity_sha256 IS NULL OR length(previous_entity_sha256)=64),
  successor_entity_id TEXT,
  successor_entity_sha256 TEXT CHECK(successor_entity_sha256 IS NULL OR length(successor_entity_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((change_kind='ADD' AND previous_entity_id IS NULL AND previous_entity_sha256 IS NULL
      AND successor_entity_id IS NOT NULL AND successor_entity_sha256 IS NOT NULL)
    OR (change_kind='REMOVE' AND previous_entity_id IS NOT NULL AND previous_entity_sha256 IS NOT NULL
      AND successor_entity_id IS NULL AND successor_entity_sha256 IS NULL)
    OR (change_kind='MODIFY' AND previous_entity_id IS NOT NULL AND previous_entity_sha256 IS NOT NULL
      AND successor_entity_id IS NOT NULL AND successor_entity_sha256 IS NOT NULL
      AND (previous_entity_id<>successor_entity_id OR previous_entity_sha256<>successor_entity_sha256))),
  PRIMARY KEY(change_acceptance_closure_id,semantic_delta_id),
  FOREIGN KEY(change_acceptance_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_acceptance_closures_v2(change_acceptance_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(change_acceptance_closure_id,entity_kind,semantic_key),
  UNIQUE(change_acceptance_closure_id,ordinal),
  UNIQUE(change_acceptance_closure_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TABLE change_acceptance_oracle_bindings_v2 (
  change_acceptance_closure_id TEXT NOT NULL,
  oracle_binding_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind='WORK_CELL'),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(change_acceptance_closure_id,oracle_binding_id),
  FOREIGN KEY(change_acceptance_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id)
    REFERENCES change_acceptance_closures_v2(change_acceptance_closure_id,goal_id,
      base_plan_revision_id,successor_plan_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(successor_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(change_acceptance_closure_id,subject_id),
  UNIQUE(change_acceptance_closure_id,ordinal),
  UNIQUE(change_acceptance_closure_id,record_sha256)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER reject_late_change_acceptance_request_member_v2
BEFORE INSERT ON change_acceptance_request_members_v2
WHEN EXISTS (
  SELECT 1 FROM change_acceptance_closures_v2 c
  WHERE c.change_acceptance_closure_id=NEW.change_acceptance_closure_id
)
BEGIN SELECT RAISE(ABORT,'Change acceptance requests cannot be appended after the root seal'); END;

CREATE TRIGGER reject_late_change_acceptance_semantic_delta_v2
BEFORE INSERT ON change_acceptance_semantic_deltas_v2
WHEN EXISTS (
  SELECT 1 FROM change_acceptance_closures_v2 c
  WHERE c.change_acceptance_closure_id=NEW.change_acceptance_closure_id
)
BEGIN SELECT RAISE(ABORT,'Change acceptance semantic deltas cannot be appended after the root seal'); END;

CREATE TRIGGER reject_late_change_acceptance_oracle_binding_v2
BEFORE INSERT ON change_acceptance_oracle_bindings_v2
WHEN EXISTS (
  SELECT 1 FROM change_acceptance_closures_v2 c
  WHERE c.change_acceptance_closure_id=NEW.change_acceptance_closure_id
)
BEGIN SELECT RAISE(ABORT,'Change acceptance oracle bindings cannot be appended after the root seal'); END;

CREATE TRIGGER validate_change_acceptance_request_member_v2
BEFORE INSERT ON change_acceptance_request_members_v2
WHEN NOT EXISTS (
  SELECT 1 FROM active_goal_change_request_bindings_v2 b
  JOIN active_goal_user_turn_classifications_v2 c ON c.classification_id=b.classification_id
  JOIN active_goal_user_turns_v2 u ON u.user_turn_id=b.user_turn_id
  JOIN change_requests_v2 r ON r.change_request_id=b.change_request_id
  JOIN plan_change_impacts_v2 i ON i.plan_change_impact_id=b.plan_change_impact_id
  JOIN plan_revisions_v2 p ON p.plan_revision_id=b.base_plan_revision_id
  WHERE b.binding_id=NEW.binding_id AND b.record_sha256=NEW.binding_sha256
    AND b.change_request_id=NEW.change_request_id
    AND b.change_request_sha256=NEW.change_request_sha256
    AND b.plan_change_impact_id=NEW.plan_change_impact_id
    AND b.plan_change_impact_sha256=NEW.impact_sha256
    AND b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
    AND b.base_plan_revision_sha256=p.record_sha256
    AND p.goal_id=NEW.goal_id
    AND c.record_sha256=b.classification_sha256
    AND c.user_turn_id=b.user_turn_id AND c.user_turn_sha256=b.user_turn_sha256
    AND c.goal_id=NEW.goal_id AND c.base_plan_revision_id=NEW.base_plan_revision_id
    AND c.base_plan_revision_sha256=p.record_sha256
    AND c.classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
    AND u.record_sha256=b.user_turn_sha256 AND u.content_sha256=b.raw_content_sha256
    AND u.goal_id=NEW.goal_id AND u.plan_revision_id=NEW.base_plan_revision_id
    AND u.plan_revision_sha256=p.record_sha256
    AND r.record_sha256=NEW.change_request_sha256 AND i.record_sha256=NEW.impact_sha256
    AND r.goal_id=NEW.goal_id AND r.base_plan_revision_id=NEW.base_plan_revision_id
    AND r.base_plan_revision_sha256=p.record_sha256
    AND i.goal_id=NEW.goal_id AND i.base_plan_revision_id=NEW.base_plan_revision_id
    AND i.base_plan_revision_sha256=p.record_sha256
    AND NOT EXISTS (
      SELECT 1 FROM active_goal_change_transitions_v2 t WHERE t.binding_id=b.binding_id
    )
)
BEGIN SELECT RAISE(ABORT,'Change acceptance request member is not an exact pending material turn'); END;

CREATE TRIGGER validate_change_acceptance_semantic_delta_v2
BEFORE INSERT ON change_acceptance_semantic_deltas_v2
WHEN (NEW.entity_kind='REQUIREMENT' AND (
    (NEW.previous_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM plan_subjects_v2 p
      JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
      JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
        AND p.subject_kind='REQUIREMENT' AND p.subject_id=NEW.previous_entity_id
        AND p.revision_sha256=NEW.previous_entity_sha256
        AND i.requirement_id=p.subject_id AND i.semantic_key=NEW.semantic_key
        AND i.record_sha256=p.revision_sha256
    )) OR (NEW.successor_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM plan_subjects_v2 p
      JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
      JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.goal_id=NEW.goal_id
        AND p.subject_kind='REQUIREMENT' AND p.subject_id=NEW.successor_entity_id
        AND p.revision_sha256=NEW.successor_entity_sha256
        AND i.requirement_id=p.subject_id AND i.semantic_key=NEW.semantic_key
        AND i.record_sha256=p.revision_sha256
    )) OR (NEW.change_kind='ADD' AND EXISTS (
      SELECT 1 FROM plan_subjects_v2 p
      JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
      JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
        AND p.subject_kind='REQUIREMENT' AND i.requirement_id=p.subject_id
        AND i.semantic_key=NEW.semantic_key AND i.record_sha256=p.revision_sha256
    )) OR (NEW.change_kind='REMOVE' AND EXISTS (
      SELECT 1 FROM plan_subjects_v2 p
      JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
      JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.goal_id=NEW.goal_id
        AND p.subject_kind='REQUIREMENT' AND i.requirement_id=p.subject_id
        AND i.semantic_key=NEW.semantic_key AND i.record_sha256=p.revision_sha256
    ))
  )) OR (NEW.entity_kind='ACCEPTANCE_FACET' AND (
    (NEW.previous_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM plan_revisions_v2 p
      JOIN acceptance_facets_v2 f ON f.contract_id=p.contract_id
      JOIN acceptance_authority_facet_members_v2 m
        ON m.authority_root_id=p.authority_root_id AND m.facet_id=f.facet_id
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
        AND f.facet_id=NEW.previous_entity_id AND f.semantic_key=NEW.semantic_key
        AND f.record_sha256=NEW.previous_entity_sha256
    )) OR (NEW.successor_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM plan_revisions_v2 p
      JOIN acceptance_facets_v2 f ON f.contract_id=p.contract_id
      JOIN acceptance_authority_facet_members_v2 m
        ON m.authority_root_id=p.authority_root_id AND m.facet_id=f.facet_id
      WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.goal_id=NEW.goal_id
        AND f.facet_id=NEW.successor_entity_id AND f.semantic_key=NEW.semantic_key
        AND f.record_sha256=NEW.successor_entity_sha256
    )) OR (NEW.change_kind='ADD' AND EXISTS (
      SELECT 1 FROM plan_revisions_v2 p
      JOIN acceptance_authority_facet_members_v2 m ON m.authority_root_id=p.authority_root_id
      JOIN acceptance_facets_v2 f ON f.facet_id=m.facet_id
      WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
        AND m.goal_id=p.goal_id AND m.contract_id=p.contract_id
        AND f.semantic_key=NEW.semantic_key
    )) OR (NEW.change_kind='REMOVE' AND EXISTS (
      SELECT 1 FROM plan_revisions_v2 p
      JOIN acceptance_authority_facet_members_v2 m ON m.authority_root_id=p.authority_root_id
      JOIN acceptance_facets_v2 f ON f.facet_id=m.facet_id
      WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.goal_id=NEW.goal_id
        AND m.goal_id=p.goal_id AND m.contract_id=p.contract_id
        AND f.semantic_key=NEW.semantic_key
    ))
  ))
BEGIN SELECT RAISE(ABORT,'Change acceptance semantic delta is outside the base/successor authority'); END;

CREATE TRIGGER validate_change_acceptance_authority_v2
BEFORE INSERT ON change_acceptance_closures_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 b
  JOIN plan_revisions_v2 s ON s.parent_plan_revision_id=b.plan_revision_id
  JOIN requirement_revisions_v2 r ON r.requirement_revision_id=s.requirement_revision_id
  JOIN decision_closures_v2 d ON d.decision_closure_id=NEW.decision_closure_id
  JOIN decision_plan_bindings_v2 p ON p.decision_plan_binding_id=NEW.decision_plan_binding_id
  JOIN change_invalidation_closures_v2 i ON i.invalidation_closure_id=NEW.invalidation_closure_id
  JOIN plan_heads_v2 h ON h.goal_id=NEW.goal_id
  WHERE b.plan_revision_id=NEW.base_plan_revision_id
    AND b.record_sha256=NEW.base_plan_revision_sha256
    AND s.plan_revision_id=NEW.successor_plan_revision_id
    AND s.record_sha256=NEW.successor_plan_revision_sha256
    AND s.parent_plan_revision_sha256=NEW.base_plan_revision_sha256
    AND s.requirement_revision_id=NEW.requirement_revision_id
    AND s.requirement_revision_sha256=NEW.requirement_revision_sha256
    AND s.goal_id=NEW.goal_id AND s.contract_id=NEW.contract_id
    AND s.authority_root_id=NEW.authority_root_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND d.requirement_revision_id=NEW.requirement_revision_id
    AND d.goal_id=NEW.goal_id AND d.contract_id=NEW.contract_id
    AND d.authority_root_id=NEW.authority_root_id
    AND d.gate='MATERIAL_CHANGE' AND d.qualified=1
    AND d.record_sha256=NEW.decision_closure_sha256
    AND p.plan_revision_id=NEW.successor_plan_revision_id
    AND p.plan_revision_sha256=NEW.successor_plan_revision_sha256
    AND p.decision_closure_id=NEW.decision_closure_id
    AND p.record_sha256=NEW.decision_plan_binding_root_sha256
    AND i.goal_id=NEW.goal_id AND i.base_plan_revision_id=NEW.base_plan_revision_id
    AND i.base_plan_revision_sha256=NEW.base_plan_revision_sha256
    AND i.successor_plan_revision_id=NEW.successor_plan_revision_id
    AND i.successor_plan_revision_sha256=NEW.successor_plan_revision_sha256
    AND i.record_sha256=NEW.invalidation_closure_sha256
    AND i.invalidation_root_sha256=NEW.invalidation_root_sha256
    AND i.reuse_root_sha256=NEW.reuse_root_sha256
    AND i.invalidation_count=NEW.invalidation_count AND i.reuse_count=NEW.reuse_count
    AND i.created_event_sequence=NEW.created_event_sequence
    AND h.plan_revision_id=NEW.successor_plan_revision_id
    AND h.plan_revision_sha256=NEW.successor_plan_revision_sha256
) OR NOT EXISTS (
  SELECT 1 FROM events e WHERE e.goal_id=NEW.goal_id
    AND e.sequence=NEW.created_event_sequence-1 AND e.event_sha256=NEW.event_head_sha256
    AND e.sequence=(SELECT max(h.sequence) FROM events h WHERE h.goal_id=NEW.goal_id)
)
BEGIN SELECT RAISE(ABORT,'Change acceptance direct-parent authority or event-head CAS mismatch'); END;

CREATE TRIGGER validate_change_acceptance_completeness_v2
BEFORE INSERT ON change_acceptance_closures_v2
WHEN (SELECT count(*) FROM change_acceptance_request_members_v2 m
        WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id)<>NEW.request_count
  OR (SELECT count(*) FROM change_acceptance_semantic_deltas_v2 m
        WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id)<>NEW.semantic_delta_count
  OR (SELECT count(*) FROM change_acceptance_oracle_bindings_v2 m
        WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id)<>NEW.oracle_count
  OR EXISTS (
    SELECT 1 FROM change_acceptance_request_members_v2 m
    WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR EXISTS (
    SELECT 1 FROM change_acceptance_semantic_deltas_v2 m
    WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR EXISTS (
    SELECT 1 FROM change_acceptance_oracle_bindings_v2 m
    WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id
      AND m.created_event_sequence<>NEW.created_event_sequence
  )
  OR (SELECT count(*) FROM plan_subjects_v2 p
        WHERE p.plan_revision_id=NEW.successor_plan_revision_id
          AND p.subject_kind='WORK_CELL')<>NEW.oracle_count
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.subject_kind='WORK_CELL'
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_oracle_bindings_v2 o
        WHERE o.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND o.subject_id=p.subject_id AND o.revision_sha256=p.revision_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM active_goal_change_request_bindings_v2 b
    LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
    WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
      AND t.transition_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_request_members_v2 m
        WHERE m.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND m.binding_id=b.binding_id AND m.binding_sha256=b.record_sha256
      )
  )
  OR (SELECT count(*) FROM active_goal_change_request_bindings_v2 b
      LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
      WHERE b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
        AND t.transition_id IS NULL)<>NEW.request_count
  OR EXISTS (
    SELECT 1 FROM active_goal_user_turns_v2 u
    LEFT JOIN active_goal_user_turn_classifications_v2 c ON c.user_turn_id=u.user_turn_id
    WHERE u.goal_id=NEW.goal_id AND u.plan_revision_id=NEW.base_plan_revision_id
      AND (u.plan_revision_sha256 IS NOT NEW.base_plan_revision_sha256
        OR c.classification_id IS NULL
        OR c.user_turn_sha256 IS NOT u.record_sha256
        OR c.goal_id IS NOT NEW.goal_id
        OR c.base_plan_revision_id IS NOT NEW.base_plan_revision_id
        OR c.base_plan_revision_sha256 IS NOT NEW.base_plan_revision_sha256)
  )
  OR EXISTS (
    SELECT 1 FROM active_goal_user_turns_v2 u
    JOIN active_goal_user_turn_classifications_v2 c ON c.user_turn_id=u.user_turn_id
    WHERE u.goal_id=NEW.goal_id AND u.plan_revision_id=NEW.base_plan_revision_id
      AND c.classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
      AND NOT EXISTS (
        SELECT 1 FROM active_goal_change_request_bindings_v2 b
        WHERE b.classification_id=c.classification_id
          AND b.classification_sha256=c.record_sha256
          AND b.user_turn_id=u.user_turn_id AND b.user_turn_sha256=u.record_sha256
          AND b.raw_content_sha256=u.content_sha256
          AND b.goal_id=NEW.goal_id AND b.base_plan_revision_id=NEW.base_plan_revision_id
          AND b.base_plan_revision_sha256=NEW.base_plan_revision_sha256
      )
  )
  OR EXISTS (
    SELECT 1 FROM change_acceptance_semantic_deltas_v2 d
    WHERE d.change_acceptance_closure_id=NEW.change_acceptance_closure_id
      AND d.entity_kind='REQUIREMENT' AND d.successor_entity_id IS NOT NULL
      AND NOT EXISTS (
        WITH RECURSIVE reachable(subject_kind,subject_id) AS (
          SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
          WHERE e.plan_revision_id=NEW.successor_plan_revision_id
            AND e.source_kind='REQUIREMENT' AND e.source_id=d.successor_entity_id
          UNION
          SELECT e.target_kind,e.target_id FROM plan_dependency_edges_v2 e
          JOIN reachable r ON r.subject_kind=e.source_kind AND r.subject_id=e.source_id
          WHERE e.plan_revision_id=NEW.successor_plan_revision_id
        )
        SELECT 1 FROM reachable WHERE subject_kind='WORK_CELL'
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
    JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      AND i.requirement_id=p.subject_id AND i.record_sha256=p.revision_sha256
    WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.subject_kind='REQUIREMENT'
      AND NOT EXISTS (
        SELECT 1 FROM plan_subjects_v2 s
        JOIN plan_revisions_v2 sr ON sr.plan_revision_id=s.plan_revision_id
        JOIN requirement_items_v2 si ON si.requirement_revision_id=sr.requirement_revision_id
          AND si.requirement_id=s.subject_id AND si.record_sha256=s.revision_sha256
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id AND s.subject_kind='REQUIREMENT'
          AND si.semantic_key=i.semantic_key AND si.requirement_id=i.requirement_id
          AND si.record_sha256=i.record_sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_semantic_deltas_v2 d
        WHERE d.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND d.entity_kind='REQUIREMENT' AND d.semantic_key=i.semantic_key
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_subjects_v2 p
    JOIN plan_revisions_v2 r ON r.plan_revision_id=p.plan_revision_id
    JOIN requirement_items_v2 i ON i.requirement_revision_id=r.requirement_revision_id
      AND i.requirement_id=p.subject_id AND i.record_sha256=p.revision_sha256
    WHERE p.plan_revision_id=NEW.successor_plan_revision_id AND p.subject_kind='REQUIREMENT'
      AND NOT EXISTS (
        SELECT 1 FROM plan_subjects_v2 b
        JOIN plan_revisions_v2 br ON br.plan_revision_id=b.plan_revision_id
        JOIN requirement_items_v2 bi ON bi.requirement_revision_id=br.requirement_revision_id
          AND bi.requirement_id=b.subject_id AND bi.record_sha256=b.revision_sha256
        WHERE b.plan_revision_id=NEW.base_plan_revision_id AND b.subject_kind='REQUIREMENT'
          AND bi.semantic_key=i.semantic_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_semantic_deltas_v2 d
        WHERE d.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND d.entity_kind='REQUIREMENT' AND d.semantic_key=i.semantic_key
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_revisions_v2 p
    JOIN acceptance_authority_facet_members_v2 m ON m.authority_root_id=p.authority_root_id
    JOIN acceptance_facets_v2 f ON f.facet_id=m.facet_id
    WHERE p.plan_revision_id=NEW.base_plan_revision_id
      AND m.goal_id=p.goal_id AND m.contract_id=p.contract_id
      AND NOT EXISTS (
        SELECT 1 FROM plan_revisions_v2 s
        JOIN acceptance_authority_facet_members_v2 sm ON sm.authority_root_id=s.authority_root_id
        JOIN acceptance_facets_v2 sf ON sf.facet_id=sm.facet_id
        WHERE s.plan_revision_id=NEW.successor_plan_revision_id
          AND sm.goal_id=s.goal_id AND sm.contract_id=s.contract_id
          AND sf.semantic_key=f.semantic_key AND sf.facet_id=f.facet_id
          AND sf.record_sha256=f.record_sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_semantic_deltas_v2 d
        WHERE d.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND d.entity_kind='ACCEPTANCE_FACET' AND d.semantic_key=f.semantic_key
      )
  )
  OR EXISTS (
    SELECT 1 FROM plan_revisions_v2 p
    JOIN acceptance_authority_facet_members_v2 m ON m.authority_root_id=p.authority_root_id
    JOIN acceptance_facets_v2 f ON f.facet_id=m.facet_id
    WHERE p.plan_revision_id=NEW.successor_plan_revision_id
      AND m.goal_id=p.goal_id AND m.contract_id=p.contract_id
      AND NOT EXISTS (
        SELECT 1 FROM plan_revisions_v2 b
        JOIN acceptance_authority_facet_members_v2 bm ON bm.authority_root_id=b.authority_root_id
        JOIN acceptance_facets_v2 bf ON bf.facet_id=bm.facet_id
        WHERE b.plan_revision_id=NEW.base_plan_revision_id
          AND bm.goal_id=b.goal_id AND bm.contract_id=b.contract_id
          AND bf.semantic_key=f.semantic_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM change_acceptance_semantic_deltas_v2 d
        WHERE d.change_acceptance_closure_id=NEW.change_acceptance_closure_id
          AND d.entity_kind='ACCEPTANCE_FACET' AND d.semantic_key=f.semantic_key
      )
  )
BEGIN SELECT RAISE(ABORT,'Change acceptance members do not close all pending material authority'); END;

CREATE TRIGGER reject_late_active_goal_change_binding_v2
BEFORE INSERT ON active_goal_change_request_bindings_v2
WHEN EXISTS (
  SELECT 1 FROM change_acceptance_closures_v2 c
  WHERE c.goal_id=NEW.goal_id AND c.base_plan_revision_id=NEW.base_plan_revision_id
)
BEGIN SELECT RAISE(ABORT,'A sealed base Plan cannot accept another material turn'); END;

CREATE TRIGGER validate_active_goal_change_binding_base_v2
BEFORE INSERT ON active_goal_change_request_bindings_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  JOIN active_goal_user_turn_classifications_v2 c
    ON c.classification_id=NEW.classification_id
  JOIN active_goal_user_turns_v2 u ON u.user_turn_id=NEW.user_turn_id
  JOIN change_requests_v2 r ON r.change_request_id=NEW.change_request_id
  JOIN plan_change_impacts_v2 i ON i.plan_change_impact_id=NEW.plan_change_impact_id
  WHERE p.plan_revision_id=NEW.base_plan_revision_id AND p.goal_id=NEW.goal_id
    AND p.record_sha256=NEW.base_plan_revision_sha256
    AND c.record_sha256=NEW.classification_sha256
    AND c.user_turn_id=NEW.user_turn_id AND c.user_turn_sha256=NEW.user_turn_sha256
    AND c.goal_id=NEW.goal_id AND c.base_plan_revision_id=NEW.base_plan_revision_id
    AND c.base_plan_revision_sha256=NEW.base_plan_revision_sha256
    AND c.classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
    AND u.record_sha256=NEW.user_turn_sha256 AND u.content_sha256=NEW.raw_content_sha256
    AND u.goal_id=NEW.goal_id AND u.plan_revision_id=NEW.base_plan_revision_id
    AND u.plan_revision_sha256=NEW.base_plan_revision_sha256
    AND r.record_sha256=NEW.change_request_sha256
    AND r.goal_id=NEW.goal_id AND r.base_plan_revision_id=NEW.base_plan_revision_id
    AND r.base_plan_revision_sha256=NEW.base_plan_revision_sha256
    AND i.change_request_id=NEW.change_request_id
    AND i.record_sha256=NEW.plan_change_impact_sha256
    AND i.goal_id=NEW.goal_id AND i.base_plan_revision_id=NEW.base_plan_revision_id
    AND i.base_plan_revision_sha256=NEW.base_plan_revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Active Goal ChangeRequest binding is outside the exact captured Plan authority'); END;

CREATE TRIGGER require_change_acceptance_transition_v2
BEFORE INSERT ON active_goal_change_transitions_v2
WHEN NOT EXISTS (
  SELECT 1 FROM change_acceptance_closures_v2 c
  JOIN change_acceptance_request_members_v2 m
    ON m.change_acceptance_closure_id=c.change_acceptance_closure_id
  JOIN stage_gate_receipts_v2 g
    ON g.stage_gate_receipt_id=NEW.successor_stage_gate_receipt_id
  WHERE c.goal_id=NEW.goal_id AND c.base_plan_revision_id=NEW.base_plan_revision_id
    AND c.base_plan_revision_sha256=NEW.base_plan_revision_sha256
    AND c.successor_plan_revision_id=NEW.successor_plan_revision_id
    AND c.successor_plan_revision_sha256=NEW.successor_plan_revision_sha256
    AND m.binding_id=NEW.binding_id AND m.binding_sha256=NEW.binding_sha256
    AND m.change_request_id=NEW.change_request_id
    AND g.goal_id=NEW.goal_id AND g.plan_revision_id=NEW.successor_plan_revision_id
    AND g.plan_revision_sha256=NEW.successor_plan_revision_sha256
    AND g.gate='MATERIAL_CHANGE' AND g.record_sha256=NEW.successor_stage_gate_sha256
)
BEGIN SELECT RAISE(ABORT,'Active Goal transition lacks its sealed Change Acceptance member'); END;

-- Schema 025 reserved the hashes needed by MATERIAL_CHANGE but rejected the
-- gate until ChangeAcceptanceClosureV2 existed. Replace only the validators;
-- the surrounding migration transaction makes this rollback-safe.
DROP TRIGGER validate_goal_fit_gate_instance_v2;
CREATE TRIGGER validate_goal_fit_gate_instance_v2
BEFORE INSERT ON goal_fit_gate_instances_v2
WHEN NOT EXISTS (
  SELECT 1 FROM requirement_revisions_v2 r JOIN decision_closures_v2 d
    ON d.requirement_revision_id=r.requirement_revision_id
  WHERE r.requirement_revision_id=NEW.requirement_revision_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND d.decision_closure_id=NEW.decision_closure_id
    AND d.record_sha256=NEW.decision_closure_sha256 AND d.gate=NEW.gate
    AND r.goal_id=NEW.goal_id AND r.contract_id=NEW.contract_id
    AND r.authority_root_id=NEW.authority_root_id
) OR NOT EXISTS (
  SELECT 1 FROM events e WHERE e.goal_id=NEW.goal_id
    AND e.sequence=NEW.created_event_sequence-1 AND e.event_sha256=NEW.event_head_sha256
    AND e.sequence=(SELECT max(h.sequence) FROM events h WHERE h.goal_id=NEW.goal_id)
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
) OR (
  NEW.gate='MATERIAL_CHANGE'
  AND (NEW.gate_subject_kind<>'CHANGE_ACCEPTANCE_CLOSURE' OR NOT EXISTS (
    SELECT 1 FROM change_acceptance_closures_v2 c
    WHERE c.change_acceptance_closure_id=NEW.gate_subject_id
      AND c.record_sha256=NEW.gate_subject_sha256
      AND c.requirement_revision_id=NEW.requirement_revision_id
      AND c.requirement_revision_sha256=NEW.requirement_revision_sha256
      AND c.goal_id=NEW.goal_id AND c.contract_id=NEW.contract_id
      AND c.authority_root_id=NEW.authority_root_id
      AND c.decision_closure_id=NEW.decision_closure_id
      AND c.decision_closure_sha256=NEW.decision_closure_sha256
      AND EXISTS (
        SELECT 1 FROM json_each(NEW.host_evidence_sha256s_json)
        WHERE value=c.record_sha256
      )
  ))
) OR NEW.gate IN ('REPEATED_FAILURE','FINAL_CLOSURE')
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 gate instance closure mismatch or unsupported gate'); END;

DROP TRIGGER validate_goal_fit_assessment_v2;
CREATE TRIGGER validate_goal_fit_assessment_v2
BEFORE INSERT ON goal_fit_assessments_v2
WHEN NOT EXISTS (
  SELECT 1 FROM goal_fit_gate_instances_v2 g JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=g.requirement_revision_id
  WHERE g.gate_instance_receipt_id=NEW.gate_instance_receipt_id
    AND g.record_sha256=NEW.gate_instance_receipt_sha256
    AND g.requirement_revision_id=NEW.requirement_revision_id
    AND g.decision_closure_id=NEW.decision_closure_id AND g.gate=NEW.gate
    AND g.goal_id=NEW.goal_id AND g.contract_id=NEW.contract_id
    AND g.authority_root_id=NEW.authority_root_id
    AND r.source_root_sha256=NEW.source_root_sha256
    AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND g.decision_closure_sha256=NEW.decision_closure_sha256
) OR json_extract(NEW.gate_specific_evidence_json,'$.status')='NOT_APPLICABLE'
OR NOT EXISTS (
  SELECT 1 FROM json_each(json_extract(NEW.gate_specific_evidence_json,'$.evidence_receipt_sha256s'))
  WHERE value=NEW.gate_instance_receipt_sha256
)
OR EXISTS (
  SELECT 1 FROM (
    SELECT NEW.outcome_fidelity_json value UNION ALL SELECT NEW.obligation_coverage_json
    UNION ALL SELECT NEW.unnecessary_design_json UNION ALL SELECT NEW.current_decisions_json
    UNION ALL SELECT NEW.invalidations_json UNION ALL SELECT NEW.gate_specific_evidence_json
  )
  WHERE json_type(value,'$.status') IS NOT 'text'
    OR json_extract(value,'$.status') NOT IN ('PASS','NOT_APPLICABLE','ASK_USER','REFRAME','REJECT')
    OR json_type(value,'$.reason_codes') IS NOT 'array'
    OR EXISTS (SELECT 1 FROM json_each(json_extract(value,'$.reason_codes'))
      WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 96
        OR value NOT GLOB '[A-Z]*'
        OR value GLOB '*[^A-Z0-9_]*')
    OR (SELECT count(*) FROM json_each(json_extract(value,'$.reason_codes')))
      <> (SELECT count(DISTINCT value) FROM json_each(json_extract(value,'$.reason_codes')))
    OR json_type(value,'$.subject_ids') IS NOT 'array'
    OR EXISTS (SELECT 1 FROM json_each(json_extract(value,'$.subject_ids'))
      WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 160)
    OR (SELECT count(*) FROM json_each(json_extract(value,'$.subject_ids')))
      <> (SELECT count(DISTINCT value) FROM json_each(json_extract(value,'$.subject_ids')))
    OR json_type(value,'$.evidence_receipt_sha256s') IS NOT 'array'
    OR EXISTS (SELECT 1 FROM json_each(json_extract(value,'$.evidence_receipt_sha256s'))
      WHERE type<>'text' OR length(value)<>64)
    OR (SELECT count(*) FROM json_each(json_extract(value,'$.evidence_receipt_sha256s')))
      <> (SELECT count(DISTINCT value) FROM json_each(json_extract(value,'$.evidence_receipt_sha256s')))
    OR (json_extract(value,'$.status')='NOT_APPLICABLE'
      AND (json_array_length(json_extract(value,'$.subject_ids'))<>0
        OR json_array_length(json_extract(value,'$.evidence_receipt_sha256s'))<>0))
    OR (json_extract(value,'$.status')<>'NOT_APPLICABLE'
      AND (json_array_length(json_extract(value,'$.subject_ids'))=0
        OR json_array_length(json_extract(value,'$.evidence_receipt_sha256s'))=0))
)
OR (NEW.gate='MATERIAL_CHANGE' AND NOT EXISTS (
  SELECT 1 FROM goal_fit_gate_instances_v2 g
  JOIN change_acceptance_closures_v2 c
    ON c.change_acceptance_closure_id=g.gate_subject_id
  WHERE g.gate_instance_receipt_id=NEW.gate_instance_receipt_id
    AND g.gate_subject_kind='CHANGE_ACCEPTANCE_CLOSURE'
    AND c.record_sha256=g.gate_subject_sha256
    AND c.successor_plan_revision_sha256=NEW.plan_revision_sha256
    AND c.decision_plan_binding_root_sha256=NEW.decision_plan_binding_root_sha256
    AND c.record_sha256=NEW.change_acceptance_closure_sha256
    AND c.invalidation_root_sha256=NEW.invalidation_root_sha256
    AND c.oracle_evidence_root_sha256=NEW.oracle_evidence_root_sha256
    AND json_extract(NEW.invalidations_json,'$.status')<>'NOT_APPLICABLE'
    AND EXISTS (
      SELECT 1 FROM json_each(json_extract(NEW.invalidations_json,'$.evidence_receipt_sha256s'))
      WHERE value=c.record_sha256
    )
    AND EXISTS (
      SELECT 1 FROM json_each(json_extract(NEW.gate_specific_evidence_json,'$.evidence_receipt_sha256s'))
      WHERE value=c.record_sha256
    )
))
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 assessment closure mismatch'); END;

CREATE INDEX ix_decision_plan_bindings_v2_goal
  ON decision_plan_bindings_v2(goal_id,created_event_sequence);
CREATE INDEX ix_decision_plan_binding_members_v2_decision
  ON decision_plan_binding_members_v2(decision_requirement_revision_id);
CREATE INDEX ix_change_invalidation_closures_v2_goal
  ON change_invalidation_closures_v2(goal_id,base_plan_revision_id,successor_plan_revision_id);
CREATE INDEX ix_change_acceptance_closures_v2_goal
  ON change_acceptance_closures_v2(goal_id,created_event_sequence);
CREATE INDEX ix_change_acceptance_request_members_v2_binding
  ON change_acceptance_request_members_v2(binding_id);
CREATE INDEX ix_change_acceptance_semantic_deltas_v2_entity
  ON change_acceptance_semantic_deltas_v2(entity_kind,semantic_key);

CREATE TRIGGER no_update_decision_plan_bindings_v2 BEFORE UPDATE ON decision_plan_bindings_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan bindings V2 are immutable'); END;
CREATE TRIGGER no_delete_decision_plan_bindings_v2 BEFORE DELETE ON decision_plan_bindings_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan bindings V2 are immutable'); END;
CREATE TRIGGER no_update_decision_plan_binding_members_v2 BEFORE UPDATE ON decision_plan_binding_members_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan binding members V2 are immutable'); END;
CREATE TRIGGER no_delete_decision_plan_binding_members_v2 BEFORE DELETE ON decision_plan_binding_members_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan binding members V2 are immutable'); END;
CREATE TRIGGER no_update_decision_plan_binding_targets_v2 BEFORE UPDATE ON decision_plan_binding_targets_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan binding targets V2 are immutable'); END;
CREATE TRIGGER no_delete_decision_plan_binding_targets_v2 BEFORE DELETE ON decision_plan_binding_targets_v2
BEGIN SELECT RAISE(ABORT,'Decision Plan binding targets V2 are immutable'); END;
CREATE TRIGGER no_update_change_invalidation_closures_v2 BEFORE UPDATE ON change_invalidation_closures_v2
BEGIN SELECT RAISE(ABORT,'Change invalidation closures V2 are immutable'); END;
CREATE TRIGGER no_delete_change_invalidation_closures_v2 BEFORE DELETE ON change_invalidation_closures_v2
BEGIN SELECT RAISE(ABORT,'Change invalidation closures V2 are immutable'); END;
CREATE TRIGGER no_update_change_invalidation_members_v2 BEFORE UPDATE ON change_invalidation_members_v2
BEGIN SELECT RAISE(ABORT,'Change invalidation members V2 are immutable'); END;
CREATE TRIGGER no_delete_change_invalidation_members_v2 BEFORE DELETE ON change_invalidation_members_v2
BEGIN SELECT RAISE(ABORT,'Change invalidation members V2 are immutable'); END;
CREATE TRIGGER no_update_change_reuse_members_v2 BEFORE UPDATE ON change_reuse_members_v2
BEGIN SELECT RAISE(ABORT,'Change reuse members V2 are immutable'); END;
CREATE TRIGGER no_delete_change_reuse_members_v2 BEFORE DELETE ON change_reuse_members_v2
BEGIN SELECT RAISE(ABORT,'Change reuse members V2 are immutable'); END;
CREATE TRIGGER no_update_change_acceptance_closures_v2 BEFORE UPDATE ON change_acceptance_closures_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance closures V2 are immutable'); END;
CREATE TRIGGER no_delete_change_acceptance_closures_v2 BEFORE DELETE ON change_acceptance_closures_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance closures V2 are immutable'); END;
CREATE TRIGGER no_update_change_acceptance_request_members_v2 BEFORE UPDATE ON change_acceptance_request_members_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance request members V2 are immutable'); END;
CREATE TRIGGER no_delete_change_acceptance_request_members_v2 BEFORE DELETE ON change_acceptance_request_members_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance request members V2 are immutable'); END;
CREATE TRIGGER no_update_change_acceptance_semantic_deltas_v2 BEFORE UPDATE ON change_acceptance_semantic_deltas_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance semantic deltas V2 are immutable'); END;
CREATE TRIGGER no_delete_change_acceptance_semantic_deltas_v2 BEFORE DELETE ON change_acceptance_semantic_deltas_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance semantic deltas V2 are immutable'); END;
CREATE TRIGGER no_update_change_acceptance_oracle_bindings_v2 BEFORE UPDATE ON change_acceptance_oracle_bindings_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance oracle bindings V2 are immutable'); END;
CREATE TRIGGER no_delete_change_acceptance_oracle_bindings_v2 BEFORE DELETE ON change_acceptance_oracle_bindings_v2
BEGIN SELECT RAISE(ABORT,'Change acceptance oracle bindings V2 are immutable'); END;
