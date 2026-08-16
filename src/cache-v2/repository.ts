import { canonicalJson, parseCanonicalJson } from "../authority/canonical-json.js";
import type { AuthorityConnection } from "../authority/database.js";
import { runImmediateTransaction } from "../authority/database.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";
import {
  sealCacheRecord, verifyCacheRecord, type CacheLogicalRequestPrepareV2, type CacheLogicalRequestV2, type CacheRequestAttributionV2,
  type CacheSecurityPartitionV2, type StablePrefixFamilyV2,
} from "./domain.js";

function same(existing: unknown, expected: string, label: string): void {
  if (typeof existing !== "string" || existing !== expected) throw new AuthorityIntegrityError(`${label} identity collision`);
}

function storedText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`${label} is not stored text`);
  return value;
}

function storedNullableText(value: unknown, label: string): string | null {
  return value === null ? null : storedText(value, label);
}

function stableIdentity(value: object & { readonly record_sha256: string; readonly created_at_ms: number }): string {
  const identity = { ...value } as Record<string, unknown>;
  delete identity.record_sha256;
  delete identity.created_at_ms;
  return canonicalJson(identity);
}

function storedPartition(row: Record<string, unknown>): CacheSecurityPartitionV2 {
  const value = {
    partition_id: storedText(row.partition_id, "partition_id"), run_id: storedText(row.run_id, "run_id"),
    transport_hmac: storedText(row.transport_hmac, "transport_hmac"), provider_hmac: storedText(row.provider_hmac, "provider_hmac"),
    api_hmac: storedText(row.api_hmac, "api_hmac"), model_hmac: storedText(row.model_hmac, "model_hmac"),
    security_epoch_hmac: storedText(row.security_epoch_hmac, "security_epoch_hmac"),
    record_sha256: storedText(row.record_sha256, "record_sha256"), created_at_ms: Number(row.created_at_ms),
  };
  verifyCacheRecord("PCH-CACHE-SECURITY-PARTITION-V2", value);
  return value;
}

function storedFamily(row: Record<string, unknown>): StablePrefixFamilyV2 {
  const value = {
    family_id: storedText(row.family_id, "family_id"), run_id: storedText(row.run_id, "run_id"),
    partition_id: storedText(row.partition_id, "partition_id"), prompt_generation_id: storedText(row.prompt_generation_id, "prompt_generation_id"),
    system_prompt_sha256: storedText(row.system_prompt_sha256, "system_prompt_sha256"),
    layout_manifest_sha256: storedNullableText(row.layout_manifest_sha256, "layout_manifest_sha256"),
    tool_surface_sha256: storedText(row.tool_surface_sha256, "tool_surface_sha256"),
    context_subject_sha256: storedText(row.context_subject_sha256, "context_subject_sha256"),
    record_sha256: storedText(row.record_sha256, "record_sha256"), created_at_ms: Number(row.created_at_ms),
  };
  verifyCacheRecord("PCH-CACHE-PREFIX-FAMILY-V2", value);
  return value;
}

export interface CacheV2RunSummary {
  readonly prepared: number;
  readonly settled: number;
  readonly pending: number;
  readonly confirmedHits: number;
  readonly misses: number;
  readonly coldStarts: number;
  readonly ineligible: number;
  readonly unobservable: number;
  readonly errors: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export class CacheV2Repository {
  private readonly knownPartitions = new Map<string, { readonly identity: string; readonly recordSha256: string }>();
  private readonly knownFamilies = new Map<string, { readonly identity: string; readonly recordSha256: string }>();
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    const required = [
      "cache_security_partitions_v2", "cache_stable_prefix_families_v2",
      "cache_logical_requests_v2", "cache_request_attributions_v2",
    ];
    const placeholders = required.map(() => "?").join(",");
    const row = this.connection.prepare(
      `SELECT count(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
    ).get(...required) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === required.length;
  }

  verifyIntegrity(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Cache v2 migration 014 is not available");
    for (const row of this.connection.prepare("SELECT * FROM cache_security_partitions_v2").all() as Record<string, unknown>[]) {
      verifyCacheRecord("PCH-CACHE-SECURITY-PARTITION-V2", row as unknown as CacheSecurityPartitionV2);
    }
    for (const row of this.connection.prepare("SELECT * FROM cache_stable_prefix_families_v2").all() as Record<string, unknown>[]) {
      verifyCacheRecord("PCH-CACHE-PREFIX-FAMILY-V2", {
        ...row, layout_manifest_sha256: storedNullableText(row.layout_manifest_sha256, "layout_manifest_sha256"),
      } as unknown as StablePrefixFamilyV2);
    }
    for (const row of this.connection.prepare("SELECT * FROM cache_logical_requests_v2").all() as Record<string, unknown>[]) {
      verifyCacheRecord("PCH-CACHE-LOGICAL-REQUEST-V2", row as unknown as CacheLogicalRequestV2);
    }
    for (const row of this.connection.prepare("SELECT * FROM cache_request_attributions_v2").all() as Record<string, unknown>[]) {
      const usage = parseCanonicalJson(storedText(row.usage_json, "usage_json")) as CacheRequestAttributionV2["usage"];
      verifyCacheRecord("PCH-CACHE-REQUEST-ATTRIBUTION-V2", {
        request_id: String(row.request_id), run_id: String(row.run_id), partition_id: String(row.partition_id),
        family_id: String(row.family_id), request_sequence: Number(row.request_sequence),
        subject_binding_sha256: String(row.subject_binding_sha256), observation_state: String(row.observation_state),
        evidence_level: String(row.evidence_level), usage,
        response_status: row.response_status === null ? null : Number(row.response_status),
        latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
        record_sha256: String(row.record_sha256), created_at_ms: Number(row.created_at_ms),
      } as CacheRequestAttributionV2);
    }
    const mismatch = this.connection.prepare(`SELECT count(*) count FROM cache_request_attributions_v2 a
      JOIN cache_logical_requests_v2 r ON r.request_id=a.request_id
      WHERE a.run_id<>r.run_id OR a.partition_id<>r.partition_id OR a.family_id<>r.family_id
        OR a.request_sequence<>r.request_sequence OR a.subject_binding_sha256<>r.subject_binding_sha256`).get() as { count?: unknown } | undefined;
    if (Number(mismatch?.count ?? 0) !== 0) throw new AuthorityIntegrityError("Cache attribution binding mismatch");
  }

  prepare(
    partition: CacheSecurityPartitionV2,
    family: StablePrefixFamilyV2,
    input: CacheLogicalRequestPrepareV2,
  ): CacheLogicalRequestV2 {
    verifyCacheRecord("PCH-CACHE-SECURITY-PARTITION-V2", partition);
    verifyCacheRecord("PCH-CACHE-PREFIX-FAMILY-V2", family);
    if (partition.run_id !== family.run_id || partition.partition_id !== family.partition_id
      || input.run_id !== partition.run_id || input.partition_id !== partition.partition_id
      || input.family_id !== family.family_id) throw new AuthorityIntegrityError("Cache prepare binding mismatch");
    const partitionIdentity = stableIdentity(partition);
    const familyIdentity = stableIdentity(family);
    const knownPartition = this.knownPartitions.get(partition.partition_id);
    const knownFamily = this.knownFamilies.get(family.family_id);
    if (knownPartition && knownPartition.identity !== partitionIdentity) {
      throw new AuthorityIntegrityError("Cache partition identity collision");
    }
    if (knownFamily && knownFamily.identity !== familyIdentity) {
      throw new AuthorityIntegrityError("Cache prefix family identity collision");
    }
    let partitionRecordSha256 = knownPartition?.recordSha256 ?? partition.record_sha256;
    let familyRecordSha256 = knownFamily?.recordSha256 ?? family.record_sha256;
    let request: CacheLogicalRequestV2 | null = null;
    runImmediateTransaction(this.connection, () => {
      if (!knownPartition) {
        const existingPartitionRow = this.connection.prepare("SELECT * FROM cache_security_partitions_v2 WHERE partition_id=?").get(partition.partition_id) as Record<string, unknown> | undefined;
        const existingPartition = existingPartitionRow ? storedPartition(existingPartitionRow) : null;
        if (existingPartition) {
          if (stableIdentity(existingPartition) !== partitionIdentity) throw new AuthorityIntegrityError("Cache partition identity collision");
          partitionRecordSha256 = existingPartition.record_sha256;
        }
        else this.connection.prepare(`INSERT INTO cache_security_partitions_v2(partition_id,run_id,transport_hmac,provider_hmac,api_hmac,model_hmac,
          security_epoch_hmac,record_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          partition.partition_id, partition.run_id, partition.transport_hmac, partition.provider_hmac, partition.api_hmac,
          partition.model_hmac, partition.security_epoch_hmac, partition.record_sha256, partition.created_at_ms,
        );
      }
      if (!knownFamily) {
        const existingFamilyRow = this.connection.prepare("SELECT * FROM cache_stable_prefix_families_v2 WHERE family_id=?").get(family.family_id) as Record<string, unknown> | undefined;
        const existingFamily = existingFamilyRow ? storedFamily(existingFamilyRow) : null;
        if (existingFamily) {
          if (stableIdentity(existingFamily) !== familyIdentity) throw new AuthorityIntegrityError("Cache prefix family identity collision");
          familyRecordSha256 = existingFamily.record_sha256;
        }
        else this.connection.prepare(`INSERT INTO cache_stable_prefix_families_v2(family_id,run_id,partition_id,prompt_generation_id,
          system_prompt_sha256,layout_manifest_sha256,tool_surface_sha256,context_subject_sha256,record_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          family.family_id, family.run_id, family.partition_id, family.prompt_generation_id, family.system_prompt_sha256,
          family.layout_manifest_sha256, family.tool_surface_sha256, family.context_subject_sha256, family.record_sha256, family.created_at_ms,
        );
      }
      const sequenceRow = this.connection.prepare("SELECT COALESCE(MAX(request_sequence),0)+1 next FROM cache_logical_requests_v2 WHERE run_id=?")
        .get(input.run_id) as { next?: unknown } | undefined;
      const sequence = Number(sequenceRow?.next ?? 1);
      request = sealCacheRecord("PCH-CACHE-LOGICAL-REQUEST-V2", {
        ...input,
        request_id: idFromSha256("CACHE_REQ", sha256Hex(`${input.run_id}\0${sequence}\0${familyRecordSha256}`)),
        request_sequence: sequence,
      });
      this.connection.prepare(`INSERT INTO cache_logical_requests_v2(request_id,run_id,partition_id,family_id,request_sequence,
        subject_binding_sha256,record_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?)`).run(
        request.request_id, request.run_id, request.partition_id, request.family_id, request.request_sequence,
        request.subject_binding_sha256, request.record_sha256, request.created_at_ms,
      );
    });
    if (!request) throw new AuthorityIntegrityError("Cache logical request was not prepared");
    this.knownPartitions.set(partition.partition_id, { identity: partitionIdentity, recordSha256: partitionRecordSha256 });
    this.knownFamilies.set(family.family_id, { identity: familyIdentity, recordSha256: familyRecordSha256 });
    return request;
  }

  settle(value: CacheRequestAttributionV2): void {
    verifyCacheRecord("PCH-CACHE-REQUEST-ATTRIBUTION-V2", value);
    const usageJson = canonicalJson(value.usage);
    runImmediateTransaction(this.connection, () => {
      const existing = this.connection.prepare("SELECT record_sha256 FROM cache_request_attributions_v2 WHERE request_id=?").get(value.request_id) as { record_sha256?: unknown } | undefined;
      if (existing) { same(existing.record_sha256, value.record_sha256, "Cache attribution"); return; }
      this.connection.prepare(`INSERT INTO cache_request_attributions_v2(request_id,run_id,partition_id,family_id,request_sequence,
        subject_binding_sha256,observation_state,evidence_level,usage_json,response_status,latency_ms,record_sha256,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.request_id, value.run_id, value.partition_id, value.family_id, value.request_sequence,
        value.subject_binding_sha256, value.observation_state, value.evidence_level, usageJson,
        value.response_status, value.latency_ms, value.record_sha256, value.created_at_ms,
      );
    });
  }

  pending(runId: string): number {
    const row = this.connection.prepare(`SELECT count(*) count FROM cache_logical_requests_v2 r
      LEFT JOIN cache_request_attributions_v2 a ON a.request_id=r.request_id WHERE r.run_id=? AND a.request_id IS NULL`).get(runId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  reconcilePending(runId: string, now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Cache reconciliation timestamp is invalid");
    const rows = this.connection.prepare(`SELECT r.* FROM cache_logical_requests_v2 r
      LEFT JOIN cache_request_attributions_v2 a ON a.request_id=r.request_id
      WHERE r.run_id=? AND a.request_id IS NULL ORDER BY r.request_sequence`).all(runId) as Record<string, unknown>[];
    for (const row of rows) {
      this.settle(sealCacheRecord("PCH-CACHE-REQUEST-ATTRIBUTION-V2", {
        request_id: storedText(row.request_id, "request_id"), run_id: storedText(row.run_id, "run_id"),
        partition_id: storedText(row.partition_id, "partition_id"), family_id: storedText(row.family_id, "family_id"),
        request_sequence: Number(row.request_sequence),
        subject_binding_sha256: storedText(row.subject_binding_sha256, "subject_binding_sha256"),
        observation_state: "UNOBSERVABLE" as const, evidence_level: "METADATA_ONLY" as const,
        usage: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
        response_status: null, latency_ms: null, created_at_ms: now,
      }));
    }
    return rows.length;
  }

  summary(runId: string): CacheV2RunSummary {
    const row = this.connection.prepare(`SELECT
      count(r.request_id) prepared,
      count(a.request_id) settled,
      sum(CASE WHEN a.request_id IS NULL THEN 1 ELSE 0 END) pending,
      sum(CASE WHEN a.observation_state='HIT' THEN 1 ELSE 0 END) confirmed_hits,
      sum(CASE WHEN a.observation_state='MISS' THEN 1 ELSE 0 END) misses,
      sum(CASE WHEN a.observation_state='COLD_START' THEN 1 ELSE 0 END) cold_starts,
      sum(CASE WHEN a.observation_state='INELIGIBLE' THEN 1 ELSE 0 END) ineligible,
      sum(CASE WHEN a.observation_state='UNOBSERVABLE' THEN 1 ELSE 0 END) unobservable,
      sum(CASE WHEN a.observation_state='ERROR' THEN 1 ELSE 0 END) errors,
      sum(COALESCE(json_extract(a.usage_json,'$.input'),0)) uncached_input_tokens,
      sum(COALESCE(json_extract(a.usage_json,'$.cacheRead'),0)) cache_read_tokens,
      sum(COALESCE(json_extract(a.usage_json,'$.cacheWrite'),0)) cache_write_tokens
      FROM cache_logical_requests_v2 r
      LEFT JOIN cache_request_attributions_v2 a ON a.request_id=r.request_id
      WHERE r.run_id=?`).get(runId) as Record<string, unknown> | undefined;
    const count = (key: string): number => Number(row?.[key] ?? 0);
    return {
      prepared: count("prepared"), settled: count("settled"), pending: count("pending"),
      confirmedHits: count("confirmed_hits"), misses: count("misses"), coldStarts: count("cold_starts"),
      ineligible: count("ineligible"), unobservable: count("unobservable"), errors: count("errors"),
      uncachedInputTokens: count("uncached_input_tokens"), cacheReadTokens: count("cache_read_tokens"),
      cacheWriteTokens: count("cache_write_tokens"),
    };
  }
}
