import type {
  EffectiveMemoryClaim, MemoryCandidateRank, MemoryClaimActionInput, MemoryClaimActionRecord,
  MemoryClaimVersionInput, MemoryClaimVersionRecord, MemoryIndexDrainResult, MemoryReceiptAttestationSource,
  MemoryRecallObservation,
} from "../../memory/types.js";
import { computeMemoryActionSha256, verifyMemoryClaimRecord } from "../../memory/admission.js";
import { memoryCjkProjection } from "../../memory/cjk.js";
import { AuthorityIntegrityError, AuthorityNotFoundError } from "../../foundation/errors.js";
import { sha256Hex } from "../../foundation/crypto.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { canonicalJson, canonicalJsonSha256, parseCanonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { computeEventSha256 } from "../event-chain.js";
import { assertEvidenceAttestation, type EvidenceAttestationRecord } from "../../task-flow/domain.js";

function text(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Memory field ${field} must be text`);
  return value;
}

function nullableText(row: Record<string, unknown>, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}

function integer(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AuthorityIntegrityError(`Memory field ${field} must be an integer`);
  }
  return value;
}

function stringArray(row: Record<string, unknown>, field: string): string[] {
  const value = parseCanonicalJson(text(row, field));
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AuthorityIntegrityError(`Memory field ${field} must be a canonical string array`);
  }
  return value as string[];
}

function objectValue(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = parseCanonicalJson(text(row, field));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityIntegrityError(`Memory field ${field} must be a canonical object`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function decodeClaim(row: Record<string, unknown>, verifyHashes = true): MemoryClaimVersionRecord {
  const record: MemoryClaimVersionRecord = {
    claimId: text(row, "claim_id"),
    version: integer(row, "version"),
    workspaceId: text(row, "workspace_id"),
    actorGoalId: text(row, "actor_goal_id"),
    scope: text(row, "scope") as MemoryClaimVersionRecord["scope"],
    scopeGoalId: nullableText(row, "scope_goal_id"),
    channel: text(row, "channel") as MemoryClaimVersionRecord["channel"],
    status: text(row, "status") as MemoryClaimVersionRecord["status"],
    payload: objectValue(row, "payload_json") as unknown as MemoryClaimVersionRecord["payload"],
    payloadSha256: text(row, "payload_sha256"),
    sourceAttestation: objectValue(row, "source_attestation_json") as unknown as MemoryClaimVersionRecord["sourceAttestation"],
    tags: stringArray(row, "tags_json"),
    pathKey: nullableText(row, "path_key"),
    dependencyKeys: stringArray(row, "dependency_keys_json"),
    classification: text(row, "classification") as MemoryClaimVersionRecord["classification"],
    validFromMs: integer(row, "valid_from_ms"),
    expiresAtMs: row.expires_at_ms === null ? null : integer(row, "expires_at_ms"),
    supersedesVersion: row.supersedes_version === null ? null : integer(row, "supersedes_version"),
    contentText: text(row, "content_text"),
    contentSha256: text(row, "content_sha256"),
    contentTokenEstimate: integer(row, "content_token_estimate"),
    claimSha256: text(row, "claim_sha256"),
    createdEventSequence: integer(row, "created_event_sequence"),
  };
  if (verifyHashes) {
    try {
      verifyMemoryClaimRecord(record);
    } catch (error) {
      throw new AuthorityIntegrityError(`Memory claim hash mismatch at ${record.claimId} v${record.version}`, error);
    }
  }
  return record;
}

function decodeAction(row: Record<string, unknown>): MemoryClaimActionRecord {
  const action: MemoryClaimActionRecord = {
    actionId: text(row, "action_id"),
    claimId: text(row, "claim_id"),
    targetVersion: integer(row, "target_version"),
    workspaceId: text(row, "workspace_id"),
    actorGoalId: text(row, "actor_goal_id"),
    actionType: text(row, "action_type") as MemoryClaimActionRecord["actionType"],
    actionFamily: text(row, "action_family") as MemoryClaimActionRecord["actionFamily"],
    reason: text(row, "reason"),
    predecessorActionId: nullableText(row, "predecessor_action_id"),
    actionSha256: text(row, "action_sha256"),
    createdAtMs: integer(row, "created_at_ms"),
    createdEventSequence: integer(row, "created_event_sequence"),
  };
  const { createdEventSequence, actionSha256, ...base } = action;
  void createdEventSequence;
  if (actionSha256 !== computeMemoryActionSha256(base)) {
    throw new AuthorityIntegrityError(`Memory action hash mismatch at ${action.actionId}`);
  }
  return action;
}

const claimColumns = `mv.claim_id AS claim_id,mv.version AS version,mv.workspace_id AS workspace_id,
  mv.actor_goal_id AS actor_goal_id,mv.scope AS scope,mv.scope_goal_id AS scope_goal_id,
  mv.channel AS channel,mv.status AS status,mv.payload_json AS payload_json,mv.payload_sha256 AS payload_sha256,
  mv.source_attestation_json AS source_attestation_json,mv.source_attestation_sha256 AS source_attestation_sha256,
  mv.tags_json AS tags_json,mv.path_key AS path_key,mv.dependency_keys_json AS dependency_keys_json,
  mv.classification AS classification,mv.valid_from_ms AS valid_from_ms,mv.expires_at_ms AS expires_at_ms,
  mv.supersedes_version AS supersedes_version,mv.content_text AS content_text,
  mv.content_sha256 AS content_sha256,mv.content_token_estimate AS content_token_estimate,
  mv.claim_sha256 AS claim_sha256,mv.created_event_sequence AS created_event_sequence`;

const claimProjection = `SELECT ${claimColumns} FROM memory_claim_versions mv`;

const actionProjection = `SELECT a.action_id AS action_id,a.claim_id AS claim_id,
  a.target_version AS target_version,a.workspace_id AS workspace_id,a.actor_goal_id AS actor_goal_id,
  a.action_type AS action_type,a.action_family AS action_family,a.reason AS reason,
  a.predecessor_action_id AS predecessor_action_id,a.action_sha256 AS action_sha256,
  a.created_at_ms AS created_at_ms,a.created_event_sequence AS created_event_sequence
  FROM memory_claim_actions a`;

function visibleScopeSql(alias: string): string {
  return `(${alias}.scope='WORKSPACE' OR (${alias}.scope='GOAL' AND ${alias}.scope_goal_id=?))`;
}

export class MemoryRepository {
  private readonly verifiedClaimVersions = new Map<string, MemoryClaimVersionRecord>();
  private claimCacheDataVersion: number | null = null;

  constructor(private readonly connection: AuthorityConnection) {}

  private refreshVerifiedClaimCache(): void {
    const row = this.connection.prepare("PRAGMA data_version").get() as Record<string, unknown> | undefined;
    const dataVersion = row ? integer(row, "data_version") : -1;
    if (this.claimCacheDataVersion !== dataVersion) {
      this.verifiedClaimVersions.clear();
      this.claimCacheDataVersion = dataVersion;
    }
  }

  private decodeVerifiedClaim(row: Record<string, unknown>): MemoryClaimVersionRecord {
    const key = `${text(row, "claim_id")}\0${integer(row, "version")}`;
    const claimSha256 = text(row, "claim_sha256");
    const cached = this.verifiedClaimVersions.get(key);
    if (cached?.claimSha256 === claimSha256) return cached;
    const record = deepFreeze(decodeClaim(row));
    if (!cached) {
      this.verifiedClaimVersions.set(key, record);
      if (this.verifiedClaimVersions.size > 1024) {
        const oldest = this.verifiedClaimVersions.keys().next().value;
        if (oldest !== undefined) this.verifiedClaimVersions.delete(oldest);
      }
    } else {
      this.verifiedClaimVersions.set(key, record);
    }
    return record;
  }

  indexMode(): "FTS5" | "TAG_PATH" {
    const row = this.connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_claims_fts'").get() as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === 1 ? "FTS5" : "TAG_PATH";
  }

  insertClaim(
    record: MemoryClaimVersionInput,
    commandGoalId: string,
    eventSequence: number,
    onFault?: (point: "after-memory-claim-write" | "after-memory-claim-head-write" | "after-memory-claim-index-outbox-write") => void,
  ): void {
    if (record.actorGoalId !== commandGoalId) throw new AuthorityIntegrityError("Memory actor Goal substitution");
    const goal = this.connection.prepare("SELECT workspace_id FROM goals WHERE goal_id=?").get(commandGoalId) as { workspace_id?: unknown } | undefined;
    if (!goal || goal.workspace_id !== record.workspaceId) throw new AuthorityIntegrityError("Memory workspace binding failed");
    if ((record.scope === "GOAL" && record.scopeGoalId !== commandGoalId)
      || (record.scope === "WORKSPACE" && record.scopeGoalId !== null)) {
      throw new AuthorityIntegrityError("Memory scope binding failed");
    }
    const current = this.currentRaw(record.claimId);
    const expectedVersion = (current?.version ?? 0) + 1;
    if (record.version !== expectedVersion || record.supersedesVersion !== (current?.version ?? null)) {
      throw new AuthorityIntegrityError("Memory claim predecessor mismatch");
    }
    try { verifyMemoryClaimRecord({ ...record, createdEventSequence: eventSequence }); }
    catch (error) { throw new AuthorityIntegrityError("Memory claim hash verification failed before insert", error); }
    this.connection.prepare(`INSERT INTO memory_claim_versions(
      claim_id,version,workspace_id,actor_goal_id,scope,scope_goal_id,channel,status,payload_json,payload_sha256,
      source_attestation_json,source_attestation_sha256,tags_json,path_key,dependency_keys_json,classification,
      valid_from_ms,expires_at_ms,supersedes_version,content_text,content_sha256,content_token_estimate,
      claim_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.claimId, record.version, record.workspaceId, record.actorGoalId, record.scope, record.scopeGoalId,
      record.channel, record.status, canonicalJson(record.payload), record.payloadSha256,
      canonicalJson(record.sourceAttestation), record.sourceAttestation.attestationSha256, canonicalJson(record.tags),
      record.pathKey, canonicalJson(record.dependencyKeys), record.classification, record.validFromMs,
      record.expiresAtMs, record.supersedesVersion, record.contentText, record.contentSha256,
      record.contentTokenEstimate, record.claimSha256, eventSequence,
    );
    onFault?.("after-memory-claim-write");
    this.connection.prepare(`INSERT INTO memory_claim_heads(
      claim_id,version,workspace_id,scope,scope_goal_id,channel,status,claim_sha256,last_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET
      version=excluded.version,workspace_id=excluded.workspace_id,scope=excluded.scope,
      scope_goal_id=excluded.scope_goal_id,channel=excluded.channel,status=excluded.status,
      claim_sha256=excluded.claim_sha256,last_event_sequence=excluded.last_event_sequence`).run(
      record.claimId, record.version, record.workspaceId, record.scope, record.scopeGoalId,
      record.channel, record.status, record.claimSha256, eventSequence,
    );
    onFault?.("after-memory-claim-head-write");
    const terms = [
      ...record.tags.map((term) => ({ kind: "TAG", term })),
      ...(record.pathKey ? [{ kind: "PATH", term: record.pathKey }] : []),
      ...record.dependencyKeys.map((term) => ({ kind: "DEPENDENCY", term })),
    ];
    const insertTerm = this.connection.prepare("INSERT INTO memory_claim_terms(claim_id,version,workspace_id,term_kind,term) VALUES(?,?,?,?,?)");
    for (const term of terms) insertTerm.run(record.claimId, record.version, record.workspaceId, term.kind, term.term);
    const outboxId = idFromSha256("MIDX", sha256Hex(`CLAIM\0${record.claimId}\0${record.version}\0${record.claimSha256}`));
    this.connection.prepare(`INSERT INTO memory_index_v2_outbox(
      outbox_id,claim_id,version,action_id,workspace_id,operation,created_event_sequence
    ) VALUES(?,?,?,NULL,?,'UPSERT',?)`).run(outboxId, record.claimId, record.version, record.workspaceId, eventSequence);
    onFault?.("after-memory-claim-index-outbox-write");
  }

  insertAction(
    action: MemoryClaimActionInput,
    commandGoalId: string,
    eventSequence: number,
    onFault?: (point: "after-memory-action-write" | "after-memory-action-head-write" | "after-memory-action-index-outbox-write") => void,
  ): void {
    if (action.actorGoalId !== commandGoalId) throw new AuthorityIntegrityError("Memory action Goal substitution");
    const claim = this.requireCurrent(action.claimId);
    const actor = this.connection.prepare("SELECT workspace_id FROM goals WHERE goal_id=?").get(commandGoalId) as { workspace_id?: unknown } | undefined;
    if (!actor || actor.workspace_id !== claim.workspaceId || action.workspaceId !== claim.workspaceId) {
      throw new AuthorityIntegrityError("Memory action workspace substitution");
    }
    if (claim.scope === "GOAL" && claim.scopeGoalId !== commandGoalId) {
      throw new AuthorityIntegrityError("Memory GOAL claim cannot be mutated from another Goal");
    }
    if (action.targetVersion !== claim.version) throw new AuthorityIntegrityError("Memory action targets a stale claim version");
    const expectedFamily = action.actionType === "ENDORSE" || action.actionType === "REVOKE_ENDORSEMENT"
      ? "ENDORSEMENT" : "VISIBILITY";
    if (action.actionFamily !== expectedFamily) throw new AuthorityIntegrityError("Memory action family mismatch");
    const prior = this.actionHead(action.claimId, action.actionFamily);
    if (action.predecessorActionId !== (prior?.actionId ?? null)) throw new AuthorityIntegrityError("Memory action predecessor mismatch");
    const { actionSha256, ...base } = action;
    if (actionSha256 !== computeMemoryActionSha256(base)) throw new AuthorityIntegrityError("Memory action hash mismatch");
    this.connection.prepare(`INSERT INTO memory_claim_actions(
      action_id,claim_id,target_version,workspace_id,actor_goal_id,action_type,action_family,reason,
      predecessor_action_id,action_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      action.actionId, action.claimId, action.targetVersion, action.workspaceId, action.actorGoalId,
      action.actionType, action.actionFamily, action.reason, action.predecessorActionId,
      action.actionSha256, action.createdAtMs, eventSequence,
    );
    onFault?.("after-memory-action-write");
    this.connection.prepare(`INSERT INTO memory_action_heads(claim_id,action_family,action_id,last_event_sequence)
      VALUES(?,?,?,?) ON CONFLICT(claim_id,action_family) DO UPDATE SET
      action_id=excluded.action_id,last_event_sequence=excluded.last_event_sequence`)
      .run(action.claimId, action.actionFamily, action.actionId, eventSequence);
    onFault?.("after-memory-action-head-write");
    if (action.actionFamily === "VISIBILITY") {
      const operation = action.actionType === "FORGET" ? "DELETE" : "UPSERT";
      const outboxId = idFromSha256("MIDX", sha256Hex(`ACTION\0${action.actionId}\0${action.actionSha256}`));
      this.connection.prepare(`INSERT INTO memory_index_v2_outbox(
        outbox_id,claim_id,version,action_id,workspace_id,operation,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?)`).run(
        outboxId, action.claimId, claim.version, action.actionId, claim.workspaceId, operation, eventSequence,
      );
      onFault?.("after-memory-action-index-outbox-write");
    }
  }

  current(claimId: string): MemoryClaimVersionRecord | null {
    const record = this.currentRaw(claimId);
    if (record) this.verifyClaimAuthority(record);
    return record;
  }

  requireCurrent(claimId: string): MemoryClaimVersionRecord {
    const value = this.currentRaw(claimId);
    if (!value) throw new AuthorityNotFoundError(`Memory claim ${claimId}`);
    this.verifyClaimAuthority(value);
    return value;
  }

  actionHead(claimId: string, family: MemoryClaimActionRecord["actionFamily"]): MemoryClaimActionRecord | null {
    const row = this.connection.prepare(`${actionProjection} JOIN memory_action_heads h ON h.action_id=a.action_id
      WHERE h.claim_id=? AND h.action_family=?`).get(claimId, family) as Record<string, unknown> | undefined;
    if (!row) return null;
    const action = decodeAction(row);
    this.verifyActionAuthority(action);
    return action;
  }

  candidates(workspaceId: string, goalId: string | null, channels: readonly string[], limit: number): EffectiveMemoryClaim[] {
    if (channels.length === 0) return [];
    const channelSql = channels.map(() => "?").join(",");
    const rows = this.connection.prepare(`${claimProjection} JOIN memory_claim_heads h
      ON h.claim_id=mv.claim_id AND h.version=mv.version
      WHERE h.workspace_id=? AND h.status='ACTIVE' AND ${visibleScopeSql("h")}
      AND h.channel IN (${channelSql}) ORDER BY h.last_event_sequence DESC,h.claim_id LIMIT ?`)
      .all(workspaceId, goalId, ...channels, limit) as Record<string, unknown>[];
    return this.effective(rows.map((row) => decodeClaim(row)));
  }

  byIds(workspaceId: string, goalId: string | null, claimIds: readonly string[]): EffectiveMemoryClaim[] {
    if (claimIds.length === 0) return [];
    this.refreshVerifiedClaimCache();
    const requestedValues = claimIds.map(() => "(?,?)").join(",");
    const requestedParameters = claimIds.flatMap((claimId, position) => [position, claimId]);
    const rows = this.connection.prepare(`WITH requested(position,claim_id) AS (VALUES ${requestedValues})
      SELECT ${claimColumns} FROM requested CROSS JOIN memory_claim_heads h
      JOIN memory_claim_versions mv ON mv.claim_id=h.claim_id AND mv.version=h.version
      WHERE h.claim_id=requested.claim_id AND h.workspace_id=? AND h.status='ACTIVE'
      AND ${visibleScopeSql("h")} ORDER BY requested.position`)
      .all(...requestedParameters, workspaceId, goalId) as Record<string, unknown>[];
    const map = new Map(this.effective(rows.map((row) => this.decodeVerifiedClaim(row))).map((value) => [value.claim.claimId, value]));
    return claimIds.map((id) => map.get(id)).filter((value): value is EffectiveMemoryClaim => value !== undefined);
  }

  structuredMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryCandidateRank["channel"][],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    if (terms.length === 0 || channels.length === 0) return [];
    const placeholders = terms.map(() => "?").join(",");
    const channelSql = channels.map(() => "?").join(",");
    const rows = this.connection.prepare(`SELECT mt.claim_id,h.channel,count(*) AS exact_matches
      FROM memory_claim_terms mt JOIN memory_claim_heads h ON h.claim_id=mt.claim_id AND h.version=mt.version
      WHERE mt.workspace_id=? AND h.status='ACTIVE' AND ${visibleScopeSql("h")}
      AND h.channel IN (${channelSql}) AND mt.term IN (${placeholders})
      GROUP BY mt.claim_id,h.channel ORDER BY exact_matches DESC,mt.claim_id LIMIT ?`)
      .all(workspaceId, goalId, ...channels, ...terms, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      claimId: text(row, "claim_id"), channel: text(row, "channel") as MemoryCandidateRank["channel"],
      relevanceRank: null, exactMatches: integer(row, "exact_matches"), lexicalMatches: 0,
    }));
  }

  ftsMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryCandidateRank["channel"][],
    query: string,
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    if (this.indexMode() !== "FTS5" || !query || channels.length === 0) return [];
    const boundedTerms = [...new Set(terms.map((term) => term.toLocaleLowerCase("en-US")))].slice(0, 32);
    const lexical = boundedTerms.length === 0
      ? "0"
      : boundedTerms.map(() => "CASE WHEN instr(lower(memory_claims_fts.content),?) > 0 THEN 1 ELSE 0 END").join("+");
    const channelSql = channels.map(() => "?").join(",");
    const rows = this.connection.prepare(`SELECT memory_claims_fts.claim_id,memory_claims_fts.channel,
      bm25(memory_claims_fts) AS relevance_rank,(${lexical}) AS lexical_matches
      FROM memory_claims_fts JOIN memory_claim_heads h
        ON h.claim_id=memory_claims_fts.claim_id AND h.version=memory_claims_fts.version
      WHERE memory_claims_fts.workspace_id=? AND h.status='ACTIVE' AND ${visibleScopeSql("h")}
      AND h.channel IN (${channelSql}) AND memory_claims_fts MATCH ?
      ORDER BY lexical_matches DESC,relevance_rank,memory_claims_fts.claim_id LIMIT ?`)
      .all(...boundedTerms, workspaceId, goalId, ...channels, query, limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const rank = row.relevance_rank;
      if (typeof rank !== "number" || !Number.isFinite(rank)) throw new AuthorityIntegrityError("Memory FTS rank is invalid");
      return {
        claimId: text(row, "claim_id"), channel: text(row, "channel") as MemoryCandidateRank["channel"],
        relevanceRank: rank, exactMatches: 0, lexicalMatches: integer(row, "lexical_matches"),
      };
    });
  }

  endorsedCandidates(workspaceId: string, goalId: string | null, channels: readonly string[], limit: number): EffectiveMemoryClaim[] {
    if (channels.length === 0) return [];
    const channelSql = channels.map(() => "?").join(",");
    const rows = this.connection.prepare(`${claimProjection} JOIN memory_claim_heads h
      ON h.claim_id=mv.claim_id AND h.version=mv.version
      JOIN memory_action_heads ah ON ah.claim_id=h.claim_id AND ah.action_family='ENDORSEMENT'
      JOIN memory_claim_actions a ON a.action_id=ah.action_id AND a.action_type='ENDORSE'
      WHERE h.workspace_id=? AND h.status='ACTIVE' AND ${visibleScopeSql("h")}
      AND h.channel IN (${channelSql}) ORDER BY a.created_event_sequence DESC,h.claim_id LIMIT ?`)
      .all(workspaceId, goalId, ...channels, limit) as Record<string, unknown>[];
    return this.effective(rows.map((row) => decodeClaim(row)));
  }

  pendingCandidates(workspaceId: string, goalId: string | null, limit: number): EffectiveMemoryClaim[] {
    const rows = this.connection.prepare(`${claimProjection} JOIN memory_claim_heads h
      ON h.claim_id=mv.claim_id AND h.version=mv.version
      JOIN memory_index_v2_outbox o ON o.claim_id=h.claim_id
      LEFT JOIN memory_index_v2_receipts ir ON ir.outbox_id=o.outbox_id
      WHERE o.workspace_id=? AND ir.outbox_id IS NULL AND h.status='ACTIVE' AND ${visibleScopeSql("h")}
      ORDER BY o.created_event_sequence DESC,o.outbox_id LIMIT ?`).all(workspaceId, goalId, limit) as Record<string, unknown>[];
    return this.effective([...new Map(rows.map((row) => {
      const claim = decodeClaim(row);
      return [claim.claimId, claim] as const;
    })).values()]);
  }

  pendingMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly string[],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[] {
    const boundedTerms = [...new Set(terms.map((term) => term.toLocaleLowerCase("en-US")))].slice(0, 32);
    if (channels.length === 0 || boundedTerms.length === 0 || limit < 1) return [];
    const score = boundedTerms.map(() => "CASE WHEN instr(lower(mv.content_text),?) > 0 THEN 1 ELSE 0 END").join("+");
    const channelSql = channels.map(() => "?").join(",");
    const rows = this.connection.prepare(`WITH pending AS MATERIALIZED (
      SELECT o.claim_id,o.version,o.created_event_sequence
      FROM memory_index_v2_outbox o
      WHERE o.workspace_id=? AND NOT EXISTS (
        SELECT 1 FROM memory_index_v2_receipts ir WHERE ir.outbox_id=o.outbox_id
      )
    ) SELECT claim_id,channel,exact_matches FROM (
      SELECT mv.claim_id AS claim_id,h.channel AS channel,(${score}) AS exact_matches,
        p.created_event_sequence AS pending_sequence
      FROM pending p
      JOIN memory_claim_heads h ON h.claim_id=p.claim_id AND h.version=p.version
      JOIN memory_claim_versions mv ON mv.claim_id=h.claim_id AND mv.version=h.version
      WHERE h.status='ACTIVE'
      AND ${visibleScopeSql("h")} AND h.channel IN (${channelSql})
    ) WHERE exact_matches>0 ORDER BY exact_matches DESC,pending_sequence DESC,claim_id LIMIT ?`)
      .all(workspaceId, ...boundedTerms, goalId, ...channels, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      claimId: text(row, "claim_id"), channel: text(row, "channel") as MemoryCandidateRank["channel"],
      relevanceRank: null, exactMatches: 0, lexicalMatches: integer(row, "exact_matches"),
    }));
  }

  pendingIndexCount(workspaceId?: string): number {
    const sql = workspaceId
      ? `SELECT count(*) AS count FROM memory_index_v2_outbox o LEFT JOIN memory_index_v2_receipts r ON r.outbox_id=o.outbox_id
         WHERE r.outbox_id IS NULL AND o.workspace_id=?`
      : `SELECT count(*) AS count FROM memory_index_v2_outbox o LEFT JOIN memory_index_v2_receipts r ON r.outbox_id=o.outbox_id
         WHERE r.outbox_id IS NULL`;
    const row = (workspaceId ? this.connection.prepare(sql).get(workspaceId) : this.connection.prepare(sql).get()) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  indexWatermark(workspaceId: string): number {
    this.verifyIndexWatermarks(workspaceId);
    const row = this.connection.prepare(`SELECT indexed_event_sequence FROM memory_workspace_watermarks
      WHERE workspace_id=?`).get(workspaceId) as Record<string, unknown> | undefined;
    return row ? integer(row, "indexed_event_sequence") : 0;
  }

  insertRecallObservations(observations: readonly MemoryRecallObservation[]): number {
    if (observations.length === 0) return 0;
    const insert = this.connection.prepare(`INSERT INTO memory_recall_observations(
      observation_id,workspace_id,goal_id,epoch,mode,selected_manifest_sha256,selected_count,
      conflict_count,abstention_count,index_lag_count,token_estimate,latency_micros,created_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of observations) {
        const goal = observation.goalId === null ? null : this.connection.prepare(
          "SELECT workspace_id FROM goals WHERE goal_id=?",
        ).get(observation.goalId) as { workspace_id?: unknown } | undefined;
        if ((goal && goal.workspace_id !== observation.workspaceId)
          || !/^[a-f0-9]{64}$/u.test(observation.selectedManifestSha256)
          || [observation.selectedCount, observation.conflictCount, observation.abstentionCount,
            observation.indexLagCount, observation.tokenEstimate, observation.latencyMicros,
            observation.createdAtMs].some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new AuthorityIntegrityError("Memory recall observation fields or workspace binding are invalid");
        }
        insert.run(
          observation.observationId, observation.workspaceId, observation.goalId, observation.epoch,
          observation.mode, observation.selectedManifestSha256, observation.selectedCount,
          observation.conflictCount, observation.abstentionCount, observation.indexLagCount,
          observation.tokenEstimate, observation.latencyMicros, observation.createdAtMs,
        );
      }
      this.connection.exec("COMMIT");
      return observations.length;
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* Preserve the original telemetry failure. */ }
      throw error;
    }
  }

  flushIndex(limit: number, nowMs: number): MemoryIndexDrainResult {
    this.verifyIndexWatermarks();
    if (this.indexMode() !== "FTS5") return { processed: 0, remaining: this.pendingIndexCount(), workspaceWatermarks: {} };
    const rows = this.connection.prepare(`SELECT o.* FROM memory_index_v2_outbox o
      LEFT JOIN memory_index_v2_receipts r ON r.outbox_id=o.outbox_id WHERE r.outbox_id IS NULL
      ORDER BY o.created_event_sequence,o.outbox_id LIMIT ?`).all(limit) as Record<string, unknown>[];
    if (rows.length === 0) return { processed: 0, remaining: 0, workspaceWatermarks: {} };
    const watermarks = new Map<string, number>();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const outboxId = text(row, "outbox_id");
        const claimId = text(row, "claim_id");
        const workspaceId = text(row, "workspace_id");
        const sequence = integer(row, "created_event_sequence");
        const version = integer(row, "version");
        const operation = text(row, "operation");
        const actionId = nullableText(row, "action_id");
        let workIsCurrent = false;
        if (actionId === null) {
          const source = this.claimVersionRaw(claimId, version);
          if (!source) throw new AuthorityIntegrityError(`Memory index claim work is orphaned at ${outboxId}`);
          this.verifyClaimVersionAuthority(source);
          const expectedId = idFromSha256("MIDX", sha256Hex(`CLAIM\0${claimId}\0${version}\0${source.claimSha256}`));
          if (outboxId !== expectedId || operation !== "UPSERT" || source.workspaceId !== workspaceId
            || source.createdEventSequence !== sequence) {
            throw new AuthorityIntegrityError(`Memory index claim work mismatch at ${outboxId}`);
          }
        } else {
          const source = this.actionRaw(actionId);
          if (!source) throw new AuthorityIntegrityError(`Memory index action work is orphaned at ${outboxId}`);
          this.verifyActionVersionAuthority(source);
          const expectedId = idFromSha256("MIDX", sha256Hex(`ACTION\0${actionId}\0${source.actionSha256}`));
          const expectedOperation = source.actionType === "FORGET" ? "DELETE" : "UPSERT";
          if (outboxId !== expectedId || operation !== expectedOperation || source.claimId !== claimId
            || source.targetVersion !== version || source.workspaceId !== workspaceId
            || source.createdEventSequence !== sequence) {
            throw new AuthorityIntegrityError(`Memory index action work mismatch at ${outboxId}`);
          }
        }
        const current = this.requireCurrent(claimId);
        const effective = this.effective([current])[0];
        const currentVisibility = this.actionHead(claimId, "VISIBILITY");
        workIsCurrent = actionId === null
          ? current.version === version && currentVisibility === null
          : current.version === version && currentVisibility?.actionId === actionId;
        this.connection.prepare("DELETE FROM memory_claims_fts WHERE claim_id=?").run(claimId);
        let result: "UPSERTED" | "DELETED" | "SUPERSEDED" = "SUPERSEDED";
        if (effective && !effective.forgotten && current.status === "ACTIVE") {
          this.connection.prepare(`INSERT INTO memory_claims_fts(
            claim_id,version,workspace_id,scope_goal_id,channel,tags,cjk_ngrams,content
          ) VALUES(?,?,?,?,?,?,?,?)`).run(
            current.claimId, current.version, current.workspaceId, current.scopeGoalId, current.channel,
            current.tags.join(" "), memoryCjkProjection(`${current.tags.join(" ")} ${current.contentText}`), current.contentText,
          );
          if (workIsCurrent) result = "UPSERTED";
        } else if (effective?.forgotten && workIsCurrent) result = "DELETED";
        this.connection.prepare(`INSERT INTO memory_index_v2_receipts(
          outbox_id,indexed_at_ms,indexed_claim_sha256,result
        ) VALUES(?,?,?,?)`).run(outboxId, nowMs, current.claimSha256, result);
        watermarks.set(workspaceId, Math.max(watermarks.get(workspaceId) ?? 0, sequence));
      }
      for (const [workspaceId, sequence] of watermarks) {
        this.connection.prepare(`INSERT INTO memory_workspace_watermarks(workspace_id,indexed_event_sequence,updated_at_ms)
          VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
          indexed_event_sequence=max(indexed_event_sequence,excluded.indexed_event_sequence),updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, sequence, nowMs);
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
    return {
      processed: rows.length,
      remaining: this.pendingIndexCount(),
      workspaceWatermarks: Object.fromEntries(watermarks),
    };
  }

  verifyClaimAuthority(record: MemoryClaimVersionRecord): void {
    const head = this.connection.prepare(`SELECT version,claim_sha256,last_event_sequence FROM memory_claim_heads WHERE claim_id=?`)
      .get(record.claimId) as Record<string, unknown> | undefined;
    if (!head || integer(head, "version") !== record.version || text(head, "claim_sha256") !== record.claimSha256
      || integer(head, "last_event_sequence") !== record.createdEventSequence) {
      throw new AuthorityIntegrityError(`Memory claim head mismatch at ${record.claimId}`);
    }
    const latest = this.connection.prepare("SELECT max(version) AS version FROM memory_claim_versions WHERE claim_id=?")
      .get(record.claimId) as Record<string, unknown> | undefined;
    if (!latest || integer(latest, "version") !== record.version) {
      throw new AuthorityIntegrityError(`Memory claim head is not current at ${record.claimId}`);
    }
    this.verifyClaimVersionAuthority(record);
  }

  private verifyClaimVersionAuthority(record: MemoryClaimVersionRecord): void {
    this.verifyLinkedEvent(record.actorGoalId, record.createdEventSequence, "MEMORY_CLAIMED", {
      claimId: record.claimId, version: record.version, claimSha256: record.claimSha256,
      channel: record.channel, scope: record.scope, status: record.status,
    });
    const receipt = this.connection.prepare(`SELECT output_sha256,issued_event_sequence FROM receipts
      WHERE goal_id=? AND receipt_type='MEMORY_CLAIM' AND subject_id=? AND issued_event_sequence=?`)
      .get(record.actorGoalId, record.claimId, record.createdEventSequence) as Record<string, unknown> | undefined;
    if (!receipt || text(receipt, "output_sha256") !== record.claimSha256
      || integer(receipt, "issued_event_sequence") !== record.createdEventSequence) {
      throw new AuthorityIntegrityError(`Memory claim receipt mismatch at ${record.claimId}`);
    }
  }

  verifyActionAuthority(action: MemoryClaimActionRecord): void {
    const head = this.connection.prepare(`SELECT h.action_id,h.last_event_sequence,
      max(a.created_event_sequence) AS latest_sequence
      FROM memory_action_heads h JOIN memory_claim_actions a
        ON a.claim_id=h.claim_id AND a.action_family=h.action_family
      WHERE h.claim_id=? AND h.action_family=? GROUP BY h.action_id,h.last_event_sequence`)
      .get(action.claimId, action.actionFamily) as Record<string, unknown> | undefined;
    if (!head || text(head, "action_id") !== action.actionId
      || integer(head, "last_event_sequence") !== action.createdEventSequence
      || integer(head, "latest_sequence") !== action.createdEventSequence) {
      throw new AuthorityIntegrityError(`Memory action head mismatch at ${action.actionId}`);
    }
    this.verifyActionVersionAuthority(action);
  }

  private verifyActionVersionAuthority(action: MemoryClaimActionRecord): void {
    this.verifyLinkedEvent(action.actorGoalId, action.createdEventSequence, "MEMORY_ACTIONED", {
      actionId: action.actionId, claimId: action.claimId, targetVersion: action.targetVersion,
      actionType: action.actionType, actionSha256: action.actionSha256,
    });
    const receipt = this.connection.prepare(`SELECT output_sha256 FROM receipts
      WHERE goal_id=? AND receipt_type='MEMORY_ACTION' AND subject_id=? AND issued_event_sequence=?`)
      .get(action.actorGoalId, action.actionId, action.createdEventSequence) as Record<string, unknown> | undefined;
    if (!receipt || text(receipt, "output_sha256") !== action.actionSha256) {
      throw new AuthorityIntegrityError(`Memory action receipt mismatch at ${action.actionId}`);
    }
  }

  receiptAttestation(receiptId: string, workspaceId: string): MemoryReceiptAttestationSource | null {
    const row = this.connection.prepare(`SELECT r.receipt_id,r.goal_id,g.workspace_id,r.result,r.body_json,r.output_sha256,
      r.failure_signature_sha256,r.issued_event_sequence,e.event_sha256
      FROM receipts r JOIN goals g ON g.goal_id=r.goal_id
      JOIN events e ON e.goal_id=r.goal_id AND e.sequence=r.issued_event_sequence
      WHERE r.receipt_id=? AND g.workspace_id=?`).get(receiptId, workspaceId) as Record<string, unknown> | undefined;
    if (row) {
      const body = parseCanonicalJson(text(row, "body_json"));
      return {
        receiptId: text(row, "receipt_id"), goalId: text(row, "goal_id"), workspaceId: text(row, "workspace_id"),
        result: text(row, "result") as MemoryReceiptAttestationSource["result"],
        bodySha256: canonicalJsonSha256(body), outputSha256: nullableText(row, "output_sha256"),
        failureSignatureSha256: nullableText(row, "failure_signature_sha256"),
        issuedEventSequence: integer(row, "issued_event_sequence"), eventSha256: text(row, "event_sha256"),
      };
    }
    const acceptanceV2 = this.acceptanceV2ReceiptAttestation(receiptId, workspaceId);
    if (acceptanceV2) return acceptanceV2;
    const taskFlowAvailable = this.connection.prepare(
      "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='evidence_attestations_v1'",
    ).get() as { present?: unknown } | undefined;
    if (taskFlowAvailable?.present !== 1) return null;
    const evidence = this.connection.prepare(`SELECT a.*,g.workspace_id,e.event_sha256
      FROM evidence_attestations_v1 a JOIN goals g ON g.goal_id=a.goal_id
      JOIN events e ON e.goal_id=a.goal_id AND e.sequence=a.created_event_sequence
      WHERE a.attestation_id=? AND g.workspace_id=?`).get(receiptId, workspaceId) as Record<string, unknown> | undefined;
    if (!evidence) return null;
    const record: EvidenceAttestationRecord = {
      schema_version: 1, attestation_id: text(evidence, "attestation_id"), goal_id: text(evidence, "goal_id"),
      work_cell_id: nullableText(evidence, "work_cell_id"), operation_id: nullableText(evidence, "operation_id"),
      obligation_id: nullableText(evidence, "obligation_id"), oracle_sha256: text(evidence, "oracle_sha256"),
      input_closure_sha256: text(evidence, "input_closure_sha256"), output_sha256: text(evidence, "output_sha256"),
      baseline_sha256: text(evidence, "baseline_sha256"), environment_sha256: text(evidence, "environment_sha256"),
      result: text(evidence, "result") as EvidenceAttestationRecord["result"],
      freshness: text(evidence, "freshness") as EvidenceAttestationRecord["freshness"],
      postcondition: text(evidence, "postcondition") as EvidenceAttestationRecord["postcondition"],
      artifact_id: nullableText(evidence, "artifact_id"), created_at_ms: integer(evidence, "created_at_ms"),
      record_sha256: text(evidence, "record_sha256"),
    };
    try {
      assertEvidenceAttestation(record);
    } catch (error) {
      throw new AuthorityIntegrityError(
        `Task Flow evidence attestation ${record.attestation_id} failed integrity verification`,
        error,
      );
    }
    const sequence = integer(evidence, "created_event_sequence");
    this.verifyLinkedEvent(record.goal_id, sequence, "EVIDENCE_ATTESTED", {
      attestationId: record.attestation_id, result: record.result, workCellId: record.work_cell_id,
    });
    return {
      receiptId: record.attestation_id, goalId: record.goal_id, workspaceId: text(evidence, "workspace_id"),
      result: record.result === "PASS" ? "SUCCEEDED" : record.result === "FAIL" ? "FAILED" : "UNKNOWN_OUTCOME",
      bodySha256: record.record_sha256, outputSha256: record.output_sha256, failureSignatureSha256: null,
      issuedEventSequence: sequence, eventSha256: text(evidence, "event_sha256"),
    };
  }

  private acceptanceV2ReceiptAttestation(
    receiptId: string,
    workspaceId: string,
  ): MemoryReceiptAttestationSource | null {
    const available = this.connection.prepare(
      "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='oracle_pass_receipts_v2'",
    ).get() as { present?: unknown } | undefined;
    if (available?.present !== 1) return null;
    const row = this.connection.prepare(`SELECT p.*,g.workspace_id,e.event_sha256,e.prev_event_sha256
      FROM oracle_pass_receipts_v2 p JOIN goals g ON g.goal_id=p.goal_id
      JOIN events e ON e.goal_id=p.goal_id AND e.sequence=p.created_event_sequence
      WHERE p.pass_receipt_id=? AND g.workspace_id=?`).get(receiptId, workspaceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const record = {
      schema_version: 2,
      pass_receipt_id: text(row, "pass_receipt_id"), authority_root_id: text(row, "authority_root_id"),
      goal_id: text(row, "goal_id"), contract_id: text(row, "contract_id"), route_id: text(row, "route_id"),
      work_cell_id: text(row, "work_cell_id"), evidence_requirement_id: text(row, "evidence_requirement_id"),
      observation_id: text(row, "observation_id"), attempt_id: text(row, "attempt_id"),
      terminal_transition_id: text(row, "terminal_transition_id"),
      terminal_transition_sha256: text(row, "terminal_transition_sha256"),
      authorization_id: text(row, "authorization_id"), authorization_sha256: text(row, "authorization_sha256"),
      lease_generation: integer(row, "lease_generation"), fencing_token: integer(row, "fencing_token"),
      postimage_root_sha256: text(row, "postimage_root_sha256"),
      environment_sha256: text(row, "environment_sha256"),
      integration_root_sha256: text(row, "integration_root_sha256"),
      topology_revision_sha256: text(row, "topology_revision_sha256"),
      observation_root_sha256: text(row, "observation_root_sha256"),
      predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    };
    const recordSha256 = canonicalJsonSha256({ domain: "PCH-ORACLE-PASS-RECEIPT-V2", ...record });
    if (recordSha256 !== text(row, "record_sha256")
      || nullableText(row, "prev_event_sha256") !== record.predecessor_authority_head_sha256) {
      throw new AuthorityIntegrityError(`Oracle PASS receipt ${receiptId} failed integrity verification`);
    }
    const sequence = integer(row, "created_event_sequence");
    const closure = this.connection.prepare(`SELECT p.evidence_requirement_id,b.evidence_binding_id,b.record_sha256,
        p.attempt_id,p.terminal_transition_id,p.work_cell_id
      FROM oracle_pass_receipts_v2 p JOIN acceptance_evidence_bindings_v2 b
        ON b.pass_receipt_id=p.pass_receipt_id
      WHERE p.goal_id=? AND p.created_event_sequence=? ORDER BY p.evidence_requirement_id`)
      .all(record.goal_id, sequence) as Record<string, unknown>[];
    if (closure.length === 0) {
      throw new AuthorityIntegrityError(`Oracle PASS receipt ${receiptId} lacks its evidence closure`);
    }
    const first = closure[0]!;
    const expectedPayload = {
      attemptId: text(first, "attempt_id"), terminalTransitionId: text(first, "terminal_transition_id"),
      evidenceRequirementIds: closure.map((entry) => text(entry, "evidence_requirement_id")),
      evidenceBindingIds: closure.map((entry) => text(entry, "evidence_binding_id")),
      evidenceBindingRootSha256: canonicalJsonSha256({
        domain: "PCH-ACCEPTANCE-EVIDENCE-EVENT-ROOT-V2",
        members: closure.map((entry) => text(entry, "record_sha256")).sort(),
      }),
      workCellId: text(first, "work_cell_id"),
    };
    if (expectedPayload.attemptId !== record.attempt_id
      || expectedPayload.terminalTransitionId !== record.terminal_transition_id
      || expectedPayload.workCellId !== record.work_cell_id
      || !expectedPayload.evidenceRequirementIds.includes(record.evidence_requirement_id)) {
      throw new AuthorityIntegrityError(`Oracle PASS receipt ${receiptId} has a mixed evidence closure`);
    }
    this.verifyLinkedEvent(record.goal_id, sequence, "EVIDENCE_ATTESTED", expectedPayload);
    return {
      receiptId: record.pass_receipt_id, goalId: record.goal_id, workspaceId: text(row, "workspace_id"),
      result: "SUCCEEDED", bodySha256: recordSha256, outputSha256: record.observation_root_sha256,
      failureSignatureSha256: null, issuedEventSequence: sequence, eventSha256: text(row, "event_sha256"),
    };
  }

  legacyDispositionCount(workspaceId: string): number {
    const row = this.connection.prepare("SELECT count(*) AS count FROM memory_legacy_dispositions WHERE workspace_id=?")
      .get(workspaceId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  private currentRaw(claimId: string): MemoryClaimVersionRecord | null {
    const row = this.connection.prepare(`${claimProjection} JOIN memory_claim_heads h
      ON h.claim_id=mv.claim_id AND h.version=mv.version WHERE h.claim_id=?`).get(claimId) as Record<string, unknown> | undefined;
    return row ? decodeClaim(row) : null;
  }

  private claimVersionRaw(claimId: string, version: number): MemoryClaimVersionRecord | null {
    const row = this.connection.prepare(`${claimProjection} WHERE mv.claim_id=? AND mv.version=?`)
      .get(claimId, version) as Record<string, unknown> | undefined;
    return row ? decodeClaim(row) : null;
  }

  private actionRaw(actionId: string): MemoryClaimActionRecord | null {
    const row = this.connection.prepare(`${actionProjection} WHERE a.action_id=?`)
      .get(actionId) as Record<string, unknown> | undefined;
    return row ? decodeAction(row) : null;
  }

  private verifyIndexWatermarks(workspaceId?: string): void {
    const statement = this.connection.prepare(`SELECT w.workspace_id,w.indexed_event_sequence,
      coalesce(max(CASE WHEN r.outbox_id IS NOT NULL THEN o.created_event_sequence END),0) AS expected_sequence
      FROM memory_workspace_watermarks w
      LEFT JOIN memory_index_v2_outbox o ON o.workspace_id=w.workspace_id
      LEFT JOIN memory_index_v2_receipts r ON r.outbox_id=o.outbox_id
      ${workspaceId === undefined ? "" : "WHERE w.workspace_id=?"}
      GROUP BY w.workspace_id,w.indexed_event_sequence`);
    const rows = (workspaceId === undefined ? statement.all() : statement.all(workspaceId)) as Record<string, unknown>[];
    for (const row of rows) {
      if (integer(row, "indexed_event_sequence") !== integer(row, "expected_sequence")) {
        throw new AuthorityIntegrityError(`Memory index watermark mismatch at ${text(row, "workspace_id")}`);
      }
    }
  }

  private effective(records: readonly MemoryClaimVersionRecord[]): EffectiveMemoryClaim[] {
    if (records.length === 0) return [];
    const ids = [...new Set(records.map((record) => record.claimId))];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.connection.prepare(`${actionProjection} JOIN memory_action_heads h ON h.action_id=a.action_id
      WHERE h.claim_id IN (${placeholders})`).all(...ids) as Record<string, unknown>[];
    const actions = new Map<string, Map<string, MemoryClaimActionRecord>>();
    for (const row of rows) {
      const action = decodeAction(row);
      this.verifyActionAuthority(action);
      const families = actions.get(action.claimId) ?? new Map<string, MemoryClaimActionRecord>();
      families.set(action.actionFamily, action);
      actions.set(action.claimId, families);
    }
    return records.map((claim) => {
      const families = actions.get(claim.claimId);
      return {
        claim,
        endorsed: families?.get("ENDORSEMENT")?.actionType === "ENDORSE",
        forgotten: families?.get("VISIBILITY")?.actionType === "FORGET",
      };
    });
  }

  private verifyLinkedEvent(
    goalId: string,
    sequence: number,
    eventType: string,
    expectedPayload: Readonly<Record<string, unknown>>,
  ): void {
    const row = this.connection.prepare(`SELECT e.*,sm.store_id,sm.store_generation,sm.leader_epoch
      FROM events e CROSS JOIN store_meta sm WHERE sm.singleton=1 AND e.goal_id=? AND e.sequence=?`)
      .get(goalId, sequence) as Record<string, unknown> | undefined;
    if (!row || text(row, "event_type") !== eventType || text(row, "payload_json") !== canonicalJson(expectedPayload)
      || text(row, "payload_sha256") !== canonicalJsonSha256(expectedPayload)) {
      throw new AuthorityIntegrityError(`Memory linked event mismatch at ${goalId}/${sequence}`);
    }
    const calculated = computeEventSha256({
      storeId: text(row, "store_id"), goalId, sequence, eventType,
      commandId: text(row, "command_id"), payloadSha256: text(row, "payload_sha256"),
      prevEventSha256: nullableText(row, "prev_event_sha256"),
      storeGeneration: integer(row, "store_generation"), leaderEpoch: integer(row, "leader_epoch"),
    });
    if (calculated !== text(row, "event_sha256")) throw new AuthorityIntegrityError(`Memory event hash mismatch at ${goalId}/${sequence}`);
  }
}
