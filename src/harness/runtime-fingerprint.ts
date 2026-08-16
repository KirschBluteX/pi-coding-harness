import { canonicalJsonSha256 } from "../authority/canonical-json.js";

export interface PiRuntimeFingerprintInput {
  readonly provider: string;
  readonly api: string;
  readonly base_url?: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
}

export function piRuntimeFingerprintSha256(runtime: PiRuntimeFingerprintInput): string {
  return canonicalJsonSha256({
    domain: "PCH-RUNTIME-FINGERPRINT-V2",
    provider: runtime.provider,
    api: runtime.api,
    baseUrl: runtime.base_url ?? null,
    model: runtime.model,
    thinkingLevel: runtime.thinking_level,
    contextWindow: runtime.context_window,
  });
}
