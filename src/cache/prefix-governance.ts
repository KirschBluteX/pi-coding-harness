import { canonicalJson } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";

export interface ProviderPromptFingerprint {
  readonly tokenHmacs: readonly string[];
  readonly promptHmacSha256: string;
  readonly tokenCount: number;
}

export function fingerprintProviderPromptTokens(
  tokens: readonly string[],
  hmacKey: string | Uint8Array,
): ProviderPromptFingerprint {
  const tokenHmacs = tokens.map((token) => hmacSha256Hex(hmacKey, token.normalize("NFC")));
  return {
    tokenHmacs,
    promptHmacSha256: hmacSha256Hex(hmacKey, canonicalJson(tokenHmacs)),
    tokenCount: tokenHmacs.length,
  };
}

export function longestCommonTokenPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

export function providerPrefixHmac(
  tokenHmacs: readonly string[],
  count: number,
  hmacKey: string | Uint8Array,
): string | null {
  if (count <= 0) return null;
  return hmacSha256Hex(hmacKey, canonicalJson(tokenHmacs.slice(0, count)));
}

export function quantizeReusablePrefix(tokens: number, minimum: number, granularity: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Reusable prefix tokens must be a non-negative integer");
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new TypeError("Provider minimum must be a non-negative integer");
  if (!Number.isSafeInteger(granularity) || granularity < 1) throw new TypeError("Provider granularity must be a positive integer");
  if (tokens < minimum) return 0;
  return Math.floor(tokens / granularity) * granularity;
}
