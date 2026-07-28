import type { EvidenceCatalog, MutationEvidenceCheck } from "./evidence-catalog.js";

export interface MutationGuardDecision {
  readonly allow: boolean;
  readonly reasonCode: "CURRENT_SOURCE_PROVEN" | "NO_CURRENT_SOURCE_PROOF";
  readonly checks: readonly MutationEvidenceCheck[];
}

export class InputContextMutationGuard {
  constructor(private readonly catalog: EvidenceCatalog) {}

  prepare(requiredReceiptIds: readonly string[]): MutationGuardDecision {
    if (requiredReceiptIds.length === 0) {
      return { allow: true, reasonCode: "CURRENT_SOURCE_PROVEN", checks: [] };
    }
    const checks = this.catalog.checkMutationEvidence([...new Set(requiredReceiptIds)]);
    return {
      allow: checks.every((check) => check.valid),
      reasonCode: checks.every((check) => check.valid) ? "CURRENT_SOURCE_PROVEN" : "NO_CURRENT_SOURCE_PROOF",
      checks,
    };
  }
}
