import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyMemoryCapture } from "../../src/memory/capture.js";
import { createPhase6Authority } from "../helpers/phase6.js";

function capture(text = "请记住：输出保持简洁") {
  return classifyMemoryCapture({
    workspaceId: "WS-TEST-001", goalId: "GOAL-PHASE2-001", text,
    sourceKind: "USER_INPUT", sourceActor: "USER", decisionActor: "RUNTIME",
    sourceLocator: "pi-input://SESSION/1", intentOwnership: "NONE",
  });
}

describe("Memory 3.1 workspace capture authority", () => {
  it("appends a truthful content-free stream without Goal version or lease ownership", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const before = fixture.store.readSnapshot(fixture.goalId).goalVersion;
      const decision = capture();
      const first = fixture.store.recordMemoryCaptureDecision(decision, "capture:1");
      const reused = fixture.store.recordMemoryCaptureDecision(decision, "capture:1");
      expect(first).toMatchObject({ reused: false, event: {
        streamSequence: 1, sourceActor: "USER", decisionActor: "RUNTIME", route: "EXPLICIT_AUTO",
      } });
      expect(reused).toMatchObject({ reused: true, event: { eventSha256: first.event.eventSha256 } });
      expect(fixture.store.readSnapshot(fixture.goalId).goalVersion).toBe(before);
      expect(fixture.store.readMemoryV3StreamHead("WS-TEST-001")).toEqual({
        streamSequence: 1, lastEventSha256: first.event.eventSha256,
      });
      expect(fixture.store.readMemoryV3Events("WS-TEST-001")).toHaveLength(1);
      fixture.store.verifyMemoryV3Integrity();

      const bytes = [fixture.databasePath, `${fixture.databasePath}-wal`]
        .filter(existsSync).map((path) => readFileSync(path).toString("utf8")).join("\n");
      expect(bytes).not.toContain("输出保持简洁");
    } finally { fixture.close(); }
  }, 15_000);

  it("rejects idempotency collisions and rolls every stream write back on a fault", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      fixture.store.recordMemoryCaptureDecision(capture("请记住：使用本地测试"), "capture:stable");
      expect(() => fixture.store.recordMemoryCaptureDecision(capture("请记住：使用完整测试"), "capture:stable"))
        .toThrow(/idempotency key was reused/u);
      expect(() => fixture.store.recordMemoryCaptureDecision(
        capture("请记住：补丁范围保持有限"), "capture:fault",
        (point) => { if (point === "after-memory-v3-event-write") throw new Error("injected capture fault"); },
      )).toThrow(/injected capture fault/u);
      expect(fixture.store.readMemoryV3StreamHead("WS-TEST-001")?.streamSequence).toBe(1);
      expect(fixture.store.readMemoryV3Events("WS-TEST-001")).toHaveLength(1);

      const retry = fixture.store.recordMemoryCaptureDecision(capture("请记住：补丁范围保持有限"), "capture:fault");
      expect(retry.event.streamSequence).toBe(2);
      fixture.store.verifyMemoryV3Integrity();
    } finally { fixture.close(); }
  });

  it("enforces immutability on capture events", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const event = fixture.store.recordMemoryCaptureDecision(capture(), "capture:immutable").event;
      const connection = (fixture.store as unknown as { connection: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).connection;
      expect(() => connection.prepare("UPDATE memory_v3_events SET route='REJECT' WHERE event_id=?").run(event.eventId))
        .toThrow(/immutable/u);
    } finally { fixture.close(); }
  });
});
