import { sha256Hex } from "../foundation/crypto.js";

export const harnessOutputPolicyMarker = "[PI-CODING-HARNESS-OUTPUT-V1]";
export const harnessOutputPolicyText = "Use tools silently. Report only questions, blockers, final evidence. Preserve requested format.";

export interface HarnessOutputPolicyAddition {
  readonly marker: typeof harnessOutputPolicyMarker;
  readonly content: string | null;
  readonly sourceBindingSha256: string | null;
}

export class HarnessOutputPolicy {
  constructor(private readonly enabled: boolean) {}

  addition(): HarnessOutputPolicyAddition {
    return this.enabled ? {
      marker: harnessOutputPolicyMarker,
      content: `${harnessOutputPolicyMarker}\n${harnessOutputPolicyText}`,
      sourceBindingSha256: sha256Hex(harnessOutputPolicyText),
    } : { marker: harnessOutputPolicyMarker, content: null, sourceBindingSha256: null };
  }
}
