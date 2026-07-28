-- Cache v2 stores redacted identity and attribution only. It never stores raw
-- prompts, provider headers, credentials, or payloads.

CREATE TABLE cache_security_partitions_v2 (
  partition_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  transport_hmac TEXT NOT NULL CHECK(length(transport_hmac)=64),
  provider_hmac TEXT NOT NULL CHECK(length(provider_hmac)=64),
  api_hmac TEXT NOT NULL CHECK(length(api_hmac)=64),
  model_hmac TEXT NOT NULL CHECK(length(model_hmac)=64),
  security_epoch_hmac TEXT NOT NULL CHECK(length(security_epoch_hmac)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(run_id,transport_hmac)
) STRICT;

CREATE TABLE cache_stable_prefix_families_v2 (
  family_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  partition_id TEXT NOT NULL REFERENCES cache_security_partitions_v2(partition_id),
  prompt_generation_id TEXT NOT NULL,
  system_prompt_sha256 TEXT NOT NULL CHECK(length(system_prompt_sha256)=64),
  layout_manifest_sha256 TEXT CHECK(layout_manifest_sha256 IS NULL OR length(layout_manifest_sha256)=64),
  tool_surface_sha256 TEXT NOT NULL CHECK(length(tool_surface_sha256)=64),
  context_subject_sha256 TEXT NOT NULL CHECK(length(context_subject_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(run_id,partition_id,prompt_generation_id,system_prompt_sha256,tool_surface_sha256,context_subject_sha256)
) STRICT;

CREATE TABLE cache_logical_requests_v2 (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  partition_id TEXT NOT NULL REFERENCES cache_security_partitions_v2(partition_id),
  family_id TEXT NOT NULL REFERENCES cache_stable_prefix_families_v2(family_id),
  request_sequence INTEGER NOT NULL CHECK(request_sequence>=1),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(run_id,request_sequence)
) STRICT;

CREATE TABLE cache_request_attributions_v2 (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  partition_id TEXT NOT NULL REFERENCES cache_security_partitions_v2(partition_id),
  family_id TEXT NOT NULL REFERENCES cache_stable_prefix_families_v2(family_id),
  request_sequence INTEGER NOT NULL CHECK(request_sequence>=1),
  subject_binding_sha256 TEXT NOT NULL CHECK(length(subject_binding_sha256)=64),
  observation_state TEXT NOT NULL CHECK(observation_state IN ('INELIGIBLE','COLD_START','HIT','MISS','UNOBSERVABLE','ERROR')),
  evidence_level TEXT NOT NULL CHECK(evidence_level IN ('METADATA_ONLY','PREFIX_OBSERVED','PROVIDER_USAGE','FINAL_PROVEN')),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json) AND json_type(usage_json)='object' AND length(usage_json)<=32768),
  response_status INTEGER CHECK(response_status IS NULL OR response_status BETWEEN 100 AND 599),
  latency_ms REAL CHECK(latency_ms IS NULL OR latency_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  FOREIGN KEY(request_id) REFERENCES cache_logical_requests_v2(request_id),
  UNIQUE(run_id,request_sequence)
) STRICT;

CREATE INDEX cache_request_family_v2 ON cache_request_attributions_v2(family_id,request_sequence);
CREATE INDEX cache_request_state_v2 ON cache_request_attributions_v2(run_id,observation_state,request_sequence);
CREATE INDEX cache_logical_pending_v2 ON cache_logical_requests_v2(run_id,request_sequence);

CREATE TRIGGER no_update_cache_security_partitions_v2 BEFORE UPDATE ON cache_security_partitions_v2 BEGIN SELECT RAISE(ABORT,'cache security partitions are immutable'); END;
CREATE TRIGGER no_delete_cache_security_partitions_v2 BEFORE DELETE ON cache_security_partitions_v2 BEGIN SELECT RAISE(ABORT,'cache security partitions cannot be deleted'); END;
CREATE TRIGGER no_update_cache_stable_prefix_families_v2 BEFORE UPDATE ON cache_stable_prefix_families_v2 BEGIN SELECT RAISE(ABORT,'cache prefix families are immutable'); END;
CREATE TRIGGER no_delete_cache_stable_prefix_families_v2 BEFORE DELETE ON cache_stable_prefix_families_v2 BEGIN SELECT RAISE(ABORT,'cache prefix families cannot be deleted'); END;
CREATE TRIGGER no_update_cache_logical_requests_v2 BEFORE UPDATE ON cache_logical_requests_v2 BEGIN SELECT RAISE(ABORT,'cache logical requests are immutable'); END;
CREATE TRIGGER no_delete_cache_logical_requests_v2 BEFORE DELETE ON cache_logical_requests_v2 BEGIN SELECT RAISE(ABORT,'cache logical requests cannot be deleted'); END;
CREATE TRIGGER no_update_cache_request_attributions_v2 BEFORE UPDATE ON cache_request_attributions_v2 BEGIN SELECT RAISE(ABORT,'cache request attributions are immutable'); END;
CREATE TRIGGER no_delete_cache_request_attributions_v2 BEFORE DELETE ON cache_request_attributions_v2 BEGIN SELECT RAISE(ABORT,'cache request attributions cannot be deleted'); END;
