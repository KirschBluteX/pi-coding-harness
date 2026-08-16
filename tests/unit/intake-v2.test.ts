import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import type { AcceptanceProjectionV2 } from "../../src/acceptance-v2/domain.js";
import {
  assertDecisionRequirementV2,
  assertRequirementRevisionClosureV2,
  decisionActionPayloadSha256V2,
  decisionDeadlineTriggerSha256V2,
  decisionFrontierSha256V2,
  deriveGoalFitOutcomeV2,
  evaluateDecisionClosureV2,
  finalizeDecisionAuthorityInputV2,
  finalizeDecisionDueEventReceiptV2,
  finalizeDecisionRequirementsV2,
  finalizeDecisionResolutionV2,
  finalizeGoalFitAssessmentV2,
  finalizeGoalFitGateInstanceReceiptV2,
  finalizeRequirementRevisionV2,
  hostDefaultAuthorityInputSourceV2,
  userDecisionAuthorityInputSourceV2,
} from "../../src/intake-v2/finalize.js";
import type {
  DecisionActionV2,
  DecisionRequirementProposalV2,
  DecisionRequirementV2,
  DecisionResolutionV2,
  GoalFitGateV2,
  GoalFitAssessmentProposalV2,
  RequirementRevisionClosureV2,
} from "../../src/intake-v2/domain.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeAcceptanceV2 } from "../../src/acceptance-v2/finalize.js";
import { finalizeGoalContract } from "../../src/task-flow/finalize.js";

const zeroSha256 = "0".repeat(64);

function acceptance(): AcceptanceProjectionV2 {
  const source = "Build the parser. Preserve Unicode. Do not deploy.";
  const contract = finalizeGoalContract({
    goalId: "GOAL-INTAKE-V2",
    objective: source,
    intent: "BUILD",
    lane: "ADAPTIVE_ROUTE",
    sourceIntakeSha256: sha256Hex(source),
    version: 1,
    parentContractId: null,
    createdAtMs: 1,
    proposal: {
      user_outcomes: ["Build the parser"],
      scope: ["src/parser.ts"],
      constraints: ["Preserve Unicode"],
      non_goals: ["Do not deploy"],
      obligations: [{
        key: "parser",
        priority: "MUST",
        statement: "The parser is correct",
        oracle: { commands: ["npm test"] },
      }],
      authorization_ceiling: "LOCAL_REVERSIBLE",
    },
  });
  return finalizeAcceptanceV2({
    goalId: contract.goal_id,
    contract,
    source,
    facets: [
      {
        key: "parser-outcome",
        kind: "OUTCOME",
        subject: { kind: "USER_OUTCOME", index: 0 },
        source_quotes: [{ quote: "Build the parser", occurrence: 1 }],
        obligation_keys: ["parser"],
      },
      {
        key: "unicode-constraint",
        kind: "CONSTRAINT",
        subject: { kind: "CONSTRAINT", index: 0 },
        source_quotes: [{ quote: "Preserve Unicode", occurrence: 1 }],
        obligation_keys: ["parser"],
      },
      {
        key: "deployment-bound",
        kind: "NON_GOAL",
        subject: { kind: "NON_GOAL", index: 0 },
        source_quotes: [{ quote: "Do not deploy", occurrence: 1 }],
        obligation_keys: ["parser"],
      },
    ],
    authority: {
      qualification_basis: "NATIVE_EXACT",
      predecessor_authority_head_sha256: sha256Hex("intake-event-head"),
    },
  });
}

function draft(order: readonly ("parser" | "unicode" | "deploy")[] = ["parser", "unicode", "deploy"]): {
  readonly graph: AcceptanceProjectionV2;
  readonly closure: RequirementRevisionClosureV2;
} {
  const graph = acceptance();
  const byKey = {
    parser: {
      key: "parser", kind: "OUTCOME" as const, priority: "MUST" as const,
      statement: "Parser output is correct",
      acceptance_facet_ids: [graph.facets.find((facet) => facet.semantic_key === "parser-outcome")!.facet_id],
      source_span_ids: graph.facets.find((facet) => facet.semantic_key === "parser-outcome")!.source_span_ids,
    },
    unicode: {
      key: "unicode", kind: "CONSTRAINT" as const, priority: "MUST" as const,
      statement: "Unicode behavior is preserved",
      acceptance_facet_ids: [graph.facets.find((facet) => facet.semantic_key === "unicode-constraint")!.facet_id],
      source_span_ids: graph.facets.find((facet) => facet.semantic_key === "unicode-constraint")!.source_span_ids,
    },
    deploy: {
      key: "deploy", kind: "NON_GOAL" as const, priority: "MUST" as const,
      statement: "Deployment remains out of scope",
      acceptance_facet_ids: [graph.facets.find((facet) => facet.semantic_key === "deployment-bound")!.facet_id],
      source_span_ids: graph.facets.find((facet) => facet.semantic_key === "deployment-bound")!.source_span_ids,
    },
  };
  return {
    graph,
    closure: finalizeRequirementRevisionV2({
      acceptance: graph,
      revision: 1,
      contract_revision: 1,
      parent_requirement_revision_id: null,
      parent_requirement_revision_sha256: null,
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      items: order.map((key) => byKey[key]),
      created_at_ms: 2,
    }),
  };
}

function decisionProposals(
  graph: AcceptanceProjectionV2,
  requirement: RequirementRevisionClosureV2,
  extras: readonly DecisionRequirementProposalV2[] = [],
): readonly DecisionRequirementV2[] {
  return finalizeDecisionRequirementsV2({
    acceptance: graph,
    requirement,
    proposals: [{
      key: "draft-review",
      kind: "DRAFT_REVIEW",
      question: "Approve the exact current draft?",
      materiality: "HIGH",
      blocking: true,
      affected_requirement_keys: requirement.items.map((item) => item.semantic_key),
      source_span_ids: [graph.spans[0]!.span_id],
      trigger: { kind: "IMMEDIATE", evidence_sha256: sha256Hex("draft-review") },
      latest_resolution_stage: "CONTRACT_FREEZE",
      default: { action: "REJECT", value: null },
      reversibility: "REVERSIBLE",
      affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }, ...extras],
  });
}

function userResolution(input: {
  readonly graph: AcceptanceProjectionV2;
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly decision: DecisionRequirementV2;
  readonly action: DecisionActionV2;
  readonly selected_value: null | Readonly<Record<string, boolean>>;
  readonly at_gate?: GoalFitGateV2;
  readonly edited_requirement_revision_id?: string | null;
  readonly deferred_trigger_sha256?: string | null;
  readonly source_override?: string;
  readonly created_at_ms?: number;
}): DecisionResolutionV2 {
  const atGate = input.at_gate ?? "CONTRACT_REVIEW";
  const edited = input.edited_requirement_revision_id ?? null;
  const deferred = input.deferred_trigger_sha256 ?? null;
  const eventHead = sha256Hex(`event-head:${input.decision.decision_requirement_revision_id}:${input.action}`);
  const actionPayloadSha256 = decisionActionPayloadSha256V2({
    decision: input.decision,
    action: input.action,
    selected_value: input.selected_value,
    edited_requirement_revision_id: edited,
    deferred_trigger_sha256: deferred,
  });
  const source = input.source_override ?? userDecisionAuthorityInputSourceV2({
    requirement_revision_sha256: input.requirement.revision.record_sha256,
    decision_requirement_revision_id: input.decision.decision_requirement_revision_id,
    decision_frontier_sha256: decisionFrontierSha256V2(input.decisions),
    action: input.action,
    action_payload_sha256: actionPayloadSha256,
    at_gate: atGate,
    session_id: "SESSION-1",
    turn_id: `TURN-${input.action}`,
    event_head_sha256: eventHead,
  });
  const authorityInput = finalizeDecisionAuthorityInputV2({
    acceptance: input.graph,
    requirement: input.requirement,
    decisions: input.decisions,
    decision: input.decision,
    authority_actor: "USER",
    action: input.action,
    at_gate: atGate,
    selected_value: input.selected_value,
    edited_requirement_revision_id: edited,
    deferred_trigger_sha256: deferred,
    source,
    session_id: "SESSION-1",
    turn_id: `TURN-${input.action}`,
    event_head_sha256: eventHead,
    due_event: null,
    created_at_ms: input.created_at_ms ?? 3,
  });
  return finalizeDecisionResolutionV2({
    acceptance: input.graph,
    requirement: input.requirement,
    decisions: input.decisions,
    decision: input.decision,
    authority_input: authorityInput.receipt,
    due_event: null,
    resolution_revision: 1,
    parent_resolution_id: null,
    action: input.action,
    authority_actor: "USER",
    at_stage: atGate,
    authority_source_span_id: null,
    selected_value: input.selected_value,
    edited_requirement_revision_id: edited,
    deferred_trigger_sha256: deferred,
    created_at_ms: (input.created_at_ms ?? 3) + 1,
  });
}

describe("Intake/Decision/Goal Fit V2", () => {
  it("seals an order-independent, complete, source-bound Requirement revision", () => {
    const first = draft(["parser", "unicode", "deploy"]).closure;
    const second = draft(["deploy", "parser", "unicode"]).closure;
    expect(first.revision.record_sha256).toBe(second.revision.record_sha256);
    expect(first.items.map((item) => item.semantic_key)).toEqual(["deploy", "parser", "unicode"]);
    expect(first.revision.contract_revision).toBe(1);
  });

  it("rejects a Requirement revision missing any Acceptance facet", () => {
    const { graph, closure } = draft();
    const item = closure.items.find((candidate) => candidate.semantic_key === "parser")!;
    expect(() => finalizeRequirementRevisionV2({
      acceptance: graph,
      revision: 1,
      contract_revision: 1,
      parent_requirement_revision_id: null,
      parent_requirement_revision_sha256: null,
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      items: [{
        key: item.semantic_key, kind: item.kind, priority: item.priority, statement: item.statement,
        acceptance_facet_ids: item.acceptance_facet_ids, source_span_ids: item.source_span_ids,
      }],
      created_at_ms: 2,
    })).toThrow(/cover.*Acceptance facet/iu);
  });

  it("uses NFC text for stable identity and immediate round-trip assertions", () => {
    const { graph, closure } = draft();
    const normalized = finalizeRequirementRevisionV2({
      acceptance: graph,
      revision: 1,
      contract_revision: 1,
      parent_requirement_revision_id: null,
      parent_requirement_revision_sha256: null,
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      items: closure.items.map((item) => ({
        key: item.semantic_key,
        kind: item.kind,
        priority: item.priority,
        statement: item.semantic_key === "parser" ? "Cafe\u0301 parser" : item.statement,
        acceptance_facet_ids: item.acceptance_facet_ids,
        source_span_ids: item.source_span_ids,
      })),
      created_at_ms: 2,
    });
    expect(normalized.items.find((item) => item.semantic_key === "parser")?.statement).toBe("Caf\u00e9 parser");
    expect(() => assertRequirementRevisionClosureV2(normalized)).not.toThrow();
  });

  it("rejects rehashed Decision identity substitution and weak draft-review defaults", () => {
    const { graph, closure } = draft();
    expect(() => finalizeDecisionRequirementsV2({
      acceptance: graph,
      requirement: closure,
      proposals: [{
        key: "draft-review", kind: "DRAFT_REVIEW", question: "Approve?", materiality: "MEDIUM", blocking: false,
        affected_requirement_keys: ["parser"], source_span_ids: [graph.spans[0]!.span_id],
        trigger: { kind: "IMMEDIATE", evidence_sha256: sha256Hex("weak") }, latest_resolution_stage: "CONTRACT_FREEZE",
        default: { action: "APPROVE", value: null }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
        proposal_origin: "PROVIDER_TYPED_PROPOSAL",
      }],
    })).toThrow(/Draft review|High-materiality/iu);

    const decision = decisionProposals(graph, closure)[0]!;
    const { record_sha256: ignored, ...body } = { ...decision, goal_id: "GOAL-SUBSTITUTED" };
    void ignored;
    const forged = { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-DECISION-REQUIREMENT-V2", ...body }) };
    expect(() => assertDecisionRequirementV2(forged)).toThrow(/stable identity/u);
  });

  it("requires explicit USER authority for every irreversible Decision regardless of claimed materiality", () => {
    const { graph, closure } = draft();
    expect(() => finalizeDecisionRequirementsV2({
      acceptance: graph,
      requirement: closure,
      proposals: [{
        key: "irreversible-layout",
        kind: "ARCHITECTURE",
        question: "Permanently replace the storage layout?",
        materiality: "LOW",
        blocking: false,
        affected_requirement_keys: ["parser"],
        source_span_ids: closure.items.find((item) => item.semantic_key === "parser")!.source_span_ids,
        trigger: { kind: "STAGE_ENTRY", evidence_sha256: sha256Hex("irreversible-layout") },
        latest_resolution_stage: "IRREVERSIBLE_ARCHITECTURE",
        default: { action: "APPROVE", value: { replace: true } },
        reversibility: "IRREVERSIBLE",
        affected_work_cell_ids: [],
        proposal_origin: "PROVIDER_TYPED_PROPOSAL",
      }],
    })).toThrow(/irreversible.*USER|USER.*irreversible/iu);
  });

  it("rejects a blocking Decision that can outlive Contract freeze", () => {
    const { graph, closure } = draft();
    expect(() => decisionProposals(graph, closure, [{
      key: "async-blocker",
      kind: "ARCHITECTURE",
      question: "Can this blocking architecture choice wait for later evidence?",
      materiality: "HIGH",
      blocking: true,
      affected_requirement_keys: ["parser"],
      source_span_ids: closure.items.find((item) => item.semantic_key === "parser")!.source_span_ids,
      trigger: { kind: "EVIDENCE_CHANGE", evidence_sha256: sha256Hex("async-blocker-trigger") },
      latest_resolution_stage: "PLAN_ENTRY",
      default: { action: "REJECT", value: null },
      reversibility: "REVERSIBLE",
      affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }])).toThrow(/blocking Decisions require immediate USER authority before Contract freeze/u);
  });

  it("does not permit a blocking Decision to be deferred", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const blocking = decisions[0]!;
    expect(() => userResolution({
      graph,
      requirement: closure,
      decisions,
      decision: blocking,
      action: "DEFER",
      selected_value: null,
      deferred_trigger_sha256: blocking.trigger_sha256,
    })).toThrow(/blocking Decisions cannot be deferred/u);
  });

  it("rejects lexical text as authority and prevents a revision-1 approval receipt from authorizing revision 2", () => {
    const { graph, closure: first } = draft();
    const firstDecisions = decisionProposals(graph, first);
    expect(() => userResolution({
      graph,
      requirement: first,
      decisions: firstDecisions,
      decision: firstDecisions[0]!,
      action: "APPROVE",
      selected_value: { approved: true },
      source_override: "I reject this draft.",
    })).toThrow(/structured action envelope/u);

    const approved = userResolution({
      graph, requirement: first, decisions: firstDecisions, decision: firstDecisions[0]!,
      action: "APPROVE", selected_value: { approved: true },
    });
    const second = finalizeRequirementRevisionV2({
      acceptance: graph,
      revision: 2,
      contract_revision: 2,
      parent_requirement_revision_id: first.revision.requirement_revision_id,
      parent_requirement_revision_sha256: first.revision.record_sha256,
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      items: first.items.map((item) => ({
        key: item.semantic_key, kind: item.kind, priority: item.priority, statement: `${item.statement} v2`,
        acceptance_facet_ids: item.acceptance_facet_ids, source_span_ids: item.source_span_ids,
      })),
      created_at_ms: 5,
    });
    const secondDecisions = decisionProposals(graph, second);
    expect(() => evaluateDecisionClosureV2({
      requirement: second,
      decisions: secondDecisions,
      resolutions: [approved],
      gate: "CONTRACT_FREEZE",
      created_at_ms: 6,
    })).toThrow(/outside the current Decision frontier|another requirement/iu);
  });

  it("prevents one authority receipt from authorizing an opposite action or value", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const decision = decisions[0]!;
    const eventHeadSha256 = sha256Hex(`event-head:${decision.decision_requirement_revision_id}:APPROVE`);
    const selectedValue = { approved: true };
    const source = userDecisionAuthorityInputSourceV2({
      requirement_revision_sha256: closure.revision.record_sha256,
      decision_requirement_revision_id: decision.decision_requirement_revision_id,
      decision_frontier_sha256: decisionFrontierSha256V2(decisions),
      action: "APPROVE",
      action_payload_sha256: decisionActionPayloadSha256V2({
        decision,
        action: "APPROVE",
        selected_value: selectedValue,
        edited_requirement_revision_id: null,
        deferred_trigger_sha256: null,
      }),
      at_gate: "CONTRACT_REVIEW",
      session_id: "SESSION-REPLAY",
      turn_id: "TURN-APPROVE",
      event_head_sha256: eventHeadSha256,
    });
    const authorityInput = finalizeDecisionAuthorityInputV2({
      acceptance: graph,
      requirement: closure,
      decisions,
      decision,
      authority_actor: "USER",
      action: "APPROVE",
      at_gate: "CONTRACT_REVIEW",
      selected_value: selectedValue,
      edited_requirement_revision_id: null,
      deferred_trigger_sha256: null,
      source,
      session_id: "SESSION-REPLAY",
      turn_id: "TURN-APPROVE",
      event_head_sha256: eventHeadSha256,
      due_event: null,
      created_at_ms: 5,
    });
    const baseResolution = {
      acceptance: graph,
      requirement: closure,
      decisions,
      decision,
      authority_input: authorityInput.receipt,
      due_event: null,
      resolution_revision: 1,
      parent_resolution_id: null,
      authority_actor: "USER" as const,
      at_stage: "CONTRACT_REVIEW" as const,
      authority_source_span_id: null,
      edited_requirement_revision_id: null,
      deferred_trigger_sha256: null,
      created_at_ms: 6,
    };
    expect(() => finalizeDecisionResolutionV2({
      ...baseResolution,
      action: "REJECT",
      selected_value: null,
    })).toThrow(/exact frozen action closure/u);
    expect(() => finalizeDecisionResolutionV2({
      ...baseResolution,
      action: "APPROVE",
      selected_value: { approved: false },
    })).toThrow(/exact frozen action closure/u);
  });

  it("qualifies contract freeze only after current explicit USER draft approval", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const approval = userResolution({
      graph, requirement: closure, decisions, decision: decisions[0]!, action: "APPROVE", selected_value: { approved: true },
    });
    const result = evaluateDecisionClosureV2({
      requirement: closure, decisions, resolutions: [approval], gate: "CONTRACT_FREEZE", created_at_ms: 5,
    });
    expect(result.closure).toMatchObject({ qualified: true, draft_review_approved: true });
  });

  it("requires a Host-owned deadline event before applying an exact default", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure, [{
      key: "layout", kind: "ARCHITECTURE", question: "Choose layout", materiality: "MEDIUM", blocking: false,
      affected_requirement_keys: ["parser"], source_span_ids: [graph.spans[0]!.span_id],
      trigger: { kind: "STAGE_ENTRY", evidence_sha256: sha256Hex("layout-trigger") }, latest_resolution_stage: "PLAN_ENTRY",
      default: { action: "APPROVE", value: { local: true } }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }]);
    const decision = decisions.find((candidate) => candidate.decision_key === "layout")!;
    expect(() => finalizeDecisionAuthorityInputV2({
      acceptance: graph, requirement: closure, decisions, decision, authority_actor: "HOST_DEFAULT", action: "APPROVE",
      at_gate: "PLAN_ENTRY", selected_value: { local: true }, edited_requirement_revision_id: null,
      deferred_trigger_sha256: null, source: "{}", session_id: null, turn_id: null,
      event_head_sha256: sha256Hex("plan-entry-head"), due_event: null, created_at_ms: 6,
    })).toThrow(/DueEventReceipt/u);

    const due = finalizeDecisionDueEventReceiptV2({
      acceptance: graph,
      requirement: closure,
      decision,
      purpose: "DEFAULT_DEADLINE",
      trigger_kind: "STAGE_ENTRY",
      trigger_sha256: decisionDeadlineTriggerSha256V2(decision),
      at_gate: "PLAN_ENTRY",
      event_evidence_sha256: sha256Hex("real-plan-entry-event"),
      event_head_sha256: sha256Hex("plan-entry-head"),
      predecessor_resolution_sha256: zeroSha256,
      created_at_ms: 6,
    });
    const source = hostDefaultAuthorityInputSourceV2(
      decision, due, closure.revision.record_sha256, decisionFrontierSha256V2(decisions),
    );
    const authorityInput = finalizeDecisionAuthorityInputV2({
      acceptance: graph, requirement: closure, decisions, decision, authority_actor: "HOST_DEFAULT", action: "APPROVE",
      at_gate: "PLAN_ENTRY", selected_value: { local: true }, edited_requirement_revision_id: null,
      deferred_trigger_sha256: null, source, session_id: null, turn_id: null,
      event_head_sha256: due.event_head_sha256, due_event: due, created_at_ms: 7,
    });
    expect(finalizeDecisionResolutionV2({
      acceptance: graph, requirement: closure, decisions, decision, authority_input: authorityInput.receipt,
      due_event: due, resolution_revision: 1, parent_resolution_id: null, action: "APPROVE",
      authority_actor: "HOST_DEFAULT", at_stage: "PLAN_ENTRY", authority_source_span_id: null,
      selected_value: { local: true }, edited_requirement_revision_id: null, deferred_trigger_sha256: null, created_at_ms: 8,
    }).due_event_receipt_id).toBe(due.due_event_receipt_id);
  });

  it("blocks a deferred Decision once its default deadline is durably due", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure, [{
      key: "layout-deadline", kind: "ARCHITECTURE", question: "Choose layout before planning", materiality: "MEDIUM", blocking: false,
      affected_requirement_keys: ["parser"], source_span_ids: closure.items.find((item) => item.semantic_key === "parser")!.source_span_ids,
      trigger: { kind: "STAGE_ENTRY", evidence_sha256: sha256Hex("layout-deadline-trigger") }, latest_resolution_stage: "PLAN_ENTRY",
      default: { action: "REJECT", value: null }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }]);
    const decision = decisions.find((candidate) => candidate.decision_key === "layout-deadline")!;
    const deferral = userResolution({
      graph, requirement: closure, decisions, decision, action: "DEFER", selected_value: null,
      deferred_trigger_sha256: decision.trigger_sha256,
    });
    const due = finalizeDecisionDueEventReceiptV2({
      acceptance: graph, requirement: closure, decision, purpose: "DEFAULT_DEADLINE", trigger_kind: "STAGE_ENTRY",
      trigger_sha256: decisionDeadlineTriggerSha256V2(decision), at_gate: "PLAN_ENTRY",
      event_evidence_sha256: sha256Hex("plan-entry-event"), event_head_sha256: sha256Hex("plan-entry-head"),
      predecessor_resolution_sha256: deferral.record_sha256, created_at_ms: 9,
    });
    expect(evaluateDecisionClosureV2({
      requirement: closure, decisions, resolutions: [deferral], due_events: [due], gate: "PLAN_ENTRY", created_at_ms: 10,
    }).closure).toMatchObject({
      qualified: false,
      due_deferred_decision_ids: [decision.decision_requirement_id],
    });
  });

  it("makes an asynchronous deferral due before its deadline only after the matching Host event receipt", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure, [{
      key: "evidence-layout", kind: "ARCHITECTURE", question: "Revisit after evidence changes?", materiality: "MEDIUM", blocking: false,
      affected_requirement_keys: ["parser"], source_span_ids: [graph.spans[0]!.span_id],
      trigger: { kind: "EVIDENCE_CHANGE", evidence_sha256: sha256Hex("watched-evidence") }, latest_resolution_stage: "FINAL_CLOSURE",
      default: { action: "REJECT", value: null }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }]);
    const draftReview = decisions.find((decision) => decision.kind === "DRAFT_REVIEW")!;
    const asynchronous = decisions.find((decision) => decision.decision_key === "evidence-layout")!;
    const approval = userResolution({
      graph, requirement: closure, decisions, decision: draftReview, action: "APPROVE", selected_value: { approved: true },
    });
    const deferral = userResolution({
      graph, requirement: closure, decisions, decision: asynchronous, action: "DEFER", selected_value: null,
      deferred_trigger_sha256: asynchronous.trigger_sha256,
    });
    const before = evaluateDecisionClosureV2({
      requirement: closure, decisions, resolutions: [approval, deferral], gate: "MATERIAL_CHANGE", created_at_ms: 8,
    });
    expect(before.closure).toMatchObject({ qualified: true, deferred_decision_ids: [asynchronous.decision_requirement_id] });

    const due = finalizeDecisionDueEventReceiptV2({
      acceptance: graph,
      requirement: closure,
      decision: asynchronous,
      purpose: "DEFERRED_TRIGGER",
      trigger_kind: "EVIDENCE_CHANGE",
      trigger_sha256: asynchronous.trigger_sha256,
      at_gate: "MATERIAL_CHANGE",
      event_evidence_sha256: sha256Hex("changed-evidence"),
      event_head_sha256: sha256Hex("evidence-change-head"),
      predecessor_resolution_sha256: deferral.record_sha256,
      created_at_ms: 9,
    });
    const after = evaluateDecisionClosureV2({
      requirement: closure, decisions, resolutions: [approval, deferral], due_events: [due],
      gate: "MATERIAL_CHANGE", created_at_ms: 10,
    });
    expect(after.closure).toMatchObject({ qualified: false, due_deferred_decision_ids: [asynchronous.decision_requirement_id] });
  });

  it("blocks an asynchronous deferral when its final deadline is reached without a DueEvent receipt", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure, [{
      key: "final-deadline",
      kind: "RISK",
      question: "Resolve this risk before final closure?",
      materiality: "MEDIUM",
      blocking: false,
      affected_requirement_keys: ["parser"],
      source_span_ids: closure.items.find((item) => item.semantic_key === "parser")!.source_span_ids,
      trigger: { kind: "EVIDENCE_CHANGE", evidence_sha256: sha256Hex("final-deadline-trigger") },
      latest_resolution_stage: "FINAL_CLOSURE",
      default: { action: "REJECT", value: null },
      reversibility: "REVERSIBLE",
      affected_work_cell_ids: [],
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    }]);
    const draftReview = decisions.find((decision) => decision.kind === "DRAFT_REVIEW")!;
    const asynchronous = decisions.find((decision) => decision.decision_key === "final-deadline")!;
    const approval = userResolution({
      graph, requirement: closure, decisions, decision: draftReview, action: "APPROVE", selected_value: { approved: true },
    });
    const deferral = userResolution({
      graph, requirement: closure, decisions, decision: asynchronous, action: "DEFER", selected_value: null,
      deferred_trigger_sha256: asynchronous.trigger_sha256,
    });

    expect(evaluateDecisionClosureV2({
      requirement: closure,
      decisions,
      resolutions: [approval, deferral],
      gate: "FINAL_CLOSURE",
      created_at_ms: 10,
    }).closure).toMatchObject({
      qualified: false,
      due_deferred_decision_ids: [asynchronous.decision_requirement_id],
    });
  });

  it("does not let a later-stage resolution authorize an earlier gate", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const draftReview = decisions[0]!;
    const lateApproval = userResolution({
      graph,
      requirement: closure,
      decisions,
      decision: draftReview,
      action: "APPROVE",
      selected_value: { approved: true },
      at_gate: "FINAL_CLOSURE",
    });

    expect(evaluateDecisionClosureV2({
      requirement: closure,
      decisions,
      resolutions: [lateApproval],
      gate: "CONTRACT_FREEZE",
      created_at_ms: 11,
    }).closure).toMatchObject({
      qualified: false,
      unresolved_decision_ids: [draftReview.decision_requirement_id],
    });
  });

  it("does not infer FIT from a qualified Decision closure when typed outcome fidelity requires reframing", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const approval = userResolution({
      graph,
      requirement: closure,
      decisions,
      decision: decisions[0]!,
      action: "APPROVE",
      selected_value: { approved: true },
    });
    const decisionClosure = evaluateDecisionClosureV2({
      requirement: closure,
      decisions,
      resolutions: [approval],
      gate: "CONTRACT_FREEZE",
      created_at_ms: 10,
    });
    const gateInstance = finalizeGoalFitGateInstanceReceiptV2({
      acceptance: graph,
      requirement: closure,
      decision_closure: decisionClosure,
      gate: "CONTRACT_FREEZE",
      gate_subject: {
        kind: "REQUIREMENT_REVISION",
        id: closure.revision.requirement_revision_id,
        record_sha256: closure.revision.record_sha256,
      },
      event_head_sha256: sha256Hex("contract-freeze-head"),
      created_at_ms: 11,
    });
    const pass = {
      status: "PASS" as const,
      reason_codes: ["LOCAL_EVIDENCE_PASSED"],
      coverage: "ALL_CURRENT" as const,
    };
    const assessment = finalizeGoalFitAssessmentV2({
      acceptance: graph,
      requirement: closure,
      decision_closure: decisionClosure,
      gate_instance: gateInstance,
      proposal: {
        proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
        outcome_fidelity: { ...pass, status: "REFRAME", reason_codes: ["OUTCOME_FIDELITY_FAILED"] },
        obligation_coverage: pass,
        unnecessary_design: pass,
        current_decisions: pass,
        invalidations: {
          status: "NOT_APPLICABLE",
          reason_codes: ["NO_ACTIVE_INVALIDATIONS"],
          coverage: "NOT_APPLICABLE",
        },
        gate_specific_evidence: pass,
      },
      created_at_ms: 12,
    });

    expect(deriveGoalFitOutcomeV2(decisionClosure, assessment)).toEqual({
      verdict: "REFRAME",
      reason_codes: ["OUTCOME_FIDELITY_FAILED"],
    });
  });

  it("rejects legacy evidence authority, partial findings and inapplicable current facets before Host lowering", () => {
    const { graph, closure } = draft();
    const decisions = decisionProposals(graph, closure);
    const approval = userResolution({
      graph,
      requirement: closure,
      decisions,
      decision: decisions[0]!,
      action: "APPROVE",
      selected_value: { approved: true },
    });
    const decisionClosure = evaluateDecisionClosureV2({
      requirement: closure,
      decisions,
      resolutions: [approval],
      gate: "CONTRACT_FREEZE",
      created_at_ms: 20,
    });
    const gateInstance = finalizeGoalFitGateInstanceReceiptV2({
      acceptance: graph,
      requirement: closure,
      decision_closure: decisionClosure,
      gate: "CONTRACT_FREEZE",
      gate_subject: {
        kind: "REQUIREMENT_REVISION",
        id: closure.revision.requirement_revision_id,
        record_sha256: closure.revision.record_sha256,
      },
      event_head_sha256: sha256Hex("strict-goal-fit-head"),
      created_at_ms: 21,
    });
    const pass = {
      status: "PASS" as const,
      reason_codes: ["CURRENT_CLOSURE_PASSED"],
      coverage: "ALL_CURRENT" as const,
    };
    const proposal = {
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL" as const,
      outcome_fidelity: pass,
      obligation_coverage: pass,
      unnecessary_design: pass,
      current_decisions: pass,
      invalidations: {
        status: "NOT_APPLICABLE" as const,
        reason_codes: ["NO_ACTIVE_INVALIDATIONS"],
        coverage: "NOT_APPLICABLE" as const,
      },
      gate_specific_evidence: pass,
    } satisfies GoalFitAssessmentProposalV2;
    const finalize = (candidate: unknown) => finalizeGoalFitAssessmentV2({
      acceptance: graph,
      requirement: closure,
      decision_closure: decisionClosure,
      gate_instance: gateInstance,
      proposal: candidate as GoalFitAssessmentProposalV2,
      created_at_ms: 22,
    });
    const injected = [
      { ...proposal, verdict: "FIT" },
      { ...proposal, plan_revision_sha256: sha256Hex("caller-plan") },
      { ...proposal, source_root_sha256: sha256Hex("caller-authority") },
      { ...proposal, outcome_fidelity: { ...pass, subject_ids: ["CALLER-SUBJECT"] } },
      { ...proposal, outcome_fidelity: { ...pass, evidence_receipt_sha256s: [sha256Hex("caller-evidence")] } },
      { ...proposal, outcome_fidelity: { ...pass, evidence: [sha256Hex("caller-evidence-alias")] } },
    ];
    for (const candidate of injected) expect(() => finalize(candidate)).toThrow(/not allowed|unexpected/iu);
    expect(() => finalize({ ...proposal, obligation_coverage: undefined })).toThrow(/object|missing|invalid/iu);
    expect(() => finalize({
      ...proposal,
      outcome_fidelity: {
        status: "NOT_APPLICABLE",
        reason_codes: ["CALLER_IGNORED_CURRENT_OUTCOME"],
        coverage: "NOT_APPLICABLE",
      },
    })).toThrow(/cannot be NOT_APPLICABLE for the current Host closure/iu);
    expect(() => finalize({
      ...proposal,
      outcome_fidelity: { ...pass, coverage: "PARTIAL" },
    })).toThrow(/coverage is invalid/iu);
    const lowered = finalize(proposal);
    expect(lowered.gate_specific_evidence).toEqual({
      status: "PASS",
      reason_codes: ["CURRENT_CLOSURE_PASSED"],
      subject_ids: [closure.revision.requirement_revision_id],
      evidence_receipt_sha256s: [closure.revision.record_sha256, gateInstance.record_sha256].sort(),
    });
    expect(lowered.outcome_fidelity.subject_ids).toEqual(
      graph.facets.filter((facet) => facet.kind === "OUTCOME" || facet.kind === "QUALITY" || facet.kind === "INVARIANT")
        .map((facet) => facet.facet_id).sort(),
    );
    expect(lowered.outcome_fidelity.evidence_receipt_sha256s).toEqual([
      graph.authority.record_sha256,
      graph.authority.facet_root_sha256,
      gateInstance.record_sha256,
    ].sort());
  });
});
