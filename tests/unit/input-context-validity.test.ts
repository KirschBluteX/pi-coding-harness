import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { makeExecutionSubjectRef } from "../../src/task-flow/domain.js";
import { inputContextHashDomains, sealInputContextRecord } from "../../src/input-context/canonical.js";
import { describeToolCapture } from "../../src/input-context/capture-adapters.js";
import type { ProjectKnowledgeClaimRecord, ReadEvidenceReceiptRecord } from "../../src/input-context/domain.js";
import { deriveUncertaintyView, evaluateEvidence } from "../../src/input-context/validity.js";

const subject = makeExecutionSubjectRef({
  kind: "NONE", goalId: null, subjectId: null, routeRevision: null,
  goalContractSha256: null, executionAuthorizationSha256: null,
});
const receipt: ReadEvidenceReceiptRecord = sealInputContextRecord(inputContextHashDomains.readEvidenceReceipt, "receipt_sha256", {
  schema_version: 1 as const, receipt_id: "READ-VALIDITY-001", workspace_id: "WS-TEST-001", subject,
  source_kind: "FILE_RANGE" as const, capture_kind: "FULL_FILE" as const, evidence_sha256: sha256Hex("bytes"),
  artifact_ref_hmac: sha256Hex("artifact"), dependency_signature_sha256: sha256Hex("dependency"),
  source_scope_hmac: sha256Hex("scope"), source_version_handle_hmac: sha256Hex("version"),
  query_completeness: "NOT_APPLICABLE" as const, content_freshness: "HASH_CURRENT" as const,
  scope_authorization: "AUTHORIZED" as const, semantic_applicability: "CURRENT" as const,
  representation_fidelity: "EXACT_RAW" as const, classification: "INTERNAL" as const,
  adapter_version: "test-v1", observed_at_ms: 1,
});

describe("Input Context evidence validity", () => {
  it("requires all four axes and applies immutable transitions in order", () => {
    expect(evaluateEvidence(receipt)).toMatchObject({ eligible: true, disposition: "CURRENT_EXACT" });
    const transition = sealInputContextRecord(inputContextHashDomains.evidenceValidityTransition, "transition_sha256", {
      transition_id: "INVALID-001", receipt_id: receipt.receipt_id, axis: "CONTENT_FRESHNESS" as const,
      value: "STALE" as const, reason_code: "SOURCE_CHANGED", evidence_sha256: sha256Hex("changed"), created_at_ms: 2,
    });
    expect(evaluateEvidence(receipt, [transition])).toMatchObject({
      eligible: false, disposition: "REREAD_REQUIRED", reasonCode: "CONTENT_STALE",
    });
  });

  it("never represents truncated or generic tool output as exact current source", () => {
    expect(describeToolCapture("read", { path: "a.ts" }, "output truncated", false))
      .toMatchObject({ representationFidelity: "OPAQUE", reusableCurrentSource: false });
    expect(describeToolCapture("unknown_tool", {}, "same text", false))
      .toMatchObject({ captureKind: "TOOL_OUTPUT", representationFidelity: "OPAQUE", reusableCurrentSource: false });
  });

  it("derives missing and conflicting project knowledge without a persisted uncertainty record", () => {
    const base = {
      schema_version: 1 as const, manifest_id: "MANIFEST-001", source_id: "SOURCE-001", subject,
      semantic_key: "build.command", source_range_sha256: sha256Hex("range"), evidence_sha256: sha256Hex("evidence"),
      trust: "VERIFIED_EVIDENCE" as const, content_freshness: "HASH_CURRENT" as const,
      scope_authorization: "AUTHORIZED" as const, semantic_applicability: "CURRENT" as const,
      representation_fidelity: "EXACT_RAW" as const, authority_status: "EVIDENCE_ONLY" as const,
      frozen_goal_contract_sha256: null, created_at_ms: 1,
    };
    const claims: ProjectKnowledgeClaimRecord[] = ["one", "two"].map((statement, index) =>
      sealInputContextRecord(inputContextHashDomains.projectKnowledgeClaim, "record_sha256", {
        ...base, claim_id: `CLAIM-00${index + 1}`, statement_sha256: sha256Hex(statement),
      }));
    expect(deriveUncertaintyView(["test.command"], claims)).toEqual({
      complete: false,
      items: [
        { semanticKey: "build.command", kind: "CONFLICT", claimIds: ["CLAIM-001", "CLAIM-002"] },
        { semanticKey: "test.command", kind: "MISSING", claimIds: [] },
      ],
    });
  });
});
