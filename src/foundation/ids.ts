import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(prefix)) throw new TypeError(`Invalid ID prefix: ${prefix}`);
  return `${prefix}-${randomUUID().toUpperCase()}`;
}

export function idFromSha256(prefix: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError("Expected lowercase SHA-256");
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(prefix)) throw new TypeError(`Invalid ID prefix: ${prefix}`);
  return `${prefix}-${sha256.toUpperCase()}`;
}
