import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanGraphV2,
  validatePlanSubjectV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";

export type { PlanDependencyEdgeV2, PlanDependencyKindV2, PlanSubjectKindV2, PlanSubjectRefV2 } from "./graph.js";

export interface PlanChangeImpactV2 {
  readonly schema_version: 2;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly invalidated_subjects: readonly PlanSubjectRefV2[];
  readonly reusable_subjects: readonly PlanSubjectRefV2[];
  readonly propagation_edges: readonly PlanInvalidationPropagationEdgeV2[];
  readonly changed_root_sha256: string;
  readonly invalidation_root_sha256: string;
  readonly reuse_root_sha256: string;
  readonly propagation_root_sha256: string;
  readonly record_sha256: string;
}

export interface PlanInvalidationPropagationEdgeV2 {
  readonly source: PlanSubjectRefV2;
  readonly target: PlanSubjectRefV2;
  readonly dependency_kind: PlanDependencyEdgeV2["dependency_kind"];
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

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}..${maximum} entries`);
  }
}

function subjectRoot(domain: string, subjects: readonly PlanSubjectRefV2[]): string {
  return canonicalJsonSha256({ domain, members: subjects });
}

function invalidationAdjacency(edges: readonly PlanDependencyEdgeV2[]): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.dependency_kind === "AUTHORIZES") continue;
    const source = planSubjectKeyV2(edge.source);
    const targets = adjacency.get(source) ?? [];
    targets.push(planSubjectKeyV2(edge.target));
    adjacency.set(source, targets);
  }
  return adjacency;
}

export function derivePlanChangeImpactV2(input: {
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly changed_subjects: readonly PlanSubjectRefV2[];
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
}): PlanChangeImpactV2 {
  boundedId(input.plan_revision_id, "Plan revision ID");
  sha(input.plan_revision_sha256, "Plan revision");
  boundedArray(input.changed_subjects, "Plan impact changed subjects", 0, 512);
  const graph = validatePlanGraphV2(input.subjects, input.edges);
  const subjects = graph.subjects_by_key;

  const changed = new Map<string, PlanSubjectRefV2>();
  for (const [index, candidate] of input.changed_subjects.entries()) {
    const subject = validatePlanSubjectV2(candidate, `Changed subject ${index}`);
    const stored = subjects.get(planSubjectKeyV2(subject));
    if (!stored || stored.revision_sha256 !== subject.revision_sha256) {
      throw new TypeError(`Changed subject ${subject.id} is outside the current Plan revision`);
    }
    const key = planSubjectKeyV2(stored);
    if (changed.has(key)) throw new TypeError(`Plan impact repeats changed subject ${subject.id}`);
    changed.set(key, stored);
  }

  const invalidated = new Set(changed.keys());
  const queue = [...changed.keys()];
  const adjacency = invalidationAdjacency(graph.edges);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const target of adjacency.get(queue[cursor]!) ?? []) {
      if (invalidated.has(target)) continue;
      invalidated.add(target);
      queue.push(target);
    }
  }

  const changedSubjects = [...changed.values()].sort(comparePlanSubjectsV2);
  const invalidatedSubjects = [...invalidated].map((key) => subjects.get(key)!).sort(comparePlanSubjectsV2);
  const reusableSubjects = [...subjects.entries()]
    .filter(([key]) => !invalidated.has(key))
    .map(([, subject]) => subject)
    .sort(comparePlanSubjectsV2);
  const propagationEdges = graph.edges.filter((edge) => edge.dependency_kind !== "AUTHORIZES"
    && invalidated.has(planSubjectKeyV2(edge.source))
    && invalidated.has(planSubjectKeyV2(edge.target))
    && !changed.has(planSubjectKeyV2(edge.target)))
    .map((edge): PlanInvalidationPropagationEdgeV2 => ({
      source: edge.source,
      target: edge.target,
      dependency_kind: edge.dependency_kind,
    }));
  const changedRoot = subjectRoot("PCH-PLAN-CHANGED-SUBJECT-ROOT-V2", changedSubjects);
  const invalidationRoot = subjectRoot("PCH-PLAN-INVALIDATION-ROOT-V2", invalidatedSubjects);
  const reuseRoot = subjectRoot("PCH-PLAN-REUSE-ROOT-V2", reusableSubjects);
  const propagationRoot = canonicalJsonSha256({
    domain: "PCH-PLAN-INVALIDATION-PROPAGATION-ROOT-V2", members: propagationEdges,
  });
  const body = {
    schema_version: 2 as const,
    plan_revision_id: input.plan_revision_id,
    plan_revision_sha256: input.plan_revision_sha256,
    changed_subjects: changedSubjects,
    invalidated_subjects: invalidatedSubjects,
    reusable_subjects: reusableSubjects,
    propagation_edges: propagationEdges,
    changed_root_sha256: changedRoot,
    invalidation_root_sha256: invalidationRoot,
    reuse_root_sha256: reuseRoot,
    propagation_root_sha256: propagationRoot,
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-PLAN-CHANGE-IMPACT-V2", ...body }) };
}
