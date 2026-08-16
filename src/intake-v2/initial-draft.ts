import type { AcceptanceProjectionV2 } from "../acceptance-v2/domain.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import type { DecisionRequirementProposalV2, RequirementItemProposalV2 } from "./domain.js";

const priorityRank = { MUST: 0, SHOULD: 1, MAY: 2 } as const;

function requirementKind(kind: AcceptanceProjectionV2["facets"][number]["kind"]): RequirementItemProposalV2["kind"] {
  if (kind === "OUTCOME") return "OUTCOME";
  if (kind === "QUALITY") return "QUALITY";
  if (kind === "NON_GOAL") return "NON_GOAL";
  return "CONSTRAINT";
}

export interface InitialIntakeDraftV2 {
  readonly requirements: readonly RequirementItemProposalV2[];
  readonly decisions: readonly DecisionRequirementProposalV2[];
}

export function deriveInitialIntakeDraftV2(acceptance: AcceptanceProjectionV2): InitialIntakeDraftV2 {
  const obligationById = new Map(acceptance.obligations.map((obligation) => [obligation.acceptance_obligation_id, obligation]));
  const obligationIdsByFacet = new Map<string, string[]>();
  for (const binding of acceptance.bindings) {
    const ids = obligationIdsByFacet.get(binding.facet_id) ?? [];
    ids.push(binding.acceptance_obligation_id);
    obligationIdsByFacet.set(binding.facet_id, ids);
  }

  const requirements = acceptance.facets.map((facet): RequirementItemProposalV2 => {
    const priorities = (obligationIdsByFacet.get(facet.facet_id) ?? []).map((obligationId) => {
      const obligation = obligationById.get(obligationId);
      if (!obligation) throw new AuthorityIntegrityError("Initial Intake binding lost its Acceptance obligation");
      return obligation.priority;
    });
    const priority = priorities.sort((left, right) => priorityRank[left] - priorityRank[right])[0];
    if (!priority) throw new AuthorityIntegrityError("Initial Intake Requirement lacks Acceptance obligation authority");
    return {
      key: facet.semantic_key,
      kind: requirementKind(facet.kind),
      priority,
      statement: facet.semantic_statement,
      acceptance_facet_ids: [facet.facet_id],
      source_span_ids: facet.source_span_ids,
    };
  });
  const requirementKeys = requirements.map((requirement) => requirement.key).sort();
  const sourceSpanId = [...new Set(requirements.flatMap((requirement) => requirement.source_span_ids))].sort()[0];
  if (!sourceSpanId) throw new AuthorityIntegrityError("Initial Intake draft review lacks exact source authority");

  return {
    requirements,
    decisions: [{
      key: "goal-contract-draft-review",
      kind: "DRAFT_REVIEW",
      question: "Approve the current Goal Contract and its complete Requirement closure?",
      materiality: "HIGH",
      blocking: true,
      affected_requirement_keys: requirementKeys,
      source_span_ids: [sourceSpanId],
      trigger: { kind: "IMMEDIATE", evidence_sha256: acceptance.authority.record_sha256 },
      latest_resolution_stage: "CONTRACT_FREEZE",
      default: { action: "REJECT", value: false },
      reversibility: "EXPENSIVE_TO_REVERSE",
      affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }],
  };
}
