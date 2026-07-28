import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { migrateInputContextStore, type InputContextMigrationFaultPoint } from "../../src/input-context/migrate.js";
import { createTestAuthority, type TestAuthority } from "../helpers/authority.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function createMigrationPredecessor(): TestAuthority {
  return createTestAuthority({
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
  });
}

describe("Input Context migration 012", () => {
  it("applies only after exact Task Flow predecessor and is idempotent", () => {
    const authority = createMigrationPredecessor(); authorities.push(authority);
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const path = resolve("schemas", "sql", "012_input_context_v1.sql");
      const applied = migrateInputContextStore(connection, path, authority.clock.now());
      expect(applied).toMatchObject({ version: 12, name: "012_input_context_v1.sql", applied: true });
      expect(migrateInputContextStore(connection, path, authority.clock.now())).toEqual({ ...applied, applied: false });
      expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 12 });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='project_knowledge_claims_v1'").get()).toEqual({ count: 1 });
      const workingSetSql = connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_working_sets_v1'").get() as { sql: string };
      expect(workingSetSql.sql).not.toContain("plan_stages");
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls back schema bytes and migration record at every fault boundary", () => {
    const authority = createMigrationPredecessor(); authorities.push(authority);
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const path = resolve("schemas", "sql", "012_input_context_v1.sql");
      for (const point of ["after-schema", "after-migration-record", "before-commit"] as InputContextMigrationFaultPoint[]) {
        expect(() => migrateInputContextStore(connection, path, authority.clock.now(), (current) => {
          if (current === point) throw new Error(`FAULT:${point}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 11 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='read_evidence_receipts_v1'").get()).toEqual({ count: 0 });
      }
      expect(migrateInputContextStore(connection, path, authority.clock.now()).applied).toBe(true);
    } finally { closeAuthorityConnection(connection); }
  });
});
