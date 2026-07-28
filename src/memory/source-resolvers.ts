import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { UnsafePathError } from "../foundation/errors.js";
import { computeSourceAttestationSha256 } from "./admission.js";
import type { MemoryReceiptAttestationSource, SourceAttestation } from "./types.js";

export interface ReceiptAttestationReader {
  readMemoryReceiptAttestation(receiptId: string, workspaceId: string): MemoryReceiptAttestationSource | null;
}

export interface SourceVerification {
  readonly current: boolean;
  readonly reason: "CURRENT" | "SOURCE_CHANGED" | "SOURCE_UNAVAILABLE";
  readonly sourceSha256: string | null;
}

function normalizedPath(path: string): string {
  const normalized = resolve(path).replaceAll("/", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function readContainedFile(workspaceRoot: string, requestedPath: string, maximumBytes: number): {
  readonly bytes: Buffer;
  readonly relativePath: string;
  readonly fileIdentity: string;
  readonly modifiedAtMs: number;
} {
  const root = realpathSync(resolve(workspaceRoot));
  const candidate = resolve(root, requestedPath);
  if (!contained(root, candidate)) throw new UnsafePathError("Memory source path escapes the workspace");
  const initial = lstatSync(candidate);
  if (initial.isSymbolicLink()) throw new UnsafePathError("Memory source cannot be a symbolic link");
  const actual = realpathSync(candidate);
  if (!contained(root, actual) || normalizedPath(actual) !== normalizedPath(candidate)) {
    throw new UnsafePathError("Memory source resolves through a symlink or junction");
  }
  const handle = openSync(actual, constants.O_RDONLY);
  try {
    const before = fstatSync(handle);
    if (!before.isFile()) throw new UnsafePathError("Memory source must be a regular file");
    if (initial.dev !== before.dev || initial.ino !== before.ino) {
      throw new TypeError("Memory source changed before it was opened");
    }
    if (before.size > maximumBytes) throw new RangeError("Memory source exceeds max_payload_bytes");
    const bytes = readFileSync(handle);
    const after = fstatSync(handle);
    const rebound = realpathSync(candidate);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new TypeError("Memory source changed while it was being attested");
    }
    if (!contained(root, rebound) || normalizedPath(rebound) !== normalizedPath(actual)) {
      throw new UnsafePathError("Memory source path changed during attestation");
    }
    return {
      bytes,
      relativePath: relative(root, actual).replaceAll("\\", "/"),
      fileIdentity: sha256Hex(`${before.dev}\0${before.ino}\0${before.size}`),
      modifiedAtMs: Math.trunc(before.mtimeMs),
    };
  } finally {
    closeSync(handle);
  }
}

function finish(attestation: Omit<SourceAttestation, "attestationSha256">): SourceAttestation {
  return { ...attestation, attestationSha256: computeSourceAttestationSha256(attestation) };
}

export function decodeSourceAttestation(value: unknown): SourceAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Memory source attestation is not an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["type", "resolver", "sourceKind", "locator", "sourceSha256", "verifiedAtMs", "binding", "attestationSha256"].sort();
  const actual = Object.keys(record).sort();
  const binding = record.binding;
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])
    || record.type !== "SOURCE_ATTESTATION"
    || !["USER_INPUT", "PROJECT_FILE", "AUTHORITY_RECEIPT"].includes(String(record.resolver))
    || !["USER_EXPLICIT", "PROJECT_FILE", "AUTHORITY_RECEIPT"].includes(String(record.sourceKind))
    || typeof record.locator !== "string" || record.locator.length === 0
    || typeof record.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sourceSha256)
    || !Number.isSafeInteger(record.verifiedAtMs) || Number(record.verifiedAtMs) < 0
    || typeof binding !== "object" || binding === null || Array.isArray(binding)
    || Object.values(binding).some((entry) => entry !== null && typeof entry !== "string" && typeof entry !== "number")
    || typeof record.attestationSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.attestationSha256)) {
    throw new TypeError("Memory source attestation schema is invalid");
  }
  const attestation: SourceAttestation = {
    resolver: record.resolver as SourceAttestation["resolver"],
    sourceKind: record.sourceKind as SourceAttestation["sourceKind"],
    locator: record.locator,
    sourceSha256: record.sourceSha256,
    verifiedAtMs: Number(record.verifiedAtMs),
    binding: binding as SourceAttestation["binding"],
    attestationSha256: record.attestationSha256,
  };
  const expectedSourceKind = attestation.resolver === "USER_INPUT" ? "USER_EXPLICIT" : attestation.resolver;
  if (attestation.sourceKind !== expectedSourceKind
    || computeSourceAttestationSha256(attestation) !== attestation.attestationSha256) {
    throw new TypeError("Memory source attestation binding is invalid");
  }
  return attestation;
}

export function attestUserInput(content: string, locator: string, nowMs: number): SourceAttestation {
  const normalized = content.normalize("NFC").trim();
  return finish({
    resolver: "USER_INPUT",
    sourceKind: "USER_EXPLICIT",
    locator,
    sourceSha256: sha256Hex(normalized),
    verifiedAtMs: nowMs,
    binding: { byteLength: Buffer.byteLength(normalized, "utf8"), inputSha256: sha256Hex(normalized) },
  });
}

export function attestProjectFile(
  workspaceRoot: string,
  path: string,
  maximumBytes: number,
  nowMs: number,
): SourceAttestation {
  const source = readContainedFile(workspaceRoot, path, maximumBytes);
  const sourceSha256 = sha256Hex(source.bytes);
  return finish({
    resolver: "PROJECT_FILE",
    sourceKind: "PROJECT_FILE",
    locator: `pch-file://${source.relativePath}`,
    sourceSha256,
    verifiedAtMs: nowMs,
    binding: {
      byteLength: source.bytes.byteLength,
      fileIdentity: source.fileIdentity,
      modifiedAtMs: source.modifiedAtMs,
      relativePath: source.relativePath,
    },
  });
}

function receiptSourceSha256(source: MemoryReceiptAttestationSource): string {
  return canonicalJsonSha256({
    domain: "PCH-MEMORY-RECEIPT-SOURCE-V2",
    receiptId: source.receiptId,
    goalId: source.goalId,
    workspaceId: source.workspaceId,
    result: source.result,
    bodySha256: source.bodySha256,
    outputSha256: source.outputSha256,
    failureSignatureSha256: source.failureSignatureSha256,
    issuedEventSequence: source.issuedEventSequence,
    eventSha256: source.eventSha256,
  });
}

export function attestAuthorityReceipt(
  authority: ReceiptAttestationReader,
  receiptId: string,
  workspaceId: string,
  nowMs: number,
): SourceAttestation | null {
  const source = authority.readMemoryReceiptAttestation(receiptId, workspaceId);
  if (!source) return null;
  return finish({
    resolver: "AUTHORITY_RECEIPT",
    sourceKind: "AUTHORITY_RECEIPT",
    locator: `pch-receipt://${source.receiptId}`,
    sourceSha256: receiptSourceSha256(source),
    verifiedAtMs: nowMs,
    binding: {
      bodySha256: source.bodySha256,
      eventSha256: source.eventSha256,
      goalId: source.goalId,
      issuedEventSequence: source.issuedEventSequence,
      receiptId: source.receiptId,
      result: source.result,
    },
  });
}

export function verifySourceAttestation(
  authority: ReceiptAttestationReader,
  attestation: SourceAttestation,
  workspaceId: string,
  workspaceRoot: string,
  maximumBytes: number,
  nowMs: number,
): SourceVerification {
  if (attestation.resolver === "USER_INPUT") {
    return { current: true, reason: "CURRENT", sourceSha256: attestation.sourceSha256 };
  }
  if (attestation.resolver === "PROJECT_FILE") {
    try {
      const relativePath = attestation.binding.relativePath;
      if (typeof relativePath !== "string") return { current: false, reason: "SOURCE_UNAVAILABLE", sourceSha256: null };
      const current = attestProjectFile(workspaceRoot, relativePath, maximumBytes, nowMs);
      return current.sourceSha256 === attestation.sourceSha256
        ? { current: true, reason: "CURRENT", sourceSha256: current.sourceSha256 }
        : { current: false, reason: "SOURCE_CHANGED", sourceSha256: current.sourceSha256 };
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      return { current: false, reason: "SOURCE_UNAVAILABLE", sourceSha256: null };
    }
  }
  const receiptId = attestation.binding.receiptId;
  if (typeof receiptId !== "string") return { current: false, reason: "SOURCE_UNAVAILABLE", sourceSha256: null };
  const source = authority.readMemoryReceiptAttestation(receiptId, workspaceId);
  if (!source) return { current: false, reason: "SOURCE_UNAVAILABLE", sourceSha256: null };
  const sourceSha256 = receiptSourceSha256(source);
  return sourceSha256 === attestation.sourceSha256
    ? { current: true, reason: "CURRENT", sourceSha256 }
    : { current: false, reason: "SOURCE_CHANGED", sourceSha256 };
}
