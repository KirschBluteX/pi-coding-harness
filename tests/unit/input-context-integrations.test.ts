import { describe, expect, it } from "vitest";
import { ToolSurfaceCoordinator } from "../../src/input-context/tool-surface.js";
import { sealInputContextConsumerSnapshot } from "../../src/input-context/integration-contracts.js";

describe("Input Context typed consumer contracts", () => {
  it("preserves the user's full tool set until exact deferred capability is proven", () => {
    const coordinator = new ToolSurfaceCoordinator();
    const baseline = coordinator.plan({
      envelopeSha256: "a".repeat(64), userActiveTools: ["read", "write"], allConfiguredTools: ["read", "write", "search"],
      capability: { epochSha256: "b".repeat(64), deferredToolsProven: false, additiveDiscoveryProven: false },
      requestDeferredCore: true,
    });
    expect(baseline).toMatchObject({ strategy: "PRESERVE_USER_FULL", deferred_tool_manifest_sha256: null });
    const proven = coordinator.plan({
      envelopeSha256: "a".repeat(64), userActiveTools: ["read", "write"], allConfiguredTools: ["read", "write", "search"],
      capability: { epochSha256: "c".repeat(64), deferredToolsProven: true, additiveDiscoveryProven: false },
      requestDeferredCore: true,
    });
    expect(proven.strategy).toBe("PCH_CORE_DEFERRED");
  });

  it("seals a text-free Memory/Output/Compaction integration snapshot deterministically", () => {
    const body = {
      schema_version: 1 as const, envelope_sha256: "a".repeat(64), layout_manifest_sha256: "b".repeat(64),
      tool_surface_plan_sha256: "c".repeat(64), compile_profile: "RECOVERY" as const,
      memory_candidate_count: 2, evidence_candidate_count: 3, output_contribution_count: 1,
      additional_model_requests: 0 as const, additional_provider_requests: 0 as const,
    };
    expect(sealInputContextConsumerSnapshot(body)).toEqual(sealInputContextConsumerSnapshot(body));
    expect(JSON.stringify(sealInputContextConsumerSnapshot(body))).not.toContain("prompt");
  });
});
