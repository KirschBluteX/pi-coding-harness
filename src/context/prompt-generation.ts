import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";
import { createId } from "../foundation/ids.js";

export type PromptBoundaryReason =
  | "INITIAL" | "PROVIDER_CHANGED" | "MODEL_CHANGED" | "BASE_URL_OR_API_CHANGED"
  | "TENANT_OR_SECURITY_EPOCH_CHANGED" | "CACHE_NAMESPACE_CHANGED" | "INSTRUCTION_PRECEDENCE_CHANGED"
  | "TOOL_SURFACE_CHANGED" | "PLAN_BUILD_SURFACE_CHANGED" | "PROMPT_CONTRACT_CHANGED"
  | "COMPACTION_REBASE" | "CONTEXT_REPAIR";

export interface PromptGenerationRecord {
  readonly schema_version: 3;
  readonly prompt_generation_id: string;
  readonly parent_prompt_generation_id: string | null;
  readonly logical_session_hmac_sha256: string;
  readonly transport_epoch_hmac_sha256: string;
  readonly cache_lineage_hmac_sha256: string;
  readonly lineage_action: "CREATE" | "CONTINUE" | "ROTATE";
  readonly prefix_generation: number;
  readonly generation_action: "START" | "INCREMENT";
  readonly boundary_reason: PromptBoundaryReason;
  readonly boundary_policy: "IMMEDIATE_REQUIRED" | "STAGE_BOUNDARY_COALESCED" | "NATURAL_COMPACTION";
  readonly coalesced_change_count: number;
  readonly history_policy: "APPEND_ONLY_WITHIN_GENERATION";
  readonly stable_contract_prefix_hmac_sha256: string;
  readonly provider_prompt_contract_prefix_hmac_sha256: string | null;
  readonly prefix_segment_manifest_sha256: string;
  readonly stable_policy_tokens: number;
  readonly tool_schema_tokens: number;
  readonly dynamic_suffix_order: readonly ["PROTECTED_STATE", "MEMORY", "TOOL_EVIDENCE", "RESPONSE_DIRECTIVE"];
  readonly contains_prompt_content: false;
  readonly recorded_at: string;
}

export interface PromptGenerationStart {
  readonly logicalSessionId: string;
  readonly transportEpoch: string;
  readonly cacheNamespace: string;
  readonly stableContractPrefix: string;
  readonly providerPromptContractPrefix?: string | null;
  readonly stablePolicyTokens: number;
  readonly toolSchemaTokens: number;
}

const lineageRotations = new Set<PromptBoundaryReason>([
  "PROVIDER_CHANGED", "MODEL_CHANGED", "BASE_URL_OR_API_CHANGED", "TENANT_OR_SECURITY_EPOCH_CHANGED", "CACHE_NAMESPACE_CHANGED",
]);

export class PromptGenerationCoordinator {
  private currentRecord: PromptGenerationRecord | null = null;

  constructor(private readonly hmacKey: string | Uint8Array, private readonly now: () => Date = () => new Date()) {}

  current(): PromptGenerationRecord | null {
    return this.currentRecord;
  }

  restore(record: PromptGenerationRecord): void {
    if (this.currentRecord) throw new TypeError("Prompt generation is already initialized");
    if (record.schema_version !== 3 || record.history_policy !== "APPEND_ONLY_WITHIN_GENERATION"
      || !/^[A-Z0-9][A-Z0-9._:-]{0,127}$/u.test(record.prompt_generation_id)
      || !/^[a-f0-9]{64}$/u.test(record.cache_lineage_hmac_sha256)) {
      throw new TypeError("Recovered PromptGeneration is invalid");
    }
    this.currentRecord = record;
  }

  start(input: PromptGenerationStart): PromptGenerationRecord {
    if (this.currentRecord) return this.currentRecord;
    return this.create(input, "INITIAL", "CREATE", "IMMEDIATE_REQUIRED", 1);
  }

  boundary(input: PromptGenerationStart, reason: Exclude<PromptBoundaryReason, "INITIAL">, options: { coalescedChangeCount?: number } = {}): PromptGenerationRecord {
    if (!this.currentRecord) throw new TypeError("Prompt generation must start before a boundary");
    const lineageAction = lineageRotations.has(reason) ? "ROTATE" : "CONTINUE";
    const policy = reason === "COMPACTION_REBASE" ? "NATURAL_COMPACTION"
      : reason === "PROMPT_CONTRACT_CHANGED" && (options.coalescedChangeCount ?? 1) > 1 ? "STAGE_BOUNDARY_COALESCED"
        : "IMMEDIATE_REQUIRED";
    return this.create(input, reason, lineageAction, policy, options.coalescedChangeCount ?? 1);
  }

  private create(input: PromptGenerationStart, reason: PromptBoundaryReason, lineageAction: "CREATE" | "CONTINUE" | "ROTATE", boundaryPolicy: PromptGenerationRecord["boundary_policy"], coalescedChangeCount: number): PromptGenerationRecord {
    const parent = this.currentRecord;
    const prefixGeneration = lineageAction === "CONTINUE" ? (parent?.prefix_generation ?? 0) + 1 : 1;
    const cacheLineageMaterial = lineageAction === "CONTINUE" && parent
      ? parent.cache_lineage_hmac_sha256
      : hmacSha256Hex(this.hmacKey, `${input.logicalSessionId}\0${input.transportEpoch}\0${input.cacheNamespace}`);
    const record: PromptGenerationRecord = {
      schema_version: 3,
      prompt_generation_id: createId("PROMPT_GEN"),
      parent_prompt_generation_id: parent?.prompt_generation_id ?? null,
      logical_session_hmac_sha256: hmacSha256Hex(this.hmacKey, input.logicalSessionId),
      transport_epoch_hmac_sha256: hmacSha256Hex(this.hmacKey, input.transportEpoch),
      cache_lineage_hmac_sha256: cacheLineageMaterial,
      lineage_action: lineageAction,
      prefix_generation: prefixGeneration,
      generation_action: lineageAction === "CONTINUE" ? "INCREMENT" : "START",
      boundary_reason: reason,
      boundary_policy: boundaryPolicy,
      coalesced_change_count: coalescedChangeCount,
      history_policy: "APPEND_ONLY_WITHIN_GENERATION",
      stable_contract_prefix_hmac_sha256: hmacSha256Hex(this.hmacKey, input.stableContractPrefix),
      provider_prompt_contract_prefix_hmac_sha256: input.providerPromptContractPrefix
        ? hmacSha256Hex(this.hmacKey, input.providerPromptContractPrefix) : null,
      prefix_segment_manifest_sha256: canonicalJsonSha256({
        order: ["STABLE_CONTRACT", "TOOL_SCHEMAS", "PROTECTED_STATE", "MEMORY", "TOOL_EVIDENCE", "RESPONSE_DIRECTIVE"],
        stablePolicyTokens: input.stablePolicyTokens,
        toolSchemaTokens: input.toolSchemaTokens,
      }),
      stable_policy_tokens: input.stablePolicyTokens,
      tool_schema_tokens: input.toolSchemaTokens,
      dynamic_suffix_order: ["PROTECTED_STATE", "MEMORY", "TOOL_EVIDENCE", "RESPONSE_DIRECTIVE"],
      contains_prompt_content: false,
      recorded_at: this.now().toISOString(),
    };
    this.currentRecord = record;
    return record;
  }
}
