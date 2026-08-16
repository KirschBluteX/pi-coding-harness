import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/executor.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import {
  sealCacheRecord, type CacheLogicalRequestPrepareV2, type CacheLogicalRequestV2,
  type CacheRequestAttributionV2, type CacheSecurityPartitionV2, type StablePrefixFamilyV2,
} from "./domain.js";
import type { CacheProviderContract } from "./provider-contract.js";
import { resolveCacheProviderContract } from "./provider-contracts.js";
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
    readonly contract: CacheProviderContract;
  }>();
  private identity: {
    readonly transportIdentity: string;
    readonly seedIdentity: string;
    readonly contract: CacheProviderContract;
    readonly partition: CacheSecurityPartitionV2;
    readonly family: StablePrefixFamilyV2;
  } | null = null;
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
    const contract = resolveCacheProviderContract(this.options.config, runtime);
    return contract
      ? { arm: "C1_PREFIX", providerIntegration: contract.integrationId, reason: "ACTIVE" }
      : { arm: "C0", providerIntegration: null, reason: "UNSUPPORTED_RUNTIME" };
  }

  prepare(runtime: WorkerRuntimeSelection, seed: CacheV2ContextSeed): string | null {
    const now = (this.options.now ?? Date.now)();
    const contract = resolveCacheProviderContract(this.options.config, runtime);
    if (!contract) return null;
    const canonicalTransport = contract.canonicalTransportIdentity(runtime);
    const transportIdentity = canonicalJsonSha256(canonicalTransport);
    const cached = this.identity?.transportIdentity === transportIdentity
      && this.identity.contract.integrationId === contract.integrationId ? this.identity : null;
    const transportHmac = cached?.partition.transport_hmac ?? hmacSha256Hex(this.options.secret, transportIdentity);
    const partitionId = cached?.partition.partition_id
      ?? idFromSha256("CACHE_PART", sha256Hex(`${this.options.runId}\0${transportHmac}`));
    const partition = cached?.partition ?? sealCacheRecord("PCH-CACHE-SECURITY-PARTITION-V2", {
      partition_id: partitionId, run_id: this.options.runId, transport_hmac: transportHmac,
      provider_hmac: hmacSha256Hex(this.options.secret, canonicalTransport.provider),
      api_hmac: hmacSha256Hex(this.options.secret, canonicalTransport.api),
      model_hmac: hmacSha256Hex(this.options.secret, canonicalTransport.model),
      security_epoch_hmac: hmacSha256Hex(this.options.secret, `${this.options.config.epoch}\0${contract.securityEpoch}`),
      created_at_ms: now,
    });
    const seedIdentity = canonicalJsonSha256(seed);
    const family = cached?.seedIdentity === seedIdentity ? cached.family : (() => {
      const familyId = idFromSha256("CACHE_FAMILY", sha256Hex(canonicalJsonSha256({ partitionId, ...seed })));
      return sealCacheRecord("PCH-CACHE-PREFIX-FAMILY-V2", {
        family_id: familyId, run_id: this.options.runId, partition_id: partitionId,
        prompt_generation_id: seed.promptGenerationId, system_prompt_sha256: seed.systemPromptSha256,
        layout_manifest_sha256: seed.layoutManifestSha256, tool_surface_sha256: seed.toolSurfaceSha256,
        context_subject_sha256: seed.subjectBindingSha256, created_at_ms: now,
      });
    })();
    this.identity = { transportIdentity, seedIdentity, contract, partition, family };
    const request = this.options.repository.prepare(partition, family, {
      run_id: this.options.runId, partition_id: partitionId, family_id: family.family_id,
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
    const { request, contract } = pending;
    const classification = contract.classifyUsage({
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

}
