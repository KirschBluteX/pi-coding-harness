import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { assertAcceptanceBundleV2, finalizeAcceptanceV2 } from "../../src/acceptance-v2/finalize.js";
import { finalizeGoalContract } from "../../src/task-flow/finalize.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { idFromSha256 } from "../../src/foundation/ids.js";

function singleOutcomeBundle() {
  const source = "one exact outcome";
  const contract = finalizeGoalContract({
    goalId: "GOAL-ROOT-ID-V2", objective: source, intent: "BUILD", lane: "DIRECT_CELL",
    sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null, createdAtMs: 1,
    proposal: {
      user_outcomes: ["One exact outcome"], scope: ["src"], obligations: [{
        key: "exact-outcome", priority: "MUST", statement: "One exact outcome",
        oracle: { command: "npm test" },
      }], authorization_ceiling: "LOCAL_REVERSIBLE",
    },
  });
  return finalizeAcceptanceV2({
    goalId: contract.goal_id, contract, source,
    facets: [{
      key: "exact-outcome", kind: "OUTCOME", subject: { kind: "USER_OUTCOME", index: 0 },
      source_binding: "ENTIRE_INTAKE", obligation_keys: ["exact-outcome"],
    }],
    authority: {
      qualification_basis: "NATIVE_EXACT",
      predecessor_authority_head_sha256: sha256Hex("admitted-event"),
    },
  });
}

describe("Acceptance V2", () => {
  it("does not turn conjunctions into a contract-count authority gate", () => {
    expect(() => finalizeGoalContract({
      goalId: "GOAL-CONJUNCTION", objective: "Update runtime and types", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: sha256Hex("Update runtime and types"), version: 1, parentContractId: null, createdAtMs: 1,
      proposal: {
        user_outcomes: ["Runtime and types are updated"],
        scope: ["src"], non_goals: [], constraints: [], assumption_refs: [], decision_refs: [],
        obligations: [{
          key: "updated-result", priority: "MUST", statement: "Runtime and types are updated",
          oracle: { command: "npm test" },
        }],
        acceptance_policy: {}, authorization_ceiling: "LOCAL_REVERSIBLE",
      },
    })).not.toThrow();
  });

  it("derives exact UTF-8 spans and explicit obligation mappings from typed proposals", () => {
    const source = "build: 修复 parser 🚀，并保持 browser clients。";
    const facets = [
      {
        key: "browser-preservation", kind: "INVARIANT" as const,
        subject: { kind: "USER_OUTCOME" as const, index: 1 },
        source_quotes: [{ quote: "保持 browser clients", occurrence: 1 }],
        obligation_keys: ["browser-preserved"],
      },
      {
        key: "parser-result", kind: "OUTCOME" as const,
        subject: { kind: "USER_OUTCOME" as const, index: 0 },
        source_quotes: [{ quote: "修复 parser 🚀", occurrence: 1 }],
        obligation_keys: ["parser-fixed"],
      },
    ];
    const contract = finalizeGoalContract({
      goalId: "GOAL-ACCEPTANCE-V2", objective: source, intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null,
      createdAtMs: 1,
      proposal: {
        user_outcomes: ["Parser is fixed", "Browser clients are preserved"],
        scope: ["src"], non_goals: [], constraints: [], assumption_refs: [], decision_refs: [],
        obligations: [
          { key: "parser-fixed", priority: "MUST", statement: "Parser is fixed", oracle: { command: "npm test" } },
          { key: "browser-preserved", priority: "MUST", statement: "Browser clients are preserved", oracle: { command: "npm test" } },
        ],
        acceptance_policy: {}, authorization_ceiling: "LOCAL_REVERSIBLE",
      },
    });

    const closure = finalizeAcceptanceV2({
      goalId: contract.goal_id, contract, source,
      facets,
      authority: {
        qualification_basis: "NATIVE_EXACT",
        predecessor_authority_head_sha256: sha256Hex("admitted-event"),
      },
    });

    expect(closure.source.byte_length).toBe(Buffer.byteLength(source, "utf8"));
    expect(closure.facets.map((facet) => facet.semantic_statement)).toEqual([
      "Browser clients are preserved", "Parser is fixed",
    ]);
    const parserSpan = closure.spans.find((span) => span.quote_sha256 === sha256Hex("修复 parser 🚀"));
    expect(parserSpan).toMatchObject({ start_byte: 7, end_byte_exclusive: 25 });
    expect(closure.bindings.map((binding) => binding.relation)).toEqual(["SATISFIES", "SATISFIES"]);
    expect(new Set(closure.evidence_requirements.map((requirement) => requirement.binding_id)).size).toBe(2);
    expect(closure.authority.unresolved_material_count).toBe(0);
  });

  it("rejects an authority root ID that is not derived from the complete root identity", () => {
    const bundle = singleOutcomeBundle();
    const { record_sha256, ...authorityBody } = bundle.authority;
    expect(record_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const substitutedBody = { ...authorityBody, authority_root_id: "ACCEPT_AUTHORITY-substituted" };
    const substitutedAuthority = {
      ...substitutedBody,
      record_sha256: canonicalJsonSha256({
        domain: "PCH-ACCEPTANCE-AUTHORITY-ROOT-V2",
        ...substitutedBody,
      }),
    };

    expect(() => assertAcceptanceBundleV2({ ...bundle, authority: substitutedAuthority }))
      .toThrow("authority root identity");
  });

  it("rejects a resealed authority root with a non-canonical schema or generation", () => {
    const bundle = singleOutcomeBundle();
    const reseal = (changes: Readonly<Record<string, unknown>>) => {
      const { authority_root_id: oldId, record_sha256: oldHash, ...identity } = bundle.authority;
      void oldId;
      void oldHash;
      const changedIdentity = { ...identity, ...changes };
      const authorityRootId = idFromSha256("ACCEPT_AUTHORITY", canonicalJsonSha256({
        domain: "PCH-ACCEPTANCE-AUTHORITY-IDENTITY-V2",
        ...changedIdentity,
      }));
      const body = { ...changedIdentity, authority_root_id: authorityRootId };
      return {
        ...body,
        record_sha256: canonicalJsonSha256({
          domain: "PCH-ACCEPTANCE-AUTHORITY-ROOT-V2",
          ...body,
        }),
      } as unknown as typeof bundle.authority;
    };

    expect(() => assertAcceptanceBundleV2({
      ...bundle,
      authority: reseal({ schema_version: 3 }),
    })).toThrow("schema_version");
    expect(() => assertAcceptanceBundleV2({
      ...bundle,
      authority: reseal({ generation: bundle.contract.version + 1 }),
    })).toThrow("generation");
  });

  it("bounds facet/obligation fan-out before constructing the authority graph", () => {
    const source = "bounded fanout";
    const count = 65;
    const obligations = Array.from({ length: count }, (_, index) => ({
      key: `obligation-${index}`,
      priority: "MUST" as const,
      statement: `Obligation ${index}`,
      oracle: { command: "npm test" },
    }));
    const contract = finalizeGoalContract({
      goalId: "GOAL-BOUNDED-FANOUT", objective: source, intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null, createdAtMs: 1,
      proposal: {
        user_outcomes: ["Bounded fanout"], scope: ["src"], obligations,
        authorization_ceiling: "LOCAL_REVERSIBLE",
      },
    });
    const obligationKeys = obligations.map((obligation) => obligation.key);
    const facets = Array.from({ length: count }, (_, index) => ({
      key: `facet-${index}`,
      kind: "OUTCOME" as const,
      subject: { kind: "USER_OUTCOME" as const, index: 0 },
      source_binding: "ENTIRE_INTAKE" as const,
      obligation_keys: obligationKeys,
    }));

    expect(() => finalizeAcceptanceV2({
      goalId: contract.goal_id, contract, source, facets,
      authority: {
        qualification_basis: "NATIVE_EXACT",
        predecessor_authority_head_sha256: sha256Hex("admitted-event"),
      },
    })).toThrow("cannot exceed 4096");
  });

  it("resolves duplicate high-occurrence quotes once for the complete freeze", () => {
    const source = "a".repeat(131_072);
    const contract = finalizeGoalContract({
      goalId: "GOAL-QUOTE-INDEX", objective: "Index repeated exact quotes", intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null, createdAtMs: 1,
      proposal: {
        user_outcomes: ["Repeated quote result"], scope: ["src"], obligations: [{
          key: "repeated-result", priority: "MUST", statement: "Repeated quote result",
          oracle: { command: "npm test" },
        }], authorization_ceiling: "LOCAL_REVERSIBLE",
      },
    });
    const quote = { quote: "a", occurrence: source.length };
    const facets = Array.from({ length: 128 }, (_, index) => ({
      key: `repeated-${index}`,
      kind: "OUTCOME" as const,
      subject: { kind: "USER_OUTCOME" as const, index: 0 },
      source_quotes: Array.from({ length: 16 }, () => quote),
      obligation_keys: ["repeated-result"],
    }));

    const bundle = finalizeAcceptanceV2({
      goalId: contract.goal_id, contract, source, facets,
      authority: {
        qualification_basis: "NATIVE_EXACT",
        predecessor_authority_head_sha256: sha256Hex("admitted-event"),
      },
    });
    expect(bundle.spans).toHaveLength(1);
    expect(bundle.facets).toHaveLength(128);
  });

  it("rejects a resealed facet whose semantics no longer match its frozen contract subject", () => {
    const bundle = singleOutcomeBundle();
    const facet = bundle.facets[0]!;
    const { record_sha256, ...facetBody } = facet;
    expect(record_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const substitutedBody = { ...facetBody, semantic_statement: "A different unstated outcome" };
    const substitutedFacet = {
      ...substitutedBody,
      record_sha256: canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-FACET-V2", ...substitutedBody }),
    };

    expect(() => assertAcceptanceBundleV2({ ...bundle, facets: [substitutedFacet] }))
      .toThrow("facet semantic binding");
  });

  it("rejects resealed obligation, binding and evidence members that contradict the frozen graph", () => {
    const bundle = singleOutcomeBundle();
    const obligation = bundle.obligations[0]!;
    const { record_sha256: obligationHash, ...obligationBody } = obligation;
    expect(obligationHash).toMatch(/^[a-f0-9]{64}$/u);
    const substitutedObligationBody = { ...obligationBody, statement: "An unfrozen obligation" };
    const substitutedObligation = {
      ...substitutedObligationBody,
      record_sha256: canonicalJsonSha256({
        domain: "PCH-ACCEPTANCE-OBLIGATION-V2",
        ...substitutedObligationBody,
      }),
    };
    expect(() => assertAcceptanceBundleV2({ ...bundle, obligations: [substitutedObligation] }))
      .toThrow("obligation binding");

    const binding = bundle.bindings[0]!;
    const { record_sha256: bindingHash, ...bindingBody } = binding;
    expect(bindingHash).toMatch(/^[a-f0-9]{64}$/u);
    const substitutedBindingBody = { ...bindingBody, relation: "BOUNDS" as const };
    const substitutedBinding = {
      ...substitutedBindingBody,
      record_sha256: canonicalJsonSha256({
        domain: "PCH-FACET-OBLIGATION-BINDING-V2",
        ...substitutedBindingBody,
      }),
    };
    expect(() => assertAcceptanceBundleV2({ ...bundle, bindings: [substitutedBinding] }))
      .toThrow("binding semantic");

    const requirement = bundle.evidence_requirements[0]!;
    const { record_sha256: requirementHash, ...requirementBody } = requirement;
    expect(requirementHash).toMatch(/^[a-f0-9]{64}$/u);
    const substitutedRequirementBody = {
      ...requirementBody,
      frozen_oracle_sha256: sha256Hex("unfrozen-oracle"),
    };
    const substitutedRequirement = {
      ...substitutedRequirementBody,
      record_sha256: canonicalJsonSha256({
        domain: "PCH-EVIDENCE-REQUIREMENT-V2",
        ...substitutedRequirementBody,
      }),
    };
    expect(() => assertAcceptanceBundleV2({ ...bundle, evidence_requirements: [substitutedRequirement] }))
      .toThrow("evidence requirement binding");
  });
});
