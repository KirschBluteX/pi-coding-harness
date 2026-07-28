import { canonicalJsonSha256 } from "../authority/canonical-json.js";

export interface CacheSecurityPartitionV2 {
  readonly partition_id: string; readonly run_id: string; readonly transport_hmac: string;
  readonly provider_hmac: string; readonly api_hmac: string; readonly model_hmac: string;
  readonly security_epoch_hmac: string; readonly record_sha256: string; readonly created_at_ms: number;
}

export interface StablePrefixFamilyV2 {
  readonly family_id: string; readonly run_id: string; readonly partition_id: string;
  readonly prompt_generation_id: string; readonly system_prompt_sha256: string;
  readonly layout_manifest_sha256: string | null; readonly tool_surface_sha256: string;
  readonly context_subject_sha256: string; readonly record_sha256: string; readonly created_at_ms: number;
}

export interface CacheLogicalRequestV2 {
  readonly request_id: string; readonly run_id: string; readonly partition_id: string; readonly family_id: string;
  readonly request_sequence: number; readonly subject_binding_sha256: string; readonly record_sha256: string; readonly created_at_ms: number;
}

export type CacheLogicalRequestPrepareV2 = Omit<
  CacheLogicalRequestV2,
  "request_id" | "request_sequence" | "record_sha256"
>;

export interface CacheRequestAttributionV2 {
  readonly request_id: string; readonly run_id: string; readonly partition_id: string; readonly family_id: string;
  readonly request_sequence: number; readonly subject_binding_sha256: string;
  readonly observation_state: "INELIGIBLE" | "COLD_START" | "HIT" | "MISS" | "UNOBSERVABLE" | "ERROR";
  readonly evidence_level: "METADATA_ONLY" | "PREFIX_OBSERVED" | "PROVIDER_USAGE" | "FINAL_PROVEN";
  readonly usage: {
    readonly input: number | null; readonly output: number | null; readonly cacheRead: number | null;
    readonly cacheWrite: number | null; readonly reasoning: number | null;
  };
  readonly response_status: number | null; readonly latency_ms: number | null;
  readonly record_sha256: string; readonly created_at_ms: number;
}

export function sealCacheRecord<T extends object>(domain: string, value: T): T & { readonly record_sha256: string } {
  return { ...value, record_sha256: canonicalJsonSha256({ domain, ...value }) };
}

export function verifyCacheRecord(domain: string, value: object & { readonly record_sha256: string }): void {
  const { record_sha256: actual, ...core } = value;
  if (!/^[a-f0-9]{64}$/u.test(actual) || canonicalJsonSha256({ domain, ...core }) !== actual) throw new TypeError(`${domain} hash mismatch`);
}
