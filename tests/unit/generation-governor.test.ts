import { describe, expect, it } from "vitest";
import { GenerationGovernor } from "../../src/control/generation-governor.js";
import { sha256Hex } from "../../src/foundation/crypto.js";

const frameA = sha256Hex("frame-a");
const frameB = sha256Hex("frame-b");
const active = (controlFrameSha256 = frameA) => ({
  controlFrameSha256, terminal: false, userDecisionRequired: false,
});

describe("GenerationGovernor", () => {
  it("escalates only repeated no-progress turns and does not count provider activity as progress", () => {
    const governor = new GenerationGovernor();
    governor.beginAgentRun("RUN-1", active());
    governor.recordProviderTurn();
    expect(governor.observeTurn(0, active())).toMatchObject({
      decision: "CONTINUE", reason_code: "FIRST_NO_PROGRESS", no_progress_turns: 1,
      provider_turns: 1, material_progress: false,
    });
    governor.recordProviderTurn();
    expect(governor.observeTurn(1, active())).toMatchObject({
      decision: "NUDGE", reason_code: "REPEATED_NO_PROGRESS", no_progress_turns: 2,
      directive: expect.stringContaining("No authority or evidence progress"),
    });
    expect(governor.observeTurn(2, active())).toMatchObject({
      decision: "HALT_AUTOMATION", reason_code: "NO_PROGRESS_LIMIT", no_progress_turns: 3,
    });
  });

  it("resets the streak on authority or unique evidence progress", () => {
    const governor = new GenerationGovernor();
    governor.beginAgentRun("RUN-1", active());
    governor.observeTurn(0, active());
    expect(governor.observeTurn(1, active(frameB))).toMatchObject({
      decision: "CONTINUE", authority_progress: true, no_progress_turns: 0,
    });
    governor.observeTurn(2, active(frameB));
    expect(governor.recordEvidence(sha256Hex("new evidence"))).toBe(true);
    expect(governor.recordEvidence(sha256Hex("new evidence"))).toBe(false);
    expect(governor.observeTurn(3, active(frameB))).toMatchObject({
      decision: "CONTINUE", evidence_progress: true, unique_evidence: 1, no_progress_turns: 0,
    });
  });

  it("blocks only a previously stalled identical route while allowing a changed repair route", () => {
    const governor = new GenerationGovernor();
    const stalled = sha256Hex("same route");
    const repair = sha256Hex("changed repair");
    governor.beginAgentRun("RUN-1", active());
    expect(governor.registerRoute(stalled).allow).toBe(true);
    governor.observeTurn(0, active());
    expect(governor.registerRoute(stalled).allow).toBe(true);
    governor.observeTurn(1, active());
    expect(governor.registerRoute(stalled)).toMatchObject({
      allow: false, reason: expect.stringContaining("PCH_GENERATION_ROUTE_STALLED"),
    });
    expect(governor.registerRoute(repair)).toEqual({ allow: true, reason: null });
  });

  it("never escalates a terminal or user-decision frontier and resets for new user input", () => {
    const governor = new GenerationGovernor();
    governor.beginAgentRun("RUN-1", active());
    governor.observeTurn(0, active());
    governor.observeTurn(1, active());
    expect(governor.observeTurn(2, { ...active(), userDecisionRequired: true })).toMatchObject({
      decision: "WAIT_USER", no_progress_turns: 0, directive: null,
    });
    expect(governor.beginAgentRun("RUN-2", active())).toMatchObject({
      decision: "CONTINUE", reason_code: "AGENT_RUN_STARTED", no_progress_turns: 0,
    });
    expect(governor.observeTurn(0, { ...active(), terminal: true })).toMatchObject({
      decision: "TERMINAL", reason_code: "GOAL_TERMINAL", directive: null,
    });
  });
});
