import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { migrateHarnessStore, type HarnessMigrationFaultPoint } from "../../src/harness/migrate.js";
import { createTestAuthority, type TestAuthority } from "../helpers/authority.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function createInputContextAuthority(): TestAuthority {
  const authority = createTestAuthority({
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
  });
  authorities.push(authority);
  return authority;
}

describe("Pi Coding Harness migration 013", () => {
  it("applies only after exact Input Context predecessor and is idempotent", () => {
    const authority = createInputContextAuthority();
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const path = resolve("schemas", "sql", "013_coding_harness_v1.sql");
      const applied = migrateHarnessStore(connection, path, authority.clock.now());
      expect(applied).toMatchObject({ version: 13, name: "013_coding_harness_v1.sql", applied: true });
      expect(migrateHarnessStore(connection, path, authority.clock.now())).toEqual({ ...applied, applied: false });
      expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 13 });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='managed_runs_v1'").get()).toEqual({ count: 1 });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='shard_lease_heads_v1'").get()).toEqual({ count: 1 });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='worker_results_v1'").get()).toEqual({ count: 1 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls back schema bytes and migration record at every fault boundary", () => {
    const authority = createInputContextAuthority();
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const path = resolve("schemas", "sql", "013_coding_harness_v1.sql");
      for (const point of ["after-schema", "after-migration-record", "before-commit"] as HarnessMigrationFaultPoint[]) {
        expect(() => migrateHarnessStore(connection, path, authority.clock.now(), (current) => {
          if (current === point) throw new Error(`FAULT:${point}`);
        })).toThrow("failed atomically");
        expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 12 });
        expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='managed_runs_v1'").get()).toEqual({ count: 0 });
      }
      expect(migrateHarnessStore(connection, path, authority.clock.now()).applied).toBe(true);
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects a store whose exact predecessor is absent", () => {
    const authority = createTestAuthority({
      memoryMigrations: taskFlowMemoryMigrations,
      taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    });
    authorities.push(authority);
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      expect(() => migrateHarnessStore(connection, resolve("schemas", "sql", "013_coding_harness_v1.sql"), authority.clock.now()))
        .toThrow("requires verified Input Context migration 012");
    } finally { closeAuthorityConnection(connection); }
  });
});
