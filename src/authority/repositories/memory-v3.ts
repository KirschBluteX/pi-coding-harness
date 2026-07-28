import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { sha256Hex } from "../../foundation/crypto.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import type {
  CurrentIntentDisposition, MemoryCaptureActor, MemoryCaptureDecision, MemoryCaptureRoute,
  MemoryCaptureSourceKind,
} from "../../memory/capture.js";
import type { MemoryChannel, MemoryClassification, MemoryScope } from "../../memory/types.js";

export type MemoryV3EventType = "CAPTURE_ROUTED" | "CLAIM_STORED" | "PROPOSAL_RESOLVED" | "ACTION_APPLIED" | "PURGE_RECONCILED";
export type MemoryV3SourceKind = MemoryCaptureSourceKind | "MANUAL_COMMAND" | "RECOVERY";

export interface MemoryV3CaptureEvent {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly streamSequence: number;
  readonly eventType: MemoryV3EventType;
  readonly sourceKind: MemoryV3SourceKind;
  readonly sourceActor: MemoryCaptureActor;
  readonly decisionActor: "USER" | "RUNTIME";
  readonly route: MemoryCaptureRoute | "MANUAL";
  readonly disposition: CurrentIntentDisposition | "NOT_APPLICABLE";
  readonly reasonCodes: readonly string[];
  readonly candidateSha256: string;
  readonly sourceLocatorSha256: string;
  readonly sourceContentSha256: string;
  readonly goalId: string | null;
  readonly claimId: string | null;
  readonly claimVersion: number | null;
  readonly channel: "POLICY" | "EVIDENCE" | "EXPERIENCE" | null;
  readonly scope: "GOAL" | "WORKSPACE" | null;
  readonly classification: "PUBLIC" | "INTERNAL" | null;
  readonly semanticKeySha256: string | null;
  readonly valueSha256: string | null;
  readonly bodySha256: string | null;
  readonly vaultRefSha256: string | null;
  readonly recordSha256: string | null;
  readonly previousEventSha256: string;
  readonly eventSha256: string;
  readonly createdAtMs: number;
}

export interface MemoryCaptureCommandResult {
  readonly reused: boolean;
  readonly commandId: string;
  readonly event: MemoryV3CaptureEvent;
}

export type MemoryCaptureFaultPoint = "after-memory-v3-event-write" | "after-memory-v3-head-write" | "after-memory-v3-command-write";

export type MemoryV3TermKind = "CONTENT" | "TAG" | "PATH" | "DEPENDENCY" | "SEMANTIC_KEY";
export type MemoryV3PayloadType = "TYPED_POLICY" | "EVIDENCE_LOCATOR" | "EXPERIENCE_RECORD";
export type MemoryV3InitialStatus = "PROPOSED" | "ACTIVE";
export type MemoryV3ProposalState = MemoryV3InitialStatus | "REJECTED";
export type MemoryV3Visibility = "VISIBLE" | "FORGOTTEN";
export type MemoryV3PurgeState = "PRESENT" | "PURGED_LOCAL_KEY" | "INTEGRITY_FAILED";
export type MemoryV3ActionType = "APPROVE" | "REJECT" | "ENDORSE" | "REVOKE_ENDORSEMENT" | "FORGET" | "RESTORE" | "PURGE_LOCAL_KEY";
export type MemoryV3ActionFamily = "PROPOSAL" | "ENDORSEMENT" | "VISIBILITY" | "PURGE";

export interface MemoryV3TermInput {
  readonly kind: MemoryV3TermKind;
  readonly hmac: string;
}

export interface MemoryV3ClaimDraft {
  readonly claimId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly sourceGoalId: string | null;
  readonly scope: MemoryScope;
  readonly scopeGoalId: string | null;
  readonly channel: MemoryChannel;
  readonly status: MemoryV3InitialStatus;
  readonly classification: MemoryClassification;
  readonly payloadType: MemoryV3PayloadType;
  readonly policyOperator: "PREFER" | "AVOID" | "REQUIRE" | "FORBID" | "SET" | null;
  readonly semanticKeySha256: string | null;
  readonly valueSha256: string | null;
  readonly bodySha256: string;
  readonly sourceLocatorSha256: string;
  readonly sourceContentSha256: string;
  readonly validFromMs: number;
  readonly expiresAtMs: number | null;
  readonly supersedesVersion: number | null;
  readonly terms: readonly MemoryV3TermInput[];
}

export interface MemoryV3StoreClaimInput extends MemoryV3ClaimDraft {
  readonly authorityMetadataSha256: string;
  readonly vaultRefSha256: string;
  readonly keyRefSha256: string;
  readonly ciphertextSha256: string;
  readonly wrappedKeySha256: string;
  readonly sourceKind: MemoryV3SourceKind;
  readonly sourceActor: MemoryCaptureActor;
  readonly decisionActor: "USER" | "RUNTIME";
  readonly route: MemoryCaptureRoute | "MANUAL";
  readonly disposition: CurrentIntentDisposition | "NOT_APPLICABLE";
  readonly reasonCodes: readonly string[];
  readonly candidateSha256: string;
}

export interface MemoryV3ClaimRecord extends Omit<MemoryV3StoreClaimInput,
  "sourceKind" | "sourceActor" | "decisionActor" | "route" | "disposition" | "reasonCodes" | "candidateSha256" | "terms"> {
  readonly claimSha256: string;
  readonly createdStreamSequence: number;
}

export interface MemoryV3ClaimHeadRecord {
  readonly claimId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly scopeGoalId: string | null;
  readonly channel: MemoryChannel;
  readonly proposalState: MemoryV3ProposalState;
  readonly visibility: MemoryV3Visibility;
  readonly purgeState: MemoryV3PurgeState;
  readonly endorsed: boolean;
  readonly claimSha256: string;
  readonly lastStreamSequence: number;
}

export interface MemoryV3CandidateHeadMatch {
  readonly head: MemoryV3ClaimHeadRecord;
  readonly matchedTerms: number;
}

export interface MemoryV3WorkspaceStatus {
  readonly total: number;
  readonly active: number;
  readonly proposed: number;
  readonly rejected: number;
  readonly forgotten: number;
  readonly purged: number;
  readonly integrityFailed: number;
  readonly endorsed: number;
}

export interface MemoryV3ActionInput {
  readonly workspaceId: string;
  readonly claimId: string;
  readonly targetVersion: number;
  readonly actionType: MemoryV3ActionType;
  readonly sourceActor: "USER" | "RUNTIME";
  readonly reasonCode: string;
  readonly purgeIntentId: string | null;
}

export interface MemoryV3ActionRecord extends MemoryV3ActionInput {
  readonly actionId: string;
  readonly actionFamily: MemoryV3ActionFamily;
  readonly predecessorActionId: string | null;
  readonly actionSha256: string;
  readonly createdAtMs: number;
  readonly createdStreamSequence: number;
}

export interface MemoryV3PurgeIntentInput {
  readonly workspaceId: string;
  readonly claimId: string;
  readonly targetVersion: number;
  readonly requestedBy: "USER" | "RUNTIME";
}

export interface MemoryV3PurgeIntentRecord extends MemoryV3PurgeIntentInput {
  readonly intentId: string;
  readonly versionManifestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly intentSha256: string;
  readonly createdAtMs: number;
}

export interface MemoryV3PurgeIntentResult {
  readonly reused: boolean;
  readonly intent: MemoryV3PurgeIntentRecord;
  readonly versions: readonly MemoryV3ClaimRecord[];
}

export interface MemoryV3ClaimCommandResult {
  readonly reused: boolean;
  readonly commandId: string;
  readonly event: MemoryV3CaptureEvent;
  readonly claim: MemoryV3ClaimRecord;
}

export interface MemoryV3ActionCommandResult {
  readonly reused: boolean;
  readonly commandId: string;
  readonly event: MemoryV3CaptureEvent;
  readonly action: MemoryV3ActionRecord;
  readonly head: MemoryV3ClaimHeadRecord;
}

export type MemoryV3MutationFaultPoint = MemoryCaptureFaultPoint
  | "after-memory-v3-claim-write" | "after-memory-v3-terms-write" | "after-memory-v3-claim-head-write"
  | "after-memory-v3-action-write" | "after-memory-v3-action-head-write" | "after-memory-v3-projection-write";

export const memoryV3PurgeLimitation = "PURGE_LOCAL_KEY deletes only current PCH-managed wrapped keys under the configured local data root; it does not delete provider logs, earlier Pi history, project source files, filesystem snapshots, external backups, or copies outside that root.";
export const memoryV3PurgeLimitationSha256 = sha256Hex(memoryV3PurgeLimitation);

const zeroSha256 = "0".repeat(64);
const shaPattern = /^[a-f0-9]{64}$/u;

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new AuthorityIntegrityError(`Memory v3 ${key} is invalid`);
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Memory v3 ${key} is invalid`);
  return value;
}

function integerValue(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new AuthorityIntegrityError(`Memory v3 ${key} is invalid`);
  return value;
}

function reasons(value: unknown): string[] {
  if (typeof value !== "string") throw new AuthorityIntegrityError("Memory v3 reason_codes_json is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch (error) { throw new AuthorityIntegrityError("Memory v3 reason codes are not JSON", error); }
  if (!Array.isArray(parsed) || parsed.length === 0
    || parsed.some((entry) => typeof entry !== "string" || !/^[A-Z0-9_:-]{1,128}$/u.test(entry))) {
    throw new AuthorityIntegrityError("Memory v3 reason codes are invalid");
  }
  return (parsed as unknown[]).map((entry) => String(entry));
}

function validateTerms(terms: readonly MemoryV3TermInput[]): MemoryV3TermInput[] {
  if (terms.length > 256) throw new RangeError("Memory v3 claim contains too many lookup terms");
  const normalized = terms.map((term) => {
    if (!["CONTENT", "TAG", "PATH", "DEPENDENCY", "SEMANTIC_KEY"].includes(term.kind) || !shaPattern.test(term.hmac)) {
      throw new TypeError("Memory v3 lookup term is invalid");
    }
    return { kind: term.kind, hmac: term.hmac };
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.hmac.localeCompare(right.hmac));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.kind === normalized[index]?.kind && normalized[index - 1]?.hmac === normalized[index]?.hmac) {
      throw new TypeError("Memory v3 lookup terms contain a duplicate");
    }
  }
  return normalized;
}

export function memoryV3AuthorityMetadata(claim: MemoryV3ClaimDraft): Readonly<Record<string, CanonicalJson>> {
  const terms = validateTerms(claim.terms);
  return {
    domain: "PCH-MEMORY-V3-CLAIM-AUTHORITY-METADATA", claimId: claim.claimId, version: claim.version,
    workspaceId: claim.workspaceId, sourceGoalId: claim.sourceGoalId, scope: claim.scope,
    scopeGoalId: claim.scopeGoalId, channel: claim.channel, status: claim.status,
    classification: claim.classification, payloadType: claim.payloadType, policyOperator: claim.policyOperator,
    semanticKeySha256: claim.semanticKeySha256, valueSha256: claim.valueSha256, bodySha256: claim.bodySha256,
    sourceLocatorSha256: claim.sourceLocatorSha256, sourceContentSha256: claim.sourceContentSha256,
    validFromMs: claim.validFromMs, expiresAtMs: claim.expiresAtMs,
    supersedesVersion: claim.supersedesVersion,
    termManifestSha256: canonicalJsonSha256(terms),
  };
}

function claimSha256(claim: Pick<MemoryV3StoreClaimInput,
  "authorityMetadataSha256" | "vaultRefSha256" | "keyRefSha256" | "ciphertextSha256" | "wrappedKeySha256">): string {
  return canonicalJsonSha256({
    domain: "PCH-MEMORY-V3-CLAIM-VERSION", authorityMetadataSha256: claim.authorityMetadataSha256,
    vaultRefSha256: claim.vaultRefSha256, keyRefSha256: claim.keyRefSha256,
    ciphertextSha256: claim.ciphertextSha256, wrappedKeySha256: claim.wrappedKeySha256,
  });
}

function actionFamily(action: MemoryV3ActionType): MemoryV3ActionFamily {
  if (action === "APPROVE" || action === "REJECT") return "PROPOSAL";
  if (action === "ENDORSE" || action === "REVOKE_ENDORSEMENT") return "ENDORSEMENT";
  if (action === "FORGET" || action === "RESTORE") return "VISIBILITY";
  return "PURGE";
}

function actionSha256(action: Omit<MemoryV3ActionRecord, "actionSha256" | "createdStreamSequence">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3-ACTION", ...action });
}

function eventHashInput(event: Omit<MemoryV3CaptureEvent, "eventSha256">): Readonly<Record<string, unknown>> {
  return {
    domain: "PCH-MEMORY-V3-WORKSPACE-EVENT",
    eventId: event.eventId, workspaceId: event.workspaceId, streamSequence: event.streamSequence,
    eventType: event.eventType, sourceKind: event.sourceKind, sourceActor: event.sourceActor,
    decisionActor: event.decisionActor, route: event.route, disposition: event.disposition,
    reasonCodes: event.reasonCodes, candidateSha256: event.candidateSha256,
    sourceLocatorSha256: event.sourceLocatorSha256, sourceContentSha256: event.sourceContentSha256,
    goalId: event.goalId, claimId: event.claimId, claimVersion: event.claimVersion,
    channel: event.channel, scope: event.scope, classification: event.classification,
    semanticKeySha256: event.semanticKeySha256, valueSha256: event.valueSha256,
    bodySha256: event.bodySha256, vaultRefSha256: event.vaultRefSha256,
    ...(event.recordSha256 === null ? {} : { recordSha256: event.recordSha256 }),
    previousEventSha256: event.previousEventSha256, createdAtMs: event.createdAtMs,
  };
}

export function computeMemoryV3EventSha256(event: Omit<MemoryV3CaptureEvent, "eventSha256">): string {
  return canonicalJsonSha256(eventHashInput(event));
}

function decodeEvent(row: Record<string, unknown>): MemoryV3CaptureEvent {
  const base: Omit<MemoryV3CaptureEvent, "eventSha256"> = {
    eventId: stringValue(row, "event_id"), workspaceId: stringValue(row, "workspace_id"),
    streamSequence: integerValue(row, "stream_sequence"), eventType: stringValue(row, "event_type") as MemoryV3EventType,
    sourceKind: stringValue(row, "source_kind") as MemoryV3SourceKind,
    sourceActor: stringValue(row, "source_actor") as MemoryCaptureActor,
    decisionActor: stringValue(row, "decision_actor") as "USER" | "RUNTIME",
    route: stringValue(row, "route") as MemoryCaptureRoute | "MANUAL",
    disposition: stringValue(row, "disposition") as CurrentIntentDisposition | "NOT_APPLICABLE",
    reasonCodes: reasons(row.reason_codes_json), candidateSha256: stringValue(row, "candidate_sha256"),
    sourceLocatorSha256: stringValue(row, "source_locator_sha256"),
    sourceContentSha256: stringValue(row, "source_content_sha256"), goalId: nullableString(row, "goal_id"),
    claimId: nullableString(row, "claim_id"), claimVersion: row.claim_version === null ? null : integerValue(row, "claim_version"),
    channel: nullableString(row, "channel") as MemoryV3CaptureEvent["channel"],
    scope: nullableString(row, "scope") as MemoryV3CaptureEvent["scope"],
    classification: nullableString(row, "classification") as MemoryV3CaptureEvent["classification"],
    semanticKeySha256: nullableString(row, "semantic_key_sha256"), valueSha256: nullableString(row, "value_sha256"),
    bodySha256: nullableString(row, "body_sha256"), vaultRefSha256: nullableString(row, "vault_ref_sha256"),
    recordSha256: nullableString(row, "record_sha256"),
    previousEventSha256: stringValue(row, "previous_event_sha256"), createdAtMs: integerValue(row, "created_at_ms"),
  };
  const eventSha256 = stringValue(row, "event_sha256");
  for (const hash of [base.candidateSha256, base.sourceLocatorSha256, base.sourceContentSha256,
    base.previousEventSha256, eventSha256, base.semanticKeySha256, base.valueSha256, base.bodySha256,
    base.vaultRefSha256, base.recordSha256]) {
    if (hash !== null && !shaPattern.test(hash)) throw new AuthorityIntegrityError(`Memory v3 event ${base.eventId} contains an invalid hash`);
  }
  if (computeMemoryV3EventSha256(base) !== eventSha256) {
    throw new AuthorityIntegrityError(`Memory v3 event ${base.eventId} failed hash verification`);
  }
  return { ...base, eventSha256 };
}

function booleanValue(row: Record<string, unknown>, key: string): boolean {
  const value = integerValue(row, key);
  if (value !== 0 && value !== 1) throw new AuthorityIntegrityError(`Memory v3 ${key} is invalid`);
  return value === 1;
}

function decodeHead(row: Record<string, unknown>): MemoryV3ClaimHeadRecord {
  return {
    claimId: stringValue(row, "claim_id"), version: integerValue(row, "version"),
    workspaceId: stringValue(row, "workspace_id"), scope: stringValue(row, "scope") as MemoryScope,
    scopeGoalId: nullableString(row, "scope_goal_id"), channel: stringValue(row, "channel") as MemoryChannel,
    proposalState: stringValue(row, "proposal_state") as MemoryV3ProposalState,
    visibility: stringValue(row, "visibility") as MemoryV3Visibility,
    purgeState: stringValue(row, "purge_state") as MemoryV3PurgeState,
    endorsed: booleanValue(row, "endorsed"), claimSha256: stringValue(row, "claim_sha256"),
    lastStreamSequence: integerValue(row, "last_stream_sequence"),
  };
}

function decodeAction(row: Record<string, unknown>): MemoryV3ActionRecord {
  const record: MemoryV3ActionRecord = {
    actionId: stringValue(row, "action_id"), workspaceId: stringValue(row, "workspace_id"),
    claimId: stringValue(row, "claim_id"), targetVersion: integerValue(row, "target_version"),
    actionType: stringValue(row, "action_type") as MemoryV3ActionType,
    actionFamily: stringValue(row, "action_family") as MemoryV3ActionFamily,
    sourceActor: stringValue(row, "source_actor") as "USER" | "RUNTIME",
    reasonCode: stringValue(row, "reason_code"), purgeIntentId: nullableString(row, "purge_intent_id"),
    predecessorActionId: nullableString(row, "predecessor_action_id"),
    actionSha256: stringValue(row, "action_sha256"), createdAtMs: integerValue(row, "created_at_ms"),
    createdStreamSequence: integerValue(row, "created_stream_sequence"),
  };
  const expected = record.actionSha256;
  const base: Omit<MemoryV3ActionRecord, "actionSha256" | "createdStreamSequence"> = {
    actionId: record.actionId, workspaceId: record.workspaceId, claimId: record.claimId,
    targetVersion: record.targetVersion, actionType: record.actionType, actionFamily: record.actionFamily,
    sourceActor: record.sourceActor, reasonCode: record.reasonCode, purgeIntentId: record.purgeIntentId,
    predecessorActionId: record.predecessorActionId, createdAtMs: record.createdAtMs,
  };
  if (!shaPattern.test(expected) || actionSha256(base) !== expected) {
    throw new AuthorityIntegrityError(`Memory v3 action ${record.actionId} failed hash verification`);
  }
  if ((record.actionType === "PURGE_LOCAL_KEY") !== (record.purgeIntentId !== null)) {
    throw new AuthorityIntegrityError(`Memory v3 action ${record.actionId} has an invalid purge binding`);
  }
  return record;
}

function purgeReceiptSha256(input: {
  readonly receiptId: string; readonly intentId: string; readonly actionId: string;
  readonly result: "PURGED_LOCAL_KEY"; readonly limitationContractSha256: string; readonly createdAtMs: number;
}): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3-PURGE-RECEIPT", ...input });
}

function purgeIntentSha256(input: Omit<MemoryV3PurgeIntentRecord, "intentSha256">): string {
  return canonicalJsonSha256({ domain: "PCH-MEMORY-V3-PURGE-INTENT", ...input });
}

function decodePurgeIntent(row: Record<string, unknown>): MemoryV3PurgeIntentRecord {
  const base: Omit<MemoryV3PurgeIntentRecord, "intentSha256"> = {
    intentId: stringValue(row, "intent_id"), workspaceId: stringValue(row, "workspace_id"),
    claimId: stringValue(row, "claim_id"), targetVersion: integerValue(row, "target_version"),
    versionManifestSha256: stringValue(row, "version_manifest_sha256"),
    idempotencyKeySha256: stringValue(row, "idempotency_key_sha256"),
    requestedBy: stringValue(row, "requested_by") as "USER" | "RUNTIME",
    createdAtMs: integerValue(row, "created_at_ms"),
  };
  const intentSha256 = stringValue(row, "intent_sha256");
  if (![base.versionManifestSha256, base.idempotencyKeySha256, intentSha256].every((value) => shaPattern.test(value))
    || purgeIntentSha256(base) !== intentSha256) {
    throw new AuthorityIntegrityError(`Memory v3 purge intent ${base.intentId} failed hash verification`);
  }
  return { ...base, intentSha256 };
}

function tableExists(connection: AuthorityConnection): boolean {
  const row = connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_v3_events'")
    .get() as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

export class MemoryV3Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection);
  }

  appendCaptureDecision(
    capture: MemoryCaptureDecision,
    idempotencyKey: string,
    createdAtMs: number,
    onFault?: (point: MemoryCaptureFaultPoint) => void,
  ): MemoryCaptureCommandResult {
    if (!this.available()) throw new AuthorityIntegrityError("Memory v3 authority migration is not available");
    if (!idempotencyKey || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new TypeError("Memory v3 capture command metadata is invalid");
    }
    const idempotencyKeySha256 = sha256Hex(idempotencyKey);
    const commandSha256 = canonicalJsonSha256({ domain: "PCH-MEMORY-V3-CAPTURE-COMMAND", capture });
    const commandId = idFromSha256("MCMD", sha256Hex(`${capture.workspaceId}\0${idempotencyKeySha256}`));
    const existing = this.connection.prepare(`SELECT command_sha256,result_event_id FROM memory_v3_commands
      WHERE command_id=? AND workspace_id=? AND idempotency_key_sha256=?`)
      .get(commandId, capture.workspaceId, idempotencyKeySha256) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.command_sha256 !== commandSha256) {
        throw new AuthorityIntegrityError("Memory v3 idempotency key was reused for different content");
      }
      const reused = this.event(stringValue(existing, "result_event_id"));
      if (!reused) throw new AuthorityIntegrityError("Memory v3 command references a missing event");
      return { reused: true, commandId, event: reused };
    }

    const head = this.connection.prepare(`SELECT stream_sequence,last_event_sha256 FROM memory_v3_workspace_stream_heads
      WHERE workspace_id=?`).get(capture.workspaceId) as Record<string, unknown> | undefined;
    const streamSequence = head ? integerValue(head, "stream_sequence") + 1 : 1;
    const previousEventSha256 = head ? stringValue(head, "last_event_sha256") : zeroSha256;
    const eventId = idFromSha256("MEVT", sha256Hex(`${capture.workspaceId}\0${streamSequence}\0${commandId}\0${commandSha256}`));
    const base: Omit<MemoryV3CaptureEvent, "eventSha256"> = {
      eventId, workspaceId: capture.workspaceId, streamSequence, eventType: "CAPTURE_ROUTED",
      sourceKind: capture.sourceKind, sourceActor: capture.sourceActor, decisionActor: capture.decisionActor,
      route: capture.route, disposition: capture.disposition, reasonCodes: capture.reasonCodes,
      candidateSha256: capture.candidateSha256, sourceLocatorSha256: capture.sourceLocatorSha256,
      sourceContentSha256: capture.sourceContentSha256, goalId: capture.goalId, claimId: null,
      claimVersion: null, channel: capture.channel, scope: capture.scope,
       classification: capture.classification, semanticKeySha256: capture.semanticKeySha256,
       valueSha256: capture.valueSha256, bodySha256: null, vaultRefSha256: null,
       recordSha256: null,
       previousEventSha256, createdAtMs,
    };
    const event = { ...base, eventSha256: computeMemoryV3EventSha256(base) };
    this.connection.prepare(`INSERT INTO memory_v3_events(
      event_id,workspace_id,stream_sequence,event_type,source_kind,source_actor,decision_actor,route,disposition,
      reason_codes_json,candidate_sha256,source_locator_sha256,source_content_sha256,goal_id,claim_id,claim_version,
      channel,scope,classification,semantic_key_sha256,value_sha256,body_sha256,vault_ref_sha256,record_sha256,
      previous_event_sha256,event_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventId, event.workspaceId, event.streamSequence, event.eventType, event.sourceKind,
        event.sourceActor, event.decisionActor, event.route, event.disposition, canonicalJson(event.reasonCodes),
        event.candidateSha256, event.sourceLocatorSha256, event.sourceContentSha256, event.goalId, event.claimId,
        event.claimVersion, event.channel, event.scope, event.classification, event.semanticKeySha256,
        event.valueSha256, event.bodySha256, event.vaultRefSha256, event.recordSha256, event.previousEventSha256,
        event.eventSha256, event.createdAtMs);
    onFault?.("after-memory-v3-event-write");
    this.connection.prepare(`INSERT INTO memory_v3_workspace_stream_heads(workspace_id,stream_sequence,last_event_sha256,updated_at_ms)
      VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET stream_sequence=excluded.stream_sequence,
      last_event_sha256=excluded.last_event_sha256,updated_at_ms=excluded.updated_at_ms`)
      .run(event.workspaceId, event.streamSequence, event.eventSha256, event.createdAtMs);
    onFault?.("after-memory-v3-head-write");
    this.connection.prepare(`INSERT INTO memory_v3_commands(
      command_id,workspace_id,idempotency_key_sha256,command_sha256,result_event_id,created_at_ms) VALUES(?,?,?,?,?,?)`)
      .run(commandId, capture.workspaceId, idempotencyKeySha256, commandSha256, event.eventId, createdAtMs);
    onFault?.("after-memory-v3-command-write");
    return { reused: false, commandId, event };
  }

  appendClaim(
    input: MemoryV3StoreClaimInput,
    idempotencyKey: string,
    createdAtMs: number,
    onFault?: (point: MemoryV3MutationFaultPoint) => void,
  ): MemoryV3ClaimCommandResult {
    this.validateClaimInput(input, idempotencyKey, createdAtMs);
    const idempotencyKeySha256 = sha256Hex(idempotencyKey);
    const commandSha256 = canonicalJsonSha256({ domain: "PCH-MEMORY-V3-STORE-CLAIM-COMMAND", input });
    const commandId = idFromSha256("MCMD", sha256Hex(`${input.workspaceId}\0${idempotencyKeySha256}`));
    const existing = this.existingCommand(commandId, input.workspaceId, idempotencyKeySha256, commandSha256);
    if (existing) {
      const event = this.requiredEvent(existing.resultEventId);
      if (!event.claimId || event.claimVersion === null) throw new AuthorityIntegrityError("Memory v3 claim command result is incomplete");
      const claim = this.claim(event.claimId, event.claimVersion);
      if (!claim) throw new AuthorityIntegrityError("Memory v3 claim command references a missing claim");
      return { reused: true, commandId, event, claim };
    }

    const current = this.claimHead(input.claimId);
    if (input.version === 1) {
      if (current || input.supersedesVersion !== null) throw new AuthorityIntegrityError("Memory v3 initial claim version is invalid");
    } else if (!current || current.workspaceId !== input.workspaceId || current.version !== input.version - 1
      || input.supersedesVersion !== current.version || current.purgeState !== "PRESENT") {
      throw new AuthorityIntegrityError("Memory v3 correction does not supersede the current claim head");
    }
    const terms = validateTerms(input.terms);
    const recordSha256 = claimSha256(input);
    const event = this.insertWorkspaceEvent({
      workspaceId: input.workspaceId, eventType: "CLAIM_STORED", sourceKind: input.sourceKind,
      sourceActor: input.sourceActor, decisionActor: input.decisionActor, route: input.route,
      disposition: input.disposition, reasonCodes: input.reasonCodes, candidateSha256: input.candidateSha256,
      sourceLocatorSha256: input.sourceLocatorSha256, sourceContentSha256: input.sourceContentSha256,
      goalId: input.sourceGoalId, claimId: input.claimId, claimVersion: input.version,
      channel: input.channel, scope: input.scope, classification: input.classification,
      semanticKeySha256: input.semanticKeySha256, valueSha256: input.valueSha256,
      bodySha256: input.bodySha256, vaultRefSha256: input.vaultRefSha256, recordSha256,
    }, commandId, commandSha256, createdAtMs);
    onFault?.("after-memory-v3-event-write");

    this.connection.prepare(`INSERT INTO memory_v3_claim_versions(
      claim_id,version,workspace_id,source_goal_id,scope,scope_goal_id,channel,status,classification,payload_type,
      policy_operator,semantic_key_sha256,value_sha256,body_sha256,source_locator_sha256,source_content_sha256,
      vault_ref_sha256,key_ref_sha256,ciphertext_sha256,valid_from_ms,expires_at_ms,supersedes_version,
      claim_sha256,created_stream_sequence,authority_metadata_sha256,wrapped_key_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.claimId, input.version, input.workspaceId, input.sourceGoalId, input.scope, input.scopeGoalId,
      input.channel, input.status, input.classification, input.payloadType, input.policyOperator,
      input.semanticKeySha256, input.valueSha256, input.bodySha256, input.sourceLocatorSha256,
      input.sourceContentSha256, input.vaultRefSha256, input.keyRefSha256, input.ciphertextSha256,
      input.validFromMs, input.expiresAtMs, input.supersedesVersion, recordSha256, event.streamSequence,
      input.authorityMetadataSha256, input.wrappedKeySha256,
    );
    onFault?.("after-memory-v3-claim-write");
    const termStatement = this.connection.prepare(`INSERT INTO memory_v3_terms(
      claim_id,version,workspace_id,term_kind,term_hmac) VALUES(?,?,?,?,?)`);
    for (const term of terms) termStatement.run(input.claimId, input.version, input.workspaceId, term.kind, term.hmac);
    onFault?.("after-memory-v3-terms-write");
    this.connection.prepare(`INSERT INTO memory_v3_claim_heads(
      claim_id,version,workspace_id,scope,scope_goal_id,channel,status,claim_sha256,last_stream_sequence,
      proposal_state,visibility,purge_state,endorsed
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET
      version=excluded.version,workspace_id=excluded.workspace_id,scope=excluded.scope,
      scope_goal_id=excluded.scope_goal_id,channel=excluded.channel,status=excluded.status,
      claim_sha256=excluded.claim_sha256,last_stream_sequence=excluded.last_stream_sequence,
      proposal_state=excluded.proposal_state,visibility=excluded.visibility,purge_state=excluded.purge_state,
      endorsed=excluded.endorsed`).run(
      input.claimId, input.version, input.workspaceId, input.scope, input.scopeGoalId, input.channel,
      input.status, recordSha256, event.streamSequence, input.status, "VISIBLE", "PRESENT", 0,
    );
    onFault?.("after-memory-v3-claim-head-write");
    this.finishWorkspaceCommand(event, commandId, idempotencyKeySha256, commandSha256, createdAtMs, onFault);
    const claim = this.claim(input.claimId, input.version);
    if (!claim) throw new AuthorityIntegrityError("Memory v3 stored claim cannot be read back");
    return { reused: false, commandId, event, claim };
  }

  preparePurgeIntent(
    input: MemoryV3PurgeIntentInput,
    idempotencyKey: string,
    createdAtMs: number,
  ): MemoryV3PurgeIntentResult {
    if (!idempotencyKey || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new TypeError("Memory v3 purge intent metadata is invalid");
    }
    const head = this.claimHead(input.claimId);
    if (!head || head.workspaceId !== input.workspaceId || head.version !== input.targetVersion
      || head.purgeState !== "PRESENT") {
      throw new AuthorityIntegrityError("Memory v3 purge intent target is not eligible");
    }
    const versions = this.claimVersions(input.claimId);
    const versionManifestSha256 = canonicalJsonSha256(versions.map((version) => ({
      claimId: version.claimId, version: version.version, claimSha256: version.claimSha256,
      keyRefSha256: version.keyRefSha256, wrappedKeySha256: version.wrappedKeySha256,
    })));
    const idempotencyKeySha256 = sha256Hex(idempotencyKey);
    const intentId = idFromSha256("MPINT", sha256Hex(`${input.workspaceId}\0${idempotencyKeySha256}`));
    const base: Omit<MemoryV3PurgeIntentRecord, "intentSha256"> = {
      ...input, intentId, versionManifestSha256, idempotencyKeySha256, createdAtMs,
    };
    const intentSha256 = purgeIntentSha256(base);
    const existing = this.connection.prepare(`SELECT * FROM memory_v3_purge_intents
      WHERE workspace_id=? AND idempotency_key_sha256=?`).get(input.workspaceId, idempotencyKeySha256) as Record<string, unknown> | undefined;
    if (existing) {
      const intent = decodePurgeIntent(existing);
      if (intent.intentSha256 !== intentSha256) {
        throw new AuthorityIntegrityError("Memory v3 purge idempotency key was reused for a different intent");
      }
      return { reused: true, intent, versions };
    }
    this.connection.prepare(`INSERT INTO memory_v3_purge_intents(
      intent_id,workspace_id,claim_id,target_version,version_manifest_sha256,idempotency_key_sha256,
      requested_by,intent_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      intentId, input.workspaceId, input.claimId, input.targetVersion, versionManifestSha256,
      idempotencyKeySha256, input.requestedBy, intentSha256, createdAtMs,
    );
    return { reused: false, intent: { ...base, intentSha256 }, versions };
  }

  pendingPurgeIntents(workspaceId: string, limit = 100): MemoryV3PurgeIntentRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3 purge intent limit is invalid");
    const rows = this.connection.prepare(`SELECT i.* FROM memory_v3_purge_intents i
      LEFT JOIN memory_v3_purge_receipts r ON r.intent_id=i.intent_id
      WHERE i.workspace_id=? AND r.intent_id IS NULL ORDER BY i.created_at_ms LIMIT ?`)
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map(decodePurgeIntent);
  }

  appendAction(
    input: MemoryV3ActionInput,
    idempotencyKey: string,
    createdAtMs: number,
    onFault?: (point: MemoryV3MutationFaultPoint) => void,
  ): MemoryV3ActionCommandResult {
    if (!idempotencyKey || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0
      || !/^[A-Z0-9_:-]{1,128}$/u.test(input.reasonCode)) {
      throw new TypeError("Memory v3 action command metadata is invalid");
    }
    const idempotencyKeySha256 = sha256Hex(idempotencyKey);
    const commandSha256 = canonicalJsonSha256({ domain: "PCH-MEMORY-V3-ACTION-COMMAND", input });
    const commandId = idFromSha256("MCMD", sha256Hex(`${input.workspaceId}\0${idempotencyKeySha256}`));
    const existing = this.existingCommand(commandId, input.workspaceId, idempotencyKeySha256, commandSha256);
    if (existing) {
      const event = this.requiredEvent(existing.resultEventId);
      if (!event.recordSha256) throw new AuthorityIntegrityError("Memory v3 action command result is incomplete");
      const row = this.connection.prepare("SELECT * FROM memory_v3_actions WHERE action_sha256=?")
        .get(event.recordSha256) as Record<string, unknown> | undefined;
      if (!row) throw new AuthorityIntegrityError("Memory v3 action command references a missing action");
      const action = decodeAction(row);
      const head = this.claimHead(action.claimId);
      if (!head) throw new AuthorityIntegrityError("Memory v3 action command references a missing head");
      return { reused: true, commandId, event, action, head };
    }

    const head = this.claimHead(input.claimId);
    if (!head || head.workspaceId !== input.workspaceId || head.version !== input.targetVersion) {
      throw new AuthorityIntegrityError("Memory v3 action target is not the current workspace claim");
    }
    let purgeIntent: MemoryV3PurgeIntentRecord | null = null;
    if (input.actionType === "PURGE_LOCAL_KEY") {
      if (!input.purgeIntentId) throw new AuthorityIntegrityError("Memory v3 purge action requires a purge intent");
      const intentRow = this.connection.prepare(`SELECT i.* FROM memory_v3_purge_intents i
        LEFT JOIN memory_v3_purge_receipts r ON r.intent_id=i.intent_id
        WHERE i.intent_id=? AND r.intent_id IS NULL`).get(input.purgeIntentId) as Record<string, unknown> | undefined;
      if (!intentRow) throw new AuthorityIntegrityError("Memory v3 purge intent is missing or already committed");
      purgeIntent = decodePurgeIntent(intentRow);
      if (purgeIntent.workspaceId !== input.workspaceId || purgeIntent.claimId !== input.claimId
        || purgeIntent.targetVersion !== input.targetVersion) {
        throw new AuthorityIntegrityError("Memory v3 purge intent does not match the action target");
      }
      const currentManifest = canonicalJsonSha256(this.claimVersions(input.claimId).map((version) => ({
        claimId: version.claimId, version: version.version, claimSha256: version.claimSha256,
        keyRefSha256: version.keyRefSha256, wrappedKeySha256: version.wrappedKeySha256,
      })));
      if (currentManifest !== purgeIntent.versionManifestSha256) {
        throw new AuthorityIntegrityError("Memory v3 purge version manifest changed after prepare");
      }
    } else if (input.purgeIntentId !== null) {
      throw new TypeError("Memory v3 non-purge action cannot reference a purge intent");
    }
    this.validateActionTransition(head, input.actionType);
    const claim = this.claim(input.claimId, input.targetVersion);
    if (!claim) throw new AuthorityIntegrityError("Memory v3 action target claim is missing");
    const family = actionFamily(input.actionType);
    const prior = this.connection.prepare(`SELECT a.* FROM memory_v3_action_heads h
      JOIN memory_v3_actions a ON a.action_id=h.action_id WHERE h.claim_id=? AND h.action_family=?`)
      .get(input.claimId, family) as Record<string, unknown> | undefined;
    const predecessorActionId = prior ? decodeAction(prior).actionId : null;
    const actionId = idFromSha256("MACT3", sha256Hex(`${commandId}\0${input.claimId}\0${input.actionType}`));
    const actionBase = { ...input, actionId, actionFamily: family, predecessorActionId, createdAtMs };
    const recordSha256 = actionSha256(actionBase);
    const event = this.insertWorkspaceEvent({
      workspaceId: input.workspaceId,
      eventType: input.actionType === "PURGE_LOCAL_KEY" && input.sourceActor === "RUNTIME"
        ? "PURGE_RECONCILED" : input.actionType === "APPROVE" || input.actionType === "REJECT"
          ? "PROPOSAL_RESOLVED" : "ACTION_APPLIED",
      sourceKind: input.sourceActor === "RUNTIME" ? "RECOVERY" : "MANUAL_COMMAND",
      sourceActor: input.sourceActor, decisionActor: input.sourceActor, route: "MANUAL",
      disposition: "NOT_APPLICABLE", reasonCodes: [input.actionType, input.reasonCode],
      candidateSha256: commandSha256, sourceLocatorSha256: sha256Hex(`memory-v3://${input.claimId}`),
      sourceContentSha256: recordSha256, goalId: claim.sourceGoalId, claimId: input.claimId,
      claimVersion: input.targetVersion, channel: claim.channel, scope: claim.scope,
      classification: claim.classification, semanticKeySha256: claim.semanticKeySha256,
      valueSha256: claim.valueSha256, bodySha256: claim.bodySha256,
      vaultRefSha256: claim.vaultRefSha256, recordSha256,
    }, commandId, commandSha256, createdAtMs);
    onFault?.("after-memory-v3-event-write");
    this.connection.prepare(`INSERT INTO memory_v3_actions(
      action_id,workspace_id,claim_id,target_version,action_type,action_family,source_actor,reason_code,
      predecessor_action_id,action_sha256,created_at_ms,created_stream_sequence,purge_intent_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      actionId, input.workspaceId, input.claimId, input.targetVersion, input.actionType, family,
      input.sourceActor, input.reasonCode, predecessorActionId, recordSha256, createdAtMs, event.streamSequence,
      input.purgeIntentId,
    );
    onFault?.("after-memory-v3-action-write");
    this.connection.prepare(`INSERT INTO memory_v3_action_heads(claim_id,action_family,action_id,last_stream_sequence)
      VALUES(?,?,?,?) ON CONFLICT(claim_id,action_family) DO UPDATE SET
      action_id=excluded.action_id,last_stream_sequence=excluded.last_stream_sequence`)
      .run(input.claimId, family, actionId, event.streamSequence);
    onFault?.("after-memory-v3-action-head-write");
    const projection = this.actionProjection(head, input.actionType, event.streamSequence);
    this.connection.prepare(`UPDATE memory_v3_claim_heads SET proposal_state=?,visibility=?,purge_state=?,
      endorsed=?,last_stream_sequence=? WHERE claim_id=?`).run(
      projection.proposalState, projection.visibility, projection.purgeState,
      projection.endorsed ? 1 : 0, projection.lastStreamSequence, input.claimId,
    );
    onFault?.("after-memory-v3-projection-write");
    if (purgeIntent) {
      const receiptId = idFromSha256("MPRCP", sha256Hex(`${purgeIntent.intentId}\0${actionId}`));
      const receiptBase = {
        receiptId, intentId: purgeIntent.intentId,
        actionId, result: "PURGED_LOCAL_KEY", limitationContractSha256: memoryV3PurgeLimitationSha256,
        createdAtMs,
      } as const;
      const receiptSha256 = purgeReceiptSha256(receiptBase);
      this.connection.prepare(`INSERT INTO memory_v3_purge_receipts(
        receipt_id,intent_id,action_id,result,limitation_contract_sha256,receipt_sha256,created_at_ms
      ) VALUES(?,?,?,?,?,?,?)`).run(
        receiptId, purgeIntent.intentId, actionId, "PURGED_LOCAL_KEY", memoryV3PurgeLimitationSha256,
        receiptSha256, createdAtMs,
      );
    }
    this.finishWorkspaceCommand(event, commandId, idempotencyKeySha256, commandSha256, createdAtMs, onFault);
    const row = this.connection.prepare("SELECT * FROM memory_v3_actions WHERE action_id=?")
      .get(actionId) as Record<string, unknown> | undefined;
    const updated = this.claimHead(input.claimId);
    if (!row || !updated) throw new AuthorityIntegrityError("Memory v3 stored action cannot be read back");
    return { reused: false, commandId, event, action: decodeAction(row), head: updated };
  }

  claimHead(claimId: string): MemoryV3ClaimHeadRecord | null {
    const row = this.connection.prepare("SELECT * FROM memory_v3_claim_heads WHERE claim_id=?")
      .get(claimId) as Record<string, unknown> | undefined;
    return row ? decodeHead(row) : null;
  }

  claim(claimId: string, version?: number): MemoryV3ClaimRecord | null {
    const row = version === undefined
      ? this.connection.prepare(`SELECT v.* FROM memory_v3_claim_heads h JOIN memory_v3_claim_versions v
          ON v.claim_id=h.claim_id AND v.version=h.version WHERE h.claim_id=?`).get(claimId)
      : this.connection.prepare("SELECT * FROM memory_v3_claim_versions WHERE claim_id=? AND version=?").get(claimId, version);
    if (!row) return null;
    const value = row as Record<string, unknown>;
    const terms = this.terms(stringValue(value, "claim_id"), integerValue(value, "version"));
    const record: MemoryV3ClaimRecord = {
      claimId: stringValue(value, "claim_id"), version: integerValue(value, "version"),
      workspaceId: stringValue(value, "workspace_id"), sourceGoalId: nullableString(value, "source_goal_id"),
      scope: stringValue(value, "scope") as MemoryScope, scopeGoalId: nullableString(value, "scope_goal_id"),
      channel: stringValue(value, "channel") as MemoryChannel,
      status: stringValue(value, "status") as MemoryV3InitialStatus,
      classification: stringValue(value, "classification") as MemoryClassification,
      payloadType: stringValue(value, "payload_type") as MemoryV3PayloadType,
      policyOperator: nullableString(value, "policy_operator") as MemoryV3ClaimRecord["policyOperator"],
      semanticKeySha256: nullableString(value, "semantic_key_sha256"), valueSha256: nullableString(value, "value_sha256"),
      bodySha256: stringValue(value, "body_sha256"), sourceLocatorSha256: stringValue(value, "source_locator_sha256"),
      sourceContentSha256: stringValue(value, "source_content_sha256"),
      authorityMetadataSha256: stringValue(value, "authority_metadata_sha256"),
      vaultRefSha256: stringValue(value, "vault_ref_sha256"), keyRefSha256: stringValue(value, "key_ref_sha256"),
      ciphertextSha256: stringValue(value, "ciphertext_sha256"), wrappedKeySha256: stringValue(value, "wrapped_key_sha256"),
      validFromMs: integerValue(value, "valid_from_ms"),
      expiresAtMs: value.expires_at_ms === null ? null : integerValue(value, "expires_at_ms"),
      supersedesVersion: value.supersedes_version === null ? null : integerValue(value, "supersedes_version"),
      claimSha256: stringValue(value, "claim_sha256"),
      createdStreamSequence: integerValue(value, "created_stream_sequence"),
    };
    const draft: MemoryV3ClaimDraft = { ...record, terms };
    const expectedMetadata = canonicalJsonSha256(memoryV3AuthorityMetadata(draft));
    if (expectedMetadata !== record.authorityMetadataSha256 || claimSha256(record) !== record.claimSha256) {
      throw new AuthorityIntegrityError(`Memory v3 claim ${record.claimId} v${record.version} failed hash verification`);
    }
    return record;
  }

  claimVersions(claimId: string): MemoryV3ClaimRecord[] {
    const rows = this.connection.prepare("SELECT version FROM memory_v3_claim_versions WHERE claim_id=? ORDER BY version")
      .all(claimId) as Array<{ version?: unknown }>;
    return rows.map((row) => {
      const value = this.claim(claimId, Number(row.version));
      if (!value) throw new AuthorityIntegrityError("Memory v3 claim version disappeared during read");
      return value;
    });
  }

  candidateHeads(workspaceId: string, goalId: string | null, limit: number): MemoryV3ClaimHeadRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Memory v3 candidate limit is invalid");
    const rows = this.connection.prepare(`SELECT * FROM memory_v3_claim_heads WHERE workspace_id=?
      AND (scope='WORKSPACE' OR (scope='GOAL' AND scope_goal_id=?))
      ORDER BY last_stream_sequence DESC LIMIT ?`).all(workspaceId, goalId, limit) as Record<string, unknown>[];
    return rows.map(decodeHead);
  }

  matchingHeads(
    workspaceId: string,
    goalId: string | null,
    channel: MemoryChannel,
    termHmacs: readonly string[],
    includeUnmatched: boolean,
    limit: number,
  ): MemoryV3CandidateHeadMatch[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Memory v3 candidate limit is invalid");
    }
    const terms = [...new Set(termHmacs)];
    if (terms.length > 256 || terms.some((term) => !shaPattern.test(term))) {
      throw new TypeError("Memory v3 query terms are invalid");
    }
    const rows: Record<string, unknown>[] = [];
    if (terms.length > 0) {
      const placeholders = terms.map(() => "?").join(",");
      rows.push(...this.connection.prepare(`SELECT h.*,count(DISTINCT t.term_hmac) AS matched_terms
        FROM memory_v3_terms t INDEXED BY ix_memory_v3_terms_lookup
        JOIN memory_v3_claim_heads h ON h.claim_id=t.claim_id AND h.version=t.version
        WHERE t.workspace_id=? AND t.term_hmac IN (${placeholders}) AND h.channel=?
          AND (h.scope='WORKSPACE' OR (h.scope='GOAL' AND h.scope_goal_id=?))
          AND h.proposal_state='ACTIVE' AND h.visibility='VISIBLE' AND h.purge_state='PRESENT'
        GROUP BY h.claim_id
        ORDER BY CASE h.scope WHEN 'GOAL' THEN 0 ELSE 1 END,
          matched_terms DESC,h.endorsed DESC,h.last_stream_sequence DESC,h.claim_id
        LIMIT ?`).all(workspaceId, ...terms, channel, goalId, limit) as Record<string, unknown>[]);
    }
    if (includeUnmatched && rows.length < limit) {
      const scoped = (scope: MemoryScope, scopeGoalId: string | null): Record<string, unknown>[] =>
        this.connection.prepare(`SELECT h.*,0 AS matched_terms FROM memory_v3_claim_heads h INDEXED BY ix_memory_v3_heads_active
          WHERE h.workspace_id=? AND h.scope=? AND h.scope_goal_id IS ? AND h.channel=?
            AND h.proposal_state='ACTIVE' AND h.visibility='VISIBLE' AND h.purge_state='PRESENT'
          ORDER BY h.last_stream_sequence DESC,h.claim_id LIMIT ?`)
          .all(workspaceId, scope, scopeGoalId, channel, limit) as Record<string, unknown>[];
      if (goalId !== null) rows.push(...scoped("GOAL", goalId));
      rows.push(...scoped("WORKSPACE", null));
    }
    const unique = new Map<string, MemoryV3CandidateHeadMatch>();
    for (const row of rows) {
      const head = decodeHead(row);
      const matchedTerms = integerValue(row, "matched_terms");
      const prior = unique.get(head.claimId);
      if (!prior || matchedTerms > prior.matchedTerms) unique.set(head.claimId, { head, matchedTerms });
    }
    return [...unique.values()].sort((left, right) => {
      if (left.head.scope !== right.head.scope) return left.head.scope === "GOAL" ? -1 : 1;
      if (right.matchedTerms !== left.matchedTerms) return right.matchedTerms - left.matchedTerms;
      if (right.head.endorsed !== left.head.endorsed) return Number(right.head.endorsed) - Number(left.head.endorsed);
      if (right.head.lastStreamSequence !== left.head.lastStreamSequence) {
        return right.head.lastStreamSequence - left.head.lastStreamSequence;
      }
      return left.head.claimId.localeCompare(right.head.claimId);
    }).slice(0, limit);
  }

  semanticPolicyHeads(
    workspaceId: string,
    goalId: string | null,
    scope: MemoryScope,
    semanticTermHmac: string,
    limit: number,
  ): { readonly matches: readonly MemoryV3ClaimHeadRecord[]; readonly total: number } {
    if (!shaPattern.test(semanticTermHmac)) throw new TypeError("Memory v3 semantic term is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("Memory v3 semantic candidate limit is invalid");
    }
    const rows = this.connection.prepare(`SELECT h.*,count(*) OVER() AS total_matches
      FROM memory_v3_terms t JOIN memory_v3_claim_heads h
        ON h.claim_id=t.claim_id AND h.version=t.version
      WHERE t.workspace_id=? AND t.term_kind='SEMANTIC_KEY' AND t.term_hmac=?
        AND h.channel='POLICY' AND h.scope=?
        AND (h.scope='WORKSPACE' OR (h.scope='GOAL' AND h.scope_goal_id=?))
        AND h.proposal_state='ACTIVE' AND h.visibility='VISIBLE' AND h.purge_state='PRESENT'
      ORDER BY CASE h.scope WHEN 'GOAL' THEN 0 ELSE 1 END,
        h.endorsed DESC,h.last_stream_sequence DESC,h.claim_id
      LIMIT ?`).all(workspaceId, semanticTermHmac, scope, goalId, limit) as Record<string, unknown>[];
    return {
      matches: rows.map(decodeHead),
      total: rows.length === 0 ? 0 : integerValue(rows[0]!, "total_matches"),
    };
  }

  workspaceHeads(workspaceId: string, beforeStreamSequence: number | null, limit: number): MemoryV3ClaimHeadRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Memory v3 workspace head limit is invalid");
    }
    if (beforeStreamSequence !== null && (!Number.isSafeInteger(beforeStreamSequence) || beforeStreamSequence < 1)) {
      throw new RangeError("Memory v3 workspace head cursor is invalid");
    }
    const rows = beforeStreamSequence === null
      ? this.connection.prepare(`SELECT * FROM memory_v3_claim_heads WHERE workspace_id=?
          ORDER BY last_stream_sequence DESC,claim_id LIMIT ?`).all(workspaceId, limit)
      : this.connection.prepare(`SELECT * FROM memory_v3_claim_heads WHERE workspace_id=? AND last_stream_sequence<?
          ORDER BY last_stream_sequence DESC,claim_id LIMIT ?`).all(workspaceId, beforeStreamSequence, limit);
    return (rows as Record<string, unknown>[]).map(decodeHead);
  }

  workspaceStatus(workspaceId: string): MemoryV3WorkspaceStatus {
    const row = this.connection.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN proposal_state='ACTIVE' AND visibility='VISIBLE' AND purge_state='PRESENT' THEN 1 ELSE 0 END),0) AS active,
      coalesce(sum(CASE WHEN proposal_state='PROPOSED' THEN 1 ELSE 0 END),0) AS proposed,
      coalesce(sum(CASE WHEN proposal_state='REJECTED' THEN 1 ELSE 0 END),0) AS rejected,
      coalesce(sum(CASE WHEN visibility='FORGOTTEN' THEN 1 ELSE 0 END),0) AS forgotten,
      coalesce(sum(CASE WHEN purge_state='PURGED_LOCAL_KEY' THEN 1 ELSE 0 END),0) AS purged,
      coalesce(sum(CASE WHEN purge_state='INTEGRITY_FAILED' THEN 1 ELSE 0 END),0) AS integrity_failed,
      coalesce(sum(CASE WHEN endorsed=1 THEN 1 ELSE 0 END),0) AS endorsed
      FROM memory_v3_claim_heads WHERE workspace_id=?`).get(workspaceId) as Record<string, unknown>;
    return {
      total: integerValue(row, "total"), active: integerValue(row, "active"),
      proposed: integerValue(row, "proposed"), rejected: integerValue(row, "rejected"),
      forgotten: integerValue(row, "forgotten"), purged: integerValue(row, "purged"),
      integrityFailed: integerValue(row, "integrity_failed"), endorsed: integerValue(row, "endorsed"),
    };
  }

  vaultReferences(workspaceId: string): {
    readonly vaultRefSha256: ReadonlySet<string>;
    readonly keyRefSha256: ReadonlySet<string>;
  } {
    const rows = this.connection.prepare(`SELECT v.vault_ref_sha256,v.key_ref_sha256,h.purge_state
      FROM memory_v3_claim_versions v JOIN memory_v3_claim_heads h ON h.claim_id=v.claim_id
      WHERE v.workspace_id=?`).all(workspaceId) as Record<string, unknown>[];
    const vaultRefs = new Set<string>();
    const keyRefs = new Set<string>();
    for (const row of rows) {
      vaultRefs.add(stringValue(row, "vault_ref_sha256"));
      if (stringValue(row, "purge_state") === "PRESENT") keyRefs.add(stringValue(row, "key_ref_sha256"));
    }
    return { vaultRefSha256: vaultRefs, keyRefSha256: keyRefs };
  }

  event(eventId: string): MemoryV3CaptureEvent | null {
    const row = this.connection.prepare("SELECT * FROM memory_v3_events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    return row ? decodeEvent(row) : null;
  }

  events(workspaceId: string, limit = 100): MemoryV3CaptureEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Memory v3 event limit is invalid");
    const rows = this.connection.prepare(`SELECT * FROM memory_v3_events WHERE workspace_id=?
      ORDER BY stream_sequence DESC LIMIT ?`).all(workspaceId, limit) as Record<string, unknown>[];
    return rows.reverse().map(decodeEvent);
  }

  streamHead(workspaceId: string): { readonly streamSequence: number; readonly lastEventSha256: string } | null {
    const row = this.connection.prepare(`SELECT stream_sequence,last_event_sha256 FROM memory_v3_workspace_stream_heads
      WHERE workspace_id=?`).get(workspaceId) as Record<string, unknown> | undefined;
    return row ? { streamSequence: integerValue(row, "stream_sequence"), lastEventSha256: stringValue(row, "last_event_sha256") } : null;
  }

  private terms(claimId: string, version: number): MemoryV3TermInput[] {
    const rows = this.connection.prepare(`SELECT term_kind,term_hmac FROM memory_v3_terms
      WHERE claim_id=? AND version=? ORDER BY term_kind,term_hmac`).all(claimId, version) as Record<string, unknown>[];
    return validateTerms(rows.map((row) => ({
      kind: stringValue(row, "term_kind") as MemoryV3TermKind, hmac: stringValue(row, "term_hmac"),
    })));
  }

  private existingCommand(
    commandId: string,
    workspaceId: string,
    idempotencyKeySha256: string,
    commandSha256: string,
  ): { readonly resultEventId: string } | null {
    const row = this.connection.prepare(`SELECT command_id,command_sha256,result_event_id FROM memory_v3_commands
      WHERE workspace_id=? AND idempotency_key_sha256=?`).get(workspaceId, idempotencyKeySha256) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (stringValue(row, "command_id") !== commandId || stringValue(row, "command_sha256") !== commandSha256) {
      throw new AuthorityIntegrityError("Memory v3 idempotency key was reused for different content");
    }
    return { resultEventId: stringValue(row, "result_event_id") };
  }

  private requiredEvent(eventId: string): MemoryV3CaptureEvent {
    const value = this.event(eventId);
    if (!value) throw new AuthorityIntegrityError("Memory v3 command references a missing event");
    return value;
  }

  private insertWorkspaceEvent(
    input: Omit<MemoryV3CaptureEvent,
      "eventId" | "streamSequence" | "previousEventSha256" | "eventSha256" | "createdAtMs">,
    commandId: string,
    commandSha256: string,
    createdAtMs: number,
  ): MemoryV3CaptureEvent {
    const head = this.connection.prepare(`SELECT stream_sequence,last_event_sha256 FROM memory_v3_workspace_stream_heads
      WHERE workspace_id=?`).get(input.workspaceId) as Record<string, unknown> | undefined;
    const streamSequence = head ? integerValue(head, "stream_sequence") + 1 : 1;
    const previousEventSha256 = head ? stringValue(head, "last_event_sha256") : zeroSha256;
    const eventId = idFromSha256("MEVT", sha256Hex(`${input.workspaceId}\0${streamSequence}\0${commandId}\0${commandSha256}`));
    const base: Omit<MemoryV3CaptureEvent, "eventSha256"> = {
      ...input, eventId, streamSequence, previousEventSha256, createdAtMs,
    };
    const event = { ...base, eventSha256: computeMemoryV3EventSha256(base) };
    this.connection.prepare(`INSERT INTO memory_v3_events(
      event_id,workspace_id,stream_sequence,event_type,source_kind,source_actor,decision_actor,route,disposition,
      reason_codes_json,candidate_sha256,source_locator_sha256,source_content_sha256,goal_id,claim_id,claim_version,
      channel,scope,classification,semantic_key_sha256,value_sha256,body_sha256,vault_ref_sha256,record_sha256,
      previous_event_sha256,event_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventId, event.workspaceId, event.streamSequence, event.eventType, event.sourceKind,
        event.sourceActor, event.decisionActor, event.route, event.disposition, canonicalJson(event.reasonCodes),
        event.candidateSha256, event.sourceLocatorSha256, event.sourceContentSha256, event.goalId,
        event.claimId, event.claimVersion, event.channel, event.scope, event.classification,
        event.semanticKeySha256, event.valueSha256, event.bodySha256, event.vaultRefSha256,
        event.recordSha256, event.previousEventSha256, event.eventSha256, event.createdAtMs);
    return event;
  }

  private finishWorkspaceCommand(
    event: MemoryV3CaptureEvent,
    commandId: string,
    idempotencyKeySha256: string,
    commandSha256: string,
    createdAtMs: number,
    onFault?: (point: MemoryV3MutationFaultPoint) => void,
  ): void {
    this.connection.prepare(`INSERT INTO memory_v3_workspace_stream_heads(workspace_id,stream_sequence,last_event_sha256,updated_at_ms)
      VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET stream_sequence=excluded.stream_sequence,
      last_event_sha256=excluded.last_event_sha256,updated_at_ms=excluded.updated_at_ms`)
      .run(event.workspaceId, event.streamSequence, event.eventSha256, createdAtMs);
    onFault?.("after-memory-v3-head-write");
    this.connection.prepare(`INSERT INTO memory_v3_commands(
      command_id,workspace_id,idempotency_key_sha256,command_sha256,result_event_id,created_at_ms) VALUES(?,?,?,?,?,?)`)
      .run(commandId, event.workspaceId, idempotencyKeySha256, commandSha256, event.eventId, createdAtMs);
    onFault?.("after-memory-v3-command-write");
  }

  private validateClaimInput(input: MemoryV3StoreClaimInput, idempotencyKey: string, createdAtMs: number): void {
    if (!this.available()) throw new AuthorityIntegrityError("Memory v3 authority migration is not available");
    if (!idempotencyKey || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0
      || !input.claimId || !input.workspaceId || !Number.isSafeInteger(input.version) || input.version < 1
      || !Number.isSafeInteger(input.validFromMs) || input.validFromMs < 0
      || (input.expiresAtMs !== null && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.validFromMs))) {
      throw new TypeError("Memory v3 claim command metadata is invalid");
    }
    if ((input.scope === "GOAL") !== (input.scopeGoalId !== null)
      || !["POLICY", "EVIDENCE", "EXPERIENCE"].includes(input.channel)
      || !["PUBLIC", "INTERNAL"].includes(input.classification)
      || !["PROPOSED", "ACTIVE"].includes(input.status)) {
      throw new TypeError("Memory v3 claim scope or classification is invalid");
    }
    for (const [name, value] of Object.entries({
      candidate_sha256: input.candidateSha256, body_sha256: input.bodySha256,
      source_locator_sha256: input.sourceLocatorSha256, source_content_sha256: input.sourceContentSha256,
      authority_metadata_sha256: input.authorityMetadataSha256, vault_ref_sha256: input.vaultRefSha256,
      key_ref_sha256: input.keyRefSha256, ciphertext_sha256: input.ciphertextSha256,
      wrapped_key_sha256: input.wrappedKeySha256,
      ...(input.semanticKeySha256 === null ? {} : { semantic_key_sha256: input.semanticKeySha256 }),
      ...(input.valueSha256 === null ? {} : { value_sha256: input.valueSha256 }),
    })) if (!shaPattern.test(value)) throw new TypeError(`Memory v3 ${name} is invalid`);
    if (input.payloadType === "TYPED_POLICY") {
      if (!input.policyOperator || !input.semanticKeySha256 || !input.valueSha256) {
        throw new TypeError("Memory v3 typed Policy requires structured semantics");
      }
    } else if (input.policyOperator !== null || input.semanticKeySha256 !== null || input.valueSha256 !== null) {
      throw new TypeError("Memory v3 non-Policy claim contains Policy semantics");
    }
    reasons(canonicalJson(input.reasonCodes));
    const metadata = canonicalJsonSha256(memoryV3AuthorityMetadata(input));
    if (metadata !== input.authorityMetadataSha256) {
      throw new AuthorityIntegrityError("Memory v3 authority metadata hash is invalid");
    }
  }

  private validateActionTransition(head: MemoryV3ClaimHeadRecord, action: MemoryV3ActionType): void {
    const valid = action === "APPROVE" ? head.proposalState === "PROPOSED" && head.purgeState === "PRESENT"
      : action === "REJECT" ? head.proposalState === "PROPOSED"
        : action === "ENDORSE" ? head.proposalState === "ACTIVE" && !head.endorsed && head.purgeState === "PRESENT"
          : action === "REVOKE_ENDORSEMENT" ? head.endorsed
            : action === "FORGET" ? head.proposalState === "ACTIVE" && head.visibility === "VISIBLE" && head.purgeState === "PRESENT"
              : action === "RESTORE" ? head.proposalState === "ACTIVE" && head.visibility === "FORGOTTEN" && head.purgeState === "PRESENT"
                : head.purgeState === "PRESENT";
    if (!valid) throw new AuthorityIntegrityError(`Memory v3 action ${action} is not valid for the current claim state`);
  }

  private actionProjection(
    head: MemoryV3ClaimHeadRecord,
    action: MemoryV3ActionType,
    lastStreamSequence: number,
  ): MemoryV3ClaimHeadRecord {
    return {
      ...head, lastStreamSequence,
      proposalState: action === "APPROVE" ? "ACTIVE" : action === "REJECT" ? "REJECTED" : head.proposalState,
      visibility: action === "FORGET" ? "FORGOTTEN" : action === "RESTORE" ? "VISIBLE" : head.visibility,
      purgeState: action === "PURGE_LOCAL_KEY" ? "PURGED_LOCAL_KEY" : head.purgeState,
      endorsed: action === "ENDORSE" ? true : action === "REVOKE_ENDORSEMENT" ? false : head.endorsed,
    };
  }

  verifyIntegrity(): void {
    if (!this.available()) return;
    const orphanWorkspaceEvents = this.connection.prepare(`SELECT count(*) AS count FROM memory_v3_events e
      LEFT JOIN memory_v3_workspace_stream_heads h ON h.workspace_id=e.workspace_id
      WHERE h.workspace_id IS NULL`).get() as { count?: unknown } | undefined;
    if (Number(orphanWorkspaceEvents?.count ?? 0) !== 0) {
      throw new AuthorityIntegrityError("Memory v3 contains events without a workspace stream head");
    }
    const workspaces = this.connection.prepare("SELECT workspace_id,stream_sequence,last_event_sha256 FROM memory_v3_workspace_stream_heads")
      .all() as Record<string, unknown>[];
    for (const head of workspaces) {
      const workspaceId = stringValue(head, "workspace_id");
      const expectedSequence = integerValue(head, "stream_sequence");
      const expectedHash = stringValue(head, "last_event_sha256");
      const rows = this.connection.prepare("SELECT * FROM memory_v3_events WHERE workspace_id=? ORDER BY stream_sequence")
        .all(workspaceId) as Record<string, unknown>[];
      let previous = zeroSha256;
      let sequence = 0;
      for (const row of rows) {
        const event = decodeEvent(row);
        sequence += 1;
        if (event.streamSequence !== sequence || event.previousEventSha256 !== previous) {
          throw new AuthorityIntegrityError(`Memory v3 workspace stream ${workspaceId} is discontinuous`);
        }
        previous = event.eventSha256;
      }
      if (sequence !== expectedSequence || previous !== expectedHash) {
        throw new AuthorityIntegrityError(`Memory v3 workspace stream ${workspaceId} head is invalid`);
      }
    }

    const claimRows = this.connection.prepare("SELECT claim_id,version,workspace_id,created_stream_sequence,claim_sha256 FROM memory_v3_claim_versions")
      .all() as Record<string, unknown>[];
    for (const row of claimRows) {
      const claimId = stringValue(row, "claim_id");
      const version = integerValue(row, "version");
      const claim = this.claim(claimId, version);
      if (!claim) throw new AuthorityIntegrityError(`Memory v3 claim ${claimId} v${version} is missing`);
      const eventRow = this.connection.prepare("SELECT * FROM memory_v3_events WHERE workspace_id=? AND stream_sequence=?")
        .get(stringValue(row, "workspace_id"), integerValue(row, "created_stream_sequence")) as Record<string, unknown> | undefined;
      if (!eventRow) throw new AuthorityIntegrityError(`Memory v3 claim ${claimId} has no creation event`);
      const event = decodeEvent(eventRow);
      if (event.eventType !== "CLAIM_STORED" || event.claimId !== claimId || event.claimVersion !== version
        || event.recordSha256 !== claim.claimSha256) {
        throw new AuthorityIntegrityError(`Memory v3 claim ${claimId} is not bound to its creation event`);
      }
    }

    const actionRows = this.connection.prepare("SELECT * FROM memory_v3_actions ORDER BY workspace_id,created_stream_sequence")
      .all() as Record<string, unknown>[];
    for (const row of actionRows) {
      const action = decodeAction(row);
      const eventRow = this.connection.prepare("SELECT * FROM memory_v3_events WHERE workspace_id=? AND stream_sequence=?")
        .get(action.workspaceId, action.createdStreamSequence) as Record<string, unknown> | undefined;
      if (!eventRow || decodeEvent(eventRow).recordSha256 !== action.actionSha256) {
        throw new AuthorityIntegrityError(`Memory v3 action ${action.actionId} is not bound to its event`);
      }
    }

    const purgeIntents = this.connection.prepare("SELECT * FROM memory_v3_purge_intents").all() as Record<string, unknown>[];
    for (const row of purgeIntents) {
      const intent = decodePurgeIntent(row);
      const versions = this.claimVersions(intent.claimId);
      const manifest = canonicalJsonSha256(versions.map((version) => ({
        claimId: version.claimId, version: version.version, claimSha256: version.claimSha256,
        keyRefSha256: version.keyRefSha256, wrappedKeySha256: version.wrappedKeySha256,
      })));
      if (manifest !== intent.versionManifestSha256 || versions.at(-1)?.version !== intent.targetVersion) {
        throw new AuthorityIntegrityError(`Memory v3 purge intent ${intent.intentId} has an invalid version manifest`);
      }
    }
    const purgeReceipts = this.connection.prepare("SELECT * FROM memory_v3_purge_receipts").all() as Record<string, unknown>[];
    for (const row of purgeReceipts) {
      const receipt = {
        receiptId: stringValue(row, "receipt_id"), intentId: stringValue(row, "intent_id"),
        actionId: stringValue(row, "action_id"), result: stringValue(row, "result") as "PURGED_LOCAL_KEY",
        limitationContractSha256: stringValue(row, "limitation_contract_sha256"),
        createdAtMs: integerValue(row, "created_at_ms"),
      };
      const receiptSha256 = stringValue(row, "receipt_sha256");
      const action = actionRows.map(decodeAction).find((value) => value.actionId === receipt.actionId);
      if (receipt.result !== "PURGED_LOCAL_KEY" || receipt.limitationContractSha256 !== memoryV3PurgeLimitationSha256
        || purgeReceiptSha256(receipt) !== receiptSha256 || action?.purgeIntentId !== receipt.intentId) {
        throw new AuthorityIntegrityError(`Memory v3 purge receipt ${receipt.receiptId} failed verification`);
      }
    }

    const heads = this.connection.prepare("SELECT * FROM memory_v3_claim_heads").all() as Record<string, unknown>[];
    for (const row of heads) {
      const actual = decodeHead(row);
      const events = this.connection.prepare(`SELECT * FROM memory_v3_events WHERE workspace_id=? AND claim_id=?
        ORDER BY stream_sequence`).all(actual.workspaceId, actual.claimId) as Record<string, unknown>[];
      let rebuilt: MemoryV3ClaimHeadRecord | null = null;
      for (const eventRow of events) {
        const event = decodeEvent(eventRow);
        if (event.eventType === "CLAIM_STORED") {
          if (event.claimVersion === null) throw new AuthorityIntegrityError("Memory v3 claim event has no version");
          const claim = this.claim(actual.claimId, event.claimVersion);
          if (!claim) throw new AuthorityIntegrityError("Memory v3 claim head references a missing version");
          rebuilt = {
            claimId: claim.claimId, version: claim.version, workspaceId: claim.workspaceId,
            scope: claim.scope, scopeGoalId: claim.scopeGoalId, channel: claim.channel,
            proposalState: claim.status, visibility: "VISIBLE", purgeState: "PRESENT", endorsed: false,
            claimSha256: claim.claimSha256, lastStreamSequence: event.streamSequence,
          };
        } else if (event.recordSha256 && rebuilt) {
          const actionRow = this.connection.prepare("SELECT * FROM memory_v3_actions WHERE action_sha256=?")
            .get(event.recordSha256) as Record<string, unknown> | undefined;
          if (actionRow) rebuilt = this.actionProjection(rebuilt, decodeAction(actionRow).actionType, event.streamSequence);
        }
      }
      if (!rebuilt || canonicalJsonSha256(rebuilt) !== canonicalJsonSha256(actual)) {
        throw new AuthorityIntegrityError(`Memory v3 claim head ${actual.claimId} is not rebuildable`);
      }
      const receiptCount = Number((this.connection.prepare(`SELECT count(*) AS count FROM memory_v3_purge_receipts r
        JOIN memory_v3_purge_intents i ON i.intent_id=r.intent_id WHERE i.claim_id=?`).get(actual.claimId) as { count?: unknown } | undefined)?.count ?? 0);
      if ((actual.purgeState === "PURGED_LOCAL_KEY") !== (receiptCount === 1)) {
        throw new AuthorityIntegrityError(`Memory v3 purge projection ${actual.claimId} is not receipt-backed`);
      }
      for (const family of ["PROPOSAL", "ENDORSEMENT", "VISIBILITY", "PURGE"] as const) {
        const expected = [...actionRows].reverse().map(decodeAction)
          .find((action) => action.claimId === actual.claimId && action.actionFamily === family);
        const actionHead = this.connection.prepare(`SELECT action_id,last_stream_sequence FROM memory_v3_action_heads
          WHERE claim_id=? AND action_family=?`).get(actual.claimId, family) as Record<string, unknown> | undefined;
        if ((expected === undefined) !== (actionHead === undefined)
          || (expected && actionHead && (stringValue(actionHead, "action_id") !== expected.actionId
            || integerValue(actionHead, "last_stream_sequence") !== expected.createdStreamSequence))) {
          throw new AuthorityIntegrityError(`Memory v3 action head ${actual.claimId}/${family} is not rebuildable`);
        }
      }
    }
  }
}
