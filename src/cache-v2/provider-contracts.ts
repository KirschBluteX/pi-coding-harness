import type { CacheModuleConfig } from "../config/types.js";
import type { WorkerRuntimeSelection } from "../harness/worker/runtime-policy.js";
import { resolveCodexLocalOpenAiResponses } from "./codex-local-openai-responses.js";
import { resolveGeekspaceOpenAiCompletions } from "./geekspace-openai-completions.js";
import type { CacheProviderContract, CacheProviderContractResolver } from "./provider-contract.js";

const resolvers: readonly CacheProviderContractResolver[] = [
  resolveGeekspaceOpenAiCompletions,
  resolveCodexLocalOpenAiResponses,
];

export function resolveCacheProviderContract(
  config: CacheModuleConfig,
  runtime: WorkerRuntimeSelection,
): CacheProviderContract | null {
  for (const resolve of resolvers) {
    const contract = resolve(config, runtime);
    if (contract) return contract;
  }
  return null;
}
