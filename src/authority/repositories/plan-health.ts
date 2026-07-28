import { AuthorityIntegrityError } from "../../foundation/errors.js";
import type { CorrectionLevel, PlanHealthStatus } from "../../planning/plan-health.js";
import { canonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";

export interface StoredRouteDecisionRecord {
  readonly routeDecisionId: string;
  readonly goalId: string;
  readonly planId: string;
  readonly planHealthStatus: PlanHealthStatus;
  readonly correctionLevel: CorrectionLevel;
  readonly triggerSha256: string;
  readonly candidates: readonly Readonly<Record<string, unknown>>[];
  readonly selectedRouteId: string;
  readonly lexicographicEvidence: Readonly<Record<string, unknown>>;
}

export class PlanHealthRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertRouteDecision(input: StoredRouteDecisionRecord, eventSequence: number): void {
    const plan = this.connection.prepare("SELECT goal_id FROM plan_revisions WHERE plan_id=?").get(input.planId) as {
      goal_id?: unknown;
    } | undefined;
    if (plan?.goal_id !== input.goalId) throw new AuthorityIntegrityError("RouteDecision Plan/Goal binding failed");
    if (!/^[a-f0-9]{64}$/u.test(input.triggerSha256)) throw new AuthorityIntegrityError("RouteDecision trigger hash is invalid");
    this.connection.prepare(`INSERT INTO route_decisions(
      route_decision_id,goal_id,plan_id,plan_health_status,correction_level,trigger_sha256,
      candidates_json,selected_route_id,lexicographic_evidence_json,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      input.routeDecisionId, input.goalId, input.planId, input.planHealthStatus,
      input.correctionLevel, input.triggerSha256, canonicalJson(input.candidates),
      input.selectedRouteId, canonicalJson(input.lexicographicEvidence), eventSequence,
    );
  }
}
