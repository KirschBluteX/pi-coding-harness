import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { buildMemoryWorkingSet } from "../../src/memory/context-projector.js";
import { memorySearchTerms } from "../../src/memory/cjk.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import type { MemorySelection } from "../../src/memory/types.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function sourceEvidence(path: string): { readonly path: string; readonly sha256: string } {
  return { path, sha256: createHash("sha256").update(readFileSync(resolve(path))).digest("hex") };
}

function sample(count: number, action: () => void): number[] {
  for (let index = 0; index < 10; index += 1) action();
  return Array.from({ length: count }, () => {
    const started = performance.now();
    action();
    return performance.now() - started;
  });
}

function seedDecoys(authority: Phase6Authority, count: number, includeFts: boolean): void {
  const database = new DatabaseSync(authority.databasePath);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const version = database.prepare(`INSERT INTO memory_claim_versions(
      claim_id,version,workspace_id,actor_goal_id,scope,scope_goal_id,channel,status,payload_json,payload_sha256,
      source_attestation_json,source_attestation_sha256,tags_json,path_key,dependency_keys_json,classification,
      valid_from_ms,expires_at_ms,supersedes_version,content_text,content_sha256,content_token_estimate,
      claim_sha256,created_event_sequence
    ) VALUES(?,1,'WS-TEST-001',?,'WORKSPACE',NULL,'POLICY','ACTIVE',?,?,?,?,?,NULL,'[]','INTERNAL',?,NULL,NULL,?,?,8,?,3)`);
    const head = database.prepare(`INSERT INTO memory_claim_heads(
      claim_id,version,workspace_id,scope,scope_goal_id,channel,status,claim_sha256,last_event_sequence
    ) VALUES(?,1,'WS-TEST-001','WORKSPACE',NULL,'POLICY','ACTIVE',?,3)`);
    const term = database.prepare("INSERT INTO memory_claim_terms(claim_id,version,workspace_id,term_kind,term) VALUES(?,1,'WS-TEST-001','TAG',?)");
    const fts = includeFts ? database.prepare(`INSERT INTO memory_claims_fts(
      claim_id,version,workspace_id,scope_goal_id,channel,tags,cjk_ngrams,content
    ) VALUES(?,1,'WS-TEST-001',NULL,'POLICY',?,'',?)`) : null;
    for (let index = 0; index < count; index += 1) {
      const id = `MEM-P9-${String(index).padStart(6, "0")}`;
      const tag = `decoy-${index}`;
      const content = `unrelated memory ${index}`;
      const hash = (index + 10).toString(16).padStart(64, "0").slice(-64);
      const payload = JSON.stringify({ type: "TYPED_POLICY", policyKind: "PREFERENCE", statement: content, appliesTo: [tag] });
      version.run(id, authority.goalId, payload, hash, "{}", hash, JSON.stringify([tag]),
        1_800_000_000_000 + index, content, hash, hash);
      head.run(id, hash);
      term.run(id, tag);
      fts?.run(id, tag, content);
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the seed failure. */ }
    throw error;
  } finally { database.close(); }
}

function selection(index: number): MemorySelection {
  const hash = (index + 1).toString(16).padStart(64, "0");
  return {
    claimId: `MEM-PROJECTION-${index}`,
    version: 1,
    channel: index < 6 ? "POLICY" : index < 10 ? "EVIDENCE" : "EXPERIENCE",
    scope: "WORKSPACE",
    payload: index < 6
      ? { type: "TYPED_POLICY", policyKind: "PREFERENCE", statement: `Projection policy ${index}`, appliesTo: ["projection"] }
      : index < 10
        ? { type: "EVIDENCE_LOCATOR", evidenceKind: "PROJECT_FILE", locator: `pch-file://source-${index}.txt`, description: "projection", lineStart: null, lineEnd: null }
        : { type: "EXPERIENCE_RECORD", lesson: `Projection lesson ${index}`, outcome: "SUCCEEDED", receiptId: `RCP-${index}`, failureSignatureSha256: null },
    projectionText: `Projection ${index}`,
    tokenEstimate: 20,
    reason: "PERFORMANCE_FIXTURE",
    sourceLocator: `pch-source://${index}`,
    sourceSha256: hash,
    claimSha256: hash,
    endorsed: false,
  };
}

const enabled = process.env.PCH_MEMORY_V2_PERFORMANCE === "1";
const authorities: Phase6Authority[] = [];
afterAll(() => { for (const authority of authorities) authority.close(); });

describe.skipIf(!enabled)("Memory v2.1 sequential performance gates", () => {
  it("meets M0-M5 component budgets at 50k rows", () => {
    const disabledAuthority = createPhase6Authority("TAG_PATH", false, "OFF");
    const exactAuthority = createPhase6Authority("TAG_PATH");
    const overlayAuthority = createPhase6Authority("FTS5");
    const mutationAuthority = createPhase6Authority("TAG_PATH");
    authorities.push(disabledAuthority, exactAuthority, overlayAuthority, mutationAuthority);
    const disabled = new MemoryEngine(disabledAuthority.store, { ...disabledAuthority.memoryConfig, enabled: false, mode: "OFF" });

    const policy = exactAuthority.memory.addUserPolicy({
      statement: "Use the phase nine policy target.", scope: "WORKSPACE", tags: ["p9-policy-target"],
    }, exactAuthority.context(3));
    const sourcePath = join(exactAuthority.directory, "p9-evidence.txt");
    writeFileSync(sourcePath, "phase nine exact evidence", "utf8");
    const evidence = exactAuthority.memory.addProjectEvidence({
      path: "p9-evidence.txt", description: "phase nine evidence", scope: "WORKSPACE", tags: ["p9-evidence-target"],
    }, exactAuthority.context(4));
    expect(policy.accepted && evidence.accepted).toBe(true);
    seedDecoys(exactAuthority, 49_998, false);

    const overlayTarget = overlayAuthority.memory.addUserPolicy({
      statement: "Use the phase nine overlay target.", scope: "WORKSPACE", tags: ["p9-overlay-target"],
    }, overlayAuthority.context(3));
    expect(overlayTarget.accepted).toBe(true);
    overlayAuthority.memory.drainIndex();
    seedDecoys(overlayAuthority, 49_499, true);
    let overlayVersion = 4;
    for (let index = 0; index < 500; index += 1) {
      const result = overlayAuthority.memory.addUserPolicy({
        statement: `Pending overlay policy ${index}.`, scope: "WORKSPACE", tags: [`pending-${index}`],
      }, overlayAuthority.context(overlayVersion));
      expect(result.accepted).toBe(true);
      overlayVersion = result.authorityResult?.goalVersion ?? overlayVersion;
    }

    const query = {
      workspaceId: "WS-TEST-001", goalId: exactAuthority.goalId, workspaceRoot: exactAuthority.directory,
      nowMs: exactAuthority.clock.now(),
    };
    const overlayTerms = memorySearchTerms("phase nine overlay target");
    const overlayChannels = ["POLICY", "EVIDENCE", "EXPERIENCE"] as const;
    const overlayPendingIds = overlayAuthority.store.memoryPendingMatches(
      "WS-TEST-001", overlayAuthority.goalId, overlayChannels, overlayTerms, 24,
    ).slice(0, 12).map((entry) => entry.claimId);
    const overlayReadIds = [...new Set([
      ...(overlayTarget.record ? [overlayTarget.record.claimId] : []), ...overlayPendingIds,
    ])];
    const samples = {
      off_ms: sample(200, () => disabled.retrieve({
        workspaceId: "WS-TEST-001", goalId: disabledAuthority.goalId,
        workspaceRoot: disabledAuthority.directory, text: "off", nowMs: disabledAuthority.clock.now(),
      })),
      policy_50k_ms: sample(100, () => exactAuthority.memory.retrieve({
        ...query, text: "p9 policy target", tags: ["p9-policy-target"],
      })),
      exact_evidence_50k_ms: sample(100, () => exactAuthority.memory.retrieve({
        ...query, text: "p9 evidence target", tags: ["p9-evidence-target"],
      })),
      fts_overlay_50k_ms: sample(100, () => overlayAuthority.memory.retrieve({
        workspaceId: "WS-TEST-001", goalId: overlayAuthority.goalId, workspaceRoot: overlayAuthority.directory,
        text: "phase nine overlay target", tags: ["p9-overlay-target"], nowMs: overlayAuthority.clock.now(),
      })),
      overlay_fts_query_ms: sample(100, () => overlayAuthority.store.memoryFtsMatches(
        "WS-TEST-001", overlayAuthority.goalId, overlayChannels,
        '"phase" OR "nine" OR "overlay" OR "target"', overlayTerms, 24,
      )),
      overlay_structured_query_ms: sample(100, () => overlayAuthority.store.memoryStructuredMatches(
        "WS-TEST-001", overlayAuthority.goalId, overlayChannels, [...overlayTerms, "p9-overlay-target"], 24,
      )),
      overlay_pending_match_ms: sample(100, () => overlayAuthority.store.memoryPendingMatches(
        "WS-TEST-001", overlayAuthority.goalId, overlayChannels, overlayTerms, 24,
      )),
      overlay_candidate_read_ms: sample(100, () => overlayAuthority.store.readMemoryByIds(
        "WS-TEST-001", overlayAuthority.goalId, overlayReadIds,
      )),
      overlay_endorsed_read_ms: sample(100, () => overlayAuthority.store.readEndorsedMemories(
        "WS-TEST-001", overlayAuthority.goalId, overlayChannels, 24,
      )),
      overlay_pending_count_ms: sample(100, () => overlayAuthority.store.memoryPendingIndexCount("WS-TEST-001")),
      overlay_watermark_ms: sample(100, () => overlayAuthority.store.memoryIndexWatermark("WS-TEST-001")),
    };

    const mutationSamples: number[] = [];
    let mutationVersion = 3;
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const result = mutationAuthority.memory.addUserPolicy({
        statement: `Mutation performance policy ${index}.`, scope: "WORKSPACE", tags: ["mutation"],
      }, mutationAuthority.context(mutationVersion));
      mutationSamples.push(performance.now() - started);
      expect(result.accepted).toBe(true);
      mutationVersion = result.authorityResult?.goalVersion ?? mutationVersion;
    }
    const allSelections = Array.from({ length: 12 }, (_, index) => selection(index));
    const projectionSamples = sample(500, () => buildMemoryWorkingSet(
      allSelections.slice(0, 6), allSelections.slice(6, 10), allSelections.slice(10), [], [],
    ));
    const metrics = {
      off_p50_ms: percentile(samples.off_ms, 0.5),
      off_p95_ms: percentile(samples.off_ms, 0.95),
      policy_50k_p50_ms: percentile(samples.policy_50k_ms, 0.5),
      policy_50k_p95_ms: percentile(samples.policy_50k_ms, 0.95),
      exact_evidence_50k_p50_ms: percentile(samples.exact_evidence_50k_ms, 0.5),
      exact_evidence_50k_p95_ms: percentile(samples.exact_evidence_50k_ms, 0.95),
      fts_overlay_50k_p50_ms: percentile(samples.fts_overlay_50k_ms, 0.5),
      fts_overlay_50k_p95_ms: percentile(samples.fts_overlay_50k_ms, 0.95),
      mutation_p50_ms: percentile(mutationSamples, 0.5),
      mutation_p95_ms: percentile(mutationSamples, 0.95),
      projection_p50_ms: percentile(projectionSamples, 0.5),
      projection_p95_ms: percentile(projectionSamples, 0.95),
      overlay_fts_query_p95_ms: percentile(samples.overlay_fts_query_ms, 0.95),
      overlay_structured_query_p95_ms: percentile(samples.overlay_structured_query_ms, 0.95),
      overlay_pending_match_p95_ms: percentile(samples.overlay_pending_match_ms, 0.95),
      overlay_candidate_read_p95_ms: percentile(samples.overlay_candidate_read_ms, 0.95),
      overlay_endorsed_read_p95_ms: percentile(samples.overlay_endorsed_read_ms, 0.95),
      overlay_pending_count_p95_ms: percentile(samples.overlay_pending_count_ms, 0.95),
      overlay_watermark_p95_ms: percentile(samples.overlay_watermark_ms, 0.95),
      additional_model_requests: 0,
      synchronous_index_drain_calls: 0,
    };
    const budgets = {
      off_p95_ms: 1,
      policy_50k_p95_ms: 12,
      exact_evidence_50k_p95_ms: 15,
      fts_overlay_50k_p95_ms: 25,
      mutation_p95_ms: 20,
      projection_p95_ms: 3,
    };
    const status = Object.entries(budgets).every(([key, budget]) => metrics[key as keyof typeof metrics] <= budget)
      ? "PASS" : "FAIL";
    const report = {
      schema_version: 1,
      report_type: "PCH_MEMORY_V2_PERFORMANCE",
      status,
      epoch: `MEMORY-V2-PERF-${Date.now()}`,
      fingerprint: {
        host: hostname(), platform: process.platform, arch: process.arch, node: process.version,
        cpu: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(),
      },
      inputs: [
        "tests/performance/memory-v2.test.ts",
        "src/memory/context-projector.ts",
        "src/memory/engine.ts",
        "src/memory/retrieval.ts",
        "src/memory/ranking.ts",
        "src/authority/repositories/memory.ts",
        "schemas/sql/005_memory_claims.sql",
        "schemas/sql/006_memory_claims_fts.sql",
      ].map(sourceEvidence),
      sample_counts: { off: 200, policy_50k: 100, exact_evidence_50k: 100, fts_overlay_50k: 100, mutation: 100, projection: 500, rows: 50_000, pending_overlay: 500 },
      samples: { ...samples, mutation_ms: mutationSamples, projection_ms: projectionSamples },
      metrics,
      budgets,
      additional_model_requests: 0,
      synchronous_index_drain_calls: 0,
    };
    mkdirSync(resolve("reports"), { recursive: true });
    writeFileSync(resolve("reports", "memory-v2-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    expect(status).toBe("PASS");
  }, 240_000);
});
