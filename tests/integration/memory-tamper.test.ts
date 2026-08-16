import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityIntegrityError } from "../../src/foundation/errors.js";
import { createPhase6Authority, type Phase6Authority } from "../helpers/phase6.js";

let authority: Phase6Authority | undefined;
afterEach(() => { authority?.close(); authority = undefined; });

function mutate(sql: string, ...values: readonly (string | number | null)[]): void {
  if (!authority) throw new Error("missing authority fixture");
  const db = new DatabaseSync(authority.databasePath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function execute(sql: string): void {
  if (!authority) throw new Error("missing authority fixture");
  const db = new DatabaseSync(authority.databasePath);
  try { db.exec(`PRAGMA busy_timeout=5000; ${sql}`); } finally { db.close(); }
}

function addPolicy(): string {
  authority = createPhase6Authority("FTS5");
  const added = authority.memory.addUserPolicy({ statement: "Preserve verified Memory authority.", scope: "WORKSPACE", tags: ["authority"] }, authority.context(3));
  if (!added.record) throw new Error(added.reason);
  return added.record.claimId;
}

describe("Memory v2 tamper detection", () => {
  it("rejects a current-head hash substitution", () => {
    const claimId = addPolicy();
    mutate("UPDATE memory_claim_heads SET claim_sha256=? WHERE claim_id=?", "f".repeat(64), claimId);
    expect(() => authority?.store.readMemoryClaim(claimId)).toThrow(AuthorityIntegrityError);
  });

  it("rejects modified immutable claim bytes even if a database attacker removes the trigger", () => {
    const claimId = addPolicy();
    execute("DROP TRIGGER no_update_memory_claim_versions");
    mutate("UPDATE memory_claim_versions SET content_text='tampered' WHERE claim_id=?", claimId);
    expect(() => authority?.store.readMemoryClaim(claimId)).toThrow(AuthorityIntegrityError);
  });

  it("invalidates a warm verified-candidate cache after an external tamper commit", () => {
    const claimId = addPolicy();
    const query = {
      workspaceId: "WS-TEST-001", goalId: authority?.goalId ?? null,
      workspaceRoot: authority?.directory ?? ".", text: "authority", tags: ["authority"],
      nowMs: authority?.clock.now() ?? 0,
    };
    expect(authority?.memory.retrieve(query).selected.map((entry) => entry.claimId)).toContain(claimId);
    execute("DROP TRIGGER no_update_memory_claim_versions");
    mutate("UPDATE memory_claim_versions SET content_text='tampered after warm read' WHERE claim_id=?", claimId);
    expect(() => authority?.memory.retrieve(query)).toThrow(AuthorityIntegrityError);
  });

  it("rejects modified claim event linkage", () => {
    const claimId = addPolicy();
    execute("DROP TRIGGER no_update_events");
    mutate("UPDATE events SET payload_json='{}' WHERE event_type='MEMORY_CLAIMED' AND goal_id=?", authority?.goalId ?? "");
    expect(() => authority?.store.readMemoryClaim(claimId)).toThrow(AuthorityIntegrityError);
  });

  it("rejects modified claim receipt linkage", () => {
    const claimId = addPolicy();
    execute("DROP TRIGGER no_update_receipts");
    mutate("UPDATE receipts SET output_sha256=? WHERE receipt_type='MEMORY_CLAIM' AND subject_id=?", "e".repeat(64), claimId);
    expect(() => authority?.store.readMemoryClaim(claimId)).toThrow(AuthorityIntegrityError);
  });

  it("rejects action-head and immutable action substitutions", () => {
    const claimId = addPolicy();
    expect(authority?.memory.endorse(claimId, authority.context(4)).accepted).toBe(true);
    mutate("UPDATE memory_action_heads SET last_event_sequence=last_event_sequence+1 WHERE claim_id=?", claimId);
    expect(() => authority?.store.readMemoryActionHead(claimId, "ENDORSEMENT")).toThrow(AuthorityIntegrityError);

    authority?.close();
    authority = createPhase6Authority("FTS5");
    const second = authority.memory.addUserPolicy({ statement: "Keep action provenance.", scope: "WORKSPACE" }, authority.context(3));
    const secondId = second.record?.claimId ?? "";
    expect(authority.memory.endorse(secondId, authority.context(4)).accepted).toBe(true);
    execute("DROP TRIGGER no_update_memory_claim_actions");
    mutate("UPDATE memory_claim_actions SET reason='tampered' WHERE claim_id=?", secondId);
    expect(() => authority?.store.readMemoryActionHead(secondId, "ENDORSEMENT")).toThrow(AuthorityIntegrityError);
  });

  it("rejects tampered index work instead of indexing a substituted operation", () => {
    addPolicy();
    execute("DROP TRIGGER no_update_memory_index_v2_outbox");
    mutate("UPDATE memory_index_v2_outbox SET operation='DELETE'");
    expect(() => authority?.memory.drainIndex()).toThrow(AuthorityIntegrityError);
  });

  it("rejects a forged workspace watermark", () => {
    addPolicy();
    expect(authority?.memory.drainIndex()).toMatchObject({ processed: 1, remaining: 0 });
    mutate("UPDATE memory_workspace_watermarks SET indexed_event_sequence=indexed_event_sequence+1000");
    expect(() => authority?.memory.drainIndex()).toThrow(AuthorityIntegrityError);
  });

  it("fails closed when a Task Flow evidence source is tampered after attestation", () => {
    authority = createPhase6Authority("TAG_PATH");
    const receiptId = authority.receiptId;
    const added = authority.memory.addReceiptEvidence({ receiptId, description: "stable receipt", scope: "WORKSPACE", tags: ["receipt"] }, authority.context(3));
    expect(added.accepted).toBe(true);
    expect(authority.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "receipt", tags: ["receipt"], nowMs: authority.clock.now(),
    }).selected.map((entry) => entry.claimId)).toContain(added.record?.claimId);
    execute("DROP TRIGGER no_update_oracle_pass_receipts_v2");
    mutate("UPDATE oracle_pass_receipts_v2 SET observation_root_sha256=? WHERE pass_receipt_id=?", "f".repeat(64), receiptId);
    expect(() => authority?.memory.retrieve({
      workspaceId: "WS-TEST-001", goalId: authority.goalId, workspaceRoot: authority.directory,
      text: "receipt", tags: ["receipt"], nowMs: authority.clock.now(),
    })).toThrow(AuthorityIntegrityError);
  });
});
