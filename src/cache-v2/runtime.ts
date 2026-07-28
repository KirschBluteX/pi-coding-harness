import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/executor.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import {
  sealCacheRecord, type CacheLogicalRequestPrepareV2, type CacheLogicalRequestV2,
  type CacheRequestAttributionV2,
} from "./domain.js";
import {
  classifyGeekspaceOpenAiCompletionsUsage, resolveGeekspaceOpenAiCompletions,
  type GeekspaceOpenAiCompletionsContract,
} from "./geekspace-openai-completions.js";
import type { CacheV2Repository } from "./repository.js";

export interface CacheV2ContextSeed {
  readonly promptGenerationId: string; readonly systemPromptSha256: string;
  readonly layoutManifestSha256: string | null; readonly toolSurfaceSha256: string;
  readonly subjectBindingSha256: string;
}

export interface CacheV2Store {
  prepare(
    partition: Parameters<CacheV2Repository["prepare"]>[0],
    family: Parameters<CacheV2Repository["prepare"]>[1],
    request: CacheLogicalRequestPrepareV2,
  ): CacheLogicalRequestV2;
  settle(value: CacheRequestAttributionV2): void;
}

export class CacheV2Runtime {
  private readonly pending = new Map<string, {
    readonly request: CacheLogicalRequestV2;
    readonly contract: GeekspaceOpenAiCompletionsContract;
  }>();
  constructor(private readonly options: {
    readonly config: CacheModuleConfig; readonly repository: CacheV2Store; readonly runId: string;
    readonly secret: Uint8Array; readonly now?: () => number;
  }) {}

  effective(runtime: WorkerRuntimeSelection): {
    readonly arm: "C0" | "C1_PREFIX";
    readonly providerIntegration: string | null;
    readonly reason: "ACTIVE" | "DISABLED" | "UNSUPPORTED_RUNTIME";
  } {
    if (!this.options.config.enabled || this.options.config.arm === "C0") {
      return { arm: "C0", providerIntegration: null, reason: "DISABLED" };
    }
    const contract = resolveGeekspaceOpenAiCompletions(this.options.config, runtime);
    return contract
      ? { arm: "C1_PREFIX", providerIntegration: contract.integrationId, reason: "ACTIVE" }
      : { arm: "C0", providerIntegration: null, reason: "UNSUPPORTED_RUNTIME" };
  }

  prepare(runtime: WorkerRuntimeSelection, seed: CacheV2ContextSeed): string | null {
    const now = (this.options.now ?? Date.now)();
    this.abandonInMemoryPending(now);
    const contract = resolveGeekspaceOpenAiCompletions(this.options.config, runtime);
    if (!contract) return null;
    const transportHmac = hmacSha256Hex(this.options.secret, canonicalJsonSha256({
      provider: runtime.provider, api: runtime.api, baseUrl: runtime.base_url ?? "unconfigured",
      model: runtime.model, thinkingLevel: runtime.thinking_level, contextWindow: runtime.context_window,
    }));
    const partitionId = idFromSha256("CACHE_PART", sha256Hex(`${this.options.runId}\0${transportHmac}`));
    const partition = sealCacheRecord("PCH-CACHE-SECURITY-PARTITION-V2", {
      partition_id: partitionId, run_id: this.options.runId, transport_hmac: transportHmac,
      provider_hmac: hmacSha256Hex(this.options.secret, runtime.provider), api_hmac: hmacSha256Hex(this.options.secret, runtime.api),
      model_hmac: hmacSha256Hex(this.options.secret, runtime.model),
      security_epoch_hmac: hmacSha256Hex(this.options.secret, `${this.options.config.epoch}\0${contract.securityEpoch}`),
      created_at_ms: now,
    });
    const familyId = idFromSha256("CACHE_FAMILY", sha256Hex(canonicalJsonSha256({ partitionId, ...seed })));
    const family = sealCacheRecord("PCH-CACHE-PREFIX-FAMILY-V2", {
      family_id: familyId, run_id: this.options.runId, partition_id: partitionId,
      prompt_generation_id: seed.promptGenerationId, system_prompt_sha256: seed.systemPromptSha256,
      layout_manifest_sha256: seed.layoutManifestSha256, tool_surface_sha256: seed.toolSurfaceSha256,
      context_subject_sha256: seed.subjectBindingSha256, created_at_ms: now,
    });
    const request = this.options.repository.prepare(partition, family, {
      run_id: this.options.runId, partition_id: partitionId, family_id: familyId,
      subject_binding_sha256: seed.subjectBindingSha256, created_at_ms: now,
    });
    this.pending.set(request.request_id, { request, contract });
    return request.request_id;
  }

  settle(requestId: string, input: {
    readonly usage: CacheRequestAttributionV2["usage"]; readonly responseStatus: number | null; readonly latencyMs: number | null;
  }): CacheRequestAttributionV2 {
    const pending = this.pending.get(requestId);
    if (!pending) throw new TypeError("Cache logical request is not pending in this Host");
    const { request } = pending;
    const classification = classifyGeekspaceOpenAiCompletionsUsage({
      usage: input.usage, responseStatus: input.responseStatus,
    });
    const value = sealCacheRecord("PCH-CACHE-REQUEST-ATTRIBUTION-V2", {
      request_id: request.request_id, run_id: request.run_id, partition_id: request.partition_id, family_id: request.family_id,
      request_sequence: request.request_sequence, subject_binding_sha256: request.subject_binding_sha256,
      observation_state: classification.observationState, evidence_level: classification.evidenceLevel,
      usage: input.usage, response_status: input.responseStatus, latency_ms: input.latencyMs, created_at_ms: (this.options.now ?? Date.now)(),
    });
    this.options.repository.settle(value); this.pending.delete(requestId); return value;
  }

  private abandonInMemoryPending(now: number): void {
    for (const [requestId, pending] of this.pending) {
      const { request } = pending;
      const value = sealCacheRecord("PCH-CACHE-REQUEST-ATTRIBUTION-V2", {
        request_id: request.request_id, run_id: request.run_id, partition_id: request.partition_id,
        family_id: request.family_id, request_sequence: request.request_sequence,
        subject_binding_sha256: request.subject_binding_sha256,
        observation_state: "UNOBSERVABLE" as const, evidence_level: "METADATA_ONLY" as const,
        usage: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
        response_status: null, latency_ms: null, created_at_ms: now,
      });
      this.options.repository.settle(value);
      this.pending.delete(requestId);
    }
  }
}
