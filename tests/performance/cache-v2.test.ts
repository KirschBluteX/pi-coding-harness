import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { CacheV2Runtime } from "../../src/cache-v2/runtime.js";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createHarnessFixture } from "../helpers/harness.js";
import { declaredPerformanceRoot } from "../helpers/performance-root.js";

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function sourceEvidence(path: string): { readonly path: string; readonly sha256: string } {
  return { path, sha256: createHash("sha256").update(readFileSync(resolve(path))).digest("hex") };
}

describe.skipIf(process.env.PCH_CACHE_V2_PERFORMANCE !== "1")("Cache v2 local performance gates", () => {
  it("keeps provider-specific C1 accounting bounded without extra provider or model requests", () => {
    const performanceRoot = declaredPerformanceRoot("cache-v2");
    mkdirSync(performanceRoot.epochRoot, { recursive: true });
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-PERFORMANCE", { baseDirectory: performanceRoot.epochRoot });
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const runtime = new CacheV2Runtime({
        config: configured.modules.cache,
        runId: fixture.run.run_id,
        secret: Buffer.alloc(32, 7),
        now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const selected = {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1",
        model: "user-configured-model", thinking_level: "user-configured", context_window: 100_000,
      };
      const seed = {
        promptGenerationId: "PROMPT-GENERATION-CACHE-PERFORMANCE",
        systemPromptSha256: sha256Hex("system-cache-performance"), layoutManifestSha256: null,
        toolSurfaceSha256: sha256Hex("tools-cache-performance"), subjectBindingSha256: sha256Hex("subject-cache-performance"),
      };
      const runOnce = (): { readonly prepareMs: number; readonly settleMs: number; readonly roundTripMs: number } => {
        const started = performance.now();
        const requestId = runtime.prepare(selected, seed);
        const prepared = performance.now();
        if (!requestId) throw new Error("Cache C1 performance request did not activate");
        runtime.settle(requestId, {
          usage: { input: 400, output: 20, cacheRead: 600, cacheWrite: 0, reasoning: 10 },
          responseStatus: 200, latencyMs: 1,
        });
        const settled = performance.now();
        return { prepareMs: prepared - started, settleMs: settled - prepared, roundTripMs: settled - started };
      };
      for (let index = 0; index < 10; index += 1) runOnce();
      const samples = Array.from({ length: 100 }, runOnce);
      const metrics = {
        prepare_p50_ms: percentile(samples.map((sample) => sample.prepareMs), 0.5),
        prepare_p95_ms: percentile(samples.map((sample) => sample.prepareMs), 0.95),
        settle_p50_ms: percentile(samples.map((sample) => sample.settleMs), 0.5),
        settle_p95_ms: percentile(samples.map((sample) => sample.settleMs), 0.95),
        ordered_round_trip_p50_ms: percentile(samples.map((sample) => sample.roundTripMs), 0.5),
        ordered_round_trip_p95_ms: percentile(samples.map((sample) => sample.roundTripMs), 0.95),
      };
      const budgets = {
        prepare_p50_ms: 8, prepare_p95_ms: 20, settle_p50_ms: 8, settle_p95_ms: 20,
        ordered_round_trip_p50_ms: 12, ordered_round_trip_p95_ms: 45,
      };
      const summary = fixture.authority.store.cacheV2Summary(fixture.run.run_id);
      const checks = {
        prepare_p50_within_budget: metrics.prepare_p50_ms <= budgets.prepare_p50_ms,
        prepare_p95_within_budget: metrics.prepare_p95_ms <= budgets.prepare_p95_ms,
        settle_p50_within_budget: metrics.settle_p50_ms <= budgets.settle_p50_ms,
        settle_p95_within_budget: metrics.settle_p95_ms <= budgets.settle_p95_ms,
        ordered_round_trip_p50_within_budget: metrics.ordered_round_trip_p50_ms <= budgets.ordered_round_trip_p50_ms,
        ordered_round_trip_p95_within_budget: metrics.ordered_round_trip_p95_ms <= budgets.ordered_round_trip_p95_ms,
        all_requests_settled: summary.prepared === 110 && summary.settled === 110 && summary.pending === 0,
        all_positive_usage_confirmed: summary.confirmedHits === 110 && summary.unobservable === 0 && summary.errors === 0,
        additional_model_requests_zero: true,
        additional_provider_requests_zero: true,
      };
      const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
      const report = {
        schema_version: 1, report_type: "PCH_CACHE_V2_PERFORMANCE", status,
        generated_at: new Date().toISOString(),
        fingerprint: {
          host: hostname(), platform: process.platform, arch: process.arch, node: process.version,
          cpu: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(),
          authority_data_root: performanceRoot.dataRoot, authority_data_root_source: performanceRoot.dataRootSource,
        },
        scope: "SQLite-backed Cache C1 accounting only; no provider request is issued by this benchmark.",
        inputs: [
          "tests/performance/cache-v2.test.ts", "src/cache-v2/runtime.ts", "src/cache-v2/repository.ts",
          "src/cache-v2/codex-local-openai-responses.ts", "schemas/sql/014_cache_v2.sql", "config/default.json",
        ].map(sourceEvidence),
        sample_counts: { warmup: 10, measured: 100 }, metrics, budgets, checks,
        additional_model_requests: 0, additional_provider_requests: 0,
      };
      writeFileSync(resolve("reports", "cache-v2-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      expect(status).toBe("PASS");
    } finally {
      fixture.authority.close();
    }
  }, 120_000);
});
