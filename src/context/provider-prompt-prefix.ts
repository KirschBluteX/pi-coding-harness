import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";

export interface LogicalSequenceFingerprint {
  readonly messageHmacs: readonly string[];
  readonly sequenceHmac: string;
}

function transportJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Provider-visible message is not JSON serializable");
  return JSON.parse(serialized) as unknown;
}

export function fingerprintLogicalSequence(messages: readonly unknown[], hmacKey: string | Uint8Array): LogicalSequenceFingerprint {
  const messageHmacs = messages.map((message) => hmacSha256Hex(hmacKey, canonicalJson(transportJson(message))));
  return { messageHmacs, sequenceHmac: hmacSha256Hex(hmacKey, canonicalJson(messageHmacs)) };
}

export function longestCommonMessagePrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function structuralShape(value: unknown, depth = 0): unknown {
  if (depth > 8) return "depth-limit";
  if (Array.isArray(value)) return { kind: "array", sample: value.length > 0 ? structuralShape(value[0], depth + 1) : "empty" };
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, structuralShape((value as Record<string, unknown>)[key], depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

export function providerPayloadContractSha256(payload: unknown): string {
  return canonicalJsonSha256(structuralShape(payload));
}

export function prefixHmac(messageHmacs: readonly string[], count: number, hmacKey: string | Uint8Array): string | null {
  if (count <= 0) return null;
  return hmacSha256Hex(hmacKey, canonicalJson(messageHmacs.slice(0, count)));
}
