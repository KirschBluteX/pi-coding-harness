import type { AcceptanceProjectionV2 } from "../acceptance-v2/domain.js";
import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type {
  ContractFreezeReceiptV2,
  DecisionActionV2,
  DecisionAuthorityInputBundleV2,
  DecisionAuthorityInputReceiptV2,
  DecisionAuthorityActorV2,
  DecisionDueEventPurposeV2,
  DecisionDueEventReceiptV2,
  DecisionClosureBundleV2,
  DecisionClosureMemberV2,
  DecisionRequirementProposalV2,
  DecisionRequirementV2,
  DecisionResolutionV2,
  GoalFitAssessmentFacetV2,
  GoalFitAssessmentProposalV2,
  GoalFitFindingFacetProposalV2,
  GoalFitAssessmentStatusV2,
  GoalFitAssessmentV2,
  GoalFitGateV2,
  GoalFitGateInstanceReceiptV2,
  GoalFitGateSubjectKindV2,
  GoalFitReviewV2,
  GoalFitReviewAssessmentBindingV2,
  GoalFitVerdictV2,
  RequirementItemProposalV2,
  RequirementItemV2,
  RequirementRevisionClosureV2,
  TypedProposalOriginV2,
} from "./domain.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const semanticKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reasonCodePattern = /^[A-Z][A-Z0-9_]{0,95}$/u;
const stages: readonly GoalFitGateV2[] = [
  "CONTRACT_REVIEW", "CONTRACT_FREEZE", "PLAN_ENTRY", "IRREVERSIBLE_ARCHITECTURE",
  "REPEATED_FAILURE", "MATERIAL_CHANGE", "FINAL_CLOSURE",
];
const requirementKinds = new Set([
  "OUTCOME", "CONSTRAINT", "NON_GOAL", "QUALITY", "PERFORMANCE", "SECURITY", "RECOVERY", "UX",
]);
const priorities = new Set(["MUST", "SHOULD", "MAY"]);
const proposalOrigins = new Set<TypedProposalOriginV2>([
  "CURRENT_AGENT_TYPED_PROPOSAL", "PROVIDER_TYPED_PROPOSAL", "WORKER_TYPED_PROPOSAL",
]);
const decisionKinds = new Set(["MATERIAL_UNKNOWN", "DRAFT_REVIEW", "ARCHITECTURE", "ACCEPTANCE", "RISK"]);
const materialities = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const triggerKinds = new Set(["IMMEDIATE", "STAGE_ENTRY", "EVIDENCE_CHANGE", "CHANGE_REQUEST"]);
const reversibilities = new Set(["REVERSIBLE", "EXPENSIVE_TO_REVERSE", "IRREVERSIBLE"]);
const actions = new Set<DecisionActionV2>(["APPROVE", "REJECT", "EDIT", "DEFER"]);
const actors = new Set<DecisionAuthorityActorV2>(["USER", "HOST_DEFAULT"]);
const verdicts = new Set<GoalFitVerdictV2>(["FIT", "ASK_USER", "REFRAME", "REJECT"]);
const assessmentStatuses = new Set<GoalFitAssessmentStatusV2>([
  "PASS", "NOT_APPLICABLE", "ASK_USER", "REFRAME", "REJECT",
]);
const gateSubjectKinds = new Set<GoalFitGateSubjectKindV2>([
  "REQUIREMENT_REVISION", "PLAN_REVISION", "CHANGE_ACCEPTANCE_CLOSURE",
  "FAILURE_RECEIPT", "DELIVERABLE_MANIFEST",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new TypeError(`${label}.${extra} is not allowed`);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${label} must contain 1..${maximum} UTF-8 bytes`);
  }
  return value.normalize("NFC");
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
  return value;
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : sha(value, label);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function uniqueSorted(values: unknown, label: string, minimum = 1, maximum = 4096): readonly string[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum
    || values.some((value: unknown) => typeof value !== "string" || value.length < 1)) {
    throw new TypeError(`${label} must contain ${minimum}..${maximum} stable IDs`);
  }
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} contains a duplicate`);
  return strings.toSorted();
}

function canonicalValue(value: unknown, label: string): CanonicalJson {
  try {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded, "utf8") > 32_768) throw new TypeError(`${label} is too large`);
    return JSON.parse(encoded) as CanonicalJson;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(`${label} must be bounded canonical JSON`, { cause: error });
  }
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertSealed(domain: string, value: Record<string, unknown>, label: string): void {
  const actual = sha(value.record_sha256, `${label}.record_sha256`);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "record_sha256"));
  if (actual !== canonicalJsonSha256({ domain, ...body })) throw new TypeError(`${label} record hash is invalid`);
}

function memberRoot(domain: string, hashes: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...hashes].sort() });
}

function stageIndex(stage: GoalFitGateV2): number {
  const index = stages.indexOf(stage);
  if (index < 0) throw new TypeError(`Unknown Goal Fit stage: ${String(stage)}`);
  return index;
}

function acceptanceIndex(acceptance: AcceptanceProjectionV2): {
  readonly facets: Map<string, AcceptanceProjectionV2["facets"][number]>;
  readonly spans: Set<string>;
} {
  if (acceptance.authority.goal_id.length < 1 || acceptance.authority.contract_id.length < 1) {
    throw new TypeError("Acceptance projection identity is invalid");
  }
  const facets = new Map(acceptance.facets.map((facet) => [facet.facet_id, facet]));
  const spans = new Set(acceptance.spans.map((span) => span.span_id));
  if (facets.size !== acceptance.facets.length || spans.size !== acceptance.spans.length) {
    throw new TypeError("Acceptance projection contains duplicate member IDs");
  }
  return { facets, spans };
}

function normalizeRequirementItem(
  proposal: RequirementItemProposalV2,
  index: ReturnType<typeof acceptanceIndex>,
  goalId: string,
  contractId: string,
  authorityRootId: string,
  requirementRevisionId: string,
): RequirementItemV2 {
  const item = record(proposal, "Requirement item proposal");
  exactKeys(item, ["key", "kind", "priority", "statement", "acceptance_facet_ids", "source_span_ids"], "Requirement item proposal");
  if (typeof item.key !== "string" || !semanticKeyPattern.test(item.key)) throw new TypeError("Requirement item key is invalid");
  if (typeof item.kind !== "string" || !requirementKinds.has(item.kind)) throw new TypeError("Requirement item kind is invalid");
  if (typeof item.priority !== "string" || !priorities.has(item.priority)) throw new TypeError("Requirement item priority is invalid");
  const statement = boundedText(item.statement, "Requirement item statement", 32_768);
  const facetIds = uniqueSorted(proposal.acceptance_facet_ids, "Requirement item acceptance facets", 1, 64);
  const spanIds = uniqueSorted(proposal.source_span_ids, "Requirement item source spans", 1, 64);
  for (const facetId of facetIds) {
    const facet = index.facets.get(facetId);
    if (!facet) throw new TypeError(`Requirement item references foreign Acceptance facet ${facetId}`);
    if (!facet.source_span_ids.some((spanId) => spanIds.includes(spanId))) {
      throw new TypeError(`Requirement item facet ${facetId} has no bound source span`);
    }
  }
  for (const spanId of spanIds) if (!index.spans.has(spanId)) throw new TypeError(`Requirement item references foreign source span ${spanId}`);
  const requirementId = idFromSha256("REQUIREMENT", canonicalJsonSha256({ goal_id: goalId, semantic_key: item.key }));
  const traceRootSha256 = canonicalJsonSha256({ facets: facetIds, spans: spanIds });
  const body = {
    schema_version: 2 as const,
    requirement_item_revision_id: idFromSha256("REQUIREMENT_ITEM", canonicalJsonSha256({
      requirement_id: requirementId, requirement_revision_id: requirementRevisionId, kind: item.kind,
      priority: item.priority, statement, trace_root_sha256: traceRootSha256,
    })),
    requirement_id: requirementId,
    requirement_revision_id: requirementRevisionId,
    goal_id: goalId,
    contract_id: contractId,
    authority_root_id: authorityRootId,
    semantic_key: item.key,
    kind: item.kind as RequirementItemV2["kind"],
    priority: item.priority as RequirementItemV2["priority"],
    statement,
    acceptance_facet_ids: facetIds,
    source_span_ids: spanIds,
    trace_root_sha256: traceRootSha256,
  };
  return sealed("PCH-REQUIREMENT-ITEM-V2", body);
}

export function finalizeRequirementRevisionV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly revision: number;
  readonly contract_revision?: number;
  readonly parent_requirement_revision_id: string | null;
  readonly parent_requirement_revision_sha256: string | null;
  readonly proposal_origin: TypedProposalOriginV2;
  readonly items: readonly RequirementItemProposalV2[];
  readonly created_at_ms: number;
}): RequirementRevisionClosureV2 {
  const revisionNumber = positiveInteger(input.revision, "Requirement revision", 1_000_000);
  const contractRevision = positiveInteger(input.contract_revision ?? revisionNumber, "Requirement contract revision", 1_000_000);
  if (!proposalOrigins.has(input.proposal_origin)) throw new TypeError("Requirement proposal origin is invalid");
  if ((revisionNumber === 1) !== (input.parent_requirement_revision_id === null && input.parent_requirement_revision_sha256 === null)) {
    throw new TypeError("Requirement revision parent identity is invalid");
  }
  if (revisionNumber > 1) {
    boundedText(input.parent_requirement_revision_id, "Parent requirement revision ID", 160);
    nullableSha(input.parent_requirement_revision_sha256, "Parent requirement revision hash");
  }
  const itemCandidates: unknown = input.items;
  if (!Array.isArray(itemCandidates) || itemCandidates.length < 1 || itemCandidates.length > 512) {
    throw new TypeError("Requirement revision must contain 1..512 typed items");
  }
  const createdAtMs = timestamp(input.created_at_ms, "Requirement revision timestamp");
  const authority = input.acceptance.authority;
  const index = acceptanceIndex(input.acceptance);
  const itemProposalRoot = canonicalJsonSha256(input.items.map((item) => ({
    ...item,
    statement: boundedText(item.statement, "Requirement item statement", 32_768),
    acceptance_facet_ids: [...item.acceptance_facet_ids].sort(),
    source_span_ids: [...item.source_span_ids].sort(),
  })).sort((left, right) => left.key.localeCompare(right.key)));
  const requirementRevisionId = idFromSha256("REQUIREMENT_REVISION", canonicalJsonSha256({
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    revision: revisionNumber,
    contract_revision: contractRevision,
    parent_requirement_revision_sha256: input.parent_requirement_revision_sha256,
    proposal_origin: input.proposal_origin,
    item_proposal_root_sha256: itemProposalRoot,
  }));
  const items = input.items.map((proposal) => normalizeRequirementItem(
    proposal, index, authority.goal_id, authority.contract_id, authority.authority_root_id, requirementRevisionId,
  )).sort((left, right) => left.semantic_key.localeCompare(right.semantic_key));
  if (new Set(items.map((item) => item.semantic_key)).size !== items.length) throw new TypeError("Requirement revision repeats a semantic key");
  const coveredFacetIds = new Set(items.flatMap((item) => item.acceptance_facet_ids));
  const uncoveredFacetIds = input.acceptance.facets
    .map((facet) => facet.facet_id)
    .filter((facetId) => !coveredFacetIds.has(facetId));
  if (uncoveredFacetIds.length > 0) {
    throw new TypeError(`Requirement revision must cover every Acceptance facet; missing ${uncoveredFacetIds.join(",")}`);
  }
  const requirementsRootSha256 = memberRoot("PCH-REQUIREMENT-ROOT-V2", items.map((item) => item.record_sha256));
  const inputClosureSha256 = canonicalJsonSha256({
    authority_root_id: authority.authority_root_id,
    source_root_sha256: authority.source_root_sha256,
    span_root_sha256: authority.span_root_sha256,
    facet_root_sha256: authority.facet_root_sha256,
    requirements_root_sha256: requirementsRootSha256,
    parent_requirement_revision_sha256: input.parent_requirement_revision_sha256,
  });
  const body = {
    schema_version: 2 as const,
    requirement_revision_id: requirementRevisionId,
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    source_revision_id: authority.source_revision_id,
    revision: revisionNumber,
    contract_revision: contractRevision,
    parent_requirement_revision_id: input.parent_requirement_revision_id,
    parent_requirement_revision_sha256: input.parent_requirement_revision_sha256,
    proposal_origin: input.proposal_origin,
    source_root_sha256: authority.source_root_sha256,
    span_root_sha256: authority.span_root_sha256,
    facet_root_sha256: authority.facet_root_sha256,
    requirements_root_sha256: requirementsRootSha256,
    input_closure_sha256: inputClosureSha256,
    item_count: items.length,
    created_at_ms: createdAtMs,
  };
  return { revision: sealed("PCH-REQUIREMENT-REVISION-V2", body), items };
}

export function finalizeDecisionRequirementsV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly proposals: readonly DecisionRequirementProposalV2[];
}): readonly DecisionRequirementV2[] {
  assertRequirementRevisionClosureV2(input.requirement);
  const authority = input.acceptance.authority;
  if (authority.authority_root_id !== input.requirement.revision.authority_root_id) throw new TypeError("Decision Acceptance authority is stale");
  const acceptance = acceptanceIndex(input.acceptance);
  if (!Array.isArray(input.proposals) || input.proposals.length < 1 || input.proposals.length > 256) {
    throw new TypeError("Decision frontier must contain 1..256 typed requirements");
  }
  const requirementsByKey = new Map(input.requirement.items.map((item) => [item.semantic_key, item]));
  const records = input.proposals.map((proposal): DecisionRequirementV2 => {
    const item = record(proposal, "Decision requirement proposal");
    exactKeys(item, [
      "key", "kind", "question", "materiality", "blocking", "affected_requirement_keys", "source_span_ids",
      "trigger", "latest_resolution_stage", "default", "reversibility", "affected_work_cell_ids", "proposal_origin",
    ], "Decision requirement proposal");
    if (typeof item.key !== "string" || !semanticKeyPattern.test(item.key)) throw new TypeError("Decision key is invalid");
    if (typeof item.kind !== "string" || !decisionKinds.has(item.kind)) throw new TypeError("Decision kind is invalid");
    const question = boundedText(item.question, "Decision question", 8_192);
    if (typeof item.materiality !== "string" || !materialities.has(item.materiality)) throw new TypeError("Decision materiality is invalid");
    if (typeof item.blocking !== "boolean") throw new TypeError("Decision blocking flag is invalid");
    const affectedKeys = uniqueSorted(item.affected_requirement_keys, "Decision affected requirements", 1, 512);
    const affectedRequirementIds = affectedKeys.map((key) => {
      const found = requirementsByKey.get(key);
      if (!found) throw new TypeError(`Decision references foreign requirement key ${key}`);
      return found.requirement_id;
    }).sort();
    const sourceSpanIds = uniqueSorted(item.source_span_ids, "Decision source spans", 1, 64);
    for (const spanId of sourceSpanIds) if (!acceptance.spans.has(spanId)) throw new TypeError(`Decision references foreign source span ${spanId}`);
    const affectedSourceSpans = new Set(affectedKeys.flatMap((key) => requirementsByKey.get(key)!.source_span_ids));
    if (!sourceSpanIds.some((spanId) => affectedSourceSpans.has(spanId))) {
      throw new TypeError("Decision source spans do not trace to any affected Requirement");
    }
    const trigger = record(item.trigger, "Decision trigger");
    exactKeys(trigger, ["kind", "evidence_sha256"], "Decision trigger");
    if (typeof trigger.kind !== "string" || !triggerKinds.has(trigger.kind)) throw new TypeError("Decision trigger kind is invalid");
    const triggerSha256 = canonicalJsonSha256({ kind: trigger.kind, evidence_sha256: sha(trigger.evidence_sha256, "Decision trigger evidence") });
    const latestStage = item.latest_resolution_stage as GoalFitGateV2;
    stageIndex(latestStage);
    const decisionDefault = record(item.default, "Decision default");
    exactKeys(decisionDefault, ["action", "value"], "Decision default");
    if (decisionDefault.action !== "APPROVE" && decisionDefault.action !== "REJECT") throw new TypeError("Decision default action is invalid");
    const defaultAction: DecisionRequirementV2["default_action"] = decisionDefault.action;
    if ((item.materiality === "HIGH" || item.materiality === "CRITICAL") && decisionDefault.action === "APPROVE") {
      throw new TypeError("High-materiality Decisions cannot default to approval");
    }
    if (item.blocking === true && (trigger.kind !== "IMMEDIATE"
      || stageIndex(latestStage) > stageIndex("CONTRACT_FREEZE") || defaultAction !== "REJECT")) {
      throw new TypeError("blocking Decisions require immediate USER authority before Contract freeze and a rejecting default");
    }
    const defaultValue = canonicalValue(decisionDefault.value, "Decision default value");
    const defaultSha256 = canonicalJsonSha256({ action: decisionDefault.action, value: defaultValue });
    if (typeof item.reversibility !== "string" || !reversibilities.has(item.reversibility)) throw new TypeError("Decision reversibility is invalid");
    if (item.reversibility === "IRREVERSIBLE"
      && (item.blocking !== true || defaultAction !== "REJECT"
        || stageIndex(latestStage) > stageIndex("IRREVERSIBLE_ARCHITECTURE"))) {
      throw new TypeError("Irreversible Decisions require blocking USER authority before the irreversible architecture gate");
    }
    const workCellIds = uniqueSorted(item.affected_work_cell_ids, "Decision affected WorkCells", 0, 1024);
    const proposalOrigin = item.proposal_origin as TypedProposalOriginV2;
    if (!proposalOrigins.has(proposalOrigin)) throw new TypeError("Decision proposal origin is invalid");
    if (item.kind === "DRAFT_REVIEW") {
      const completeRequirementIds = input.requirement.items.map((requirement) => requirement.requirement_id).sort();
      if ((item.materiality !== "HIGH" && item.materiality !== "CRITICAL") || item.blocking !== true
        || latestStage !== "CONTRACT_FREEZE" || defaultAction !== "REJECT"
        || canonicalJson(affectedRequirementIds) !== canonicalJson(completeRequirementIds)) {
        throw new TypeError("Draft review must be user-blocking and bind the complete Requirement closure");
      }
    }
    const decisionRequirementId = idFromSha256("DECISION_REQUIREMENT", canonicalJsonSha256({
      goal_id: authority.goal_id, decision_key: item.key,
    }));
    const body = {
      schema_version: 2 as const,
      decision_requirement_revision_id: idFromSha256("DECISION_REQUIREMENT_REVISION", canonicalJsonSha256({
        decision_requirement_id: decisionRequirementId,
        requirement_revision_id: input.requirement.revision.requirement_revision_id,
        question,
        kind: item.kind,
        materiality: item.materiality,
        blocking: item.blocking,
        affected_requirement_ids: affectedRequirementIds,
        source_span_ids: sourceSpanIds,
        trigger_sha256: triggerSha256,
        latest_resolution_stage: latestStage,
        default_sha256: defaultSha256,
        reversibility: item.reversibility,
        affected_work_cell_ids: workCellIds,
        proposal_origin: proposalOrigin,
      })),
      decision_requirement_id: decisionRequirementId,
      requirement_revision_id: input.requirement.revision.requirement_revision_id,
      goal_id: authority.goal_id,
      contract_id: authority.contract_id,
      authority_root_id: authority.authority_root_id,
      decision_key: item.key,
      kind: item.kind as DecisionRequirementV2["kind"],
      question,
      materiality: item.materiality as DecisionRequirementV2["materiality"],
      blocking: item.blocking,
      affected_requirement_ids: affectedRequirementIds,
      source_span_ids: sourceSpanIds,
      trigger_kind: trigger.kind as DecisionRequirementV2["trigger_kind"],
      trigger_sha256: triggerSha256,
      latest_resolution_stage: latestStage,
      default_action: defaultAction,
      default_value: defaultValue,
      default_sha256: defaultSha256,
      reversibility: item.reversibility as DecisionRequirementV2["reversibility"],
      affected_work_cell_ids: workCellIds,
      proposal_origin: proposalOrigin,
    };
    return sealed("PCH-DECISION-REQUIREMENT-V2", body);
  }).sort((left, right) => left.decision_key.localeCompare(right.decision_key));
  if (new Set(records.map((item) => item.decision_key)).size !== records.length) throw new TypeError("Decision frontier repeats a decision key");
  if (records.filter((item) => item.kind === "DRAFT_REVIEW").length > 1) throw new TypeError("Decision frontier repeats draft review authority");
  return records;
}

export function decisionFrontierSha256V2(decisions: readonly DecisionRequirementV2[]): string {
  if (decisions.length < 1 || decisions.length > 256) {
    throw new TypeError("Decision frontier must contain 1..256 finalized requirements");
  }
  decisions.forEach(assertDecisionRequirementV2);
  const requirementRevisionId = decisions[0]!.requirement_revision_id;
  if (decisions.some((decision) => decision.requirement_revision_id !== requirementRevisionId)) {
    throw new TypeError("Decision frontier mixes Requirement revisions");
  }
  return memberRoot("PCH-DECISION-REQUIREMENT-ROOT-V2", decisions.map((decision) => decision.record_sha256));
}

export function decisionDeadlineTriggerSha256V2(decision: DecisionRequirementV2): string {
  assertDecisionRequirementV2(decision);
  return canonicalJsonSha256({ kind: "STAGE_ENTRY", gate: decision.latest_resolution_stage });
}

function actionPayload(input: {
  readonly decision: DecisionRequirementV2;
  readonly action: DecisionActionV2;
  readonly selected_value: CanonicalJson;
  readonly edited_requirement_revision_id: string | null;
  readonly deferred_trigger_sha256: string | null;
}): {
  readonly selected_value: CanonicalJson;
  readonly selected_value_sha256: string;
  readonly action_payload_sha256: string;
} {
  if (!actions.has(input.action)) throw new TypeError("Decision resolution action is invalid");
  const selectedValue = canonicalValue(input.selected_value, "Decision selected value");
  const selectedValueSha256 = canonicalJsonSha256(selectedValue);
  if (input.action === "EDIT") {
    boundedText(input.edited_requirement_revision_id, "Edited requirement revision ID", 160);
    if (input.deferred_trigger_sha256 !== null) throw new TypeError("EDIT cannot carry a deferred trigger");
  } else if (input.action === "DEFER") {
    if (input.decision.blocking) throw new TypeError("blocking Decisions cannot be deferred");
    if (input.edited_requirement_revision_id !== null || input.deferred_trigger_sha256 !== input.decision.trigger_sha256) {
      throw new TypeError("DEFER must bind the frozen Decision trigger");
    }
  } else if (input.edited_requirement_revision_id !== null || input.deferred_trigger_sha256 !== null) {
    throw new TypeError(`${input.action} cannot carry edit or defer authority`);
  }
  return {
    selected_value: selectedValue,
    selected_value_sha256: selectedValueSha256,
    action_payload_sha256: canonicalJsonSha256({
      action: input.action,
      selected_value_sha256: selectedValueSha256,
      edited_requirement_revision_id: input.edited_requirement_revision_id,
      deferred_trigger_sha256: input.deferred_trigger_sha256,
    }),
  };
}

export function decisionActionPayloadSha256V2(input: {
  readonly decision: DecisionRequirementV2;
  readonly action: DecisionActionV2;
  readonly selected_value: CanonicalJson;
  readonly edited_requirement_revision_id: string | null;
  readonly deferred_trigger_sha256: string | null;
}): string {
  return actionPayload(input).action_payload_sha256;
}

export function userDecisionAuthorityInputSourceV2(input: {
  readonly requirement_revision_sha256: string;
  readonly decision_requirement_revision_id: string;
  readonly decision_frontier_sha256: string;
  readonly action: DecisionActionV2;
  readonly action_payload_sha256: string;
  readonly at_gate: GoalFitGateV2;
  readonly session_id: string;
  readonly turn_id: string;
  readonly event_head_sha256: string;
}): string {
  return canonicalJson({ domain: "PCH-USER-DECISION-ACTION-V2", ...input });
}

export function finalizeDecisionDueEventReceiptV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decision: DecisionRequirementV2;
  readonly purpose: DecisionDueEventPurposeV2;
  readonly trigger_kind: Exclude<DecisionRequirementV2["trigger_kind"], "IMMEDIATE">;
  readonly trigger_sha256: string;
  readonly at_gate: GoalFitGateV2;
  readonly event_evidence_sha256: string;
  readonly event_head_sha256: string;
  readonly predecessor_resolution_sha256: string;
  readonly created_at_ms: number;
}): DecisionDueEventReceiptV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionRequirementV2(input.decision);
  if (input.acceptance.authority.authority_root_id !== input.requirement.revision.authority_root_id
    || input.decision.requirement_revision_id !== input.requirement.revision.requirement_revision_id) {
    throw new TypeError("Decision due event is outside the current authority closure");
  }
  stageIndex(input.at_gate);
  const triggerSha256 = sha(input.trigger_sha256, "Decision due trigger hash");
  if (input.purpose === "DEFAULT_DEADLINE") {
    if (input.trigger_kind !== "STAGE_ENTRY" || input.at_gate !== input.decision.latest_resolution_stage
      || triggerSha256 !== decisionDeadlineTriggerSha256V2(input.decision)) {
      throw new TypeError("Decision default requires its exact Host-observed deadline event");
    }
  } else if (input.purpose === "DEFERRED_TRIGGER") {
    if (input.decision.trigger_kind === "IMMEDIATE" || input.trigger_kind !== input.decision.trigger_kind
      || triggerSha256 !== input.decision.trigger_sha256) {
      throw new TypeError("Decision deferral due event does not match its frozen asynchronous trigger");
    }
  } else throw new TypeError("Decision due event purpose is invalid");
  const body = {
    schema_version: 2 as const,
    due_event_receipt_id: idFromSha256("DECISION_DUE_EVENT", canonicalJsonSha256({
      decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
      requirement_revision_sha256: input.requirement.revision.record_sha256,
      purpose: input.purpose,
      trigger_sha256: triggerSha256,
      at_gate: input.at_gate,
      event_evidence_sha256: sha(input.event_evidence_sha256, "Decision due event evidence"),
      event_head_sha256: sha(input.event_head_sha256, "Decision due event head"),
      predecessor_resolution_sha256: sha(input.predecessor_resolution_sha256, "Decision due predecessor resolution"),
    })),
    goal_id: input.decision.goal_id,
    contract_id: input.decision.contract_id,
    authority_root_id: input.decision.authority_root_id,
    decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    requirement_revision_sha256: input.requirement.revision.record_sha256,
    purpose: input.purpose,
    trigger_kind: input.trigger_kind,
    trigger_sha256: triggerSha256,
    at_gate: input.at_gate,
    event_evidence_sha256: sha(input.event_evidence_sha256, "Decision due event evidence"),
    event_head_sha256: sha(input.event_head_sha256, "Decision due event head"),
    predecessor_resolution_sha256: sha(input.predecessor_resolution_sha256, "Decision due predecessor resolution"),
    captured_by: "HOST" as const,
    created_at_ms: timestamp(input.created_at_ms, "Decision due event timestamp"),
  };
  return sealed("PCH-DECISION-DUE-EVENT-V2", body);
}

export function hostDefaultAuthorityInputSourceV2(
  decision: DecisionRequirementV2,
  dueEvent: DecisionDueEventReceiptV2,
  requirementRevisionSha256: string,
  decisionFrontierSha256: string,
): string {
  assertDecisionRequirementV2(decision);
  assertDecisionDueEventReceiptV2(dueEvent);
  return canonicalJson({
    domain: "PCH-HOST-DEFAULT-DUE-V2",
    decision_requirement_revision_id: decision.decision_requirement_revision_id,
    requirement_revision_sha256: requirementRevisionSha256,
    decision_frontier_sha256: decisionFrontierSha256,
    due_event_receipt_id: dueEvent.due_event_receipt_id,
    action: decision.default_action,
    value: decision.default_value,
    default_sha256: decision.default_sha256,
  });
}

export function finalizeDecisionAuthorityInputV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly decision: DecisionRequirementV2;
  readonly authority_actor: DecisionAuthorityActorV2;
  readonly action: DecisionActionV2;
  readonly at_gate: GoalFitGateV2;
  readonly selected_value: CanonicalJson;
  readonly edited_requirement_revision_id: string | null;
  readonly deferred_trigger_sha256: string | null;
  readonly source: string | Uint8Array;
  readonly session_id: string | null;
  readonly turn_id: string | null;
  readonly event_head_sha256: string;
  readonly due_event: DecisionDueEventReceiptV2 | null;
  readonly created_at_ms: number;
}): DecisionAuthorityInputBundleV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionRequirementV2(input.decision);
  if (!actors.has(input.authority_actor)) throw new TypeError("Decision authority input actor is invalid");
  if (input.acceptance.authority.authority_root_id !== input.requirement.revision.authority_root_id
    || input.decision.requirement_revision_id !== input.requirement.revision.requirement_revision_id) {
    throw new TypeError("Decision authority input is outside the current authority closure");
  }
  const frontierSha256 = decisionFrontierSha256V2(input.decisions);
  if (!input.decisions.some((decision) => decision.decision_requirement_revision_id === input.decision.decision_requirement_revision_id)) {
    throw new TypeError("Decision authority input is outside the complete Decision frontier");
  }
  stageIndex(input.at_gate);
  const payload = actionPayload(input);
  const eventHeadSha256 = sha(input.event_head_sha256, "Decision authority event head");
  let expectedSource: string;
  if (input.authority_actor === "USER") {
    if (input.due_event !== null) throw new TypeError("USER Decision authority cannot use a due event");
    const sessionId = boundedText(input.session_id, "Decision authority session ID", 160);
    const turnId = boundedText(input.turn_id, "Decision authority turn ID", 160);
    expectedSource = userDecisionAuthorityInputSourceV2({
      requirement_revision_sha256: input.requirement.revision.record_sha256,
      decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
      decision_frontier_sha256: frontierSha256,
      action: input.action,
      action_payload_sha256: payload.action_payload_sha256,
      at_gate: input.at_gate,
      session_id: sessionId,
      turn_id: turnId,
      event_head_sha256: eventHeadSha256,
    });
  } else {
    if (input.session_id !== null || input.turn_id !== null || input.due_event === null) {
      throw new TypeError("HOST_DEFAULT Decision authority requires a DueEventReceipt and no user turn identity");
    }
    assertDecisionDueEventReceiptV2(input.due_event);
    if (input.due_event.purpose !== "DEFAULT_DEADLINE"
      || input.due_event.decision_requirement_revision_id !== input.decision.decision_requirement_revision_id
      || input.due_event.requirement_revision_sha256 !== input.requirement.revision.record_sha256
      || input.action !== input.decision.default_action
      || payload.selected_value_sha256 !== canonicalJsonSha256(input.decision.default_value)) {
      throw new TypeError("Host default is not bound to the exact frozen default and due event");
    }
    expectedSource = hostDefaultAuthorityInputSourceV2(
      input.decision, input.due_event, input.requirement.revision.record_sha256, frontierSha256,
    );
  }
  const bytes = typeof input.source === "string" ? Buffer.from(input.source, "utf8") : Buffer.from(input.source);
  if (bytes.length < 1 || bytes.length > 131_072) throw new TypeError("Decision authority input must contain 1..131072 UTF-8 bytes");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new TypeError("Decision authority input must contain exact UTF-8 bytes");
  }
  if (!bytes.equals(Buffer.from(expectedSource, "utf8"))) {
    throw new TypeError("Decision authority input bytes do not match the exact structured action envelope");
  }
  const contentSha256 = sha256Hex(bytes);
  const createdAtMs = timestamp(input.created_at_ms, "Decision authority input timestamp");
  const authority = input.acceptance.authority;
  const body = {
    schema_version: 2 as const,
    authority_input_receipt_id: idFromSha256("DECISION_INPUT", canonicalJsonSha256({
      decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
      requirement_revision_sha256: input.requirement.revision.record_sha256,
      decision_frontier_sha256: frontierSha256,
      action_payload_sha256: payload.action_payload_sha256,
      authority_actor: input.authority_actor,
      content_sha256: contentSha256,
      event_head_sha256: eventHeadSha256,
      created_at_ms: createdAtMs,
    })),
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    requirement_revision_sha256: input.requirement.revision.record_sha256,
    decision_frontier_sha256: frontierSha256,
    action: input.action,
    action_payload_sha256: payload.action_payload_sha256,
    at_gate: input.at_gate,
    authority_actor: input.authority_actor,
    source_kind: input.authority_actor === "USER" ? "USER_TURN" as const : "HOST_DEFAULT_DUE" as const,
    session_id: input.session_id,
    turn_id: input.turn_id,
    event_head_sha256: eventHeadSha256,
    due_event_receipt_id: input.due_event?.due_event_receipt_id ?? null,
    content_sha256: contentSha256,
    byte_length: bytes.length,
    encoding: "UTF-8" as const,
    fidelity: "EXACT" as const,
    captured_by: "HOST" as const,
    created_at_ms: createdAtMs,
  };
  return { receipt: sealed("PCH-DECISION-AUTHORITY-INPUT-V2", body), source_bytes: bytes };
}

export function finalizeDecisionResolutionV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly decision: DecisionRequirementV2;
  readonly authority_input: DecisionAuthorityInputReceiptV2;
  readonly due_event: DecisionDueEventReceiptV2 | null;
  readonly resolution_revision: number;
  readonly parent_resolution_id: string | null;
  readonly action: DecisionActionV2;
  readonly authority_actor: DecisionAuthorityActorV2;
  readonly at_stage: GoalFitGateV2;
  readonly authority_source_span_id: string | null;
  readonly selected_value: CanonicalJson;
  readonly edited_requirement_revision_id: string | null;
  readonly deferred_trigger_sha256: string | null;
  readonly created_at_ms: number;
}): DecisionResolutionV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionRequirementV2(input.decision);
  assertDecisionAuthorityInputReceiptV2(input.authority_input);
  const frontierSha256 = decisionFrontierSha256V2(input.decisions);
  const payload = actionPayload(input);
  if (input.acceptance.authority.authority_root_id !== input.decision.authority_root_id
    || input.decision.requirement_revision_id !== input.requirement.revision.requirement_revision_id
    || input.authority_input.goal_id !== input.decision.goal_id
    || input.authority_input.contract_id !== input.decision.contract_id
    || input.authority_input.authority_root_id !== input.decision.authority_root_id
    || input.authority_input.decision_requirement_revision_id !== input.decision.decision_requirement_revision_id
    || input.authority_input.requirement_revision_sha256 !== input.requirement.revision.record_sha256
    || input.authority_input.decision_frontier_sha256 !== frontierSha256
    || input.authority_input.action !== input.action
    || input.authority_input.action_payload_sha256 !== payload.action_payload_sha256
    || input.authority_input.at_gate !== input.at_stage
    || input.authority_input.authority_actor !== input.authority_actor) {
    throw new TypeError("Decision resolution authority input receipt is outside the exact frozen action closure");
  }
  if ((input.due_event?.due_event_receipt_id ?? null) !== input.authority_input.due_event_receipt_id) {
    throw new TypeError("Decision resolution DueEventReceipt binding is invalid");
  }
  const revision = positiveInteger(input.resolution_revision, "Decision resolution revision", 1_000_000);
  if ((revision === 1) !== (input.parent_resolution_id === null)) throw new TypeError("Decision resolution parent identity is invalid");
  if (revision > 1) boundedText(input.parent_resolution_id, "Decision parent resolution ID", 160);
  if (!actors.has(input.authority_actor)) throw new TypeError("Decision resolution actor is invalid");
  stageIndex(input.at_stage);
  if (input.authority_source_span_id !== null && !acceptanceIndex(input.acceptance).spans.has(input.authority_source_span_id)) {
    throw new TypeError("Decision resolution source span is foreign");
  }
  const resolutionInputSha256 = input.authority_input.content_sha256;
  const body = {
    schema_version: 2 as const,
    decision_resolution_id: idFromSha256("DECISION_RESOLUTION", canonicalJsonSha256({
      decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
      resolution_revision: revision,
      parent_resolution_id: input.parent_resolution_id,
      action: input.action,
      authority_actor: input.authority_actor,
      at_stage: input.at_stage,
      decision_frontier_sha256: frontierSha256,
      action_payload_sha256: payload.action_payload_sha256,
      authority_input_receipt_id: input.authority_input.authority_input_receipt_id,
      due_event_receipt_id: input.due_event?.due_event_receipt_id ?? null,
      resolution_input_sha256: resolutionInputSha256,
      authority_source_span_id: input.authority_source_span_id,
      selected_value_sha256: payload.selected_value_sha256,
      edited_requirement_revision_id: input.edited_requirement_revision_id,
      deferred_trigger_sha256: input.deferred_trigger_sha256,
    })),
    decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
    decision_requirement_id: input.decision.decision_requirement_id,
    requirement_revision_id: input.decision.requirement_revision_id,
    goal_id: input.decision.goal_id,
    contract_id: input.decision.contract_id,
    authority_root_id: input.decision.authority_root_id,
    resolution_revision: revision,
    parent_resolution_id: input.parent_resolution_id,
    action: input.action,
    authority_actor: input.authority_actor,
    at_stage: input.at_stage,
    decision_frontier_sha256: frontierSha256,
    action_payload_sha256: payload.action_payload_sha256,
    authority_input_receipt_id: input.authority_input.authority_input_receipt_id,
    due_event_receipt_id: input.due_event?.due_event_receipt_id ?? null,
    resolution_input_sha256: resolutionInputSha256,
    authority_source_span_id: input.authority_source_span_id,
    selected_value: payload.selected_value,
    selected_value_sha256: payload.selected_value_sha256,
    edited_requirement_revision_id: input.edited_requirement_revision_id,
    deferred_trigger_sha256: input.deferred_trigger_sha256,
    created_at_ms: timestamp(input.created_at_ms, "Decision resolution timestamp"),
  };
  return sealed("PCH-DECISION-RESOLUTION-V2", body);
}

export function evaluateDecisionClosureV2(input: {
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly resolutions: readonly DecisionResolutionV2[];
  readonly due_events?: readonly DecisionDueEventReceiptV2[];
  readonly gate: GoalFitGateV2;
  readonly created_at_ms: number;
}): DecisionClosureBundleV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  stageIndex(input.gate);
  const decisionByRevision = new Map<string, DecisionRequirementV2>();
  for (const decision of input.decisions) {
    assertDecisionRequirementV2(decision);
    if (decision.requirement_revision_id !== input.requirement.revision.requirement_revision_id) throw new TypeError("Decision belongs to another requirement revision");
    if (decisionByRevision.has(decision.decision_requirement_revision_id)) throw new TypeError("Decision closure repeats a Decision requirement");
    decisionByRevision.set(decision.decision_requirement_revision_id, decision);
  }
  if (decisionByRevision.size < 1) throw new TypeError("Decision closure requires at least one typed Decision requirement");
  const decisionRootSha256 = decisionFrontierSha256V2([...decisionByRevision.values()]);
  const latestResolution = new Map<string, DecisionResolutionV2>();
  for (const resolution of input.resolutions) {
    assertDecisionResolutionV2(resolution);
    const decision = decisionByRevision.get(resolution.decision_requirement_revision_id);
    if (!decision || resolution.requirement_revision_id !== input.requirement.revision.requirement_revision_id) {
      throw new TypeError("Decision resolution is outside the current Decision frontier");
    }
    if (stageIndex(resolution.at_stage) > stageIndex(input.gate)) continue;
    // Draft approval attests the complete contract frontier. Other immutable
    // Decisions retain their own resolution when an independent Decision is appended.
    if (decision.kind === "DRAFT_REVIEW" && resolution.decision_frontier_sha256 !== decisionRootSha256) {
      continue;
    }
    const existing = latestResolution.get(resolution.decision_requirement_revision_id);
    if (!existing || resolution.resolution_revision > existing.resolution_revision) latestResolution.set(resolution.decision_requirement_revision_id, resolution);
  }
  const dueDecisionRevisions = new Set((input.due_events ?? []).flatMap((event) => {
    assertDecisionDueEventReceiptV2(event);
    if (event.requirement_revision_sha256 !== input.requirement.revision.record_sha256) {
      throw new TypeError("Decision due event belongs to another Requirement revision");
    }
    return [event.decision_requirement_revision_id];
  }));
  const members: DecisionClosureMemberV2[] = [...decisionByRevision.values()]
    .sort((left, right) => left.decision_requirement_id.localeCompare(right.decision_requirement_id))
    .map((decision) => {
      const resolution = latestResolution.get(decision.decision_requirement_revision_id) ?? null;
      const due = resolution?.action === "DEFER"
        ? dueDecisionRevisions.has(decision.decision_requirement_revision_id)
          || stageIndex(input.gate) >= stageIndex(decision.latest_resolution_stage)
        : false;
      const state = resolution === null ? "UNRESOLVED"
        : resolution.action === "APPROVE" ? "APPROVED"
          : resolution.action === "REJECT" ? "REJECTED"
            : resolution.action === "EDIT" ? "EDITED"
              : due ? "DUE_DEFERRED" : "DEFERRED";
      return {
        decision_requirement_revision_id: decision.decision_requirement_revision_id,
        decision_requirement_id: decision.decision_requirement_id,
        decision_resolution_id: resolution?.decision_resolution_id ?? null,
        state,
      };
    });
  const ids = (state: DecisionClosureMemberV2["state"]): readonly string[] => members
    .filter((member) => member.state === state).map((member) => member.decision_requirement_id).sort();
  const unresolved = ids("UNRESOLVED");
  const rejected = ids("REJECTED");
  const edited = ids("EDITED");
  const deferred = ids("DEFERRED");
  const dueDeferred = ids("DUE_DEFERRED");
  const completeRequirementIds = input.requirement.items.map((item) => item.requirement_id).sort();
  const draftReviews = [...decisionByRevision.values()].filter((decision) => decision.kind === "DRAFT_REVIEW");
  const draftReviewApproved = draftReviews.length === 1 && canonicalJson(draftReviews[0]!.affected_requirement_ids) === canonicalJson(completeRequirementIds)
    && members.some((member) => member.decision_requirement_revision_id === draftReviews[0]!.decision_requirement_revision_id
      && member.state === "APPROVED" && latestResolution.get(member.decision_requirement_revision_id)?.authority_actor === "USER");
  const qualified = unresolved.length === 0 && rejected.length === 0 && edited.length === 0 && dueDeferred.length === 0
    && (input.gate !== "CONTRACT_FREEZE" || draftReviewApproved);
  const resolutionRootSha256 = memberRoot("PCH-DECISION-RESOLUTION-ROOT-V2", [...latestResolution.values()].map((item) => item.record_sha256));
  const memberRootSha256 = canonicalJsonSha256({ domain: "PCH-DECISION-CLOSURE-MEMBERS-V2", members });
  const createdAtMs = timestamp(input.created_at_ms, "Decision closure timestamp");
  const body = {
    schema_version: 2 as const,
    decision_closure_id: idFromSha256("DECISION_CLOSURE", canonicalJsonSha256({
      requirement_revision_id: input.requirement.revision.requirement_revision_id,
      gate: input.gate,
      decision_root_sha256: decisionRootSha256,
      resolution_root_sha256: resolutionRootSha256,
      member_root_sha256: memberRootSha256,
    })),
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    goal_id: input.requirement.revision.goal_id,
    contract_id: input.requirement.revision.contract_id,
    authority_root_id: input.requirement.revision.authority_root_id,
    gate: input.gate,
    decision_root_sha256: decisionRootSha256,
    resolution_root_sha256: resolutionRootSha256,
    member_root_sha256: memberRootSha256,
    unresolved_decision_ids: unresolved,
    rejected_decision_ids: rejected,
    edited_decision_ids: edited,
    deferred_decision_ids: deferred,
    due_deferred_decision_ids: dueDeferred,
    draft_review_approved: draftReviewApproved,
    qualified,
    created_at_ms: createdAtMs,
  };
  return { closure: sealed("PCH-DECISION-CLOSURE-V2", body), members };
}

function expectedGateSubjectKind(gate: GoalFitGateV2): GoalFitGateSubjectKindV2 {
  if (gate === "CONTRACT_REVIEW" || gate === "CONTRACT_FREEZE") return "REQUIREMENT_REVISION";
  if (gate === "PLAN_ENTRY" || gate === "IRREVERSIBLE_ARCHITECTURE") return "PLAN_REVISION";
  if (gate === "MATERIAL_CHANGE") return "CHANGE_ACCEPTANCE_CLOSURE";
  if (gate === "REPEATED_FAILURE") return "FAILURE_RECEIPT";
  return "DELIVERABLE_MANIFEST";
}

export function finalizeGoalFitGateInstanceReceiptV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly gate: GoalFitGateV2;
  readonly gate_subject: {
    readonly kind: GoalFitGateSubjectKindV2;
    readonly id: string;
    readonly record_sha256: string;
  };
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
}): GoalFitGateInstanceReceiptV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionClosureV2(input.decision_closure);
  stageIndex(input.gate);
  const authority = input.acceptance.authority;
  const requirement = input.requirement.revision;
  const closure = input.decision_closure.closure;
  if (authority.authority_root_id !== requirement.authority_root_id
    || closure.requirement_revision_id !== requirement.requirement_revision_id
    || closure.gate !== input.gate) {
    throw new TypeError("Goal Fit gate instance input closure is stale");
  }
  if (!gateSubjectKinds.has(input.gate_subject.kind)
    || input.gate_subject.kind !== expectedGateSubjectKind(input.gate)) {
    throw new TypeError("Goal Fit gate subject kind does not match the gate");
  }
  const gateSubjectId = boundedText(input.gate_subject.id, "Goal Fit gate subject ID", 160);
  const gateSubjectSha256 = sha(input.gate_subject.record_sha256, "Goal Fit gate subject hash");
  if (input.gate_subject.kind === "REQUIREMENT_REVISION"
    && (gateSubjectId !== requirement.requirement_revision_id || gateSubjectSha256 !== requirement.record_sha256)) {
    throw new TypeError("Goal Fit Requirement gate subject is stale");
  }
  const hostEvidence = [...new Set([
    authority.record_sha256,
    input.acceptance.source.record_sha256,
    authority.source_root_sha256,
    authority.span_root_sha256,
    authority.facet_root_sha256,
    authority.obligation_root_sha256,
    authority.binding_root_sha256,
    authority.evidence_requirement_root_sha256,
    requirement.record_sha256,
    requirement.source_root_sha256,
    requirement.span_root_sha256,
    requirement.facet_root_sha256,
    requirement.requirements_root_sha256,
    closure.record_sha256,
    closure.decision_root_sha256,
    closure.resolution_root_sha256,
    closure.member_root_sha256,
    gateSubjectSha256,
  ])].map((value) => sha(value, "Goal Fit Host evidence hash")).sort();
  const eventHeadSha256 = sha(input.event_head_sha256, "Goal Fit gate event head");
  const hostEvidenceRootSha256 = memberRoot("PCH-GOAL-FIT-HOST-EVIDENCE-V2", hostEvidence);
  const body = {
    schema_version: 2 as const,
    gate_instance_receipt_id: idFromSha256("GOAL_FIT_GATE_INSTANCE", canonicalJsonSha256({
      requirement_revision_sha256: requirement.record_sha256,
      decision_closure_sha256: closure.record_sha256,
      gate: input.gate,
      gate_subject_kind: input.gate_subject.kind,
      gate_subject_id: gateSubjectId,
      gate_subject_sha256: gateSubjectSha256,
      host_evidence_root_sha256: hostEvidenceRootSha256,
      event_head_sha256: eventHeadSha256,
    })),
    requirement_revision_id: requirement.requirement_revision_id,
    goal_id: requirement.goal_id,
    contract_id: requirement.contract_id,
    authority_root_id: requirement.authority_root_id,
    decision_closure_id: closure.decision_closure_id,
    gate: input.gate,
    gate_subject_kind: input.gate_subject.kind,
    gate_subject_id: gateSubjectId,
    gate_subject_sha256: gateSubjectSha256,
    requirement_revision_sha256: requirement.record_sha256,
    decision_closure_sha256: closure.record_sha256,
    host_evidence_sha256s: hostEvidence,
    host_evidence_root_sha256: hostEvidenceRootSha256,
    event_head_sha256: eventHeadSha256,
    created_at_ms: timestamp(input.created_at_ms, "Goal Fit gate instance timestamp"),
  };
  return sealed("PCH-GOAL-FIT-GATE-INSTANCE-V2", body);
}

function normalizeGoalFitFindingFacetProposal(
  value: GoalFitFindingFacetProposalV2,
  label: string,
): GoalFitFindingFacetProposalV2 {
  const facet = record(value, label);
  exactKeys(facet, ["status", "reason_codes", "coverage"], label);
  if (!assessmentStatuses.has(value.status)) throw new TypeError(`${label}.status is invalid`);
  const reasonCodes = uniqueSorted(value.reason_codes, `${label}.reason_codes`, 1, 64);
  if (reasonCodes.some((code) => !reasonCodePattern.test(code))) throw new TypeError(`${label}.reason_codes is invalid`);
  if (value.coverage !== "ALL_CURRENT" && value.coverage !== "NOT_APPLICABLE") {
    throw new TypeError(`${label}.coverage is invalid`);
  }
  if ((value.status === "NOT_APPLICABLE") !== (value.coverage === "NOT_APPLICABLE")) {
    throw new TypeError(`${label} NOT_APPLICABLE status and coverage must agree`);
  }
  return { status: value.status, reason_codes: reasonCodes, coverage: value.coverage };
}

function normalizeGoalFitAssessmentFacet(
  value: GoalFitAssessmentFacetV2,
  label: string,
): GoalFitAssessmentFacetV2 {
  const facet = record(value, label);
  exactKeys(facet, ["status", "reason_codes", "subject_ids", "evidence_receipt_sha256s"], label);
  if (!assessmentStatuses.has(value.status)) throw new TypeError(`${label}.status is invalid`);
  const reasonCodes = uniqueSorted(value.reason_codes, `${label}.reason_codes`, 1, 64);
  if (reasonCodes.some((code) => !reasonCodePattern.test(code))) throw new TypeError(`${label}.reason_codes is invalid`);
  const subjectIds = uniqueSorted(value.subject_ids, `${label}.subject_ids`, 0, 256);
  const evidence = uniqueSorted(value.evidence_receipt_sha256s, `${label}.evidence_receipt_sha256s`, 0, 256)
    .map((hash) => sha(hash, `${label}.evidence_receipt_sha256s`));
  if (value.status === "NOT_APPLICABLE" && (subjectIds.length > 0 || evidence.length > 0)) {
    throw new TypeError(`${label} NOT_APPLICABLE cannot claim subjects or evidence`);
  }
  if (value.status !== "NOT_APPLICABLE" && (subjectIds.length === 0 || evidence.length === 0)) {
    throw new TypeError(`${label} must have Host-derived subjects and evidence`);
  }
  return { status: value.status, reason_codes: reasonCodes, subject_ids: subjectIds, evidence_receipt_sha256s: evidence };
}

export function normalizeGoalFitAssessmentProposalV2(value: unknown): GoalFitAssessmentProposalV2 {
  const proposal = record(value, "Goal Fit assessment proposal");
  exactKeys(proposal, [
    "proposal_origin", "outcome_fidelity", "obligation_coverage", "unnecessary_design", "current_decisions",
    "invalidations", "gate_specific_evidence",
  ], "Goal Fit assessment proposal");
  if (!proposalOrigins.has(proposal.proposal_origin as TypedProposalOriginV2)) {
    throw new TypeError("Goal Fit proposal origin is invalid");
  }
  const normalized = {
    proposal_origin: proposal.proposal_origin as TypedProposalOriginV2,
    outcome_fidelity: normalizeGoalFitFindingFacetProposal(
      proposal.outcome_fidelity as GoalFitFindingFacetProposalV2, "Goal Fit outcome fidelity",
    ),
    obligation_coverage: normalizeGoalFitFindingFacetProposal(
      proposal.obligation_coverage as GoalFitFindingFacetProposalV2, "Goal Fit obligation coverage",
    ),
    unnecessary_design: normalizeGoalFitFindingFacetProposal(
      proposal.unnecessary_design as GoalFitFindingFacetProposalV2, "Goal Fit unnecessary design",
    ),
    current_decisions: normalizeGoalFitFindingFacetProposal(
      proposal.current_decisions as GoalFitFindingFacetProposalV2, "Goal Fit current Decisions",
    ),
    invalidations: normalizeGoalFitFindingFacetProposal(
      proposal.invalidations as GoalFitFindingFacetProposalV2, "Goal Fit invalidations",
    ),
    gate_specific_evidence: normalizeGoalFitFindingFacetProposal(
      proposal.gate_specific_evidence as GoalFitFindingFacetProposalV2, "Goal Fit gate-specific evidence",
    ),
  } satisfies GoalFitAssessmentProposalV2;
  if (normalized.gate_specific_evidence.status === "NOT_APPLICABLE") {
    throw new TypeError("Goal Fit gate-specific evidence cannot be NOT_APPLICABLE");
  }
  return normalized;
}

export function goalFitAssessmentProposalFromPersistedV2(
  assessment: GoalFitAssessmentV2,
): GoalFitAssessmentProposalV2 {
  assertGoalFitAssessmentV2(assessment);
  const proposalFacet = (facet: GoalFitAssessmentFacetV2): GoalFitFindingFacetProposalV2 => ({
    status: facet.status,
    reason_codes: facet.reason_codes,
    coverage: facet.status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "ALL_CURRENT",
  });
  return normalizeGoalFitAssessmentProposalV2({
    proposal_origin: assessment.proposal_origin,
    outcome_fidelity: proposalFacet(assessment.outcome_fidelity),
    obligation_coverage: proposalFacet(assessment.obligation_coverage),
    unnecessary_design: proposalFacet(assessment.unnecessary_design),
    current_decisions: proposalFacet(assessment.current_decisions),
    invalidations: proposalFacet(assessment.invalidations),
    gate_specific_evidence: proposalFacet(assessment.gate_specific_evidence),
  });
}

export function finalizeGoalFitAssessmentV2(input: {
  readonly acceptance: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly gate_instance: GoalFitGateInstanceReceiptV2;
  readonly change_acceptance?: {
    readonly plan_revision_sha256: string;
    readonly decision_plan_binding_root_sha256: string;
    readonly change_acceptance_closure_sha256: string;
    readonly invalidation_root_sha256: string;
    readonly oracle_evidence_root_sha256: string;
  };
  readonly proposal: GoalFitAssessmentProposalV2;
  readonly created_at_ms: number;
}): GoalFitAssessmentV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionClosureV2(input.decision_closure);
  assertGoalFitGateInstanceReceiptV2(input.gate_instance);
  const requirement = input.requirement.revision;
  const closure = input.decision_closure.closure;
  const gateInstance = input.gate_instance;
  if (input.acceptance.authority.authority_root_id !== requirement.authority_root_id
    || gateInstance.requirement_revision_id !== requirement.requirement_revision_id
    || gateInstance.requirement_revision_sha256 !== requirement.record_sha256
    || gateInstance.decision_closure_id !== closure.decision_closure_id
    || gateInstance.decision_closure_sha256 !== closure.record_sha256
    || gateInstance.gate !== closure.gate) {
    throw new TypeError("Goal Fit assessment input closure is stale");
  }
  const proposal = normalizeGoalFitAssessmentProposalV2(input.proposal);
  const bindFinding = (
    finding: GoalFitFindingFacetProposalV2,
    subjectIds: readonly string[],
    evidenceSha256s: readonly string[],
    label: string,
  ): GoalFitAssessmentFacetV2 => {
    const subjects = [...new Set(subjectIds)].sort();
    if (finding.coverage === "NOT_APPLICABLE") {
      if (subjects.length > 0) throw new TypeError(`${label} cannot be NOT_APPLICABLE for the current Host closure`);
      return { status: "NOT_APPLICABLE", reason_codes: finding.reason_codes, subject_ids: [], evidence_receipt_sha256s: [] };
    }
    if (subjects.length === 0) throw new TypeError(`${label} has no current Host subjects to assess`);
    return {
      status: finding.status,
      reason_codes: finding.reason_codes,
      subject_ids: subjects,
      evidence_receipt_sha256s: [...new Set([...evidenceSha256s, gateInstance.record_sha256])]
        .map((hash) => sha(hash, `${label} Host evidence`)).sort(),
    };
  };
  const outcomeFidelity = bindFinding(
    proposal.outcome_fidelity,
    input.acceptance.facets
      .filter((facet) => facet.kind === "OUTCOME" || facet.kind === "QUALITY" || facet.kind === "INVARIANT")
      .map((facet) => facet.facet_id),
    [input.acceptance.authority.record_sha256, input.acceptance.authority.facet_root_sha256],
    "Goal Fit outcome fidelity",
  );
  const obligationCoverage = bindFinding(
    proposal.obligation_coverage,
    input.requirement.items.filter((item) => item.priority === "MUST").map((item) => item.requirement_id),
    [requirement.record_sha256, requirement.requirements_root_sha256, input.acceptance.authority.obligation_root_sha256],
    "Goal Fit obligation coverage",
  );
  const unnecessaryDesign = bindFinding(
    proposal.unnecessary_design,
    [gateInstance.gate_subject_id],
    [gateInstance.gate_subject_sha256],
    "Goal Fit unnecessary design",
  );
  const currentDecisions = bindFinding(
    proposal.current_decisions,
    input.decision_closure.members.map((member) => member.decision_requirement_revision_id),
    [closure.record_sha256, closure.decision_root_sha256, closure.resolution_root_sha256, closure.member_root_sha256],
    "Goal Fit current Decisions",
  );
  const hasInvalidationAuthority = gateInstance.gate_subject_kind === "CHANGE_ACCEPTANCE_CLOSURE";
  if (hasInvalidationAuthority !== (input.change_acceptance !== undefined)) {
    throw new TypeError("Goal Fit MATERIAL_CHANGE requires the exact Host Change Acceptance closure");
  }
  if (input.change_acceptance !== undefined
    && input.change_acceptance.change_acceptance_closure_sha256 !== gateInstance.gate_subject_sha256) {
    throw new TypeError("Goal Fit Change Acceptance closure is stale");
  }
  const invalidations = bindFinding(
    proposal.invalidations,
    hasInvalidationAuthority ? [gateInstance.gate_subject_id] : [],
    hasInvalidationAuthority ? [gateInstance.gate_subject_sha256] : [],
    "Goal Fit invalidations",
  );
  const gateSpecificEvidence = bindFinding(
    proposal.gate_specific_evidence,
    [gateInstance.gate_subject_id],
    [gateInstance.gate_subject_sha256],
    "Goal Fit gate-specific evidence",
  );
  const planRevisionSha256 = gateInstance.gate_subject_kind === "PLAN_REVISION"
    ? gateInstance.gate_subject_sha256 : input.change_acceptance?.plan_revision_sha256 ?? null;
  const decisionPlanBindingRootSha256 = input.change_acceptance?.decision_plan_binding_root_sha256 ?? null;
  const changeAcceptanceClosureSha256 = input.change_acceptance?.change_acceptance_closure_sha256 ?? null;
  const invalidationRootSha256 = input.change_acceptance?.invalidation_root_sha256 ?? null;
  const oracleEvidenceRootSha256 = input.change_acceptance?.oracle_evidence_root_sha256 ?? null;
  const inputClosureSha256 = canonicalJsonSha256({
    source_root_sha256: requirement.source_root_sha256,
    requirement_revision_sha256: requirement.record_sha256,
    decision_closure_sha256: closure.record_sha256,
    gate_instance_receipt_sha256: gateInstance.record_sha256,
    outcome_fidelity: outcomeFidelity,
    obligation_coverage: obligationCoverage,
    unnecessary_design: unnecessaryDesign,
    current_decisions: currentDecisions,
    invalidations,
    gate_specific_evidence: gateSpecificEvidence,
    plan_revision_sha256: planRevisionSha256,
    decision_plan_binding_root_sha256: decisionPlanBindingRootSha256,
    change_acceptance_closure_sha256: changeAcceptanceClosureSha256,
    invalidation_root_sha256: invalidationRootSha256,
    oracle_evidence_root_sha256: oracleEvidenceRootSha256,
  });
  const body = {
    schema_version: 2 as const,
    goal_fit_assessment_id: idFromSha256("GOAL_FIT_ASSESSMENT", inputClosureSha256),
    requirement_revision_id: requirement.requirement_revision_id,
    goal_id: requirement.goal_id,
    contract_id: requirement.contract_id,
    authority_root_id: requirement.authority_root_id,
    decision_closure_id: closure.decision_closure_id,
    gate: closure.gate,
    gate_instance_receipt_id: gateInstance.gate_instance_receipt_id,
    gate_instance_receipt_sha256: gateInstance.record_sha256,
    proposal_origin: proposal.proposal_origin,
    outcome_fidelity: outcomeFidelity,
    obligation_coverage: obligationCoverage,
    unnecessary_design: unnecessaryDesign,
    current_decisions: currentDecisions,
    invalidations,
    gate_specific_evidence: gateSpecificEvidence,
    plan_revision_sha256: planRevisionSha256,
    decision_plan_binding_root_sha256: decisionPlanBindingRootSha256,
    change_acceptance_closure_sha256: changeAcceptanceClosureSha256,
    invalidation_root_sha256: invalidationRootSha256,
    oracle_evidence_root_sha256: oracleEvidenceRootSha256,
    source_root_sha256: requirement.source_root_sha256,
    requirement_root_sha256: requirement.requirements_root_sha256,
    decision_closure_sha256: closure.record_sha256,
    input_closure_sha256: inputClosureSha256,
    created_at_ms: timestamp(input.created_at_ms, "Goal Fit assessment timestamp"),
  };
  return sealed("PCH-GOAL-FIT-ASSESSMENT-V2", body);
}

export function deriveGoalFitOutcomeV2(
  decisionClosure: DecisionClosureBundleV2,
  assessment?: GoalFitAssessmentV2,
): {
  readonly verdict: GoalFitVerdictV2;
  readonly reason_codes: readonly string[];
} {
  assertDecisionClosureV2(decisionClosure);
  if (!assessment) throw new TypeError("Goal Fit outcome requires a typed assessment");
  assertGoalFitAssessmentV2(assessment);
  const closure = decisionClosure.closure;
  if (assessment.decision_closure_id !== closure.decision_closure_id
    || assessment.decision_closure_sha256 !== closure.record_sha256
    || assessment.gate !== closure.gate) {
    throw new TypeError("Goal Fit assessment does not match the Decision closure");
  }
  if (closure.rejected_decision_ids.length > 0) {
    return { verdict: "REJECT", reason_codes: ["DECISION_REJECTED"] };
  }
  if (closure.edited_decision_ids.length > 0) {
    return { verdict: "REFRAME", reason_codes: ["REQUIREMENT_EDIT_REQUIRED"] };
  }
  if (!closure.qualified || closure.unresolved_decision_ids.length > 0 || closure.due_deferred_decision_ids.length > 0) {
    return { verdict: "ASK_USER", reason_codes: ["MATERIAL_DECISION_PENDING"] };
  }
  const facets = [
    assessment.outcome_fidelity,
    assessment.obligation_coverage,
    assessment.unnecessary_design,
    assessment.current_decisions,
    assessment.invalidations,
    assessment.gate_specific_evidence,
  ];
  for (const verdict of ["REJECT", "REFRAME", "ASK_USER"] as const) {
    const reasons = [...new Set(facets
      .filter((facet) => facet.status === verdict)
      .flatMap((facet) => facet.reason_codes))].sort();
    if (reasons.length > 0) return { verdict, reason_codes: reasons };
  }
  return { verdict: "FIT", reason_codes: ["GOAL_FIT_ASSESSMENT_PASSED"] };
}

export function finalizeLegacyGoalFitReviewV2(input: {
  readonly requirement: RequirementRevisionClosureV2;
  readonly acceptance: AcceptanceProjectionV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly gate: GoalFitGateV2;
  readonly verdict: GoalFitVerdictV2;
  readonly reason_codes: readonly string[];
  readonly created_at_ms: number;
}): GoalFitReviewV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionClosureV2(input.decision_closure);
  stageIndex(input.gate);
  if (!verdicts.has(input.verdict)) throw new TypeError("Goal Fit verdict is invalid");
  const authority = input.acceptance.authority;
  if (authority.authority_root_id !== input.requirement.revision.authority_root_id
    || input.decision_closure.closure.requirement_revision_id !== input.requirement.revision.requirement_revision_id
    || input.decision_closure.closure.gate !== input.gate) {
    throw new TypeError("Goal Fit input closure is stale");
  }
  if (input.verdict === "FIT" && !input.decision_closure.closure.qualified) {
    throw new TypeError("Goal Fit requires a qualified Decision closure");
  }
  const reasonCodes = uniqueSorted(input.reason_codes, "Goal Fit reason codes", 1, 64);
  if (reasonCodes.some((code) => !reasonCodePattern.test(code))) throw new TypeError("Goal Fit reason code is invalid");
  const inputClosureSha256 = canonicalJsonSha256({
    authority_root_id: authority.authority_root_id,
    source_root_sha256: authority.source_root_sha256,
    requirement_revision_sha256: input.requirement.revision.record_sha256,
    decision_closure_sha256: input.decision_closure.closure.record_sha256,
    gate: input.gate,
  });
  const body = {
    schema_version: 2 as const,
    goal_fit_review_id: idFromSha256("GOAL_FIT_REVIEW", canonicalJsonSha256({
      input_closure_sha256: inputClosureSha256, verdict: input.verdict, reason_codes: reasonCodes,
    })),
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    decision_closure_id: input.decision_closure.closure.decision_closure_id,
    gate: input.gate,
    verdict: input.verdict,
    review_owner: "HOST" as const,
    reason_codes: reasonCodes,
    source_root_sha256: authority.source_root_sha256,
    requirement_root_sha256: input.requirement.revision.requirements_root_sha256,
    decision_closure_sha256: input.decision_closure.closure.record_sha256,
    input_closure_sha256: inputClosureSha256,
    created_at_ms: timestamp(input.created_at_ms, "Goal Fit review timestamp"),
  };
  return sealed("PCH-GOAL-FIT-REVIEW-V2", body);
}

export function finalizeGoalFitReviewV2(input: {
  readonly requirement: RequirementRevisionClosureV2;
  readonly acceptance: AcceptanceProjectionV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly gate_instance: GoalFitGateInstanceReceiptV2;
  readonly assessment: GoalFitAssessmentV2;
  readonly created_at_ms: number;
}): GoalFitReviewV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionClosureV2(input.decision_closure);
  assertGoalFitGateInstanceReceiptV2(input.gate_instance);
  assertGoalFitAssessmentV2(input.assessment);
  const authority = input.acceptance.authority;
  const closure = input.decision_closure.closure;
  if (authority.authority_root_id !== input.requirement.revision.authority_root_id
    || closure.requirement_revision_id !== input.requirement.revision.requirement_revision_id
    || input.gate_instance.requirement_revision_id !== input.requirement.revision.requirement_revision_id
    || input.gate_instance.decision_closure_id !== closure.decision_closure_id
    || input.assessment.requirement_revision_id !== input.requirement.revision.requirement_revision_id
    || input.assessment.decision_closure_id !== closure.decision_closure_id
    || input.assessment.gate_instance_receipt_id !== input.gate_instance.gate_instance_receipt_id
    || input.assessment.gate_instance_receipt_sha256 !== input.gate_instance.record_sha256
    || input.assessment.gate !== closure.gate) {
    throw new TypeError("Goal Fit assessed review input closure is stale");
  }
  const outcome = deriveGoalFitOutcomeV2(input.decision_closure, input.assessment);
  if (outcome.verdict === "FIT" && !closure.qualified) {
    throw new TypeError("Goal Fit requires a qualified Decision closure");
  }
  const inputClosureSha256 = canonicalJsonSha256({
    authority_root_id: authority.authority_root_id,
    source_root_sha256: authority.source_root_sha256,
    requirement_revision_sha256: input.requirement.revision.record_sha256,
    decision_closure_sha256: closure.record_sha256,
    gate_instance_receipt_sha256: input.gate_instance.record_sha256,
    goal_fit_assessment_sha256: input.assessment.record_sha256,
    gate: closure.gate,
  });
  const body = {
    schema_version: 2 as const,
    goal_fit_review_id: idFromSha256("GOAL_FIT_REVIEW", canonicalJsonSha256({
      input_closure_sha256: inputClosureSha256,
      verdict: outcome.verdict,
      reason_codes: outcome.reason_codes,
    })),
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    decision_closure_id: closure.decision_closure_id,
    gate: closure.gate,
    verdict: outcome.verdict,
    review_owner: "HOST" as const,
    reason_codes: outcome.reason_codes,
    source_root_sha256: authority.source_root_sha256,
    requirement_root_sha256: input.requirement.revision.requirements_root_sha256,
    decision_closure_sha256: closure.record_sha256,
    input_closure_sha256: inputClosureSha256,
    created_at_ms: timestamp(input.created_at_ms, "Goal Fit review timestamp"),
  };
  return sealed("PCH-GOAL-FIT-REVIEW-V2", body);
}

export function finalizeGoalFitReviewAssessmentBindingV2(input: {
  readonly decision_closure: DecisionClosureBundleV2;
  readonly gate_instance: GoalFitGateInstanceReceiptV2;
  readonly assessment: GoalFitAssessmentV2;
  readonly review: GoalFitReviewV2;
  readonly created_at_ms: number;
}): GoalFitReviewAssessmentBindingV2 {
  assertDecisionClosureV2(input.decision_closure);
  assertGoalFitGateInstanceReceiptV2(input.gate_instance);
  assertGoalFitAssessmentV2(input.assessment);
  assertGoalFitReviewV2(input.review);
  const gateInstance = input.gate_instance;
  const assessment = input.assessment;
  const review = input.review;
  if (assessment.gate_instance_receipt_id !== gateInstance.gate_instance_receipt_id
    || assessment.gate_instance_receipt_sha256 !== gateInstance.record_sha256
    || review.requirement_revision_id !== gateInstance.requirement_revision_id
    || review.decision_closure_id !== gateInstance.decision_closure_id
    || input.decision_closure.closure.decision_closure_id !== review.decision_closure_id
    || input.decision_closure.closure.record_sha256 !== review.decision_closure_sha256
    || review.gate !== gateInstance.gate
    || assessment.requirement_revision_id !== review.requirement_revision_id
    || assessment.decision_closure_id !== review.decision_closure_id
    || assessment.gate !== review.gate
    || assessment.goal_id !== review.goal_id || assessment.contract_id !== review.contract_id
    || assessment.authority_root_id !== review.authority_root_id) {
    throw new TypeError("Goal Fit assessed review binding input closure is stale");
  }
  const outcome = deriveGoalFitOutcomeV2(input.decision_closure, assessment);
  if (outcome.verdict !== review.verdict
    || canonicalJson(outcome.reason_codes) !== canonicalJson(review.reason_codes)) {
    throw new TypeError("Goal Fit binding verdict is not Host-derived");
  }
  const reasonCodeRootSha256 = memberRoot("PCH-GOAL-FIT-REASON-CODE-ROOT-V2", review.reason_codes);
  const body = {
    schema_version: 2 as const,
    goal_fit_review_id: review.goal_fit_review_id,
    goal_fit_review_sha256: review.record_sha256,
    goal_fit_assessment_id: assessment.goal_fit_assessment_id,
    goal_fit_assessment_sha256: assessment.record_sha256,
    gate_instance_receipt_id: gateInstance.gate_instance_receipt_id,
    gate_instance_receipt_sha256: gateInstance.record_sha256,
    requirement_revision_id: review.requirement_revision_id,
    goal_id: review.goal_id,
    contract_id: review.contract_id,
    authority_root_id: review.authority_root_id,
    decision_closure_id: review.decision_closure_id,
    gate: review.gate,
    derived_verdict: review.verdict,
    derived_reason_codes: review.reason_codes,
    derived_reason_code_root_sha256: reasonCodeRootSha256,
    qualification_status: "CURRENT_ASSESSED" as const,
    created_at_ms: timestamp(input.created_at_ms, "Goal Fit assessed review binding timestamp"),
  };
  return sealed("PCH-GOAL-FIT-REVIEW-ASSESSMENT-BINDING-V2", body);
}

export function finalizeContractFreezeReceiptV2(input: {
  readonly requirement: RequirementRevisionClosureV2;
  readonly acceptance: AcceptanceProjectionV2;
  readonly decision_closure: DecisionClosureBundleV2;
  readonly goal_fit_review: GoalFitReviewV2;
  readonly contract_sha256: string;
  readonly generation: number;
  readonly predecessor_freeze_sha256: string;
  readonly created_at_ms: number;
}): ContractFreezeReceiptV2 {
  assertRequirementRevisionClosureV2(input.requirement);
  assertDecisionClosureV2(input.decision_closure);
  assertGoalFitReviewV2(input.goal_fit_review);
  const authority = input.acceptance.authority;
  if (input.decision_closure.closure.gate !== "CONTRACT_FREEZE" || !input.decision_closure.closure.qualified
    || !input.decision_closure.closure.draft_review_approved
    || input.goal_fit_review.gate !== "CONTRACT_FREEZE" || input.goal_fit_review.verdict !== "FIT"
    || input.goal_fit_review.decision_closure_id !== input.decision_closure.closure.decision_closure_id
    || input.requirement.revision.authority_root_id !== authority.authority_root_id) {
    throw new TypeError("Contract freeze requires current user approval and fresh Goal Fit authority");
  }
  const generation = positiveInteger(input.generation, "Contract freeze generation", 1_000_000);
  const contractSha256 = sha(input.contract_sha256, "Contract freeze contract hash");
  const predecessor = sha(input.predecessor_freeze_sha256, "Contract freeze predecessor");
  const body = {
    schema_version: 2 as const,
    contract_freeze_receipt_id: idFromSha256("CONTRACT_FREEZE", canonicalJsonSha256({
      authority_root_id: authority.authority_root_id,
      requirement_revision_sha256: input.requirement.revision.record_sha256,
      decision_closure_sha256: input.decision_closure.closure.record_sha256,
      goal_fit_review_sha256: input.goal_fit_review.record_sha256,
      generation,
      predecessor_freeze_sha256: predecessor,
    })),
    goal_id: authority.goal_id,
    contract_id: authority.contract_id,
    authority_root_id: authority.authority_root_id,
    requirement_revision_id: input.requirement.revision.requirement_revision_id,
    decision_closure_id: input.decision_closure.closure.decision_closure_id,
    goal_fit_review_id: input.goal_fit_review.goal_fit_review_id,
    generation,
    predecessor_freeze_sha256: predecessor,
    contract_sha256: contractSha256,
    source_root_sha256: authority.source_root_sha256,
    facet_root_sha256: authority.facet_root_sha256,
    requirement_root_sha256: input.requirement.revision.requirements_root_sha256,
    decision_root_sha256: input.decision_closure.closure.decision_root_sha256,
    created_at_ms: timestamp(input.created_at_ms, "Contract freeze timestamp"),
  };
  return sealed("PCH-CONTRACT-FREEZE-RECEIPT-V2", body);
}

export function assertRequirementRevisionClosureV2(value: RequirementRevisionClosureV2): void {
  const revision = record(value.revision, "Requirement revision");
  assertSealed("PCH-REQUIREMENT-REVISION-V2", revision, "Requirement revision");
  const goalRevision = positiveInteger(value.revision.revision, "Requirement revision", 1_000_000);
  const contractRevision = positiveInteger(value.revision.contract_revision, "Requirement contract revision", 1_000_000);
  const hasNoParent = value.revision.parent_requirement_revision_id === null
    && value.revision.parent_requirement_revision_sha256 === null;
  const hasCompleteParent = value.revision.parent_requirement_revision_id !== null
    && value.revision.parent_requirement_revision_sha256 !== null;
  if (contractRevision > goalRevision
    || (goalRevision === 1 ? !hasNoParent : !hasCompleteParent)
    || !proposalOrigins.has(value.revision.proposal_origin)) {
    throw new TypeError("Requirement revision lineage is invalid");
  }
  if (hasCompleteParent) {
    boundedText(value.revision.parent_requirement_revision_id, "Parent requirement revision ID", 160);
    sha(value.revision.parent_requirement_revision_sha256, "Parent requirement revision hash");
  }
  timestamp(value.revision.created_at_ms, "Requirement revision timestamp");
  const itemCandidates: unknown = value.items;
  if (!Array.isArray(itemCandidates) || itemCandidates.length !== value.revision.item_count) {
    throw new TypeError("Requirement item count is invalid");
  }
  const semanticKeys = new Set<string>();
  for (const item of value.items) {
    const candidate = record(item, "Requirement item");
    assertSealed("PCH-REQUIREMENT-ITEM-V2", candidate, "Requirement item");
    if (item.requirement_revision_id !== value.revision.requirement_revision_id
      || item.goal_id !== value.revision.goal_id || item.contract_id !== value.revision.contract_id
      || item.authority_root_id !== value.revision.authority_root_id) throw new TypeError("Requirement item identity is invalid");
    if (!semanticKeyPattern.test(item.semantic_key) || semanticKeys.has(item.semantic_key)) throw new TypeError("Requirement item semantic key is invalid");
    semanticKeys.add(item.semantic_key);
    if (!requirementKinds.has(item.kind) || !priorities.has(item.priority)) {
      throw new TypeError("Requirement item classification is invalid");
    }
    boundedText(item.statement, "Requirement item statement", 32_768);
    uniqueSorted(item.acceptance_facet_ids, "Requirement item acceptance facets", 1, 64);
    uniqueSorted(item.source_span_ids, "Requirement item source spans", 1, 64);
    const expectedRequirementId = idFromSha256("REQUIREMENT", canonicalJsonSha256({
      goal_id: item.goal_id, semantic_key: item.semantic_key,
    }));
    const expectedTraceRoot = canonicalJsonSha256({ facets: item.acceptance_facet_ids, spans: item.source_span_ids });
    const expectedItemId = idFromSha256("REQUIREMENT_ITEM", canonicalJsonSha256({
      requirement_id: expectedRequirementId,
      requirement_revision_id: item.requirement_revision_id,
      kind: item.kind,
      priority: item.priority,
      statement: item.statement,
      trace_root_sha256: expectedTraceRoot,
    }));
    if (item.requirement_id !== expectedRequirementId || item.requirement_item_revision_id !== expectedItemId
      || item.trace_root_sha256 !== expectedTraceRoot
      || canonicalJson(item.acceptance_facet_ids) !== canonicalJson([...item.acceptance_facet_ids].sort())
      || canonicalJson(item.source_span_ids) !== canonicalJson([...item.source_span_ids].sort())
      || new Set(item.acceptance_facet_ids).size !== item.acceptance_facet_ids.length
      || new Set(item.source_span_ids).size !== item.source_span_ids.length) {
      throw new TypeError("Requirement item stable identity is invalid");
    }
  }
  const requirementsRoot = memberRoot("PCH-REQUIREMENT-ROOT-V2", value.items.map((item) => item.record_sha256));
  const proposalRoot = canonicalJsonSha256(value.items.map((item) => ({
    key: item.semantic_key,
    kind: item.kind,
    priority: item.priority,
    statement: item.statement,
    acceptance_facet_ids: item.acceptance_facet_ids,
    source_span_ids: item.source_span_ids,
  })).sort((left, right) => left.key.localeCompare(right.key)));
  const expectedRevisionId = idFromSha256("REQUIREMENT_REVISION", canonicalJsonSha256({
    goal_id: value.revision.goal_id,
    contract_id: value.revision.contract_id,
    authority_root_id: value.revision.authority_root_id,
    revision: value.revision.revision,
    contract_revision: value.revision.contract_revision,
    parent_requirement_revision_sha256: value.revision.parent_requirement_revision_sha256,
    proposal_origin: value.revision.proposal_origin,
    item_proposal_root_sha256: proposalRoot,
  }));
  const expectedInputClosure = canonicalJsonSha256({
    authority_root_id: value.revision.authority_root_id,
    source_root_sha256: value.revision.source_root_sha256,
    span_root_sha256: value.revision.span_root_sha256,
    facet_root_sha256: value.revision.facet_root_sha256,
    requirements_root_sha256: requirementsRoot,
    parent_requirement_revision_sha256: value.revision.parent_requirement_revision_sha256,
  });
  if (requirementsRoot !== value.revision.requirements_root_sha256
    || expectedRevisionId !== value.revision.requirement_revision_id
    || expectedInputClosure !== value.revision.input_closure_sha256) {
    throw new TypeError("Requirement root is invalid");
  }
}

export function assertDecisionRequirementV2(value: DecisionRequirementV2): void {
  assertSealed("PCH-DECISION-REQUIREMENT-V2", record(value, "Decision requirement"), "Decision requirement");
  const decisionRequirementId = idFromSha256("DECISION_REQUIREMENT", canonicalJsonSha256({
    goal_id: value.goal_id, decision_key: value.decision_key,
  }));
  const defaultSha256 = canonicalJsonSha256({ action: value.default_action, value: value.default_value });
  const decisionRequirementRevisionId = idFromSha256("DECISION_REQUIREMENT_REVISION", canonicalJsonSha256({
    decision_requirement_id: decisionRequirementId,
    requirement_revision_id: value.requirement_revision_id,
    question: value.question,
    kind: value.kind,
    materiality: value.materiality,
    blocking: value.blocking,
    affected_requirement_ids: value.affected_requirement_ids,
    source_span_ids: value.source_span_ids,
    trigger_sha256: value.trigger_sha256,
    latest_resolution_stage: value.latest_resolution_stage,
    default_sha256: defaultSha256,
    reversibility: value.reversibility,
    affected_work_cell_ids: value.affected_work_cell_ids,
    proposal_origin: value.proposal_origin,
  }));
  if (decisionRequirementId !== value.decision_requirement_id
    || decisionRequirementRevisionId !== value.decision_requirement_revision_id
    || defaultSha256 !== value.default_sha256
    || canonicalJson(value.affected_requirement_ids) !== canonicalJson([...value.affected_requirement_ids].sort())
    || canonicalJson(value.source_span_ids) !== canonicalJson([...value.source_span_ids].sort())
    || canonicalJson(value.affected_work_cell_ids) !== canonicalJson([...value.affected_work_cell_ids].sort())
    || new Set(value.affected_requirement_ids).size !== value.affected_requirement_ids.length
    || new Set(value.source_span_ids).size !== value.source_span_ids.length
    || new Set(value.affected_work_cell_ids).size !== value.affected_work_cell_ids.length) {
    throw new TypeError("Decision requirement stable identity is invalid");
  }
}

export function assertDecisionResolutionV2(value: DecisionResolutionV2): void {
  assertSealed("PCH-DECISION-RESOLUTION-V2", record(value, "Decision resolution"), "Decision resolution");
  const selectedValueSha256 = canonicalJsonSha256(value.selected_value);
  const actionPayloadSha256 = canonicalJsonSha256({
    action: value.action,
    selected_value_sha256: selectedValueSha256,
    edited_requirement_revision_id: value.edited_requirement_revision_id,
    deferred_trigger_sha256: value.deferred_trigger_sha256,
  });
  const expectedId = idFromSha256("DECISION_RESOLUTION", canonicalJsonSha256({
    decision_requirement_revision_id: value.decision_requirement_revision_id,
    resolution_revision: value.resolution_revision,
    parent_resolution_id: value.parent_resolution_id,
    action: value.action,
    authority_actor: value.authority_actor,
    at_stage: value.at_stage,
    decision_frontier_sha256: value.decision_frontier_sha256,
    action_payload_sha256: value.action_payload_sha256,
    authority_input_receipt_id: value.authority_input_receipt_id,
    due_event_receipt_id: value.due_event_receipt_id,
    resolution_input_sha256: value.resolution_input_sha256,
    authority_source_span_id: value.authority_source_span_id,
    selected_value_sha256: selectedValueSha256,
    edited_requirement_revision_id: value.edited_requirement_revision_id,
    deferred_trigger_sha256: value.deferred_trigger_sha256,
  }));
  if (value.decision_resolution_id !== expectedId || value.selected_value_sha256 !== selectedValueSha256
    || value.action_payload_sha256 !== actionPayloadSha256 || !sha256Pattern.test(value.decision_frontier_sha256)
    || (value.action === "EDIT") !== (value.edited_requirement_revision_id !== null)
    || (value.action === "DEFER") !== (value.deferred_trigger_sha256 !== null)
    || (value.authority_actor === "USER") !== (value.due_event_receipt_id === null)) {
    throw new TypeError("Decision resolution stable identity is invalid");
  }
}

export function assertDecisionAuthorityInputReceiptV2(value: DecisionAuthorityInputReceiptV2): void {
  assertSealed("PCH-DECISION-AUTHORITY-INPUT-V2", record(value, "Decision authority input"), "Decision authority input");
  const expectedId = idFromSha256("DECISION_INPUT", canonicalJsonSha256({
    decision_requirement_revision_id: value.decision_requirement_revision_id,
    requirement_revision_sha256: value.requirement_revision_sha256,
    decision_frontier_sha256: value.decision_frontier_sha256,
    action_payload_sha256: value.action_payload_sha256,
    authority_actor: value.authority_actor,
    content_sha256: value.content_sha256,
    event_head_sha256: value.event_head_sha256,
    created_at_ms: value.created_at_ms,
  }));
  if (value.authority_input_receipt_id !== expectedId || value.byte_length < 1 || value.byte_length > 131_072
    || value.encoding !== "UTF-8" || value.fidelity !== "EXACT" || value.captured_by !== "HOST"
    || !sha256Pattern.test(value.requirement_revision_sha256)
    || !sha256Pattern.test(value.decision_frontier_sha256)
    || !sha256Pattern.test(value.action_payload_sha256)
    || !sha256Pattern.test(value.event_head_sha256)
    || !actions.has(value.action)
    || !stages.includes(value.at_gate)
    || (value.authority_actor === "USER") !== (value.source_kind === "USER_TURN")
    || (value.authority_actor === "USER"
      ? value.session_id === null || value.turn_id === null || value.due_event_receipt_id !== null
      : value.session_id !== null || value.turn_id !== null || value.due_event_receipt_id === null)) {
    throw new TypeError("Decision authority input stable identity is invalid");
  }
}

export function assertDecisionDueEventReceiptV2(value: DecisionDueEventReceiptV2): void {
  assertSealed("PCH-DECISION-DUE-EVENT-V2", record(value, "Decision due event"), "Decision due event");
  const expectedId = idFromSha256("DECISION_DUE_EVENT", canonicalJsonSha256({
    decision_requirement_revision_id: value.decision_requirement_revision_id,
    requirement_revision_sha256: value.requirement_revision_sha256,
    purpose: value.purpose,
    trigger_sha256: value.trigger_sha256,
    at_gate: value.at_gate,
    event_evidence_sha256: value.event_evidence_sha256,
    event_head_sha256: value.event_head_sha256,
    predecessor_resolution_sha256: value.predecessor_resolution_sha256,
  }));
  if (value.due_event_receipt_id !== expectedId || value.captured_by !== "HOST"
    || !sha256Pattern.test(value.requirement_revision_sha256)
    || !sha256Pattern.test(value.trigger_sha256)
    || !sha256Pattern.test(value.event_evidence_sha256)
    || !sha256Pattern.test(value.event_head_sha256)
    || !sha256Pattern.test(value.predecessor_resolution_sha256)
    || (value.purpose !== "DEFAULT_DEADLINE" && value.purpose !== "DEFERRED_TRIGGER")) {
    throw new TypeError("Decision due event stable identity is invalid");
  }
  stageIndex(value.at_gate);
}

export function assertDecisionClosureV2(value: DecisionClosureBundleV2): void {
  assertSealed("PCH-DECISION-CLOSURE-V2", record(value.closure, "Decision closure"), "Decision closure");
  if (!Array.isArray(value.members) || canonicalJsonSha256({ domain: "PCH-DECISION-CLOSURE-MEMBERS-V2", members: value.members })
    !== value.closure.member_root_sha256) throw new TypeError("Decision closure member root is invalid");
}

export function assertGoalFitGateInstanceReceiptV2(value: GoalFitGateInstanceReceiptV2): void {
  assertSealed("PCH-GOAL-FIT-GATE-INSTANCE-V2", record(value, "Goal Fit gate instance"), "Goal Fit gate instance");
  if (!gateSubjectKinds.has(value.gate_subject_kind)
    || value.gate_subject_kind !== expectedGateSubjectKind(value.gate)
    || !sha256Pattern.test(value.requirement_revision_sha256)
    || !sha256Pattern.test(value.decision_closure_sha256)
    || !sha256Pattern.test(value.gate_subject_sha256)
    || memberRoot("PCH-GOAL-FIT-HOST-EVIDENCE-V2", value.host_evidence_sha256s
      .map((hash) => sha(hash, "Goal Fit Host evidence hash"))) !== value.host_evidence_root_sha256
    || !sha256Pattern.test(value.host_evidence_root_sha256)
    || !sha256Pattern.test(value.event_head_sha256)) {
    throw new TypeError("Goal Fit gate instance identity is invalid");
  }
  stageIndex(value.gate);
}

export function assertGoalFitAssessmentV2(value: GoalFitAssessmentV2): void {
  assertSealed("PCH-GOAL-FIT-ASSESSMENT-V2", record(value, "Goal Fit assessment"), "Goal Fit assessment");
  if (!proposalOrigins.has(value.proposal_origin)
    || !sha256Pattern.test(value.gate_instance_receipt_sha256)
    || !sha256Pattern.test(value.source_root_sha256)
    || !sha256Pattern.test(value.requirement_root_sha256)
    || !sha256Pattern.test(value.decision_closure_sha256)
    || !sha256Pattern.test(value.input_closure_sha256)) {
    throw new TypeError("Goal Fit assessment identity is invalid");
  }
  const facets = [
    normalizeGoalFitAssessmentFacet(value.outcome_fidelity, "Goal Fit outcome fidelity"),
    normalizeGoalFitAssessmentFacet(value.obligation_coverage, "Goal Fit obligation coverage"),
    normalizeGoalFitAssessmentFacet(value.unnecessary_design, "Goal Fit unnecessary design"),
    normalizeGoalFitAssessmentFacet(value.current_decisions, "Goal Fit current Decisions"),
    normalizeGoalFitAssessmentFacet(value.invalidations, "Goal Fit invalidations"),
    normalizeGoalFitAssessmentFacet(value.gate_specific_evidence, "Goal Fit gate-specific evidence"),
  ];
  if (facets.some((facet) => facet.status !== "NOT_APPLICABLE"
    && !facet.evidence_receipt_sha256s.includes(value.gate_instance_receipt_sha256))) {
    throw new TypeError("Goal Fit assessment facet is not bound to its exact Host gate instance");
  }
  const materialHashes = [
    value.decision_plan_binding_root_sha256,
    value.change_acceptance_closure_sha256,
    value.invalidation_root_sha256,
    value.oracle_evidence_root_sha256,
  ];
  if (value.gate === "MATERIAL_CHANGE") {
    if (!sha256Pattern.test(value.plan_revision_sha256 ?? "")
      || materialHashes.some((hash) => !sha256Pattern.test(hash ?? ""))) {
      throw new TypeError("Goal Fit MATERIAL_CHANGE assessment lacks its Host-derived closure roots");
    }
  } else if (materialHashes.some((hash) => hash !== null)) {
    throw new TypeError("Goal Fit non-material assessment carries Change Acceptance authority");
  }
  stageIndex(value.gate);
}

export function assertGoalFitReviewV2(value: GoalFitReviewV2): void {
  assertSealed("PCH-GOAL-FIT-REVIEW-V2", record(value, "Goal Fit review"), "Goal Fit review");
}

export function assertGoalFitReviewAssessmentBindingV2(value: GoalFitReviewAssessmentBindingV2): void {
  assertSealed(
    "PCH-GOAL-FIT-REVIEW-ASSESSMENT-BINDING-V2",
    record(value, "Goal Fit assessed review binding"),
    "Goal Fit assessed review binding",
  );
  if (value.qualification_status !== "CURRENT_ASSESSED"
    || !verdicts.has(value.derived_verdict)
    || memberRoot("PCH-GOAL-FIT-REASON-CODE-ROOT-V2", value.derived_reason_codes)
      !== value.derived_reason_code_root_sha256) {
    throw new TypeError("Goal Fit assessed review binding identity is invalid");
  }
  stageIndex(value.gate);
}

export function assertContractFreezeReceiptV2(value: ContractFreezeReceiptV2): void {
  assertSealed("PCH-CONTRACT-FREEZE-RECEIPT-V2", record(value, "Contract freeze receipt"), "Contract freeze receipt");
}
