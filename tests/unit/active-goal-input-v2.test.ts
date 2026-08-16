import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeActiveGoalUserTurnV2 } from "../../src/plan-v2/active-goal-input.js";

const closure = {
  goal_id: "GOAL-ACTIVE-INPUT",
  goal_version: 1,
  contract_sha256: null,
  route_sha256: null,
  plan_revision_id: null,
  plan_revision_sha256: null,
  stage_gate_sha256: null,
  execution_authorization_sha256: null,
} as const;

function finalize(source: string | Uint8Array) {
  return finalizeActiveGoalUserTurnV2({
    closure,
    source,
    session_id: "SESSION-ACTIVE-INPUT",
    turn_id: "TURN-ACTIVE-INPUT",
    event_head_sha256: sha256Hex("event-head"),
    created_at_ms: 1,
  });
}

describe("Active Goal exact input authority", () => {
  it("preserves well-formed non-NFC UTF-8 bytes", () => {
    const source = "e\u0301";

    expect(Buffer.from(finalize(source).source_bytes).toString("utf8")).toBe(source);
  });

  it("rejects malformed Unicode strings and whitespace-only UTF-8", () => {
    expect(() => finalize("\ud800")).toThrow(/exact UTF-8/iu);
    expect(() => finalize(Buffer.from(" \t\r\n", "utf8"))).toThrow(/non-whitespace/iu);
  });
});
