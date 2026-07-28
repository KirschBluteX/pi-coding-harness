import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, parseCanonicalJson } from "../../src/authority/canonical-json.js";
import {
  defaultMemoryCaptureV31Limits, type MemoryCaptureV31Limits,
} from "../../src/authority/repositories/memory-capture-v31.js";
import { classifyMemoryCapture, type MemoryCaptureDecision } from "../../src/memory/capture.js";
import { MemoryVault } from "../../src/memory/vault.js";
import { MemoryV3Engine } from "../../src/memory/v3-engine.js";
import { idFromSha256 } from "../../src/foundation/ids.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

const authorities: Phase6Authority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function setup(): { readonly authority: Phase6Authority; readonly vault: MemoryVault; readonly key: Buffer } {
  const authority = createPhase6Authority("TAG_PATH");
  authorities.push(authority);
  const key = Buffer.alloc(32, 7);
  return { authority, vault: new MemoryVault(authority.directory, key, 1_048_576), key };
}

function decision(
  authority: Phase6Authority,
  text: string,
  session = "a".repeat(64),
): MemoryCaptureDecision {
  return classifyMemoryCapture({
    workspaceId: "WS-TEST-001", goalId: authority.goalId, text,
    sourceKind: "USER_INPUT", sourceActor: "USER", decisionActor: "RUNTIME",
    sourceLocator: `pi-input://${session.slice(0, 8)}/${sha256Hex(text)}`,
    sourceSessionHmac: session, observedAtMs: authority.clock.now(), intentOwnership: "NONE",
  });
}

function prepareObservation(
  vault: MemoryVault,
  value: MemoryCaptureDecision,
  intentId: string,
) {
  const observationId = idFromSha256("MOBS", sha256Hex(intentId));
  const authorityMetadata = parseCanonicalJson(canonicalJson({
    domain: "PCH-MEMORY-V3.1-OBSERVATION-METADATA", intentId,
    candidateSha256: value.candidateSha256, conceptSha256: value.conceptSha256,
  }));
  const body = parseCanonicalJson(canonicalJson({
    schema_version: 1, record_type: "MEMORY_V31_OBSERVATION", intent_id: intentId,
    normalized_text: value.normalizedText, policy: value.policy,
  }));
  return vault.prepare({ workspaceId: value.workspaceId, claimId: observationId, version: 1, authorityMetadata, body });
}

function commitObservation(
  authority: Phase6Authority,
  vault: MemoryVault,
  value: MemoryCaptureDecision,
  key: string,
  limits: MemoryCaptureV31Limits = defaultMemoryCaptureV31Limits,
) {
  const begun = authority.store.beginMemoryV31Capture(value, key, limits);
  const prepared = prepareObservation(vault, value, begun.intent.intentId);
  const preparedInput = {
    observationId: prepared.claimId, workspaceId: prepared.workspaceId,
    authorityMetadataSha256: prepared.authorityMetadataSha256, bodySha256: prepared.bodySha256,
    vaultRefSha256: prepared.vaultRefSha256, keyRefSha256: prepared.keyRefSha256,
    ciphertextSha256: prepared.ciphertextSha256, wrappedKeySha256: prepared.wrappedKeySha256,
  };
  authority.store.markMemoryV31CaptureVaultPrepared(begun.intent.intentId, preparedInput);
  const committed = authority.store.commitMemoryV31Observation(begun.intent.intentId, preparedInput, limits);
  if (committed.receipt.reasonCode === "REPLAY_REUSED" || committed.receipt.result === "QUOTA_REJECTED") {
    vault.discardPrepared(prepared);
  }
  return { begun, prepared, committed };
}

describe("Memory 3.1 capture authority", () => {
  it("stores weak signals as encrypted observations and reuses exact replay evidence", () => {
    const { authority, vault } = setup();
    const first = decision(authority, "我通常偏好先看架构图");
    expect(first.route).toBe("PROPOSE_ONLY");
    const stored = commitObservation(authority, vault, first, "capture-1");
    expect(stored.committed).toMatchObject({
      reused: false, receipt: { result: "OBSERVED", reasonCode: "OBSERVATION_RECORDED" },
      cluster: { activeObservationCount: 1, independentSessionCount: 1, independentDayCount: 1 },
    });

    const replay = decision(authority, "我通常偏好先看架构图");
    const reused = commitObservation(authority, vault, replay, "capture-replay");
    expect(reused.committed).toMatchObject({
      receipt: { result: "OBSERVED", reasonCode: "REPLAY_REUSED",
        observationId: stored.committed.observation?.observationId },
      cluster: { activeObservationCount: 1 },
    });
    expect(authority.store.readMemoryV31VaultReferences("WS-TEST-001").vaultRefSha256.size).toBe(1);
  });

  it("requires three observations across at least two independent session or day windows", () => {
    const { authority, vault } = setup();
    const values = [
      ["我偏好使用 tabs", "a".repeat(64)],
      ["我的长期偏好是使用 tabs", "b".repeat(64)],
      ["我通常偏好使用 tabs", "a".repeat(64)],
    ] as const;
    for (let index = 0; index < values.length; index += 1) {
      if (index === 2) authority.clock.advance(86_400_000);
      const [text, session] = values[index]!;
      commitObservation(authority, vault, decision(authority, text, session), `capture-${index}`);
    }
    const eligible = authority.store.readMemoryV31EligibleClusters("WS-TEST-001");
    expect(eligible).toHaveLength(1);
    expect(eligible[0]).toMatchObject({
      activeObservationCount: 3, independentSessionCount: 2, independentDayCount: 2, state: "OPEN",
    });
  });

  it("bounds observations with quota and retires expired encrypted evidence", () => {
    const { authority, vault } = setup();
    const limits = { ...defaultMemoryCaptureV31Limits, maxActiveObservations: 1, observationTtlMs: 1_000 };
    const first = commitObservation(authority, vault, decision(authority, "我偏好输出简洁"), "capture-1", limits);
    const second = commitObservation(authority, vault, decision(authority, "我偏好使用 tabs"), "capture-2", limits);
    expect(first.committed.receipt.result).toBe("OBSERVED");
    expect(second.committed.receipt).toMatchObject({ result: "QUOTA_REJECTED", reasonCode: "CAPTURE_QUOTA_REACHED" });
    authority.clock.advance(1_001);
    const retired = authority.store.retireExpiredMemoryV31Observations("WS-TEST-001");
    expect(retired.map((entry) => entry.observationId)).toEqual([first.committed.observation?.observationId]);
    expect(authority.store.readMemoryV31VaultReferences("WS-TEST-001").vaultRefSha256.size).toBe(0);
  });

  it("exposes and aborts a prepared intent after a crash window", () => {
    const { authority } = setup();
    const value = decision(authority, "我通常偏好先看架构图");
    const begun = authority.store.beginMemoryV31Capture(value, "crash-before-vault");
    expect(authority.store.readPendingMemoryV31CaptureIntents("WS-TEST-001")).toEqual([begun.intent]);
    expect(authority.store.abortMemoryV31Capture(begun.intent.intentId, "BODY_UNAVAILABLE_AFTER_RECOVERY"))
      .toMatchObject({ result: "ABORTED", reasonCode: "BODY_UNAVAILABLE_AFTER_RECOVERY" });
    expect(authority.store.readPendingMemoryV31CaptureIntents("WS-TEST-001")).toEqual([]);
  });

  it("reconciles a crash after Vault preparation without changing the binding", () => {
    const { authority, vault, key } = setup();
    const value = decision(authority, "我通常偏好先看架构图");
    const begun = authority.store.beginMemoryV31Capture(value, "crash-after-vault");
    const prepared = prepareObservation(vault, value, begun.intent.intentId);
    const preparedInput = {
      observationId: prepared.claimId, workspaceId: prepared.workspaceId,
      authorityMetadataSha256: prepared.authorityMetadataSha256, bodySha256: prepared.bodySha256,
      vaultRefSha256: prepared.vaultRefSha256, keyRefSha256: prepared.keyRefSha256,
      ciphertextSha256: prepared.ciphertextSha256, wrappedKeySha256: prepared.wrappedKeySha256,
    };
    authority.store.markMemoryV31CaptureVaultPrepared(begun.intent.intentId, preparedInput);
    expect(() => authority.store.markMemoryV31CaptureVaultPrepared(begun.intent.intentId, {
      ...preparedInput, bodySha256: "f".repeat(64),
    })).toThrow(/binding changed/u);

    const recovered = new MemoryV3Engine(
      authority.store, vault, key, authority.memoryConfig.maxPayloadBytes, () => authority.clock.now(),
    );
    expect(recovered.reconcile("WS-TEST-001")).toMatchObject({
      completedCaptureIntentIds: [begun.intent.intentId], abortedCaptureIntentIds: [],
    });
    expect(authority.store.readMemoryV31CaptureReceipt(begun.intent.intentId)).toMatchObject({
      result: "OBSERVED", observationId: prepared.claimId,
    });
  });

  it("retires expired evidence before recovery can materialize a proposal", () => {
    const { authority, vault, key } = setup();
    const values = [
      ["我偏好使用 tabs", "a".repeat(64)],
      ["我的长期偏好是使用 tabs", "b".repeat(64)],
      ["我通常偏好使用 tabs", "c".repeat(64)],
    ] as const;
    for (let index = 0; index < values.length; index += 1) {
      commitObservation(authority, vault, decision(authority, values[index]![0], values[index]![1]), `expiry-${index}`);
    }
    authority.clock.advance(8 * 86_400_000);
    const recovered = new MemoryV3Engine(
      authority.store, vault, key, authority.memoryConfig.maxPayloadBytes, () => authority.clock.now(),
    );
    expect(recovered.reconcile("WS-TEST-001").retiredObservationIds).toHaveLength(3);
    expect(authority.store.readMemoryV31ActiveProposals("WS-TEST-001", 10)).toHaveLength(0);
  });
});
