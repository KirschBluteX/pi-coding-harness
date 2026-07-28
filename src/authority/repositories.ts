import type { AuthorityConnection } from "./database.js";
import type { StoredEvent } from "./event-chain.js";
import { parseCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError, AuthorityNotFoundError } from "../foundation/errors.js";

export interface StoreMetaRow {
  readonly storeId: string;
  readonly storeGeneration: number;
  readonly leaderEpoch: number;
}

export interface GoalRow {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly originSessionId: string;
  readonly objective: string;
  readonly objectiveSha256: string;
  readonly intent: "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
  readonly requirementProfile: "TASK_SPEC" | "PRD";
  readonly planningDepth: "LIGHT" | "STANDARD" | "FULL";
  readonly createdAtMs: number;
}

export interface LeaseRow {
  readonly goalId: string;
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly lastProgressEventSequence: number;
  readonly rowVersion: number;
}

export interface PersistedCommandResult {
  readonly goalId: string;
  readonly eventSequence: number;
  readonly goalVersion: number;
  readonly eventSha256: string;
  readonly eventType: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Authority field ${field} must be text`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AuthorityIntegrityError(`Authority field ${field} must be a safe integer`);
  }
  return value;
}

function isPersistedCommandResult(value: unknown): value is PersistedCommandResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 5
    && typeof candidate.goalId === "string"
    && Number.isSafeInteger(candidate.eventSequence)
    && Number.isSafeInteger(candidate.goalVersion)
    && typeof candidate.eventSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(candidate.eventSha256)
    && typeof candidate.eventType === "string";
}

const commandReceiptProjection = `
  SELECT cr.command_id,cr.command_sha256,cr.result_json,cr.result_sha256,
         cr.committed_goal_version,cr.committed_event_sequence,
         e.sequence AS event_sequence,e.event_sha256,e.event_type
  FROM command_receipts cr
  LEFT JOIN events e ON e.goal_id=cr.goal_id AND e.command_id=cr.command_id`;

function decodeCommandReceipt(
  row: Record<string, unknown>,
  goalId: string,
  expectedCommandSha256?: string,
): PersistedCommandResult {
  const commandId = requiredText(row.command_id, "command_receipts.command_id");
  const commandSha256 = requiredText(row.command_sha256, "command_receipts.command_sha256");
  if (!/^[a-f0-9]{64}$/u.test(commandSha256)) {
    throw new AuthorityIntegrityError(`Command receipt command hash is invalid at ${commandId}`);
  }
  if (expectedCommandSha256 !== undefined && commandSha256 !== expectedCommandSha256) {
    throw new AuthorityIntegrityError(`Idempotency key was reused with different command content at ${commandId}`);
  }
  const resultJson = requiredText(row.result_json, "command_receipts.result_json");
  const resultSha256 = requiredText(row.result_sha256, "command_receipts.result_sha256");
  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(resultJson);
  } catch (error) {
    throw new AuthorityIntegrityError(`Command receipt JSON failed at ${commandId}`, error);
  }
  if (sha256Hex(resultJson) !== resultSha256) {
    throw new AuthorityIntegrityError(`Command receipt hash mismatch at ${commandId}`);
  }
  const committedVersion = requiredInteger(row.committed_goal_version, "command_receipts.committed_goal_version");
  const committedSequence = requiredInteger(row.committed_event_sequence, "command_receipts.committed_event_sequence");
  const eventSequence = requiredInteger(row.event_sequence, "events.sequence");
  const eventSha256 = requiredText(row.event_sha256, "events.event_sha256");
  const eventType = requiredText(row.event_type, "events.event_type");
  if (!isPersistedCommandResult(parsed)
    || parsed.goalId !== goalId
    || parsed.goalVersion !== committedVersion
    || parsed.eventSequence !== committedSequence
    || parsed.eventSequence !== eventSequence
    || parsed.eventSha256 !== eventSha256
    || parsed.eventType !== eventType) {
    throw new AuthorityIntegrityError(`Command receipt result does not match its committed event at ${commandId}`);
  }
  return parsed;
}

export class AuthorityRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  storeMeta(): StoreMetaRow {
    const row = this.connection.prepare("SELECT store_id,store_generation,leader_epoch FROM store_meta WHERE singleton=1").get() as {
      store_id?: unknown; store_generation?: unknown; leader_epoch?: unknown;
    } | undefined;
    if (!row) throw new AuthorityIntegrityError("store_meta singleton is missing");
    return { storeId: String(row.store_id), storeGeneration: Number(row.store_generation), leaderEpoch: Number(row.leader_epoch) };
  }

  goal(goalId: string): GoalRow {
    const row = this.connection.prepare(`SELECT goal_id,workspace_id,origin_session_id,objective,objective_sha256,intent,requirement_profile,planning_depth,created_at_ms FROM goals WHERE goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityNotFoundError(`Goal ${goalId}`);
    return {
      goalId: String(row.goal_id), workspaceId: String(row.workspace_id), originSessionId: String(row.origin_session_id),
      objective: String(row.objective), objectiveSha256: String(row.objective_sha256), intent: String(row.intent) as GoalRow["intent"],
      requirementProfile: String(row.requirement_profile) as GoalRow["requirementProfile"], planningDepth: String(row.planning_depth) as GoalRow["planningDepth"],
      createdAtMs: Number(row.created_at_ms),
    };
  }

  goalForSession(workspaceId: string, originSessionId: string): GoalRow | null {
    const row = this.connection.prepare(`SELECT goal_id,workspace_id,origin_session_id,objective,objective_sha256,intent,requirement_profile,planning_depth,created_at_ms
      FROM goals WHERE workspace_id=? AND origin_session_id=? ORDER BY created_at_ms DESC, goal_id DESC LIMIT 1`)
      .get(workspaceId, originSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      goalId: String(row.goal_id), workspaceId: String(row.workspace_id), originSessionId: String(row.origin_session_id),
      objective: String(row.objective), objectiveSha256: String(row.objective_sha256), intent: String(row.intent) as GoalRow["intent"],
      requirementProfile: String(row.requirement_profile) as GoalRow["requirementProfile"], planningDepth: String(row.planning_depth) as GoalRow["planningDepth"],
      createdAtMs: Number(row.created_at_ms),
    };
  }

  goalVersion(goalId: string): number {
    const row = this.connection.prepare("SELECT COALESCE(MAX(sequence),0) AS version FROM events WHERE goal_id=?").get(goalId) as { version?: unknown } | undefined;
    return Number(row?.version ?? 0);
  }

  eventHead(goalId: string): { sequence: number; eventSha256: string | null } {
    const row = this.connection.prepare("SELECT sequence,event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1").get(goalId) as {
      sequence?: unknown; event_sha256?: unknown;
    } | undefined;
    return row ? { sequence: Number(row.sequence), eventSha256: String(row.event_sha256) } : { sequence: 0, eventSha256: null };
  }

  goalExists(goalId: string): boolean {
    const row = this.connection.prepare("SELECT count(*) AS count FROM goals WHERE goal_id=?").get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === 1;
  }

  insertWorkspace(input: { workspaceId: string; workspaceHmac: string; filesystemKind: string; localLockingVerified: boolean; createdAtMs: number }): void {
    this.connection.prepare("INSERT OR IGNORE INTO workspaces(workspace_id,workspace_hmac,filesystem_kind,local_locking_verified,created_at_ms) VALUES(?,?,?,?,?)")
      .run(input.workspaceId, input.workspaceHmac, input.filesystemKind, input.localLockingVerified ? 1 : 0, input.createdAtMs);
    const row = this.connection.prepare("SELECT workspace_hmac,filesystem_kind,local_locking_verified FROM workspaces WHERE workspace_id=?").get(input.workspaceId) as Record<string, unknown> | undefined;
    if (!row || row.workspace_hmac !== input.workspaceHmac || row.filesystem_kind !== input.filesystemKind || Number(row.local_locking_verified) !== (input.localLockingVerified ? 1 : 0)) {
      throw new AuthorityIntegrityError(`Workspace identity conflict for ${input.workspaceId}`);
    }
  }

  insertGoal(input: GoalRow): void {
    this.connection.prepare(`INSERT INTO goals(goal_id,workspace_id,origin_session_id,objective,objective_sha256,intent,requirement_profile,planning_depth,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(input.goalId, input.workspaceId, input.originSessionId, input.objective, input.objectiveSha256, input.intent, input.requirementProfile, input.planningDepth, input.createdAtMs);
  }

  commandResult(commandId: string, goalId: string, idempotencyKeySha256: string, commandSha256: string): PersistedCommandResult | null {
    const row = this.connection.prepare(`${commandReceiptProjection} WHERE cr.command_id=? AND cr.goal_id=? AND cr.idempotency_key_sha256=?`)
      .get(commandId, goalId, idempotencyKeySha256) as Record<string, unknown> | undefined;
    if (!row) return null;
    return decodeCommandReceipt(row, goalId, commandSha256);
  }

  appendEvent(event: StoredEvent & { actor: string; idempotencyKeySha256: string; occurredAtMs: number }): void {
    this.connection.prepare(`INSERT INTO events(event_id,goal_id,sequence,event_type,command_id,idempotency_key_sha256,actor,payload_json,payload_sha256,prev_event_sha256,event_sha256,store_generation,leader_epoch,occurred_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventId, event.goalId, event.sequence, event.eventType, event.commandId, event.idempotencyKeySha256, event.actor,
        event.payloadJson, event.payloadSha256, event.prevEventSha256, event.eventSha256, event.storeGeneration, event.leaderEpoch, event.occurredAtMs);
  }

  appendOutbox(input: { outboxId: string; goalId: string; topic: string; payloadJson: string; payloadSha256: string; sequence: number }): void {
    this.connection.prepare("INSERT INTO outbox(outbox_id,goal_id,topic,payload_json,payload_sha256,created_event_sequence,delivery_attempts) VALUES(?,?,?,?,?,?,0)")
      .run(input.outboxId, input.goalId, input.topic, input.payloadJson, input.payloadSha256, input.sequence);
  }

  appendCommandReceipt(input: {
    commandId: string; goalId: string; idempotencyKeySha256: string; commandSha256: string; expectedVersion: number; committedVersion: number;
    resultJson: string; resultSha256: string; eventSequence: number;
  }): void {
    this.connection.prepare(`INSERT INTO command_receipts(command_id,goal_id,idempotency_key_sha256,command_sha256,expected_goal_version,committed_goal_version,result_json,result_sha256,committed_event_sequence) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(input.commandId, input.goalId, input.idempotencyKeySha256, input.commandSha256, input.expectedVersion, input.committedVersion, input.resultJson, input.resultSha256, input.eventSequence);
  }

  events(goalId: string): StoredEvent[] {
    const rows = this.connection.prepare(`SELECT event_id,goal_id,sequence,event_type,command_id,payload_json,payload_sha256,prev_event_sha256,event_sha256,store_generation,leader_epoch FROM events WHERE goal_id=? ORDER BY sequence`).all(goalId) as Record<string, unknown>[];
    const store = this.storeMeta();
    return rows.map((row) => ({
      eventId: String(row.event_id), goalId: String(row.goal_id), sequence: Number(row.sequence), eventType: String(row.event_type),
      commandId: String(row.command_id), payloadJson: String(row.payload_json), payloadSha256: String(row.payload_sha256),
      prevEventSha256: row.prev_event_sha256 === null ? null : requiredText(row.prev_event_sha256, "events.prev_event_sha256"), eventSha256: String(row.event_sha256),
      storeId: store.storeId, storeGeneration: Number(row.store_generation), leaderEpoch: Number(row.leader_epoch),
    }));
  }

  commandReceiptCount(goalId: string): number {
    const row = this.connection.prepare("SELECT count(*) AS count FROM command_receipts WHERE goal_id=?").get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  verifyCommandReceipts(goalId: string): number {
    const rows = this.connection.prepare(`${commandReceiptProjection} WHERE cr.goal_id=? ORDER BY cr.committed_event_sequence`).all(goalId) as Record<string, unknown>[];
    for (const row of rows) decodeCommandReceipt(row, goalId);
    return rows.length;
  }

  lease(goalId: string): LeaseRow | null {
    const row = this.connection.prepare(`SELECT goal_id,owner_session_id,generation,fencing_token,acquired_at_ms,expires_at_ms,last_progress_event_sequence,row_version FROM execution_leases WHERE goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      goalId: String(row.goal_id), ownerSessionId: String(row.owner_session_id), generation: Number(row.generation), fencingToken: Number(row.fencing_token),
      acquiredAtMs: Number(row.acquired_at_ms), expiresAtMs: Number(row.expires_at_ms), lastProgressEventSequence: Number(row.last_progress_event_sequence),
      rowVersion: Number(row.row_version),
    };
  }

  insertLease(input: LeaseRow): void {
    this.connection.prepare(`INSERT INTO execution_leases(goal_id,owner_session_id,generation,fencing_token,acquired_at_ms,expires_at_ms,last_progress_event_sequence,row_version) VALUES(?,?,?,?,?,?,?,?)`)
      .run(input.goalId, input.ownerSessionId, input.generation, input.fencingToken, input.acquiredAtMs, input.expiresAtMs, input.lastProgressEventSequence, input.rowVersion);
  }

  replaceLease(previous: LeaseRow, next: LeaseRow): boolean {
    const result = this.connection.prepare(`UPDATE execution_leases SET owner_session_id=?,generation=?,fencing_token=?,acquired_at_ms=?,expires_at_ms=?,last_progress_event_sequence=?,row_version=? WHERE goal_id=? AND generation=? AND fencing_token=? AND row_version=?`)
      .run(next.ownerSessionId, next.generation, next.fencingToken, next.acquiredAtMs, next.expiresAtMs, next.lastProgressEventSequence,
        next.rowVersion, previous.goalId, previous.generation, previous.fencingToken, previous.rowVersion);
    return Number(result.changes) === 1;
  }

  integrity(): { integrity: string; foreignKeyFailures: number } {
    const integrity = this.connection.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    const foreignKeys = this.connection.prepare("PRAGMA foreign_key_check").all();
    return {
      integrity: requiredText(integrity?.integrity_check, "PRAGMA integrity_check"),
      foreignKeyFailures: foreignKeys.length,
    };
  }

  goalIds(): string[] {
    return (this.connection.prepare("SELECT goal_id FROM goals ORDER BY goal_id").all() as { goal_id?: unknown }[]).map((row) => String(row.goal_id));
  }
}
