import { describe, expect, it } from "vitest";
import { PromptGenerationCoordinator } from "../../src/context/prompt-generation.js";

describe("PromptGeneration epochs", () => {
  const input = {
    logicalSessionId: "SESSION-001", transportEpoch: "provider/model", cacheNamespace: "cache-namespace",
    stableContractPrefix: "stable policy", stablePolicyTokens: 10, toolSchemaTokens: 20,
  };

  it("separates append generations from lineage rotations", () => {
    const coordinator = new PromptGenerationCoordinator("secret", () => new Date("2026-07-22T00:00:00Z"));
    const initial = coordinator.start(input);
    expect(initial.lineage_action).toBe("CREATE");
    expect(initial.prefix_generation).toBe(1);
    expect(initial.parent_prompt_generation_id).toBeNull();
    const surface = coordinator.boundary(input, "PLAN_BUILD_SURFACE_CHANGED");
    expect(surface.lineage_action).toBe("CONTINUE");
    expect(surface.prefix_generation).toBe(2);
    expect(surface.cache_lineage_hmac_sha256).toBe(initial.cache_lineage_hmac_sha256);
    const rotated = coordinator.boundary({ ...input, transportEpoch: "provider-2/model" }, "PROVIDER_CHANGED");
    expect(rotated.lineage_action).toBe("ROTATE");
    expect(rotated.prefix_generation).toBe(1);
    expect(rotated.cache_lineage_hmac_sha256).not.toBe(initial.cache_lineage_hmac_sha256);
    expect(JSON.stringify(rotated)).not.toContain("stable policy");
  });

  it("coalesces only noncritical prompt-contract changes", () => {
    const coordinator = new PromptGenerationCoordinator("secret");
    coordinator.start(input);
    const record = coordinator.boundary(input, "PROMPT_CONTRACT_CHANGED", { coalescedChangeCount: 3 });
    expect(record.boundary_policy).toBe("STAGE_BOUNDARY_COALESCED");
    expect(record.coalesced_change_count).toBe(3);
  });
});
