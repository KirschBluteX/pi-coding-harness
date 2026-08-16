import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection, type AuthorityConnection } from "../../src/authority/database.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { ProviderTurnLedgerCoordinator } from "../../src/input-context/provider-turn-ledger.js";
import { InputContextRepository } from "../../src/input-context/repository.js";
import { inputContextHashDomains, sealInputContextRecord } from "../../src/input-context/canonical.js";
import { createHarnessFixture, type HarnessFixture } from "../helpers/harness.js";

const fixtures: HarnessFixture[] = [];
const connections: AuthorityConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) closeAuthorityConnection(connection);
  for (const fixture of fixtures.splice(0)) fixture.authority.close();
});

function open(topology: "SINGLE" | "MULTI", suffix: string) {
  const fixture = createHarnessFixture(topology, suffix);
  fixtures.push(fixture);
  const connection = openAuthorityConnection({ path: fixture.authority.databasePath });
  connections.push(connection);
  return { fixture, repository: new InputContextRepository(connection) };
}

function beginInput(generation: string, suffix: string) {
  return {
    promptGenerationId: generation,
    payloadShapeSha256: sha256Hex(`payload:${suffix}`),
    history: {
      descriptorRootSha256: sha256Hex(`history:${suffix}`),
      messageCount: 1,
      logicalBytes: 4,
      userBytes: 4,
      assistantBytes: 0,
      otherBytes: 0,
    },
    toolSchemaBytes: 10,
    contextEnvelopeSha256: null,
    layout: null,
    contributions: [],
  } as const;
}

describe("Strong Single provider usage window", () => {
  it("attributes only the exact Goal/run/window and closes totals from immutable evidence", () => {
    const first = open("SINGLE", "STRONG-USAGE-A");
    const second = open("SINGLE", "STRONG-USAGE-B");
    let now = 1_900_000_000_000;
    const coordinatorA = new ProviderTurnLedgerCoordinator(first.repository, "usage-secret-a", () => now);
    const coordinatorB = new ProviderTurnLedgerCoordinator(second.repository, "usage-secret-b", () => now);
    const startedAt = now;
    coordinatorA.begin({
      ...beginInput("PROMPT-GENERATION-STRONG-A", "a"),
      goalBinding: {
        goalId: first.fixture.goalId,
        runId: first.fixture.run.run_id,
        sessionId: "SESSION-STRONG-A",
      },
    });
    coordinatorB.begin({
      ...beginInput("PROMPT-GENERATION-STRONG-B", "b"),
      goalBinding: {
        goalId: second.fixture.goalId,
        runId: second.fixture.run.run_id,
        sessionId: "SESSION-STRONG-B",
      },
    });
    now += 25;
    coordinatorA.settle({
      usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, reasoning: 1 },
      responseStatus: 200,
      outcome: "RESPONDED",
      outputSeeds: [],
    });
    coordinatorB.settle({
      usage: { input: 100, cacheRead: 20, cacheWrite: 10, output: 30, reasoning: 10 },
      responseStatus: 200,
      outcome: "RESPONDED",
      outputSeeds: [],
    });

    const usage = first.repository.readRunProviderTurnUsage({
      goal_id: first.fixture.goalId,
      run_id: first.fixture.run.run_id,
      started_at_ms: startedAt,
      completed_at_ms: now,
    });
    expect(usage).toMatchObject({
      accounting_completeness: "COMPLETE",
      requests: 1,
      input_tokens: 13,
      output_tokens: 3,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      incomplete_reasons: [],
    });
    expect(usage.receipt_refs).toHaveLength(5);
    expect(usage.receipt_refs).toEqual([...usage.receipt_refs].sort());
  });

  it("rejects partial, pending, and crossing evidence instead of inventing complete zeros", () => {
    const { fixture, repository } = open("SINGLE", "STRONG-USAGE-PARTIAL");
    let now = 1_900_000_100_000;
    const coordinator = new ProviderTurnLedgerCoordinator(repository, "usage-secret-partial", () => now);
    coordinator.begin({
      ...beginInput("PROMPT-GENERATION-STRONG-PARTIAL", "partial"),
      goalBinding: { goalId: fixture.goalId, runId: fixture.run.run_id, sessionId: "SESSION-STRONG-PARTIAL" },
    });
    const startedAt = now;
    now += 10;
    const pending = repository.readRunProviderTurnUsage({
      goal_id: fixture.goalId,
      run_id: fixture.run.run_id,
      started_at_ms: startedAt,
      completed_at_ms: now,
    });
    expect(pending.accounting_completeness).toBe("PARTIAL");
    expect(pending.incomplete_reasons).toContain("PENDING_OR_WINDOW_CROSSING");

    coordinator.settle({ usage: null, responseStatus: null, outcome: "OUTCOME_UNKNOWN", outputSeeds: [] });
    const incomplete = repository.readRunProviderTurnUsage({
      goal_id: fixture.goalId,
      run_id: fixture.run.run_id,
      started_at_ms: startedAt,
      completed_at_ms: now,
    });
    expect(incomplete.accounting_completeness).toBe("PARTIAL");
    expect(incomplete.incomplete_reasons).toEqual(expect.arrayContaining([
      "CORE_USAGE_UNOBSERVABLE",
      "LEDGER_INCOMPLETE",
      "NON_RESPONDED_PROVIDER_TURN",
    ]));

    const crossing = repository.readRunProviderTurnUsage({
      goal_id: fixture.goalId,
      run_id: fixture.run.run_id,
      started_at_ms: startedAt + 1,
      completed_at_ms: now,
    });
    expect(crossing.accounting_completeness).toBe("PARTIAL");
    expect(crossing.incomplete_reasons).toContain("WINDOW_CROSSING");
  });

  it("rejects physical retries until usage is attributable per attempt", () => {
    const { fixture, repository } = open("SINGLE", "STRONG-USAGE-RETRY");
    let now = 1_900_000_200_000;
    const coordinator = new ProviderTurnLedgerCoordinator(repository, "usage-secret-retry", () => now);
    const first = coordinator.begin({
      ...beginInput("PROMPT-GENERATION-STRONG-RETRY", "retry"),
      goalBinding: { goalId: fixture.goalId, runId: fixture.run.run_id, sessionId: "SESSION-STRONG-RETRY" },
    });
    const startedAt = now;
    now += 10;
    coordinator.settle({
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 },
      responseStatus: 200, outcome: "RESPONDED", outputSeeds: [],
    });
    now += 1;
    const { record_sha256: _firstSha256, ...binding } = first;
    void _firstSha256;
    repository.appendProviderTurnAttempt(sealInputContextRecord(
      inputContextHashDomains.providerTurnAttempt, "record_sha256", {
        ...binding,
        attempt_id: "PROVIDER-ATTEMPT-STRONG-RETRY-2",
        attempt_number: 2,
        transition_ordinal: 0,
        started_at_ms: now,
        completed_at_ms: null,
        response_status: null,
        outcome: "STARTED" as const,
        usage_contribution_sha256: null,
      },
    ));
    const usage = repository.readRunProviderTurnUsage({
      goal_id: fixture.goalId,
      run_id: fixture.run.run_id,
      started_at_ms: startedAt,
      completed_at_ms: now,
    });
    expect(usage.accounting_completeness).toBe("PARTIAL");
    expect(usage.incomplete_reasons).toEqual(expect.arrayContaining([
      "PENDING_OR_WINDOW_CROSSING",
      "RETRY_USAGE_UNPROVEN",
    ]));
  });
});
