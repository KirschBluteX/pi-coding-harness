import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  assertPatchSet, assertTaskPacket, makeExecutionSubjectRefV2, packetContentSha256,
  sealHarnessRecord, type ManagedRunRecord, type PatchSetRecord, type TaskPacketRecord,
} from "../../src/harness/domain.js";

describe("Pi Coding Harness domain", () => {
  it("seals immutable records and rejects mutation", () => {
    const record = sealHarnessRecord<ManagedRunRecord, "record_sha256">("PCH-MANAGED-RUN-V1", {
      schema_version: 1, run_id: "RUN-TEST-001", goal_id: "GOAL-TEST-001", workspace_id: "WS-TEST-001",
      created_by_host_hmac: sha256Hex("host"), initial_config_sha256: sha256Hex("config"), created_at_ms: 1,
    }, "record_sha256");
    expect(record.record_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds TaskPacket identity to content but not its secret capability proof", () => {
    const content = {
      schema_version: 1 as const, packet_id: "PACKET-TEST-001", run_id: "RUN-TEST-001", shard_id: "SHARD-TEST-001", attempt: 1,
      subject_binding_sha256: sha256Hex("subject"), task: "Inspect the bounded module", goal_contract_sha256: sha256Hex("contract"),
      route_sha256: sha256Hex("route"), work_cell_sha256: sha256Hex("cell"), evidence_refs: [], shared_memory: null, failure_signatures: [], expires_at_ms: 10,
    };
    const packet: TaskPacketRecord = { ...content, packet_sha256: packetContentSha256(content), capability_hmac: sha256Hex("capability") };
    expect(() => assertTaskPacket(packet)).not.toThrow();
    const sharedContent = {
      ...content,
      evidence_refs: [sha256Hex("binding")],
      shared_memory: {
        schema_version: 1 as const, audience: "VERIFIED_SHARED" as const,
        content: "[PCH-MEMORY-V3 test]\nverified shared context",
        manifest_sha256: sha256Hex("manifest"), binding_sha256s: [sha256Hex("binding")],
      },
    };
    expect(() => assertTaskPacket({
      ...sharedContent, packet_sha256: packetContentSha256(sharedContent), capability_hmac: sha256Hex("capability"),
    })).not.toThrow();
    expect(() => assertTaskPacket({ ...packet, task: "substituted" })).toThrow("canonical hash mismatch");
  });

  it("enforces operation-specific PatchSet preimage and postimage contracts", () => {
    const valid = sealHarnessRecord<PatchSetRecord, "patch_sha256">("PCH-PATCH-SET-V1", {
      schema_version: 1, patch_set_id: "PATCH-TEST-001", run_id: "RUN-TEST-001", shard_id: "SHARD-TEST-001",
      worker_run_id: "WORKER-TEST-001", baseline_sha256: sha256Hex("baseline"),
      entries: [{ operation: "CREATE", path: "src/new.ts", before_sha256: null, after_sha256: sha256Hex("after"), content_locator: `pch-cas://sha256/${sha256Hex("after")}`, byte_length: 5 }],
      created_at_ms: 1,
    }, "patch_sha256");
    expect(() => assertPatchSet(valid)).not.toThrow();
    expect(() => assertPatchSet({ ...valid, entries: [{ ...valid.entries[0], path: "../escape" }] })).toThrow("canonical relative path");
  });

  it("creates a hash-bound worker execution subject", () => {
    const subject = makeExecutionSubjectRefV2({
      kind: "WORKER_RUN", run_id: "RUN-TEST-001", goal_id: "GOAL-TEST-001", work_cell_id: "CELL-TEST-001",
      shard_id: "SHARD-TEST-001", worker_run_id: "WORKER-TEST-001", role: "EXPLORER", topology_revision: 1,
      attempt: 1, goal_contract_sha256: sha256Hex("contract"), route_sha256: sha256Hex("route"), authorization_sha256: null,
    });
    expect(subject.binding_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
