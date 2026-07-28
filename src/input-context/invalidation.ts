import { idFromSha256 } from "../foundation/ids.js";
import { sha256Hex } from "../foundation/crypto.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type {
  EvidenceValidityAxis, EvidenceValidityTransitionRecord, ReadEvidenceReceiptRecord,
} from "./domain.js";

export function evidenceInvalidation(input: {
  readonly receipt: ReadEvidenceReceiptRecord;
  readonly axis: EvidenceValidityAxis;
  readonly value: EvidenceValidityTransitionRecord["value"];
  readonly reasonCode: string;
  readonly evidenceSha256: string;
  readonly createdAtMs: number;
}): EvidenceValidityTransitionRecord {
  const identity = sha256Hex([
    input.receipt.receipt_id, input.axis, input.value, input.reasonCode,
    input.evidenceSha256, String(input.createdAtMs),
  ].join("\0"));
  return sealInputContextRecord(inputContextHashDomains.evidenceValidityTransition, "transition_sha256", {
    transition_id: idFromSha256("IC_INVALID", identity),
    receipt_id: input.receipt.receipt_id,
    axis: input.axis,
    value: input.value,
    reason_code: input.reasonCode,
    evidence_sha256: input.evidenceSha256,
    created_at_ms: input.createdAtMs,
  });
}
