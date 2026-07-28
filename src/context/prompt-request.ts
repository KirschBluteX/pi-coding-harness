import { createId } from "../foundation/ids.js";
import { extractVerifiedProviderPrompt, type VerifiedProviderPromptExtractor } from "../cache/provider-prompt-extractor.js";
import { longestCommonTokenPrefix, providerPrefixHmac, type ProviderPromptFingerprint } from "../cache/prefix-governance.js";
import { fingerprintLogicalSequence, longestCommonMessagePrefix, prefixHmac, providerPayloadContractSha256, type LogicalSequenceFingerprint } from "./provider-prompt-prefix.js";

export class PromptHistoryRewriteError extends Error {
  constructor() {
    super("Provider-visible logical history was rewritten within one PromptGeneration");
    this.name = "PromptHistoryRewriteError";
  }
}

export interface PromptRequestRecord {
  readonly schema_version: 2;
  readonly prompt_request_id: string;
  readonly prompt_generation_id: string;
  readonly previous_prompt_request_id: string | null;
  readonly request_sequence: number;
  readonly history_action: "FIRST" | "APPEND" | "RETRY_EQUIVALENT";
  readonly append_only_verification: "VERIFIED" | "UNOBSERVABLE" | "FAILED";
  readonly logical_request_hmac_sha256: string;
  readonly logical_reusable_prefix_hmac_sha256: string | null;
  readonly provider_prompt_hmac_sha256: string | null;
  readonly provider_prompt_reusable_prefix_hmac_sha256: string | null;
  readonly provider_prompt_contract_sha256: string;
  readonly provider_prompt_observability: "EXACT_AFTER_HOOK" | "PROVIDER_DECLARED" | "UNOBSERVABLE";
  readonly reusable_prefix_method: "EXACT_PROVIDER_PROMPT_SEQUENCE_LCP" | "PROVIDER_DECLARED_EQUIVALENT" | "UNOBSERVABLE";
  readonly token_counts: {
    readonly total_input_tokens: number | null;
    readonly provider_prompt_tokens: number | null;
    readonly stable_contract_prefix_tokens: number | null;
    readonly provider_prompt_lcp_tokens: number | null;
    readonly dynamic_suffix_tokens: number | null;
    readonly response_directive_input_tokens: number;
    readonly tokenizer_source: "PROVIDER" | "PI_NORMALIZED" | "LOCAL_ESTIMATE" | "UNOBSERVABLE";
  };
  readonly response_contract_id: string | null;
  readonly directive_profile: "STABLE_POLICY_ONLY" | "COMPACT_SUFFIX" | "USER_FORMAT";
  readonly contains_prompt_content: false;
  readonly recorded_at: string;
}

export interface PromptRequestInput {
  readonly promptGenerationId: string;
  readonly logicalMessages: readonly unknown[];
  readonly providerPayload: unknown;
  readonly totalInputTokens?: number | null;
  readonly stableContractPrefixTokens?: number | null;
  readonly responseDirectiveInputTokens?: number;
  readonly responseContractId?: string | null;
  readonly directiveProfile?: PromptRequestRecord["directive_profile"];
  readonly providerIdentity?: { readonly provider: string; readonly api: string };
  readonly providerPromptExtractor?: VerifiedProviderPromptExtractor;
}

interface RequestState {
  readonly record: PromptRequestRecord;
  readonly logical: LogicalSequenceFingerprint;
  readonly providerPrompt: ProviderPromptFingerprint | null;
}

export class PromptRequestChain {
  private previous: RequestState | null = null;

  constructor(private readonly hmacKey: string | Uint8Array, private readonly now: () => Date = () => new Date()) {}

  reset(): void {
    this.previous = null;
  }

  current(): PromptRequestRecord | null {
    return this.previous?.record ?? null;
  }

  append(input: PromptRequestInput): PromptRequestRecord {
    const logical = fingerprintLogicalSequence(input.logicalMessages, this.hmacKey);
    const previous = this.previous;
    const lcp = previous ? longestCommonMessagePrefix(previous.logical.messageHmacs, logical.messageHmacs) : 0;
    if (previous && lcp < previous.logical.messageHmacs.length) throw new PromptHistoryRewriteError();
    const extraction = input.providerPromptExtractor && input.providerIdentity
      ? extractVerifiedProviderPrompt(input.providerPayload, input.providerPromptExtractor, input.providerIdentity, this.hmacKey)
      : null;
    const providerPrompt = extraction?.fingerprint ?? null;
    const providerLcp = previous && previous.providerPrompt && providerPrompt
      ? longestCommonTokenPrefix(previous.providerPrompt.tokenHmacs, providerPrompt.tokenHmacs)
      : 0;
    if (previous?.providerPrompt && providerPrompt && providerLcp < previous.providerPrompt.tokenHmacs.length) {
      throw new PromptHistoryRewriteError();
    }
    const historyAction = !previous ? "FIRST"
      : lcp === logical.messageHmacs.length && lcp === previous.logical.messageHmacs.length ? "RETRY_EQUIVALENT"
        : "APPEND";
    const providerObserved = providerPrompt !== null;
    const reusableProviderPrefixObserved = Boolean(previous?.providerPrompt && providerPrompt && providerLcp > 0);
    const record: PromptRequestRecord = {
      schema_version: 2,
      prompt_request_id: createId("PROMPT_REQ"),
      prompt_generation_id: input.promptGenerationId,
      previous_prompt_request_id: previous?.record.prompt_request_id ?? null,
      request_sequence: previous ? previous.record.request_sequence + 1 : 0,
      history_action: historyAction,
      append_only_verification: historyAction === "FIRST" ? "UNOBSERVABLE" : "VERIFIED",
      logical_request_hmac_sha256: logical.sequenceHmac,
      logical_reusable_prefix_hmac_sha256: previous ? prefixHmac(logical.messageHmacs, lcp, this.hmacKey) : null,
      provider_prompt_hmac_sha256: providerPrompt?.promptHmacSha256 ?? null,
      provider_prompt_reusable_prefix_hmac_sha256: previous && providerPrompt
        ? providerPrefixHmac(providerPrompt.tokenHmacs, providerLcp, this.hmacKey) : null,
      provider_prompt_contract_sha256: extraction?.payloadContractSha256 ?? providerPayloadContractSha256(input.providerPayload),
      provider_prompt_observability: providerObserved ? "EXACT_AFTER_HOOK" : "UNOBSERVABLE",
      reusable_prefix_method: reusableProviderPrefixObserved ? "EXACT_PROVIDER_PROMPT_SEQUENCE_LCP" : "UNOBSERVABLE",
      token_counts: {
        total_input_tokens: input.totalInputTokens ?? null,
        provider_prompt_tokens: providerPrompt?.tokenCount ?? null,
        stable_contract_prefix_tokens: input.stableContractPrefixTokens ?? null,
        provider_prompt_lcp_tokens: previous && providerPrompt ? providerLcp : null,
        dynamic_suffix_tokens: input.responseDirectiveInputTokens === undefined ? null : input.responseDirectiveInputTokens,
        response_directive_input_tokens: input.responseDirectiveInputTokens ?? 0,
        tokenizer_source: extraction?.tokenizerSource
          ?? (input.totalInputTokens === undefined || input.totalInputTokens === null ? "UNOBSERVABLE" : "PI_NORMALIZED"),
      },
      response_contract_id: input.responseContractId ?? null,
      directive_profile: input.directiveProfile ?? "STABLE_POLICY_ONLY",
      contains_prompt_content: false,
      recorded_at: this.now().toISOString(),
    };
    this.previous = { record, logical, providerPrompt };
    return record;
  }
}
