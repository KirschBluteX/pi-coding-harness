import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuthorityConnection } from "../authority/database.js";
import type { MigrationResult } from "../authority/migrate.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, MigrationHashMismatchError } from "../foundation/errors.js";

export const INPUT_CONTEXT_MIGRATION_VERSION = 12;
export const INPUT_CONTEXT_MIGRATION_NAME = "012_input_context_v1.sql";

export type InputContextMigrationFaultPoint = "after-schema" | "after-migration-record" | "before-commit";

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

export function migrateInputContextStore(
  connection: AuthorityConnection,
  migrationPath = resolve("schemas", "sql", INPUT_CONTEXT_MIGRATION_NAME),
  nowMs = Date.now(),
  onFault?: (point: InputContextMigrationFaultPoint) => void,
): MigrationResult {
  const absolutePath = resolve(migrationPath);
  const name = basename(absolutePath);
  if (name !== INPUT_CONTEXT_MIGRATION_NAME) {
    throw new AuthorityIntegrityError(`Input Context migration must be named ${INPUT_CONTEXT_MIGRATION_NAME}`);
  }
  const bytes = readFileSync(absolutePath);
  const hash = sha256Hex(bytes);
  const existing = migrationRecord(connection, INPUT_CONTEXT_MIGRATION_VERSION);
  if (existing) {
    if (existing.name !== name) throw new AuthorityIntegrityError("Migration 12 name mismatch");
    if (existing.sha256 !== hash) throw new MigrationHashMismatchError(INPUT_CONTEXT_MIGRATION_VERSION, existing.sha256, hash);
    return { version: INPUT_CONTEXT_MIGRATION_VERSION, name, sha256: hash, applied: false };
  }

  const predecessor = migrationRecord(connection, 11);
  if (predecessor?.name !== "011_task_flow_kernel_v1.sql") {
    throw new AuthorityIntegrityError("Input Context migration requires verified Task Flow migration 011");
  }
  const head = connection.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get() as { version?: unknown } | undefined;
  if (Number(head?.version ?? 0) !== 11) throw new AuthorityIntegrityError("Input Context migration requires exact predecessor head 11");
  const nameCollision = connection.prepare("SELECT version FROM schema_migrations WHERE name=?").get(name) as { version?: unknown } | undefined;
  if (nameCollision) throw new AuthorityIntegrityError(`Input Context migration name is already assigned to version ${String(nameCollision.version)}`);

  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(bytes.toString("utf8"));
    onFault?.("after-schema");
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)")
      .run(INPUT_CONTEXT_MIGRATION_VERSION, name, hash, nowMs);
    onFault?.("after-migration-record");
    onFault?.("before-commit");
    connection.exec("COMMIT");
    return { version: INPUT_CONTEXT_MIGRATION_VERSION, name, sha256: hash, applied: true };
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve the original migration error. */ }
    if (error instanceof AuthorityIntegrityError || error instanceof MigrationHashMismatchError) throw error;
    throw new AuthorityIntegrityError("Input Context migration 012 failed atomically", error);
  }
}
