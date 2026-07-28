import type { PromptRequestRecord } from "../context/prompt-request.js";
import { quantizeReusablePrefix } from "./prefix-governance.js";
import type { RetentionEvaluation } from "./retention.js";

export type CacheObservationState = "INELIGIBLE" | "COLD_START" | "HIT" | "MISS" | "UNOBSERVABLE" | "ERROR";
export type CacheEligibilityReason =
  | "SUPPORTED_WARM" | "FIRST_GENERATION_REQUEST" | "PROVIDER_UNSUPPORTED" | "MODEL_UNSUPPORTED"
  | "BELOW_MINIMUM" | "REQUEST_TYPE" | "TRANSPORT_RETRY" | "PREFIX_CHANGED" | "RETENTION_EXPIRED"
  | "AFFINITY_UNPROVEN" | "USAGE_UNPROVEN" | "TRANSPORT_UNOBSERVABLE";

export interface CacheEligibility {
  readonly state: Exclude<CacheObservationState, "HIT" | "MISS" | "ERROR"> | null;
  readonly eligible: boolean;
  readonly reason: CacheEligibilityReason;
  readonly appendOnlyVerified: boolean;
  readonly providerPromptLcpTokens: number | null;
  readonly eligiblePrefixTokens: number | null;
  readonly providerMinimumTokens: number | null;
  readonly providerGranularityTokens: number | null;
  readonly denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" | "PROVIDER_DECLARED_EQUIVALENT" | "UNOBSERVABLE";
}

export interface CacheEligibilityInput {
  readonly request: PromptRequestRecord;
  readonly providerSupport: "SUPPORTED" | "UNSUPPORTED" | "UNVERIFIED";
  readonly modelSupport: "SUPPORTED" | "UNSUPPORTED" | "UNVERIFIED";
  readonly requestType: "NORMAL" | "TRANSPORT_RETRY" | "NON_CACHEABLE";
  readonly providerMinimumTokens: number | null;
  readonly providerGranularityTokens: number | null;
  readonly retention: RetentionEvaluation;
}

export function evaluateCacheEligibility(input: CacheEligibilityInput): CacheEligibility {
  const request = input.request;
  const base = {
    appendOnlyVerified: request.append_only_verification === "VERIFIED",
    providerPromptLcpTokens: request.token_counts.provider_prompt_lcp_tokens,
    providerMinimumTokens: input.providerMinimumTokens,
    providerGranularityTokens: input.providerGranularityTokens,
  };
  if (input.requestType === "TRANSPORT_RETRY") {
    return { ...base, state: "INELIGIBLE", eligible: false, reason: "TRANSPORT_RETRY", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (input.requestType === "NON_CACHEABLE") {
    return { ...base, state: "INELIGIBLE", eligible: false, reason: "REQUEST_TYPE", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (input.providerSupport === "UNSUPPORTED") {
    return { ...base, state: "INELIGIBLE", eligible: false, reason: "PROVIDER_UNSUPPORTED", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (input.modelSupport === "UNSUPPORTED") {
    return { ...base, state: "INELIGIBLE", eligible: false, reason: "MODEL_UNSUPPORTED", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (input.providerSupport === "UNVERIFIED" || input.modelSupport === "UNVERIFIED"
    || request.provider_prompt_observability === "UNOBSERVABLE") {
    return { ...base, state: "UNOBSERVABLE", eligible: false, reason: "TRANSPORT_UNOBSERVABLE", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (request.history_action === "FIRST") {
    return { ...base, state: "COLD_START", eligible: false, reason: "FIRST_GENERATION_REQUEST", eligiblePrefixTokens: 0, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
  }
  if (!base.appendOnlyVerified) {
    return { ...base, state: "UNOBSERVABLE", eligible: false, reason: "PREFIX_CHANGED", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  if (base.providerPromptLcpTokens === null || input.providerMinimumTokens === null || input.providerGranularityTokens === null) {
    return { ...base, state: "UNOBSERVABLE", eligible: false, reason: "TRANSPORT_UNOBSERVABLE", eligiblePrefixTokens: null, denominatorMethod: "UNOBSERVABLE" };
  }
  const eligiblePrefixTokens = quantizeReusablePrefix(base.providerPromptLcpTokens, input.providerMinimumTokens, input.providerGranularityTokens);
  if (eligiblePrefixTokens === 0) {
    return { ...base, state: "INELIGIBLE", eligible: false, reason: "BELOW_MINIMUM", eligiblePrefixTokens, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
  }
  if (!input.retention.affinityVerified) {
    return { ...base, state: "UNOBSERVABLE", eligible: true, reason: "AFFINITY_UNPROVEN", eligiblePrefixTokens, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
  }
  if (input.retention.withinVerifiedWindow === false) {
    return { ...base, state: "COLD_START", eligible: false, reason: "RETENTION_EXPIRED", eligiblePrefixTokens, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
  }
  if (input.retention.withinVerifiedWindow !== true) {
    return { ...base, state: "UNOBSERVABLE", eligible: true, reason: "USAGE_UNPROVEN", eligiblePrefixTokens, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
  }
  return { ...base, state: null, eligible: true, reason: "SUPPORTED_WARM", eligiblePrefixTokens, denominatorMethod: "PROVIDER_PROMPT_SEQUENCE_LCP_QUANTIZED" };
}
