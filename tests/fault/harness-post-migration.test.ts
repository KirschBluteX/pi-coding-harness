import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthorityConnection, closeAuthorityConnection } from "../../src/authority/database.js";
import { migrateCoreStore } from "../../src/authority/migrate.js";
import { migrateExperimentStore } from "../../src/authority/experiment-migrate.js";
import { migrateMemoryStore } from "../../src/authority/memory-migrate.js";
import { migrateTaskFlowStore } from "../../src/task-flow/migrate.js";
import { migrateInputContextStore } from "../../src/input-context/migrate.js";
import { migrateHarnessStore } from "../../src/harness/migrate.js";
import { migrateHarnessPostStore } from "../../src/harness/post-migrate.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  it("applies 014..019 atomically and reopens idempotently", () => {
    const connection = base();
    try {
      expect(migrateHarnessPostStore(connection, resolve("schemas/sql")).map((entry) => entry.applied)).toEqual([true, true, true, true, true, true]);
      expect(migrateHarnessPostStore(connection, resolve("schemas/sql")).map((entry) => entry.applied)).toEqual([false, false, false, false, false, false]);
      expect(connection.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({ version: 19 });
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
});
