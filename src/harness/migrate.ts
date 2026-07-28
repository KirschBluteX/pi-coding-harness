import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuthorityConnection } from "../authority/database.js";
import type { MigrationResult } from "../authority/migrate.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, MigrationHashMismatchError } from "../foundation/errors.js";

export const HARNESS_MIGRATION_VERSION = 13;
export const HARNESS_MIGRATION_NAME = "013_coding_harness_v1.sql";
export type HarnessMigrationFaultPoint = "after-schema" | "after-migration-record" | "before-commit";

function record(connection: AuthorityConnection, version: number): { name: string; sha256: string } | null {
  const row = connection.prepare("SELECT name,sha256 FROM schema_migrations WHERE version=?").get(version) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (typeof row.name !== "string" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
    throw new AuthorityIntegrityError(`Migration ${version} record is invalid`);
  }
  return { name: row.name, sha256: row.sha256 };
}

export function migrateHarnessStore(
  connection: AuthorityConnection,
  migrationPath = resolve("schemas", "sql", HARNESS_MIGRATION_NAME),
  nowMs = Date.now(),
  onFault?: (point: HarnessMigrationFaultPoint) => void,
): MigrationResult {
  const absolute = resolve(migrationPath);
  const name = basename(absolute);
  if (name !== HARNESS_MIGRATION_NAME) throw new AuthorityIntegrityError(`Harness migration must be named ${HARNESS_MIGRATION_NAME}`);
  const bytes = readFileSync(absolute);
  const hash = sha256Hex(bytes);
  const existing = record(connection, HARNESS_MIGRATION_VERSION);
  if (existing) {
    if (existing.name !== name) throw new AuthorityIntegrityError("Migration 13 name mismatch");
    if (existing.sha256 !== hash) throw new MigrationHashMismatchError(HARNESS_MIGRATION_VERSION, existing.sha256, hash);
    return { version: HARNESS_MIGRATION_VERSION, name, sha256: hash, applied: false };
  }
  if (record(connection, 12)?.name !== "012_input_context_v1.sql") {
    throw new AuthorityIntegrityError("Harness migration requires verified Input Context migration 012");
  }
  const head = connection.prepare("SELECT COALESCE(MAX(version),0) version FROM schema_migrations").get() as Record<string, unknown>;
  if (Number(head.version) !== 12) throw new AuthorityIntegrityError("Harness migration requires exact predecessor head 12");
  const nameCollision = connection.prepare("SELECT version FROM schema_migrations WHERE name=?").get(name) as { version?: unknown } | undefined;
  if (nameCollision) throw new AuthorityIntegrityError(`Harness migration name is already assigned to version ${String(nameCollision.version)}`);
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(bytes.toString("utf8"));
    onFault?.("after-schema");
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)")
      .run(HARNESS_MIGRATION_VERSION, name, hash, nowMs);
    onFault?.("after-migration-record");
    onFault?.("before-commit");
    connection.exec("COMMIT");
    return { version: HARNESS_MIGRATION_VERSION, name, sha256: hash, applied: true };
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
    if (error instanceof AuthorityIntegrityError || error instanceof MigrationHashMismatchError) throw error;
    throw new AuthorityIntegrityError("Harness migration 013 failed atomically", error);
  }
}
