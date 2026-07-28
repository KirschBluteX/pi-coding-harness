import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import type {
  MemoryClaimActionInput, MemoryClaimPayload, MemoryClaimStatus, MemoryClaimVersionInput, MemoryClaimVersionRecord,
  MemoryClassification, MemoryScope, SourceAttestation,
} from "./types.js";

const shaPattern = /^[a-f0-9]{64}$/u;
const secretPattern = /(?:authorization\s*[:=]\s*(?:bearer\s+)?\S{8,}|(?:api[_-]?key|password|private[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*\S{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[a-z0-9_-]{16,})/iu;
const injectionPattern = /(?:ignore\s+(?:all\s+)?previous\s+(?:system\s+|developer\s+)?instructions|reveal\s+(?:the\s+)?system\s+prompt|you\s+are\s+now\s+(?:the\s+)?system|<\/?(?:system|developer|assistant|tool)(?:\s[^>]*)?>|\\?["']role\\?["']\s*:\s*\\?["'](?:system|developer|tool)\\?["']|(?:^|\n)\s*(?:system|developer)\s*:\s*|\[INST\]|<<SYS>>|override\s+(?:the\s+)?(?:system|developer)\s+(?:message|instructions?))/imu;

export type MemoryTextRisk = "SENSITIVE_MATERIAL_REJECTED" | "PROMPT_INJECTION_RISK_REJECTED";

export function classifyMemoryTextRisk(value: string): MemoryTextRisk | null {
  const securityText = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (secretPattern.test(securityText)) return "SENSITIVE_MATERIAL_REJECTED";
  if (injectionPattern.test(securityText)) return "PROMPT_INJECTION_RISK_REJECTED";
  return null;
}

export interface PrepareMemoryClaimInput {
  readonly claimId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly actorGoalId: string;
  readonly scope: MemoryScope;
  readonly channel: MemoryClaimVersionInput["channel"];
  readonly status?: MemoryClaimStatus;
  readonly payload: MemoryClaimPayload;
  readonly sourceAttestation: SourceAttestation;
  readonly tags?: readonly string[];
  readonly pathKey?: string | null;
  readonly dependencyKeys?: readonly string[];
  readonly classification?: MemoryClassification;
  readonly validFromMs: number;
  readonly expiresAtMs?: number | null;
  readonly supersedesVersion: number | null;
  readonly maxPayloadBytes: number;
}

export function computeMemoryActionSha256(action: Omit<MemoryClaimActionInput, "actionSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-ACTION-V2", ...action });
}

export type MemoryClaimAdmissionDecision =
  | { readonly accepted: true; readonly reason: "ADMITTED"; readonly record: MemoryClaimVersionInput }
  | { readonly accepted: false; readonly reason: string; readonly record: null };

export function normalizeMemoryTags(values: readonly string[] = []): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim().toLowerCase()).filter(Boolean))].sort().slice(0, 64);
}

export function normalizeMemoryPath(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  return normalized ? normalized.toLowerCase() : null;
}

function boundedText(value: string, maximumBytes: number): string | null {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximumBytes) return null;
  return normalized;
}

function normalizePayload(payload: MemoryClaimPayload, maximumBytes: number): MemoryClaimPayload | null {
  if (payload.type === "TYPED_POLICY") {
    const statement = boundedText(payload.statement, maximumBytes);
    if (!statement) return null;
    return { ...payload, statement, appliesTo: normalizeMemoryTags(payload.appliesTo) };
  }
  if (payload.type === "EVIDENCE_LOCATOR") {
    const locator = boundedText(payload.locator, Math.min(maximumBytes, 4096));
    const description = payload.description ? boundedText(payload.description, maximumBytes) : "";
    if (!locator || description === null) return null;
    if ((payload.lineStart === null) !== (payload.lineEnd === null)) return null;
    if (payload.lineStart !== null && (!Number.isSafeInteger(payload.lineStart) || !Number.isSafeInteger(payload.lineEnd)
      || payload.lineStart < 1 || (payload.lineEnd ?? 0) < payload.lineStart)) return null;
    return { ...payload, locator, description };
  }
  const lesson = boundedText(payload.lesson, maximumBytes);
  if (!lesson || !payload.receiptId.trim()) return null;
  if (payload.failureSignatureSha256 !== null && !shaPattern.test(payload.failureSignatureSha256)) return null;
  return { ...payload, lesson, receiptId: payload.receiptId.normalize("NFC").trim() };
}

export function memoryClaimContent(payload: MemoryClaimPayload): string {
  if (payload.type === "TYPED_POLICY") return payload.statement;
  if (payload.type === "EVIDENCE_LOCATOR") return [payload.description, payload.locator].filter(Boolean).join(" ");
  return payload.lesson;
}

export function computeSourceAttestationSha256(attestation: Omit<SourceAttestation, "attestationSha256">): string {
  const { resolver, sourceKind, locator, sourceSha256, verifiedAtMs, binding } = attestation;
  return canonicalJsonSha256({
    domain: "PCH-MEMORY-SOURCE-ATTESTATION-V2", resolver, sourceKind, locator, sourceSha256, verifiedAtMs, binding,
  });
}

export function computeMemoryClaimSha256(record: Omit<MemoryClaimVersionInput, "claimSha256">): string {
  return canonicalJsonSha256({
    domain: "PCH-MEMORY-CLAIM-V2",
    claimId: record.claimId,
    version: record.version,
    workspaceId: record.workspaceId,
    actorGoalId: record.actorGoalId,
    scope: record.scope,
    scopeGoalId: record.scopeGoalId,
    channel: record.channel,
    status: record.status,
    payload: record.payload,
    payloadSha256: record.payloadSha256,
    sourceAttestation: record.sourceAttestation,
    tags: record.tags,
    pathKey: record.pathKey,
    dependencyKeys: record.dependencyKeys,
    classification: record.classification,
    validFromMs: record.validFromMs,
    expiresAtMs: record.expiresAtMs,
    supersedesVersion: record.supersedesVersion,
    contentSha256: record.contentSha256,
    contentTokenEstimate: record.contentTokenEstimate,
  });
}

function allAdmissionText(
  payload: MemoryClaimPayload,
  attestation: SourceAttestation,
  tags: readonly string[],
  pathKey: string | null,
  dependencyKeys: readonly string[],
): string {
  return canonicalJson({ payload, locator: attestation.locator, binding: attestation.binding, tags, pathKey, dependencyKeys });
}

export function prepareMemoryClaim(input: PrepareMemoryClaimInput): MemoryClaimAdmissionDecision {
  if (!input.claimId || !input.workspaceId || !input.actorGoalId) return { accepted: false, reason: "MISSING_IDENTITY", record: null };
  if (!Number.isSafeInteger(input.version) || input.version < 1
    || input.supersedesVersion !== (input.version === 1 ? null : input.version - 1)) {
    return { accepted: false, reason: "INVALID_VERSION_CHAIN", record: null };
  }
  if (!Number.isSafeInteger(input.validFromMs) || input.validFromMs < 0
    || (input.expiresAtMs !== undefined && input.expiresAtMs !== null
      && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.validFromMs))) {
    return { accepted: false, reason: "INVALID_VALIDITY_WINDOW", record: null };
  }
  if (!shaPattern.test(input.sourceAttestation.sourceSha256)
    || input.sourceAttestation.attestationSha256 !== computeSourceAttestationSha256(input.sourceAttestation)) {
    return { accepted: false, reason: "INVALID_SOURCE_ATTESTATION", record: null };
  }
  const payload = normalizePayload(input.payload, input.maxPayloadBytes);
  if (!payload) return { accepted: false, reason: "INVALID_OR_OVERSIZE_PAYLOAD", record: null };
  if ((input.channel === "POLICY") !== (payload.type === "TYPED_POLICY")
    || (input.channel === "EVIDENCE") !== (payload.type === "EVIDENCE_LOCATOR")
    || (input.channel === "EXPERIENCE") !== (payload.type === "EXPERIENCE_RECORD")) {
    return { accepted: false, reason: "CHANNEL_PAYLOAD_MISMATCH", record: null };
  }
  const tags = normalizeMemoryTags(input.tags);
  const dependencyKeys = normalizeMemoryTags(input.dependencyKeys);
  const pathKey = normalizeMemoryPath(input.pathKey);
  const admissionText = allAdmissionText(payload, input.sourceAttestation, tags, pathKey, dependencyKeys);
  const risk = classifyMemoryTextRisk(admissionText);
  if (risk) return { accepted: false, reason: risk, record: null };
  const contentText = memoryClaimContent(payload);
  const base: Omit<MemoryClaimVersionInput, "claimSha256"> = {
    claimId: input.claimId,
    version: input.version,
    workspaceId: input.workspaceId,
    actorGoalId: input.actorGoalId,
    scope: input.scope,
    scopeGoalId: input.scope === "GOAL" ? input.actorGoalId : null,
    channel: input.channel,
    status: input.status ?? "ACTIVE",
    payload,
    payloadSha256: canonicalJsonSha256(payload),
    sourceAttestation: input.sourceAttestation,
    tags,
    pathKey,
    dependencyKeys,
    classification: input.classification ?? "INTERNAL",
    validFromMs: input.validFromMs,
    expiresAtMs: input.expiresAtMs ?? null,
    supersedesVersion: input.supersedesVersion,
    contentText,
    contentSha256: sha256Hex(contentText),
    contentTokenEstimate: Math.ceil(Buffer.byteLength(contentText, "utf8") / 4),
  };
  return { accepted: true, reason: "ADMITTED", record: { ...base, claimSha256: computeMemoryClaimSha256(base) } };
}

export function verifyMemoryClaimRecord(record: MemoryClaimVersionRecord): void {
  const { createdEventSequence, claimSha256, ...base } = record;
  void createdEventSequence;
  if (record.payloadSha256 !== canonicalJsonSha256(record.payload)
    || record.contentText !== memoryClaimContent(record.payload)
    || record.contentSha256 !== sha256Hex(record.contentText)
    || record.contentTokenEstimate !== Math.ceil(Buffer.byteLength(record.contentText, "utf8") / 4)
    || record.sourceAttestation.attestationSha256 !== computeSourceAttestationSha256(record.sourceAttestation)
    || claimSha256 !== computeMemoryClaimSha256(base)) {
    throw new TypeError(`Memory claim ${record.claimId} v${record.version} failed hash verification`);
  }
}
