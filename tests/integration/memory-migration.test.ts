import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { applyForwardMigration } from "../../src/authority/migrate.js";
import { migrateMemoryStore, probeMemoryFts5 } from "../../src/authority/memory-migrate.js";
import { AuthorityStore } from "../../src/authority/transactions.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import type { MemoryEngineConfig } from "../../src/memory/types.js";
import { TestClock, createGoalCommand } from "../helpers/authority.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function paths() {
  return {
    structuredPath: resolve("schemas", "sql", "003_memory.sql"),
    ftsPath: resolve("schemas", "sql", "004_memory_fts.sql"),
    claimsPath: resolve("schemas", "sql", "005_memory_claims.sql"),
    claimsFtsPath: resolve("schemas", "sql", "006_memory_claims_fts.sql"),
    checkpointPath: resolve("schemas", "sql", "007_memory_checkpoint.sql"),
    vaultPath: resolve("schemas", "sql", "008_memory_v3_vault.sql"),
    lifecyclePath: resolve("schemas", "sql", "009_memory_v3_lifecycle.sql"),
    captureV31Path: resolve("schemas", "sql", "010_memory_v3_1_capture.sql"),
  };
}

function config(mode: MemoryEngineConfig["mode"] = "EXPLICIT_ONLY"): MemoryEngineConfig {
  return {
    enabled: mode !== "OFF", mode, epoch: "MEMORY-V2-MIGRATION", softProjectionTokens: 600,
    hardProjectionTokens: 1200, maxResults: 12, maxPolicyResults: 6, maxEvidenceResults: 4,
    maxExperienceResults: 2, maxStructuredScanRows: 5000, maxPayloadBytes: 1_048_576,
    indexDrainBatch: 128, indexDrainDebounceMs: 50,
  };
}

describe("Memory v2 forward-only migration", () => {
  it("upgrades a verified version-8 store without changing migration 008", () => {
    const root = mkdtempSync(join(tmpdir(), "pch-memory-v3-v8-upgrade-"));
    directories.push(root);
    const connection = openAuthorityConnection({ path: join(root, "authority.sqlite3") });
    try {
      applyForwardMigration(connection, 1, resolve("schemas", "sql", "001_core.sql"), 1);
      applyForwardMigration(connection, 2, resolve("schemas", "sql", "002_experiments.sql"), 2);
      applyForwardMigration(connection, 3, paths().structuredPath, 3);
      applyForwardMigration(connection, 5, paths().claimsPath, 5);
      applyForwardMigration(connection, 7, paths().checkpointPath, 7);
      const version8 = applyForwardMigration(connection, 8, paths().vaultPath, 8);
      const upgraded = migrateMemoryStore(connection, { ...paths(), forceIndexMode: "TAG_PATH", nowMs: 9 });
      expect(upgraded.vault).toMatchObject({ version: 8, sha256: version8.sha256, applied: false });
      expect(upgraded.lifecycle).toMatchObject({ version: 9, applied: true });
      expect(upgraded.captureV31).toMatchObject({ version: 10, applied: true });
      expect(connection.prepare("SELECT sha256 FROM schema_migrations WHERE version=8").get())
        .toEqual({ sha256: version8.sha256 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("applies the Memory v3.1 authority migrations through version 10 with and without FTS", () => {
    const root = mkdtempSync(join(tmpdir(), "pch-memory-v2-migration-"));
    directories.push(root);
    const connection = openAuthorityConnection({ path: join(root, "authority.sqlite3") });
    try {
      applyForwardMigration(connection, 1, resolve("schemas", "sql", "001_core.sql"), 1);
      applyForwardMigration(connection, 2, resolve("schemas", "sql", "002_experiments.sql"), 2);
      const noFts = migrateMemoryStore(connection, { ...paths(), forceIndexMode: "TAG_PATH", nowMs: 3 });
      expect(noFts).toMatchObject({ indexMode: "TAG_PATH", structured: { version: 3 }, fts: null, claims: { version: 5 }, claimsFts: null, checkpoint: { version: 7 }, vault: { version: 8 }, lifecycle: { version: 9 }, captureV31: { version: 10 } });
      expect(connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 10 });
      if (probeMemoryFts5(connection)) {
        const withFts = migrateMemoryStore(connection, { ...paths(), forceIndexMode: "FTS5", nowMs: 4 });
        expect(withFts).toMatchObject({ indexMode: "FTS5", fts: { version: 4 }, claimsFts: { version: 6 }, checkpoint: { version: 7 }, vault: { version: 8 }, lifecycle: { version: 9 }, captureV31: { version: 10 } });
        expect(connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 10 });
      }
    } finally { closeAuthorityConnection(connection); }
  });

  it("does not apply optional Memory migrations while the module is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "pch-memory-v2-disabled-"));
    directories.push(root);
    const databasePath = join(root, "authority.sqlite3");
    const store = AuthorityStore.open({ databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql") });
    store.close();
    const connection = openAuthorityConnection({ path: databasePath });
    try {
      expect(connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 2 });
      expect(connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_claim_versions'").get()).toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("recovers attested claims and exact recall after reopening", () => {
    const root = mkdtempSync(join(tmpdir(), "pch-memory-v2-reopen-"));
    directories.push(root);
    const databasePath = join(root, "authority.sqlite3");
    const clock = new TestClock();
    const goalId = "GOAL-MEMORY-V2-REOPEN";
    let store = AuthorityStore.open({
      databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: { ...paths(), forceIndexMode: "TAG_PATH", nowMs: clock.now() }, clock,
    });
    store.transact(createGoalCommand(goalId), { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const lease = store.acquireLease(goalId, "SESSION-MEMORY-V2-REOPEN", 60_000);
    const engine = new MemoryEngine(store, config(), () => clock.now());
    const added = engine.addUserPolicy({ statement: "Reopen keeps attested Memory.", scope: "WORKSPACE", tags: ["reopen"] }, {
      goalId, workspaceId: "WS-TEST-001", workspaceRoot: root,
      mutation: { expectedVersion: 1, idempotencyKey: "add", actor: "USER", lease },
    });
    const claimId = added.record?.claimId ?? "";
    store.close();

    store = AuthorityStore.open({
      databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: { ...paths(), forceIndexMode: "TAG_PATH", nowMs: clock.now() }, clock,
    });
    try {
      const recovered = new MemoryEngine(store, config(), () => clock.now());
      expect(store.readMemoryClaim(claimId)).toMatchObject({ claimId, version: 1, status: "ACTIVE" });
      expect(recovered.retrieve({
        workspaceId: "WS-TEST-001", goalId, workspaceRoot: root, text: "", tags: ["reopen"], nowMs: clock.now(),
      }).selected.map((entry) => entry.claimId)).toEqual([claimId]);
    } finally { store.close(); }
  });

  it("quarantines v1 heads instead of silently trusting them", () => {
    const root = mkdtempSync(join(tmpdir(), "pch-memory-v1-quarantine-"));
    directories.push(root);
    const databasePath = join(root, "authority.sqlite3");
    const base = AuthorityStore.open({ databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql") });
    const goalId = "GOAL-MEMORY-V1";
    base.transact(createGoalCommand(goalId), { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    base.close();
    const connection = openAuthorityConnection({ path: databasePath });
    try {
      applyForwardMigration(connection, 3, paths().structuredPath, 3);
      connection.prepare(`INSERT INTO memory_versions(
        memory_id,version,workspace_id,goal_id,kind,scope,status,source_kind,source_locator,source_sha256,
        tags_json,path_key,dependency_keys_json,pinned,content_text,content_artifact_id,content_sha256,
        content_token_estimate,confidence_basis,classification,valid_from_ms,expires_at_ms,supersedes_version,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`).run(
        "MEM-V1", 1, "WS-TEST-001", goalId, "PREFERENCE", "GLOBAL", "ACTIVE", "USER_EXPLICIT",
        "pch-user://legacy", "a".repeat(64), "[]", null, "[]", 1, "legacy", "b".repeat(64), 2,
        "USER_CONFIRMED", "INTERNAL", 1, null, null, 1,
      );
      migrateMemoryStore(connection, { ...paths(), forceIndexMode: "TAG_PATH", nowMs: 5 });
      expect(connection.prepare("SELECT disposition,legacy_scope FROM memory_legacy_dispositions WHERE memory_id='MEM-V1'").get())
        .toEqual({ disposition: "QUARANTINED_V1", legacy_scope: "GLOBAL" });
      expect(connection.prepare("SELECT count(*) AS count FROM memory_claim_versions").get()).toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });
});
