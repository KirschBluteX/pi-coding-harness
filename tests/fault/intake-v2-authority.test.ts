import { afterEach, describe, expect, it } from "vitest";
import { AcceptanceAuthorityV2Repository } from "../../src/acceptance-v2/repository.js";
import { AuthorityTransactionKernel } from "../../src/authority/authority-transaction-kernel.js";
import { closeAuthorityConnection, openAuthorityConnection, runImmediateTransaction, type AuthorityConnection } from "../../src/authority/database.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { verifyLifecycleAuthorityIntegrity } from "../../src/runtime/lifecycle.js";
import {
  decisionActionPayloadSha256V2,
  decisionDeadlineTriggerSha256V2,
  decisionFrontierSha256V2,
  userDecisionAuthorityInputSourceV2,
} from "../../src/intake-v2/finalize.js";
import { IntakeAuthorityV2Repository, intakeAuthorityZeroSha256 } from "../../src/intake-v2/repository.js";
import type {
  ContractFreezeReceiptV2,
  DecisionRequirementProposalV2,
  DecisionRequirementV2,
  RequirementItemProposalV2,
  RequirementRevisionClosureV2,
} from "../../src/intake-v2/domain.js";
import type { AcceptanceBundleV2 } from "../../src/acceptance-v2/domain.js";
import { TestClock, type TestAuthority } from "../helpers/authority.js";
import {
  createTaskFlowAuthority,
  taskAcceptanceFacets,
  taskAdmissionMetadata,
  taskContractProposal,
} from "../helpers/task-flow.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

interface Fixture {
  readonly authority: TestAuthority;
  connection: AuthorityConnection;
  readonly goalId: string;
  readonly acceptance: AcceptanceBundleV2;
  readonly lease: ReturnType<TestAuthority["store"]["acquireLease"]>;
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    closeAuthorityConnection(fixture.connection);
    fixture.authority.close();
  }
});

function fixture(): Fixture {
  const authority = createTaskFlowAuthority();
  const goalId = `GOAL-INTAKE-V2-${fixtures.length + 1}`;
  authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW",
    goalId,
    workspace: {
      workspaceId: `WS-${goalId}`,
      workspaceHmac: sha256Hex(`workspace:${goalId}`),
      filesystemKind: "LOCAL_TEST",
      localLockingVerified: true,
    },
    originSessionId: `SESSION-${goalId}`,
    objective: "Build one verified local result",
    intent: "BUILD",
    lane: "DIRECT_CELL",
    sourceIntakeSha256: sha256Hex("task-flow-intake"),
    sourceText: "task-flow-intake",
    activationSha256: sha256Hex(`activation:${goalId}`),
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, { expectedVersion: 0, idempotencyKey: `admit:${goalId}`, actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, `SESSION-${goalId}`, 60_000);
  authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT",
    goalId,
    proposal: taskContractProposal(),
    acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, { expectedVersion: 1, idempotencyKey: `contract:${goalId}:1`, actor: "RUNTIME", lease });
  const contractId = authority.store.readTaskFlowView(goalId)?.contract?.contract_id;
  if (!contractId) throw new Error("Intake V2 fixture did not freeze Acceptance authority");
  const connection = openAuthorityConnection({ path: authority.databasePath });
  if (!new IntakeAuthorityV2Repository(connection).available()) {
    throw new Error("Intake V2 migration was not registered by the Host migration chain");
  }
  const acceptance = new AcceptanceAuthorityV2Repository(connection).readBundle(contractId);
  if (!acceptance) throw new Error("Intake V2 fixture cannot rebuild Acceptance authority");
  const result = { authority, connection, goalId, acceptance, lease };
  fixtures.push(result);
  return result;
}

function requirementItems(acceptance: AcceptanceBundleV2, suffix = ""): readonly RequirementItemProposalV2[] {
  return acceptance.facets.map((facet) => ({
    key: facet.semantic_key,
    kind: facet.kind === "CONSTRAINT" ? "CONSTRAINT" as const
      : facet.kind === "NON_GOAL" ? "NON_GOAL" as const
        : facet.kind === "OUTCOME" ? "OUTCOME" as const : "QUALITY" as const,
    priority: "MUST" as const,
    statement: `${facet.semantic_statement}${suffix}`,
    acceptance_facet_ids: [facet.facet_id],
    source_span_ids: facet.source_span_ids,
  }));
}

function eventHead(input: Fixture): { readonly sequence: number; readonly sha256: string } {
  const row = input.connection.prepare(`SELECT sequence,event_sha256 FROM events
    WHERE goal_id=? ORDER BY sequence DESC LIMIT 1`).get(input.goalId) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(Number(row.sequence)) || typeof row.event_sha256 !== "string") {
    throw new Error("Intake V2 fixture lacks a core event head");
  }
  return { sequence: Number(row.sequence), sha256: row.event_sha256 };
}

function intakeCommand<T>(
  input: Fixture,
  commandKey: string,
  nowMs: number,
  mutate: (repository: IntakeAuthorityV2Repository, context: {
    readonly sequence: number;
    readonly event_head_sha256: string;
    readonly now_ms: number;
  }) => T,
): T {
  const predecessor = eventHead(input);
  let value: T | undefined;
  new AuthorityTransactionKernel(input.connection, new TestClock(nowMs)).execute({
    goalId: input.goalId,
    commandSha256: sha256Hex(`intake-v2-command:${commandKey}`),
    meta: {
      expectedVersion: predecessor.sequence,
      idempotencyKey: `intake-v2:${input.goalId}:${commandKey}`,
      actor: "RUNTIME",
    },
  }, {
    mutate: ({ sequence, nowMs: transactionNowMs }) => {
      value = mutate(new IntakeAuthorityV2Repository(input.connection), {
        sequence,
        event_head_sha256: predecessor.sha256,
        now_ms: transactionNowMs,
      });
      return value;
    },
    event: () => ({
      eventType: "DECISION_RESOLVED",
      payload: { intakeV2CommandSha256: sha256Hex(commandKey) },
    }),
  });
  if (value === undefined) throw new Error("Intake V2 test command did not execute");
  return value;
}

function draftReview(
  acceptance: AcceptanceBundleV2,
  requirement: RequirementRevisionClosureV2,
): DecisionRequirementProposalV2 {
  return {
    key: "draft-review",
    kind: "DRAFT_REVIEW",
    question: "Approve the exact Requirement and Acceptance closure?",
    materiality: "HIGH",
    blocking: true,
    affected_requirement_keys: requirement.items.map((item) => item.semantic_key),
    source_span_ids: [acceptance.spans[0]!.span_id],
    trigger: { kind: "IMMEDIATE", evidence_sha256: sha256Hex("draft-review-trigger") },
    latest_resolution_stage: "CONTRACT_FREEZE",
    default: { action: "REJECT", value: null },
    reversibility: "REVERSIBLE",
    affected_work_cell_ids: [],
    proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
  };
}

function appendRequirement(
  input: Fixture,
  repository: IntakeAuthorityV2Repository,
  expectedParent?: string,
  suffix = "",
  sequence = 100,
): RequirementRevisionClosureV2 {
  const parentSha256 = expectedParent
    ?? repository.rebuildGoalProjection(input.goalId)?.requirement.revision.record_sha256
    ?? intakeAuthorityZeroSha256;
  return intakeCommand(input, `requirement:${sequence}:${sha256Hex(suffix)}`, sequence, (repository, context) =>
    repository.appendRequirementProposal({
      goal_id: input.goalId,
      expected_parent_requirement_sha256: parentSha256,
      proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      items: requirementItems(input.acceptance, suffix),
      created_at_ms: context.now_ms,
    }, context.sequence));
}

function appendDraftReview(
  input: Fixture,
  _repository: IntakeAuthorityV2Repository,
  requirement: RequirementRevisionClosureV2,
  extras: readonly DecisionRequirementProposalV2[] = [],
  sequence = 101,
): readonly DecisionRequirementV2[] {
  return intakeCommand(input, `decisions:${sequence}:${requirement.revision.requirement_revision_id}`, sequence, (repository, context) =>
    repository.appendDecisionProposals({
      requirement_revision_id: requirement.revision.requirement_revision_id,
      proposals: [draftReview(input.acceptance, requirement), ...extras],
    }, context.sequence));
}

function userActionSource(
  requirement: RequirementRevisionClosureV2,
  decisions: readonly DecisionRequirementV2[],
  decision: DecisionRequirementV2,
): string {
  const eventHead = sha256Hex(`user-action-head:${decision.decision_requirement_revision_id}`);
  return userDecisionAuthorityInputSourceV2({
    requirement_revision_sha256: requirement.revision.record_sha256,
    decision_requirement_revision_id: decision.decision_requirement_revision_id,
    decision_frontier_sha256: decisionFrontierSha256V2(decisions),
    action: "APPROVE",
    action_payload_sha256: decisionActionPayloadSha256V2({
      decision,
      action: "APPROVE",
      selected_value: { approved: true },
      edited_requirement_revision_id: null,
      deferred_trigger_sha256: null,
    }),
    at_gate: "CONTRACT_REVIEW",
    session_id: "SESSION-USER-ACTION",
    turn_id: "TURN-USER-ACTION",
    event_head_sha256: eventHead,
  });
}

function approveDraft(
  input: Fixture,
  requirement: RequirementRevisionClosureV2,
  decisions: readonly DecisionRequirementV2[],
  sequence = 102,
): ReturnType<IntakeAuthorityV2Repository["captureUserDecisionAction"]> {
  const decision = decisions.find((candidate) => candidate.kind === "DRAFT_REVIEW")!;
  return intakeCommand(input, `approve:${sequence}:${decision.decision_requirement_revision_id}`, sequence, (hostRepository, context) => {
    const source = userDecisionAuthorityInputSourceV2({
      requirement_revision_sha256: requirement.revision.record_sha256,
      decision_requirement_revision_id: decision.decision_requirement_revision_id,
      decision_frontier_sha256: decisionFrontierSha256V2(decisions),
      action: "APPROVE",
      action_payload_sha256: decisionActionPayloadSha256V2({
        decision, action: "APPROVE", selected_value: { approved: true },
        edited_requirement_revision_id: null, deferred_trigger_sha256: null,
      }),
      at_gate: "CONTRACT_REVIEW", session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
      event_head_sha256: context.event_head_sha256,
    });
    return hostRepository.captureUserDecisionAction({
      decision_requirement_revision_id: decision.decision_requirement_revision_id,
      action: "APPROVE", at_gate: "CONTRACT_REVIEW", selected_value: { approved: true },
      edited_requirement_revision_id: null, deferred_trigger_sha256: null, authority_source_span_id: null,
      source, session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
      event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
    }, context.sequence);
  });
}

function completeFreezeWithinTransaction(input: Fixture): {
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly freeze: ContractFreezeReceiptV2;
} {
  const repository = new IntakeAuthorityV2Repository(input.connection);
  const projection = repository.rebuildGoalProjection(input.goalId);
  if (!projection) throw new Error("Intake V2 fixture lacks its initial Host-derived projection");
  const { requirement, decisions } = projection;
  approveDraft(input, requirement, decisions);
  const completed = intakeCommand(input, `freeze:103:${requirement.revision.requirement_revision_id}`, 103,
    (hostRepository, context) => {
      const closure = hostRepository.recordDecisionClosure(
        requirement.revision.requirement_revision_id, "CONTRACT_FREEZE", context.now_ms, context.sequence,
      );
      hostRepository.recordGoalFitReview({
        requirement_revision_id: requirement.revision.requirement_revision_id,
        decision_closure_id: closure.closure.decision_closure_id,
        gate_subject: {
          kind: "REQUIREMENT_REVISION",
          id: requirement.revision.requirement_revision_id,
          record_sha256: requirement.revision.record_sha256,
        },
        assessment: passingGoalFitAssessment(),
        created_at_ms: context.now_ms,
      }, context.sequence);
      const freeze = hostRepository.freezeContract({
        goal_id: input.goalId,
        expected_predecessor_freeze_sha256: intakeAuthorityZeroSha256,
        created_at_ms: context.now_ms,
      }, context.sequence);
      return { closure, freeze };
    });
  return { requirement, decisions, freeze: completed.freeze };
}

function completeFreeze(input: Fixture): ReturnType<typeof completeFreezeWithinTransaction> {
  return runImmediateTransaction(input.connection, () => completeFreezeWithinTransaction(input));
}

const tables = [
  "requirement_revisions_v2",
  "requirement_items_v2",
  "requirement_item_facet_members_v2",
  "requirement_item_span_members_v2",
  "decision_requirements_v2",
  "decision_requirement_item_members_v2",
  "decision_requirement_span_members_v2",
  "decision_due_event_receipts_v2",
  "decision_authority_inputs_v2",
  "decision_resolutions_v2",
  "decision_closures_v2",
  "decision_closure_members_v2",
  "goal_fit_gate_instances_v2",
  "goal_fit_assessments_v2",
  "goal_fit_reviews_v2",
  "goal_fit_review_assessment_bindings_v2",
  "contract_freeze_receipts_v2",
] as const;

const transactionFaults = [
  "after-domain-write",
  "after-event-write",
  "after-projection-write",
  "after-outbox-write",
  "after-receipt-write",
  "before-commit",
] as const;

function authorityTransactionSnapshot(input: Fixture): unknown {
  const counts = Object.fromEntries([
    ...tables,
    "events",
    "outbox",
    "command_receipts",
  ].map((table) => [table, input.connection.prepare(`SELECT count(*) count FROM ${table} WHERE goal_id=?`)
    .get(input.goalId)]));
  const head = input.connection.prepare(`SELECT status,next_action_code,updated_event_sequence
    FROM task_flow_goal_heads_v1 WHERE goal_id=?`).get(input.goalId);
  return { counts, head, eventHead: eventHead(input) };
}

describe("Intake/Decision/Goal Fit V2 authority", () => {
  it("rolls USER review and Contract freeze back with their core event envelope at every pre-commit fault", () => {
    const input = fixture();
    const intake = input.authority.store.readTaskFlowIntakeV2(input.goalId);
    const review = intake?.decisions.find((decision) => decision.kind === "DRAFT_REVIEW");
    if (!intake || !review) throw new Error("Fault fixture lacks its draft review Decision");
    const reviewBaseline = authorityTransactionSnapshot(input);

    for (const point of transactionFaults) {
      expect(() => input.authority.store.transactTaskFlowUserInput({
        type: "RESOLVE_GOAL_CONTRACT_REVIEW",
        goalId: input.goalId,
        expectedDecisionRequirementRevisionId: review.decision_requirement_revision_id,
        expectedRequirementRevisionSha256: intake.requirement.revision.record_sha256,
        expectedDecisionFrontierSha256: decisionFrontierSha256V2(intake.decisions),
        action: "APPROVE",
        selectedValue: true,
      }, {
        expectedVersion: 2,
        idempotencyKey: `fault-review:${point}`,
        lease: input.lease,
        sessionId: input.lease.ownerSessionId,
        turnId: `FAULT-REVIEW-${point}`,
      }, (current) => { if (current === point) throw new Error(`FAULT:${point}`); }))
        .toThrow(`FAULT:${point}`);
      expect(authorityTransactionSnapshot(input)).toEqual(reviewBaseline);
    }

    input.authority.store.transactTaskFlowUserInput({
      type: "RESOLVE_GOAL_CONTRACT_REVIEW",
      goalId: input.goalId,
      expectedDecisionRequirementRevisionId: review.decision_requirement_revision_id,
      expectedRequirementRevisionSha256: intake.requirement.revision.record_sha256,
      expectedDecisionFrontierSha256: decisionFrontierSha256V2(intake.decisions),
      action: "APPROVE",
      selectedValue: true,
    }, {
      expectedVersion: 2,
      idempotencyKey: "fault-review:commit",
      lease: input.lease,
      sessionId: input.lease.ownerSessionId,
      turnId: "FAULT-REVIEW-COMMIT",
    });
    const freezeBaseline = authorityTransactionSnapshot(input);

    for (const point of transactionFaults) {
      expect(() => input.authority.store.transactTaskFlow({
        type: "FINALIZE_GOAL_CONTRACT_INTAKE",
        goalId: input.goalId,
      }, {
        expectedVersion: 3,
        idempotencyKey: `fault-freeze:${point}`,
        actor: "RUNTIME",
        lease: input.lease,
      }, (current) => { if (current === point) throw new Error(`FAULT:${point}`); }))
        .toThrow(`FAULT:${point}`);
      expect(authorityTransactionSnapshot(input)).toEqual(freezeBaseline);
    }

    expect(() => verifyLifecycleAuthorityIntegrity(input.connection, input.authority.databasePath)).not.toThrow();
  });

  it("freezes an exact user-approved closure and rebuilds it after restart without chat", () => {
    const input = fixture();
    const completed = completeFreeze(input);
    expect(completed.freeze).toMatchObject({
      goal_id: input.goalId,
      authority_root_id: input.acceptance.authority.authority_root_id,
      requirement_revision_id: completed.requirement.revision.requirement_revision_id,
      generation: 1,
      predecessor_freeze_sha256: intakeAuthorityZeroSha256,
    });
    const before = new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId);
    const beforeBundle = new IntakeAuthorityV2Repository(input.connection)
      .readAssessedGoalFitReview(completed.freeze.goal_fit_review_id);
    const beforeCounts = Object.fromEntries([
      "goal_fit_gate_instances_v2",
      "goal_fit_assessments_v2",
      "goal_fit_reviews_v2",
      "goal_fit_review_assessment_bindings_v2",
    ].map((table) => [table, input.connection.prepare(`SELECT count(*) count FROM ${table}`).get()]));
    expect(beforeBundle).not.toBeNull();
    expect(before?.decision_closure?.closure).toMatchObject({ qualified: true, draft_review_approved: true });
    expect(before?.contract_freeze?.record_sha256).toBe(completed.freeze.record_sha256);
    expect(input.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    const after = new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId);
    const afterBundle = new IntakeAuthorityV2Repository(input.connection)
      .readAssessedGoalFitReview(completed.freeze.goal_fit_review_id);
    expect(after?.projection_sha256).toBe(before?.projection_sha256);
    expect(after?.contract_freeze?.record_sha256).toBe(completed.freeze.record_sha256);
    expect(afterBundle).toEqual(beforeBundle);
    expect(Object.fromEntries(Object.keys(beforeCounts).map((table) => [
      table,
      input.connection.prepare(`SELECT count(*) count FROM ${table}`).get(),
    ]))).toEqual(beforeCounts);
  });

  it("rolls back a complete public workflow fault without exposing partial authority", () => {
    const input = fixture();
    const baseline = Object.fromEntries(tables.map((table) => [table,
      input.connection.prepare(`SELECT count(*) count FROM ${table}`).get()]));
    expect(() => runImmediateTransaction(input.connection, () => {
      completeFreezeWithinTransaction(input);
      throw new Error("fault:complete-workflow");
    })).toThrow("fault:complete-workflow");
    for (const table of tables) {
      expect(input.connection.prepare(`SELECT count(*) count FROM ${table}`).get(), table).toEqual(baseline[table]);
    }
  });

  it("uses a method SAVEPOINT when the second Requirement member insert fails and the caller catches the error", () => {
    const input = fixture();
    const beforeRevisions = input.connection.prepare("SELECT count(*) count FROM requirement_revisions_v2").get();
    const beforeItems = input.connection.prepare("SELECT count(*) count FROM requirement_items_v2").get();
    input.connection.exec(`CREATE TEMP TRIGGER fault_second_requirement_item
      BEFORE INSERT ON requirement_items_v2
      WHEN (SELECT count(*) FROM requirement_items_v2 WHERE requirement_revision_id=NEW.requirement_revision_id)=1
      BEGIN SELECT RAISE(ABORT,'fault:second-requirement-item'); END`);
    runImmediateTransaction(input.connection, () => {
      try {
        appendRequirement(input, new IntakeAuthorityV2Repository(input.connection));
      } catch (error) {
        expect(String(error)).toContain("fault:second-requirement-item");
      }
    });
    expect(input.connection.prepare("SELECT count(*) count FROM requirement_revisions_v2").get()).toEqual(beforeRevisions);
    expect(input.connection.prepare("SELECT count(*) count FROM requirement_items_v2").get()).toEqual(beforeItems);
    input.connection.exec("DROP TRIGGER fault_second_requirement_item");
  });

  it("uses a method SAVEPOINT when a Decision member insert fails and preserves the committed Requirement", () => {
    const input = fixture();
    const requirement = runImmediateTransaction(input.connection, () => appendRequirement(
      input, new IntakeAuthorityV2Repository(input.connection),
    ));
    const beforeRequirements = input.connection.prepare("SELECT count(*) count FROM requirement_revisions_v2").get();
    const beforeDecisions = input.connection.prepare("SELECT count(*) count FROM decision_requirements_v2").get();
    const beforeMembers = input.connection.prepare("SELECT count(*) count FROM decision_requirement_item_members_v2").get();
    input.connection.exec(`CREATE TEMP TRIGGER fault_second_decision_member
      BEFORE INSERT ON decision_requirement_item_members_v2
      WHEN (SELECT count(*) FROM decision_requirement_item_members_v2
        WHERE decision_requirement_revision_id=NEW.decision_requirement_revision_id)=1
      BEGIN SELECT RAISE(ABORT,'fault:second-decision-member'); END`);
    runImmediateTransaction(input.connection, () => {
      try {
        appendDraftReview(input, new IntakeAuthorityV2Repository(input.connection), requirement);
      } catch (error) {
        expect(String(error)).toContain("fault:second-decision-member");
      }
    });
    expect(input.connection.prepare("SELECT count(*) count FROM requirement_revisions_v2").get()).toEqual(beforeRequirements);
    expect(input.connection.prepare("SELECT count(*) count FROM decision_requirements_v2").get()).toEqual(beforeDecisions);
    expect(input.connection.prepare("SELECT count(*) count FROM decision_requirement_item_members_v2").get()).toEqual(beforeMembers);
    input.connection.exec("DROP TRIGGER fault_second_decision_member");
  });

  it("rejects lexical approval and a prior-revision action envelope without appending new authority", () => {
    const input = fixture();
    runImmediateTransaction(input.connection, () => {
      const repository = new IntakeAuthorityV2Repository(input.connection);
      const first = appendRequirement(input, repository);
      const firstDecisions = appendDraftReview(input, repository, first);
      const firstDecision = firstDecisions[0]!;
      expect(() => intakeCommand(input, "lexical-action:102", 102, (hostRepository, context) =>
        hostRepository.captureUserDecisionAction({
          decision_requirement_revision_id: firstDecision.decision_requirement_revision_id,
          action: "APPROVE", at_gate: "CONTRACT_REVIEW", selected_value: { approved: true },
          edited_requirement_revision_id: null, deferred_trigger_sha256: null, authority_source_span_id: null,
          source: "I reject this draft.", session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        }, context.sequence))).toThrow(/structured action envelope/u);
      approveDraft(input, first, firstDecisions);

      const second = appendRequirement(input, repository, first.revision.record_sha256, " v2", 110);
      const secondDecisions = appendDraftReview(input, repository, second, [], 111);
      const secondDecision = secondDecisions[0]!;
      expect(() => intakeCommand(input, "prior-revision-action:112", 112, (hostRepository, context) =>
        hostRepository.captureUserDecisionAction({
          decision_requirement_revision_id: secondDecision.decision_requirement_revision_id,
          action: "APPROVE", at_gate: "CONTRACT_REVIEW", selected_value: { approved: true },
          edited_requirement_revision_id: null, deferred_trigger_sha256: null, authority_source_span_id: null,
          source: userActionSource(first, firstDecisions, firstDecision),
          session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        }, context.sequence))).toThrow(/structured action envelope/u);
    });
    expect(input.connection.prepare("SELECT count(*) count FROM decision_authority_inputs_v2").get()).toEqual({ count: 1 });
    expect(input.connection.prepare("SELECT count(*) count FROM decision_resolutions_v2").get()).toEqual({ count: 1 });
  });

  it("cannot apply a Host default from a declared stage without the exact persisted DueEventReceipt", () => {
    const input = fixture();
    runImmediateTransaction(input.connection, () => {
      const repository = new IntakeAuthorityV2Repository(input.connection);
      const requirement = appendRequirement(input, repository);
      const decisions = appendDraftReview(input, repository, requirement, [{
        key: "layout", kind: "ARCHITECTURE", question: "Choose layout", materiality: "MEDIUM", blocking: false,
        affected_requirement_keys: [requirement.items[0]!.semantic_key], source_span_ids: [input.acceptance.spans[0]!.span_id],
        trigger: { kind: "STAGE_ENTRY", evidence_sha256: sha256Hex("layout-trigger") }, latest_resolution_stage: "PLAN_ENTRY",
        default: { action: "APPROVE", value: { local: true } }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
        proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      }]);
      const decision = decisions.find((candidate) => candidate.decision_key === "layout")!;
      expect(() => intakeCommand(input, "missing-default:103", 103, (hostRepository, context) =>
        hostRepository.applyHostDefault({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          due_event_receipt_id: "DUE-EVENT-DOES-NOT-EXIST",
          created_at_ms: context.now_ms,
        }, context.sequence))).toThrow(/DueEventReceipt.*missing/u);
      const due = intakeCommand(input, "due-event:104", 104, (hostRepository, context) =>
        hostRepository.recordDueEvent({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          purpose: "DEFAULT_DEADLINE", trigger_kind: "STAGE_ENTRY",
          trigger_sha256: decisionDeadlineTriggerSha256V2(decision), at_gate: "PLAN_ENTRY",
          event_evidence_sha256: sha256Hex("real-plan-entry-event"),
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        }, context.sequence));
      expect(intakeCommand(input, "apply-default:105", 105, (hostRepository, context) =>
        hostRepository.applyHostDefault({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          due_event_receipt_id: due.due_event_receipt_id,
          created_at_ms: context.now_ms,
        }, context.sequence))).toMatchObject({ authority_actor: "HOST_DEFAULT", due_event_receipt_id: due.due_event_receipt_id });
    });
  });

  it("never lets a delayed Host default overwrite an explicit USER resolution", () => {
    const input = fixture();
    runImmediateTransaction(input.connection, () => {
      const repository = new IntakeAuthorityV2Repository(input.connection);
      const requirement = appendRequirement(input, repository);
      const decisions = appendDraftReview(input, repository, requirement, [{
        key: "layout-user-wins", kind: "ARCHITECTURE", question: "Choose layout", materiality: "MEDIUM", blocking: false,
        affected_requirement_keys: [requirement.items[0]!.semantic_key], source_span_ids: requirement.items[0]!.source_span_ids,
        trigger: { kind: "STAGE_ENTRY", evidence_sha256: sha256Hex("layout-user-wins-trigger") }, latest_resolution_stage: "PLAN_ENTRY",
        default: { action: "APPROVE", value: { local: true } }, reversibility: "REVERSIBLE", affected_work_cell_ids: [],
        proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
      }]);
      const decision = decisions.find((candidate) => candidate.decision_key === "layout-user-wins")!;
      const due = intakeCommand(input, "user-wins-due:103", 103, (hostRepository, context) =>
        hostRepository.recordDueEvent({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          purpose: "DEFAULT_DEADLINE", trigger_kind: "STAGE_ENTRY",
          trigger_sha256: decisionDeadlineTriggerSha256V2(decision), at_gate: "PLAN_ENTRY",
          event_evidence_sha256: sha256Hex("layout-user-wins-event"),
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        }, context.sequence));
      const user = intakeCommand(input, "user-wins-action:104", 104, (hostRepository, context) => {
        const source = userDecisionAuthorityInputSourceV2({
          requirement_revision_sha256: requirement.revision.record_sha256,
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          decision_frontier_sha256: decisionFrontierSha256V2(decisions), action: "REJECT",
          action_payload_sha256: decisionActionPayloadSha256V2({
            decision, action: "REJECT", selected_value: null,
            edited_requirement_revision_id: null, deferred_trigger_sha256: null,
          }),
          at_gate: "PLAN_ENTRY", session_id: "SESSION-USER-WINS", turn_id: "TURN-USER-WINS",
          event_head_sha256: context.event_head_sha256,
        });
        return hostRepository.captureUserDecisionAction({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          action: "REJECT", at_gate: "PLAN_ENTRY", selected_value: null,
          edited_requirement_revision_id: null, deferred_trigger_sha256: null, authority_source_span_id: null,
          source, session_id: "SESSION-USER-WINS", turn_id: "TURN-USER-WINS",
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        }, context.sequence);
      });
      expect(() => intakeCommand(input, "user-wins-default:105", 105, (hostRepository, context) =>
        hostRepository.applyHostDefault({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          due_event_receipt_id: due.due_event_receipt_id,
          created_at_ms: context.now_ms,
        }, context.sequence))).toThrow(/USER|stale|expected.*head|already resolved/iu);
      expect(repository.rebuildGoalProjection(input.goalId)?.resolutions
        .find((resolution) => resolution.decision_requirement_revision_id === decision.decision_requirement_revision_id))
        .toMatchObject({ decision_resolution_id: user.decision_resolution_id, action: "REJECT", authority_actor: "USER" });
    });
  });

  it("returns the same USER resolution for an exact authority-input retry", () => {
    const input = fixture();
    runImmediateTransaction(input.connection, () => {
      const repository = new IntakeAuthorityV2Repository(input.connection);
      const requirement = appendRequirement(input, repository);
      const decisions = appendDraftReview(input, repository, requirement);
      const decision = decisions[0]!;
      const [first, retried] = intakeCommand(input, "exact-action-retry:102", 102, (hostRepository, context) => {
        const source = userDecisionAuthorityInputSourceV2({
          requirement_revision_sha256: requirement.revision.record_sha256,
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          decision_frontier_sha256: decisionFrontierSha256V2(decisions), action: "APPROVE",
          action_payload_sha256: decisionActionPayloadSha256V2({
            decision, action: "APPROVE", selected_value: { approved: true },
            edited_requirement_revision_id: null, deferred_trigger_sha256: null,
          }),
          at_gate: "CONTRACT_REVIEW", session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
          event_head_sha256: context.event_head_sha256,
        });
        const command = {
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          action: "APPROVE" as const, at_gate: "CONTRACT_REVIEW" as const, selected_value: { approved: true },
          edited_requirement_revision_id: null, deferred_trigger_sha256: null, authority_source_span_id: null,
          source, session_id: "SESSION-USER-ACTION", turn_id: "TURN-USER-ACTION",
          event_head_sha256: context.event_head_sha256, created_at_ms: context.now_ms,
        };
        return [
          hostRepository.captureUserDecisionAction(command, context.sequence),
          hostRepository.captureUserDecisionAction(command, context.sequence),
        ] as const;
      });
      expect(retried.record_sha256).toBe(first.record_sha256);
      expect(input.connection.prepare(`SELECT count(*) count FROM decision_resolutions_v2
        WHERE decision_requirement_revision_id=?`).get(decision.decision_requirement_revision_id)).toEqual({ count: 1 });
    });
  });

  it("returns the same immutable freeze receipt for an exact post-commit retry", () => {
    const input = fixture();
    const completed = completeFreeze(input);
    const retried = intakeCommand(input, "freeze-retry:106", 106, (repository, context) => repository.freezeContract({
      goal_id: input.goalId,
      expected_predecessor_freeze_sha256: completed.freeze.predecessor_freeze_sha256,
      created_at_ms: completed.freeze.created_at_ms,
    }, context.sequence));
    expect(retried.record_sha256).toBe(completed.freeze.record_sha256);
    expect(input.connection.prepare("SELECT count(*) count FROM contract_freeze_receipts_v2").get()).toEqual({ count: 1 });
  });

  it("rebuilds a Decision closure from its creation-time event frontier", () => {
    const input = fixture();
    const { closureId, closureSha256 } = runImmediateTransaction(input.connection, () => {
      const repository = new IntakeAuthorityV2Repository(input.connection);
      const requirement = appendRequirement(input, repository);
      const decisions = appendDraftReview(input, repository, requirement);
      const decision = decisions[0]!;
      approveDraft(input, requirement, decisions);
      const closure = intakeCommand(input, "as-of-closure:103", 103, (hostRepository, context) =>
        hostRepository.recordDecisionClosure(
          requirement.revision.requirement_revision_id, "CONTRACT_FREEZE", context.now_ms, context.sequence,
        ));
      intakeCommand(input, "as-of-later-rejection:104", 104, (hostRepository, context) => {
        const source = userDecisionAuthorityInputSourceV2({
          requirement_revision_sha256: requirement.revision.record_sha256,
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          decision_frontier_sha256: decisionFrontierSha256V2(decisions),
          action: "REJECT",
          action_payload_sha256: decisionActionPayloadSha256V2({
            decision,
            action: "REJECT",
            selected_value: null,
            edited_requirement_revision_id: null,
            deferred_trigger_sha256: null,
          }),
          at_gate: "CONTRACT_REVIEW",
          session_id: "SESSION-LATER-REJECTION",
          turn_id: "TURN-LATER-REJECTION",
          event_head_sha256: context.event_head_sha256,
        });
        return hostRepository.captureUserDecisionAction({
          decision_requirement_revision_id: decision.decision_requirement_revision_id,
          action: "REJECT",
          at_gate: "CONTRACT_REVIEW",
          selected_value: null,
          edited_requirement_revision_id: null,
          deferred_trigger_sha256: null,
          authority_source_span_id: null,
          source,
          session_id: "SESSION-LATER-REJECTION",
          turn_id: "TURN-LATER-REJECTION",
          event_head_sha256: context.event_head_sha256,
          created_at_ms: context.now_ms,
        }, context.sequence);
      });
      return {
        closureId: closure.closure.decision_closure_id,
        closureSha256: closure.closure.record_sha256,
      };
    });

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    const repository = new IntakeAuthorityV2Repository(input.connection);
    expect(repository.readDecisionClosure(closureId)?.closure)
      .toMatchObject({ record_sha256: closureSha256, qualified: true, rejected_decision_ids: [] });
    expect(repository.rebuildGoalProjection(input.goalId)).toMatchObject({
      decision_closure: null,
      goal_fit_review: null,
    });
  });

  it("detects a missing typed Decision closure member during restart rebuild", () => {
    const input = fixture();
    completeFreeze(input);
    input.connection.exec("DROP TRIGGER no_delete_decision_closure_members_v2");
    const member = input.connection.prepare(`SELECT decision_closure_id,decision_requirement_revision_id
      FROM decision_closure_members_v2 LIMIT 1`).get() as {
        decision_closure_id: string;
        decision_requirement_revision_id: string;
      };
    input.connection.prepare(`DELETE FROM decision_closure_members_v2
      WHERE decision_closure_id=? AND decision_requirement_revision_id=?`)
      .run(member.decision_closure_id, member.decision_requirement_revision_id);
    expect(() => new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId))
      .toThrow(/closure is invalid|member root|complete Host-derived projection/iu);
  });

  it("rebuilds the complete Intake history at lifecycle verification and rejects hostile tamper", () => {
    const input = fixture();
    completeFreeze(input);
    const repository = new IntakeAuthorityV2Repository(input.connection);
    expect(repository.verifyIntegrity()).toMatchObject({
      requirements: 1,
      decisions: 1,
      authority_inputs: 1,
      resolutions: 1,
      decision_closures: 1,
      goal_fit_reviews: 1,
      assessed_goal_fit_reviews: 1,
      contract_freezes: 1,
      goals: 1,
    });
    expect(() => verifyLifecycleAuthorityIntegrity(input.connection, input.authority.databasePath)).not.toThrow();

    input.connection.exec("DROP TRIGGER no_update_requirement_revisions_v2");
    input.connection.prepare(`UPDATE requirement_revisions_v2 SET input_closure_sha256=?
      WHERE requirement_revision_id=(SELECT requirement_revision_id FROM requirement_revisions_v2 LIMIT 1)`)
      .run(sha256Hex("hostile-intake-tamper"));
    expect(() => repository.verifyIntegrity()).toThrow(/Requirement V2 closure is invalid|predecessor chain/iu);
    expect(() => verifyLifecycleAuthorityIntegrity(input.connection, input.authority.databasePath))
      .toThrow(/Requirement V2 closure is invalid|predecessor chain/iu);
  });

  it.each([
    ["gate instance", "goal_fit_gate_instances_v2", "no_update_goal_fit_gate_instances_v2", "host_evidence_root_sha256"],
    ["assessment", "goal_fit_assessments_v2", "no_update_goal_fit_assessments_v2", "input_closure_sha256"],
    ["review", "goal_fit_reviews_v2", "no_update_goal_fit_reviews_v2", "input_closure_sha256"],
    ["binding", "goal_fit_review_assessment_bindings_v2", "no_update_goal_fit_review_assessment_bindings_v2", "record_sha256"],
  ] as const)("fails closed when an assessed Goal Fit %s is tampered", (_layer, table, trigger, column) => {
    const input = fixture();
    completeFreeze(input);
    input.connection.exec(`DROP TRIGGER ${trigger}`);
    input.connection.prepare(`UPDATE ${table} SET ${column}=? WHERE goal_id=?`)
      .run(sha256Hex(`hostile-${table}-${column}`), input.goalId);
    const repository = new IntakeAuthorityV2Repository(input.connection);
    expect(() => repository.verifyIntegrity()).toThrow(/Goal Fit|gate instance|assessment|review|binding|closure/iu);
    expect(() => verifyLifecycleAuthorityIntegrity(input.connection, input.authority.databasePath))
      .toThrow(/Goal Fit|gate instance|assessment|review|binding|closure/iu);
  });

  it("supports goal-global Requirement lineage across a new contract with contract-local revision 1", () => {
    const input = fixture();
    const first = new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId)?.requirement;
    if (!first) throw new Error("Intake V2 fixture lacks its first Requirement revision");
    input.authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT",
      goalId: input.goalId,
      proposal: taskContractProposal(),
      acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, { expectedVersion: eventHead(input).sequence, idempotencyKey: `contract:${input.goalId}:2`, actor: "RUNTIME", lease: input.lease });
    const secondContractId = input.authority.store.readTaskFlowView(input.goalId)?.contract?.contract_id;
    if (!secondContractId || secondContractId === input.acceptance.authority.contract_id) {
      throw new Error("Intake V2 fixture did not advance GoalContract authority");
    }
    const secondAcceptance = new AcceptanceAuthorityV2Repository(input.connection).readBundle(secondContractId);
    if (!secondAcceptance) throw new Error("Intake V2 cannot rebuild second Acceptance authority");
    const second = new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId)?.requirement;
    if (!second) throw new Error("Intake V2 fixture lacks its second Requirement revision");
    expect(second.revision).toMatchObject({
      revision: 2,
      contract_revision: 1,
      parent_requirement_revision_id: first.revision.requirement_revision_id,
      parent_requirement_revision_sha256: first.revision.record_sha256,
      contract_id: secondContractId,
    });
    expect(new IntakeAuthorityV2Repository(input.connection).rebuildGoalProjection(input.goalId)?.requirement.revision.record_sha256)
      .toBe(second.revision.record_sha256);
  });

});
