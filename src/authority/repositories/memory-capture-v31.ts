import type { AuthorityConnection } from "../database.js";
import { canonicalJsonSha256 } from "../canonical-json.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { sha256Hex } from "../../foundation/crypto.js";
import type { MemoryCaptureDecision } from "../../memory/capture.js";
import type { MemoryCaptureCommandResult } from "./memory-v3.js";

const shaPattern = /^[a-f0-9]{64}$/u;

export interface MemoryCaptureV31Limits {
  readonly observationTtlMs: number;
  readonly proposalTtlMs: number;
  readonly maxActiveObservations: number;
  readonly maxActiveClusters: number;
  readonly maxActiveProposals: number;
  readonly minimumIndependentObservations: number;
  readonly minimumIndependentWindows: number;
}

export const defaultMemoryCaptureV31Limits: MemoryCaptureV31Limits = {
  observationTtlMs: 7 * 86_400_000,
  proposalTtlMs: 14 * 86_400_000,
  maxActiveObservations: 512,
  maxActiveClusters: 256,
  maxActiveProposals: 64,
  minimumIndependentObservations: 3,
  minimumIndependentWindows: 2,
};

export interface MemoryCaptureV31IntentRecord {
  readonly intentId: string;
  readonly workspaceId: string;
  readonly captureEventId: string;
  readonly idempotencyKeySha256: string;
  readonly candidateSha256: string;
  readonly conceptSha256: string | null;
  readonly route: Exclude<MemoryCaptureDecision["route"], "REJECT">;
  readonly sourceKind: MemoryCaptureDecision["sourceKind"];
  readonly sourceActor: MemoryCaptureDecision["sourceActor"];
  readonly goalId: string | null;
  readonly scope: MemoryCaptureDecision["scope"];
  readonly channel: MemoryCaptureDecision["channel"];
  readonly classification: MemoryCaptureDecision["classification"];
  readonly sourceSessionHmac: string | null;
  readonly sourceDayBucket: number;
  readonly sourceContentSha256: string;
  readonly authorityContextSha256: string | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly intentSha256: string;
}

export interface MemoryCaptureV31IntentResult {
  readonly reused: boolean;
  readonly intent: MemoryCaptureV31IntentRecord;
  readonly captureCommand: MemoryCaptureCommandResult;
}

export interface MemoryCaptureV31VaultInput {
  readonly observationId: string;
  readonly workspaceId: string;
  readonly authorityMetadataSha256: string;
  readonly bodySha256: string;
  readonly vaultRefSha256: string;
  readonly keyRefSha256: string;
  readonly ciphertextSha256: string;
  readonly wrappedKeySha256: string;
}

export interface MemoryCaptureV31PreparedRecord extends MemoryCaptureV31VaultInput {
  readonly intentId: string;
}

export interface MemoryObservationV31Record extends MemoryCaptureV31VaultInput {
  readonly intentId: string;
  readonly conceptSha256: string;
  readonly sourceSessionHmac: string | null;
  readonly sourceDayBucket: number;
  readonly sourceMessageSha256: string;
  readonly independenceKeySha256: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly observationSha256: string;
}

export type MemoryCaptureV31ReceiptResult = "ACTIVE" | "OBSERVED" | "PROPOSED" | "QUOTA_REJECTED" | "ABORTED";

export interface MemoryCaptureV31ReceiptRecord {
  readonly receiptId: string;
  readonly intentId: string;
  readonly result: MemoryCaptureV31ReceiptResult;
  readonly observationId: string | null;
  readonly claimId: string | null;
  readonly reasonCode: string;
  readonly receiptSha256: string;
  readonly createdAtMs: number;
}

export interface MemoryCandidateClusterV31Record {
  readonly workspaceId: string;
  readonly conceptSha256: string;
  readonly scope: MemoryCaptureDecision["scope"];
  readonly goalId: string | null;
  readonly channel: MemoryCaptureDecision["channel"];
  readonly state: "OPEN" | "PROPOSED" | "ACTIVE" | "REJECTED";
  readonly activeObservationCount: number;
  readonly independentSessionCount: number;
  readonly independentDayCount: number;
  readonly currentClaimId: string | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly clusterSha256: string;
}

export interface MemoryProposalV31Record {
  readonly proposalId: string;
  readonly workspaceId: string;
  readonly conceptSha256: string;
  readonly claimId: string;
  readonly sourceIntentId: string;
  readonly evidenceManifestSha256: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly proposalSha256: string;
}

export interface MemoryCaptureV31CommitResult {
  readonly reused: boolean;
  readonly receipt: MemoryCaptureV31ReceiptRecord;
  readonly observation: MemoryObservationV31Record | null;
  readonly cluster: MemoryCandidateClusterV31Record | null;
}

export type MemoryObservationV31RetirementReason = "EXPIRED" | "QUOTA" | "USER_REJECTED" | "PURGED";

function textValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new AuthorityIntegrityError(`Memory v3.1 ${key} is invalid`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Memory v3.1 ${key} is invalid`);
  return value;
}

function integerValue(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new AuthorityIntegrityError(`Memory v3.1 ${key} is invalid`);
  return value;
}

function intentHash(record: Omit<MemoryCaptureV31IntentRecord, "intentSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-CAPTURE-INTENT", ...record });
}

function observationHash(record: Omit<MemoryObservationV31Record, "observationSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-OBSERVATION", ...record });
}

function receiptHash(record: Omit<MemoryCaptureV31ReceiptRecord, "receiptSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-CAPTURE-RECEIPT", ...record });
}

function clusterHash(record: Omit<MemoryCandidateClusterV31Record, "clusterSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-CANDIDATE-CLUSTER", ...record });
}

function proposalHash(record: Omit<MemoryProposalV31Record, "proposalSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-PROPOSAL", ...record });
}

function vaultBinding(input: MemoryCaptureV31VaultInput): MemoryCaptureV31VaultInput {
  return {
    observationId: input.observationId, workspaceId: input.workspaceId,
    authorityMetadataSha256: input.authorityMetadataSha256, bodySha256: input.bodySha256,
    vaultRefSha256: input.vaultRefSha256, keyRefSha256: input.keyRefSha256,
    ciphertextSha256: input.ciphertextSha256, wrappedKeySha256: input.wrappedKeySha256,
  };
}

function decodeIntent(row: Record<string, unknown>): MemoryCaptureV31IntentRecord {
  const base: Omit<MemoryCaptureV31IntentRecord, "intentSha256"> = {
    intentId: textValue(row, "intent_id"), workspaceId: textValue(row, "workspace_id"),
    captureEventId: textValue(row, "capture_event_id"), idempotencyKeySha256: textValue(row, "idempotency_key_sha256"),
    candidateSha256: textValue(row, "candidate_sha256"), conceptSha256: nullableText(row, "concept_sha256"),
    route: textValue(row, "route") as MemoryCaptureV31IntentRecord["route"],
    sourceKind: textValue(row, "source_kind") as MemoryCaptureV31IntentRecord["sourceKind"],
    sourceActor: textValue(row, "source_actor") as MemoryCaptureV31IntentRecord["sourceActor"],
    goalId: nullableText(row, "goal_id"), scope: textValue(row, "scope") as MemoryCaptureV31IntentRecord["scope"],
    channel: textValue(row, "channel") as MemoryCaptureV31IntentRecord["channel"],
    classification: textValue(row, "classification") as MemoryCaptureV31IntentRecord["classification"],
    sourceSessionHmac: nullableText(row, "source_session_hmac"), sourceDayBucket: integerValue(row, "source_day_bucket"),
    sourceContentSha256: textValue(row, "source_content_sha256"), createdAtMs: integerValue(row, "created_at_ms"),
    authorityContextSha256: nullableText(row, "authority_context_sha256"),
    expiresAtMs: integerValue(row, "expires_at_ms"),
  };
  const intentSha256 = textValue(row, "intent_sha256");
  if (intentSha256 !== intentHash(base)) throw new AuthorityIntegrityError(`Memory v3.1 intent ${base.intentId} failed hash verification`);
  return { ...base, intentSha256 };
}

function decodeObservation(row: Record<string, unknown>): MemoryObservationV31Record {
  const base: Omit<MemoryObservationV31Record, "observationSha256"> = {
    observationId: textValue(row, "observation_id"), intentId: textValue(row, "intent_id"),
    workspaceId: textValue(row, "workspace_id"), conceptSha256: textValue(row, "concept_sha256"),
    sourceSessionHmac: nullableText(row, "source_session_hmac"), sourceDayBucket: integerValue(row, "source_day_bucket"),
    sourceMessageSha256: textValue(row, "source_message_sha256"), independenceKeySha256: textValue(row, "independence_key_sha256"),
    authorityMetadataSha256: textValue(row, "authority_metadata_sha256"), bodySha256: textValue(row, "body_sha256"),
    vaultRefSha256: textValue(row, "vault_ref_sha256"), keyRefSha256: textValue(row, "key_ref_sha256"),
    ciphertextSha256: textValue(row, "ciphertext_sha256"), wrappedKeySha256: textValue(row, "wrapped_key_sha256"),
    observedAtMs: integerValue(row, "observed_at_ms"), expiresAtMs: integerValue(row, "expires_at_ms"),
  };
  const observationSha256 = textValue(row, "observation_sha256");
  if (observationSha256 !== observationHash(base)) throw new AuthorityIntegrityError(`Memory v3.1 observation ${base.observationId} failed hash verification`);
  return { ...base, observationSha256 };
}

function decodeReceipt(row: Record<string, unknown>): MemoryCaptureV31ReceiptRecord {
  const base: Omit<MemoryCaptureV31ReceiptRecord, "receiptSha256"> = {
    receiptId: textValue(row, "receipt_id"), intentId: textValue(row, "intent_id"),
    result: textValue(row, "result") as MemoryCaptureV31ReceiptResult,
    observationId: nullableText(row, "observation_id"), claimId: nullableText(row, "claim_id"),
    reasonCode: textValue(row, "reason_code"), createdAtMs: integerValue(row, "created_at_ms"),
  };
  const receiptSha256 = textValue(row, "receipt_sha256");
  if (receiptSha256 !== receiptHash(base)) throw new AuthorityIntegrityError(`Memory v3.1 receipt ${base.receiptId} failed hash verification`);
  return { ...base, receiptSha256 };
}

function decodeCluster(row: Record<string, unknown>): MemoryCandidateClusterV31Record {
  const base: Omit<MemoryCandidateClusterV31Record, "clusterSha256"> = {
    workspaceId: textValue(row, "workspace_id"), conceptSha256: textValue(row, "concept_sha256"),
    scope: textValue(row, "scope") as MemoryCandidateClusterV31Record["scope"], goalId: nullableText(row, "goal_id"),
    channel: textValue(row, "channel") as MemoryCandidateClusterV31Record["channel"],
    state: textValue(row, "state") as MemoryCandidateClusterV31Record["state"],
    activeObservationCount: integerValue(row, "active_observation_count"),
    independentSessionCount: integerValue(row, "independent_session_count"),
    independentDayCount: integerValue(row, "independent_day_count"), currentClaimId: nullableText(row, "current_claim_id"),
    firstObservedAtMs: integerValue(row, "first_observed_at_ms"), lastObservedAtMs: integerValue(row, "last_observed_at_ms"),
  };
  const clusterSha256 = textValue(row, "cluster_sha256");
  if (clusterSha256 !== clusterHash(base)) throw new AuthorityIntegrityError(`Memory v3.1 cluster ${base.conceptSha256} failed hash verification`);
  return { ...base, clusterSha256 };
}

function decodeProposal(row: Record<string, unknown>): MemoryProposalV31Record {
  const base: Omit<MemoryProposalV31Record, "proposalSha256"> = {
    proposalId: textValue(row, "proposal_id"), workspaceId: textValue(row, "workspace_id"),
    conceptSha256: textValue(row, "concept_sha256"), claimId: textValue(row, "claim_id"),
    sourceIntentId: textValue(row, "source_intent_id"),
    evidenceManifestSha256: textValue(row, "evidence_manifest_sha256"),
    createdAtMs: integerValue(row, "created_at_ms"), expiresAtMs: integerValue(row, "expires_at_ms"),
  };
  const proposalSha256 = textValue(row, "proposal_sha256");
  if (proposalSha256 !== proposalHash(base)) throw new AuthorityIntegrityError(`Memory v3.1 proposal ${base.proposalId} failed hash verification`);
  return { ...base, proposalSha256 };
}

function requireLimits(limits: MemoryCaptureV31Limits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Memory v3.1 capture limits are invalid");
  }
}

export class MemoryCaptureV31Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  begin(
    decision: MemoryCaptureDecision,
    captureCommand: MemoryCaptureCommandResult,
    idempotencyKey: string,
    nowMs: number,
    limits: MemoryCaptureV31Limits = defaultMemoryCaptureV31Limits,
  ): MemoryCaptureV31IntentResult {
    requireLimits(limits);
    const event = captureCommand.event;
    if (decision.route === "REJECT" || event.candidateSha256 !== decision.candidateSha256
      || event.eventType !== "CAPTURE_ROUTED" || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Memory v3.1 capture intent input is invalid");
    }
    const idempotencyKeySha256 = sha256Hex(idempotencyKey);
    const existing = this.connection.prepare(`SELECT * FROM memory_v31_capture_intents
      WHERE workspace_id=? AND idempotency_key_sha256=?`).get(decision.workspaceId, idempotencyKeySha256) as Record<string, unknown> | undefined;
    if (existing) {
      const intent = decodeIntent(existing);
      if (intent.candidateSha256 !== decision.candidateSha256 || intent.captureEventId !== event.eventId) {
        throw new AuthorityIntegrityError("Memory v3.1 capture idempotency key was reused for different input");
      }
      return { reused: true, intent, captureCommand };
    }
    const intentId = idFromSha256("MINT", sha256Hex(`${decision.workspaceId}\0${idempotencyKeySha256}`));
    const base: Omit<MemoryCaptureV31IntentRecord, "intentSha256"> = {
      intentId, workspaceId: decision.workspaceId, captureEventId: event.eventId, idempotencyKeySha256,
      candidateSha256: decision.candidateSha256, conceptSha256: decision.conceptSha256, route: decision.route,
      sourceKind: decision.sourceKind, sourceActor: decision.sourceActor, goalId: decision.goalId,
      scope: decision.scope, channel: decision.channel, classification: decision.classification,
      sourceSessionHmac: decision.sourceSessionHmac, sourceDayBucket: decision.sourceDayBucket,
      sourceContentSha256: decision.sourceContentSha256, authorityContextSha256: decision.authorityContextSha256,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + limits.observationTtlMs,
    };
    const intent = { ...base, intentSha256: intentHash(base) };
    this.connection.prepare(`INSERT INTO memory_v31_capture_intents(
      intent_id,workspace_id,capture_event_id,idempotency_key_sha256,candidate_sha256,concept_sha256,
      route,source_kind,source_actor,goal_id,scope,channel,classification,source_session_hmac,
      source_day_bucket,source_content_sha256,authority_context_sha256,created_at_ms,expires_at_ms,intent_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      intent.intentId, intent.workspaceId, intent.captureEventId, intent.idempotencyKeySha256,
      intent.candidateSha256, intent.conceptSha256, intent.route, intent.sourceKind, intent.sourceActor,
      intent.goalId, intent.scope, intent.channel, intent.classification, intent.sourceSessionHmac,
      intent.sourceDayBucket, intent.sourceContentSha256, intent.authorityContextSha256,
      intent.createdAtMs, intent.expiresAtMs, intent.intentSha256,
    );
    this.connection.prepare(`INSERT INTO memory_v31_capture_outbox(intent_id,state,attempt_count,last_error_code,updated_at_ms)
      VALUES(?,'PREPARED',0,NULL,?)`).run(intent.intentId, nowMs);
    return { reused: false, intent, captureCommand };
  }

  markVaultPrepared(intentId: string, prepared: MemoryCaptureV31VaultInput, nowMs: number): void {
    if (!prepared.observationId || !prepared.workspaceId || Object.values({
      authorityMetadataSha256: prepared.authorityMetadataSha256, bodySha256: prepared.bodySha256,
      vaultRefSha256: prepared.vaultRefSha256, keyRefSha256: prepared.keyRefSha256,
      ciphertextSha256: prepared.ciphertextSha256, wrappedKeySha256: prepared.wrappedKeySha256,
    }).some((value) => !shaPattern.test(value))) throw new TypeError("Memory v3.1 prepared Vault record is invalid");
    const intent = this.intent(intentId);
    if (!intent || intent.workspaceId !== prepared.workspaceId) throw new TypeError("Memory v3.1 prepared Vault workspace is invalid");
    const existing = this.preparedVault(intentId);
    if (existing) {
      const { intentId: ignored, ...bound } = existing;
      void ignored;
      if (canonicalJsonSha256(bound) !== canonicalJsonSha256(vaultBinding(prepared))) {
        throw new AuthorityIntegrityError("Memory v3.1 prepared Vault binding changed");
      }
      return;
    }
    const result = this.connection.prepare(`UPDATE memory_v31_capture_outbox SET state='VAULT_PREPARED',
      attempt_count=attempt_count+1,observation_id=?,authority_metadata_sha256=?,body_sha256=?,vault_ref_sha256=?,
      key_ref_sha256=?,ciphertext_sha256=?,wrapped_key_sha256=?,last_error_code=NULL,updated_at_ms=?
      WHERE intent_id=? AND state IN ('PREPARED','VAULT_PREPARED')`).run(
      prepared.observationId, prepared.authorityMetadataSha256, prepared.bodySha256, prepared.vaultRefSha256,
      prepared.keyRefSha256, prepared.ciphertextSha256, prepared.wrappedKeySha256, nowMs, intentId,
    );
    if (Number(result.changes) !== 1) {
      const receipt = this.receipt(intentId);
      if (!receipt) throw new AuthorityIntegrityError("Memory v3.1 capture outbox cannot enter VAULT_PREPARED");
    }
  }

  commitObservation(
    intentId: string,
    prepared: MemoryCaptureV31VaultInput,
    nowMs: number,
    limits: MemoryCaptureV31Limits = defaultMemoryCaptureV31Limits,
  ): MemoryCaptureV31CommitResult {
    requireLimits(limits);
    const prior = this.receipt(intentId);
    if (prior) return { reused: true, receipt: prior, observation: prior.observationId ? this.observation(prior.observationId) : null,
      cluster: prior.observationId ? this.clusterForObservation(prior.observationId) : null };
    const intent = this.intent(intentId);
    if (!intent || intent.route !== "PROPOSE_ONLY" || !intent.conceptSha256 || prepared.workspaceId !== intent.workspaceId
      || !shaPattern.test(prepared.authorityMetadataSha256) || !shaPattern.test(prepared.bodySha256)
      || !shaPattern.test(prepared.vaultRefSha256) || !shaPattern.test(prepared.keyRefSha256)
      || !shaPattern.test(prepared.ciphertextSha256) || !shaPattern.test(prepared.wrappedKeySha256)) {
      throw new TypeError("Memory v3.1 observation commit input is invalid");
    }
    const bound = this.preparedVault(intentId);
    if (!bound) throw new AuthorityIntegrityError("Memory v3.1 observation has no prepared Vault binding");
    const { intentId: ignored, ...boundInput } = bound;
    void ignored;
    if (canonicalJsonSha256(boundInput) !== canonicalJsonSha256(vaultBinding(prepared))) {
      throw new AuthorityIntegrityError("Memory v3.1 observation does not match the prepared Vault binding");
    }
    const existingCluster = this.cluster(intent.workspaceId, intent.conceptSha256);
    if (existingCluster?.state === "PROPOSED" || existingCluster?.state === "ACTIVE") {
      if (!existingCluster.currentClaimId) throw new AuthorityIntegrityError("Memory v3.1 terminal cluster has no claim binding");
      const result = existingCluster.state === "ACTIVE" ? "ACTIVE" : "PROPOSED";
      const receipt = this.insertReceipt(
        intentId, result, null, existingCluster.currentClaimId,
        result === "ACTIVE" ? "EXISTING_ACTIVE_CONCEPT" : "EXISTING_PROPOSAL_CONCEPT", nowMs,
      );
      this.finishOutbox(intentId, "COMMITTED", null, nowMs);
      return { reused: false, receipt, observation: null, cluster: existingCluster };
    }
    if (existingCluster?.state === "REJECTED") {
      const receipt = this.insertReceipt(intentId, "ABORTED", null, null, "CONCEPT_PREVIOUSLY_REJECTED", nowMs);
      this.finishOutbox(intentId, "ABORTED", "CONCEPT_PREVIOUSLY_REJECTED", nowMs);
      return { reused: false, receipt, observation: null, cluster: existingCluster };
    }
    const activeClusters = Number((this.connection.prepare(`SELECT count(DISTINCT o.concept_sha256) AS count
      FROM memory_v31_observations o LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.expires_at_ms>? AND r.observation_id IS NULL`).get(intent.workspaceId, nowMs) as { count?: unknown }).count ?? 0);
    const clusterExists = this.connection.prepare(`SELECT 1 FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.concept_sha256=? AND o.expires_at_ms>? AND r.observation_id IS NULL LIMIT 1`)
      .get(intent.workspaceId, intent.conceptSha256, nowMs);
    const activeObservations = Number((this.connection.prepare(`SELECT count(*) AS count FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.expires_at_ms>? AND r.observation_id IS NULL`).get(intent.workspaceId, nowMs) as { count?: unknown }).count ?? 0);
    if (activeObservations >= limits.maxActiveObservations || (!clusterExists && activeClusters >= limits.maxActiveClusters)) {
      const receipt = this.insertReceipt(intentId, "QUOTA_REJECTED", null, null, "CAPTURE_QUOTA_REACHED", nowMs);
      this.finishOutbox(intentId, "COMMITTED", null, nowMs);
      return { reused: false, receipt, observation: null, cluster: null };
    }
    const sourceEvent = this.connection.prepare("SELECT source_locator_sha256 FROM memory_v3_events WHERE event_id=?")
      .get(intent.captureEventId) as Record<string, unknown> | undefined;
    if (!sourceEvent) throw new AuthorityIntegrityError("Memory v3.1 observation source event is missing");
    const independenceKeySha256 = canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-INDEPENDENT-OBSERVATION-V2",
      workspaceId: intent.workspaceId, conceptSha256: intent.conceptSha256,
      sourceKind: intent.sourceKind, sourceActor: intent.sourceActor,
      sourceSessionHmac: intent.sourceSessionHmac, sourceDayBucket: intent.sourceDayBucket,
      sourceContentSha256: intent.sourceContentSha256,
      nonUserSourceLocatorSha256: intent.sourceKind === "USER_INPUT" ? null : textValue(sourceEvent, "source_locator_sha256") });
    const duplicate = this.connection.prepare(`SELECT * FROM memory_v31_observations
      WHERE workspace_id=? AND independence_key_sha256=?`).get(intent.workspaceId, independenceKeySha256) as Record<string, unknown> | undefined;
    if (duplicate) {
      const observation = decodeObservation(duplicate);
      const receipt = this.insertReceipt(intentId, "OBSERVED", observation.observationId, null, "REPLAY_REUSED", nowMs);
      this.finishOutbox(intentId, "COMMITTED", null, nowMs);
      return { reused: false, receipt, observation, cluster: this.cluster(intent.workspaceId, intent.conceptSha256) };
    }
    const base: Omit<MemoryObservationV31Record, "observationSha256"> = {
      ...prepared, intentId, conceptSha256: intent.conceptSha256, sourceSessionHmac: intent.sourceSessionHmac,
      sourceDayBucket: intent.sourceDayBucket, sourceMessageSha256: intent.sourceContentSha256,
      independenceKeySha256, observedAtMs: nowMs, expiresAtMs: nowMs + limits.observationTtlMs,
    };
    const observation = { ...base, observationSha256: observationHash(base) };
    this.connection.prepare(`INSERT INTO memory_v31_observations(
      observation_id,intent_id,workspace_id,concept_sha256,source_session_hmac,source_day_bucket,
      source_message_sha256,independence_key_sha256,authority_metadata_sha256,body_sha256,
      vault_ref_sha256,key_ref_sha256,ciphertext_sha256,wrapped_key_sha256,observed_at_ms,expires_at_ms,observation_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      observation.observationId, observation.intentId, observation.workspaceId, observation.conceptSha256,
      observation.sourceSessionHmac, observation.sourceDayBucket, observation.sourceMessageSha256,
      observation.independenceKeySha256, observation.authorityMetadataSha256, observation.bodySha256,
      observation.vaultRefSha256, observation.keyRefSha256, observation.ciphertextSha256,
      observation.wrappedKeySha256, observation.observedAtMs, observation.expiresAtMs, observation.observationSha256,
    );
    const cluster = this.refreshCluster(intent, nowMs);
    const receipt = this.insertReceipt(intentId, "OBSERVED", observation.observationId, null, "OBSERVATION_RECORDED", nowMs);
    this.finishOutbox(intentId, "COMMITTED", null, nowMs);
    return { reused: false, receipt, observation, cluster };
  }

  commitClaim(intentId: string, claimId: string, result: "ACTIVE" | "PROPOSED", nowMs: number): MemoryCaptureV31CommitResult {
    const prior = this.receipt(intentId);
    if (prior) return { reused: true, receipt: prior, observation: null,
      cluster: this.intent(intentId)?.conceptSha256 ? this.cluster(this.intent(intentId)!.workspaceId, this.intent(intentId)!.conceptSha256!) : null };
    const intent = this.intent(intentId);
    if (!intent || !claimId) throw new TypeError("Memory v3.1 claim receipt input is invalid");
    const receipt = this.insertReceipt(intentId, result, null, claimId,
      result === "ACTIVE" ? "ACTIVE_CLAIM_COMMITTED" : "PROPOSAL_COMMITTED", nowMs);
    this.finishOutbox(intentId, "COMMITTED", null, nowMs);
    return { reused: false, receipt, observation: null,
      cluster: intent.conceptSha256 ? this.cluster(intent.workspaceId, intent.conceptSha256) : null };
  }

  abort(intentId: string, reasonCode: string, nowMs: number): MemoryCaptureV31ReceiptRecord {
    const prior = this.receipt(intentId);
    if (prior) return prior;
    if (!this.intent(intentId) || !/^[A-Z0-9_:-]{1,128}$/u.test(reasonCode)) throw new TypeError("Memory v3.1 abort input is invalid");
    const receipt = this.insertReceipt(intentId, "ABORTED", null, null, reasonCode, nowMs);
    this.finishOutbox(intentId, "ABORTED", reasonCode, nowMs);
    return receipt;
  }

  registerProposal(
    workspaceId: string,
    conceptSha256: string,
    claimId: string,
    sourceIntentId: string,
    evidenceManifestSha256: string,
    nowMs: number,
    limits: MemoryCaptureV31Limits = defaultMemoryCaptureV31Limits,
  ): MemoryProposalV31Record | null {
    requireLimits(limits);
    const existing = this.connection.prepare(`SELECT * FROM memory_v31_proposals WHERE workspace_id=? AND concept_sha256=?`)
      .get(workspaceId, conceptSha256) as Record<string, unknown> | undefined;
    if (existing) return decodeProposal(existing);
    const activeCount = Number((this.connection.prepare(`SELECT count(*) AS count FROM memory_v31_proposals p
      LEFT JOIN memory_v31_proposal_resolutions r ON r.proposal_id=p.proposal_id
      WHERE p.workspace_id=? AND p.expires_at_ms>? AND r.proposal_id IS NULL`).get(workspaceId, nowMs) as { count?: unknown }).count ?? 0);
    if (activeCount >= limits.maxActiveProposals) return null;
    const sourceIntent = this.intent(sourceIntentId);
    if (!sourceIntent || sourceIntent.workspaceId !== workspaceId || sourceIntent.conceptSha256 !== conceptSha256) {
      throw new TypeError("Memory v3.1 proposal source intent is invalid");
    }
    const proposalId = idFromSha256("MPRP", sha256Hex(`${workspaceId}\0${conceptSha256}`));
    const base: Omit<MemoryProposalV31Record, "proposalSha256"> = {
      proposalId, workspaceId, conceptSha256, claimId, sourceIntentId, evidenceManifestSha256,
      createdAtMs: nowMs, expiresAtMs: nowMs + limits.proposalTtlMs,
    };
    const proposal = { ...base, proposalSha256: proposalHash(base) };
    this.connection.prepare(`INSERT INTO memory_v31_proposals(proposal_id,workspace_id,concept_sha256,claim_id,source_intent_id,
      evidence_manifest_sha256,created_at_ms,expires_at_ms,proposal_sha256) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      proposal.proposalId, proposal.workspaceId, proposal.conceptSha256, proposal.claimId, proposal.sourceIntentId,
      proposal.evidenceManifestSha256, proposal.createdAtMs, proposal.expiresAtMs, proposal.proposalSha256,
    );
    this.setClusterState(workspaceId, conceptSha256, "PROPOSED", claimId);
    return proposal;
  }

  linkActiveClaim(workspaceId: string, conceptSha256: string, claimId: string): void {
    const head = this.connection.prepare(`SELECT proposal_state FROM memory_v3_claim_heads
      WHERE workspace_id=? AND claim_id=?`).get(workspaceId, claimId) as Record<string, unknown> | undefined;
    if (!head || textValue(head, "proposal_state") !== "ACTIVE") {
      throw new TypeError("Memory v3.1 cluster can link only an active claim");
    }
    this.setClusterState(workspaceId, conceptSha256, "ACTIVE", claimId);
  }

  resolveProposal(proposalId: string, result: "APPROVED" | "REJECTED" | "EXPIRED" | "PURGED", actionId: string | null, nowMs: number): void {
    const proposalRow = this.connection.prepare("SELECT * FROM memory_v31_proposals WHERE proposal_id=?").get(proposalId) as Record<string, unknown> | undefined;
    if (!proposalRow) throw new TypeError("Memory v3.1 proposal does not exist");
    const proposal = decodeProposal(proposalRow);
    const existing = this.connection.prepare("SELECT * FROM memory_v31_proposal_resolutions WHERE proposal_id=?").get(proposalId) as Record<string, unknown> | undefined;
    if (existing) {
      if (textValue(existing, "result") !== result) throw new AuthorityIntegrityError("Memory v3.1 proposal was resolved differently");
      return;
    }
    const resolutionId = idFromSha256("MRES", sha256Hex(`${proposalId}\0${result}`));
    const base = { resolutionId, proposalId, result, actionId, resolvedAtMs: nowMs };
    const resolutionSha256 = canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-PROPOSAL-RESOLUTION", ...base });
    this.connection.prepare(`INSERT INTO memory_v31_proposal_resolutions(resolution_id,proposal_id,result,action_id,
      resolved_at_ms,resolution_sha256) VALUES(?,?,?,?,?,?)`).run(resolutionId, proposalId, result, actionId, nowMs, resolutionSha256);
    this.setClusterState(
      proposal.workspaceId,
      proposal.conceptSha256,
      result === "APPROVED" ? "ACTIVE" : result === "EXPIRED" ? "OPEN" : "REJECTED",
      result === "EXPIRED" ? null : proposal.claimId,
    );
  }

  retireExpiredObservations(workspaceId: string, nowMs: number, limit = 128): MemoryObservationV31Record[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3.1 cleanup limit is invalid");
    const rows = this.connection.prepare(`SELECT o.* FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.expires_at_ms<=? AND r.observation_id IS NULL
      ORDER BY o.expires_at_ms,o.observation_id LIMIT ?`).all(workspaceId, nowMs, limit) as Record<string, unknown>[];
    const affected = new Set<string>();
    const observations = rows.map(decodeObservation);
    for (const observation of observations) {
      const retirementId = idFromSha256("MRET", sha256Hex(`${observation.observationId}\0EXPIRED`));
      const base = { retirementId, observationId: observation.observationId, reason: "EXPIRED", retiredAtMs: nowMs };
      const hash = canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-OBSERVATION-RETIREMENT", ...base });
      this.connection.prepare(`INSERT INTO memory_v31_observation_retirements(retirement_id,observation_id,reason,
        retired_at_ms,retirement_sha256) VALUES(?,?,?,?,?)`).run(retirementId, observation.observationId, "EXPIRED", nowMs, hash);
      affected.add(observation.conceptSha256);
    }
    for (const concept of affected) {
      const intentRow = this.connection.prepare(`SELECT i.* FROM memory_v31_capture_intents i
        JOIN memory_v31_observations o ON o.intent_id=i.intent_id WHERE o.workspace_id=? AND o.concept_sha256=?
        ORDER BY o.observed_at_ms DESC LIMIT 1`).get(workspaceId, concept) as Record<string, unknown> | undefined;
      if (intentRow) this.refreshCluster(decodeIntent(intentRow), nowMs);
    }
    return observations;
  }

  retireConceptObservations(
    workspaceId: string,
    conceptSha256: string,
    reason: Exclude<MemoryObservationV31RetirementReason, "EXPIRED">,
    nowMs: number,
    limit = 512,
  ): MemoryObservationV31Record[] {
    if (!shaPattern.test(conceptSha256) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Memory v3.1 concept retirement input is invalid");
    }
    const rows = this.connection.prepare(`SELECT o.* FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.concept_sha256=? AND r.observation_id IS NULL
      ORDER BY o.observed_at_ms,o.observation_id LIMIT ?`).all(workspaceId, conceptSha256, limit) as Record<string, unknown>[];
    const observations = rows.map(decodeObservation);
    for (const observation of observations) {
      const retirementId = idFromSha256("MRET", sha256Hex(`${observation.observationId}\0${reason}`));
      const base = { retirementId, observationId: observation.observationId, reason, retiredAtMs: nowMs };
      const hash = canonicalJsonSha256({ domain: "PCH-MEMORY-V3.1-OBSERVATION-RETIREMENT", ...base });
      this.connection.prepare(`INSERT INTO memory_v31_observation_retirements(retirement_id,observation_id,reason,
        retired_at_ms,retirement_sha256) VALUES(?,?,?,?,?)`).run(
        retirementId, observation.observationId, reason, nowMs, hash,
      );
    }
    const intentRow = this.connection.prepare(`SELECT i.* FROM memory_v31_capture_intents i
      JOIN memory_v31_observations o ON o.intent_id=i.intent_id WHERE o.workspace_id=? AND o.concept_sha256=?
      ORDER BY o.observed_at_ms DESC LIMIT 1`).get(workspaceId, conceptSha256) as Record<string, unknown> | undefined;
    if (intentRow) this.refreshCluster(decodeIntent(intentRow), nowMs);
    return observations;
  }

  eligibleClusters(workspaceId: string, limits: MemoryCaptureV31Limits = defaultMemoryCaptureV31Limits): MemoryCandidateClusterV31Record[] {
    requireLimits(limits);
    const rows = this.connection.prepare(`SELECT * FROM memory_v31_candidate_clusters WHERE workspace_id=? AND state='OPEN'
      AND active_observation_count>=?
      ORDER BY last_observed_at_ms,concept_sha256`).all(
      workspaceId, Math.min(limits.minimumIndependentObservations, 2),
    ) as Record<string, unknown>[];
    return rows.map(decodeCluster);
  }

  latestActiveObservation(workspaceId: string, conceptSha256: string, nowMs: number): MemoryObservationV31Record | null {
    const row = this.connection.prepare(`SELECT o.* FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.concept_sha256=? AND o.expires_at_ms>? AND r.observation_id IS NULL
      ORDER BY o.observed_at_ms DESC,o.observation_id DESC LIMIT 1`).get(workspaceId, conceptSha256, nowMs) as Record<string, unknown> | undefined;
    return row ? decodeObservation(row) : null;
  }

  activeObservations(workspaceId: string, conceptSha256: string, nowMs: number, limit = 512): MemoryObservationV31Record[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3.1 observation page limit is invalid");
    const rows = this.connection.prepare(`SELECT o.* FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.concept_sha256=? AND o.expires_at_ms>? AND r.observation_id IS NULL
      ORDER BY o.observed_at_ms,o.observation_id LIMIT ?`).all(workspaceId, conceptSha256, nowMs, limit) as Record<string, unknown>[];
    return rows.map(decodeObservation);
  }

  activeProposals(workspaceId: string, nowMs: number, limit: number, afterProposalId: string | null = null): MemoryProposalV31Record[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3.1 proposal page limit is invalid");
    const rows = this.connection.prepare(`SELECT p.* FROM memory_v31_proposals p
      LEFT JOIN memory_v31_proposal_resolutions r ON r.proposal_id=p.proposal_id
      WHERE p.workspace_id=? AND p.expires_at_ms>? AND r.proposal_id IS NULL AND (? IS NULL OR p.proposal_id>?)
      ORDER BY p.proposal_id LIMIT ?`).all(workspaceId, nowMs, afterProposalId, afterProposalId, limit) as Record<string, unknown>[];
    return rows.map(decodeProposal);
  }

  expiredProposals(workspaceId: string, nowMs: number, limit = 128): MemoryProposalV31Record[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3.1 proposal cleanup limit is invalid");
    const rows = this.connection.prepare(`SELECT p.* FROM memory_v31_proposals p
      LEFT JOIN memory_v31_proposal_resolutions r ON r.proposal_id=p.proposal_id
      WHERE p.workspace_id=? AND p.expires_at_ms<=? AND r.proposal_id IS NULL
      ORDER BY p.expires_at_ms,p.proposal_id LIMIT ?`).all(workspaceId, nowMs, limit) as Record<string, unknown>[];
    return rows.map(decodeProposal);
  }

  proposalForClaim(claimId: string): MemoryProposalV31Record | null {
    const row = this.connection.prepare(`SELECT p.* FROM memory_v31_proposals p
      LEFT JOIN memory_v31_proposal_resolutions r ON r.proposal_id=p.proposal_id
      WHERE p.claim_id=? AND r.proposal_id IS NULL`).get(claimId) as Record<string, unknown> | undefined;
    return row ? decodeProposal(row) : null;
  }

  clusterForClaim(workspaceId: string, claimId: string): MemoryCandidateClusterV31Record | null {
    const row = this.connection.prepare(`SELECT * FROM memory_v31_candidate_clusters
      WHERE workspace_id=? AND current_claim_id=?`).get(workspaceId, claimId) as Record<string, unknown> | undefined;
    return row ? decodeCluster(row) : null;
  }

  pendingIntents(workspaceId: string, limit = 100): MemoryCaptureV31IntentRecord[] {
    const rows = this.connection.prepare(`SELECT i.* FROM memory_v31_capture_intents i
      JOIN memory_v31_capture_outbox o ON o.intent_id=i.intent_id
      LEFT JOIN memory_v31_capture_receipts r ON r.intent_id=i.intent_id
      WHERE i.workspace_id=? AND r.intent_id IS NULL AND o.state IN ('PREPARED','VAULT_PREPARED')
      ORDER BY i.created_at_ms,i.intent_id LIMIT ?`).all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map(decodeIntent);
  }

  preparedVault(intentId: string): MemoryCaptureV31PreparedRecord | null {
    const row = this.connection.prepare(`SELECT * FROM memory_v31_capture_outbox
      WHERE intent_id=? AND state='VAULT_PREPARED'`).get(intentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      intentId, observationId: textValue(row, "observation_id"),
      workspaceId: this.intent(intentId)?.workspaceId ?? "",
      authorityMetadataSha256: textValue(row, "authority_metadata_sha256"), bodySha256: textValue(row, "body_sha256"),
      vaultRefSha256: textValue(row, "vault_ref_sha256"), keyRefSha256: textValue(row, "key_ref_sha256"),
      ciphertextSha256: textValue(row, "ciphertext_sha256"), wrappedKeySha256: textValue(row, "wrapped_key_sha256"),
    };
  }

  storedClaimForIntent(intentId: string): { readonly claimId: string; readonly status: "PROPOSED" | "ACTIVE" } | null {
    const intent = this.intent(intentId);
    if (!intent) return null;
    const row = this.connection.prepare(`SELECT e.claim_id,h.proposal_state FROM memory_v3_events e
      JOIN memory_v3_claim_heads h ON h.claim_id=e.claim_id
      WHERE e.workspace_id=? AND e.candidate_sha256=? AND e.event_type='CLAIM_STORED' AND e.claim_id IS NOT NULL
      ORDER BY e.stream_sequence DESC LIMIT 1`).get(intent.workspaceId, intent.candidateSha256) as Record<string, unknown> | undefined;
    if (!row) return null;
    const state = textValue(row, "proposal_state");
    if (state !== "PROPOSED" && state !== "ACTIVE") throw new AuthorityIntegrityError("Memory v3.1 recovered claim state is invalid");
    return { claimId: textValue(row, "claim_id"), status: state };
  }

  intent(intentId: string): MemoryCaptureV31IntentRecord | null {
    const row = this.connection.prepare("SELECT * FROM memory_v31_capture_intents WHERE intent_id=?").get(intentId) as Record<string, unknown> | undefined;
    return row ? decodeIntent(row) : null;
  }

  receipt(intentId: string): MemoryCaptureV31ReceiptRecord | null {
    const row = this.connection.prepare("SELECT * FROM memory_v31_capture_receipts WHERE intent_id=?").get(intentId) as Record<string, unknown> | undefined;
    return row ? decodeReceipt(row) : null;
  }

  observation(observationId: string): MemoryObservationV31Record | null {
    const row = this.connection.prepare("SELECT * FROM memory_v31_observations WHERE observation_id=?").get(observationId) as Record<string, unknown> | undefined;
    return row ? decodeObservation(row) : null;
  }

  cluster(workspaceId: string, conceptSha256: string): MemoryCandidateClusterV31Record | null {
    const row = this.connection.prepare(`SELECT * FROM memory_v31_candidate_clusters WHERE workspace_id=? AND concept_sha256=?`)
      .get(workspaceId, conceptSha256) as Record<string, unknown> | undefined;
    return row ? decodeCluster(row) : null;
  }

  vaultReferences(workspaceId: string): { readonly vaultRefSha256: ReadonlySet<string>; readonly keyRefSha256: ReadonlySet<string> } {
    const rows = this.connection.prepare(`SELECT o.vault_ref_sha256,o.key_ref_sha256 FROM memory_v31_observations o
      LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND r.observation_id IS NULL`).all(workspaceId) as Record<string, unknown>[];
    return { vaultRefSha256: new Set(rows.map((row) => textValue(row, "vault_ref_sha256"))),
      keyRefSha256: new Set(rows.map((row) => textValue(row, "key_ref_sha256"))) };
  }

  verifyIntegrity(): void {
    const available = Number((this.connection.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name='memory_v31_capture_intents'`).get() as { count?: unknown }).count ?? 0) === 1;
    if (!available) return;
    const intents = this.connection.prepare("SELECT * FROM memory_v31_capture_intents").all() as Record<string, unknown>[];
    for (const row of intents) decodeIntent(row);
    const observations = this.connection.prepare("SELECT * FROM memory_v31_observations").all() as Record<string, unknown>[];
    for (const row of observations) decodeObservation(row);
    const receipts = this.connection.prepare("SELECT * FROM memory_v31_capture_receipts").all() as Record<string, unknown>[];
    for (const row of receipts) decodeReceipt(row);
    const clusters = this.connection.prepare("SELECT * FROM memory_v31_candidate_clusters").all() as Record<string, unknown>[];
    for (const row of clusters) decodeCluster(row);
    const proposals = this.connection.prepare("SELECT * FROM memory_v31_proposals").all() as Record<string, unknown>[];
    for (const row of proposals) decodeProposal(row);
  }

  private clusterForObservation(observationId: string): MemoryCandidateClusterV31Record | null {
    const observation = this.observation(observationId);
    return observation ? this.cluster(observation.workspaceId, observation.conceptSha256) : null;
  }

  private refreshCluster(intent: MemoryCaptureV31IntentRecord, nowMs: number): MemoryCandidateClusterV31Record {
    if (!intent.conceptSha256) throw new TypeError("Memory v3.1 cluster requires a concept");
    const aggregate = this.connection.prepare(`SELECT count(*) AS active_count,
      count(DISTINCT o.source_session_hmac) AS session_count,count(DISTINCT o.source_day_bucket) AS day_count,
      min(o.observed_at_ms) AS first_ms,max(o.observed_at_ms) AS last_ms
      FROM memory_v31_observations o LEFT JOIN memory_v31_observation_retirements r ON r.observation_id=o.observation_id
      WHERE o.workspace_id=? AND o.concept_sha256=? AND o.expires_at_ms>? AND r.observation_id IS NULL`)
      .get(intent.workspaceId, intent.conceptSha256, nowMs) as Record<string, unknown>;
    const existing = this.cluster(intent.workspaceId, intent.conceptSha256);
    const count = Number(aggregate.active_count ?? 0);
    const first = count > 0 ? Number(aggregate.first_ms) : existing?.firstObservedAtMs ?? nowMs;
    const last = count > 0 ? Number(aggregate.last_ms) : existing?.lastObservedAtMs ?? nowMs;
    const base: Omit<MemoryCandidateClusterV31Record, "clusterSha256"> = {
      workspaceId: intent.workspaceId, conceptSha256: intent.conceptSha256, scope: intent.scope,
      goalId: intent.scope === "GOAL" ? intent.goalId : null, channel: intent.channel,
      state: existing?.state ?? "OPEN", activeObservationCount: count,
      independentSessionCount: Number(aggregate.session_count ?? 0), independentDayCount: Number(aggregate.day_count ?? 0),
      currentClaimId: existing?.currentClaimId ?? null, firstObservedAtMs: first, lastObservedAtMs: last,
    };
    const cluster = { ...base, clusterSha256: clusterHash(base) };
    this.connection.prepare(`INSERT INTO memory_v31_candidate_clusters(workspace_id,concept_sha256,scope,goal_id,channel,
      state,active_observation_count,independent_session_count,independent_day_count,current_claim_id,
      first_observed_at_ms,last_observed_at_ms,cluster_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,concept_sha256) DO UPDATE SET scope=excluded.scope,goal_id=excluded.goal_id,
      channel=excluded.channel,state=excluded.state,active_observation_count=excluded.active_observation_count,
      independent_session_count=excluded.independent_session_count,independent_day_count=excluded.independent_day_count,
      current_claim_id=excluded.current_claim_id,first_observed_at_ms=excluded.first_observed_at_ms,
      last_observed_at_ms=excluded.last_observed_at_ms,cluster_sha256=excluded.cluster_sha256`).run(
      cluster.workspaceId, cluster.conceptSha256, cluster.scope, cluster.goalId, cluster.channel, cluster.state,
      cluster.activeObservationCount, cluster.independentSessionCount, cluster.independentDayCount,
      cluster.currentClaimId, cluster.firstObservedAtMs, cluster.lastObservedAtMs, cluster.clusterSha256,
    );
    return cluster;
  }

  private setClusterState(
    workspaceId: string,
    conceptSha256: string,
    state: MemoryCandidateClusterV31Record["state"],
    claimId: string | null,
  ): void {
    const cluster = this.cluster(workspaceId, conceptSha256);
    if (!cluster) throw new AuthorityIntegrityError("Memory v3.1 proposal cluster is missing");
    const base = { ...cluster, state, currentClaimId: claimId };
    const { clusterSha256: ignored, ...hashInput } = base;
    void ignored;
    const updated = { ...hashInput, clusterSha256: clusterHash(hashInput) };
    this.connection.prepare(`UPDATE memory_v31_candidate_clusters SET state=?,current_claim_id=?,cluster_sha256=?
      WHERE workspace_id=? AND concept_sha256=?`).run(state, claimId, updated.clusterSha256, workspaceId, conceptSha256);
  }

  private insertReceipt(
    intentId: string,
    result: MemoryCaptureV31ReceiptResult,
    observationId: string | null,
    claimId: string | null,
    reasonCode: string,
    nowMs: number,
  ): MemoryCaptureV31ReceiptRecord {
    const receiptId = idFromSha256("MCRP", sha256Hex(`${intentId}\0${result}`));
    const base: Omit<MemoryCaptureV31ReceiptRecord, "receiptSha256"> = {
      receiptId, intentId, result, observationId, claimId, reasonCode, createdAtMs: nowMs,
    };
    const receipt = { ...base, receiptSha256: receiptHash(base) };
    this.connection.prepare(`INSERT INTO memory_v31_capture_receipts(receipt_id,intent_id,result,observation_id,
      claim_id,reason_code,receipt_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?)`).run(
      receipt.receiptId, receipt.intentId, receipt.result, receipt.observationId, receipt.claimId,
      receipt.reasonCode, receipt.receiptSha256, receipt.createdAtMs,
    );
    return receipt;
  }

  private finishOutbox(intentId: string, state: "COMMITTED" | "ABORTED", error: string | null, nowMs: number): void {
    const result = this.connection.prepare(`UPDATE memory_v31_capture_outbox SET state=?,last_error_code=?,updated_at_ms=?
      WHERE intent_id=? AND state IN ('PREPARED','VAULT_PREPARED')`).run(state, error, nowMs, intentId);
    if (Number(result.changes) !== 1) throw new AuthorityIntegrityError("Memory v3.1 capture outbox terminal transition failed");
  }
}
