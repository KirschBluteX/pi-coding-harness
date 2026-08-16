import { describe, expect, it } from "vitest";
import { buildAcceptanceLedger } from "../../src/task-flow/acceptance-ledger.js";
import { finalizeGoalContract } from "../../src/task-flow/finalize.js";
import { sha256Hex } from "../../src/foundation/crypto.js";

describe("AcceptanceLedger", () => {
  it("retains root evidence and maps facets to obligations many-to-many without promoting inference", () => {
    const source = "Implement fast parsing\nDo not use network access";
    const contract = finalizeGoalContract({
      goalId: "GOAL-1", objective: source, intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null,
      createdAtMs: 1,
      proposal: {
        user_outcomes: ["Implement fast parsing"], scope: ["src"], non_goals: ["Do not use network access"],
        constraints: [], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{ key: "parse", priority: "MUST", statement: "Parser passes", oracle: { command: "npm test" } }],
      },
    });
    const ledger = buildAcceptanceLedger({ source, contract });
    expect(ledger.facets[0]).toMatchObject({ kind: "SOURCE_ROOT", source_span: { start: 0, end: source.length } });
    expect(ledger.facets.some((entry) => entry.kind === "SOURCE_EXPLICIT")).toBe(true);
    expect(ledger.links.filter((entry) => entry.obligation_id === contract.obligations[0]!.obligation_id).map((entry) => entry.relation))
      .toEqual(expect.arrayContaining(["DERIVED_FROM_ROOT", "COVERS", "CONSTRAINS"]));
  });

  it("keeps paraphrased outcomes explicitly marked as inferred", () => {
    const source = "Fix the parser";
    const contract = finalizeGoalContract({
      goalId: "GOAL-2", objective: source, intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: sha256Hex(source), version: 1, parentContractId: null,
      createdAtMs: 1,
      proposal: {
        user_outcomes: ["Parsing is correct"], scope: ["src/parser.ts"], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{ key: "parse", priority: "MUST", statement: "Parser passes", oracle: { command: "npm test" } }],
      },
    });
    expect(buildAcceptanceLedger({ source, contract }).facets.some((entry) => entry.kind === "INFERRED_OUTCOME")).toBe(true);
  });
});
