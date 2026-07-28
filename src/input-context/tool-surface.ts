import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type { ToolSurfacePlanRecord } from "./domain.js";

export interface ToolSurfaceCapability {
  readonly epochSha256: string;
  readonly deferredToolsProven: boolean;
  readonly additiveDiscoveryProven: boolean;
}

export class ToolSurfaceCoordinator {
  plan(input: {
    readonly envelopeSha256: string;
    readonly userActiveTools: readonly string[];
    readonly allConfiguredTools: readonly string[];
    readonly capability: ToolSurfaceCapability;
    readonly requestDeferredCore?: boolean;
  }): ToolSurfacePlanRecord {
    const user = [...new Set(input.userActiveTools)].sort();
    const all = [...new Set(input.allConfiguredTools)].sort();
    const canDefer = input.requestDeferredCore === true && input.capability.deferredToolsProven;
    const strategy = canDefer ? "PCH_CORE_DEFERRED" as const : "PRESERVE_USER_FULL" as const;
    const userHash = canonicalJsonSha256({ domain: "PCH-USER-TOOL-CONFIG-V1", tools: user });
    const activeHash = canonicalJsonSha256({ domain: "PCH-ACTIVE-TOOL-MANIFEST-V1", tools: user });
    const deferredHash = canDefer
      ? canonicalJsonSha256({ domain: "PCH-DEFERRED-TOOL-MANIFEST-V1", tools: all.filter((tool) => !user.includes(tool)) })
      : null;
    return sealInputContextRecord(inputContextHashDomains.toolSurfacePlan, "record_sha256", {
      schema_version: 1 as const,
      tool_surface_plan_id: idFromSha256("IC_TOOLS", canonicalJsonSha256({ envelope: input.envelopeSha256, userHash, activeHash, deferredHash })),
      context_envelope_sha256: input.envelopeSha256,
      strategy,
      user_tool_configuration_sha256: userHash,
      active_tool_manifest_sha256: activeHash,
      deferred_tool_manifest_sha256: deferredHash,
      capability_epoch_sha256: input.capability.epochSha256,
    });
  }
}
