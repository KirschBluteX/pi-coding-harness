import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeDynamicMultiProposalReceiptV2 } from "../../src/harness-v2/dynamic-multi-proposal.js";

describe("Dynamic Multi proposal receipt", () => {
  it("binds normalized source to the exact admission closure", () => {
    const receipt = finalizeDynamicMultiProposalReceiptV2({
      goal_id: "GOAL-PROPOSAL",
      run_id: "RUN-PROPOSAL",
      work_cell_id: "CELL-PROPOSAL",
      plan_revision_id: "PLAN-PROPOSAL",
      plan_revision_sha256: sha256Hex("plan"),
      authorization_id: "AUTH-PROPOSAL",
      authorization_sha256: sha256Hex("authorization"),
      input_closure_sha256: sha256Hex("input"),
      baseline_sha256: sha256Hex("baseline"),
      baseline_content_root_sha256: sha256Hex("content"),
      environment_sha256: sha256Hex("environment"),
      runtime_fingerprint_sha256: sha256Hex("runtime"),
      config_sha256: sha256Hex("config"),
      graph_proposal_sha256: sha256Hex("graph"),
      source: [{ key: "A", task: "Inspect source" }, { key: "B", task: "Verify source" }],
      predecessor_authority_head_sha256: sha256Hex("head"),
      created_at_ms: 100,
    });
    expect(receipt.dynamic_multi_proposal_receipt_id).toMatch(/^MULTI_PROPOSAL-/u);
    expect(receipt.source).toHaveLength(2);
    expect(() => finalizeDynamicMultiProposalReceiptV2({
      ...receipt,
      graph_proposal_sha256: sha256Hex("substituted"),
    })).toThrow(/identity|integrity/u);
  });
});
