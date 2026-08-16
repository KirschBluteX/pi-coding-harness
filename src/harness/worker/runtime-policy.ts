import type { WorkerRuntimePolicyConfig } from "../../config/types.js";
import { workerRoles, type WorkerRole } from "../domain.js";

export interface WorkerRuntimeSelection {
  readonly provider: string;
  readonly api: string;
  readonly base_url?: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
}

export type WorkerRuntimeSource = "SUPERVISOR_INHERITED" | "PI_CONFIG" | "SUPERVISOR_FALLBACK";

export interface ResolvedWorkerRuntime {
  readonly runtime: WorkerRuntimeSelection;
  readonly source: WorkerRuntimeSource;
  readonly source_profile_id?: string;
  readonly fallback_reason: "MODEL_NOT_FOUND" | "AUTH_NOT_CONFIGURED" | null;
}

export type WorkerRuntimeMap = Readonly<Record<WorkerRole, ResolvedWorkerRuntime>>;

export type WorkerModelLookup = (
  providerId: string,
  modelId: string,
) =>
  | { readonly ok: true; readonly api: string; readonly contextWindow: number }
  | { readonly ok: false; readonly reason: "MODEL_NOT_FOUND" | "AUTH_NOT_CONFIGURED" };

function inherited(
  supervisor: WorkerRuntimeSelection,
  fallbackReason: ResolvedWorkerRuntime["fallback_reason"] = null,
  sourceProfileId?: string,
): ResolvedWorkerRuntime {
  return {
    runtime: supervisor,
    source: fallbackReason === null ? "SUPERVISOR_INHERITED" : "SUPERVISOR_FALLBACK",
    ...(sourceProfileId === undefined ? {} : { source_profile_id: sourceProfileId }),
    fallback_reason: fallbackReason,
  };
}

export function rolePolicyNeedsModelCatalog(policy: WorkerRuntimePolicyConfig | undefined): boolean {
  return policy !== undefined && workerRoles.some((role) => policy.roles[role].source === "PI_CONFIG");
}

export function resolveWorkerRuntimeMap(
  supervisor: WorkerRuntimeSelection,
  policy: WorkerRuntimePolicyConfig | undefined,
  lookup?: WorkerModelLookup,
): WorkerRuntimeMap {
  const entries = workerRoles.map((role): readonly [WorkerRole, ResolvedWorkerRuntime] => {
    const profile = policy?.roles[role];
    if (!profile || profile.source === "INHERIT_SUPERVISOR") return [role, inherited(supervisor)];
    if (!lookup) throw new TypeError("PI_CONFIG worker roles require the Pi model catalog");
    const found = lookup(profile.provider_id, profile.model_id);
    if (!found.ok) return [role, inherited(supervisor, found.reason, `PI_CONFIG_ROLE:${role}`)];
    return [role, {
      runtime: {
        provider: profile.provider_id,
        api: found.api,
        model: profile.model_id,
        thinking_level: profile.thinking_level === "INHERIT_SUPERVISOR"
          ? supervisor.thinking_level
          : profile.thinking_level,
        context_window: found.contextWindow,
      },
      source: "PI_CONFIG",
      source_profile_id: `PI_CONFIG_ROLE:${role}`,
      fallback_reason: null,
    }];
  });
  return Object.fromEntries(entries) as WorkerRuntimeMap;
}
