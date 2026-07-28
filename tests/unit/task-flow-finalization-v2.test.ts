import { describe, expect, it } from "vitest";
import { finalizeGoalContract, finalizeRoute, type GoalContractProposal, type RouteProposal } from "../../src/task-flow/finalize.js";
import { applyRouteRevisionPatch } from "../../src/task-flow/route-revision.js";

const now = Date.parse("2026-07-25T00:00:00.000Z");

function contract(lane: "DIRECT_CELL" | "ADAPTIVE_ROUTE" = "DIRECT_CELL") {
  return finalizeGoalContract({
    goalId: "GOAL-ROUTE-V2", objective: "Update src/a.ts and verify it", intent: "BUILD", lane,
    sourceIntakeSha256: "a".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
    proposal: {
      user_outcomes: ["The change is verified"], scope: ["src/a.ts"], authorization_ceiling: "LOCAL_REVERSIBLE",
      obligations: [
        { key: "implementation", priority: "MUST", statement: "The file is updated", oracle: { command: "npm test" } },
        { key: "verification", priority: "MUST", statement: "The result is verified", oracle: { command: "npm test" } },
      ],
    },
  });
}

function cell(key: string, obligations: readonly string[]) {
  return {
    key, outcome: `Complete ${key}`, obligation_keys: obligations,
    read_roots: ["src/a.ts"], write_roots: ["src/a.ts"],
    effect_classes: ["LOCAL_REVERSIBLE" as const], oracle: { command: "npm test" },
    risk: "LOW" as const, reversible: true,
  };
}

describe("Task Flow v2 route finalization", () => {
  it("reports missing GoalContract proposal fields with an actionable path", () => {
    const proposal = { user_outcomes: ["Verified"], scope: ["src/a.ts"] } as unknown as GoalContractProposal;
    expect(() => finalizeGoalContract({
      goalId: "GOAL-MALFORMED", objective: "Update src/a.ts", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "a".repeat(64), version: 1, parentContractId: null, proposal, createdAtMs: now,
    })).toThrow("GoalContract proposal.authorization_ceiling must be one of");
  });

  it("reports missing Route proposal fields with an actionable path", () => {
    const proposal = { outcomes: ["Verified"] } as unknown as RouteProposal;
    expect(() => finalizeRoute({ contract: contract(), revision: 1, parentRouteId: null, proposal, createdAtMs: now }))
      .toThrow("Route proposal.work_cells must be an array");
  });

  it("rejects a generic one-item contract when the intake contains three explicit acceptance facets", () => {
    const objective = "If cleanup throws, every remaining cleanup must still run, the error must reach the boundary, and the throwing cleanup must not run again.";
    expect(() => finalizeGoalContract({
      goalId: "GOAL-ATOMIC-ACCEPTANCE", objective, intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: "d".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["Cleanup works"], scope: ["src/a.ts"], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{ key: "cleanup", priority: "MUST", statement: "Cleanup works", oracle: { commands: ["npm test"] } }],
      },
    })).toThrow(/at least 3 independent user_outcomes and MUST obligations/u);
  });

  it("rejects shell-composed acceptance and directs multiple checks to commands[]", () => {
    expect(() => finalizeGoalContract({
      goalId: "GOAL-COMPOSED-ORACLE", objective: "Update and verify", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "c".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["Verified"], scope: ["src/a.ts"], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{
          key: "composed", priority: "MUST", statement: "Both checks pass",
          oracle: { command: "npm test && npm run lint" },
        }],
      },
    })).toThrow(/rejects "npm test && npm run lint".*oracle\.commands\[\]/u);
  });

  it("accepts terminating project-local build binaries as independent oracle commands", () => {
    expect(() => finalizeGoalContract({
      goalId: "GOAL-LOCAL-BUILD", objective: "Bundle src/index.js", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "e".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["The bundle is built"], scope: ["src/index.js", "dist/preact.js"], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{
          key: "bundle", priority: "MUST", statement: "The bundle is produced",
          oracle: { commands: ["node_modules/.bin/esbuild src/index.js --bundle --format=cjs --outfile=dist/preact.js"] },
        }],
      },
    })).not.toThrow();
  });

  it("rejects npm exec precisely even when commands[] is already used", () => {
    expect(() => finalizeGoalContract({
      goalId: "GOAL-NPM-EXEC", objective: "Bundle src/index.js", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "f".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["The bundle is built"], scope: ["src/index.js"], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{
          key: "bundle", priority: "MUST", statement: "The bundle is produced",
          oracle: { commands: ["npm exec esbuild -- src/index.js --bundle --outfile=dist/preact.js"] },
        }],
      },
    })).toThrow(/rejects "npm exec esbuild.*may install.*commands\[\] only separates/iu);
  });

  it("accepts a bounded workspace-local go test oracle", () => {
    const command = "go test ./internal/terraform -run=^TestContext2Plan_import -count=1 -timeout=30m";
    expect(() => finalizeGoalContract({
      goalId: "GOAL-GO-ORACLE", objective: "Validate Terraform import blocks", intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: "9".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["Import blocks are validated"], scope: ["internal/terraform"], non_goals: [], constraints: [],
        assumption_refs: [], decision_refs: [], authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [{ key: "go-tests", priority: "MUST", statement: "Import validation tests pass", oracle: { commands: [command] } }],
        acceptance_policy: {},
      },
    })).not.toThrow();
  });

  it("keeps a proven one-cell route on DirectCell and emits a qualification receipt", () => {
    const value = finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: { lane: "DIRECT_CELL", outcomes: ["Complete the bounded change"], work_cells: [cell("change", ["implementation", "verification"])] },
      boundedScopeOverride: true,
    });
    expect(value).toMatchObject({ schema_version: 2, lane: "DIRECT_CELL", deferred_outcomes: [] });
    expect(value.qualification).toMatchObject({ selected_lane: "DIRECT_CELL", bounded_scope: true, oracle_known: true, reversible: true });
  });

  it("promotes an unqualified DirectCell hint without revising the GoalContract", () => {
    const value = finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        lane: "DIRECT_CELL", outcomes: ["Complete two near-horizon cells"],
        work_cells: [cell("first", ["implementation"]), { ...cell("second", ["verification"]), dependencies: ["first"] }],
      },
      boundedScopeOverride: true,
    });
    expect(value.lane).toBe("ADAPTIVE_ROUTE");
    expect(value.qualification).toMatchObject({ admission_lane_hint: "DIRECT_CELL", requested_lane: "DIRECT_CELL", selected_lane: "ADAPTIVE_ROUTE" });
    expect(value.qualification?.reason_codes).toContain("DIRECT_CELL_PROMOTED");
  });

  it("expands a compact RouteRevision patch and reruns full acceptance closure", () => {
    const frozenContract = contract("ADAPTIVE_ROUTE");
    const prior = finalizeRoute({
      contract: frozenContract, revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        lane: "ADAPTIVE_ROUTE", outcomes: ["Implement and verify"],
        assumptions: [{ key: "old-route", statement: "The old route is viable", status: "SUPPORTED" }],
        work_cells: [
          cell("implementation", ["implementation"]),
          { ...cell("verification", ["verification"]), dependencies: ["implementation"] },
        ],
      },
    });
    const proposal = applyRouteRevisionPatch({
      contract: frozenContract, priorRoute: prior,
      patch: {
        work_cells: [cell("local-repair", ["verification"])],
        assumptions: [{ key: "repair-route", statement: "The local repair is viable", status: "SUPPORTED" }],
      },
    });
    expect(proposal).toMatchObject({
      outcomes: ["Implement and verify"], near_horizon: ["local-repair"],
      assumptions: [{ key: "repair-route" }], work_cells: [{ key: "local-repair" }],
    });
    const revised = finalizeRoute({
      contract: frozenContract, revision: 2, parentRouteId: prior.route_id,
      priorRoute: prior, proposal, createdAtMs: now + 1,
    });
    expect(revised.work_cells).toHaveLength(1);
    expect(revised.work_cells[0]?.obligation_ids).toEqual(frozenContract.obligations.map((entry) => entry.obligation_id));
    expect(revised.work_cells[0]?.oracle).toMatchObject({ command: "npm test" });
  });

  it("reclassifies an initial Adaptive admission to Direct only when complete route evidence proves it", () => {
    const value = finalizeRoute({
      contract: contract("ADAPTIVE_ROUTE"), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: { outcomes: ["Complete the bounded change"], work_cells: [cell("change", ["implementation", "verification"])] },
      boundedScopeOverride: true,
    });
    expect(value.lane).toBe("DIRECT_CELL");
    expect(value.qualification).toMatchObject({
      schema_version: 2, admission_lane_hint: "ADAPTIVE_ROUTE", proposal_lane: null,
      evidence_candidate_lane: "DIRECT_CELL", prior_selected_lane: null,
      selected_lane: "DIRECT_CELL", hysteresis_action: "INITIAL_RECLASSIFY",
    });
  });

  it("holds Adaptive after promotion instead of oscillating back to Direct", () => {
    const frozenContract = contract("DIRECT_CELL");
    const first = finalizeRoute({
      contract: frozenContract, revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        outcomes: ["Complete two cells"],
        work_cells: [cell("first", ["implementation"]), { ...cell("second", ["verification"]), dependencies: ["first"] }],
      },
      boundedScopeOverride: true,
    });
    const second = finalizeRoute({
      contract: frozenContract, revision: 2, parentRouteId: first.route_id, priorRoute: first, createdAtMs: now + 1,
      proposal: { lane: "DIRECT_CELL", outcomes: ["Use one bounded cell"], work_cells: [cell("change", ["implementation", "verification"])] },
      boundedScopeOverride: true,
    });
    expect(second.lane).toBe("ADAPTIVE_ROUTE");
    expect(second.qualification).toMatchObject({
      evidence_candidate_lane: "DIRECT_CELL", prior_selected_lane: "ADAPTIVE_ROUTE",
      selected_lane: "ADAPTIVE_ROUTE", hysteresis_action: "HELD_ADAPTIVE",
    });
  });

  it("promotes a prior Direct route immediately when new route evidence becomes unsafe", () => {
    const frozenContract = contract("DIRECT_CELL");
    const first = finalizeRoute({
      contract: frozenContract, revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: { outcomes: ["Complete the bounded change"], work_cells: [cell("change", ["implementation", "verification"])] },
      boundedScopeOverride: true,
    });
    const second = finalizeRoute({
      contract: frozenContract, revision: 2, parentRouteId: first.route_id, priorRoute: first, createdAtMs: now + 1,
      proposal: { outcomes: ["Complete the changed route"], work_cells: [{ ...cell("change", ["implementation", "verification"]), risk: "MEDIUM" }] },
      boundedScopeOverride: true,
    });
    expect(second.lane).toBe("ADAPTIVE_ROUTE");
    expect(second.qualification).toMatchObject({ prior_selected_lane: "DIRECT_CELL", hysteresis_action: "PROMOTED" });
  });

  it("projects every MUST oracle onto one terminal WorkCell without adding a model-visible stage", () => {
    const splitContract = finalizeGoalContract({
      goalId: "GOAL-TERMINAL-CLOSURE", objective: "Update runtime and types", intent: "BUILD", lane: "ADAPTIVE_ROUTE",
      sourceIntakeSha256: "b".repeat(64), version: 1, parentContractId: null, createdAtMs: now,
      proposal: {
        user_outcomes: ["Runtime and types are verified"], scope: ["src/runtime.ts", "src/types.ts"],
        authorization_ceiling: "LOCAL_REVERSIBLE",
        obligations: [
          { key: "runtime", priority: "MUST", statement: "Runtime tests pass", oracle: { command: "npm run test:runtime" } },
          { key: "types", priority: "MUST", statement: "Type tests pass", oracle: { command: "npm run test:types" } },
        ],
      },
    });
    const value = finalizeRoute({
      contract: splitContract, revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        outcomes: ["Implement and verify both surfaces"],
        work_cells: [
          {
            key: "runtime", outcome: "Update runtime", obligation_keys: ["runtime"],
            read_roots: ["src/runtime.ts"], write_roots: ["src/runtime.ts"],
            effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm run test:runtime" }, risk: "LOW", reversible: true,
          },
          {
            key: "types", outcome: "Update types", obligation_keys: ["types"], dependencies: ["runtime"],
            read_roots: ["src/types.ts"], write_roots: ["src/types.ts"],
            effect_classes: ["LOCAL_REVERSIBLE"], oracle: { command: "npm run test:types" }, risk: "LOW", reversible: true,
          },
        ],
      },
    });
    const terminal = value.work_cells[1]!;
    expect(terminal.obligation_ids).toEqual(splitContract.obligations.map((entry) => entry.obligation_id));
    expect(terminal.dependencies).toEqual([value.work_cells[0]!.work_cell_id]);
    expect(terminal.read_roots).toEqual(["src/runtime.ts", "src/types.ts"]);
    expect(terminal.oracle.commands).toEqual(["npm run test:runtime", "npm run test:types"]);
    expect(value.acceptance_coverage[splitContract.obligations[0]!.obligation_id]).toEqual([
      value.work_cells[0]!.work_cell_id,
      terminal.work_cell_id,
    ]);
  });

  it("accepts deferred MUST coverage without pre-expanding a full route", () => {
    const value = finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        outcomes: ["Implement then verify"], work_cells: [cell("implement", ["implementation"])],
        deferred_outcomes: [{
          key: "verify-later", outcome: "Verify final workspace", obligation_keys: ["verification"],
          dependencies: ["implement"], expansion_trigger: "WORK_CELL_CLOSED", commitment: "REVERSIBLE",
        }],
      },
    });
    expect(value.lane).toBe("ADAPTIVE_ROUTE");
    expect(value.work_cells).toHaveLength(1);
    expect(value.deferred_outcomes).toHaveLength(1);
    expect(value.acceptance_coverage[value.deferred_outcomes![0]!.obligation_ids[0]!]).toContain(value.deferred_outcomes![0]!.deferred_outcome_id);
  });

  it("repairs only the terminal acceptance closure and still rejects a mismatched non-terminal oracle", () => {
    const mismatched = {
      ...cell("change", ["implementation"]),
      oracle: { command: "npm run lint" },
    };
    const closed = finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: { lane: "DIRECT_CELL", outcomes: ["Complete the bounded change"], work_cells: [mismatched] },
      boundedScopeOverride: true,
    });
    expect(closed.work_cells[0]?.oracle.commands).toEqual(["npm test", "npm run lint"]);
    expect(closed.work_cells[0]?.obligation_ids).toEqual(contract().obligations.map((entry) => entry.obligation_id));

    expect(() => finalizeRoute({
      contract: contract("ADAPTIVE_ROUTE"), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        outcomes: ["Implement, then verify"],
        work_cells: [
          mismatched,
          { ...cell("verify", ["verification"]), dependencies: ["change"] },
        ],
      },
    })).toThrow(/does not prove obligation oracle/u);
  });

  it("rejects untyped route assumptions", () => {
    const proposal = {
      outcomes: ["Complete the change"], work_cells: [cell("change", ["implementation", "verification"])],
      assumptions: [{ note: "arbitrary bag" }],
    } as unknown as RouteProposal;
    expect(() => finalizeRoute({ contract: contract(), revision: 1, parentRouteId: null, proposal, createdAtMs: now }))
      .toThrow();
  });

  it("rejects proposal fields that would otherwise be silently discarded", () => {
    const valid = {
      outcomes: ["Complete the bounded change"],
      work_cells: [cell("change", ["implementation", "verification"])],
    };
    expect(() => finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: { ...valid, failure_recovery: "ignored" } as never,
    })).toThrow("Route proposal.failure_recovery is not allowed");
    expect(() => finalizeRoute({
      contract: contract(), revision: 1, parentRouteId: null, createdAtMs: now,
      proposal: {
        ...valid,
        assumptions: [{ key: "runtime", statement: "Runtime is present", status: "SUPPORTED", evidence: "src/runtime.ts" }],
      } as never,
    })).toThrow("Route proposal.assumptions[0].evidence is not allowed");
  });
});
