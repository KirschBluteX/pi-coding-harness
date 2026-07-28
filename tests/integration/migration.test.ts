import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { applyForwardMigration, initializeCoreStore } from "../../src/authority/migrate.js";
import { migrateExperimentStore } from "../../src/authority/experiment-migrate.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { MigrationHashMismatchError, UnsafePathError } from "../../src/foundation/errors.js";
import { createGoalCommand, createTestAuthority, type TestAuthority } from "../helpers/authority.js";

const directories: string[] = [];
const authorities: TestAuthority[] = [];
const migrationPath = resolve("schemas", "sql", "001_core.sql");

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "pch-migration-test-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("forward-only core migration", () => {
  it("applies fresh, records the hash and no-ops only for the same bytes", () => {
    const connection = openAuthorityConnection({ path: join(directory(), "authority.sqlite3") });
    try {
      const first = applyForwardMigration(connection, 1, migrationPath, 1);
      const meta = initializeCoreStore(connection, { storeId: "STORE-MIGRATION-TEST", nowMs: 1 });
      const second = applyForwardMigration(connection, 1, migrationPath, 2);
      expect(first.applied).toBe(true);
      expect(second).toEqual({ ...first, applied: false });
      expect(meta.storeId).toBe("STORE-MIGRATION-TEST");
      const migration = connection.prepare("SELECT version,name,sha256,applied_at_ms FROM schema_migrations").get() as Record<string, unknown>;
      expect(migration).toMatchObject({ version: 1, name: "001_core.sql", sha256: first.sha256, applied_at_ms: 1 });
      expect(() => connection.exec("DELETE FROM schema_migrations")).toThrow(/immutable/u);
      expect(() => connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)").run("bad", "bad", "0".repeat(64), 1)).toThrow();
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("fails closed when an applied migration version has different bytes", () => {
    const root = directory();
    const modified = join(root, "001_core.sql");
    copyFileSync(migrationPath, modified);
    const connection = openAuthorityConnection({ path: join(root, "authority.sqlite3") });
    try {
      applyForwardMigration(connection, 1, modified, 1);
      appendFileSync(modified, "\n-- tampered after application\n", "utf8");
      expect(() => applyForwardMigration(connection, 1, modified, 2)).toThrow(MigrationHashMismatchError);
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("does not apply optional Memory or experiment migrations in Phase 1", () => {
    const connection = openAuthorityConnection({ path: join(directory(), "authority.sqlite3") });
    try {
      applyForwardMigration(connection, 1, migrationPath, 1);
      const names = (connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name?: unknown }[]).map((row) => String(row.name));
      expect(names).not.toContain("memories");
      expect(names).not.toContain("experiment_epochs");
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("enforces immutable artifact and receipt metadata and one RUNNING Stage per Goal", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const goal = createGoalCommand();
    authority.store.transact(goal, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const connection = openAuthorityConnection({ path: authority.databasePath });
    const hash = (value: string): string => sha256Hex(value);
    try {
      const insertArtifact = connection.prepare("INSERT INTO artifacts(artifact_id,sha256,byte_length,media_type,classification,locator,encryption_key_id,created_at_ms,retention_class) VALUES(?,?,?,?,?,?,?,?,?)");
      insertArtifact.run("ART-REQ", hash("req"), 3, "application/json", "INTERNAL", `pch-cas://sha256/${hash("req")}`, null, 1, "GOAL");
      insertArtifact.run("ART-PLAN", hash("plan"), 4, "application/json", "INTERNAL", `pch-cas://sha256/${hash("plan")}`, null, 1, "GOAL");
      connection.prepare("INSERT INTO requirement_revisions(requirement_id,goal_id,revision,parent_requirement_id,profile,status,trigger_type,trigger_evidence_sha256,requirements_payload_sha256,requirements_artifact_id,markdown_artifact_id,validation_receipt_id,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("REQ-1", goal.goalId, 1, null, "TASK_SPEC", "FROZEN", "INTAKE", hash("trigger"), hash("requirements"), "ART-REQ", "ART-REQ", null, 1, 1);
      connection.prepare("INSERT INTO plan_revisions(plan_id,goal_id,requirement_id,revision,parent_plan_id,trigger_type,trigger_evidence_sha256,rationale,plan_payload_sha256,plan_artifact_id,markdown_artifact_id,validation_receipt_id,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("PLAN-1", goal.goalId, "REQ-1", 1, null, "INITIAL", hash("trigger"), "Test invariant", hash("plan-payload"), "ART-PLAN", "ART-PLAN", null, 1, 1);
      const insertStage = connection.prepare("INSERT INTO plan_stages(stage_id,plan_id,goal_id,logical_key,title,detail_horizon,risk,ordinal,entry_criteria_json,exit_criteria_json,outputs_json,failure_routes_json,spec_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
      insertStage.run("STAGE-1", "PLAN-1", goal.goalId, "one", "One", "CURRENT", "LOW", 0, "[]", "[]", "[]", "[]", hash("stage-1"));
      insertStage.run("STAGE-2", "PLAN-1", goal.goalId, "two", "Two", "NEAR", "LOW", 1, "[]", "[]", "[]", "[]", hash("stage-2"));
      connection.prepare("INSERT INTO stage_heads(stage_id,goal_id,status,row_version,last_event_sequence) VALUES(?,?,?,?,?)")
        .run("STAGE-1", goal.goalId, "RUNNING", 1, 1);
      expect(() => connection.prepare("INSERT INTO stage_heads(stage_id,goal_id,status,row_version,last_event_sequence) VALUES(?,?,?,?,?)")
        .run("STAGE-2", goal.goalId, "RUNNING", 1, 1)).toThrow(/UNIQUE/u);
      connection.prepare("INSERT INTO receipts(receipt_id,goal_id,receipt_type,subject_type,subject_id,attempt_id,result,input_closure_sha256,output_sha256,failure_signature_sha256,body_json,issuer,issued_at_ms,issued_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("RCP-1", goal.goalId, "VALIDATION", "GOAL", goal.goalId, null, "SUCCEEDED", hash("input"), hash("output"), null, "{}", "VALIDATOR", 1, 1);
      expect(() => connection.exec("UPDATE artifacts SET media_type='text/plain' WHERE artifact_id='ART-REQ'")).toThrow(/immutable/u);
      expect(() => connection.exec("UPDATE receipts SET body_json='[]' WHERE receipt_id='RCP-1'")).toThrow(/immutable/u);
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("rejects an authority database directory reached through a symlink or junction", () => {
    const root = directory();
    const actual = join(root, "actual");
    const linked = join(root, "linked");
    mkdirSync(actual);
    try {
      symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => openAuthorityConnection({ path: join(linked, "authority.sqlite3") })).toThrow(UnsafePathError);
  });

  it("applies migration 002 only after core and records the immutable hash", () => {
    const connection = openAuthorityConnection({ path: join(directory(), "authority.sqlite3") });
    try {
      applyForwardMigration(connection, 1, migrationPath, 1);
      initializeCoreStore(connection, { storeId: "STORE-EXPERIMENT-MIGRATION", nowMs: 1 });
      const result = migrateExperimentStore(connection, resolve("schemas", "sql", "002_experiments.sql"), 2);
      expect(result.applied).toBe(true);
      expect(migrateExperimentStore(connection, resolve("schemas", "sql", "002_experiments.sql"), 3).applied).toBe(false);
      expect(initializeCoreStore(connection)).toMatchObject({ storeId: "STORE-EXPERIMENT-MIGRATION" });
      expect(connection.prepare("SELECT name FROM schema_migrations WHERE version=2").get()).toEqual({ name: "002_experiments.sql" });
      expect(() => connection.exec("DELETE FROM experiment_epochs")).not.toThrow();
      expect(connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='performance_trials'").get()).toEqual({ count: 1 });
    } finally {
      closeAuthorityConnection(connection);
    }
  });
});
