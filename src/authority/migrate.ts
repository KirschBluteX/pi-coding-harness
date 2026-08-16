import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuthorityConnection } from "./database.js";
import { sha256Hex } from "../foundation/crypto.js";
import { createId } from "../foundation/ids.js";
import { AuthorityIntegrityError, MigrationHashMismatchError } from "../foundation/errors.js";

export const SUPPORTED_MIGRATION_VERSION = 35;

export interface MigrationResult {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly applied: boolean;
}

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(table) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

export function assertSupportedMigrationVersion(
  connection: AuthorityConnection,
  supportedVersion = SUPPORTED_MIGRATION_VERSION,
): number {
  if (!tableExists(connection, "schema_migrations")) return 0;
  const row = connection.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get() as {
    version?: unknown;
  } | undefined;
  const version = Number(row?.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new AuthorityIntegrityError("Store migration version is invalid");
  }
  if (version > supportedVersion) {
    throw new AuthorityIntegrityError(
      `Store migration version ${version} is newer than runtime support ${supportedVersion}`,
    );
  }
  return version;
}

export function applyForwardMigration(
  connection: AuthorityConnection,
  version: number,
  migrationPath: string,
  nowMs = Date.now(),
): MigrationResult {
  const absolutePath = resolve(migrationPath);
  const bytes = readFileSync(absolutePath);
  const hash = sha256Hex(bytes);
  const name = basename(absolutePath);
  if (tableExists(connection, "schema_migrations")) {
    const recorded = connection.prepare("SELECT name, sha256 FROM schema_migrations WHERE version=?").get(version) as { name?: unknown; sha256?: unknown } | undefined;
    if (recorded) {
      if (typeof recorded.sha256 !== "string" || typeof recorded.name !== "string") {
        throw new AuthorityIntegrityError(`Migration ${version} record has invalid field types`);
      }
      const recordedHash = recorded.sha256;
      if (recordedHash !== hash) throw new MigrationHashMismatchError(version, recordedHash, hash);
      if (recorded.name !== name) throw new AuthorityIntegrityError(`Migration ${version} name mismatch`);
      return { version, name, sha256: hash, applied: false };
    }
  }
  try {
    connection.exec(bytes.toString("utf8"));
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* SQLite already rolled back or no transaction remains. */ }
    throw new AuthorityIntegrityError(`Migration ${version} failed`, error);
  }
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare("INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(?,?,?,?)").run(version, name, hash, nowMs);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw new AuthorityIntegrityError(`Migration ${version} record failed`, error);
  }
  return { version, name, sha256: hash, applied: true };
}

export function initializeCoreStore(
  connection: AuthorityConnection,
  options: { readonly storeId?: string; readonly nowMs?: number } = {},
): { storeId: string; storeGeneration: number; leaderEpoch: number } {
  const core = connection.prepare("SELECT name,sha256 FROM schema_migrations WHERE version=1").get() as {
    name?: unknown;
    sha256?: unknown;
  } | undefined;
  if (core?.name !== "001_core.sql" || typeof core.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(core.sha256)) {
    throw new AuthorityIntegrityError("Core store requires a valid migration version 1 record");
  }
  const existing = connection.prepare("SELECT store_id,store_generation,leader_epoch,schema_version FROM store_meta WHERE singleton=1").get() as {
    store_id?: unknown; store_generation?: unknown; leader_epoch?: unknown; schema_version?: unknown;
  } | undefined;
  if (existing) {
    if (Number(existing.schema_version) !== 1) throw new AuthorityIntegrityError("Store schema version is not supported");
    return {
      storeId: String(existing.store_id),
      storeGeneration: Number(existing.store_generation),
      leaderEpoch: Number(existing.leader_epoch),
    };
  }
  const storeId = options.storeId ?? createId("STORE");
  connection.prepare("INSERT INTO store_meta(singleton,store_id,schema_version,store_generation,leader_epoch,created_at_ms) VALUES(1,?,1,1,1,?)")
    .run(storeId, options.nowMs ?? Date.now());
  return { storeId, storeGeneration: 1, leaderEpoch: 1 };
}

export function migrateCoreStore(connection: AuthorityConnection, migrationPath: string, nowMs = Date.now()): MigrationResult {
  assertSupportedMigrationVersion(connection);
  const result = applyForwardMigration(connection, 1, migrationPath, nowMs);
  assertSupportedMigrationVersion(connection);
  initializeCoreStore(connection, { nowMs });
  return result;
}
