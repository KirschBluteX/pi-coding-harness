import { canonicalJson, canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";

export interface ReceiptInput {
  readonly receiptId: string;
  readonly goalId: string;
  readonly receiptType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly attemptId?: string | null;
  readonly result: "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNKNOWN_OUTCOME" | "WAIVED";
  readonly inputClosureSha256: string;
  readonly outputSha256: string | null;
  readonly failureSignatureSha256?: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly issuer: string;
  readonly issuedAtMs: number;
  readonly issuedEventSequence: number;
}

export class ReceiptRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insert(input: ReceiptInput): void {
    const bodyJson = canonicalJson(input.body);
    this.connection.prepare(`INSERT INTO receipts(
      receipt_id, goal_id, receipt_type, subject_type, subject_id, attempt_id, result,
      input_closure_sha256, output_sha256, failure_signature_sha256, body_json, issuer,
      issued_at_ms, issued_event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.receiptId, input.goalId, input.receiptType, input.subjectType, input.subjectId,
      input.attemptId ?? null, input.result,
      input.inputClosureSha256, input.outputSha256, input.failureSignatureSha256 ?? null, bodyJson,
      input.issuer, input.issuedAtMs, input.issuedEventSequence,
    );
  }

  linkArtifact(receiptId: string, artifactId: string, role: string): void {
    this.connection.prepare("INSERT INTO receipt_artifacts(receipt_id,artifact_id,role) VALUES(?,?,?)")
      .run(receiptId, artifactId, role);
  }

  bodySha256(receiptId: string): string | null {
    const row = this.connection.prepare("SELECT body_json FROM receipts WHERE receipt_id = ?").get(receiptId) as { body_json?: unknown } | undefined;
    return typeof row?.body_json === "string" ? canonicalJsonSha256(JSON.parse(row.body_json) as unknown) : null;
  }
}
