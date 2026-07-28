import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityStore } from "../../src/authority/transactions.js";
import { LeaseConflictError, StaleFencingTokenError } from "../../src/foundation/errors.js";
import { createGoalCommand, createTestAuthority, TestClock, type TestAuthority } from "../helpers/authority.js";

const authorities: TestAuthority[] = [];
const secondaryStores: AuthorityStore[] = [];
afterEach(() => {
  for (const store of secondaryStores.splice(0)) store.close();
  for (const authority of authorities.splice(0)) authority.close();
});

describe("lease generation and fencing", () => {
  it("allows one owner, performs expired CAS takeover and rejects the stale token", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const secondClock = new TestClock(authority.clock.current);
    const second = AuthorityStore.open({ databasePath: authority.databasePath, clock: secondClock });
    secondaryStores.push(second);
    const firstToken = authority.store.acquireLease(command.goalId, "SESSION-A", 1_000);
    expect(() => authority.store.renewLease(firstToken, 0, 1)).toThrow(RangeError);
    expect(() => authority.store.renewLease(firstToken, 1_000, 0)).toThrow(RangeError);
    expect(() => second.acquireLease(command.goalId, "SESSION-B", 1_000)).toThrow(LeaseConflictError);
    secondClock.advance(1_001);
    const secondToken = second.acquireLease(command.goalId, "SESSION-B", 1_000);
    expect(secondToken).toMatchObject({ generation: 2, fencingToken: 2, ownerSessionId: "SESSION-B" });
    expect(() => authority.store.renewLease(firstToken, 1_000, 1)).toThrow(StaleFencingTokenError);
    expect(() => authority.store.transact(
      { type: "APPEND_EVENT", goalId: command.goalId, eventType: "GOAL_CORRECTED", payload: {} },
      { expectedVersion: 1, idempotencyKey: "stale-write", actor: "AGENT", lease: firstToken },
    )).toThrow(StaleFencingTokenError);
    const result = second.transact(
      { type: "APPEND_EVENT", goalId: command.goalId, eventType: "GOAL_CORRECTED", payload: {} },
      { expectedVersion: 1, idempotencyKey: "current-write", actor: "AGENT", lease: secondToken },
    );
    expect(result.goalVersion).toBe(2);
  });

  it("does not create durable writes for redundant renewal requests", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const initial = authority.store.acquireLease(command.goalId, "SESSION-A", 1_000);
    const connection = new DatabaseSync(authority.databasePath, { readOnly: true, timeout: 5_000 });
    const row = (): { expires_at_ms: number; last_progress_event_sequence: number; row_version: number } =>
      connection.prepare("SELECT expires_at_ms,last_progress_event_sequence,row_version FROM execution_leases WHERE goal_id=?")
        .get(command.goalId) as { expires_at_ms: number; last_progress_event_sequence: number; row_version: number };
    try {
      const before = row();
      expect(authority.store.renewLease(initial, 1_000, 1)).toEqual(initial);
      expect(row()).toEqual(before);

      const progressed = authority.store.renewLease(initial, 1_000, 2);
      expect(row()).toEqual({ ...before, last_progress_event_sequence: 2, row_version: before.row_version + 1 });

      authority.clock.advance(500);
      const extended = authority.store.renewLease(progressed, 1_000, 2);
      expect(extended.expiresAtMs).toBe(initial.expiresAtMs + 500);
      expect(row().row_version).toBe(before.row_version + 2);
    } finally {
      connection.close();
    }
  });

  it("executes canonical mutation only while its lease fence is current", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create-fenced-effect", actor: "USER" });
    const secondClock = new TestClock(authority.clock.current);
    const second = AuthorityStore.open({ databasePath: authority.databasePath, clock: secondClock });
    secondaryStores.push(second);
    const firstToken = authority.store.acquireLease(command.goalId, "SESSION-A", 1_000);
    const effects: string[] = [];
    authority.store.withLeaseFence(firstToken, () => effects.push("CURRENT"));

    authority.clock.advance(1_001);
    secondClock.advance(1_001);
    second.acquireLease(command.goalId, "SESSION-B", 1_000);
    expect(() => authority.store.withLeaseFence(firstToken, () => effects.push("STALE")))
      .toThrow(StaleFencingTokenError);
    expect(effects).toEqual(["CURRENT"]);
  });
});
