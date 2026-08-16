import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/runtime-policy.js";
import type { CacheRequestAttributionV2 } from "./domain.js";

export interface CacheUsageClassification {
  readonly observationState: CacheRequestAttributionV2["observation_state"];
  readonly evidenceLevel: CacheRequestAttributionV2["evidence_level"];
}

export interface CacheUsageObservation {
  readonly usage: CacheRequestAttributionV2["usage"];
  readonly responseStatus: number | null;
}

export interface CacheTransportIdentity {
  readonly provider: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly contextWindow: number;
}

export interface CacheProviderContract {
  readonly integrationId: string;
  readonly securityEpoch: string;
  readonly usageSemanticsId: string;
  canonicalTransportIdentity(runtime: WorkerRuntimeSelection): CacheTransportIdentity;
  classifyUsage(input: CacheUsageObservation): CacheUsageClassification;
}

export type CacheProviderContractResolver = (
  config: CacheModuleConfig,
  runtime: WorkerRuntimeSelection,
) => CacheProviderContract | null;

function token(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function classifyPositiveProviderCacheRead(input: CacheUsageObservation): CacheUsageClassification {
  if (input.responseStatus !== null && input.responseStatus >= 400) {
    return { observationState: "ERROR", evidenceLevel: "METADATA_ONLY" };
  }
  if (input.responseStatus === null || input.responseStatus < 200 || input.responseStatus >= 300) {
    return { observationState: "UNOBSERVABLE", evidenceLevel: "METADATA_ONLY" };
  }
  const uncached = token(input.usage.input);
  const cacheRead = token(input.usage.cacheRead);
  const cacheWrite = token(input.usage.cacheWrite);
  if (uncached === null || cacheRead === null || cacheWrite === null) {
    return { observationState: "UNOBSERVABLE", evidenceLevel: "METADATA_ONLY" };
  }
  // Pi 0.82.1 normalizes a missing cached_tokens field to zero. Positive values
  // prove provider-reported reuse; zero must remain unknown rather than MISS.
  return cacheRead > 0
    ? { observationState: "HIT", evidenceLevel: "PROVIDER_USAGE" }
    : { observationState: "UNOBSERVABLE", evidenceLevel: "METADATA_ONLY" };
}
