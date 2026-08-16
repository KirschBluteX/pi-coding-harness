export type PlanSubjectKindV2 =
  | "REQUIREMENT"
  | "DECISION"
  | "WORK_CELL"
  | "STAGE_GATE"
  | "EVIDENCE"
  | "PATCH_SET"
  | "ARTIFACT"
  | "AUTHORIZATION";

export type PlanDependencyKindV2 =
  | "REQUIRES"
  | "SATISFIES"
  | "DERIVED_FROM"
  | "PRODUCES"
  | "AUTHORIZES";

export interface PlanSubjectRefV2 {
  readonly kind: PlanSubjectKindV2;
  readonly id: string;
  readonly revision_sha256: string;
}

export interface PlanDependencyEdgeV2 {
  readonly source: PlanSubjectRefV2;
  readonly target: PlanSubjectRefV2;
  readonly dependency_kind: PlanDependencyKindV2;
}

export interface ValidatedPlanGraphV2 {
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
  readonly subjects_by_key: ReadonlyMap<string, PlanSubjectRefV2>;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
}

const subjectKinds = new Set<PlanSubjectKindV2>([
  "REQUIREMENT", "DECISION", "WORK_CELL", "STAGE_GATE", "EVIDENCE", "PATCH_SET", "ARTIFACT", "AUTHORIZATION",
]);
const dependencyKinds = new Set<PlanDependencyKindV2>([
  "REQUIRES", "SATISFIES", "DERIVED_FROM", "PRODUCES", "AUTHORIZES",
]);
const shaPattern = /^[a-f0-9]{64}$/u;

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}..${maximum} entries`);
  }
}

export function planSubjectKeyV2(subject: PlanSubjectRefV2): string {
  return `${subject.kind}\u0000${subject.id}`;
}

export function comparePlanSubjectsV2(left: PlanSubjectRefV2, right: PlanSubjectRefV2): number {
  return left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind);
}

export function validatePlanSubjectV2(subject: PlanSubjectRefV2, label: string): PlanSubjectRefV2 {
  if (!subject || typeof subject !== "object" || !subjectKinds.has(subject.kind)) {
    throw new TypeError(`${label} kind is invalid`);
  }
  if (typeof subject.id !== "string" || subject.id.length < 1 || subject.id.length > 160) {
    throw new TypeError(`${label} ID must contain 1..160 characters`);
  }
  if (typeof subject.revision_sha256 !== "string" || !shaPattern.test(subject.revision_sha256)) {
    throw new TypeError(`${label} revision must be a lowercase SHA-256`);
  }
  return subject;
}

export function validatePlanGraphV2(
  subjectInput: readonly PlanSubjectRefV2[],
  edgeInput: readonly PlanDependencyEdgeV2[],
): ValidatedPlanGraphV2 {
  boundedArray(subjectInput, "Plan graph subjects", 1, 8_192);
  boundedArray(edgeInput, "Plan graph dependency edges", 0, 32_768);
  const subjects = new Map<string, PlanSubjectRefV2>();
  for (const [index, candidate] of subjectInput.entries()) {
    const subject = validatePlanSubjectV2(candidate, `Plan subject ${index}`);
    const key = planSubjectKeyV2(subject);
    if (subjects.has(key)) throw new TypeError(`Plan graph repeats subject ${subject.id}`);
    subjects.set(key, subject);
  }

  const adjacency = new Map<string, string[]>();
  const incoming = new Map([...subjects.keys()].map((key) => [key, 0]));
  const edgeIds = new Set<string>();
  for (const [index, edge] of edgeInput.entries()) {
    if (!edge || typeof edge !== "object" || !dependencyKinds.has(edge.dependency_kind)) {
      throw new TypeError(`Plan dependency edge ${index} is invalid`);
    }
    const source = validatePlanSubjectV2(edge.source, `Plan dependency edge ${index} source`);
    const target = validatePlanSubjectV2(edge.target, `Plan dependency edge ${index} target`);
    const sourceKey = planSubjectKeyV2(source);
    const targetKey = planSubjectKeyV2(target);
    const storedSource = subjects.get(sourceKey);
    const storedTarget = subjects.get(targetKey);
    if (!storedSource || storedSource.revision_sha256 !== source.revision_sha256
      || !storedTarget || storedTarget.revision_sha256 !== target.revision_sha256) {
      throw new TypeError(`Plan dependency edge ${index} is outside the current Plan revision`);
    }
    const edgeId = `${sourceKey}\u0000${edge.dependency_kind}\u0000${targetKey}`;
    if (edgeIds.has(edgeId)) throw new TypeError(`Plan dependency edge ${index} is duplicated`);
    edgeIds.add(edgeId);
    const targets = adjacency.get(sourceKey) ?? [];
    if (!targets.includes(targetKey)) {
      targets.push(targetKey);
      incoming.set(targetKey, incoming.get(targetKey)! + 1);
    }
    adjacency.set(sourceKey, targets);
  }

  const ready = [...incoming.entries()].filter(([, count]) => count === 0).map(([key]) => key);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    visited += 1;
    for (const target of adjacency.get(ready[cursor]!) ?? []) {
      const next = incoming.get(target)! - 1;
      incoming.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== subjects.size) throw new TypeError("Plan dependency graph contains a cycle");

  const normalizedSubjects = [...subjects.values()].sort(comparePlanSubjectsV2);
  const normalizedEdges = [...edgeInput].sort((left, right) =>
    planSubjectKeyV2(left.source).localeCompare(planSubjectKeyV2(right.source))
      || planSubjectKeyV2(left.target).localeCompare(planSubjectKeyV2(right.target))
      || left.dependency_kind.localeCompare(right.dependency_kind));
  return { subjects: normalizedSubjects, edges: normalizedEdges, subjects_by_key: subjects, adjacency };
}
