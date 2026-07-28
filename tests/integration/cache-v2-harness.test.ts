import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { CacheV2Runtime } from "../../src/cache-v2/runtime.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createHarnessFixture } from "../helpers/harness.js";

describe("Harness Cache v2 attribution", () => {
  it("records a provider-proven positive Cache read as HIT", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const runtime = new CacheV2Runtime({
        config: configured.modules.cache, runId: fixture.run.run_id,
        secret: Buffer.alloc(32, 4), now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const requestId = runtime.prepare(
        {
          provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1/",
          model: "user-selected-model", thinking_level: "high", context_window: 100_000,
        },
        { promptGenerationId: "PROMPT-GENERATION-1", systemPromptSha256: sha256Hex("system"),
          layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools"), subjectBindingSha256: sha256Hex("subject") },
      );
      expect(requestId).toMatch(/^CACHE_REQ-/u);
      expect(fixture.authority.store.pendingCacheV2Requests(fixture.run.run_id)).toBe(1);
      const observation = runtime.settle(requestId!, {
        usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 10 }, responseStatus: 200, latencyMs: 15,
      });
      expect(observation).toMatchObject({ observation_state: "HIT", evidence_level: "PROVIDER_USAGE" });
      expect(fixture.authority.store.pendingCacheV2Requests(fixture.run.run_id)).toBe(0);
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 1, settled: 1, pending: 0, confirmedHits: 1, unobservable: 0,
        uncachedInputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 0,
      });
    } finally { fixture.authority.close(); }
  });

  it("keeps normalized zero Cache usage unobservable", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-ZERO");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const runtime = new CacheV2Runtime({
        config: configured.modules.cache, runId: fixture.run.run_id,
        secret: Buffer.alloc(32, 5), now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const requestId = runtime.prepare(
        {
          provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1",
          model: "another-user-model", thinking_level: "max", context_window: 272_000,
        },
        { promptGenerationId: "PROMPT-GENERATION-ZERO", systemPromptSha256: sha256Hex("system-zero"),
          layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools-zero"), subjectBindingSha256: sha256Hex("subject-zero") },
      );
      const observation = runtime.settle(requestId!, {
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 10 }, responseStatus: 200, latencyMs: 15,
      });
      expect(observation).toMatchObject({ observation_state: "UNOBSERVABLE", evidence_level: "METADATA_ONLY" });
    } finally { fixture.authority.close(); }
  });

  it("falls back to C0 without repository work for an unsupported provider or base URL", () => {
    const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
    const repository = {
      prepare: () => { throw new Error("unexpected"); },
      settle: () => { throw new Error("unexpected"); },
    };
    const runtime = new CacheV2Runtime({ config: configured.modules.cache, repository, runId: "RUN-CACHE-FALLBACK", secret: Buffer.alloc(32) });
    const selected = {
      provider: "geekspace", api: "openai-completions", base_url: "https://other.example/v1",
      model: "model", thinking_level: "none", context_window: 1,
    };
    expect(runtime.effective(selected)).toEqual({ arm: "C0", providerIntegration: null, reason: "UNSUPPORTED_RUNTIME" });
    expect(runtime.prepare(selected, {
      promptGenerationId: "PG", systemPromptSha256: sha256Hex("s"), layoutManifestSha256: null,
      toolSurfaceSha256: sha256Hex("t"), subjectBindingSha256: sha256Hex("x"),
    })).toBeNull();
  });

  it("settles abandoned in-memory and restart-pending observations as unknown", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-RECOVERY");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      let now = fixture.authority.clock.now();
      const runtime = new CacheV2Runtime({
        config: configured.modules.cache, runId: fixture.run.run_id,
        secret: Buffer.alloc(32, 6), now: () => now++,
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const selected = {
        provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      };
      const seed = { promptGenerationId: "PROMPT-GENERATION-RECOVERY", systemPromptSha256: sha256Hex("system-recovery"),
        layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools-recovery"), subjectBindingSha256: sha256Hex("subject-recovery") };
      expect(runtime.prepare(selected, seed)).toMatch(/^CACHE_REQ-/u);
      expect(runtime.prepare(selected, seed)).toMatch(/^CACHE_REQ-/u);
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 2, settled: 1, pending: 1, unobservable: 1,
      });
      expect(fixture.authority.store.reconcilePendingCacheV2(fixture.run.run_id, fixture.authority.clock.now())).toBe(1);
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 2, settled: 2, pending: 0, unobservable: 2,
      });
    } finally { fixture.authority.close(); }
  });

  it("performs no repository operation while Cache is disabled", () => {
    const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
    const repository = {
      prepare: () => { throw new Error("unexpected"); },
      settle: () => { throw new Error("unexpected"); },
    };
    const runtime = new CacheV2Runtime({
      config: { ...configured.modules.cache, enabled: false, arm: "C0", provider_integration: null },
      repository, runId: "RUN-CACHE-OFF", secret: Buffer.alloc(32),
    });
    expect(runtime.prepare(
      { provider: "p", api: "a", model: "m", thinking_level: "none", context_window: 1 },
      { promptGenerationId: "PG", systemPromptSha256: sha256Hex("s"), layoutManifestSha256: null,
        toolSurfaceSha256: sha256Hex("t"), subjectBindingSha256: sha256Hex("x") },
    )).toBeNull();
  });
});
