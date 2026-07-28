import { sha256Hex } from "../foundation/crypto.js";

export type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(`${path} must be a finite JSON number within the safe magnitude`);
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not canonical JSON data`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => serialize(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
    const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key.normalize("NFC"), entry] as const);
    normalizedEntries.sort(([left], [right]) => compareCodePoints(left, right));
    for (let index = 1; index < normalizedEntries.length; index += 1) {
      if (normalizedEntries[index - 1]?.[0] === normalizedEntries[index]?.[0]) {
        throw new TypeError(`${path} contains keys that collide after NFC normalization`);
      }
    }
    return `{${normalizedEntries.map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJsonBytes(value));
}

export function parseCanonicalJson(text: string): CanonicalJson {
  const value = JSON.parse(text) as unknown;
  if (canonicalJson(value) !== text) throw new TypeError("JSON is not in PCH-CJ1 canonical form");
  return value as CanonicalJson;
}

export function omitProperty<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key)) as Omit<T, K>;
}
