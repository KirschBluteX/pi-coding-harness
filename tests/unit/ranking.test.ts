import { describe, expect, it } from "vitest";
import { conflictingPolicyClaimIds, rankMemoryChannel } from "../../src/memory/ranking.js";
import { attestUserInput } from "../../src/memory/source-resolvers.js";
import type { EffectiveMemoryClaim, MemoryClaimVersionRecord, MemoryQuery, TypedPolicy } from "../../src/memory/types.js";

function value(claimId: string, statement: string, overrides: Partial<MemoryClaimVersionRecord> = {}): EffectiveMemoryClaim {
  const payload: TypedPolicy = { type: "TYPED_POLICY", policyKind: "PREFERENCE", statement, appliesTo: ["build"] };
  const source = attestUserInput(statement, `pch-user://${claimId}`, 100);
  const claim = {
    claimId, version: 1, workspaceId: "WS-1", actorGoalId: "GOAL-1", scope: "WORKSPACE", scopeGoalId: null,
    channel: "POLICY", status: "ACTIVE", payload, payloadSha256: "a".repeat(64), sourceAttestation: source,
    tags: ["build"], pathKey: null, dependencyKeys: [], classification: "INTERNAL", validFromMs: 100,
    expiresAtMs: null, supersedesVersion: null, contentText: statement, contentSha256: "b".repeat(64),
    contentTokenEstimate: 5, claimSha256: "c".repeat(64), createdEventSequence: 1, ...overrides,
  } as MemoryClaimVersionRecord;
  return { claim, endorsed: false, forgotten: false };
}

const query: MemoryQuery = {
  workspaceId: "WS-1", goalId: "GOAL-1", workspaceRoot: ".", text: "build", tags: ["build"], nowMs: 200,
};

describe("Memory v2 typed ranking", () => {
  it("ranks Policy by scope and exact applicability without mixing channels", () => {
    const ranked = rankMemoryChannel([
      value("MEM-WORKSPACE", "Use pnpm."),
      value("MEM-GOAL", "Use npm.", { scope: "GOAL", scopeGoalId: "GOAL-1" }),
    ], query, new Map());
    expect(ranked.map((entry) => entry.value.claim.claimId)).toEqual(["MEM-GOAL", "MEM-WORKSPACE"]);
  });

  it("preserves BM25 order for Evidence when exact metadata ties", () => {
    const evidence = (id: string): EffectiveMemoryClaim => ({
      ...value(id, id),
      claim: { ...value(id, id).claim, channel: "EVIDENCE", payload: {
        type: "EVIDENCE_LOCATOR", evidenceKind: "PROJECT_FILE", locator: `pch-file://${id}`, description: id,
        lineStart: null, lineEnd: null,
      } },
    });
    const ranked = rankMemoryChannel([evidence("MEM-B"), evidence("MEM-A")], { ...query, tags: [] }, new Map([
      ["MEM-A", { claimId: "MEM-A", channel: "EVIDENCE", exactMatches: 0, lexicalMatches: 1, relevanceRank: -2 }],
      ["MEM-B", { claimId: "MEM-B", channel: "EVIDENCE", exactMatches: 0, lexicalMatches: 1, relevanceRank: -1 }],
    ]));
    expect(ranked.map((entry) => entry.value.claim.claimId)).toEqual(["MEM-A", "MEM-B"]);
  });

  it("abstains both equal-precedence contradictory policies", () => {
    const ranked = rankMemoryChannel([
      value("MEM-YES", "Use npm."), value("MEM-NO", "Do not use npm."),
    ], query, new Map());
    expect([...conflictingPolicyClaimIds(ranked)].sort()).toEqual(["MEM-NO", "MEM-YES"]);
  });
});
