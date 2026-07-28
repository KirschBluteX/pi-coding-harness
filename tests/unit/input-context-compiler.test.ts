import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { makeExecutionSubjectRef } from "../../src/task-flow/domain.js";
import { inputContextHashDomains, sealInputContextRecord } from "../../src/input-context/canonical.js";
import { ContextCompiler } from "../../src/input-context/context-compiler.js";
import type {
  ContextCandidateRecord, ContextDemandRecord, EvidenceObligationRecord,
} from "../../src/input-context/domain.js";

const none = makeExecutionSubjectRef({
  kind: "NONE", goalId: null, subjectId: null, routeRevision: null,
  goalContractSha256: null, executionAuthorizationSha256: null,
});
const goal = makeExecutionSubjectRef({
  kind: "GOAL", goalId: "GOAL-COMPILER-001", subjectId: "GOAL-COMPILER-001", routeRevision: null,
  goalContractSha256: sha256Hex("contract"), executionAuthorizationSha256: null,
});

function obligation(
  id: string,
  confidence: EvidenceObligationRecord["confidence"] = "PROVEN_REQUIRED",
): EvidenceObligationRecord {
  return {
    obligation_id: id, role: "NEXT_ACTION", confidence, source_refs: [],
    must_be_current: true, must_be_exact: true,
    authorization_scope_sha256: sha256Hex(`auth:${id}`), semantic_scope_sha256: sha256Hex(`semantic:${id}`),
  };
}

function demand(
  obligations: readonly EvidenceObligationRecord[],
  profile: ContextDemandRecord["profile"] = "TARGETED_EVIDENCE",
): ContextDemandRecord {
  return sealInputContextRecord(inputContextHashDomains.contextDemand, "record_sha256", {
    schema_version: 1 as const, demand_id: "DEMAND-COMPILER-001",
    subject: profile === "PASS_THROUGH" ? none : goal, profile, next_action_sha256: sha256Hex("next"),
    obligations, source_closure_root_sha256: sha256Hex("sources"),
    acceptance_closure_root_sha256: sha256Hex("acceptance"), context_pressure: "LOW" as const,
    runtime_fingerprint_sha256: sha256Hex("runtime"),
  });
}

function candidate(
  id: string,
  obligationIds: readonly string[],
  tokens: number,
  overrides: Partial<ContextCandidateRecord> = {},
): ContextCandidateRecord {
  return sealInputContextRecord(inputContextHashDomains.contextCandidate, "record_sha256", {
    schema_version: 1 as const, candidate_id: id, source_kind: "FILE_RANGE" as const,
    content_freshness: "HASH_CURRENT" as const, scope_authorization: "AUTHORIZED" as const,
    semantic_applicability: "CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
    trust: "VERIFIED_EVIDENCE" as const, obligation_ids: obligationIds,
    evidence_sha256: sha256Hex(`evidence:${id}`), dependency_signature_sha256: sha256Hex(`dependency:${id}`),
    artifact_locator: `pch-cas://sha256/${sha256Hex(`evidence:${id}`)}`,
    estimated_tokens: tokens, classification: "INTERNAL" as const,
    ...overrides,
  });
}

function compile(
  contextDemand: ContextDemandRecord,
  candidates: readonly ContextCandidateRecord[],
  evidenceTokens = 100,
) {
  return new ContextCompiler("compiler-key").compile({
    demand: contextDemand, candidates, retainedRootSha256: sha256Hex("retained"),
    retainedCandidates: [], promptGenerationId: null,
    budget: {
      contextWindowTokens: 10_000, currentInputTokens: 1_000, outputReserveTokens: 1_000,
      softEvidenceTokens: Math.min(50, evidenceTokens), hardEvidenceTokens: evidenceTokens,
    },
    unknownCandidateTokens: 32, nowMs: 10,
  });
}

describe("ContextCompiler", () => {
  it("uses a zero-content PASS_THROUGH fast path", () => {
    const result = compile(demand([], "PASS_THROUGH"), []);
    expect(result).toMatchObject({
      fitDisposition: "FIT",
      envelope: { profile: "PASS_THROUGH", estimated_projected_tokens: 0, items: [] },
      receipt: { mandatory_obligation_count: 0, mandatory_covered_count: 0, fallback: "NONE" },
    });
  });

  it("covers mandatory evidence inline and produces an identical envelope for identical inputs", () => {
    const required = obligation("OBLIGATION-001");
    const inputDemand = demand([required]);
    const inputCandidate = candidate("CANDIDATE-001", [required.obligation_id], 20);
    const first = compile(inputDemand, [inputCandidate]);
    const second = compile(inputDemand, [inputCandidate]);
    expect(first).toMatchObject({
      fitDisposition: "FIT", uncoveredMandatoryObligationIds: [],
      envelope: { estimated_projected_tokens: 20, items: [{ disposition: "MANDATORY_INLINE" }] },
    });
    expect(second.envelope).toEqual(first.envelope);
    expect(second.workingSet).toEqual(first.workingSet);
  });

  it("uses complete ON_DEMAND delivery instead of truncating a mandatory item", () => {
    const required = obligation("OBLIGATION-001");
    const result = compile(demand([required]), [candidate("CANDIDATE-001", [required.obligation_id], 200)], 20);
    expect(result).toMatchObject({
      fitDisposition: "FIT_WITH_ON_DEMAND", onDemandCandidateIds: ["CANDIDATE-001"],
      envelope: { estimated_projected_tokens: 0, items: [{ disposition: "ON_DEMAND", projected_tokens: 0 }] },
    });
  });

  it("keeps complete optional overflow available on demand instead of dropping its locator", () => {
    const result = compile(demand([]), [candidate("CANDIDATE-OPTIONAL", [], 200)], 20);
    expect(result).toMatchObject({
      fitDisposition: "FIT_WITH_ON_DEMAND", onDemandCandidateIds: ["CANDIDATE-OPTIONAL"],
      receipt: { omitted_optional_count: 1 },
      envelope: {
        estimated_projected_tokens: 0,
        items: [{ disposition: "ON_DEMAND", reason_code: "OPTIONAL_COMPLETE_ON_DEMAND", projected_tokens: 0 }],
      },
    });
  });

  it("reuses the immutable result for an unchanged consecutive compile closure", () => {
    const compiler = new ContextCompiler("compiler-key");
    const inputDemand = demand([]);
    const inputCandidate = candidate("CANDIDATE-CACHED", [], 20);
    const input = {
      demand: inputDemand, candidates: [inputCandidate], retainedRootSha256: sha256Hex("retained"),
      retainedCandidates: [], promptGenerationId: null,
      budget: {
        contextWindowTokens: 10_000, currentInputTokens: 1_000, outputReserveTokens: 1_000,
        softEvidenceTokens: 50, hardEvidenceTokens: 100,
      },
      unknownCandidateTokens: 32, nowMs: 10,
    } as const;
    const first = compiler.compile(input);
    const second = compiler.compile(input);
    expect(second).toBe(first);
    expect(second.receipt.compile_receipt_id).toBe(first.receipt.compile_receipt_id);
  });

  it("returns compiler-owned fallback when mandatory evidence is missing or stale", () => {
    const required = obligation("OBLIGATION-001");
    const missing = compile(demand([required]), []);
    expect(missing).toMatchObject({
      fitDisposition: "BASELINE_FALLBACK", uncoveredMandatoryObligationIds: ["OBLIGATION-001"],
      receipt: { fallback: "FRESH_READ" },
    });
    const stale = compile(demand([required]), [candidate("CANDIDATE-001", [required.obligation_id], 10, {
      content_freshness: "STALE",
    })]);
    expect(stale.envelope.items[0]).toMatchObject({ disposition: "REREAD_REQUIRED" });
    expect(stale.fitDisposition).toBe("BASELINE_FALLBACK");
    expect(compile(demand([required], "RECOVERY"), []).fitDisposition).toBe("RECOVERY_REQUIRED");
  });

  it("keeps unknown discovery debt visible and does not collapse role/trust identities", () => {
    const discovery = obligation("DISCOVERY-001", "UNKNOWN_DISCOVERY");
    expect(compile(demand([discovery]), [])).toMatchObject({
      fitDisposition: "FIT_WITH_ON_DEMAND", receipt: { discovery_debt_count: 1 },
    });
    const left = candidate("CANDIDATE-001", [], 5);
    const right = candidate("CANDIDATE-002", [], 5, {
      evidence_sha256: left.evidence_sha256,
      dependency_signature_sha256: left.dependency_signature_sha256,
      trust: "UNTRUSTED_CONTEXT",
    });
    expect(compile(demand([]), [left, right]).envelope.items.map((item) => item.disposition))
      .toEqual(["INLINE_EXACT", "INLINE_EXACT"]);
  });
});
