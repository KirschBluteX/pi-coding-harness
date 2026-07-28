import type { CodingHarnessConfig } from "./types.js";

export interface HarnessRuntimeResolution {
  readonly config: CodingHarnessConfig;
  readonly memoryRecallError: null;
  readonly memoryCaptureError: null;
  readonly inputContextError: null;
}

export interface HarnessOptionalFallbacks {
  readonly memoryRecall: boolean;
  readonly memoryCapture: boolean;
  readonly inputContext: boolean;
}

export function formatHarnessFallbackSummary(fallbacks: HarnessOptionalFallbacks): string {
  const degraded = [
    fallbacks.memoryRecall ? "Memory recall=EMPTY_OPTIONAL_PROJECTION" : null,
    fallbacks.memoryCapture ? "Memory capture=MANUAL_CAPTURE" : null,
    fallbacks.inputContext ? "Input Context=OBSERVE" : null,
  ].filter((value): value is string => value !== null);
  return degraded.length ? `\noptional fallback: ${degraded.join(", ")}` : "";
}

export function formatInputContextFallbackNotice(reason: string): string {
  return `Input Context fell back to OBSERVE: ${reason}`;
}

export function resolveHarnessRuntimeConfig(_configPath: string, source: CodingHarnessConfig): HarnessRuntimeResolution {
  return {
    config: source,
    memoryRecallError: null,
    memoryCaptureError: null,
    inputContextError: null,
  };
}
