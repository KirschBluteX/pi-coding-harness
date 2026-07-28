import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type { ContextLayoutManifestRecord, LayoutSegmentManifestEntryRecord } from "./domain.js";

export interface PromptLayoutSegment {
  readonly type: string;
  readonly lifecycle: LayoutSegmentManifestEntryRecord["lifecycle"];
  readonly sourceBindingSha256: string;
  readonly semanticVersion: string;
  readonly content: string;
  readonly containsUserContent: boolean;
}

export class PromptLayoutPlanner {
  constructor(private readonly hmacKey: string | Uint8Array) {}

  plan(input: {
    readonly envelopeSha256: string;
    readonly promptGenerationId: string | null;
    readonly segments: readonly PromptLayoutSegment[];
  }): ContextLayoutManifestRecord {
    let predecessor: string | null = null;
    const entries = input.segments.map((segment, ordinal) => {
      const contentIdentityHmac = hmacSha256Hex(this.hmacKey, segment.content);
      const entry: LayoutSegmentManifestEntryRecord = {
        segment_type: segment.type,
        ordinal,
        lifecycle: segment.lifecycle,
        source_binding_sha256: segment.sourceBindingSha256,
        semantic_version: segment.semanticVersion,
        byte_length: Buffer.byteLength(segment.content, "utf8"),
        estimated_tokens: Math.ceil(Buffer.byteLength(segment.content, "utf8") / 4),
        content_identity_hmac: contentIdentityHmac,
        predecessor_hmac: predecessor,
        contains_user_content: segment.containsUserContent,
      };
      predecessor = contentIdentityHmac;
      return entry;
    });
    const root = canonicalJsonSha256({ domain: "PCH-CONTEXT-LAYOUT-ORDER-V1", entries });
    return sealInputContextRecord(inputContextHashDomains.contextLayoutManifest, "record_sha256", {
      schema_version: 1 as const,
      layout_manifest_id: idFromSha256("IC_LAYOUT", canonicalJsonSha256({ envelope: input.envelopeSha256, root })),
      context_envelope_sha256: input.envelopeSha256,
      prompt_generation_id: input.promptGenerationId,
      ordered_segment_root_sha256: root,
      segment_count: entries.length,
      entries,
      canonical_encoder_version: "pch-layout-v1",
    });
  }
}
