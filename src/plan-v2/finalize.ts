import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import {
  comparePlanSubjectsV2,
  planSubjectKeyV2,
  validatePlanGraphV2,
  validatePlanSubjectV2,
  type PlanDependencyEdgeV2,
  type PlanSubjectRefV2,
} from "./graph.js";

export interface PlanRevisionV2 {
  readonly schema_version: 2;
  readonly plan_revision_id: string;
  readonly plan_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly contract_freeze_receipt_id: string;
  readonly contract_freeze_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly route_id: string;
  readonly route_sha256: string;
  readonly revision: number;
  readonly parent_plan_revision_id: string | null;
  readonly parent_plan_revision_sha256: string | null;
  readonly subject_root_sha256: string;
  readonly dependency_root_sha256: string;
  readonly must_requirement_root_sha256: string;
  readonly work_cell_root_sha256: string;
  readonly input_closure_sha256: string;
  readonly subject_count: number;
  readonly dependency_count: number;
  readonly requirement_count: number;
  readonly work_cell_count: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

const shaPattern = /^[a-f0-9]{64}$/u;

function boundedId(value: string | null, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new TypeError(`${label} must contain 1..160 characters`);
  }
  return value;
}

function sha(value: string | null, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new TypeError(`${label} is invalid`);
  return value;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Plan revision timestamp is invalid");
  return value;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}..${maximum} entries`);
  }
}

function currentMembers(
  candidates: readonly PlanSubjectRefV2[],
  expectedKind: "REQUIREMENT" | "WORK_CELL",
  graph: ReturnType<typeof validatePlanGraphV2>,
  label: string,
): readonly PlanSubjectRefV2[] {
  boundedArray(candidates, label, 1, expectedKind === "REQUIREMENT" ? 512 : 8_192);
  const result = new Map<string, PlanSubjectRefV2>();
  for (const [index, candidate] of candidates.entries()) {
    const subject = validatePlanSubjectV2(candidate, `${label} ${index}`);
    if (subject.kind !== expectedKind) throw new TypeError(`${label} must contain only ${expectedKind} subjects`);
    const key = planSubjectKeyV2(subject);
    const current = graph.subjects_by_key.get(key);
    if (!current || current.revision_sha256 !== subject.revision_sha256) {
      throw new TypeError(`${label} subject ${subject.id} is outside the current Plan graph`);
    }
    if (result.has(key)) throw new TypeError(`${label} repeats subject ${subject.id}`);
    result.set(key, current);
  }
  return [...result.values()].sort(comparePlanSubjectsV2);
}

function reachesAnyWorkCell(
  requirement: PlanSubjectRefV2,
  workCellKeys: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  const visited = new Set<string>([planSubjectKeyV2(requirement)]);
  const queue = [...visited];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const target of adjacency.get(queue[cursor]!) ?? []) {
      if (workCellKeys.has(target)) return true;
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push(target);
    }
  }
  return false;
}

function implementationAdjacency(
  edges: readonly PlanDependencyEdgeV2[],
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.dependency_kind !== "REQUIRES" && edge.dependency_kind !== "DERIVED_FROM") continue;
    const source = planSubjectKeyV2(edge.source);
    const targets = adjacency.get(source) ?? [];
    targets.push(planSubjectKeyV2(edge.target));
    adjacency.set(source, targets);
  }
  return adjacency;
}

export function finalizePlanRevisionV2(input: {
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly contract_freeze_receipt_id: string;
  readonly contract_freeze_sha256: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly route_id: string;
  readonly route_sha256: string;
  readonly revision: number;
  readonly parent_plan_revision_id: string | null;
  readonly parent_plan_revision_sha256: string | null;
  readonly subjects: readonly PlanSubjectRefV2[];
  readonly edges: readonly PlanDependencyEdgeV2[];
  readonly must_requirements: readonly PlanSubjectRefV2[];
  readonly work_cells: readonly PlanSubjectRefV2[];
  readonly created_at_ms: number;
}): PlanRevisionV2 {
  const goalId = boundedId(input.goal_id, "Plan Goal ID");
  const contractId = boundedId(input.contract_id, "Plan contract ID");
  const authorityRootId = boundedId(input.authority_root_id, "Plan authority root ID");
  const contractFreezeReceiptId = boundedId(input.contract_freeze_receipt_id, "Plan contract freeze receipt ID");
  const requirementRevisionId = boundedId(input.requirement_revision_id, "Plan Requirement revision ID");
  const routeId = boundedId(input.route_id, "Plan Route ID");
  const contractFreezeSha256 = sha(input.contract_freeze_sha256, "Plan contract freeze");
  const requirementRevisionSha256 = sha(input.requirement_revision_sha256, "Plan Requirement revision");
  const routeSha256 = sha(input.route_sha256, "Plan Route");
  const revision = positiveInteger(input.revision, "Plan revision");
  if ((revision === 1) !== (input.parent_plan_revision_id === null && input.parent_plan_revision_sha256 === null)) {
    throw new TypeError("Plan revision parent identity is invalid");
  }
  const parentPlanRevisionId = revision === 1 ? null : boundedId(input.parent_plan_revision_id, "Parent Plan revision ID");
  const parentPlanRevisionSha256 = revision === 1 ? null : sha(input.parent_plan_revision_sha256, "Parent Plan revision");
  const graph = validatePlanGraphV2(input.subjects, input.edges);
  const mustRequirements = currentMembers(input.must_requirements, "REQUIREMENT", graph, "MUST requirements");
  const workCells = currentMembers(input.work_cells, "WORK_CELL", graph, "Plan WorkCells");
  const workCellKeys = new Set(workCells.map(planSubjectKeyV2));
  const implementationEdges = implementationAdjacency(graph.edges);
  for (const requirement of mustRequirements) {
    if (!reachesAnyWorkCell(requirement, workCellKeys, implementationEdges)) {
      throw new TypeError(`MUST requirement ${requirement.id} has no reachable WorkCell`);
    }
  }

  const subjectRootSha256 = canonicalJsonSha256({ domain: "PCH-PLAN-SUBJECT-ROOT-V2", members: graph.subjects });
  const dependencyRootSha256 = canonicalJsonSha256({ domain: "PCH-PLAN-DEPENDENCY-ROOT-V2", members: graph.edges });
  const mustRequirementRootSha256 = canonicalJsonSha256({ domain: "PCH-PLAN-MUST-ROOT-V2", members: mustRequirements });
  const workCellRootSha256 = canonicalJsonSha256({ domain: "PCH-PLAN-WORK-CELL-ROOT-V2", members: workCells });
  const inputClosureSha256 = canonicalJsonSha256({
    domain: "PCH-PLAN-INPUT-CLOSURE-V2",
    contract_freeze_sha256: contractFreezeSha256,
    requirement_revision_sha256: requirementRevisionSha256,
    route_sha256: routeSha256,
    subject_root_sha256: subjectRootSha256,
    dependency_root_sha256: dependencyRootSha256,
    must_requirement_root_sha256: mustRequirementRootSha256,
    work_cell_root_sha256: workCellRootSha256,
  });
  // A Plan survives Contract revisions; each PlanRevision binds the exact current ContractFreeze.
  const planId = idFromSha256("PLAN", canonicalJsonSha256({ goal_id: goalId }));
  const planRevisionId = idFromSha256("PLAN_REVISION", canonicalJsonSha256({
    plan_id: planId,
    revision,
    parent_plan_revision_sha256: parentPlanRevisionSha256,
    input_closure_sha256: inputClosureSha256,
  }));
  const body = {
    schema_version: 2 as const,
    plan_revision_id: planRevisionId,
    plan_id: planId,
    goal_id: goalId,
    contract_id: contractId,
    authority_root_id: authorityRootId,
    contract_freeze_receipt_id: contractFreezeReceiptId,
    contract_freeze_sha256: contractFreezeSha256,
    requirement_revision_id: requirementRevisionId,
    requirement_revision_sha256: requirementRevisionSha256,
    route_id: routeId,
    route_sha256: routeSha256,
    revision,
    parent_plan_revision_id: parentPlanRevisionId,
    parent_plan_revision_sha256: parentPlanRevisionSha256,
    subject_root_sha256: subjectRootSha256,
    dependency_root_sha256: dependencyRootSha256,
    must_requirement_root_sha256: mustRequirementRootSha256,
    work_cell_root_sha256: workCellRootSha256,
    input_closure_sha256: inputClosureSha256,
    subject_count: graph.subjects.length,
    dependency_count: graph.edges.length,
    requirement_count: mustRequirements.length,
    work_cell_count: workCells.length,
    created_at_ms: timestamp(input.created_at_ms),
  };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-PLAN-REVISION-V2", ...body }) };
}
