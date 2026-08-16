import type { AuthorityConnection } from "../authority/database.js";
import { runImmediateTransaction } from "../authority/database.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError, AuthorityNotFoundError, LeaseConflictError, VersionConflictError } from "../foundation/errors.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";

export const SESSION_GOAL_BINDING_CUSTOM_TYPE = "pi-coding-harness.session-binding.v1";

export type SessionGoalBindingState = "BOUND" | "UNBOUND" | "TERMINAL";
export type SessionGoalBindingReason = "EXPLICIT_ENTRY" | "AUTO_RESUME" | "TRANSFER" | "TITLE_EDIT" | "EXIT" | "GOAL_TERMINAL";

export interface SessionGoalBindingV1 {
  readonly schemaVersion: 1;
  readonly bindingId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly state: SessionGoalBindingState;
  readonly autoResume: boolean;
  readonly goalTitle: string;
  readonly reasonCode: SessionGoalBindingReason;
  readonly predecessorReceiptSha256: string | null;
  readonly createdAtMs: number;
  readonly bindingReceiptSha256: string;
  readonly rowVersion: number;
}

export interface SessionGoalBindingMarkerV1 {
  readonly schema_version: 1;
  readonly binding_id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly session_id: string;
  readonly state: SessionGoalBindingState;
  readonly auto_resume: boolean;
  readonly goal_title: string;
  readonly binding_receipt_sha256: string;
}

export interface SessionGoalCandidateV1 {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  readonly state: SessionGoalBindingState;
  readonly goalTitle: string;
  readonly bindingReceiptSha256: string | null;
  readonly objective: string;
  readonly intent: "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
  readonly status: string;
  readonly nextActionCode: string;
  readonly controllerSessionId: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly leaseReleasedAtMs: number | null;
}

interface BindingMaterialV1 {
  readonly schema_version: 1;
  readonly binding_id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly session_id: string;
  readonly state: SessionGoalBindingState;
  readonly auto_resume: boolean;
  readonly goal_title: string;
  readonly reason_code: SessionGoalBindingReason;
  readonly predecessor_receipt_sha256: string | null;
  readonly created_at_ms: number;
}

function tableExists(connection: AuthorityConnection, tableName: string): boolean {
  const row = connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function assertBoundedText(value: string, name: string, maxLength: number): string {
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new TypeError(`${name} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function decodeBoolean(value: unknown, name: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new AuthorityIntegrityError(`Goal session binding ${name} is invalid`);
}

function decodeNullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new AuthorityIntegrityError(`Goal session binding ${name} is invalid`);
}

function decodeState(value: unknown): SessionGoalBindingState {
  if (value === "BOUND" || value === "UNBOUND" || value === "TERMINAL") return value;
  throw new AuthorityIntegrityError("Goal session binding state is invalid");
}

function decodeReason(value: unknown): SessionGoalBindingReason {
  if (value === "EXPLICIT_ENTRY" || value === "AUTO_RESUME" || value === "TRANSFER" || value === "TITLE_EDIT"
    || value === "EXIT" || value === "GOAL_TERMINAL") return value;
  throw new AuthorityIntegrityError("Goal session binding reason is invalid");
}

function material(input: Omit<SessionGoalBindingV1, "schemaVersion" | "bindingReceiptSha256" | "rowVersion">): BindingMaterialV1 {
  return {
    schema_version: 1,
    binding_id: input.bindingId,
    goal_id: input.goalId,
    workspace_id: input.workspaceId,
    revision: input.revision,
    session_id: input.sessionId,
    state: input.state,
    auto_resume: input.autoResume,
    goal_title: input.goalTitle,
    reason_code: input.reasonCode,
    predecessor_receipt_sha256: input.predecessorReceiptSha256,
    created_at_ms: input.createdAtMs,
  };
}

function decodeBinding(row: Record<string, unknown>): SessionGoalBindingV1 {
  const binding: SessionGoalBindingV1 = {
    schemaVersion: 1,
    bindingId: String(row.binding_id),
    goalId: String(row.goal_id),
    workspaceId: String(row.workspace_id),
    revision: Number(row.revision),
    sessionId: String(row.session_id),
    state: decodeState(row.state),
    autoResume: decodeBoolean(row.auto_resume, "auto_resume"),
    goalTitle: String(row.goal_title),
    reasonCode: decodeReason(row.reason_code),
    predecessorReceiptSha256: decodeNullableText(row.predecessor_receipt_sha256, "predecessor_receipt_sha256"),
    createdAtMs: Number(row.created_at_ms),
    bindingReceiptSha256: String(row.receipt_sha256),
    rowVersion: Number(row.row_version ?? row.revision),
  };
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1
    || !Number.isSafeInteger(binding.rowVersion) || binding.rowVersion < 1
    || !Number.isSafeInteger(binding.createdAtMs) || binding.createdAtMs < 0
    || !/^[a-f0-9]{64}$/u.test(binding.bindingReceiptSha256)
    || (binding.predecessorReceiptSha256 !== null && !/^[a-f0-9]{64}$/u.test(binding.predecessorReceiptSha256))) {
    throw new AuthorityIntegrityError("Goal session binding record is malformed");
  }
  assertBoundedText(binding.bindingId, "bindingId", 256);
  assertBoundedText(binding.goalId, "goalId", 256);
  assertBoundedText(binding.workspaceId, "workspaceId", 256);
  assertBoundedText(binding.sessionId, "sessionId", 256);
  assertBoundedText(binding.goalTitle, "goalTitle", 128);
  if ((binding.state === "BOUND") !== binding.autoResume) {
    throw new AuthorityIntegrityError("Goal session binding auto-resume state is inconsistent");
  }
  return binding;
}

const bindingColumns = `head.goal_id,head.workspace_id,head.revision,head.binding_id,head.session_id,head.state,
  head.auto_resume,head.goal_title,head.binding_receipt_sha256 AS receipt_sha256,head.row_version,
  revision.reason_code,revision.predecessor_receipt_sha256,revision.created_at_ms`;
const bindingFrom = `FROM goal_session_binding_heads_v1 head
JOIN goal_session_binding_revisions_v1 revision
  ON revision.goal_id=head.goal_id AND revision.revision=head.revision
  AND revision.binding_id=head.binding_id AND revision.receipt_sha256=head.binding_receipt_sha256
JOIN goals goal ON goal.goal_id=head.goal_id`;
const currentBindingProjection = `SELECT ${bindingColumns} ${bindingFrom}`;

export function deriveGoalTitle(objective: string): string {
  const normalized = assertBoundedText(objective, "objective", 100_000);
  const firstClause = normalized.split(/[.!?\n]|[。！？]/u, 1)[0]?.trim() || normalized;
  const codePoints = Array.from(firstClause);
  if (codePoints.length <= 64) return firstClause;
  return `${codePoints.slice(0, 61).join("")}...`;
}

export function toSessionGoalBindingMarker(binding: SessionGoalBindingV1): SessionGoalBindingMarkerV1 {
  return {
    schema_version: 1,
    binding_id: binding.bindingId,
    goal_id: binding.goalId,
    workspace_id: binding.workspaceId,
    revision: binding.revision,
    session_id: binding.sessionId,
    state: binding.state,
    auto_resume: binding.autoResume,
    goal_title: binding.goalTitle,
    binding_receipt_sha256: binding.bindingReceiptSha256,
  };
}

export function parseSessionGoalBindingMarker(value: unknown): SessionGoalBindingMarkerV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1 || typeof row.binding_id !== "string" || typeof row.goal_id !== "string"
    || typeof row.workspace_id !== "string" || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || typeof row.session_id !== "string" || (row.state !== "BOUND" && row.state !== "UNBOUND" && row.state !== "TERMINAL")
    || typeof row.auto_resume !== "boolean" || typeof row.goal_title !== "string"
    || typeof row.binding_receipt_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.binding_receipt_sha256)) return null;
  if ((row.state === "BOUND") !== row.auto_resume) return null;
  try {
    return {
      schema_version: 1,
      binding_id: assertBoundedText(row.binding_id, "binding_id", 256),
      goal_id: assertBoundedText(row.goal_id, "goal_id", 256),
      workspace_id: assertBoundedText(row.workspace_id, "workspace_id", 256),
      revision: Number(row.revision),
      session_id: assertBoundedText(row.session_id, "session_id", 256),
      state: row.state,
      auto_resume: row.auto_resume,
      goal_title: assertBoundedText(row.goal_title, "goal_title", 128),
      binding_receipt_sha256: row.binding_receipt_sha256,
    };
  } catch {
    return null;
  }
}

export class SessionGoalBindingRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "goal_session_binding_heads_v1");
  }

  currentForGoal(goalId: string): SessionGoalBindingV1 | null {
    if (!this.available()) return null;
    const row = this.connection.prepare(`${currentBindingProjection} WHERE head.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    return row ? decodeBinding(row) : null;
  }

  currentForSession(workspaceId: string, sessionId: string): SessionGoalBindingV1 | null {
    if (!this.available()) return null;
    const row = this.connection.prepare(`${currentBindingProjection}
      WHERE head.workspace_id=? AND head.session_id=? AND head.state='BOUND'`)
      .get(workspaceId, sessionId) as Record<string, unknown> | undefined;
    return row ? decodeBinding(row) : null;
  }

  recoverable(workspaceId: string): readonly SessionGoalCandidateV1[] {
    if (!this.available()) return [];
    const rows = this.connection.prepare(`SELECT ${bindingColumns},
      goal.goal_id AS candidate_goal_id,goal.workspace_id AS candidate_workspace_id,
      goal.objective,goal.intent,flow.status,flow.next_action_code,
      lease.expires_at_ms,lease.released_at_ms
      FROM goals goal
      JOIN task_flow_goal_heads_v1 flow ON flow.goal_id=goal.goal_id
      LEFT JOIN goal_session_binding_heads_v1 head ON head.goal_id=goal.goal_id
      LEFT JOIN goal_session_binding_revisions_v1 revision
        ON revision.goal_id=head.goal_id AND revision.revision=head.revision
        AND revision.binding_id=head.binding_id AND revision.receipt_sha256=head.binding_receipt_sha256
      LEFT JOIN execution_leases lease ON lease.goal_id=goal.goal_id
      WHERE goal.workspace_id=? AND flow.status NOT IN ('SUCCEEDED','FAILED','CANCELED')
      ORDER BY CASE head.state WHEN 'BOUND' THEN 0 ELSE 1 END,
        COALESCE(head.updated_at_ms,goal.created_at_ms) DESC,goal.goal_id`)
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => {
      const objective = String(row.objective);
      const binding = row.binding_id === null ? null : decodeBinding(row);
      return {
        goalId: String(row.candidate_goal_id),
        workspaceId: String(row.candidate_workspace_id),
        sessionId: binding?.sessionId ?? null,
        state: binding?.state ?? "UNBOUND",
        goalTitle: binding?.goalTitle ?? deriveGoalTitle(objective),
        bindingReceiptSha256: binding?.bindingReceiptSha256 ?? null,
        objective,
        intent: String(row.intent) as SessionGoalCandidateV1["intent"],
        status: String(row.status),
        nextActionCode: String(row.next_action_code),
        controllerSessionId: binding?.state === "BOUND" ? binding.sessionId : null,
        leaseExpiresAtMs: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
        leaseReleasedAtMs: row.released_at_ms === null ? null : Number(row.released_at_ms),
      };
    });
  }

  transition(input: {
    readonly goalId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly state: SessionGoalBindingState;
    readonly goalTitle: string;
    readonly reasonCode: SessionGoalBindingReason;
    readonly expectedReceiptSha256: string | null;
    readonly nowMs: number;
  }): SessionGoalBindingV1 {
    if (!this.available()) throw new AuthorityIntegrityError("Goal session binding schema is unavailable");
    const goalId = assertBoundedText(input.goalId, "goalId", 256);
    const workspaceId = assertBoundedText(input.workspaceId, "workspaceId", 256);
    const sessionId = assertBoundedText(input.sessionId, "sessionId", 256);
    const goalTitle = assertBoundedText(input.goalTitle, "goalTitle", 128);
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new TypeError("nowMs must be a non-negative integer");
    return runImmediateTransaction(this.connection, () => {
      const goal = this.connection.prepare("SELECT workspace_id FROM goals WHERE goal_id=?").get(goalId) as Record<string, unknown> | undefined;
      if (!goal) throw new AuthorityNotFoundError(goalId);
      if (goal.workspace_id !== workspaceId) throw new AuthorityIntegrityError("Goal session binding workspace mismatch");
      const current = this.currentForGoal(goalId);
      if ((current?.bindingReceiptSha256 ?? null) !== input.expectedReceiptSha256) {
        throw new VersionConflictError(input.expectedReceiptSha256 === null ? 0 : -1, current?.revision ?? 0);
      }
      const autoResume = input.state === "BOUND";
      if (current && current.sessionId === sessionId && current.state === input.state
        && current.goalTitle === goalTitle && current.autoResume === autoResume) return current;
      if (!current && input.reasonCode !== "EXPLICIT_ENTRY") {
        throw new AuthorityIntegrityError("Initial Goal session binding requires explicit entry");
      }
      if (input.reasonCode === "EXIT" && (input.state !== "UNBOUND" || current?.sessionId !== sessionId)) {
        throw new AuthorityIntegrityError("Goal session exit must unbind its current controlling session");
      }
      if (input.reasonCode === "TRANSFER" && (input.state !== "BOUND" || current === null || current.sessionId === sessionId)) {
        throw new AuthorityIntegrityError("Goal session transfer requires a different current controlling session");
      }
      if (current && current.sessionId !== sessionId && input.state === "BOUND" && input.reasonCode !== "TRANSFER") {
        throw new LeaseConflictError(`Goal ${goalId} is bound to another session`);
      }
      const revision = (current?.revision ?? 0) + 1;
      const predecessorReceiptSha256 = current?.bindingReceiptSha256 ?? null;
      const bindingId = idFromSha256("GOAL_BINDING", sha256Hex([
        goalId, workspaceId, String(revision), sessionId, input.state, predecessorReceiptSha256 ?? "ROOT",
      ].join("\0")));
      const base = {
        bindingId,
        goalId,
        workspaceId,
        revision,
        sessionId,
        state: input.state,
        autoResume,
        goalTitle,
        reasonCode: input.reasonCode,
        predecessorReceiptSha256,
        createdAtMs: input.nowMs,
      } as const;
      const bindingReceiptSha256 = canonicalJsonSha256(material(base));
      const rowVersion = (current?.rowVersion ?? 0) + 1;
      try {
        this.connection.prepare(`INSERT INTO goal_session_binding_revisions_v1(
          binding_id,goal_id,workspace_id,revision,session_id,state,auto_resume,goal_title,reason_code,
          predecessor_receipt_sha256,created_at_ms,receipt_sha256
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          bindingId, goalId, workspaceId, revision, sessionId, input.state, autoResume ? 1 : 0, goalTitle,
          input.reasonCode, predecessorReceiptSha256, input.nowMs, bindingReceiptSha256,
        );
        if (!current) {
          this.connection.prepare(`INSERT INTO goal_session_binding_heads_v1(
            goal_id,workspace_id,revision,binding_id,session_id,state,auto_resume,goal_title,
            binding_receipt_sha256,row_version,updated_at_ms
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
            goalId, workspaceId, revision, bindingId, sessionId, input.state, autoResume ? 1 : 0, goalTitle,
            bindingReceiptSha256, rowVersion, input.nowMs,
          );
        } else {
          const result = this.connection.prepare(`UPDATE goal_session_binding_heads_v1 SET
            revision=?,binding_id=?,session_id=?,state=?,auto_resume=?,goal_title=?,binding_receipt_sha256=?,
            row_version=?,updated_at_ms=? WHERE goal_id=? AND row_version=? AND binding_receipt_sha256=?`).run(
            revision, bindingId, sessionId, input.state, autoResume ? 1 : 0, goalTitle, bindingReceiptSha256,
            rowVersion, input.nowMs, goalId, current.rowVersion, current.bindingReceiptSha256,
          );
          if (Number(result.changes) !== 1) throw new VersionConflictError(current.rowVersion, rowVersion);
        }
      } catch (error) {
        if (error instanceof AuthorityIntegrityError || error instanceof LeaseConflictError || error instanceof VersionConflictError) throw error;
        if (error instanceof Error && /ux_goal_session_binding_active_session|unique constraint failed/iu.test(error.message)) {
          throw new LeaseConflictError(`Session ${sessionId} already controls another Goal`);
        }
        throw error;
      }
      return { schemaVersion: 1, ...base, bindingReceiptSha256, rowVersion };
    });
  }

  validateMarker(marker: SessionGoalBindingMarkerV1, expectedWorkspaceId: string, expectedSessionId: string): SessionGoalBindingV1 {
    const current = this.currentForGoal(marker.goal_id);
    if (!current || current.workspaceId !== expectedWorkspaceId || current.sessionId !== expectedSessionId
      || current.state !== "BOUND" || !current.autoResume || current.bindingId !== marker.binding_id
      || current.revision !== marker.revision || current.bindingReceiptSha256 !== marker.binding_receipt_sha256) {
      throw new AuthorityIntegrityError("Session Goal binding marker does not match current authority");
    }
    return current;
  }

  verifyIntegrity(): { readonly revisions: number; readonly heads: number } {
    if (!this.available()) return { revisions: 0, heads: 0 };
    const rows = this.connection.prepare(`SELECT revision.*, revision.receipt_sha256, revision.revision AS row_version
      FROM goal_session_binding_revisions_v1 revision ORDER BY revision.goal_id,revision.revision`).all() as Record<string, unknown>[];
    let previousGoalId: string | null = null;
    let previousReceipt: string | null = null;
    for (const row of rows) {
      const binding = decodeBinding(row);
      if (binding.goalId !== previousGoalId) previousReceipt = null;
      if (binding.predecessorReceiptSha256 !== previousReceipt
        || canonicalJsonSha256(material(binding)) !== binding.bindingReceiptSha256) {
        throw new AuthorityIntegrityError(`Goal session binding receipt chain is invalid for ${binding.goalId}`);
      }
      previousGoalId = binding.goalId;
      previousReceipt = binding.bindingReceiptSha256;
    }
    const heads = this.connection.prepare(`${currentBindingProjection} ORDER BY head.goal_id`).all() as Record<string, unknown>[];
    for (const row of heads) {
      const binding = decodeBinding(row);
      if (binding.rowVersion !== binding.revision) {
        throw new AuthorityIntegrityError(`Goal session binding head version is invalid for ${binding.goalId}`);
      }
    }
    return { revisions: rows.length, heads: heads.length };
  }
}
