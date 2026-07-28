import { canonicalJson, canonicalJsonSha256, parseCanonicalJson, type CanonicalJson } from "../authority/canonical-json.js";
import {
  memoryV3AuthorityMetadata, memoryV3PurgeLimitation,
  type MemoryCaptureCommandResult, type MemoryV3ActionCommandResult, type MemoryV3ActionRecord, type MemoryV3ActionType,
  type MemoryV3ClaimCommandResult,
  type MemoryV3ClaimHeadRecord, type MemoryV3ClaimRecord, type MemoryV3StoreClaimInput,
} from "../authority/repositories/memory-v3.js";
import {
  defaultMemoryCaptureV31Limits, type MemoryCaptureV31IntentRecord,
  type MemoryCaptureV31ReceiptRecord, type MemoryObservationV31Record, type MemoryProposalV31Record,
} from "../authority/repositories/memory-capture-v31.js";
import type { AuthorityStore } from "../authority/transactions.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { memoryClaimContent, normalizeMemoryPath, normalizeMemoryTags, prepareMemoryClaim } from "./admission.js";
import { classifyMemorySecurityRisk } from "./security.js";
import { memorySearchTerms } from "./cjk.js";
import { memoryCaptureConceptSha256, memoryPolicySemantics, type MemoryCaptureDecision } from "./capture.js";
import { attestAuthorityReceipt, attestProjectFile, attestUserInput, decodeSourceAttestation } from "./source-resolvers.js";
import type {
  AddProjectEvidenceIntent, AddReceiptEvidenceIntent, AddReceiptExperienceIntent, AddUserPolicyIntent,
  MemoryClaimPayload, MemoryClassification, MemoryEngineConfig, MemoryQuery, MemoryScope, SourceAttestation,
} from "./types.js";
import type { MemoryVault, MemoryVaultPrepared, MemoryVaultRecord } from "./vault.js";
import { retrieveMemoryV3, type MemoryV3RecallResult } from "./v3-retrieval.js";

export interface MemoryV3Body {
  readonly schema_version: 1;
  readonly record_type: "MEMORY_V3_BODY";
  readonly claim_id: string;
  readonly version: number;
  readonly workspace_id: string;
  readonly payload: MemoryClaimPayload;
  readonly source: CanonicalJson;
  readonly tags: readonly string[];
  readonly path_key: string | null;
  readonly dependency_keys: readonly string[];
  readonly content_text: string;
  readonly content_token_estimate: number;
}

export interface OpenedMemoryV3Claim {
  readonly record: MemoryV3ClaimRecord;
  readonly head: MemoryV3ClaimHeadRecord;
  readonly body: MemoryV3Body;
}

export interface MemoryV3WriteResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly record: MemoryV3ClaimRecord | null;
  readonly authorityResult: null;
  readonly workspaceAuthorityResult: MemoryV3ClaimCommandResult | null;
  readonly additionalModelRequests: 0;
  readonly captureAuthorityResult?: MemoryCaptureCommandResult | null;
}

export interface MemoryV3ActionResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly action: MemoryV3ActionRecord | null;
  readonly authorityResult: null;
  readonly workspaceAuthorityResult: MemoryV3ActionCommandResult | null;
  readonly limitation: string | null;
  readonly additionalModelRequests: 0;
}

export interface MemoryV3ReconcileResult {
  readonly completedPurgeIntentIds: readonly string[];
  readonly completedCaptureIntentIds: readonly string[];
  readonly abortedCaptureIntentIds: readonly string[];
  readonly retiredObservationIds: readonly string[];
  readonly expiredProposalIds: readonly string[];
  readonly integrityFailureClaimIds: readonly string[];
  readonly quarantinedOrphanCount: number;
  readonly removedOrphanCount: number;
}

export interface MemoryV31ProposalPage {
  readonly items: readonly { readonly proposal: MemoryProposalV31Record; readonly opened: OpenedMemoryV3Claim }[];
  readonly nextCursor: string | null;
}

export interface MemoryV31BulkRejectResult {
  readonly rejected: number;
  readonly failedClaimIds: readonly string[];
  readonly nextCursor: string | null;
}

export interface MemoryV3MutationContext {
  readonly goalId: string | null;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly authorityContextSha256?: string | null;
}

interface PersistInput {
  readonly claimId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly sourceGoalId: string | null;
  readonly scope: MemoryScope;
  readonly scopeGoalId: string | null;
  readonly status: "PROPOSED" | "ACTIVE";
  readonly classification: MemoryClassification;
  readonly payload: MemoryClaimPayload;
  readonly source: CanonicalJson;
  readonly sourceLocatorSha256: string;
  readonly sourceContentSha256: string;
  readonly tags: readonly string[];
  readonly pathKey: string | null;
  readonly dependencyKeys: readonly string[];
  readonly validFromMs: number;
  readonly expiresAtMs: number | null;
  readonly supersedesVersion: number | null;
  readonly sourceKind: MemoryV3StoreClaimInput["sourceKind"];
  readonly sourceActor: MemoryV3StoreClaimInput["sourceActor"];
  readonly decisionActor: MemoryV3StoreClaimInput["decisionActor"];
  readonly route: MemoryV3StoreClaimInput["route"];
  readonly disposition: MemoryV3StoreClaimInput["disposition"];
  readonly reasonCodes: readonly string[];
  readonly candidateSha256: string;
  readonly idempotencyKey: string;
}

interface MemoryV31ObservationBody {
  readonly schema_version: 1;
  readonly record_type: "MEMORY_V31_OBSERVATION";
  readonly intent_id: string;
  readonly normalized_text: string;
  readonly policy: MemoryCaptureDecision["policy"];
}

interface QualifiedCaptureEvidence {
  readonly eligible: boolean;
  readonly observations: readonly MemoryObservationV31Record[];
  readonly latestIntent: MemoryCaptureV31IntentRecord | null;
  readonly evidenceManifestSha256: string;
}

const minimumVerifiedRouteFailureObservations = 2;

function failedWrite(reason: string): MemoryV3WriteResult {
  return { accepted: false, reason, record: null, authorityResult: null, workspaceAuthorityResult: null, additionalModelRequests: 0 };
}

function failedAction(reason: string): MemoryV3ActionResult {
  return { accepted: false, reason, action: null, authorityResult: null, workspaceAuthorityResult: null,
    limitation: null, additionalModelRequests: 0 };
}

function canonical(value: unknown): CanonicalJson {
  return parseCanonicalJson(canonicalJson(value));
}

function sourceValue(attestation: SourceAttestation): CanonicalJson {
  return canonical({ type: "SOURCE_ATTESTATION", ...attestation });
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(Array.from(value).length / 4));
}

function bodyValue(value: unknown): MemoryV3Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityIntegrityError("Memory v3 Vault body is not an object");
  }
  const body = value as Partial<MemoryV3Body> & Record<string, unknown>;
  const expected = ["schema_version", "record_type", "claim_id", "version", "workspace_id", "payload",
    "source", "tags", "path_key", "dependency_keys", "content_text", "content_token_estimate"].sort();
  const actual = Object.keys(body).sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])
    || body.schema_version !== 1 || body.record_type !== "MEMORY_V3_BODY"
    || typeof body.claim_id !== "string" || !Number.isSafeInteger(body.version)
    || typeof body.workspace_id !== "string" || typeof body.content_text !== "string"
    || !Number.isSafeInteger(body.content_token_estimate) || !Array.isArray(body.tags)
    || !Array.isArray(body.dependency_keys) || (body.path_key !== null && typeof body.path_key !== "string")
    || typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload)
    || !["TYPED_POLICY", "EVIDENCE_LOCATOR", "EXPERIENCE_RECORD"].includes(String((body.payload as { type?: unknown }).type))) {
    throw new AuthorityIntegrityError("Memory v3 Vault body schema is invalid");
  }
  if ((body.tags as unknown[]).some((entry) => typeof entry !== "string")
    || (body.dependency_keys as unknown[]).some((entry) => typeof entry !== "string")) {
    throw new AuthorityIntegrityError("Memory v3 Vault body terms are invalid");
  }
  try { decodeSourceAttestation(body.source); }
  catch (error) {
    throw new AuthorityIntegrityError(`Memory v3 Vault source is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return body as unknown as MemoryV3Body;
}

function observationBodyValue(value: unknown, intentId: string): MemoryV31ObservationBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityIntegrityError("Memory v3.1 observation body is not an object");
  }
  const body = value as Partial<MemoryV31ObservationBody> & Record<string, unknown>;
  const expected = ["schema_version", "record_type", "intent_id", "normalized_text", "policy"].sort();
  const actual = Object.keys(body).sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])
    || body.schema_version !== 1 || body.record_type !== "MEMORY_V31_OBSERVATION"
    || body.intent_id !== intentId || typeof body.normalized_text !== "string" || !body.normalized_text.trim()
    || (body.policy !== null && (typeof body.policy !== "object" || Array.isArray(body.policy)))) {
    throw new AuthorityIntegrityError("Memory v3.1 observation body schema is invalid");
  }
  return body as unknown as MemoryV31ObservationBody;
}

export class MemoryV3Engine {
  constructor(
    private readonly authority: AuthorityStore,
    private readonly vault: MemoryVault,
    private readonly workspaceSecret: Uint8Array,
    private readonly maximumPayloadBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    if (workspaceSecret.byteLength < 16) throw new TypeError("Memory v3 term key is too short");
  }

  addUserPolicy(intent: AddUserPolicyIntent, context: MemoryV3MutationContext): MemoryV3WriteResult {
    if (intent.scope === "GOAL" && !context.goalId) return failedWrite("GOAL_SCOPE_REQUIRES_ACTIVE_GOAL");
    const policy = memoryPolicySemantics(intent.statement.normalize("NFC").trim());
    const claimId = this.claimId(context.workspaceId, intent.scope, "POLICY", canonicalJsonSha256(policy));
    const attestation = attestUserInput(policy.statement, `pch-user://memory/${claimId}/v1`, this.now());
    const admitted = prepareMemoryClaim({
      claimId, version: 1, workspaceId: context.workspaceId, actorGoalId: context.goalId ?? "GOAL-NONE",
      scope: intent.scope, channel: "POLICY", payload: policy, sourceAttestation: attestation,
      tags: intent.tags ?? [], pathKey: intent.pathKey ?? null, dependencyKeys: intent.dependencyKeys ?? [],
      classification: intent.classification ?? "INTERNAL", validFromMs: this.now(),
      expiresAtMs: intent.expiresAtMs ?? null, supersedesVersion: null, maxPayloadBytes: this.maximumPayloadBytes,
    });
    if (!admitted.accepted) return failedWrite(admitted.reason);
    const existing = this.authority.readMemoryV3Claim(claimId);
    if (existing) {
      try {
        const opened = this.open(claimId, context.workspaceId, context.goalId);
        return opened?.body.content_text === admitted.record.contentText
          ? { accepted: true, reason: "REUSED_EXISTING_CLAIM", record: existing, authorityResult: null,
            workspaceAuthorityResult: null, additionalModelRequests: 0 }
          : failedWrite("CLAIM_EXISTS_USE_EDIT");
      } catch { return failedWrite("CLAIM_INTEGRITY_FAILED"); }
    }
    return this.persist({
      claimId, version: 1, workspaceId: context.workspaceId, sourceGoalId: context.goalId,
      scope: admitted.record.scope, scopeGoalId: admitted.record.scopeGoalId, status: "ACTIVE",
      classification: admitted.record.classification, payload: admitted.record.payload,
      source: sourceValue(admitted.record.sourceAttestation), sourceLocatorSha256: sha256Hex(admitted.record.sourceAttestation.locator),
      sourceContentSha256: admitted.record.sourceAttestation.sourceSha256, tags: admitted.record.tags,
      pathKey: admitted.record.pathKey, dependencyKeys: admitted.record.dependencyKeys,
      validFromMs: admitted.record.validFromMs, expiresAtMs: admitted.record.expiresAtMs,
      supersedesVersion: null, sourceKind: "MANUAL_COMMAND", sourceActor: "USER", decisionActor: "USER",
      route: "MANUAL", disposition: "NOT_APPLICABLE", reasonCodes: ["USER_EXPLICIT_MEMORY"],
      candidateSha256: canonicalJsonSha256({ claimId, version: 1, payloadSha256: admitted.record.payloadSha256 }),
      idempotencyKey: `memory-v3:claim:${claimId}:1`,
    });
  }

  addProjectEvidence(intent: AddProjectEvidenceIntent, context: MemoryV3MutationContext): MemoryV3WriteResult {
    if (intent.scope === "GOAL" && !context.goalId) return failedWrite("GOAL_SCOPE_REQUIRES_ACTIVE_GOAL");
    let attestation: SourceAttestation;
    try { attestation = attestProjectFile(context.workspaceRoot, intent.path, this.maximumPayloadBytes, this.now()); }
    catch (error) { return failedWrite(error instanceof Error ? `PROJECT_SOURCE_REJECTED:${error.message}` : "PROJECT_SOURCE_REJECTED"); }
    return this.addAttested({
      payload: { type: "EVIDENCE_LOCATOR", evidenceKind: "PROJECT_FILE", locator: attestation.locator,
        description: intent.description ?? "", lineStart: intent.lineStart ?? null, lineEnd: intent.lineEnd ?? null },
      channel: "EVIDENCE", scope: intent.scope, attestation, tags: intent.tags ?? [], pathKey: intent.path,
      dependencyKeys: intent.dependencyKeys ?? [], classification: "INTERNAL",
    }, context);
  }

  addReceiptEvidence(intent: AddReceiptEvidenceIntent, context: MemoryV3MutationContext): MemoryV3WriteResult {
    if (intent.scope === "GOAL" && !context.goalId) return failedWrite("GOAL_SCOPE_REQUIRES_ACTIVE_GOAL");
    const attestation = attestAuthorityReceipt(this.authority, intent.receiptId, context.workspaceId, this.now());
    if (!attestation) return failedWrite("RECEIPT_NOT_FOUND_OR_OUT_OF_SCOPE");
    return this.addAttested({
      payload: { type: "EVIDENCE_LOCATOR", evidenceKind: "AUTHORITY_RECEIPT", locator: attestation.locator,
        description: intent.description ?? "", lineStart: null, lineEnd: null },
      channel: "EVIDENCE", scope: intent.scope, attestation, tags: intent.tags ?? [], pathKey: null,
      dependencyKeys: intent.dependencyKeys ?? [], classification: "INTERNAL",
    }, context);
  }

  addReceiptExperience(intent: AddReceiptExperienceIntent, context: MemoryV3MutationContext): MemoryV3WriteResult {
    if (intent.scope === "GOAL" && !context.goalId) return failedWrite("GOAL_SCOPE_REQUIRES_ACTIVE_GOAL");
    const receipt = this.authority.readMemoryReceiptAttestation(intent.receiptId, context.workspaceId);
    const attestation = attestAuthorityReceipt(this.authority, intent.receiptId, context.workspaceId, this.now());
    if (!receipt || !attestation) return failedWrite("RECEIPT_NOT_FOUND_OR_OUT_OF_SCOPE");
    return this.addAttested({
      payload: { type: "EXPERIENCE_RECORD", lesson: intent.lesson, outcome: receipt.result,
        receiptId: receipt.receiptId, failureSignatureSha256: receipt.failureSignatureSha256 },
      channel: "EXPERIENCE", scope: intent.scope, attestation, tags: intent.tags ?? [], pathKey: null,
      dependencyKeys: intent.dependencyKeys ?? [], classification: "INTERNAL",
    }, context);
  }

  storeCapture(decision: MemoryCaptureDecision, idempotencyKey: string): MemoryV3WriteResult {
    if (!decision.normalizedText || decision.route === "REJECT") return failedWrite("CAPTURE_NOT_STORABLE");
    const risk = classifyMemorySecurityRisk(decision.normalizedText);
    if (risk) return failedWrite(risk);
    let begun;
    try {
      begun = this.authority.beginMemoryV31Capture(decision, idempotencyKey, defaultMemoryCaptureV31Limits);
    } catch (error) {
      return failedWrite(error instanceof Error ? `CAPTURE_BEGIN_FAILED:${error.message}` : "CAPTURE_BEGIN_FAILED");
    }
    const existingReceipt = this.authority.readMemoryV31CaptureReceipt(begun.intent.intentId);
    if (existingReceipt) return this.captureReceiptResult(existingReceipt, begun.captureCommand);

    if (decision.route === "PROPOSE_ONLY") {
      let prepared: MemoryVaultPrepared | null = null;
      try {
        prepared = this.prepareObservation(decision, begun.intent.intentId);
        const preparedInput = {
          observationId: prepared.claimId, workspaceId: prepared.workspaceId,
          authorityMetadataSha256: prepared.authorityMetadataSha256, bodySha256: prepared.bodySha256,
          vaultRefSha256: prepared.vaultRefSha256, keyRefSha256: prepared.keyRefSha256,
          ciphertextSha256: prepared.ciphertextSha256, wrappedKeySha256: prepared.wrappedKeySha256,
        };
        this.authority.markMemoryV31CaptureVaultPrepared(begun.intent.intentId, preparedInput);
        const committed = this.authority.commitMemoryV31Observation(
          begun.intent.intentId, preparedInput, defaultMemoryCaptureV31Limits,
        );
        if (!committed.observation || committed.observation.observationId !== prepared.claimId) {
          this.vault.discardPrepared(prepared);
        }
        const existingRecord = committed.receipt.claimId
          ? this.authority.readMemoryV3Claim(committed.receipt.claimId) : null;
        const proposal = this.materializeEligibleProposals(decision.workspaceId);
        return {
          accepted: true, reason: committed.receipt.reasonCode, record: existingRecord ?? proposal,
          authorityResult: null, workspaceAuthorityResult: null, additionalModelRequests: 0,
          captureAuthorityResult: begun.captureCommand,
        };
      } catch (error) {
        if (prepared && !this.authority.readMemoryV31PreparedVault(begun.intent.intentId)) {
          try { this.vault.discardPrepared(prepared); } catch { /* Preserve the primary capture failure. */ }
        }
        return { ...failedWrite(error instanceof Error ? `CAPTURE_OBSERVATION_FAILED:${error.message}` : "CAPTURE_OBSERVATION_FAILED"),
          captureAuthorityResult: begun.captureCommand };
      }
    }

    const payload: MemoryClaimPayload = decision.channel === "EXPERIENCE"
      ? { type: "EXPERIENCE_RECORD", lesson: decision.normalizedText, outcome: "FAILED",
        receiptId: `capture:${decision.candidateSha256}`, failureSignatureSha256: null }
      : decision.policy ?? memoryPolicySemantics(decision.normalizedText);
    const claimId = this.claimId(decision.workspaceId, decision.scope, decision.channel,
      decision.conceptSha256 ?? decision.candidateSha256);
    const existing = this.authority.readMemoryV3ClaimHead(claimId);
    if (existing) {
      try {
        const opened = this.open(claimId, decision.workspaceId, decision.goalId);
        if (opened?.body.content_text === memoryClaimContent(payload)) {
          this.authority.commitMemoryV31Claim(begun.intent.intentId, claimId, "ACTIVE");
          return { accepted: true, reason: "REUSED_EXISTING_CLAIM", record: opened.record, authorityResult: null,
            workspaceAuthorityResult: null, additionalModelRequests: 0, captureAuthorityResult: begun.captureCommand };
        }
      } catch { /* A new version below will either repair or fail closed. */ }
    }
    const source = sourceValue(attestUserInput(
      decision.normalizedText,
      `pch-capture://${decision.candidateSha256}`,
      this.now(),
    ));
    const write = this.persist({
      claimId, version: existing ? existing.version + 1 : 1, workspaceId: decision.workspaceId, sourceGoalId: decision.goalId,
      scope: decision.scope, scopeGoalId: decision.scope === "GOAL" ? decision.goalId : null,
      status: "ACTIVE",
      classification: decision.classification, payload, source,
      sourceLocatorSha256: decision.sourceLocatorSha256, sourceContentSha256: decision.sourceContentSha256,
      tags: [], pathKey: null, dependencyKeys: [], validFromMs: this.now(), expiresAtMs: null,
      supersedesVersion: existing?.version ?? null, sourceKind: decision.sourceKind, sourceActor: decision.sourceActor,
      decisionActor: decision.decisionActor, route: decision.route, disposition: decision.disposition,
      reasonCodes: decision.reasonCodes, candidateSha256: decision.candidateSha256,
      idempotencyKey: `memory-v3:capture:${idempotencyKey}`,
    });
    if (!write.accepted || !write.record) {
      try { this.authority.abortMemoryV31Capture(begun.intent.intentId, "CLAIM_WRITE_REJECTED"); } catch { /* Original result remains decisive. */ }
      return { ...write, captureAuthorityResult: begun.captureCommand };
    }
    this.authority.commitMemoryV31Claim(begun.intent.intentId, write.record.claimId, "ACTIVE");
    return { ...write, captureAuthorityResult: begun.captureCommand };
  }

  correct(claimId: string, replacement: string, context: MemoryV3MutationContext): MemoryV3WriteResult {
    const opened = this.open(claimId, context.workspaceId, context.goalId);
    if (!opened) return failedWrite("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    if (opened.head.purgeState !== "PRESENT") return failedWrite("CLAIM_PURGED");
    const payload = opened.body.payload.type === "TYPED_POLICY" ? memoryPolicySemantics(replacement)
      : opened.body.payload.type === "EVIDENCE_LOCATOR" ? { ...opened.body.payload, description: replacement }
        : { ...opened.body.payload, lesson: replacement };
    const attestation = attestUserInput(replacement, `pch-user://memory/${claimId}/v${opened.record.version + 1}`, this.now());
    return this.persist({
      claimId, version: opened.record.version + 1, workspaceId: context.workspaceId, sourceGoalId: context.goalId,
      scope: opened.record.scope, scopeGoalId: opened.record.scopeGoalId, status: "ACTIVE",
      classification: opened.record.classification, payload, source: sourceValue(attestation),
      sourceLocatorSha256: sha256Hex(attestation.locator), sourceContentSha256: attestation.sourceSha256,
      tags: opened.body.tags, pathKey: opened.body.path_key, dependencyKeys: opened.body.dependency_keys,
      validFromMs: this.now(), expiresAtMs: opened.record.expiresAtMs,
      supersedesVersion: opened.record.version, sourceKind: "MANUAL_COMMAND", sourceActor: "USER",
      decisionActor: "USER", route: "MANUAL", disposition: "NOT_APPLICABLE", reasonCodes: ["USER_CORRECTION"],
      candidateSha256: canonicalJsonSha256({ claimId, version: opened.record.version + 1, replacementSha256: sha256Hex(replacement) }),
      idempotencyKey: `memory-v3:correct:${claimId}:${opened.record.version + 1}:${sha256Hex(replacement)}`,
    });
  }

  approve(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult {
    const proposal = this.authority.readMemoryV31ProposalForClaim(claimId);
    let opened: OpenedMemoryV3Claim | null;
    try { opened = this.open(claimId, context.workspaceId, context.goalId); }
    catch { return failedAction("APPROVAL_VAULT_INTEGRITY_FAILED"); }
    if (!opened || opened.head.proposalState !== "PROPOSED") return failedAction("PROPOSAL_NOT_ACTIVE");
    if (!proposal || proposal.workspaceId !== context.workspaceId || proposal.claimId !== claimId) {
      return failedAction("PROPOSAL_BINDING_MISSING");
    }
    if (proposal.expiresAtMs <= this.now()) {
      const expired = this.action(claimId, "REJECT", "PROPOSAL_EXPIRED", context);
      if (expired.accepted) this.authority.resolveMemoryV31Proposal(proposal.proposalId, "EXPIRED", expired.action?.actionId ?? null);
      return failedAction("PROPOSAL_EXPIRED");
    }
    const evidence = this.qualifiedCaptureEvidence(context.workspaceId, proposal.conceptSha256);
    const sourceIntent = evidence.latestIntent;
    if (!evidence.eligible || !sourceIntent || sourceIntent.intentId !== proposal.sourceIntentId
      || evidence.evidenceManifestSha256 !== proposal.evidenceManifestSha256
      || sourceIntent.conceptSha256 !== proposal.conceptSha256) {
      return failedAction("PROPOSAL_EVIDENCE_STALE_OR_INSUFFICIENT");
    }
    if (sourceIntent.authorityContextSha256 !== null
      && sourceIntent.authorityContextSha256 !== (context.authorityContextSha256 ?? null)) {
      return failedAction("AUTHORITY_CONTEXT_CHANGED_REVIEW_REQUIRED");
    }
    const securityRisk = classifyMemorySecurityRisk(canonicalJson({
      payload: opened.body.payload, source: opened.body.source, content: opened.body.content_text,
    }));
    if (securityRisk) return failedAction(securityRisk);
    let source: SourceAttestation;
    try { source = decodeSourceAttestation(opened.body.source); }
    catch { return failedAction("PROPOSAL_SOURCE_INTEGRITY_FAILED"); }
    if (source.sourceSha256 !== opened.record.sourceContentSha256
      || sha256Hex(source.locator) !== opened.record.sourceLocatorSha256) {
      return failedAction("PROPOSAL_SOURCE_INTEGRITY_FAILED");
    }
    if (opened.body.payload.type === "TYPED_POLICY") {
      const policy = opened.body.payload;
      if (!policy.semanticKey || !policy.operator || !policy.value) {
        return failedAction("PROPOSAL_SEMANTICS_INCOMPLETE");
      }
      const semanticSha256 = sha256Hex(policy.semanticKey);
      const conceptSha256 = memoryCaptureConceptSha256(
        { ...policy, semanticKey: policy.semanticKey, operator: policy.operator, value: policy.value },
        opened.record.channel, opened.record.scope, opened.record.scopeGoalId, null, this.workspaceSecret,
      );
      if (opened.record.semanticKeySha256 !== semanticSha256
        || proposal.conceptSha256 !== conceptSha256) {
        return failedAction("PROPOSAL_SEMANTIC_IDENTITY_CHANGED");
      }
      const semanticTerm = hmacSha256Hex(this.workspaceSecret,
        `PCH-MEMORY-V3-TERM\0SEMANTIC_KEY\0${policy.semanticKey.normalize("NFKC").toLowerCase()}`);
      const active = this.authority.readMemoryV3SemanticPolicyHeads(
        context.workspaceId, context.goalId, opened.record.scope, semanticTerm, 128,
      );
      for (const head of active.matches) {
        if (head.claimId === claimId) continue;
        try {
          const competing = this.open(head.claimId, context.workspaceId, context.goalId);
          if (competing?.body.payload.type === "TYPED_POLICY"
            && (competing.body.payload.operator !== policy.operator
              || competing.body.payload.value !== policy.value)) {
            return failedAction("ACTIVE_CONFLICT_REVIEW_REQUIRED");
          }
        } catch { return failedAction("ACTIVE_CONFLICT_INTEGRITY_FAILED"); }
      }
    }
    const result = this.action(claimId, "APPROVE", "USER_APPROVED_REVALIDATED", context);
    if (result.accepted) {
      this.authority.resolveMemoryV31Proposal(proposal.proposalId, "APPROVED", result.action?.actionId ?? null);
    }
    return result;
  }

  reject(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult {
    const proposal = this.authority.readMemoryV31ProposalForClaim(claimId);
    const result = this.action(claimId, "REJECT", "USER_REJECTED", context);
    if (result.accepted && proposal) {
      this.authority.resolveMemoryV31Proposal(proposal.proposalId, "REJECTED", result.action?.actionId ?? null);
      let limitation: string | null = null;
      try {
        this.retireCaptureEvidence(context.workspaceId, proposal.conceptSha256, "USER_REJECTED");
        this.purgeClaimKeys(context.workspaceId, claimId, "USER", "USER_REJECTED_PROPOSAL_KEYS");
      } catch (error) {
        limitation = `Proposal is rejected and hidden; local key cleanup requires reconciliation: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { ...result, limitation };
    }
    return result;
  }
  endorse(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult { return this.action(claimId, "ENDORSE", "USER_ENDORSED", context); }
  unendorse(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult { return this.action(claimId, "REVOKE_ENDORSEMENT", "USER_REVOKED_ENDORSEMENT", context); }
  forget(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult { return this.action(claimId, "FORGET", "USER_FORGOT", context); }

  restore(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult {
    let opened: OpenedMemoryV3Claim | null;
    try { opened = this.open(claimId, context.workspaceId, context.goalId); }
    catch { return failedAction("CLAIM_VAULT_INTEGRITY_FAILED"); }
    if (!opened) return failedAction("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    return this.action(claimId, "RESTORE", "USER_RESTORED", context);
  }

  purge(claimId: string, context: MemoryV3MutationContext): MemoryV3ActionResult {
    const head = this.boundHead(claimId, context.workspaceId, context.goalId);
    if (!head) return failedAction("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    try {
      const proposal = this.authority.readMemoryV31ProposalForClaim(claimId);
      const cluster = this.authority.readMemoryV31ClusterForClaim(context.workspaceId, claimId);
      const result = this.purgeClaimKeys(context.workspaceId, claimId, "USER", "USER_PURGED_LOCAL_KEYS");
      if (!result) return failedAction("CLAIM_ALREADY_PURGED");
      if (proposal) this.authority.resolveMemoryV31Proposal(proposal.proposalId, "PURGED", result.action.actionId);
      const conceptSha256 = proposal?.conceptSha256 ?? cluster?.conceptSha256 ?? null;
      if (conceptSha256) this.retireCaptureEvidence(context.workspaceId, conceptSha256, "PURGED");
      return { accepted: true, reason: "PURGED_LOCAL_KEY", action: result.action, authorityResult: null,
        workspaceAuthorityResult: result, limitation: memoryV3PurgeLimitation, additionalModelRequests: 0 };
    } catch (error) {
      return failedAction(error instanceof Error ? `PURGE_FAILED:${error.message}` : "PURGE_FAILED");
    }
  }

  open(claimId: string, workspaceId: string, goalId: string | null): OpenedMemoryV3Claim | null {
    const head = this.boundHead(claimId, workspaceId, goalId);
    if (!head) return null;
    const record = this.authority.readMemoryV3Claim(claimId, head.version);
    if (!record) throw new AuthorityIntegrityError("Memory v3 head references a missing claim");
    return this.openResolved(head, record);
  }

  private openResolved(head: MemoryV3ClaimHeadRecord, record: MemoryV3ClaimRecord): OpenedMemoryV3Claim {
    if (head.claimId !== record.claimId || head.version !== record.version || head.claimSha256 !== record.claimSha256
      || head.purgeState !== "PRESENT") {
      throw new AuthorityIntegrityError("Memory v3 resolved claim is stale or unavailable");
    }
    const body = bodyValue(this.vault.open(this.vaultRecord(record)));
    if (body.claim_id !== record.claimId || body.version !== record.version || body.workspace_id !== record.workspaceId
      || body.payload.type !== record.payloadType || body.content_text !== memoryClaimContent(body.payload)
      || body.content_token_estimate !== tokenEstimate(body.content_text)) {
      throw new AuthorityIntegrityError("Memory v3 decrypted body does not match authority metadata");
    }
    return { record, head, body };
  }

  proposed(workspaceId: string, goalId: string | null, limit: number): OpenedMemoryV3Claim[] {
    return this.proposalPage(workspaceId, goalId, limit).items.map((entry) => entry.opened);
  }

  proposalPage(
    workspaceId: string,
    goalId: string | null,
    limit: number,
    afterProposalId: string | null = null,
  ): MemoryV31ProposalPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("Memory proposal page limit must be between 1 and 64");
    const rows = this.authority.readMemoryV31ActiveProposals(workspaceId, limit + 1, afterProposalId);
    const pageRows = rows.slice(0, limit);
    const items: { proposal: MemoryProposalV31Record; opened: OpenedMemoryV3Claim }[] = [];
    for (const proposal of pageRows) {
      try {
        const opened = this.open(proposal.claimId, workspaceId, goalId);
        if (opened?.head.proposalState === "PROPOSED" && opened.head.visibility === "VISIBLE") {
          items.push({ proposal, opened });
        }
      }
      catch { /* A broken optional claim stays fail-closed. */ }
    }
    return { items, nextCursor: rows.length > limit ? pageRows.at(-1)?.proposalId ?? null : null };
  }

  rejectAllProposals(context: MemoryV3MutationContext, limit = 64): MemoryV31BulkRejectResult {
    const page = this.proposalPage(context.workspaceId, context.goalId, limit);
    const failed: string[] = [];
    let rejected = 0;
    for (const item of page.items) {
      const result = this.reject(item.opened.record.claimId, context);
      if (result.accepted) rejected += 1;
      else failed.push(item.opened.record.claimId);
    }
    return { rejected, failedClaimIds: failed, nextCursor: page.nextCursor };
  }

  retrieve(query: MemoryQuery, config: MemoryEngineConfig): MemoryV3RecallResult {
    return retrieveMemoryV3(
      this.authority,
      (head, record) => this.openResolved(head, record),
      this.workspaceSecret,
      config,
      query,
    );
  }

  reconcile(workspaceId: string): MemoryV3ReconcileResult {
    const completed: string[] = [];
    for (const intent of this.authority.readPendingMemoryV3PurgeIntents(workspaceId, 100)) {
      const versions = this.authority.readMemoryV3ClaimVersions(intent.claimId);
      for (const version of versions) this.vault.destroyKey(version);
      this.authority.recordMemoryV3Action({
        workspaceId, claimId: intent.claimId, targetVersion: intent.targetVersion,
        actionType: "PURGE_LOCAL_KEY", sourceActor: "RUNTIME", reasonCode: "PURGE_CRASH_RECONCILED",
        purgeIntentId: intent.intentId,
      }, `memory-v3:purge-commit:${intent.intentId}`);
      completed.push(intent.intentId);
    }
    const completedCapture: string[] = [];
    const abortedCapture: string[] = [];
    for (const intent of this.authority.readPendingMemoryV31CaptureIntents(workspaceId, 100)) {
      const stored = this.authority.readMemoryV31StoredClaimForIntent(intent.intentId);
      if (stored) {
        this.authority.commitMemoryV31Claim(intent.intentId, stored.claimId, stored.status);
        completedCapture.push(intent.intentId);
        continue;
      }
      const prepared = this.authority.readMemoryV31PreparedVault(intent.intentId);
      if (prepared && intent.route === "PROPOSE_ONLY") {
        this.authority.commitMemoryV31Observation(intent.intentId, prepared, defaultMemoryCaptureV31Limits);
        completedCapture.push(intent.intentId);
        continue;
      }
      this.authority.abortMemoryV31Capture(intent.intentId, "BODY_UNAVAILABLE_AFTER_RECOVERY");
      abortedCapture.push(intent.intentId);
    }
    const retired = this.authority.retireExpiredMemoryV31Observations(workspaceId, 128);
    for (const observation of retired) this.vault.destroyKey(this.observationVaultRecord(observation));
    this.materializeEligibleProposals(workspaceId);
    const expiredProposalIds: string[] = [];
    for (const proposal of this.authority.readExpiredMemoryV31Proposals(workspaceId, 128)) {
      let actionId: string | null = null;
      const head = this.authority.readMemoryV3ClaimHead(proposal.claimId);
      if (head?.proposalState === "PROPOSED") {
        const result = this.authority.recordMemoryV3Action({
          workspaceId, claimId: proposal.claimId, targetVersion: head.version, actionType: "REJECT",
          sourceActor: "RUNTIME", reasonCode: "PROPOSAL_EXPIRED", purgeIntentId: null,
        }, `memory-v31:expire:${proposal.proposalId}`);
        actionId = result.action.actionId;
      }
      this.authority.resolveMemoryV31Proposal(proposal.proposalId, "EXPIRED", actionId);
      this.retireCaptureEvidence(workspaceId, proposal.conceptSha256, "PURGED");
      this.purgeClaimKeys(workspaceId, proposal.claimId, "RUNTIME", "EXPIRED_PROPOSAL_KEYS");
      expiredProposalIds.push(proposal.proposalId);
    }
    const claimReferences = this.authority.readMemoryV3VaultReferences(workspaceId);
    const observationReferences = this.authority.readMemoryV31VaultReferences(workspaceId);
    const vaultReferences = new Set([...claimReferences.vaultRefSha256, ...observationReferences.vaultRefSha256]);
    const keyReferences = new Set([...claimReferences.keyRefSha256, ...observationReferences.keyRefSha256]);
    const orphan = this.vault.reconcileOrphans(vaultReferences, keyReferences, this.now());
    const integrity = new Set<string>();
    for (const head of this.authority.readMemoryV3WorkspaceHeads(workspaceId, null, 1_000)) {
      if (head.purgeState !== "PRESENT") continue;
      const versions = this.authority.readMemoryV3ClaimVersions(head.claimId);
      if (versions.some((version) => {
        const state = this.vault.inspect(version);
        return state.body !== "PRESENT" || state.key !== "PRESENT";
      })) integrity.add(head.claimId);
    }
    return { completedPurgeIntentIds: completed, completedCaptureIntentIds: completedCapture,
      abortedCaptureIntentIds: abortedCapture, retiredObservationIds: retired.map((entry) => entry.observationId),
      expiredProposalIds, integrityFailureClaimIds: [...integrity].sort(),
      quarantinedOrphanCount: orphan.quarantinedRefSha256.length, removedOrphanCount: orphan.removedQuarantineCount };
  }

  private captureReceiptResult(
    receipt: MemoryCaptureV31ReceiptRecord,
    captureAuthorityResult: MemoryCaptureCommandResult,
  ): MemoryV3WriteResult {
    const record = receipt.claimId ? this.authority.readMemoryV3Claim(receipt.claimId) : null;
    return {
      accepted: receipt.result !== "ABORTED" || receipt.reasonCode === "CONCEPT_PREVIOUSLY_REJECTED",
      reason: receipt.reasonCode, record,
      authorityResult: null, workspaceAuthorityResult: null, additionalModelRequests: 0, captureAuthorityResult,
    };
  }

  private prepareObservation(decision: MemoryCaptureDecision, intentId: string): MemoryVaultPrepared {
    if (!decision.normalizedText || !decision.conceptSha256) throw new TypeError("Memory v3.1 observation lacks semantic identity");
    const observationId = idFromSha256("MOBS", sha256Hex(intentId));
    const authorityMetadata = canonical({
      domain: "PCH-MEMORY-V3.1-OBSERVATION-METADATA", intentId,
      candidateSha256: decision.candidateSha256, conceptSha256: decision.conceptSha256,
    });
    const body = canonical({
      schema_version: 1, record_type: "MEMORY_V31_OBSERVATION", intent_id: intentId,
      normalized_text: decision.normalizedText, policy: decision.policy,
    });
    return this.vault.prepare({ workspaceId: decision.workspaceId, claimId: observationId,
      version: 1, authorityMetadata, body });
  }

  private observationVaultRecord(observation: MemoryObservationV31Record): MemoryVaultRecord {
    return {
      workspaceId: observation.workspaceId, claimId: observation.observationId, version: 1, formatVersion: 1,
      authorityMetadataSha256: observation.authorityMetadataSha256, bodySha256: observation.bodySha256,
      vaultRefSha256: observation.vaultRefSha256, keyRefSha256: observation.keyRefSha256,
      ciphertextSha256: observation.ciphertextSha256, wrappedKeySha256: observation.wrappedKeySha256, reused: false,
    };
  }

  private materializeEligibleProposals(workspaceId: string): MemoryV3ClaimRecord | null {
    let last: MemoryV3ClaimRecord | null = null;
    if (this.authority.readMemoryV31ActiveProposals(
      workspaceId, defaultMemoryCaptureV31Limits.maxActiveProposals,
    ).length >= defaultMemoryCaptureV31Limits.maxActiveProposals) return null;
    for (const cluster of this.authority.readMemoryV31EligibleClusters(workspaceId, defaultMemoryCaptureV31Limits)) {
      const evidence = this.qualifiedCaptureEvidence(workspaceId, cluster.conceptSha256);
      const latest = evidence.observations.at(-1) ?? null;
      const intent = evidence.latestIntent;
      if (!evidence.eligible || !latest || !intent) continue;
      const body = observationBodyValue(this.vault.open(this.observationVaultRecord(latest)), latest.intentId);
      if (classifyMemorySecurityRisk(body.normalized_text)) continue;
      const payload: MemoryClaimPayload = cluster.channel === "EXPERIENCE"
        ? { type: "EXPERIENCE_RECORD", lesson: body.normalized_text, outcome: "FAILED",
          receiptId: `observation:${latest.observationId}`, failureSignatureSha256: cluster.conceptSha256 }
        : body.policy ?? memoryPolicySemantics(body.normalized_text);
      const baseClaimId = this.claimId(workspaceId, cluster.scope, cluster.channel, cluster.conceptSha256);
      let claimId = baseClaimId;
      let current = this.authority.readMemoryV3ClaimHead(baseClaimId);
      if (current?.proposalState === "ACTIVE") {
        const active = this.open(baseClaimId, workspaceId, cluster.goalId);
        if (active && canonicalJsonSha256(active.body.payload) === canonicalJsonSha256(payload)) {
          this.authority.linkMemoryV31ActiveClaim(workspaceId, cluster.conceptSha256, baseClaimId);
          last = active.record;
          continue;
        }
        claimId = this.claimId(workspaceId, cluster.scope, cluster.channel, canonicalJsonSha256({
          conceptSha256: cluster.conceptSha256, proposedPayloadSha256: canonicalJsonSha256(payload),
        }));
        current = this.authority.readMemoryV3ClaimHead(claimId);
      }
      const evidenceManifestSha256 = evidence.evidenceManifestSha256;
      if (current) {
        if (current.proposalState === "PROPOSED") {
          this.authority.registerMemoryV31Proposal(workspaceId, cluster.conceptSha256, claimId, latest.intentId,
            evidenceManifestSha256, defaultMemoryCaptureV31Limits);
          last = this.authority.readMemoryV3Claim(claimId);
        }
        continue;
      }
      const source = sourceValue(attestUserInput(
        body.normalized_text, `pch-observation://${latest.observationId}`, this.now(),
      ));
      const write = this.persist({
        claimId, version: 1, workspaceId, sourceGoalId: cluster.goalId,
        scope: cluster.scope, scopeGoalId: cluster.scope === "GOAL" ? cluster.goalId : null,
        status: "PROPOSED", classification: intent.classification, payload, source,
        sourceLocatorSha256: sha256Hex(`pch-observation://${latest.observationId}`),
        sourceContentSha256: intent.sourceContentSha256, tags: [], pathKey: null, dependencyKeys: [],
        validFromMs: this.now(), expiresAtMs: this.now() + defaultMemoryCaptureV31Limits.proposalTtlMs,
        supersedesVersion: null, sourceKind: intent.sourceKind, sourceActor: intent.sourceActor,
        decisionActor: "RUNTIME", route: "PROPOSE_ONLY", disposition: "UNCERTAIN_PROPOSE",
        reasonCodes: ["INDEPENDENT_EVIDENCE_THRESHOLD_MET"], candidateSha256: intent.candidateSha256,
        idempotencyKey: `memory-v31:proposal:${workspaceId}:${cluster.conceptSha256}`,
      });
      if (!write.accepted || !write.record) continue;
      const proposal = this.authority.registerMemoryV31Proposal(workspaceId, cluster.conceptSha256,
        write.record.claimId, latest.intentId, evidenceManifestSha256, defaultMemoryCaptureV31Limits);
      if (proposal) last = write.record;
    }
    return last;
  }

  private qualifiedCaptureEvidence(workspaceId: string, conceptSha256: string): QualifiedCaptureEvidence {
    const candidates = this.authority.readActiveMemoryV31Observations(
      workspaceId, conceptSha256, defaultMemoryCaptureV31Limits.maxActiveObservations,
    ).map((observation) => ({
      observation,
      intent: this.authority.readMemoryV31CaptureIntent(observation.intentId),
    })).filter((entry): entry is { observation: MemoryObservationV31Record; intent: MemoryCaptureV31IntentRecord } =>
      entry.intent !== null
      && entry.intent.workspaceId === workspaceId
      && entry.intent.conceptSha256 === conceptSha256
      && entry.intent.route === "PROPOSE_ONLY"
      && ((entry.intent.sourceKind === "USER_INPUT" && entry.intent.sourceActor === "USER")
        || (entry.intent.sourceKind === "ROUTE_FAILURE" && entry.intent.sourceActor === "RUNTIME")));
    const sourceKind = candidates[0]?.intent.sourceKind ?? null;
    const sameSource = candidates.filter((entry) => entry.intent.sourceKind === sourceKind);
    sameSource.sort((left, right) => left.observation.observedAtMs - right.observation.observedAtMs
      || left.observation.observationId.localeCompare(right.observation.observationId));
    const observations = sameSource.map((entry) => entry.observation);
    const sessions = new Set(sameSource.map((entry) => entry.intent.sourceSessionHmac).filter((value): value is string => value !== null));
    const days = new Set(sameSource.map((entry) => entry.intent.sourceDayBucket));
    const captureEvents = new Set(sameSource.map((entry) => entry.intent.captureEventId));
    const enough = observations.length >= defaultMemoryCaptureV31Limits.minimumIndependentObservations;
    const eligible = sourceKind === "USER_INPUT"
      ? enough && Math.max(sessions.size, days.size) >= defaultMemoryCaptureV31Limits.minimumIndependentWindows
      : sourceKind === "ROUTE_FAILURE"
        && observations.length >= minimumVerifiedRouteFailureObservations
        && captureEvents.size >= minimumVerifiedRouteFailureObservations;
    const evidenceManifestSha256 = canonicalJsonSha256({
      domain: "PCH-MEMORY-V3.1-QUALIFIED-EVIDENCE-MANIFEST-V2",
      workspaceId,
      conceptSha256,
      sourceKind,
      evidence: sameSource.map(({ observation, intent }) => ({
        observationId: observation.observationId,
        observationSha256: observation.observationSha256,
        intentId: intent.intentId,
        intentSha256: intent.intentSha256,
      })),
    });
    return {
      eligible,
      observations,
      latestIntent: sameSource.at(-1)?.intent ?? null,
      evidenceManifestSha256,
    };
  }

  private retireCaptureEvidence(
    workspaceId: string,
    conceptSha256: string,
    reason: "USER_REJECTED" | "PURGED",
  ): void {
    const retired = this.authority.retireMemoryV31ConceptObservations(
      workspaceId, conceptSha256, reason, defaultMemoryCaptureV31Limits.maxActiveObservations,
    );
    for (const observation of retired) this.vault.destroyKey(this.observationVaultRecord(observation));
  }

  private purgeClaimKeys(
    workspaceId: string,
    claimId: string,
    sourceActor: "USER" | "RUNTIME",
    reasonCode: string,
  ): MemoryV3ActionCommandResult | null {
    const head = this.authority.readMemoryV3ClaimHead(claimId);
    if (!head || head.workspaceId !== workspaceId || head.purgeState !== "PRESENT") return null;
    const intent = this.authority.prepareMemoryV3PurgeIntent({
      workspaceId, claimId, targetVersion: head.version, requestedBy: sourceActor,
    }, `memory-v3:purge-intent:${claimId}:${head.version}:${reasonCode}`);
    for (const version of intent.versions) this.vault.destroyKey(version);
    return this.authority.recordMemoryV3Action({
      workspaceId, claimId, targetVersion: head.version, actionType: "PURGE_LOCAL_KEY",
      sourceActor, reasonCode, purgeIntentId: intent.intent.intentId,
    }, `memory-v3:purge-commit:${intent.intent.intentId}`);
  }

  private addAttested(
    input: {
      readonly payload: MemoryClaimPayload; readonly channel: "EVIDENCE" | "EXPERIENCE";
      readonly scope: MemoryScope; readonly attestation: SourceAttestation; readonly tags: readonly string[];
      readonly pathKey: string | null; readonly dependencyKeys: readonly string[];
      readonly classification: MemoryClassification;
    },
    context: MemoryV3MutationContext,
  ): MemoryV3WriteResult {
    const claimId = this.claimId(context.workspaceId, input.scope, input.channel, canonicalJsonSha256(input.payload));
    if (this.authority.readMemoryV3Claim(claimId)) return failedWrite("CLAIM_EXISTS_USE_EDIT");
    const admitted = prepareMemoryClaim({
      claimId, version: 1, workspaceId: context.workspaceId, actorGoalId: context.goalId ?? "GOAL-NONE",
      scope: input.scope, channel: input.channel, payload: input.payload, sourceAttestation: input.attestation,
      tags: input.tags, pathKey: input.pathKey, dependencyKeys: input.dependencyKeys,
      classification: input.classification, validFromMs: this.now(), supersedesVersion: null,
      maxPayloadBytes: this.maximumPayloadBytes,
    });
    if (!admitted.accepted) return failedWrite(admitted.reason);
    return this.persist({
      claimId, version: 1, workspaceId: context.workspaceId, sourceGoalId: context.goalId,
      scope: admitted.record.scope, scopeGoalId: admitted.record.scopeGoalId, status: "ACTIVE",
      classification: admitted.record.classification, payload: admitted.record.payload,
      source: sourceValue(admitted.record.sourceAttestation), sourceLocatorSha256: sha256Hex(admitted.record.sourceAttestation.locator),
      sourceContentSha256: admitted.record.sourceAttestation.sourceSha256, tags: admitted.record.tags,
      pathKey: admitted.record.pathKey, dependencyKeys: admitted.record.dependencyKeys,
      validFromMs: admitted.record.validFromMs, expiresAtMs: admitted.record.expiresAtMs,
      supersedesVersion: null, sourceKind: "MANUAL_COMMAND", sourceActor: "USER", decisionActor: "USER",
      route: "MANUAL", disposition: "NOT_APPLICABLE", reasonCodes: ["USER_EXPLICIT_MEMORY"],
      candidateSha256: canonicalJsonSha256({ claimId, payloadSha256: admitted.record.payloadSha256 }),
      idempotencyKey: `memory-v3:claim:${claimId}:1`,
    });
  }

  private persist(input: PersistInput): MemoryV3WriteResult {
    const risk = classifyMemorySecurityRisk(canonicalJson({ payload: input.payload, source: input.source,
      tags: input.tags, pathKey: input.pathKey, dependencyKeys: input.dependencyKeys }));
    if (risk) return failedWrite(risk);
    const contentText = memoryClaimContent(input.payload).normalize("NFC").trim();
    if (!contentText) return failedWrite("INVALID_OR_EMPTY_CONTENT");
    const body = canonical({
      schema_version: 1, record_type: "MEMORY_V3_BODY", claim_id: input.claimId, version: input.version,
      workspace_id: input.workspaceId, payload: input.payload, source: input.source,
      tags: normalizeMemoryTags(input.tags), path_key: normalizeMemoryPath(input.pathKey),
      dependency_keys: normalizeMemoryTags(input.dependencyKeys), content_text: contentText,
      content_token_estimate: tokenEstimate(contentText),
    });
    const bodySha256 = canonicalJsonSha256(body);
    const policy = input.payload.type === "TYPED_POLICY" ? input.payload : null;
    if (policy && (!policy.semanticKey || !policy.operator || !policy.value)) return failedWrite("POLICY_SEMANTICS_REQUIRED");
    const terms = this.terms(input, contentText, policy?.semanticKey ?? null);
    const draft = {
      claimId: input.claimId, version: input.version, workspaceId: input.workspaceId,
      sourceGoalId: input.sourceGoalId, scope: input.scope, scopeGoalId: input.scopeGoalId,
      channel: input.payload.type === "TYPED_POLICY" ? "POLICY" as const
        : input.payload.type === "EVIDENCE_LOCATOR" ? "EVIDENCE" as const : "EXPERIENCE" as const,
      status: input.status, classification: input.classification, payloadType: input.payload.type,
      policyOperator: policy?.operator ?? null, semanticKeySha256: policy?.semanticKey ? sha256Hex(policy.semanticKey) : null,
      valueSha256: policy?.value ? sha256Hex(policy.value) : null, bodySha256,
      sourceLocatorSha256: input.sourceLocatorSha256, sourceContentSha256: input.sourceContentSha256,
      validFromMs: input.validFromMs, expiresAtMs: input.expiresAtMs,
      supersedesVersion: input.supersedesVersion, terms,
    };
    const authorityMetadata = memoryV3AuthorityMetadata(draft);
    let prepared;
    try {
      prepared = this.vault.prepare({ workspaceId: input.workspaceId, claimId: input.claimId,
        version: input.version, authorityMetadata, body });
      const command: MemoryV3StoreClaimInput = {
        ...draft, authorityMetadataSha256: prepared.authorityMetadataSha256,
        vaultRefSha256: prepared.vaultRefSha256, keyRefSha256: prepared.keyRefSha256,
        ciphertextSha256: prepared.ciphertextSha256, wrappedKeySha256: prepared.wrappedKeySha256,
        sourceKind: input.sourceKind, sourceActor: input.sourceActor, decisionActor: input.decisionActor,
        route: input.route, disposition: input.disposition, reasonCodes: input.reasonCodes,
        candidateSha256: input.candidateSha256,
      };
      const result = this.authority.recordMemoryV3Claim(command, input.idempotencyKey);
      return { accepted: true, reason: result.reused ? "REUSED_EXISTING_CLAIM" : "ADMITTED",
        record: result.claim, authorityResult: null, workspaceAuthorityResult: result, additionalModelRequests: 0 };
    } catch (error) {
      const existing = this.authority.readMemoryV3Claim(input.claimId, input.version);
      if (!existing && prepared) {
        try { this.vault.discardPrepared(prepared); } catch { /* Preserve the primary write failure. */ }
      }
      return failedWrite(error instanceof Error ? `V3_WRITE_FAILED:${error.message}` : "V3_WRITE_FAILED");
    }
  }

  private action(
    claimId: string,
    actionType: Exclude<MemoryV3ActionType, "PURGE_LOCAL_KEY">,
    reasonCode: string,
    context: MemoryV3MutationContext,
  ): MemoryV3ActionResult {
    const head = this.boundHead(claimId, context.workspaceId, context.goalId);
    if (!head) return failedAction("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    try {
      const result = this.authority.recordMemoryV3Action({
        workspaceId: context.workspaceId, claimId, targetVersion: head.version, actionType,
        sourceActor: "USER", reasonCode, purgeIntentId: null,
      }, `memory-v3:action:${claimId}:${head.version}:${actionType}`);
      return { accepted: true, reason: actionType, action: result.action, authorityResult: null,
        workspaceAuthorityResult: result, limitation: null, additionalModelRequests: 0 };
    } catch (error) {
      return failedAction(error instanceof Error ? `ACTION_REJECTED:${error.message}` : "ACTION_REJECTED");
    }
  }

  private boundHead(claimId: string, workspaceId: string, goalId: string | null): MemoryV3ClaimHeadRecord | null {
    const head = this.authority.readMemoryV3ClaimHead(claimId);
    if (!head || head.workspaceId !== workspaceId || (head.scope === "GOAL" && head.scopeGoalId !== goalId)) return null;
    return head;
  }

  private vaultRecord(record: MemoryV3ClaimRecord): MemoryVaultRecord {
    return { workspaceId: record.workspaceId, claimId: record.claimId, version: record.version,
      formatVersion: 1, authorityMetadataSha256: record.authorityMetadataSha256, bodySha256: record.bodySha256,
      vaultRefSha256: record.vaultRefSha256, keyRefSha256: record.keyRefSha256,
      ciphertextSha256: record.ciphertextSha256, wrappedKeySha256: record.wrappedKeySha256, reused: false };
  }

  private terms(input: PersistInput, contentText: string, semanticKey: string | null): MemoryV3StoreClaimInput["terms"] {
    const values: Array<{ kind: MemoryV3StoreClaimInput["terms"][number]["kind"]; value: string }> = [];
    for (const term of memorySearchTerms(contentText)) values.push({ kind: "CONTENT", value: term });
    for (const term of normalizeMemoryTags(input.tags)) values.push({ kind: "TAG", value: term });
    const path = normalizeMemoryPath(input.pathKey);
    if (path) values.push({ kind: "PATH", value: path });
    for (const term of normalizeMemoryTags(input.dependencyKeys)) values.push({ kind: "DEPENDENCY", value: term });
    if (semanticKey) values.push({ kind: "SEMANTIC_KEY", value: semanticKey.normalize("NFKC").toLowerCase() });
    return values.map((value) => ({
      kind: value.kind, hmac: hmacSha256Hex(this.workspaceSecret, `PCH-MEMORY-V3-TERM\0${value.kind}\0${value.value}`),
    })).sort((left, right) => left.kind.localeCompare(right.kind) || left.hmac.localeCompare(right.hmac));
  }

  private claimId(workspaceId: string, scope: MemoryScope, channel: string, payloadSha256: string): string {
    return idFromSha256("MEM3", sha256Hex(canonicalJson({ workspaceId, scope, channel, payloadSha256 })));
  }
}
