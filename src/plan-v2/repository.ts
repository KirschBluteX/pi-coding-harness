import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { DecisionClosureBundleV2 } from "../intake-v2/domain.js";
import { IntakeAuthorityV2Repository } from "../intake-v2/repository.js";
import {
  finalizePlanRevisionV2,
  type PlanRevisionV2,
} from "./finalize.js";
import {
  planSubjectKeyV2,
  validatePlanGraphV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";
import {
  finalizeStageGateReceiptV2,
  type PlanStageGateV2,
  type StageGateReceiptV2,
} from "./stage-gate.js";
import { derivePlanChangeImpactV2, type PlanChangeImpactV2 } from "./change-impact.js";
import {
  bindPlanChangeImpactV2,
  finalizePlanReuseReceiptV2,
  finalizeUserChangeRequestV2,
  planChangeImpactIdV2,
  type ChangeRequestClassificationV2,
  type ChangeRequestMaterialityV2,
  type ChangeRequestPlanImpactV2,
  type PlanReuseReceiptV2,
  type UserChangeRequestV2,
} from "./change-request.js";
import {
  correctionFamiliesV2,
  finalizeCorrectionAttemptV2,
  finalizeCorrectionBudgetV2,
  type CorrectionAttemptReceiptV2,
  type CorrectionAttemptResultV2,
  type CorrectionBudgetV2,
  type CorrectionFamilyV2,
} from "./correction-budget.js";
import {
  finalizeActiveGoalUserTurnV2,
  finalizeActiveGoalUserTurnClassificationV2,
  finalizeActiveGoalChangeRequestBindingV2,
  finalizeActiveGoalChangeTransitionV2,
  type ActiveGoalChangeRequestBindingV2,
  type ActiveGoalChangeTransitionV2,
  type ActiveGoalChangeKindV2,
  type ActiveGoalInputClosureV2,
  type ActiveGoalUserTurnClassificationV2,
  type ActiveGoalUserTurnBundleV2,
  type ActiveGoalUserTurnV2,
} from "./active-goal-input.js";
import {
  finalizeChangeAcceptanceClosureV2,
  finalizeDecisionPlanBindingV2,
  type ChangeAcceptanceClosureBundleV2,
  type ChangeAcceptanceMaterialRequestV2,
  type ChangeAcceptanceSemanticRecordV2,
  type DecisionPlanBindingBundleV2,
} from "./change-acceptance.js";

export const planAuthorityZeroSha256 = "0".repeat(64);

export interface PlanAuthorityProjectionV2 {
  readonly revision: PlanRevisionV2;
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
}

export interface ChangeRequestProjectionV2 {
  readonly request: UserChangeRequestV2;
  readonly impact: ChangeRequestPlanImpactV2;
  readonly reuse_receipts: readonly PlanReuseReceiptV2[];
}

export interface ActiveGoalChangeRequestProjectionV2 {
  readonly classification: ActiveGoalUserTurnClassificationV2;
  readonly change: ChangeRequestProjectionV2;
  readonly binding: ActiveGoalChangeRequestBindingV2;
}

export interface PlanAuthorityIntegritySummaryV2 {
  readonly available: boolean;
  readonly planRevisions: number;
  readonly stageGates: number;
  readonly changeRequests: number;
  readonly activeGoalUserTurns: number;
  readonly activeGoalInputClassifications: number;
  readonly activeGoalChangeRequests: number;
  readonly activeGoalChangeTransitions: number;
  readonly correctionBudgets: number;
  readonly correctionAttempts: number;
  readonly decisionPlanBindings: number;
  readonly changeAcceptances: number;
  readonly headMismatches: number;
}

interface DerivedPlanInputV2 {
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly contract_freeze_receipt_id: string;
  readonly contract_freeze_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly route_id: string;
  readonly route_sha256: string;
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
  readonly must_requirements: readonly PlanSubjectRefV2[];
  readonly work_cells: readonly PlanSubjectRefV2[];
}

const shaPattern = /^[a-f0-9]{64}$/u;
let savepointSequence = 0;

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Plan V2 ${key} is invalid`);
  return value;
}

function decisionPlanAuthorityInputs(
  intake: IntakeAuthorityV2Repository,
  closure: DecisionClosureBundleV2,
): {
  readonly decisions: readonly {
    readonly decision_requirement_revision_id: string;
    readonly decision_requirement_id: string;
    readonly record_sha256: string;
    readonly affected_work_cell_ids: readonly string[];
  }[];
  readonly resolutions: readonly {
    readonly decision_resolution_id: string;
    readonly record_sha256: string;
  }[];
} {
  const decisionsByRevisionId = new Map(intake.readDecisionRequirements(closure.closure.requirement_revision_id)
    .map((decision) => [decision.decision_requirement_revision_id, decision]));
  const resolutionsById = new Map(intake.readDecisionResolutions(closure.closure.requirement_revision_id)
    .map((resolution) => [resolution.decision_resolution_id, resolution]));
  return {
    decisions: closure.members.map((member) => {
      const decision = decisionsByRevisionId.get(member.decision_requirement_revision_id);
      if (!decision || decision.decision_requirement_id !== member.decision_requirement_id) {
        throw new AuthorityIntegrityError("Decision Plan binding lost a closure-bound Decision");
      }
      return {
        decision_requirement_revision_id: decision.decision_requirement_revision_id,
        decision_requirement_id: decision.decision_requirement_id,
        record_sha256: decision.record_sha256,
        affected_work_cell_ids: decision.affected_work_cell_ids,
      };
    }),
    resolutions: closure.members.map((member) => {
      if (member.decision_resolution_id === null) {
        throw new AuthorityIntegrityError("Decision Plan binding closure lacks an effective resolution");
      }
      const resolution = resolutionsById.get(member.decision_resolution_id);
      if (!resolution) {
        throw new AuthorityIntegrityError("Decision Plan binding lost a closure-bound resolution");
      }
      return {
        decision_resolution_id: resolution.decision_resolution_id,
        record_sha256: resolution.record_sha256,
      };
    }),
  };
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new AuthorityIntegrityError(`Plan V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Plan V2 ${key} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new AuthorityIntegrityError(`${label} is not a lowercase SHA-256`);
  }
  return value;
}

function stringArray(row: Record<string, unknown>, key: string): readonly string[] {
  const source = text(row, key);
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    throw new AuthorityIntegrityError(`Plan V2 ${key} is invalid JSON`, error);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")
    || canonicalJson(value as CanonicalJson) !== source) {
    throw new AuthorityIntegrityError(`Plan V2 ${key} is not a canonical string array`);
  }
  return value as string[];
}

function canonicalValue(row: Record<string, unknown>, key: string): CanonicalJson {
  const source = text(row, key);
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    throw new AuthorityIntegrityError(`Plan V2 ${key} is invalid JSON`, error);
  }
  if (canonicalJson(value) !== source) throw new AuthorityIntegrityError(`Plan V2 ${key} is not canonical JSON`);
  return value as CanonicalJson;
}

function eventSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new AuthorityIntegrityError("Plan V2 event sequence is invalid");
  return value;
}

function assertTransaction(connection: AuthorityConnection): void {
  if (!connection.isTransaction) throw new AuthorityIntegrityError("Plan V2 mutation must run inside the authority transaction");
}

function inSavepoint<T>(connection: AuthorityConnection, operation: () => T): T {
  const name = `plan_v2_${++savepointSequence}`;
  connection.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    connection.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function edgeIdentity(planRevisionId: string, edge: PlanDependencyEdgeV2): {
  readonly edge_id: string;
  readonly record_sha256: string;
} {
  const recordSha256 = canonicalJsonSha256({
    domain: "PCH-PLAN-DEPENDENCY-EDGE-V2",
    plan_revision_id: planRevisionId,
    source: edge.source,
    target: edge.target,
    dependency_kind: edge.dependency_kind,
  });
  return { edge_id: idFromSha256("PLAN_EDGE", recordSha256), record_sha256: recordSha256 };
}

function invalidationEdgeIdentity(
  impactId: string,
  edge: PlanChangeImpactV2["propagation_edges"][number],
): { readonly invalidation_edge_id: string; readonly record_sha256: string } {
  const recordSha256 = canonicalJsonSha256({
    domain: "PCH-PLAN-INVALIDATION-EDGE-V2",
    plan_change_impact_id: impactId,
    source: edge.source,
    target: edge.target,
    dependency_kind: edge.dependency_kind,
    invalidation_kind: "TRANSITIVE_DEPENDENT",
  });
  return { invalidation_edge_id: idFromSha256("PLAN_INVALIDATION_EDGE", recordSha256), record_sha256: recordSha256 };
}

function sameRecord(left: PlanRevisionV2, right: PlanRevisionV2): boolean {
  return canonicalJson(left as unknown as CanonicalJson) === canonicalJson(right as unknown as CanonicalJson);
}

function assertCanonicalEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual as CanonicalJson) !== canonicalJson(expected as CanonicalJson)) {
    throw new AuthorityIntegrityError(`${label} is not exact Host-derived authority`);
  }
}

export class PlanAuthorityV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return this.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_revisions_v2'")
      .get() !== undefined;
  }

  verifyIntegrity(): PlanAuthorityIntegritySummaryV2 {
    if (!this.available()) {
      return {
        available: false,
        planRevisions: 0,
        stageGates: 0,
        changeRequests: 0,
        activeGoalUserTurns: 0,
        activeGoalInputClassifications: 0,
        activeGoalChangeRequests: 0,
        activeGoalChangeTransitions: 0,
        correctionBudgets: 0,
        correctionAttempts: 0,
        decisionPlanBindings: 0,
        changeAcceptances: 0,
        headMismatches: 0,
      };
    }
    const revisionIds = this.connection.prepare("SELECT plan_revision_id FROM plan_revisions_v2 ORDER BY goal_id,revision")
      .all() as Record<string, unknown>[];
    for (const row of revisionIds) {
      if (!this.readPlanRevision(text(row, "plan_revision_id"))) {
        throw new AuthorityIntegrityError("Plan V2 revision cannot be rebuilt");
      }
    }
    const headMismatches = Number((this.connection.prepare(`SELECT count(*) count FROM (
      SELECT r.goal_id,max(r.revision) latest_revision FROM plan_revisions_v2 r GROUP BY r.goal_id
    ) latest LEFT JOIN plan_heads_v2 h ON h.goal_id=latest.goal_id
      WHERE h.goal_id IS NULL OR h.revision<>latest.latest_revision`).get() as { readonly count?: unknown } | undefined)?.count ?? 0);
    if (headMismatches > 0) throw new AuthorityIntegrityError("Plan V2 head is not the latest immutable revision");

    const stageGateIds = this.connection.prepare("SELECT stage_gate_receipt_id FROM stage_gate_receipts_v2 ORDER BY goal_id,created_event_sequence")
      .all() as Record<string, unknown>[];
    for (const row of stageGateIds) {
      if (!this.readStageGate(text(row, "stage_gate_receipt_id"))) {
        throw new AuthorityIntegrityError("Plan V2 StageGate cannot be rebuilt");
      }
    }
    const changeRequestIds = this.connection.prepare("SELECT change_request_id FROM change_requests_v2 ORDER BY goal_id,created_event_sequence")
      .all() as Record<string, unknown>[];
    for (const row of changeRequestIds) {
      if (!this.readChangeRequest(text(row, "change_request_id"))) {
        throw new AuthorityIntegrityError("Plan V2 ChangeRequest cannot be rebuilt");
      }
    }
    const activeGoalTurnIds = this.connection.prepare(
      "SELECT user_turn_id FROM active_goal_user_turns_v2 ORDER BY goal_id,created_event_sequence",
    ).all() as Record<string, unknown>[];
    for (const row of activeGoalTurnIds) {
      if (!this.readActiveGoalUserTurn(text(row, "user_turn_id"))) {
        throw new AuthorityIntegrityError("Active Goal user turn V2 cannot be rebuilt");
      }
    }
    const activeGoalClassificationIds = this.connection.prepare(
      "SELECT classification_id FROM active_goal_user_turn_classifications_v2 ORDER BY goal_id,created_event_sequence",
    ).all() as Record<string, unknown>[];
    for (const row of activeGoalClassificationIds) {
      if (!this.readActiveGoalUserTurnClassification(text(row, "classification_id"))) {
        throw new AuthorityIntegrityError("Active Goal input classification V2 cannot be rebuilt");
      }
    }
    const activeGoalChangeTurnIds = this.connection.prepare(
      "SELECT user_turn_id FROM active_goal_change_request_bindings_v2 ORDER BY goal_id,created_event_sequence",
    ).all() as Record<string, unknown>[];
    for (const row of activeGoalChangeTurnIds) {
      if (!this.readActiveGoalChangeRequestByTurn(text(row, "user_turn_id"))) {
        throw new AuthorityIntegrityError("Active Goal ChangeRequest binding V2 cannot be rebuilt");
      }
    }
    const activeGoalTransitionTurnIds = this.connection.prepare(`SELECT b.user_turn_id
      FROM active_goal_change_transitions_v2 t JOIN active_goal_change_request_bindings_v2 b
        ON b.binding_id=t.binding_id ORDER BY t.goal_id,t.created_event_sequence`).all() as Record<string, unknown>[];
    for (const row of activeGoalTransitionTurnIds) {
      if (!this.readActiveGoalChangeTransitionByTurn(text(row, "user_turn_id"))) {
        throw new AuthorityIntegrityError("Active Goal change transition V2 cannot be rebuilt");
      }
    }
    const budgetRows = this.connection.prepare("SELECT goal_id,count(*) count FROM correction_budgets_v2 GROUP BY goal_id")
      .all() as Record<string, unknown>[];
    let correctionBudgets = 0;
    for (const row of budgetRows) {
      const budgets = this.readCorrectionBudgets(text(row, "goal_id"));
      if (budgets.length !== integer(row, "count")) {
        throw new AuthorityIntegrityError("Plan V2 correction budget closure is incomplete");
      }
      correctionBudgets += budgets.length;
    }
    const attemptIds = this.connection.prepare("SELECT correction_attempt_id FROM correction_attempts_v2 ORDER BY goal_id,created_event_sequence")
      .all() as Record<string, unknown>[];
    for (const row of attemptIds) {
      if (!this.readCorrectionAttempt(text(row, "correction_attempt_id"))) {
        throw new AuthorityIntegrityError("Plan V2 correction attempt cannot be rebuilt");
      }
    }
    const decisionPlanBindingIds = this.connection.prepare(
      "SELECT decision_plan_binding_id FROM decision_plan_bindings_v2 ORDER BY goal_id,created_event_sequence",
    ).all() as Record<string, unknown>[];
    for (const row of decisionPlanBindingIds) {
      if (!this.readDecisionPlanBinding(text(row, "decision_plan_binding_id"))) {
        throw new AuthorityIntegrityError("Decision Plan binding V2 cannot be rebuilt");
      }
    }
    const changeAcceptanceIds = this.connection.prepare(
      "SELECT change_acceptance_closure_id FROM change_acceptance_closures_v2 ORDER BY goal_id,created_event_sequence",
    ).all() as Record<string, unknown>[];
    for (const row of changeAcceptanceIds) {
      if (!this.readChangeAcceptance(text(row, "change_acceptance_closure_id"))) {
        throw new AuthorityIntegrityError("Change Acceptance V2 cannot be rebuilt");
      }
    }
    return {
      available: true,
      planRevisions: revisionIds.length,
      stageGates: stageGateIds.length,
      changeRequests: changeRequestIds.length,
      activeGoalUserTurns: activeGoalTurnIds.length,
      activeGoalInputClassifications: activeGoalClassificationIds.length,
      activeGoalChangeRequests: activeGoalChangeTurnIds.length,
      activeGoalChangeTransitions: activeGoalTransitionTurnIds.length,
      correctionBudgets,
      correctionAttempts: attemptIds.length,
      decisionPlanBindings: decisionPlanBindingIds.length,
      changeAcceptances: changeAcceptanceIds.length,
      headMismatches,
    };
  }

  freezeCurrentPlan(input: {
    readonly goal_id: string;
    readonly expected_predecessor_plan_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): PlanAuthorityProjectionV2 {
    assertTransaction(this.connection);
    if (!this.available()) throw new AuthorityIntegrityError("Plan V2 authority schema is unavailable");
    sha(input.expected_predecessor_plan_sha256, "Plan V2 expected predecessor");
    this.assertEventContext(input.goal_id, sequence);
    return inSavepoint(this.connection, () => {
      const derived = this.deriveCurrentInput(input.goal_id);
      const current = this.readCurrentPlan(input.goal_id);
      if (current) {
        const currentProbe = finalizePlanRevisionV2({
          ...derived,
          revision: current.revision.revision,
          parent_plan_revision_id: current.revision.parent_plan_revision_id,
          parent_plan_revision_sha256: current.revision.parent_plan_revision_sha256,
          created_at_ms: current.revision.created_at_ms,
        });
        if (currentProbe.input_closure_sha256 === current.revision.input_closure_sha256) {
          const expected = input.expected_predecessor_plan_sha256;
          const exactRetryPredecessor = current.revision.parent_plan_revision_sha256 ?? planAuthorityZeroSha256;
          if (expected === current.revision.record_sha256 || expected === exactRetryPredecessor) {
            this.ensureCorrectionBudgets(current.revision, sequence);
            return current;
          }
          throw new AuthorityIntegrityError("Plan V2 expected-head CAS mismatch");
        }
        if (input.expected_predecessor_plan_sha256 !== current.revision.record_sha256) {
          throw new AuthorityIntegrityError("Plan V2 expected-head CAS mismatch");
        }
      } else if (input.expected_predecessor_plan_sha256 !== planAuthorityZeroSha256) {
        throw new AuthorityIntegrityError("Initial Plan V2 expected-head CAS mismatch");
      }

      const revision = (current?.revision.revision ?? 0) + 1;
      const record = finalizePlanRevisionV2({
        ...derived,
        revision,
        parent_plan_revision_id: current?.revision.plan_revision_id ?? null,
        parent_plan_revision_sha256: current?.revision.record_sha256 ?? null,
        created_at_ms: input.created_at_ms,
      });
      this.insertProjection({ revision: record, subjects: derived.subjects, edges: derived.edges }, sequence, current);
      this.ensureCorrectionBudgets(record, sequence);
      const restored = this.readCurrentPlan(input.goal_id);
      if (!restored || restored.revision.record_sha256 !== record.record_sha256) {
        throw new AuthorityIntegrityError("Plan V2 write did not rebuild its exact authority projection");
      }
      return restored;
    });
  }

  readCurrentPlan(goalId: string): PlanAuthorityProjectionV2 | null {
    const head = this.connection.prepare("SELECT * FROM plan_heads_v2 WHERE goal_id=?").get(goalId) as
      Record<string, unknown> | undefined;
    if (!head) return null;
    const projection = this.readPlanRevision(text(head, "plan_revision_id"));
    if (!projection
      || projection.revision.goal_id !== goalId
      || projection.revision.plan_id !== text(head, "plan_id")
      || projection.revision.revision !== integer(head, "revision")
      || projection.revision.record_sha256 !== text(head, "plan_revision_sha256")) {
      throw new AuthorityIntegrityError("Plan V2 head does not bind its immutable revision");
    }
    return projection;
  }

  readPlanRevision(planRevisionId: string): PlanAuthorityProjectionV2 | null {
    const row = this.connection.prepare("SELECT * FROM plan_revisions_v2 WHERE plan_revision_id=?")
      .get(planRevisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const subjectRows = this.connection.prepare("SELECT * FROM plan_subjects_v2 WHERE plan_revision_id=? ORDER BY ordinal")
      .all(planRevisionId) as Record<string, unknown>[];
    const subjects = subjectRows.map((subjectRow, ordinal): PlanSubjectRefV2 => {
      if (integer(subjectRow, "ordinal") !== ordinal || text(subjectRow, "goal_id") !== text(row, "goal_id")) {
        throw new AuthorityIntegrityError("Plan V2 subject ordinal or Goal identity is invalid");
      }
      const subject = {
        kind: text(subjectRow, "subject_kind") as PlanSubjectRefV2["kind"],
        id: text(subjectRow, "subject_id"),
        revision_sha256: sha(subjectRow.revision_sha256, "Plan V2 subject revision"),
      };
      this.assertSubjectBacking(subject, row);
      return subject;
    });
    const byKey = new Map(subjects.map((subject) => [planSubjectKeyV2(subject), subject]));
    const edgeRows = this.connection.prepare("SELECT * FROM plan_dependency_edges_v2 WHERE plan_revision_id=? ORDER BY ordinal")
      .all(planRevisionId) as Record<string, unknown>[];
    const edges = edgeRows.map((edgeRow, ordinal): PlanDependencyEdgeV2 => {
      if (integer(edgeRow, "ordinal") !== ordinal || text(edgeRow, "goal_id") !== text(row, "goal_id")) {
        throw new AuthorityIntegrityError("Plan V2 dependency ordinal or Goal identity is invalid");
      }
      const source = byKey.get(`${text(edgeRow, "source_kind")}\u0000${text(edgeRow, "source_id")}`);
      const target = byKey.get(`${text(edgeRow, "target_kind")}\u0000${text(edgeRow, "target_id")}`);
      if (!source || !target) throw new AuthorityIntegrityError("Plan V2 dependency lost a subject");
      const edge: PlanDependencyEdgeV2 = {
        source,
        target,
        dependency_kind: text(edgeRow, "dependency_kind") as PlanDependencyEdgeV2["dependency_kind"],
      };
      const identity = edgeIdentity(planRevisionId, edge);
      if (identity.edge_id !== text(edgeRow, "edge_id") || identity.record_sha256 !== text(edgeRow, "record_sha256")) {
        throw new AuthorityIntegrityError("Plan V2 dependency identity is invalid");
      }
      return edge;
    });
    const graph = validatePlanGraphV2(subjects, edges);
    const mustRequirements = graph.subjects.filter((subject) => subject.kind === "REQUIREMENT"
      && this.requirementPriority(subject.id) === "MUST");
    const workCells = graph.subjects.filter((subject) => subject.kind === "WORK_CELL");
    const stored: PlanRevisionV2 = {
      schema_version: 2,
      plan_revision_id: text(row, "plan_revision_id"),
      plan_id: text(row, "plan_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      authority_root_id: text(row, "authority_root_id"),
      contract_freeze_receipt_id: text(row, "contract_freeze_receipt_id"),
      contract_freeze_sha256: text(row, "contract_freeze_sha256"),
      requirement_revision_id: text(row, "requirement_revision_id"),
      requirement_revision_sha256: text(row, "requirement_revision_sha256"),
      route_id: text(row, "route_id"),
      route_sha256: text(row, "route_sha256"),
      revision: integer(row, "revision"),
      parent_plan_revision_id: nullableText(row, "parent_plan_revision_id"),
      parent_plan_revision_sha256: nullableText(row, "parent_plan_revision_sha256"),
      subject_root_sha256: text(row, "subject_root_sha256"),
      dependency_root_sha256: text(row, "dependency_root_sha256"),
      must_requirement_root_sha256: text(row, "must_requirement_root_sha256"),
      work_cell_root_sha256: text(row, "work_cell_root_sha256"),
      input_closure_sha256: text(row, "input_closure_sha256"),
      subject_count: integer(row, "subject_count"),
      dependency_count: integer(row, "dependency_count"),
      requirement_count: integer(row, "requirement_count"),
      work_cell_count: integer(row, "work_cell_count"),
      created_at_ms: integer(row, "created_at_ms"),
      record_sha256: text(row, "record_sha256"),
    };
    let expected: PlanRevisionV2;
    try {
      expected = finalizePlanRevisionV2({
        goal_id: stored.goal_id,
        contract_id: stored.contract_id,
        authority_root_id: stored.authority_root_id,
        contract_freeze_receipt_id: stored.contract_freeze_receipt_id,
        contract_freeze_sha256: stored.contract_freeze_sha256,
        requirement_revision_id: stored.requirement_revision_id,
        requirement_revision_sha256: stored.requirement_revision_sha256,
        route_id: stored.route_id,
        route_sha256: stored.route_sha256,
        revision: stored.revision,
        parent_plan_revision_id: stored.parent_plan_revision_id,
        parent_plan_revision_sha256: stored.parent_plan_revision_sha256,
        subjects: graph.subjects,
        edges: graph.edges,
        must_requirements: mustRequirements,
        work_cells: workCells,
        created_at_ms: stored.created_at_ms,
      });
    } catch (error) {
      throw new AuthorityIntegrityError("Stored Plan V2 graph is invalid", error);
    }
    if (!sameRecord(stored, expected)) throw new AuthorityIntegrityError("Stored Plan V2 revision is not Host-derived");
    return { revision: expected, subjects: graph.subjects, edges: graph.edges };
  }

  recordCurrentStageGate(input: {
    readonly goal_id: string;
    readonly plan_revision_id: string;
    readonly plan_revision_sha256: string;
    readonly gate: "PLAN_ENTRY" | "MATERIAL_CHANGE";
    readonly decision_closure_id: string;
    readonly decision_closure_sha256: string;
    readonly goal_fit_review_id: string;
    readonly goal_fit_review_sha256: string;
    readonly change_acceptance_closure_id: string | null;
    readonly change_acceptance_closure_sha256: string | null;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): StageGateReceiptV2 {
    assertTransaction(this.connection);
    const eventHeadSha256 = this.assertEventContext(input.goal_id, sequence, input.event_head_sha256);
    return inSavepoint(this.connection, () => {
      const plan = this.readCurrentPlan(input.goal_id);
      if (!plan) throw new AuthorityIntegrityError("Stage gate V2 requires a current Plan revision");
      if (plan.revision.plan_revision_id !== input.plan_revision_id
        || plan.revision.record_sha256 !== input.plan_revision_sha256) {
        throw new AuthorityIntegrityError("Stage gate V2 staged Plan identity is stale");
      }
      const intake = new IntakeAuthorityV2Repository(this.connection);
      const assessedReview = intake.readAssessedGoalFitReview(input.goal_fit_review_id);
      if (!assessedReview || assessedReview.review.record_sha256 !== input.goal_fit_review_sha256
        || assessedReview.review.gate !== input.gate
        || assessedReview.review.verdict !== "FIT"
        || assessedReview.binding.qualification_status !== "CURRENT_ASSESSED") {
        throw new AuthorityIntegrityError("Stage gate V2 exact staged Goal Fit review is invalid");
      }
      const review = assessedReview.review;
      const closure = intake.readDecisionClosure(input.decision_closure_id);
      if (!closure || closure.closure.record_sha256 !== input.decision_closure_sha256
        || review.decision_closure_id !== closure.closure.decision_closure_id
        || review.decision_closure_sha256 !== closure.closure.record_sha256) {
        throw new AuthorityIntegrityError("Stage gate V2 exact staged Decision closure is invalid");
      }
      if (input.gate === "MATERIAL_CHANGE") {
        const acceptance = this.readCurrentChangeAcceptance(input.goal_id);
        if (!acceptance
          || acceptance.closure.change_acceptance_closure_id !== input.change_acceptance_closure_id
          || acceptance.closure.record_sha256 !== input.change_acceptance_closure_sha256
          || assessedReview.gate_instance.gate_subject_kind !== "CHANGE_ACCEPTANCE_CLOSURE"
          || assessedReview.gate_instance.gate_subject_id !== acceptance.closure.change_acceptance_closure_id
          || assessedReview.gate_instance.gate_subject_sha256 !== acceptance.closure.record_sha256) {
          throw new AuthorityIntegrityError("Stage gate V2 MATERIAL_CHANGE lacks its exact Change Acceptance closure");
        }
      } else if (input.change_acceptance_closure_id !== null
        || input.change_acceptance_closure_sha256 !== null
        || assessedReview.gate_instance.gate_subject_kind !== "PLAN_REVISION"
        || assessedReview.gate_instance.gate_subject_id !== plan.revision.plan_revision_id
        || assessedReview.gate_instance.gate_subject_sha256 !== plan.revision.record_sha256) {
        throw new AuthorityIntegrityError("Stage gate V2 PLAN_ENTRY has a mismatched staged subject");
      }
      const receipt = finalizeStageGateReceiptV2({
        plan: plan.revision,
        decision_closure: closure,
        goal_fit_review: review,
        gate: input.gate,
        event_head_sha256: eventHeadSha256,
        created_at_ms: input.created_at_ms,
      });
      const result = this.connection.prepare(`INSERT OR IGNORE INTO stage_gate_receipts_v2(
        stage_gate_receipt_id,goal_id,plan_id,plan_revision_id,plan_revision_sha256,contract_id,authority_root_id,
        contract_freeze_receipt_id,contract_freeze_sha256,requirement_revision_id,requirement_revision_sha256,
        decision_closure_id,decision_closure_sha256,goal_fit_review_id,goal_fit_review_sha256,gate,event_head_sha256,
        review_owner,record_sha256,created_at_ms,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.stage_gate_receipt_id, receipt.goal_id, receipt.plan_id, receipt.plan_revision_id,
        receipt.plan_revision_sha256, receipt.contract_id, receipt.authority_root_id,
        receipt.contract_freeze_receipt_id, receipt.contract_freeze_sha256, receipt.requirement_revision_id,
        receipt.requirement_revision_sha256, receipt.decision_closure_id, receipt.decision_closure_sha256,
        receipt.goal_fit_review_id, receipt.goal_fit_review_sha256, receipt.gate, receipt.event_head_sha256,
        receipt.review_owner, receipt.record_sha256, receipt.created_at_ms, sequence,
      );
      if (Number(result.changes) === 0) {
        const existing = this.connection.prepare(`SELECT stage_gate_receipt_id FROM stage_gate_receipts_v2
          WHERE plan_revision_id=? AND gate=?`).get(receipt.plan_revision_id, receipt.gate) as Record<string, unknown> | undefined;
        const restored = existing ? this.readStageGate(text(existing, "stage_gate_receipt_id")) : null;
        if (!restored || restored.record_sha256 !== receipt.record_sha256) {
          throw new AuthorityIntegrityError("Stage gate V2 already has a different receipt");
        }
        return restored;
      }
      const restored = this.readStageGate(receipt.stage_gate_receipt_id);
      if (!restored) throw new AuthorityIntegrityError("Stage gate V2 write could not be rebuilt");
      return restored;
    });
  }

  readStageGate(stageGateReceiptId: string): StageGateReceiptV2 | null {
    const row = this.connection.prepare("SELECT * FROM stage_gate_receipts_v2 WHERE stage_gate_receipt_id=?")
      .get(stageGateReceiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plan = this.readPlanRevision(text(row, "plan_revision_id"));
    if (!plan) throw new AuthorityIntegrityError("Stage gate V2 lost its Plan revision");
    const intake = new IntakeAuthorityV2Repository(this.connection);
    const review = intake.readAssessedGoalFitReview(text(row, "goal_fit_review_id"))?.review ?? null;
    const closure = intake.readDecisionClosure(text(row, "decision_closure_id"));
    if (!review || !closure) throw new AuthorityIntegrityError("Stage gate V2 lost its Goal Fit closure");
    const lineage = this.connection.prepare(`SELECT p.created_event_sequence plan_sequence,
        r.created_event_sequence review_sequence
      FROM plan_revisions_v2 p JOIN goal_fit_reviews_v2 r ON r.goal_fit_review_id=?
      WHERE p.plan_revision_id=?`).get(
      review.goal_fit_review_id, plan.revision.plan_revision_id,
    ) as Record<string, unknown> | undefined;
    // GoalFit reviews are content-addressed semantic evidence and can be reused when the
    // Requirement/Decision closure is unchanged. The per-Plan StageGate is the fresh receipt.
    if (!lineage || integer(row, "created_event_sequence") <= integer(lineage, "plan_sequence")
      || integer(row, "created_event_sequence") <= integer(lineage, "review_sequence")) {
      throw new AuthorityIntegrityError("Stage gate V2 does not follow its current Plan and Goal Fit review");
    }
    const expected = finalizeStageGateReceiptV2({
      plan: plan.revision,
      decision_closure: closure,
      goal_fit_review: review,
      gate: text(row, "gate") as PlanStageGateV2,
      event_head_sha256: text(row, "event_head_sha256"),
      created_at_ms: integer(row, "created_at_ms"),
    });
    if (expected.stage_gate_receipt_id !== text(row, "stage_gate_receipt_id")
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.plan_revision_sha256 !== text(row, "plan_revision_sha256")
      || expected.goal_fit_review_sha256 !== text(row, "goal_fit_review_sha256")
      || expected.decision_closure_sha256 !== text(row, "decision_closure_sha256")) {
      throw new AuthorityIntegrityError("Stored stage gate V2 receipt is not Host-derived");
    }
    return expected;
  }

  readCurrentStageGate(goalId: string, gate: PlanStageGateV2): StageGateReceiptV2 | null {
    const row = this.connection.prepare(`SELECT g.stage_gate_receipt_id
      FROM stage_gate_receipts_v2 g JOIN plan_heads_v2 h
        ON h.goal_id=g.goal_id AND h.plan_revision_id=g.plan_revision_id
      WHERE g.goal_id=? AND g.gate=?`).get(goalId, gate) as Record<string, unknown> | undefined;
    return row ? this.readStageGate(text(row, "stage_gate_receipt_id")) : null;
  }

  qualifyCurrentPlanEntryGate(goalId: string): "PLAN_ENTRY" | "MATERIAL_CHANGE" {
    const successor = this.readCurrentPlan(goalId);
    if (!successor) throw new AuthorityIntegrityError("Plan entry qualification requires a current Plan revision");
    const parentId = successor.revision.parent_plan_revision_id;
    const parentSha256 = successor.revision.parent_plan_revision_sha256;
    if (parentId === null || parentSha256 === null) return "PLAN_ENTRY";
    return this.pendingMaterialRequests(goalId, parentId, parentSha256).length > 0
      ? "MATERIAL_CHANGE"
      : "PLAN_ENTRY";
  }

  readCurrentChangeAcceptance(goalId: string): ChangeAcceptanceClosureBundleV2 | null {
    const row = this.connection.prepare(`SELECT c.change_acceptance_closure_id
      FROM change_acceptance_closures_v2 c JOIN plan_heads_v2 h
        ON h.goal_id=c.goal_id AND h.plan_revision_id=c.successor_plan_revision_id
      WHERE c.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    return row ? this.readChangeAcceptance(text(row, "change_acceptance_closure_id")) : null;
  }

  readCurrentExecutionStageGate(goalId: string): StageGateReceiptV2 | null {
    const rows = this.connection.prepare(`SELECT g.stage_gate_receipt_id
      FROM stage_gate_receipts_v2 g JOIN plan_heads_v2 h
        ON h.goal_id=g.goal_id AND h.plan_revision_id=g.plan_revision_id
      WHERE g.goal_id=? AND g.gate IN ('PLAN_ENTRY','MATERIAL_CHANGE')
      ORDER BY g.created_event_sequence`).all(goalId) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new AuthorityIntegrityError("Current Plan has multiple execution StageGate receipts");
    }
    return rows[0] ? this.readStageGate(text(rows[0], "stage_gate_receipt_id")) : null;
  }

  captureActiveGoalUserTurn(input: {
    readonly closure: ActiveGoalInputClosureV2;
    readonly source: string | Uint8Array;
    readonly session_id: string;
    readonly turn_id: string;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): ActiveGoalUserTurnBundleV2 {
    assertTransaction(this.connection);
    const eventHeadSha256 = this.assertEventContext(input.closure.goal_id, sequence, input.event_head_sha256);
    const bundle = finalizeActiveGoalUserTurnV2({ ...input, event_head_sha256: eventHeadSha256 });
    this.connection.prepare(`INSERT INTO active_goal_user_turns_v2(
      user_turn_id,goal_id,goal_version,contract_sha256,route_sha256,plan_revision_id,
      plan_revision_sha256,stage_gate_sha256,execution_authorization_sha256,input_closure_sha256,
      source_kind,session_id,turn_id,event_head_sha256,source_bytes,content_sha256,byte_length,
      encoding,fidelity,captured_by,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      bundle.turn.user_turn_id, bundle.turn.goal_id, bundle.turn.goal_version,
      bundle.turn.contract_sha256, bundle.turn.route_sha256, bundle.turn.plan_revision_id,
      bundle.turn.plan_revision_sha256, bundle.turn.stage_gate_sha256,
      bundle.turn.execution_authorization_sha256, bundle.turn.input_closure_sha256,
      bundle.turn.source_kind, bundle.turn.session_id, bundle.turn.turn_id, bundle.turn.event_head_sha256,
      Buffer.from(bundle.source_bytes), bundle.turn.content_sha256, bundle.turn.byte_length,
      bundle.turn.encoding, bundle.turn.fidelity, bundle.turn.captured_by, bundle.turn.record_sha256,
      bundle.turn.created_at_ms, sequence,
    );
    const restored = this.readActiveGoalUserTurn(bundle.turn.user_turn_id);
    if (!restored || restored.turn.record_sha256 !== bundle.turn.record_sha256) {
      throw new AuthorityIntegrityError("Active Goal user turn V2 write did not rebuild its exact source closure");
    }
    return restored;
  }

  readActiveGoalUserTurn(userTurnId: string): ActiveGoalUserTurnBundleV2 | null {
    const row = this.connection.prepare("SELECT * FROM active_goal_user_turns_v2 WHERE user_turn_id=?")
      .get(userTurnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sourceBytes = row.source_bytes;
    if (!(sourceBytes instanceof Uint8Array)) throw new AuthorityIntegrityError("Active Goal user turn V2 source is invalid");
    const bundle = finalizeActiveGoalUserTurnV2({
      closure: {
        goal_id: text(row, "goal_id"),
        goal_version: integer(row, "goal_version"),
        contract_sha256: nullableText(row, "contract_sha256"),
        route_sha256: nullableText(row, "route_sha256"),
        plan_revision_id: nullableText(row, "plan_revision_id"),
        plan_revision_sha256: nullableText(row, "plan_revision_sha256"),
        stage_gate_sha256: nullableText(row, "stage_gate_sha256"),
        execution_authorization_sha256: nullableText(row, "execution_authorization_sha256"),
      },
      source: sourceBytes,
      session_id: text(row, "session_id"),
      turn_id: text(row, "turn_id"),
      event_head_sha256: text(row, "event_head_sha256"),
      created_at_ms: integer(row, "created_at_ms"),
    });
    if (bundle.turn.user_turn_id !== userTurnId
      || bundle.turn.record_sha256 !== text(row, "record_sha256")
      || bundle.turn.input_closure_sha256 !== text(row, "input_closure_sha256")
      || bundle.turn.content_sha256 !== text(row, "content_sha256")
      || bundle.turn.byte_length !== integer(row, "byte_length")) {
      throw new AuthorityIntegrityError("Stored Active Goal user turn V2 is not exact Host authority");
    }
    return bundle;
  }

  classifyActiveGoalUserTurn(input: {
    readonly user_turn_id: string;
    readonly expected_user_turn_sha256: string;
    readonly classification: ChangeRequestClassificationV2;
    readonly materiality: ChangeRequestMaterialityV2;
    readonly change_kind: ActiveGoalChangeKindV2 | null;
    readonly changed_subjects: readonly PlanSubjectRefV2[];
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): ActiveGoalUserTurnClassificationV2 {
    assertTransaction(this.connection);
    const turn = this.readActiveGoalUserTurn(input.user_turn_id)?.turn;
    if (!turn || turn.record_sha256 !== input.expected_user_turn_sha256) {
      throw new AuthorityIntegrityError("Active Goal input classification lost its exact captured turn CAS");
    }
    const existing = this.readActiveGoalUserTurnClassificationByTurn(turn.user_turn_id);
    if (existing) throw new AuthorityIntegrityError("Active Goal user turn already has a classification");
    const plan = turn.plan_revision_id === null ? null : this.readPlanRevision(turn.plan_revision_id);
    if ((plan?.revision.record_sha256 ?? null) !== turn.plan_revision_sha256) {
      throw new AuthorityIntegrityError("Active Goal input classification lost its captured Plan revision");
    }
    const eventHeadSha256 = this.assertEventContext(turn.goal_id, sequence, input.event_head_sha256);
    const classification = finalizeActiveGoalUserTurnClassificationV2({
      turn,
      plan_subjects: plan?.subjects ?? [],
      classification: input.classification,
      materiality: input.materiality,
      change_kind: input.change_kind,
      changed_subjects: input.changed_subjects,
      event_head_sha256: eventHeadSha256,
      created_at_ms: input.created_at_ms,
    });
    this.connection.prepare(`INSERT INTO active_goal_user_turn_classifications_v2(
      classification_id,user_turn_id,user_turn_sha256,goal_id,base_plan_revision_id,
      base_plan_revision_sha256,classification,materiality,change_kind,changed_subject_root_sha256,
      changed_subject_count,proposal_origin,event_head_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      classification.classification_id, classification.user_turn_id, classification.user_turn_sha256,
      classification.goal_id, classification.base_plan_revision_id, classification.base_plan_revision_sha256,
      classification.classification, classification.materiality, classification.change_kind,
      classification.changed_subject_root_sha256, classification.changed_subject_count,
      classification.proposal_origin, classification.event_head_sha256, classification.record_sha256,
      classification.created_at_ms, sequence,
    );
    const insertSubject = this.connection.prepare(`INSERT INTO active_goal_classification_subjects_v2(
      classification_id,goal_id,base_plan_revision_id,subject_kind,subject_id,revision_sha256,
      ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    classification.changed_subjects.forEach((subject, ordinal) => insertSubject.run(
      classification.classification_id, classification.goal_id, classification.base_plan_revision_id,
      subject.kind, subject.id, subject.revision_sha256, ordinal, sequence,
    ));
    const restored = this.readActiveGoalUserTurnClassification(classification.classification_id);
    if (!restored || restored.record_sha256 !== classification.record_sha256) {
      throw new AuthorityIntegrityError("Active Goal input classification V2 did not rebuild after commit");
    }
    return restored;
  }

  readActiveGoalUserTurnClassification(classificationId: string): ActiveGoalUserTurnClassificationV2 | null {
    const row = this.connection.prepare(
      "SELECT * FROM active_goal_user_turn_classifications_v2 WHERE classification_id=?",
    ).get(classificationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const turn = this.readActiveGoalUserTurn(text(row, "user_turn_id"))?.turn;
    if (!turn || turn.record_sha256 !== text(row, "user_turn_sha256")) {
      throw new AuthorityIntegrityError("Active Goal input classification lost its captured turn");
    }
    const plan = turn.plan_revision_id === null ? null : this.readPlanRevision(turn.plan_revision_id);
    const subjectRows = this.connection.prepare(`SELECT * FROM active_goal_classification_subjects_v2
      WHERE classification_id=? ORDER BY ordinal`).all(classificationId) as Record<string, unknown>[];
    const available = new Map((plan?.subjects ?? []).map((subject) => [planSubjectKeyV2(subject), subject]));
    const changedSubjects = subjectRows.map((subjectRow, ordinal) => {
      if (integer(subjectRow, "ordinal") !== ordinal) {
        throw new AuthorityIntegrityError("Active Goal input classification subject ordinal gap");
      }
      const subject = available.get(`${text(subjectRow, "subject_kind")}\u0000${text(subjectRow, "subject_id")}`);
      if (!subject || subject.revision_sha256 !== text(subjectRow, "revision_sha256")) {
        throw new AuthorityIntegrityError("Active Goal input classification subject left its captured Plan");
      }
      return subject;
    });
    const expected = finalizeActiveGoalUserTurnClassificationV2({
      turn,
      plan_subjects: plan?.subjects ?? [],
      classification: text(row, "classification") as ChangeRequestClassificationV2,
      materiality: text(row, "materiality") as ChangeRequestMaterialityV2,
      change_kind: nullableText(row, "change_kind") as ActiveGoalChangeKindV2 | null,
      changed_subjects: changedSubjects,
      event_head_sha256: text(row, "event_head_sha256"),
      created_at_ms: integer(row, "created_at_ms"),
    });
    if (expected.classification_id !== classificationId
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.changed_subject_root_sha256 !== text(row, "changed_subject_root_sha256")
      || expected.changed_subject_count !== integer(row, "changed_subject_count")) {
      throw new AuthorityIntegrityError("Stored Active Goal input classification V2 is not Host-derived");
    }
    return expected;
  }

  readActiveGoalUserTurnClassificationByTurn(userTurnId: string): ActiveGoalUserTurnClassificationV2 | null {
    const row = this.connection.prepare(
      "SELECT classification_id FROM active_goal_user_turn_classifications_v2 WHERE user_turn_id=?",
    ).get(userTurnId) as Record<string, unknown> | undefined;
    return row ? this.readActiveGoalUserTurnClassification(text(row, "classification_id")) : null;
  }

  captureActiveGoalChangeRequest(
    classificationId: string,
    sequence: number,
  ): ActiveGoalChangeRequestProjectionV2 {
    assertTransaction(this.connection);
    const classification = this.readActiveGoalUserTurnClassification(classificationId);
    if (!classification || !["CORRECT_CURRENT", "CHANGE_REQUEST", "INTERRUPT_NOW"].includes(classification.classification)) {
      throw new AuthorityIntegrityError("Active Goal ChangeRequest requires a material current-Goal classification");
    }
    const turnBundle = this.readActiveGoalUserTurn(classification.user_turn_id);
    const plan = classification.base_plan_revision_id === null
      ? null : this.readPlanRevision(classification.base_plan_revision_id);
    if (!turnBundle || !plan || plan.revision.record_sha256 !== classification.base_plan_revision_sha256) {
      throw new AuthorityIntegrityError("Active Goal ChangeRequest lost its captured source or Plan");
    }
    const requestBundle = finalizeUserChangeRequestV2({
      plan: plan.revision,
      subjects: plan.subjects,
      edges: plan.edges,
      classification: classification.classification,
      materiality: classification.materiality,
      request_payload: { change_kind: classification.change_kind },
      changed_subjects: classification.changed_subjects,
      source: turnBundle.source_bytes,
      source_authority: {
        user_turn_id: turnBundle.turn.user_turn_id,
        user_turn_sha256: turnBundle.turn.record_sha256,
        content_sha256: turnBundle.turn.content_sha256,
      },
      session_id: turnBundle.turn.session_id,
      turn_id: turnBundle.turn.turn_id,
      event_head_sha256: classification.event_head_sha256,
      created_at_ms: classification.created_at_ms,
    });
    const impact = bindPlanChangeImpactV2(requestBundle.request, derivePlanChangeImpactV2({
      plan_revision_id: plan.revision.plan_revision_id,
      plan_revision_sha256: plan.revision.record_sha256,
      changed_subjects: requestBundle.request.changed_subjects,
      subjects: plan.subjects,
      edges: plan.edges,
    }));
    const reuseReceipts = impact.reusable_subjects.map((subject) => finalizePlanReuseReceiptV2({
      request: requestBundle.request,
      impact,
      subject,
    }));
    this.insertChangeRequest(requestBundle.request, requestBundle.source_bytes, impact, reuseReceipts, sequence);
    const binding = finalizeActiveGoalChangeRequestBindingV2({
      turn: turnBundle.turn,
      classification,
      request: requestBundle.request,
      impact,
    });
    this.connection.prepare(`INSERT INTO active_goal_change_request_bindings_v2(
      binding_id,classification_id,classification_sha256,user_turn_id,user_turn_sha256,raw_content_sha256,
      change_request_id,change_request_sha256,plan_change_impact_id,plan_change_impact_sha256,goal_id,
      base_plan_revision_id,base_plan_revision_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      binding.binding_id, binding.classification_id, binding.classification_sha256,
      binding.user_turn_id, binding.user_turn_sha256, binding.raw_content_sha256,
      binding.change_request_id, binding.change_request_sha256, binding.plan_change_impact_id,
      binding.plan_change_impact_sha256, binding.goal_id, binding.base_plan_revision_id,
      binding.base_plan_revision_sha256, binding.record_sha256, binding.created_at_ms, sequence,
    );
    const restored = this.readActiveGoalChangeRequestByTurn(turnBundle.turn.user_turn_id);
    if (!restored || restored.binding.record_sha256 !== binding.record_sha256) {
      throw new AuthorityIntegrityError("Active Goal ChangeRequest did not rebuild its raw source binding");
    }
    return restored;
  }

  readActiveGoalChangeRequestByTurn(userTurnId: string): ActiveGoalChangeRequestProjectionV2 | null {
    const row = this.connection.prepare(
      "SELECT * FROM active_goal_change_request_bindings_v2 WHERE user_turn_id=?",
    ).get(userTurnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const classification = this.readActiveGoalUserTurnClassification(text(row, "classification_id"));
    const turn = this.readActiveGoalUserTurn(userTurnId)?.turn;
    const change = this.readChangeRequest(text(row, "change_request_id"));
    if (!classification || !turn || !change) {
      throw new AuthorityIntegrityError("Active Goal ChangeRequest binding lost one of its authority records");
    }
    const expected = finalizeActiveGoalChangeRequestBindingV2({
      turn,
      classification,
      request: change.request,
      impact: change.impact,
    });
    if (expected.binding_id !== text(row, "binding_id")
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.classification_sha256 !== text(row, "classification_sha256")
      || expected.user_turn_sha256 !== text(row, "user_turn_sha256")
      || expected.raw_content_sha256 !== text(row, "raw_content_sha256")
      || expected.change_request_sha256 !== text(row, "change_request_sha256")
      || expected.plan_change_impact_id !== text(row, "plan_change_impact_id")
      || expected.plan_change_impact_sha256 !== text(row, "plan_change_impact_sha256")) {
      throw new AuthorityIntegrityError("Stored Active Goal ChangeRequest binding is not exact");
    }
    return { classification, change, binding: expected };
  }

  recordActiveGoalChangeTransitions(input: {
    readonly goal_id: string;
    readonly successor_stage_gate: StageGateReceiptV2;
  }, sequence: number): readonly ActiveGoalChangeTransitionV2[] {
    assertTransaction(this.connection);
    const successor = this.readCurrentPlan(input.goal_id);
    if (!successor) throw new AuthorityIntegrityError("Active Goal change transition lacks its successor Plan");
    const parentPlanRevisionId = successor.revision.parent_plan_revision_id;
    const parentPlanRevisionSha256 = successor.revision.parent_plan_revision_sha256;
    if (parentPlanRevisionId === null || parentPlanRevisionSha256 === null) return [];
    return inSavepoint(this.connection, () => {
      const rows = this.connection.prepare(`SELECT b.user_turn_id
        FROM active_goal_change_request_bindings_v2 b
        LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
        WHERE b.goal_id=? AND b.base_plan_revision_id=? AND b.base_plan_revision_sha256=?
          AND t.transition_id IS NULL
        ORDER BY b.created_event_sequence,b.binding_id`).all(
        input.goal_id, parentPlanRevisionId, parentPlanRevisionSha256,
      ) as Record<string, unknown>[];
      const insert = this.connection.prepare(`INSERT INTO active_goal_change_transitions_v2(
        transition_id,binding_id,binding_sha256,classification_id,change_request_id,plan_change_impact_id,
        goal_id,base_plan_revision_id,base_plan_revision_sha256,successor_plan_revision_id,
        successor_plan_revision_sha256,successor_stage_gate_receipt_id,successor_stage_gate_sha256,
        record_sha256,created_at_ms,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      return rows.map((row) => {
        const userTurnId = text(row, "user_turn_id");
        const activeChange = this.readActiveGoalChangeRequestByTurn(userTurnId);
        if (!activeChange) {
          throw new AuthorityIntegrityError("Active Goal change transition lacks its binding");
        }
        const transition = finalizeActiveGoalChangeTransitionV2({
          binding: activeChange.binding,
          successor_plan: successor.revision,
          successor_stage_gate: input.successor_stage_gate,
        });
        insert.run(
          transition.transition_id, transition.binding_id, transition.binding_sha256,
          transition.classification_id, transition.change_request_id, transition.plan_change_impact_id,
          transition.goal_id, transition.base_plan_revision_id, transition.base_plan_revision_sha256,
          transition.successor_plan_revision_id, transition.successor_plan_revision_sha256,
          transition.successor_stage_gate_receipt_id, transition.successor_stage_gate_sha256,
          transition.record_sha256, transition.created_at_ms, sequence,
        );
        const restored = this.readActiveGoalChangeTransitionByTurn(userTurnId);
        if (!restored || restored.record_sha256 !== transition.record_sha256) {
          throw new AuthorityIntegrityError("Active Goal change transition did not rebuild after commit");
        }
        return restored;
      });
    });
  }

  readActiveGoalChangeTransitionByTurn(userTurnId: string): ActiveGoalChangeTransitionV2 | null {
    const row = this.connection.prepare(`SELECT t.* FROM active_goal_change_transitions_v2 t
      JOIN active_goal_change_request_bindings_v2 b ON b.binding_id=t.binding_id
      WHERE b.user_turn_id=?`).get(userTurnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const activeChange = this.readActiveGoalChangeRequestByTurn(userTurnId);
    const successor = this.readPlanRevision(text(row, "successor_plan_revision_id"));
    const gate = this.readStageGate(text(row, "successor_stage_gate_receipt_id"));
    if (!activeChange || !successor || !gate) {
      throw new AuthorityIntegrityError("Active Goal change transition lost a bound record");
    }
    const expected = finalizeActiveGoalChangeTransitionV2({
      binding: activeChange.binding,
      successor_plan: successor.revision,
      successor_stage_gate: gate,
    });
    if (expected.transition_id !== text(row, "transition_id")
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.binding_sha256 !== text(row, "binding_sha256")
      || expected.successor_plan_revision_sha256 !== text(row, "successor_plan_revision_sha256")
      || expected.successor_stage_gate_sha256 !== text(row, "successor_stage_gate_sha256")) {
      throw new AuthorityIntegrityError("Stored Active Goal change transition is not exact");
    }
    return expected;
  }

  readDecisionPlanBinding(decisionPlanBindingId: string): DecisionPlanBindingBundleV2 | null {
    const row = this.connection.prepare("SELECT * FROM decision_plan_bindings_v2 WHERE decision_plan_binding_id=?")
      .get(decisionPlanBindingId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plan = this.readPlanRevision(text(row, "plan_revision_id"));
    const intake = new IntakeAuthorityV2Repository(this.connection);
    const closure = intake.readDecisionClosure(text(row, "decision_closure_id"));
    if (!plan || !closure) throw new AuthorityIntegrityError("Decision Plan binding lost its source authority");
    const authorityInputs = decisionPlanAuthorityInputs(intake, closure);
    const expected = finalizeDecisionPlanBindingV2({
      plan: {
        plan_revision_id: plan.revision.plan_revision_id,
        record_sha256: plan.revision.record_sha256,
        requirement_revision_id: plan.revision.requirement_revision_id,
        requirement_revision_sha256: plan.revision.requirement_revision_sha256,
        goal_id: plan.revision.goal_id,
        contract_id: plan.revision.contract_id,
        authority_root_id: plan.revision.authority_root_id,
      },
      subjects: plan.subjects,
      edges: plan.edges,
      decision_closure: closure,
      decisions: authorityInputs.decisions,
      resolutions: authorityInputs.resolutions,
      created_at_ms: integer(row, "created_at_ms"),
    });
    const memberRows = this.connection.prepare(`SELECT * FROM decision_plan_binding_members_v2
      WHERE decision_plan_binding_id=? ORDER BY ordinal`).all(decisionPlanBindingId) as Record<string, unknown>[];
    const targetRows = this.connection.prepare(`SELECT * FROM decision_plan_binding_targets_v2
      WHERE decision_plan_binding_id=? ORDER BY decision_plan_binding_member_id,ordinal`)
      .all(decisionPlanBindingId) as Record<string, unknown>[];
    const targetsByMember = new Map<string, PlanSubjectRefV2[]>();
    for (const target of targetRows) {
      const memberId = text(target, "decision_plan_binding_member_id");
      const values = targetsByMember.get(memberId) ?? [];
      if (integer(target, "ordinal") !== values.length) {
        throw new AuthorityIntegrityError("Decision Plan binding target ordinal gap");
      }
      values.push({
        kind: text(target, "subject_kind") as "WORK_CELL",
        id: text(target, "subject_id"),
        revision_sha256: text(target, "revision_sha256"),
      });
      targetsByMember.set(memberId, values);
    }
    const storedMembers = memberRows.map((member, ordinal) => {
      if (integer(member, "ordinal") !== ordinal) {
        throw new AuthorityIntegrityError("Decision Plan binding member ordinal gap");
      }
      return {
        schema_version: 2 as const,
        decision_plan_binding_member_id: text(member, "decision_plan_binding_member_id"),
        decision_requirement_revision_id: text(member, "decision_requirement_revision_id"),
        decision_requirement_id: text(member, "decision_requirement_id"),
        decision_requirement_sha256: text(member, "decision_requirement_sha256"),
        decision_state: text(member, "decision_state") as DecisionPlanBindingBundleV2["members"][number]["decision_state"],
        decision_resolution_id: text(member, "decision_resolution_id"),
        decision_resolution_sha256: text(member, "decision_resolution_sha256"),
        target_work_cells: targetsByMember.get(text(member, "decision_plan_binding_member_id")) ?? [],
        target_root_sha256: text(member, "target_root_sha256"),
        target_count: integer(member, "target_count"),
        record_sha256: text(member, "record_sha256"),
      };
    });
    const stored = {
      binding: {
        schema_version: 2 as const,
        decision_plan_binding_id: decisionPlanBindingId,
        plan_revision_id: text(row, "plan_revision_id"),
        plan_revision_sha256: text(row, "plan_revision_sha256"),
        requirement_revision_id: text(row, "requirement_revision_id"),
        requirement_revision_sha256: text(row, "requirement_revision_sha256"),
        goal_id: text(row, "goal_id"),
        contract_id: text(row, "contract_id"),
        authority_root_id: text(row, "authority_root_id"),
        decision_closure_id: text(row, "decision_closure_id"),
        decision_closure_sha256: text(row, "decision_closure_sha256"),
        member_root_sha256: text(row, "member_root_sha256"),
        member_count: integer(row, "member_count"),
        created_at_ms: integer(row, "created_at_ms"),
        record_sha256: text(row, "record_sha256"),
      },
      members: storedMembers,
    };
    assertCanonicalEqual("Stored Decision Plan binding", stored, expected);
    return expected;
  }

  recordChangeAcceptance(input: {
    readonly goal_id: string;
    readonly decision_closure_id: string;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): ChangeAcceptanceClosureBundleV2 {
    assertTransaction(this.connection);
    const eventHeadSha256 = this.assertEventContext(input.goal_id, sequence, input.event_head_sha256);
    return inSavepoint(this.connection, () => {
      const successor = this.readCurrentPlan(input.goal_id);
      if (!successor) throw new AuthorityIntegrityError("Change Acceptance V2 requires a current successor Plan");
      const parentId = successor.revision.parent_plan_revision_id;
      const parentSha256 = successor.revision.parent_plan_revision_sha256;
      if (parentId === null || parentSha256 === null) {
        throw new AuthorityIntegrityError("Change Acceptance V2 requires one direct parent Plan");
      }
      const base = this.readPlanRevision(parentId);
      if (!base || base.revision.record_sha256 !== parentSha256) {
        throw new AuthorityIntegrityError("Change Acceptance V2 lost its direct parent Plan authority");
      }
      const intake = new IntakeAuthorityV2Repository(this.connection);
      const decisionClosure = intake.readDecisionClosure(input.decision_closure_id);
      if (!decisionClosure) throw new AuthorityIntegrityError("Change Acceptance V2 lacks its Decision closure");
      const authorityInputs = decisionPlanAuthorityInputs(intake, decisionClosure);
      const decisionPlanBinding = finalizeDecisionPlanBindingV2({
        plan: {
          plan_revision_id: successor.revision.plan_revision_id,
          record_sha256: successor.revision.record_sha256,
          requirement_revision_id: successor.revision.requirement_revision_id,
          requirement_revision_sha256: successor.revision.requirement_revision_sha256,
          goal_id: successor.revision.goal_id,
          contract_id: successor.revision.contract_id,
          authority_root_id: successor.revision.authority_root_id,
        },
        subjects: successor.subjects,
        edges: successor.edges,
        decision_closure: decisionClosure,
        decisions: authorityInputs.decisions,
        resolutions: authorityInputs.resolutions,
        created_at_ms: input.created_at_ms,
      });
      const materialRequests = this.pendingMaterialRequests(
        input.goal_id, base.revision.plan_revision_id, base.revision.record_sha256,
      );
      const closure = finalizeChangeAcceptanceClosureV2({
        base_plan: {
          plan_revision_id: base.revision.plan_revision_id,
          record_sha256: base.revision.record_sha256,
          subjects: base.subjects,
          edges: base.edges,
        },
        successor_plan: {
          plan_revision_id: successor.revision.plan_revision_id,
          record_sha256: successor.revision.record_sha256,
          parent_plan_revision_id: parentId,
          parent_plan_revision_sha256: parentSha256,
          requirement_revision_id: successor.revision.requirement_revision_id,
          requirement_revision_sha256: successor.revision.requirement_revision_sha256,
          goal_id: successor.revision.goal_id,
          contract_id: successor.revision.contract_id,
          authority_root_id: successor.revision.authority_root_id,
          subjects: successor.subjects,
          edges: successor.edges,
        },
        decision_plan_binding: decisionPlanBinding,
        material_requests: materialRequests,
        base_semantic_records: this.semanticRecords(base),
        successor_semantic_records: this.semanticRecords(successor),
        oracle_bindings: this.oracleBindings(successor),
        event_head_sha256: eventHeadSha256,
        created_at_ms: input.created_at_ms,
      });
      this.insertDecisionPlanBinding(decisionPlanBinding, sequence);
      this.insertChangeAcceptance(closure, materialRequests, sequence);
      const restored = this.readChangeAcceptance(closure.closure.change_acceptance_closure_id);
      if (!restored || restored.closure.record_sha256 !== closure.closure.record_sha256) {
        throw new AuthorityIntegrityError("Change Acceptance V2 did not rebuild after commit");
      }
      return restored;
    });
  }

  readChangeAcceptance(changeAcceptanceClosureId: string): ChangeAcceptanceClosureBundleV2 | null {
    const row = this.connection.prepare("SELECT * FROM change_acceptance_closures_v2 WHERE change_acceptance_closure_id=?")
      .get(changeAcceptanceClosureId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const base = this.readPlanRevision(text(row, "base_plan_revision_id"));
    const successor = this.readPlanRevision(text(row, "successor_plan_revision_id"));
    const decisionPlanBinding = this.readDecisionPlanBinding(text(row, "decision_plan_binding_id"));
    if (!base || !successor || !decisionPlanBinding) {
      throw new AuthorityIntegrityError("Change Acceptance V2 lost its Plan or Decision authority");
    }
    const materialRequests = this.materialRequestsForClosure(changeAcceptanceClosureId);
    const expected = finalizeChangeAcceptanceClosureV2({
      base_plan: {
        plan_revision_id: base.revision.plan_revision_id,
        record_sha256: base.revision.record_sha256,
        subjects: base.subjects,
        edges: base.edges,
      },
      successor_plan: {
        plan_revision_id: successor.revision.plan_revision_id,
        record_sha256: successor.revision.record_sha256,
        parent_plan_revision_id: successor.revision.parent_plan_revision_id ?? "",
        parent_plan_revision_sha256: successor.revision.parent_plan_revision_sha256 ?? "",
        requirement_revision_id: successor.revision.requirement_revision_id,
        requirement_revision_sha256: successor.revision.requirement_revision_sha256,
        goal_id: successor.revision.goal_id,
        contract_id: successor.revision.contract_id,
        authority_root_id: successor.revision.authority_root_id,
        subjects: successor.subjects,
        edges: successor.edges,
      },
      decision_plan_binding: decisionPlanBinding,
      material_requests: materialRequests,
      base_semantic_records: this.semanticRecords(base),
      successor_semantic_records: this.semanticRecords(successor),
      oracle_bindings: this.oracleBindings(successor),
      event_head_sha256: text(row, "event_head_sha256"),
      created_at_ms: integer(row, "created_at_ms"),
    });
    const requestRows = this.connection.prepare(`SELECT * FROM change_acceptance_request_members_v2
      WHERE change_acceptance_closure_id=? ORDER BY ordinal`).all(changeAcceptanceClosureId) as Record<string, unknown>[];
    const semanticRows = this.connection.prepare(`SELECT * FROM change_acceptance_semantic_deltas_v2
      WHERE change_acceptance_closure_id=? ORDER BY ordinal`).all(changeAcceptanceClosureId) as Record<string, unknown>[];
    const invalidationRows = this.connection.prepare(`SELECT * FROM change_invalidation_members_v2
      WHERE invalidation_closure_id=? ORDER BY ordinal`).all(
      text(row, "invalidation_closure_id"),
    ) as Record<string, unknown>[];
    const reuseRows = this.connection.prepare(`SELECT * FROM change_reuse_members_v2
      WHERE invalidation_closure_id=? ORDER BY ordinal`).all(
      text(row, "invalidation_closure_id"),
    ) as Record<string, unknown>[];
    const oracleRows = this.connection.prepare(`SELECT * FROM change_acceptance_oracle_bindings_v2
      WHERE change_acceptance_closure_id=? ORDER BY ordinal`).all(changeAcceptanceClosureId) as Record<string, unknown>[];
    const stored = {
      closure: {
        schema_version: 2 as const,
        change_acceptance_closure_id: changeAcceptanceClosureId,
        base_plan_revision_id: text(row, "base_plan_revision_id"),
        base_plan_revision_sha256: text(row, "base_plan_revision_sha256"),
        successor_plan_revision_id: text(row, "successor_plan_revision_id"),
        successor_plan_revision_sha256: text(row, "successor_plan_revision_sha256"),
        requirement_revision_id: text(row, "requirement_revision_id"),
        requirement_revision_sha256: text(row, "requirement_revision_sha256"),
        goal_id: text(row, "goal_id"), contract_id: text(row, "contract_id"),
        authority_root_id: text(row, "authority_root_id"),
        decision_closure_id: text(row, "decision_closure_id"),
        decision_closure_sha256: text(row, "decision_closure_sha256"),
        decision_plan_binding_id: text(row, "decision_plan_binding_id"),
        decision_plan_binding_root_sha256: text(row, "decision_plan_binding_root_sha256"),
        request_root_sha256: text(row, "request_root_sha256"), request_count: integer(row, "request_count"),
        semantic_delta_root_sha256: text(row, "semantic_delta_root_sha256"),
        semantic_delta_count: integer(row, "semantic_delta_count"),
        invalidation_closure_id: text(row, "invalidation_closure_id"),
        invalidation_closure_sha256: text(row, "invalidation_closure_sha256"),
        invalidation_root_sha256: text(row, "invalidation_root_sha256"),
        invalidation_count: integer(row, "invalidation_count"), reuse_root_sha256: text(row, "reuse_root_sha256"),
        reuse_count: integer(row, "reuse_count"), oracle_evidence_root_sha256: text(row, "oracle_evidence_root_sha256"),
        oracle_count: integer(row, "oracle_count"), event_head_sha256: text(row, "event_head_sha256"),
        created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
      },
      request_members: requestRows.map((member, ordinal) => {
        if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change request member ordinal gap");
        return {
          schema_version: 2 as const, request_member_id: text(member, "request_member_id"),
          binding_id: text(member, "binding_id"), binding_sha256: text(member, "binding_sha256"),
          change_request_id: text(member, "change_request_id"),
          change_request_sha256: text(member, "change_request_sha256"),
          impact_sha256: text(member, "impact_sha256"), record_sha256: text(member, "record_sha256"),
        };
      }),
      semantic_deltas: semanticRows.map((delta, ordinal) => {
        if (integer(delta, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change semantic delta ordinal gap");
        return {
          schema_version: 2 as const, semantic_delta_id: text(delta, "semantic_delta_id"),
          entity_kind: text(delta, "entity_kind") as ChangeAcceptanceClosureBundleV2["semantic_deltas"][number]["entity_kind"],
          semantic_key: text(delta, "semantic_key"),
          change_kind: text(delta, "change_kind") as ChangeAcceptanceClosureBundleV2["semantic_deltas"][number]["change_kind"],
          previous_entity_id: nullableText(delta, "previous_entity_id"),
          previous_entity_sha256: nullableText(delta, "previous_entity_sha256"),
          successor_entity_id: nullableText(delta, "successor_entity_id"),
          successor_entity_sha256: nullableText(delta, "successor_entity_sha256"),
          record_sha256: text(delta, "record_sha256"),
        };
      }),
      invalidation: {
        ...expected.invalidation,
        members: invalidationRows.map((member, ordinal) => {
          if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change invalidation ordinal gap");
          return {
            schema_version: 2 as const, invalidation_member_id: text(member, "invalidation_member_id"),
            subject: { kind: text(member, "subject_kind") as PlanSubjectRefV2["kind"], id: text(member, "subject_id"), revision_sha256: text(member, "revision_sha256") },
            local: integer(member, "local") === 1, upstream: integer(member, "upstream") === 1,
            structural: integer(member, "structural") === 1, record_sha256: text(member, "record_sha256"),
          };
        }),
        reusable_subjects: reuseRows.map((member, ordinal) => {
          if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change reuse ordinal gap");
          return { kind: text(member, "subject_kind") as PlanSubjectRefV2["kind"], id: text(member, "subject_id"), revision_sha256: text(member, "revision_sha256") };
        }),
      },
      oracle_bindings: oracleRows.map((oracle, ordinal) => {
        if (integer(oracle, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change oracle binding ordinal gap");
        return {
          schema_version: 2 as const, oracle_binding_id: text(oracle, "oracle_binding_id"),
          work_cell: { kind: text(oracle, "subject_kind") as "WORK_CELL", id: text(oracle, "subject_id"), revision_sha256: text(oracle, "revision_sha256") },
          oracle_sha256: text(oracle, "oracle_sha256"), record_sha256: text(oracle, "record_sha256"),
        };
      }),
    };
    assertCanonicalEqual("Stored Change Acceptance", stored, expected);
    return expected;
  }

  readPendingActiveGoalUserTurns(goalId: string): readonly ActiveGoalUserTurnV2[] {
    const rows = this.connection.prepare(`SELECT t.user_turn_id FROM active_goal_user_turns_v2 t
      LEFT JOIN active_goal_user_turn_classifications_v2 c ON c.user_turn_id=t.user_turn_id
      WHERE t.goal_id=? AND c.classification_id IS NULL ORDER BY t.created_event_sequence`).all(goalId) as Record<string, unknown>[];
    return rows.map((row) => {
      const bundle = this.readActiveGoalUserTurn(text(row, "user_turn_id"));
      if (!bundle) throw new AuthorityIntegrityError("Pending Active Goal user turn V2 disappeared");
      return bundle.turn;
    });
  }

  private pendingMaterialRequests(
    goalId: string,
    basePlanRevisionId: string,
    basePlanRevisionSha256: string,
  ): readonly ChangeAcceptanceMaterialRequestV2[] {
    const unclassified = this.connection.prepare(`SELECT 1 FROM active_goal_user_turns_v2 t
      LEFT JOIN active_goal_user_turn_classifications_v2 c ON c.user_turn_id=t.user_turn_id
      WHERE t.goal_id=? AND t.plan_revision_id=? AND c.classification_id IS NULL LIMIT 1`)
      .get(goalId, basePlanRevisionId);
    if (unclassified) throw new AuthorityIntegrityError("Change Acceptance V2 has an unclassified captured turn");
    const missingMaterialBinding = this.connection.prepare(`SELECT 1
      FROM active_goal_user_turn_classifications_v2 c
      LEFT JOIN active_goal_change_request_bindings_v2 b ON b.classification_id=c.classification_id
      WHERE c.goal_id=? AND c.base_plan_revision_id=?
        AND c.classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
        AND b.binding_id IS NULL LIMIT 1`).get(goalId, basePlanRevisionId);
    if (missingMaterialBinding) {
      throw new AuthorityIntegrityError("Change Acceptance V2 has a material turn without its exact binding");
    }
    const rows = this.connection.prepare(`SELECT b.user_turn_id,b.binding_id,b.record_sha256 binding_sha256,
        b.change_request_id,b.change_request_sha256,b.plan_change_impact_id,b.plan_change_impact_sha256
      FROM active_goal_change_request_bindings_v2 b
      LEFT JOIN active_goal_change_transitions_v2 t ON t.binding_id=b.binding_id
      WHERE b.goal_id=? AND b.base_plan_revision_id=? AND t.transition_id IS NULL
      ORDER BY b.created_event_sequence,b.binding_id`).all(goalId, basePlanRevisionId) as Record<string, unknown>[];
    return rows.map((row) => {
      const projection = this.readActiveGoalChangeRequestByTurn(text(row, "user_turn_id"));
      if (!projection || projection.binding.base_plan_revision_sha256 !== basePlanRevisionSha256
        || projection.change.request.record_sha256 !== text(row, "change_request_sha256")
        || projection.change.impact.record_sha256 !== text(row, "plan_change_impact_sha256")) {
        throw new AuthorityIntegrityError("Change Acceptance V2 material binding is outside its exact base Plan");
      }
      return {
        binding_id: projection.binding.binding_id,
        binding_sha256: projection.binding.record_sha256,
        change_request_id: projection.change.request.change_request_id,
        change_request_sha256: projection.change.request.record_sha256,
        impact: { ...projection.change.impact, record_sha256: projection.change.impact.impact_closure_sha256 },
        impact_authority_id: planChangeImpactIdV2(projection.change.impact),
        impact_authority_sha256: projection.change.impact.record_sha256,
      };
    });
  }

  private materialRequestsForClosure(changeAcceptanceClosureId: string): readonly ChangeAcceptanceMaterialRequestV2[] {
    const rows = this.connection.prepare(`SELECT b.user_turn_id,m.binding_id,m.binding_sha256,
        m.change_request_id,m.change_request_sha256,m.impact_sha256
      FROM change_acceptance_request_members_v2 m
      JOIN active_goal_change_request_bindings_v2 b ON b.binding_id=m.binding_id
      WHERE m.change_acceptance_closure_id=? ORDER BY m.ordinal`).all(
      changeAcceptanceClosureId,
    ) as Record<string, unknown>[];
    return rows.map((row) => {
      const projection = this.readActiveGoalChangeRequestByTurn(text(row, "user_turn_id"));
      if (!projection || projection.binding.record_sha256 !== text(row, "binding_sha256")
        || projection.change.request.record_sha256 !== text(row, "change_request_sha256")
        || projection.change.impact.record_sha256 !== text(row, "impact_sha256")) {
        throw new AuthorityIntegrityError("Stored Change Acceptance request member lost its exact authority");
      }
      return {
        binding_id: projection.binding.binding_id,
        binding_sha256: projection.binding.record_sha256,
        change_request_id: projection.change.request.change_request_id,
        change_request_sha256: projection.change.request.record_sha256,
        impact: { ...projection.change.impact, record_sha256: projection.change.impact.impact_closure_sha256 },
        impact_authority_id: planChangeImpactIdV2(projection.change.impact),
        impact_authority_sha256: projection.change.impact.record_sha256,
      };
    });
  }

  private semanticRecords(projection: PlanAuthorityProjectionV2): readonly ChangeAcceptanceSemanticRecordV2[] {
    const requirementRows = this.connection.prepare(`SELECT semantic_key,requirement_id,record_sha256
      FROM requirement_items_v2 WHERE requirement_revision_id=? ORDER BY semantic_key`).all(
      projection.revision.requirement_revision_id,
    ) as Record<string, unknown>[];
    const facetRows = this.connection.prepare(`SELECT semantic_key,facet_id,record_sha256
      FROM acceptance_facets_v2 WHERE contract_id=? ORDER BY semantic_key`).all(
      projection.revision.contract_id,
    ) as Record<string, unknown>[];
    return [
      ...facetRows.map((row): ChangeAcceptanceSemanticRecordV2 => ({
        entity_kind: "ACCEPTANCE_FACET", semantic_key: text(row, "semantic_key"),
        entity_id: text(row, "facet_id"), record_sha256: text(row, "record_sha256"),
      })),
      ...requirementRows.map((row): ChangeAcceptanceSemanticRecordV2 => ({
        entity_kind: "REQUIREMENT", semantic_key: text(row, "semantic_key"),
        entity_id: text(row, "requirement_id"), record_sha256: text(row, "record_sha256"),
      })),
    ];
  }

  private oracleBindings(projection: PlanAuthorityProjectionV2): readonly {
    readonly work_cell: PlanSubjectRefV2;
    readonly oracle_sha256: string;
  }[] {
    const routeId = projection.revision.route_id;
    const rows = this.connection.prepare(`SELECT logical_key,spec_sha256,oracle_json FROM work_cells_v1
      WHERE route_id=? ORDER BY logical_key`).all(routeId) as Record<string, unknown>[];
    const workCells = new Map(projection.subjects.filter((subject) => subject.kind === "WORK_CELL")
      .map((subject) => [subject.id, subject]));
    return rows.map((row) => {
      const workCell = workCells.get(text(row, "logical_key"));
      if (!workCell || workCell.revision_sha256 !== text(row, "spec_sha256")) {
        throw new AuthorityIntegrityError("Change Acceptance V2 WorkCell oracle lost its Plan subject");
      }
      return { work_cell: workCell, oracle_sha256: canonicalJsonSha256(canonicalValue(row, "oracle_json")) };
    });
  }

  private insertDecisionPlanBinding(bundle: DecisionPlanBindingBundleV2, sequence: number): void {
    const binding = bundle.binding;
    const insertMember = this.connection.prepare(`INSERT INTO decision_plan_binding_members_v2(
      decision_plan_binding_id,decision_plan_binding_member_id,plan_revision_id,requirement_revision_id,
      goal_id,contract_id,authority_root_id,decision_closure_id,decision_requirement_revision_id,
      decision_requirement_id,decision_requirement_sha256,decision_state,decision_resolution_id,
      decision_resolution_sha256,target_root_sha256,target_count,ordinal,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertTarget = this.connection.prepare(`INSERT INTO decision_plan_binding_targets_v2(
      decision_plan_binding_member_id,decision_plan_binding_id,plan_revision_id,goal_id,
      subject_kind,subject_id,revision_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    bundle.members.forEach((member, ordinal) => {
      insertMember.run(
        binding.decision_plan_binding_id, member.decision_plan_binding_member_id,
        binding.plan_revision_id, binding.requirement_revision_id, binding.goal_id, binding.contract_id,
        binding.authority_root_id, binding.decision_closure_id, member.decision_requirement_revision_id,
        member.decision_requirement_id, member.decision_requirement_sha256, member.decision_state,
        member.decision_resolution_id, member.decision_resolution_sha256, member.target_root_sha256,
        member.target_count, ordinal, member.record_sha256, sequence,
      );
      member.target_work_cells.forEach((target, targetOrdinal) => insertTarget.run(
        member.decision_plan_binding_member_id, binding.decision_plan_binding_id,
        binding.plan_revision_id, binding.goal_id, target.kind, target.id, target.revision_sha256,
        targetOrdinal, sequence,
      ));
    });
    this.connection.prepare(`INSERT INTO decision_plan_bindings_v2(
      decision_plan_binding_id,plan_revision_id,plan_revision_sha256,requirement_revision_id,
      requirement_revision_sha256,goal_id,contract_id,authority_root_id,decision_closure_id,
      decision_closure_sha256,member_root_sha256,member_count,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      binding.decision_plan_binding_id, binding.plan_revision_id, binding.plan_revision_sha256,
      binding.requirement_revision_id, binding.requirement_revision_sha256, binding.goal_id,
      binding.contract_id, binding.authority_root_id, binding.decision_closure_id,
      binding.decision_closure_sha256, binding.member_root_sha256, binding.member_count,
      binding.record_sha256, binding.created_at_ms, sequence,
    );
  }

  private insertChangeAcceptance(
    bundle: ChangeAcceptanceClosureBundleV2,
    materialRequests: readonly ChangeAcceptanceMaterialRequestV2[],
    sequence: number,
  ): void {
    const closure = bundle.closure;
    const invalidation = bundle.invalidation;
    const insertInvalidationMember = this.connection.prepare(`INSERT INTO change_invalidation_members_v2(
      invalidation_closure_id,invalidation_member_id,goal_id,base_plan_revision_id,
      successor_plan_revision_id,subject_kind,subject_id,revision_sha256,local,upstream,structural,
      ordinal,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    invalidation.members.forEach((member, ordinal) => insertInvalidationMember.run(
      invalidation.invalidation_closure_id, member.invalidation_member_id, closure.goal_id,
      closure.base_plan_revision_id, closure.successor_plan_revision_id, member.subject.kind,
      member.subject.id, member.subject.revision_sha256, member.local ? 1 : 0,
      member.upstream ? 1 : 0, member.structural ? 1 : 0, ordinal, member.record_sha256, sequence,
    ));
    const insertReuse = this.connection.prepare(`INSERT INTO change_reuse_members_v2(
      invalidation_closure_id,goal_id,base_plan_revision_id,successor_plan_revision_id,
      subject_kind,subject_id,revision_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    invalidation.reusable_subjects.forEach((subject, ordinal) => insertReuse.run(
      invalidation.invalidation_closure_id, closure.goal_id, closure.base_plan_revision_id,
      closure.successor_plan_revision_id, subject.kind, subject.id, subject.revision_sha256, ordinal, sequence,
    ));
    this.connection.prepare(`INSERT INTO change_invalidation_closures_v2(
      invalidation_closure_id,goal_id,base_plan_revision_id,base_plan_revision_sha256,
      successor_plan_revision_id,successor_plan_revision_sha256,revision_delta_sha256,
      request_impact_root_sha256,local_root_sha256,upstream_root_sha256,structural_root_sha256,
      invalidation_root_sha256,reuse_root_sha256,invalidation_count,reuse_count,record_sha256,
      created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      invalidation.invalidation_closure_id, closure.goal_id, invalidation.base_plan_revision_id,
      invalidation.base_plan_revision_sha256, invalidation.successor_plan_revision_id,
      invalidation.successor_plan_revision_sha256, invalidation.revision_delta.record_sha256,
      invalidation.request_impact_root_sha256, invalidation.local_root_sha256,
      invalidation.upstream_root_sha256, invalidation.structural_root_sha256,
      invalidation.invalidation_root_sha256, invalidation.reuse_root_sha256,
      invalidation.members.length, invalidation.reusable_subjects.length, invalidation.record_sha256, sequence,
    );

    const materialByBinding = new Map(materialRequests.map((request) => [request.binding_id, request]));
    const insertRequest = this.connection.prepare(`INSERT INTO change_acceptance_request_members_v2(
      change_acceptance_closure_id,request_member_id,goal_id,base_plan_revision_id,
      successor_plan_revision_id,binding_id,binding_sha256,change_request_id,change_request_sha256,
      plan_change_impact_id,impact_sha256,ordinal,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    bundle.request_members.forEach((member, ordinal) => {
      const material = materialByBinding.get(member.binding_id);
      if (!material || (material.impact_authority_sha256 ?? material.impact.record_sha256) !== member.impact_sha256) {
        throw new AuthorityIntegrityError("Change Acceptance request member lost its material impact");
      }
      insertRequest.run(
        closure.change_acceptance_closure_id, member.request_member_id, closure.goal_id,
        closure.base_plan_revision_id, closure.successor_plan_revision_id, member.binding_id,
        member.binding_sha256, member.change_request_id, member.change_request_sha256,
        material.impact_authority_id ?? idFromSha256("PLAN_CHANGE_IMPACT", material.impact.record_sha256),
        member.impact_sha256, ordinal, member.record_sha256, sequence,
      );
    });
    const insertSemantic = this.connection.prepare(`INSERT INTO change_acceptance_semantic_deltas_v2(
      change_acceptance_closure_id,semantic_delta_id,goal_id,base_plan_revision_id,
      successor_plan_revision_id,entity_kind,semantic_key,change_kind,previous_entity_id,
      previous_entity_sha256,successor_entity_id,successor_entity_sha256,ordinal,record_sha256,
      created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    bundle.semantic_deltas.forEach((delta, ordinal) => insertSemantic.run(
      closure.change_acceptance_closure_id, delta.semantic_delta_id, closure.goal_id,
      closure.base_plan_revision_id, closure.successor_plan_revision_id, delta.entity_kind,
      delta.semantic_key, delta.change_kind, delta.previous_entity_id, delta.previous_entity_sha256,
      delta.successor_entity_id, delta.successor_entity_sha256, ordinal, delta.record_sha256, sequence,
    ));
    const insertOracle = this.connection.prepare(`INSERT INTO change_acceptance_oracle_bindings_v2(
      change_acceptance_closure_id,oracle_binding_id,goal_id,base_plan_revision_id,
      successor_plan_revision_id,subject_kind,subject_id,revision_sha256,oracle_sha256,ordinal,
      record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    bundle.oracle_bindings.forEach((oracle, ordinal) => insertOracle.run(
      closure.change_acceptance_closure_id, oracle.oracle_binding_id, closure.goal_id,
      closure.base_plan_revision_id, closure.successor_plan_revision_id, oracle.work_cell.kind,
      oracle.work_cell.id, oracle.work_cell.revision_sha256, oracle.oracle_sha256, ordinal,
      oracle.record_sha256, sequence,
    ));
    this.connection.prepare(`INSERT INTO change_acceptance_closures_v2(
      change_acceptance_closure_id,base_plan_revision_id,base_plan_revision_sha256,
      successor_plan_revision_id,successor_plan_revision_sha256,requirement_revision_id,
      requirement_revision_sha256,goal_id,contract_id,authority_root_id,decision_closure_id,
      decision_closure_sha256,decision_plan_binding_id,decision_plan_binding_root_sha256,
      request_root_sha256,request_count,semantic_delta_root_sha256,semantic_delta_count,
      invalidation_closure_id,invalidation_closure_sha256,invalidation_root_sha256,invalidation_count,
      reuse_root_sha256,reuse_count,oracle_evidence_root_sha256,oracle_count,event_head_sha256,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      closure.change_acceptance_closure_id, closure.base_plan_revision_id,
      closure.base_plan_revision_sha256, closure.successor_plan_revision_id,
      closure.successor_plan_revision_sha256, closure.requirement_revision_id,
      closure.requirement_revision_sha256, closure.goal_id, closure.contract_id,
      closure.authority_root_id, closure.decision_closure_id, closure.decision_closure_sha256,
      closure.decision_plan_binding_id, closure.decision_plan_binding_root_sha256,
      closure.request_root_sha256, closure.request_count, closure.semantic_delta_root_sha256,
      closure.semantic_delta_count, closure.invalidation_closure_id, closure.invalidation_closure_sha256,
      closure.invalidation_root_sha256, closure.invalidation_count, closure.reuse_root_sha256,
      closure.reuse_count, closure.oracle_evidence_root_sha256, closure.oracle_count,
      closure.event_head_sha256, closure.record_sha256, closure.created_at_ms, sequence,
    );
  }

  hasPendingActiveGoalUserTurn(goalId: string): boolean {
    return this.connection.prepare(`SELECT 1 FROM active_goal_user_turns_v2 t
      LEFT JOIN active_goal_user_turn_classifications_v2 c ON c.user_turn_id=t.user_turn_id
      WHERE t.goal_id=? AND c.classification_id IS NULL LIMIT 1`)
      .get(goalId) !== undefined;
  }

  captureUserChangeRequest(input: {
    readonly goal_id: string;
    readonly classification: ChangeRequestClassificationV2;
    readonly materiality: ChangeRequestMaterialityV2;
    readonly request_payload: CanonicalJson;
    readonly changed_subjects: readonly PlanSubjectRefV2[];
    readonly source: string | Uint8Array;
    readonly session_id: string;
    readonly turn_id: string;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): ChangeRequestProjectionV2 {
    assertTransaction(this.connection);
    const eventHeadSha256 = this.assertEventContext(input.goal_id, sequence, input.event_head_sha256);
    return inSavepoint(this.connection, () => {
      const plan = this.readCurrentPlan(input.goal_id);
      if (!plan) throw new AuthorityIntegrityError("Change Request V2 requires a current Plan revision");
      const bundle = finalizeUserChangeRequestV2({
        plan: plan.revision,
        subjects: plan.subjects,
        edges: plan.edges,
        classification: input.classification,
        materiality: input.materiality,
        request_payload: input.request_payload,
        changed_subjects: input.changed_subjects,
        source: input.source,
        session_id: input.session_id,
        turn_id: input.turn_id,
        event_head_sha256: eventHeadSha256,
        created_at_ms: input.created_at_ms,
      });
      const impact = bindPlanChangeImpactV2(bundle.request, derivePlanChangeImpactV2({
        plan_revision_id: plan.revision.plan_revision_id,
        plan_revision_sha256: plan.revision.record_sha256,
        changed_subjects: bundle.request.changed_subjects,
        subjects: plan.subjects,
        edges: plan.edges,
      }));
      const reuseReceipts = impact.reusable_subjects.map((subject) => finalizePlanReuseReceiptV2({
        request: bundle.request,
        impact,
        subject,
      }));
      this.insertChangeRequest(bundle.request, bundle.source_bytes, impact, reuseReceipts, sequence);
      const restored = this.readChangeRequest(bundle.request.change_request_id);
      if (!restored || restored.request.record_sha256 !== bundle.request.record_sha256
        || restored.impact.record_sha256 !== impact.record_sha256) {
        throw new AuthorityIntegrityError("Change Request V2 write did not rebuild its exact impact closure");
      }
      return restored;
    });
  }

  readChangeRequest(changeRequestId: string): ChangeRequestProjectionV2 | null {
    const row = this.connection.prepare("SELECT * FROM change_requests_v2 WHERE change_request_id=?")
      .get(changeRequestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plan = this.readPlanRevision(text(row, "base_plan_revision_id"));
    if (!plan) throw new AuthorityIntegrityError("Change Request V2 lost its base Plan revision");
    const subjectRows = this.connection.prepare(`SELECT * FROM change_request_subjects_v2
      WHERE change_request_id=? ORDER BY ordinal`).all(changeRequestId) as Record<string, unknown>[];
    const subjectsByKey = new Map(plan.subjects.map((subject) => [planSubjectKeyV2(subject), subject]));
    const changedSubjects = subjectRows.map((subjectRow, ordinal) => {
      if (integer(subjectRow, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Change Request V2 subject ordinal gap");
      const subject = subjectsByKey.get(`${text(subjectRow, "subject_kind")}\u0000${text(subjectRow, "subject_id")}`);
      if (!subject || subject.revision_sha256 !== text(subjectRow, "revision_sha256")) {
        throw new AuthorityIntegrityError("Change Request V2 subject is outside its base Plan");
      }
      return subject;
    });
    const rawBytes = row.source_bytes;
    if (!(rawBytes instanceof Uint8Array)) throw new AuthorityIntegrityError("Change Request V2 source bytes are invalid");
    const activeBinding = this.connection.prepare(`SELECT user_turn_id,user_turn_sha256,raw_content_sha256
      FROM active_goal_change_request_bindings_v2 WHERE change_request_id=?`).get(changeRequestId) as
      Record<string, unknown> | undefined;
    const sourceAuthority = activeBinding === undefined ? undefined : {
      user_turn_id: text(activeBinding, "user_turn_id"),
      user_turn_sha256: text(activeBinding, "user_turn_sha256"),
      content_sha256: text(activeBinding, "raw_content_sha256"),
    };
    const bundle = finalizeUserChangeRequestV2({
      plan: plan.revision,
      subjects: plan.subjects,
      edges: plan.edges,
      classification: text(row, "classification") as ChangeRequestClassificationV2,
      materiality: text(row, "materiality") as ChangeRequestMaterialityV2,
      request_payload: canonicalValue(row, "request_payload_json"),
      changed_subjects: changedSubjects,
      source: rawBytes,
      session_id: text(row, "session_id"),
      turn_id: text(row, "turn_id"),
      event_head_sha256: text(row, "event_head_sha256"),
      created_at_ms: integer(row, "created_at_ms"),
      ...(sourceAuthority === undefined ? {} : { source_authority: sourceAuthority }),
    });
    if (bundle.request.change_request_id !== changeRequestId
      || bundle.request.record_sha256 !== text(row, "record_sha256")
      || bundle.request.content_sha256 !== text(row, "content_sha256")
      || bundle.request.request_payload_sha256 !== text(row, "request_payload_sha256")
      || bundle.request.changed_subject_root_sha256 !== text(row, "changed_subject_root_sha256")
      || bundle.request.changed_subject_count !== integer(row, "changed_subject_count")
      || bundle.request.byte_length !== integer(row, "byte_length")
      || bundle.request.base_plan_revision_sha256 !== text(row, "base_plan_revision_sha256")) {
      throw new AuthorityIntegrityError("Stored Change Request V2 is not exact user authority");
    }
    const semanticImpact = derivePlanChangeImpactV2({
      plan_revision_id: plan.revision.plan_revision_id,
      plan_revision_sha256: plan.revision.record_sha256,
      changed_subjects: bundle.request.changed_subjects,
      subjects: plan.subjects,
      edges: plan.edges,
    });
    const impact = this.readAndAssertStoredImpact(bundle.request, semanticImpact);
    const reuseReceipts = impact.reusable_subjects.map((subject) => finalizePlanReuseReceiptV2({
      request: bundle.request,
      impact,
      subject,
    }));
    const reuseRows = this.connection.prepare(`SELECT * FROM plan_reuse_receipts_v2
      WHERE change_request_id=? ORDER BY subject_id,subject_kind`).all(changeRequestId) as Record<string, unknown>[];
    if (reuseRows.length !== reuseReceipts.length) throw new AuthorityIntegrityError("Plan reuse receipt V2 count mismatch");
    const expectedReuse = new Map(reuseReceipts.map((receipt) => [receipt.reuse_receipt_id, receipt]));
    for (const reuseRow of reuseRows) {
      const expected = expectedReuse.get(text(reuseRow, "reuse_receipt_id"));
      if (!expected || expected.record_sha256 !== text(reuseRow, "record_sha256")
        || expected.plan_change_impact_sha256 !== text(reuseRow, "plan_change_impact_sha256")
        || expected.subject.revision_sha256 !== text(reuseRow, "revision_sha256")
        || integer(reuseRow, "requires_fresh_effect_oracle") !== 1) {
        throw new AuthorityIntegrityError("Stored Plan reuse receipt V2 is invalid");
      }
    }
    return { request: bundle.request, impact, reuse_receipts: reuseReceipts };
  }

  readRecentChangeRequests(goalId: string, limit = 16): readonly ChangeRequestProjectionV2[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new RangeError("Recent Change Request limit must be between 1 and 64");
    }
    const rows = this.connection.prepare(`SELECT change_request_id FROM change_requests_v2
      WHERE goal_id=? ORDER BY created_event_sequence DESC,change_request_id DESC LIMIT ?`).all(
      goalId, limit,
    ) as Record<string, unknown>[];
    return rows.map((row) => {
      const change = this.readChangeRequest(text(row, "change_request_id"));
      if (!change) throw new AuthorityIntegrityError("Recent Change Request disappeared during projection");
      return change;
    });
  }

  private insertChangeRequest(
    request: UserChangeRequestV2,
    sourceBytes: Uint8Array,
    impact: ChangeRequestPlanImpactV2,
    reuseReceipts: readonly PlanReuseReceiptV2[],
    sequence: number,
  ): void {
    this.connection.prepare(`INSERT INTO change_requests_v2(
      change_request_id,goal_id,base_plan_revision_id,base_plan_revision_sha256,classification,materiality,
      request_payload_json,request_payload_sha256,changed_subject_root_sha256,changed_subject_count,source_kind,
      session_id,turn_id,event_head_sha256,source_bytes,content_sha256,byte_length,encoding,fidelity,captured_by,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      request.change_request_id, request.goal_id, request.base_plan_revision_id, request.base_plan_revision_sha256,
      request.classification, request.materiality, canonicalJson(request.request_payload), request.request_payload_sha256,
      request.changed_subject_root_sha256, request.changed_subject_count, request.source_kind, request.session_id,
      request.turn_id, request.event_head_sha256, Buffer.from(sourceBytes), request.content_sha256, request.byte_length,
      request.encoding, request.fidelity, request.captured_by, request.record_sha256, request.created_at_ms, sequence,
    );
    const insertChanged = this.connection.prepare(`INSERT INTO change_request_subjects_v2(
      change_request_id,goal_id,base_plan_revision_id,subject_kind,subject_id,revision_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    request.changed_subjects.forEach((subject, ordinal) => insertChanged.run(
      request.change_request_id, request.goal_id, request.base_plan_revision_id,
      subject.kind, subject.id, subject.revision_sha256, ordinal, sequence,
    ));
    const impactId = planChangeImpactIdV2(impact);
    this.connection.prepare(`INSERT INTO plan_change_impacts_v2(
      plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id,base_plan_revision_sha256,
      changed_root_sha256,invalidation_root_sha256,reuse_root_sha256,propagation_root_sha256,
      changed_count,invalidated_count,reusable_count,propagation_count,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      impactId, request.change_request_id, request.goal_id, request.base_plan_revision_id,
      request.base_plan_revision_sha256, impact.changed_root_sha256, impact.invalidation_root_sha256,
      impact.reuse_root_sha256, impact.propagation_root_sha256, impact.changed_subjects.length,
      impact.invalidated_subjects.length, impact.reusable_subjects.length, impact.propagation_edges.length,
      impact.record_sha256, request.created_at_ms, sequence,
    );
    const insertMember = this.connection.prepare(`INSERT INTO plan_change_impact_members_v2(
      plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id,disposition,subject_kind,subject_id,
      revision_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const sets = [
      ["CHANGED", impact.changed_subjects],
      ["INVALIDATED", impact.invalidated_subjects],
      ["REUSABLE", impact.reusable_subjects],
    ] as const;
    for (const [disposition, members] of sets) members.forEach((subject, ordinal) => insertMember.run(
      impactId, request.change_request_id, request.goal_id, request.base_plan_revision_id, disposition,
      subject.kind, subject.id, subject.revision_sha256, ordinal, sequence,
    ));
    const insertInvalidation = this.connection.prepare(`INSERT INTO plan_invalidation_edges_v2(
      invalidation_edge_id,plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id,
      source_kind,source_id,target_kind,target_id,dependency_kind,invalidation_kind,ordinal,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    impact.propagation_edges.forEach((edge, ordinal) => {
      const identity = invalidationEdgeIdentity(impactId, edge);
      insertInvalidation.run(identity.invalidation_edge_id, impactId, request.change_request_id, request.goal_id,
        request.base_plan_revision_id, edge.source.kind, edge.source.id, edge.target.kind, edge.target.id,
        edge.dependency_kind, "TRANSITIVE_DEPENDENT", ordinal, identity.record_sha256, sequence);
    });
    const insertReuse = this.connection.prepare(`INSERT INTO plan_reuse_receipts_v2(
      reuse_receipt_id,change_request_id,plan_change_impact_id,plan_change_impact_sha256,goal_id,
      base_plan_revision_id,base_plan_revision_sha256,subject_kind,subject_id,revision_sha256,
      reuse_scope,requires_fresh_effect_oracle,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const receipt of reuseReceipts) insertReuse.run(
      receipt.reuse_receipt_id, receipt.change_request_id, receipt.plan_change_impact_id,
      receipt.plan_change_impact_sha256, receipt.goal_id, receipt.base_plan_revision_id,
      receipt.base_plan_revision_sha256, receipt.subject.kind, receipt.subject.id, receipt.subject.revision_sha256,
      receipt.reuse_scope, 1, receipt.record_sha256, sequence,
    );
  }

  private readAndAssertStoredImpact(
    request: UserChangeRequestV2,
    semanticImpact: PlanChangeImpactV2,
  ): ChangeRequestPlanImpactV2 {
    const row = this.connection.prepare("SELECT * FROM plan_change_impacts_v2 WHERE change_request_id=?")
      .get(request.change_request_id) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Stored Plan change impact V2 is missing");
    const boundImpact = bindPlanChangeImpactV2(request, semanticImpact);
    const storedRecordSha256 = text(row, "record_sha256");
    if (storedRecordSha256 !== boundImpact.record_sha256) {
      throw new AuthorityIntegrityError("Stored Plan change impact V2 is not bound to its Change Request");
    }
    const impact: ChangeRequestPlanImpactV2 = boundImpact;
    const impactId = planChangeImpactIdV2(impact);
    if (text(row, "plan_change_impact_id") !== impactId
      || text(row, "base_plan_revision_sha256") !== impact.plan_revision_sha256
      || text(row, "changed_root_sha256") !== impact.changed_root_sha256
      || text(row, "invalidation_root_sha256") !== impact.invalidation_root_sha256
      || text(row, "reuse_root_sha256") !== impact.reuse_root_sha256
      || text(row, "propagation_root_sha256") !== impact.propagation_root_sha256
      || integer(row, "changed_count") !== impact.changed_subjects.length
      || integer(row, "invalidated_count") !== impact.invalidated_subjects.length
      || integer(row, "reusable_count") !== impact.reusable_subjects.length
      || integer(row, "propagation_count") !== impact.propagation_edges.length) {
      throw new AuthorityIntegrityError("Stored Plan change impact V2 is not Host-derived");
    }
    const memberRows = this.connection.prepare(`SELECT * FROM plan_change_impact_members_v2
      WHERE plan_change_impact_id=? ORDER BY disposition,ordinal`).all(impactId) as Record<string, unknown>[];
    const expectedMembers = [
      ...impact.changed_subjects.map((subject, ordinal) => ({ disposition: "CHANGED", subject, ordinal })),
      ...impact.invalidated_subjects.map((subject, ordinal) => ({ disposition: "INVALIDATED", subject, ordinal })),
      ...impact.reusable_subjects.map((subject, ordinal) => ({ disposition: "REUSABLE", subject, ordinal })),
    ].sort((left, right) => left.disposition.localeCompare(right.disposition) || left.ordinal - right.ordinal);
    if (memberRows.length !== expectedMembers.length || memberRows.some((member, index) => {
      const expected = expectedMembers[index]!;
      return text(member, "disposition") !== expected.disposition
        || integer(member, "ordinal") !== expected.ordinal
        || text(member, "subject_kind") !== expected.subject.kind
        || text(member, "subject_id") !== expected.subject.id
        || text(member, "revision_sha256") !== expected.subject.revision_sha256
        || text(member, "change_request_id") !== request.change_request_id
        || text(member, "goal_id") !== request.goal_id
        || text(member, "base_plan_revision_id") !== request.base_plan_revision_id;
    })) {
      throw new AuthorityIntegrityError("Stored Plan change impact V2 member closure is invalid");
    }
    const edgeRows = this.connection.prepare(`SELECT * FROM plan_invalidation_edges_v2
      WHERE plan_change_impact_id=? ORDER BY ordinal`).all(impactId) as Record<string, unknown>[];
    if (edgeRows.length !== impact.propagation_edges.length) throw new AuthorityIntegrityError("Plan invalidation edge V2 count mismatch");
    edgeRows.forEach((edgeRow, ordinal) => {
      const edge = impact.propagation_edges[ordinal]!;
      const identity = invalidationEdgeIdentity(impactId, edge);
      if (integer(edgeRow, "ordinal") !== ordinal
        || text(edgeRow, "invalidation_edge_id") !== identity.invalidation_edge_id
        || text(edgeRow, "record_sha256") !== identity.record_sha256
        || text(edgeRow, "change_request_id") !== request.change_request_id
        || text(edgeRow, "goal_id") !== request.goal_id
        || text(edgeRow, "base_plan_revision_id") !== request.base_plan_revision_id
        || text(edgeRow, "source_kind") !== edge.source.kind
        || text(edgeRow, "source_id") !== edge.source.id
        || text(edgeRow, "target_kind") !== edge.target.kind
        || text(edgeRow, "target_id") !== edge.target.id
        || text(edgeRow, "dependency_kind") !== edge.dependency_kind
        || text(edgeRow, "invalidation_kind") !== "TRANSITIVE_DEPENDENT") {
        throw new AuthorityIntegrityError("Stored Plan invalidation edge V2 is invalid");
      }
    });
    return impact;
  }

  readCorrectionBudgets(goalId: string): readonly CorrectionBudgetV2[] {
    const rows = this.connection.prepare("SELECT correction_budget_id FROM correction_budgets_v2 WHERE goal_id=? ORDER BY family")
      .all(goalId) as Record<string, unknown>[];
    return rows.map((row) => {
      const budget = this.readCorrectionBudget(text(row, "correction_budget_id"));
      if (!budget) throw new AuthorityIntegrityError("Correction budget V2 index lost a record");
      return budget;
    });
  }

  recordCorrectionAttempt(input: {
    readonly goal_id: string;
    readonly family: CorrectionFamilyV2;
    readonly result: CorrectionAttemptResultV2;
    readonly created_at_ms: number;
  }, sequence: number): CorrectionAttemptReceiptV2 {
    assertTransaction(this.connection);
    const observationEventSha256 = this.assertEventContext(input.goal_id, sequence);
    return inSavepoint(this.connection, () => {
      const plan = this.readCurrentPlan(input.goal_id);
      if (!plan) throw new AuthorityIntegrityError("Correction attempt V2 requires a current Plan revision");
      const budgetRow = this.connection.prepare(`SELECT correction_budget_id FROM correction_budgets_v2
        WHERE goal_id=? AND family=?`).get(input.goal_id, input.family) as Record<string, unknown> | undefined;
      if (!budgetRow) throw new AuthorityIntegrityError("Correction attempt V2 lacks its durable family budget");
      const budget = this.readCorrectionBudget(text(budgetRow, "correction_budget_id"));
      if (!budget) throw new AuthorityIntegrityError("Correction attempt V2 budget is invalid");
      const head = this.connection.prepare("SELECT * FROM correction_budget_heads_v2 WHERE correction_budget_id=?")
        .get(budget.correction_budget_id) as Record<string, unknown> | undefined;
      if (!head || text(head, "stop_action") !== "CONTINUE") {
        throw new AuthorityIntegrityError("Correction attempt V2 budget is already stopped");
      }
      const previousId = nullableText(head, "latest_attempt_id");
      const previous = previousId === null ? null : this.readCorrectionAttempt(previousId);
      if (previousId !== null && !previous) throw new AuthorityIntegrityError("Correction attempt V2 head lost its predecessor");
      const observation = this.connection.prepare(`SELECT sequence,event_type,payload_sha256,event_sha256 FROM events
        WHERE goal_id=? AND sequence=?`).get(input.goal_id, sequence - 1) as Record<string, unknown> | undefined;
      if (!observation || text(observation, "event_sha256") !== observationEventSha256) {
        throw new AuthorityIntegrityError("Correction attempt V2 lacks its exact Host observation event");
      }
      const observationSignatureSha256 = canonicalJsonSha256({
        domain: "PCH-CORRECTION-OBSERVATION-SIGNATURE-V2",
        event_type: text(observation, "event_type"),
        payload_sha256: text(observation, "payload_sha256"),
      });
      const receipt = finalizeCorrectionAttemptV2({
        budget,
        current_plan: plan.revision,
        previous,
        observation_event_sequence: integer(observation, "sequence"),
        observation_event_sha256: observationEventSha256,
        observation_signature_sha256: observationSignatureSha256,
        result: input.result,
        created_at_ms: input.created_at_ms,
      });
      this.connection.prepare(`INSERT INTO correction_attempts_v2(
        correction_attempt_id,correction_budget_id,goal_id,current_plan_revision_id,current_plan_revision_sha256,
        family,attempt_number,parent_attempt_id,parent_attempt_sha256,observation_event_sequence,
        observation_event_sha256,observation_signature_sha256,progress_changed,no_progress_streak,result,
        stop_action,stop_reason,record_sha256,created_at_ms,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.correction_attempt_id, receipt.correction_budget_id, receipt.goal_id,
        receipt.current_plan_revision_id, receipt.current_plan_revision_sha256, receipt.family,
        receipt.attempt_number, receipt.parent_attempt_id, receipt.parent_attempt_sha256,
        receipt.observation_event_sequence, receipt.observation_event_sha256, receipt.observation_signature_sha256,
        receipt.progress_changed ? 1 : 0, receipt.no_progress_streak, receipt.result, receipt.stop_action,
        receipt.stop_reason, receipt.record_sha256, receipt.created_at_ms, sequence,
      );
      const updated = this.connection.prepare(`UPDATE correction_budget_heads_v2 SET latest_attempt_id=?,
        latest_attempt_sha256=?,attempt_count=?,no_progress_streak=?,stop_action=?,updated_event_sequence=?
        WHERE correction_budget_id=? AND attempt_count=? AND stop_action='CONTINUE'`).run(
        receipt.correction_attempt_id, receipt.record_sha256, receipt.attempt_number, receipt.no_progress_streak,
        receipt.stop_action, sequence, receipt.correction_budget_id, receipt.attempt_number - 1,
      );
      if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Correction attempt V2 head CAS failed");
      const restored = this.readCorrectionAttempt(receipt.correction_attempt_id);
      if (!restored || restored.record_sha256 !== receipt.record_sha256) {
        throw new AuthorityIntegrityError("Correction attempt V2 write could not be rebuilt");
      }
      return restored;
    });
  }

  readCorrectionAttempt(correctionAttemptId: string): CorrectionAttemptReceiptV2 | null {
    const row = this.connection.prepare("SELECT * FROM correction_attempts_v2 WHERE correction_attempt_id=?")
      .get(correctionAttemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const budget = this.readCorrectionBudget(text(row, "correction_budget_id"));
    const plan = this.readPlanRevision(text(row, "current_plan_revision_id"));
    if (!budget || !plan) throw new AuthorityIntegrityError("Correction attempt V2 lost its authority closure");
    const parentId = nullableText(row, "parent_attempt_id");
    const previous = parentId === null ? null : this.readCorrectionAttempt(parentId);
    if (parentId !== null && !previous) throw new AuthorityIntegrityError("Correction attempt V2 lost its predecessor");
    const observation = this.connection.prepare(`SELECT event_type,payload_sha256,event_sha256 FROM events
      WHERE goal_id=? AND sequence=?`).get(
      text(row, "goal_id"), integer(row, "observation_event_sequence"),
    ) as Record<string, unknown> | undefined;
    if (!observation || text(observation, "event_sha256") !== text(row, "observation_event_sha256")) {
      throw new AuthorityIntegrityError("Correction attempt V2 observation event is invalid");
    }
    const observationSignatureSha256 = canonicalJsonSha256({
      domain: "PCH-CORRECTION-OBSERVATION-SIGNATURE-V2",
      event_type: text(observation, "event_type"),
      payload_sha256: text(observation, "payload_sha256"),
    });
    const expected = finalizeCorrectionAttemptV2({
      budget,
      current_plan: plan.revision,
      previous,
      observation_event_sequence: integer(row, "observation_event_sequence"),
      observation_event_sha256: text(row, "observation_event_sha256"),
      observation_signature_sha256: observationSignatureSha256,
      result: text(row, "result") as CorrectionAttemptResultV2,
      created_at_ms: integer(row, "created_at_ms"),
    });
    if (expected.correction_attempt_id !== correctionAttemptId
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.observation_signature_sha256 !== text(row, "observation_signature_sha256")
      || Number(expected.progress_changed) !== integer(row, "progress_changed")
      || expected.no_progress_streak !== integer(row, "no_progress_streak")
      || expected.stop_action !== text(row, "stop_action")
      || expected.stop_reason !== text(row, "stop_reason")) {
      throw new AuthorityIntegrityError("Stored Correction attempt V2 is not Host-derived");
    }
    return expected;
  }

  private readCorrectionBudget(correctionBudgetId: string): CorrectionBudgetV2 | null {
    const row = this.connection.prepare("SELECT * FROM correction_budgets_v2 WHERE correction_budget_id=?")
      .get(correctionBudgetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plan = this.readPlanRevision(text(row, "origin_plan_revision_id"));
    if (!plan) throw new AuthorityIntegrityError("Correction budget V2 lost its origin Plan");
    const expected = finalizeCorrectionBudgetV2({
      plan: plan.revision,
      family: text(row, "family") as CorrectionFamilyV2,
      maximum_attempts: integer(row, "maximum_attempts"),
      maximum_no_progress: integer(row, "maximum_no_progress"),
      policy_source_sha256: text(row, "policy_source_sha256"),
    });
    if (expected.correction_budget_id !== correctionBudgetId
      || expected.record_sha256 !== text(row, "record_sha256")
      || expected.origin_plan_revision_sha256 !== text(row, "origin_plan_revision_sha256")) {
      throw new AuthorityIntegrityError("Stored Correction budget V2 is not Host-derived");
    }
    return expected;
  }

  private ensureCorrectionBudgets(plan: PlanRevisionV2, sequence: number): void {
    const budgetRows = this.connection.prepare("SELECT budget_json FROM work_cells_v1 WHERE route_id=? ORDER BY logical_key")
      .all(plan.route_id) as Record<string, unknown>[];
    const workCellBudgets = budgetRows.map((row) => canonicalValue(row, "budget_json"));
    const configuredAttempts = workCellBudgets.flatMap((budget) => {
      if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return [];
      const value = (budget as Record<string, CanonicalJson>).max_attempts;
      return typeof value === "number" && Number.isSafeInteger(value) ? [value] : [];
    });
    const workAttemptLimit = Math.min(8, Math.max(2, ...configuredAttempts));
    const policies: Readonly<Record<CorrectionFamilyV2, readonly [number, number]>> = {
      LOCAL_REPAIR: [workAttemptLimit, Math.min(2, workAttemptLimit)],
      REPLAN: [3, 2],
      ASK_USER: [2, 1],
      RECONCILE: [3, 2],
      WORKER_RETRY: [workAttemptLimit, Math.min(2, workAttemptLimit)],
      HANDOFF: [3, 1],
      PROVIDER_FANOUT: [4, 2],
    };
    const policySourceSha256 = canonicalJsonSha256({
      domain: "PCH-CORRECTION-BUDGET-POLICY-SOURCE-V2",
      route_sha256: plan.route_sha256,
      work_cell_budgets: workCellBudgets,
      policies,
    });
    for (const family of correctionFamiliesV2) {
      const existing = this.connection.prepare("SELECT correction_budget_id FROM correction_budgets_v2 WHERE goal_id=? AND family=?")
        .get(plan.goal_id, family) as Record<string, unknown> | undefined;
      if (existing) {
        this.readCorrectionBudget(text(existing, "correction_budget_id"));
        continue;
      }
      const [maximumAttempts, maximumNoProgress] = policies[family];
      const budget = finalizeCorrectionBudgetV2({
        plan,
        family,
        maximum_attempts: maximumAttempts,
        maximum_no_progress: maximumNoProgress,
        policy_source_sha256: policySourceSha256,
      });
      this.connection.prepare(`INSERT INTO correction_budgets_v2(
        correction_budget_id,goal_id,origin_plan_revision_id,origin_plan_revision_sha256,family,maximum_attempts,
        maximum_no_progress,policy_source_sha256,record_sha256,created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        budget.correction_budget_id, budget.goal_id, budget.origin_plan_revision_id,
        budget.origin_plan_revision_sha256, budget.family, budget.maximum_attempts,
        budget.maximum_no_progress, budget.policy_source_sha256, budget.record_sha256, sequence,
      );
      this.connection.prepare(`INSERT INTO correction_budget_heads_v2(
        correction_budget_id,goal_id,family,latest_attempt_id,latest_attempt_sha256,attempt_count,
        no_progress_streak,stop_action,updated_event_sequence
      ) VALUES(?,?,?,NULL,NULL,0,0,'CONTINUE',?)`).run(
        budget.correction_budget_id, budget.goal_id, budget.family, sequence,
      );
    }
  }

  private deriveCurrentInput(goalId: string): DerivedPlanInputV2 {
    const intake = new IntakeAuthorityV2Repository(this.connection);
    const freeze = intake.readLatestContractFreeze(goalId);
    if (!freeze) throw new AuthorityIntegrityError("Plan V2 requires a current ContractFreezeReceipt");
    const contractHead = this.connection.prepare("SELECT * FROM goal_contract_heads_v1 WHERE goal_id=?")
      .get(goalId) as Record<string, unknown> | undefined;
    if (!contractHead || text(contractHead, "contract_id") !== freeze.contract_id
      || text(contractHead, "contract_sha256") !== freeze.contract_sha256) {
      throw new AuthorityIntegrityError("Plan V2 ContractFreeze is not bound to the current GoalContract head");
    }
    const latestRequirement = this.connection.prepare(`SELECT requirement_revision_id,record_sha256
      FROM requirement_revisions_v2 WHERE goal_id=? AND contract_id=? ORDER BY revision DESC LIMIT 1`)
      .get(goalId, freeze.contract_id) as Record<string, unknown> | undefined;
    if (!latestRequirement
      || text(latestRequirement, "requirement_revision_id") !== freeze.requirement_revision_id) {
      throw new AuthorityIntegrityError("Plan V2 ContractFreeze does not bind the current Requirement revision");
    }
    const route = this.connection.prepare(`SELECT r.route_id,r.contract_id,r.record_sha256,h.route_sha256,h.health
      FROM route_skeleton_heads_v1 h JOIN route_skeleton_versions_v1 r ON r.route_id=h.route_id
      WHERE h.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!route || text(route, "contract_id") !== freeze.contract_id
      || text(route, "record_sha256") !== text(route, "route_sha256")
      || text(route, "health") !== "HEALTHY") {
      throw new AuthorityIntegrityError("Plan V2 requires the current healthy Route projection");
    }
    const graph = this.deriveGraph(freeze.requirement_revision_id, text(route, "route_id"), freeze.contract_id);
    return {
      goal_id: goalId,
      contract_id: freeze.contract_id,
      authority_root_id: freeze.authority_root_id,
      contract_freeze_receipt_id: freeze.contract_freeze_receipt_id,
      contract_freeze_sha256: freeze.record_sha256,
      requirement_revision_id: freeze.requirement_revision_id,
      requirement_revision_sha256: text(latestRequirement, "record_sha256"),
      route_id: text(route, "route_id"),
      route_sha256: text(route, "record_sha256"),
      ...graph,
    };
  }

  private deriveGraph(
    requirementRevisionId: string,
    routeId: string,
    contractId: string,
  ): Pick<DerivedPlanInputV2, "subjects" | "edges" | "must_requirements" | "work_cells"> {
    const requirementRows = this.connection.prepare(`SELECT requirement_id,requirement_item_revision_id,priority,record_sha256
      FROM requirement_items_v2 WHERE requirement_revision_id=? ORDER BY requirement_id`)
      .all(requirementRevisionId) as Record<string, unknown>[];
    const decisionRows = this.connection.prepare(`SELECT decision_requirement_id,decision_requirement_revision_id,kind,record_sha256
      FROM decision_requirements_v2 WHERE requirement_revision_id=? ORDER BY decision_requirement_id`)
      .all(requirementRevisionId) as Record<string, unknown>[];
    const workCellRows = this.connection.prepare(`SELECT work_cell_id,logical_key,spec_sha256,obligation_ids_json
      FROM work_cells_v1 WHERE route_id=? ORDER BY logical_key`).all(routeId) as Record<string, unknown>[];
    const requirements = requirementRows.map((row): PlanSubjectRefV2 => ({
      kind: "REQUIREMENT",
      id: text(row, "requirement_id"),
      revision_sha256: text(row, "record_sha256"),
    }));
    const decisions = decisionRows.map((row): PlanSubjectRefV2 => ({
      kind: "DECISION",
      id: text(row, "decision_requirement_id"),
      revision_sha256: text(row, "record_sha256"),
    }));
    const workCells = workCellRows.map((row): PlanSubjectRefV2 => ({
      kind: "WORK_CELL",
      id: text(row, "logical_key"),
      revision_sha256: text(row, "spec_sha256"),
    }));
    const byKey = new Map([...requirements, ...decisions, ...workCells].map((subject) => [planSubjectKeyV2(subject), subject]));
    const edges = new Map<string, PlanDependencyEdgeV2>();
    const appendEdge = (source: PlanSubjectRefV2, target: PlanSubjectRefV2, kind: PlanDependencyEdgeV2["dependency_kind"]): void => {
      const key = `${planSubjectKeyV2(source)}\u0000${kind}\u0000${planSubjectKeyV2(target)}`;
      edges.set(key, { source, target, dependency_kind: kind });
    };

    const obligationCells = new Map<string, PlanSubjectRefV2[]>();
    workCellRows.forEach((row) => {
      const cell = byKey.get(`WORK_CELL\u0000${text(row, "logical_key")}`)!;
      for (const obligationId of stringArray(row, "obligation_ids_json")) {
        const cells = obligationCells.get(obligationId) ?? [];
        cells.push(cell);
        obligationCells.set(obligationId, cells);
      }
    });
    const requirementObligations = this.connection.prepare(`SELECT DISTINCT
        r.requirement_id,o.task_obligation_id
      FROM requirement_item_facet_members_v2 m
      JOIN requirement_items_v2 r ON r.requirement_item_revision_id=m.requirement_item_revision_id
      JOIN facet_obligation_bindings_v2 b ON b.facet_id=m.facet_id AND b.contract_id=?
      JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
      WHERE m.requirement_revision_id=?`).all(contractId, requirementRevisionId) as Record<string, unknown>[];
    for (const row of requirementObligations) {
      const requirement = byKey.get(`REQUIREMENT\u0000${text(row, "requirement_id")}`);
      if (!requirement) throw new AuthorityIntegrityError("Plan V2 coverage references an unknown Requirement");
      for (const cell of obligationCells.get(text(row, "task_obligation_id")) ?? []) {
        appendEdge(requirement, cell, "REQUIRES");
      }
    }
    const decisionMembers = this.connection.prepare(`SELECT d.decision_requirement_id,d.kind,r.requirement_id
      FROM decision_requirement_item_members_v2 m
      JOIN decision_requirements_v2 d ON d.decision_requirement_revision_id=m.decision_requirement_revision_id
      JOIN requirement_items_v2 r ON r.requirement_item_revision_id=m.requirement_item_revision_id
      WHERE m.requirement_revision_id=?`)
      .all(requirementRevisionId) as Record<string, unknown>[];
    for (const row of decisionMembers) {
      const decision = byKey.get(`DECISION\u0000${text(row, "decision_requirement_id")}`);
      const requirement = byKey.get(`REQUIREMENT\u0000${text(row, "requirement_id")}`);
      if (!decision || !requirement) throw new AuthorityIntegrityError("Plan V2 Decision trace lost a subject");
      appendEdge(decision, requirement, text(row, "kind") === "DRAFT_REVIEW" ? "AUTHORIZES" : "DERIVED_FROM");
    }
    const dependencies = this.connection.prepare(`SELECT dependent.logical_key AS dependent_key,
        prerequisite.logical_key AS prerequisite_key
      FROM work_cell_dependencies_v1 d
      JOIN work_cells_v1 dependent ON dependent.work_cell_id=d.work_cell_id
      JOIN work_cells_v1 prerequisite ON prerequisite.work_cell_id=d.depends_on_work_cell_id
      WHERE d.route_id=?`).all(routeId) as Record<string, unknown>[];
    for (const row of dependencies) {
      const dependent = byKey.get(`WORK_CELL\u0000${text(row, "dependent_key")}`);
      const prerequisite = byKey.get(`WORK_CELL\u0000${text(row, "prerequisite_key")}`);
      if (!dependent || !prerequisite) throw new AuthorityIntegrityError("Plan V2 WorkCell dependency lost a subject");
      appendEdge(prerequisite, dependent, "REQUIRES");
    }
    const graph = validatePlanGraphV2([...byKey.values()], [...edges.values()]);
    return {
      subjects: graph.subjects,
      edges: graph.edges,
      must_requirements: requirements.filter((_, index) => text(requirementRows[index]!, "priority") === "MUST"),
      work_cells: workCells,
    };
  }

  private insertProjection(
    projection: PlanAuthorityProjectionV2,
    sequence: number,
    predecessor: PlanAuthorityProjectionV2 | null,
  ): void {
    const revision = projection.revision;
    this.connection.prepare(`INSERT INTO plan_revisions_v2(
      plan_revision_id,plan_id,goal_id,contract_id,authority_root_id,contract_freeze_receipt_id,
      contract_freeze_sha256,requirement_revision_id,requirement_revision_sha256,route_id,route_sha256,
      revision,parent_plan_revision_id,parent_plan_revision_sha256,subject_root_sha256,dependency_root_sha256,
      must_requirement_root_sha256,work_cell_root_sha256,input_closure_sha256,subject_count,dependency_count,
      requirement_count,work_cell_count,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      revision.plan_revision_id, revision.plan_id, revision.goal_id, revision.contract_id, revision.authority_root_id,
      revision.contract_freeze_receipt_id, revision.contract_freeze_sha256, revision.requirement_revision_id,
      revision.requirement_revision_sha256, revision.route_id, revision.route_sha256, revision.revision,
      revision.parent_plan_revision_id, revision.parent_plan_revision_sha256, revision.subject_root_sha256,
      revision.dependency_root_sha256, revision.must_requirement_root_sha256, revision.work_cell_root_sha256,
      revision.input_closure_sha256, revision.subject_count, revision.dependency_count, revision.requirement_count,
      revision.work_cell_count, revision.record_sha256, revision.created_at_ms, sequence,
    );
    const insertSubject = this.connection.prepare(`INSERT INTO plan_subjects_v2(
      plan_revision_id,goal_id,subject_kind,subject_id,revision_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?)`);
    projection.subjects.forEach((subject, ordinal) => insertSubject.run(
      revision.plan_revision_id, revision.goal_id, subject.kind, subject.id, subject.revision_sha256, ordinal, sequence,
    ));
    const insertEdge = this.connection.prepare(`INSERT INTO plan_dependency_edges_v2(
      edge_id,plan_revision_id,goal_id,source_kind,source_id,target_kind,target_id,dependency_kind,
      ordinal,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    projection.edges.forEach((edge, ordinal) => {
      const identity = edgeIdentity(revision.plan_revision_id, edge);
      insertEdge.run(identity.edge_id, revision.plan_revision_id, revision.goal_id,
        edge.source.kind, edge.source.id, edge.target.kind, edge.target.id, edge.dependency_kind,
        ordinal, identity.record_sha256, sequence);
    });
    if (!predecessor) {
      this.connection.prepare(`INSERT INTO plan_heads_v2(
        goal_id,plan_id,plan_revision_id,revision,plan_revision_sha256,updated_event_sequence
      ) VALUES(?,?,?,?,?,?)`).run(
        revision.goal_id, revision.plan_id, revision.plan_revision_id, revision.revision, revision.record_sha256, sequence,
      );
      return;
    }
    const result = this.connection.prepare(`UPDATE plan_heads_v2 SET plan_id=?,plan_revision_id=?,revision=?,
      plan_revision_sha256=?,updated_event_sequence=? WHERE goal_id=? AND plan_revision_id=? AND plan_revision_sha256=?`)
      .run(revision.plan_id, revision.plan_revision_id, revision.revision, revision.record_sha256, sequence,
        revision.goal_id, predecessor.revision.plan_revision_id, predecessor.revision.record_sha256);
    if (Number(result.changes) !== 1) throw new AuthorityIntegrityError("Plan V2 head CAS failed");
  }

  private requirementPriority(requirementId: string): string {
    const row = this.connection.prepare("SELECT priority FROM requirement_items_v2 WHERE requirement_id=?")
      .get(requirementId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Plan V2 Requirement subject is missing");
    return text(row, "priority");
  }

  private assertSubjectBacking(subject: PlanSubjectRefV2, planRow: Record<string, unknown>): void {
    let row: Record<string, unknown> | undefined;
    let hashColumn: string;
    if (subject.kind === "REQUIREMENT") {
      row = this.connection.prepare(`SELECT record_sha256 FROM requirement_items_v2
        WHERE requirement_id=? AND requirement_revision_id=? AND goal_id=?`)
        .get(subject.id, text(planRow, "requirement_revision_id"), text(planRow, "goal_id")) as Record<string, unknown> | undefined;
      hashColumn = "record_sha256";
    } else if (subject.kind === "DECISION") {
      row = this.connection.prepare(`SELECT record_sha256 FROM decision_requirements_v2
        WHERE decision_requirement_id=? AND requirement_revision_id=? AND goal_id=?`)
        .get(subject.id, text(planRow, "requirement_revision_id"), text(planRow, "goal_id")) as Record<string, unknown> | undefined;
      hashColumn = "record_sha256";
    } else if (subject.kind === "WORK_CELL") {
      row = this.connection.prepare(`SELECT spec_sha256 FROM work_cells_v1
        WHERE logical_key=? AND route_id=? AND goal_id=?`)
        .get(subject.id, text(planRow, "route_id"), text(planRow, "goal_id")) as Record<string, unknown> | undefined;
      hashColumn = "spec_sha256";
    } else {
      throw new AuthorityIntegrityError(`Plan V2 persisted unsupported subject kind ${subject.kind}`);
    }
    if (!row || text(row, hashColumn) !== subject.revision_sha256) {
      throw new AuthorityIntegrityError(`Plan V2 ${subject.kind} subject backing is invalid`);
    }
  }

  private assertEventContext(goalId: string, sequence: number, providedHeadSha256?: string): string {
    eventSequence(sequence);
    const row = this.connection.prepare(`SELECT sequence,event_sha256 FROM events
      WHERE goal_id=? ORDER BY sequence DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Plan V2 authority command lacks a core event predecessor");
    const predecessorSequence = integer(row, "sequence");
    const predecessorSha256 = text(row, "event_sha256");
    if (sequence !== predecessorSequence + 1) {
      throw new AuthorityIntegrityError("Plan V2 created_event_sequence is not the next core Goal event");
    }
    if (providedHeadSha256 !== undefined && providedHeadSha256 !== predecessorSha256) {
      throw new AuthorityIntegrityError("Plan V2 authority input is not bound to the current core event head");
    }
    return predecessorSha256;
  }
}
