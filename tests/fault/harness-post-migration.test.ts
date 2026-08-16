import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthorityConnection, closeAuthorityConnection } from "../../src/authority/database.js";
import { migrateCoreStore, SUPPORTED_MIGRATION_VERSION } from "../../src/authority/migrate.js";
import { migrateExperimentStore } from "../../src/authority/experiment-migrate.js";
import { migrateMemoryStore } from "../../src/authority/memory-migrate.js";
import { migrateTaskFlowStore } from "../../src/task-flow/migrate.js";
import { migrateInputContextStore } from "../../src/input-context/migrate.js";
import { migrateHarnessStore } from "../../src/harness/migrate.js";
import { harnessPostMigrations, migrateHarnessPostStore } from "../../src/harness/post-migrate.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

const intakeV2Tables = [
  "requirement_revisions_v2", "requirement_items_v2", "requirement_item_facet_members_v2",
  "requirement_item_span_members_v2", "decision_requirements_v2",
  "decision_requirement_item_members_v2", "decision_requirement_span_members_v2",
  "decision_due_event_receipts_v2", "decision_authority_inputs_v2", "decision_resolutions_v2", "decision_closures_v2",
  "decision_closure_members_v2", "goal_fit_reviews_v2", "contract_freeze_receipts_v2",
  "goal_fit_gate_instances_v2", "goal_fit_assessments_v2", "goal_fit_review_assessment_bindings_v2",
] as const;

const planV2Tables = [
  "plan_revisions_v2", "plan_subjects_v2", "plan_dependency_edges_v2", "plan_heads_v2",
] as const;

const topologyV2Tables = [
  "strong_single_baselines_v2", "dynamic_multi_candidates_v2", "topology_gate_receipts_v2",
  "topology_revision_gate_bindings_v2",
] as const;

const changeAcceptanceV2Tables = [
  "decision_plan_bindings_v2", "decision_plan_binding_members_v2", "decision_plan_binding_targets_v2",
  "change_invalidation_closures_v2", "change_invalidation_members_v2", "change_reuse_members_v2",
  "change_acceptance_closures_v2", "change_acceptance_request_members_v2",
  "change_acceptance_semantic_deltas_v2", "change_acceptance_oracle_bindings_v2",
] as const;

const providerV2Tables = [
  "provider_redaction_receipts_v1", "provider_call_plans_v1", "provider_invocation_transitions_v1",
] as const;

function base() {
  const root = mkdtempSync(resolve(tmpdir(), "pch-post-migrate-")); roots.push(root);
  const connection = openAuthorityConnection({ path: resolve(root, "authority.sqlite") });
  migrateCoreStore(connection, resolve("schemas/sql/001_core.sql"));
  migrateExperimentStore(connection, resolve("schemas/sql/002_experiments.sql"));
  migrateMemoryStore(connection, taskFlowMemoryMigrations);
  migrateTaskFlowStore(connection, resolve("schemas/sql/011_task_flow_kernel_v1.sql"));
  migrateInputContextStore(connection, resolve("schemas/sql/012_input_context_v1.sql"));
  migrateHarnessStore(connection, resolve("schemas/sql/013_coding_harness_v1.sql"));
  return connection;
}

describe("Harness post migrations", () => {
  it("applies every registered post migration atomically and reopens idempotently", () => {
    const connection = base();
    try {
      expect(migrateHarnessPostStore(connection, resolve("schemas/sql")).map((entry) => entry.applied))
        .toEqual(harnessPostMigrations.map(() => true));
      expect(migrateHarnessPostStore(connection, resolve("schemas/sql")).map((entry) => entry.applied))
        .toEqual(harnessPostMigrations.map(() => false));
      expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get())
        .toEqual({ version: SUPPORTED_MIGRATION_VERSION });
      for (const table of [
        ...authorityV2Tables, ...intakeV2Tables, ...planV2Tables.filter((table) => table !== "plan_heads_v2"),
        ...topologyV2Tables, ...changeAcceptanceV2Tables,
      ]) {
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table))
          .toEqual({ count: 1 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='trigger' AND name=?")
          .get(`no_update_${table}`)).toEqual({ count: 1 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='trigger' AND name=?")
          .get(`no_delete_${table}`)).toEqual({ count: 1 });
      }
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls back a faulted 014 without exposing a partial schema", () => {
    const connection = base();
    try {
      expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
        if (version === 14 && point === "after-schema") throw new Error("fault");
      })).toThrow("failed atomically");
      expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 13 });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name='cache_security_partitions_v2'").get()).toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls back every fault point in 020 without exposing partial authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 20 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 19 });
        for (const table of authorityV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table)).toEqual({ count: 0 });
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(`no_update_${table}`)).toEqual({ count: 0 });
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(`no_delete_${table}`)).toEqual({ count: 0 });
        }
        expect(migrateHarnessPostStore(connection, resolve("schemas/sql")).at(-1)?.applied).toBe(true);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 021 without exposing partial Intake authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 21 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 20 });
        for (const table of intakeV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table)).toEqual({ count: 0 });
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(`no_update_${table}`)).toEqual({ count: 0 });
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(`no_delete_${table}`)).toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.find((entry) => entry.version === 21)).toMatchObject({ version: 21, applied: true });
        expect(retry.find((entry) => entry.version === 22)).toMatchObject({ version: 22, applied: true });
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 022 without exposing partial Plan authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 22 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 21 });
        for (const table of planV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table)).toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.find((entry) => entry.version === 22)).toMatchObject({ version: 22, applied: true });
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 023 without exposing partial topology authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 23 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 22 });
        for (const table of topologyV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table)).toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rebuilds Goal Fit review identity for exact gate instances and rolls schema 26 back atomically", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 26 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 26)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 25 });
        const tableSql = connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='goal_fit_reviews_v2'")
          .get() as { sql?: unknown };
        expect(String(tableSql.sql)).toContain("UNIQUE(requirement_revision_id,gate,decision_closure_id)");
        expect(connection.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 26);
        expect(retry.at(-1)).toMatchObject({ version: 26, applied: true });
        const rebuiltSql = connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='goal_fit_reviews_v2'")
          .get() as { sql?: unknown };
        expect(String(rebuiltSql.sql)).not.toContain("UNIQUE(requirement_revision_id,gate,decision_closure_id)");
        expect(connection.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 027 without exposing partial Change Acceptance authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 26);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 27 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 27)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 26 });
        for (const table of changeAcceptanceV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table))
            .toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 27);
        expect(retry.at(-1)).toMatchObject({ version: 27, applied: true });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 029 and upgrades 28 to the exact current schema", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 28);
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 28 });
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 29 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 29)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 28 });
        for (const table of providerV2Tables) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table))
            .toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get())
          .toEqual({ version: SUPPORTED_MIGRATION_VERSION });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 030 without exposing a partial Goal provider binding", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 29);
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 29 });
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 30 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 30)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 29 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name='provider_turn_goal_bindings_v1'").get())
          .toEqual({ count: 0 });
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 031 without exposing a partial integration journal", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 30);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 31 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 31)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 30 });
        for (const table of ["execution_integration_journals_v2", "execution_integration_preimages_v2"]) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table))
            .toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 032 without exposing a partial Strong Single registry", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 31);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 32 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 32)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 31 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name='strong_single_rollout_receipts_v1'").get())
          .toEqual({ count: 0 });
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 033 without exposing partial comparability authority", () => {
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 32);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 33 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 33)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 32 });
        for (const table of ["strong_single_workload_bindings_v1", "workload_comparability_receipts_v1"]) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(table))
            .toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.at(-1)).toMatchObject({ version: SUPPORTED_MIGRATION_VERSION, applied: true });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 034 without exposing partial Dynamic Multi proposal authority", () => {
    const schemaObjects = [
      "dynamic_multi_proposal_receipts_v2",
      "validate_dynamic_multi_proposal_receipt_v2",
      "ix_dynamic_multi_proposal_current_v2",
      "no_update_dynamic_multi_proposal_receipts_v2",
      "no_delete_dynamic_multi_proposal_receipts_v2",
    ] as const;
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 33);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 34 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 34)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 33 });
        for (const name of schemaObjects) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(name))
            .toEqual({ count: 0 });
        }
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.find((entry) => entry.version === 34)).toMatchObject({ version: 34, applied: true });
        for (const name of schemaObjects) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(name))
            .toEqual({ count: 1 });
        }
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });

  it("rolls back every fault point in 035 without exposing a partial session binding authority", () => {
    const schemaObjects = [
      "goal_session_binding_revisions_v1",
      "goal_session_binding_heads_v1",
      "ux_goal_session_binding_active_session_v1",
      "validate_goal_session_binding_revision_v1",
      "validate_goal_session_binding_head_update_v1",
    ] as const;
    for (const faultPoint of ["after-schema", "after-migration-record", "before-commit"] as const) {
      const connection = base();
      try {
        migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), undefined, 34);
        expect(() => migrateHarnessPostStore(connection, resolve("schemas/sql"), Date.now(), (version, point) => {
          if (version === 35 && point === faultPoint) throw new Error(`fault:${faultPoint}`);
        }, 35)).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 34 });
        for (const name of schemaObjects) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(name))
            .toEqual({ count: 0 });
        }
        expect(connection.prepare("SELECT count(*) count FROM pragma_table_info('execution_leases') WHERE name='owner_instance_id'").get())
          .toEqual({ count: 0 });
        const retry = migrateHarnessPostStore(connection, resolve("schemas/sql"));
        expect(retry.find((entry) => entry.version === 35)).toMatchObject({ version: 35, applied: true });
        for (const name of schemaObjects) {
          expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE name=?").get(name))
            .toEqual({ count: 1 });
        }
        expect(connection.prepare("SELECT count(*) count FROM pragma_table_info('execution_leases') WHERE name='owner_instance_id'").get())
          .toEqual({ count: 1 });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { closeAuthorityConnection(connection); }
    }
  });
});
