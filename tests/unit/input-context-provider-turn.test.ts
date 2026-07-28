import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  assertProviderTurnAttempt, assertProviderTurnLedger, assertProviderTurnRequest,
  type ProviderTurnAttemptRecord, type ProviderTurnLedgerRecord, type ProviderTurnRequestRecord,
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
  let beginCalls = 0;
  return {
    attempts, requests, completions,
    get beginCalls() { return beginCalls; },
    beginProviderTurn: (request: ProviderTurnRequestRecord, started: ProviderTurnAttemptRecord) => {
      beginCalls += 1;
      requests.push(request);
      attempts.push(started);
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
