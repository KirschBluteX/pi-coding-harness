import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { ExecutionSubjectRef } from "../task-flow/domain.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type {
  ContextCandidateRecord, ContextClassification, EvidenceValidityAxis,
  EvidenceValidityTransitionRecord, ReadEvidenceReceiptRecord,
} from "./domain.js";
import { evidenceInvalidation } from "./invalidation.js";
import { evaluateEvidence } from "./validity.js";
import type { ToolCaptureDescriptor } from "./capture-adapters.js";

const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
const knownTokenPattern = /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u;
const quotedSecretLiteralPattern = /["']?(?:authorization|api[_-]?key|password|private[_-]?key|client[_-]?secret|access[_-]?token)["']?\s*[:=]\s*(?:"(?:bearer\s+)?[^"\r\n]{8,}"|'(?:bearer\s+)?[^'\r\n]{8,}')/iu;
const envSecretLiteralPattern = /^(?:\s*export\s+)?(?:authorization|api[_-]?key|password|private[_-]?key|client[_-]?secret|access[_-]?token)\s*=\s*(?!(?:\$\{|\$env:|process\.env|<|your[_-]?|example|placeholder|change[_-]?me|redacted))[^\s#"'][^\r\n#]{7,}\s*(?:#.*)?$/imu;
const envFilePattern = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.env)$/iu;

export interface EvidenceCaptureResult {
  readonly status: "CAPTURED" | "SECRET_REFUSED" | "UNSUPPORTED";
  readonly receipt: ReadEvidenceReceiptRecord | null;
  readonly artifact: ArtifactRecord | null;
  readonly reused: boolean;
}

export interface EvidenceSourceBinding {
  readonly receiptId: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly sourceVersionHandleHmac: string;
}

export interface MutationEvidenceCheck {
  readonly receiptId: string;
  readonly valid: boolean;
  readonly reasonCode: "CURRENT" | "BINDING_UNAVAILABLE" | "SOURCE_MISSING" | "SOURCE_CHANGED" | "RECEIPT_INVALID";
}

export interface EvidenceAuthority {
  insertReadEvidenceReceipt(receipt: ReadEvidenceReceiptRecord): { readonly reused: boolean; readonly record: ReadEvidenceReceiptRecord };
  readEvidenceReceipt(receiptId: string): ReadEvidenceReceiptRecord | null;
  appendEvidenceValidityTransition(transition: EvidenceValidityTransitionRecord): { readonly reused: boolean; readonly record: EvidenceValidityTransitionRecord };
  readEvidenceValidityTransitions(receiptId: string): EvidenceValidityTransitionRecord[];
}

function containsSecret(bytes: Uint8Array, sourcePath?: string): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  return privateKeyPattern.test(text)
    || knownTokenPattern.test(text)
    || quotedSecretLiteralPattern.test(text)
    || (sourcePath !== undefined && envFilePattern.test(sourcePath.replaceAll("\\", "/"))
      && envSecretLiteralPattern.test(text));
}

function safeSourcePath(workspaceRoot: string, requested: string): { absolute: string; relative: string } {
  const root = realpathSync.native(resolve(workspaceRoot));
  const candidate = resolve(root, requested);
  if (!existsSync(candidate)) throw new TypeError("Evidence source does not exist");
  const actual = realpathSync.native(candidate);
  const rel = relative(root, actual).replaceAll("\\", "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new TypeError("Evidence source escapes the workspace");
  return { absolute: actual, relative: rel };
}

export class EvidenceCatalog {
  private readonly bindings = new Map<string, EvidenceSourceBinding>();
  private readonly latestFileReceiptByPath = new Map<string, string>();

  constructor(
    private readonly repository: EvidenceAuthority,
    private readonly artifacts: ArtifactStore,
    private readonly workspaceRoot: string,
    private readonly hmacKey: string | Uint8Array,
    private readonly nowMs: () => number = Date.now,
  ) {}

  captureFile(input: {
    readonly workspaceId: string;
    readonly subject: ExecutionSubjectRef;
    readonly path: string;
    readonly classification?: ContextClassification;
    readonly adapterVersion?: string;
  }): EvidenceCaptureResult {
    const source = safeSourcePath(this.workspaceRoot, input.path);
    const bytes = readFileSync(source.absolute);
    if (containsSecret(bytes, source.relative)) return { status: "SECRET_REFUSED", receipt: null, artifact: null, reused: false };
    const artifact = this.artifacts.put(bytes, {
      mediaType: "application/vnd.pch.exact-source", classification: input.classification ?? "INTERNAL",
      retentionClass: "GOAL_EVIDENCE",
    });
    const sourceScopeHmac = hmacSha256Hex(this.hmacKey, `FILE\0${source.relative}`);
    const sourceVersionHandleHmac = hmacSha256Hex(this.hmacKey, canonicalJson({
      path: source.relative, contentSha256: artifact.sha256, adapterVersion: input.adapterVersion ?? "pch-file-v1",
    }));
    const dependencySignatureSha256 = canonicalJsonSha256({
      domain: "PCH-EVIDENCE-DEPENDENCY-V1", workspaceId: input.workspaceId,
      sourceScopeHmac, evidenceSha256: artifact.sha256, sourceVersionHandleHmac,
      adapterVersion: input.adapterVersion ?? "pch-file-v1",
    });
    const receipt = this.receipt({
      workspaceId: input.workspaceId, subject: input.subject, sourceKind: "FILE_RANGE",
      captureKind: "FULL_FILE", evidenceSha256: artifact.sha256, artifact,
      dependencySignatureSha256, sourceScopeHmac, sourceVersionHandleHmac,
      queryCompleteness: "NOT_APPLICABLE", contentFreshness: "HASH_CURRENT",
      representationFidelity: "EXACT_RAW", classification: input.classification ?? "INTERNAL",
      adapterVersion: input.adapterVersion ?? "pch-file-v1",
    });
    const stored = this.repository.insertReadEvidenceReceipt(receipt);
    this.bindings.set(receipt.receipt_id, {
      receiptId: receipt.receipt_id, absolutePath: source.absolute, relativePath: source.relative,
      contentSha256: artifact.sha256, sourceVersionHandleHmac,
    });
    this.latestFileReceiptByPath.set(source.relative.toLowerCase(), receipt.receipt_id);
    return { status: "CAPTURED", receipt: stored.record, artifact, reused: stored.reused };
  }

  captureToolResult(input: {
    readonly workspaceId: string;
    readonly subject: ExecutionSubjectRef;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly result: string;
    readonly isError: boolean;
    readonly descriptor: ToolCaptureDescriptor;
    readonly existingArtifact?: ArtifactRecord;
  }): EvidenceCaptureResult {
    const bytes = Buffer.from(input.result, "utf8");
    const sourcePath = typeof input.toolInput.path === "string" ? input.toolInput.path : undefined;
    if (containsSecret(bytes, sourcePath)) return { status: "SECRET_REFUSED", receipt: null, artifact: null, reused: false };
    const artifact = input.existingArtifact ?? this.artifacts.put(bytes, {
      mediaType: "application/vnd.pch.tool-result", classification: "INTERNAL", retentionClass: "GOAL_EVIDENCE",
    });
    const sourceScopeHmac = hmacSha256Hex(this.hmacKey, canonicalJson({
      toolName: input.toolName, input: input.toolInput,
    }));
    const sourceKind = input.descriptor.captureKind === "QUERY_SCOPE" ? "QUERY" as const : "TOOL_RESULT" as const;
    const dependencySignatureSha256 = canonicalJsonSha256({
      domain: "PCH-EVIDENCE-DEPENDENCY-V1", workspaceId: input.workspaceId,
      toolName: input.toolName, toolInputHmac: sourceScopeHmac, adapterVersion: input.descriptor.adapterVersion,
      evidenceSha256: artifact.sha256,
    });
    const receipt = this.receipt({
      workspaceId: input.workspaceId, subject: input.subject, sourceKind,
      captureKind: input.descriptor.captureKind, evidenceSha256: artifact.sha256, artifact,
      dependencySignatureSha256, sourceScopeHmac, sourceVersionHandleHmac: null,
      queryCompleteness: input.descriptor.queryCompleteness,
      contentFreshness: sourceKind === "QUERY" ? "UNKNOWN" : "NOT_APPLICABLE",
      representationFidelity: input.descriptor.representationFidelity,
      classification: "INTERNAL", adapterVersion: input.descriptor.adapterVersion,
    });
    const stored = this.repository.insertReadEvidenceReceipt(receipt);
    return { status: "CAPTURED", receipt: stored.record, artifact, reused: stored.reused };
  }

  invalidate(input: {
    readonly receiptId: string;
    readonly axis: EvidenceValidityAxis;
    readonly value: EvidenceValidityTransitionRecord["value"];
    readonly reasonCode: string;
    readonly evidenceSha256: string;
  }): EvidenceValidityTransitionRecord {
    const receipt = this.repository.readEvidenceReceipt(input.receiptId);
    if (!receipt) throw new TypeError(`Evidence receipt ${input.receiptId} does not exist`);
    const transition = evidenceInvalidation({
      receipt, axis: input.axis, value: input.value, reasonCode: input.reasonCode,
      evidenceSha256: input.evidenceSha256, createdAtMs: this.nowMs(),
    });
    return this.repository.appendEvidenceValidityTransition(transition).record;
  }

  candidate(receiptId: string, obligationIds: readonly string[] = []): ContextCandidateRecord | null {
    const receipt = this.repository.readEvidenceReceipt(receiptId);
    if (!receipt) return null;
    const transitions = this.repository.readEvidenceValidityTransitions(receiptId);
    const eligibility = evaluateEvidence(receipt, transitions);
    return sealInputContextRecord(inputContextHashDomains.contextCandidate, "record_sha256", {
      schema_version: 1 as const,
      candidate_id: idFromSha256("IC_CANDIDATE", receipt.receipt_sha256),
      source_kind: receipt.source_kind,
      content_freshness: eligibility.validity.contentFreshness,
      scope_authorization: eligibility.validity.scopeAuthorization,
      semantic_applicability: eligibility.validity.semanticApplicability,
      representation_fidelity: eligibility.validity.representationFidelity,
      trust: receipt.source_kind === "AUTHORITY" ? "AUTHORITY" as const : "VERIFIED_EVIDENCE" as const,
      obligation_ids: [...new Set(obligationIds)].sort(),
      evidence_sha256: receipt.evidence_sha256,
      dependency_signature_sha256: receipt.dependency_signature_sha256,
      artifact_locator: `pch-cas://sha256/${receipt.evidence_sha256}`,
      estimated_tokens: null,
      classification: receipt.classification,
    });
  }

  checkMutationEvidence(receiptIds: readonly string[]): MutationEvidenceCheck[] {
    return receiptIds.map((receiptId) => {
      const receipt = this.repository.readEvidenceReceipt(receiptId);
      if (!receipt || !evaluateEvidence(receipt, this.repository.readEvidenceValidityTransitions(receiptId)).eligible) {
        return { receiptId, valid: false, reasonCode: "RECEIPT_INVALID" as const };
      }
      const binding = this.bindings.get(receiptId);
      if (!binding) return { receiptId, valid: false, reasonCode: "BINDING_UNAVAILABLE" as const };
      if (!existsSync(binding.absolutePath)) {
        this.invalidate({ receiptId, axis: "CONTENT_FRESHNESS", value: "STALE", reasonCode: "SOURCE_MISSING", evidenceSha256: receipt.evidence_sha256 });
        return { receiptId, valid: false, reasonCode: "SOURCE_MISSING" as const };
      }
      const currentSha256 = sha256Hex(readFileSync(binding.absolutePath));
      if (currentSha256 !== binding.contentSha256) {
        this.invalidate({ receiptId, axis: "CONTENT_FRESHNESS", value: "STALE", reasonCode: "SOURCE_CHANGED", evidenceSha256: currentSha256 });
        return { receiptId, valid: false, reasonCode: "SOURCE_CHANGED" as const };
      }
      return { receiptId, valid: true, reasonCode: "CURRENT" as const };
    });
  }

  receiptForPath(requestedPath: string): string | null {
    try {
      const source = safeSourcePath(this.workspaceRoot, requestedPath);
      return this.latestFileReceiptByPath.get(source.relative.toLowerCase()) ?? null;
    } catch {
      return null;
    }
  }

  open(receiptId: string): Uint8Array {
    const receipt = this.repository.readEvidenceReceipt(receiptId);
    if (!receipt) throw new TypeError(`Evidence receipt ${receiptId} does not exist`);
    if (!evaluateEvidence(receipt, this.repository.readEvidenceValidityTransitions(receiptId)).eligible) {
      throw new TypeError("Evidence is not current, authorized, applicable and exact");
    }
    return this.artifacts.open(`pch-cas://sha256/${receipt.evidence_sha256}`);
  }

  private receipt(input: {
    readonly workspaceId: string;
    readonly subject: ExecutionSubjectRef;
    readonly sourceKind: ReadEvidenceReceiptRecord["source_kind"];
    readonly captureKind: ReadEvidenceReceiptRecord["capture_kind"];
    readonly evidenceSha256: string;
    readonly artifact: ArtifactRecord;
    readonly dependencySignatureSha256: string;
    readonly sourceScopeHmac: string;
    readonly sourceVersionHandleHmac: string | null;
    readonly queryCompleteness: ReadEvidenceReceiptRecord["query_completeness"];
    readonly contentFreshness: ReadEvidenceReceiptRecord["content_freshness"];
    readonly representationFidelity: ReadEvidenceReceiptRecord["representation_fidelity"];
    readonly classification: ContextClassification;
    readonly adapterVersion: string;
  }): ReadEvidenceReceiptRecord {
    const observedAtMs = this.nowMs();
    const identity = sha256Hex([
      input.workspaceId, input.subject.bindingSha256, input.sourceKind, input.captureKind,
      input.evidenceSha256, input.dependencySignatureSha256, String(observedAtMs),
    ].join("\0"));
    return sealInputContextRecord(inputContextHashDomains.readEvidenceReceipt, "receipt_sha256", {
      schema_version: 1 as const, receipt_id: idFromSha256("IC_READ", identity),
      workspace_id: input.workspaceId, subject: input.subject, source_kind: input.sourceKind,
      capture_kind: input.captureKind, evidence_sha256: input.evidenceSha256,
      artifact_ref_hmac: hmacSha256Hex(this.hmacKey, input.artifact.locator),
      dependency_signature_sha256: input.dependencySignatureSha256,
      source_scope_hmac: input.sourceScopeHmac, source_version_handle_hmac: input.sourceVersionHandleHmac,
      query_completeness: input.queryCompleteness, content_freshness: input.contentFreshness,
      scope_authorization: "AUTHORIZED" as const, semantic_applicability: "CURRENT" as const,
      representation_fidelity: input.representationFidelity, classification: input.classification,
      adapter_version: input.adapterVersion, observed_at_ms: observedAtMs,
    });
  }
}
