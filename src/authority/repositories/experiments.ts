import type { ProtectedRef } from "../../context/protected-projection.js";
import type { PromptGenerationRecord } from "../../context/prompt-generation.js";
import type { PromptRequestRecord } from "../../context/prompt-request.js";
import type { CacheEpochPreregistration, CacheObservationRecord } from "../../cache/telemetry.js";
import type { ArtifactMetadata } from "./common.js";
import type { TrialPairSample } from "../../performance/benchmark-harness.js";
import type { OpportunityAdmission } from "../../performance/opportunities.js";
import type { PerformanceTrialSpec, PerformanceVerdictRecord } from "../../performance/trial-types.js";
import { AuthorityIntegrityError, AuthorityNotFoundError } from "../../foundation/errors.js";
import { canonicalJson, canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";

export interface ExperimentEpochInput {
  readonly epochId: string;
  readonly arm: string;
  readonly runtimeFingerprintSha256: string;
  readonly configSha256: string;
  readonly preregistrationArtifactId: string;
}

export interface TrialWorkAttemptInput {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseGeneration: number;
  readonly fencingToken: number;
}

export interface ActivePerformanceTrialMaterial {
  readonly trialId: string;
  readonly opportunityId: string;
  readonly epochId: string;
  readonly goalId: string;
  readonly stageId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly planId: string;
  readonly runtimeFingerprintSha256: string;
  readonly specArtifactId: string;
  readonly specArtifactSha256: string;
  readonly specArtifactLocator: string;
  readonly ref: ProtectedRef;
}

export interface CacheAuthorityRecordInput {
  readonly goalId: string;
  readonly epoch: { readonly record: CacheEpochPreregistration; readonly artifact: ArtifactMetadata };
  readonly generations: readonly {
    readonly record: PromptGenerationRecord;
    readonly artifact: ArtifactMetadata;
    readonly epochId: string | null;
  }[];
  readonly requests: readonly { readonly record: PromptRequestRecord; readonly artifact: ArtifactMetadata }[];
  readonly observation: { readonly record: CacheObservationRecord; readonly artifact: ArtifactMetadata };
}

export interface CacheDiagnostic {
  readonly latest: null | {
    readonly observationId: string;
    readonly epochId: string;
    readonly promptRequestId: string;
    readonly requestSequence: number;
    readonly state: string;
    readonly eligibilityReason: string;
    readonly eligible: boolean;
    readonly cacheReadTokens: number | null;
    readonly eligiblePrefixTokens: number | null;
    readonly piCompatibleLatestHitRate: number | null;
    readonly warmEligibleTokenHitRate: number | null;
    readonly latencyMs: number | null;
    readonly recordedAtMs: number;
  };
  readonly cohort: null | {
    readonly epochId: string;
    readonly totalRequests: number;
    readonly eligibleRequests: number;
    readonly observableWarmRequests: number;
    readonly hits: number;
    readonly misses: number;
    readonly unobservable: number;
    readonly errors: number;
    readonly warmEligibleRequestHitRate: number | null;
    readonly warmEligibleTokenHitRate: number | null;
    readonly effectiveInputTokenHitRate: number | null;
    readonly observableWarmCoverage: number | null;
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Experiment field ${field} must be text`);
  return value;
}

function gateForSql(gate: string): "PASS" | "FAIL" | "INSUFFICIENT" {
  return gate === "PASS" ? "PASS" : gate === "FAIL" ? "FAIL" : "INSUFFICIENT";
}

function recordedAtMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new AuthorityIntegrityError(`${label} recorded_at is invalid`);
  return parsed;
}

function assertStoredIdentity(
  row: Record<string, unknown> | undefined,
  expected: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (!row) throw new AuthorityIntegrityError(`${label} was not persisted`);
  for (const [field, value] of Object.entries(expected)) {
    if ((row[field] ?? null) !== (value ?? null)) {
      throw new AuthorityIntegrityError(`${label} identity substitution detected at ${field}`);
    }
  }
}

export class ExperimentRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertTrial(
    spec: PerformanceTrialSpec,
    admission: OpportunityAdmission,
    epoch: ExperimentEpochInput,
    attempt: TrialWorkAttemptInput,
    artifacts: { readonly contractId: string; readonly trialSpecId: string; readonly admissionId: string; readonly candidatePatchId: string },
    nowMs: number,
    eventSequence: number,
  ): void {
    const stage = this.connection.prepare("SELECT plan_id,goal_id FROM plan_stages WHERE stage_id=?").get(spec.stage_id) as Record<string, unknown> | undefined;
    if (!stage || stage.plan_id !== spec.plan_revision_id || stage.goal_id !== spec.goal_id) {
      throw new AuthorityIntegrityError("PerformanceTrial Stage/Plan/Goal binding failed");
    }
    const baseline = this.connection.prepare("SELECT goal_id,result,output_sha256 FROM receipts WHERE receipt_id=?").get(spec.baseline_correctness_receipt_id) as Record<string, unknown> | undefined;
    if (!baseline || baseline.goal_id !== spec.goal_id || baseline.result !== "SUCCEEDED"
      || baseline.output_sha256 !== spec.baseline_metric_evidence_sha256) {
      throw new AuthorityIntegrityError("PerformanceTrial requires a successful baseline correctness receipt");
    }
    const evidence = this.connection.prepare("SELECT goal_id,result,output_sha256 FROM receipts WHERE receipt_id=?").get(admission.evidenceReceiptId) as Record<string, unknown> | undefined;
    if (!evidence || evidence.goal_id !== spec.goal_id || evidence.result !== "SUCCEEDED"
      || evidence.output_sha256 !== admission.evidenceSha256) {
      throw new AuthorityIntegrityError("PerformanceTrial opportunity evidence receipt is missing or failed");
    }
    this.connection.prepare(`INSERT OR IGNORE INTO experiment_epochs(
      epoch_id,module,arm,runtime_fingerprint_sha256,config_sha256,preregistration_artifact_id,created_event_sequence,created_at_ms
    ) VALUES(?,'PERFORMANCE',?,?,?,?,?,?)`).run(
      epoch.epochId, epoch.arm, epoch.runtimeFingerprintSha256, epoch.configSha256,
      epoch.preregistrationArtifactId, eventSequence, nowMs,
    );
    const storedEpoch = this.connection.prepare("SELECT module,arm,runtime_fingerprint_sha256,config_sha256,preregistration_artifact_id FROM experiment_epochs WHERE epoch_id=?")
      .get(epoch.epochId) as Record<string, unknown> | undefined;
    if (!storedEpoch || storedEpoch.module !== "PERFORMANCE" || storedEpoch.arm !== epoch.arm
      || storedEpoch.runtime_fingerprint_sha256 !== epoch.runtimeFingerprintSha256
      || storedEpoch.config_sha256 !== epoch.configSha256
      || storedEpoch.preregistration_artifact_id !== epoch.preregistrationArtifactId) {
      throw new AuthorityIntegrityError("Experiment epoch identity substitution detected");
    }
    const transition = this.connection.prepare("SELECT count(*) AS count FROM experiment_epoch_transitions WHERE epoch_id=?").get(epoch.epochId) as { count?: unknown } | undefined;
    if (Number(transition?.count ?? 0) === 0) {
      this.connection.prepare("INSERT INTO experiment_epoch_transitions(epoch_id,sequence,status,reason_code,evidence_artifact_id,created_event_sequence,recorded_at_ms) VALUES(?,1,'RUNNING','TRIAL_AUTHORIZED',?,?,?)")
        .run(epoch.epochId, artifacts.trialSpecId, eventSequence, nowMs);
    }
    const actionSpec = {
      kind: "TARGET_PROJECT_PERFORMANCE_TRIAL",
      trialId: spec.trial_id,
      opportunityId: spec.opportunity_id,
      scope: spec.scope,
      workloadIds: spec.workload_ids,
      metricIds: spec.metric_ids,
    };
    const workSpecSha256 = canonicalJsonSha256(actionSpec);
    this.connection.prepare(`INSERT INTO work_items(
      work_item_id,goal_id,plan_id,stage_id,logical_key,action_spec_json,effect_class,spec_sha256,declared_input_closure_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,'READ_ONLY',?,?,?)`).run(
      spec.work_item_id, spec.goal_id, spec.plan_revision_id, spec.stage_id, `performance:${spec.opportunity_id}`,
      canonicalJson(actionSpec), workSpecSha256, spec.performance_contract_sha256, eventSequence,
    );
    this.connection.prepare("INSERT INTO attempts(attempt_id,work_item_id,attempt_number,lease_generation,fencing_token,started_at_ms) VALUES(?,?,?,?,?,?)")
      .run(attempt.attemptId, spec.work_item_id, attempt.attemptNumber, attempt.leaseGeneration, attempt.fencingToken, nowMs);
    this.connection.prepare(`INSERT INTO performance_trials(
      trial_id,opportunity_id,epoch_id,goal_id,stage_id,work_item_id,attempt_id,plan_id,contract_artifact_id,
      trial_spec_artifact_id,opportunity_admission_artifact_id,baseline_revision_sha256,
      baseline_correctness_receipt_id,baseline_metric_evidence_sha256,candidate_patch_sha256,candidate_patch_artifact_id,protocol_sha256,
      runtime_fingerprint_sha256,candidate_family_id,candidate_index,created_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      spec.trial_id, spec.opportunity_id, spec.epoch_id, spec.goal_id, spec.stage_id, spec.work_item_id,
      attempt.attemptId, spec.plan_revision_id, artifacts.contractId, artifacts.trialSpecId, artifacts.admissionId,
      spec.baseline_revision_sha256, spec.baseline_correctness_receipt_id, spec.baseline_metric_evidence_sha256,
      spec.candidate_patch_sha256, artifacts.candidatePatchId, spec.protocol_sha256, spec.environment_fingerprint_sha256,
      spec.candidate_family_id, spec.candidate_index, nowMs,
    );
  }

  insertSamples(spec: PerformanceTrialSpec, samples: readonly TrialPairSample[], nowMs: number): void {
    const trial = this.trial(spec.trial_id);
    if (trial.goal_id !== spec.goal_id || trial.plan_id !== spec.plan_revision_id
      || trial.runtime_fingerprint_sha256 !== spec.environment_fingerprint_sha256) {
      throw new AuthorityIntegrityError("Trial authority binding changed before sample persistence");
    }
    for (const sample of samples) {
      if (sample.trialId !== spec.trial_id || sample.environmentFingerprintSha256 !== spec.environment_fingerprint_sha256) {
        throw new AuthorityIntegrityError("Performance sample trial or environment substitution");
      }
      const metrics = {
        direction: sample.metricDirection,
        unit: sample.unit,
        value: sample.value,
        workload_role: sample.workloadRole,
      };
      this.connection.prepare(`INSERT INTO telemetry_samples(
        sample_id,epoch_id,trial_id,goal_id,cohort_id,sample_cluster_id,request_sequence,runtime_fingerprint_sha256,
        metric_scope,sample_role,workload_id,metric_id,pair_id,sample_index,order_in_pair,task_class,
        metrics_json,metrics_sha256,quality_gate,recorded_at_ms
      ) VALUES(?,?,?,?,?,?,NULL,?,'TARGET_PROJECT',?,?,?,?,?,?,'PERFORMANCE_TRIAL',?,?,?,?)`).run(
        sample.sampleId, spec.epoch_id, spec.trial_id, spec.goal_id,
        `${spec.trial_id}:${sample.workloadId}:${sample.metricId}`, sample.pairId,
        sample.environmentFingerprintSha256, sample.sampleRole, sample.workloadId, sample.metricId,
        sample.pairId, sample.pairIndex, sample.orderInPair, canonicalJson(metrics), canonicalJsonSha256(metrics),
        sample.qualityGate, sample.observedAtMs || nowMs,
      );
    }
  }

  insertPromptGeneration(
    goalId: string,
    record: PromptGenerationRecord,
    artifact: ArtifactMetadata,
    epochId: string | null,
  ): void {
    if (record.schema_version !== 3 || record.contains_prompt_content !== false) {
      throw new AuthorityIntegrityError("PromptGeneration observation contract is invalid");
    }
    const values = {
      parent_prompt_generation_id: record.parent_prompt_generation_id,
      epoch_id: epochId,
      goal_id: goalId,
      logical_session_hmac_sha256: record.logical_session_hmac_sha256,
      transport_epoch_hmac_sha256: record.transport_epoch_hmac_sha256,
      cache_lineage_hmac_sha256: record.cache_lineage_hmac_sha256,
      lineage_action: record.lineage_action,
      prefix_generation: record.prefix_generation,
      generation_action: record.generation_action,
      boundary_reason: record.boundary_reason,
      boundary_policy: record.boundary_policy,
      coalesced_change_count: record.coalesced_change_count,
      stable_contract_prefix_hmac_sha256: record.stable_contract_prefix_hmac_sha256,
      provider_prompt_contract_prefix_hmac_sha256: record.provider_prompt_contract_prefix_hmac_sha256,
      prefix_segment_manifest_sha256: record.prefix_segment_manifest_sha256,
      stable_policy_tokens: record.stable_policy_tokens,
      tool_schema_tokens: record.tool_schema_tokens,
      generation_artifact_id: artifact.artifactId,
      recorded_at_ms: recordedAtMs(record.recorded_at, "PromptGeneration"),
    };
    this.connection.prepare(`INSERT OR IGNORE INTO prompt_generations(
      prompt_generation_id,${Object.keys(values).join(",")}
    ) VALUES(${Array.from({ length: Object.keys(values).length + 1 }, () => "?").join(",")})`)
      .run(record.prompt_generation_id, ...Object.values(values));
    const stored = this.connection.prepare(`SELECT ${Object.keys(values).join(",")} FROM prompt_generations
      WHERE prompt_generation_id=?`).get(record.prompt_generation_id) as Record<string, unknown> | undefined;
    const stableExpected = Object.fromEntries(Object.entries(values).filter(([field]) => field !== "epoch_id"));
    assertStoredIdentity(stored, stableExpected, `PromptGeneration ${record.prompt_generation_id}`);
    if (stored?.epoch_id !== null && epochId !== null && stored?.epoch_id !== epochId) {
      throw new AuthorityIntegrityError(`PromptGeneration ${record.prompt_generation_id} epoch substitution detected`);
    }
  }

  insertPromptRequest(record: PromptRequestRecord, artifact: ArtifactMetadata): void {
    if (record.schema_version !== 2 || record.contains_prompt_content !== false) {
      throw new AuthorityIntegrityError("PromptRequest observation contract is invalid");
    }
    const expected = {
      prompt_generation_id: record.prompt_generation_id,
      previous_prompt_request_id: record.previous_prompt_request_id,
      request_sequence: record.request_sequence,
      history_action: record.history_action,
      append_only_verification: record.append_only_verification,
      logical_request_hmac_sha256: record.logical_request_hmac_sha256,
      logical_reusable_prefix_hmac_sha256: record.logical_reusable_prefix_hmac_sha256,
      provider_prompt_hmac_sha256: record.provider_prompt_hmac_sha256,
      provider_prompt_reusable_prefix_hmac_sha256: record.provider_prompt_reusable_prefix_hmac_sha256,
      provider_prompt_contract_sha256: record.provider_prompt_contract_sha256,
      provider_prompt_observability: record.provider_prompt_observability,
      reusable_prefix_method: record.reusable_prefix_method,
      total_input_tokens: record.token_counts.total_input_tokens,
      provider_prompt_tokens: record.token_counts.provider_prompt_tokens,
      stable_contract_prefix_tokens: record.token_counts.stable_contract_prefix_tokens,
      provider_prompt_lcp_tokens: record.token_counts.provider_prompt_lcp_tokens,
      dynamic_suffix_tokens: record.token_counts.dynamic_suffix_tokens,
      response_directive_input_tokens: record.token_counts.response_directive_input_tokens,
      tokenizer_source: record.token_counts.tokenizer_source,
      response_contract_artifact_id: null,
      directive_profile: record.directive_profile,
      observation_artifact_id: artifact.artifactId,
      recorded_at_ms: recordedAtMs(record.recorded_at, "PromptRequest"),
    };
    this.connection.prepare(`INSERT OR IGNORE INTO prompt_requests(
      prompt_request_id,${Object.keys(expected).join(",")}
    ) VALUES(${Array.from({ length: Object.keys(expected).length + 1 }, () => "?").join(",")})`)
      .run(record.prompt_request_id, ...Object.values(expected));
    assertStoredIdentity(this.connection.prepare(`SELECT ${Object.keys(expected).join(",")} FROM prompt_requests
      WHERE prompt_request_id=?`).get(record.prompt_request_id) as Record<string, unknown> | undefined,
    expected, `PromptRequest ${record.prompt_request_id}`);
  }

  insertCacheObservation(input: CacheAuthorityRecordInput, nowMs: number, eventSequence: number): void {
    const epoch = input.epoch.record;
    const observation = input.observation.record;
    if (epoch.epoch_id !== observation.epoch_id || epoch.module !== "CACHE"
      || observation.prompt_generation_id !== input.generations.at(-1)?.record.prompt_generation_id
      || observation.prompt_request_id !== input.requests.at(-1)?.record.prompt_request_id) {
      throw new AuthorityIntegrityError("Cache authority command binding failed");
    }
    this.connection.prepare(`INSERT OR IGNORE INTO experiment_epochs(
      epoch_id,module,arm,runtime_fingerprint_sha256,config_sha256,preregistration_artifact_id,created_event_sequence,created_at_ms
    ) VALUES(?,'CACHE',?,?,?,?,?,?)`).run(
      epoch.epoch_id, epoch.effective_arm, epoch.runtime_fingerprint_sha256, epoch.config_sha256,
      input.epoch.artifact.artifactId, eventSequence, nowMs,
    );
    const storedEpochExpected = {
      module: "CACHE", arm: epoch.effective_arm, runtime_fingerprint_sha256: epoch.runtime_fingerprint_sha256,
      config_sha256: epoch.config_sha256, preregistration_artifact_id: input.epoch.artifact.artifactId,
    };
    assertStoredIdentity(this.connection.prepare(`SELECT ${Object.keys(storedEpochExpected).join(",")} FROM experiment_epochs WHERE epoch_id=?`)
      .get(epoch.epoch_id) as Record<string, unknown> | undefined, storedEpochExpected, `Cache epoch ${epoch.epoch_id}`);
    const transition = this.connection.prepare("SELECT count(*) AS count FROM experiment_epoch_transitions WHERE epoch_id=?")
      .get(epoch.epoch_id) as { count?: unknown } | undefined;
    if (Number(transition?.count ?? 0) === 0) {
      this.connection.prepare(`INSERT INTO experiment_epoch_transitions(
        epoch_id,sequence,status,reason_code,evidence_artifact_id,created_event_sequence,recorded_at_ms
      ) VALUES(?,1,'RUNNING','CACHE_C0_C1_OBSERVATION_STARTED',?,?,?)`)
        .run(epoch.epoch_id, input.epoch.artifact.artifactId, eventSequence, nowMs);
    }
    for (const item of input.generations) {
      this.insertPromptGeneration(input.goalId, item.record, item.artifact, item.epochId);
    }
    for (const item of input.requests) this.insertPromptRequest(item.record, item.artifact);
    const expectedObservation = {
      epoch_id: observation.epoch_id,
      goal_id: input.goalId,
      prompt_generation_id: observation.prompt_generation_id,
      prompt_request_id: observation.prompt_request_id,
      request_sequence: observation.request_sequence,
      provider_fingerprint_hmac_sha256: observation.provider_fingerprint_hmac_sha256,
      model_fingerprint_hmac_sha256: observation.model_fingerprint_hmac_sha256,
      cache_lineage_hmac_sha256: observation.cache_lineage_hmac_sha256,
      prefix_generation: observation.prefix_generation,
      stable_contract_prefix_hmac_sha256: observation.stable_contract_prefix_hmac_sha256,
      provider_prompt_reusable_prefix_hmac_sha256: observation.provider_prompt_reusable_prefix_hmac_sha256,
      fingerprint_method: observation.fingerprint_method,
      transport_contract_sha256: observation.transport_contract_sha256,
      state: observation.state,
      eligibility_reason: observation.eligibility.reason,
      eligible: observation.eligibility.eligible ? 1 : 0,
      append_only_verified: observation.eligibility.append_only_verified ? 1 : 0,
      total_input_tokens: observation.eligibility.total_input_tokens,
      provider_prompt_lcp_tokens: observation.eligibility.provider_prompt_lcp_tokens,
      eligible_prefix_tokens: observation.eligibility.eligible_cacheable_prefix_tokens,
      provider_minimum_tokens: observation.eligibility.provider_minimum_tokens,
      provider_granularity_tokens: observation.eligibility.provider_granularity_tokens,
      denominator_method: observation.eligibility.denominator_method,
      retention_contract_receipt_sha256: observation.retention.contract_receipt_sha256,
      retention_mode: observation.retention.mode,
      verified_min_ttl_ms: observation.retention.verified_min_ttl_ms,
      inter_request_gap_ms: observation.retention.inter_request_gap_ms,
      within_verified_window: observation.retention.within_verified_window === null ? null : observation.retention.within_verified_window ? 1 : 0,
      usage_contract_receipt_sha256: observation.usage_contract.receipt_sha256,
      total_input_definition: observation.usage_contract.total_input_definition,
      cache_read_scope: observation.usage_contract.cache_read_scope,
      uncached_input_tokens: observation.usage.uncached_input_tokens,
      cache_read_tokens: observation.usage.cache_read_tokens,
      cache_write_tokens: observation.usage.cache_write_tokens,
      usage_observable: observation.usage.observable ? 1 : 0,
      pi_compatible_latest_hit_rate: observation.diagnostic_rates.pi_compatible_latest_hit_rate,
      warm_eligible_token_hit_rate: observation.diagnostic_rates.warm_eligible_token_hit_rate,
      miss_attribution: observation.miss_attribution,
      latency_ms: observation.latency_ms,
      quality_gate: observation.quality_gate,
      observation_artifact_id: input.observation.artifact.artifactId,
      recorded_at_ms: recordedAtMs(observation.recorded_at, "CacheObservation"),
    };
    this.connection.prepare(`INSERT OR IGNORE INTO cache_observations(
      observation_id,${Object.keys(expectedObservation).join(",")}
    ) VALUES(${Array.from({ length: Object.keys(expectedObservation).length + 1 }, () => "?").join(",")})`)
      .run(observation.observation_id, ...Object.values(expectedObservation));
    assertStoredIdentity(this.connection.prepare(`SELECT ${Object.keys(expectedObservation).join(",")} FROM cache_observations WHERE observation_id=?`)
      .get(observation.observation_id) as Record<string, unknown> | undefined, expectedObservation, `CacheObservation ${observation.observation_id}`);
  }

  cacheObservationCount(goalId: string): number {
    const row = this.connection.prepare("SELECT count(*) AS count FROM cache_observations WHERE goal_id=?")
      .get(goalId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  cacheDiagnostic(goalId: string): CacheDiagnostic {
    const row = this.connection.prepare(`SELECT observation_id,epoch_id,prompt_request_id,request_sequence,state,
      eligibility_reason,eligible,cache_read_tokens,eligible_prefix_tokens,pi_compatible_latest_hit_rate,
      warm_eligible_token_hit_rate,latency_ms,recorded_at_ms
      FROM cache_observations WHERE goal_id=? ORDER BY recorded_at_ms DESC,rowid DESC LIMIT 1`)
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) return { latest: null, cohort: null };
    const epochId = text(row.epoch_id, "cache_observations.epoch_id");
    const aggregate = this.connection.prepare(`SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN eligible=1 THEN 1 ELSE 0 END) AS eligible_requests,
      SUM(CASE WHEN state IN ('HIT','MISS') THEN 1 ELSE 0 END) AS observable_warm_requests,
      SUM(CASE WHEN state='HIT' THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN state='MISS' THEN 1 ELSE 0 END) AS misses,
      SUM(CASE WHEN state='UNOBSERVABLE' THEN 1 ELSE 0 END) AS unobservable,
      SUM(CASE WHEN state='ERROR' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN state IN ('HIT','MISS') THEN cache_read_tokens ELSE 0 END) AS warm_cache_read,
      SUM(CASE WHEN state IN ('HIT','MISS') THEN eligible_prefix_tokens ELSE 0 END) AS warm_eligible_prefix,
      SUM(COALESCE(cache_read_tokens,0)) AS all_cache_read,
      SUM(COALESCE(uncached_input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)) AS effective_input
      FROM cache_observations WHERE goal_id=? AND epoch_id=?`).get(goalId, epochId) as Record<string, unknown>;
    const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
    const nullableNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
    const hits = number(aggregate.hits);
    const misses = number(aggregate.misses);
    const observable = number(aggregate.observable_warm_requests);
    const eligible = number(aggregate.eligible_requests);
    const warmPrefix = number(aggregate.warm_eligible_prefix);
    const effectiveInput = number(aggregate.effective_input);
    return {
      latest: {
        observationId: text(row.observation_id, "cache_observations.observation_id"), epochId,
        promptRequestId: text(row.prompt_request_id, "cache_observations.prompt_request_id"),
        requestSequence: number(row.request_sequence), state: text(row.state, "cache_observations.state"),
        eligibilityReason: text(row.eligibility_reason, "cache_observations.eligibility_reason"),
        eligible: number(row.eligible) === 1,
        cacheReadTokens: nullableNumber(row.cache_read_tokens), eligiblePrefixTokens: nullableNumber(row.eligible_prefix_tokens),
        piCompatibleLatestHitRate: nullableNumber(row.pi_compatible_latest_hit_rate),
        warmEligibleTokenHitRate: nullableNumber(row.warm_eligible_token_hit_rate),
        latencyMs: nullableNumber(row.latency_ms), recordedAtMs: number(row.recorded_at_ms),
      },
      cohort: {
        epochId, totalRequests: number(aggregate.total_requests), eligibleRequests: eligible,
        observableWarmRequests: observable, hits, misses,
        unobservable: number(aggregate.unobservable), errors: number(aggregate.errors),
        warmEligibleRequestHitRate: hits + misses > 0 ? hits / (hits + misses) : null,
        warmEligibleTokenHitRate: warmPrefix > 0 ? number(aggregate.warm_cache_read) / warmPrefix : null,
        effectiveInputTokenHitRate: effectiveInput > 0 ? number(aggregate.all_cache_read) / effectiveInput : null,
        observableWarmCoverage: eligible > 0 ? observable / eligible : null,
      },
    };
  }

  insertVerdict(input: {
    readonly goalId: string;
    readonly verdict: PerformanceVerdictRecord;
    readonly sampleSetArtifactId: string;
    readonly baselineSetArtifactId: string;
    readonly candidateSetArtifactId: string;
    readonly statisticsArtifactId: string;
    readonly correctnessReceiptId: string | null;
    readonly holdoutReceiptId: string | null;
  }, nowMs: number, eventSequence: number): void {
    const trial = this.trial(input.verdict.trial_id);
    const trialGoalId = text(trial.goal_id, "performance_trials.goal_id");
    if (trialGoalId !== input.goalId) {
      throw new AuthorityIntegrityError("Performance verdict Goal substitution");
    }
    const trialEpochId = text(trial.epoch_id, "performance_trials.epoch_id");
    const trialAttemptId = text(trial.attempt_id, "performance_trials.attempt_id");
    if (input.verdict.verdict === "PROMOTE") {
      for (const receiptId of [input.correctnessReceiptId, input.holdoutReceiptId]) {
        const row = receiptId ? this.connection.prepare("SELECT goal_id,result FROM receipts WHERE receipt_id=?").get(receiptId) as Record<string, unknown> | undefined : undefined;
        if (!row || row.goal_id !== trialGoalId || row.result !== "SUCCEEDED") throw new AuthorityIntegrityError("PROMOTE requires successful candidate and holdout receipts");
      }
    }
    this.connection.prepare(`INSERT INTO performance_trial_verdicts(
      verdict_id,trial_id,sequence,sample_set_artifact_id,baseline_set_artifact_id,candidate_set_artifact_id,statistics_artifact_id,
      correctness_receipt_id,holdout_receipt_id,confidence_gate,practical_effect_gate,end_to_end_gate,regression_gate,
      holdout_gate,benefit_horizon_gate,environment_gate,budget_gate,verdict,verdict_sha256,recorded_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.verdict.verdict_id, input.verdict.trial_id, input.verdict.sequence, input.sampleSetArtifactId,
      input.baselineSetArtifactId, input.candidateSetArtifactId, input.statisticsArtifactId,
      input.correctnessReceiptId, input.holdoutReceiptId, gateForSql(input.verdict.gates.confidence),
      gateForSql(input.verdict.gates.practical_effect), gateForSql(input.verdict.gates.end_to_end),
      gateForSql(input.verdict.gates.regression), gateForSql(input.verdict.gates.holdout),
      gateForSql(input.verdict.gates.benefit_horizon), gateForSql(input.verdict.gates.environment),
      gateForSql(input.verdict.gates.budget), input.verdict.verdict, canonicalJsonSha256(input.verdict), nowMs,
    );
    const status = input.verdict.verdict === "PROMOTE" ? "PASSED"
      : input.verdict.verdict === "REJECT" ? "FAILED"
        : input.verdict.verdict === "CANCELED" ? "STOPPED" : "RUNNING";
    const prior = this.connection.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM experiment_epoch_transitions WHERE epoch_id=?").get(trialEpochId) as { sequence?: unknown } | undefined;
    this.connection.prepare("INSERT INTO experiment_epoch_transitions(epoch_id,sequence,status,reason_code,evidence_artifact_id,created_event_sequence,recorded_at_ms) VALUES(?,?,?,?,?,?,?)")
      .run(trialEpochId, Number(prior?.sequence ?? 0) + 1, status, input.verdict.verdict, input.statisticsArtifactId, eventSequence, nowMs);
    if (input.verdict.verdict !== "NEED_MORE_EVIDENCE") {
      const attemptOutcome = input.verdict.verdict === "PROMOTE" ? "SUCCEEDED" : input.verdict.verdict === "CANCELED" ? "CANCELED" : "FAILED";
      this.connection.prepare("UPDATE attempts SET ended_at_ms=?,outcome=? WHERE attempt_id=? AND ended_at_ms IS NULL")
        .run(nowMs, attemptOutcome, trialAttemptId);
    }
  }

  activeTrial(goalId: string): ActivePerformanceTrialMaterial | null {
    const row = this.connection.prepare(`SELECT pt.trial_id,pt.opportunity_id,pt.epoch_id,pt.goal_id,pt.stage_id,pt.work_item_id,
      pt.attempt_id,pt.plan_id,pt.runtime_fingerprint_sha256,pt.trial_spec_artifact_id,
      a.sha256 AS artifact_sha256,a.locator AS artifact_locator
      FROM performance_trials pt JOIN artifacts a ON a.artifact_id=pt.trial_spec_artifact_id
      LEFT JOIN performance_trial_verdicts v ON v.trial_id=pt.trial_id AND v.verdict IN ('PROMOTE','REJECT','CANCELED')
      WHERE pt.goal_id=? AND v.verdict_id IS NULL ORDER BY pt.created_at_ms DESC,pt.trial_id DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const trialId = text(row.trial_id, "trial_id");
    const specHash = text(row.artifact_sha256, "artifact_sha256");
    return {
      trialId,
      opportunityId: text(row.opportunity_id, "opportunity_id"),
      epochId: text(row.epoch_id, "epoch_id"),
      goalId: text(row.goal_id, "goal_id"),
      stageId: text(row.stage_id, "stage_id"),
      workItemId: text(row.work_item_id, "work_item_id"),
      attemptId: text(row.attempt_id, "attempt_id"),
      planId: text(row.plan_id, "plan_id"),
      runtimeFingerprintSha256: text(row.runtime_fingerprint_sha256, "runtime_fingerprint_sha256"),
      specArtifactId: text(row.trial_spec_artifact_id, "trial_spec_artifact_id"),
      specArtifactSha256: specHash,
      specArtifactLocator: text(row.artifact_locator, "artifact_locator"),
      ref: { id: trialId, sha256: specHash },
    };
  }

  sampleCount(trialId: string): number {
    const row = this.connection.prepare("SELECT count(*) AS count FROM telemetry_samples WHERE trial_id=?").get(trialId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  verdictCount(trialId: string): number {
    const row = this.connection.prepare("SELECT count(*) AS count FROM performance_trial_verdicts WHERE trial_id=?").get(trialId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  private trial(trialId: string): Record<string, unknown> {
    const row = this.connection.prepare("SELECT * FROM performance_trials WHERE trial_id=?").get(trialId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityNotFoundError(`PerformanceTrial ${trialId}`);
    return row;
  }
}
