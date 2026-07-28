import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { ContextProfile } from "./domain.js";

export interface InputContextConsumerSnapshot {
  readonly schema_version: 1;
  readonly envelope_sha256: string;
  readonly layout_manifest_sha256: string;
  readonly tool_surface_plan_sha256: string;
  readonly compile_profile: ContextProfile;
  readonly memory_candidate_count: number;
  readonly evidence_candidate_count: number;
  readonly output_contribution_count: number;
  readonly additional_model_requests: 0;
  readonly additional_provider_requests: 0;
  readonly record_sha256: string;
}

export function sealInputContextConsumerSnapshot(
  body: Omit<InputContextConsumerSnapshot, "record_sha256">,
): InputContextConsumerSnapshot {
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-INPUT-CONTEXT-CONSUMER-SNAPSHOT-V1", body }),
  };
}
