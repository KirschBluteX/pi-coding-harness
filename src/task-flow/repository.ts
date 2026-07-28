import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { sha256Hex } from "../foundation/crypto.js";
import {
  assertEvidenceAttestation,
  assertGoalContract,
  assertOperationAttempt,
  assertOperationReconcileLocator,
  assertOperationTransition,
  assertRouteHealth,
  assertRouteSkeleton,
  type DeliverableManifestRecord,
  type EvidenceAttestationRecord,
  type ExecutionAuthorizationRecord,
  type GoalContractRecord,
  type OperationAttemptRecord,
  type OperationReconcileLocatorRecord,
  type OperationState,
  type OperationTransitionRecord,
  type RouteHealthRecord,
  type RouteSkeletonRecord,
  type TaskFlowIntent,
  type TaskFlowLane,
  assertTaskDecisionEntry,
  type TaskDecisionEntryRecord,
  type WorkCellRecord,
  type WorkCellStatus,
  type WorkspaceBaselineRecord,
} from "./domain.js";
import { requiresWorkspaceMutation } from "./admission.js";
import { assertAcceptanceLedger, type AcceptanceLedgerRecord } from "./acceptance-ledger.js";

export interface TaskFlowCurrentView {
  readonly goalId: string;
  readonly intent: TaskFlowIntent;
  readonly lane: TaskFlowLane;
  readonly status: "CONTRACTING" | "PLANNING" | "WAITING_USER" | "BUILDING" | "RECONCILING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  readonly nextActionCode: string;
  readonly contract: GoalContractRecord | null;
  readonly route: RouteSkeletonRecord | null;
  readonly workCellId: string | null;
  readonly workCellStatus: WorkCellStatus | null;
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly unresolvedOperationIds: readonly string[];
  readonly latestHealth: RouteHealthRecord | null;
}

export interface TaskFlowIntegritySummary {
  readonly available: boolean;
  readonly contracts: number;
  readonly routes: number;
  readonly workCells: number;
  readonly operations: number;
  readonly evidence: number;
  readonly headMismatches: number;
  readonly multipleRunningGoals: number;
  readonly unresolvedOperations: number;
}

export interface ActiveTaskFlowGoal {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly originSessionId: string;
  readonly objective: string;
  readonly objectiveSha256: string;
  readonly acceptanceFacetMinimum: number;
  readonly version: number;
}

export interface TaskFlowOperationSnapshot {
  readonly attempt: OperationAttemptRecord;
  readonly state: OperationState;
  readonly ordinal: number;
  readonly transitionSha256: string;
  readonly outputSha256: string | null;
  readonly readbackSha256: string | null;
  readonly failureSignatureSha256: string | null;
  readonly postcondition: OperationTransitionRecord["postcondition"];
  readonly reconcileLocator: OperationReconcileLocatorRecord | null;
}

export interface TaskFlowAuthorizationFence {
  readonly leaseGeneration: number;
  readonly fencingToken: number;
  readonly nowMs: number;
}

interface HeadRow {
  readonly contract_id?: unknown;
  readonly route_id?: unknown;
  readonly work_cell_id?: unknown;
  readonly status?: unknown;
}

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(table) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`${label} is not JSON text`);
  try { return JSON.parse(value) as T; }
  catch (error) { throw new AuthorityIntegrityError(`${label} is invalid JSON`, error); }
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_:-]{0,159}$/u.test(value)) throw new AuthorityIntegrityError(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new AuthorityIntegrityError(`${label} is invalid`);
  return value;
}

function recordHash(domain: string, value: object, field = "record_sha256"): string {
  return canonicalJsonSha256({ domain, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)) });
}

function assertStoredHash(domain: string, value: object, field = "record_sha256"): void {
  const row = value as Record<string, unknown>;
  if (row[field] !== recordHash(domain, value, field)) throw new AuthorityIntegrityError(`${domain} canonical hash mismatch`);
}

export class TaskFlowRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "goal_contract_versions_v1") && tableExists(this.connection, "operation_transitions_v1");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Task Flow migration 011 is not available");
  }

  assertMutableGoal(goalId: string): void {
    this.assertAvailable();
    const head = this.connection.prepare("SELECT status FROM task_flow_goal_heads_v1 WHERE goal_id=?")
      .get(goalId) as { status?: unknown } | undefined;
    if (!head) throw new AuthorityIntegrityError("Task Flow Goal head does not exist");
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(String(head.status))) {
      throw new AuthorityIntegrityError("Terminal Task Flow Goal cannot accept a new mutation");
    }
  }

  activateGoal(input: {
    readonly goalId: string;
    readonly intent: TaskFlowIntent;
    readonly lane: TaskFlowLane;
    readonly sourceIntakeSha256: string;
    readonly activationSha256: string;
    readonly nowMs: number;
  }): boolean {
    this.assertAvailable();
    const owner = this.connection.prepare(`SELECT g.goal_id FROM goals g
      JOIN task_flow_goal_heads_v1 h ON h.goal_id=g.goal_id
      WHERE g.workspace_id=(SELECT workspace_id FROM goals WHERE goal_id=?)
        AND g.goal_id<>? AND h.status NOT IN ('SUCCEEDED','FAILED','CANCELED') LIMIT 1`)
      .get(input.goalId, input.goalId) as { goal_id?: unknown } | undefined;
    if (owner?.goal_id !== undefined) {
      throw new AuthorityIntegrityError(`Workspace already has active Task Flow Goal ${boundedId(owner.goal_id, "goal_id")}`);
    }
    const result = this.connection.prepare(`INSERT INTO task_flow_modes_v1(
      goal_id,intent,lane,source_intake_sha256,activation_sha256,created_at_ms
    ) VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id) DO NOTHING`).run(
      input.goalId, input.intent, input.lane, input.sourceIntakeSha256, input.activationSha256, input.nowMs,
    );
    if (Number(result.changes) === 0) {
      const current = this.connection.prepare("SELECT intent,lane,source_intake_sha256,activation_sha256 FROM task_flow_modes_v1 WHERE goal_id=?").get(input.goalId) as Record<string, unknown> | undefined;
      if (!current || current.intent !== input.intent || current.lane !== input.lane || current.source_intake_sha256 !== input.sourceIntakeSha256 || current.activation_sha256 !== input.activationSha256) {
        throw new AuthorityIntegrityError("Task Flow activation idempotency conflict");
      }
      return true;
    } else {
      this.connection.prepare("INSERT INTO task_flow_goal_heads_v1(goal_id,status,next_action_code,current_contract_id,current_route_id,current_work_cell_id,updated_event_sequence) VALUES(?,?,?,?,?,?,?)")
        .run(input.goalId, "CONTRACTING", "SUBMIT_CONTRACT", null, null, null, 1);
    }
    return false;
  }

  insertIntakeEvidence(input: {
    readonly goalId: string;
    readonly sourceIntakeSha256: string;
    readonly sourceText: string;
    readonly fidelity: "EXACT" | "LEGACY_HASH_ONLY";
    readonly eventSequence: number;
  }): void {
    const contentSha256 = sha256Hex(input.sourceText);
    if (input.fidelity === "EXACT" && contentSha256 !== input.sourceIntakeSha256) {
      throw new AuthorityIntegrityError("Exact intake evidence does not match source_intake_sha256");
    }
    this.connection.prepare(`INSERT INTO task_flow_intake_evidence_v1(
      goal_id,source_intake_sha256,source_content_sha256,source_text,fidelity,created_event_sequence
    ) VALUES(?,?,?,?,?,?)`).run(
      input.goalId, input.sourceIntakeSha256, contentSha256, input.sourceText, input.fidelity, input.eventSequence,
    );
  }

  intakeEvidence(goalId: string): {
    readonly sourceText: string;
    readonly fidelity: "EXACT" | "LEGACY_HASH_ONLY";
  } {
    const row = this.connection.prepare("SELECT source_text,fidelity FROM task_flow_intake_evidence_v1 WHERE goal_id=?")
      .get(goalId) as { source_text?: unknown; fidelity?: unknown } | undefined;
    if (!row || typeof row.source_text !== "string" || !["EXACT", "LEGACY_HASH_ONLY"].includes(String(row.fidelity))) {
      throw new AuthorityIntegrityError("Task Flow intake evidence is missing or invalid");
    }
    return { sourceText: row.source_text, fidelity: row.fidelity as "EXACT" | "LEGACY_HASH_ONLY" };
  }

  insertContract(contract: GoalContractRecord, acceptanceLedger: AcceptanceLedgerRecord, eventSequence: number): boolean {
    this.assertAvailable();
    assertGoalContract(contract);
    assertAcceptanceLedger(acceptanceLedger, contract);
    const existing = this.connection.prepare("SELECT record_sha256 FROM goal_contract_versions_v1 WHERE contract_id=?").get(contract.contract_id) as { record_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.record_sha256 !== contract.record_sha256) throw new AuthorityIntegrityError("GoalContract ID substitution");
      return true;
    }
    const head = this.connection.prepare("SELECT contract_id,version FROM goal_contract_heads_v1 WHERE goal_id=?").get(contract.goal_id) as { contract_id?: unknown; version?: unknown } | undefined;
    if (contract.version === 1) {
      if (head) throw new AuthorityIntegrityError("Initial GoalContract already exists");
    } else if (!head || head.contract_id !== contract.parent_contract_id || Number(head.version) + 1 !== contract.version) {
      throw new AuthorityIntegrityError("GoalContract revision does not extend the current head");
    }
    if (head) {
      const routeHead = this.connection.prepare("SELECT route_id FROM route_skeleton_heads_v1 WHERE goal_id=?").get(contract.goal_id) as { route_id?: unknown } | undefined;
      if (routeHead?.route_id !== undefined) {
        this.invalidateRouteHead(boundedId(routeHead.route_id, "route_id"), eventSequence, contract.created_at_ms);
      }
      this.connection.prepare("DELETE FROM route_skeleton_heads_v1 WHERE goal_id=?").run(contract.goal_id);
    }
    const obligationSetSha256 = canonicalJsonSha256(contract.obligations.map((entry) => entry.record_sha256));
    this.connection.prepare(`INSERT INTO goal_contract_versions_v1(
      contract_id,goal_id,version,parent_contract_id,intent,lane,objective,contract_json,
      obligation_set_sha256,source_intake_sha256,authorization_ceiling,record_sha256,
      created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      contract.contract_id, contract.goal_id, contract.version, contract.parent_contract_id,
      contract.intent, contract.lane, contract.objective, canonicalJson(contract),
      obligationSetSha256, contract.source_intake_sha256, contract.authorization_ceiling,
      contract.record_sha256, contract.created_at_ms, eventSequence,
    );
    const insertObligation = this.connection.prepare(`INSERT INTO task_obligations_v1(
      obligation_id,contract_id,goal_id,semantic_key,priority,statement,oracle_json,
      dependencies_json,record_sha256,ordinal
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const obligation of contract.obligations) insertObligation.run(
      obligation.obligation_id, obligation.contract_id, obligation.goal_id,
      obligation.semantic_key, obligation.priority, obligation.statement,
      canonicalJson(obligation.oracle), canonicalJson(obligation.dependencies),
      obligation.record_sha256, obligation.ordinal,
    );
    this.connection.prepare(`INSERT INTO acceptance_ledgers_v1(
      ledger_id,goal_id,contract_id,source_intake_sha256,source_content_sha256,
      source_fidelity,source_length,ledger_json,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      acceptanceLedger.ledger_id, acceptanceLedger.goal_id, acceptanceLedger.contract_id,
      acceptanceLedger.source_intake_sha256, acceptanceLedger.source_content_sha256,
      acceptanceLedger.source_fidelity, acceptanceLedger.source_length,
      canonicalJson(acceptanceLedger), acceptanceLedger.record_sha256,
      eventSequence,
    );
    this.connection.prepare(`INSERT INTO goal_contract_heads_v1(goal_id,contract_id,version,contract_sha256,updated_event_sequence)
      VALUES(?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET contract_id=excluded.contract_id,
      version=excluded.version,contract_sha256=excluded.contract_sha256,updated_event_sequence=excluded.updated_event_sequence`).run(
      contract.goal_id, contract.contract_id, contract.version, contract.record_sha256, eventSequence,
    );
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status='PLANNING',next_action_code='SUBMIT_ROUTE',current_contract_id=?,current_route_id=NULL,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
      .run(contract.contract_id, eventSequence, contract.goal_id);
    return false;
  }

  acceptanceLedger(contractId: string): AcceptanceLedgerRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT ledger_json FROM acceptance_ledgers_v1 WHERE contract_id=?")
      .get(contractId) as { ledger_json?: unknown } | undefined;
    if (!row || typeof row.ledger_json !== "string") return null;
    const value = JSON.parse(row.ledger_json) as AcceptanceLedgerRecord;
    const contractRow = this.connection.prepare("SELECT contract_json FROM goal_contract_versions_v1 WHERE contract_id=?")
      .get(contractId) as { contract_json?: unknown } | undefined;
    if (!contractRow || typeof contractRow.contract_json !== "string") throw new AuthorityIntegrityError("AcceptanceLedger contract is missing");
    const contract = JSON.parse(contractRow.contract_json) as GoalContractRecord;
    assertGoalContract(contract);
    assertAcceptanceLedger(value, contract);
    return value;
  }

  insertRoute(route: RouteSkeletonRecord, contract: GoalContractRecord, eventSequence: number): boolean {
    this.assertAvailable();
    assertRouteSkeleton(route, contract);
    const existing = this.connection.prepare("SELECT record_sha256 FROM route_skeleton_versions_v1 WHERE route_id=?").get(route.route_id) as { record_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.record_sha256 !== route.record_sha256) throw new AuthorityIntegrityError("RouteSkeleton ID substitution");
      return true;
    }
    const goalHead = this.connection.prepare("SELECT status,next_action_code FROM task_flow_goal_heads_v1 WHERE goal_id=?").get(route.goal_id) as Record<string, unknown> | undefined;
    if (goalHead?.status !== "PLANNING" || goalHead.next_action_code !== "SUBMIT_ROUTE") {
      throw new AuthorityIntegrityError("RouteSkeleton submission requires the current SUBMIT_ROUTE planning boundary");
    }
    const contractHead = this.connection.prepare("SELECT contract_id FROM goal_contract_heads_v1 WHERE goal_id=?").get(route.goal_id) as { contract_id?: unknown } | undefined;
    if (contractHead?.contract_id !== route.contract_id) throw new AuthorityIntegrityError("RouteSkeleton is not bound to the current GoalContract");
    const head = this.connection.prepare("SELECT route_id,revision FROM route_skeleton_heads_v1 WHERE goal_id=?").get(route.goal_id) as { route_id?: unknown; revision?: unknown } | undefined;
    const latest = this.connection.prepare("SELECT route_id,revision FROM route_skeleton_versions_v1 WHERE goal_id=? ORDER BY revision DESC LIMIT 1").get(route.goal_id) as { route_id?: unknown; revision?: unknown } | undefined;
    const predecessor = head ?? latest;
    if (route.revision === 1) {
      if (predecessor) throw new AuthorityIntegrityError("Initial RouteSkeleton already exists");
    } else if (!predecessor || predecessor.route_id !== route.parent_route_id || Number(predecessor.revision) + 1 !== route.revision) {
      throw new AuthorityIntegrityError("RouteSkeleton revision does not extend the latest persisted route");
    }
    this.connection.prepare(`INSERT INTO route_skeleton_versions_v1(
      route_id,goal_id,contract_id,revision,parent_route_id,lane,route_json,
      acceptance_coverage_sha256,assumptions_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      route.route_id, route.goal_id, route.contract_id, route.revision, route.parent_route_id,
      route.lane, canonicalJson(route), canonicalJsonSha256(route.acceptance_coverage),
      canonicalJsonSha256(route.assumptions), route.record_sha256, route.created_at_ms, eventSequence,
    );
    const insertCell = this.connection.prepare(`INSERT INTO work_cells_v1(
      work_cell_id,goal_id,contract_id,route_id,logical_key,ordinal,horizon,outcome,
      obligation_ids_json,read_roots_json,write_roots_json,effect_classes_json,oracle_json,
      risk,reversible,budget_json,spec_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertHead = this.connection.prepare("INSERT INTO work_cell_heads_v1(work_cell_id,goal_id,route_id,status,attempt_count,last_progress_sha256,updated_event_sequence) VALUES(?,?,?,?,0,NULL,?)");
    for (const cell of route.work_cells) {
      insertCell.run(cell.work_cell_id, cell.goal_id, cell.contract_id, cell.route_id,
        cell.logical_key, cell.ordinal, cell.horizon, cell.outcome,
        canonicalJson(cell.obligation_ids), canonicalJson(cell.read_roots), canonicalJson(cell.write_roots),
        canonicalJson(cell.effect_classes), canonicalJson(cell.oracle), cell.risk, cell.reversible ? 1 : 0,
        canonicalJson(cell.budget), cell.spec_sha256, eventSequence);
      insertHead.run(cell.work_cell_id, cell.goal_id, cell.route_id, cell.dependencies.length === 0 ? "READY" : "PROPOSED", eventSequence);
    }
    const insertDependency = this.connection.prepare("INSERT INTO work_cell_dependencies_v1(route_id,work_cell_id,depends_on_work_cell_id) VALUES(?,?,?)");
    for (const cell of route.work_cells) for (const dependency of cell.dependencies) insertDependency.run(route.route_id, cell.work_cell_id, dependency);
    if (head) this.invalidateRouteHead(String(head.route_id), eventSequence, route.created_at_ms);
    this.connection.prepare(`INSERT INTO route_skeleton_heads_v1(goal_id,route_id,revision,route_sha256,health,updated_event_sequence)
      VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET route_id=excluded.route_id,revision=excluded.revision,
      route_sha256=excluded.route_sha256,health=excluded.health,updated_event_sequence=excluded.updated_event_sequence`).run(
      route.goal_id, route.route_id, route.revision, route.record_sha256, "HEALTHY", eventSequence,
    );
    const intent = this.connection.prepare("SELECT intent FROM task_flow_modes_v1 WHERE goal_id=?").get(route.goal_id) as { intent?: unknown } | undefined;
    const waiting = intent?.intent === "PLAN";
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code=?,current_route_id=?,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
      .run(waiting ? "WAITING_USER" : "BUILDING", waiting ? "PLAN_CONTINUATION" : "AUTHORIZE_WORK", route.route_id, eventSequence, route.goal_id);
    return false;
  }

  private invalidateRouteHead(routeId: string, eventSequence: number, nowMs: number): void {
    this.connection.prepare("UPDATE work_cell_heads_v1 SET status='INVALIDATED',updated_event_sequence=? WHERE route_id=? AND status NOT IN ('SUCCEEDED','FAILED','INVALIDATED')").run(eventSequence, routeId);
    this.connection.prepare("UPDATE execution_authorizations_v1 SET revoked_at_ms=? WHERE route_id=? AND revoked_at_ms IS NULL").run(nowMs, routeId);
  }

  insertBaseline(record: WorkspaceBaselineRecord, eventSequence: number): boolean {
    this.assertAvailable();
    for (const value of [record.filesystem_identity_hmac, record.content_root_sha256, record.environment_sha256, record.oracle_set_sha256, record.record_sha256]) sha(value, "WorkspaceBaseline hash");
    assertStoredHash("PCH-WORKSPACE-BASELINE-V1", record);
    const result = this.connection.prepare(`INSERT INTO workspace_baselines_v1(
      baseline_id,workspace_id,goal_id,filesystem_identity_hmac,content_root_sha256,
      environment_sha256,oracle_set_sha256,scope_manifest_json,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(baseline_id) DO NOTHING`).run(
      record.baseline_id, record.workspace_id, record.goal_id, record.filesystem_identity_hmac,
      record.content_root_sha256, record.environment_sha256, record.oracle_set_sha256,
      canonicalJson(record.scope_manifest), record.record_sha256, record.created_at_ms, eventSequence,
    );
    if (Number(result.changes) === 0) {
      const current = this.connection.prepare("SELECT record_sha256 FROM workspace_baselines_v1 WHERE baseline_id=?").get(record.baseline_id) as { record_sha256?: unknown } | undefined;
      if (current?.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("WorkspaceBaseline ID substitution");
      return true;
    }
    return false;
  }

  authorize(record: ExecutionAuthorizationRecord, eventSequence: number): boolean {
    this.assertAvailable();
    assertStoredHash("PCH-EXECUTION-AUTHORIZATION-V1", record);
    const existing = this.connection.prepare("SELECT record_sha256 FROM execution_authorizations_v1 WHERE authorization_id=?").get(record.authorization_id) as { record_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("ExecutionAuthorization ID substitution");
      return true;
    }
    const current = this.connection.prepare("SELECT route_id FROM route_skeleton_heads_v1 WHERE goal_id=?").get(record.goal_id) as { route_id?: unknown } | undefined;
    const cell = this.connection.prepare("SELECT status,route_id FROM work_cell_heads_v1 WHERE work_cell_id=? AND goal_id=?").get(record.work_cell_id, record.goal_id) as { status?: unknown; route_id?: unknown } | undefined;
    if (current?.route_id !== record.route_id || cell?.route_id !== record.route_id || !["READY", "REPAIRING"].includes(String(cell.status))) throw new AuthorityIntegrityError("WorkCell is not eligible for authorization");
    const unresolved = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get(record.goal_id) as { count?: unknown } | undefined)?.count ?? 0);
    if (unresolved > 0) throw new AuthorityIntegrityError("ExecutionAuthorization requires zero unresolved operations");
    this.connection.prepare(`INSERT INTO execution_authorizations_v1(
      authorization_id,goal_id,contract_id,route_id,work_cell_id,baseline_id,lease_generation,
      fencing_token,effect_ceiling,decision_closure_sha256,allowed_scope_sha256,expires_at_ms,
      record_sha256,created_at_ms,revoked_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(
      record.authorization_id, record.goal_id, record.contract_id, record.route_id, record.work_cell_id,
      record.baseline_id, record.lease_generation, record.fencing_token, record.effect_ceiling,
      record.decision_closure_sha256, record.allowed_scope_sha256, record.expires_at_ms,
      record.record_sha256, record.created_at_ms, eventSequence,
    );
    this.transitionWorkCell(record.work_cell_id, String(cell.status) as WorkCellStatus, "RUNNING", eventSequence);
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status='BUILDING',next_action_code='EXECUTE_WORK',current_work_cell_id=?,updated_event_sequence=? WHERE goal_id=?")
      .run(record.work_cell_id, eventSequence, record.goal_id);
    return false;
  }

  revokeAuthorization(goalId: string, nowMs: number): void {
    this.assertAvailable();
    this.connection.prepare("UPDATE execution_authorizations_v1 SET revoked_at_ms=? WHERE goal_id=? AND revoked_at_ms IS NULL").run(nowMs, goalId);
  }

  openContractRevision(goalId: string, eventSequence: number, nowMs: number): void {
    this.assertAvailable();
    const head = this.connection.prepare(
      "SELECT status,current_contract_id,current_work_cell_id FROM task_flow_goal_heads_v1 WHERE goal_id=?",
    ).get(goalId) as Record<string, unknown> | undefined;
    if (!head || head.current_contract_id === null) {
      throw new AuthorityIntegrityError("GoalContract revision requires a frozen contract");
    }
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(String(head.status))) {
      throw new AuthorityIntegrityError("Terminal Goal cannot open a GoalContract revision");
    }
    this.revokeAuthorization(goalId, nowMs);
    if (head.current_work_cell_id !== null) {
      this.connection.prepare(`UPDATE work_cell_heads_v1
        SET status='WAITING_USER',updated_event_sequence=?
        WHERE work_cell_id=? AND status IN ('RUNNING','REPAIRING','READY')`)
        .run(eventSequence, boundedId(head.current_work_cell_id, "work_cell_id"));
    }
    this.connection.prepare(`UPDATE task_flow_goal_heads_v1
      SET status='CONTRACTING',next_action_code='SUBMIT_CONTRACT',current_work_cell_id=NULL,updated_event_sequence=?
      WHERE goal_id=?`).run(eventSequence, goalId);
  }

  transitionWorkCell(workCellId: string, expected: WorkCellStatus, next: WorkCellStatus, eventSequence: number, progressSha256: string | null = null): void {
    const result = this.connection.prepare(`UPDATE work_cell_heads_v1 SET status=?,attempt_count=attempt_count+CASE WHEN ?='RUNNING' THEN 1 ELSE 0 END,
      last_progress_sha256=COALESCE(?,last_progress_sha256),updated_event_sequence=? WHERE work_cell_id=? AND status=?`).run(
      next, next, progressSha256, eventSequence, workCellId, expected,
    );
    if (Number(result.changes) !== 1) throw new AuthorityIntegrityError(`WorkCell transition ${expected} -> ${next} lost its expected head`);
    if (next === "SUCCEEDED") {
      const route = this.connection.prepare("SELECT route_id FROM work_cells_v1 WHERE work_cell_id=?").get(workCellId) as { route_id?: unknown } | undefined;
      this.connection.prepare(`UPDATE work_cell_heads_v1 SET status='READY',updated_event_sequence=?
        WHERE route_id=? AND status='PROPOSED' AND NOT EXISTS(
          SELECT 1 FROM work_cell_dependencies_v1 d JOIN work_cell_heads_v1 h ON h.work_cell_id=d.depends_on_work_cell_id
          WHERE d.work_cell_id=work_cell_heads_v1.work_cell_id AND h.status<>'SUCCEEDED'
        )`).run(eventSequence, route?.route_id === undefined ? null : boundedId(route.route_id, "route_id"));
      const goal = this.connection.prepare("SELECT goal_id FROM work_cells_v1 WHERE work_cell_id=?").get(workCellId) as { goal_id?: unknown } | undefined;
      if (goal?.goal_id !== undefined) this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET next_action_code='AUTHORIZE_WORK',current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
        .run(eventSequence, boundedId(goal.goal_id, "goal_id"));
    }
  }

  completeWorkCell(goalId: string, workCellId: string, progressSha256: string, eventSequence: number, nowMs: number): void {
    this.assertAvailable();
    sha(progressSha256, "WorkCell completion summary");
    const row = this.connection.prepare(`SELECT h.status,c.obligation_ids_json,a.authorization_id,a.effect_ceiling
      FROM work_cell_heads_v1 h JOIN work_cells_v1 c ON c.work_cell_id=h.work_cell_id
      JOIN execution_authorizations_v1 a ON a.work_cell_id=h.work_cell_id AND a.revoked_at_ms IS NULL
      WHERE h.goal_id=? AND h.work_cell_id=?`).get(goalId, workCellId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "RUNNING") throw new AuthorityIntegrityError("WorkCell completion requires the current running authorization");
    const goal = this.connection.prepare("SELECT objective FROM goals WHERE goal_id=?").get(goalId) as { objective?: unknown } | undefined;
    if (!goal || typeof goal.objective !== "string") throw new AuthorityIntegrityError("WorkCell completion requires the admitted Goal objective");
    const remainingPeerCells = Number((this.connection.prepare(`SELECT count(*) count FROM work_cell_heads_v1
      WHERE goal_id=? AND work_cell_id<>? AND status IN ('PROPOSED','READY','RUNNING','WAITING_USER','REPAIRING')`)
      .get(goalId, workCellId) as { count?: unknown } | undefined)?.count ?? 0);
    if (remainingPeerCells === 0 && row.effect_ceiling !== "READ_ONLY" && requiresWorkspaceMutation(goal.objective)) {
      const committedMutations = Number((this.connection.prepare(`SELECT count(*) count
        FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
        WHERE a.goal_id=? AND a.operation_kind IN ('WRITE','EDIT','DELETE','MOVE','COMMAND')
          AND t.state='COMMITTED'`).get(goalId) as { count?: unknown } | undefined)?.count ?? 0);
      if (committedMutations === 0) {
        throw new AuthorityIntegrityError(
          "PCH_MUTATION_REQUIRED: explicit implementation Goal cannot close without a committed workspace mutation; implement the change, or obtain user confirmation and revise the GoalContract to READ_ONLY for a verified no-change outcome",
        );
      }
    }
    const unresolved = Number((this.connection.prepare(`SELECT count(*) count FROM operation_heads_v1
      WHERE goal_id=? AND work_cell_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')`).get(goalId, workCellId) as { count?: unknown } | undefined)?.count ?? 0);
    const obligationIds = parseJson<unknown[]>(row.obligation_ids_json, "WorkCell obligation IDs");
    const baseline = this.connection.prepare("SELECT record_sha256,created_event_sequence FROM workspace_baselines_v1 WHERE goal_id=? ORDER BY created_event_sequence DESC LIMIT 1").get(goalId) as Record<string, unknown> | undefined;
    if (!baseline) throw new AuthorityIntegrityError("WorkCell completion requires a post-validation WorkspaceBaseline");
    const baselineSha256 = sha(baseline.record_sha256, "baseline_sha256");
    const lastMutation = Number((this.connection.prepare(`SELECT COALESCE(MAX(t.created_event_sequence),0) sequence
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND a.work_cell_id=? AND a.operation_kind IN ('WRITE','EDIT','DELETE','MOVE','COMMAND')
        AND t.state='COMMITTED'`).get(goalId, workCellId) as { sequence?: unknown } | undefined)?.sequence ?? 0);
    let missing = 0;
    for (const obligationId of obligationIds) {
      const bounded = boundedId(obligationId, "obligation_id");
      const evidence = this.connection.prepare(`SELECT count(*) count FROM evidence_attestations_v1
        WHERE goal_id=? AND work_cell_id=? AND obligation_id=? AND result='PASS'
          AND freshness='CURRENT' AND postcondition='PASS' AND baseline_sha256=?
          AND created_event_sequence>?`).get(goalId, workCellId, bounded, baselineSha256, lastMutation) as { count?: unknown } | undefined;
      if (Number(evidence?.count ?? 0) === 0) missing += 1;
    }
    if (unresolved > 0 || missing > 0) throw new AuthorityIntegrityError("WorkCell evidence closure is incomplete");
    this.transitionWorkCell(workCellId, "RUNNING", "SUCCEEDED", eventSequence, progressSha256);
    this.connection.prepare("UPDATE execution_authorizations_v1 SET revoked_at_ms=? WHERE authorization_id=? AND revoked_at_ms IS NULL")
      .run(nowMs, boundedId(row.authorization_id, "authorization_id"));
    const remaining = Number((this.connection.prepare("SELECT count(*) count FROM work_cell_heads_v1 WHERE goal_id=? AND status IN ('PROPOSED','READY','RUNNING','WAITING_USER','REPAIRING')").get(goalId) as { count?: unknown } | undefined)?.count ?? 0);
    const routeRow = this.connection.prepare(`SELECT v.route_json FROM route_skeleton_heads_v1 h
      JOIN route_skeleton_versions_v1 v ON v.route_id=h.route_id WHERE h.goal_id=?`).get(goalId) as { route_json?: unknown } | undefined;
    const route = routeRow ? parseJson<RouteSkeletonRecord>(routeRow.route_json, "RouteSkeleton") : null;
    const deferred = route?.schema_version === 2 && (route.deferred_outcomes?.length ?? 0) > 0;
    const nextAction = remaining === 0 ? (deferred ? "SUBMIT_ROUTE" : "CLOSE_GOAL") : "AUTHORIZE_WORK";
    const status = remaining === 0 && deferred ? "PLANNING" : "BUILDING";
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code=?,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
      .run(status, nextAction, eventSequence, goalId);
  }

  resolvePlanContinuation(input: {
    readonly goalId: string;
    readonly decision: TaskDecisionEntryRecord;
    readonly choice: "BUILD" | "KEEP" | "REVISE";
    readonly eventSequence: number;
    readonly nowMs: number;
  }): void {
    this.assertAvailable();
    assertTaskDecisionEntry(input.decision);
    if (input.decision.goal_id !== input.goalId || input.decision.decision_key !== "PLAN_CONTINUATION"
      || input.decision.state !== "RESOLVED" || input.decision.selection?.choice !== input.choice) {
      throw new AuthorityIntegrityError("Plan continuation Decision binding is invalid");
    }
    const head = this.connection.prepare(`SELECT m.intent,h.status,h.next_action_code,h.current_contract_id,h.current_route_id
      FROM task_flow_modes_v1 m JOIN task_flow_goal_heads_v1 h ON h.goal_id=m.goal_id WHERE m.goal_id=?`).get(input.goalId) as Record<string, unknown> | undefined;
    if (!head || head.intent !== "PLAN" || head.status !== "WAITING_USER" || head.next_action_code !== "PLAN_CONTINUATION") {
      throw new AuthorityIntegrityError("Plan continuation is not currently open");
    }
    const contractId = head.current_contract_id === null ? null : boundedId(head.current_contract_id, "contract_id");
    const routeId = head.current_route_id === null ? null : boundedId(head.current_route_id, "route_id");
    if (input.decision.contract_id !== contractId || input.decision.route_id !== routeId) throw new AuthorityIntegrityError("Plan continuation Decision does not bind current heads");
    this.insertDecision(input.decision, input.eventSequence);
    if (input.choice === "REVISE" && routeId !== null) {
      this.invalidateRouteHead(routeId, input.eventSequence, input.nowMs);
      this.connection.prepare("UPDATE route_skeleton_heads_v1 SET health='INVALID',updated_event_sequence=? WHERE goal_id=? AND route_id=?")
        .run(input.eventSequence, input.goalId, routeId);
    }
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code=?,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
      .run(input.choice === "BUILD" ? "BUILDING" : input.choice === "KEEP" ? "SUCCEEDED" : "PLANNING",
        input.choice === "BUILD" ? "AUTHORIZE_WORK" : input.choice === "KEEP" ? "NONE" : "SUBMIT_ROUTE",
        input.eventSequence, input.goalId);
  }

  insertOperation(
    record: OperationAttemptRecord,
    prepared: OperationTransitionRecord,
    reconcileLocator: OperationReconcileLocatorRecord | null,
    eventSequence: number,
    fence: TaskFlowAuthorizationFence,
    dispatched: OperationTransitionRecord | null = null,
  ): boolean {
    this.assertAvailable(); assertOperationAttempt(record); assertOperationTransition(prepared);
    if (prepared.attempt_id !== record.attempt_id || prepared.ordinal !== 0 || prepared.state !== "PREPARED") throw new AuthorityIntegrityError("Operation PREPARED transition binding failed");
    if (dispatched) {
      assertOperationTransition(dispatched);
      if (dispatched.attempt_id !== record.attempt_id || dispatched.ordinal !== 1
        || dispatched.state !== "DISPATCHED" || dispatched.predecessor_sha256 !== prepared.transition_sha256) {
        throw new AuthorityIntegrityError("Operation DISPATCHED transition binding failed");
      }
    }
    const authorization = this.connection.prepare(`SELECT a.goal_id,a.record_sha256,a.revoked_at_ms,a.lease_generation,a.fencing_token,a.expires_at_ms,
      h.status,b.record_sha256 baseline_sha256,b.environment_sha256
      FROM execution_authorizations_v1 a JOIN work_cell_heads_v1 h ON h.work_cell_id=a.work_cell_id
      JOIN workspace_baselines_v1 b ON b.baseline_id=a.baseline_id WHERE a.authorization_id=?`).get(record.authorization_id) as Record<string, unknown> | undefined;
    if (!authorization || authorization.revoked_at_ms !== null || authorization.status !== "RUNNING" || authorization.baseline_sha256 !== record.baseline_sha256 || authorization.environment_sha256 !== record.environment_sha256) throw new AuthorityIntegrityError("Operation is not bound to the current authorization/baseline");
    if (authorization.goal_id !== record.goal_id
      || Number(authorization.lease_generation) !== fence.leaseGeneration
      || Number(authorization.fencing_token) !== fence.fencingToken
      || Number(authorization.expires_at_ms) <= fence.nowMs) {
      throw new AuthorityIntegrityError("Operation authorization fence is not current");
    }
    const existing = this.connection.prepare("SELECT record_sha256 FROM operation_attempts_v1 WHERE attempt_id=?").get(record.attempt_id) as { record_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("Operation Attempt ID substitution");
      return true;
    }
    this.connection.prepare(`INSERT INTO operation_attempts_v1(
      attempt_id,operation_id,goal_id,work_cell_id,authorization_id,attempt_number,operation_kind,
      normalized_target_hmac,normalized_payload_sha256,execution_fingerprint_sha256,baseline_sha256,
      environment_sha256,oracle_sha256,idempotency_key_hmac,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.attempt_id, record.operation_id, record.goal_id, record.work_cell_id,
      record.authorization_id, record.attempt_number, record.operation_kind,
      record.normalized_target_hmac, record.normalized_payload_sha256,
      record.execution_fingerprint_sha256, record.baseline_sha256, record.environment_sha256,
      record.oracle_sha256, record.idempotency_key_hmac, record.record_sha256,
      record.created_at_ms, eventSequence,
    );
    this.insertOperationTransition(prepared, eventSequence);
    if (dispatched) this.insertOperationTransition(dispatched, eventSequence);
    if (reconcileLocator) {
      assertOperationReconcileLocator(reconcileLocator);
      if (reconcileLocator.attempt_id !== record.attempt_id || reconcileLocator.goal_id !== record.goal_id) {
        throw new AuthorityIntegrityError("Operation reconcile locator parent substitution");
      }
      this.connection.prepare(`INSERT INTO operation_reconcile_locators_v1(
        locator_id,attempt_id,goal_id,target_relative,preimage_sha256,expected_postimage_sha256,
        record_sha256,created_at_ms,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        reconcileLocator.locator_id, reconcileLocator.attempt_id, reconcileLocator.goal_id,
        reconcileLocator.target_relative, reconcileLocator.preimage_sha256,
        reconcileLocator.expected_postimage_sha256, reconcileLocator.record_sha256,
        reconcileLocator.created_at_ms, eventSequence,
      );
    }
    return false;
  }

  assertOperationAuthorizationCurrent(
    attemptId: string,
    goalId: string,
    fence: TaskFlowAuthorizationFence,
  ): void {
    this.assertAvailable();
    const authorization = this.connection.prepare(`SELECT o.goal_id,a.revoked_at_ms,a.lease_generation,a.fencing_token,a.expires_at_ms
      FROM operation_attempts_v1 o JOIN execution_authorizations_v1 a ON a.authorization_id=o.authorization_id
      WHERE o.attempt_id=?`).get(attemptId) as Record<string, unknown> | undefined;
    if (!authorization || authorization.goal_id !== goalId || authorization.revoked_at_ms !== null
      || Number(authorization.lease_generation) !== fence.leaseGeneration
      || Number(authorization.fencing_token) !== fence.fencingToken
      || Number(authorization.expires_at_ms) <= fence.nowMs) {
      throw new AuthorityIntegrityError("Operation authorization fence is not current");
    }
  }

  insertDecision(record: TaskDecisionEntryRecord, eventSequence: number): boolean {
    this.assertAvailable(); assertTaskDecisionEntry(record);
    const result = this.connection.prepare(`INSERT INTO task_decision_entries_v1(
      decision_entry_id,goal_id,contract_id,route_id,decision_key,authority_actor,materiality,
      reversible,privacy_related,question_hmac,recommendation_json,selection_json,state,
      binding_sha256,record_sha256,created_at_ms,expires_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_entry_id) DO NOTHING`).run(
      record.decision_entry_id, record.goal_id, record.contract_id, record.route_id,
      record.decision_key, record.authority_actor, record.materiality, record.reversible ? 1 : 0,
      record.privacy_related ? 1 : 0, record.question_hmac, canonicalJson(record.recommendation),
      record.selection === null ? null : canonicalJson(record.selection), record.state,
      record.binding_sha256, record.record_sha256, record.created_at_ms, record.expires_at_ms,
      eventSequence,
    );
    if (Number(result.changes) === 0) {
      const current = this.connection.prepare("SELECT record_sha256 FROM task_decision_entries_v1 WHERE decision_entry_id=?").get(record.decision_entry_id) as { record_sha256?: unknown } | undefined;
      if (current?.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("TaskDecisionEntry ID substitution");
      return true;
    }
    return false;
  }

  controlGoal(action: "PAUSE" | "RESUME" | "CANCEL", decision: TaskDecisionEntryRecord, eventSequence: number, nowMs: number): void {
    this.assertAvailable();
    const head = this.connection.prepare("SELECT status,next_action_code,current_contract_id,current_route_id,current_work_cell_id FROM task_flow_goal_heads_v1 WHERE goal_id=?").get(decision.goal_id) as Record<string, unknown> | undefined;
    if (!head) throw new AuthorityIntegrityError("Task Flow control requires an active Goal head");
    const terminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(String(head.status));
    if (action !== "CANCEL" && terminal) throw new AuthorityIntegrityError("Terminal Task Flow Goal cannot be paused or resumed");
    this.insertDecision(decision, eventSequence);
    if (action === "CANCEL") {
      this.revokeAuthorization(decision.goal_id, nowMs);
      this.connection.prepare("UPDATE work_cell_heads_v1 SET status='INVALIDATED',updated_event_sequence=? WHERE goal_id=? AND status NOT IN ('SUCCEEDED','FAILED','INVALIDATED')").run(eventSequence, decision.goal_id);
      this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status='CANCELED',next_action_code='NONE',current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?").run(eventSequence, decision.goal_id);
      return;
    }
    if (action === "PAUSE") {
      const unresolved = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get(decision.goal_id) as { count?: unknown } | undefined)?.count ?? 0);
      if (unresolved > 0) throw new AuthorityIntegrityError("Reconcile unresolved Operations before pausing");
      if (head.status === "WAITING_USER" && head.next_action_code === "RESUME") return;
      this.revokeAuthorization(decision.goal_id, nowMs);
      this.connection.prepare("UPDATE work_cell_heads_v1 SET status='REPAIRING',updated_event_sequence=? WHERE goal_id=? AND status='RUNNING'").run(eventSequence, decision.goal_id);
      this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status='WAITING_USER',next_action_code='RESUME',current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?").run(eventSequence, decision.goal_id);
      return;
    }
    if (head.status !== "WAITING_USER" || head.next_action_code !== "RESUME") throw new AuthorityIntegrityError("Task Flow Goal is not paused");
    const contract = head.current_contract_id !== null;
    const route = head.current_route_id !== null;
    const mode = this.connection.prepare("SELECT intent FROM task_flow_modes_v1 WHERE goal_id=?").get(decision.goal_id) as { intent?: unknown } | undefined;
    const continuation = this.connection.prepare("SELECT selection_json FROM task_decision_entries_v1 WHERE goal_id=? AND decision_key='PLAN_CONTINUATION' AND state='RESOLVED' ORDER BY created_event_sequence DESC LIMIT 1").get(decision.goal_id) as { selection_json?: unknown } | undefined;
    const choice = continuation ? parseJson<{ choice?: unknown }>(continuation.selection_json, "Plan continuation").choice : null;
    const nextStatus = !contract ? "CONTRACTING" : !route || choice === "REVISE" ? "PLANNING" : mode?.intent === "PLAN" && choice !== "BUILD" ? "WAITING_USER" : "BUILDING";
    const nextAction = !contract ? "SUBMIT_CONTRACT" : !route || choice === "REVISE" ? "SUBMIT_ROUTE" : mode?.intent === "PLAN" && choice !== "BUILD" ? "PLAN_CONTINUATION" : "AUTHORIZE_WORK";
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code=?,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?").run(nextStatus, nextAction, eventSequence, decision.goal_id);
  }

  settleReconciliation(record: OperationTransitionRecord, disposition: "NOT_DISPATCHED" | "APPLIED" | "NOT_APPLIED" | "APPLIED_UNVERIFIED" | "SAFE_TO_RETRY", eventSequence: number, nowMs: number): void {
    this.insertOperationTransition(record, eventSequence, true);
    if (record.state !== "FAILED" && record.state !== "RECONCILED" && record.state !== "COMMITTED") throw new AuthorityIntegrityError("Reconciliation must end in a terminal Operation state");
    const attempt = this.connection.prepare("SELECT goal_id,work_cell_id FROM operation_attempts_v1 WHERE attempt_id=?").get(record.attempt_id) as Record<string, unknown> | undefined;
    if (!attempt) throw new AuthorityIntegrityError("Reconciled Operation attempt is missing");
    const goalId = boundedId(attempt.goal_id, "goal_id");
    const unresolved = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get(goalId) as { count?: unknown } | undefined)?.count ?? 0);
    if (unresolved > 0) return;
    if (disposition === "NOT_DISPATCHED" || record.state === "COMMITTED") return;
    this.revokeAuthorization(goalId, nowMs);
    const workCellId = boundedId(attempt.work_cell_id, "work_cell_id");
    this.connection.prepare("UPDATE work_cell_heads_v1 SET status='REPAIRING',updated_event_sequence=? WHERE work_cell_id=? AND status NOT IN ('SUCCEEDED','FAILED','INVALIDATED')").run(eventSequence, workCellId);
    this.connection.prepare("UPDATE route_skeleton_heads_v1 SET health='DEGRADED',updated_event_sequence=? WHERE goal_id=?").run(eventSequence, goalId);
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status='BUILDING',next_action_code='AUTHORIZE_WORK',current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?").run(eventSequence, goalId);
  }

  insertOperationTransition(record: OperationTransitionRecord, eventSequence: number, reconciliation = false): boolean {
    this.assertAvailable(); assertOperationTransition(record);
    const existing = this.connection.prepare("SELECT transition_sha256 FROM operation_transitions_v1 WHERE transition_id=?").get(record.transition_id) as { transition_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.transition_sha256 !== record.transition_sha256) throw new AuthorityIntegrityError("Operation transition ID substitution");
      return true;
    }
    const head = this.connection.prepare("SELECT ordinal,state,transition_sha256 FROM operation_heads_v1 WHERE attempt_id=?").get(record.attempt_id) as { ordinal?: unknown; state?: unknown; transition_sha256?: unknown } | undefined;
    if (record.ordinal === 0) {
      if (head) throw new AuthorityIntegrityError("Operation attempt already has a head");
    } else if (!head || Number(head.ordinal) + 1 !== record.ordinal || head.transition_sha256 !== record.predecessor_sha256) {
      throw new AuthorityIntegrityError("Operation transition does not extend the current head");
    }
    const allowed: Readonly<Record<OperationState, readonly OperationState[]>> = {
      PREPARED: ["DISPATCHED", "FAILED"], DISPATCHED: ["OBSERVED", "FAILED", "OUTCOME_UNKNOWN"],
      OBSERVED: ["COMMITTED", "FAILED", "OUTCOME_UNKNOWN"], OUTCOME_UNKNOWN: ["RECONCILED"],
      COMMITTED: [], FAILED: [], RECONCILED: [],
    };
    const priorState = head ? String(head.state) as OperationState : null;
    const reconciliationTransition = reconciliation && priorState !== null
      && ["PREPARED", "DISPATCHED", "OBSERVED", "OUTCOME_UNKNOWN"].includes(priorState)
      && ["FAILED", "RECONCILED", "COMMITTED"].includes(record.state);
    if (head && !allowed[priorState!].includes(record.state) && !reconciliationTransition) {
      throw new AuthorityIntegrityError(`Invalid Operation transition ${String(head.state)} -> ${record.state}`);
    }
    this.connection.prepare(`INSERT INTO operation_transitions_v1(
      transition_id,attempt_id,ordinal,state,output_sha256,readback_sha256,failure_signature_sha256,
      postcondition,predecessor_sha256,transition_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.transition_id, record.attempt_id, record.ordinal, record.state, record.output_sha256,
      record.readback_sha256, record.failure_signature_sha256, record.postcondition,
      record.predecessor_sha256, record.transition_sha256, record.created_at_ms, eventSequence,
    );
    const attempt = this.connection.prepare("SELECT operation_id,goal_id,work_cell_id FROM operation_attempts_v1 WHERE attempt_id=?").get(record.attempt_id) as Record<string, unknown> | undefined;
    if (!attempt) throw new AuthorityIntegrityError("Operation attempt is missing");
    this.connection.prepare(`INSERT INTO operation_heads_v1(attempt_id,operation_id,goal_id,work_cell_id,ordinal,state,transition_sha256,updated_event_sequence)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET ordinal=excluded.ordinal,state=excluded.state,
      transition_sha256=excluded.transition_sha256,updated_event_sequence=excluded.updated_event_sequence`).run(
      record.attempt_id, boundedId(attempt.operation_id, "operation_id"), boundedId(attempt.goal_id, "goal_id"), boundedId(attempt.work_cell_id, "work_cell_id"),
      record.ordinal, record.state, record.transition_sha256, eventSequence,
    );
    return false;
  }

  insertEvidence(record: EvidenceAttestationRecord, eventSequence: number): boolean {
    this.assertAvailable(); assertEvidenceAttestation(record);
    const result = this.connection.prepare(`INSERT INTO evidence_attestations_v1(
      attestation_id,goal_id,work_cell_id,operation_id,obligation_id,oracle_sha256,input_closure_sha256,
      output_sha256,baseline_sha256,environment_sha256,result,freshness,postcondition,artifact_id,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attestation_id) DO NOTHING`).run(
      record.attestation_id, record.goal_id, record.work_cell_id, record.operation_id,
      record.obligation_id, record.oracle_sha256, record.input_closure_sha256,
      record.output_sha256, record.baseline_sha256, record.environment_sha256,
      record.result, record.freshness, record.postcondition, record.artifact_id,
      record.record_sha256, record.created_at_ms, eventSequence,
    );
    if (Number(result.changes) === 0) {
      const current = this.connection.prepare("SELECT record_sha256 FROM evidence_attestations_v1 WHERE attestation_id=?").get(record.attestation_id) as { record_sha256?: unknown } | undefined;
      if (current?.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("EvidenceAttestation ID substitution");
      return true;
    }
    return false;
  }

  insertRouteHealth(record: RouteHealthRecord, eventSequence: number): boolean {
    this.assertAvailable(); assertRouteHealth(record);
    const result = this.connection.prepare(`INSERT INTO route_health_records_v1(
      health_id,goal_id,route_id,work_cell_id,trigger_sha256,failure_signature_sha256,
      occurrence,level,reason_code,selected_route_id,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(health_id) DO NOTHING`).run(
      record.health_id, record.goal_id, record.route_id, record.work_cell_id,
      record.trigger_sha256, record.failure_signature_sha256, record.occurrence,
      record.level, record.reason_code, record.selected_route_id, record.record_sha256,
      record.created_at_ms, eventSequence,
    );
    if (Number(result.changes) === 0) return true;
    const health = record.level === "H3_REFRAME" ? "INVALID" : record.level === "H4_ASK" ? "WAITING_USER" : record.level === "H5_RECONCILE_OR_STOP" ? "RECONCILING" : record.level === "H0_CONTINUE" ? "HEALTHY" : "DEGRADED";
    this.connection.prepare("UPDATE route_skeleton_heads_v1 SET health=?,updated_event_sequence=? WHERE goal_id=? AND route_id=?").run(health, eventSequence, record.goal_id, record.route_id);
    if (record.level === "H3_REFRAME" || record.level === "H4_ASK" || record.level === "H5_RECONCILE_OR_STOP") {
      this.revokeAuthorization(record.goal_id, record.created_at_ms);
      if (record.level === "H3_REFRAME") {
        this.connection.prepare("UPDATE work_cell_heads_v1 SET status='INVALIDATED',updated_event_sequence=? WHERE goal_id=? AND route_id=? AND status NOT IN ('SUCCEEDED','FAILED','INVALIDATED')")
          .run(eventSequence, record.goal_id, record.route_id);
        const invalidation = {
          invalidation_id: `INVALIDATION:${record.health_id}`, goal_id: record.goal_id,
          target_kind: "ROUTE", target_id: record.route_id, reason_code: record.reason_code,
          evidence_sha256: record.trigger_sha256, created_at_ms: record.created_at_ms,
        };
        const recordSha256 = canonicalJsonSha256({ domain: "PCH-TASK-INVALIDATION-V1", ...invalidation });
        this.connection.prepare(`INSERT INTO task_invalidations_v1(
          invalidation_id,goal_id,target_kind,target_id,reason_code,evidence_sha256,
          record_sha256,created_at_ms,created_event_sequence
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          invalidation.invalidation_id, invalidation.goal_id, invalidation.target_kind,
          invalidation.target_id, invalidation.reason_code, invalidation.evidence_sha256,
          recordSha256, invalidation.created_at_ms, eventSequence,
        );
      } else if (record.level === "H4_ASK") {
        this.connection.prepare("UPDATE work_cell_heads_v1 SET status='WAITING_USER',updated_event_sequence=? WHERE goal_id=? AND route_id=? AND status IN ('RUNNING','REPAIRING')")
          .run(eventSequence, record.goal_id, record.route_id);
      }
      this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code=?,current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
        .run(record.level === "H3_REFRAME" ? "PLANNING" : record.level === "H4_ASK" ? "WAITING_USER" : "RECONCILING", record.level === "H3_REFRAME" ? "SUBMIT_ROUTE" : record.level === "H4_ASK" ? "RESOLVE_DECISION" : "RECONCILE_OPERATION", eventSequence, record.goal_id);
    }
    return false;
  }

  insertDeliverable(record: DeliverableManifestRecord, eventSequence: number): boolean {
    this.assertAvailable(); assertStoredHash("PCH-DELIVERABLE-MANIFEST-V1", record);
    if (record.result === "SUCCEEDED") this.assertGoalClosure(record.goal_id, record.contract_id, record.route_id, record.final_baseline_id);
    const result = this.connection.prepare(`INSERT INTO deliverable_manifests_v1(
      deliverable_id,goal_id,contract_id,route_id,final_baseline_id,obligation_closure_sha256,
      evidence_root_sha256,artifact_manifest_json,result,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO NOTHING`).run(
      record.deliverable_id, record.goal_id, record.contract_id, record.route_id,
      record.final_baseline_id, record.obligation_closure_sha256, record.evidence_root_sha256,
      canonicalJson(record.artifacts), record.result, record.record_sha256, record.created_at_ms, eventSequence,
    );
    if (Number(result.changes) === 0) {
      const current = this.connection.prepare("SELECT record_sha256 FROM deliverable_manifests_v1 WHERE goal_id=?").get(record.goal_id) as { record_sha256?: unknown } | undefined;
      if (current?.record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("Goal already has a different DeliverableManifest");
      return true;
    }
    this.connection.prepare("UPDATE task_flow_goal_heads_v1 SET status=?,next_action_code='NONE',current_work_cell_id=NULL,updated_event_sequence=? WHERE goal_id=?")
      .run(record.result, eventSequence, record.goal_id);
    return false;
  }

  private assertGoalClosure(goalId: string, contractId: string, routeId: string, baselineId: string): void {
    const heads = this.connection.prepare("SELECT c.contract_id,r.route_id FROM goal_contract_heads_v1 c JOIN route_skeleton_heads_v1 r ON r.goal_id=c.goal_id WHERE c.goal_id=?").get(goalId) as Record<string, unknown> | undefined;
    if (!heads || heads.contract_id !== contractId || heads.route_id !== routeId) throw new AuthorityIntegrityError("DeliverableManifest is not bound to current contract/route heads");
    const incomplete = Number((this.connection.prepare("SELECT count(*) count FROM work_cell_heads_v1 WHERE goal_id=? AND route_id=? AND status<>'SUCCEEDED'").get(goalId, routeId) as { count?: unknown } | undefined)?.count ?? 0);
    const unresolved = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get(goalId) as { count?: unknown } | undefined)?.count ?? 0);
    const baseline = this.connection.prepare("SELECT record_sha256,created_event_sequence FROM workspace_baselines_v1 WHERE baseline_id=? AND goal_id=?").get(baselineId, goalId) as Record<string, unknown> | undefined;
    if (!baseline) throw new AuthorityIntegrityError("DeliverableManifest final baseline is not owned by the Goal");
    const finalBaselineSha256 = sha(baseline.record_sha256, "final_baseline_sha256");
    const lastMutation = Number((this.connection.prepare(`SELECT COALESCE(MAX(t.created_event_sequence),0) sequence
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND a.operation_kind IN ('WRITE','EDIT','DELETE','MOVE','COMMAND') AND t.state='COMMITTED'`).get(goalId) as { sequence?: unknown } | undefined)?.sequence ?? 0);
    const missingMust = Number((this.connection.prepare(`SELECT count(*) count FROM task_obligations_v1 o
      WHERE o.contract_id=? AND o.priority='MUST' AND NOT EXISTS(
        SELECT 1 FROM evidence_attestations_v1 e WHERE e.obligation_id=o.obligation_id
          AND e.goal_id=? AND e.result='PASS' AND e.freshness='CURRENT' AND e.postcondition='PASS'
          AND e.baseline_sha256=? AND e.created_event_sequence>?)`).get(contractId, goalId, finalBaselineSha256, lastMutation) as { count?: unknown } | undefined)?.count ?? 0);
    if (incomplete > 0 || unresolved > 0 || missingMust > 0) throw new AuthorityIntegrityError("DeliverableManifest closure is incomplete");
  }

  currentView(goalId: string): TaskFlowCurrentView | null {
    this.assertAvailable();
    const mode = this.connection.prepare(`SELECT m.intent,m.lane,h.status,h.next_action_code
      FROM task_flow_modes_v1 m JOIN task_flow_goal_heads_v1 h ON h.goal_id=m.goal_id WHERE m.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!mode) return null;
    const contractRow = this.connection.prepare(`SELECT v.contract_json FROM goal_contract_heads_v1 h
      JOIN goal_contract_versions_v1 v ON v.contract_id=h.contract_id WHERE h.goal_id=?`).get(goalId) as { contract_json?: unknown } | undefined;
    const contract = contractRow ? parseJson<GoalContractRecord>(contractRow.contract_json, "GoalContract") : null;
    if (contract) assertGoalContract(contract);
    const routeRow = this.connection.prepare(`SELECT v.route_json FROM route_skeleton_heads_v1 h
      JOIN route_skeleton_versions_v1 v ON v.route_id=h.route_id WHERE h.goal_id=?`).get(goalId) as { route_json?: unknown } | undefined;
    const route = routeRow ? parseJson<RouteSkeletonRecord>(routeRow.route_json, "RouteSkeleton") : null;
    if (route && !contract) throw new AuthorityIntegrityError("Task Flow route has no GoalContract");
    if (route && contract) assertRouteSkeleton(route, contract);
    const cell = this.connection.prepare("SELECT work_cell_id,status FROM work_cell_heads_v1 WHERE goal_id=? AND status IN ('RUNNING','WAITING_USER','REPAIRING') ORDER BY updated_event_sequence DESC LIMIT 1").get(goalId) as HeadRow | undefined;
    const authorizationRow = this.connection.prepare("SELECT * FROM execution_authorizations_v1 WHERE goal_id=? AND revoked_at_ms IS NULL LIMIT 1").get(goalId) as Record<string, unknown> | undefined;
    const authorization = authorizationRow ? this.authorizationFromRow(authorizationRow) : null;
    const unresolved = this.connection.prepare("SELECT DISTINCT operation_id FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN') ORDER BY operation_id").all(goalId).map((row) => boundedId((row as Record<string, unknown>).operation_id, "operation_id"));
    const healthRow = route === null ? undefined : this.connection.prepare(
      "SELECT * FROM route_health_records_v1 WHERE goal_id=? AND route_id=? ORDER BY created_event_sequence DESC LIMIT 1",
    ).get(goalId, route.route_id) as Record<string, unknown> | undefined;
    const health = healthRow ? this.healthFromRow(healthRow) : null;
    return { goalId, intent: String(mode.intent) as TaskFlowIntent, lane: route?.lane ?? String(mode.lane) as TaskFlowLane,
      status: String(mode.status) as TaskFlowCurrentView["status"], nextActionCode: String(mode.next_action_code),
      contract, route, workCellId: cell ? boundedId(cell.work_cell_id, "work_cell_id") : null,
      workCellStatus: cell ? String(cell.status) as WorkCellStatus : null, authorization,
      unresolvedOperationIds: unresolved, latestHealth: health };
  }

  latestRouteRef(goalId: string): { readonly route_id: string; readonly revision: number } | null {
    this.assertAvailable();
    const row = this.connection.prepare(
      "SELECT route_id,revision FROM route_skeleton_versions_v1 WHERE goal_id=? ORDER BY revision DESC LIMIT 1",
    ).get(goalId) as { route_id?: unknown; revision?: unknown } | undefined;
    if (!row || row.route_id === undefined || row.revision === undefined) return null;
    return { route_id: boundedId(row.route_id, "route_id"), revision: Number(row.revision) };
  }

  activeGoal(workspaceId: string, originSessionId?: string): ActiveTaskFlowGoal | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT g.goal_id,g.workspace_id,g.origin_session_id,g.objective,g.objective_sha256,
        json_extract(e.payload_json,'$.acceptanceFacetMinimum') acceptance_facet_minimum,
        COALESCE((SELECT MAX(e.sequence) FROM events e WHERE e.goal_id=g.goal_id),0) version
      FROM goals g JOIN task_flow_goal_heads_v1 h ON h.goal_id=g.goal_id
      JOIN events e ON e.goal_id=g.goal_id AND e.sequence=1 AND e.event_type='GOAL_ADMITTED'
      WHERE g.workspace_id=? AND h.status NOT IN ('SUCCEEDED','FAILED','CANCELED')
        AND (? IS NULL OR g.origin_session_id=?)
      ORDER BY g.created_at_ms DESC,g.goal_id DESC LIMIT 1`).get(workspaceId, originSessionId ?? null, originSessionId ?? null) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      goalId: boundedId(row.goal_id, "goal_id"), workspaceId: boundedId(row.workspace_id, "workspace_id"),
      originSessionId: String(row.origin_session_id), objective: String(row.objective),
      objectiveSha256: sha(row.objective_sha256, "objective_sha256"),
      acceptanceFacetMinimum: Number.isSafeInteger(row.acceptance_facet_minimum)
        && Number(row.acceptance_facet_minimum) >= 1 && Number(row.acceptance_facet_minimum) <= 6
        ? Number(row.acceptance_facet_minimum) : 1,
      version: Number(row.version),
    };
  }

  goalVersion(goalId: string): number {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT COALESCE(MAX(sequence),0) version FROM events WHERE goal_id=?").get(goalId) as { version?: unknown } | undefined;
    return Number(row?.version ?? 0);
  }

  nextReadyWorkCell(goalId: string): WorkCellRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT v.route_json,h.work_cell_id FROM route_skeleton_heads_v1 r
      JOIN route_skeleton_versions_v1 v ON v.route_id=r.route_id
      JOIN work_cell_heads_v1 h ON h.route_id=r.route_id AND h.goal_id=r.goal_id
      WHERE r.goal_id=? AND h.status IN ('READY','REPAIRING') ORDER BY
        CASE h.status WHEN 'REPAIRING' THEN 0 ELSE 1 END,
        (SELECT ordinal FROM work_cells_v1 c WHERE c.work_cell_id=h.work_cell_id) LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const contractRow = this.connection.prepare(`SELECT v.contract_json FROM goal_contract_heads_v1 h
      JOIN goal_contract_versions_v1 v ON v.contract_id=h.contract_id WHERE h.goal_id=?`).get(goalId) as { contract_json?: unknown } | undefined;
    if (!contractRow) throw new AuthorityIntegrityError("Ready WorkCell has no current GoalContract");
    const contract = parseJson<GoalContractRecord>(contractRow.contract_json, "GoalContract");
    const route = parseJson<RouteSkeletonRecord>(row.route_json, "RouteSkeleton");
    assertGoalContract(contract); assertRouteSkeleton(route, contract);
    const workCellId = boundedId(row.work_cell_id, "work_cell_id");
    return route.work_cells.find((cell) => cell.work_cell_id === workCellId) ?? null;
  }

  operationSnapshot(goalId: string, operationId: string): TaskFlowOperationSnapshot | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT a.*,h.state,h.ordinal,h.transition_sha256,
        t.output_sha256,t.readback_sha256,t.failure_signature_sha256,t.postcondition,l.locator_id,l.target_relative,
        l.preimage_sha256,l.expected_postimage_sha256,l.record_sha256 locator_record_sha256,
        l.created_at_ms locator_created_at_ms
      FROM operation_attempts_v1 a JOIN operation_heads_v1 h ON h.attempt_id=a.attempt_id
      JOIN operation_transitions_v1 t ON t.attempt_id=h.attempt_id AND t.ordinal=h.ordinal
      LEFT JOIN operation_reconcile_locators_v1 l ON l.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND a.operation_id=? ORDER BY a.attempt_number DESC LIMIT 1`).get(goalId, operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const attempt: OperationAttemptRecord = {
      schema_version: 1, attempt_id: boundedId(row.attempt_id, "attempt_id"), operation_id: boundedId(row.operation_id, "operation_id"),
      goal_id: boundedId(row.goal_id, "goal_id"), work_cell_id: boundedId(row.work_cell_id, "work_cell_id"),
      authorization_id: boundedId(row.authorization_id, "authorization_id"), attempt_number: Number(row.attempt_number),
      operation_kind: String(row.operation_kind) as OperationAttemptRecord["operation_kind"],
      normalized_target_hmac: sha(row.normalized_target_hmac, "normalized_target_hmac"),
      normalized_payload_sha256: sha(row.normalized_payload_sha256, "normalized_payload_sha256"),
      execution_fingerprint_sha256: sha(row.execution_fingerprint_sha256, "execution_fingerprint_sha256"),
      baseline_sha256: sha(row.baseline_sha256, "baseline_sha256"), environment_sha256: sha(row.environment_sha256, "environment_sha256"),
      oracle_sha256: sha(row.oracle_sha256, "oracle_sha256"), idempotency_key_hmac: sha(row.idempotency_key_hmac, "idempotency_key_hmac"),
      created_at_ms: Number(row.created_at_ms), record_sha256: sha(row.record_sha256, "record_sha256"),
    };
    assertOperationAttempt(attempt);
    const reconcileLocator: OperationReconcileLocatorRecord | null = row.locator_id === null ? null : {
      schema_version: 1, locator_id: boundedId(row.locator_id, "locator_id"), attempt_id: attempt.attempt_id,
      goal_id: attempt.goal_id, target_relative: String(row.target_relative),
      preimage_sha256: sha(row.preimage_sha256, "preimage_sha256"),
      expected_postimage_sha256: row.expected_postimage_sha256 === null ? null : sha(row.expected_postimage_sha256, "expected_postimage_sha256"),
      created_at_ms: Number(row.locator_created_at_ms), record_sha256: sha(row.locator_record_sha256, "locator_record_sha256"),
    };
    if (reconcileLocator) assertOperationReconcileLocator(reconcileLocator);
    return {
      attempt, state: String(row.state) as OperationState, ordinal: Number(row.ordinal),
      transitionSha256: sha(row.transition_sha256, "transition_sha256"),
      outputSha256: row.output_sha256 === null ? null : sha(row.output_sha256, "output_sha256"),
      readbackSha256: row.readback_sha256 === null ? null : sha(row.readback_sha256, "readback_sha256"),
      failureSignatureSha256: row.failure_signature_sha256 === null ? null : sha(row.failure_signature_sha256, "failure_signature_sha256"),
      postcondition: String(row.postcondition) as OperationTransitionRecord["postcondition"],
      reconcileLocator,
    };
  }

  operationAttemptCount(goalId: string, operationId: string): number {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT count(*) count FROM operation_attempts_v1 WHERE goal_id=? AND operation_id=?").get(goalId, operationId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  openDecisionCount(goalId: string): number {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT count(*) count FROM task_decision_entries_v1 open
      WHERE open.goal_id=? AND open.state='OPEN' AND NOT EXISTS(
        SELECT 1 FROM task_decision_entries_v1 resolved
        WHERE resolved.goal_id=open.goal_id AND resolved.decision_key=open.decision_key
          AND resolved.binding_sha256=open.binding_sha256 AND resolved.state='RESOLVED'
          AND resolved.created_event_sequence>open.created_event_sequence
      )`).get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  openClarificationDecisions(goalId: string): readonly TaskDecisionEntryRecord[] {
    this.assertAvailable();
    return (this.connection.prepare(`SELECT open.* FROM task_decision_entries_v1 open
      WHERE open.goal_id=? AND open.state='OPEN' AND open.decision_key LIKE 'CLARIFICATION:%'
        AND NOT EXISTS(
          SELECT 1 FROM task_decision_entries_v1 resolved
          WHERE resolved.goal_id=open.goal_id AND resolved.decision_key=open.decision_key
            AND resolved.binding_sha256=open.binding_sha256 AND resolved.state='RESOLVED'
            AND resolved.created_event_sequence>open.created_event_sequence
        ) ORDER BY open.created_event_sequence,open.decision_entry_id`).all(goalId) as Record<string, unknown>[])
      .map((row) => this.decisionFromRow(row));
  }

  failureSignatureOccurrence(goalId: string, signatureSha256: string): number {
    this.assertAvailable(); sha(signatureSha256, "failure_signature_sha256");
    const row = this.connection.prepare(`SELECT count(DISTINCT a.attempt_id) count
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND t.failure_signature_sha256=?`).get(goalId, signatureSha256) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  unresolvedOperations(goalId: string): readonly TaskFlowOperationSnapshot[] {
    this.assertAvailable();
    const ids = this.connection.prepare(`SELECT DISTINCT operation_id FROM operation_heads_v1
      WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN') ORDER BY operation_id`).all(goalId) as Record<string, unknown>[];
    return ids.map((row) => this.operationSnapshot(goalId, boundedId(row.operation_id, "operation_id")))
      .filter((value): value is TaskFlowOperationSnapshot => value !== null);
  }

  baseline(baselineId: string): WorkspaceBaselineRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM workspace_baselines_v1 WHERE baseline_id=?").get(baselineId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const record: WorkspaceBaselineRecord = {
      schema_version: 1, baseline_id: boundedId(row.baseline_id, "baseline_id"), workspace_id: boundedId(row.workspace_id, "workspace_id"),
      goal_id: boundedId(row.goal_id, "goal_id"), filesystem_identity_hmac: sha(row.filesystem_identity_hmac, "filesystem_identity_hmac"),
      content_root_sha256: sha(row.content_root_sha256, "content_root_sha256"), environment_sha256: sha(row.environment_sha256, "environment_sha256"),
      oracle_set_sha256: sha(row.oracle_set_sha256, "oracle_set_sha256"),
      scope_manifest: parseJson<Readonly<Record<string, unknown>>[]>(row.scope_manifest_json, "WorkspaceBaseline scope"),
      created_at_ms: Number(row.created_at_ms), record_sha256: sha(row.record_sha256, "record_sha256"),
    };
    assertStoredHash("PCH-WORKSPACE-BASELINE-V1", record);
    return record;
  }

  latestBaseline(goalId: string): WorkspaceBaselineRecord | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT baseline_id FROM workspace_baselines_v1 WHERE goal_id=? ORDER BY created_event_sequence DESC LIMIT 1").get(goalId) as { baseline_id?: unknown } | undefined;
    return row?.baseline_id === undefined ? null : this.baseline(boundedId(row.baseline_id, "baseline_id"));
  }

  evidenceRoot(goalId: string, baselineSha256?: string): string {
    this.assertAvailable();
    const rows = baselineSha256
      ? this.connection.prepare("SELECT record_sha256 FROM evidence_attestations_v1 WHERE goal_id=? AND baseline_sha256=? ORDER BY created_event_sequence,attestation_id").all(goalId, baselineSha256)
      : this.connection.prepare("SELECT record_sha256 FROM evidence_attestations_v1 WHERE goal_id=? ORDER BY created_event_sequence,attestation_id").all(goalId);
    return canonicalJsonSha256(rows.map((row) => sha((row as Record<string, unknown>).record_sha256, "record_sha256")));
  }

  private authorizationFromRow(row: Record<string, unknown>): ExecutionAuthorizationRecord {
    const record: ExecutionAuthorizationRecord = {
      schema_version: 1, authorization_id: boundedId(row.authorization_id, "authorization_id"),
      goal_id: boundedId(row.goal_id, "goal_id"), contract_id: boundedId(row.contract_id, "contract_id"),
      route_id: boundedId(row.route_id, "route_id"), work_cell_id: boundedId(row.work_cell_id, "work_cell_id"),
      baseline_id: boundedId(row.baseline_id, "baseline_id"), lease_generation: Number(row.lease_generation),
      fencing_token: Number(row.fencing_token), effect_ceiling: String(row.effect_ceiling) as ExecutionAuthorizationRecord["effect_ceiling"],
      decision_closure_sha256: sha(row.decision_closure_sha256, "decision_closure_sha256"),
      allowed_scope_sha256: sha(row.allowed_scope_sha256, "allowed_scope_sha256"),
      expires_at_ms: Number(row.expires_at_ms), created_at_ms: Number(row.created_at_ms),
      record_sha256: sha(row.record_sha256, "record_sha256"),
    };
    assertStoredHash("PCH-EXECUTION-AUTHORIZATION-V1", record);
    return record;
  }

  private healthFromRow(row: Record<string, unknown>): RouteHealthRecord {
    const record: RouteHealthRecord = {
      schema_version: 1, health_id: boundedId(row.health_id, "health_id"),
      goal_id: boundedId(row.goal_id, "goal_id"), route_id: boundedId(row.route_id, "route_id"),
      work_cell_id: row.work_cell_id === null ? null : boundedId(row.work_cell_id, "work_cell_id"),
      trigger_sha256: sha(row.trigger_sha256, "trigger_sha256"),
      failure_signature_sha256: row.failure_signature_sha256 === null ? null : sha(row.failure_signature_sha256, "failure_signature_sha256"),
      occurrence: Number(row.occurrence), level: String(row.level) as RouteHealthRecord["level"],
      reason_code: String(row.reason_code), selected_route_id: row.selected_route_id === null ? null : boundedId(row.selected_route_id, "selected_route_id"),
      created_at_ms: Number(row.created_at_ms), record_sha256: sha(row.record_sha256, "record_sha256"),
    };
    assertRouteHealth(record); return record;
  }

  private decisionFromRow(row: Record<string, unknown>): TaskDecisionEntryRecord {
    const record: TaskDecisionEntryRecord = {
      schema_version: 1, decision_entry_id: boundedId(row.decision_entry_id, "decision_entry_id"),
      goal_id: boundedId(row.goal_id, "goal_id"), contract_id: row.contract_id === null ? null : boundedId(row.contract_id, "contract_id"),
      route_id: row.route_id === null ? null : boundedId(row.route_id, "route_id"), decision_key: String(row.decision_key),
      authority_actor: String(row.authority_actor) as TaskDecisionEntryRecord["authority_actor"],
      materiality: String(row.materiality) as TaskDecisionEntryRecord["materiality"], reversible: Number(row.reversible) === 1,
      privacy_related: Number(row.privacy_related) === 1, question_hmac: sha(row.question_hmac, "question_hmac"),
      recommendation: parseJson<Readonly<Record<string, unknown>>>(row.recommendation_json, "TaskDecision recommendation"),
      selection: row.selection_json === null ? null : parseJson<Readonly<Record<string, unknown>>>(row.selection_json, "TaskDecision selection"),
      state: String(row.state) as TaskDecisionEntryRecord["state"], binding_sha256: sha(row.binding_sha256, "binding_sha256"),
      created_at_ms: Number(row.created_at_ms), expires_at_ms: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
      record_sha256: sha(row.record_sha256, "record_sha256"),
    };
    assertTaskDecisionEntry(record); return record;
  }

  rebuildGoalHeads(goalId: string): void {
    this.assertAvailable();
    const mode = this.connection.prepare("SELECT intent FROM task_flow_modes_v1 WHERE goal_id=?").get(goalId) as { intent?: unknown } | undefined;
    if (!mode) throw new AuthorityIntegrityError(`Task Flow Goal ${goalId} is missing`);
    const eventSequence = Number((this.connection.prepare("SELECT COALESCE(MAX(sequence),1) sequence FROM events WHERE goal_id=?").get(goalId) as { sequence?: unknown } | undefined)?.sequence ?? 1);

    this.connection.prepare("DELETE FROM goal_contract_heads_v1 WHERE goal_id=?").run(goalId);
    const contract = this.connection.prepare(`SELECT contract_id,version,record_sha256,created_event_sequence
      FROM goal_contract_versions_v1 WHERE goal_id=? ORDER BY version DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (contract) this.connection.prepare("INSERT INTO goal_contract_heads_v1(goal_id,contract_id,version,contract_sha256,updated_event_sequence) VALUES(?,?,?,?,?)")
      .run(goalId, boundedId(contract.contract_id, "contract_id"), Number(contract.version), sha(contract.record_sha256, "contract_sha256"), Number(contract.created_event_sequence));

    this.connection.prepare("DELETE FROM route_skeleton_heads_v1 WHERE goal_id=?").run(goalId);
    const route = this.connection.prepare(`SELECT route_id,revision,record_sha256,created_event_sequence
      FROM route_skeleton_versions_v1 WHERE goal_id=? ORDER BY revision DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (route) {
      const routeId = boundedId(route.route_id, "route_id");
      const latestHealth = this.connection.prepare("SELECT level,created_event_sequence FROM route_health_records_v1 WHERE goal_id=? AND route_id=? ORDER BY created_event_sequence DESC LIMIT 1").get(goalId, routeId) as Record<string, unknown> | undefined;
      const level = latestHealth?.level;
      const health = level === "H3_REFRAME" ? "INVALID" : level === "H4_ASK" ? "WAITING_USER" : level === "H5_RECONCILE_OR_STOP" ? "RECONCILING" : level === "H0_CONTINUE" || level === undefined ? "HEALTHY" : "DEGRADED";
      this.connection.prepare("INSERT INTO route_skeleton_heads_v1(goal_id,route_id,revision,route_sha256,health,updated_event_sequence) VALUES(?,?,?,?,?,?)")
        .run(goalId, routeId, Number(route.revision), sha(route.record_sha256, "route_sha256"), health, Number(latestHealth?.created_event_sequence ?? route.created_event_sequence));
    }

    this.connection.prepare("DELETE FROM work_cell_heads_v1 WHERE goal_id=?").run(goalId);
    const cells = this.connection.prepare("SELECT work_cell_id,route_id FROM work_cells_v1 WHERE goal_id=? ORDER BY route_id,ordinal").all(goalId) as Record<string, unknown>[];
    const currentRouteId = route ? boundedId(route.route_id, "route_id") : null;
    const insertCellHead = this.connection.prepare("INSERT INTO work_cell_heads_v1(work_cell_id,goal_id,route_id,status,attempt_count,last_progress_sha256,updated_event_sequence) VALUES(?,?,?,?,?,?,?)");
    for (const cell of cells) {
      const workCellId = boundedId(cell.work_cell_id, "work_cell_id");
      const routeId = boundedId(cell.route_id, "route_id");
      const completed = this.connection.prepare("SELECT payload_json,sequence FROM events WHERE goal_id=? AND event_type='WORK_CELL_TRANSITIONED' AND json_extract(payload_json,'$.workCellId')=? ORDER BY sequence DESC LIMIT 1").get(goalId, workCellId) as Record<string, unknown> | undefined;
      const live = this.connection.prepare("SELECT created_event_sequence FROM execution_authorizations_v1 WHERE goal_id=? AND work_cell_id=? AND revoked_at_ms IS NULL LIMIT 1").get(goalId, workCellId) as Record<string, unknown> | undefined;
      const status: WorkCellStatus = routeId !== currentRouteId ? "INVALIDATED" : completed ? "SUCCEEDED" : live ? "RUNNING" : "PROPOSED";
      const completionPayload = completed ? parseJson<Record<string, unknown>>(completed.payload_json, "WorkCell completion event") : null;
      const completionSummarySha256 = completionPayload?.completionSummarySha256 === undefined
        ? null
        : sha(completionPayload.completionSummarySha256, "completionSummarySha256");
      insertCellHead.run(workCellId, goalId, routeId, status, live ? 1 : 0,
        completionSummarySha256, Number(completed?.sequence ?? live?.created_event_sequence ?? eventSequence));
    }
    if (currentRouteId !== null) this.connection.prepare(`UPDATE work_cell_heads_v1 SET status='READY',updated_event_sequence=?
      WHERE route_id=? AND status='PROPOSED' AND NOT EXISTS(
        SELECT 1 FROM work_cell_dependencies_v1 d JOIN work_cell_heads_v1 h ON h.work_cell_id=d.depends_on_work_cell_id
        WHERE d.work_cell_id=work_cell_heads_v1.work_cell_id AND h.status<>'SUCCEEDED'
      )`).run(eventSequence, currentRouteId);

    this.connection.prepare("DELETE FROM operation_heads_v1 WHERE goal_id=?").run(goalId);
    this.connection.prepare(`INSERT INTO operation_heads_v1(attempt_id,operation_id,goal_id,work_cell_id,ordinal,state,transition_sha256,updated_event_sequence)
      SELECT a.attempt_id,a.operation_id,a.goal_id,a.work_cell_id,t.ordinal,t.state,t.transition_sha256,t.created_event_sequence
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND t.ordinal=(SELECT MAX(t2.ordinal) FROM operation_transitions_v1 t2 WHERE t2.attempt_id=a.attempt_id)`).run(goalId);

    const unresolved = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get(goalId) as { count?: unknown } | undefined)?.count ?? 0);
    const liveAuthorization = this.connection.prepare("SELECT work_cell_id FROM execution_authorizations_v1 WHERE goal_id=? AND revoked_at_ms IS NULL LIMIT 1").get(goalId) as { work_cell_id?: unknown } | undefined;
    const deliverable = this.connection.prepare("SELECT result FROM deliverable_manifests_v1 WHERE goal_id=?").get(goalId) as { result?: unknown } | undefined;
    const continuation = this.connection.prepare("SELECT selection_json FROM task_decision_entries_v1 WHERE goal_id=? AND decision_key='PLAN_CONTINUATION' AND state='RESOLVED' ORDER BY created_event_sequence DESC LIMIT 1").get(goalId) as { selection_json?: unknown } | undefined;
    const continuationChoice = continuation ? parseJson<{ choice?: unknown }>(continuation.selection_json, "Plan continuation").choice : null;
    const control = this.connection.prepare("SELECT selection_json FROM task_decision_entries_v1 WHERE goal_id=? AND decision_key='USER_CONTROL' AND state='RESOLVED' ORDER BY created_event_sequence DESC LIMIT 1").get(goalId) as { selection_json?: unknown } | undefined;
    const controlAction = control ? parseJson<{ action?: unknown }>(control.selection_json, "Task Flow control").action : null;
    const incomplete = Number((this.connection.prepare("SELECT count(*) count FROM work_cell_heads_v1 WHERE goal_id=? AND route_id=? AND status<>'SUCCEEDED'").get(goalId, currentRouteId) as { count?: unknown } | undefined)?.count ?? 0);
    let status: TaskFlowCurrentView["status"];
    let nextActionCode: string;
    if (controlAction === "CANCEL") { status = "CANCELED"; nextActionCode = "NONE"; }
    else if (controlAction === "PAUSE") { status = "WAITING_USER"; nextActionCode = "RESUME"; }
    else if (deliverable) { status = String(deliverable.result) as TaskFlowCurrentView["status"]; nextActionCode = "NONE"; }
    else if (continuationChoice === "KEEP") { status = "SUCCEEDED"; nextActionCode = "NONE"; }
    else if (unresolved > 0) { status = "RECONCILING"; nextActionCode = "RECONCILE_OPERATION"; }
    else if (!contract) { status = "CONTRACTING"; nextActionCode = "SUBMIT_CONTRACT"; }
    else if (!route || continuationChoice === "REVISE") { status = "PLANNING"; nextActionCode = "SUBMIT_ROUTE"; }
    else if (mode.intent === "PLAN" && continuationChoice !== "BUILD") { status = "WAITING_USER"; nextActionCode = "PLAN_CONTINUATION"; }
    else if (liveAuthorization) { status = "BUILDING"; nextActionCode = "EXECUTE_WORK"; }
    else if (incomplete === 0 && route) {
      const routeRow = this.connection.prepare("SELECT route_json FROM route_skeleton_versions_v1 WHERE route_id=?").get(currentRouteId) as { route_json?: unknown } | undefined;
      const currentRoute = routeRow ? parseJson<RouteSkeletonRecord>(routeRow.route_json, "RouteSkeleton") : null;
      const deferred = currentRoute?.schema_version === 2 && (currentRoute.deferred_outcomes?.length ?? 0) > 0;
      status = deferred ? "PLANNING" : "BUILDING";
      nextActionCode = deferred ? "SUBMIT_ROUTE" : "CLOSE_GOAL";
    }
    else { status = "BUILDING"; nextActionCode = "AUTHORIZE_WORK"; }
    const currentContractId = contract ? boundedId(contract.contract_id, "contract_id") : null;
    this.connection.prepare(`INSERT INTO task_flow_goal_heads_v1(goal_id,status,next_action_code,current_contract_id,current_route_id,current_work_cell_id,updated_event_sequence)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET status=excluded.status,next_action_code=excluded.next_action_code,
      current_contract_id=excluded.current_contract_id,current_route_id=excluded.current_route_id,current_work_cell_id=excluded.current_work_cell_id,
      updated_event_sequence=excluded.updated_event_sequence`).run(
      goalId, status, nextActionCode, currentContractId, currentRouteId,
      liveAuthorization?.work_cell_id === undefined ? null : boundedId(liveAuthorization.work_cell_id, "work_cell_id"), eventSequence,
    );
  }

  verifyIntegrity(): TaskFlowIntegritySummary {
    if (!this.available()) return { available: false, contracts: 0, routes: 0, workCells: 0, operations: 0, evidence: 0, headMismatches: 0, multipleRunningGoals: 0, unresolvedOperations: 0 };
    const count = (table: string): number => Number((this.connection.prepare(`SELECT count(*) count FROM ${table}`).get() as { count?: unknown } | undefined)?.count ?? 0);
    let headMismatches = 0;
    for (const row of this.connection.prepare("SELECT contract_json,record_sha256 FROM goal_contract_versions_v1").all() as Record<string, unknown>[]) { const record = parseJson<GoalContractRecord>(row.contract_json, "GoalContract"); assertGoalContract(record); if (record.record_sha256 !== row.record_sha256) headMismatches += 1; }
    for (const row of this.connection.prepare("SELECT route_json,record_sha256 FROM route_skeleton_versions_v1").all() as Record<string, unknown>[]) { const route = parseJson<RouteSkeletonRecord>(row.route_json, "RouteSkeleton"); const contractRow = this.connection.prepare("SELECT contract_json FROM goal_contract_versions_v1 WHERE contract_id=?").get(route.contract_id) as { contract_json?: unknown } | undefined; if (!contractRow) { headMismatches += 1; continue; } const contract = parseJson<GoalContractRecord>(contractRow.contract_json, "GoalContract"); assertRouteSkeleton(route, contract); if (route.record_sha256 !== row.record_sha256) headMismatches += 1; }
    for (const row of this.connection.prepare("SELECT * FROM task_decision_entries_v1").all() as Record<string, unknown>[]) this.decisionFromRow(row);
    for (const row of this.connection.prepare("SELECT l.*,a.goal_id attempt_goal_id FROM operation_reconcile_locators_v1 l JOIN operation_attempts_v1 a ON a.attempt_id=l.attempt_id").all() as Record<string, unknown>[]) {
      const locator: OperationReconcileLocatorRecord = {
        schema_version: 1, locator_id: boundedId(row.locator_id, "locator_id"), attempt_id: boundedId(row.attempt_id, "attempt_id"),
        goal_id: boundedId(row.goal_id, "goal_id"), target_relative: String(row.target_relative),
        preimage_sha256: sha(row.preimage_sha256, "preimage_sha256"), expected_postimage_sha256: row.expected_postimage_sha256 === null ? null : sha(row.expected_postimage_sha256, "expected_postimage_sha256"),
        created_at_ms: Number(row.created_at_ms), record_sha256: sha(row.record_sha256, "record_sha256"),
      };
      assertOperationReconcileLocator(locator);
      if (locator.goal_id !== row.attempt_goal_id) headMismatches += 1;
    }
    const invalidContractHeads = Number((this.connection.prepare(`SELECT count(*) count FROM goal_contract_heads_v1 h LEFT JOIN goal_contract_versions_v1 v ON v.contract_id=h.contract_id
      WHERE v.contract_id IS NULL OR v.goal_id<>h.goal_id OR v.version<>h.version OR v.record_sha256<>h.contract_sha256`).get() as { count?: unknown } | undefined)?.count ?? 0);
    const invalidRouteHeads = Number((this.connection.prepare(`SELECT count(*) count FROM route_skeleton_heads_v1 h LEFT JOIN route_skeleton_versions_v1 v ON v.route_id=h.route_id
      WHERE v.route_id IS NULL OR v.goal_id<>h.goal_id OR v.revision<>h.revision OR v.record_sha256<>h.route_sha256`).get() as { count?: unknown } | undefined)?.count ?? 0);
    headMismatches += invalidContractHeads + invalidRouteHeads;
    const multipleRunningGoals = Number((this.connection.prepare("SELECT count(*) count FROM (SELECT goal_id FROM work_cell_heads_v1 WHERE status='RUNNING' GROUP BY goal_id HAVING count(*)>1)").get() as { count?: unknown } | undefined)?.count ?? 0);
    const unresolvedOperations = Number((this.connection.prepare("SELECT count(*) count FROM operation_heads_v1 WHERE state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')").get() as { count?: unknown } | undefined)?.count ?? 0);
    const missingGoalHeads = Number((this.connection.prepare("SELECT count(*) count FROM task_flow_modes_v1 m LEFT JOIN task_flow_goal_heads_v1 h ON h.goal_id=m.goal_id WHERE h.goal_id IS NULL").get() as { count?: unknown } | undefined)?.count ?? 0);
    const workCellHeadMismatch = Math.abs(count("work_cells_v1") - count("work_cell_heads_v1"));
    const operationHeadMismatch = Math.abs(count("operation_attempts_v1") - count("operation_heads_v1"));
    headMismatches += missingGoalHeads + workCellHeadMismatch + operationHeadMismatch;
    if (headMismatches > 0 || multipleRunningGoals > 0) throw new AuthorityIntegrityError("Task Flow current-view integrity failed");
    return { available: true, contracts: count("goal_contract_versions_v1"), routes: count("route_skeleton_versions_v1"), workCells: count("work_cells_v1"), operations: count("operation_attempts_v1"), evidence: count("evidence_attestations_v1"), headMismatches, multipleRunningGoals, unresolvedOperations };
  }
}
