import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { makeExecutionSubjectRef } from "../../src/task-flow/domain.js";
import {
  assertContextDemand,
  assertContextEnvelope,
  assertProjectKnowledgeClaim,
  assertProjectSourceManifest,
  type ContextDemandRecord,
  type ContextEnvelopeRecord,
  type ProjectKnowledgeClaimRecord,
  type ProjectSourceManifestRecord,
} from "../../src/input-context/domain.js";
import { inputContextHashDomains, sealInputContextRecord } from "../../src/input-context/canonical.js";

const none = makeExecutionSubjectRef({
  kind: "NONE", goalId: null, subjectId: null, routeRevision: null,
  goalContractSha256: null, executionAuthorizationSha256: null,
});
const goal = makeExecutionSubjectRef({
  kind: "GOAL", goalId: "GOAL-IC-001", subjectId: "GOAL-IC-001", routeRevision: 1,
  goalContractSha256: sha256Hex("contract"), executionAuthorizationSha256: null,
});

function demand(subject = goal, profile: ContextDemandRecord["profile"] = "TARGETED_EVIDENCE"): ContextDemandRecord {
  return sealInputContextRecord(inputContextHashDomains.contextDemand, "record_sha256", {
    schema_version: 1 as const, demand_id: "DEMAND-IC-001", subject, profile,
    next_action_sha256: sha256Hex("next"), obligations: [],
    source_closure_root_sha256: sha256Hex("sources"), acceptance_closure_root_sha256: sha256Hex("acceptance"),
    context_pressure: "LOW" as const, runtime_fingerprint_sha256: sha256Hex("runtime"),
  });
}

function envelope(fit: ContextEnvelopeRecord["fit_disposition"] = "FIT"): ContextEnvelopeRecord {
  return sealInputContextRecord(inputContextHashDomains.contextEnvelope, "record_sha256", {
    schema_version: 1 as const, envelope_id: "ENVELOPE-IC-001", subject: goal,
    profile: "TARGETED_EVIDENCE" as const, prompt_generation_id: null,
    retained_root_sha256: sha256Hex("retained"), source_closure_root_sha256: sha256Hex("sources"),
    acceptance_closure_root_sha256: sha256Hex("acceptance"), mandatory_coverage_root_sha256: sha256Hex("coverage"),
    context_demand_root_sha256: demand().record_sha256, items: [], estimated_projected_tokens: 0,
    fit_disposition: fit,
  });
}

describe("Input Context domain contracts", () => {
  it("reuses Task Flow ExecutionSubjectRef and enforces PASS_THROUGH semantics", () => {
    expect(() => assertContextDemand(demand())).not.toThrow();
    const pass = demand(none, "PASS_THROUGH");
    expect(() => assertContextDemand(pass)).not.toThrow();
    expect(() => assertContextDemand(sealInputContextRecord(inputContextHashDomains.contextDemand, "record_sha256", {
      ...pass, profile: "TARGETED_EVIDENCE" as const,
    }))).toThrow("requires an execution subject");
    expect(() => assertContextDemand({ ...demand(), goal_id: "GOAL-LEGACY" })).toThrow("frozen contract");
  });

  it("stores compiler-owned fitDisposition in the envelope", () => {
    for (const fit of ["FIT", "FIT_WITH_ON_DEMAND", "BASELINE_FALLBACK", "RECOVERY_REQUIRED"] as const) {
      expect(() => assertContextEnvelope(envelope(fit))).not.toThrow();
    }
    expect(() => assertContextEnvelope({ ...envelope(), fit_disposition: "SECOND_GATE" })).toThrow("outside the frozen enum");
  });

  it("keeps project knowledge as exact-source evidence unless the GoalContract hash matches", () => {
    const manifest: ProjectSourceManifestRecord = sealInputContextRecord(
      inputContextHashDomains.projectSourceManifest, "record_sha256", {
        schema_version: 1 as const, manifest_id: "MANIFEST-IC-001", workspace_id: "WS-TEST-001", subject: goal,
        entries: [{
          source_id: "SOURCE-IC-001", source_kind: "PROJECT_GUIDE" as const,
          workspace_path_hmac: sha256Hex("AGENTS.md"), content_sha256: sha256Hex("bytes"),
          source_version_handle_hmac: sha256Hex("version"), trust: "VERIFIED_EVIDENCE" as const,
          content_freshness: "HASH_CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
          classification: "INTERNAL" as const,
        }],
        created_at_ms: 1,
      },
    );
    expect(() => assertProjectSourceManifest(manifest)).not.toThrow();
    const evidenceOnly: ProjectKnowledgeClaimRecord = sealInputContextRecord(
      inputContextHashDomains.projectKnowledgeClaim, "record_sha256", {
        schema_version: 1 as const, claim_id: "CLAIM-IC-001", manifest_id: manifest.manifest_id,
        source_id: "SOURCE-IC-001", subject: goal, semantic_key: "testing.required",
        statement_sha256: sha256Hex("claim"), source_range_sha256: sha256Hex("range"),
        evidence_sha256: sha256Hex("evidence"), trust: "VERIFIED_EVIDENCE" as const,
        content_freshness: "HASH_CURRENT" as const, scope_authorization: "AUTHORIZED" as const,
        semantic_applicability: "CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
        authority_status: "EVIDENCE_ONLY" as const, frozen_goal_contract_sha256: null, created_at_ms: 2,
      },
    );
    expect(() => assertProjectKnowledgeClaim(evidenceOnly)).not.toThrow();
    expect(() => assertProjectKnowledgeClaim(sealInputContextRecord(
      inputContextHashDomains.projectKnowledgeClaim, "record_sha256", {
        ...evidenceOnly, authority_status: "FROZEN_IN_GOAL_CONTRACT" as const,
        frozen_goal_contract_sha256: sha256Hex("wrong-contract"),
      },
    ))).toThrow("does not match its subject");
  });
});
