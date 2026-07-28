import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyMemoryCapture } from "../../src/memory/capture.js";
import { MemoryV3Engine } from "../../src/memory/v3-engine.js";
import { MemoryVault } from "../../src/memory/vault.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

function weakDecision(
  fixture: Phase6Authority,
  key: Uint8Array,
  text: string,
  session: string,
  authorityContextSha256: string | null = null,
) {
  return classifyMemoryCapture({
    workspaceId: "WS-TEST-001", goalId: null, text,
    sourceKind: "USER_INPUT", sourceActor: "USER", decisionActor: "RUNTIME",
    sourceLocator: `pi-input://${session.slice(0, 8)}/${fixture.clock.now()}`,
    sourceSessionHmac: session, observedAtMs: fixture.clock.now(), intentOwnership: "NONE",
    authorityContextSha256, identityHmacKey: key,
  });
}

function proposalFromSignals(
  fixture: Phase6Authority,
  engine: MemoryV3Engine,
  key: Uint8Array,
  authorityContextSha256: string | null = null,
  semanticValue = "tabs",
) {
  const signals = [
    [`我偏好使用 ${semanticValue}`, "a".repeat(64)],
    [`我的长期偏好是使用 ${semanticValue}`, "b".repeat(64)],
    [`我通常偏好使用 ${semanticValue}`, "a".repeat(64)],
  ] as const;
  let result: ReturnType<MemoryV3Engine["storeCapture"]> | null = null;
  for (let index = 0; index < signals.length; index += 1) {
    if (index === 2) fixture.clock.advance(86_400_000);
    result = engine.storeCapture(
      weakDecision(fixture, key, signals[index]![0], signals[index]![1], authorityContextSha256),
      `capture:proposal-helper:${authorityContextSha256 ?? "none"}:${semanticValue}:${index}`,
    );
  }
  return result;
}

describe("Memory v3 engine", () => {
  it("uses the Vault-backed workspace authority for manual lifecycle commands", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const vault = new MemoryVault(fixture.directory, key);
      const engine = new MemoryV3Engine(fixture.store, vault, key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now());
      const before = fixture.store.readSnapshot(fixture.goalId).goalVersion;
      const added = engine.addUserPolicy({ statement: "Prefer concise final output.", scope: "WORKSPACE" }, fixture.context(before));
      expect(added).toMatchObject({ accepted: true, reason: "ADMITTED", record: { version: 1 } });
      expect(fixture.store.readSnapshot(fixture.goalId).goalVersion).toBe(before);
      const claimId = added.record?.claimId ?? "";
      const payload = engine.open(claimId, "WS-TEST-001", fixture.goalId)?.body.payload;
      expect(payload?.type).toBe("TYPED_POLICY");
      if (payload?.type !== "TYPED_POLICY") throw new Error("Policy payload fixture missing");
      expect(payload.operator).toBe("PREFER");
      expect(payload.semanticKey).toMatch(/^policy\./u);

      const corrected = engine.correct(claimId, "Prefer concise verified output.", fixture.context(before));
      expect(corrected).toMatchObject({ accepted: true, record: { version: 2 } });
      expect(engine.endorse(claimId, fixture.context(before))).toMatchObject({ accepted: true, reason: "ENDORSE" });
      expect(engine.forget(claimId, fixture.context(before))).toMatchObject({ accepted: true, reason: "FORGET" });
      expect(fixture.store.readMemoryV3ClaimHead(claimId)?.visibility).toBe("FORGOTTEN");
      expect(engine.restore(claimId, fixture.context(before))).toMatchObject({ accepted: true, reason: "RESTORE" });

      const purged = engine.purge(claimId, fixture.context(before));
      expect(purged).toMatchObject({ accepted: true, reason: "PURGED_LOCAL_KEY" });
      expect(purged.limitation).toMatch(/only current PCH-managed wrapped keys/u);
      expect(fixture.store.readMemoryV3ClaimHead(claimId)?.purgeState).toBe("PURGED_LOCAL_KEY");
      expect(engine.restore(claimId, fixture.context(before))).toMatchObject({ accepted: false });
      expect(fixture.store.readSnapshot(fixture.goalId).goalVersion).toBe(before);
    } finally { fixture.close(); }
  });

  it("stores explicit capture as active and requires independent evidence for a proposal", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const explicit = classifyMemoryCapture({
        workspaceId: "WS-TEST-001", goalId: null, text: "请记住：我偏好简洁输出",
        sourceKind: "USER_INPUT", sourceActor: "USER", decisionActor: "RUNTIME",
        sourceLocator: "pi-input://SESSION/1", intentOwnership: "NONE", identityHmacKey: key,
      });
      expect(engine.storeCapture(explicit, "capture:explicit")).toMatchObject({
        accepted: true, record: { status: "ACTIVE" }, additionalModelRequests: 0,
      });
      const signals = [
        ["我偏好使用 tabs", "a".repeat(64)],
        ["我的长期偏好是使用 tabs", "b".repeat(64)],
        ["我通常偏好使用 tabs", "a".repeat(64)],
      ] as const;
      let stored = null as ReturnType<MemoryV3Engine["storeCapture"]> | null;
      for (let index = 0; index < signals.length; index += 1) {
        if (index === 2) fixture.clock.advance(86_400_000);
        const [text, session] = signals[index]!;
        const proposed = classifyMemoryCapture({
          workspaceId: "WS-TEST-001", goalId: null, text,
          sourceKind: "USER_INPUT", sourceActor: "USER", decisionActor: "RUNTIME",
          sourceLocator: `pi-input://${index}`, sourceSessionHmac: session,
          observedAtMs: fixture.clock.now(), intentOwnership: "NONE", identityHmacKey: key,
        });
        stored = engine.storeCapture(proposed, `capture:proposal:${index}`);
        if (index < 2) expect(stored.record).toBeNull();
      }
      if (!stored) throw new Error("proposal result missing");
      expect(stored).toMatchObject({ accepted: true, record: { status: "PROPOSED" } });
      const claimId = stored.record?.claimId ?? "";
      expect(engine.proposed("WS-TEST-001", null, 10).map((entry) => entry.record.claimId)).toContain(claimId);
      const proposal = fixture.store.readMemoryV31ProposalForClaim(claimId);
      if (!proposal) throw new Error("proposal binding missing");
      const beforeCount = fixture.store.readActiveMemoryV31Observations("WS-TEST-001", proposal.conceptSha256).length;
      const repeated = engine.storeCapture(weakDecision(fixture, key, "我一直偏好使用 tabs", "c".repeat(64)), "capture:after-proposal");
      expect(repeated).toMatchObject({ accepted: true, reason: "EXISTING_PROPOSAL_CONCEPT", record: { claimId } });
      expect(fixture.store.readActiveMemoryV31Observations("WS-TEST-001", proposal.conceptSha256)).toHaveLength(beforeCount);
      expect(engine.approve(claimId, {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion), workspaceId: "WS-TEST-001",
      })).toMatchObject({ accepted: true, reason: "APPROVE" });
      expect(engine.proposed("WS-TEST-001", null, 10)).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("excludes Agent observations from the independent user evidence threshold", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      for (let index = 0; index < 3; index += 1) {
        const decision = classifyMemoryCapture({
          workspaceId: "WS-TEST-001", goalId: null, text: "偏好先运行本地测试",
          sourceKind: "AGENT_PROPOSAL", sourceActor: "AGENT", decisionActor: "RUNTIME",
          sourceLocator: `agent-proposal://${index}`, sourceSessionHmac: String(index + 1).repeat(64),
          observedAtMs: fixture.clock.now(), intentOwnership: "NONE", identityHmacKey: key,
        });
        expect(engine.storeCapture(decision, `agent-proposal:${index}`).record).toBeNull();
        fixture.clock.advance(86_400_000);
      }
      expect(engine.proposed("WS-TEST-001", null, 10)).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("proposes only after two independently recorded verified route failures", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const failureSignatureSha256 = "f".repeat(64);
      const route = (locator: string) => classifyMemoryCapture({
        workspaceId: "WS-TEST-001", goalId: fixture.goalId,
        text: "避免重复执行已失败的本地构建路线",
        sourceKind: "ROUTE_FAILURE", sourceActor: "RUNTIME", decisionActor: "RUNTIME",
        sourceLocator: locator, scope: "WORKSPACE", channel: "EXPERIENCE",
        authorityVerified: true, failureSignatureSha256, observedAtMs: fixture.clock.now(),
        intentOwnership: "ACTIVE_BUILD", identityHmacKey: key,
      });
      expect(engine.storeCapture(route("pch-route-decision://ROUTE-1"), "route-failure:1").record).toBeNull();
      const replay = engine.storeCapture(route("pch-route-decision://ROUTE-1"), "route-failure:replay");
      expect(replay.record).toBeNull();
      const proposed = engine.storeCapture(route("pch-route-decision://ROUTE-2"), "route-failure:2");
      expect(proposed.record).toMatchObject({ status: "PROPOSED", channel: "EXPERIENCE" });
    } finally { fixture.close(); }
  });

  it("revalidates live evidence and authority context before approval", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const authorityContext = "a".repeat(64);
      const proposed = proposalFromSignals(fixture, engine, key, authorityContext);
      const claimId = proposed?.record?.claimId ?? "";
      expect(engine.approve(claimId, {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion),
        workspaceId: "WS-TEST-001", authorityContextSha256: "b".repeat(64),
      })).toMatchObject({ accepted: false, reason: "AUTHORITY_CONTEXT_CHANGED_REVIEW_REQUIRED" });
      fixture.clock.advance(8 * 86_400_000);
      expect(engine.approve(claimId, {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion),
        workspaceId: "WS-TEST-001", authorityContextSha256: authorityContext,
      })).toMatchObject({ accepted: false, reason: "PROPOSAL_EVIDENCE_STALE_OR_INSUFFICIENT" });
    } finally { fixture.close(); }
  });

  it("fails approval closed when the proposal Vault key is unavailable", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const vault = new MemoryVault(fixture.directory, key);
      const engine = new MemoryV3Engine(
        fixture.store, vault, key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const proposed = proposalFromSignals(fixture, engine, key);
      if (!proposed?.record) throw new Error("proposal fixture missing");
      expect(vault.destroyKey(proposed.record)).toBe("DESTROYED");
      expect(engine.approve(proposed.record.claimId, {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion),
        workspaceId: "WS-TEST-001",
      })).toMatchObject({ accepted: false, reason: "APPROVAL_VAULT_INTEGRITY_FAILED" });
    } finally { fixture.close(); }
  });

  it("expires a proposal at the exact fourteen-day boundary", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key,
        fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const proposed = proposalFromSignals(fixture, engine, key);
      const claimId = proposed?.record?.claimId ?? "";
      const proposal = fixture.store.readMemoryV31ProposalForClaim(claimId);
      if (!proposal) throw new Error("proposal binding missing");
      fixture.clock.advance(proposal.expiresAtMs - fixture.clock.now());
      expect(engine.approve(claimId, {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion),
        workspaceId: "WS-TEST-001",
      })).toMatchObject({ accepted: false, reason: "PROPOSAL_EXPIRED" });
      expect(fixture.store.readMemoryV31ProposalForClaim(claimId)).toBeNull();
    } finally { fixture.close(); }
  });

  it("rejects a stale second approval after the proposal becomes active", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key,
        fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const proposed = proposalFromSignals(fixture, engine, key);
      const claimId = proposed?.record?.claimId ?? "";
      const staleContext = {
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion),
        workspaceId: "WS-TEST-001",
      };
      expect(engine.approve(claimId, staleContext)).toMatchObject({ accepted: true, reason: "APPROVE" });
      expect(engine.approve(claimId, staleContext)).toMatchObject({ accepted: false, reason: "PROPOSAL_NOT_ACTIVE" });
    } finally { fixture.close(); }
  });

  it("requires user review when a proposal conflicts with an active policy", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const context = fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion);
      expect(engine.addUserPolicy({ statement: "不要使用 tabs", scope: "WORKSPACE" }, context).accepted).toBe(true);
      const proposed = proposalFromSignals(fixture, engine, key);
      expect(engine.approve(proposed?.record?.claimId ?? "", context))
        .toMatchObject({ accepted: false, reason: "ACTIVE_CONFLICT_REVIEW_REQUIRED" });
    } finally { fixture.close(); }
  });

  it("paginates and bulk-rejects proposals without allowing rejected concepts to reactivate", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const first = proposalFromSignals(fixture, engine, key, null, "tabs");
      const second = proposalFromSignals(fixture, engine, key, null, "spaces");
      expect(first?.record?.claimId).toBeTruthy();
      expect(second?.record?.claimId).toBeTruthy();
      const page = engine.proposalPage("WS-TEST-001", null, 1);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
      const rejectedClaimId = page.items[0]!.opened.record.claimId;
      const proposal = page.items[0]!.proposal;
      const rejectedPayload = page.items[0]!.opened.body.payload;
      if (rejectedPayload.type !== "TYPED_POLICY" || !rejectedPayload.value) throw new Error("proposal policy missing");
      const result = engine.rejectAllProposals({
        ...fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion), workspaceId: "WS-TEST-001",
      }, 1);
      expect(result).toMatchObject({ rejected: 1, failedClaimIds: [] });
      expect(fixture.store.readMemoryV3ClaimHead(rejectedClaimId)?.purgeState).toBe("PURGED_LOCAL_KEY");
      expect(fixture.store.readActiveMemoryV31Observations("WS-TEST-001", proposal.conceptSha256)).toHaveLength(0);
      expect(engine.proposalPage("WS-TEST-001", null, 64).items).toHaveLength(1);
      const ignored = engine.storeCapture(
        weakDecision(fixture, key, `我一直偏好${rejectedPayload.value}`, "d".repeat(64)), "capture:rejected-concept",
      );
      expect(ignored).toMatchObject({ accepted: true, reason: "CONCEPT_PREVIOUSLY_REJECTED", record: null });
      expect(fixture.store.readActiveMemoryV31Observations("WS-TEST-001", proposal.conceptSha256)).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("uses a bounded HMAC metadata frontier and abstains structured v3 conflicts", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const engine = new MemoryV3Engine(
        fixture.store, new MemoryVault(fixture.directory, key), key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now(),
      );
      const context = fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion);
      for (let index = 0; index < 20; index += 1) {
        expect(engine.addUserPolicy({ statement: `Prefer bounded policy ${index}.`, scope: "WORKSPACE" }, context).accepted).toBe(true);
      }
      const bounded = engine.retrieve({
        workspaceId: "WS-TEST-001", goalId: fixture.goalId, workspaceRoot: fixture.directory,
        text: "bounded policy 19", nowMs: fixture.clock.now(),
      }, fixture.memoryConfig);
      expect(bounded.metadataCandidateCount).toBeLessThanOrEqual(fixture.memoryConfig.maxPolicyResults);
      expect(bounded.decryptedCandidateCount).toBeLessThanOrEqual(fixture.memoryConfig.maxPolicyResults);

      const positive = engine.addUserPolicy({ statement: "Use tabs", scope: "WORKSPACE" }, context).record;
      const negative = engine.addUserPolicy({ statement: "Do not use tabs", scope: "WORKSPACE" }, context).record;
      if (!positive || !negative) throw new Error("structured conflict fixtures missing");
      const conflicted = engine.retrieve({
        workspaceId: "WS-TEST-001", goalId: fixture.goalId, workspaceRoot: fixture.directory,
        text: "tabs", nowMs: fixture.clock.now(),
      }, fixture.memoryConfig);
      expect(conflicted.conflicts).toEqual(expect.arrayContaining([positive.claimId, negative.claimId]));
      expect(conflicted.selections.map((entry) => entry.claimId)).not.toContain(positive.claimId);
      expect(conflicted.selections.map((entry) => entry.claimId)).not.toContain(negative.claimId);
      expect(conflicted.additionalModelRequests).toBe(0);
    } finally { fixture.close(); }
  });

  it("continues only authority-backed purge intents after a crash", () => {
    const fixture = createPhase6Authority("TAG_PATH");
    try {
      const key = randomBytes(32);
      const vault = new MemoryVault(fixture.directory, key);
      const engine = new MemoryV3Engine(fixture.store, vault, key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now());
      const context = fixture.context(fixture.store.readSnapshot(fixture.goalId).goalVersion);
      const claimId = engine.addUserPolicy({ statement: "Prefer local verification.", scope: "WORKSPACE" }, context).record?.claimId ?? "";
      engine.correct(claimId, "Prefer local deterministic verification.", context);
      const head = fixture.store.readMemoryV3ClaimHead(claimId);
      if (!head) throw new Error("head fixture missing");
      const intent = fixture.store.prepareMemoryV3PurgeIntent({
        workspaceId: "WS-TEST-001", claimId, targetVersion: head.version, requestedBy: "USER",
      }, "purge:crash-window");
      vault.destroyKey(intent.versions[0]!);

      const recovered = new MemoryV3Engine(fixture.store, vault, key, fixture.memoryConfig.maxPayloadBytes, () => fixture.clock.now());
      expect(recovered.reconcile("WS-TEST-001")).toMatchObject({
        completedPurgeIntentIds: [intent.intent.intentId], integrityFailureClaimIds: [],
      });
      expect(fixture.store.readMemoryV3ClaimHead(claimId)?.purgeState).toBe("PURGED_LOCAL_KEY");

      const unrelated = engine.addUserPolicy({ statement: "Prefer bounded changes.", scope: "GOAL" }, context).record;
      if (!unrelated) throw new Error("unrelated claim fixture missing");
      vault.destroyKey(unrelated);
      const integrity = recovered.reconcile("WS-TEST-001");
      expect(integrity.integrityFailureClaimIds).toContain(unrelated.claimId);
      expect(fixture.store.readMemoryV3ClaimHead(unrelated.claimId)?.purgeState).toBe("PRESENT");
    } finally { fixture.close(); }
  });
});
