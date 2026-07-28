export type RetentionMode = "UNKNOWN" | "PROVIDER_EPHEMERAL" | "VERIFIED_TTL" | "VERIFIED_SESSION";

export interface RetentionContractEvidence {
  readonly receiptSha256: string;
  readonly mode: Exclude<RetentionMode, "UNKNOWN">;
  readonly verifiedMinTtlMs: number | null;
  readonly affinityVerified: boolean;
}

export interface RetentionEvaluation {
  readonly contractReceiptSha256: string | null;
  readonly mode: RetentionMode;
  readonly verifiedMinTtlMs: number | null;
  readonly interRequestGapMs: number | null;
  readonly withinVerifiedWindow: boolean | null;
  readonly affinityVerified: boolean;
}

export function evaluateRetention(
  evidence: RetentionContractEvidence | null,
  previousRequestAtMs: number | null,
  requestAtMs: number,
): RetentionEvaluation {
  const gap = previousRequestAtMs === null ? null : Math.max(0, requestAtMs - previousRequestAtMs);
  if (!evidence || !/^[a-f0-9]{64}$/u.test(evidence.receiptSha256)) {
    return {
      contractReceiptSha256: null,
      mode: "UNKNOWN",
      verifiedMinTtlMs: null,
      interRequestGapMs: gap,
      withinVerifiedWindow: null,
      affinityVerified: false,
    };
  }
  if (evidence.mode === "VERIFIED_TTL") {
    if (!Number.isSafeInteger(evidence.verifiedMinTtlMs) || (evidence.verifiedMinTtlMs ?? -1) < 0) {
      throw new TypeError("VERIFIED_TTL requires a non-negative verified minimum TTL");
    }
    return {
      contractReceiptSha256: evidence.receiptSha256,
      mode: evidence.mode,
      verifiedMinTtlMs: evidence.verifiedMinTtlMs,
      interRequestGapMs: gap,
      withinVerifiedWindow: gap === null ? null : gap <= (evidence.verifiedMinTtlMs ?? 0),
      affinityVerified: evidence.affinityVerified,
    };
  }
  return {
    contractReceiptSha256: evidence.receiptSha256,
    mode: evidence.mode,
    verifiedMinTtlMs: evidence.verifiedMinTtlMs,
    interRequestGapMs: gap,
    withinVerifiedWindow: gap === null ? null : evidence.affinityVerified,
    affinityVerified: evidence.affinityVerified,
  };
}
