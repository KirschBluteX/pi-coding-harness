import { describe, expect, it } from "vitest";
import { BatchRehydrator, type RehydrationSource } from "../../src/input-context/batch-rehydrator.js";
import { ContextToolRuntime, type ContextToolSnapshot } from "../../src/input-context/context-tool.js";

function source(
  candidateId: string,
  value: string | Uint8Array | null,
  status: RehydrationSource["status"] = "CURRENT",
  byteLength: number | null = value === null ? null : typeof value === "string" ? Buffer.byteLength(value) : value.byteLength,
): RehydrationSource {
  return {
    candidateId, status, byteLength,
    open: () => value === null ? null : typeof value === "string" ? Buffer.from(value) : value,
  };
}

function snapshot(values: ReadonlyMap<string, RehydrationSource>): ContextToolSnapshot {
  return {
    epoch: "epoch-1", subjectBindingSha256: "a".repeat(64), envelopeSha256: "b".repeat(64),
    workingSetCandidateIds: [...values.keys()], onDemandCandidateIds: [...values.keys()],
    source: (candidateId) => values.get(candidateId) ?? null,
  };
}

describe("bounded pch_context delivery", () => {
  it("continues under a fixed absolute cursor expiry and survives a runtime restart", async () => {
    let now = 100;
    const values = new Map([
      ["one", source("one", "a".repeat(700))],
      ["two", source("two", "b".repeat(700))],
    ]);
    const first = new ContextToolRuntime(() => snapshot(values), "cursor-key", 10, 1_024, 50, () => now);
    const page = await first.execute({ selector: "CURRENT_WORKING_SET" });
    expect(page.items.map((item) => item.candidate_id)).toEqual(["one"]);
    expect(page.continuation).toBeTruthy();

    now = 120;
    const restarted = new ContextToolRuntime(() => snapshot(values), "cursor-key", 10, 1_024, 50, () => now);
    const resumed = await restarted.execute({ cursor: page.continuation! });
    expect(resumed.items.map((item) => item.candidate_id)).toEqual(["two"]);
    now = 151;
    expect((await restarted.execute({ cursor: page.continuation! })).status).toBe("CURSOR_INVALID");
  });

  it("rejects tampered, cross-envelope and out-of-scope selections", async () => {
    const values = new Map([["allowed", source("allowed", "value")]]);
    const runtime = new ContextToolRuntime(() => snapshot(values), "cursor-key", 10, 1_024, 50, () => 100);
    expect((await runtime.execute({ selector: "CURRENT_ON_DEMAND", candidate_ids: [] })).status).toBe("SELECTION_INVALID");
    expect((await runtime.execute({ selector: "CURRENT_ON_DEMAND", candidate_ids: ["other"] })).status).toBe("SELECTION_INVALID");
    const page = await runtime.execute({ selector: "CURRENT_ON_DEMAND" });
    expect(page.continuation).toBeNull();
    expect((await runtime.execute({ cursor: "forged.invalid" })).status).toBe("CURSOR_INVALID");
  });

  it("returns explicit non-current, missing, corrupt and sensitive statuses without content", async () => {
    const throwing: RehydrationSource = {
      candidateId: "corrupt", status: "CURRENT", byteLength: 1,
      open: () => { throw new Error("CAS corruption"); },
    };
    const values = new Map<string, RehydrationSource>([
      ["stale", source("stale", "old", "STALE")],
      ["sensitive", source("sensitive", "secret", "SENSITIVE_REFUSED")],
      ["missing", source("missing", null, "CURRENT")],
      ["corrupt", throwing],
    ]);
    const runtime = new ContextToolRuntime(() => snapshot(values), "cursor-key", 10, 4_096, 50, () => 100);
    const page = await runtime.execute({ selector: "CURRENT_WORKING_SET" });
    expect(page.items.map((item) => [item.candidate_id, item.status, item.content])).toEqual([
      ["stale", "STALE", null], ["sensitive", "SENSITIVE_REFUSED", null],
      ["missing", "MISSING", null], ["corrupt", "SOURCE_ERROR", null],
    ]);
    expect(page.fallback).toBe("NORMAL_READ_SEARCH");
  });

  it("always advances past an unknown-length oversized or non-UTF8 object", async () => {
    const rehydrator = new BatchRehydrator(10, 1_024);
    const oversized = await rehydrator.rehydrate([source("large", "x".repeat(2_000), "CURRENT", null)]);
    expect(oversized).toMatchObject({ nextOffset: null, items: [{ candidate_id: "large", status: "TOO_LARGE" }] });
    const binary = await rehydrator.rehydrate([source("binary", new Uint8Array([0xff]), "CURRENT", null)]);
    expect(binary).toMatchObject({ nextOffset: null, items: [{ candidate_id: "binary", status: "INSUFFICIENT" }] });
  });

  it("delivers lazy structural metadata while preserving partial-completeness fallback", async () => {
    const structural: RehydrationSource = {
      candidateId: "source", status: "CURRENT", byteLength: 20, open: () => Buffer.from("raw source"),
      structural: () => Promise.resolve({
        bytes: Buffer.from(JSON.stringify({ status: "PARTIAL", reasons: ["DYNAMIC_DEPENDENCY"] })),
        status: "PARTIAL" as const,
      }),
    };
    const runtime = new ContextToolRuntime(
      () => snapshot(new Map([["source", structural]])), "cursor-key", 10, 4_096, 50, () => 100,
    );
    const page = await runtime.execute({ selector: "CURRENT_WORKING_SET", representation: "STRUCTURAL" });
    expect(page.items[0]).toMatchObject({
      candidate_id: "source", status: "CURRENT", representation: "STRUCTURAL", structural_status: "PARTIAL",
    });
    expect(page.items[0]?.content).toContain("DYNAMIC_DEPENDENCY");
    expect(page.fallback).toBe("NORMAL_READ_SEARCH");
  });
});
