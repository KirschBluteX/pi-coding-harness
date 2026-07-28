import type { Impact, PlanPackage } from "../../planning/types.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { canonicalJson, canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { registerArtifact, type ArtifactMetadata } from "./common.js";

export interface FrozenPlanArtifacts {
  readonly packageArtifact: ArtifactMetadata;
  readonly markdownArtifact: ArtifactMetadata;
}

const riskOrder: Readonly<Record<Impact, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export class PlanRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertFrozen(
    pkg: PlanPackage,
    artifacts: FrozenPlanArtifacts,
    validationReceiptId: string,
    triggerType: string,
    triggerEvidenceSha256: string,
    rationale: string,
    createdAtMs: number,
    eventSequence: number,
  ): void {
    if (pkg.package.status !== "FROZEN") throw new AuthorityIntegrityError("Plan repository accepts only frozen packages");
    const current = this.connection.prepare(`SELECT plan_id,revision,requirement_id FROM plan_revisions
      WHERE goal_id=? ORDER BY revision DESC LIMIT 1`).get(pkg.package.goal_id) as Record<string, unknown> | undefined;
    if (!current) {
      if (pkg.package.revision !== 1 || (pkg.package.parent_plan_id ?? null) !== null || (pkg.package.supersedes_plan_id ?? null) !== null) {
        throw new AuthorityIntegrityError("Initial Plan must be revision 1 without a parent");
      }
    } else {
      const currentId = String(current.plan_id);
      if (pkg.package.revision !== Number(current.revision) + 1
        || pkg.package.parent_plan_id !== currentId || pkg.package.supersedes_plan_id !== currentId) {
        throw new AuthorityIntegrityError(`PlanRevision must directly supersede ${currentId}`);
      }
    }
    const actualHash = canonicalJsonSha256(pkg.plan);
    if (actualHash !== pkg.integrity.plan_payload_sha256 || actualHash !== artifacts.packageArtifact.sha256) throw new AuthorityIntegrityError("Plan payload or artifact hash substitution");
    const requirement = this.connection.prepare(`SELECT requirements_payload_sha256 FROM requirement_revisions
      WHERE requirement_id=? AND goal_id=? AND status='FROZEN'
      AND revision=(SELECT MAX(revision) FROM requirement_revisions WHERE goal_id=?)`).get(
      pkg.package.requirement_id, pkg.package.goal_id, pkg.package.goal_id,
    ) as { requirements_payload_sha256?: unknown } | undefined;
    if (requirement?.requirements_payload_sha256 !== pkg.package.requirement_payload_sha256
      || requirement.requirements_payload_sha256 !== pkg.integrity.requirement_payload_sha256) {
      throw new AuthorityIntegrityError("Plan does not bind the current frozen Requirement payload");
    }
    registerArtifact(this.connection, artifacts.packageArtifact, createdAtMs);
    registerArtifact(this.connection, artifacts.markdownArtifact, createdAtMs);
    this.connection.prepare(`INSERT INTO plan_revisions(
      plan_id, goal_id, requirement_id, revision, parent_plan_id, trigger_type, trigger_evidence_sha256,
      rationale, plan_payload_sha256, plan_artifact_id, markdown_artifact_id, validation_receipt_id,
      created_at_ms, created_event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      pkg.package.plan_id, pkg.package.goal_id, pkg.package.requirement_id, pkg.package.revision,
      pkg.package.parent_plan_id ?? null, triggerType, triggerEvidenceSha256, rationale, actualHash,
      artifacts.packageArtifact.artifactId, artifacts.markdownArtifact.artifactId, validationReceiptId,
      createdAtMs, eventSequence,
    );
    for (const [ordinal, stage] of pkg.plan.stages.entries()) {
      const risk = pkg.plan.risk_summary.filter((item) => item.owner_stage_id === stage.id).map((item) => item.severity).sort((left, right) => riskOrder[right] - riskOrder[left])[0] ?? "LOW";
      this.connection.prepare(`INSERT INTO plan_stages(
        stage_id, plan_id, goal_id, logical_key, title, detail_horizon, risk, ordinal,
        entry_criteria_json, exit_criteria_json, outputs_json, failure_routes_json, spec_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        stage.id, pkg.package.plan_id, pkg.package.goal_id, stage.logical_key, stage.title, stage.detail_horizon,
        risk, ordinal, canonicalJson(stage.entry_criteria), canonicalJson(stage.exit_criteria),
        canonicalJson(stage.outputs), canonicalJson(stage.failure_routes), canonicalJsonSha256(stage),
      );
    }
    for (const stage of pkg.plan.stages) {
      for (const dependency of stage.dependencies) this.connection.prepare("INSERT INTO stage_dependencies(plan_id, stage_id, depends_on_stage_id) VALUES (?, ?, ?)").run(pkg.package.plan_id, stage.id, dependency);
    }
    for (const coverage of pkg.plan.acceptance_coverage) {
      for (const stageId of coverage.stage_ids) this.connection.prepare("INSERT INTO acceptance_stage_coverage(plan_id, criterion_id, stage_id, proof_rule) VALUES (?, ?, ?, ?)").run(pkg.package.plan_id, coverage.criterion_id, stageId, coverage.proof);
    }
  }

  payloadSha256(planId: string): string | null {
    const row = this.connection.prepare("SELECT plan_payload_sha256 FROM plan_revisions WHERE plan_id = ?").get(planId) as { plan_payload_sha256?: unknown } | undefined;
    return typeof row?.plan_payload_sha256 === "string" ? row.plan_payload_sha256 : null;
  }

  head(goalId: string): { readonly planId: string; readonly revision: number } | null {
    const row = this.connection.prepare("SELECT plan_id,revision FROM plan_revisions WHERE goal_id=? ORDER BY revision DESC LIMIT 1")
      .get(goalId) as { plan_id?: unknown; revision?: unknown } | undefined;
    return typeof row?.plan_id === "string" && typeof row.revision === "number"
      ? { planId: row.plan_id, revision: row.revision }
      : null;
  }
}
