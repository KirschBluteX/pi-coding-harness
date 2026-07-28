import { afterEach, describe, expect, it } from "vitest";
import { prepareMemoryClaim, computeMemoryActionSha256 } from "../../src/memory/admission.js";
import { attestUserInput } from "../../src/memory/source-resolvers.js";
import type { AppendMemoryActionCommand, AppendMemoryClaimCommand, TransactionFaultPoint } from "../../src/authority/transactions.js";
import type { MemoryClaimActionInput } from "../../src/memory/types.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

const authorities: Phase6Authority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function fixture(indexMode: "FTS5" | "TAG_PATH" = "TAG_PATH"): Phase6Authority {
  const authority = createPhase6Authority(indexMode);
  authorities.push(authority);
  return authority;
}

function claimCommand(authority: Phase6Authority, claimId: string): AppendMemoryClaimCommand {
  const statement = `Use deterministic Memory recovery for ${claimId}.`;
  const decision = prepareMemoryClaim({
    claimId, version: 1, workspaceId: "WS-TEST-001", actorGoalId: authority.goalId,
    scope: "WORKSPACE", channel: "POLICY",
    payload: { type: "TYPED_POLICY", policyKind: "WORKSPACE_RULE", statement, appliesTo: ["memory"] },
    sourceAttestation: attestUserInput(statement, `pch-user://memory/${claimId}/v1`, authority.clock.now()),
    tags: ["memory"], validFromMs: authority.clock.now(), supersedesVersion: null,
    maxPayloadBytes: authority.memoryConfig.maxPayloadBytes,
  });
  if (!decision.accepted) throw new Error(decision.reason);
  return { type: "APPEND_MEMORY_CLAIM", goalId: authority.goalId, record: decision.record };
}

const claimFaults: TransactionFaultPoint[] = [
  "after-memory-claim-write", "after-memory-claim-head-write", "after-memory-claim-index-outbox-write",
  "after-domain-write", "after-event-write", "after-outbox-write", "after-receipt-write", "before-commit",
];

describe("Memory v2 authority crash and fencing", () => {
  it.each(claimFaults)("rolls claim, head, event, receipt and index work back at %s", (faultPoint) => {
    const authority = fixture();
    const command = claimCommand(authority, `MEM-FAULT-${faultPoint.toUpperCase()}`);
    const initialVersion = authority.store.readSnapshot(authority.goalId).goalVersion;
    const meta = { expectedVersion: initialVersion, idempotencyKey: `memory-fault:${faultPoint}`, actor: "USER" as const, lease: authority.lease };
    expect(() => authority.store.transact(command, meta, (point) => {
      if (point === faultPoint) throw new Error(`FAULT:${point}`);
    })).toThrow(`FAULT:${faultPoint}`);
    expect(authority.store.readMemoryClaim(command.record.claimId)).toBeNull();
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(0);
    expect(authority.store.readSnapshot(authority.goalId).goalVersion).toBe(initialVersion);

    const replay = authority.store.transact(command, meta);
    expect(replay).toMatchObject({ eventSequence: initialVersion + 1, reused: false });
    expect(authority.store.readMemoryClaim(command.record.claimId)?.claimSha256).toBe(command.record.claimSha256);
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(1);
    expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1 });
  });

  it.each(["after-commit", "before-return"] as const)("recovers committed claim idempotently at %s", (faultPoint) => {
    const authority = fixture();
    const command = claimCommand(authority, `MEM-COMMIT-${faultPoint.toUpperCase()}`);
    const initialVersion = authority.store.readSnapshot(authority.goalId).goalVersion;
    const meta = { expectedVersion: initialVersion, idempotencyKey: `memory-commit:${faultPoint}`, actor: "USER" as const, lease: authority.lease };
    expect(() => authority.store.transact(command, meta, (point) => {
      if (point === faultPoint) throw new Error(`FAULT:${point}`);
    })).toThrow(`FAULT:${faultPoint}`);
    expect(authority.store.readMemoryClaim(command.record.claimId)).not.toBeNull();
    expect(authority.store.transact(command, meta)).toMatchObject({ eventSequence: initialVersion + 1, reused: true });
  });

  it.each([
    "after-memory-action-write", "after-memory-action-head-write", "after-memory-action-index-outbox-write",
  ] as const)("rolls a visibility action back at %s", (faultPoint) => {
    const authority = fixture("FTS5");
    const added = authority.memory.addUserPolicy({ statement: "Keep crash recovery exact.", scope: "WORKSPACE" }, authority.context(3));
    const claimId = added.record?.claimId ?? "";
    expect(authority.memory.drainIndex()).toMatchObject({ processed: 1, remaining: 0 });
    const base = {
      actionId: `MACT-${faultPoint.toUpperCase()}`, claimId, targetVersion: 1,
      workspaceId: "WS-TEST-001", actorGoalId: authority.goalId,
      actionType: "FORGET", actionFamily: "VISIBILITY", reason: "fault matrix",
      predecessorActionId: null, createdAtMs: authority.clock.now(),
    } as const;
    const memoryAction: MemoryClaimActionInput = { ...base, actionSha256: computeMemoryActionSha256(base) };
    const command: AppendMemoryActionCommand = { type: "APPEND_MEMORY_ACTION", goalId: authority.goalId, memoryAction };
    const initialVersion = authority.store.readSnapshot(authority.goalId).goalVersion;
    const meta = { expectedVersion: initialVersion, idempotencyKey: `memory-action:${faultPoint}`, actor: "USER" as const, lease: authority.lease };
    expect(() => authority.store.transact(command, meta, (point) => {
      if (point === faultPoint) throw new Error(`FAULT:${point}`);
    })).toThrow(`FAULT:${faultPoint}`);
    expect(authority.store.readMemoryActionHead(claimId, "VISIBILITY")).toBeNull();
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(0);
    expect(authority.store.transact(command, meta)).toMatchObject({ eventSequence: initialVersion + 1, reused: false });
    expect(authority.store.readMemoryActionHead(claimId, "VISIBILITY")?.actionType).toBe("FORGET");
  });

  it("rejects a stale lease after takeover without creating a correction version", () => {
    const authority = fixture();
    const added = authority.memory.addUserPolicy({ statement: "Use one fenced writer.", scope: "WORKSPACE" }, authority.context(3));
    const claimId = added.record?.claimId ?? "";
    authority.clock.advance(60_001);
    const takeover = authority.store.acquireLease(authority.goalId, "SESSION-MEMORY-TAKEOVER", 60_000);
    const currentVersion = authority.store.readSnapshot(authority.goalId).goalVersion;
    expect(() => authority.memory.correct(claimId, "Use the current fenced writer.", {
      goalId: authority.goalId, workspaceId: "WS-TEST-001", workspaceRoot: authority.directory,
      mutation: { expectedVersion: currentVersion, idempotencyKey: "stale-memory-correction", actor: "USER", lease: authority.lease },
    })).toThrow(/lease|fencing|owner/iu);
    expect(authority.store.readMemoryClaim(claimId)?.version).toBe(1);
    expect(authority.memory.correct(claimId, "Use the current fenced writer.", {
      goalId: authority.goalId, workspaceId: "WS-TEST-001", workspaceRoot: authority.directory,
      mutation: { expectedVersion: currentVersion, idempotencyKey: "takeover-memory-correction", actor: "USER", lease: takeover },
    })).toMatchObject({ accepted: true, record: { version: 2 } });
  });
});
