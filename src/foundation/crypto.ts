import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(key: string | Uint8Array, input: string | Uint8Array): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

export function equalSha256(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
