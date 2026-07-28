import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuthorityConnection } from "../authority/database.js";
import type { MigrationResult } from "../authority/migrate.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, MigrationHashMismatchError } from "../foundation/errors.js";

export const TASK_FLOW_MIGRATION_VERSION = 11;
export const TASK_FLOW_MIGRATION_NAME = "011_task_flow_kernel_v1.sql";

export type TaskFlowMigrationFaultPoint = "after-schema" | "after-migration-record" | "before-commit";

function migrationRecord(connection: AuthorityConnection, version: number): { readonly name: string; readonly sha256: string } | null {
  const row = connection.prepare("SELECT name,sha256 FROM schema_migrations WHERE version=?").get(version) as {
    name?: unknown; sha256?: unknown;
  } | undefined;
  if (!row) return null;
  if (typeof row.name !== "string" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
    throw new AuthorityIntegrityError(`Migration ${version} record is invalid`);
  }
  return { name: row.name, sha256: row.sha256 };
}

export function migrateTaskFlowStore(
  connection: AuthorityConnection,
  migrationPath = resolve("schemas", "sql", TASK_FLOW_MIGRATION_NAME),
  nowMs = Date.now(),
  onFault?: (point: TaskFlowMigrationFaultPoint) => void,
): MigrationResult {
  const absolutePath = resolve(migrationPath);
  const name = basename(absolutePath);
  if (name !== TASK_FLOW_MIGRATION_NAME) {
    throw new AuthorityIntegrityError(`Task Flow migration must be named ${TASK_FLOW_MIGRATION_NAME}`);
  }
  const bytes = readFileSync(absolutePath);
  const hash = sha256Hex(bytes);
  const existing = migrationRecord(connection, TASK_FLOW_MIGRATION_VERSION);
  if (existing) {
    if (existing.name !== name) throw new AuthorityIntegrityError("Migration 11 name mismatch");
    if (existing.sha256 !== hash) throw new MigrationHashMismatchError(TASK_FLOW_MIGRATION_VERSION, existing.sha256, hash);
    return { version: TASK_FLOW_MIGRATION_VERSION, name, sha256: hash, applied: false };
  }
  const predecessor = migrationRecord(connection, 10);
  if (predecessor?.name !== "010_memory_v3_1_capture.sql") {
    throw new AuthorityIntegrityError("Task Flow migration requires verified Memory migration 010");
  }
  const head = connection.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get() as { version?: unknown } | undefined;
  if (Number(head?.version ?? 0) !== 10) throw new AuthorityIntegrityError("Task Flow migration requires exact predecessor head 10");

  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(bytes.toString("utf8"));
    onFault?.("after-schema");
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)")
      .run(TASK_FLOW_MIGRATION_VERSION, name, hash, nowMs);
    onFault?.("after-migration-record");
    onFault?.("before-commit");
    connection.exec("COMMIT");
    return { version: TASK_FLOW_MIGRATION_VERSION, name, sha256: hash, applied: true };
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve the original migration error. */ }
    if (error instanceof AuthorityIntegrityError || error instanceof MigrationHashMismatchError) throw error;
    throw new AuthorityIntegrityError("Task Flow migration 011 failed atomically", error);
  }
}
