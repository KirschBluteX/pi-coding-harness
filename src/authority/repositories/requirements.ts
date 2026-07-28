import type { RequirementPackage } from "../../planning/types.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import { registerArtifact, type ArtifactMetadata } from "./common.js";

export interface FrozenRequirementArtifacts {
  readonly packageArtifact: ArtifactMetadata;
  readonly markdownArtifact: ArtifactMetadata;
}

interface ItemSource {
  readonly logicalId: string;
  readonly category: "OUTCOME" | "FUNCTIONAL" | "QUALITY" | "USER_FLOW" | "CONSTRAINT" | "NON_GOAL";
  readonly priority: "MUST" | "SHOULD" | "COULD" | null;
  readonly statement: string;
  readonly acceptanceIds: readonly string[];
  readonly ordinal: number;
  readonly value: unknown;
}

function items(pkg: RequirementPackage): ItemSource[] {
  const r = pkg.requirements;
  return [
    ...r.desired_outcomes.map((value, ordinal) => ({ logicalId: value.id, category: "OUTCOME" as const, priority: null, statement: value.statement, acceptanceIds: [] as string[], ordinal, value })),
    ...r.functional_requirements.map((value, ordinal) => ({ logicalId: value.id, category: "FUNCTIONAL" as const, priority: value.priority, statement: value.statement, acceptanceIds: value.acceptance_ids, ordinal, value })),
    ...r.quality_requirements.map((value, ordinal) => ({ logicalId: value.id, category: "QUALITY" as const, priority: null, statement: value.statement, acceptanceIds: value.acceptance_ids, ordinal, value })),
    ...r.user_flows.map((value, ordinal) => ({ logicalId: value.id, category: "USER_FLOW" as const, priority: null, statement: `${value.trigger}: ${value.success}`, acceptanceIds: [] as string[], ordinal, value })),
    ...r.constraints.map((value, ordinal) => ({ logicalId: value.id, category: "CONSTRAINT" as const, priority: null, statement: value.statement, acceptanceIds: [] as string[], ordinal, value })),
    ...r.non_goals.map((value, ordinal) => ({ logicalId: `NON_GOAL_${ordinal}`, category: "NON_GOAL" as const, priority: null, statement: value, acceptanceIds: [] as string[], ordinal, value })),
  ];
}

export class RequirementRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertFrozen(
    pkg: RequirementPackage,
    artifacts: FrozenRequirementArtifacts,
    validationReceiptId: string,
    triggerType: string,
    triggerEvidenceSha256: string,
    createdAtMs: number,
    eventSequence: number,
  ): void {
    if (pkg.package.status !== "FROZEN") throw new AuthorityIntegrityError("Requirement repository accepts only frozen packages");
    const current = this.connection.prepare(`SELECT requirement_id,revision FROM requirement_revisions
      WHERE goal_id=? ORDER BY revision DESC LIMIT 1`).get(pkg.package.goal_id) as Record<string, unknown> | undefined;
    if (!current) {
      if (pkg.package.revision !== 1 || (pkg.package.parent_requirement_id ?? null) !== null) {
        throw new AuthorityIntegrityError("Initial Requirement must be revision 1 without a parent");
      }
    } else if (pkg.package.revision !== Number(current.revision) + 1
      || pkg.package.parent_requirement_id !== String(current.requirement_id)) {
      throw new AuthorityIntegrityError(`RequirementRevision must directly supersede ${String(current.requirement_id)}`);
    }
    const actualHash = canonicalJsonSha256(pkg.requirements);
    if (actualHash !== pkg.integrity.requirements_payload_sha256 || actualHash !== artifacts.packageArtifact.sha256) throw new AuthorityIntegrityError("Requirement payload or artifact hash substitution");
    registerArtifact(this.connection, artifacts.packageArtifact, createdAtMs);
    registerArtifact(this.connection, artifacts.markdownArtifact, createdAtMs);

    for (const criterion of pkg.requirements.acceptance_criteria) {
      const specHash = canonicalJsonSha256(criterion);
      this.connection.prepare(`INSERT OR IGNORE INTO acceptance_criteria(
        criterion_id, goal_id, statement, criterion_class, required, spec_sha256, created_event_sequence
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(criterion.id, pkg.package.goal_id, criterion.statement, "REQUIREMENT", specHash, eventSequence);
      const existing = this.connection.prepare("SELECT goal_id, spec_sha256 FROM acceptance_criteria WHERE criterion_id = ?").get(criterion.id) as { goal_id?: unknown; spec_sha256?: unknown } | undefined;
      if (existing?.goal_id !== pkg.package.goal_id || existing.spec_sha256 !== specHash) throw new AuthorityIntegrityError(`Acceptance substitution detected for ${criterion.id}`);
    }
    this.connection.prepare(`INSERT INTO requirement_revisions(
      requirement_id, goal_id, revision, parent_requirement_id, profile, status, trigger_type,
      trigger_evidence_sha256, requirements_payload_sha256, requirements_artifact_id,
      markdown_artifact_id, validation_receipt_id, created_at_ms, created_event_sequence
    ) VALUES (?, ?, ?, ?, ?, 'FROZEN', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      pkg.package.requirement_id, pkg.package.goal_id, pkg.package.revision, pkg.package.parent_requirement_id ?? null,
      pkg.package.profile, triggerType, triggerEvidenceSha256, actualHash, artifacts.packageArtifact.artifactId,
      artifacts.markdownArtifact.artifactId, validationReceiptId, createdAtMs, eventSequence,
    );
    for (const item of items(pkg)) {
      const itemHash = canonicalJsonSha256(item.value);
      const itemId = idFromSha256("RITEM", canonicalJsonSha256({ requirementId: pkg.package.requirement_id, category: item.category, logicalId: item.logicalId }));
      this.connection.prepare(`INSERT INTO requirement_items(
        requirement_item_id, requirement_id, goal_id, category, priority, statement, item_sha256, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, pkg.package.requirement_id, pkg.package.goal_id, item.category, item.priority, item.statement, itemHash, item.ordinal);
      for (const acceptanceId of item.acceptanceIds) {
        this.connection.prepare("INSERT INTO requirement_acceptance_coverage(requirement_id, requirement_item_id, criterion_id) VALUES (?, ?, ?)").run(pkg.package.requirement_id, itemId, acceptanceId);
      }
    }
  }

  payloadSha256(requirementId: string): string | null {
    const row = this.connection.prepare("SELECT requirements_payload_sha256 FROM requirement_revisions WHERE requirement_id = ?").get(requirementId) as { requirements_payload_sha256?: unknown } | undefined;
    return typeof row?.requirements_payload_sha256 === "string" ? row.requirements_payload_sha256 : null;
  }
}
