import { describe, expect, it } from "vitest";
import {
  HarnessOutputPolicy, harnessOutputPolicyMarker, harnessOutputPolicyText,
} from "../../src/harness/output-policy.js";

describe("Harness stable Output policy", () => {
  it("uses one short stable prefix addition without a dynamic response directive", () => {
    const addition = new HarnessOutputPolicy(true).addition();
    expect(addition).toMatchObject({ marker: harnessOutputPolicyMarker });
    expect(addition.content).toBe(`${harnessOutputPolicyMarker}\n${harnessOutputPolicyText}`);
    expect(Math.ceil(Buffer.byteLength(harnessOutputPolicyText, "utf8") / 4)).toBeLessThanOrEqual(24);
    expect(addition.sourceBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("has a zero-input fallback when governance is disabled", () => {
    expect(new HarnessOutputPolicy(false).addition()).toEqual({
      marker: harnessOutputPolicyMarker, content: null, sourceBindingSha256: null,
    });
  });
});
