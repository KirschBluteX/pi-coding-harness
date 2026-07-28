import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { MemoryIndexDrainer } from "../../src/memory/index-drainer.js";
import { createGoalCommand } from "../helpers/authority.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

let authority: Phase6Authority | undefined;
afterEach(() => {
  vi.useRealTimers();
  authority?.close();
  authority = undefined;
});

describe("Memory v2 per-workspace index recovery", () => {
  it("keeps another workspace backlog from disabling FTS and merges only the local pending overlay", () => {
    authority = createPhase6Authority("FTS5");
    const first = authority.memory.addUserPolicy({
      statement: "Use indexed alpha evidence.", scope: "WORKSPACE", tags: ["alpha-indexed"],
    }, authority.context(3));
    expect(authority.memory.drainIndex()).toMatchObject({ processed: 1, remaining: 0 });

    const secondGoalId = "GOAL-MEMORY-INDEX-B";
    const secondCommand = {
      ...createGoalCommand(secondGoalId), originSessionId: "SESSION-MEMORY-INDEX-B",
      workspace: {
        workspaceId: "WS-MEMORY-INDEX-B", workspaceHmac: sha256Hex("memory-index-b"),
        filesystemKind: "LOCAL_TEST", localLockingVerified: true as const,
      },
    };
    authority.store.transact(secondCommand, { expectedVersion: 0, idempotencyKey: "memory-index-b:create", actor: "USER" });
    const secondLease = authority.store.acquireLease(secondGoalId, "SESSION-MEMORY-INDEX-B", 60_000);
    const second = authority.memory.addUserPolicy({
      statement: "Use pending beta evidence.", scope: "WORKSPACE", tags: ["beta-pending"],
    }, {
      goalId: secondGoalId, workspaceId: "WS-MEMORY-INDEX-B", workspaceRoot: authority.directory,
      mutation: { expectedVersion: 1, idempotencyKey: "memory-index-b:add", actor: "USER", lease: secondLease },
    });

    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(0);
    expect(authority.store.memoryPendingIndexCount("WS-MEMORY-INDEX-B")).toBe(1);
    const indexed = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "alpha indexed", tags: ["alpha-indexed"], nowMs: authority.clock.now(),
    });
    expect(indexed.indexMode).toBe("FTS5");
    expect(indexed.selected.map((entry) => entry.claimId)).toContain(first.record?.claimId);
    expect(indexed.indexLagCount).toBe(0);

    const pending = authority.memory.retrieve({
      workspaceId: "WS-MEMORY-INDEX-B", goalId: secondGoalId, workspaceRoot: authority.directory,
      text: "beta pending", tags: ["beta-pending"], nowMs: authority.clock.now(),
    });
    expect(pending.indexMode).toBe("FTS5");
    expect(pending.selected.map((entry) => entry.claimId)).toContain(second.record?.claimId);
    expect(pending.indexLagCount).toBe(1);
    expect(pending.selected.map((entry) => entry.claimId)).not.toContain(first.record?.claimId);
  });

  it("drains a scheduled batch after debounce without blocking the mutation path", () => {
    vi.useFakeTimers();
    authority = createPhase6Authority("FTS5");
    const drainer = new MemoryIndexDrainer(authority.memory, 50);
    expect(authority.memory.addUserPolicy({ statement: "Drain outside the request path.", scope: "WORKSPACE" }, authority.context(3)).accepted).toBe(true);
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(1);
    authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "Drain outside", nowMs: authority.clock.now(),
    });
    expect(authority.memory.pendingTelemetryCount()).toBe(1);
    const before = new DatabaseSync(authority.databasePath, { readOnly: true });
    expect(before.prepare("SELECT count(*) AS count FROM memory_recall_observations").get()).toEqual({ count: 0 });
    before.close();
    drainer.schedule();
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(1);
    vi.advanceTimersByTime(49);
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(0);
    const after = new DatabaseSync(authority.databasePath, { readOnly: true });
    expect(after.prepare("SELECT selected_count,index_lag_count FROM memory_recall_observations").get())
      .toMatchObject({ selected_count: 1, index_lag_count: 1 });
    after.close();
    expect(authority.memory.pendingTelemetryCount()).toBe(0);
    expect(drainer.failure()).toBeNull();
    expect(drainer.close()).toMatchObject({ processed: 0, remaining: 0 });
  });

  it("recalls an older relevant pending claim beyond a newer unrelated backlog", () => {
    authority = createPhase6Authority("FTS5");
    let version = 3;
    const target = authority.memory.addUserPolicy({
      statement: "Use the distinctive quasar route.", scope: "WORKSPACE",
    }, authority.context(version));
    expect(target.accepted).toBe(true);
    version += 1;
    for (let index = 0; index < 40; index += 1) {
      const decoy = authority.memory.addUserPolicy({
        statement: `Recent unrelated pending policy ${index}.`, scope: "WORKSPACE",
      }, authority.context(version));
      expect(decoy.accepted).toBe(true);
      version += 1;
    }

    const recalled = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "distinctive quasar route", nowMs: authority.clock.now(),
    });
    expect(recalled.selected.map((entry) => entry.claimId)).toContain(target.record?.claimId);
    expect(recalled.indexLagCount).toBe(41);
  });

  it("ranks an exact metadata match above newer weak lexical pending matches", () => {
    authority = createPhase6Authority("FTS5");
    let version = 3;
    const target = authority.memory.addUserPolicy({
      statement: "Prefer the stable build route.", scope: "WORKSPACE", tags: ["release-target"],
    }, authority.context(version));
    expect(target.accepted).toBe(true);
    version += 1;
    for (let index = 0; index < 20; index += 1) {
      const decoy = authority.memory.addUserPolicy({
        statement: `Release target appears incidentally in policy ${index}.`, scope: "WORKSPACE",
      }, authority.context(version));
      expect(decoy.accepted).toBe(true);
      version += 1;
    }

    const recalled = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "release target", tags: ["release-target"], nowMs: authority.clock.now(),
    });
    expect(recalled.selected[0]?.claimId).toBe(target.record?.claimId);
  });
});
