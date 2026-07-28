import { afterEach, describe, expect, it } from "vitest";
import { createTestAuthority, createGoalCommand, type TestAuthority } from "../helpers/authority.js";
import { type TransactionFaultPoint } from "../../src/authority/transactions.js";
import { AuthorityNotFoundError, VersionConflictError } from "../../src/foundation/errors.js";

const authorities: TestAuthority[] = [];
const beforeCommit: TransactionFaultPoint[] = [
  "before-begin", "after-begin", "after-idempotency", "after-version-check", "after-domain-write",
  "after-event-write", "after-projection-write", "after-outbox-write", "after-receipt-write", "before-commit",
];

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
});

describe("authority transaction crash matrix", () => {
  it.each(beforeCommit)("rolls back at %s", (faultPoint) => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    expect(() => authority.store.transact(command, { expectedVersion: 0, idempotencyKey: `create-${faultPoint}`, actor: "USER" }, (point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    })).toThrow(`fault:${faultPoint}`);
    expect(() => authority.store.readSnapshot(command.goalId)).toThrow(AuthorityNotFoundError);
    const replay = authority.store.transact(command, { expectedVersion: 0, idempotencyKey: `create-${faultPoint}`, actor: "USER" });
    expect(replay).toMatchObject({ goalVersion: 1, reused: false });
  });

  it.each(["after-commit", "before-return"] as const)("recovers a committed result after client failure at %s", (faultPoint) => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    const meta = { expectedVersion: 0, idempotencyKey: `create-${faultPoint}`, actor: "USER" as const };
    expect(() => authority.store.transact(command, meta, (point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    })).toThrow(`fault:${faultPoint}`);
    const replay = authority.store.transact(command, meta);
    expect(replay).toMatchObject({ goalVersion: 1, eventSequence: 1, reused: true });
    expect(authority.store.readSnapshot(command.goalId)).toMatchObject({ eventCount: 1, commandReceiptCount: 1 });
  });

  it("deduplicates a command before version checking and rejects a new stale command", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    const createMeta = { expectedVersion: 0, idempotencyKey: "create-once", actor: "USER" as const };
    const first = authority.store.transact(command, createMeta);
    const duplicate = authority.store.transact(command, createMeta);
    expect(first.reused).toBe(false);
    expect(duplicate).toMatchObject({ eventSha256: first.eventSha256, reused: true });
    const lease = authority.store.acquireLease(command.goalId, "SESSION-OWNER-A", 30_000);
    const appended = authority.store.transact(
      { type: "APPEND_EVENT", goalId: command.goalId, eventType: "PLAN_HEALTH_EVALUATED", payload: { step: 1 } },
      { expectedVersion: 1, idempotencyKey: "append-once", actor: "AGENT", lease },
    );
    expect(appended.goalVersion).toBe(2);
    expect(() => authority.store.transact(
      { type: "APPEND_EVENT", goalId: command.goalId, eventType: "GOAL_CORRECTED", payload: { step: 2 } },
      { expectedVersion: 1, idempotencyKey: "append-stale", actor: "AGENT", lease },
    )).toThrow(VersionConflictError);
    expect(authority.store.verifyIntegrity()).toEqual({ goalCount: 1, eventCount: 2 });
  });

  it("rejects reuse of an idempotency key for different command content", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "same-key", actor: "USER" });
    expect(() => authority.store.transact(
      { ...command, objective: "Different objective" },
      { expectedVersion: 0, idempotencyKey: "same-key", actor: "USER" },
    )).toThrow(/different command content/u);
    expect(authority.store.readSnapshot(command.goalId)).toMatchObject({ eventCount: 1, commandReceiptCount: 1 });
  });

  it("rejects an intake classification that contradicts the persisted profile and depth", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    expect(() => authority.store.transact(
      { ...command, classification: { ...command.classification, specificationRoute: "BUILD_LIGHT", confidence: "HIGH", reasonCodes: ["CLEAR_LOW_RISK_SINGLE_STAGE"] } },
      { expectedVersion: 0, idempotencyKey: "classification-substitution", actor: "USER" },
    )).toThrow(/BUILD_LIGHT requires TASK_SPEC and LIGHT|Goal intake classification is inconsistent/u);
    expect(() => authority.store.readSnapshot(command.goalId)).toThrow(AuthorityNotFoundError);
  });
});
