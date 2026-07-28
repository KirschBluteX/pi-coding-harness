import { providerPayloadContractSha256 } from "../context/provider-prompt-prefix.js";
import { fingerprintProviderPromptTokens, type ProviderPromptFingerprint } from "./prefix-governance.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface VerifiedProviderPromptExtractor {
  readonly provider: string;
  readonly api: string;
  readonly contractReceiptSha256: string;
  readonly payloadContractSha256: string;
  readonly tokenizerSource: "PROVIDER" | "LOCAL_ESTIMATE";
  readonly extractPromptTokens: (payload: unknown) => readonly string[] | null;
}

export interface ProviderPromptExtraction {
  readonly fingerprint: ProviderPromptFingerprint;
  readonly payloadContractSha256: string;
  readonly contractReceiptSha256: string;
  readonly tokenizerSource: VerifiedProviderPromptExtractor["tokenizerSource"];
}

export function extractVerifiedProviderPrompt(
  payload: unknown,
  extractor: VerifiedProviderPromptExtractor,
  identity: { readonly provider: string; readonly api: string },
  hmacKey: string | Uint8Array,
): ProviderPromptExtraction | null {
  if (!sha256Pattern.test(extractor.contractReceiptSha256) || !sha256Pattern.test(extractor.payloadContractSha256)) {
    throw new TypeError("Provider prompt extractor requires hash-bound contract evidence");
  }
  if (extractor.provider !== identity.provider || extractor.api !== identity.api) return null;
  const actualContract = providerPayloadContractSha256(payload);
  if (actualContract !== extractor.payloadContractSha256) return null;
  const tokens = extractor.extractPromptTokens(payload);
  if (!tokens || tokens.some((token) => typeof token !== "string")) return null;
  return {
    fingerprint: fingerprintProviderPromptTokens(tokens, hmacKey),
    payloadContractSha256: actualContract,
    contractReceiptSha256: extractor.contractReceiptSha256,
    tokenizerSource: extractor.tokenizerSource,
  };
}
