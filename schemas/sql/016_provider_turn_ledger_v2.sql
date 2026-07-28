-- Input Context owns its provider-turn request lineage. No prompt or message
-- content is stored; only bounded hashes, counts and provider-reported usage.

CREATE TABLE input_context_prompt_requests_v2 (
  prompt_request_id TEXT PRIMARY KEY,
  prompt_generation_id TEXT NOT NULL,
  previous_prompt_request_id TEXT REFERENCES input_context_prompt_requests_v2(prompt_request_id),
  request_sequence INTEGER NOT NULL CHECK(request_sequence>=0),
  logical_request_hmac_sha256 TEXT NOT NULL CHECK(length(logical_request_hmac_sha256)=64),
  payload_shape_sha256 TEXT NOT NULL CHECK(length(payload_shape_sha256)=64),
  message_descriptor_root_sha256 TEXT NOT NULL CHECK(length(message_descriptor_root_sha256)=64),
  message_count INTEGER NOT NULL CHECK(message_count>=0),
  logical_message_bytes INTEGER NOT NULL CHECK(logical_message_bytes>=0),
  user_history_bytes INTEGER NOT NULL CHECK(user_history_bytes>=0),
  assistant_history_bytes INTEGER NOT NULL CHECK(assistant_history_bytes>=0),
  other_history_bytes INTEGER NOT NULL CHECK(other_history_bytes>=0),
  tool_schema_bytes INTEGER NOT NULL CHECK(tool_schema_bytes>=0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  UNIQUE(prompt_generation_id,request_sequence),
  CHECK((request_sequence=0 AND previous_prompt_request_id IS NULL)
    OR (request_sequence>0 AND previous_prompt_request_id IS NOT NULL)),
  CHECK(user_history_bytes+assistant_history_bytes+other_history_bytes=logical_message_bytes)
) STRICT;

CREATE TABLE provider_turn_ledgers_v2 (
  prompt_request_id TEXT PRIMARY KEY REFERENCES input_context_prompt_requests_v2(prompt_request_id),
  prompt_generation_id TEXT NOT NULL,
  context_envelope_sha256 TEXT CHECK(context_envelope_sha256 IS NULL OR length(context_envelope_sha256)=64),
  layout_manifest_sha256 TEXT CHECK(layout_manifest_sha256 IS NULL OR length(layout_manifest_sha256)=64),
  provider_uncached_input_tokens INTEGER CHECK(provider_uncached_input_tokens IS NULL OR provider_uncached_input_tokens>=0),
  provider_cache_read_tokens INTEGER CHECK(provider_cache_read_tokens IS NULL OR provider_cache_read_tokens>=0),
  provider_cache_write_tokens INTEGER CHECK(provider_cache_write_tokens IS NULL OR provider_cache_write_tokens>=0),
  provider_generated_output_tokens INTEGER CHECK(provider_generated_output_tokens IS NULL OR provider_generated_output_tokens>=0),
  provider_reasoning_tokens INTEGER CHECK(provider_reasoning_tokens IS NULL OR provider_reasoning_tokens>=0),
  attributed_input_tokens INTEGER CHECK(attributed_input_tokens IS NULL OR attributed_input_tokens>=0),
  unattributed_input_tokens INTEGER CHECK(unattributed_input_tokens IS NULL OR unattributed_input_tokens>=0),
  attributed_output_tokens INTEGER CHECK(attributed_output_tokens IS NULL OR attributed_output_tokens>=0),
  unattributed_output_tokens INTEGER CHECK(unattributed_output_tokens IS NULL OR unattributed_output_tokens>=0),
  accounting_completeness TEXT NOT NULL CHECK(accounting_completeness IN ('COMPLETE','PARTIAL','UNOBSERVABLE')),
  additional_model_requests INTEGER NOT NULL CHECK(additional_model_requests=0),
  additional_provider_requests INTEGER NOT NULL CHECK(additional_provider_requests=0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  CHECK(provider_reasoning_tokens IS NULL OR provider_generated_output_tokens IS NULL
    OR provider_reasoning_tokens<=provider_generated_output_tokens)
) STRICT;

CREATE TABLE provider_turn_attempts_v2 (
  attempt_id TEXT NOT NULL,
  prompt_request_id TEXT NOT NULL REFERENCES input_context_prompt_requests_v2(prompt_request_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 1024),
  transition_ordinal INTEGER NOT NULL CHECK(transition_ordinal IN (0,1)),
  request_identity_hmac TEXT NOT NULL CHECK(length(request_identity_hmac)=64),
  payload_identity_hmac TEXT CHECK(payload_identity_hmac IS NULL OR length(payload_identity_hmac)=64),
  payload_finality TEXT NOT NULL CHECK(payload_finality IN ('PCH_HOOK_INPUT','PCH_HOOK_OUTPUT','EXTENSION_CHAIN_FINAL','WIRE_SERIALIZED')),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms>=started_at_ms),
  response_status INTEGER CHECK(response_status IS NULL OR response_status BETWEEN 0 AND 999),
  outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','RESPONDED','FAILED','OUTCOME_UNKNOWN')),
  usage_contribution_sha256 TEXT CHECK(usage_contribution_sha256 IS NULL OR length(usage_contribution_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  PRIMARY KEY(attempt_id,transition_ordinal),
  UNIQUE(prompt_request_id,attempt_number,transition_ordinal),
  CHECK((transition_ordinal=0 AND outcome='STARTED') OR (transition_ordinal=1 AND outcome<>'STARTED')),
  CHECK((outcome='STARTED' AND completed_at_ms IS NULL) OR (outcome<>'STARTED' AND completed_at_ms IS NOT NULL)),
  CHECK(outcome<>'RESPONDED' OR response_status IS NOT NULL)
) STRICT;

CREATE TABLE provider_turn_contributions_v2 (
  contribution_id TEXT PRIMARY KEY,
  prompt_request_id TEXT NOT NULL REFERENCES provider_turn_ledgers_v2(prompt_request_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
  owner TEXT NOT NULL CHECK(owner IN ('PI','INPUT_CONTEXT','MEMORY','OUTPUT','COMPACTION','USER','PROVIDER')),
  input_surface TEXT CHECK(input_surface IS NULL OR input_surface IN ('PI_BASE_SYSTEM','PCH_STABLE_POLICY','PCH_WORKFLOW_CONTROL','PCH_PROTECTED_AUTHORITY','PCH_MEMORY','PCH_EVIDENCE','PCH_TOOL_RESULT','PCH_RESPONSE_DIRECTIVE','PCH_RECOVERY_CAPSULE','PI_NATIVE_COMPACTION_SUMMARY','USER_HISTORY','ASSISTANT_HISTORY','TOOL_SCHEMAS','PROVIDER_FRAMING','UNATTRIBUTED_INPUT')),
  output_surface TEXT CHECK(output_surface IS NULL OR output_surface IN ('ASSISTANT_TEXT','TOOL_CALL_ARGUMENTS','REASONING','NATIVE_COMPACTION_SUMMARY','CUSTOM_COMPACTION_SUMMARY','UNATTRIBUTED_OUTPUT')),
  segment_identity_hmac TEXT CHECK(segment_identity_hmac IS NULL OR length(segment_identity_hmac)=64),
  logical_bytes INTEGER CHECK(logical_bytes IS NULL OR logical_bytes>=0),
  tokens INTEGER CHECK(tokens IS NULL OR tokens>=0),
  evidence TEXT NOT NULL CHECK(evidence IN ('PROVIDER_REPORTED','SERIALIZER_PROVEN','TOKENIZER_PROVEN','LOCAL_ESTIMATE','UNOBSERVABLE')),
  included INTEGER NOT NULL CHECK(included IN (0,1)),
  duplicate_of TEXT REFERENCES provider_turn_contributions_v2(contribution_id),
  contribution_sha256 TEXT NOT NULL UNIQUE CHECK(length(contribution_sha256)=64),
  UNIQUE(prompt_request_id,ordinal),
  CHECK((input_surface IS NULL)<>(output_surface IS NULL)),
  CHECK(duplicate_of IS NULL OR included=0),
  CHECK(evidence<>'UNOBSERVABLE' OR tokens IS NULL)
) STRICT;

CREATE INDEX ix_input_context_prompt_generation_v2
  ON input_context_prompt_requests_v2(prompt_generation_id,request_sequence DESC);
CREATE INDEX ix_provider_turn_attempt_request_v2
  ON provider_turn_attempts_v2(prompt_request_id,attempt_number,transition_ordinal);
CREATE INDEX ix_provider_turn_contribution_request_v2
  ON provider_turn_contributions_v2(prompt_request_id,ordinal);
CREATE UNIQUE INDEX ux_provider_turn_included_segment_v2
  ON provider_turn_contributions_v2(prompt_request_id,segment_identity_hmac)
  WHERE included=1 AND segment_identity_hmac IS NOT NULL;

CREATE TRIGGER no_update_input_context_prompt_requests_v2 BEFORE UPDATE ON input_context_prompt_requests_v2 BEGIN SELECT RAISE(ABORT, 'Input Context prompt requests are immutable'); END;
CREATE TRIGGER no_delete_input_context_prompt_requests_v2 BEFORE DELETE ON input_context_prompt_requests_v2 BEGIN SELECT RAISE(ABORT, 'Input Context prompt requests are immutable'); END;
CREATE TRIGGER no_update_provider_turn_ledgers_v2 BEFORE UPDATE ON provider_turn_ledgers_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn ledgers are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_ledgers_v2 BEFORE DELETE ON provider_turn_ledgers_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn ledgers are immutable'); END;
CREATE TRIGGER no_update_provider_turn_attempts_v2 BEFORE UPDATE ON provider_turn_attempts_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn attempts are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_attempts_v2 BEFORE DELETE ON provider_turn_attempts_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn attempts are immutable'); END;
CREATE TRIGGER no_update_provider_turn_contributions_v2 BEFORE UPDATE ON provider_turn_contributions_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn contributions are immutable'); END;
CREATE TRIGGER no_delete_provider_turn_contributions_v2 BEFORE DELETE ON provider_turn_contributions_v2 BEGIN SELECT RAISE(ABORT, 'Input Context provider-turn contributions are immutable'); END;
