import type { PerformanceContract } from "./contract.js";

export type PerformanceOpportunitySource = PerformanceContract["opportunity_admission"]["allowed_sources"][number];

export interface PerformanceOpportunity {
  readonly opportunityId: string;
  readonly source: PerformanceOpportunitySource;
  readonly evidenceReceiptId: string;
  readonly evidenceSha256: string;
  readonly scope: readonly string[];
  readonly hypothesis: string;
  readonly endToEndMetricIds: readonly string[];
  readonly measuredHotspotFraction: number | null;
  readonly theoreticalSpeedupCeilingPct: number | null;
  readonly reversible: true;
  readonly rollbackAction: string;
}

export interface OpportunityAdmission {
  readonly opportunityId: string;
  readonly result: "PASS" | "ADVICE_ONLY" | "REJECT";
  readonly reasonCodes: readonly string[];
  readonly admittedScope: readonly string[];
  readonly endToEndMetricIds: readonly string[];
  readonly evidenceReceiptId: string;
  readonly evidenceSha256: string;
  readonly hotspotFraction: number | null;
  readonly theoreticalSpeedupCeilingPct: number | null;
  readonly additionalModelRequests: 0;
}
