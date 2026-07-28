import type { DataClassification } from "../../artifacts/classify.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import type { AuthorityConnection } from "../database.js";

export interface EvidenceArtifactView {
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly classification: DataClassification;
  readonly locator: string;
  readonly retentionClass: string;
  readonly role: string;
}

export interface EvidenceReceiptView {
  readonly receiptId: string;
  readonly receiptType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly result: string;
  readonly issuer: string;
  readonly outputSha256: string | null;
  readonly issuedAtMs: number;
  readonly issuedEventSequence: number;
}

export interface EvidenceLookup {
  readonly queryId: string;
  readonly receipts: readonly EvidenceReceiptView[];
  readonly artifacts: readonly EvidenceArtifactView[];
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Evidence ${field} must be text`);
  return value;
}

export class EvidenceRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  read(goalId: string, queryId: string): EvidenceLookup {
    const rows = this.connection.prepare(`SELECT
      r.receipt_id,r.receipt_type,r.subject_type,r.subject_id,r.result,r.issuer,r.output_sha256,
      r.issued_at_ms,r.issued_event_sequence,ra.role,
      a.artifact_id,a.sha256,a.byte_length,a.media_type,a.classification,a.locator,a.retention_class
      FROM receipts r
      LEFT JOIN receipt_artifacts ra ON ra.receipt_id=r.receipt_id
      LEFT JOIN artifacts a ON a.artifact_id=ra.artifact_id
      WHERE r.goal_id=? AND (r.receipt_id=? OR r.subject_id=? OR a.artifact_id=?)
      ORDER BY r.issued_event_sequence,r.receipt_id,ra.role,a.artifact_id`).all(
      goalId, queryId, queryId, queryId,
    ) as Record<string, unknown>[];
    const receipts = new Map<string, EvidenceReceiptView>();
    const artifacts = new Map<string, EvidenceArtifactView>();
    for (const row of rows) {
      const receiptId = requiredText(row.receipt_id, "receipt_id");
      receipts.set(receiptId, {
        receiptId,
        receiptType: requiredText(row.receipt_type, "receipt_type"),
        subjectType: requiredText(row.subject_type, "subject_type"),
        subjectId: requiredText(row.subject_id, "subject_id"),
        result: requiredText(row.result, "result"),
        issuer: requiredText(row.issuer, "issuer"),
        outputSha256: row.output_sha256 === null ? null : requiredText(row.output_sha256, "output_sha256"),
        issuedAtMs: Number(row.issued_at_ms),
        issuedEventSequence: Number(row.issued_event_sequence),
      });
      if (row.artifact_id === null) continue;
      const artifactId = requiredText(row.artifact_id, "artifact_id");
      artifacts.set(artifactId, {
        artifactId,
        sha256: requiredText(row.sha256, "artifact.sha256"),
        byteLength: Number(row.byte_length),
        mediaType: requiredText(row.media_type, "artifact.media_type"),
        classification: requiredText(row.classification, "artifact.classification") as DataClassification,
        locator: requiredText(row.locator, "artifact.locator"),
        retentionClass: requiredText(row.retention_class, "artifact.retention_class"),
        role: requiredText(row.role, "artifact.role"),
      });
    }
    return { queryId, receipts: [...receipts.values()], artifacts: [...artifacts.values()] };
  }
}
