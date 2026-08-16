import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { GoalContractRecord, RouteSkeletonRecord } from "./domain.js";
import type { GoalFitAssessmentProposalV2 } from "../intake-v2/domain.js";
import { normalizeGoalFitAssessmentProposalV2 } from "../intake-v2/finalize.js";
import type {
  DeferredOutcomeProposal,
  RouteAlternativeProposal,
  RouteAssumptionProposal,
  RouteProposal,
  RouteRiskProposal,
  WorkCellProposal,
} from "./finalize.js";

export interface RouteRevisionPatch {
  readonly lane?: RouteProposal["lane"];
  readonly outcomes?: readonly string[];
  readonly work_cells: readonly WorkCellProposal[];
  readonly near_horizon?: readonly string[];
  readonly assumptions?: readonly RouteAssumptionProposal[];
  readonly risks?: readonly RouteRiskProposal[];
  readonly alternatives?: readonly RouteAlternativeProposal[];
  readonly deferred_outcomes?: readonly DeferredOutcomeProposal[];
}

export interface RouteRevisionAuthorityPatchV2 extends RouteRevisionPatch {
  readonly goal_fit_assessment: GoalFitAssessmentProposalV2;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label}.${unexpected[0]} is not allowed`);
}

function obligationKeys(contract: GoalContractRecord): ReadonlyMap<string, string> {
  return new Map(contract.obligations.map((obligation) => [obligation.obligation_id, obligation.semantic_key]));
}

function proposalFromRoute(contract: GoalContractRecord, route: RouteSkeletonRecord): RouteProposal {
  const obligations = obligationKeys(contract);
  const subjects = new Map<string, string>();
  for (const cell of route.work_cells) subjects.set(cell.work_cell_id, cell.logical_key);
  for (const deferred of route.deferred_outcomes ?? []) subjects.set(deferred.deferred_outcome_id, deferred.key);
  const subjectKey = (id: string, label: string): string => {
    const key = subjects.get(id);
    if (!key) throw new TypeError(`${label} references an unknown prior route subject`);
    return key;
  };
  const obligationKey = (id: string, label: string): string => {
    const key = obligations.get(id);
    if (!key) throw new TypeError(`${label} references an unknown GoalContract obligation`);
    return key;
  };
  return {
    lane: route.lane,
    outcomes: route.outcomes,
    work_cells: route.work_cells.map((cell) => ({
      key: cell.logical_key,
      outcome: cell.outcome,
      obligation_keys: cell.obligation_ids.map((id) => obligationKey(id, `WorkCell ${cell.logical_key}`)),
      dependencies: cell.dependencies.map((id) => subjectKey(id, `WorkCell ${cell.logical_key}`)),
      read_roots: cell.read_roots,
      write_roots: cell.write_roots,
      effect_classes: cell.effect_classes,
      oracle: cell.oracle,
      risk: cell.risk,
      reversible: cell.reversible,
      budget: cell.budget,
    })),
    near_horizon: route.near_horizon.map((id) => subjectKey(id, "near_horizon")),
    assumptions: route.assumptions.map((value) => {
      const entry = value as unknown as RouteSkeletonRecord["assumptions"][number] & RouteAssumptionProposal;
      return { key: entry.key, statement: entry.statement, status: entry.status, evidence_refs: entry.evidence_refs ?? [] };
    }),
    risks: route.risks.map((value) => {
      const entry = value as unknown as RouteSkeletonRecord["risks"][number] & RouteRiskProposal;
      return {
        key: entry.key, statement: entry.statement, likelihood: entry.likelihood,
        impact: entry.impact, mitigation: entry.mitigation, evidence_refs: entry.evidence_refs ?? [],
      };
    }),
    alternatives: route.alternatives.map((value) => {
      const entry = value as unknown as RouteSkeletonRecord["alternatives"][number] & RouteAlternativeProposal;
      return {
        key: entry.key, summary: entry.summary, disposition: entry.disposition,
        reason: entry.reason, evidence_refs: entry.evidence_refs ?? [],
      };
    }),
    deferred_outcomes: (route.deferred_outcomes ?? []).map((entry) => ({
      key: entry.key,
      outcome: entry.outcome,
      obligation_keys: entry.obligation_ids.map((id) => obligationKey(id, `DeferredOutcome ${entry.key}`)),
      dependencies: entry.dependencies.map((id) => subjectKey(id, `DeferredOutcome ${entry.key}`)),
      expansion_trigger: entry.expansion_trigger,
      commitment: entry.commitment,
      evidence_refs: entry.evidence_refs,
    })),
  };
}

export function routeExecutionSemanticsSha256(
  contract: GoalContractRecord, route: RouteSkeletonRecord,
): string {
  return canonicalJsonSha256(proposalFromRoute(contract, route));
}

export function applyRouteRevisionPatch(input: {
  readonly contract: GoalContractRecord;
  readonly priorRoute: RouteSkeletonRecord;
  readonly patch: RouteRevisionPatch;
}): RouteProposal {
  const patch = record(input.patch, "RouteRevision patch");
  exactKeys(patch, [
    "lane", "outcomes", "work_cells", "near_horizon", "assumptions", "risks", "alternatives", "deferred_outcomes",
  ], "RouteRevision patch");
  if (!Array.isArray(patch.work_cells) || patch.work_cells.length < 1 || patch.work_cells.length > 3) {
    throw new TypeError("RouteRevision patch requires 1..3 replacement current/near WorkCells");
  }
  const prior = proposalFromRoute(input.contract, input.priorRoute);
  const workCells = patch.work_cells as unknown as readonly WorkCellProposal[];
  const merged: RouteProposal = {
    lane: (patch.lane as RouteProposal["lane"] | undefined) ?? prior.lane ?? input.priorRoute.lane,
    outcomes: (patch.outcomes as readonly string[] | undefined) ?? prior.outcomes,
    work_cells: workCells,
    near_horizon: (patch.near_horizon as readonly string[] | undefined) ?? workCells.map((cell) => cell.key),
    assumptions: (patch.assumptions as readonly RouteAssumptionProposal[] | undefined) ?? prior.assumptions ?? [],
    risks: (patch.risks as readonly RouteRiskProposal[] | undefined) ?? prior.risks ?? [],
    alternatives: (patch.alternatives as readonly RouteAlternativeProposal[] | undefined) ?? prior.alternatives ?? [],
    deferred_outcomes: (patch.deferred_outcomes as readonly DeferredOutcomeProposal[] | undefined) ?? prior.deferred_outcomes ?? [],
  };
  if (canonicalJsonSha256(merged) === canonicalJsonSha256(prior)) {
    throw new TypeError("RouteRevision patch does not change the prior RouteSkeleton");
  }
  return merged;
}

export function splitRouteRevisionAuthorityPatchV2(value: unknown): {
  readonly patch: RouteRevisionPatch;
  readonly goalFitAssessment: GoalFitAssessmentProposalV2;
} {
  const proposal = record(value, "RouteRevision Authority V2 patch");
  exactKeys(proposal, [
    "lane", "outcomes", "work_cells", "near_horizon", "assumptions", "risks", "alternatives",
    "deferred_outcomes", "goal_fit_assessment",
  ], "RouteRevision Authority V2 patch");
  const goalFitAssessment = normalizeGoalFitAssessmentProposalV2(proposal.goal_fit_assessment);
  const { goal_fit_assessment: _goalFitAssessment, ...patch } = proposal;
  void _goalFitAssessment;
  return { patch: patch as unknown as RouteRevisionPatch, goalFitAssessment };
}
