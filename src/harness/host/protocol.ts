import { timingSafeEqual } from "node:crypto";
import { canonicalJson, omitProperty } from "../../authority/canonical-json.js";
import { hmacSha256Hex } from "../../foundation/crypto.js";

export const HOST_PROTOCOL_VERSION = 1 as const;
export const MAX_IPC_LINE_BYTES = 4 * 1024 * 1024;
const requestKeys = new Set(["protocol", "kind", "request_id", "nonce", "method", "params", "mac"]);
const responseKeys = new Set(["protocol", "kind", "request_id", "nonce", "ok", "result", "error", "mac"]);

export interface HostRequestEnvelope {
  readonly protocol: 1;
  readonly kind: "request";
  readonly request_id: string;
  readonly nonce: string;
  readonly method: string;
  readonly params: unknown;
  readonly mac: string;
}

export interface HostResponseEnvelope {
  readonly protocol: 1;
  readonly kind: "response";
  readonly request_id: string;
  readonly nonce: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly mac: string;
}

function unsigned<T extends HostRequestEnvelope | HostResponseEnvelope>(value: T): Omit<T, "mac"> {
  return omitProperty(value, "mac");
}

function mac(secret: Uint8Array, value: Omit<HostRequestEnvelope, "mac"> | Omit<HostResponseEnvelope, "mac">): string {
  return hmacSha256Hex(secret, canonicalJson(value));
}

function validMac(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === allowed.size;
}

export function makeHostRequest(
  secret: Uint8Array,
  input: Omit<HostRequestEnvelope, "protocol" | "kind" | "mac">,
): HostRequestEnvelope {
  const content = { protocol: HOST_PROTOCOL_VERSION, kind: "request" as const, ...input };
  return { ...content, mac: mac(secret, content) };
}

export function makeHostResponse(
  secret: Uint8Array,
  input: Omit<HostResponseEnvelope, "protocol" | "kind" | "mac">,
): HostResponseEnvelope {
  const content = { protocol: HOST_PROTOCOL_VERSION, kind: "response" as const, ...input };
  return { ...content, mac: mac(secret, content) };
}

export function assertHostRequest(secret: Uint8Array, value: unknown): asserts value is HostRequestEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("IPC_REQUEST_INVALID");
  const row = value as Record<string, unknown>;
  if (!hasOnlyKeys(row, requestKeys) || row.protocol !== HOST_PROTOCOL_VERSION || row.kind !== "request" || typeof row.request_id !== "string"
    || !/^[A-Z0-9-]{8,160}$/u.test(row.request_id) || typeof row.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(row.nonce)
    || typeof row.method !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(row.method) || !("params" in row)) {
    throw new TypeError("IPC_REQUEST_INVALID");
  }
  if (!validMac(row.mac, mac(secret, unsigned(value as HostRequestEnvelope)))) throw new TypeError("IPC_AUTH_FAILED");
}

export function assertHostResponse(secret: Uint8Array, value: unknown): asserts value is HostResponseEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("IPC_RESPONSE_INVALID");
  const row = value as Record<string, unknown>;
  const validError = row.error === null || (typeof row.error === "object" && row.error !== null && !Array.isArray(row.error)
    && Object.keys(row.error).length === 2 && typeof (row.error as Record<string, unknown>).code === "string"
    && typeof (row.error as Record<string, unknown>).message === "string");
  if (!hasOnlyKeys(row, responseKeys) || row.protocol !== HOST_PROTOCOL_VERSION || row.kind !== "response"
    || typeof row.request_id !== "string" || !/^[A-Z0-9-]{8,160}$/u.test(row.request_id)
    || typeof row.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(row.nonce) || typeof row.ok !== "boolean"
    || !("result" in row) || !validError || (row.ok ? row.error !== null : row.error === null)) {
    throw new TypeError("IPC_RESPONSE_INVALID");
  }
  if (!validMac(row.mac, mac(secret, unsigned(value as HostResponseEnvelope)))) throw new TypeError("IPC_AUTH_FAILED");
}

export function parseIpcLine(line: string): unknown {
  if (Buffer.byteLength(line, "utf8") > MAX_IPC_LINE_BYTES) throw new TypeError("IPC_LINE_TOO_LARGE");
  return JSON.parse(line) as unknown;
}
