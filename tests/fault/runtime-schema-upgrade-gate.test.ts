import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { applyForwardMigration, initializeCoreStore, SUPPORTED_MIGRATION_VERSION } from "../../src/authority/migrate.js";
import { AuthorityStore, type AuthorityStoreOptions } from "../../src/authority/transactions.js";
import { migrateHarnessPostStore } from "../../src/harness/post-migrate.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const directories: string[] = [];
const migrationNames = [
  "001_core.sql", "002_experiments.sql", "003_memory.sql", "004_memory_fts.sql",
  "005_memory_claims.sql", "006_memory_claims_fts.sql", "007_memory_checkpoint.sql",
  "008_memory_v3_vault.sql", "009_memory_v3_lifecycle.sql", "010_memory_v3_1_capture.sql",
  "011_task_flow_kernel_v1.sql", "012_input_context_v1.sql", "013_coding_harness_v1.sql",
  "014_cache_v2.sql", "015_compaction_v2_1.sql", "016_provider_turn_ledger_v2.sql",
  "017_target_performance_receipts.sql", "018_control_plane_v2.sql", "019_patch_transaction_v1.sql",
  "020_authority_acceptance_v2.sql", "021_intake_decision_goal_fit_v2.sql",
  "022_plan_change_invalidation_v2.sql", "023_dynamic_multi_v2.sql", "024_active_goal_change_intake_v2.sql",
  "025_goal_fit_assessment_v2.sql", "026_goal_fit_review_identity_v2.sql", "027_change_acceptance_v2.sql",
  "028_dynamic_multi_execution_v2.sql", "029_provider_call_plan_v2.sql",
  "030_provider_turn_goal_binding_v1.sql", "031_dynamic_multi_integration_journal_v2.sql",
  "032_strong_single_rollout_registry_v1.sql", "033_workload_comparability_v1.sql",
  "034_dynamic_multi_proposal_v2.sql", "035_session_goal_binding_v1.sql",
] as const;
const authorityV2Tables = [
  "acceptance_source_revisions_v2", "acceptance_source_spans_v2", "acceptance_facets_v2",
  "acceptance_facet_span_members_v2", "acceptance_obligations_v2", "facet_obligation_bindings_v2",
  "evidence_requirements_v2", "acceptance_authority_roots_v2", "acceptance_authority_span_members_v2",
  "acceptance_authority_facet_members_v2", "acceptance_authority_obligation_members_v2",
  "acceptance_authority_binding_members_v2", "acceptance_authority_requirement_members_v2",
  "legacy_authority_dispositions_v2", "oracle_execution_descriptors_v2", "oracle_execution_observations_v2", "oracle_pass_receipts_v2",
  "acceptance_evidence_bindings_v2", "acceptance_evidence_witness_members_v2",
  "work_cell_completion_receipts_v2", "work_cell_completion_evidence_members_v2",
  "work_cell_completion_obligation_members_v2", "deliverable_manifests_v2",
  "deliverable_completion_members_v2", "deliverable_artifact_members_v2",
] as const;
const activeGoalChangeSchemaObjects = [
  "table:active_goal_user_turns_v2",
  "table:active_goal_user_turn_classifications_v2",
  "table:active_goal_classification_subjects_v2",
  "table:active_goal_change_request_bindings_v2",
  "table:active_goal_change_transitions_v2",
  "index:ix_active_goal_user_turns_v2_pending",
  "index:ix_active_goal_input_classifications_v2_goal",
  "index:ix_active_goal_change_request_bindings_v2_goal",
  "index:ix_active_goal_change_transitions_v2_goal",
  "trigger:no_update_active_goal_user_turns_v2",
  "trigger:no_delete_active_goal_user_turns_v2",
  "trigger:no_update_active_goal_user_turn_classifications_v2",
  "trigger:no_delete_active_goal_user_turn_classifications_v2",
  "trigger:no_update_active_goal_classification_subjects_v2",
  "trigger:no_delete_active_goal_classification_subjects_v2",
  "trigger:no_update_active_goal_change_request_bindings_v2",
  "trigger:no_delete_active_goal_change_request_bindings_v2",
  "trigger:no_update_active_goal_change_transitions_v2",
  "trigger:no_delete_active_goal_change_transitions_v2",
] as const;

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "pch-runtime-upgrade-gate-"));
  directories.push(value);
  return value;
}

function schemaObjects(databasePath: string): readonly string[] {
  const connection = openAuthorityConnection({ path: databasePath });
  try {
    return (connection.prepare(
      "SELECT type || ':' || name AS object FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ).all() as { object?: unknown }[]).map((row) => String(row.object));
  } finally {
    closeAuthorityConnection(connection);
  }
}

function createSchemaVersion(databasePath: string, targetVersion: number): void {
  const connection = openAuthorityConnection({ path: databasePath });
  try {
    applyForwardMigration(connection, 1, resolve("schemas/sql/001_core.sql"), 1);
    initializeCoreStore(connection, { storeId: `STORE-RUNTIME-UPGRADE-${targetVersion}`, nowMs: 1 });
    const directTarget = Math.min(targetVersion, 25);
    for (let version = 2; version <= directTarget; version += 1) {
      applyForwardMigration(connection, version, resolve("schemas/sql", migrationNames[version - 1]!), version);
    }
    if (targetVersion >= 26) {
      migrateHarnessPostStore(connection, resolve("schemas/sql"), targetVersion, undefined, targetVersion);
    }
  } finally {
    closeAuthorityConnection(connection);
  }
}

function runtimeOptions(databasePath: string): AuthorityStoreOptions {
  return {
    databasePath,
    migrationPath: resolve("schemas/sql/001_core.sql"),
    experimentsMigrationPath: resolve("schemas/sql/002_experiments.sql"),
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas/sql/011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas/sql/012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas/sql/013_coding_harness_v1.sql"),
  };
}

function currentVersion(databasePath: string): number {
  const connection = openAuthorityConnection({ path: databasePath });
  try {
    return Number((connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: unknown }).version);
  } finally {
    closeAuthorityConnection(connection);
  }
}

function authorityV2ObjectCount(databasePath: string): number {
  const connection = openAuthorityConnection({ path: databasePath });
  try {
    const placeholders = authorityV2Tables.map(() => "?").join(",");
    const row = connection.prepare(
      `SELECT count(*) AS count FROM sqlite_master WHERE name IN (${placeholders}) OR tbl_name IN (${placeholders})`,
    ).get(...authorityV2Tables, ...authorityV2Tables) as { count?: unknown };
    return Number(row.count);
  } finally {
    closeAuthorityConnection(connection);
  }
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runtime schema upgrade gate", () => {
  it.each(Array.from({ length: SUPPORTED_MIGRATION_VERSION - 1 }, (_, index) => index + 1))(
    "requires lifecycle upgrade before an existing schema-%i runtime open",
    (version) => {
      const databasePath = join(directory(), "authority.sqlite");
      createSchemaVersion(databasePath, version);
      const objectsBefore = schemaObjects(databasePath);
      let opened: AuthorityStore | null = null;
      let failure: unknown;

      try {
        opened = AuthorityStore.open(version >= 13 ? { databasePath } : runtimeOptions(databasePath));
      } catch (error) {
        failure = error;
      } finally {
        opened?.close();
      }

      expect(failure).toMatchObject({
        code: "LIFECYCLE_UPGRADE_REQUIRED", currentVersion: version, requiredVersion: SUPPORTED_MIGRATION_VERSION,
      });
      expect(schemaObjects(databasePath)).toEqual(objectsBefore);
      expect(currentVersion(databasePath)).toBe(version);
      if (version === 19) expect(authorityV2ObjectCount(databasePath)).toBe(0);
      if (version === 23) {
        expect(objectsBefore.some((object) => activeGoalChangeSchemaObjects.includes(
          object as (typeof activeGoalChangeSchemaObjects)[number],
        ))).toBe(false);
      }
    },
    15_000,
  );

  it("bootstraps a fresh schema-0 store through the current schema", () => {
    const databasePath = join(directory(), "authority.sqlite");
    const store = AuthorityStore.open(runtimeOptions(databasePath));
    store.close();

    expect(currentVersion(databasePath)).toBe(SUPPORTED_MIGRATION_VERSION);
    expect(schemaObjects(databasePath)).toEqual(expect.arrayContaining([...activeGoalChangeSchemaObjects]));
    expect(schemaObjects(databasePath)).toEqual(expect.arrayContaining([
      "table:execution_integration_journals_v2",
      "table:execution_integration_preimages_v2",
      "table:strong_single_rollout_receipts_v1",
    ]));
    expect(authorityV2ObjectCount(databasePath)).toBeGreaterThan(0);
  });

  it("validates and opens the current schema without migration writes", () => {
    const databasePath = join(directory(), "authority.sqlite");
    const initial = AuthorityStore.open(runtimeOptions(databasePath));
    initial.close();
    const objectsBefore = schemaObjects(databasePath);

    const store = AuthorityStore.open(runtimeOptions(databasePath));
    store.close();

    expect(currentVersion(databasePath)).toBe(SUPPORTED_MIGRATION_VERSION);
    expect(schemaObjects(databasePath)).toEqual(objectsBefore);
  });
});
