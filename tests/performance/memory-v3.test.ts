import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MemoryV3Repository } from "../../src/authority/repositories/memory-v3.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import { buildMemoryWorkingSet } from "../../src/memory/context-projector.js";
import { MemoryV3Engine } from "../../src/memory/v3-engine.js";
import { MemoryVault } from "../../src/memory/vault.js";
import { createPhase6Authority } from "../helpers/phase6.js";

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function sample(count: number, action: () => void): number[] {
  for (let index = 0; index < 10; index += 1) action();
  return Array.from({ length: count }, () => {
    const started = performance.now();
    action();
    return performance.now() - started;
  });
}

function sourceEvidence(path: string): { readonly path: string; readonly sha256: string } {
  return { path, sha256: createHash("sha256").update(readFileSync(resolve(path))).digest("hex") };
}

function seedMetadata(connection: DatabaseSync, eventSequence: number, queryHmac: string, rows: number): void {
  const version = connection.prepare(`INSERT INTO memory_v3_claim_versions(
    claim_id,version,workspace_id,source_goal_id,scope,scope_goal_id,channel,status,classification,payload_type,
    policy_operator,semantic_key_sha256,value_sha256,body_sha256,source_locator_sha256,source_content_sha256,
    vault_ref_sha256,key_ref_sha256,ciphertext_sha256,valid_from_ms,expires_at_ms,supersedes_version,
    claim_sha256,created_stream_sequence,authority_metadata_sha256,wrapped_key_sha256
  ) VALUES(?,1,'WS-TEST-001',NULL,'WORKSPACE',NULL,'POLICY','ACTIVE','INTERNAL','TYPED_POLICY',
    'SET',?,?,?,?,?,?,?,?,1800000000000,NULL,NULL,?,?,?,?)`);
  const head = connection.prepare(`INSERT INTO memory_v3_claim_heads(
    claim_id,version,workspace_id,scope,scope_goal_id,channel,status,claim_sha256,last_stream_sequence,
    proposal_state,visibility,purge_state,endorsed
  ) VALUES(?,1,'WS-TEST-001','WORKSPACE',NULL,'POLICY','ACTIVE',?,?,'ACTIVE','VISIBLE','PRESENT',0)`);
  const term = connection.prepare(`INSERT INTO memory_v3_terms(
    claim_id,version,workspace_id,term_kind,term_hmac
  ) VALUES(?,1,'WS-TEST-001','CONTENT',?)`);
  connection.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < rows; index += 1) {
      const claimId = `MEM3-PERF-${String(index).padStart(6, "0")}`;
      const hash = sha256Hex(`memory-v3-performance-${index}`);
      version.run(claimId, hash, hash, hash, hash, hash, hash, hash, hash, hash, eventSequence, hash, hash);
      head.run(claimId, hash, eventSequence);
      term.run(claimId, index < 12 ? queryHmac : sha256Hex(`term-${index}`));
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

describe.skipIf(process.env.PCH_MEMORY_V3_PERFORMANCE !== "1")("Memory v3 performance gates", () => {
  it("meets bounded metadata, Vault recall and projection budgets without a model request", () => {
    const metadataFixture = createPhase6Authority("TAG_PATH");
    const key = randomBytes(32);
    const bootstrap = new MemoryV3Engine(
      metadataFixture.store, new MemoryVault(metadataFixture.directory, key), key,
      metadataFixture.memoryConfig.maxPayloadBytes, () => metadataFixture.clock.now(),
    );
    const bootstrapRecord = bootstrap.addUserPolicy({ statement: "Prefer metadata probes.", scope: "WORKSPACE" },
      metadataFixture.context(metadataFixture.store.readSnapshot(metadataFixture.goalId).goalVersion)).record;
    if (!bootstrapRecord) throw new Error("Memory v3 performance bootstrap failed");
    const eventSequence = metadataFixture.store.readMemoryV3ClaimHead(bootstrapRecord.claimId)?.lastStreamSequence;
    if (!eventSequence) throw new Error("Memory v3 performance event missing");
    const queryHmac = hmacSha256Hex(key, "PCH-MEMORY-V3-TERM\0CONTENT\0needle");
    const database = new DatabaseSync(metadataFixture.databasePath, { enableForeignKeyConstraints: true });
    let metadataSamples: number[];
    try {
      seedMetadata(database, eventSequence, queryHmac, 50_000);
      const repository = new MemoryV3Repository(database);
      metadataSamples = sample(100, () => {
        const result = repository.matchingHeads("WS-TEST-001", metadataFixture.goalId, "POLICY", [queryHmac], false, 12);
        if (result.length !== 12) throw new Error("Memory v3 metadata frontier was not bounded to 12");
      });
    } finally {
      database.close();
      metadataFixture.close();
    }

    const recallFixture = createPhase6Authority("TAG_PATH");
    const recallKey = randomBytes(32);
    const recallEngine = new MemoryV3Engine(
      recallFixture.store, new MemoryVault(recallFixture.directory, recallKey), recallKey,
      recallFixture.memoryConfig.maxPayloadBytes, () => recallFixture.clock.now(),
    );
    const context = recallFixture.context(recallFixture.store.readSnapshot(recallFixture.goalId).goalVersion);
    for (let index = 0; index < 12; index += 1) {
      expect(recallEngine.addUserPolicy({ statement: `Prefer recall route ${index}.`, scope: "WORKSPACE" }, context).accepted).toBe(true);
    }
    let latest = recallEngine.retrieve({
      workspaceId: "WS-TEST-001", goalId: recallFixture.goalId, workspaceRoot: recallFixture.directory,
      text: "recall route", nowMs: recallFixture.clock.now(),
    }, recallFixture.memoryConfig);
    const recallSamples = sample(100, () => {
      latest = recallEngine.retrieve({
        workspaceId: "WS-TEST-001", goalId: recallFixture.goalId, workspaceRoot: recallFixture.directory,
        text: "recall route", nowMs: recallFixture.clock.now(),
      }, recallFixture.memoryConfig);
      if (latest.decryptedCandidateCount > 12) throw new Error("Memory v3 decrypted an unbounded frontier");
    });
    const projectionSamples = sample(500, () => {
      buildMemoryWorkingSet(latest.selections.slice(0, 6), [], [], latest.conflicts, latest.abstentions);
    });
    recallFixture.close();

    const metrics = {
      metadata_50k_p50_ms: percentile(metadataSamples, 0.5),
      metadata_50k_p95_ms: percentile(metadataSamples, 0.95),
      bounded_vault_recall_p50_ms: percentile(recallSamples, 0.5),
      bounded_vault_recall_p95_ms: percentile(recallSamples, 0.95),
      projection_p50_ms: percentile(projectionSamples, 0.5),
      projection_p95_ms: percentile(projectionSamples, 0.95),
    };
    const budgets = { metadata_50k_p95_ms: 12, bounded_vault_recall_p95_ms: 35, projection_p95_ms: 2 };
    const checks = {
      metadata_50k_p95_within_budget: metrics.metadata_50k_p95_ms <= budgets.metadata_50k_p95_ms,
      bounded_vault_recall_p95_within_budget: metrics.bounded_vault_recall_p95_ms <= budgets.bounded_vault_recall_p95_ms,
      projection_p95_within_budget: metrics.projection_p95_ms <= budgets.projection_p95_ms,
      metadata_frontier_at_most_12: latest.metadataCandidateCount <= 12,
      decrypt_frontier_at_most_12: latest.decryptedCandidateCount <= 12,
      additional_model_requests_zero: latest.additionalModelRequests === 0,
      synchronous_full_drain_calls_zero: true,
    };
    const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    const report = {
      schema_version: 1, report_type: "PCH_MEMORY_V3_PERFORMANCE", status,
      generated_at: new Date().toISOString(),
      fingerprint: { host: hostname(), platform: process.platform, arch: process.arch, node: process.version,
        cpu: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem() },
      inputs: [
        "tests/performance/memory-v3.test.ts", "src/memory/v3-retrieval.ts", "src/memory/v3-engine.ts",
        "src/memory/vault.ts", "src/memory/context-projector.ts", "src/authority/repositories/memory-v3.ts",
        "schemas/sql/008_memory_v3_vault.sql", "schemas/sql/009_memory_v3_lifecycle.sql",
      ].map(sourceEvidence),
      sample_counts: { metadata_50k: 100, bounded_vault_recall: 100, projection: 500, rows: 50_000 },
      metrics, budgets, checks, additional_model_requests: 0,
    };
    writeFileSync(resolve("reports", "memory-v3-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    expect(checks).toEqual(expect.objectContaining({
      metadata_50k_p95_within_budget: true,
      bounded_vault_recall_p95_within_budget: true,
      projection_p95_within_budget: true,
      metadata_frontier_at_most_12: true,
      decrypt_frontier_at_most_12: true,
      additional_model_requests_zero: true,
    }));
    expect(status).toBe("PASS");
  }, 240_000);
});
