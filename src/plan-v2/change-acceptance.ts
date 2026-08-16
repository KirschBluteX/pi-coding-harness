import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { DecisionClosureBundleV2, DecisionClosureStateV2 } from "../intake-v2/domain.js";
import { assertDecisionClosureV2 } from "../intake-v2/finalize.js";
import { derivePlanChangeImpactV2, type PlanChangeImpactV2 } from "./change-impact.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanGraphV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";
import { derivePlanRevisionDeltaV2, type PlanRevisionDeltaV2 } from "./revision-delta.js";

export interface ChangeInvalidationMemberV2 {
  readonly schema_version: 2;
  readonly invalidation_member_id: string;
  readonly subject: PlanSubjectRefV2;
  readonly local: boolean;
  readonly upstream: boolean;
  readonly structural: boolean;
  readonly record_sha256: string;
}

export interface ChangeInvalidationClosureV2 {
  readonly schema_version: 2;
  readonly invalidation_closure_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly successor_plan_revision_id: string;
  readonly successor_plan_revision_sha256: string;
  readonly revision_delta: PlanRevisionDeltaV2;
  readonly request_impact_root_sha256: string;
  readonly local_root_sha256: string;
  readonly upstream_root_sha256: string;
  readonly structural_root_sha256: string;
  readonly invalidation_root_sha256: string;
  readonly reuse_root_sha256: string;
  readonly members: readonly ChangeInvalidationMemberV2[];
  readonly reusable_subjects: readonly PlanSubjectRefV2[];
  readonly record_sha256: string;
}

export interface DecisionPlanBindingMemberV2 {
  readonly schema_version: 2;
  readonly decision_plan_binding_member_id: string;
  readonly decision_requirement_revision_id: string;
  readonly decision_requirement_id: string;
  readonly decision_requirement_sha256: string;
  readonly decision_state: DecisionClosureStateV2;
  readonly decision_resolution_id: string;
  readonly decision_resolution_sha256: string;
  readonly target_work_cells: readonly PlanSubjectRefV2[];
  readonly target_root_sha256: string;
  readonly target_count: number;
  readonly record_sha256: string;
}

export interface DecisionPlanBindingV2 {
  readonly schema_version: 2;
  readonly decision_plan_binding_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly decision_closure_sha256: string;
  readonly member_root_sha256: string;
  readonly member_count: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface DecisionPlanBindingBundleV2 {
  readonly binding: DecisionPlanBindingV2;
  readonly members: readonly DecisionPlanBindingMemberV2[];
}

export interface DecisionPlanBindingDecisionV2 {
  readonly decision_requirement_revision_id: string;
  readonly decision_requirement_id: string;
  readonly record_sha256: string;
  readonly affected_work_cell_ids: readonly string[];
}

export interface DecisionPlanBindingResolutionV2 {
  readonly decision_resolution_id: string;
  readonly record_sha256: string;
}

export type ChangeAcceptanceSemanticEntityKindV2 = "ACCEPTANCE_FACET" | "REQUIREMENT";
export type ChangeAcceptanceSemanticDeltaKindV2 = "ADD" | "MODIFY" | "REMOVE";

export interface ChangeAcceptanceSemanticRecordV2 {
  readonly entity_kind: ChangeAcceptanceSemanticEntityKindV2;
  readonly semantic_key: string;
  readonly entity_id: string;
  readonly record_sha256: string;
}

export interface ChangeAcceptanceRequestMemberV2 {
  readonly schema_version: 2;
  readonly request_member_id: string;
  readonly binding_id: string;
  readonly binding_sha256: string;
  readonly change_request_id: string;
  readonly change_request_sha256: string;
  readonly impact_sha256: string;
  readonly record_sha256: string;
}

export interface ChangeAcceptanceSemanticDeltaV2 {
  readonly schema_version: 2;
  readonly semantic_delta_id: string;
  readonly entity_kind: ChangeAcceptanceSemanticEntityKindV2;
  readonly semantic_key: string;
  readonly change_kind: ChangeAcceptanceSemanticDeltaKindV2;
  readonly previous_entity_id: string | null;
  readonly previous_entity_sha256: string | null;
  readonly successor_entity_id: string | null;
  readonly successor_entity_sha256: string | null;
  readonly record_sha256: string;
}

export interface ChangeAcceptanceOracleBindingV2 {
  readonly schema_version: 2;
  readonly oracle_binding_id: string;
  readonly work_cell: PlanSubjectRefV2;
  readonly oracle_sha256: string;
  readonly record_sha256: string;
}

export interface ChangeAcceptanceClosureV2 {
  readonly schema_version: 2;
  readonly change_acceptance_closure_id: string;
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly successor_plan_revision_id: string;
  readonly successor_plan_revision_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly decision_closure_sha256: string;
  readonly decision_plan_binding_id: string;
  readonly decision_plan_binding_root_sha256: string;
  readonly request_root_sha256: string;
  readonly request_count: number;
  readonly semantic_delta_root_sha256: string;
  readonly semantic_delta_count: number;
  readonly invalidation_closure_id: string;
  readonly invalidation_closure_sha256: string;
  readonly invalidation_root_sha256: string;
  readonly invalidation_count: number;
  readonly reuse_root_sha256: string;
  readonly reuse_count: number;
  readonly oracle_evidence_root_sha256: string;
  readonly oracle_count: number;
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ChangeAcceptanceClosureBundleV2 {
  readonly closure: ChangeAcceptanceClosureV2;
  readonly request_members: readonly ChangeAcceptanceRequestMemberV2[];
  readonly semantic_deltas: readonly ChangeAcceptanceSemanticDeltaV2[];
  readonly invalidation: ChangeInvalidationClosureV2;
  readonly oracle_bindings: readonly ChangeAcceptanceOracleBindingV2[];
}

export interface ChangeAcceptanceMaterialRequestV2 {
  readonly binding_id: string;
  readonly binding_sha256: string;
  readonly change_request_id: string;
  readonly change_request_sha256: string;
  readonly impact: PlanChangeImpactV2;
  readonly impact_authority_id?: string;
  readonly impact_authority_sha256?: string;
}

const shaPattern = /^[a-f0-9]{64}$/u;

function boundedId(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new TypeError(`${label} must contain 1..160 characters`);
  }
  return value;
}

function sha(value: string, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function subjectRoot(domain: string, subjects: readonly PlanSubjectRefV2[]): string {
  return canonicalJsonSha256({ domain, members: [...subjects].sort(comparePlanSubjectsV2) });
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}..${maximum} entries`);
  }
}

function boundedText(value: string, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} must contain 1..${maximum} characters`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function reachableWorkCells(
  source: PlanSubjectRefV2,
  graph: ReturnType<typeof validatePlanGraphV2>,
): readonly PlanSubjectRefV2[] {
  const visited = new Set<string>([planSubjectKeyV2(source)]);
  const queue = [...visited];
  const targets = new Map<string, PlanSubjectRefV2>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const next of graph.adjacency.get(queue[cursor]!) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
      const subject = graph.subjects_by_key.get(next);
      if (subject?.kind === "WORK_CELL") targets.set(next, subject);
    }
  }
  return [...targets.values()].sort(comparePlanSubjectsV2);
}

export function finalizeDecisionPlanBindingV2(input: {
  readonly plan: {
    readonly plan_revision_id: string;
    readonly record_sha256: string;
    readonly requirement_revision_id: string;
    readonly requirement_revision_sha256: string;
    readonly goal_id: string;
    readonly contract_id: string;
    readonly authority_root_id: string;
  };
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
  readonly decision_closure: DecisionClosureBundleV2;
  readonly decisions: readonly DecisionPlanBindingDecisionV2[];
  readonly resolutions: readonly DecisionPlanBindingResolutionV2[];
  readonly created_at_ms: number;
}): DecisionPlanBindingBundleV2 {
  boundedArray(input.decisions, "Decision Plan binding Decisions", 1, 1_024);
  boundedArray(input.decision_closure.members, "Decision Plan binding closure members", 1, 1_024);
  boundedArray(input.resolutions, "Decision Plan binding resolutions", 1, 1_024);
  assertDecisionClosureV2(input.decision_closure);
  const graph = validatePlanGraphV2(input.subjects, input.edges);
  const planRevisionId = boundedId(input.plan.plan_revision_id, "Decision Plan binding Plan revision ID");
  const planRevisionSha256 = sha(input.plan.record_sha256, "Decision Plan binding Plan revision");
  const requirementRevisionId = boundedId(
    input.plan.requirement_revision_id,
    "Decision Plan binding Requirement revision ID",
  );
  const requirementRevisionSha256 = sha(
    input.plan.requirement_revision_sha256,
    "Decision Plan binding Requirement revision",
  );
  const goalId = boundedId(input.plan.goal_id, "Decision Plan binding Goal ID");
  const contractId = boundedId(input.plan.contract_id, "Decision Plan binding contract ID");
  const authorityRootId = boundedId(input.plan.authority_root_id, "Decision Plan binding authority root ID");
  const closure = input.decision_closure.closure;
  if (closure.gate !== "MATERIAL_CHANGE" || !closure.qualified
    || closure.requirement_revision_id !== requirementRevisionId
    || closure.goal_id !== goalId
    || closure.contract_id !== contractId
    || closure.authority_root_id !== authorityRootId) {
    throw new TypeError("Decision Plan binding requires the exact qualified MATERIAL_CHANGE Decision closure");
  }
  const decisionSubjects = graph.subjects.filter((subject) => subject.kind === "DECISION");
  const decisionById = new Map(input.decisions.map((decision) => [
    boundedId(decision.decision_requirement_id, "Decision Plan binding Decision ID"),
    decision,
  ]));
  const closureMemberById = new Map(input.decision_closure.members.map((member) => [
    member.decision_requirement_id,
    member,
  ]));
  if (decisionById.size !== input.decisions.length
    || closureMemberById.size !== input.decision_closure.members.length
    || decisionSubjects.length !== decisionById.size
    || decisionSubjects.length !== closureMemberById.size) {
    throw new TypeError("Decision Plan binding does not cover the complete Decision frontier");
  }
  const resolutionById = new Map(input.resolutions.map((resolution) => [
    boundedId(resolution.decision_resolution_id, "Decision Plan binding resolution ID"),
    sha(resolution.record_sha256, "Decision Plan binding resolution"),
  ]));
  if (resolutionById.size !== input.resolutions.length) {
    throw new TypeError("Decision Plan binding repeats an effective resolution");
  }
  const effectiveResolutionIds = input.decision_closure.members.map((member) => member.decision_resolution_id);
  if (effectiveResolutionIds.some((resolutionId) => resolutionId === null)
    || new Set(effectiveResolutionIds).size !== resolutionById.size
    || [...resolutionById.keys()].some((resolutionId) => !effectiveResolutionIds.includes(resolutionId))) {
    throw new TypeError("Decision Plan binding resolutions do not match the complete effective resolution frontier");
  }
  const workCellsById = new Map(graph.subjects.filter((subject) => subject.kind === "WORK_CELL")
    .map((subject) => [subject.id, subject]));
  const members = decisionSubjects.map((decisionSubject): DecisionPlanBindingMemberV2 => {
    const decision = decisionById.get(decisionSubject.id);
    const closureMember = closureMemberById.get(decisionSubject.id);
    if (!decision || !closureMember
      || decision.record_sha256 !== decisionSubject.revision_sha256
      || decision.decision_requirement_revision_id !== closureMember.decision_requirement_revision_id) {
      throw new TypeError("Decision Plan binding does not cover the complete Decision frontier");
    }
    if (closureMember.decision_resolution_id === null) {
      throw new TypeError(`Decision ${decisionSubject.id} lacks an effective resolution`);
    }
    const resolutionSha256 = resolutionById.get(closureMember.decision_resolution_id);
    if (!resolutionSha256) {
      throw new TypeError(`Decision ${decisionSubject.id} lacks its effective resolution`);
    }
    const authorizes = graph.edges.some((edge) => edge.source.kind === "DECISION"
      && edge.source.id === decisionSubject.id
      && edge.dependency_kind === "AUTHORIZES");
    if (closureMember.state !== "APPROVED" && authorizes) {
      throw new TypeError(`Decision ${decisionSubject.id} is non-approved but still has an AUTHORIZES edge`);
    }
    boundedArray(decision.affected_work_cell_ids, `Decision ${decisionSubject.id} affected WorkCells`, 0, 8_192);
    if (new Set(decision.affected_work_cell_ids).size !== decision.affected_work_cell_ids.length) {
      throw new TypeError(`Decision ${decisionSubject.id} repeats an affected WorkCell`);
    }
    const targetWorkCells = decision.affected_work_cell_ids.length > 0
      ? decision.affected_work_cell_ids.map((workCellId) => {
          const workCell = workCellsById.get(workCellId);
          if (!workCell) throw new TypeError(`Decision ${decisionSubject.id} names a stale WorkCell ${workCellId}`);
          return workCell;
        }).sort(comparePlanSubjectsV2)
      : reachableWorkCells(decisionSubject, graph);
    if (targetWorkCells.length === 0) {
      throw new TypeError(`Decision ${decisionSubject.id} has no reachable current WorkCell`);
    }
    const targetRootSha256 = subjectRoot("PCH-DECISION-PLAN-TARGET-ROOT-V2", targetWorkCells);
    const body = {
      schema_version: 2 as const,
      decision_plan_binding_member_id: idFromSha256("DECISION_PLAN_MEMBER", canonicalJsonSha256({
        plan_revision_sha256: planRevisionSha256,
        decision_requirement_sha256: decisionSubject.revision_sha256,
        decision_resolution_sha256: resolutionSha256,
        target_root_sha256: targetRootSha256,
      })),
      decision_requirement_revision_id: decision.decision_requirement_revision_id,
      decision_requirement_id: decision.decision_requirement_id,
      decision_requirement_sha256: decision.record_sha256,
      decision_state: closureMember.state,
      decision_resolution_id: closureMember.decision_resolution_id,
      decision_resolution_sha256: resolutionSha256,
      target_work_cells: targetWorkCells,
      target_root_sha256: targetRootSha256,
      target_count: targetWorkCells.length,
    };
    return {
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-DECISION-PLAN-BINDING-MEMBER-V2", ...body }),
    };
  }).sort((left, right) => compareText(left.decision_requirement_id, right.decision_requirement_id));
  const memberRootSha256 = canonicalJsonSha256({
    domain: "PCH-DECISION-PLAN-BINDING-MEMBER-ROOT-V2",
    members: members.map((member) => member.record_sha256),
  });
  const createdAtMs = timestamp(input.created_at_ms, "Decision Plan binding timestamp");
  const body = {
    schema_version: 2 as const,
    decision_plan_binding_id: idFromSha256("DECISION_PLAN_BINDING", canonicalJsonSha256({
      plan_revision_sha256: planRevisionSha256,
      decision_closure_sha256: closure.record_sha256,
      member_root_sha256: memberRootSha256,
    })),
    plan_revision_id: planRevisionId,
    plan_revision_sha256: planRevisionSha256,
    requirement_revision_id: requirementRevisionId,
    requirement_revision_sha256: requirementRevisionSha256,
    goal_id: goalId,
    contract_id: contractId,
    authority_root_id: authorityRootId,
    decision_closure_id: closure.decision_closure_id,
    decision_closure_sha256: sha(closure.record_sha256, "Decision Plan binding Decision closure"),
    member_root_sha256: memberRootSha256,
    member_count: members.length,
    created_at_ms: createdAtMs,
  };
  return {
    binding: {
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-DECISION-PLAN-BINDING-V2", ...body }),
    },
    members,
  };
}

function deriveImpact(
  planRevisionId: string,
  planRevisionSha256: string,
  changedSubjects: readonly PlanSubjectRefV2[],
  subjects: readonly PlanSubjectRefV2[],
  edges: readonly PlanDependencyEdgeV2[],
): PlanChangeImpactV2 {
  return derivePlanChangeImpactV2({
    plan_revision_id: planRevisionId,
    plan_revision_sha256: planRevisionSha256,
    changed_subjects: changedSubjects,
    subjects,
    edges,
  });
}

export function deriveChangeInvalidationClosureV2(input: {
  readonly base_plan_revision_id: string;
  readonly base_plan_revision_sha256: string;
  readonly successor_plan_revision_id: string;
  readonly successor_plan_revision_sha256: string;
  readonly base_subjects: readonly PlanSubjectRefV2[];
  readonly base_edges: readonly PlanDependencyEdgeV2[];
  readonly successor_subjects: readonly PlanSubjectRefV2[];
  readonly successor_edges: readonly PlanDependencyEdgeV2[];
  readonly request_impacts: readonly PlanChangeImpactV2[];
}): ChangeInvalidationClosureV2 {
  const basePlanRevisionId = boundedId(input.base_plan_revision_id, "Base Plan revision ID");
  const basePlanRevisionSha256 = sha(input.base_plan_revision_sha256, "Base Plan revision");
  const successorPlanRevisionId = boundedId(input.successor_plan_revision_id, "Successor Plan revision ID");
  const successorPlanRevisionSha256 = sha(input.successor_plan_revision_sha256, "Successor Plan revision");
  if (basePlanRevisionId === successorPlanRevisionId) {
    throw new TypeError("Change invalidation requires distinct Plan revisions");
  }
  if (input.request_impacts.length < 1 || input.request_impacts.length > 1_024) {
    throw new TypeError("Change invalidation requires 1..1024 material request impacts");
  }
  const base = validatePlanGraphV2(input.base_subjects, input.base_edges);
  const successor = validatePlanGraphV2(input.successor_subjects, input.successor_edges);
  const revisionDelta = derivePlanRevisionDeltaV2({
    previous_plan_revision_id: basePlanRevisionId,
    previous_plan_revision_sha256: basePlanRevisionSha256,
    current_plan_revision_id: successorPlanRevisionId,
    current_plan_revision_sha256: successorPlanRevisionSha256,
    previous_subjects: base.subjects,
    previous_edges: base.edges,
    current_subjects: successor.subjects,
    current_edges: successor.edges,
  });
  const deltaInvalidated = new Set(revisionDelta.impact.invalidated_subjects.map(planSubjectKeyV2));
  const verifiedImpacts = input.request_impacts.map((candidate, index) => {
    if (candidate.plan_revision_id !== basePlanRevisionId
      || candidate.plan_revision_sha256 !== basePlanRevisionSha256) {
      throw new TypeError(`Material request impact ${index} belongs to another base Plan`);
    }
    const expected = deriveImpact(
      basePlanRevisionId,
      basePlanRevisionSha256,
      candidate.changed_subjects,
      base.subjects,
      base.edges,
    );
    if (expected.record_sha256 !== candidate.record_sha256) {
      throw new TypeError(`Material request impact ${index} is not Host-derived`);
    }
    if (!expected.invalidated_subjects.some((subject) => deltaInvalidated.has(planSubjectKeyV2(subject)))) {
      throw new TypeError(`Material request impact ${index} has no material successor delta`);
    }
    return expected;
  });
  const requestCovered = new Set(verifiedImpacts
    .flatMap((impact) => impact.invalidated_subjects.map(planSubjectKeyV2)));
  if (revisionDelta.impact.invalidated_subjects.some((subject) => !requestCovered.has(planSubjectKeyV2(subject)))) {
    throw new TypeError("Material requests do not cover the complete successor delta");
  }

  const local = new Set(verifiedImpacts.flatMap((impact) => impact.invalidated_subjects.map(planSubjectKeyV2)));
  const upstreamSeeds = [
    ...revisionDelta.removed_subjects,
    ...revisionDelta.modified_subjects.map((entry) => entry.before),
  ].filter((subject) => subject.kind === "REQUIREMENT" || subject.kind === "DECISION");
  const upstreamImpact = deriveImpact(
    basePlanRevisionId,
    basePlanRevisionSha256,
    upstreamSeeds,
    base.subjects,
    base.edges,
  );
  const upstream = new Set(upstreamImpact.invalidated_subjects.map(planSubjectKeyV2));
  const structuralImpact = deriveImpact(
    basePlanRevisionId,
    basePlanRevisionSha256,
    revisionDelta.structurally_changed_subjects,
    base.subjects,
    base.edges,
  );
  const structural = new Set(structuralImpact.invalidated_subjects.map(planSubjectKeyV2));
  const invalidatedKeys = new Set([...local, ...upstream, ...structural]);
  const invalidatedSubjects = base.subjects.filter((subject) => invalidatedKeys.has(planSubjectKeyV2(subject)));
  const members = invalidatedSubjects.map((subject): ChangeInvalidationMemberV2 => {
    const flags = {
      subject,
      local: local.has(planSubjectKeyV2(subject)),
      upstream: upstream.has(planSubjectKeyV2(subject)),
      structural: structural.has(planSubjectKeyV2(subject)),
    };
    const recordSha256 = canonicalJsonSha256({ domain: "PCH-CHANGE-INVALIDATION-MEMBER-V2", ...flags });
    return {
      schema_version: 2,
      invalidation_member_id: idFromSha256("CHANGE_INVALIDATION_MEMBER", recordSha256),
      ...flags,
      record_sha256: recordSha256,
    };
  });
  const successorByKey = successor.subjects_by_key;
  const reusableSubjects = base.subjects.filter((subject) => {
    if (invalidatedKeys.has(planSubjectKeyV2(subject))) return false;
    return successorByKey.get(planSubjectKeyV2(subject))?.revision_sha256 === subject.revision_sha256;
  });
  const requestImpactRootSha256 = canonicalJsonSha256({
    domain: "PCH-CHANGE-REQUEST-IMPACT-ROOT-V2",
    members: verifiedImpacts.map((impact) => impact.record_sha256).sort(),
  });
  const localRootSha256 = subjectRoot(
    "PCH-CHANGE-LOCAL-INVALIDATION-ROOT-V2",
    base.subjects.filter((subject) => local.has(planSubjectKeyV2(subject))),
  );
  const upstreamRootSha256 = subjectRoot(
    "PCH-CHANGE-UPSTREAM-INVALIDATION-ROOT-V2",
    base.subjects.filter((subject) => upstream.has(planSubjectKeyV2(subject))),
  );
  const structuralRootSha256 = subjectRoot(
    "PCH-CHANGE-STRUCTURAL-INVALIDATION-ROOT-V2",
    base.subjects.filter((subject) => structural.has(planSubjectKeyV2(subject))),
  );
  const invalidationRootSha256 = subjectRoot("PCH-CHANGE-INVALIDATION-ROOT-V2", invalidatedSubjects);
  const reuseRootSha256 = subjectRoot("PCH-CHANGE-REUSE-ROOT-V2", reusableSubjects);
  const body = {
    schema_version: 2 as const,
    invalidation_closure_id: idFromSha256("CHANGE_INVALIDATION", canonicalJsonSha256({
      base_plan_revision_sha256: basePlanRevisionSha256,
      successor_plan_revision_sha256: successorPlanRevisionSha256,
      request_impact_root_sha256: requestImpactRootSha256,
      revision_delta_sha256: revisionDelta.record_sha256,
    })),
    base_plan_revision_id: basePlanRevisionId,
    base_plan_revision_sha256: basePlanRevisionSha256,
    successor_plan_revision_id: successorPlanRevisionId,
    successor_plan_revision_sha256: successorPlanRevisionSha256,
    revision_delta: revisionDelta,
    request_impact_root_sha256: requestImpactRootSha256,
    local_root_sha256: localRootSha256,
    upstream_root_sha256: upstreamRootSha256,
    structural_root_sha256: structuralRootSha256,
    invalidation_root_sha256: invalidationRootSha256,
    reuse_root_sha256: reuseRootSha256,
    members,
    reusable_subjects: reusableSubjects,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-CHANGE-INVALIDATION-CLOSURE-V2", ...body }),
  };
}

function assertDecisionPlanBindingBundleV2(
  bundle: DecisionPlanBindingBundleV2,
  successorSubjects: readonly PlanSubjectRefV2[],
  successorEdges: readonly PlanDependencyEdgeV2[],
): DecisionPlanBindingBundleV2 {
  const graph = validatePlanGraphV2(successorSubjects, successorEdges);
  const binding = bundle.binding;
  boundedArray(bundle.members, "Decision Plan binding members", 1, 1_024);
  const decisionSubjects = new Map(graph.subjects
    .filter((subject) => subject.kind === "DECISION")
    .map((subject) => [subject.id, subject]));
  const workCells = graph.subjects_by_key;
  const seenDecisions = new Set<string>();
  const decisionStates = new Set<DecisionClosureStateV2>([
    "APPROVED", "REJECTED", "EDITED", "DEFERRED", "DUE_DEFERRED", "UNRESOLVED",
  ]);
  const members = bundle.members.map((member, index): DecisionPlanBindingMemberV2 => {
    const decisionId = boundedId(member.decision_requirement_id, `Decision Plan binding member ${index} Decision ID`);
    if (seenDecisions.has(decisionId)) throw new TypeError(`Decision Plan binding repeats Decision ${decisionId}`);
    seenDecisions.add(decisionId);
    const decision = decisionSubjects.get(decisionId);
    const decisionSha256 = sha(member.decision_requirement_sha256, `Decision Plan binding member ${index} Decision`);
    if (!decision || decision.revision_sha256 !== decisionSha256) {
      throw new TypeError(`Decision Plan binding member ${index} is outside the successor Plan`);
    }
    if (!decisionStates.has(member.decision_state)) {
      throw new TypeError(`Decision Plan binding member ${index} state is invalid`);
    }
    boundedArray(member.target_work_cells, `Decision Plan binding member ${index} targets`, 1, 8_192);
    const seenTargets = new Set<string>();
    const targets = member.target_work_cells.map((target, targetIndex) => {
      const key = planSubjectKeyV2(target);
      const stored = workCells.get(key);
      if (target.kind !== "WORK_CELL" || !stored || stored.revision_sha256 !== target.revision_sha256) {
        throw new TypeError(`Decision Plan binding member ${index} target ${targetIndex} is not a current WorkCell`);
      }
      if (seenTargets.has(key)) throw new TypeError(`Decision Plan binding member ${index} repeats WorkCell ${target.id}`);
      seenTargets.add(key);
      return stored;
    }).sort(comparePlanSubjectsV2);
    const targetRootSha256 = subjectRoot("PCH-DECISION-PLAN-TARGET-ROOT-V2", targets);
    if (member.target_count !== targets.length || member.target_root_sha256 !== targetRootSha256) {
      throw new TypeError(`Decision Plan binding member ${index} target closure is invalid`);
    }
    const authorizes = graph.edges.some((edge) => edge.source.id === decisionId
      && edge.source.kind === "DECISION" && edge.dependency_kind === "AUTHORIZES");
    if (member.decision_state !== "APPROVED" && authorizes) {
      throw new TypeError(`Decision ${decisionId} is non-approved but still has an AUTHORIZES edge`);
    }
    const body = {
      schema_version: 2 as const,
      decision_plan_binding_member_id: idFromSha256("DECISION_PLAN_MEMBER", canonicalJsonSha256({
        plan_revision_sha256: binding.plan_revision_sha256,
        decision_requirement_sha256: decisionSha256,
        decision_resolution_sha256: sha(
          member.decision_resolution_sha256,
          `Decision Plan binding member ${index} resolution`,
        ),
        target_root_sha256: targetRootSha256,
      })),
      decision_requirement_revision_id: boundedId(
        member.decision_requirement_revision_id,
        `Decision Plan binding member ${index} Decision revision ID`,
      ),
      decision_requirement_id: decisionId,
      decision_requirement_sha256: decisionSha256,
      decision_state: member.decision_state,
      decision_resolution_id: boundedId(
        member.decision_resolution_id,
        `Decision Plan binding member ${index} resolution ID`,
      ),
      decision_resolution_sha256: member.decision_resolution_sha256,
      target_work_cells: targets,
      target_root_sha256: targetRootSha256,
      target_count: targets.length,
    };
    const recordSha256 = canonicalJsonSha256({ domain: "PCH-DECISION-PLAN-BINDING-MEMBER-V2", ...body });
    if (member.decision_plan_binding_member_id !== body.decision_plan_binding_member_id
      || member.record_sha256 !== recordSha256) {
      throw new TypeError(`Decision Plan binding member ${index} is not Host-derived`);
    }
    return { ...body, record_sha256: recordSha256 };
  }).sort((left, right) => compareText(left.decision_requirement_id, right.decision_requirement_id));
  if (members.length !== decisionSubjects.size) {
    throw new TypeError("Decision Plan binding does not cover the complete Decision frontier");
  }
  const memberRootSha256 = canonicalJsonSha256({
    domain: "PCH-DECISION-PLAN-BINDING-MEMBER-ROOT-V2",
    members: members.map((member) => member.record_sha256),
  });
  const body = {
    schema_version: 2 as const,
    decision_plan_binding_id: idFromSha256("DECISION_PLAN_BINDING", canonicalJsonSha256({
      plan_revision_sha256: sha(binding.plan_revision_sha256, "Decision Plan binding Plan revision"),
      decision_closure_sha256: sha(binding.decision_closure_sha256, "Decision Plan binding Decision closure"),
      member_root_sha256: memberRootSha256,
    })),
    plan_revision_id: boundedId(binding.plan_revision_id, "Decision Plan binding Plan revision ID"),
    plan_revision_sha256: binding.plan_revision_sha256,
    requirement_revision_id: boundedId(binding.requirement_revision_id, "Decision Plan binding Requirement revision ID"),
    requirement_revision_sha256: sha(
      binding.requirement_revision_sha256,
      "Decision Plan binding Requirement revision",
    ),
    goal_id: boundedId(binding.goal_id, "Decision Plan binding Goal ID"),
    contract_id: boundedId(binding.contract_id, "Decision Plan binding contract ID"),
    authority_root_id: boundedId(binding.authority_root_id, "Decision Plan binding authority root ID"),
    decision_closure_id: boundedId(binding.decision_closure_id, "Decision Plan binding Decision closure ID"),
    decision_closure_sha256: binding.decision_closure_sha256,
    member_root_sha256: memberRootSha256,
    member_count: members.length,
    created_at_ms: timestamp(binding.created_at_ms, "Decision Plan binding timestamp"),
  };
  const recordSha256 = canonicalJsonSha256({ domain: "PCH-DECISION-PLAN-BINDING-V2", ...body });
  if (binding.member_count !== members.length || binding.member_root_sha256 !== memberRootSha256
    || binding.decision_plan_binding_id !== body.decision_plan_binding_id
    || binding.record_sha256 !== recordSha256) {
    throw new TypeError("Decision Plan binding is not Host-derived");
  }
  return { binding: { ...body, record_sha256: recordSha256 }, members };
}

function semanticRecordMap(
  records: readonly ChangeAcceptanceSemanticRecordV2[],
  label: string,
): ReadonlyMap<string, ChangeAcceptanceSemanticRecordV2> {
  boundedArray(records, label, 0, 8_192);
  const kinds = new Set<ChangeAcceptanceSemanticEntityKindV2>(["ACCEPTANCE_FACET", "REQUIREMENT"]);
  const result = new Map<string, ChangeAcceptanceSemanticRecordV2>();
  for (const [index, record] of records.entries()) {
    if (!kinds.has(record.entity_kind)) throw new TypeError(`${label} ${index} kind is invalid`);
    const semanticKey = boundedText(record.semantic_key, `${label} ${index} semantic key`);
    const key = `${record.entity_kind}\u0000${semanticKey.normalize("NFC")}`;
    if (result.has(key)) throw new TypeError(`${label} repeats semantic key ${semanticKey}`);
    result.set(key, {
      entity_kind: record.entity_kind,
      semantic_key: semanticKey,
      entity_id: boundedId(record.entity_id, `${label} ${index} entity ID`),
      record_sha256: sha(record.record_sha256, `${label} ${index} entity`),
    });
  }
  return result;
}

function deriveSemanticDeltas(
  baseRecords: readonly ChangeAcceptanceSemanticRecordV2[],
  successorRecords: readonly ChangeAcceptanceSemanticRecordV2[],
): readonly ChangeAcceptanceSemanticDeltaV2[] {
  const base = semanticRecordMap(baseRecords, "Base semantic records");
  const successor = semanticRecordMap(successorRecords, "Successor semantic records");
  return [...new Set([...base.keys(), ...successor.keys()])].sort(compareText).flatMap((key) => {
    const previous = base.get(key);
    const current = successor.get(key);
    if (previous && current && previous.entity_id === current.entity_id
      && previous.record_sha256 === current.record_sha256) return [];
    const changeKind: ChangeAcceptanceSemanticDeltaKindV2 = !previous ? "ADD" : !current ? "REMOVE" : "MODIFY";
    const body = {
      schema_version: 2 as const,
      semantic_delta_id: idFromSha256("CHANGE_SEMANTIC_DELTA", canonicalJsonSha256({
        entity_kind: (current ?? previous)!.entity_kind,
        semantic_key: (current ?? previous)!.semantic_key,
        change_kind: changeKind,
        previous_entity_sha256: previous?.record_sha256 ?? null,
        successor_entity_sha256: current?.record_sha256 ?? null,
      })),
      entity_kind: (current ?? previous)!.entity_kind,
      semantic_key: (current ?? previous)!.semantic_key,
      change_kind: changeKind,
      previous_entity_id: previous?.entity_id ?? null,
      previous_entity_sha256: previous?.record_sha256 ?? null,
      successor_entity_id: current?.entity_id ?? null,
      successor_entity_sha256: current?.record_sha256 ?? null,
    };
    return [{
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-CHANGE-SEMANTIC-DELTA-V2", ...body }),
    }];
  });
}

function assertRequirementSemanticClosure(
  records: readonly ChangeAcceptanceSemanticRecordV2[],
  subjects: readonly PlanSubjectRefV2[],
  label: string,
): void {
  const expected = new Map(subjects.filter((subject) => subject.kind === "REQUIREMENT")
    .map((subject) => [subject.id, subject.revision_sha256]));
  const actual = records.filter((record) => record.entity_kind === "REQUIREMENT");
  if (actual.length !== expected.size || new Set(actual.map((record) => record.entity_id)).size !== actual.length
    || actual.some((record) => expected.get(record.entity_id) !== record.record_sha256)) {
    throw new TypeError(`${label} does not exactly cover its Plan Requirement subjects`);
  }
}

export function finalizeChangeAcceptanceClosureV2(input: {
  readonly base_plan: {
    readonly plan_revision_id: string;
    readonly record_sha256: string;
    readonly subjects: readonly PlanSubjectRefV2[];
    readonly edges: readonly PlanDependencyEdgeV2[];
  };
  readonly successor_plan: {
    readonly plan_revision_id: string;
    readonly record_sha256: string;
    readonly parent_plan_revision_id: string;
    readonly parent_plan_revision_sha256: string;
    readonly requirement_revision_id: string;
    readonly requirement_revision_sha256: string;
    readonly goal_id: string;
    readonly contract_id: string;
    readonly authority_root_id: string;
    readonly subjects: readonly PlanSubjectRefV2[];
    readonly edges: readonly PlanDependencyEdgeV2[];
  };
  readonly decision_plan_binding: DecisionPlanBindingBundleV2;
  readonly material_requests: readonly ChangeAcceptanceMaterialRequestV2[];
  readonly base_semantic_records: readonly ChangeAcceptanceSemanticRecordV2[];
  readonly successor_semantic_records: readonly ChangeAcceptanceSemanticRecordV2[];
  readonly oracle_bindings: readonly {
    readonly work_cell: PlanSubjectRefV2;
    readonly oracle_sha256: string;
  }[];
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
}): ChangeAcceptanceClosureBundleV2 {
  const basePlanRevisionId = boundedId(input.base_plan.plan_revision_id, "Change acceptance base Plan revision ID");
  const basePlanRevisionSha256 = sha(input.base_plan.record_sha256, "Change acceptance base Plan revision");
  const successorPlanRevisionId = boundedId(
    input.successor_plan.plan_revision_id,
    "Change acceptance successor Plan revision ID",
  );
  const successorPlanRevisionSha256 = sha(
    input.successor_plan.record_sha256,
    "Change acceptance successor Plan revision",
  );
  if (successorPlanRevisionId === basePlanRevisionId
    || input.successor_plan.parent_plan_revision_id !== basePlanRevisionId
    || input.successor_plan.parent_plan_revision_sha256 !== basePlanRevisionSha256) {
    throw new TypeError("Change acceptance requires one direct successor Plan");
  }
  const baseGraph = validatePlanGraphV2(input.base_plan.subjects, input.base_plan.edges);
  const successorGraph = validatePlanGraphV2(input.successor_plan.subjects, input.successor_plan.edges);
  const decisionPlanBinding = assertDecisionPlanBindingBundleV2(
    input.decision_plan_binding,
    successorGraph.subjects,
    successorGraph.edges,
  );
  const binding = decisionPlanBinding.binding;
  const requirementRevisionId = boundedId(
    input.successor_plan.requirement_revision_id,
    "Change acceptance Requirement revision ID",
  );
  const requirementRevisionSha256 = sha(
    input.successor_plan.requirement_revision_sha256,
    "Change acceptance Requirement revision",
  );
  const goalId = boundedId(input.successor_plan.goal_id, "Change acceptance Goal ID");
  const contractId = boundedId(input.successor_plan.contract_id, "Change acceptance contract ID");
  const authorityRootId = boundedId(input.successor_plan.authority_root_id, "Change acceptance authority root ID");
  if (binding.plan_revision_id !== successorPlanRevisionId
    || binding.plan_revision_sha256 !== successorPlanRevisionSha256
    || binding.requirement_revision_id !== requirementRevisionId
    || binding.requirement_revision_sha256 !== requirementRevisionSha256
    || binding.goal_id !== goalId || binding.contract_id !== contractId
    || binding.authority_root_id !== authorityRootId) {
    throw new TypeError("Change acceptance Decision Plan binding belongs to another successor authority closure");
  }

  boundedArray(input.material_requests, "Change acceptance material requests", 1, 1_024);
  const seenBindings = new Set<string>();
  const seenBindingHashes = new Set<string>();
  const seenRequests = new Set<string>();
  const seenRequestHashes = new Set<string>();
  const materialRequests = input.material_requests.map((request, index) => {
    const bindingId = boundedId(request.binding_id, `Change acceptance request ${index} binding ID`);
    const changeRequestId = boundedId(request.change_request_id, `Change acceptance request ${index} Change Request ID`);
    const bindingSha256 = sha(request.binding_sha256, `Change acceptance request ${index} binding`);
    const changeRequestSha256 = sha(
      request.change_request_sha256,
      `Change acceptance request ${index} Change Request`,
    );
    if (seenBindings.has(bindingId) || seenBindingHashes.has(bindingSha256)
      || seenRequests.has(changeRequestId) || seenRequestHashes.has(changeRequestSha256)) {
      throw new TypeError("Change acceptance repeats a material request or binding");
    }
    seenBindings.add(bindingId);
    seenBindingHashes.add(bindingSha256);
    seenRequests.add(changeRequestId);
    seenRequestHashes.add(changeRequestSha256);
    return {
      binding_id: bindingId,
      binding_sha256: bindingSha256,
      change_request_id: changeRequestId,
      change_request_sha256: changeRequestSha256,
      impact: request.impact,
      impact_authority_id: request.impact_authority_id,
      impact_authority_sha256: request.impact_authority_sha256,
    };
  }).sort((left, right) => compareText(left.binding_id, right.binding_id));
  const invalidation = deriveChangeInvalidationClosureV2({
    base_plan_revision_id: basePlanRevisionId,
    base_plan_revision_sha256: basePlanRevisionSha256,
    successor_plan_revision_id: successorPlanRevisionId,
    successor_plan_revision_sha256: successorPlanRevisionSha256,
    base_subjects: baseGraph.subjects,
    base_edges: baseGraph.edges,
    successor_subjects: successorGraph.subjects,
    successor_edges: successorGraph.edges,
    request_impacts: materialRequests.map((request) => request.impact),
  });
  const requestMembers = materialRequests.map((request): ChangeAcceptanceRequestMemberV2 => {
    const body = {
      schema_version: 2 as const,
      request_member_id: idFromSha256("CHANGE_ACCEPTANCE_REQUEST", canonicalJsonSha256({
        binding_sha256: request.binding_sha256,
        change_request_sha256: request.change_request_sha256,
        impact_sha256: request.impact_authority_sha256 ?? request.impact.record_sha256,
      })),
      binding_id: request.binding_id,
      binding_sha256: request.binding_sha256,
      change_request_id: request.change_request_id,
      change_request_sha256: request.change_request_sha256,
      impact_sha256: request.impact_authority_sha256 ?? request.impact.record_sha256,
    };
    return {
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-CHANGE-ACCEPTANCE-REQUEST-MEMBER-V2", ...body }),
    };
  });

  const successorWorkCells = successorGraph.subjects.filter((subject) => subject.kind === "WORK_CELL");
  if (input.oracle_bindings.length !== successorWorkCells.length) {
    throw new TypeError("Change acceptance oracle bindings must cover the complete successor WorkCell set");
  }
  const successorWorkCellByKey = new Map(successorWorkCells.map((workCell) => [planSubjectKeyV2(workCell), workCell]));
  const seenOracleWorkCells = new Set<string>();
  const oracleBindings = input.oracle_bindings.map((candidate, index): ChangeAcceptanceOracleBindingV2 => {
    const key = planSubjectKeyV2(candidate.work_cell);
    const workCell = successorWorkCellByKey.get(key);
    if (!workCell || workCell.revision_sha256 !== candidate.work_cell.revision_sha256
      || seenOracleWorkCells.has(key)) {
      throw new TypeError("Change acceptance oracle bindings must cover the complete successor WorkCell set");
    }
    seenOracleWorkCells.add(key);
    const oracleSha256 = sha(candidate.oracle_sha256, `Change acceptance oracle binding ${index}`);
    const body = {
      schema_version: 2 as const,
      oracle_binding_id: idFromSha256("CHANGE_ACCEPTANCE_ORACLE", canonicalJsonSha256({
        successor_plan_revision_sha256: successorPlanRevisionSha256,
        work_cell: workCell,
        oracle_sha256: oracleSha256,
      })),
      work_cell: workCell,
      oracle_sha256: oracleSha256,
    };
    return {
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-CHANGE-ACCEPTANCE-ORACLE-BINDING-V2", ...body }),
    };
  }).sort((left, right) => comparePlanSubjectsV2(left.work_cell, right.work_cell));
  if (seenOracleWorkCells.size !== successorWorkCells.length) {
    throw new TypeError("Change acceptance oracle bindings must cover the complete successor WorkCell set");
  }

  assertRequirementSemanticClosure(
    input.base_semantic_records,
    baseGraph.subjects,
    "Base semantic Requirement closure",
  );
  assertRequirementSemanticClosure(
    input.successor_semantic_records,
    successorGraph.subjects,
    "Successor semantic Requirement closure",
  );
  const semanticDeltas = deriveSemanticDeltas(input.base_semantic_records, input.successor_semantic_records);
  if (semanticDeltas.length < 1) {
    throw new TypeError("Change acceptance requires a source-bound semantic delta");
  }
  for (const delta of semanticDeltas) {
    if (delta.entity_kind !== "REQUIREMENT") continue;
    const previous = delta.previous_entity_id === null ? null
      : baseGraph.subjects.find((subject) => subject.kind === "REQUIREMENT" && subject.id === delta.previous_entity_id);
    const current = delta.successor_entity_id === null ? null
      : successorGraph.subjects.find((subject) => subject.kind === "REQUIREMENT" && subject.id === delta.successor_entity_id);
    if ((delta.previous_entity_id !== null && !previous) || (delta.successor_entity_id !== null && !current)
      || (current && current.revision_sha256 !== delta.successor_entity_sha256)
      || (current && reachableWorkCells(current, successorGraph).length < 1)) {
      throw new TypeError(`Changed Requirement ${delta.semantic_key} is not bound to a current WorkCell and oracle`);
    }
  }

  const requestRootSha256 = canonicalJsonSha256({
    domain: "PCH-CHANGE-ACCEPTANCE-REQUEST-ROOT-V2",
    members: requestMembers.map((member) => member.record_sha256),
  });
  const semanticDeltaRootSha256 = canonicalJsonSha256({
    domain: "PCH-CHANGE-ACCEPTANCE-SEMANTIC-DELTA-ROOT-V2",
    members: semanticDeltas.map((delta) => delta.record_sha256),
  });
  const oracleEvidenceRootSha256 = canonicalJsonSha256({
    domain: "PCH-CHANGE-ACCEPTANCE-ORACLE-ROOT-V2",
    members: oracleBindings.map((oracle) => oracle.record_sha256),
  });
  const eventHeadSha256 = sha(input.event_head_sha256, "Change acceptance event head");
  const createdAtMs = timestamp(input.created_at_ms, "Change acceptance timestamp");
  const body = {
    schema_version: 2 as const,
    change_acceptance_closure_id: idFromSha256("CHANGE_ACCEPTANCE", canonicalJsonSha256({
      base_plan_revision_sha256: basePlanRevisionSha256,
      successor_plan_revision_sha256: successorPlanRevisionSha256,
      decision_plan_binding_root_sha256: binding.record_sha256,
      request_root_sha256: requestRootSha256,
      semantic_delta_root_sha256: semanticDeltaRootSha256,
      invalidation_root_sha256: invalidation.invalidation_root_sha256,
      oracle_evidence_root_sha256: oracleEvidenceRootSha256,
      event_head_sha256: eventHeadSha256,
    })),
    base_plan_revision_id: basePlanRevisionId,
    base_plan_revision_sha256: basePlanRevisionSha256,
    successor_plan_revision_id: successorPlanRevisionId,
    successor_plan_revision_sha256: successorPlanRevisionSha256,
    requirement_revision_id: requirementRevisionId,
    requirement_revision_sha256: requirementRevisionSha256,
    goal_id: goalId,
    contract_id: contractId,
    authority_root_id: authorityRootId,
    decision_closure_id: binding.decision_closure_id,
    decision_closure_sha256: binding.decision_closure_sha256,
    decision_plan_binding_id: binding.decision_plan_binding_id,
    decision_plan_binding_root_sha256: binding.record_sha256,
    request_root_sha256: requestRootSha256,
    request_count: requestMembers.length,
    semantic_delta_root_sha256: semanticDeltaRootSha256,
    semantic_delta_count: semanticDeltas.length,
    invalidation_closure_id: invalidation.invalidation_closure_id,
    invalidation_closure_sha256: invalidation.record_sha256,
    invalidation_root_sha256: invalidation.invalidation_root_sha256,
    invalidation_count: invalidation.members.length,
    reuse_root_sha256: invalidation.reuse_root_sha256,
    reuse_count: invalidation.reusable_subjects.length,
    oracle_evidence_root_sha256: oracleEvidenceRootSha256,
    oracle_count: oracleBindings.length,
    event_head_sha256: eventHeadSha256,
    created_at_ms: createdAtMs,
  };
  return {
    closure: {
      ...body,
      record_sha256: canonicalJsonSha256({ domain: "PCH-CHANGE-ACCEPTANCE-CLOSURE-V2", ...body }),
    },
    request_members: requestMembers,
    semantic_deltas: semanticDeltas,
    invalidation,
    oracle_bindings: oracleBindings,
  };
}
