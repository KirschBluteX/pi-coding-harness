import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AcceptanceAuthorityV2Repository } from "../acceptance-v2/repository.js";
import type { AcceptanceProjectionV2 } from "../acceptance-v2/domain.js";
import type {
  AssessedGoalFitReviewBundleV2,
  ContractFreezeReceiptV2,
  DecisionAuthorityInputBundleV2,
  DecisionAuthorityInputReceiptV2,
  DecisionClosureBundleV2,
  DecisionClosureStateV2,
  DecisionDueEventReceiptV2,
  DecisionRequirementProposalV2,
  DecisionRequirementV2,
  DecisionResolutionV2,
  DecisionActionV2,
  GoalFitGateV2,
  GoalFitGateSubjectKindV2,
  GoalFitAssessmentProposalV2,
  GoalFitAssessmentFacetV2,
  GoalFitAssessmentV2,
  GoalFitGateInstanceReceiptV2,
  GoalFitReviewAssessmentBindingV2,
  GoalFitReviewV2,
  IntakeAuthorityProjectionV2,
  RequirementItemProposalV2,
  RequirementItemV2,
  RequirementRevisionClosureV2,
  RequirementRevisionV2,
  TypedProposalOriginV2,
} from "./domain.js";
import {
  assertContractFreezeReceiptV2,
  assertDecisionAuthorityInputReceiptV2,
  assertDecisionClosureV2,
  assertDecisionDueEventReceiptV2,
  assertDecisionRequirementV2,
  assertDecisionResolutionV2,
  assertGoalFitReviewV2,
  assertGoalFitAssessmentV2,
  assertGoalFitGateInstanceReceiptV2,
  assertGoalFitReviewAssessmentBindingV2,
  assertRequirementRevisionClosureV2,
  evaluateDecisionClosureV2,
  finalizeContractFreezeReceiptV2,
  finalizeDecisionAuthorityInputV2,
  decisionActionPayloadSha256V2,
  finalizeDecisionDueEventReceiptV2,
  finalizeDecisionRequirementsV2,
  finalizeDecisionResolutionV2,
  finalizeGoalFitReviewV2,
  finalizeGoalFitAssessmentV2,
  finalizeGoalFitGateInstanceReceiptV2,
  finalizeGoalFitReviewAssessmentBindingV2,
  goalFitAssessmentProposalFromPersistedV2,
  finalizeLegacyGoalFitReviewV2,
  finalizeRequirementRevisionV2,
  hostDefaultAuthorityInputSourceV2,
  decisionFrontierSha256V2,
  userDecisionAuthorityInputSourceV2,
} from "./finalize.js";

const zeroSha256 = "0".repeat(64);

interface ChangeAcceptanceGoalFitRootsV2 {
  readonly plan_revision_sha256: string;
  readonly decision_plan_binding_root_sha256: string;
  readonly change_acceptance_closure_sha256: string;
  readonly invalidation_root_sha256: string;
  readonly oracle_evidence_root_sha256: string;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Intake V2 ${key} is invalid`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new AuthorityIntegrityError(`Intake V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Intake V2 ${key} is invalid`);
  return value;
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) throw new AuthorityIntegrityError(`Intake V2 ${key} is invalid`);
  return value === 1;
}

function json<T extends CanonicalJson>(row: Record<string, unknown>, key: string): T {
  const source = text(row, key);
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    throw new AuthorityIntegrityError(`Intake V2 ${key} is invalid JSON`, error);
  }
  if (canonicalJson(value) !== source) throw new AuthorityIntegrityError(`Intake V2 ${key} is not canonical JSON`);
  return value as T;
}

function stringArray(row: Record<string, unknown>, key: string): readonly string[] {
  const values = json<CanonicalJson[]>(row, key);
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new AuthorityIntegrityError(`Intake V2 ${key} is not a string array`);
  }
  return values as string[];
}

function tableExists(connection: AuthorityConnection, table: string): boolean {
  return connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function assertTransaction(connection: AuthorityConnection, operation: string): void {
  if (!connection.isTransaction) throw new AuthorityIntegrityError(`${operation} must run inside the authority transaction`);
}

function eventSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new AuthorityIntegrityError("Intake V2 event sequence is invalid");
  return value;
}

function root(domain: string, values: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...values].sort() });
}

function groupedMembers(
  rows: readonly Record<string, unknown>[],
  ownerKey: string,
  memberKey: string,
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const owner = text(row, ownerKey);
    const values = grouped.get(owner) ?? [];
    values.push(text(row, memberKey));
    grouped.set(owner, values);
  }
  return grouped;
}

let savepointSequence = 0;

function inSavepoint<T>(connection: AuthorityConnection, label: string, operation: () => T): T {
  const name = `intake_v2_${label}_${++savepointSequence}`;
  connection.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    connection.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    connection.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

export interface IntakeAuthorityIntegritySummaryV2 {
  readonly requirements: number;
  readonly decisions: number;
  readonly authority_inputs: number;
  readonly due_events: number;
  readonly resolutions: number;
  readonly decision_closures: number;
  readonly goal_fit_reviews: number;
  readonly assessed_goal_fit_reviews: number;
  readonly contract_freezes: number;
  readonly goals: number;
}

export class IntakeAuthorityV2Repository {
  readonly #acceptanceCache = new Map<string, AcceptanceProjectionV2>();
  readonly #requirementCache = new Map<string, RequirementRevisionClosureV2>();
  readonly #decisionCache = new Map<string, DecisionRequirementV2>();
  readonly #authorityInputCache = new Map<string, DecisionAuthorityInputReceiptV2>();
  readonly #dueEventCache = new Map<string, DecisionDueEventReceiptV2>();

  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "contract_freeze_receipts_v2");
  }

  appendRequirementProposal(input: {
    readonly goal_id: string;
    readonly expected_parent_requirement_sha256: string;
    readonly proposal_origin: TypedProposalOriginV2;
    readonly items: readonly RequirementItemProposalV2[];
    readonly created_at_ms: number;
  }, sequence: number): RequirementRevisionClosureV2 {
    assertTransaction(this.connection, "Requirement V2 proposal append");
    this.assertAvailable();
    this.assertEventContext(input.goal_id, sequence);
    return inSavepoint(this.connection, "requirement", () => {
      const acceptance = this.currentAcceptance(input.goal_id);
      const parent = this.connection.prepare(`SELECT requirement_revision_id,contract_id,revision,contract_revision,record_sha256
        FROM requirement_revisions_v2 WHERE goal_id=? ORDER BY revision DESC LIMIT 1`).get(input.goal_id) as Record<string, unknown> | undefined;
      const parentSha256 = parent ? text(parent, "record_sha256") : zeroSha256;
      if (parentSha256 !== input.expected_parent_requirement_sha256) {
        throw new AuthorityIntegrityError("Requirement V2 expected-head CAS mismatch");
      }
      const sameContract = parent !== undefined && text(parent, "contract_id") === acceptance.authority.contract_id;
      const closure = finalizeRequirementRevisionV2({
        acceptance,
        revision: parent ? integer(parent, "revision") + 1 : 1,
        contract_revision: sameContract ? integer(parent, "contract_revision") + 1 : 1,
        parent_requirement_revision_id: parent ? text(parent, "requirement_revision_id") : null,
        parent_requirement_revision_sha256: parent ? parentSha256 : null,
        proposal_origin: input.proposal_origin,
        items: input.items,
        created_at_ms: input.created_at_ms,
      });
      this.#insertRequirementRevision(closure, sequence);
      return closure;
    });
  }

  appendDecisionProposals(input: {
    readonly requirement_revision_id: string;
    readonly proposals: readonly DecisionRequirementProposalV2[];
  }, sequence: number): readonly DecisionRequirementV2[] {
    assertTransaction(this.connection, "Decision V2 proposal append");
    this.assertAvailable();
    return inSavepoint(this.connection, "decisions", () => {
      const requirement = this.requirement(input.requirement_revision_id);
      this.assertCurrentRequirement(requirement, true);
      this.assertEventContext(requirement.revision.goal_id, sequence);
      const records = finalizeDecisionRequirementsV2({
        acceptance: this.acceptance(requirement.revision.contract_id), requirement, proposals: input.proposals,
      });
      this.#insertDecisionRequirements(records, sequence);
      const frontier = this.readDecisionRequirements(input.requirement_revision_id);
      if (frontier.filter((decision) => decision.kind === "DRAFT_REVIEW").length > 1) {
        throw new AuthorityIntegrityError("Decision V2 frontier repeats draft review authority");
      }
      return frontier;
    });
  }

  captureStructuredUserDecisionAction(input: {
    readonly decision_requirement_revision_id: string;
    readonly action: DecisionActionV2;
    readonly at_gate: GoalFitGateV2;
    readonly selected_value: CanonicalJson;
    readonly edited_requirement_revision_id: string | null;
    readonly deferred_trigger_sha256: string | null;
    readonly session_id: string;
    readonly turn_id: string;
    readonly created_at_ms: number;
  }, sequence: number): DecisionResolutionV2 {
    const decision = this.decision(input.decision_requirement_revision_id);
    const requirement = this.requirement(decision.requirement_revision_id);
    this.assertCurrentRequirement(requirement, false);
    const decisions = this.readDecisionRequirements(decision.requirement_revision_id);
    const eventHeadSha256 = this.assertEventContext(decision.goal_id, sequence);
    const actionPayloadSha256 = decisionActionPayloadSha256V2({
      decision,
      action: input.action,
      selected_value: input.selected_value,
      edited_requirement_revision_id: input.edited_requirement_revision_id,
      deferred_trigger_sha256: input.deferred_trigger_sha256,
    });
    const source = userDecisionAuthorityInputSourceV2({
      requirement_revision_sha256: requirement.revision.record_sha256,
      decision_requirement_revision_id: decision.decision_requirement_revision_id,
      decision_frontier_sha256: decisionFrontierSha256V2(decisions),
      action: input.action,
      action_payload_sha256: actionPayloadSha256,
      at_gate: input.at_gate,
      session_id: input.session_id,
      turn_id: input.turn_id,
      event_head_sha256: eventHeadSha256,
    });
    return this.captureUserDecisionAction({
      ...input,
      authority_source_span_id: decision.source_span_ids[0] ?? null,
      source,
      event_head_sha256: eventHeadSha256,
    }, sequence);
  }

  captureUserDecisionAction(input: {
    readonly decision_requirement_revision_id: string;
    readonly action: DecisionActionV2;
    readonly at_gate: GoalFitGateV2;
    readonly selected_value: CanonicalJson;
    readonly edited_requirement_revision_id: string | null;
    readonly deferred_trigger_sha256: string | null;
    readonly authority_source_span_id: string | null;
    readonly source: string | Uint8Array;
    readonly session_id: string;
    readonly turn_id: string;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): DecisionResolutionV2 {
    assertTransaction(this.connection, "Decision V2 user action");
    this.assertAvailable();
    return inSavepoint(this.connection, "user_action", () => {
      const decision = this.decision(input.decision_requirement_revision_id);
      const requirement = this.requirement(decision.requirement_revision_id);
      this.assertCurrentRequirement(requirement, false);
      const eventHeadSha256 = this.assertEventContext(decision.goal_id, sequence, input.event_head_sha256);
      const decisions = this.readDecisionRequirements(decision.requirement_revision_id);
      const authorityInput = finalizeDecisionAuthorityInputV2({
        acceptance: this.acceptance(decision.contract_id), requirement, decisions, decision,
        authority_actor: "USER", action: input.action, at_gate: input.at_gate,
        selected_value: input.selected_value, edited_requirement_revision_id: input.edited_requirement_revision_id,
        deferred_trigger_sha256: input.deferred_trigger_sha256, source: input.source,
        session_id: input.session_id, turn_id: input.turn_id, event_head_sha256: eventHeadSha256,
        due_event: null, created_at_ms: input.created_at_ms,
      });
      const authorityInputAlreadyExists = this.#insertDecisionAuthorityInput(authorityInput, sequence);
      const previous = this.latestResolution(decision.decision_requirement_revision_id);
      if (authorityInputAlreadyExists) {
        if (!previous || previous.authority_input_receipt_id !== authorityInput.receipt.authority_input_receipt_id) {
          throw new AuthorityIntegrityError("Decision V2 USER action retry is stale against the current resolution head");
        }
        return previous;
      }
      const resolution = finalizeDecisionResolutionV2({
        acceptance: this.acceptance(decision.contract_id), requirement, decisions, decision,
        authority_input: authorityInput.receipt, due_event: null,
        resolution_revision: previous ? previous.resolution_revision + 1 : 1,
        parent_resolution_id: previous?.decision_resolution_id ?? null,
        action: input.action, authority_actor: "USER", at_stage: input.at_gate,
        authority_source_span_id: input.authority_source_span_id, selected_value: input.selected_value,
        edited_requirement_revision_id: input.edited_requirement_revision_id,
        deferred_trigger_sha256: input.deferred_trigger_sha256, created_at_ms: input.created_at_ms,
      });
      this.#insertDecisionResolution(resolution, sequence);
      return resolution;
    });
  }

  recordDueEvent(input: {
    readonly decision_requirement_revision_id: string;
    readonly purpose: DecisionDueEventReceiptV2["purpose"];
    readonly trigger_kind: DecisionDueEventReceiptV2["trigger_kind"];
    readonly trigger_sha256: string;
    readonly at_gate: GoalFitGateV2;
    readonly event_evidence_sha256: string;
    readonly event_head_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): DecisionDueEventReceiptV2 {
    assertTransaction(this.connection, "Decision V2 due event");
    this.assertAvailable();
    return inSavepoint(this.connection, "due_event", () => {
      const decision = this.decision(input.decision_requirement_revision_id);
      const requirement = this.requirement(decision.requirement_revision_id);
      this.assertCurrentRequirement(requirement, false);
      const eventHeadSha256 = this.assertEventContext(decision.goal_id, sequence, input.event_head_sha256);
      const predecessorResolutionSha256 = this.latestResolution(decision.decision_requirement_revision_id)?.record_sha256 ?? zeroSha256;
      const receipt = finalizeDecisionDueEventReceiptV2({
        acceptance: this.acceptance(decision.contract_id), requirement, decision,
        purpose: input.purpose, trigger_kind: input.trigger_kind, trigger_sha256: input.trigger_sha256,
        at_gate: input.at_gate, event_evidence_sha256: input.event_evidence_sha256,
        event_head_sha256: eventHeadSha256, predecessor_resolution_sha256: predecessorResolutionSha256,
        created_at_ms: input.created_at_ms,
      });
      this.#insertDueEvent(receipt, sequence);
      return receipt;
    });
  }

  applyHostDefault(input: {
    readonly decision_requirement_revision_id: string;
    readonly due_event_receipt_id: string;
    readonly created_at_ms: number;
  }, sequence: number): DecisionResolutionV2 {
    assertTransaction(this.connection, "Decision V2 Host default");
    this.assertAvailable();
    return inSavepoint(this.connection, "host_default", () => {
      const decision = this.decision(input.decision_requirement_revision_id);
      const requirement = this.requirement(decision.requirement_revision_id);
      this.assertCurrentRequirement(requirement, false);
      const eventHeadSha256 = this.assertEventContext(decision.goal_id, sequence);
      const decisions = this.readDecisionRequirements(decision.requirement_revision_id);
      const dueEvent = this.dueEvent(input.due_event_receipt_id);
      const previous = this.latestResolution(decision.decision_requirement_revision_id);
      if (decision.reversibility === "IRREVERSIBLE") {
        throw new AuthorityIntegrityError("Irreversible Decisions require explicit USER authority");
      }
      if (previous?.authority_actor === "HOST_DEFAULT") {
        if (previous.due_event_receipt_id === dueEvent.due_event_receipt_id) return previous;
        throw new AuthorityIntegrityError("Decision V2 Host default cannot replace an existing default resolution");
      }
      if ((previous?.record_sha256 ?? zeroSha256) !== dueEvent.predecessor_resolution_sha256) {
        throw new AuthorityIntegrityError("Decision V2 Host default expected-resolution head is stale after USER or Host authority changed");
      }
      const source = hostDefaultAuthorityInputSourceV2(
        decision, dueEvent, requirement.revision.record_sha256, decisionFrontierSha256V2(decisions),
      );
      const authorityInput = finalizeDecisionAuthorityInputV2({
        acceptance: this.acceptance(decision.contract_id), requirement, decisions, decision,
        authority_actor: "HOST_DEFAULT", action: decision.default_action, at_gate: dueEvent.at_gate,
        selected_value: decision.default_value, edited_requirement_revision_id: null,
        deferred_trigger_sha256: null, source, session_id: null, turn_id: null,
        event_head_sha256: eventHeadSha256, due_event: dueEvent, created_at_ms: input.created_at_ms,
      });
      this.#insertDecisionAuthorityInput(authorityInput, sequence);
      const resolution = finalizeDecisionResolutionV2({
        acceptance: this.acceptance(decision.contract_id), requirement, decisions, decision,
        authority_input: authorityInput.receipt, due_event: dueEvent,
        resolution_revision: previous ? previous.resolution_revision + 1 : 1,
        parent_resolution_id: previous?.decision_resolution_id ?? null,
        action: decision.default_action, authority_actor: "HOST_DEFAULT", at_stage: dueEvent.at_gate,
        authority_source_span_id: null, selected_value: decision.default_value,
        edited_requirement_revision_id: null, deferred_trigger_sha256: null, created_at_ms: input.created_at_ms,
      });
      this.#insertDecisionResolution(resolution, sequence);
      return resolution;
    });
  }

  recordGoalFitReview(input: {
    readonly requirement_revision_id: string;
    readonly decision_closure_id: string;
    readonly gate_subject: {
      readonly kind: GoalFitGateSubjectKindV2;
      readonly id: string;
      readonly record_sha256: string;
    };
    readonly assessment: GoalFitAssessmentProposalV2;
    readonly created_at_ms: number;
  }, sequence: number): AssessedGoalFitReviewBundleV2 {
    assertTransaction(this.connection, "Goal Fit V2 review");
    this.assertAvailable();
    return inSavepoint(this.connection, "goal_fit", () => {
      const requirement = this.requirement(input.requirement_revision_id);
      this.assertCurrentRequirement(requirement, false);
      const eventHeadSha256 = this.assertEventContext(requirement.revision.goal_id, sequence);
      const closure = this.readDecisionClosure(input.decision_closure_id);
      if (!closure || closure.closure.requirement_revision_id !== input.requirement_revision_id) {
        throw new AuthorityIntegrityError("Goal Fit V2 review lacks its exact Decision closure");
      }
      const acceptance = this.acceptance(requirement.revision.contract_id);
      const gateInstance = finalizeGoalFitGateInstanceReceiptV2({
        requirement, acceptance, decision_closure: closure, gate: closure.closure.gate,
        gate_subject: input.gate_subject,
        event_head_sha256: eventHeadSha256, created_at_ms: input.created_at_ms,
      });
      const changeAcceptance = this.changeAcceptanceGoalFitRoots(gateInstance);
      const assessment = finalizeGoalFitAssessmentV2({
        requirement, acceptance, decision_closure: closure, gate_instance: gateInstance,
        ...(changeAcceptance === undefined ? {} : { change_acceptance: changeAcceptance }),
        proposal: input.assessment, created_at_ms: input.created_at_ms,
      });
      const review = finalizeGoalFitReviewV2({
        requirement, acceptance, decision_closure: closure, gate_instance: gateInstance, assessment,
        created_at_ms: input.created_at_ms,
      });
      const binding = finalizeGoalFitReviewAssessmentBindingV2({
        decision_closure: closure, gate_instance: gateInstance, assessment, review, created_at_ms: input.created_at_ms,
      });
      return this.#insertAssessedGoalFitReview({ gate_instance: gateInstance, assessment, review, binding }, sequence);
    });
  }

  #insertRequirementRevision(closure: RequirementRevisionClosureV2, sequence: number): boolean {
    assertTransaction(this.connection, "Requirement V2 append");
    this.assertAvailable();
    eventSequence(sequence);
    assertRequirementRevisionClosureV2(closure);
    const revision = closure.revision;
    const current = this.connection.prepare(`SELECT h.contract_id,a.authority_root_id
      FROM goal_contract_heads_v1 h JOIN acceptance_authority_roots_v2 a ON a.contract_id=h.contract_id
      WHERE h.goal_id=?`).get(revision.goal_id) as Record<string, unknown> | undefined;
    if (!current || text(current, "contract_id") !== revision.contract_id
      || text(current, "authority_root_id") !== revision.authority_root_id) {
      throw new AuthorityIntegrityError("Requirement V2 revision is outside current Acceptance authority");
    }
    const frozen = this.connection.prepare("SELECT 1 FROM contract_freeze_receipts_v2 WHERE contract_id=?")
      .get(revision.contract_id);
    if (frozen) throw new AuthorityIntegrityError("Requirement V2 cannot revise an already frozen contract");
    const existing = this.connection.prepare("SELECT record_sha256 FROM requirement_revisions_v2 WHERE requirement_revision_id=?")
      .get(revision.requirement_revision_id) as Record<string, unknown> | undefined;
    if (existing) {
      if (text(existing, "record_sha256") !== revision.record_sha256) throw new AuthorityIntegrityError("Requirement V2 revision ID substitution");
      const restored = this.readRequirementRevision(revision.requirement_revision_id);
      if (!restored || restored.revision.record_sha256 !== revision.record_sha256) throw new AuthorityIntegrityError("Requirement V2 revision cannot be rebuilt");
      return true;
    }
    this.connection.prepare(`INSERT INTO requirement_revisions_v2(
      requirement_revision_id,goal_id,contract_id,authority_root_id,source_revision_id,revision,contract_revision,
      parent_requirement_revision_id,parent_requirement_revision_sha256,proposal_origin,source_root_sha256,
      span_root_sha256,facet_root_sha256,requirements_root_sha256,input_closure_sha256,item_count,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      revision.requirement_revision_id, revision.goal_id, revision.contract_id, revision.authority_root_id,
      revision.source_revision_id, revision.revision, revision.contract_revision, revision.parent_requirement_revision_id,
      revision.parent_requirement_revision_sha256, revision.proposal_origin, revision.source_root_sha256,
      revision.span_root_sha256, revision.facet_root_sha256, revision.requirements_root_sha256,
      revision.input_closure_sha256, revision.item_count, revision.record_sha256, revision.created_at_ms, sequence,
    );
    const insertItem = this.connection.prepare(`INSERT INTO requirement_items_v2(
      requirement_item_revision_id,requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id,
      semantic_key,kind,priority,statement,facet_ids_json,facet_ids_root_sha256,source_span_ids_json,
      source_span_ids_root_sha256,trace_root_sha256,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFacet = this.connection.prepare(`INSERT INTO requirement_item_facet_members_v2(
      requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id,facet_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    const insertSpan = this.connection.prepare(`INSERT INTO requirement_item_span_members_v2(
      requirement_item_revision_id,requirement_revision_id,goal_id,contract_id,authority_root_id,span_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    for (const item of closure.items) {
      insertItem.run(
        item.requirement_item_revision_id, item.requirement_id, item.requirement_revision_id, item.goal_id,
        item.contract_id, item.authority_root_id, item.semantic_key, item.kind, item.priority, item.statement,
        canonicalJson(item.acceptance_facet_ids), root("PCH-REQUIREMENT-FACET-ID-ROOT-V2", item.acceptance_facet_ids),
        canonicalJson(item.source_span_ids), root("PCH-REQUIREMENT-SPAN-ID-ROOT-V2", item.source_span_ids),
        item.trace_root_sha256, item.record_sha256, sequence,
      );
      item.acceptance_facet_ids.forEach((facetId, ordinal) => insertFacet.run(
        item.requirement_item_revision_id, item.requirement_revision_id, item.goal_id, item.contract_id,
        item.authority_root_id, facetId, ordinal, sequence,
      ));
      item.source_span_ids.forEach((spanId, ordinal) => insertSpan.run(
        item.requirement_item_revision_id, item.requirement_revision_id, item.goal_id, item.contract_id,
        item.authority_root_id, spanId, ordinal, sequence,
      ));
    }
    const restored = this.readRequirementRevision(revision.requirement_revision_id);
    if (!restored || restored.revision.record_sha256 !== revision.record_sha256) throw new AuthorityIntegrityError("Requirement V2 append did not round-trip");
    return false;
  }

  #insertDecisionRequirements(records: readonly DecisionRequirementV2[], sequence: number): number {
    assertTransaction(this.connection, "Decision V2 frontier append");
    this.assertAvailable();
    eventSequence(sequence);
    if (records.length < 1 || records.length > 256) throw new AuthorityIntegrityError("Decision V2 frontier is not bounded");
    const requirementRevisionId = records[0]!.requirement_revision_id;
    const requirement = this.readRequirementRevision(requirementRevisionId);
    if (!requirement) throw new AuthorityIntegrityError("Decision V2 frontier lacks its Requirement revision");
    const itemsById = new Map(requirement.items.map((item) => [item.requirement_id, item]));
    const itemByStableId = new Map(requirement.items.map((item) => [item.requirement_id, item]));
    const insert = this.connection.prepare(`INSERT INTO decision_requirements_v2(
      decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,
      authority_root_id,decision_key,kind,question,materiality,blocking,affected_requirement_ids_json,
      affected_requirement_root_sha256,source_span_ids_json,source_span_root_sha256,trigger_kind,trigger_sha256,
      latest_resolution_stage,default_action,default_value_json,default_sha256,reversibility,
      affected_work_cell_ids_json,affected_work_cell_root_sha256,proposal_origin,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_requirement_revision_id) DO NOTHING`);
    const insertItem = this.connection.prepare(`INSERT INTO decision_requirement_item_members_v2(
      decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id,
      requirement_item_revision_id,requirement_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_requirement_revision_id,requirement_item_revision_id) DO NOTHING`);
    const insertSpan = this.connection.prepare(`INSERT INTO decision_requirement_span_members_v2(
      decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,goal_id,contract_id,authority_root_id,
      span_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_requirement_revision_id,span_id) DO NOTHING`);
    let inserted = 0;
    for (const decision of records) {
      assertDecisionRequirementV2(decision);
      if (decision.requirement_revision_id !== requirementRevisionId || decision.goal_id !== requirement.revision.goal_id
        || decision.contract_id !== requirement.revision.contract_id || decision.authority_root_id !== requirement.revision.authority_root_id) {
        throw new AuthorityIntegrityError("Decision V2 frontier mixes authority closures");
      }
      const result = insert.run(
        decision.decision_requirement_revision_id, decision.decision_requirement_id, decision.requirement_revision_id,
        decision.goal_id, decision.contract_id, decision.authority_root_id, decision.decision_key, decision.kind,
        decision.question, decision.materiality, decision.blocking ? 1 : 0,
        canonicalJson(decision.affected_requirement_ids), root("PCH-DECISION-AFFECTED-REQUIREMENT-ROOT-V2", decision.affected_requirement_ids),
        canonicalJson(decision.source_span_ids), root("PCH-DECISION-SOURCE-SPAN-ROOT-V2", decision.source_span_ids),
        decision.trigger_kind, decision.trigger_sha256, decision.latest_resolution_stage, decision.default_action,
        canonicalJson(decision.default_value), decision.default_sha256, decision.reversibility,
        canonicalJson(decision.affected_work_cell_ids), root("PCH-DECISION-AFFECTED-WORK-CELL-ROOT-V2", decision.affected_work_cell_ids),
        decision.proposal_origin, decision.record_sha256, sequence,
      );
      if (Number(result.changes) === 0) {
        const existing = this.connection.prepare("SELECT record_sha256 FROM decision_requirements_v2 WHERE decision_requirement_revision_id=?")
          .get(decision.decision_requirement_revision_id) as Record<string, unknown> | undefined;
        if (!existing || text(existing, "record_sha256") !== decision.record_sha256) throw new AuthorityIntegrityError("Decision V2 requirement ID substitution");
      } else inserted += 1;
      decision.affected_requirement_ids.forEach((requirementId, ordinal) => {
        const item = itemByStableId.get(requirementId);
        if (!item || !itemsById.has(requirementId)) throw new AuthorityIntegrityError("Decision V2 references a foreign Requirement item");
        insertItem.run(
          decision.decision_requirement_revision_id, decision.decision_requirement_id, decision.requirement_revision_id,
          decision.goal_id, decision.contract_id, decision.authority_root_id, item.requirement_item_revision_id,
          item.requirement_id, ordinal, sequence,
        );
      });
      decision.source_span_ids.forEach((spanId, ordinal) => insertSpan.run(
        decision.decision_requirement_revision_id, decision.decision_requirement_id, decision.requirement_revision_id,
        decision.goal_id, decision.contract_id, decision.authority_root_id, spanId, ordinal, sequence,
      ));
    }
    const restored = this.readDecisionRequirements(requirementRevisionId);
    const restoredById = new Map(restored.map((value) => [value.decision_requirement_revision_id, value]));
    if (records.some((value) => restoredById.get(value.decision_requirement_revision_id)?.record_sha256 !== value.record_sha256)) {
      throw new AuthorityIntegrityError("Decision V2 frontier did not round-trip");
    }
    return inserted;
  }

  #insertDueEvent(receipt: DecisionDueEventReceiptV2, sequence: number): boolean {
    assertDecisionDueEventReceiptV2(receipt);
    const result = this.connection.prepare(`INSERT INTO decision_due_event_receipts_v2(
      due_event_receipt_id,goal_id,contract_id,authority_root_id,decision_requirement_revision_id,
      requirement_revision_id,requirement_revision_sha256,purpose,trigger_kind,trigger_sha256,at_gate,
      event_evidence_sha256,event_head_sha256,predecessor_resolution_sha256,captured_by,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(due_event_receipt_id) DO NOTHING`).run(
      receipt.due_event_receipt_id, receipt.goal_id, receipt.contract_id, receipt.authority_root_id,
      receipt.decision_requirement_revision_id, receipt.requirement_revision_id, receipt.requirement_revision_sha256,
      receipt.purpose, receipt.trigger_kind, receipt.trigger_sha256, receipt.at_gate,
      receipt.event_evidence_sha256, receipt.event_head_sha256, receipt.predecessor_resolution_sha256, receipt.captured_by,
      receipt.record_sha256, receipt.created_at_ms, sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.connection.prepare("SELECT record_sha256 FROM decision_due_event_receipts_v2 WHERE due_event_receipt_id=?")
        .get(receipt.due_event_receipt_id) as Record<string, unknown> | undefined;
      if (!existing || text(existing, "record_sha256") !== receipt.record_sha256) {
        throw new AuthorityIntegrityError("Decision V2 due event receipt ID substitution");
      }
      return true;
    }
    return false;
  }

  #insertDecisionAuthorityInput(bundle: DecisionAuthorityInputBundleV2, sequence: number): boolean {
    assertTransaction(this.connection, "Decision V2 authority input append");
    this.assertAvailable();
    eventSequence(sequence);
    assertDecisionAuthorityInputReceiptV2(bundle.receipt);
    const bytes = Buffer.from(bundle.source_bytes);
    if (bytes.length !== bundle.receipt.byte_length || sha256Hex(bytes) !== bundle.receipt.content_sha256) {
      throw new AuthorityIntegrityError("Decision V2 authority input bytes do not match the Host receipt");
    }
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
      throw new AuthorityIntegrityError("Decision V2 authority input is not exact UTF-8");
    }
    const current = this.connection.prepare(`SELECT h.contract_id,a.authority_root_id
      FROM goal_contract_heads_v1 h JOIN acceptance_authority_roots_v2 a ON a.contract_id=h.contract_id
      WHERE h.goal_id=?`).get(bundle.receipt.goal_id) as Record<string, unknown> | undefined;
    if (!current || text(current, "contract_id") !== bundle.receipt.contract_id
      || text(current, "authority_root_id") !== bundle.receipt.authority_root_id) {
      throw new AuthorityIntegrityError("Decision V2 authority input is outside current Acceptance authority");
    }
    const result = this.connection.prepare(`INSERT INTO decision_authority_inputs_v2(
      authority_input_receipt_id,goal_id,contract_id,authority_root_id,decision_requirement_revision_id,
      requirement_revision_id,requirement_revision_sha256,decision_frontier_sha256,action,action_payload_sha256,at_gate,
      authority_actor,source_kind,session_id,turn_id,event_head_sha256,due_event_receipt_id,
      source_bytes,content_sha256,byte_length,encoding,fidelity,captured_by,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(authority_input_receipt_id) DO NOTHING`).run(
      bundle.receipt.authority_input_receipt_id, bundle.receipt.goal_id, bundle.receipt.contract_id,
      bundle.receipt.authority_root_id, bundle.receipt.decision_requirement_revision_id,
      bundle.receipt.requirement_revision_id, bundle.receipt.requirement_revision_sha256,
      bundle.receipt.decision_frontier_sha256, bundle.receipt.action, bundle.receipt.action_payload_sha256,
      bundle.receipt.at_gate,
      bundle.receipt.authority_actor, bundle.receipt.source_kind, bundle.receipt.session_id, bundle.receipt.turn_id,
      bundle.receipt.event_head_sha256, bundle.receipt.due_event_receipt_id,
      bytes, bundle.receipt.content_sha256, bundle.receipt.byte_length, bundle.receipt.encoding,
      bundle.receipt.fidelity, bundle.receipt.captured_by, bundle.receipt.record_sha256,
      bundle.receipt.created_at_ms, sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.connection.prepare("SELECT record_sha256 FROM decision_authority_inputs_v2 WHERE authority_input_receipt_id=?")
        .get(bundle.receipt.authority_input_receipt_id) as Record<string, unknown> | undefined;
      if (!existing || text(existing, "record_sha256") !== bundle.receipt.record_sha256) {
        throw new AuthorityIntegrityError("Decision V2 authority input receipt ID substitution");
      }
      return true;
    }
    return false;
  }

  #insertDecisionResolution(resolution: DecisionResolutionV2, sequence: number): boolean {
    assertTransaction(this.connection, "Decision V2 resolution append");
    this.assertAvailable();
    eventSequence(sequence);
    assertDecisionResolutionV2(resolution);
    const decision = this.readDecisionRequirement(resolution.decision_requirement_revision_id);
    if (!decision || decision.decision_requirement_id !== resolution.decision_requirement_id
      || decision.requirement_revision_id !== resolution.requirement_revision_id
      || decision.authority_root_id !== resolution.authority_root_id) {
      throw new AuthorityIntegrityError("Decision V2 resolution is outside its frozen requirement");
    }
    const authorityInput = this.readDecisionAuthorityInput(resolution.authority_input_receipt_id);
    if (!authorityInput || authorityInput.goal_id !== resolution.goal_id
      || authorityInput.contract_id !== resolution.contract_id
      || authorityInput.authority_root_id !== resolution.authority_root_id
      || authorityInput.authority_actor !== resolution.authority_actor
      || authorityInput.content_sha256 !== resolution.resolution_input_sha256) {
      throw new AuthorityIntegrityError(`${resolution.authority_actor} authority requires a Host-captured input receipt`);
    }
    const requirement = this.requirement(resolution.requirement_revision_id);
    const decisions = this.readDecisionRequirements(resolution.requirement_revision_id);
    const dueEvent = resolution.due_event_receipt_id === null ? null : this.dueEvent(resolution.due_event_receipt_id);
    const expectedResolution = finalizeDecisionResolutionV2({
      acceptance: this.acceptance(resolution.contract_id),
      requirement,
      decisions,
      decision,
      authority_input: authorityInput,
      due_event: dueEvent,
      resolution_revision: resolution.resolution_revision,
      parent_resolution_id: resolution.parent_resolution_id,
      action: resolution.action,
      authority_actor: resolution.authority_actor,
      at_stage: resolution.at_stage,
      authority_source_span_id: resolution.authority_source_span_id,
      selected_value: resolution.selected_value,
      edited_requirement_revision_id: resolution.edited_requirement_revision_id,
      deferred_trigger_sha256: resolution.deferred_trigger_sha256,
      created_at_ms: resolution.created_at_ms,
    });
    if (expectedResolution.record_sha256 !== resolution.record_sha256) {
      throw new AuthorityIntegrityError("Decision V2 resolution is not Host-derived from its frozen authority input");
    }
    const result = this.connection.prepare(`INSERT INTO decision_resolutions_v2(
      decision_resolution_id,decision_requirement_revision_id,decision_requirement_id,requirement_revision_id,
      goal_id,contract_id,authority_root_id,resolution_revision,parent_resolution_id,action,authority_actor,at_stage,
      decision_frontier_sha256,action_payload_sha256,authority_input_receipt_id,due_event_receipt_id,
      resolution_input_sha256,authority_source_span_id,selected_value_json,selected_value_sha256,
      edited_requirement_revision_id,deferred_trigger_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_resolution_id) DO NOTHING`).run(
      resolution.decision_resolution_id, resolution.decision_requirement_revision_id, resolution.decision_requirement_id,
      resolution.requirement_revision_id, resolution.goal_id, resolution.contract_id, resolution.authority_root_id,
      resolution.resolution_revision, resolution.parent_resolution_id, resolution.action, resolution.authority_actor,
      resolution.at_stage, resolution.decision_frontier_sha256, resolution.action_payload_sha256,
      resolution.authority_input_receipt_id, resolution.due_event_receipt_id,
      resolution.resolution_input_sha256, resolution.authority_source_span_id,
      canonicalJson(resolution.selected_value), resolution.selected_value_sha256, resolution.edited_requirement_revision_id,
      resolution.deferred_trigger_sha256, resolution.record_sha256, resolution.created_at_ms, sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.connection.prepare("SELECT record_sha256 FROM decision_resolutions_v2 WHERE decision_resolution_id=?")
        .get(resolution.decision_resolution_id) as Record<string, unknown> | undefined;
      if (!existing || text(existing, "record_sha256") !== resolution.record_sha256) throw new AuthorityIntegrityError("Decision V2 resolution ID substitution");
      return true;
    }
    return false;
  }

  recordDecisionClosure(
    requirementRevisionId: string, gate: GoalFitGateV2, createdAtMs: number, sequence: number,
  ): DecisionClosureBundleV2 {
    assertTransaction(this.connection, "Decision V2 closure append");
    this.assertAvailable();
    return inSavepoint(this.connection, "decision_closure", () => {
    const requirement = this.readRequirementRevision(requirementRevisionId);
    if (!requirement) throw new AuthorityIntegrityError("Decision V2 closure lacks its Requirement revision");
    this.assertCurrentRequirement(requirement, false);
    this.assertEventContext(requirement.revision.goal_id, sequence);
    const bundle = evaluateDecisionClosureV2({
      requirement,
      decisions: this.readDecisionRequirements(requirementRevisionId),
      resolutions: this.readDecisionResolutions(requirementRevisionId),
      due_events: this.readDueEvents(requirementRevisionId),
      gate,
      created_at_ms: createdAtMs,
    });
    const closure = bundle.closure;
    const result = this.connection.prepare(`INSERT INTO decision_closures_v2(
      decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id,gate,
      decision_root_sha256,resolution_root_sha256,member_root_sha256,unresolved_ids_json,rejected_ids_json,
      edited_ids_json,deferred_ids_json,due_deferred_ids_json,draft_review_approved,qualified,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_closure_id) DO NOTHING`).run(
      closure.decision_closure_id, closure.requirement_revision_id, closure.goal_id, closure.contract_id,
      closure.authority_root_id, closure.gate, closure.decision_root_sha256, closure.resolution_root_sha256,
      closure.member_root_sha256, canonicalJson(closure.unresolved_decision_ids), canonicalJson(closure.rejected_decision_ids),
      canonicalJson(closure.edited_decision_ids), canonicalJson(closure.deferred_decision_ids),
      canonicalJson(closure.due_deferred_decision_ids), closure.draft_review_approved ? 1 : 0, closure.qualified ? 1 : 0,
      closure.record_sha256, closure.created_at_ms, sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.readDecisionClosure(closure.decision_closure_id);
      if (!existing) throw new AuthorityIntegrityError("Decision V2 closure ID substitution");
      return existing;
    }
    const insertMember = this.connection.prepare(`INSERT INTO decision_closure_members_v2(
      decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id,
      decision_requirement_revision_id,decision_requirement_id,decision_resolution_id,state,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_closure_id,decision_requirement_revision_id) DO NOTHING`);
    bundle.members.forEach((member, ordinal) => insertMember.run(
      closure.decision_closure_id, closure.requirement_revision_id, closure.goal_id, closure.contract_id,
      closure.authority_root_id, member.decision_requirement_revision_id, member.decision_requirement_id,
      member.decision_resolution_id, member.state, ordinal, sequence,
    ));
    const restored = this.readDecisionClosure(closure.decision_closure_id);
    if (!restored || restored.closure.record_sha256 !== closure.record_sha256) throw new AuthorityIntegrityError("Decision V2 closure did not round-trip");
    return restored;
    });
  }

  #insertAssessedGoalFitReview(
    bundle: AssessedGoalFitReviewBundleV2,
    sequence: number,
  ): AssessedGoalFitReviewBundleV2 {
    assertTransaction(this.connection, "Goal Fit V2 append");
    this.assertAvailable();
    eventSequence(sequence);
    assertGoalFitGateInstanceReceiptV2(bundle.gate_instance);
    assertGoalFitAssessmentV2(bundle.assessment);
    assertGoalFitReviewAssessmentBindingV2(bundle.binding);
    const restoredExisting = this.readAssessedGoalFitReview(bundle.review.goal_fit_review_id);
    if (restoredExisting) {
      if (restoredExisting.gate_instance.record_sha256 !== bundle.gate_instance.record_sha256
        || restoredExisting.assessment.record_sha256 !== bundle.assessment.record_sha256
        || restoredExisting.review.record_sha256 !== bundle.review.record_sha256
        || restoredExisting.binding.record_sha256 !== bundle.binding.record_sha256) {
        throw new AuthorityIntegrityError("Goal Fit V2 assessed review ID substitution");
      }
      return restoredExisting;
    }
    this.connection.prepare(`INSERT INTO goal_fit_gate_instances_v2(
      gate_instance_receipt_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id,
      gate,gate_subject_kind,gate_subject_id,gate_subject_sha256,requirement_revision_sha256,decision_closure_sha256,
      host_evidence_sha256s_json,host_evidence_root_sha256,event_head_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      bundle.gate_instance.gate_instance_receipt_id, bundle.gate_instance.requirement_revision_id,
      bundle.gate_instance.goal_id, bundle.gate_instance.contract_id, bundle.gate_instance.authority_root_id,
      bundle.gate_instance.decision_closure_id, bundle.gate_instance.gate, bundle.gate_instance.gate_subject_kind,
      bundle.gate_instance.gate_subject_id, bundle.gate_instance.gate_subject_sha256,
      bundle.gate_instance.requirement_revision_sha256, bundle.gate_instance.decision_closure_sha256,
      canonicalJson(bundle.gate_instance.host_evidence_sha256s), bundle.gate_instance.host_evidence_root_sha256,
      bundle.gate_instance.event_head_sha256, bundle.gate_instance.record_sha256, bundle.gate_instance.created_at_ms, sequence,
    );
    const assessment = bundle.assessment;
    this.connection.prepare(`INSERT INTO goal_fit_assessments_v2(
      goal_fit_assessment_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id,gate,
      gate_instance_receipt_id,gate_instance_receipt_sha256,proposal_origin,outcome_fidelity_json,
      obligation_coverage_json,unnecessary_design_json,current_decisions_json,invalidations_json,
      gate_specific_evidence_json,plan_revision_sha256,decision_plan_binding_root_sha256,
      change_acceptance_closure_sha256,invalidation_root_sha256,oracle_evidence_root_sha256,source_root_sha256,
      requirement_root_sha256,decision_closure_sha256,input_closure_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      assessment.goal_fit_assessment_id, assessment.requirement_revision_id, assessment.goal_id, assessment.contract_id,
      assessment.authority_root_id, assessment.decision_closure_id, assessment.gate,
      assessment.gate_instance_receipt_id, assessment.gate_instance_receipt_sha256, assessment.proposal_origin,
      canonicalJson(assessment.outcome_fidelity), canonicalJson(assessment.obligation_coverage),
      canonicalJson(assessment.unnecessary_design), canonicalJson(assessment.current_decisions),
      canonicalJson(assessment.invalidations), canonicalJson(assessment.gate_specific_evidence),
      assessment.plan_revision_sha256, assessment.decision_plan_binding_root_sha256,
      assessment.change_acceptance_closure_sha256, assessment.invalidation_root_sha256,
      assessment.oracle_evidence_root_sha256, assessment.source_root_sha256, assessment.requirement_root_sha256,
      assessment.decision_closure_sha256, assessment.input_closure_sha256, assessment.record_sha256,
      assessment.created_at_ms, sequence,
    );
    const review = bundle.review;
    assertGoalFitReviewV2(review);
    const requirement = this.readRequirementRevision(review.requirement_revision_id);
    const closure = this.readDecisionClosure(review.decision_closure_id);
    if (!requirement || !closure) throw new AuthorityIntegrityError("Goal Fit V2 review lacks its input closure");
    const current = evaluateDecisionClosureV2({
      requirement,
      decisions: this.readDecisionRequirements(review.requirement_revision_id),
      resolutions: this.readDecisionResolutions(review.requirement_revision_id),
      due_events: this.readDueEvents(review.requirement_revision_id),
      gate: review.gate,
      created_at_ms: closure.closure.created_at_ms,
    });
    const latestRevision = this.connection.prepare("SELECT requirement_revision_id FROM requirement_revisions_v2 WHERE goal_id=? ORDER BY revision DESC LIMIT 1")
      .get(review.goal_id) as Record<string, unknown> | undefined;
    if (!latestRevision || text(latestRevision, "requirement_revision_id") !== review.requirement_revision_id
      || current.closure.record_sha256 !== closure.closure.record_sha256
      || review.decision_closure_sha256 !== closure.closure.record_sha256) {
      throw new AuthorityIntegrityError("Goal Fit V2 review is stale");
    }
    const expectedReview = finalizeGoalFitReviewV2({
      requirement,
      acceptance: this.acceptance(review.contract_id),
      decision_closure: closure,
      gate_instance: bundle.gate_instance,
      assessment: bundle.assessment,
      created_at_ms: review.created_at_ms,
    });
    if (expectedReview.record_sha256 !== review.record_sha256) {
      throw new AuthorityIntegrityError("Goal Fit V2 review is not Host-derived from its frozen closure");
    }
    const result = this.connection.prepare(`INSERT INTO goal_fit_reviews_v2(
      goal_fit_review_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id,
      gate,verdict,review_owner,reason_codes_json,reason_code_root_sha256,source_root_sha256,
      requirement_root_sha256,decision_closure_sha256,input_closure_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_fit_review_id) DO NOTHING`).run(
      review.goal_fit_review_id, review.requirement_revision_id, review.goal_id, review.contract_id,
      review.authority_root_id, review.decision_closure_id, review.gate, review.verdict, review.review_owner,
      canonicalJson(review.reason_codes), root("PCH-GOAL-FIT-REASON-CODE-ROOT-V2", review.reason_codes),
      review.source_root_sha256, review.requirement_root_sha256, review.decision_closure_sha256,
      review.input_closure_sha256, review.record_sha256, review.created_at_ms, sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.readGoalFitReview(review.goal_fit_review_id);
      if (!existing) throw new AuthorityIntegrityError("Goal Fit V2 review ID substitution");
      throw new AuthorityIntegrityError("Goal Fit V2 review already exists without its exact assessed binding");
    }
    const binding = bundle.binding;
    this.connection.prepare(`INSERT INTO goal_fit_review_assessment_bindings_v2(
      goal_fit_review_id,goal_fit_review_sha256,goal_fit_assessment_id,goal_fit_assessment_sha256,
      gate_instance_receipt_id,gate_instance_receipt_sha256,requirement_revision_id,goal_id,contract_id,authority_root_id,
      decision_closure_id,gate,derived_verdict,derived_reason_codes_json,derived_reason_code_root_sha256,
      qualification_status,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      binding.goal_fit_review_id, binding.goal_fit_review_sha256, binding.goal_fit_assessment_id,
      binding.goal_fit_assessment_sha256, binding.gate_instance_receipt_id, binding.gate_instance_receipt_sha256,
      binding.requirement_revision_id, binding.goal_id, binding.contract_id, binding.authority_root_id,
      binding.decision_closure_id, binding.gate, binding.derived_verdict, canonicalJson(binding.derived_reason_codes),
      binding.derived_reason_code_root_sha256, binding.qualification_status, binding.record_sha256,
      binding.created_at_ms, sequence,
    );
    const restored = this.readAssessedGoalFitReview(review.goal_fit_review_id);
    if (!restored || restored.review.record_sha256 !== review.record_sha256
      || restored.binding.record_sha256 !== binding.record_sha256) {
      throw new AuthorityIntegrityError("Goal Fit V2 assessed review did not round-trip");
    }
    return restored;
  }

  freezeContract(input: {
    readonly goal_id: string;
    readonly expected_predecessor_freeze_sha256: string;
    readonly created_at_ms: number;
  }, sequence: number): ContractFreezeReceiptV2 {
    assertTransaction(this.connection, "Contract freeze V2 append");
    this.assertAvailable();
    return inSavepoint(this.connection, "contract_freeze", () => {
    const current = this.connection.prepare(`SELECT h.contract_id,c.record_sha256,a.authority_root_id
      FROM goal_contract_heads_v1 h JOIN goal_contract_versions_v1 c ON c.contract_id=h.contract_id
      JOIN acceptance_authority_roots_v2 a ON a.contract_id=c.contract_id
      WHERE h.goal_id=?`).get(input.goal_id) as Record<string, unknown> | undefined;
    if (!current) throw new AuthorityIntegrityError("Contract freeze V2 lacks current contract authority");
    this.assertEventContext(input.goal_id, sequence);
    const existingCurrent = this.connection.prepare("SELECT contract_freeze_receipt_id,predecessor_freeze_sha256,created_at_ms FROM contract_freeze_receipts_v2 WHERE contract_id=?")
      .get(text(current, "contract_id")) as Record<string, unknown> | undefined;
    if (existingCurrent) {
      if (text(existingCurrent, "predecessor_freeze_sha256") === input.expected_predecessor_freeze_sha256
        && integer(existingCurrent, "created_at_ms") === input.created_at_ms) {
        const restored = this.readLatestContractFreeze(input.goal_id);
        if (restored && restored.contract_freeze_receipt_id === text(existingCurrent, "contract_freeze_receipt_id")) return restored;
      }
      throw new AuthorityIntegrityError("Contract freeze V2 expected-head CAS mismatch");
    }
    const latestRequirement = this.connection.prepare(`SELECT requirement_revision_id FROM requirement_revisions_v2
      WHERE goal_id=? AND contract_id=? ORDER BY revision DESC LIMIT 1`).get(input.goal_id, text(current, "contract_id")) as Record<string, unknown> | undefined;
    if (!latestRequirement) throw new AuthorityIntegrityError("Contract freeze V2 lacks a Requirement revision");
    const requirement = this.readRequirementRevision(text(latestRequirement, "requirement_revision_id"));
    if (!requirement) throw new AuthorityIntegrityError("Contract freeze V2 Requirement closure is invalid");
    const decisions = this.readDecisionRequirements(requirement.revision.requirement_revision_id);
    const resolutions = this.readDecisionResolutions(requirement.revision.requirement_revision_id);
    const dueEvents = this.readDueEvents(requirement.revision.requirement_revision_id);
    const currentResolutionClosure = evaluateDecisionClosureV2({
      requirement, decisions, resolutions, due_events: dueEvents,
      gate: "CONTRACT_FREEZE",
      created_at_ms: input.created_at_ms,
    });
    const storedClosure = this.connection.prepare(`SELECT decision_closure_id FROM decision_closures_v2
      WHERE requirement_revision_id=? AND gate='CONTRACT_FREEZE' AND resolution_root_sha256=?
      ORDER BY created_event_sequence DESC LIMIT 1`).get(
      requirement.revision.requirement_revision_id, currentResolutionClosure.closure.resolution_root_sha256,
    ) as Record<string, unknown> | undefined;
    if (!storedClosure) throw new AuthorityIntegrityError("Contract freeze V2 lacks a fresh Decision closure");
    const closure = this.readDecisionClosure(text(storedClosure, "decision_closure_id"));
    const recomputed = closure ? evaluateDecisionClosureV2({
      requirement, decisions, resolutions, due_events: dueEvents,
      gate: "CONTRACT_FREEZE",
      created_at_ms: closure.closure.created_at_ms,
    }) : null;
    if (!closure || !recomputed || closure.closure.record_sha256 !== recomputed.closure.record_sha256) {
      throw new AuthorityIntegrityError("Contract freeze V2 Decision closure is stale");
    }
    const reviewRow = this.connection.prepare(`SELECT goal_fit_review_id FROM goal_fit_reviews_v2
      WHERE requirement_revision_id=? AND decision_closure_id=? AND gate='CONTRACT_FREEZE' AND verdict='FIT'
      ORDER BY created_event_sequence DESC LIMIT 1`).get(
      requirement.revision.requirement_revision_id, closure.closure.decision_closure_id,
    ) as Record<string, unknown> | undefined;
    if (!reviewRow) throw new AuthorityIntegrityError("Contract freeze V2 lacks a fresh Goal Fit review");
    const assessedReview = this.readAssessedGoalFitReview(text(reviewRow, "goal_fit_review_id"));
    if (!assessedReview || assessedReview.review.verdict !== "FIT") {
      throw new AuthorityIntegrityError("Contract freeze V2 Goal Fit review is not currently assessed");
    }
    const review = assessedReview.review;
    const predecessorRow = this.connection.prepare(`SELECT generation,record_sha256 FROM contract_freeze_receipts_v2
      WHERE goal_id=? ORDER BY generation DESC LIMIT 1`).get(input.goal_id) as Record<string, unknown> | undefined;
    const predecessor = predecessorRow ? text(predecessorRow, "record_sha256") : zeroSha256;
    if (predecessor !== input.expected_predecessor_freeze_sha256) {
      throw new AuthorityIntegrityError("Contract freeze V2 expected-head CAS mismatch");
    }
    const acceptance = this.acceptance(text(current, "contract_id"));
    const receipt = finalizeContractFreezeReceiptV2({
      requirement,
      acceptance,
      decision_closure: closure,
      goal_fit_review: review,
      contract_sha256: text(current, "record_sha256"),
      generation: predecessorRow ? integer(predecessorRow, "generation") + 1 : 1,
      predecessor_freeze_sha256: predecessor,
      created_at_ms: input.created_at_ms,
    });
    this.connection.prepare(`INSERT INTO contract_freeze_receipts_v2(
      contract_freeze_receipt_id,goal_id,contract_id,authority_root_id,requirement_revision_id,
      decision_closure_id,goal_fit_review_id,generation,predecessor_freeze_sha256,contract_sha256,
      source_root_sha256,facet_root_sha256,requirement_root_sha256,decision_root_sha256,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.contract_freeze_receipt_id, receipt.goal_id, receipt.contract_id, receipt.authority_root_id,
      receipt.requirement_revision_id, receipt.decision_closure_id, receipt.goal_fit_review_id,
      receipt.generation, receipt.predecessor_freeze_sha256, receipt.contract_sha256, receipt.source_root_sha256,
      receipt.facet_root_sha256, receipt.requirement_root_sha256, receipt.decision_root_sha256,
      receipt.record_sha256, receipt.created_at_ms, sequence,
    );
    return receipt;
    });
  }

  readRequirementRevision(requirementRevisionId: string): RequirementRevisionClosureV2 | null {
    const cached = this.#requirementCache.get(requirementRevisionId);
    if (cached) return cached;
    const row = this.connection.prepare("SELECT * FROM requirement_revisions_v2 WHERE requirement_revision_id=?")
      .get(requirementRevisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const revision: RequirementRevisionV2 = {
      schema_version: 2,
      requirement_revision_id: text(row, "requirement_revision_id"), goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      source_revision_id: text(row, "source_revision_id"), revision: integer(row, "revision"),
      contract_revision: integer(row, "contract_revision"),
      parent_requirement_revision_id: nullableText(row, "parent_requirement_revision_id"),
      parent_requirement_revision_sha256: nullableText(row, "parent_requirement_revision_sha256"),
      proposal_origin: text(row, "proposal_origin") as RequirementRevisionV2["proposal_origin"],
      source_root_sha256: text(row, "source_root_sha256"), span_root_sha256: text(row, "span_root_sha256"),
      facet_root_sha256: text(row, "facet_root_sha256"), requirements_root_sha256: text(row, "requirements_root_sha256"),
      input_closure_sha256: text(row, "input_closure_sha256"), item_count: integer(row, "item_count"),
      created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    const itemRows = this.connection.prepare("SELECT * FROM requirement_items_v2 WHERE requirement_revision_id=? ORDER BY semantic_key")
      .all(requirementRevisionId) as Record<string, unknown>[];
    const facetMembers = groupedMembers(this.connection.prepare(`SELECT requirement_item_revision_id,facet_id
      FROM requirement_item_facet_members_v2 WHERE requirement_revision_id=?
      ORDER BY requirement_item_revision_id,ordinal`).all(requirementRevisionId) as Record<string, unknown>[],
    "requirement_item_revision_id", "facet_id");
    const spanMembers = groupedMembers(this.connection.prepare(`SELECT requirement_item_revision_id,span_id
      FROM requirement_item_span_members_v2 WHERE requirement_revision_id=?
      ORDER BY requirement_item_revision_id,ordinal`).all(requirementRevisionId) as Record<string, unknown>[],
    "requirement_item_revision_id", "span_id");
    const items = itemRows.map((item): RequirementItemV2 => {
      const facets = stringArray(item, "facet_ids_json");
      const spans = stringArray(item, "source_span_ids_json");
      if (root("PCH-REQUIREMENT-FACET-ID-ROOT-V2", facets) !== text(item, "facet_ids_root_sha256")
        || root("PCH-REQUIREMENT-SPAN-ID-ROOT-V2", spans) !== text(item, "source_span_ids_root_sha256")) {
        throw new AuthorityIntegrityError("Requirement V2 member ID root mismatch");
      }
      const itemRevisionId = text(item, "requirement_item_revision_id");
      const storedFacets = facetMembers.get(itemRevisionId) ?? [];
      const storedSpans = spanMembers.get(itemRevisionId) ?? [];
      if (canonicalJson(storedFacets) !== canonicalJson(facets) || canonicalJson(storedSpans) !== canonicalJson(spans)) {
        throw new AuthorityIntegrityError("Requirement V2 member closure mismatch");
      }
      return {
        schema_version: 2,
        requirement_item_revision_id: text(item, "requirement_item_revision_id"),
        requirement_id: text(item, "requirement_id"), requirement_revision_id: text(item, "requirement_revision_id"),
        goal_id: text(item, "goal_id"), contract_id: text(item, "contract_id"),
        authority_root_id: text(item, "authority_root_id"), semantic_key: text(item, "semantic_key"),
        kind: text(item, "kind") as RequirementItemV2["kind"], priority: text(item, "priority") as RequirementItemV2["priority"],
        statement: text(item, "statement"), acceptance_facet_ids: facets, source_span_ids: spans,
        trace_root_sha256: text(item, "trace_root_sha256"), record_sha256: text(item, "record_sha256"),
      };
    });
    const closure = { revision, items };
    try { assertRequirementRevisionClosureV2(closure); } catch (error) {
      throw new AuthorityIntegrityError("Stored Requirement V2 closure is invalid", error);
    }
    const acceptanceFacetIds = this.acceptance(revision.contract_id).facets.map((facet) => facet.facet_id).sort();
    const coveredFacetIds = [...new Set(items.flatMap((item) => item.acceptance_facet_ids))].sort();
    if (canonicalJson(acceptanceFacetIds) !== canonicalJson(coveredFacetIds)) {
      throw new AuthorityIntegrityError("Stored Requirement V2 closure does not cover complete Acceptance authority");
    }
    this.#requirementCache.set(requirementRevisionId, closure);
    return closure;
  }

  readDecisionRequirements(requirementRevisionId: string): readonly DecisionRequirementV2[] {
    const rows = this.connection.prepare("SELECT * FROM decision_requirements_v2 WHERE requirement_revision_id=? ORDER BY decision_key")
      .all(requirementRevisionId) as Record<string, unknown>[];
    const itemMembers = groupedMembers(this.connection.prepare(`SELECT decision_requirement_revision_id,requirement_id
      FROM decision_requirement_item_members_v2 WHERE requirement_revision_id=?
      ORDER BY decision_requirement_revision_id,ordinal`).all(requirementRevisionId) as Record<string, unknown>[],
    "decision_requirement_revision_id", "requirement_id");
    const spanMembers = groupedMembers(this.connection.prepare(`SELECT decision_requirement_revision_id,span_id
      FROM decision_requirement_span_members_v2 WHERE requirement_revision_id=?
      ORDER BY decision_requirement_revision_id,ordinal`).all(requirementRevisionId) as Record<string, unknown>[],
    "decision_requirement_revision_id", "span_id");
    return rows.map((row) => {
      const decisionId = text(row, "decision_requirement_revision_id");
      return this.decisionFromRow(row, itemMembers.get(decisionId) ?? [], spanMembers.get(decisionId) ?? []);
    });
  }

  readDecisionResolutions(requirementRevisionId: string): readonly DecisionResolutionV2[] {
    return this.readDecisionResolutionsBefore(requirementRevisionId, null);
  }

  private readDecisionResolutionsBefore(
    requirementRevisionId: string, beforeEventSequence: number | null,
  ): readonly DecisionResolutionV2[] {
    const rows = (beforeEventSequence === null
      ? this.connection.prepare(`SELECT * FROM decision_resolutions_v2 WHERE requirement_revision_id=?
        ORDER BY decision_requirement_revision_id,resolution_revision`).all(requirementRevisionId)
      : this.connection.prepare(`SELECT * FROM decision_resolutions_v2
        WHERE requirement_revision_id=? AND created_event_sequence<?
        ORDER BY decision_requirement_revision_id,resolution_revision`).all(requirementRevisionId, beforeEventSequence)
    ) as Record<string, unknown>[];
    return rows.map((row) => {
      const resolution = this.resolutionFromRow(row);
      const decision = this.readDecisionRequirement(resolution.decision_requirement_revision_id);
      const authorityInput = this.readDecisionAuthorityInput(resolution.authority_input_receipt_id);
      if (!decision || !authorityInput) throw new AuthorityIntegrityError("Stored Decision V2 resolution lost its authority closure");
      const requirement = this.requirement(resolution.requirement_revision_id);
      const dueEvent = resolution.due_event_receipt_id === null ? null : this.dueEvent(resolution.due_event_receipt_id);
      if (authorityInput.requirement_revision_id !== requirement.revision.requirement_revision_id
        || authorityInput.requirement_revision_sha256 !== requirement.revision.record_sha256
        || authorityInput.decision_requirement_revision_id !== decision.decision_requirement_revision_id
        || authorityInput.decision_frontier_sha256 !== resolution.decision_frontier_sha256
        || authorityInput.action !== resolution.action
        || authorityInput.action_payload_sha256 !== resolution.action_payload_sha256
        || authorityInput.at_gate !== resolution.at_stage
        || authorityInput.due_event_receipt_id !== (dueEvent?.due_event_receipt_id ?? null)) {
        throw new AuthorityIntegrityError("Stored Decision V2 resolution authority binding is invalid");
      }
      return resolution;
    });
  }

  readDecisionClosure(decisionClosureId: string): DecisionClosureBundleV2 | null {
    const row = this.connection.prepare("SELECT * FROM decision_closures_v2 WHERE decision_closure_id=?")
      .get(decisionClosureId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const members = (this.connection.prepare("SELECT * FROM decision_closure_members_v2 WHERE decision_closure_id=? ORDER BY ordinal")
      .all(decisionClosureId) as Record<string, unknown>[]).map((member) => ({
        decision_requirement_revision_id: text(member, "decision_requirement_revision_id"),
        decision_requirement_id: text(member, "decision_requirement_id"),
        decision_resolution_id: nullableText(member, "decision_resolution_id"),
        state: text(member, "state") as DecisionClosureStateV2,
      }));
    const bundle: DecisionClosureBundleV2 = {
      closure: {
        schema_version: 2, decision_closure_id: text(row, "decision_closure_id"),
        requirement_revision_id: text(row, "requirement_revision_id"), goal_id: text(row, "goal_id"),
        contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
        gate: text(row, "gate") as GoalFitGateV2, decision_root_sha256: text(row, "decision_root_sha256"),
        resolution_root_sha256: text(row, "resolution_root_sha256"), member_root_sha256: text(row, "member_root_sha256"),
        unresolved_decision_ids: stringArray(row, "unresolved_ids_json"), rejected_decision_ids: stringArray(row, "rejected_ids_json"),
        edited_decision_ids: stringArray(row, "edited_ids_json"), deferred_decision_ids: stringArray(row, "deferred_ids_json"),
        due_deferred_decision_ids: stringArray(row, "due_deferred_ids_json"),
        draft_review_approved: boolean(row, "draft_review_approved"), qualified: boolean(row, "qualified"),
        created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
      },
      members,
    };
    try { assertDecisionClosureV2(bundle); } catch (error) {
      throw new AuthorityIntegrityError("Stored Decision V2 closure is invalid", error);
    }
    const requirement = this.requirement(bundle.closure.requirement_revision_id);
    const closureEventSequence = integer(row, "created_event_sequence");
    const expected = evaluateDecisionClosureV2({
      requirement,
      decisions: this.readDecisionRequirements(bundle.closure.requirement_revision_id),
      resolutions: this.readDecisionResolutionsBefore(bundle.closure.requirement_revision_id, closureEventSequence),
      due_events: this.readDueEventsBefore(bundle.closure.requirement_revision_id, closureEventSequence),
      gate: bundle.closure.gate,
      created_at_ms: bundle.closure.created_at_ms,
    });
    if (expected.closure.record_sha256 !== bundle.closure.record_sha256) {
      throw new AuthorityIntegrityError("Stored Decision V2 closure is not a complete Host-derived projection");
    }
    return bundle;
  }

  readGoalFitReview(goalFitReviewId: string): GoalFitReviewV2 | null {
    const review = this.goalFitReviewRecord(goalFitReviewId);
    if (!review) return null;
    const assessed = this.connection.prepare(
      "SELECT 1 FROM goal_fit_review_assessment_bindings_v2 WHERE goal_fit_review_id=?",
    ).get(goalFitReviewId);
    if (assessed) return this.readAssessedGoalFitReview(goalFitReviewId)?.review ?? null;
    const requirement = this.readRequirementRevision(review.requirement_revision_id);
    const closure = this.readDecisionClosure(review.decision_closure_id);
    if (!requirement || !closure) throw new AuthorityIntegrityError("Stored Goal Fit V2 review lost its input closure");
    const expected = finalizeLegacyGoalFitReviewV2({
      requirement,
      acceptance: this.acceptance(review.contract_id),
      decision_closure: closure,
      gate: review.gate,
      verdict: review.verdict,
      reason_codes: review.reason_codes,
      created_at_ms: review.created_at_ms,
    });
    if (expected.record_sha256 !== review.record_sha256) {
      throw new AuthorityIntegrityError("Stored legacy Goal Fit V2 review is not Host-derived");
    }
    return review;
  }

  private goalFitReviewRecord(goalFitReviewId: string): GoalFitReviewV2 | null {
    const row = this.connection.prepare("SELECT * FROM goal_fit_reviews_v2 WHERE goal_fit_review_id=?")
      .get(goalFitReviewId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const review: GoalFitReviewV2 = {
      schema_version: 2, goal_fit_review_id: text(row, "goal_fit_review_id"),
      requirement_revision_id: text(row, "requirement_revision_id"), goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      decision_closure_id: text(row, "decision_closure_id"), gate: text(row, "gate") as GoalFitGateV2,
      verdict: text(row, "verdict") as GoalFitReviewV2["verdict"], review_owner: "HOST",
      reason_codes: stringArray(row, "reason_codes_json"), source_root_sha256: text(row, "source_root_sha256"),
      requirement_root_sha256: text(row, "requirement_root_sha256"),
      decision_closure_sha256: text(row, "decision_closure_sha256"), input_closure_sha256: text(row, "input_closure_sha256"),
      created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    try { assertGoalFitReviewV2(review); } catch (error) {
      throw new AuthorityIntegrityError("Stored Goal Fit V2 review is invalid", error);
    }
    return review;
  }

  readAssessedGoalFitReview(goalFitReviewId: string): AssessedGoalFitReviewBundleV2 | null {
    const bindingRow = this.connection.prepare(
      "SELECT * FROM goal_fit_review_assessment_bindings_v2 WHERE goal_fit_review_id=?",
    ).get(goalFitReviewId) as Record<string, unknown> | undefined;
    if (!bindingRow) return null;
    const gateRow = this.connection.prepare(
      "SELECT * FROM goal_fit_gate_instances_v2 WHERE gate_instance_receipt_id=?",
    ).get(text(bindingRow, "gate_instance_receipt_id")) as Record<string, unknown> | undefined;
    const assessmentRow = this.connection.prepare(
      "SELECT * FROM goal_fit_assessments_v2 WHERE goal_fit_assessment_id=?",
    ).get(text(bindingRow, "goal_fit_assessment_id")) as Record<string, unknown> | undefined;
    const review = this.goalFitReviewRecord(goalFitReviewId);
    if (!gateRow || !assessmentRow || !review) {
      throw new AuthorityIntegrityError("Assessed Goal Fit V2 review lost its authority closure");
    }
    const gateInstance: GoalFitGateInstanceReceiptV2 = {
      schema_version: 2, gate_instance_receipt_id: text(gateRow, "gate_instance_receipt_id"),
      requirement_revision_id: text(gateRow, "requirement_revision_id"), goal_id: text(gateRow, "goal_id"),
      contract_id: text(gateRow, "contract_id"), authority_root_id: text(gateRow, "authority_root_id"),
      decision_closure_id: text(gateRow, "decision_closure_id"), gate: text(gateRow, "gate") as GoalFitGateV2,
      gate_subject_kind: text(gateRow, "gate_subject_kind") as GoalFitGateSubjectKindV2,
      gate_subject_id: text(gateRow, "gate_subject_id"), gate_subject_sha256: text(gateRow, "gate_subject_sha256"),
      requirement_revision_sha256: text(gateRow, "requirement_revision_sha256"),
      decision_closure_sha256: text(gateRow, "decision_closure_sha256"),
      host_evidence_sha256s: stringArray(gateRow, "host_evidence_sha256s_json"),
      host_evidence_root_sha256: text(gateRow, "host_evidence_root_sha256"),
      event_head_sha256: text(gateRow, "event_head_sha256"), created_at_ms: integer(gateRow, "created_at_ms"),
      record_sha256: text(gateRow, "record_sha256"),
    };
    const assessment: GoalFitAssessmentV2 = {
      schema_version: 2, goal_fit_assessment_id: text(assessmentRow, "goal_fit_assessment_id"),
      requirement_revision_id: text(assessmentRow, "requirement_revision_id"), goal_id: text(assessmentRow, "goal_id"),
      contract_id: text(assessmentRow, "contract_id"), authority_root_id: text(assessmentRow, "authority_root_id"),
      decision_closure_id: text(assessmentRow, "decision_closure_id"),
      gate: text(assessmentRow, "gate") as GoalFitGateV2,
      gate_instance_receipt_id: text(assessmentRow, "gate_instance_receipt_id"),
      gate_instance_receipt_sha256: text(assessmentRow, "gate_instance_receipt_sha256"),
      proposal_origin: text(assessmentRow, "proposal_origin") as GoalFitAssessmentV2["proposal_origin"],
      outcome_fidelity: json(assessmentRow, "outcome_fidelity_json") as unknown as GoalFitAssessmentFacetV2,
      obligation_coverage: json(assessmentRow, "obligation_coverage_json") as unknown as GoalFitAssessmentFacetV2,
      unnecessary_design: json(assessmentRow, "unnecessary_design_json") as unknown as GoalFitAssessmentFacetV2,
      current_decisions: json(assessmentRow, "current_decisions_json") as unknown as GoalFitAssessmentFacetV2,
      invalidations: json(assessmentRow, "invalidations_json") as unknown as GoalFitAssessmentFacetV2,
      gate_specific_evidence: json(assessmentRow, "gate_specific_evidence_json") as unknown as GoalFitAssessmentFacetV2,
      plan_revision_sha256: nullableText(assessmentRow, "plan_revision_sha256"),
      decision_plan_binding_root_sha256: nullableText(assessmentRow, "decision_plan_binding_root_sha256"),
      change_acceptance_closure_sha256: nullableText(assessmentRow, "change_acceptance_closure_sha256"),
      invalidation_root_sha256: nullableText(assessmentRow, "invalidation_root_sha256"),
      oracle_evidence_root_sha256: nullableText(assessmentRow, "oracle_evidence_root_sha256"),
      source_root_sha256: text(assessmentRow, "source_root_sha256"),
      requirement_root_sha256: text(assessmentRow, "requirement_root_sha256"),
      decision_closure_sha256: text(assessmentRow, "decision_closure_sha256"),
      input_closure_sha256: text(assessmentRow, "input_closure_sha256"),
      created_at_ms: integer(assessmentRow, "created_at_ms"), record_sha256: text(assessmentRow, "record_sha256"),
    };
    const binding: GoalFitReviewAssessmentBindingV2 = {
      schema_version: 2, goal_fit_review_id: text(bindingRow, "goal_fit_review_id"),
      goal_fit_review_sha256: text(bindingRow, "goal_fit_review_sha256"),
      goal_fit_assessment_id: text(bindingRow, "goal_fit_assessment_id"),
      goal_fit_assessment_sha256: text(bindingRow, "goal_fit_assessment_sha256"),
      gate_instance_receipt_id: text(bindingRow, "gate_instance_receipt_id"),
      gate_instance_receipt_sha256: text(bindingRow, "gate_instance_receipt_sha256"),
      requirement_revision_id: text(bindingRow, "requirement_revision_id"), goal_id: text(bindingRow, "goal_id"),
      contract_id: text(bindingRow, "contract_id"), authority_root_id: text(bindingRow, "authority_root_id"),
      decision_closure_id: text(bindingRow, "decision_closure_id"), gate: text(bindingRow, "gate") as GoalFitGateV2,
      derived_verdict: text(bindingRow, "derived_verdict") as GoalFitReviewV2["verdict"],
      derived_reason_codes: stringArray(bindingRow, "derived_reason_codes_json"),
      derived_reason_code_root_sha256: text(bindingRow, "derived_reason_code_root_sha256"),
      qualification_status: "CURRENT_ASSESSED", created_at_ms: integer(bindingRow, "created_at_ms"),
      record_sha256: text(bindingRow, "record_sha256"),
    };
    try {
      assertGoalFitGateInstanceReceiptV2(gateInstance);
      assertGoalFitAssessmentV2(assessment);
      assertGoalFitReviewAssessmentBindingV2(binding);
    } catch (error) {
      throw new AuthorityIntegrityError("Stored assessed Goal Fit V2 review is invalid", error);
    }
    const requirement = this.readRequirementRevision(review.requirement_revision_id);
    const closure = this.readDecisionClosure(review.decision_closure_id);
    if (!requirement || !closure) throw new AuthorityIntegrityError("Assessed Goal Fit V2 review lost its frozen inputs");
    const acceptance = this.acceptance(review.contract_id);
    const expectedGate = finalizeGoalFitGateInstanceReceiptV2({
      acceptance, requirement, decision_closure: closure, gate: gateInstance.gate,
      gate_subject: { kind: gateInstance.gate_subject_kind, id: gateInstance.gate_subject_id, record_sha256: gateInstance.gate_subject_sha256 },
      event_head_sha256: gateInstance.event_head_sha256,
      created_at_ms: gateInstance.created_at_ms,
    });
    const changeAcceptance = this.changeAcceptanceGoalFitRoots(expectedGate);
    const expectedAssessment = finalizeGoalFitAssessmentV2({
      acceptance, requirement, decision_closure: closure, gate_instance: expectedGate,
      ...(changeAcceptance === undefined ? {} : { change_acceptance: changeAcceptance }),
      proposal: goalFitAssessmentProposalFromPersistedV2(assessment),
      created_at_ms: assessment.created_at_ms,
    });
    const expectedReview = finalizeGoalFitReviewV2({
      acceptance, requirement, decision_closure: closure, gate_instance: expectedGate, assessment: expectedAssessment,
      created_at_ms: review.created_at_ms,
    });
    const expectedBinding = finalizeGoalFitReviewAssessmentBindingV2({
      decision_closure: closure, gate_instance: expectedGate, assessment: expectedAssessment, review: expectedReview,
      created_at_ms: binding.created_at_ms,
    });
    if (expectedGate.record_sha256 !== gateInstance.record_sha256
      || expectedAssessment.record_sha256 !== assessment.record_sha256
      || expectedReview.record_sha256 !== review.record_sha256
      || expectedBinding.record_sha256 !== binding.record_sha256) {
      throw new AuthorityIntegrityError("Stored assessed Goal Fit V2 review is not Host-derived");
    }
    return { gate_instance: gateInstance, assessment, review, binding };
  }

  readLatestContractFreeze(goalId: string): ContractFreezeReceiptV2 | null {
    const row = this.connection.prepare(`SELECT contract_freeze_receipt_id FROM contract_freeze_receipts_v2
      WHERE goal_id=? ORDER BY generation DESC LIMIT 1`)
      .get(goalId) as Record<string, unknown> | undefined;
    return row ? this.readContractFreeze(text(row, "contract_freeze_receipt_id")) : null;
  }

  readContractFreeze(contractFreezeReceiptId: string): ContractFreezeReceiptV2 | null {
    const row = this.connection.prepare("SELECT * FROM contract_freeze_receipts_v2 WHERE contract_freeze_receipt_id=?")
      .get(contractFreezeReceiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const receipt: ContractFreezeReceiptV2 = {
      schema_version: 2, contract_freeze_receipt_id: text(row, "contract_freeze_receipt_id"),
      goal_id: text(row, "goal_id"), contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      requirement_revision_id: text(row, "requirement_revision_id"), decision_closure_id: text(row, "decision_closure_id"),
      goal_fit_review_id: text(row, "goal_fit_review_id"), generation: integer(row, "generation"),
      predecessor_freeze_sha256: text(row, "predecessor_freeze_sha256"), contract_sha256: text(row, "contract_sha256"),
      source_root_sha256: text(row, "source_root_sha256"), facet_root_sha256: text(row, "facet_root_sha256"),
      requirement_root_sha256: text(row, "requirement_root_sha256"), decision_root_sha256: text(row, "decision_root_sha256"),
      created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    try { assertContractFreezeReceiptV2(receipt); } catch (error) {
      throw new AuthorityIntegrityError("Stored contract freeze V2 receipt is invalid", error);
    }
    const requirement = this.readRequirementRevision(receipt.requirement_revision_id);
    const closure = this.readDecisionClosure(receipt.decision_closure_id);
    const assessedReview = this.readAssessedGoalFitReview(receipt.goal_fit_review_id);
    const review = assessedReview?.review ?? null;
    const contract = this.connection.prepare("SELECT record_sha256 FROM goal_contract_versions_v1 WHERE contract_id=? AND goal_id=?")
      .get(receipt.contract_id, receipt.goal_id) as Record<string, unknown> | undefined;
    if (!requirement || !closure || !review || !contract) {
      throw new AuthorityIntegrityError("Stored contract freeze V2 receipt lost its input closure");
    }
    const expected = finalizeContractFreezeReceiptV2({
      requirement,
      acceptance: this.acceptance(receipt.contract_id),
      decision_closure: closure,
      goal_fit_review: review,
      contract_sha256: text(contract, "record_sha256"),
      generation: receipt.generation,
      predecessor_freeze_sha256: receipt.predecessor_freeze_sha256,
      created_at_ms: receipt.created_at_ms,
    });
    if (expected.record_sha256 !== receipt.record_sha256) {
      throw new AuthorityIntegrityError("Stored contract freeze V2 receipt is not Host-derived");
    }
    return receipt;
  }

  verifyIntegrity(): IntakeAuthorityIntegritySummaryV2 {
    this.assertAvailable();
    // Integrity verification must rebuild from SQLite, not trust projections cached before a hostile change.
    this.#acceptanceCache.clear();
    this.#requirementCache.clear();
    this.#decisionCache.clear();
    this.#authorityInputCache.clear();
    this.#dueEventCache.clear();
    const requirementIds = (this.connection.prepare(
      "SELECT requirement_revision_id FROM requirement_revisions_v2 ORDER BY goal_id,revision",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "requirement_revision_id"));
    const decisionIds = (this.connection.prepare(
      "SELECT decision_requirement_revision_id FROM decision_requirements_v2 ORDER BY decision_requirement_revision_id",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "decision_requirement_revision_id"));
    const authorityInputRows = this.connection.prepare(
      "SELECT * FROM decision_authority_inputs_v2 ORDER BY authority_input_receipt_id",
    ).all() as Record<string, unknown>[];
    const dueEventRows = this.connection.prepare(
      "SELECT * FROM decision_due_event_receipts_v2 ORDER BY due_event_receipt_id",
    ).all() as Record<string, unknown>[];
    const resolutionRows = this.connection.prepare(
      "SELECT * FROM decision_resolutions_v2 ORDER BY decision_resolution_id",
    ).all() as Record<string, unknown>[];
    const closureIds = (this.connection.prepare(
      "SELECT decision_closure_id FROM decision_closures_v2 ORDER BY decision_closure_id",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "decision_closure_id"));
    const reviewIds = (this.connection.prepare(
      "SELECT goal_fit_review_id FROM goal_fit_reviews_v2 ORDER BY goal_fit_review_id",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "goal_fit_review_id"));
    const assessedReviewIds = (this.connection.prepare(
      "SELECT goal_fit_review_id FROM goal_fit_review_assessment_bindings_v2 ORDER BY goal_fit_review_id",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "goal_fit_review_id"));
    const freezeRows = this.connection.prepare(`SELECT contract_freeze_receipt_id,goal_id,generation,
      predecessor_freeze_sha256,record_sha256 FROM contract_freeze_receipts_v2 ORDER BY goal_id,generation`)
      .all() as Record<string, unknown>[];
    const goalIds = (this.connection.prepare(
      "SELECT DISTINCT goal_id FROM requirement_revisions_v2 ORDER BY goal_id",
    ).all() as Record<string, unknown>[]).map((row) => text(row, "goal_id"));

    const requirements = new Map<string, RequirementRevisionClosureV2>();
    for (const requirementId of requirementIds) {
      const requirement = this.readRequirementRevision(requirementId);
      if (!requirement) throw new AuthorityIntegrityError("Intake V2 Requirement disappeared during integrity rebuild");
      requirements.set(requirementId, requirement);
      const parentId = requirement.revision.parent_requirement_revision_id;
      const parentSha256 = requirement.revision.parent_requirement_revision_sha256;
      if (parentId !== null) {
        const parent = requirements.get(parentId) ?? this.readRequirementRevision(parentId);
        if (!parent || parent.revision.goal_id !== requirement.revision.goal_id
          || parent.revision.revision + 1 !== requirement.revision.revision
          || parent.revision.record_sha256 !== parentSha256) {
          throw new AuthorityIntegrityError("Intake V2 Requirement predecessor chain is invalid");
        }
      }
    }
    for (const decisionId of decisionIds) this.decision(decisionId);
    for (const row of authorityInputRows) this.authorityInputFromRow(row);
    for (const row of dueEventRows) this.dueEventFromRow(row);
    for (const row of resolutionRows) this.resolutionFromRow(row);
    for (const requirementId of requirementIds) this.readDecisionResolutions(requirementId);
    for (const closureId of closureIds) {
      if (!this.readDecisionClosure(closureId)) throw new AuthorityIntegrityError("Intake V2 Decision closure disappeared during integrity rebuild");
    }
    for (const reviewId of reviewIds) {
      if (!this.readGoalFitReview(reviewId)) throw new AuthorityIntegrityError("Intake V2 Goal Fit review disappeared during integrity rebuild");
    }
    for (const reviewId of assessedReviewIds) {
      if (!this.readAssessedGoalFitReview(reviewId)) {
        throw new AuthorityIntegrityError("Intake V2 assessed Goal Fit review disappeared during integrity rebuild");
      }
    }

    const freezeHeads = new Map<string, { readonly generation: number; readonly record_sha256: string }>();
    for (const row of freezeRows) {
      const freezeId = text(row, "contract_freeze_receipt_id");
      const goalId = text(row, "goal_id");
      const generation = integer(row, "generation");
      const predecessor = text(row, "predecessor_freeze_sha256");
      const previous = freezeHeads.get(goalId);
      if ((!previous && (generation !== 1 || predecessor !== zeroSha256))
        || (previous && (generation !== previous.generation + 1 || predecessor !== previous.record_sha256))) {
        throw new AuthorityIntegrityError("Intake V2 contract freeze predecessor chain is invalid");
      }
      const freeze = this.readContractFreeze(freezeId);
      if (!freeze || freeze.record_sha256 !== text(row, "record_sha256")) {
        throw new AuthorityIntegrityError("Intake V2 contract freeze disappeared during integrity rebuild");
      }
      freezeHeads.set(goalId, { generation, record_sha256: freeze.record_sha256 });
    }
    for (const goalId of goalIds) {
      if (!this.rebuildGoalProjection(goalId)) {
        throw new AuthorityIntegrityError("Intake V2 Goal projection disappeared during integrity rebuild");
      }
    }
    return {
      requirements: requirementIds.length,
      decisions: decisionIds.length,
      authority_inputs: authorityInputRows.length,
      due_events: dueEventRows.length,
      resolutions: resolutionRows.length,
      decision_closures: closureIds.length,
      goal_fit_reviews: reviewIds.length,
      assessed_goal_fit_reviews: assessedReviewIds.length,
      contract_freezes: freezeRows.length,
      goals: goalIds.length,
    };
  }

  rebuildGoalProjection(goalId: string): IntakeAuthorityProjectionV2 | null {
    const latest = this.connection.prepare(`SELECT r.requirement_revision_id FROM goal_contract_heads_v1 h
      JOIN requirement_revisions_v2 r ON r.contract_id=h.contract_id
      WHERE h.goal_id=? ORDER BY r.contract_revision DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!latest) return null;
    const requirement = this.readRequirementRevision(text(latest, "requirement_revision_id"));
    if (!requirement) throw new AuthorityIntegrityError("Intake V2 projection lost its Requirement revision");
    const decisions = this.readDecisionRequirements(requirement.revision.requirement_revision_id);
    const authorityInputs = this.readDecisionAuthorityInputs(requirement.revision.requirement_revision_id);
    const dueEvents = this.readDueEvents(requirement.revision.requirement_revision_id);
    const resolutions = this.readDecisionResolutions(requirement.revision.requirement_revision_id);
    const closureRow = this.connection.prepare(`SELECT decision_closure_id FROM decision_closures_v2
      WHERE requirement_revision_id=? ORDER BY created_event_sequence DESC LIMIT 1`).get(
      requirement.revision.requirement_revision_id,
    ) as Record<string, unknown> | undefined;
    let decisionClosure = closureRow ? this.readDecisionClosure(text(closureRow, "decision_closure_id")) : null;
    if (decisionClosure) {
      const recomputed = evaluateDecisionClosureV2({
        requirement, decisions, resolutions, due_events: dueEvents,
        gate: decisionClosure.closure.gate,
        created_at_ms: decisionClosure.closure.created_at_ms,
      });
      if (recomputed.closure.record_sha256 !== decisionClosure.closure.record_sha256) {
        decisionClosure = null;
      }
    }
    const reviewRow = decisionClosure ? this.connection.prepare(`SELECT goal_fit_review_id FROM goal_fit_reviews_v2
      WHERE requirement_revision_id=? AND decision_closure_id=? ORDER BY created_event_sequence DESC LIMIT 1`).get(
      requirement.revision.requirement_revision_id, decisionClosure.closure.decision_closure_id,
    ) as Record<string, unknown> | undefined : undefined;
    const review = reviewRow
      ? this.readAssessedGoalFitReview(text(reviewRow, "goal_fit_review_id"))?.review ?? null
      : null;
    const currentFreezeRow = this.connection.prepare("SELECT 1 FROM contract_freeze_receipts_v2 WHERE contract_id=?")
      .get(requirement.revision.contract_id);
    const freeze = currentFreezeRow ? this.readLatestContractFreeze(goalId) : null;
    if (freeze) {
      const freezeReview = this.readAssessedGoalFitReview(freeze.goal_fit_review_id)?.review ?? null;
      const freezeClosure = this.readDecisionClosure(freeze.decision_closure_id);
      if (freeze.requirement_revision_id !== requirement.revision.requirement_revision_id
        || !freezeReview || !freezeClosure
        || freezeReview.decision_closure_id !== freezeClosure.closure.decision_closure_id
        || freezeReview.requirement_revision_id !== freeze.requirement_revision_id) {
        throw new AuthorityIntegrityError("Intake V2 freeze receipt is outside the rebuilt authority closure");
      }
    }
    const projectionSha256 = canonicalJsonSha256({
      requirement: requirement.revision.record_sha256,
      decisions: decisions.map((record) => record.record_sha256),
      authority_inputs: authorityInputs.map((record) => record.record_sha256),
      due_events: dueEvents.map((record) => record.record_sha256),
      resolutions: resolutions.map((record) => record.record_sha256),
      decision_closure: decisionClosure?.closure.record_sha256 ?? null,
      goal_fit_review: review?.record_sha256 ?? null,
      contract_freeze: freeze?.record_sha256 ?? null,
    });
    return {
      requirement, decisions, authority_inputs: authorityInputs, due_events: dueEvents, resolutions, decision_closure: decisionClosure,
      goal_fit_review: review, contract_freeze: freeze, projection_sha256: projectionSha256,
    };
  }

  private currentAcceptance(goalId: string): AcceptanceProjectionV2 {
    const row = this.connection.prepare("SELECT contract_id FROM goal_contract_heads_v1 WHERE goal_id=?")
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Intake V2 lacks the current Goal contract");
    return this.acceptance(text(row, "contract_id"));
  }

  private requirement(requirementRevisionId: string): RequirementRevisionClosureV2 {
    const requirement = this.readRequirementRevision(requirementRevisionId);
    if (!requirement) throw new AuthorityIntegrityError("Intake V2 Requirement revision is missing");
    return requirement;
  }

  private decision(decisionRequirementRevisionId: string): DecisionRequirementV2 {
    const decision = this.readDecisionRequirement(decisionRequirementRevisionId);
    if (!decision) throw new AuthorityIntegrityError("Intake V2 Decision requirement is missing");
    return decision;
  }

  private latestResolution(decisionRequirementRevisionId: string): DecisionResolutionV2 | null {
    const row = this.connection.prepare(`SELECT * FROM decision_resolutions_v2
      WHERE decision_requirement_revision_id=? ORDER BY resolution_revision DESC LIMIT 1`)
      .get(decisionRequirementRevisionId) as Record<string, unknown> | undefined;
    return row ? this.resolutionFromRow(row) : null;
  }

  private changeAcceptanceGoalFitRoots(
    gateInstance: GoalFitGateInstanceReceiptV2,
  ): ChangeAcceptanceGoalFitRootsV2 | undefined {
    if (gateInstance.gate_subject_kind !== "CHANGE_ACCEPTANCE_CLOSURE") return undefined;
    const row = this.connection.prepare(`SELECT requirement_revision_id,requirement_revision_sha256,
        goal_id,contract_id,authority_root_id,decision_closure_id,decision_closure_sha256,
        successor_plan_revision_sha256,decision_plan_binding_root_sha256,record_sha256,
        invalidation_root_sha256,oracle_evidence_root_sha256
      FROM change_acceptance_closures_v2 WHERE change_acceptance_closure_id=?`)
      .get(gateInstance.gate_subject_id) as Record<string, unknown> | undefined;
    if (!row
      || text(row, "record_sha256") !== gateInstance.gate_subject_sha256
      || text(row, "requirement_revision_id") !== gateInstance.requirement_revision_id
      || text(row, "requirement_revision_sha256") !== gateInstance.requirement_revision_sha256
      || text(row, "goal_id") !== gateInstance.goal_id
      || text(row, "contract_id") !== gateInstance.contract_id
      || text(row, "authority_root_id") !== gateInstance.authority_root_id
      || text(row, "decision_closure_id") !== gateInstance.decision_closure_id
      || text(row, "decision_closure_sha256") !== gateInstance.decision_closure_sha256) {
      throw new AuthorityIntegrityError("Goal Fit V2 MATERIAL_CHANGE lost its exact Change Acceptance closure");
    }
    return {
      plan_revision_sha256: text(row, "successor_plan_revision_sha256"),
      decision_plan_binding_root_sha256: text(row, "decision_plan_binding_root_sha256"),
      change_acceptance_closure_sha256: text(row, "record_sha256"),
      invalidation_root_sha256: text(row, "invalidation_root_sha256"),
      oracle_evidence_root_sha256: text(row, "oracle_evidence_root_sha256"),
    };
  }

  private acceptance(contractId: string): AcceptanceProjectionV2 {
    const cached = this.#acceptanceCache.get(contractId);
    if (cached) return cached;
    const bundle = new AcceptanceAuthorityV2Repository(this.connection).readBundle(contractId);
    if (!bundle) throw new AuthorityIntegrityError("Intake V2 lacks its Acceptance authority");
    this.#acceptanceCache.set(contractId, bundle);
    return bundle;
  }

  private readDecisionRequirement(decisionRequirementRevisionId: string): DecisionRequirementV2 | null {
    const cached = this.#decisionCache.get(decisionRequirementRevisionId);
    if (cached) return cached;
    const row = this.connection.prepare("SELECT * FROM decision_requirements_v2 WHERE decision_requirement_revision_id=?")
      .get(decisionRequirementRevisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const decision = this.decisionFromRow(row);
    this.#decisionCache.set(decisionRequirementRevisionId, decision);
    return decision;
  }

  private readDecisionAuthorityInputs(requirementRevisionId: string): readonly DecisionAuthorityInputReceiptV2[] {
    return (this.connection.prepare(`SELECT * FROM decision_authority_inputs_v2
      WHERE requirement_revision_id=? ORDER BY created_event_sequence,authority_input_receipt_id`)
      .all(requirementRevisionId) as Record<string, unknown>[]).map((row) => this.authorityInputFromRow(row));
  }

  private readDueEvents(requirementRevisionId: string): readonly DecisionDueEventReceiptV2[] {
    return this.readDueEventsBefore(requirementRevisionId, null);
  }

  private readDueEventsBefore(
    requirementRevisionId: string, beforeEventSequence: number | null,
  ): readonly DecisionDueEventReceiptV2[] {
    const rows = (beforeEventSequence === null
      ? this.connection.prepare(`SELECT * FROM decision_due_event_receipts_v2
        WHERE requirement_revision_id=? ORDER BY created_event_sequence,due_event_receipt_id`).all(requirementRevisionId)
      : this.connection.prepare(`SELECT * FROM decision_due_event_receipts_v2
        WHERE requirement_revision_id=? AND created_event_sequence<?
        ORDER BY created_event_sequence,due_event_receipt_id`).all(requirementRevisionId, beforeEventSequence)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.dueEventFromRow(row));
  }

  private dueEvent(dueEventReceiptId: string): DecisionDueEventReceiptV2 {
    const cached = this.#dueEventCache.get(dueEventReceiptId);
    if (cached) return cached;
    const row = this.connection.prepare("SELECT * FROM decision_due_event_receipts_v2 WHERE due_event_receipt_id=?")
      .get(dueEventReceiptId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Decision V2 DueEventReceipt is missing");
    const receipt = this.dueEventFromRow(row);
    this.#dueEventCache.set(dueEventReceiptId, receipt);
    return receipt;
  }

  private dueEventFromRow(row: Record<string, unknown>): DecisionDueEventReceiptV2 {
    const receipt: DecisionDueEventReceiptV2 = {
      schema_version: 2,
      due_event_receipt_id: text(row, "due_event_receipt_id"), goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      decision_requirement_revision_id: text(row, "decision_requirement_revision_id"),
      requirement_revision_id: text(row, "requirement_revision_id"),
      requirement_revision_sha256: text(row, "requirement_revision_sha256"),
      purpose: text(row, "purpose") as DecisionDueEventReceiptV2["purpose"],
      trigger_kind: text(row, "trigger_kind") as DecisionDueEventReceiptV2["trigger_kind"],
      trigger_sha256: text(row, "trigger_sha256"), at_gate: text(row, "at_gate") as GoalFitGateV2,
      event_evidence_sha256: text(row, "event_evidence_sha256"), event_head_sha256: text(row, "event_head_sha256"),
      predecessor_resolution_sha256: text(row, "predecessor_resolution_sha256"),
      captured_by: "HOST", created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    try { assertDecisionDueEventReceiptV2(receipt); } catch (error) {
      throw new AuthorityIntegrityError("Stored Decision V2 due event is invalid", error);
    }
    const decision = this.readDecisionRequirement(receipt.decision_requirement_revision_id);
    const requirement = this.readRequirementRevision(receipt.requirement_revision_id);
    if (!decision || !requirement) throw new AuthorityIntegrityError("Stored Decision V2 due event lost its input closure");
    const expected = finalizeDecisionDueEventReceiptV2({
      acceptance: this.acceptance(receipt.contract_id), requirement, decision,
      purpose: receipt.purpose, trigger_kind: receipt.trigger_kind, trigger_sha256: receipt.trigger_sha256,
      at_gate: receipt.at_gate, event_evidence_sha256: receipt.event_evidence_sha256,
      event_head_sha256: receipt.event_head_sha256,
      predecessor_resolution_sha256: receipt.predecessor_resolution_sha256, created_at_ms: receipt.created_at_ms,
    });
    if (expected.record_sha256 !== receipt.record_sha256) {
      throw new AuthorityIntegrityError("Stored Decision V2 due event is not Host-derived");
    }
    return receipt;
  }

  private readDecisionAuthorityInput(authorityInputReceiptId: string): DecisionAuthorityInputReceiptV2 | null {
    const cached = this.#authorityInputCache.get(authorityInputReceiptId);
    if (cached) return cached;
    const row = this.connection.prepare("SELECT * FROM decision_authority_inputs_v2 WHERE authority_input_receipt_id=?")
      .get(authorityInputReceiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const receipt = this.authorityInputFromRow(row);
    this.#authorityInputCache.set(authorityInputReceiptId, receipt);
    return receipt;
  }

  private authorityInputFromRow(row: Record<string, unknown>): DecisionAuthorityInputReceiptV2 {
    const sourceBytes = row.source_bytes;
    if (!(sourceBytes instanceof Uint8Array)) throw new AuthorityIntegrityError("Stored Decision V2 authority input bytes are invalid");
    const receipt: DecisionAuthorityInputReceiptV2 = {
      schema_version: 2,
      authority_input_receipt_id: text(row, "authority_input_receipt_id"),
      goal_id: text(row, "goal_id"), contract_id: text(row, "contract_id"),
      authority_root_id: text(row, "authority_root_id"),
      decision_requirement_revision_id: text(row, "decision_requirement_revision_id"),
      requirement_revision_id: text(row, "requirement_revision_id"),
      requirement_revision_sha256: text(row, "requirement_revision_sha256"),
      decision_frontier_sha256: text(row, "decision_frontier_sha256"),
      action: text(row, "action") as DecisionAuthorityInputReceiptV2["action"],
      action_payload_sha256: text(row, "action_payload_sha256"),
      at_gate: text(row, "at_gate") as GoalFitGateV2,
      authority_actor: text(row, "authority_actor") as DecisionAuthorityInputReceiptV2["authority_actor"],
      source_kind: text(row, "source_kind") as DecisionAuthorityInputReceiptV2["source_kind"],
      session_id: nullableText(row, "session_id"), turn_id: nullableText(row, "turn_id"),
      event_head_sha256: text(row, "event_head_sha256"), due_event_receipt_id: nullableText(row, "due_event_receipt_id"),
      content_sha256: text(row, "content_sha256"), byte_length: integer(row, "byte_length"),
      encoding: "UTF-8", fidelity: "EXACT", captured_by: "HOST",
      created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    try { assertDecisionAuthorityInputReceiptV2(receipt); } catch (error) {
      throw new AuthorityIntegrityError("Stored Decision V2 authority input receipt is invalid", error);
    }
    if (sourceBytes.byteLength !== receipt.byte_length || sha256Hex(sourceBytes) !== receipt.content_sha256) {
      throw new AuthorityIntegrityError("Stored Decision V2 authority input bytes mismatch");
    }
    const expectedSource = receipt.authority_actor === "USER"
      ? userDecisionAuthorityInputSourceV2({
        requirement_revision_sha256: receipt.requirement_revision_sha256,
        decision_requirement_revision_id: receipt.decision_requirement_revision_id,
        decision_frontier_sha256: receipt.decision_frontier_sha256,
        action: receipt.action,
        action_payload_sha256: receipt.action_payload_sha256,
        at_gate: receipt.at_gate,
        session_id: receipt.session_id!,
        turn_id: receipt.turn_id!,
        event_head_sha256: receipt.event_head_sha256,
      })
      : hostDefaultAuthorityInputSourceV2(
        this.decision(receipt.decision_requirement_revision_id),
        this.dueEvent(receipt.due_event_receipt_id!),
        receipt.requirement_revision_sha256,
        receipt.decision_frontier_sha256,
      );
    if (!Buffer.from(sourceBytes).equals(Buffer.from(expectedSource, "utf8"))) {
      throw new AuthorityIntegrityError("Stored Decision V2 authority input is not the exact structured action envelope");
    }
    return receipt;
  }

  private decisionFromRow(
    row: Record<string, unknown>,
    prefetchedItemMembers?: readonly string[],
    prefetchedSpanMembers?: readonly string[],
  ): DecisionRequirementV2 {
    const decisionRevisionId = text(row, "decision_requirement_revision_id");
    const decision: DecisionRequirementV2 = {
      schema_version: 2,
      decision_requirement_revision_id: decisionRevisionId,
      decision_requirement_id: text(row, "decision_requirement_id"),
      requirement_revision_id: text(row, "requirement_revision_id"), goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      decision_key: text(row, "decision_key"), kind: text(row, "kind") as DecisionRequirementV2["kind"],
      question: text(row, "question"), materiality: text(row, "materiality") as DecisionRequirementV2["materiality"],
      blocking: boolean(row, "blocking"), affected_requirement_ids: stringArray(row, "affected_requirement_ids_json"),
      source_span_ids: stringArray(row, "source_span_ids_json"),
      trigger_kind: text(row, "trigger_kind") as DecisionRequirementV2["trigger_kind"], trigger_sha256: text(row, "trigger_sha256"),
      latest_resolution_stage: text(row, "latest_resolution_stage") as GoalFitGateV2,
      default_action: text(row, "default_action") as DecisionRequirementV2["default_action"],
      default_value: json<CanonicalJson>(row, "default_value_json"), default_sha256: text(row, "default_sha256"),
      reversibility: text(row, "reversibility") as DecisionRequirementV2["reversibility"],
      affected_work_cell_ids: stringArray(row, "affected_work_cell_ids_json"),
      proposal_origin: text(row, "proposal_origin") as DecisionRequirementV2["proposal_origin"],
      record_sha256: text(row, "record_sha256"),
    };
    const itemMembers = prefetchedItemMembers ?? (this.connection.prepare(`SELECT requirement_id FROM decision_requirement_item_members_v2
      WHERE decision_requirement_revision_id=? ORDER BY ordinal`).all(decisionRevisionId) as Record<string, unknown>[])
      .map((member) => text(member, "requirement_id"));
    const spanMembers = prefetchedSpanMembers ?? (this.connection.prepare(`SELECT span_id FROM decision_requirement_span_members_v2
      WHERE decision_requirement_revision_id=? ORDER BY ordinal`).all(decisionRevisionId) as Record<string, unknown>[])
      .map((member) => text(member, "span_id"));
    if (canonicalJson(itemMembers) !== canonicalJson(decision.affected_requirement_ids)
      || canonicalJson(spanMembers) !== canonicalJson(decision.source_span_ids)
      || root("PCH-DECISION-AFFECTED-REQUIREMENT-ROOT-V2", itemMembers) !== text(row, "affected_requirement_root_sha256")
      || root("PCH-DECISION-SOURCE-SPAN-ROOT-V2", spanMembers) !== text(row, "source_span_root_sha256")
      || root("PCH-DECISION-AFFECTED-WORK-CELL-ROOT-V2", decision.affected_work_cell_ids) !== text(row, "affected_work_cell_root_sha256")) {
      throw new AuthorityIntegrityError("Stored Decision V2 member closure is invalid");
    }
    try { assertDecisionRequirementV2(decision); } catch (error) {
      throw new AuthorityIntegrityError("Stored Decision V2 requirement is invalid", error);
    }
    return decision;
  }

  private resolutionFromRow(row: Record<string, unknown>): DecisionResolutionV2 {
    const resolution: DecisionResolutionV2 = {
      schema_version: 2, decision_resolution_id: text(row, "decision_resolution_id"),
      decision_requirement_revision_id: text(row, "decision_requirement_revision_id"),
      decision_requirement_id: text(row, "decision_requirement_id"),
      requirement_revision_id: text(row, "requirement_revision_id"), goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"), authority_root_id: text(row, "authority_root_id"),
      resolution_revision: integer(row, "resolution_revision"), parent_resolution_id: nullableText(row, "parent_resolution_id"),
      action: text(row, "action") as DecisionResolutionV2["action"],
      authority_actor: text(row, "authority_actor") as DecisionResolutionV2["authority_actor"],
      at_stage: text(row, "at_stage") as GoalFitGateV2,
      decision_frontier_sha256: text(row, "decision_frontier_sha256"),
      action_payload_sha256: text(row, "action_payload_sha256"),
      resolution_input_sha256: text(row, "resolution_input_sha256"),
      authority_input_receipt_id: text(row, "authority_input_receipt_id"),
      due_event_receipt_id: nullableText(row, "due_event_receipt_id"),
      authority_source_span_id: nullableText(row, "authority_source_span_id"),
      selected_value: json<CanonicalJson>(row, "selected_value_json"), selected_value_sha256: text(row, "selected_value_sha256"),
      edited_requirement_revision_id: nullableText(row, "edited_requirement_revision_id"),
      deferred_trigger_sha256: nullableText(row, "deferred_trigger_sha256"),
      created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
    };
    try { assertDecisionResolutionV2(resolution); } catch (error) {
      throw new AuthorityIntegrityError("Stored Decision V2 resolution is invalid", error);
    }
    return resolution;
  }

  private assertEventContext(goalId: string, sequence: number, providedHeadSha256?: string): string {
    eventSequence(sequence);
    const row = this.connection.prepare(`SELECT sequence,event_sha256 FROM events
      WHERE goal_id=? ORDER BY sequence DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Intake V2 authority command lacks a core event predecessor");
    const predecessorSequence = integer(row, "sequence");
    const predecessorSha256 = text(row, "event_sha256");
    if (sequence !== predecessorSequence + 1) {
      throw new AuthorityIntegrityError("Intake V2 created_event_sequence is not the next core Goal event");
    }
    if (providedHeadSha256 !== undefined && providedHeadSha256 !== predecessorSha256) {
      throw new AuthorityIntegrityError("Intake V2 authority input is not bound to the current core event head");
    }
    return predecessorSha256;
  }

  private assertCurrentRequirement(requirement: RequirementRevisionClosureV2, frontierMustBeMutable: boolean): void {
    const current = this.connection.prepare(`SELECT r.requirement_revision_id,r.contract_id
      FROM goal_contract_heads_v1 h JOIN requirement_revisions_v2 r ON r.contract_id=h.contract_id
      WHERE h.goal_id=? ORDER BY r.contract_revision DESC LIMIT 1`).get(
      requirement.revision.goal_id,
    ) as Record<string, unknown> | undefined;
    if (!current || text(current, "requirement_revision_id") !== requirement.revision.requirement_revision_id
      || text(current, "contract_id") !== requirement.revision.contract_id) {
      throw new AuthorityIntegrityError("Intake V2 command targets a stale Requirement revision");
    }
    if (frontierMustBeMutable && this.connection.prepare(
      "SELECT 1 FROM contract_freeze_receipts_v2 WHERE contract_id=?",
    ).get(requirement.revision.contract_id)) {
      throw new AuthorityIntegrityError("Decision V2 frontier is immutable after contract freeze");
    }
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Intake/Decision/Goal Fit migration 021 is not available");
  }
}

export { zeroSha256 as intakeAuthorityZeroSha256 };
