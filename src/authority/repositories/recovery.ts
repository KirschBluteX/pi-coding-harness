import type { DataClassification } from "../../artifacts/classify.js";
import type { ProtectedRef } from "../../context/protected-projection.js";
import type { GoalRow } from "../repositories.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { canonicalJsonSha256, parseCanonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { AuthorityRepository } from "../repositories.js";
import { ExperimentRepository, type ActivePerformanceTrialMaterial } from "./experiments.js";

export type RecoveryObservationType =
  | "PROMPT_GENERATION" | "PROMPT_REQUEST" | "OUTPUT_OBSERVATION" | "TOOL_RESULT_PROJECTION";

export interface RecoveryArtifact {
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly classification: DataClassification;
  readonly locator: string;
  readonly encryptionKeyId: string | null;
  readonly retentionClass: string;
}

export interface RequirementRevisionMaterial {
  readonly requirementId: string;
  readonly revision: number;
  readonly parentRequirementId: string | null;
  readonly profile: "TASK_SPEC" | "PRD";
  readonly triggerEvidenceSha256: string;
  readonly payloadSha256: string;
  readonly createdAtMs: number;
  readonly createdEventSequence: number;
  readonly artifact: RecoveryArtifact;
}

export interface PlanRevisionMaterial {
  readonly planId: string;
  readonly requirementId: string;
  readonly revision: number;
  readonly parentPlanId: string | null;
  readonly triggerEvidenceSha256: string;
  readonly payloadSha256: string;
  readonly createdAtMs: number;
  readonly createdEventSequence: number;
  readonly artifact: RecoveryArtifact;
}

export interface StageRecoveryMaterial {
  readonly stageId: string;
  readonly specSha256: string;
  readonly status: "PLANNED" | "READY" | "RUNNING" | "WAITING_USER" | "BLOCKED" | "RECOVERING"
    | "NEEDS_RECONCILIATION" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "INVALIDATED";
  readonly ordinal: number;
}

export interface ReceiptRecoveryMaterial {
  readonly receiptId: string;
  readonly receiptType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly result: string;
  readonly inputClosureSha256: string;
  readonly outputSha256: string | null;
  readonly failureSignatureSha256: string | null;
  readonly body: unknown;
  readonly issuedEventSequence: number;
  readonly ref: ProtectedRef;
}

export interface PendingEffectRecoveryMaterial {
  readonly effectId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly stageId: string;
  readonly effectClass: string;
  readonly normalizedTargetSha256: string;
  readonly normalizedPayloadSha256: string;
  readonly idempotencyKeyHmac: string;
  readonly attemptOutcome: string | null;
  readonly ref: ProtectedRef;
}

export interface RouteDecisionRecoveryMaterial {
  readonly routeDecisionId: string;
  readonly planId: string;
  readonly planHealthStatus: string;
  readonly correctionLevel: string;
  readonly triggerSha256: string;
  readonly candidates: unknown;
  readonly selectedRouteId: string;
  readonly lexicographicEvidence: unknown;
  readonly createdEventSequence: number;
  readonly ref: ProtectedRef;
}

export interface ObservationRecoveryMaterial {
  readonly observationId: string;
  readonly observationType: RecoveryObservationType;
  readonly issuedEventSequence: number;
  readonly artifact: RecoveryArtifact;
  readonly ref: ProtectedRef;
}

export interface TransitionRecoveryMaterial {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventSha256: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuthorityRecoveryMaterial {
  readonly goal: GoalRow;
  readonly admission: TransitionRecoveryMaterial;
  readonly goalVersion: number;
  readonly requirement: RequirementRevisionMaterial | null;
  readonly plan: PlanRevisionMaterial | null;
  readonly stages: readonly StageRecoveryMaterial[];
  readonly invalidatedIds: ReadonlySet<string>;
  readonly blockingDecisionIds: readonly string[];
  readonly pendingEffects: readonly PendingEffectRecoveryMaterial[];
  readonly receipts: readonly ReceiptRecoveryMaterial[];
  readonly failureSignatures: readonly string[];
  readonly failureOccurrences: Readonly<Record<string, number>>;
  readonly routeDecision: RouteDecisionRecoveryMaterial | null;
  readonly latestCorrection: TransitionRecoveryMaterial | null;
  readonly latestInvalidation: TransitionRecoveryMaterial | null;
  readonly latestTransition: TransitionRecoveryMaterial | null;
  readonly observations: readonly ObservationRecoveryMaterial[];
  readonly activePerformanceTrial: ActivePerformanceTrialMaterial | null;
  readonly historicalRefs: readonly ProtectedRef[];
  readonly historicalRequirementArtifacts: readonly RecoveryArtifact[];
  readonly historicalPlanArtifacts: readonly RecoveryArtifact[];
}

function text(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Recovery field ${field} must be text`);
  return value;
}

function integer(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AuthorityIntegrityError(`Recovery field ${field} must be a safe integer`);
  }
  return value;
}

function nullableText(row: Record<string, unknown>, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}

function parsed(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Recovery field ${field} must contain canonical JSON`);
  try { return parseCanonicalJson(value); }
  catch (error) { throw new AuthorityIntegrityError(`Recovery field ${field} is not canonical JSON`, error); }
}

function artifact(row: Record<string, unknown>): RecoveryArtifact {
  const record: RecoveryArtifact = {
    artifactId: text(row, "artifact_id"), sha256: text(row, "sha256"),
    byteLength: integer(row, "byte_length"), mediaType: text(row, "media_type"),
    classification: text(row, "classification") as DataClassification,
    locator: text(row, "locator"), encryptionKeyId: nullableText(row, "encryption_key_id"),
    retentionClass: text(row, "retention_class"),
  };
  if (!/^[a-f0-9]{64}$/u.test(record.sha256) || record.byteLength < 0) {
    throw new AuthorityIntegrityError(`Invalid recovery artifact metadata at ${record.artifactId}`);
  }
  return record;
}

function protectedRef(id: string, value: unknown): ProtectedRef {
  return { id, sha256: canonicalJsonSha256(value) };
}

function transition(row: Record<string, unknown> | undefined): TransitionRecoveryMaterial | null {
  if (!row) return null;
  const payload = parsed(row.payload_json, "payload_json");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AuthorityIntegrityError("Recovery transition payload must be an object");
  }
  return {
    eventId: text(row, "event_id"), eventType: text(row, "event_type"),
    eventSha256: text(row, "event_sha256"), sequence: integer(row, "sequence"),
    payload: payload as Readonly<Record<string, unknown>>,
  };
}

const artifactColumns = "a.artifact_id,a.sha256,a.byte_length,a.media_type,a.classification,a.locator,a.encryption_key_id,a.retention_class";

export class RecoveryRepository {
  private readonly authority: AuthorityRepository;
  private readonly experiments: ExperimentRepository;

  constructor(private readonly connection: AuthorityConnection) {
    this.authority = new AuthorityRepository(connection);
    this.experiments = new ExperimentRepository(connection);
  }

  read(goalId: string): AuthorityRecoveryMaterial {
    const goal = this.authority.goal(goalId);
    const goalVersion = this.authority.goalVersion(goalId);
    const admission = this.latestEvent(goalId, "GOAL_ADMITTED");
    if (!admission || admission.sequence !== 1) throw new AuthorityIntegrityError("Goal admission event is missing or out of order");
    const requirement = this.requirement(goalId);
    const plan = requirement ? this.plan(goalId, requirement.requirementId) : null;
    const failureOccurrences = this.failureOccurrences(goalId);
    return {
      goal, admission, goalVersion, requirement, plan,
      stages: plan ? this.stages(plan.planId) : [],
      invalidatedIds: new Set((this.connection.prepare("SELECT target_id FROM invalidations WHERE goal_id=? ORDER BY created_event_sequence").all(goalId) as Record<string, unknown>[]).map((row) => text(row, "target_id"))),
      blockingDecisionIds: (this.connection.prepare(`SELECT d.decision_id FROM decisions d LEFT JOIN decision_resolutions r ON r.decision_id=d.decision_id
        WHERE d.goal_id=? AND r.decision_id IS NULL ORDER BY d.requested_event_sequence`).all(goalId) as Record<string, unknown>[]).map((row) => text(row, "decision_id")),
      pendingEffects: this.pendingEffects(goalId), receipts: this.receipts(goalId),
      failureSignatures: Object.keys(failureOccurrences).sort(), failureOccurrences,
      routeDecision: this.routeDecision(goalId), latestCorrection: this.latestEvent(goalId, "GOAL_CORRECTED"),
      latestInvalidation: this.latestEvent(goalId, "DEPENDENCY_INVALIDATED"),
      latestTransition: this.latestTransition(goalId), observations: this.observations(goalId),
      activePerformanceTrial: this.experiments.activeTrial(goalId),
      historicalRefs: this.historicalRefs(goalId),
      historicalRequirementArtifacts: this.historicalRequirementArtifacts(goalId),
      historicalPlanArtifacts: this.historicalPlanArtifacts(goalId),
    };
  }

  private historicalRefs(goalId: string): ProtectedRef[] {
    const refs: ProtectedRef[] = [];
    const requirements = this.connection.prepare(`SELECT requirement_id,requirements_payload_sha256
      FROM requirement_revisions WHERE goal_id=? ORDER BY revision`).all(goalId) as Record<string, unknown>[];
    for (const row of requirements) refs.push({
      id: text(row, "requirement_id"), sha256: text(row, "requirements_payload_sha256"),
    });
    const plans = this.connection.prepare(`SELECT plan_id,plan_payload_sha256 FROM plan_revisions
      WHERE goal_id=? ORDER BY revision`).all(goalId) as Record<string, unknown>[];
    for (const row of plans) refs.push({ id: text(row, "plan_id"), sha256: text(row, "plan_payload_sha256") });
    const stages = this.connection.prepare(`SELECT stage_id,spec_sha256 FROM plan_stages
      WHERE goal_id=? ORDER BY plan_id,ordinal`).all(goalId) as Record<string, unknown>[];
    for (const row of stages) refs.push({ id: text(row, "stage_id"), sha256: text(row, "spec_sha256") });
    const effects = this.connection.prepare(`SELECT e.effect_id,e.work_item_id,e.attempt_id,w.stage_id,e.effect_class,
      e.normalized_target_sha256,e.normalized_payload_sha256,e.idempotency_key_hmac
      FROM effects e JOIN work_items w ON w.work_item_id=e.work_item_id
      WHERE e.goal_id=? ORDER BY e.created_event_sequence,e.effect_id`).all(goalId) as Record<string, unknown>[];
    for (const row of effects) {
      const effectId = text(row, "effect_id");
      refs.push(protectedRef(effectId, {
        work_item_id: text(row, "work_item_id"), attempt_id: text(row, "attempt_id"),
        stage_id: text(row, "stage_id"), effect_class: text(row, "effect_class"),
        normalized_target_sha256: text(row, "normalized_target_sha256"),
        normalized_payload_sha256: text(row, "normalized_payload_sha256"),
        idempotency_key_hmac: text(row, "idempotency_key_hmac"),
      }));
    }
    const decisions = this.connection.prepare(`SELECT route_decision_id,plan_id,plan_health_status,correction_level,
      trigger_sha256,candidates_json,selected_route_id,lexicographic_evidence_json,created_event_sequence
      FROM route_decisions WHERE goal_id=? ORDER BY created_event_sequence,route_decision_id`).all(goalId) as Record<string, unknown>[];
    for (const row of decisions) refs.push(this.decodeRouteDecision(row).ref);
    const corrections = this.connection.prepare(`SELECT event_id,event_sha256 FROM events
      WHERE goal_id=? AND event_type='GOAL_CORRECTED' ORDER BY sequence`).all(goalId) as Record<string, unknown>[];
    for (const row of corrections) refs.push({ id: text(row, "event_id"), sha256: text(row, "event_sha256") });
    const trials = this.connection.prepare(`SELECT pt.trial_id,a.sha256 FROM performance_trials pt
      JOIN artifacts a ON a.artifact_id=pt.trial_spec_artifact_id WHERE pt.goal_id=?
      ORDER BY pt.created_at_ms,pt.trial_id`).all(goalId) as Record<string, unknown>[];
    for (const row of trials) refs.push({ id: text(row, "trial_id"), sha256: text(row, "sha256") });
    return refs;
  }

  private historicalRequirementArtifacts(goalId: string): RecoveryArtifact[] {
    const rows = this.connection.prepare(`SELECT ${artifactColumns} FROM requirement_revisions r
      JOIN artifacts a ON a.artifact_id=r.requirements_artifact_id WHERE r.goal_id=? ORDER BY r.revision`).all(goalId) as Record<string, unknown>[];
    return rows.map(artifact);
  }

  private historicalPlanArtifacts(goalId: string): RecoveryArtifact[] {
    const rows = this.connection.prepare(`SELECT ${artifactColumns} FROM plan_revisions p
      JOIN artifacts a ON a.artifact_id=p.plan_artifact_id WHERE p.goal_id=? ORDER BY p.revision`).all(goalId) as Record<string, unknown>[];
    return rows.map(artifact);
  }

  private failureOccurrences(goalId: string): Record<string, number> {
    const occurrences: Record<string, number> = {};
    const stored = this.connection.prepare("SELECT signature_sha256,occurrence_count FROM failure_signatures WHERE goal_id=?").all(goalId) as Record<string, unknown>[];
    for (const row of stored) {
      const signature = text(row, "signature_sha256");
      occurrences[signature] = Math.max(occurrences[signature] ?? 0, integer(row, "occurrence_count"));
    }
    const decisions = this.connection.prepare("SELECT lexicographic_evidence_json FROM route_decisions WHERE goal_id=? ORDER BY created_event_sequence").all(goalId) as Record<string, unknown>[];
    for (const row of decisions) {
      const evidence = parsed(row.lexicographic_evidence_json, "route_decisions.lexicographic_evidence_json");
      if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) continue;
      const value = evidence as Record<string, unknown>;
      const signature = value.failure_signature_sha256;
      const count = value.occurrence_count;
      if (typeof signature !== "string" || !/^[a-f0-9]{64}$/u.test(signature)
        || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) continue;
      occurrences[signature] = Math.max(occurrences[signature] ?? 0, count);
    }
    return occurrences;
  }

  private requirement(goalId: string): RequirementRevisionMaterial | null {
    const row = this.connection.prepare(`SELECT r.requirement_id,r.revision,r.parent_requirement_id,r.profile,
      r.trigger_evidence_sha256,r.requirements_payload_sha256,r.created_at_ms,r.created_event_sequence,${artifactColumns}
      FROM requirement_revisions r JOIN artifacts a ON a.artifact_id=r.requirements_artifact_id
      WHERE r.goal_id=? ORDER BY r.revision DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const payloadArtifact = artifact(row);
    const payloadSha256 = text(row, "requirements_payload_sha256");
    if (payloadArtifact.sha256 !== payloadSha256) throw new AuthorityIntegrityError("Requirement CAS locator does not match its payload hash");
    return {
      requirementId: text(row, "requirement_id"), revision: integer(row, "revision"),
      parentRequirementId: nullableText(row, "parent_requirement_id"), profile: text(row, "profile") as "TASK_SPEC" | "PRD",
      triggerEvidenceSha256: text(row, "trigger_evidence_sha256"), payloadSha256,
      createdAtMs: integer(row, "created_at_ms"), createdEventSequence: integer(row, "created_event_sequence"), artifact: payloadArtifact,
    };
  }

  private plan(goalId: string, requirementId: string): PlanRevisionMaterial | null {
    const row = this.connection.prepare(`SELECT p.plan_id,p.requirement_id,p.revision,p.parent_plan_id,
      p.trigger_evidence_sha256,p.plan_payload_sha256,p.created_at_ms,p.created_event_sequence,${artifactColumns}
      FROM plan_revisions p JOIN artifacts a ON a.artifact_id=p.plan_artifact_id
      WHERE p.goal_id=? AND p.requirement_id=? ORDER BY p.revision DESC LIMIT 1`).get(goalId, requirementId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const payloadArtifact = artifact(row);
    const payloadSha256 = text(row, "plan_payload_sha256");
    if (payloadArtifact.sha256 !== payloadSha256) throw new AuthorityIntegrityError("Plan CAS locator does not match its payload hash");
    return {
      planId: text(row, "plan_id"), requirementId: text(row, "requirement_id"), revision: integer(row, "revision"),
      parentPlanId: nullableText(row, "parent_plan_id"), triggerEvidenceSha256: text(row, "trigger_evidence_sha256"), payloadSha256,
      createdAtMs: integer(row, "created_at_ms"), createdEventSequence: integer(row, "created_event_sequence"), artifact: payloadArtifact,
    };
  }

  private stages(planId: string): StageRecoveryMaterial[] {
    const rows = this.connection.prepare(`SELECT s.stage_id,s.spec_sha256,s.ordinal,COALESCE(h.status,'PLANNED') AS status
      FROM plan_stages s LEFT JOIN stage_heads h ON h.stage_id=s.stage_id WHERE s.plan_id=? ORDER BY s.ordinal`).all(planId) as Record<string, unknown>[];
    return rows.map((row) => ({
      stageId: text(row, "stage_id"), specSha256: text(row, "spec_sha256"), ordinal: integer(row, "ordinal"),
      status: text(row, "status") as StageRecoveryMaterial["status"],
    }));
  }

  private receipts(goalId: string): ReceiptRecoveryMaterial[] {
    const rows = this.connection.prepare(`SELECT receipt_id,receipt_type,subject_type,subject_id,result,input_closure_sha256,
      output_sha256,failure_signature_sha256,body_json,issued_event_sequence FROM receipts WHERE goal_id=? ORDER BY issued_event_sequence,receipt_id`).all(goalId) as Record<string, unknown>[];
    return rows.map((row) => {
      const body = parsed(row.body_json, "receipts.body_json");
      const core = {
        receipt_type: text(row, "receipt_type"), subject_type: text(row, "subject_type"), subject_id: text(row, "subject_id"),
        result: text(row, "result"), input_closure_sha256: text(row, "input_closure_sha256"),
        output_sha256: nullableText(row, "output_sha256"), failure_signature_sha256: nullableText(row, "failure_signature_sha256"),
        body, issued_event_sequence: integer(row, "issued_event_sequence"),
      };
      const receiptId = text(row, "receipt_id");
      return { receiptId, receiptType: core.receipt_type, subjectType: core.subject_type, subjectId: core.subject_id,
        result: core.result, inputClosureSha256: core.input_closure_sha256, outputSha256: core.output_sha256,
        failureSignatureSha256: core.failure_signature_sha256, body, issuedEventSequence: core.issued_event_sequence,
        ref: protectedRef(receiptId, core) };
    });
  }

  private pendingEffects(goalId: string): PendingEffectRecoveryMaterial[] {
    const rows = this.connection.prepare(`SELECT e.effect_id,e.work_item_id,e.attempt_id,w.stage_id,e.effect_class,
      e.normalized_target_sha256,e.normalized_payload_sha256,e.idempotency_key_hmac,a.outcome AS attempt_outcome,
      o.outcome AS terminal_outcome FROM effects e JOIN work_items w ON w.work_item_id=e.work_item_id
      JOIN attempts a ON a.attempt_id=e.attempt_id LEFT JOIN effect_outcomes o ON o.effect_id=e.effect_id
      WHERE e.goal_id=? AND o.effect_id IS NULL ORDER BY e.created_event_sequence,e.effect_id`).all(goalId) as Record<string, unknown>[];
    return rows.map((row) => {
      const core = {
        work_item_id: text(row, "work_item_id"), attempt_id: text(row, "attempt_id"), stage_id: text(row, "stage_id"),
        effect_class: text(row, "effect_class"), normalized_target_sha256: text(row, "normalized_target_sha256"),
        normalized_payload_sha256: text(row, "normalized_payload_sha256"), idempotency_key_hmac: text(row, "idempotency_key_hmac"),
      };
      const effectId = text(row, "effect_id");
      return { effectId, workItemId: core.work_item_id, attemptId: core.attempt_id, stageId: core.stage_id,
        effectClass: core.effect_class, normalizedTargetSha256: core.normalized_target_sha256,
        normalizedPayloadSha256: core.normalized_payload_sha256, idempotencyKeyHmac: core.idempotency_key_hmac,
        attemptOutcome: nullableText(row, "attempt_outcome"), ref: protectedRef(effectId, core) };
    });
  }

  private routeDecision(goalId: string): RouteDecisionRecoveryMaterial | null {
    const row = this.connection.prepare(`SELECT route_decision_id,plan_id,plan_health_status,correction_level,trigger_sha256,
      candidates_json,selected_route_id,lexicographic_evidence_json,created_event_sequence
      FROM route_decisions WHERE goal_id=? ORDER BY created_event_sequence DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.decodeRouteDecision(row);
  }

  private decodeRouteDecision(row: Record<string, unknown>): RouteDecisionRecoveryMaterial {
    const core = {
      plan_id: text(row, "plan_id"), plan_health_status: text(row, "plan_health_status"), correction_level: text(row, "correction_level"),
      trigger_sha256: text(row, "trigger_sha256"), candidates: parsed(row.candidates_json, "route_decisions.candidates_json"),
      selected_route_id: text(row, "selected_route_id"), lexicographic_evidence: parsed(row.lexicographic_evidence_json, "route_decisions.lexicographic_evidence_json"),
      created_event_sequence: integer(row, "created_event_sequence"),
    };
    const routeDecisionId = text(row, "route_decision_id");
    return { routeDecisionId, planId: core.plan_id, planHealthStatus: core.plan_health_status,
      correctionLevel: core.correction_level, triggerSha256: core.trigger_sha256, candidates: core.candidates,
      selectedRouteId: core.selected_route_id, lexicographicEvidence: core.lexicographic_evidence,
      createdEventSequence: core.created_event_sequence, ref: protectedRef(routeDecisionId, core) };
  }

  private observations(goalId: string): ObservationRecoveryMaterial[] {
    const rows = this.connection.prepare(`SELECT r.subject_id,r.output_sha256,r.body_json,r.issued_event_sequence,
      ra.role,${artifactColumns} FROM receipts r JOIN receipt_artifacts ra ON ra.receipt_id=r.receipt_id
      JOIN artifacts a ON a.artifact_id=ra.artifact_id WHERE r.goal_id=? AND r.receipt_type='VALIDATION'
      ORDER BY r.issued_event_sequence,r.receipt_id`).all(goalId) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const body = parsed(row.body_json, "observation receipt body");
      if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
      const value = body as Record<string, unknown>;
      const observationType = value.observationType;
      if (observationType !== "PROMPT_GENERATION" && observationType !== "PROMPT_REQUEST"
        && observationType !== "OUTPUT_OBSERVATION" && observationType !== "TOOL_RESULT_PROJECTION") return [];
      const record = artifact(row);
      const observationId = text(row, "subject_id");
      if (value.observationId !== observationId || value.artifactId !== record.artifactId
        || text(row, "role") !== observationType || nullableText(row, "output_sha256") !== record.sha256) {
        throw new AuthorityIntegrityError(`Observation receipt binding failed at ${observationId}`);
      }
      return [{ observationId, observationType, issuedEventSequence: integer(row, "issued_event_sequence"),
        artifact: record, ref: { id: observationId, sha256: record.sha256 } }];
    });
  }

  private latestEvent(goalId: string, eventType: string): TransitionRecoveryMaterial | null {
    const row = this.connection.prepare(`SELECT event_id,event_type,event_sha256,sequence,payload_json FROM events
      WHERE goal_id=? AND event_type=? ORDER BY sequence DESC LIMIT 1`).get(goalId, eventType) as Record<string, unknown> | undefined;
    return transition(row);
  }

  private latestTransition(goalId: string): TransitionRecoveryMaterial | null {
    const row = this.connection.prepare(`SELECT event_id,event_type,event_sha256,sequence,payload_json FROM events
      WHERE goal_id=? AND event_type IN ('GOAL_TRANSITIONED','STAGE_AUTHORIZED','STAGE_TRANSITIONED','BUILD_STARTED','DEPENDENCY_INVALIDATED')
      ORDER BY sequence DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    return transition(row);
  }
}
