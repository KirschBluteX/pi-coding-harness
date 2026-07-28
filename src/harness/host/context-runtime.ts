import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import type { CodingHarnessConfig } from "../../config/types.js";
import { normalizeToolEffect, type ToolInvocation } from "../../effects/normalize.js";
import { InputContextRuntime, type InputContextAddition } from "../../input-context/runtime.js";
import type { TaskFlowSession } from "../../runtime/task-flow-session.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { sha256Hex } from "../../foundation/crypto.js";
import type { WorkerRuntimeSelection } from "../worker/executor.js";
import type { CacheV2ContextSeed } from "../../cache-v2/runtime.js";
import type { RetainedContextDescriptor } from "../../input-context/retained-ledger.js";
import type { ProviderTurnHistorySummary, ProviderUsage } from "../../input-context/provider-turn-ledger.js";
import type { ContextToolRequest, ContextToolResponse } from "../../input-context/context-tool.js";
import { HarnessOutputPolicy } from "../output-policy.js";
import type { CurrentControlFrame } from "../../control/control-frame.js";
import {
  applyProjectionDelta, type ContextProjectionDelta, type ProjectionDeltaApplyResult,
} from "../../input-context/projection-delta.js";

export interface HarnessTurnPreparation {
  readonly system_prompt: string;
  readonly changed: boolean;
  readonly context_projection_active: boolean;
  readonly mode: CodingHarnessConfig["modules"]["input_context"]["mode"];
  readonly fit_disposition: string;
  readonly fallback: string | null;
  readonly memory_projected: boolean;
  readonly subject_binding_sha256: string;
  readonly control_frame: CurrentControlFrame;
}

export class HarnessContextRuntime {
  private readonly runtime: InputContextRuntime;
  private currentRuntime: WorkerRuntimeSelection;
  private readonly prompts = new Map<string, string>();
  private lastCacheSeed: CacheV2ContextSeed | null = null;
  private readonly outputPolicy: HarnessOutputPolicy;
  private projectionState: {
    readonly lineage_id: string;
    readonly sequence_root: string;
    readonly count: number;
    readonly descriptors: readonly RetainedContextDescriptor[];
  } | null = null;

  constructor(private readonly options: {
    readonly session: TaskFlowSession;
    readonly config: CodingHarnessConfig;
    readonly runtimeSelection: WorkerRuntimeSelection;
  }) {
    const resources = options.session.resources();
    if (!resources) throw new TypeError("Harness context requires initialized runtime resources");
    this.currentRuntime = options.runtimeSelection;
    this.outputPolicy = new HarnessOutputPolicy(options.config.modules.output.enabled);
    this.runtime = new InputContextRuntime({
      config: options.config.modules.input_context, authority: resources.authority, artifacts: resources.artifacts,
      workspaceRoot: options.session.workspaceRoot(), hmacKey: resources.workspaceSecret,
    });
  }

  updateRuntime(runtime: WorkerRuntimeSelection): void { this.currentRuntime = runtime; }

  prepare(input: {
    readonly systemPromptSha256: string;
    readonly systemPrompt?: string;
    readonly currentInputTokens: number | null;
    readonly activeTools: readonly string[];
    readonly allTools: readonly string[];
  }): HarnessTurnPreparation {
    if (input.systemPrompt !== undefined) {
      if (sha256Hex(input.systemPrompt) !== input.systemPromptSha256) throw new TypeError("System prompt hash mismatch");
      this.prompts.delete(input.systemPromptSha256);
      this.prompts.set(input.systemPromptSha256, input.systemPrompt);
      while (this.prompts.size > 2) this.prompts.delete(this.prompts.keys().next().value!);
    }
    const base = this.prompts.get(input.systemPromptSha256);
    if (base === undefined) throw new TypeError("System prompt bytes are required for an unknown prompt hash");
    const workflow = this.options.session.workflowPrompt();
    const protectedState = this.options.session.protectedProjection();
    const subject = this.options.session.executionSubject();
    const runtimeFingerprintSha256 = canonicalJsonSha256({
      domain: "PCH-RUNTIME-FINGERPRINT-V1", provider: this.currentRuntime.provider, api: this.currentRuntime.api,
      model: this.currentRuntime.model, thinkingLevel: this.currentRuntime.thinking_level,
      contextWindow: this.currentRuntime.context_window,
    });
    const memoryEligible = this.options.config.modules.memory.enabled
      && this.options.config.modules.memory.mode !== "OFF";
    const memory = memoryEligible ? this.options.session.memoryProjection() : null;
    const output = this.outputPolicy.addition();
    const additions: InputContextAddition[] = [
      {
        marker: "[PI-CODING-HARNESS-WORKFLOW-V1]", type: "PCH_WORKFLOW", content: workflow,
        sourceBindingSha256: workflow ? sha256Hex(workflow) : null, owner: "INPUT_CONTEXT",
        inputSurface: "PCH_WORKFLOW_CONTROL", lifecycle: "GENERATION_STABLE", containsUserContent: true,
      },
      {
        marker: "[PI-CODING-HARNESS-PROTECTED-V1]", type: "PCH_PROTECTED", content: protectedState,
        sourceBindingSha256: protectedState ? sha256Hex(protectedState) : null, owner: "INPUT_CONTEXT",
        inputSurface: "PCH_PROTECTED_AUTHORITY", lifecycle: "APPEND_ONLY_DELTA", containsUserContent: true,
      },
      {
        marker: output.marker, type: "PCH_OUTPUT_POLICY",
        content: output.content, sourceBindingSha256: output.sourceBindingSha256,
        owner: "OUTPUT", inputSurface: "PCH_STABLE_POLICY", lifecycle: "LINEAGE_STABLE", containsUserContent: false,
      },
    ];
    const effectiveMode = this.options.config.modules.input_context.enabled
      ? this.options.config.modules.input_context.mode : "OFF";
    const generationId = idFromSha256("PROMPT_GENERATION", sha256Hex(`${subject.bindingSha256}\0${runtimeFingerprintSha256}\0${input.systemPromptSha256}`));
    const prepared = this.runtime.prepareTurn({
      generationId, systemPrompt: base, additions, seed: this.options.session.inputContextSeed(), memory,
      runtimeFingerprintSha256, contextWindowTokens: this.currentRuntime.context_window,
      currentInputTokens: input.currentInputTokens, activeTools: input.activeTools, allTools: input.allTools, effectiveMode,
    });
    const snapshot = this.runtime.integrationSnapshot();
    this.lastCacheSeed = {
      promptGenerationId: generationId, systemPromptSha256: input.systemPromptSha256,
      layoutManifestSha256: snapshot?.layout_manifest_sha256 ?? null,
      toolSurfaceSha256: snapshot?.tool_surface_plan_sha256 ?? canonicalJsonSha256({ active: input.activeTools, all: input.allTools }),
      subjectBindingSha256: subject.bindingSha256,
    };
    return {
      system_prompt: prepared.systemPrompt, changed: prepared.systemPromptChanged,
      context_projection_active: prepared.contextProjectionRequired,
      mode: prepared.mode, fit_disposition: prepared.fitDisposition, fallback: prepared.fallback,
      memory_projected: memory !== null, subject_binding_sha256: subject.bindingSha256,
      control_frame: this.options.session.controlFrame(this.lastCacheSeed.toolSurfaceSha256),
    };
  }

  currentControlFrame(): CurrentControlFrame | null {
    return this.lastCacheSeed ? this.options.session.controlFrame(this.lastCacheSeed.toolSurfaceSha256) : null;
  }

  project(messages: readonly unknown[]): { readonly messages: readonly unknown[]; readonly changed: boolean } {
    return this.runtime.project(messages);
  }

  projectDescriptors(descriptors: readonly RetainedContextDescriptor[], removed: number) {
    return this.runtime.projectDescriptors(descriptors, removed);
  }

  projectDescriptorDelta(delta: ContextProjectionDelta, removed: number) {
    const current = this.projectionState ?? { lineage_id: "", sequence_root: "", count: 0, descriptors: [] };
    const applied = applyProjectionDelta(current, delta);
    if (!applied.accepted) {
      return {
        changed: false, overlays: [], projectedSegmentCount: 0,
        removedPersistedHarnessMessages: removed, fallback: "NONE" as const,
        projection_ack: applied,
      };
    }
    const descriptors = delta.full_reconcile
      ? [...delta.append] : [...current.descriptors, ...delta.append];
    if (descriptors.length !== applied.count) throw new TypeError("Projection delta descriptor count mismatch");
    const projected = this.runtime.projectDescriptors(descriptors, removed);
    this.projectionState = {
      lineage_id: delta.lineage_id, sequence_root: applied.sequence_root,
      count: applied.count, descriptors,
    };
    return { ...projected, projection_ack: applied satisfies ProjectionDeltaApplyResult };
  }

  context(request: ContextToolRequest): Promise<ContextToolResponse> {
    return this.runtime.context(request);
  }

  cacheSeed(): CacheV2ContextSeed {
    if (!this.lastCacheSeed) throw new TypeError("Cache attribution requires a prepared Harness turn");
    return this.lastCacheSeed;
  }

  beginProviderTurn(input: {
    readonly payloadShapeSha256: string;
    readonly history: ProviderTurnHistorySummary;
    readonly toolSchemaBytes: number;
  }): boolean {
    if (!this.lastCacheSeed || !this.options.config.modules.input_context.enabled) return false;
    this.runtime.beginProviderTurn({
      promptGenerationId: this.lastCacheSeed.promptGenerationId,
      payloadShapeSha256: input.payloadShapeSha256,
      history: input.history,
      toolSchemaBytes: input.toolSchemaBytes,
    });
    return this.runtime.lastError() === null;
  }

  settleProviderTurn(input: {
    readonly usage: ProviderUsage | null;
    readonly responseStatus: number | null;
    readonly outcome: "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
    readonly assistantTextBytes: number;
    readonly toolArgumentBytes: number;
  }): string | null {
    return this.runtime.settleProviderTurn(input)?.record_sha256 ?? null;
  }

  guard(invocation: ToolInvocation): { readonly allow: boolean; readonly reason: string | null } {
    return this.runtime.guardMutation(normalizeToolEffect(invocation), invocation.input);
  }

  capturesToolResults(): boolean { return this.runtime.capturesToolResults(); }

  capture(input: {
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly result: string;
    readonly isError: boolean;
  }): void {
    const seed = this.options.session.inputContextSeed();
    if (seed) this.runtime.captureToolResult({ seed, ...input });
  }

  shutdown(): void { this.runtime.shutdown(); }
}
