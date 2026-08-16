import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { derivePlanChangeImpactV2, type PlanChangeImpactV2 } from "./change-impact.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanGraphV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";

export interface ModifiedPlanSubjectV2 {
  readonly before: PlanSubjectRefV2;
  readonly after: PlanSubjectRefV2;
}

export interface PlanRevisionDeltaV2 {
  readonly schema_version: 2;
  readonly previous_plan_revision_id: string;
  readonly previous_plan_revision_sha256: string;
  readonly current_plan_revision_id: string;
  readonly current_plan_revision_sha256: string;
  readonly added_subjects: readonly PlanSubjectRefV2[];
  readonly removed_subjects: readonly PlanSubjectRefV2[];
  readonly modified_subjects: readonly ModifiedPlanSubjectV2[];
  readonly structurally_changed_subjects: readonly PlanSubjectRefV2[];
  readonly reusable_subjects: readonly PlanSubjectRefV2[];
  readonly impact: PlanChangeImpactV2;
  readonly delta_root_sha256: string;
  readonly record_sha256: string;
}

const shaPattern = /^[a-f0-9]{64}$/u;

function boundedId(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new TypeError(`${label} must contain 1..160 characters`);
  }
  return value;
}

function sha(value: string, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function stableEdgeKey(edge: PlanDependencyEdgeV2): string {
  return `${planSubjectKeyV2(edge.source)}\u0000${edge.dependency_kind}\u0000${planSubjectKeyV2(edge.target)}`;
}

function addPreviousSubject(
  target: Map<string, PlanSubjectRefV2>,
  previous: ReadonlyMap<string, PlanSubjectRefV2>,
  subject: PlanSubjectRefV2,
): void {
  const stable = previous.get(planSubjectKeyV2(subject));
  if (stable) target.set(planSubjectKeyV2(stable), stable);
}

export function derivePlanRevisionDeltaV2(input: {
  readonly previous_plan_revision_id: string;
  readonly previous_plan_revision_sha256: string;
  readonly current_plan_revision_id: string;
  readonly current_plan_revision_sha256: string;
  readonly previous_subjects: readonly PlanSubjectRefV2[];
  readonly previous_edges: readonly PlanDependencyEdgeV2[];
  readonly current_subjects: readonly PlanSubjectRefV2[];
  readonly current_edges: readonly PlanDependencyEdgeV2[];
}): PlanRevisionDeltaV2 {
  const previousPlanRevisionId = boundedId(input.previous_plan_revision_id, "Previous Plan revision ID");
  const currentPlanRevisionId = boundedId(input.current_plan_revision_id, "Current Plan revision ID");
  if (previousPlanRevisionId === currentPlanRevisionId) throw new TypeError("Plan delta requires distinct revisions");
  const previousPlanRevisionSha256 = sha(input.previous_plan_revision_sha256, "Previous Plan revision");
  const currentPlanRevisionSha256 = sha(input.current_plan_revision_sha256, "Current Plan revision");
  const previousGraph = validatePlanGraphV2(input.previous_subjects, input.previous_edges);
  const currentGraph = validatePlanGraphV2(input.current_subjects, input.current_edges);
  const previous = previousGraph.subjects_by_key;
  const current = currentGraph.subjects_by_key;

  const added = currentGraph.subjects.filter((subject) => !previous.has(planSubjectKeyV2(subject)));
  const removed = previousGraph.subjects.filter((subject) => !current.has(planSubjectKeyV2(subject)));
  const modified = previousGraph.subjects.flatMap((before): ModifiedPlanSubjectV2[] => {
    const after = current.get(planSubjectKeyV2(before));
    return after && after.revision_sha256 !== before.revision_sha256 ? [{ before, after }] : [];
  });

  const previousEdges = new Map(previousGraph.edges.map((edge) => [stableEdgeKey(edge), edge]));
  const currentEdges = new Map(currentGraph.edges.map((edge) => [stableEdgeKey(edge), edge]));
  const structural = new Map<string, PlanSubjectRefV2>();
  for (const [key, edge] of previousEdges) {
    if (currentEdges.has(key)) continue;
    addPreviousSubject(structural, previous, edge.source);
    addPreviousSubject(structural, previous, edge.target);
  }
  for (const [key, edge] of currentEdges) {
    if (previousEdges.has(key)) continue;
    addPreviousSubject(structural, previous, edge.source);
    addPreviousSubject(structural, previous, edge.target);
  }
  const changed = new Map<string, PlanSubjectRefV2>();
  for (const subject of removed) changed.set(planSubjectKeyV2(subject), subject);
  for (const item of modified) changed.set(planSubjectKeyV2(item.before), item.before);
  for (const subject of structural.values()) changed.set(planSubjectKeyV2(subject), subject);
  const impact = derivePlanChangeImpactV2({
    plan_revision_id: previousPlanRevisionId,
    plan_revision_sha256: previousPlanRevisionSha256,
    changed_subjects: [...changed.values()],
    subjects: previousGraph.subjects,
    edges: previousGraph.edges,
  });
  const reusable = impact.reusable_subjects.filter((before) => {
    const after = current.get(planSubjectKeyV2(before));
    return after?.revision_sha256 === before.revision_sha256;
  });
  const addedSubjects = [...added].sort(comparePlanSubjectsV2);
  const removedSubjects = [...removed].sort(comparePlanSubjectsV2);
  const modifiedSubjects = [...modified].sort((left, right) => comparePlanSubjectsV2(left.before, right.before));
  const structurallyChangedSubjects = [...structural.values()].sort(comparePlanSubjectsV2);
  const reusableSubjects = [...reusable].sort(comparePlanSubjectsV2);
  const deltaRootSha256 = canonicalJsonSha256({
    domain: "PCH-PLAN-REVISION-DELTA-ROOT-V2",
    added: addedSubjects,
    removed: removedSubjects,
    modified: modifiedSubjects,
    structural: structurallyChangedSubjects,
    invalidation_root_sha256: impact.invalidation_root_sha256,
    reuse_root_sha256: impact.reuse_root_sha256,
    propagation_root_sha256: impact.propagation_root_sha256,
  });
  const body = {
    schema_version: 2 as const,
    previous_plan_revision_id: previousPlanRevisionId,
    previous_plan_revision_sha256: previousPlanRevisionSha256,
    current_plan_revision_id: currentPlanRevisionId,
    current_plan_revision_sha256: currentPlanRevisionSha256,
    added_subjects: addedSubjects,
    removed_subjects: removedSubjects,
    modified_subjects: modifiedSubjects,
    structurally_changed_subjects: structurallyChangedSubjects,
    reusable_subjects: reusableSubjects,
    impact,
    delta_root_sha256: deltaRootSha256,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-PLAN-REVISION-DELTA-V2", ...body }) };
}
