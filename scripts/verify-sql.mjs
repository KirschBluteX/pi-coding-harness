import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportArg = process.argv.indexOf("--report");
const reportPath = reportArg >= 0 ? resolve(process.argv[reportArg + 1]) : null;
const db = new DatabaseSync(":memory:");
const failures = [];
const migrations = [];

function runMigration(name, required = true) {
  const path = resolve(root, "schemas", "sql", name);
  try {
    db.exec(readFileSync(path, "utf8"));
    migrations.push({ file: relative(root, path).replaceAll("\\", "/"), status: "PASS" });
  } catch (error) {
    migrations.push({ file: relative(root, path).replaceAll("\\", "/"), status: required ? "FAIL" : "SKIP", error: error.message });
    if (required) failures.push(`${name}: ${error.message}`);
  }
}

function runExternallyTransactionalMigration(name) {
  const path = resolve(root, "schemas", "sql", name);
  const rebuildsReferencedTable = name === "026_goal_fit_review_identity_v2.sql";
  try {
    if (rebuildsReferencedTable) db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
    db.exec("BEGIN IMMEDIATE");
    db.exec(readFileSync(path, "utf8"));
    if (rebuildsReferencedTable && db.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("table rebuild produced a foreign-key violation");
    }
    db.exec("COMMIT");
    migrations.push({ file: relative(root, path).replaceAll("\\", "/"), status: "PASS", transaction_owner: "external" });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
    migrations.push({ file: relative(root, path).replaceAll("\\", "/"), status: "FAIL", error: error.message });
    failures.push(`${name}: ${error.message}`);
  } finally {
    if (rebuildsReferencedTable) db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
  }
}

let fts5 = false;
try {
  db.exec("CREATE VIRTUAL TABLE __pch_fts_probe USING fts5(content); DROP TABLE __pch_fts_probe;");
  fts5 = true;
} catch {
  fts5 = false;
}

const authoritySchema = Number(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  .codingHarness?.authoritySchema);
const migrationFiles = readdirSync(resolve(root, "schemas", "sql"))
  .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en-US"));
if (!Number.isSafeInteger(authoritySchema) || authoritySchema < 1) {
  failures.push("package.json codingHarness.authoritySchema is invalid");
}
if (migrationFiles.length !== authoritySchema) {
  failures.push(`migration file count ${migrationFiles.length} does not match authority schema ${authoritySchema}`);
}
for (const [index, name] of migrationFiles.entries()) {
  const expectedPrefix = String(index + 1).padStart(3, "0");
  if (!name.startsWith(`${expectedPrefix}_`)) {
    failures.push(`migration sequence gap: expected ${expectedPrefix}, found ${name}`);
  }
  if (!fts5 && name === "004_memory_fts.sql") {
    migrations.push({ file: `schemas/sql/${name}`, status: "SKIP", reason: "FTS5 unavailable; migration 003 TAG_PATH authority remains active." });
  } else if (!fts5 && name === "006_memory_claims_fts.sql") {
    migrations.push({ file: `schemas/sql/${name}`, status: "SKIP", reason: "FTS5 unavailable; Memory v2 exact indexes and pending overlay remain active." });
  } else if (index < 10) {
    runMigration(name);
  } else {
    runExternallyTransactionalMigration(name);
  }
}

const acceptanceV2Tables = [
  "acceptance_source_revisions_v2", "acceptance_source_spans_v2", "acceptance_facets_v2",
  "acceptance_facet_span_members_v2", "acceptance_obligations_v2", "facet_obligation_bindings_v2",
  "evidence_requirements_v2", "acceptance_authority_roots_v2",
  "acceptance_authority_span_members_v2", "acceptance_authority_facet_members_v2",
  "acceptance_authority_obligation_members_v2", "acceptance_authority_binding_members_v2",
  "acceptance_authority_requirement_members_v2", "legacy_authority_dispositions_v2",
  "oracle_execution_descriptors_v2", "oracle_execution_observations_v2", "oracle_pass_receipts_v2",
  "acceptance_evidence_bindings_v2", "acceptance_evidence_witness_members_v2",
  "work_cell_completion_receipts_v2", "work_cell_completion_evidence_members_v2",
  "work_cell_completion_obligation_members_v2", "deliverable_manifests_v2",
  "deliverable_completion_members_v2", "deliverable_artifact_members_v2",
];

const intakeV2Tables = [
  "requirement_revisions_v2", "requirement_items_v2", "requirement_item_facet_members_v2",
  "requirement_item_span_members_v2", "decision_requirements_v2",
  "decision_requirement_item_members_v2", "decision_requirement_span_members_v2",
  "decision_due_event_receipts_v2", "decision_authority_inputs_v2", "decision_resolutions_v2", "decision_closures_v2",
  "decision_closure_members_v2", "goal_fit_reviews_v2", "contract_freeze_receipts_v2",
];

const requiredTables = [
  "goals", "requirement_revisions", "requirement_items", "plan_revisions", "plan_stages",
  "attempts", "assumptions", "receipts", "effects", "events", "execution_leases",
  "progress_snapshots", "milestone_checkpoints", "experiment_epochs", "performance_trials",
  "experiment_epoch_transitions", "performance_trial_verdicts", "prompt_generations", "prompt_requests",
  "cache_observations", "output_observations", "tool_result_projections",
  "memory_versions", "memory_index_outbox", "memory_lookup_terms",
  "memory_claim_versions", "memory_claim_heads", "memory_claim_actions", "memory_action_heads",
  "memory_claim_terms", "memory_index_v2_outbox", "memory_index_v2_receipts",
  "memory_workspace_watermarks", "memory_legacy_dispositions", "memory_recall_observations",
  "memory_checkpoint_snapshots", "memory_v3_workspace_stream_heads", "memory_v3_events",
  "memory_v3_commands", "memory_v3_claim_versions", "memory_v3_claim_heads",
  "memory_v3_actions", "memory_v3_action_heads", "memory_v3_terms",
  "memory_v3_purge_intents", "memory_v3_purge_receipts",
  "memory_v31_capture_intents", "memory_v31_capture_outbox", "memory_v31_observations",
  "memory_v31_observation_retirements", "memory_v31_candidate_clusters", "memory_v31_proposals",
  "memory_v31_proposal_resolutions", "memory_v31_capture_receipts",
  "task_flow_modes_v1", "task_flow_goal_heads_v1", "goal_contract_versions_v1", "goal_contract_heads_v1",
  "task_obligations_v1", "workspace_baselines_v1", "route_skeleton_versions_v1", "route_skeleton_heads_v1",
  "work_cells_v1", "work_cell_heads_v1", "execution_authorizations_v1", "operation_attempts_v1",
  "operation_transitions_v1", "operation_heads_v1", "evidence_attestations_v1", "route_health_records_v1",
  "task_invalidations_v1", "task_flow_activities_v1", "deliverable_manifests_v1",
  "read_evidence_receipts_v1", "evidence_validity_transitions_v1", "context_working_sets_v1",
  "context_working_set_items_v1", "context_compile_receipts_v1", "context_retention_roots_v1",
  "context_tool_surface_plans_v1", "context_layout_manifests_v1", "context_projection_receipts_v1",
  "context_query_scope_heads_v1", "provider_turn_ledgers_v1", "provider_turn_attempts_v1",
  "provider_turn_contributions_v1",
  "managed_runs_v1", "topology_revisions_v1", "work_shards_v1", "task_packets_v1",
  "shard_lease_generations_v1", "worker_runs_v1", "worker_run_transitions_v1",
  "worker_results_v1", "patch_sets_v1", "integration_receipts_v1", "execution_subject_bindings_v2",
  "memory_visibility_bindings_v1", "cache_security_partitions_v2", "cache_stable_prefix_families_v2",
  "cache_logical_requests_v2", "cache_request_attributions_v2", "harness_compaction_attempts_v21",
  "harness_compaction_transitions_v21", "input_context_prompt_requests_v2", "provider_turn_ledgers_v2",
  "provider_turn_attempts_v2", "provider_turn_contributions_v2", "target_performance_measurements_v1",
  "target_performance_verdicts_v1", "task_flow_intake_evidence_v1", "acceptance_ledgers_v1",
  "patch_transaction_preparations_v1", "provider_turn_goal_bindings_v1"
];
requiredTables.push(...acceptanceV2Tables, ...intakeV2Tables);
if (fts5) requiredTables.push("memory_fts", "memory_claims_fts");
for (const table of requiredTables) {
  const row = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (Number(row.count) !== 1) failures.push(`required table missing: ${table}`);
}

const immutableExperimentTables = [
  "experiment_epochs", "experiment_epoch_transitions", "telemetry_samples", "performance_trials",
  "performance_trial_verdicts", "prompt_generations", "prompt_requests", "cache_observations",
  "output_observations", "tool_result_projections", "performance_windows"
];
for (const table of immutableExperimentTables) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?"
    ).get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}

for (const operation of ["update", "delete"]) {
  const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
    .get(`no_${operation}_memory_versions`);
  if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_memory_versions`);
}

for (const table of ["memory_claim_versions", "memory_claim_actions", "memory_claim_terms", "memory_index_v2_outbox", "memory_index_v2_receipts", "memory_legacy_dispositions", "memory_recall_observations", "memory_checkpoint_snapshots"]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}

for (const table of ["memory_v3_events", "memory_v3_commands", "memory_v3_claim_versions", "memory_v3_actions", "memory_v3_terms"]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}
for (const table of ["memory_v3_purge_intents", "memory_v3_purge_receipts"]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}
for (const table of ["memory_v31_capture_intents", "memory_v31_observations", "memory_v31_observation_retirements", "memory_v31_proposals", "memory_v31_proposal_resolutions", "memory_v31_capture_receipts"]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}

for (const table of [
  "task_flow_modes_v1", "goal_contract_versions_v1", "task_obligations_v1", "task_decision_entries_v1",
  "workspace_baselines_v1", "route_skeleton_versions_v1", "commitment_points_v1", "work_cells_v1",
  "work_cell_dependencies_v1", "operation_attempts_v1", "operation_transitions_v1", "evidence_attestations_v1",
  "route_health_records_v1", "task_invalidations_v1", "task_flow_activities_v1", "deliverable_manifests_v1",
  "read_evidence_receipts_v1", "evidence_validity_transitions_v1", "context_working_sets_v1",
  "context_working_set_items_v1", "context_compile_receipts_v1", "context_retention_roots_v1",
  "context_tool_surface_plans_v1", "context_layout_manifests_v1", "context_projection_receipts_v1",
  "provider_turn_ledgers_v1", "provider_turn_attempts_v1", "provider_turn_contributions_v1"
]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}

for (const table of [
  "managed_runs_v1", "topology_revisions_v1", "work_shards_v1", "task_packets_v1",
  "shard_lease_generations_v1", "worker_runs_v1", "worker_run_transitions_v1", "worker_results_v1",
  "patch_sets_v1", "integration_receipts_v1", "execution_subject_bindings_v2", "memory_visibility_bindings_v1",
  "cache_security_partitions_v2", "cache_stable_prefix_families_v2", "cache_logical_requests_v2",
  "cache_request_attributions_v2", "harness_compaction_attempts_v21", "harness_compaction_transitions_v21",
  "input_context_prompt_requests_v2", "provider_turn_ledgers_v2", "provider_turn_attempts_v2",
  "provider_turn_contributions_v2", "target_performance_measurements_v1", "target_performance_verdicts_v1",
  "task_flow_intake_evidence_v1", "acceptance_ledgers_v1", "patch_transaction_preparations_v1",
]) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}
for (const table of acceptanceV2Tables) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}
for (const table of intakeV2Tables) {
  for (const operation of ["update", "delete"]) {
    const trigger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`no_${operation}_${table}`);
    if (Number(trigger.count) !== 1) failures.push(`immutable trigger missing: no_${operation}_${table}`);
  }
}

const inputContextColumns = db.prepare(`SELECT m.name AS table_name,p.name AS column_name
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type='table' AND (m.name LIKE 'context_%_v1' OR m.name LIKE 'provider_turn_%_v1'
    OR m.name IN ('read_evidence_receipts_v1','evidence_validity_transitions_v1'))`).all();
for (const row of inputContextColumns) {
  if (/(?:^|_)(?:raw_(?:content|prompt|query|path)|prompt_(?:text|bytes|json)|content_(?:text|bytes|json)|absolute_path|query_(?:text|bytes|json))(?:_|$)/u.test(String(row.column_name))) {
    failures.push(`Input Context SQL stores forbidden raw field: ${row.table_name}.${row.column_name}`);
  }
}

const promptColumns = new Set(db.prepare("PRAGMA table_info(prompt_generations)").all().map((row) => row.name));
for (const column of ["transport_epoch_hmac_sha256", "parent_prompt_generation_id", "lineage_action", "generation_action", "boundary_reason", "boundary_policy", "prefix_segment_manifest_sha256", "stable_contract_prefix_hmac_sha256"]) {
  if (!promptColumns.has(column)) failures.push(`prompt_generations column missing: ${column}`);
}

const cacheColumns = new Set(db.prepare("PRAGMA table_info(cache_observations)").all().map((row) => row.name));
for (const column of ["prompt_generation_id", "prompt_request_id", "provider_prompt_reusable_prefix_hmac_sha256", "fingerprint_method", "transport_contract_sha256", "provider_prompt_lcp_tokens", "eligible_prefix_tokens", "retention_mode", "miss_attribution"]) {
  if (!cacheColumns.has(column)) failures.push(`cache_observations column missing: ${column}`);
}

const integrationColumns = new Set(db.prepare("PRAGMA table_info(integration_receipts_v1)").all().map((row) => row.name));
if (!integrationColumns.has("transaction_journal_sha256")) failures.push("integration_receipts_v1 column missing: transaction_journal_sha256");

const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
if (integrity !== "ok") failures.push(`integrity_check: ${integrity}`);
if (foreignKeyFailures.length) failures.push(`foreign_key_check returned ${foreignKeyFailures.length} rows`);

const report = {
  status: failures.length ? "FAIL" : "PASS",
  node: process.version,
  sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
  fts5,
  migrations,
  table_count: Number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count),
  trigger_count: Number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'").get().count),
  integrity,
  foreign_key_failures: foreignKeyFailures,
  failures
};
db.close();

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, rendered, "utf8");
}
process.stdout.write(rendered);
if (failures.length) process.exitCode = 1;
