import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { PiContextProjector } from "../../src/input-context/pi-context-projector.js";
import { RetainedContextLedger } from "../../src/input-context/retained-ledger.js";
import type { MemoryContextMessage } from "../../src/memory/context-projector.js";

const memory = (content: string): MemoryContextMessage => ({
  customType: "pch-memory-v3", content, display: false,
  details: {
    manifestSha256: sha256Hex(content), policySnapshotSha256: sha256Hex("policy"),
    evidenceDeltaSha256: sha256Hex("evidence"), persistence: "EPHEMERAL_PROVIDER_CONTEXT",
    contributionClaim: {
      contractId: "PCH-PROVIDER-TURN-LEDGER-V1", owner: "MEMORY", inputSurface: "PCH_MEMORY",
      logicalBytes: Buffer.byteLength(content), estimatedTokens: 1, evidence: "LOCAL_ESTIMATE",
    },
  },
});

describe("RetainedContextLedger", () => {
  it("hashes only an appended suffix and detects a branch cut", () => {
    const ledger = new RetainedContextLedger("key");
    const first = { role: "user", content: "one" };
    const second = { role: "assistant", content: "two" };
    expect(ledger.reconcile([first, second])).toMatchObject({ commonPrefixCount: 0, hashedMessageCount: 2, branchChanged: false });
    expect(ledger.reconcile([first, second, { role: "user", content: "three" }]))
      .toMatchObject({ commonPrefixCount: 2, hashedMessageCount: 1, branchChanged: false });
    expect(ledger.reconcile([first])).toMatchObject({ commonPrefixCount: 1, hashedMessageCount: 0, branchChanged: true });
  });

  it("does not collide equal text with different roles", () => {
    const ledger = new RetainedContextLedger("key");
    const user = ledger.reconcile([{ role: "user", content: "same" }]);
    const assistant = ledger.reconcile([{ role: "assistant", content: "same" }]);
    expect(assistant.entries[0]?.entryIdentityHmac).not.toBe(user.entries[0]?.entryIdentityHmac);
  });
});

describe("PiContextProjector", () => {
  it("is idempotent, strips persisted PCH context and projects one ephemeral segment", () => {
    const projector = new PiContextProjector("key", () => 10);
    const prepared = projector.prepareSystemPrompt({
      generationId: "GEN-1", systemPrompt: "base",
      additions: [{ marker: "[POLICY]", content: "[POLICY]\nrule" }],
      segment: memory("memory"),
    });
    expect(prepared).toMatchObject({ systemPromptChanged: true, stagedSegment: "STAGED" });
    const base = [{ role: "user", content: "task" }];
    const first = projector.project(base);
    expect(first.projectedSegmentCount).toBe(1);
    expect(first.messages).toHaveLength(2);
    const persisted = first.messages;
    const second = projector.project(persisted);
    expect(second.projectedSegmentCount).toBe(1);
    expect(second.removedPersistedHarnessMessages).toBe(1);
    expect(second.messages).toHaveLength(2);
  });

  it("requires a generation boundary before replacing one segment type", () => {
    const projector = new PiContextProjector("key", () => 10);
    projector.prepareSystemPrompt({ generationId: "GEN-1", systemPrompt: "base", additions: [], segment: memory("one") });
    projector.project([{ role: "user", content: "task" }]);
    expect(projector.prepareSystemPrompt({
      generationId: "GEN-1", systemPrompt: "base", additions: [], segment: memory("two"),
    }).stagedSegment).toBe("BOUNDARY_REQUIRED");
    expect(projector.prepareSystemPrompt({
      generationId: "GEN-2", systemPrompt: "base", additions: [], segment: memory("two"),
    }).stagedSegment).toBe("STAGED");
  });

  it("falls back to baseline when an overlay anchor exceeds the actual branch", () => {
    const projector = new PiContextProjector("key", () => 10);
    projector.prepareSystemPrompt({ generationId: "GEN-1", systemPrompt: "base", additions: [], segment: memory("one") });
    projector.project([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    const cut = projector.project([{ role: "user", content: "a" }]);
    expect(cut).toMatchObject({ fallback: "BASELINE_INVALID_ANCHOR", projectedSegmentCount: 0 });
    expect(cut.messages).toHaveLength(1);
  });
});
