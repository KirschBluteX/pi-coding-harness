import { performance } from "node:perf_hooks";
import { projectProtectedState, verifyProtectedProjection, type ProtectedTaskState } from "../../src/context/protected-projection.js";
import { sha256Hex } from "../../src/foundation/crypto.js";

function protectedState(): ProtectedTaskState {
  const receipts = Array.from({ length: 100 }, (_, index) => ({ id: `RCP-LONG-${index}`, sha256: sha256Hex(`receipt-${index}`) }));
  return {
    objective: "Continue a long Goal across recovery", acceptance_contract: { id: "AC-LONG", sha256: sha256Hex("acceptance") },
    constraints: [], latest_correction: { id: "COR-LONG", sha256: sha256Hex("correction") }, assumptions: [],
    requirement_revision: { id: "REQ-LONG", sha256: sha256Hex("requirement") },
    plan_revision: { id: "PLAN-LONG", sha256: sha256Hex("plan") }, execution_phase: "BUILDING",
    current_stage: { id: "STAGE-LONG", sha256: sha256Hex("stage") }, next_action: "Continue exact next WorkItem",
    pending_effects: [], receipts, failure_signatures: [sha256Hex("failed-route")], route_decision: null,
    active_performance_trial: null, prompt_generation: { id: "PROMPT-GEN-LONG", sha256: sha256Hex("generation") },
    prompt_request: { id: "PROMPT-REQ-LONG", sha256: sha256Hex("request") }, cache_lineage: null,
    response_contract: { id: "RESP-LONG", sha256: sha256Hex("response") }, evidence_frontier: [], lease_generation: 3,
  };
}

export function runLongScenario(): number {
  const started = performance.now();
  const projection = projectProtectedState(protectedState());
  verifyProtectedProjection(projection);
  return performance.now() - started;
}
