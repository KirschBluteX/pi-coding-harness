import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuthorityConnection } from "../authority/database.js";
import type { MigrationResult } from "../authority/migrate.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, MigrationHashMismatchError } from "../foundation/errors.js";

export const harnessPostMigrations = [
  { version: 14, name: "014_cache_v2.sql" },
  { version: 15, name: "015_compaction_v2_1.sql" },
  { version: 16, name: "016_provider_turn_ledger_v2.sql" },
  { version: 17, name: "017_target_performance_receipts.sql" },
  { version: 18, name: "018_control_plane_v2.sql" },
  { version: 19, name: "019_patch_transaction_v1.sql" },
] as const;

export type HarnessPostMigrationFaultPoint = "after-schema" | "after-migration-record" | "before-commit";

function record(connection: AuthorityConnection, version: number): { readonly name: string; readonly sha256: string } | null {
  const row = connection.prepare("SELECT name,sha256 FROM schema_migrations WHERE version=?").get(version) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (typeof row.name !== "string" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
    throw new AuthorityIntegrityError(`Migration ${version} record is invalid`);
  }
  return { name: row.name, sha256: row.sha256 };
}

function applyOne(
  connection: AuthorityConnection,
  migrationPath: string,
  expected: typeof harnessPostMigrations[number],
  nowMs: number,
  onFault?: (version: number, point: HarnessPostMigrationFaultPoint) => void,
): MigrationResult {
  const absolute = resolve(migrationPath);
  if (basename(absolute) !== expected.name) throw new AuthorityIntegrityError(`Migration ${expected.version} must be named ${expected.name}`);
  const bytes = readFileSync(absolute); const hash = sha256Hex(bytes);
  const existing = record(connection, expected.version);
  if (existing) {
    if (existing.name !== expected.name) throw new AuthorityIntegrityError(`Migration ${expected.version} name mismatch`);
    if (existing.sha256 !== hash) throw new MigrationHashMismatchError(expected.version, existing.sha256, hash);
    return { version: expected.version, name: expected.name, sha256: hash, applied: false };
  }
  const predecessor = record(connection, expected.version - 1);
  if (!predecessor || Number((connection.prepare("SELECT COALESCE(MAX(version),0) version FROM schema_migrations").get() as Record<string, unknown>).version) !== expected.version - 1) {
    throw new AuthorityIntegrityError(`Migration ${expected.version} requires exact predecessor ${expected.version - 1}`);
  }
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(bytes.toString("utf8")); onFault?.(expected.version, "after-schema");
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)")
      .run(expected.version, expected.name, hash, nowMs);
    onFault?.(expected.version, "after-migration-record"); onFault?.(expected.version, "before-commit");
    connection.exec("COMMIT");
    return { version: expected.version, name: expected.name, sha256: hash, applied: true };
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
    if (error instanceof AuthorityIntegrityError || error instanceof MigrationHashMismatchError) throw error;
    throw new AuthorityIntegrityError(`Migration ${expected.version} failed atomically`, error);
  }
}

export function migrateHarnessPostStore(
  connection: AuthorityConnection,
  sqlRoot: string,
  nowMs = Date.now(),
  onFault?: (version: number, point: HarnessPostMigrationFaultPoint) => void,
): readonly MigrationResult[] {
  return harnessPostMigrations.map((entry) => applyOne(connection, resolve(sqlRoot, entry.name), entry, nowMs, onFault));
}
