import type { PlanPackage, StageRuntimeStatus } from "../../planning/types.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { sha256Hex } from "../../foundation/crypto.js";
import { assertGoalTransition, assertStageTransition, type GoalStatus, type StageStatus } from "../state-machines.js";
import { canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { ReceiptRepository } from "./receipts.js";

export interface WorkflowAdvance {
  readonly completedStageId: string;
  readonly nextStageId: string | null;
  readonly terminal: boolean;
  readonly stageReceiptId: string;
  readonly validationReceiptIds: readonly string[];
  readonly acceptanceReceiptIds: readonly string[];
  readonly deliveryReceiptId: string | null;
}

export interface WorkflowState {
  readonly planId: string;
  readonly stageStatuses: Readonly<Record<string, StageRuntimeStatus>>;
  readonly currentStageId: string | null;
  readonly nextStageId: string | null;
  readonly terminal: boolean;
}

interface StageRow {
  readonly stage_id: string;
  readonly status: StageStatus;
  readonly spec_sha256: string;
  readonly ordinal: number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`${field} must be text`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`${field} must be an integer`);
  return value;
}

export class WorkflowRepository {
  private readonly receipts: ReceiptRepository;

  constructor(private readonly connection: AuthorityConnection) {
    this.receipts = new ReceiptRepository(connection);
  }

  initializePlan(plan: PlanPackage, eventSequence: number): void {
    for (const stage of plan.plan.stages) {
      const status: StageStatus = stage.dependencies.length === 0 ? "READY" : "PLANNED";
      this.connection.prepare(`INSERT INTO stage_heads(stage_id,goal_id,status,row_version,last_event_sequence)
        VALUES(?,?,?,1,?)`).run(stage.id, plan.package.goal_id, status, eventSequence);
    }
  }

  authorize(goalId: string, planId: string, stageId: string, eventSequence: number): void {
    this.assertCurrentPlan(goalId, planId);
    const running = this.connection.prepare(`SELECT h.stage_id FROM stage_heads h JOIN plan_stages s ON s.stage_id=h.stage_id
      WHERE h.goal_id=? AND h.status='RUNNING' AND s.plan_id=? LIMIT 1`).get(goalId, planId) as { stage_id?: unknown } | undefined;
    if (running) throw new AuthorityIntegrityError(`Stage ${String(running.stage_id)} already owns execution`);
    if (this.unresolvedDecisionCount(goalId) > 0) throw new AuthorityIntegrityError("Stage authorization is blocked by an unresolved Decision");
    if (this.pendingEffectCount(goalId) > 0) throw new AuthorityIntegrityError("Stage authorization is blocked by a pending effect");
    const row = this.stage(planId, stageId);
    if (row.status !== "READY" && row.status !== "PLANNED") throw new AuthorityIntegrityError(`Stage ${stageId} is not eligible from ${row.status}`);
    if (!this.dependenciesSucceeded(planId, stageId)) throw new AuthorityIntegrityError(`Stage ${stageId} dependencies are not satisfied`);
    assertStageTransition(row.status, "RUNNING");
    this.updateStage(stageId, row.status, "RUNNING", eventSequence);
  }

  complete(
    goalId: string,
    planId: string,
    stageId: string,
    completionSummarySha256: string,
    issuedAtMs: number,
    eventSequence: number,
  ): WorkflowAdvance {
    this.assertCurrentPlan(goalId, planId);
    const row = this.stage(planId, stageId);
    if (row.status !== "RUNNING") throw new AuthorityIntegrityError(`Stage ${stageId} cannot complete from ${row.status}`);
    if (this.pendingEffectCount(goalId) > 0) throw new AuthorityIntegrityError("Stage completion requires zero pending effects");
    const validationReceiptIds = this.successfulValidationReceipts(goalId, planId, stageId);
    if (validationReceiptIds.length === 0) {
      throw new AuthorityIntegrityError("Stage completion requires a successful allowlisted local validation receipt");
    }
    const evidenceSha256 = canonicalJsonSha256({ completionSummarySha256, validationReceiptIds });
    const stageReceiptId = idFromSha256("RCP", sha256Hex(`STAGE_COMPLETION\0${planId}\0${stageId}\0${evidenceSha256}`));
    this.receipts.insert({
      receiptId: stageReceiptId, goalId, receiptType: "STAGE_COMPLETION", subjectType: "STAGE", subjectId: stageId,
      result: "SUCCEEDED", inputClosureSha256: canonicalJsonSha256({ planId, stageId, stageSpecSha256: row.spec_sha256 }),
      outputSha256: evidenceSha256, body: { completionSummarySha256, planId, validationReceiptIds },
      issuer: "WorkflowCoordinator", issuedAtMs, issuedEventSequence: eventSequence,
    });
    assertStageTransition("RUNNING", "SUCCEEDED");
    this.updateStage(stageId, "RUNNING", "SUCCEEDED", eventSequence);
    this.promoteReadyStages(planId, goalId, eventSequence);

    const terminal = this.planIsComplete(planId);
    const acceptanceReceiptIds = terminal ? this.closeAcceptance(goalId, planId, issuedAtMs, eventSequence) : [];
    const deliveryReceiptId = terminal
      ? this.closeDelivery(goalId, planId, acceptanceReceiptIds, issuedAtMs, eventSequence)
      : null;
    const nextStageId = terminal ? null : this.nextEligibleStage(planId);
    return {
      completedStageId: stageId, nextStageId, terminal, stageReceiptId,
      validationReceiptIds, acceptanceReceiptIds, deliveryReceiptId,
    };
  }

  transitionGoal(input: {
    readonly goalId: string;
    readonly action: "pause" | "resume" | "cancel" | "plan_complete" | "complete" | "wait_user" | "decision_resolved" | "plan_continue";
    readonly fromStatus: GoalStatus;
    readonly toStatus: GoalStatus;
    readonly planId: string | null;
    readonly stageId: string | null;
  }, eventSequence: number): void {
    const current = this.goalStatus(input.goalId);
    if (current !== input.fromStatus) throw new AuthorityIntegrityError(`Goal transition expected ${input.fromStatus} but authority is ${current}`);
    assertGoalTransition(input.fromStatus, input.toStatus);
    if (input.action === "pause") {
      if (input.planId) this.suspend(input.goalId, input.planId, input.stageId, eventSequence);
    } else if (input.action === "resume") {
      if (input.planId && input.stageId) this.resume(input.goalId, input.planId, input.stageId, eventSequence);
    } else if (input.action === "cancel") {
      this.cancel(input.goalId, eventSequence);
    }
  }

  goalStatus(goalId: string): GoalStatus {
    const row = this.connection.prepare(`SELECT payload_json FROM events WHERE goal_id=? AND event_type='GOAL_TRANSITIONED'
      ORDER BY sequence DESC LIMIT 1`).get(goalId) as { payload_json?: unknown } | undefined;
    if (typeof row?.payload_json !== "string") return "ACTIVE";
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const status = payload.toStatus;
    return typeof status === "string" ? status as GoalStatus : "ACTIVE";
  }

  suspend(goalId: string, planId: string, stageId: string | null, eventSequence: number): void {
    if (!stageId) return;
    this.assertCurrentPlan(goalId, planId);
    const row = this.stage(planId, stageId);
    if (row.status !== "RUNNING") throw new AuthorityIntegrityError(`Stage ${stageId} cannot pause from ${row.status}`);
    assertStageTransition("RUNNING", "WAITING_USER");
    this.updateStage(stageId, "RUNNING", "WAITING_USER", eventSequence);
  }

  resume(goalId: string, planId: string, stageId: string, eventSequence: number): void {
    this.assertCurrentPlan(goalId, planId);
    const row = this.stage(planId, stageId);
    if (row.status !== "WAITING_USER") throw new AuthorityIntegrityError(`Stage ${stageId} cannot resume from ${row.status}`);
    assertStageTransition("WAITING_USER", "RUNNING");
    this.updateStage(stageId, "WAITING_USER", "RUNNING", eventSequence);
  }

  cancel(goalId: string, eventSequence: number): void {
    const rows = this.connection.prepare(`SELECT h.stage_id,h.status FROM stage_heads h
      WHERE h.goal_id=? AND h.status NOT IN ('SUCCEEDED','FAILED','SKIPPED','INVALIDATED')`).all(goalId) as Record<string, unknown>[];
    for (const row of rows) {
      const stageId = text(row.stage_id, "stage_heads.stage_id");
      const status = text(row.status, "stage_heads.status") as StageStatus;
      assertStageTransition(status, "INVALIDATED");
      this.updateStage(stageId, status, "INVALIDATED", eventSequence);
    }
  }

  invalidateRoute(
    goalId: string,
    planId: string,
    causeId: string,
    evidenceSha256: string,
    reason: string,
    eventSequence: number,
  ): readonly string[] {
    this.assertCurrentPlan(goalId, planId);
    const targets: { type: "PLAN" | "STAGE"; id: string }[] = [{ type: "PLAN", id: planId }];
    const stages = this.connection.prepare(`SELECT h.stage_id,h.status FROM stage_heads h JOIN plan_stages s ON s.stage_id=h.stage_id
      WHERE s.plan_id=? ORDER BY s.ordinal`).all(planId) as Record<string, unknown>[];
    for (const row of stages) {
      const stageId = text(row.stage_id, "stage_heads.stage_id");
      const status = text(row.status, "stage_heads.status") as StageStatus;
      if (status !== "SUCCEEDED" && status !== "FAILED" && status !== "SKIPPED" && status !== "INVALIDATED") {
        assertStageTransition(status, "INVALIDATED");
        this.updateStage(stageId, status, "INVALIDATED", eventSequence);
        targets.push({ type: "STAGE", id: stageId });
      }
    }
    for (const target of targets) {
      const invalidationId = idFromSha256("INV", sha256Hex(`${goalId}\0${causeId}\0${target.type}\0${target.id}\0${evidenceSha256}`));
      this.connection.prepare(`INSERT INTO invalidations(invalidation_id,goal_id,cause_type,cause_id,target_type,target_id,
        evidence_sha256,reason,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        invalidationId, goalId, "ROUTE_DECISION", causeId, target.type, target.id,
        evidenceSha256, reason.normalize("NFC"), eventSequence,
      );
    }
    return targets.map((target) => target.id);
  }

  state(goalId: string, planId: string): WorkflowState {
    const rows = this.connection.prepare(`SELECT s.stage_id,s.ordinal,COALESCE(h.status,'PLANNED') AS status
      FROM plan_stages s LEFT JOIN stage_heads h ON h.stage_id=s.stage_id
      WHERE s.plan_id=? AND s.goal_id=? ORDER BY s.ordinal`).all(planId, goalId) as Record<string, unknown>[];
    if (rows.length === 0) throw new AuthorityIntegrityError(`Plan ${planId} has no Stages`);
    const stageStatuses = Object.fromEntries(rows.map((row) => [text(row.stage_id, "plan_stages.stage_id"), text(row.status, "stage_heads.status") as StageRuntimeStatus]));
    const currentStageId = rows.find((row) => row.status === "RUNNING" || row.status === "WAITING_USER")?.stage_id;
    return {
      planId,
      stageStatuses,
      currentStageId: typeof currentStageId === "string" ? currentStageId : null,
      nextStageId: this.nextEligibleStage(planId),
      terminal: rows.every((row) => row.status === "SUCCEEDED"),
    };
  }

  private assertCurrentPlan(goalId: string, planId: string): void {
    const row = this.connection.prepare("SELECT plan_id FROM plan_revisions WHERE goal_id=? ORDER BY revision DESC LIMIT 1").get(goalId) as { plan_id?: unknown } | undefined;
    if (row?.plan_id !== planId) throw new AuthorityIntegrityError(`Plan ${planId} is not the current PlanRevision`);
    const invalidated = this.connection.prepare("SELECT COUNT(*) AS count FROM invalidations WHERE goal_id=? AND target_type='PLAN' AND target_id=?").get(goalId, planId) as { count?: unknown } | undefined;
    if (Number(invalidated?.count ?? 0) > 0) throw new AuthorityIntegrityError(`Plan ${planId} is invalidated`);
  }

  private stage(planId: string, stageId: string): StageRow {
    const row = this.connection.prepare(`SELECT s.stage_id,s.spec_sha256,s.ordinal,h.status FROM plan_stages s
      JOIN stage_heads h ON h.stage_id=s.stage_id WHERE s.plan_id=? AND s.stage_id=?`).get(planId, stageId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError(`Stage ${stageId} does not belong to Plan ${planId}`);
    return {
      stage_id: text(row.stage_id, "plan_stages.stage_id"), status: text(row.status, "stage_heads.status") as StageStatus,
      spec_sha256: text(row.spec_sha256, "plan_stages.spec_sha256"), ordinal: integer(row.ordinal, "plan_stages.ordinal"),
    };
  }

  private updateStage(stageId: string, from: StageStatus, to: StageStatus, eventSequence: number): void {
    const result = this.connection.prepare(`UPDATE stage_heads SET status=?,row_version=row_version+1,last_event_sequence=?
      WHERE stage_id=? AND status=?`).run(to, eventSequence, stageId, from);
    if (result.changes !== 1) throw new AuthorityIntegrityError(`Stage ${stageId} transition ${from} -> ${to} lost CAS`);
  }

  private dependenciesSucceeded(planId: string, stageId: string): boolean {
    const row = this.connection.prepare(`SELECT COUNT(*) AS count FROM stage_dependencies d
      LEFT JOIN stage_heads h ON h.stage_id=d.depends_on_stage_id
      WHERE d.plan_id=? AND d.stage_id=? AND COALESCE(h.status,'PLANNED')<>'SUCCEEDED'`).get(planId, stageId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === 0;
  }

  private promoteReadyStages(planId: string, goalId: string, eventSequence: number): void {
    const planned = this.connection.prepare(`SELECT s.stage_id FROM plan_stages s JOIN stage_heads h ON h.stage_id=s.stage_id
      WHERE s.plan_id=? AND s.goal_id=? AND h.status='PLANNED' ORDER BY s.ordinal`).all(planId, goalId) as Record<string, unknown>[];
    for (const row of planned) {
      const stageId = text(row.stage_id, "plan_stages.stage_id");
      if (this.dependenciesSucceeded(planId, stageId)) {
        assertStageTransition("PLANNED", "READY");
        this.updateStage(stageId, "PLANNED", "READY", eventSequence);
      }
    }
  }

  private nextEligibleStage(planId: string): string | null {
    const row = this.connection.prepare(`SELECT s.stage_id FROM plan_stages s JOIN stage_heads h ON h.stage_id=s.stage_id
      WHERE s.plan_id=? AND h.status='READY' ORDER BY s.ordinal LIMIT 1`).get(planId) as { stage_id?: unknown } | undefined;
    return typeof row?.stage_id === "string" ? row.stage_id : null;
  }

  private planIsComplete(planId: string): boolean {
    const row = this.connection.prepare(`SELECT COUNT(*) AS count FROM plan_stages s JOIN stage_heads h ON h.stage_id=s.stage_id
      WHERE s.plan_id=? AND h.status<>'SUCCEEDED'`).get(planId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === 0;
  }

  private pendingEffectCount(goalId: string): number {
    const row = this.connection.prepare(`SELECT COUNT(*) AS count FROM effects e LEFT JOIN effect_outcomes o ON o.effect_id=e.effect_id
      WHERE e.goal_id=? AND o.effect_id IS NULL`).get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  private unresolvedDecisionCount(goalId: string): number {
    const row = this.connection.prepare(`SELECT COUNT(*) AS count FROM decisions d LEFT JOIN decision_resolutions r ON r.decision_id=d.decision_id
      WHERE d.goal_id=? AND r.decision_id IS NULL`).get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  private successfulValidationReceipts(goalId: string, planId: string, stageId: string): string[] {
    const rows = this.connection.prepare(`SELECT r.receipt_id,r.result,r.issued_event_sequence,w.action_spec_json FROM receipts r
      JOIN effects e ON e.effect_id=r.subject_id JOIN work_items w ON w.work_item_id=e.work_item_id
      WHERE r.goal_id=? AND w.plan_id=? AND w.stage_id=? AND r.receipt_type='EFFECT_OUTCOME'
      ORDER BY r.issued_event_sequence,r.receipt_id`).all(goalId, planId, stageId) as Record<string, unknown>[];
    const effects = rows.flatMap((row) => {
      if (typeof row.action_spec_json !== "string") return [];
      const spec = JSON.parse(row.action_spec_json) as Record<string, unknown>;
      return [{
        classificationReason: typeof spec.classification_reason === "string" ? spec.classification_reason : "",
        receiptId: text(row.receipt_id, "receipts.receipt_id"),
        result: text(row.result, "receipts.result"),
        sequence: integer(row.issued_event_sequence, "receipts.issued_event_sequence"),
      }];
    });
    // Even a failed file tool may have partially changed its target. Require a
    // later validator receipt before Stage exit instead of reusing stale proof.
    const lastWriteAttemptSequence = effects
      .filter((entry) => entry.classificationReason === "BUILTIN_FILE_WRITE")
      .reduce((latest, entry) => Math.max(latest, entry.sequence), 0);
    const validations = effects.filter((entry) => entry.classificationReason === "ALLOWLISTED_LOCAL_VALIDATION");
    const latestValidation = validations.at(-1);
    if (!latestValidation || latestValidation.result !== "SUCCEEDED"
      || latestValidation.sequence <= lastWriteAttemptSequence) return [];
    return [latestValidation.receiptId];
  }

  private closeAcceptance(goalId: string, planId: string, issuedAtMs: number, eventSequence: number): string[] {
    const criteria = this.connection.prepare(`SELECT DISTINCT a.criterion_id,a.spec_sha256 FROM acceptance_criteria a
      JOIN acceptance_stage_coverage c ON c.criterion_id=a.criterion_id WHERE c.plan_id=? ORDER BY a.criterion_id`).all(planId) as Record<string, unknown>[];
    if (criteria.length === 0) {
      throw new AuthorityIntegrityError("Delivery cannot close because acceptance coverage is incomplete");
    }
    const receiptIds: string[] = [];
    for (const criterion of criteria) {
      const criterionId = text(criterion.criterion_id, "acceptance_criteria.criterion_id");
      const stageReceipts = this.connection.prepare(`SELECT r.receipt_id FROM acceptance_stage_coverage c
        JOIN receipts r ON r.subject_type='STAGE' AND r.subject_id=c.stage_id AND r.receipt_type='STAGE_COMPLETION' AND r.result='SUCCEEDED'
        WHERE c.plan_id=? AND c.criterion_id=? ORDER BY r.receipt_id`).all(planId, criterionId) as Record<string, unknown>[];
      if (stageReceipts.length === 0) throw new AuthorityIntegrityError(`Acceptance ${criterionId} has no successful Stage evidence`);
      const evidenceReceiptIds = stageReceipts.map((row) => text(row.receipt_id, "receipts.receipt_id"));
      const outputSha256 = canonicalJsonSha256({ criterionId, evidenceReceiptIds });
      const receiptId = idFromSha256("RCP", sha256Hex(`ACCEPTANCE\0${planId}\0${criterionId}\0${outputSha256}`));
      this.receipts.insert({
        receiptId, goalId, receiptType: "ACCEPTANCE", subjectType: "ACCEPTANCE", subjectId: criterionId,
        result: "SUCCEEDED", inputClosureSha256: text(criterion.spec_sha256, "acceptance_criteria.spec_sha256"),
        outputSha256, body: { evidenceReceiptIds, planId }, issuer: "WorkflowCoordinator",
        issuedAtMs, issuedEventSequence: eventSequence,
      });
      receiptIds.push(receiptId);
    }
    return receiptIds;
  }

  private closeDelivery(goalId: string, planId: string, acceptanceReceiptIds: readonly string[], issuedAtMs: number, eventSequence: number): string {
    const outputSha256 = canonicalJsonSha256({ acceptanceReceiptIds, planId });
    const receiptId = idFromSha256("RCP", sha256Hex(`DELIVERY\0${goalId}\0${planId}\0${outputSha256}`));
    this.receipts.insert({
      receiptId, goalId, receiptType: "DELIVERY", subjectType: "GOAL", subjectId: goalId,
      result: "SUCCEEDED", inputClosureSha256: canonicalJsonSha256({ goalId, planId }), outputSha256,
      body: { acceptanceReceiptIds, planId, terminal: true }, issuer: "WorkflowCoordinator",
      issuedAtMs, issuedEventSequence: eventSequence,
    });
    return receiptId;
  }
}
