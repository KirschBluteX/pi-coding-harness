import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { AuthorityStore } from "../../src/authority/transactions.js";
import { AuthorityTransactionKernel } from "../../src/authority/authority-transaction-kernel.js";
import { openAuthorityConnection, closeAuthorityConnection } from "../../src/authority/database.js";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { piRuntimeFingerprintSha256 } from "../../src/harness/runtime-fingerprint.js";
import { finalizeExecutionNodeLeaseV2, finalizeWorkerProposalV2 } from "../../src/harness/execution-v2/domain.js";
import { createWorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";
import { finalizeProviderInvocationTerminalV1 } from "../../src/provider-v2/invocation.js";
import { ProviderCallPlanV1Repository } from "../../src/provider-v2/repository.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";
import { TestClock } from "../helpers/authority.js";
import { prepareExecutionV2GraphFixture } from "../helpers/execution-v2.js";
import type { HarnessFixture } from "../helpers/harness.js";

const sha = (value: string): string => sha256Hex(value);
const fixtures: HarnessFixture[] = [];
const reopenedStores: AuthorityStore[] = [];
const runtime = {
  provider: "provider-authority-test",
  api: "openai-responses",
  model: "provider-authority-model",
  thinking_level: "high",
  context_window: 128_000,
} as const;
const resolvedRuntime = {
  runtime,
  source: "SUPERVISOR_INHERITED" as const,
  fallback_reason: null,
};

afterEach(() => {
  for (const store of reopenedStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) fixture.authority.close();
});

function prepare(suffix: string, nodeId = "NODE-A") {
  const prepared = prepareExecutionV2GraphFixture(suffix, piRuntimeFingerprintSha256(runtime));
  fixtures.push(prepared.fixture);
  const { fixture, graph } = prepared;
  const node = graph.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) throw new TypeError(`Provider authority fixture lacks ${nodeId}`);
  const now = fixture.authority.clock.now();
  const closure = fixture.authority.store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const dispatch = createWorkerProviderDispatchAuthorityV1({
    graph,
    node,
    attempt: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    deadlineMs: now + 60_000,
    createdAtMs: now,
    predecessorAuthorityHeadSha256: closure.predecessorAuthorityHeadSha256,
    capabilityKey: "provider-authority-capability",
    runtime: resolvedRuntime,
  });
  const lease = finalizeExecutionNodeLeaseV2({
    packet: dispatch.packet,
    owner_hmac: sha(`provider-owner:${suffix}:${nodeId}`),
    expires_at_ms: now + 30_000,
    created_at_ms: now,
  });
  return { ...prepared, dispatch, lease };
}

function lease(input: ReturnType<typeof prepare>) {
  return input.fixture.authority.store.transactExecutionV2({
    type: "LEASE_EXECUTION_NODE_V2",
    goalId: input.fixture.goalId,
    packet: input.dispatch.packet,
    lease: input.lease,
    providerPlan: input.dispatch.plan,
    redaction: input.dispatch.redaction,
    invocation: input.dispatch.invocation,
  }, {
    expectedVersion: input.version,
    idempotencyKey: `provider-authority:${input.dispatch.packet.packet_id}:lease`,
    actor: "RUNTIME",
    lease: input.fixture.lease,
  });
}

function terminal(input: ReturnType<typeof prepare>, version: number, options: {
  readonly successSha256?: string;
  readonly inputTokens?: number;
  readonly suffix: string;
}) {
  const transition = finalizeProviderInvocationTerminalV1({
    prepared: input.dispatch.invocation,
    state: "SETTLED",
    request_count: 1,
    input_tokens: options.inputTokens ?? 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_microusd: 0,
    wall_time_ms: 1,
    cache_lineage_sha256: null,
    success_evidence_sha256: options.successSha256 ?? null,
    failure_sha256: options.successSha256 === undefined ? sha(`provider-failure:${options.suffix}`) : null,
    created_at_ms: input.fixture.authority.clock.now(),
  });
  const result = input.fixture.authority.store.transactExecutionV2({
    type: "RECORD_PROVIDER_INVOCATION_TRANSITION_V1",
    goalId: input.fixture.goalId,
    transition,
  }, {
    expectedVersion: version,
    idempotencyKey: `provider-authority:${options.suffix}:terminal`,
    actor: "RUNTIME",
    lease: input.fixture.lease,
  });
  return { transition, result };
}

function reopen(input: ReturnType<typeof prepare>): AuthorityStore {
  const store = AuthorityStore.open({
    databasePath: input.fixture.authority.databasePath,
    migrationPath: resolve("schemas", "sql", "001_core.sql"),
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
    clock: input.fixture.authority.clock,
  });
  reopenedStores.push(store);
  return store;
}

describe("ProviderCallPlan V1 authority", () => {
  it("atomically records exact plan, redaction, packet, lease and prepared invocation authority", () => {
    const input = prepare("PROVIDER-ATOMIC");
    lease(input);
    const store = input.fixture.authority.store;

    expect(store.readProviderCallPlan(input.dispatch.plan.provider_call_plan_id)).toEqual(input.dispatch.plan);
    expect(store.readProviderRedaction(input.dispatch.redaction.redaction_receipt_id)).toEqual(input.dispatch.redaction);
    expect(store.readProviderInvocation(input.dispatch.invocation.provider_invocation_id, 0)).toEqual(input.dispatch.invocation);
    expect(store.verifyProviderV2Integrity()).toMatchObject({
      available: true,
      plans: 1,
      plannedTaskPackets: 1,
      activeUnplannedTaskPackets: 0,
      mismatches: 0,
    });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({ packets: 1, leases: 1, mismatches: 0 });

    const restarted = reopen(input);
    expect(restarted.readProviderCallPlan(input.dispatch.plan.provider_call_plan_id)).toEqual(input.dispatch.plan);
    expect(restarted.readProviderInvocationByPacket(input.dispatch.packet.packet_id)).toEqual(input.dispatch.invocation);
  });

  it("rejects a plan, redaction, or invocation substituted from another exact node before dispatch", () => {
    const input = prepare("PROVIDER-SUBSTITUTION");
    const nodeB = input.graph.nodes.find((node) => node.node_id === "NODE-B")!;
    const now = input.fixture.authority.clock.now();
    const other = createWorkerProviderDispatchAuthorityV1({
      graph: input.graph,
      node: nodeB,
      attempt: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      deadlineMs: now + 60_000,
      createdAtMs: now,
      predecessorAuthorityHeadSha256: input.dispatch.plan.predecessor_authority_head_sha256,
      capabilityKey: "provider-authority-capability",
      runtime: resolvedRuntime,
    });
    expect(() => input.fixture.authority.store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2",
      goalId: input.fixture.goalId,
      packet: input.dispatch.packet,
      lease: input.lease,
      providerPlan: other.plan,
      redaction: other.redaction,
      invocation: other.invocation,
    }, {
      expectedVersion: input.version,
      idempotencyKey: "provider-authority:substituted-dispatch",
      actor: "RUNTIME",
      lease: input.fixture.lease,
    })).toThrow(/Provider authority|exact|invalid/u);
    expect(input.fixture.authority.store.verifyProviderV2Integrity()).toMatchObject({ plans: 0, mismatches: 0 });
  });

  it("persists observed over-budget usage but prevents it from authorizing a Worker proposal", () => {
    const input = prepare("PROVIDER-BUDGET");
    const leased = lease(input);
    const proposal = finalizeWorkerProposalV2({
      packet: input.dispatch.packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("provider-budget-proposal"), classification: "INTERNAL" }] },
      created_at_ms: input.fixture.authority.clock.now(),
    });
    const settled = terminal(input, leased.goalVersion, {
      successSha256: proposal.record_sha256,
      inputTokens: input.dispatch.plan.request_budget.soft_max_input_tokens + 1,
      suffix: "over-budget",
    });
    expect(input.fixture.authority.store.readProviderInvocation(
      input.dispatch.invocation.provider_invocation_id, 1,
    )).toEqual(settled.transition);
    expect(() => input.fixture.authority.store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2",
      goalId: input.fixture.goalId,
      proposal,
      patchSet: null,
      artifacts: [],
    }, {
      expectedVersion: settled.result.goalVersion,
      idempotencyKey: "provider-authority:over-budget:proposal",
      actor: "RUNTIME",
      lease: input.fixture.lease,
    })).toThrow(/settled Provider invocation|budget|receipt/u);
    expect(input.fixture.authority.store.verifyProviderV2Integrity()).toMatchObject({ plans: 1, mismatches: 0 });
  });

  it("allows a compliant terminal receipt to authorize exactly its bound proposal", () => {
    const input = prepare("PROVIDER-SUCCESS");
    const leased = lease(input);
    const proposal = finalizeWorkerProposalV2({
      packet: input.dispatch.packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("provider-success-proposal"), classification: "INTERNAL" }] },
      created_at_ms: input.fixture.authority.clock.now(),
    });
    const settled = terminal(input, leased.goalVersion, {
      successSha256: proposal.record_sha256,
      suffix: "success",
    });
    expect(() => input.fixture.authority.store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2",
      goalId: input.fixture.goalId,
      proposal,
      patchSet: null,
      artifacts: [],
    }, {
      expectedVersion: settled.result.goalVersion,
      idempotencyKey: "provider-authority:success:proposal",
      actor: "RUNTIME",
      lease: input.fixture.lease,
    })).not.toThrow();
    expect(input.fixture.authority.store.verifyProviderV2Integrity()).toMatchObject({ plans: 1, mismatches: 0 });
  });

  it("commits a successful Provider settlement and its Worker proposal under one authority event", () => {
    const input = prepare("PROVIDER-ATOMIC-PROPOSAL");
    const leased = lease(input);
    const proposal = finalizeWorkerProposalV2({
      packet: input.dispatch.packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("provider-atomic-proposal"), classification: "INTERNAL" }] },
      created_at_ms: input.fixture.authority.clock.now(),
    });
    const providerTerminal = finalizeProviderInvocationTerminalV1({
      prepared: input.dispatch.invocation,
      state: "SETTLED",
      request_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_microusd: 0,
      wall_time_ms: 1,
      cache_lineage_sha256: null,
      success_evidence_sha256: proposal.record_sha256,
      failure_sha256: null,
      created_at_ms: input.fixture.authority.clock.now(),
    });
    input.fixture.authority.store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2",
      goalId: input.fixture.goalId,
      proposal,
      patchSet: null,
      artifacts: [],
      providerTerminal,
    }, {
      expectedVersion: leased.goalVersion,
      idempotencyKey: "provider-authority:atomic-settlement-proposal",
      actor: "RUNTIME",
      lease: input.fixture.lease,
    });
    const database = new DatabaseSync(input.fixture.authority.databasePath, { readOnly: true });
    try {
      const rows = database.prepare(`SELECT i.created_event_sequence invocation_sequence,
        p.created_event_sequence proposal_sequence,e.event_type
        FROM provider_invocation_transitions_v1 i
        JOIN worker_proposals_v2 p ON p.record_sha256=i.success_evidence_sha256
        JOIN events e ON e.goal_id=i.goal_id AND e.sequence=i.created_event_sequence
        WHERE i.provider_invocation_id=? AND i.ordinal=1`).all(
        input.dispatch.invocation.provider_invocation_id,
      );
      expect(rows).toEqual([{
        invocation_sequence: leased.goalVersion + 1,
        proposal_sequence: leased.goalVersion + 1,
        event_type: "EXECUTION_WORKER_PROPOSAL_SUBMITTED",
      }]);
    } finally {
      database.close();
    }
    expect(input.fixture.authority.store.verifyProviderV2Integrity()).toMatchObject({ mismatches: 0 });
  });

  it("rejects a terminal invocation recorded under an unrelated authority event", () => {
    const input = prepare("PROVIDER-EVENT-BINDING");
    const leased = lease(input);
    const transition = finalizeProviderInvocationTerminalV1({
      prepared: input.dispatch.invocation,
      state: "SETTLED",
      request_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_microusd: 0,
      wall_time_ms: 1,
      cache_lineage_sha256: null,
      success_evidence_sha256: null,
      failure_sha256: sha("provider-unrelated-event"),
      created_at_ms: input.fixture.authority.clock.now(),
    });
    const connection = openAuthorityConnection({ path: input.fixture.authority.databasePath });
    try {
      const repository = new ProviderCallPlanV1Repository(connection);
      expect(() => new AuthorityTransactionKernel(connection, new TestClock(input.fixture.authority.clock.now())).execute({
        goalId: input.fixture.goalId,
        commandSha256: canonicalJsonSha256({ transition: transition.record_sha256 }),
        meta: {
          expectedVersion: leased.goalVersion,
          idempotencyKey: "provider-authority:wrong-terminal-event",
          actor: "RUNTIME",
        },
      }, {
        mutate: ({ sequence }) => repository.recordInvocation(transition, sequence),
        event: () => ({ eventType: "DECISION_RESOLVED", payload: { transition: transition.record_sha256 } }),
      })).toThrow(/terminal event|exact transition/u);
    } finally {
      closeAuthorityConnection(connection);
    }
    expect(input.fixture.authority.store.readProviderInvocation(input.dispatch.invocation.provider_invocation_id, 1)).toBeNull();
  });

  it("detects terminal event payload tampering after restart", () => {
    const input = prepare("PROVIDER-TAMPER");
    const leased = lease(input);
    terminal(input, leased.goalVersion, { suffix: "tamper" });
    const attacker = new DatabaseSync(input.fixture.authority.databasePath, { timeout: 5_000 });
    try {
      attacker.exec("DROP TRIGGER no_update_events");
      attacker.prepare(`UPDATE events SET payload_json=json_set(payload_json,'$.providerInvocationTransitionSha256',?)
        WHERE goal_id=? AND event_type='PROVIDER_INVOCATION_TRANSITIONED'`).run(
        sha("tampered-provider-terminal"), input.fixture.goalId,
      );
    } finally {
      attacker.close();
    }
    expect(() => input.fixture.authority.store.verifyProviderV2Integrity()).toThrow(/mismatch|event|integrity/u);
  });
});
