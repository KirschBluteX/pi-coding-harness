import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { ArtifactMetadata } from "../authority/repositories/common.js";
import type { AuthorityStore, CommandResult, MutationMeta, RecordCacheObservationCommand } from "../authority/transactions.js";
import type { PromptGenerationRecord } from "../context/prompt-generation.js";
import type { PromptRequestRecord } from "../context/prompt-request.js";
import { createId } from "../foundation/ids.js";
import type { CacheEligibility, CacheEligibilityReason, CacheObservationState } from "./eligibility.js";
import type { RetentionEvaluation } from "./retention.js";

export interface CacheUsageContractEvidence {
  readonly receiptSha256: string;
  readonly totalInputDefinition: "INCLUDES_CACHE_READ" | "UNCACHED_PLUS_CACHE_READ_AND_WRITE";
  readonly cacheReadScope: "PROVIDER_PROMPT_REUSABLE_PREFIX";
}

export interface CacheNormalizedUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
}

export interface CacheEpochPreregistration {
  readonly schema_version: 1;
  readonly epoch_id: string;
  readonly module: "CACHE";
  readonly configured_epoch: string;
  readonly requested_arm: string;
  readonly effective_arm: "C0" | "C1_PREFIX";
  readonly runtime_fingerprint_sha256: string;
  readonly config_sha256: string;
  readonly fixed_window: Readonly<Record<string, unknown>>;
  readonly exclusions_frozen_before_epoch: true;
  readonly additional_model_requests: 0;
  readonly provider_requests_added: 0;
}

export interface CacheObservationRecord {
  readonly schema_version: 3;
  readonly observation_id: string;
  readonly prompt_generation_id: string;
  readonly prompt_request_id: string;
  readonly epoch_id: string;
  readonly request_sequence: number;
  readonly provider_fingerprint_hmac_sha256: string;
  readonly model_fingerprint_hmac_sha256: string;
  readonly cache_lineage_hmac_sha256: string;
  readonly prefix_generation: number;
  readonly stable_contract_prefix_hmac_sha256: string;
  readonly provider_prompt_reusable_prefix_hmac_sha256: string | null;
  readonly fingerprint_method: "HMAC_SHA256_INSTALL_SCOPED";
  readonly transport_contract_sha256: string;
  readonly state: CacheObservationState;
  readonly eligibility: {
    readonly eligible: boolean;
    readonly reason: CacheEligibilityReason;
    readonly append_only_verified: boolean;
    readonly total_input_tokens: number | null;
    readonly provider_prompt_lcp_tokens: number | null;
    readonly eligible_cacheable_prefix_tokens: number | null;
    readonly provider_minimum_tokens: number | null;
    readonly provider_granularity_tokens: number | null;
    readonly denominator_method: CacheEligibility["denominatorMethod"];
  };
  readonly retention: {
    readonly contract_receipt_sha256: string | null;
    readonly mode: RetentionEvaluation["mode"];
    readonly verified_min_ttl_ms: number | null;
    readonly inter_request_gap_ms: number | null;
    readonly within_verified_window: boolean | null;
  };
  readonly usage_contract: {
    readonly receipt_sha256: string | null;
    readonly total_input_definition: "INCLUDES_CACHE_READ" | "UNCACHED_PLUS_CACHE_READ_AND_WRITE" | "UNKNOWN";
    readonly cache_read_scope: "PROVIDER_PROMPT_REUSABLE_PREFIX" | "UNKNOWN";
  };
  readonly usage: {
    readonly source: "PI_NORMALIZED_USAGE" | "NONE";
    readonly observable: boolean;
    readonly uncached_input_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly cache_write_tokens: number | null;
    readonly output_tokens: number | null;
    readonly reasoning_tokens: number | null;
  };
  readonly diagnostic_rates: {
    readonly pi_compatible_latest_hit_rate: number | null;
    readonly pi_formula: "CACHE_READ_OVER_UNCACHED_PLUS_READ_PLUS_WRITE";
    readonly warm_eligible_token_hit_rate: number | null;
  };
  readonly miss_attribution: "NOT_APPLICABLE" | "PROVIDER_EVICTION_OR_CAPACITY" | "AFFINITY_OR_ROUTING" | "PROVIDER_POLICY" | "UNKNOWN";
  readonly latency_ms: number | null;
  readonly quality_gate: "PASS" | "FAIL" | "NOT_EVALUATED";
  readonly contains_prompt_content: false;
  readonly recorded_at: string;
}

export interface BuildCacheObservationInput {
  readonly epochId: string;
  readonly generation: PromptGenerationRecord;
  readonly request: PromptRequestRecord;
  readonly providerFingerprintHmacSha256: string;
  readonly modelFingerprintHmacSha256: string;
  readonly transportContractSha256: string;
  readonly eligibility: CacheEligibility;
  readonly retention: RetentionEvaluation;
  readonly usageContract: CacheUsageContractEvidence | null;
  readonly usage: CacheNormalizedUsage;
  readonly responseStatus: number | null;
  readonly latencyMs: number | null;
  readonly qualityGate?: CacheObservationRecord["quality_gate"];
  readonly missAttribution?: Exclude<CacheObservationRecord["miss_attribution"], "NOT_APPLICABLE">;
  readonly now: Date;
}

function token(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function buildCacheObservation(input: BuildCacheObservationInput): CacheObservationRecord {
  const normalized = {
    input: token(input.usage.input),
    output: token(input.usage.output),
    cacheRead: token(input.usage.cacheRead),
    cacheWrite: token(input.usage.cacheWrite),
    reasoning: token(input.usage.reasoning),
  };
  const hasPromptUsage = normalized.input !== null && normalized.cacheRead !== null && normalized.cacheWrite !== null;
  const totalInput = hasPromptUsage
    ? (normalized.input ?? 0) + (normalized.cacheRead ?? 0) + (normalized.cacheWrite ?? 0)
    : input.request.token_counts.total_input_tokens;
  const contractValid = Boolean(input.usageContract && /^[a-f0-9]{64}$/u.test(input.usageContract.receiptSha256));
  const denominatorValid = input.eligibility.eligiblePrefixTokens !== null
    && normalized.cacheRead !== null && normalized.cacheRead <= input.eligibility.eligiblePrefixTokens;
  let state: CacheObservationState;
  let reason = input.eligibility.reason;
  let usageObservable = false;
  if (input.responseStatus !== null && input.responseStatus >= 400) {
    state = "ERROR";
  } else if (input.eligibility.state !== null) {
    state = input.eligibility.state;
  } else if (!contractValid || !hasPromptUsage || !denominatorValid) {
    state = "UNOBSERVABLE";
    reason = "USAGE_UNPROVEN";
  } else {
    usageObservable = true;
    state = (normalized.cacheRead ?? 0) > 0 ? "HIT" : "MISS";
  }
  if (state === "UNOBSERVABLE") usageObservable = false;
  const piDenominator = hasPromptUsage ? totalInput : null;
  const latestRate = piDenominator && piDenominator > 0 ? (normalized.cacheRead ?? 0) / piDenominator : null;
  const warmRate = usageObservable && input.eligibility.eligiblePrefixTokens && input.eligibility.eligiblePrefixTokens > 0
    ? (normalized.cacheRead ?? 0) / input.eligibility.eligiblePrefixTokens : null;
  const record: CacheObservationRecord = {
    schema_version: 3,
    observation_id: createId("CACHE_OBS"),
    prompt_generation_id: input.generation.prompt_generation_id,
    prompt_request_id: input.request.prompt_request_id,
    epoch_id: input.epochId,
    request_sequence: input.request.request_sequence,
    provider_fingerprint_hmac_sha256: input.providerFingerprintHmacSha256,
    model_fingerprint_hmac_sha256: input.modelFingerprintHmacSha256,
    cache_lineage_hmac_sha256: input.generation.cache_lineage_hmac_sha256,
    prefix_generation: input.generation.prefix_generation,
    stable_contract_prefix_hmac_sha256: input.generation.stable_contract_prefix_hmac_sha256,
    provider_prompt_reusable_prefix_hmac_sha256: input.request.provider_prompt_reusable_prefix_hmac_sha256,
    fingerprint_method: "HMAC_SHA256_INSTALL_SCOPED",
    transport_contract_sha256: input.transportContractSha256,
    state,
    eligibility: {
      eligible: input.eligibility.eligible,
      reason,
      append_only_verified: input.eligibility.appendOnlyVerified,
      total_input_tokens: totalInput,
      provider_prompt_lcp_tokens: input.eligibility.providerPromptLcpTokens,
      eligible_cacheable_prefix_tokens: input.eligibility.eligiblePrefixTokens,
      provider_minimum_tokens: input.eligibility.providerMinimumTokens,
      provider_granularity_tokens: input.eligibility.providerGranularityTokens,
      denominator_method: input.eligibility.denominatorMethod,
    },
    retention: {
      contract_receipt_sha256: input.retention.contractReceiptSha256,
      mode: input.retention.mode,
      verified_min_ttl_ms: input.retention.verifiedMinTtlMs,
      inter_request_gap_ms: input.retention.interRequestGapMs,
      within_verified_window: input.retention.withinVerifiedWindow,
    },
    usage_contract: {
      receipt_sha256: contractValid ? input.usageContract?.receiptSha256 ?? null : null,
      total_input_definition: contractValid ? input.usageContract?.totalInputDefinition ?? "UNKNOWN" : "UNKNOWN",
      cache_read_scope: contractValid ? input.usageContract?.cacheReadScope ?? "UNKNOWN" : "UNKNOWN",
    },
    usage: {
      source: hasPromptUsage || normalized.output !== null ? "PI_NORMALIZED_USAGE" : "NONE",
      observable: usageObservable,
      uncached_input_tokens: normalized.input,
      cache_read_tokens: normalized.cacheRead,
      cache_write_tokens: normalized.cacheWrite,
      output_tokens: normalized.output,
      reasoning_tokens: normalized.reasoning,
    },
    diagnostic_rates: {
      pi_compatible_latest_hit_rate: latestRate,
      pi_formula: "CACHE_READ_OVER_UNCACHED_PLUS_READ_PLUS_WRITE",
      warm_eligible_token_hit_rate: warmRate,
    },
    miss_attribution: state === "MISS" ? input.missAttribution ?? "UNKNOWN" : "NOT_APPLICABLE",
    latency_ms: input.latencyMs !== null && Number.isFinite(input.latencyMs) && input.latencyMs >= 0 ? input.latencyMs : null,
    quality_gate: input.qualityGate ?? "NOT_EVALUATED",
    contains_prompt_content: false,
    recorded_at: input.now.toISOString(),
  };
  canonicalJsonSha256(record);
  return record;
}

function artifactMetadata(record: ArtifactRecord | ArtifactMetadata): ArtifactMetadata {
  return {
    artifactId: record.artifactId,
    sha256: record.sha256,
    byteLength: record.byteLength,
    mediaType: record.mediaType,
    classification: record.classification,
    locator: record.locator,
    encryptionKeyId: record.encryptionKeyId,
    retentionClass: record.retentionClass,
  };
}

function promptGeneration(value: unknown): value is PromptGenerationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<PromptGenerationRecord>;
  return record.schema_version === 3 && typeof record.prompt_generation_id === "string"
    && typeof record.recorded_at === "string";
}

function promptRequest(value: unknown): value is PromptRequestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<PromptRequestRecord>;
  return record.schema_version === 2 && typeof record.prompt_request_id === "string"
    && typeof record.prompt_generation_id === "string" && typeof record.recorded_at === "string";
}

function topologicalGenerations(
  entries: readonly { readonly record: PromptGenerationRecord; readonly artifact: ArtifactMetadata }[],
): { readonly record: PromptGenerationRecord; readonly artifact: ArtifactMetadata }[] {
  const pending = new Map(entries.map((entry) => [entry.record.prompt_generation_id, entry]));
  const ordered: { readonly record: PromptGenerationRecord; readonly artifact: ArtifactMetadata }[] = [];
  const emitted = new Set<string>();
  while (pending.size > 0) {
    const next = [...pending.values()]
      .filter((entry) => !entry.record.parent_prompt_generation_id
        || emitted.has(entry.record.parent_prompt_generation_id)
        || !pending.has(entry.record.parent_prompt_generation_id))
      .sort((left, right) => left.record.recorded_at.localeCompare(right.record.recorded_at)
        || left.record.prompt_generation_id.localeCompare(right.record.prompt_generation_id))[0];
    if (!next) throw new TypeError("PromptGeneration history contains a cycle");
    pending.delete(next.record.prompt_generation_id);
    emitted.add(next.record.prompt_generation_id);
    ordered.push(next);
  }
  return ordered;
}

export class CacheTelemetryRecorder {
  private readonly backfilledGoals = new Set<string>();

  constructor(private readonly authority: AuthorityStore, private readonly artifacts: ArtifactStore) {}

  record(
    goalId: string,
    epoch: CacheEpochPreregistration,
    generation: PromptGenerationRecord,
    request: PromptRequestRecord,
    observation: CacheObservationRecord,
    inputClosureSha256: string,
    mutation: MutationMeta,
  ): CommandResult {
    const epochArtifact = this.put(epoch, "cache-epoch-preregistration");
    const generationArtifact = this.put(generation, "prompt-generation");
    const requestArtifact = this.put(request, "prompt-request");
    const observationArtifact = this.put(observation, "cache-observation");
    const historicalGenerations = new Map<string, { readonly record: PromptGenerationRecord; readonly artifact: ArtifactMetadata }>();
    const historicalRequests = new Map<string, { readonly record: PromptRequestRecord; readonly artifact: ArtifactMetadata }>();
    if (!this.backfilledGoals.has(goalId)) {
      const recovery = this.authority.readRecoveryMaterial(goalId);
      for (const item of recovery.observations) {
        if (item.observationType !== "PROMPT_GENERATION" && item.observationType !== "PROMPT_REQUEST") continue;
        const value = JSON.parse(new TextDecoder().decode(this.artifacts.open(item.artifact.locator))) as unknown;
        if (item.observationType === "PROMPT_GENERATION" && promptGeneration(value)) {
          historicalGenerations.set(value.prompt_generation_id, { record: value, artifact: artifactMetadata(item.artifact) });
        } else if (item.observationType === "PROMPT_REQUEST" && promptRequest(value)) {
          historicalRequests.set(value.prompt_request_id, { record: value, artifact: artifactMetadata(item.artifact) });
        }
      }
    }
    historicalGenerations.set(generation.prompt_generation_id, { record: generation, artifact: artifactMetadata(generationArtifact) });
    historicalRequests.set(request.prompt_request_id, { record: request, artifact: artifactMetadata(requestArtifact) });
    const orderedGenerations = topologicalGenerations([...historicalGenerations.values()]);
    const currentGeneration = orderedGenerations.find((entry) => entry.record.prompt_generation_id === generation.prompt_generation_id);
    if (!currentGeneration) throw new TypeError("Current PromptGeneration was lost during backfill");
    const generations = orderedGenerations.filter((entry) => entry !== currentGeneration)
      .map((entry) => ({ ...entry, epochId: null as string | null }));
    generations.push({ ...currentGeneration, epochId: epoch.epoch_id });
    const orderedRequests = [...historicalRequests.values()]
      .filter((entry) => entry.record.prompt_request_id !== request.prompt_request_id)
      .sort((left, right) => left.record.recorded_at.localeCompare(right.record.recorded_at)
        || left.record.request_sequence - right.record.request_sequence);
    orderedRequests.push({ record: request, artifact: artifactMetadata(requestArtifact) });
    const command: RecordCacheObservationCommand = {
      type: "RECORD_CACHE_OBSERVATION",
      goalId,
      epoch: { record: epoch, artifact: artifactMetadata(epochArtifact) },
      generations,
      requests: orderedRequests,
      observation: { record: observation, artifact: artifactMetadata(observationArtifact) },
      inputClosureSha256,
    };
    const result = this.authority.transact(command, mutation);
    this.backfilledGoals.add(goalId);
    return result;
  }

  private put(value: unknown, mediaName: string): ArtifactRecord {
    const artifact = this.artifacts.put(canonicalJson(value), {
      mediaType: `application/vnd.pch.${mediaName}+json`,
      classification: "INTERNAL",
      retentionClass: "GOAL_TELEMETRY",
    });
    const verification = this.artifacts.verify(artifact.locator);
    if (!verification.valid || verification.sha256 !== artifact.sha256 || verification.byteLength !== artifact.byteLength) {
      throw new TypeError(`Cache telemetry CAS readback failed for ${mediaName}`);
    }
    return artifact;
  }
}
