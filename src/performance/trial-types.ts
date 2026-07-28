import type { ArtifactMetadata } from "../authority/repositories/common.js";
import type { LeaseToken } from "../authority/lease.js";
import type { PerformanceContract } from "./contract.js";
import type { OpportunityAdmission } from "./opportunities.js";

export type TrialGate = "PASS" | "FAIL" | "INSUFFICIENT" | "NOT_APPLICABLE";

export interface PerformanceVerdictEstimate {
  readonly workload_id: string;
  readonly workload_role: "PRIMARY" | "REGRESSION" | "HOLDOUT";
  readonly metric_id: string;
  readonly pair_count: number;
  readonly baseline_point: number;
  readonly candidate_point: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly unit: string;
  readonly confidence_level: number;
  readonly method: "PAIRED_BOOTSTRAP" | "PAIRED_NONPARAMETRIC";
}

export interface PerformanceTrialSpec {
  readonly schema_version: 1;
  readonly trial_id: string;
  readonly opportunity_id: string;
  readonly epoch_id: string;
  readonly goal_id: string;
  readonly stage_id: string;
  readonly work_item_id: string;
  readonly plan_revision_id: string;
  readonly performance_contract_id: string;
  readonly performance_contract_sha256: string;
  readonly baseline_revision_sha256: string;
  readonly baseline_correctness_receipt_id: string;
  readonly baseline_metric_evidence_sha256: string;
  readonly environment_fingerprint_sha256: string;
  readonly candidate_patch_sha256: string;
  readonly hypothesis: string;
  readonly opportunity_admission: {
    readonly source: PerformanceContract["opportunity_admission"]["allowed_sources"][number];
    readonly evidence_receipt_id: string;
    readonly hotspot_fraction: number | null;
    readonly theoretical_speedup_ceiling_pct: number;
    readonly end_to_end_metric_ids: readonly string[];
    readonly result: "PASS";
  };
  readonly scope: readonly string[];
  readonly workload_ids: readonly string[];
  readonly holdout_workload_ids: readonly string[];
  readonly metric_ids: readonly string[];
  readonly correctness_acceptance_ids: readonly string[];
  readonly protocol_sha256: string;
  readonly candidate_family_id: string;
  readonly candidate_index: number;
  readonly authorization: {
    readonly kind: "AUTO_WITHIN_FROZEN_CONTRACT" | "USER_DECISION";
    readonly decision_id: string | null;
  };
  readonly automatic_promotion_eligible: boolean;
  readonly reversible: true;
  readonly rollback_action: string;
  readonly kill_conditions: readonly string[];
  readonly created_at: string;
}

export interface PerformanceVerdictRecord {
  readonly schema_version: 1;
  readonly verdict_id: string;
  readonly trial_id: string;
  readonly sequence: number;
  readonly analysis_population: "ALL_PREDECLARED_VALID_PAIRS";
  readonly sample_set_sha256: string;
  readonly statistics_sha256: string;
  readonly estimates: readonly PerformanceVerdictEstimate[];
  readonly gates: {
    readonly correctness: TrialGate;
    readonly confidence: TrialGate;
    readonly practical_effect: TrialGate;
    readonly end_to_end: TrialGate;
    readonly regression: TrialGate;
    readonly holdout: TrialGate;
    readonly benefit_horizon: TrialGate;
    readonly environment: TrialGate;
    readonly budget: TrialGate;
  };
  readonly verdict: "PROMOTE" | "REJECT" | "NEED_MORE_EVIDENCE" | "CANCELED";
  readonly reason: string;
  readonly recorded_at: string;
}

export interface PerformanceTrialArtifacts {
  readonly preregistration: ArtifactMetadata;
  readonly contract: ArtifactMetadata;
  readonly trialSpec: ArtifactMetadata;
  readonly admission: ArtifactMetadata;
  readonly candidatePatch: ArtifactMetadata;
}

export interface PerformanceTrialAuthorityInput {
  readonly spec: PerformanceTrialSpec;
  readonly admission: OpportunityAdmission;
  readonly artifacts: PerformanceTrialArtifacts;
  readonly runtimeConfigSha256: string;
  readonly arm: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly lease: LeaseToken;
}
