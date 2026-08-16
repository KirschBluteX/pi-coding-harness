CREATE TABLE strong_single_rollout_receipts_v1 (
  rollout_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  topology_revision INTEGER NOT NULL CHECK(topology_revision>=1),
  topology_revision_sha256 TEXT NOT NULL CHECK(length(topology_revision_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  completion_receipt_id TEXT NOT NULL REFERENCES work_cell_completion_receipts_v2(completion_receipt_id),
  completion_receipt_sha256 TEXT NOT NULL CHECK(length(completion_receipt_sha256)=64),
  correctness TEXT NOT NULL CHECK(correctness='PASS'),
  quality_basis_points INTEGER NOT NULL CHECK(quality_basis_points=10000),
  wall_time_ms INTEGER NOT NULL CHECK(wall_time_ms>=0),
  provider_requests INTEGER NOT NULL CHECK(provider_requests>=0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  cache_read_tokens INTEGER NOT NULL CHECK(cache_read_tokens>=0),
  provider_accounting_completeness TEXT NOT NULL CHECK(provider_accounting_completeness='COMPLETE'),
  provider_receipt_refs_json TEXT NOT NULL CHECK(
    json_valid(provider_receipt_refs_json) AND json_type(provider_receipt_refs_json)='array'
    AND length(provider_receipt_refs_json)<=1048576
  ),
  provider_receipt_root_sha256 TEXT NOT NULL CHECK(length(provider_receipt_root_sha256)=64),
  user_interventions INTEGER NOT NULL CHECK(user_interventions>=0),
  safety_events INTEGER NOT NULL CHECK(safety_events>=0),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  completed_at_ms INTEGER NOT NULL CHECK(completed_at_ms>=started_at_ms),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(run_id,topology_revision) REFERENCES topology_revisions_v1(run_id,revision),
  UNIQUE(run_id,work_cell_id,authorization_sha256,runtime_fingerprint_sha256),
  UNIQUE(rollout_receipt_id,goal_id,run_id,work_cell_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_strong_single_rollout_receipt_v1
BEFORE INSERT ON strong_single_rollout_receipts_v1
WHEN NOT EXISTS (
  SELECT 1 FROM managed_runs_v1 r
  JOIN managed_run_heads_v1 h ON h.run_id=r.run_id
  JOIN topology_revisions_v1 t ON t.run_id=r.run_id AND t.revision=NEW.topology_revision
  JOIN plan_revisions_v2 p ON p.plan_revision_id=NEW.plan_revision_id
  JOIN work_cells_v1 w ON w.work_cell_id=NEW.work_cell_id
  JOIN plan_subjects_v2 s ON s.plan_revision_id=p.plan_revision_id
    AND s.subject_kind='WORK_CELL' AND s.subject_id=w.logical_key AND s.revision_sha256=w.spec_sha256
  JOIN execution_authorizations_v1 z ON z.authorization_id=NEW.authorization_id
  JOIN workspace_baselines_v1 b ON b.baseline_id=z.baseline_id
  JOIN work_cell_completion_receipts_v2 c ON c.completion_receipt_id=NEW.completion_receipt_id
  JOIN events e ON e.goal_id=NEW.goal_id AND e.sequence=NEW.created_event_sequence-1
  WHERE r.run_id=NEW.run_id AND r.goal_id=NEW.goal_id
    AND h.topology_revision=NEW.topology_revision AND h.effective_topology='SINGLE'
    AND t.effective_topology='SINGLE' AND t.record_sha256=NEW.topology_revision_sha256
    AND t.config_sha256=NEW.config_sha256 AND t.created_at_ms<=NEW.started_at_ms
    AND p.goal_id=NEW.goal_id AND p.record_sha256=NEW.plan_revision_sha256
    AND p.input_closure_sha256=NEW.input_closure_sha256
    AND p.contract_id=w.contract_id AND p.route_id=w.route_id
    AND p.created_event_sequence<NEW.created_event_sequence
    AND z.goal_id=NEW.goal_id AND z.work_cell_id=NEW.work_cell_id
    AND z.contract_id=p.contract_id AND z.route_id=p.route_id
    AND z.record_sha256=NEW.authorization_sha256 AND z.created_at_ms=NEW.started_at_ms
    AND z.created_event_sequence<NEW.created_event_sequence
    AND b.record_sha256=NEW.baseline_sha256
    AND b.content_root_sha256=NEW.baseline_content_root_sha256
    AND b.environment_sha256=NEW.environment_sha256
    AND c.goal_id=NEW.goal_id AND c.work_cell_id=NEW.work_cell_id
    AND c.contract_id=p.contract_id AND c.route_id=p.route_id AND c.authority_root_id=p.authority_root_id
    AND c.authorization_id=NEW.authorization_id AND c.authorization_sha256=NEW.authorization_sha256
    AND c.record_sha256=NEW.completion_receipt_sha256 AND c.created_at_ms=NEW.completed_at_ms
    AND c.created_event_sequence<NEW.created_event_sequence
    AND NOT EXISTS (
      SELECT 1 FROM provider_invocation_transitions_v1 invocation
      WHERE invocation.goal_id=NEW.goal_id AND invocation.run_id=NEW.run_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_turn_goal_bindings_v1 binding
      JOIN input_context_prompt_requests_v2 request ON request.prompt_request_id=binding.prompt_request_id
      JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=request.prompt_request_id
        AND started.transition_ordinal=0
      LEFT JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      LEFT JOIN provider_turn_ledgers_v2 ledger ON ledger.prompt_request_id=request.prompt_request_id
      WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
        AND started.started_at_ms<=NEW.completed_at_ms
        AND coalesce(terminal.completed_at_ms,9223372036854775807)>=NEW.started_at_ms
        AND (
          started.started_at_ms<NEW.started_at_ms OR terminal.completed_at_ms IS NULL
          OR terminal.completed_at_ms>NEW.completed_at_ms OR terminal.outcome<>'RESPONDED'
          OR ledger.prompt_request_id IS NULL OR ledger.accounting_completeness<>'COMPLETE'
          OR ledger.provider_uncached_input_tokens IS NULL OR ledger.provider_cache_read_tokens IS NULL
          OR ledger.provider_cache_write_tokens IS NULL OR ledger.provider_generated_output_tokens IS NULL
          OR ledger.created_at_ms<started.started_at_ms OR ledger.created_at_ms>terminal.completed_at_ms
          OR NOT EXISTS (SELECT 1 FROM provider_turn_contributions_v2 usage
            WHERE usage.prompt_request_id=request.prompt_request_id
              AND usage.contribution_sha256=terminal.usage_contribution_sha256)
          OR request.created_at_ms>started.started_at_ms OR binding.created_at_ms>started.started_at_ms
          OR (SELECT count(*) FROM provider_turn_attempts_v2 retry
              WHERE retry.prompt_request_id=request.prompt_request_id AND retry.transition_ordinal=0)<>1
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_turn_attempts_v2 started
      LEFT JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      WHERE started.transition_ordinal=0 AND started.started_at_ms<=NEW.completed_at_ms
        AND coalesce(terminal.completed_at_ms,9223372036854775807)>=NEW.started_at_ms
        AND NOT EXISTS (SELECT 1 FROM provider_turn_goal_bindings_v1 binding
          WHERE binding.prompt_request_id=started.prompt_request_id)
    )
    AND NEW.provider_requests=(
      SELECT count(*)
      FROM provider_turn_goal_bindings_v1 binding
      JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
        AND started.transition_ordinal=0
      JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
        AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
    )
    AND NEW.input_tokens=coalesce((
      SELECT sum(ledger.provider_uncached_input_tokens+ledger.provider_cache_read_tokens+ledger.provider_cache_write_tokens)
      FROM provider_turn_goal_bindings_v1 binding
      JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
        AND started.transition_ordinal=0
      JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      JOIN provider_turn_ledgers_v2 ledger ON ledger.prompt_request_id=binding.prompt_request_id
      WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
        AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
    ),0)
    AND NEW.output_tokens=coalesce((
      SELECT sum(ledger.provider_generated_output_tokens)
      FROM provider_turn_goal_bindings_v1 binding
      JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
        AND started.transition_ordinal=0
      JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      JOIN provider_turn_ledgers_v2 ledger ON ledger.prompt_request_id=binding.prompt_request_id
      WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
        AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
    ),0)
    AND NEW.cache_read_tokens=coalesce((
      SELECT sum(ledger.provider_cache_read_tokens)
      FROM provider_turn_goal_bindings_v1 binding
      JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
        AND started.transition_ordinal=0
      JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
        AND terminal.transition_ordinal=1
      JOIN provider_turn_ledgers_v2 ledger ON ledger.prompt_request_id=binding.prompt_request_id
      WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
        AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
    ),0)
    AND json_array_length(NEW.provider_receipt_refs_json)=NEW.provider_requests*5
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.provider_receipt_refs_json) ref
      WHERE ref.type<>'text' OR length(ref.value)<>64
    )
    AND NOT EXISTS (
      SELECT ref.value FROM json_each(NEW.provider_receipt_refs_json) ref
      GROUP BY ref.value HAVING count(*)<>1
    )
    AND NOT EXISTS (
      SELECT expected.record_sha256 FROM (
        SELECT binding.record_sha256
        FROM provider_turn_goal_bindings_v1 binding
        JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
          AND started.transition_ordinal=0
        JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
          AND terminal.transition_ordinal=1
        WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
          AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
          AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        UNION ALL
        SELECT request.record_sha256
        FROM provider_turn_goal_bindings_v1 binding
        JOIN input_context_prompt_requests_v2 request ON request.prompt_request_id=binding.prompt_request_id
        JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
          AND started.transition_ordinal=0
        JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
          AND terminal.transition_ordinal=1
        WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
          AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
          AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        UNION ALL
        SELECT attempt.record_sha256
        FROM provider_turn_goal_bindings_v1 binding
        JOIN provider_turn_attempts_v2 attempt ON attempt.prompt_request_id=binding.prompt_request_id
        JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
          AND started.transition_ordinal=0
        JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
          AND terminal.transition_ordinal=1
        WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
          AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
          AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
        UNION ALL
        SELECT ledger.record_sha256
        FROM provider_turn_goal_bindings_v1 binding
        JOIN provider_turn_ledgers_v2 ledger ON ledger.prompt_request_id=binding.prompt_request_id
        JOIN provider_turn_attempts_v2 started ON started.prompt_request_id=binding.prompt_request_id
          AND started.transition_ordinal=0
        JOIN provider_turn_attempts_v2 terminal ON terminal.attempt_id=started.attempt_id
          AND terminal.transition_ordinal=1
        WHERE binding.goal_id=NEW.goal_id AND binding.run_id=NEW.run_id
          AND started.started_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
          AND terminal.completed_at_ms BETWEEN NEW.started_at_ms AND NEW.completed_at_ms
      ) expected
      WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.provider_receipt_refs_json) ref
        WHERE ref.value=expected.record_sha256)
    )
)
BEGIN SELECT RAISE(ABORT,'Strong Single rollout authority closure mismatch'); END;

CREATE INDEX ix_strong_single_rollout_lookup_v1 ON strong_single_rollout_receipts_v1(
  goal_id,run_id,work_cell_id,plan_revision_id,input_closure_sha256,runtime_fingerprint_sha256,
  config_sha256,baseline_sha256,baseline_content_root_sha256,environment_sha256,completed_at_ms
);

CREATE TRIGGER no_update_strong_single_rollout_receipts_v1
BEFORE UPDATE ON strong_single_rollout_receipts_v1
BEGIN SELECT RAISE(ABORT,'Strong Single rollout receipts V1 are immutable'); END;
CREATE TRIGGER no_delete_strong_single_rollout_receipts_v1
BEFORE DELETE ON strong_single_rollout_receipts_v1
BEGIN SELECT RAISE(ABORT,'Strong Single rollout receipts V1 are immutable'); END;
