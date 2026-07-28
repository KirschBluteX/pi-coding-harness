import { describe, expect, it } from "vitest";
import { createEventHashes, verifyEventChain, type StoredEvent } from "../../src/authority/event-chain.js";
import { AuthorityIntegrityError } from "../../src/foundation/errors.js";

function event(sequence: number, prevEventSha256: string | null, payload: unknown): StoredEvent {
  const fields = {
    storeId: "STORE-TEST",
    goalId: "GOAL-TEST",
    sequence,
    eventType: sequence === 1 ? "GOAL_ADMITTED" : "PLAN_HEALTH_EVALUATED",
    commandId: `CMD-${sequence}`,
    prevEventSha256,
    storeGeneration: 1,
    leaderEpoch: 1,
  };
  return { eventId: `EVT-${sequence}`, ...fields, ...createEventHashes(payload, fields) };
}

describe("event hash chain", () => {
  it("verifies a contiguous canonical chain", () => {
    const first = event(1, null, { value: 1 });
    const second = event(2, first.eventSha256, { value: 2 });
    expect(verifyEventChain([first, second])).toEqual({ count: 2, headSha256: second.eventSha256 });
  });

  it("rejects sequence, predecessor, payload and event tampering", () => {
    const first = event(1, null, { value: 1 });
    const second = event(2, first.eventSha256, { value: 2 });
    expect(() => verifyEventChain([{ ...first, sequence: 2 }])).toThrow(AuthorityIntegrityError);
    expect(() => verifyEventChain([first, { ...second, prevEventSha256: "0".repeat(64) }])).toThrow(/predecessor/u);
    expect(() => verifyEventChain([first, { ...second, payloadJson: '{"value":3}' }])).toThrow(/payload hash/u);
    expect(() => verifyEventChain([first, { ...second, eventSha256: "f".repeat(64) }])).toThrow(/event hash/iu);
  });
});
