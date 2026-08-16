import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { DeliverableManifestV2 } from "./domain.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface RecordDeliverableTriggerV2 {
  readonly goal_id: string;
}

export interface DeliveryTransactionStampV2 {
  readonly created_at_ms: number;
  readonly created_event_sequence: number;
}

export interface DeliverableArtifactMemberV2 {
  readonly artifact_id: string;
  readonly artifact_sha256: string;
}

export interface DeliverableClosureV2 {
  readonly manifest: DeliverableManifestV2;
  readonly completion_receipt_ids: readonly string[];
  readonly evidence_binding_ids: readonly string[];
  readonly artifacts: readonly DeliverableArtifactMemberV2[];
}

interface FinalEvidenceMemberV2 {
  readonly evidence_binding_id: string;
  readonly work_cell_id: string;
  readonly record_sha256: string;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Deliverable V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Deliverable V2 ${key} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AuthorityIntegrityError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function memberRoot(domain: string, hashes: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...hashes].sort() });
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertSealed(domain: string, value: Record<string, unknown>): void {
  const actual = text(value, "record_sha256");
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "record_sha256"));
  if (canonicalJsonSha256({ domain, ...body }) !== actual) throw new AuthorityIntegrityError("Deliverable V2 record hash mismatch");
}

export class AcceptanceDeliveryV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  recordDeliverable(trigger: RecordDeliverableTriggerV2, stamp: DeliveryTransactionStampV2): DeliverableClosureV2 {
    if (!this.connection.isTransaction) throw new AuthorityIntegrityError("Deliverable V2 requires the authority transaction");
    if (!Number.isSafeInteger(stamp.created_at_ms) || stamp.created_at_ms < 0
      || !Number.isSafeInteger(stamp.created_event_sequence) || stamp.created_event_sequence < 1) {
      throw new AuthorityIntegrityError("Deliverable V2 transaction stamp is invalid");
    }
    const predecessor = this.eventHead(trigger.goal_id);
    if (stamp.created_event_sequence !== predecessor.sequence + 1) {
      throw new AuthorityIntegrityError("Deliverable V2 transaction sequence is not the next Goal event");
    }
    const head = this.currentClosure(trigger.goal_id);
    const completions = this.completions(head);
    const finalEvidence = this.finalEvidence(head);
    const finalEvidenceHashes = finalEvidence.map((entry) => entry.record_sha256);
    const artifacts: readonly DeliverableArtifactMemberV2[] = [];
    const completionIds = completions.map((row) => text(row, "completion_receipt_id"));
    const completionHashes = completions.map((row) => sha(row.record_sha256, "Completion receipt SHA-256"));
    const artifactHashes = artifacts.map((artifact) => canonicalJsonSha256({
      domain: "PCH-DELIVERABLE-ARTIFACT-MEMBER-V2", ...artifact,
    }));
    const revision = integer(this.connection.prepare(`SELECT COALESCE(MAX(revision),0)+1 revision
      FROM deliverable_manifests_v2 WHERE goal_id=?`).get(trigger.goal_id) as Record<string, unknown>, "revision");
    const body = {
      schema_version: 2 as const,
      deliverable_manifest_id: idFromSha256("DELIVERABLE_V2", canonicalJsonSha256({
        authority: text(head, "authority_root_id"), route: text(head, "route_id"),
        completions: completionHashes, artifacts: artifactHashes, revision,
      })),
      goal_id: trigger.goal_id,
      contract_id: text(head, "contract_id"),
      route_id: text(head, "route_id"),
      authority_root_id: text(head, "authority_root_id"),
      revision,
      final_baseline_id: text(head, "baseline_id"),
      final_postimage_root_sha256: text(head, "content_root_sha256"),
      completion_root_sha256: memberRoot("PCH-DELIVERABLE-COMPLETION-ROOT-V2", completionHashes),
      evidence_root_sha256: memberRoot("PCH-DELIVERABLE-EVIDENCE-ROOT-V2", finalEvidenceHashes),
      artifact_root_sha256: memberRoot("PCH-DELIVERABLE-ARTIFACT-ROOT-V2", artifactHashes),
      predecessor_authority_head_sha256: predecessor.sha256,
    };
    const manifest = sealed("PCH-DELIVERABLE-MANIFEST-V2", body);
    this.insertManifest(manifest, stamp);
    this.insertMembers(manifest, completionIds, finalEvidence, artifacts, stamp.created_event_sequence);
    return {
      manifest, completion_receipt_ids: completionIds,
      evidence_binding_ids: finalEvidence.map((entry) => entry.evidence_binding_id), artifacts,
    };
  }

  private currentClosure(goalId: string): Record<string, unknown> {
    const row = this.connection.prepare(`SELECT ch.goal_id,ch.contract_id,rh.route_id,ar.authority_root_id,
        b.baseline_id,b.content_root_sha256,b.environment_sha256,b.created_event_sequence AS baseline_sequence
      FROM goal_contract_heads_v1 ch JOIN route_skeleton_heads_v1 rh ON rh.goal_id=ch.goal_id
      JOIN acceptance_authority_roots_v2 ar ON ar.contract_id=ch.contract_id
      JOIN workspace_baselines_v1 b ON b.goal_id=ch.goal_id
        AND b.created_event_sequence=(SELECT MAX(x.created_event_sequence) FROM workspace_baselines_v1 x WHERE x.goal_id=ch.goal_id)
      WHERE ch.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Deliverable V2 lacks current contract, route, authority, or baseline");
    const incomplete = integer(this.connection.prepare(`SELECT count(*) count FROM work_cell_heads_v1
      WHERE goal_id=? AND route_id=? AND status<>'SUCCEEDED'`).get(goalId, text(row, "route_id")) as Record<string, unknown>, "count");
    const unresolved = integer(this.connection.prepare(`SELECT count(*) count FROM operation_heads_v1
      WHERE goal_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')`).get(goalId) as Record<string, unknown>, "count");
    if (incomplete !== 0 || unresolved !== 0) throw new AuthorityIntegrityError("Deliverable V2 closure is incomplete");
    return row;
  }

  private eventHead(goalId: string): { readonly sequence: number; readonly sha256: string } {
    const row = this.connection.prepare("SELECT sequence,event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Deliverable predecessor event is missing");
    return {
      sequence: integer(row, "sequence"),
      sha256: sha(row.event_sha256, "Deliverable predecessor event"),
    };
  }

  private completions(head: Record<string, unknown>): readonly Record<string, unknown>[] {
    const rows = this.connection.prepare(`SELECT c.ordinal,r.completion_receipt_id,r.record_sha256,
        r.evidence_binding_root_sha256,r.final_postimage_root_sha256
      FROM work_cells_v1 c JOIN work_cell_completion_receipts_v2 r ON r.work_cell_id=c.work_cell_id
      WHERE c.goal_id=? AND c.route_id=? AND r.contract_id=?
        AND r.revision=(SELECT MAX(x.revision) FROM work_cell_completion_receipts_v2 x WHERE x.work_cell_id=c.work_cell_id)
      ORDER BY c.ordinal`).all(
      text(head, "goal_id"), text(head, "route_id"), text(head, "contract_id"),
    ) as Record<string, unknown>[];
    const expected = integer(this.connection.prepare("SELECT count(*) count FROM work_cells_v1 WHERE goal_id=? AND route_id=?")
      .get(text(head, "goal_id"), text(head, "route_id")) as Record<string, unknown>, "count");
    if (expected === 0 || rows.length !== expected) {
      throw new AuthorityIntegrityError("Deliverable V2 lacks current completion receipts for every WorkCell");
    }
    return rows;
  }

  private finalEvidence(head: Record<string, unknown>): readonly FinalEvidenceMemberV2[] {
    const rows = this.connection.prepare(`SELECT r.evidence_requirement_id,e.evidence_binding_id,e.work_cell_id,
        e.record_sha256,e.created_event_sequence
      FROM acceptance_authority_requirement_members_v2 m
      JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=m.evidence_requirement_id
      LEFT JOIN acceptance_evidence_bindings_v2 e ON e.authority_root_id=m.authority_root_id
        AND e.evidence_requirement_id=r.evidence_requirement_id
      LEFT JOIN oracle_pass_receipts_v2 p ON p.pass_receipt_id=e.pass_receipt_id
      WHERE m.authority_root_id=? AND p.postimage_root_sha256=? AND p.environment_sha256=?
      ORDER BY r.evidence_requirement_id,e.created_event_sequence DESC`).all(
      text(head, "authority_root_id"), text(head, "content_root_sha256"), text(head, "environment_sha256"),
    ) as Record<string, unknown>[];
    const latest = new Map<string, FinalEvidenceMemberV2>();
    for (const row of rows) {
      const requirementId = text(row, "evidence_requirement_id");
      if (!latest.has(requirementId)) latest.set(requirementId, {
        evidence_binding_id: text(row, "evidence_binding_id"),
        work_cell_id: text(row, "work_cell_id"),
        record_sha256: sha(row.record_sha256, "Final evidence binding SHA-256"),
      });
    }
    const required = integer(this.connection.prepare(`SELECT count(*) count
      FROM acceptance_authority_requirement_members_v2 WHERE authority_root_id=?`)
      .get(text(head, "authority_root_id")) as Record<string, unknown>, "count");
    if (required === 0 || latest.size !== required) {
      throw new AuthorityIntegrityError("Deliverable V2 lacks final-baseline evidence for every Acceptance requirement");
    }
    return [...latest.values()];
  }

  private insertManifest(manifest: DeliverableManifestV2, stamp: DeliveryTransactionStampV2): void {
    this.connection.prepare(`INSERT INTO deliverable_manifests_v2(
      deliverable_manifest_id,goal_id,contract_id,route_id,authority_root_id,revision,final_baseline_id,
      final_postimage_root_sha256,completion_root_sha256,evidence_root_sha256,artifact_root_sha256,
      predecessor_authority_head_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      manifest.deliverable_manifest_id, manifest.goal_id, manifest.contract_id, manifest.route_id,
      manifest.authority_root_id, manifest.revision, manifest.final_baseline_id, manifest.final_postimage_root_sha256,
      manifest.completion_root_sha256, manifest.evidence_root_sha256, manifest.artifact_root_sha256,
      manifest.predecessor_authority_head_sha256, manifest.record_sha256, stamp.created_at_ms, stamp.created_event_sequence,
    );
  }

  private insertMembers(
    manifest: DeliverableManifestV2,
    completionIds: readonly string[],
    evidence: readonly FinalEvidenceMemberV2[],
    artifacts: readonly DeliverableArtifactMemberV2[],
    sequence: number,
  ): void {
    const completionInsert = this.connection.prepare(`INSERT INTO deliverable_completion_members_v2(
      deliverable_manifest_id,completion_receipt_id,authority_root_id,goal_id,contract_id,route_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    completionIds.forEach((id, ordinal) => completionInsert.run(manifest.deliverable_manifest_id, id,
      manifest.authority_root_id, manifest.goal_id, manifest.contract_id, manifest.route_id, ordinal, sequence));
    const evidenceInsert = this.connection.prepare(`INSERT INTO deliverable_evidence_members_v2(
      deliverable_manifest_id,evidence_binding_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    evidence.forEach((entry, ordinal) => evidenceInsert.run(manifest.deliverable_manifest_id,
      entry.evidence_binding_id, manifest.authority_root_id, manifest.goal_id, manifest.contract_id,
      manifest.route_id, entry.work_cell_id, ordinal, sequence));
    const artifactInsert = this.connection.prepare(`INSERT INTO deliverable_artifact_members_v2(
      deliverable_manifest_id,goal_id,contract_id,route_id,artifact_id,artifact_sha256,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    artifacts.forEach((artifact, ordinal) => artifactInsert.run(manifest.deliverable_manifest_id, manifest.goal_id,
      manifest.contract_id, manifest.route_id, artifact.artifact_id, artifact.artifact_sha256, ordinal, sequence));
  }

  verifyIntegrity(): { readonly deliverables: number } {
    const rows = this.connection.prepare("SELECT * FROM deliverable_manifests_v2 ORDER BY deliverable_manifest_id")
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const manifestId = text(row, "deliverable_manifest_id");
      assertSealed("PCH-DELIVERABLE-MANIFEST-V2", {
        schema_version: 2, deliverable_manifest_id: manifestId, goal_id: text(row, "goal_id"),
        contract_id: text(row, "contract_id"), route_id: text(row, "route_id"),
        authority_root_id: text(row, "authority_root_id"), revision: integer(row, "revision"),
        final_baseline_id: text(row, "final_baseline_id"), final_postimage_root_sha256: text(row, "final_postimage_root_sha256"),
        completion_root_sha256: text(row, "completion_root_sha256"), evidence_root_sha256: text(row, "evidence_root_sha256"),
        artifact_root_sha256: text(row, "artifact_root_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        record_sha256: text(row, "record_sha256"),
      });
      const completions = this.connection.prepare(`SELECT r.record_sha256,m.ordinal
        FROM deliverable_completion_members_v2 m JOIN work_cell_completion_receipts_v2 r
          ON r.completion_receipt_id=m.completion_receipt_id
        WHERE m.deliverable_manifest_id=? ORDER BY m.ordinal`).all(manifestId) as Record<string, unknown>[];
      const evidence = this.connection.prepare(`SELECT e.record_sha256,m.ordinal
        FROM deliverable_evidence_members_v2 m JOIN acceptance_evidence_bindings_v2 e
          ON e.evidence_binding_id=m.evidence_binding_id
        WHERE m.deliverable_manifest_id=? ORDER BY m.ordinal`).all(manifestId) as Record<string, unknown>[];
      const artifacts = this.connection.prepare(`SELECT m.artifact_id,m.artifact_sha256,m.ordinal
        FROM deliverable_artifact_members_v2 m WHERE m.deliverable_manifest_id=? ORDER BY m.ordinal`)
        .all(manifestId) as Record<string, unknown>[];
      for (const members of [completions, evidence, artifacts]) members.forEach((member, ordinal) => {
        if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Deliverable V2 member ordinal gap");
      });
      const artifactHashes = artifacts.map((member) => canonicalJsonSha256({
        domain: "PCH-DELIVERABLE-ARTIFACT-MEMBER-V2",
        artifact_id: text(member, "artifact_id"), artifact_sha256: sha(member.artifact_sha256, "Deliverable artifact SHA-256"),
      }));
      if (memberRoot("PCH-DELIVERABLE-COMPLETION-ROOT-V2", completions.map((member) => sha(member.record_sha256, "Deliverable completion SHA-256")))
          !== text(row, "completion_root_sha256")
        || memberRoot("PCH-DELIVERABLE-EVIDENCE-ROOT-V2", evidence.map((member) => sha(member.record_sha256, "Deliverable evidence SHA-256")))
          !== text(row, "evidence_root_sha256")
        || memberRoot("PCH-DELIVERABLE-ARTIFACT-ROOT-V2", artifactHashes) !== text(row, "artifact_root_sha256")) {
        throw new AuthorityIntegrityError("Deliverable V2 member closure mismatch");
      }
    }
    return { deliverables: rows.length };
  }
}
