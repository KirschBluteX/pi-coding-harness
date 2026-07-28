import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import {
  memoryV3AuthorityMetadata, type MemoryV3ClaimDraft, type MemoryV3StoreClaimInput,
} from "../../src/authority/repositories/memory-v3.js";
import { MemoryVault, type MemoryVaultPrepared } from "../../src/memory/vault.js";
import { createPhase6Authority } from "../helpers/phase6.js";

function body(statement: string) {
  return {
    schema_version: 1, record_type: "MEMORY_V3_BODY", content_text: statement,
    payload: {
      type: "TYPED_POLICY", policyKind: "PREFERENCE", semanticKey: "policy.output.style",
      operator: "PREFER", value: statement, statement, appliesTo: [],
    },
    source: { locator: "pch-user://memory/test", actor: "USER" },
    tags: [], path_key: null, dependency_keys: [], content_token_estimate: 8,
  } as const;
}

function draft(statement: string, claimId: string, version = 1, status: "ACTIVE" | "PROPOSED" = "ACTIVE"): MemoryV3ClaimDraft {
  const value = body(statement);
  return {
    claimId, version, workspaceId: "WS-TEST-001", sourceGoalId: "GOAL-PHASE2-001",
    scope: "WORKSPACE", scopeGoalId: null, channel: "POLICY", status, classification: "INTERNAL",
    payloadType: "TYPED_POLICY", policyOperator: "PREFER",
    semanticKeySha256: canonicalJsonSha256("policy.output.style"),
    valueSha256: canonicalJsonSha256(statement), bodySha256: canonicalJsonSha256(value),
    sourceLocatorSha256: canonicalJsonSha256("pch-user://memory/test"),
    sourceContentSha256: canonicalJsonSha256(statement), validFromMs: 1_800_000_000_000,
    expiresAtMs: null, supersedesVersion: version === 1 ? null : version - 1,
    terms: [{ kind: "SEMANTIC_KEY", hmac: "a".repeat(64) }, { kind: "CONTENT", hmac: "b".repeat(64) }],
  };
}

function stored(
  vault: MemoryVault,
  statement: string,
  claimId = "MEM3-LIFECYCLE-001",
  version = 1,
  status: "ACTIVE" | "PROPOSED" = "ACTIVE",
): { readonly input: MemoryV3StoreClaimInput; readonly prepared: MemoryVaultPrepared } {
  const value = body(statement);
  const base = draft(statement, claimId, version, status);
  const metadata = memoryV3AuthorityMetadata(base);
  const prepared = vault.prepare({ workspaceId: base.workspaceId, claimId, version, authorityMetadata: metadata, body: value });
  return {
    prepared,
    input: {
      ...base, ...prepared, sourceKind: "MANUAL_COMMAND", sourceActor: "USER", decisionActor: "USER",
      route: "MANUAL", disposition: "NOT_APPLICABLE", reasonCodes: ["USER_EXPLICIT_MEMORY"],
      candidateSha256: canonicalJsonSha256({ claimId, version, statement }),
    },
  };
}

describe("Memory v3 Vault-backed authority lifecycle", () => {
  it("stores only content-free authority metadata without advancing the Goal", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const vault = new MemoryVault(fixture.directory, randomBytes(32));
      const item = stored(vault, "Keep final output concise.");
      const before = fixture.store.readSnapshot(fixture.goalId).goalVersion;
      const result = fixture.store.recordMemoryV3Claim(item.input, "claim:1");
      const reused = fixture.store.recordMemoryV3Claim(item.input, "claim:1");
      expect(result).toMatchObject({ reused: false, claim: { claimId: item.input.claimId, version: 1 } });
      expect(reused).toMatchObject({ reused: true, claim: { claimSha256: result.claim.claimSha256 } });
      expect(fixture.store.readSnapshot(fixture.goalId).goalVersion).toBe(before);
      expect(fixture.store.readMemoryV3ClaimHead(item.input.claimId)).toMatchObject({
        proposalState: "ACTIVE", visibility: "VISIBLE", purgeState: "PRESENT", endorsed: false,
      });
      expect(vault.open({ ...item.prepared, ...result.claim })).toMatchObject({ content_text: "Keep final output concise." });
      fixture.store.verifyMemoryV3Integrity();

      const bytes = [fixture.databasePath, `${fixture.databasePath}-wal`]
        .filter(existsSync).map((path) => readFileSync(path).toString("utf8")).join("\n");
      expect(bytes).not.toContain("Keep final output concise.");
    } finally { fixture.close(); }
  });

  it("rebuilds proposal, visibility, endorsement, correction and purge projections", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const vault = new MemoryVault(fixture.directory, randomBytes(32));
      const initial = stored(vault, "Prefer concise output.", "MEM3-LIFECYCLE-002", 1, "PROPOSED");
      fixture.store.recordMemoryV3Claim(initial.input, "claim:proposal");
      expect(fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 1,
        actionType: "APPROVE", sourceActor: "USER", reasonCode: "USER_APPROVED",
        purgeIntentId: null,
      }, "action:approve").head.proposalState).toBe("ACTIVE");
      expect(fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 1,
        actionType: "ENDORSE", sourceActor: "USER", reasonCode: "USER_ENDORSED",
        purgeIntentId: null,
      }, "action:endorse").head.endorsed).toBe(true);
      expect(fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 1,
        actionType: "FORGET", sourceActor: "USER", reasonCode: "USER_FORGOT",
        purgeIntentId: null,
      }, "action:forget").head.visibility).toBe("FORGOTTEN");
      expect(fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 1,
        actionType: "RESTORE", sourceActor: "USER", reasonCode: "USER_RESTORED",
        purgeIntentId: null,
      }, "action:restore").head.visibility).toBe("VISIBLE");

      const corrected = stored(vault, "Prefer concise final output.", initial.input.claimId, 2);
      fixture.store.recordMemoryV3Claim(corrected.input, "claim:correction");
      expect(fixture.store.readMemoryV3ClaimVersions(initial.input.claimId).map((entry) => entry.version)).toEqual([1, 2]);
      const purgeIntent = fixture.store.prepareMemoryV3PurgeIntent({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 2, requestedBy: "USER",
      }, "purge:intent");
      for (const version of fixture.store.readMemoryV3ClaimVersions(initial.input.claimId)) {
        expect(vault.destroyKey(version)).toMatch(/DESTROYED|ALREADY_ABSENT/u);
      }
      const purged = fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 2,
        actionType: "PURGE_LOCAL_KEY", sourceActor: "USER", reasonCode: "USER_PURGED_LOCAL_KEYS",
        purgeIntentId: purgeIntent.intent.intentId,
      }, "action:purge");
      expect(purged.head.purgeState).toBe("PURGED_LOCAL_KEY");
      expect(() => fixture.store.recordMemoryV3Action({
        workspaceId: initial.input.workspaceId, claimId: initial.input.claimId, targetVersion: 2,
        actionType: "RESTORE", sourceActor: "USER", reasonCode: "INVALID_RESTORE",
        purgeIntentId: null,
      }, "action:restore-after-purge")).toThrow(/not valid/u);
      fixture.store.verifyMemoryV3Integrity();
    } finally { fixture.close(); }
  });

  it("rolls back every authority projection when claim persistence faults", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const vault = new MemoryVault(fixture.directory, randomBytes(32));
      const item = stored(vault, "Keep bounded patches.", "MEM3-LIFECYCLE-003");
      expect(() => fixture.store.recordMemoryV3Claim(item.input, "claim:fault", (point) => {
        if (point === "after-memory-v3-claim-head-write") throw new Error("injected claim fault");
      })).toThrow(/injected claim fault/u);
      expect(fixture.store.readMemoryV3Claim(item.input.claimId)).toBeNull();
      expect(fixture.store.readMemoryV3ClaimHead(item.input.claimId)).toBeNull();
      expect(fixture.store.readMemoryV3Events(item.input.workspaceId)).toHaveLength(0);
      vault.discardPrepared(item.prepared);
      expect(vault.inspect(item.prepared)).toEqual({ body: "MISSING", key: "MISSING" });
    } finally { fixture.close(); }
  });
});
