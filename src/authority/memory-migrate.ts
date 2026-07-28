import { resolve } from "node:path";
import type { AuthorityConnection } from "./database.js";
import { applyForwardMigration, type MigrationResult } from "./migrate.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

export type MemoryIndexMode = "FTS5" | "TAG_PATH";

export interface MemoryMigrationOptions {
  readonly structuredPath?: string;
  readonly ftsPath?: string;
  readonly claimsPath?: string;
  readonly claimsFtsPath?: string;
  readonly checkpointPath?: string;
  readonly vaultPath?: string;
  readonly lifecyclePath?: string;
  readonly captureV31Path?: string;
  readonly forceIndexMode?: MemoryIndexMode;
  readonly nowMs?: number;
}

export interface MemoryMigrationResult {
  readonly structured: MigrationResult;
  readonly fts: MigrationResult | null;
  readonly claims: MigrationResult;
  readonly claimsFts: MigrationResult | null;
  readonly checkpoint: MigrationResult;
  readonly vault: MigrationResult;
  readonly lifecycle: MigrationResult;
  readonly captureV31: MigrationResult;
  readonly indexMode: MemoryIndexMode;
}

export function probeMemoryFts5(connection: AuthorityConnection): boolean {
  try {
    connection.exec("CREATE VIRTUAL TABLE temp.__pch_memory_fts_probe USING fts5(content)");
    connection.exec("DROP TABLE temp.__pch_memory_fts_probe");
    return true;
  } catch {
    try { connection.exec("DROP TABLE IF EXISTS temp.__pch_memory_fts_probe"); } catch { /* Probe cleanup only. */ }
    return false;
  }
}

export function migrateMemoryStore(
  connection: AuthorityConnection,
  options: MemoryMigrationOptions = {},
): MemoryMigrationResult {
  const experiments = connection.prepare("SELECT name FROM schema_migrations WHERE version=2").get() as { name?: unknown } | undefined;
  if (experiments?.name !== "002_experiments.sql") {
    throw new AuthorityIntegrityError("Memory migration requires verified experiment migration 002");
  }
  const nowMs = options.nowMs ?? Date.now();
  const structured = applyForwardMigration(
    connection,
    3,
    options.structuredPath ?? resolve("schemas", "sql", "003_memory.sql"),
    nowMs,
  );
  const indexMode = options.forceIndexMode ?? (probeMemoryFts5(connection) ? "FTS5" : "TAG_PATH");
  const fts = indexMode === "FTS5"
    ? applyForwardMigration(connection, 4, options.ftsPath ?? resolve("schemas", "sql", "004_memory_fts.sql"), nowMs)
    : null;
  const claims = applyForwardMigration(
    connection,
    5,
    options.claimsPath ?? resolve("schemas", "sql", "005_memory_claims.sql"),
    nowMs,
  );
  const claimsFts = indexMode === "FTS5"
    ? applyForwardMigration(connection, 6, options.claimsFtsPath ?? resolve("schemas", "sql", "006_memory_claims_fts.sql"), nowMs)
    : null;
  const checkpoint = applyForwardMigration(
    connection,
    7,
    options.checkpointPath ?? resolve("schemas", "sql", "007_memory_checkpoint.sql"),
    nowMs,
  );
  const vault = applyForwardMigration(
    connection,
    8,
    options.vaultPath ?? resolve("schemas", "sql", "008_memory_v3_vault.sql"),
    nowMs,
  );
  const lifecycle = applyForwardMigration(
    connection,
    9,
    options.lifecyclePath ?? resolve("schemas", "sql", "009_memory_v3_lifecycle.sql"),
    nowMs,
  );
  const captureV31 = applyForwardMigration(
    connection,
    10,
    options.captureV31Path ?? resolve("schemas", "sql", "010_memory_v3_1_capture.sql"),
    nowMs,
  );
  return { structured, fts, claims, claimsFts, checkpoint, vault, lifecycle, captureV31, indexMode };
}
