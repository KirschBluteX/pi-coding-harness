import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type {
  AppendMemoryActionCommand, AppendMemoryClaimCommand, AuthorityStore,
} from "../authority/transactions.js";
import { sha256Hex } from "../foundation/crypto.js";
import { createId, idFromSha256 } from "../foundation/ids.js";
import {
  computeMemoryActionSha256, prepareMemoryClaim,
} from "./admission.js";
import { retrieveMemory } from "./retrieval.js";
import { buildMemoryRecallObservation, MemoryTelemetryBuffer } from "./telemetry.js";
import {
  attestAuthorityReceipt, attestProjectFile, attestUserInput,
} from "./source-resolvers.js";
import type {
  AddProjectEvidenceIntent, AddReceiptEvidenceIntent, AddReceiptExperienceIntent, AddUserPolicyIntent,
  MemoryActionResult, MemoryActionType, MemoryClaimPayload, MemoryClaimVersionInput, MemoryClaimVersionRecord,
  MemoryEngineConfig, MemoryExplanation, MemoryIndexDrainResult, MemoryMutationContext, MemoryQuery,
  MemoryRetrievalResult, MemoryWriteResult,
} from "./types.js";

function writeResult(reason: string, record: MemoryClaimVersionInput | null = null): MemoryWriteResult {
  return { accepted: false, reason, record, authorityResult: null, additionalModelRequests: 0 };
}

function reusedWrite(record: MemoryClaimVersionRecord): MemoryWriteResult {
  return { accepted: true, reason: "REUSED_EXISTING_CLAIM", record, authorityResult: null, additionalModelRequests: 0 };
}

function actionResult(reason: string): MemoryActionResult {
  return { accepted: false, reason, action: null, authorityResult: null, additionalModelRequests: 0 };
}

export class MemoryEngine {
  private readonly telemetry = new MemoryTelemetryBuffer();

  constructor(
    private readonly authority: AuthorityStore,
    private readonly config: MemoryEngineConfig,
    private readonly now: () => number = Date.now,
  ) {
    if (config.softProjectionTokens > config.hardProjectionTokens) {
      throw new RangeError("Memory soft projection budget exceeds hard budget");
    }
    if ((!config.enabled && config.mode !== "OFF") || (config.enabled && config.mode === "OFF")) {
      throw new RangeError("Memory enabled and mode configuration are inconsistent");
    }
  }

  addUserPolicy(intent: AddUserPolicyIntent, context: MemoryMutationContext): MemoryWriteResult {
    if (!this.available()) return writeResult("MEMORY_OFF");
    const normalized = intent.statement.normalize("NFC").trim();
    const claimId = idFromSha256("MEM", sha256Hex(canonicalJsonSha256({
      workspaceId: context.workspaceId,
      scope: intent.scope,
      scopeGoalId: intent.scope === "GOAL" ? context.goalId : null,
      channel: "POLICY",
      statementSha256: sha256Hex(normalized),
    })));
    const existing = this.authority.readMemoryClaim(claimId);
    if (existing) return existing.contentText === normalized ? reusedWrite(existing) : writeResult("CLAIM_ID_COLLISION");
    const attestation = attestUserInput(normalized, `pch-user://memory/${claimId}/v1`, this.now());
    return this.prepareAndPersist({
      claimId,
      payload: {
        type: "TYPED_POLICY",
        policyKind: intent.policyKind ?? "PREFERENCE",
        statement: normalized,
        appliesTo: intent.tags ?? [],
      },
      channel: "POLICY",
      scope: intent.scope,
      sourceAttestation: attestation,
      tags: intent.tags ?? [],
      pathKey: intent.pathKey ?? null,
      dependencyKeys: intent.dependencyKeys ?? [],
      classification: intent.classification ?? "INTERNAL",
      expiresAtMs: intent.expiresAtMs ?? null,
    }, context);
  }

  addProjectEvidence(intent: AddProjectEvidenceIntent, context: MemoryMutationContext): MemoryWriteResult {
    if (!this.available() || this.config.mode === "EXPLICIT_ONLY") return writeResult("MEMORY_MODE_NOT_ELIGIBLE_FOR_EVIDENCE");
    let attestation;
    try {
      attestation = attestProjectFile(context.workspaceRoot, intent.path, this.config.maxPayloadBytes, this.now());
    } catch (error) {
      return writeResult(error instanceof Error ? `PROJECT_SOURCE_REJECTED:${error.message}` : "PROJECT_SOURCE_REJECTED");
    }
    const claimId = idFromSha256("MEM", sha256Hex(canonicalJsonSha256({
      workspaceId: context.workspaceId,
      scope: intent.scope,
      scopeGoalId: intent.scope === "GOAL" ? context.goalId : null,
      channel: "EVIDENCE",
      locator: attestation.locator,
    })));
    const existing = this.authority.readMemoryClaim(claimId);
    if (existing) return existing.sourceAttestation.sourceSha256 === attestation.sourceSha256
      ? reusedWrite(existing) : writeResult("SOURCE_CHANGED_REQUIRES_CORRECTION");
    return this.prepareAndPersist({
      claimId,
      payload: {
        type: "EVIDENCE_LOCATOR",
        evidenceKind: "PROJECT_FILE",
        locator: attestation.locator,
        description: intent.description ?? "",
        lineStart: intent.lineStart ?? null,
        lineEnd: intent.lineEnd ?? null,
      },
      channel: "EVIDENCE",
      scope: intent.scope,
      sourceAttestation: attestation,
      tags: intent.tags ?? [],
      pathKey: intent.path,
      dependencyKeys: intent.dependencyKeys ?? [],
    }, context);
  }

  addReceiptEvidence(intent: AddReceiptEvidenceIntent, context: MemoryMutationContext): MemoryWriteResult {
    if (!this.available() || this.config.mode === "EXPLICIT_ONLY") return writeResult("MEMORY_MODE_NOT_ELIGIBLE_FOR_EVIDENCE");
    const attestation = attestAuthorityReceipt(this.authority, intent.receiptId, context.workspaceId, this.now());
    if (!attestation) return writeResult("RECEIPT_NOT_FOUND_OR_OUT_OF_SCOPE");
    const claimId = idFromSha256("MEM", sha256Hex(canonicalJsonSha256({
      workspaceId: context.workspaceId,
      scope: intent.scope,
      scopeGoalId: intent.scope === "GOAL" ? context.goalId : null,
      channel: "EVIDENCE",
      locator: attestation.locator,
    })));
    const existing = this.authority.readMemoryClaim(claimId);
    if (existing) return existing.sourceAttestation.sourceSha256 === attestation.sourceSha256
      ? reusedWrite(existing) : writeResult("SOURCE_CHANGED_REQUIRES_CORRECTION");
    return this.prepareAndPersist({
      claimId,
      payload: {
        type: "EVIDENCE_LOCATOR",
        evidenceKind: "AUTHORITY_RECEIPT",
        locator: attestation.locator,
        description: intent.description ?? "",
        lineStart: null,
        lineEnd: null,
      },
      channel: "EVIDENCE",
      scope: intent.scope,
      sourceAttestation: attestation,
      tags: intent.tags ?? [],
      dependencyKeys: intent.dependencyKeys ?? [],
    }, context);
  }

  addReceiptExperience(intent: AddReceiptExperienceIntent, context: MemoryMutationContext): MemoryWriteResult {
    if (!this.available() || this.config.mode !== "EXPERIMENTAL") return writeResult("MEMORY_MODE_NOT_ELIGIBLE_FOR_EXPERIENCE");
    const source = this.authority.readMemoryReceiptAttestation(intent.receiptId, context.workspaceId);
    const attestation = attestAuthorityReceipt(this.authority, intent.receiptId, context.workspaceId, this.now());
    if (!source || !attestation) return writeResult("RECEIPT_NOT_FOUND_OR_OUT_OF_SCOPE");
    const claimId = idFromSha256("MEM", sha256Hex(canonicalJsonSha256({
      workspaceId: context.workspaceId,
      scope: intent.scope,
      scopeGoalId: intent.scope === "GOAL" ? context.goalId : null,
      channel: "EXPERIENCE",
      receiptId: intent.receiptId,
      lessonSha256: sha256Hex(intent.lesson.normalize("NFC").trim()),
    })));
    const existing = this.authority.readMemoryClaim(claimId);
    if (existing) return existing.sourceAttestation.sourceSha256 === attestation.sourceSha256
      ? reusedWrite(existing) : writeResult("SOURCE_CHANGED_REQUIRES_CORRECTION");
    return this.prepareAndPersist({
      claimId,
      payload: {
        type: "EXPERIENCE_RECORD",
        lesson: intent.lesson,
        outcome: source.result,
        receiptId: source.receiptId,
        failureSignatureSha256: source.failureSignatureSha256,
      },
      channel: "EXPERIENCE",
      scope: intent.scope,
      sourceAttestation: attestation,
      tags: intent.tags ?? [],
      dependencyKeys: intent.dependencyKeys ?? [],
    }, context);
  }

  correct(claimId: string, replacement: string, context: MemoryMutationContext): MemoryWriteResult {
    if (!this.available()) return writeResult("MEMORY_OFF");
    const current = this.boundCurrent(claimId, context);
    if (!current) return writeResult("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    let payload: MemoryClaimPayload;
    let attestation = current.sourceAttestation;
    if (current.payload.type === "TYPED_POLICY") {
      payload = { ...current.payload, statement: replacement };
      attestation = attestUserInput(replacement, `pch-user://memory/${claimId}/v${current.version + 1}`, this.now());
    } else if (current.payload.type === "EVIDENCE_LOCATOR") {
      payload = { ...current.payload, description: replacement };
    } else {
      payload = { ...current.payload, lesson: replacement };
    }
    return this.prepareAndPersist({
      claimId,
      version: current.version + 1,
      supersedesVersion: current.version,
      payload,
      channel: current.channel,
      scope: current.scope,
      sourceAttestation: attestation,
      tags: current.tags,
      pathKey: current.pathKey,
      dependencyKeys: current.dependencyKeys,
      classification: current.classification,
      expiresAtMs: current.expiresAtMs,
    }, context);
  }

  endorse(claimId: string, context: MemoryMutationContext): MemoryActionResult {
    return this.applyAction(claimId, "ENDORSE", "User endorsed Memory claim", context);
  }

  unendorse(claimId: string, context: MemoryMutationContext): MemoryActionResult {
    return this.applyAction(claimId, "REVOKE_ENDORSEMENT", "User revoked Memory endorsement", context);
  }

  forget(claimId: string, context: MemoryMutationContext): MemoryActionResult {
    return this.applyAction(claimId, "FORGET", "User hid Memory claim from recall", context);
  }

  restore(claimId: string, context: MemoryMutationContext): MemoryActionResult {
    return this.applyAction(claimId, "RESTORE", "User restored Memory claim visibility", context);
  }

  purge(claimId: string, context: MemoryMutationContext): MemoryActionResult {
    void claimId;
    void context;
    return actionResult("PURGE_UNAVAILABLE_REQUIRES_STORE_KEY_ROTATION_WAL_FTS_AND_BACKUP_POLICY");
  }

  retrieve(query: MemoryQuery, observe = true): MemoryRetrievalResult {
    const started = performance.now();
    const result = retrieveMemory(this.authority, this.config, query);
    if (observe && this.available()) {
      this.telemetry.enqueue(buildMemoryRecallObservation(result, query, (performance.now() - started) * 1000));
    }
    return result;
  }

  observeRecall(result: MemoryRetrievalResult, query: MemoryQuery, latencyMicros: number): void {
    if (this.available()) this.telemetry.enqueue(buildMemoryRecallObservation(result, query, latencyMicros));
  }

  explain(claimId: string, workspaceId: string, goalId: string | null): MemoryExplanation | null {
    if (!this.available()) return null;
    const claim = this.authority.readMemoryClaim(claimId);
    if (!claim || claim.workspaceId !== workspaceId || (claim.scope === "GOAL" && claim.scopeGoalId !== goalId)) return null;
    const endorsement = this.authority.readMemoryActionHead(claimId, "ENDORSEMENT");
    const visibility = this.authority.readMemoryActionHead(claimId, "VISIBILITY");
    return {
      claimId: claim.claimId,
      version: claim.version,
      status: claim.status,
      channel: claim.channel,
      sourceAttestation: claim.sourceAttestation,
      claimSha256: claim.claimSha256,
      scope: claim.scope,
      classification: claim.classification,
      endorsed: endorsement?.actionType === "ENDORSE",
      forgotten: visibility?.actionType === "FORGET",
      reason: `${claim.channel}+${claim.scope}+${claim.sourceAttestation.resolver}`,
      additionalModelRequests: 0,
    };
  }

  drainIndex(limit = this.config.indexDrainBatch, nowMs = this.now()): MemoryIndexDrainResult {
    if (!this.available()) return { processed: 0, remaining: 0, workspaceWatermarks: {} };
    return this.authority.flushMemoryIndex(limit, nowMs);
  }

  flushTelemetry(limit = this.config.indexDrainBatch): number {
    if (!this.available()) return 0;
    const batch = this.telemetry.peek(limit);
    if (batch.length === 0) return 0;
    const written = this.authority.recordMemoryRecallObservations(batch);
    this.telemetry.acknowledge(written);
    return written;
  }

  pendingTelemetryCount(): number {
    return this.telemetry.size();
  }

  private available(): boolean {
    return this.config.enabled && this.config.mode !== "OFF";
  }

  private boundCurrent(claimId: string, context: MemoryMutationContext): MemoryClaimVersionRecord | null {
    const current = this.authority.readMemoryClaim(claimId);
    if (!current || current.workspaceId !== context.workspaceId) return null;
    if (current.scope === "GOAL" && current.scopeGoalId !== context.goalId) return null;
    return current;
  }

  private prepareAndPersist(
    input: {
      readonly claimId: string;
      readonly version?: number;
      readonly supersedesVersion?: number | null;
      readonly payload: MemoryClaimPayload;
      readonly channel: MemoryClaimVersionInput["channel"];
      readonly scope: MemoryClaimVersionInput["scope"];
      readonly sourceAttestation: MemoryClaimVersionInput["sourceAttestation"];
      readonly tags?: readonly string[];
      readonly pathKey?: string | null;
      readonly dependencyKeys?: readonly string[];
      readonly classification?: MemoryClaimVersionInput["classification"];
      readonly expiresAtMs?: number | null;
    },
    context: MemoryMutationContext,
  ): MemoryWriteResult {
    const decision = prepareMemoryClaim({
      claimId: input.claimId,
      version: input.version ?? 1,
      workspaceId: context.workspaceId,
      actorGoalId: context.goalId,
      scope: input.scope,
      channel: input.channel,
      payload: input.payload,
      sourceAttestation: input.sourceAttestation,
      tags: input.tags ?? [],
      pathKey: input.pathKey ?? null,
      dependencyKeys: input.dependencyKeys ?? [],
      classification: input.classification ?? "INTERNAL",
      validFromMs: this.now(),
      expiresAtMs: input.expiresAtMs ?? null,
      supersedesVersion: input.supersedesVersion ?? null,
      maxPayloadBytes: this.config.maxPayloadBytes,
    });
    if (!decision.accepted) return writeResult(decision.reason);
    const command: AppendMemoryClaimCommand = { type: "APPEND_MEMORY_CLAIM", goalId: context.goalId, record: decision.record };
    const authorityResult = this.authority.transact(command, {
      ...context.mutation,
      idempotencyKey: `memory:claim:${decision.record.claimId}:${decision.record.version}:${decision.record.claimSha256}`,
    });
    return { accepted: true, reason: "ADMITTED", record: decision.record, authorityResult, additionalModelRequests: 0 };
  }

  private applyAction(
    claimId: string,
    actionType: MemoryActionType,
    reason: string,
    context: MemoryMutationContext,
  ): MemoryActionResult {
    if (!this.available()) return actionResult("MEMORY_OFF");
    const claim = this.boundCurrent(claimId, context);
    if (!claim) return actionResult("CLAIM_NOT_FOUND_OR_OUT_OF_SCOPE");
    const actionFamily = actionType === "ENDORSE" || actionType === "REVOKE_ENDORSEMENT" ? "ENDORSEMENT" : "VISIBILITY";
    const prior = this.authority.readMemoryActionHead(claimId, actionFamily);
    if ((actionType === "ENDORSE" && prior?.actionType === "ENDORSE")
      || (actionType === "REVOKE_ENDORSEMENT" && (!prior || prior.actionType === "REVOKE_ENDORSEMENT"))
      || (actionType === "FORGET" && prior?.actionType === "FORGET")
      || (actionType === "RESTORE" && (!prior || prior.actionType === "RESTORE"))) {
      return actionResult(`ACTION_ALREADY_EFFECTIVE:${actionType}`);
    }
    const createdAtMs = this.now();
    const actionId = createId("MACT");
    const base = {
      actionId,
      claimId,
      targetVersion: claim.version,
      workspaceId: context.workspaceId,
      actorGoalId: context.goalId,
      actionType,
      actionFamily,
      reason,
      predecessorActionId: prior?.actionId ?? null,
      createdAtMs,
    } as const;
    const action = { ...base, actionSha256: computeMemoryActionSha256(base) };
    const command: AppendMemoryActionCommand = { type: "APPEND_MEMORY_ACTION", goalId: context.goalId, memoryAction: action };
    const authorityResult = this.authority.transact(command, {
      ...context.mutation,
      idempotencyKey: `memory:action:${claimId}:${actionType}:${action.actionSha256}`,
    });
    return { accepted: true, reason: actionType, action, authorityResult, additionalModelRequests: 0 };
  }
}
