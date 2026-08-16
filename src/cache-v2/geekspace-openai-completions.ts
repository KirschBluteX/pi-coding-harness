import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/runtime-policy.js";
import {
  classifyPositiveProviderCacheRead,
  type CacheProviderContract,
  type CacheUsageObservation,
} from "./provider-contract.js";

export const geekspaceOpenAiCompletionsIntegrationId = "geekspace-openai-completions-positive-usage-v1";

export interface GeekspaceOpenAiCompletionsContract extends CacheProviderContract {
  readonly integrationId: typeof geekspaceOpenAiCompletionsIntegrationId;
  readonly securityEpoch: "GEEKSPACE-OPENAI-COMPLETIONS-C1-002";
  readonly usageSemanticsId: "PI-0.82-USAGE-DISJOINT-INPUT-CACHE-OUTPUT-V1";
}

const contract: GeekspaceOpenAiCompletionsContract = {
  integrationId: geekspaceOpenAiCompletionsIntegrationId,
  securityEpoch: "GEEKSPACE-OPENAI-COMPLETIONS-C1-002",
  usageSemanticsId: "PI-0.82-USAGE-DISJOINT-INPUT-CACHE-OUTPUT-V1",
  canonicalTransportIdentity: (runtime) => ({
    provider: "geekspace",
    api: "openai-completions",
    baseUrl: normalizedBaseUrl(runtime.base_url)!,
    model: runtime.model,
    thinkingLevel: runtime.thinking_level,
    contextWindow: runtime.context_window,
  }),
  classifyUsage: classifyPositiveProviderCacheRead,
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

export function classifyGeekspaceOpenAiCompletionsUsage(input: CacheUsageObservation) {
  return classifyPositiveProviderCacheRead(input);
}
