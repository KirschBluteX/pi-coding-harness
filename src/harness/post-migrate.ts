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
  { version: 20, name: "020_authority_acceptance_v2.sql" },
  { version: 21, name: "021_intake_decision_goal_fit_v2.sql" },
  { version: 22, name: "022_plan_change_invalidation_v2.sql" },
  { version: 23, name: "023_dynamic_multi_v2.sql" },
  { version: 24, name: "024_active_goal_change_intake_v2.sql" },
  { version: 25, name: "025_goal_fit_assessment_v2.sql" },
  { version: 26, name: "026_goal_fit_review_identity_v2.sql", foreignKeys: "SUSPEND_FOR_TABLE_REBUILD" },
  { version: 27, name: "027_change_acceptance_v2.sql" },
  { version: 28, name: "028_dynamic_multi_execution_v2.sql" },
  { version: 29, name: "029_provider_call_plan_v2.sql" },
  { version: 30, name: "030_provider_turn_goal_binding_v1.sql" },
  { version: 31, name: "031_dynamic_multi_integration_journal_v2.sql" },
  { version: 32, name: "032_strong_single_rollout_registry_v1.sql" },
  { version: 33, name: "033_workload_comparability_v1.sql" },
  { version: 34, name: "034_dynamic_multi_proposal_v2.sql" },
  { version: 35, name: "035_session_goal_binding_v1.sql" },
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
  const rebuildsReferencedTable = "foreignKeys" in expected
    && expected.foreignKeys === "SUSPEND_FOR_TABLE_REBUILD";
  if (rebuildsReferencedTable) {
    connection.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
    const foreignKeys = connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown };
    const legacyAlterTable = connection.prepare("PRAGMA legacy_alter_table").get() as { legacy_alter_table?: unknown };
    if (Number(foreignKeys.foreign_keys) !== 0 || Number(legacyAlterTable.legacy_alter_table) !== 1) {
      throw new AuthorityIntegrityError(`Migration ${expected.version} could not enter table-rebuild mode`);
    }
  }
  let failure: unknown;
  let restorationFailure: AuthorityIntegrityError | null = null;
  try {
    connection.exec("BEGIN IMMEDIATE");
    connection.exec(bytes.toString("utf8")); onFault?.(expected.version, "after-schema");
    if (rebuildsReferencedTable && connection.prepare("PRAGMA foreign_key_check").get()) {
      throw new AuthorityIntegrityError(`Migration ${expected.version} produced a foreign-key violation`);
    }
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)")
      .run(expected.version, expected.name, hash, nowMs);
    onFault?.(expected.version, "after-migration-record"); onFault?.(expected.version, "before-commit");
    connection.exec("COMMIT");
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
    failure = error;
  } finally {
    if (rebuildsReferencedTable) {
      connection.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
      const foreignKeys = connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown };
      const legacyAlterTable = connection.prepare("PRAGMA legacy_alter_table").get() as { legacy_alter_table?: unknown };
      if (Number(foreignKeys.foreign_keys) !== 1 || Number(legacyAlterTable.legacy_alter_table) !== 0) {
        restorationFailure = new AuthorityIntegrityError(
          `Migration ${expected.version} failed to restore foreign-key enforcement`,
        );
      }
    }
  }
  if (restorationFailure) throw restorationFailure;
  if (failure instanceof AuthorityIntegrityError || failure instanceof MigrationHashMismatchError) throw failure;
  if (failure) throw new AuthorityIntegrityError(`Migration ${expected.version} failed atomically`, failure);
  return { version: expected.version, name: expected.name, sha256: hash, applied: true };
}

export function migrateHarnessPostStore(
  connection: AuthorityConnection,
  sqlRoot: string,
  nowMs = Date.now(),
  onFault?: (version: number, point: HarnessPostMigrationFaultPoint) => void,
  throughVersion: number = harnessPostMigrations.at(-1)!.version,
): readonly MigrationResult[] {
  if (!Number.isSafeInteger(throughVersion) || throughVersion < harnessPostMigrations[0].version
    || throughVersion > harnessPostMigrations.at(-1)!.version) {
    throw new AuthorityIntegrityError("Harness post-migration target version is invalid");
  }
  return harnessPostMigrations.filter((entry) => entry.version <= throughVersion)
    .map((entry) => applyOne(connection, resolve(sqlRoot, entry.name), entry, nowMs, onFault));
}
