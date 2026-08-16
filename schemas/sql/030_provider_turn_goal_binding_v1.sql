-- Durable Goal/run attribution for Supervisor provider turns. This table is
-- telemetry authority only; it cannot authorize model calls or side effects.

CREATE TABLE provider_turn_goal_bindings_v1 (
  prompt_request_id TEXT PRIMARY KEY REFERENCES input_context_prompt_requests_v2(prompt_request_id),
  prompt_request_sha256 TEXT NOT NULL REFERENCES input_context_prompt_requests_v2(record_sha256)
    CHECK(length(prompt_request_sha256)=64),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  UNIQUE(prompt_request_id,goal_id,run_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_provider_turn_goal_binding_v1
BEFORE INSERT ON provider_turn_goal_bindings_v1
WHEN NOT EXISTS (
  SELECT 1 FROM input_context_prompt_requests_v2 request
  JOIN managed_runs_v1 run ON run.run_id=NEW.run_id AND run.goal_id=NEW.goal_id
  WHERE request.prompt_request_id=NEW.prompt_request_id
    AND request.record_sha256=NEW.prompt_request_sha256
)
BEGIN SELECT RAISE(ABORT,'Provider turn Goal binding is outside its request/run authority'); END;

CREATE INDEX ix_provider_turn_goal_bindings_v1_goal
  ON provider_turn_goal_bindings_v1(goal_id,run_id,prompt_request_id);

CREATE TRIGGER no_update_provider_turn_goal_bindings_v1
BEFORE UPDATE ON provider_turn_goal_bindings_v1
BEGIN SELECT RAISE(ABORT,'Provider turn Goal bindings are immutable'); END;

CREATE TRIGGER no_delete_provider_turn_goal_bindings_v1
BEFORE DELETE ON provider_turn_goal_bindings_v1
BEGIN SELECT RAISE(ABORT,'Provider turn Goal bindings are immutable'); END;
