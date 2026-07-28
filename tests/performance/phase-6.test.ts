import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { Phase6Authority } from "../helpers/phase6.js";
import { createPhase6Authority } from "../helpers/phase6.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import { declaredPerformanceRoot } from "../helpers/performance-root.js";

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function sample(count: number, action: () => void): number[] {
  return Array.from({ length: count }, () => {
    const started = performance.now();
    action();
    return performance.now() - started;
  });
}

function seed(authority: Phase6Authority, count: number, mode: "FTS5" | "TAG_PATH", needle: string): string {
  const target = authority.memory.addUserPolicy({
    statement: `${needle} representative memory`, scope: "WORKSPACE", tags: [needle],
  }, authority.context(3));
  if (!target.accepted || !target.record) throw new Error(`Unable to seed benchmark target: ${target.reason}`);
  if (mode === "FTS5") authority.memory.drainIndex();
  const db = new DatabaseSync(authority.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const version = db.prepare(`INSERT INTO memory_claim_versions(
      claim_id,version,workspace_id,actor_goal_id,scope,scope_goal_id,channel,status,payload_json,payload_sha256,
      source_attestation_json,source_attestation_sha256,tags_json,path_key,dependency_keys_json,classification,
      valid_from_ms,expires_at_ms,supersedes_version,content_text,content_sha256,content_token_estimate,
      claim_sha256,created_event_sequence
    ) VALUES(?,1,'WS-TEST-001',?,'WORKSPACE',NULL,'POLICY','ACTIVE',?,?,?,?,?,NULL,'[]','INTERNAL',?,NULL,NULL,?,?,8,?,3)`);
    const head = db.prepare(`INSERT INTO memory_claim_heads(
      claim_id,version,workspace_id,scope,scope_goal_id,channel,status,claim_sha256,last_event_sequence
    ) VALUES(?,1,'WS-TEST-001','WORKSPACE',NULL,'POLICY','ACTIVE',?,3)`);
    const term = db.prepare("INSERT INTO memory_claim_terms(claim_id,version,workspace_id,term_kind,term) VALUES(?,1,'WS-TEST-001','TAG',?)");
    const fts = mode === "FTS5" ? db.prepare(`INSERT INTO memory_claims_fts(
      claim_id,version,workspace_id,scope_goal_id,channel,tags,cjk_ngrams,content
    ) VALUES(?,1,'WS-TEST-001',NULL,'POLICY',?,'',?)`) : null;
    for (let index = 1; index < count; index += 1) {
      const id = `MEM-P6-${String(index).padStart(6, "0")}`;
      const tag = `topic-${index}`;
      const content = `representative memory ${index}`;
      const hash = index.toString(16).padStart(64, "0").slice(-64);
      const payload = JSON.stringify({ type: "TYPED_POLICY", policyKind: "PREFERENCE", statement: content, appliesTo: [tag] });
      version.run(id, authority.goalId, payload, hash, "{}", hash, JSON.stringify([tag]), 1_800_000_000_000 + index, content, hash, hash);
      head.run(id, hash);
      term.run(id, tag);
      fts?.run(id, tag, content);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return target.record.claimId;
}

const enabled = process.env.PCH_PHASE6_PERFORMANCE === "1";
const authorities: Phase6Authority[] = [];
afterAll(() => { for (const authority of authorities) authority.close(); });

describe.skipIf(!enabled)("Phase 6 Memory budgets", () => {
  it("meets disabled, TAG_PATH and FTS5 P95 budgets at 50k rows", () => {
    const performanceRoot = declaredPerformanceRoot("phase-6");
    const disabledAuthority = createPhase6Authority("TAG_PATH", false, "OFF", performanceRoot.epochRoot);
    const tagAuthority = createPhase6Authority("TAG_PATH", true, "EXPERIMENTAL", performanceRoot.epochRoot);
    const ftsAuthority = createPhase6Authority("FTS5", true, "EXPERIMENTAL", performanceRoot.epochRoot);
    authorities.push(disabledAuthority, tagAuthority, ftsAuthority);
    const tagTargetId = seed(tagAuthority, 50_000, "TAG_PATH", "needle-fallback");
    const ftsTargetId = seed(ftsAuthority, 50_000, "FTS5", "needle-fts");
    const disabled = new MemoryEngine(disabledAuthority.store, { ...disabledAuthority.memoryConfig, enabled: false });

    const samples = {
      disabled_ms: sample(100, () => disabled.retrieve({ workspaceId: "WS-TEST-001", goalId: disabledAuthority.goalId, workspaceRoot: disabledAuthority.directory, text: "none", nowMs: 1_900_000_000_000 })),
      tag_path_50k_ms: sample(100, () => tagAuthority.memory.retrieve({ workspaceId: "WS-TEST-001", goalId: tagAuthority.goalId, workspaceRoot: tagAuthority.directory, text: "needle-fallback", nowMs: 1_900_000_000_000 })),
      fts_50k_ms: sample(100, () => ftsAuthority.memory.retrieve({ workspaceId: "WS-TEST-001", goalId: ftsAuthority.goalId, workspaceRoot: ftsAuthority.directory, text: "needle-fts", nowMs: 1_900_000_000_000 })),
    };
    expect(tagAuthority.memory.retrieve({ workspaceId: "WS-TEST-001", goalId: tagAuthority.goalId, workspaceRoot: tagAuthority.directory, text: "needle-fallback", nowMs: 1_900_000_000_000 }).selected[0]?.claimId).toBe(tagTargetId);
    expect(ftsAuthority.memory.retrieve({ workspaceId: "WS-TEST-001", goalId: ftsAuthority.goalId, workspaceRoot: ftsAuthority.directory, text: "needle-fts", nowMs: 1_900_000_000_000 }).selected[0]?.claimId).toBe(ftsTargetId);
    const metrics = {
      disabled_p95_ms: percentile(samples.disabled_ms, 0.95),
      tag_path_50k_p95_ms: percentile(samples.tag_path_50k_ms, 0.95),
      fts_50k_p95_ms: percentile(samples.fts_50k_ms, 0.95),
      additional_model_requests: 0,
    };
    const budgets = { disabled_p95_ms: 1, tag_path_50k_p95_ms: 15, fts_50k_p95_ms: 25 };
    const status = Object.entries(budgets).every(([key, budget]) => metrics[key as keyof typeof metrics] <= budget) ? "PASS" : "FAIL";
    const report = {
      schema_version: 1, phase: "PHASE-06", status, epoch: `P6-${Date.now()}`,
      fingerprint: { host: hostname(), platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), authority_data_root: performanceRoot.dataRoot, authority_data_root_source: performanceRoot.dataRootSource, authority_database_volume_root: parse(tagAuthority.databasePath).root, source_project_volume_root: parse(resolve(".")).root, sqlite_durability: "WAL_SYNCHRONOUS_FULL" },
      sample_counts: { disabled: 100, tag_path_50k: 100, fts_50k: 100, rows_per_enabled_store: 50_000 },
      samples, metrics, budgets, additional_model_requests: 0,
    };
    mkdirSync(resolve("reports"), { recursive: true });
    writeFileSync(resolve("reports", "phase-6-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    expect(status).toBe("PASS");
  }, 180_000);
});
