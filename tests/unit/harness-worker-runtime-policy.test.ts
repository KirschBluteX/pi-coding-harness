import { describe, expect, it, vi } from "vitest";
import type { WorkerRuntimePolicyConfig } from "../../src/config/types.js";
import { resolveWorkerRuntimeMap, rolePolicyNeedsModelCatalog } from "../../src/harness/worker/runtime-policy.js";

const supervisor = {
  provider: "user-provider",
  api: "user-api",
  model: "user-model",
  thinking_level: "high",
  context_window: 128_000,
};

function policy(): WorkerRuntimePolicyConfig {
  return {
    unavailable_policy: "INHERIT_SUPERVISOR",
    roles: {
      PLANNER: { source: "PI_CONFIG", provider_id: "configured-provider", model_id: "planner-model", thinking_level: "medium" },
      EXPLORER: { source: "PI_CONFIG", provider_id: "missing-provider", model_id: "missing-model", thinking_level: "low" },
      IMPLEMENTER: { source: "INHERIT_SUPERVISOR" },
      VERIFIER: { source: "PI_CONFIG", provider_id: "no-auth-provider", model_id: "verifier-model", thinking_level: "INHERIT_SUPERVISOR" },
      INTEGRATOR: { source: "INHERIT_SUPERVISOR" },
    },
  };
}

describe("Multi worker runtime policy", () => {
  it("uses the supervisor runtime without consulting a catalog on the default path", () => {
    const lookup = vi.fn();
    const resolved = resolveWorkerRuntimeMap(supervisor, undefined, lookup);
    expect(rolePolicyNeedsModelCatalog(undefined)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(Object.values(resolved)).toHaveLength(5);
    expect(Object.values(resolved).every((item) => item.runtime === supervisor && item.source === "SUPERVISOR_INHERITED")).toBe(true);
  });

  it("resolves only explicit Pi-configured roles and falls back without changing the supervisor", () => {
    const configured = policy();
    expect(rolePolicyNeedsModelCatalog(configured)).toBe(true);
    const resolved = resolveWorkerRuntimeMap(supervisor, configured, (provider, model) => {
      if (provider === "configured-provider" && model === "planner-model") {
        return { ok: true, api: "configured-api", contextWindow: 64_000 };
      }
      return provider === "no-auth-provider"
        ? { ok: false, reason: "AUTH_NOT_CONFIGURED" }
        : { ok: false, reason: "MODEL_NOT_FOUND" };
    });
    expect(resolved.PLANNER).toEqual({
      runtime: { provider: "configured-provider", api: "configured-api", model: "planner-model", thinking_level: "medium", context_window: 64_000 },
      source: "PI_CONFIG", source_profile_id: "PI_CONFIG_ROLE:PLANNER", fallback_reason: null,
    });
    expect(resolved.EXPLORER).toMatchObject({
      runtime: supervisor, source: "SUPERVISOR_FALLBACK", source_profile_id: "PI_CONFIG_ROLE:EXPLORER",
      fallback_reason: "MODEL_NOT_FOUND",
    });
    expect(resolved.VERIFIER).toMatchObject({
      runtime: supervisor, source: "SUPERVISOR_FALLBACK", source_profile_id: "PI_CONFIG_ROLE:VERIFIER",
      fallback_reason: "AUTH_NOT_CONFIGURED",
    });
    expect(resolved.IMPLEMENTER).toMatchObject({ runtime: supervisor, source: "SUPERVISOR_INHERITED", fallback_reason: null });
  });
});
