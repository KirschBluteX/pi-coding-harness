import { hmacSha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type {
  ContextEnvelopeRecord, ContextLayoutManifestRecord, ContextProjectionReceiptRecord,
  ProjectionState, ProviderPayloadFinality, ToolSurfacePlanRecord,
} from "./domain.js";

export interface ProjectionAuthority {
  appendInputContextProjection(receipt: ContextProjectionReceiptRecord): unknown;
  latestInputContextProjection(projectionId: string): ContextProjectionReceiptRecord | null;
}

export class ProjectionSaga {
  private current: ContextProjectionReceiptRecord | null = null;

  constructor(
    private readonly authority: ProjectionAuthority,
    private readonly hmacKey: string | Uint8Array,
    private readonly nowMs: () => number = Date.now,
  ) {}

  prepare(input: {
    readonly envelope: ContextEnvelopeRecord;
    readonly toolSurface: ToolSurfacePlanRecord;
    readonly layout: ContextLayoutManifestRecord;
    readonly runtimeFingerprintSha256: string;
  }): ContextProjectionReceiptRecord {
    const idempotencyKeyHmac = hmacSha256Hex(this.hmacKey, [
      input.envelope.record_sha256, input.toolSurface.record_sha256, input.layout.record_sha256,
      input.runtimeFingerprintSha256, input.envelope.retained_root_sha256,
    ].join("\0"));
    const projectionId = idFromSha256("IC_PROJECTION", idempotencyKeyHmac);
    const existing = this.authority.latestInputContextProjection(projectionId);
    if (existing) {
      this.current = existing;
      return existing;
    }
    const receipt = this.make({
      projectionId, ordinal: 0, state: "PREPARED", finality: "PCH_HOOK_INPUT",
      envelope: input.envelope, toolSurface: input.toolSurface, layout: input.layout,
      runtimeFingerprintSha256: input.runtimeFingerprintSha256, idempotencyKeyHmac,
    });
    this.authority.appendInputContextProjection(receipt);
    this.current = receipt;
    return receipt;
  }

  transition(state: ProjectionState, finality: ProviderPayloadFinality): ContextProjectionReceiptRecord | null {
    const prior = this.current;
    if (!prior || prior.projection_state === state) return prior;
    if (prior.projection_state === "COMPLETED" || prior.projection_state === "ABANDONED") return prior;
    const { receipt_sha256: _priorHash, ...binding } = prior;
    void _priorHash;
    const receipt = sealInputContextRecord(inputContextHashDomains.contextProjectionReceipt, "receipt_sha256", {
      ...binding,
      transition_ordinal: prior.transition_ordinal + 1,
      projection_state: state,
      finality,
      created_at_ms: Math.max(prior.created_at_ms, this.nowMs()),
    });
    this.authority.appendInputContextProjection(receipt);
    this.current = receipt;
    return receipt;
  }

  latest(): ContextProjectionReceiptRecord | null { return this.current; }
  clear(): void { this.current = null; }

  private make(input: {
    readonly projectionId: string; readonly ordinal: number; readonly state: ProjectionState;
    readonly finality: ProviderPayloadFinality; readonly envelope: ContextEnvelopeRecord;
    readonly toolSurface: ToolSurfacePlanRecord; readonly layout: ContextLayoutManifestRecord;
    readonly runtimeFingerprintSha256: string; readonly idempotencyKeyHmac: string;
  }): ContextProjectionReceiptRecord {
    return sealInputContextRecord(inputContextHashDomains.contextProjectionReceipt, "receipt_sha256", {
      schema_version: 1 as const,
      projection_id: input.projectionId,
      transition_ordinal: input.ordinal,
      context_envelope_sha256: input.envelope.record_sha256,
      tool_surface_plan_sha256: input.toolSurface.record_sha256,
      layout_manifest_sha256: input.layout.record_sha256,
      retained_root_sha256: input.envelope.retained_root_sha256,
      runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
      subject: input.envelope.subject,
      prompt_generation_id: input.envelope.prompt_generation_id,
      projection_state: input.state,
      idempotency_key_hmac: input.idempotencyKeyHmac,
      finality: input.finality,
      created_at_ms: this.nowMs(),
    });
  }
}
