import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/runtime-policy.js";
import type { CacheRequestAttributionV2 } from "./domain.js";

export const geekspaceOpenAiCompletionsIntegrationId = "geekspace-openai-completions-positive-usage-v1";

export interface GeekspaceOpenAiCompletionsContract {
  readonly integrationId: typeof geekspaceOpenAiCompletionsIntegrationId;
  readonly securityEpoch: "GEEKSPACE-OPENAI-COMPLETIONS-C1-001";
}

export interface CacheUsageClassification {
  readonly observationState: CacheRequestAttributionV2["observation_state"];
  readonly evidenceLevel: CacheRequestAttributionV2["evidence_level"];
}

const contract: GeekspaceOpenAiCompletionsContract = {
  integrationId: geekspaceOpenAiCompletionsIntegrationId,
  securityEpoch: "GEEKSPACE-OPENAI-COMPLETIONS-C1-001",
};

function normalizedBaseUrl(value: string | undefined): string | null {
  if (!value || value === "unconfigured") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

export function resolveGeekspaceOpenAiCompletions(
  config: CacheModuleConfig,
  runtime: WorkerRuntimeSelection,
): GeekspaceOpenAiCompletionsContract | null {
  if (!config.enabled || config.arm !== "C1_PREFIX"
    || config.provider_integration !== geekspaceOpenAiCompletionsIntegrationId) return null;
  if (runtime.provider.toLowerCase() !== "geekspace" || runtime.api !== "openai-completions") return null;
  if (normalizedBaseUrl(runtime.base_url) !== "https://geekspace.cloud/v1") return null;
  return contract;
}

function token(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function classifyGeekspaceOpenAiCompletionsUsage(input: {
  readonly usage: CacheRequestAttributionV2["usage"];
  readonly responseStatus: number | null;
}): CacheUsageClassification {
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
