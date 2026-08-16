import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { codexLocalOpenAiResponsesIntegrationId } from "../../src/cache-v2/codex-local-openai-responses.js";
import { geekspaceOpenAiCompletionsIntegrationId } from "../../src/cache-v2/geekspace-openai-completions.js";
import { CacheV2Runtime } from "../../src/cache-v2/runtime.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createHarnessFixture } from "../helpers/harness.js";

describe("Harness Cache v2 attribution", () => {
  it("selects the codex-local contract and records provider-proven usage without payload mutation", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-CODEX-LOCAL");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const config = { ...configured.modules.cache, provider_integration: codexLocalOpenAiResponsesIntegrationId };
      const runtime = new CacheV2Runtime({
        config, runId: fixture.run.run_id, secret: Buffer.alloc(32, 3), now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const selected = {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1/",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      };
      const selectedBefore = structuredClone(selected);
      expect(runtime.effective(selected)).toEqual({
        arm: "C1_PREFIX", providerIntegration: codexLocalOpenAiResponsesIntegrationId, reason: "ACTIVE",
      });
      const requestId = runtime.prepare(selected, {
        promptGenerationId: "PROMPT-GENERATION-CODEX-LOCAL", systemPromptSha256: sha256Hex("system-local"),
        layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools-local"),
        subjectBindingSha256: sha256Hex("subject-local"),
      });
      expect(selected).toEqual(selectedBefore);
      expect(runtime.settle(requestId!, {
        usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 10 },
        responseStatus: 200, latencyMs: 15,
      })).toMatchObject({ observation_state: "HIT", evidence_level: "PROVIDER_USAGE" });
    } finally { fixture.authority.close(); }
  });

  it("uses one partition for Adapter-equivalent transport spellings", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-CANONICAL-TRANSPORT");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const runtime = new CacheV2Runtime({
        config: { ...configured.modules.cache, provider_integration: codexLocalOpenAiResponsesIntegrationId },
        runId: fixture.run.run_id, secret: Buffer.alloc(32, 9), now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => fixture.authority.store.prepareCacheV2(partition, family, request),
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const seed = {
        promptGenerationId: "PROMPT-GENERATION-CANONICAL", systemPromptSha256: sha256Hex("system"),
        layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools"),
        subjectBindingSha256: sha256Hex("subject"),
      };
      const selected = {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1/",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      };
      for (const transport of [selected, { ...selected, provider: "CODEX-LOCAL", base_url: "http://localhost:58493/v1" }]) {
        const requestId = runtime.prepare(transport, seed)!;
        runtime.settle(requestId, {
          usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
          responseStatus: 200, latencyMs: 12,
        });
      }
      const read = new DatabaseSync(fixture.authority.databasePath, { readOnly: true, timeout: 5_000 });
      try {
        expect(read.prepare("SELECT count(*) count FROM cache_security_partitions_v2").get()).toEqual({ count: 1 });
        expect(read.prepare("SELECT count(*) count FROM cache_stable_prefix_families_v2").get()).toEqual({ count: 1 });
      } finally { read.close(); }
    } finally { fixture.authority.close(); }
  });

  it("reuses stable Cache identities across requests in one Host epoch", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-IDENTITY-REUSE");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const prepared: { partition: object; family: object }[] = [];
      const runtime = new CacheV2Runtime({
        config: configured.modules.cache, runId: fixture.run.run_id, secret: Buffer.alloc(32, 8),
        now: () => fixture.authority.clock.now(),
        repository: {
          prepare: (partition, family, request) => {
            prepared.push({ partition, family });
            return fixture.authority.store.prepareCacheV2(partition, family, request);
          },
          settle: (value) => fixture.authority.store.settleCacheV2(value),
        },
      });
      const selected = {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      };
      const seed = {
        promptGenerationId: "PROMPT-GENERATION-IDENTITY-REUSE", systemPromptSha256: sha256Hex("system-reuse"),
        layoutManifestSha256: null, toolSurfaceSha256: sha256Hex("tools-reuse"),
        subjectBindingSha256: sha256Hex("subject-reuse"),
      };
      for (let index = 0; index < 2; index += 1) {
        const requestId = runtime.prepare(selected, seed)!;
        runtime.settle(requestId, {
          usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 10 },
          responseStatus: 200, latencyMs: 15,
        });
      }
      const changedSeed = { ...seed, subjectBindingSha256: sha256Hex("subject-reuse-changed") };
      const changedRequestId = runtime.prepare(selected, changedSeed)!;
      runtime.settle(changedRequestId, {
        usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 10 },
        responseStatus: 200, latencyMs: 15,
      });
      expect(prepared).toHaveLength(3);
      expect(prepared[1]!.partition).toBe(prepared[0]!.partition);
      expect(prepared[1]!.family).toBe(prepared[0]!.family);
      expect(prepared[2]!.partition).toBe(prepared[0]!.partition);
      expect(prepared[2]!.family).not.toBe(prepared[0]!.family);
    } finally { fixture.authority.close(); }
  });

  it("records a provider-proven positive Cache read as HIT", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      const runtime = new CacheV2Runtime({
        config: { ...configured.modules.cache, provider_integration: geekspaceOpenAiCompletionsIntegrationId },
        runId: fixture.run.run_id,
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
        config: { ...configured.modules.cache, provider_integration: geekspaceOpenAiCompletionsIntegrationId },
        runId: fixture.run.run_id,
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

  it("keeps concurrent in-memory requests independent and reconciles only restart-pending observations", () => {
    const fixture = createHarnessFixture("SINGLE", "CACHE-V2-RECOVERY");
    try {
      const configured = JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig;
      let now = fixture.authority.clock.now();
      const runtime = new CacheV2Runtime({
        config: { ...configured.modules.cache, provider_integration: geekspaceOpenAiCompletionsIntegrationId },
        runId: fixture.run.run_id,
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
      const firstRequestId = runtime.prepare(selected, seed)!;
      const secondRequestId = runtime.prepare(selected, seed)!;
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 2, settled: 0, pending: 2, unobservable: 0,
      });
      runtime.settle(secondRequestId, {
        usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
        responseStatus: 200, latencyMs: 12,
      });
      runtime.settle(firstRequestId, {
        usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
        responseStatus: 200, latencyMs: 14,
      });
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 2, settled: 2, pending: 0, confirmedHits: 2, unobservable: 0,
      });

      const restartPendingId = runtime.prepare(selected, seed)!;
      expect(restartPendingId).toMatch(/^CACHE_REQ-/u);
      expect(fixture.authority.store.reconcilePendingCacheV2(fixture.run.run_id, fixture.authority.clock.now())).toBe(1);
      expect(fixture.authority.store.cacheV2Summary(fixture.run.run_id)).toMatchObject({
        prepared: 3, settled: 3, pending: 0, confirmedHits: 2, unobservable: 1,
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
