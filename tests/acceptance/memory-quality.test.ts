import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Phase6Authority } from "../helpers/phase6.js";
import { createPhase6Authority } from "../helpers/phase6.js";
import { MemoryEngine } from "../../src/memory/engine.js";

describe.each(["TAG_PATH", "FTS5"] as const)("Memory v2 quality %s", (indexMode) => {
  let authority: Phase6Authority | undefined;
  afterEach(() => authority?.close());

  it("adds, explains, corrects, endorses, forgets and restores without changing provenance on endorsement", () => {
    authority = createPhase6Authority(indexMode);
    const added = authority.memory.addUserPolicy({
      statement: "Use deterministic local validation.", scope: "GOAL", tags: ["validation"],
    }, authority.context(3));
    expect(added.accepted).toBe(true);
    const claimId = added.record?.claimId ?? "";
    if (indexMode === "FTS5") expect(authority.memory.drainIndex().processed).toBe(1);
    const first = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "deterministic validation", nowMs: authority.clock.now(),
    });
    expect(first).toMatchObject({ indexMode, additionalModelRequests: 0, mode: "EXPERIMENTAL" });
    expect(first.selected.map((entry) => entry.claimId)).toEqual([claimId]);

    authority.clock.advance(25);
    const corrected = authority.memory.correct(claimId, "Use deterministic local checks before full validation.", authority.context(4));
    expect(corrected).toMatchObject({ accepted: true, record: { version: 2 } });
    const sourceBeforeEndorse = corrected.record?.sourceAttestation;
    authority.clock.advance(25);
    const endorsed = authority.memory.endorse(claimId, authority.context(5));
    expect(endorsed).toMatchObject({ accepted: true, action: { actionType: "ENDORSE" } });
    expect(authority.store.readMemoryClaim(claimId)?.sourceAttestation).toEqual(sourceBeforeEndorse);

    authority.clock.advance(25);
    expect(authority.memory.forget(claimId, authority.context(6))).toMatchObject({ accepted: true, action: { actionType: "FORGET" } });
    expect(authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "local checks", nowMs: authority.clock.now(),
    }).selected).toEqual([]);
    authority.clock.advance(25);
    expect(authority.memory.restore(claimId, authority.context(7))).toMatchObject({ accepted: true, action: { actionType: "RESTORE" } });
    expect(authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "local checks", nowMs: authority.clock.now(),
    }).selected.map((entry) => entry.claimId)).toEqual([claimId]);
    expect(authority.memory.purge(claimId, authority.context(8))).toMatchObject({
      accepted: false, reason: "PURGE_UNAVAILABLE_REQUIRES_STORE_KEY_ROTATION_WAL_FTS_AND_BACKUP_POLICY",
    });
  });

  it("reuses an exact duplicate without advancing Goal or Memory authority", () => {
    authority = createPhase6Authority(indexMode);
    const intent = { statement: "Reuse exact Memory writes.", scope: "WORKSPACE" as const, tags: ["reuse"] };
    const first = authority.memory.addUserPolicy(intent, authority.context(3));
    const before = authority.store.readSnapshot(authority.goalId).goalVersion;
    const duplicate = authority.memory.addUserPolicy(intent, authority.context(before));
    expect(duplicate).toMatchObject({ accepted: true, reason: "REUSED_EXISTING_CLAIM", authorityResult: null });
    expect(duplicate.record?.claimSha256).toBe(first.record?.claimSha256);
    expect(authority.store.readSnapshot(authority.goalId).goalVersion).toBe(before);
    expect(authority.store.memoryPendingIndexCount("WS-TEST-001")).toBe(1);
  });

  it("uses source-first project evidence and abstains after the file changes", () => {
    authority = createPhase6Authority(indexMode);
    const sourcePath = join(authority.directory, "architecture.txt");
    writeFileSync(sourcePath, "authoritative architecture v1", "utf8");
    const added = authority.memory.addProjectEvidence({
      path: "architecture.txt", description: "Architecture source", scope: "WORKSPACE", tags: ["architecture"],
    }, authority.context(3));
    expect(added.accepted).toBe(true);
    if (indexMode === "FTS5") authority.memory.drainIndex();
    const current = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "architecture", tags: ["architecture"], nowMs: authority.clock.now(),
    });
    expect(current.selected[0]).toMatchObject({ channel: "EVIDENCE", payload: { locator: "pch-file://architecture.txt" } });
    expect(current.workingSet.projection).not.toContain("authoritative architecture v1");
    writeFileSync(sourcePath, "authoritative architecture v2", "utf8");
    const stale = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "architecture", tags: ["architecture"], nowMs: authority.clock.now(),
    });
    expect(stale.selected).toEqual([]);
    expect(stale.workingSet.abstentions).toContain(`${added.record?.claimId}:SOURCE_CHANGED`);
  });

  it("enforces whole-claim projection budgets and channel quotas", () => {
    authority = createPhase6Authority(indexMode);
    let version = 3;
    for (let index = 0; index < 8; index += 1) {
      expect(authority.memory.addUserPolicy({
        statement: `Policy ${index} ${"content ".repeat(8)}`, scope: "WORKSPACE", tags: ["budget"],
      }, authority.context(version)).accepted).toBe(true);
      version += 1;
    }
    const constrained = new MemoryEngine(authority.store, {
      ...authority.memoryConfig, softProjectionTokens: 100, hardProjectionTokens: 640, maxPolicyResults: 3,
    }, () => authority?.clock.now() ?? 0);
    const result = constrained.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "", tags: ["budget"], nowMs: authority.clock.now(),
    });
    expect(result.selected.length).toBeLessThanOrEqual(3);
    expect(result.omittedClaimIds.length).toBeGreaterThan(0);
    expect(result.workingSet.tokenEstimate).toBeLessThanOrEqual(640);
    expect(result.workingSet.policy.map((entry) => entry.claimId))
      .toEqual(result.selected.map((entry) => entry.claimId));
    for (const entry of result.selected) {
      expect(entry.payload.type).toBe("TYPED_POLICY");
      if (entry.payload.type === "TYPED_POLICY") {
        expect(result.workingSet.projection).toContain(entry.payload.value ?? entry.payload.statement);
      }
      expect(result.workingSet.projection).not.toContain(entry.claimId);
      expect(result.workingSet.projection).not.toContain(entry.reason);
      expect(result.workingSet.projection).not.toContain(entry.sourceSha256);
      expect(result.workingSet.projection).not.toContain(entry.claimSha256);
    }
  });

  it("keeps the returned selection and WorkingSet within one total cross-channel limit", () => {
    authority = createPhase6Authority(indexMode);
    const receiptId = authority.receiptId;
    expect(authority.memory.addUserPolicy({ statement: "Use total budgets.", scope: "WORKSPACE", tags: ["total"] }, authority.context(3)).accepted).toBe(true);
    expect(authority.memory.addReceiptEvidence({ receiptId, description: "total evidence", scope: "WORKSPACE", tags: ["total"] }, authority.context(4)).accepted).toBe(true);
    expect(authority.memory.addReceiptExperience({ receiptId, lesson: "total experience", scope: "WORKSPACE", tags: ["total"] }, authority.context(5)).accepted).toBe(true);
    const constrained = new MemoryEngine(authority.store, {
      ...authority.memoryConfig, maxResults: 2, maxPolicyResults: 2, maxEvidenceResults: 2, maxExperienceResults: 2,
    }, () => authority?.clock.now() ?? 0);
    const result = constrained.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "total", tags: ["total"], nowMs: authority.clock.now(),
    });
    const workingIds = [...result.workingSet.policy, ...result.workingSet.evidence, ...result.workingSet.experience]
      .map((entry) => entry.claimId);
    expect(result.selected).toHaveLength(2);
    expect(workingIds).toEqual(result.selected.map((entry) => entry.claimId));
    expect(result.omittedClaimIds.length).toBeGreaterThan(0);
  });
});

describe("Memory v2 OFF fallback", () => {
  let authority: Phase6Authority | undefined;
  afterEach(() => authority?.close());

  it("returns an exact empty optional WorkingSet without touching Memory tables", () => {
    authority = createPhase6Authority("TAG_PATH", false, "OFF");
    const result = authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "anything", nowMs: authority.clock.now(),
    });
    expect(result).toMatchObject({ indexMode: "DISABLED", mode: "OFF", selected: [], reason: "MEMORY_OFF", additionalModelRequests: 0 });
    expect(result.workingSet.projection).toBe("");
    expect(authority.memory.drainIndex()).toEqual({ processed: 0, remaining: 0, workspaceWatermarks: {} });
  });
});

describe("Memory v2 receipt-backed Experience", () => {
  let authority: Phase6Authority | undefined;
  afterEach(() => authority?.close());

  it("admits, verifies, retrieves, and projects an Experience only from an authority receipt", () => {
    authority = createPhase6Authority("FTS5");
    const receiptId = authority.receiptId;

    const added = authority.memory.addReceiptExperience({
      receiptId,
      lesson: "Invalidate the Memory index before retrying a repaired retrieval route.",
      scope: "WORKSPACE",
      tags: ["index", "retry", "experience"],
    }, authority.context(3));
    expect(added).toMatchObject({
      accepted: true,
      additionalModelRequests: 0,
      record: {
        channel: "EXPERIENCE",
        payload: { type: "EXPERIENCE_RECORD", receiptId },
        sourceAttestation: { resolver: "AUTHORITY_RECEIPT", locator: `pch-receipt://${receiptId}` },
      },
    });
    expect(authority.memory.drainIndex()).toMatchObject({ processed: 1, remaining: 0 });

    const recalled = authority.memory.retrieve({
      workspaceId: "WS-TEST-001",
      goalId: authority.goalId,
      workspaceRoot: authority.directory,
      text: "repaired retrieval retry",
      tags: ["experience"],
      nowMs: authority.clock.now(),
    });
    expect(recalled).toMatchObject({ mode: "EXPERIMENTAL", additionalModelRequests: 0 });
    expect(recalled.selected).toHaveLength(1);
    expect(recalled.selected[0]).toMatchObject({
      channel: "EXPERIENCE",
      sourceLocator: `pch-receipt://${receiptId}`,
      payload: { type: "EXPERIENCE_RECORD", receiptId },
    });
    expect(recalled.workingSet.experience.map((entry) => entry.claimId)).toEqual([
      added.record?.claimId,
    ]);
    expect(recalled.workingSet.projection).toContain("Invalidate the Memory index before retrying");

    const verifiedJit = new MemoryEngine(authority.store, {
      ...authority.memoryConfig,
      mode: "VERIFIED_JIT",
    }, () => authority?.clock.now() ?? 0);
    expect(verifiedJit.addReceiptExperience({
      receiptId,
      lesson: "This must not be admitted outside EXPERIMENTAL.",
      scope: "WORKSPACE",
    }, authority.context(4))).toMatchObject({
      accepted: false,
      reason: "MEMORY_MODE_NOT_ELIGIBLE_FOR_EXPERIENCE",
      additionalModelRequests: 0,
    });
  });
});
