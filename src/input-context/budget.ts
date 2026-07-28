export interface ContextBudgetInput {
  readonly contextWindowTokens: number | null;
  readonly currentInputTokens: number | null;
  readonly outputReserveTokens: number;
  readonly softEvidenceTokens: number;
  readonly hardEvidenceTokens: number;
}

export interface ContextBudget {
  readonly evidenceTokens: number;
  readonly source: "KNOWN_WINDOW" | "SOFT_UNKNOWN_WINDOW";
  readonly pressure: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
}

function boundedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

export function allocateContextBudget(input: ContextBudgetInput): ContextBudget {
  boundedInteger(input.outputReserveTokens, "outputReserveTokens");
  boundedInteger(input.softEvidenceTokens, "softEvidenceTokens");
  boundedInteger(input.hardEvidenceTokens, "hardEvidenceTokens");
  if (input.softEvidenceTokens > input.hardEvidenceTokens) throw new TypeError("soft evidence budget exceeds hard budget");
  if (input.contextWindowTokens === null || input.currentInputTokens === null) {
    return { evidenceTokens: input.softEvidenceTokens, source: "SOFT_UNKNOWN_WINDOW", pressure: "UNKNOWN" };
  }
  boundedInteger(input.contextWindowTokens, "contextWindowTokens");
  boundedInteger(input.currentInputTokens, "currentInputTokens");
  const headroom = Math.max(0, input.contextWindowTokens - input.currentInputTokens - input.outputReserveTokens);
  const evidenceTokens = Math.min(input.hardEvidenceTokens, headroom);
  const ratio = input.contextWindowTokens === 0 ? 1 : input.currentInputTokens / input.contextWindowTokens;
  return {
    evidenceTokens,
    source: "KNOWN_WINDOW",
    pressure: ratio >= 0.9 ? "HIGH" : ratio >= 0.7 ? "MEDIUM" : "LOW",
  };
}
