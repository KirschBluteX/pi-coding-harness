import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  assertProviderTurnAttempt, assertProviderTurnLedger, assertProviderTurnRequest,
  assertProviderTurnGoalBinding,
  type ProviderTurnAttemptRecord, type ProviderTurnGoalBindingRecord, type ProviderTurnLedgerRecord,
  type ProviderTurnRequestRecord,
} from "../../src/input-context/domain.js";
import { ProviderTurnLedgerCoordinator } from "../../src/input-context/provider-turn-ledger.js";

const promptGenerationId = "PROMPT-GENERATION-TEST-001";
const beginInput = {
  promptGenerationId,
  payloadShapeSha256: sha256Hex("payload-shape"),
  history: {
    descriptorRootSha256: sha256Hex("history"), messageCount: 1,
    logicalBytes: 4, userBytes: 4, assistantBytes: 0, otherBytes: 0,
  },
  toolSchemaBytes: 10,
  contextEnvelopeSha256: null,
  layout: null,
  contributions: [],
};

function authority(pending: readonly {
  readonly started: ProviderTurnAttemptRecord;
  readonly promptGenerationId: string;
  readonly ledger: ProviderTurnLedgerRecord | null;
}[] = []) {
  const attempts: ProviderTurnAttemptRecord[] = [];
  const requests: ProviderTurnRequestRecord[] = [];
  const completions: { ledger: ProviderTurnLedgerRecord; terminal: ProviderTurnAttemptRecord }[] = [];
  const bindings: ProviderTurnGoalBindingRecord[] = [];
  let beginCalls = 0;
  return {
    attempts, requests, completions, bindings,
    get beginCalls() { return beginCalls; },
    beginProviderTurn: (
      request: ProviderTurnRequestRecord,
      started: ProviderTurnAttemptRecord,
      binding?: ProviderTurnGoalBindingRecord,
    ) => {
      beginCalls += 1;
      requests.push(request);
      attempts.push(started);
      if (binding) bindings.push(binding);
    },
    readLatestProviderTurnRequest: (generationId: string) =>
      requests.filter((entry) => entry.prompt_generation_id === generationId).at(-1) ?? null,
    readPendingProviderTurns: () => pending,
    completeProviderTurn: (ledger: ProviderTurnLedgerRecord, terminal: ProviderTurnAttemptRecord) => {
      completions.push({ ledger, terminal });
    },
  };
}

describe("ProviderTurnLedgerCoordinator", () => {
  it("seals the exact Goal/run/session attribution with the logical request", () => {
    const store = authority();
    const lifecycle = new ProviderTurnLedgerCoordinator(store, "test", () => 100);
    const started = lifecycle.begin({
      ...beginInput,
      goalBinding: { goalId: "GOAL-PROVIDER-1", runId: "RUN-PROVIDER-1", sessionId: "SESSION-PROVIDER-1" },
    });
    expect(store.bindings).toHaveLength(1);
    expect(() => assertProviderTurnGoalBinding(store.bindings[0])).not.toThrow();
    expect(store.bindings[0]).toMatchObject({
      prompt_request_id: started.prompt_request_id,
      prompt_request_sha256: store.requests[0]?.record_sha256,
      goal_id: "GOAL-PROVIDER-1",
      run_id: "RUN-PROVIDER-1",
      session_id: "SESSION-PROVIDER-1",
    });
  });

  it("keeps STARTED independent from response usage and reconciles only after response", () => {
    let now = 100;
    const store = authority();
    const lifecycle = new ProviderTurnLedgerCoordinator(store, "test", () => now++);
    const started = lifecycle.begin(beginInput);
    expect(store.beginCalls).toBe(1);
    expect(() => assertProviderTurnRequest(store.requests[0])).not.toThrow();
    expect(() => assertProviderTurnAttempt(started)).not.toThrow();
    expect(started).toMatchObject({ outcome: "STARTED", completed_at_ms: null, usage_contribution_sha256: null });

    const reconciled = lifecycle.settle({
      usage: {
        input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 1,
      },
      responseStatus: 200,
      outcome: "RESPONDED",
      outputSeeds: [],
    });
    expect(reconciled).not.toBeNull();
    expect(() => assertProviderTurnLedger(reconciled)).not.toThrow();
    expect(() => assertProviderTurnAttempt(store.completions[0]?.terminal)).not.toThrow();
    expect(reconciled).toMatchObject({
      accounting_completeness: "COMPLETE", provider_uncached_input_tokens: 10,
      provider_cache_read_tokens: 2, provider_cache_write_tokens: 0,
      provider_generated_output_tokens: 3, attributed_input_tokens: 0,
      unattributed_input_tokens: 12, additional_provider_requests: 0,
    });
  });

  it("records an explicit unobservable reconciliation without inventing zero tokens", () => {
    const store = authority();
    const lifecycle = new ProviderTurnLedgerCoordinator(store, "test", () => 100);
    lifecycle.begin(beginInput);
    const reconciled = lifecycle.settle({
      usage: null,
      responseStatus: null,
      outcome: "OUTCOME_UNKNOWN",
      outputSeeds: [],
    });
    expect(reconciled).not.toBeNull();
    expect(() => assertProviderTurnLedger(reconciled)).not.toThrow();
    expect(reconciled).toMatchObject({
      accounting_completeness: "UNOBSERVABLE", provider_uncached_input_tokens: null,
      provider_generated_output_tokens: null, unattributed_input_tokens: null,
      unattributed_output_tokens: null,
    });
  });

  it("keeps interleaved attempts independent and settles them by attempt id", () => {
    let now = 100;
    const store = authority();
    const lifecycle = new ProviderTurnLedgerCoordinator(store, "test", () => now++);
    const first = lifecycle.begin(beginInput);
    const second = lifecycle.begin({
      ...beginInput,
      payloadShapeSha256: sha256Hex("payload-shape-second"),
    });

    expect(store.completions).toHaveLength(0);
    expect(lifecycle.hasPending(first.attempt_id)).toBe(true);
    expect(lifecycle.hasPending(second.attempt_id)).toBe(true);

    const settle = (attemptId: string, output: number) => lifecycle.settle({
      attemptId,
      usage: { input: 10, cacheRead: 2, cacheWrite: 0, output, reasoning: 1 },
      responseStatus: 200,
      outcome: "RESPONDED",
      outputSeeds: [],
    });
    expect(settle(second.attempt_id, 4)?.prompt_request_id).toBe(second.prompt_request_id);
    expect(lifecycle.hasPending(first.attempt_id)).toBe(true);
    expect(settle(first.attempt_id, 3)?.prompt_request_id).toBe(first.prompt_request_id);
    expect(lifecycle.hasPending()).toBe(false);
    expect(store.completions.map((entry) => entry.terminal.attempt_id)).toEqual([
      second.attempt_id,
      first.attempt_id,
    ]);
  });

  it("atomically closes a persisted STARTED attempt as OUTCOME_UNKNOWN after restart", () => {
    const firstStore = authority();
    const first = new ProviderTurnLedgerCoordinator(firstStore, "test", () => 100);
    const started = first.begin(beginInput);
    const recoveredStore = authority([{ started, promptGenerationId, ledger: null }]);
    new ProviderTurnLedgerCoordinator(recoveredStore, "test", () => 200);
    expect(recoveredStore.completions).toHaveLength(1);
    expect(recoveredStore.completions[0]?.terminal).toMatchObject({ outcome: "OUTCOME_UNKNOWN", transition_ordinal: 1 });
    expect(recoveredStore.completions[0]?.ledger).toMatchObject({ accounting_completeness: "UNOBSERVABLE" });
  });
});
