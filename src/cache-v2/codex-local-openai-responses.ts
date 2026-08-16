import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/runtime-policy.js";
import {
  classifyPositiveProviderCacheRead,
  type CacheProviderContract,
  type CacheUsageObservation,
} from "./provider-contract.js";

export const codexLocalOpenAiResponsesIntegrationId = "codex-local-openai-responses-positive-usage-v1";

export interface CodexLocalOpenAiResponsesContract extends CacheProviderContract {
  readonly integrationId: typeof codexLocalOpenAiResponsesIntegrationId;
  readonly securityEpoch: "CODEX-LOCAL-OPENAI-RESPONSES-C1-002";
  readonly usageSemanticsId: "PI-0.82-USAGE-DISJOINT-INPUT-CACHE-OUTPUT-V1";
}

const contract: CodexLocalOpenAiResponsesContract = {
  integrationId: codexLocalOpenAiResponsesIntegrationId,
  securityEpoch: "CODEX-LOCAL-OPENAI-RESPONSES-C1-002",
  usageSemanticsId: "PI-0.82-USAGE-DISJOINT-INPUT-CACHE-OUTPUT-V1",
  canonicalTransportIdentity: (runtime) => ({
    provider: normalizedProvider(runtime.provider)!,
    api: "openai-responses",
    baseUrl: normalizedBaseUrl(runtime.base_url)!,
    model: runtime.model,
    thinkingLevel: runtime.thinking_level,
    contextWindow: runtime.context_window,
  }),
  classifyUsage: classifyPositiveProviderCacheRead,
};

function normalizedProvider(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizedBaseUrl(value: string | undefined): string | null {
  if (!value || value === "unconfigured") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

export function resolveCodexLocalOpenAiResponses(
  config: CacheModuleConfig,
  runtime: WorkerRuntimeSelection,
): CodexLocalOpenAiResponsesContract | null {
  if (!config.enabled || config.arm !== "C1_PREFIX"
    || config.provider_integration !== codexLocalOpenAiResponsesIntegrationId) return null;
  if (!normalizedProvider(runtime.provider) || runtime.api !== "openai-responses") return null;
  if (normalizedBaseUrl(runtime.base_url) !== "http://localhost:58493/v1") return null;
  return contract;
}

export function classifyCodexLocalOpenAiResponsesUsage(input: CacheUsageObservation) {
  return classifyPositiveProviderCacheRead(input);
}
