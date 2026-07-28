import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { AuthorityStore } from "../authority/transactions.js";
import type { InputContextModuleConfig } from "../config/types.js";
import type { NormalizedEffect } from "../effects/normalize.js";
import type { MemoryContextMessage } from "../memory/context-projector.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { ExecutionSubjectRef } from "../task-flow/domain.js";
import type { RehydrationSource } from "./batch-rehydrator.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import { ContextCompiler, type ContextCompileResult } from "./context-compiler.js";
import { ContextToolRuntime, type ContextToolRequest, type ContextToolResponse, type ContextToolSnapshot } from "./context-tool.js";
import { describeToolCapture } from "./capture-adapters.js";
import type {
  ContextCandidateRecord, ContextDemandRecord, ContextLayoutManifestRecord, EvidenceObligationRecord,
  ContextProfile, InputSurface, ProviderTurnLedgerRecord, ToolSurfacePlanRecord,
} from "./domain.js";
import { EvidenceCatalog, type EvidenceCaptureResult } from "./evidence-catalog.js";
import { InputContextMutationGuard } from "./mutation-guard.js";
import {
  PiContextProjector, inputContextMessageType,
  type ContextProjectionDirective, type ProviderContextSegment,
} from "./pi-context-projector.js";
import type { RetainedContextDescriptor } from "./retained-ledger.js";
import { ProjectionSaga } from "./projection-saga.js";
import { PromptLayoutPlanner, type PromptLayoutSegment } from "./prompt-layout.js";
import {
  ProviderTurnLedgerCoordinator, type ContributionSeed, type ProviderTurnHistorySummary, type ProviderUsage,
} from "./provider-turn-ledger.js";
import { ToolSurfaceCoordinator } from "./tool-surface.js";
import { StructuralContextService } from "./structural/service.js";
import { sealInputContextConsumerSnapshot, type InputContextConsumerSnapshot } from "./integration-contracts.js";

export interface InputContextSeed {
  readonly workspaceId: string;
  readonly subject: ExecutionSubjectRef;
  readonly obligations: readonly EvidenceObligationRecord[];
  readonly nextActionSha256: string | null;
  readonly sourceClosureRootSha256: string | null;
  readonly acceptanceClosureRootSha256: string | null;
}

export interface InputContextAddition {
  readonly marker: string;
  readonly type: string;
  readonly content: string | null;
  readonly sourceBindingSha256: string | null;
  readonly owner: ContributionSeed["owner"];
  readonly inputSurface: InputSurface;
  readonly lifecycle: PromptLayoutSegment["lifecycle"];
  readonly containsUserContent: boolean;
}

export interface InputContextPreparation {
  readonly systemPrompt: string;
  readonly systemPromptChanged: boolean;
  readonly mode: InputContextModuleConfig["mode"];
  readonly fitDisposition: ContextCompileResult["fitDisposition"] | "PASS_THROUGH";
  readonly envelopeSha256: string | null;
  readonly fallback: string | null;
  readonly contextProjectionRequired: boolean;
}

interface CandidateContent {
  readonly candidate: ContextCandidateRecord;
  readonly content: string | null;
  readonly receiptId: string | null;
  readonly subjectBindingSha256: string;
  readonly sourcePath: string | null;
}

interface EnrichedLayoutSegment extends PromptLayoutSegment {
  readonly owner: ContributionSeed["owner"];
  readonly inputSurface: InputSurface;
}

const mutationTools = new Set(["write", "edit", "write_file", "edit_file"]);
const exactEditPreimageMaximumBytes = 8 * 1024 * 1024;
const exactEditArgumentMaximumBytes = 1024 * 1024;

function estimateTokens(content: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4)); }

function normalizedLf(value: string): string { return value.replace(/\r\n?/gu, "\n"); }

export function exactEditPreimageProvesCurrentSource(
  path: string, input: Readonly<Record<string, unknown>>,
): boolean {
  if (!existsSync(path)) return false;
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > exactEditPreimageMaximumBytes) return false;
  const rawEdits = Array.isArray(input.edits) ? input.edits
    : typeof input.oldText === "string" && typeof input.newText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }] : null;
  if (!rawEdits || rawEdits.length < 1 || rawEdits.length > 64) return false;
  const edits = rawEdits.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const edit = value as Record<string, unknown>;
    return typeof edit.oldText === "string" && typeof edit.newText === "string"
      ? { oldText: normalizedLf(edit.oldText), newText: normalizedLf(edit.newText) } : null;
  });
  if (edits.some((edit) => edit === null)) return false;
  const typed = edits as { readonly oldText: string; readonly newText: string }[];
  if (typed.some((edit) => !edit.oldText)
    || typed.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText), 0)
      > exactEditArgumentMaximumBytes) return false;
  const content = normalizedLf(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
  const matches = typed.map((edit) => {
    const start = content.indexOf(edit.oldText);
    return start >= 0 && content.indexOf(edit.oldText, start + 1) < 0
      ? { start, end: start + edit.oldText.length } : null;
  });
  if (matches.some((match) => match === null)) return false;
  const ordered = (matches as { readonly start: number; readonly end: number }[])
    .slice().sort((left, right) => left.start - right.start);
  return ordered.every((match, index) => index === 0 || ordered[index - 1]!.end <= match.start);
}

function contextStep<T>(code: string, action: () => T): T {
  try { return action(); }
  catch (error) {
    throw new TypeError(`PCH_INPUT_CONTEXT_${code}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function candidateStatus(candidate: ContextCandidateRecord): RehydrationSource["status"] {
  if (candidate.classification === "SENSITIVE") return "SENSITIVE_REFUSED";
  if (candidate.scope_authorization !== "AUTHORIZED") return "UNAUTHORIZED";
  if (!(["CURRENT", "NOT_APPLICABLE"] as const).includes(candidate.semantic_applicability as "CURRENT" | "NOT_APPLICABLE")) return "SUPERSEDED";
  if (!(["HASH_CURRENT", "CHANGE_WITNESS_CURRENT", "NOT_APPLICABLE"] as const)
    .includes(candidate.content_freshness as "HASH_CURRENT" | "CHANGE_WITNESS_CURRENT" | "NOT_APPLICABLE")) return "STALE";
  if (!(["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"] as const)
    .includes(candidate.representation_fidelity as "EXACT_RAW" | "EXACT_DECODED" | "TYPED_EXTRACT")) return "INSUFFICIENT";
  return "CURRENT";
}

function surfaceForCandidate(candidate: ContextCandidateRecord): InputSurface {
  if (candidate.source_kind === "MEMORY") return "PCH_MEMORY";
  if (candidate.source_kind === "TOOL_RESULT") return "PCH_TOOL_RESULT";
  return "PCH_EVIDENCE";
}

function ownerForCandidate(candidate: ContextCandidateRecord): ContributionSeed["owner"] {
  return candidate.source_kind === "MEMORY" ? "MEMORY" : "INPUT_CONTEXT";
}

export class InputContextRuntime {
  private readonly compiler: ContextCompiler;
  private readonly projector: PiContextProjector;
  private readonly layoutPlanner: PromptLayoutPlanner;
  private readonly tools = new ToolSurfaceCoordinator();
  private readonly saga: ProjectionSaga;
  private readonly turns: ProviderTurnLedgerCoordinator;
  private readonly catalog: EvidenceCatalog;
  private readonly mutationGuard: InputContextMutationGuard;
  private readonly contextTool: ContextToolRuntime;
  private readonly structural: StructuralContextService;
  private readonly captured = new Map<string, CandidateContent>();
  private currentCandidates = new Map<string, CandidateContent>();
  private currentCompile: ContextCompileResult | null = null;
  private currentLayout: ContextLayoutManifestRecord | null = null;
  private currentToolSurface: ToolSurfacePlanRecord | null = null;
  private currentContributionSeeds: readonly ContributionSeed[] = [];
  private currentProfile: ContextProfile | null = null;
  private currentMode: InputContextModuleConfig["mode"] = "OFF";
  private recoveryRequested = false;
  private lastErrorValue: string | null = null;
  private lastLedgerValue: ProviderTurnLedgerRecord | null = null;

  constructor(private readonly options: {
    readonly config: InputContextModuleConfig;
    readonly authority: AuthorityStore;
    readonly artifacts: ArtifactStore;
    readonly workspaceRoot: string;
    readonly hmacKey: string | Uint8Array;
    readonly nowMs?: () => number;
  }) {
    const now = options.nowMs ?? Date.now;
    this.compiler = new ContextCompiler(options.hmacKey);
    this.projector = new PiContextProjector(options.hmacKey, now);
    this.layoutPlanner = new PromptLayoutPlanner(options.hmacKey);
    this.saga = new ProjectionSaga(options.authority, options.hmacKey, now);
    this.turns = new ProviderTurnLedgerCoordinator(options.authority, options.hmacKey, now);
    this.catalog = new EvidenceCatalog(options.authority, options.artifacts, options.workspaceRoot, options.hmacKey, now);
    this.mutationGuard = new InputContextMutationGuard(this.catalog);
    this.structural = new StructuralContextService({ workspaceRoot: options.workspaceRoot });
    this.contextTool = new ContextToolRuntime(
      () => this.toolSnapshot(), options.hmacKey, options.config.max_batch_items,
      options.config.max_batch_bytes, options.config.cursor_ttl_ms, now,
    );
  }

  prepareTurn(input: {
    readonly generationId: string;
    readonly systemPrompt: string;
    readonly additions: readonly InputContextAddition[];
    readonly seed: InputContextSeed | null;
    readonly memory: MemoryContextMessage | null;
    readonly runtimeFingerprintSha256: string;
    readonly contextWindowTokens: number | null;
    readonly currentInputTokens: number | null;
    readonly activeTools: readonly string[];
    readonly allTools: readonly string[];
    readonly effectiveMode?: InputContextModuleConfig["mode"];
  }): InputContextPreparation {
    this.lastErrorValue = null;
    const configuredMode = this.options.config.enabled ? this.options.config.mode : "OFF";
    const mode = input.effectiveMode ?? configuredMode;
    this.currentMode = mode;
    const additions = input.additions.filter((entry) => entry.content !== null && entry.content.length > 0);
    const includedAdditions = additions.filter((entry) => !input.systemPrompt.includes(entry.marker));
    if (!input.seed || input.seed.subject.kind === "NONE" || mode === "OFF") {
      this.currentCompile = null;
      this.currentCandidates.clear();
      this.currentLayout = null;
      this.currentToolSurface = null;
      this.currentContributionSeeds = [];
      this.currentProfile = null;
      this.saga.clear();
      const prepared = this.projector.prepareSystemPrompt({
        generationId: input.generationId,
        systemPrompt: input.systemPrompt,
        additions: additions.map((entry) => ({ marker: entry.marker, content: entry.content })),
      });
      return {
        systemPrompt: prepared.systemPrompt, systemPromptChanged: prepared.systemPromptChanged,
        mode, fitDisposition: "PASS_THROUGH", envelopeSha256: null, fallback: null,
        contextProjectionRequired: this.projector.hasProjection(),
      };
    }

    try {
      const demand = this.demand(input.seed, input.runtimeFingerprintSha256, input.contextWindowTokens, input.currentInputTokens);
      this.currentProfile = demand.profile;
      const candidateContents = this.candidates(input.seed, additions, input.memory);
      const candidates = [...candidateContents.values()].map((entry) => entry.candidate);
      const retained = this.projector.currentRetained();
      const compile = this.compiler.compile({
        demand, candidates, retainedRootSha256: retained.rootSha256, retainedCandidates: [],
        promptGenerationId: input.generationId,
        budget: {
          contextWindowTokens: input.contextWindowTokens,
          currentInputTokens: input.currentInputTokens,
          outputReserveTokens: 1_024,
          softEvidenceTokens: this.options.config.soft_evidence_tokens,
          hardEvidenceTokens: this.options.config.hard_evidence_tokens,
        },
        unknownCandidateTokens: 512,
        nowMs: this.nowMs(),
      });
      contextStep("WORKING_SET_PERSIST_FAILED", () =>
        this.options.authority.storeInputContextWorkingSet(compile.workingSet, compile.envelope));
      contextStep("COMPILE_RECEIPT_PERSIST_FAILED", () =>
        this.options.authority.insertInputContextCompileReceipt(compile.receipt));
      this.currentCompile = compile;
      this.currentCandidates = candidateContents;

      const optionalSegments = this.optionalSegments(compile, candidateContents);
      const enriched: EnrichedLayoutSegment[] = [
        {
          type: "PI_BASE_SYSTEM", lifecycle: "LINEAGE_STABLE", sourceBindingSha256: sha256Hex(input.systemPrompt),
          semanticVersion: "pi-runtime", content: input.systemPrompt, containsUserContent: true,
          owner: "PI", inputSurface: "PI_BASE_SYSTEM",
        },
        ...additions.map((entry): EnrichedLayoutSegment => ({
          type: entry.type, lifecycle: entry.lifecycle,
          sourceBindingSha256: entry.sourceBindingSha256 ?? sha256Hex(entry.content!),
          semanticVersion: "pch-v1", content: entry.content!, containsUserContent: entry.containsUserContent,
          owner: entry.owner, inputSurface: entry.inputSurface,
        })),
        ...optionalSegments,
      ];
      const layout = this.layoutPlanner.plan({
        envelopeSha256: compile.envelope.record_sha256,
        promptGenerationId: input.generationId,
        segments: enriched,
      });
      const toolSurface = this.tools.plan({
        envelopeSha256: compile.envelope.record_sha256,
        userActiveTools: input.activeTools,
        allConfiguredTools: input.allTools,
        capability: {
          epochSha256: canonicalJsonSha256({ domain: "PCH-TOOL-SURFACE-CAPABILITY-V1", deferred: false, additive: false }),
          deferredToolsProven: false,
          additiveDiscoveryProven: false,
        },
      });
      contextStep("LAYOUT_PERSIST_FAILED", () => this.options.authority.insertInputContextLayoutManifest(layout));
      contextStep("TOOL_SURFACE_PERSIST_FAILED", () => this.options.authority.insertInputContextToolSurfacePlan(toolSurface));
      this.currentLayout = layout;
      this.currentToolSurface = toolSurface;
      this.currentContributionSeeds = enriched.map((segment) => ({
        owner: segment.owner, inputSurface: segment.inputSurface,
        segmentIdentityHmac: hmacSha256Hex(this.options.hmacKey, segment.content),
        logicalBytes: Buffer.byteLength(segment.content, "utf8"),
        tokens: estimateTokens(segment.content), evidence: "LOCAL_ESTIMATE" as const,
      }));
      contextStep("PROJECTION_PREPARE_FAILED", () =>
        this.saga.prepare({ envelope: compile.envelope, toolSurface, layout, runtimeFingerprintSha256: input.runtimeFingerprintSha256 }));
      const optionalContent = optionalSegments.length === 0 ? null : optionalSegments
        .map((segment) => `[${segment.type}]\n${segment.content}`).join("\n\n");
      const providerSegment: ProviderContextSegment | null = mode === "AUTO_GUARDED" && optionalContent
        && (compile.fitDisposition === "FIT" || compile.fitDisposition === "FIT_WITH_ON_DEMAND") ? {
          segmentId: compile.envelope.envelope_id,
          customType: inputContextMessageType,
          content: optionalContent,
          sourceBindingSha256: compile.envelope.record_sha256,
          contributionClaim: {
            owner: "INPUT_CONTEXT", envelopeSha256: compile.envelope.record_sha256,
            layoutManifestSha256: layout.record_sha256, persistence: "EPHEMERAL_PROVIDER_CONTEXT",
          },
        } : null;
      const prepared = this.projector.prepareSystemPrompt({
        generationId: input.generationId,
        systemPrompt: input.systemPrompt,
        additions: includedAdditions.map((entry) => ({ marker: entry.marker, content: entry.content })),
        segment: providerSegment,
      });
      const fallback = prepared.stagedSegment === "BOUNDARY_REQUIRED" ? "GENERATION_BOUNDARY_REQUIRED"
        : compile.receipt.fallback === "NONE" ? null : compile.receipt.fallback;
      return {
        systemPrompt: prepared.systemPrompt, systemPromptChanged: prepared.systemPromptChanged,
        mode, fitDisposition: compile.fitDisposition, envelopeSha256: compile.envelope.record_sha256, fallback,
        contextProjectionRequired: this.projector.hasProjection(),
      };
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error);
      this.currentCompile = null;
      this.currentCandidates.clear();
      this.currentLayout = null;
      this.currentToolSurface = null;
      this.currentContributionSeeds = [];
      this.currentProfile = null;
      this.saga.clear();
      const prepared = this.projector.prepareSystemPrompt({
        generationId: input.generationId, systemPrompt: input.systemPrompt,
        additions: additions.map((entry) => ({ marker: entry.marker, content: entry.content })),
      });
      return {
        systemPrompt: prepared.systemPrompt, systemPromptChanged: prepared.systemPromptChanged,
        mode, fitDisposition: "BASELINE_FALLBACK", envelopeSha256: null, fallback: "PI_BASELINE",
        contextProjectionRequired: this.projector.hasProjection(),
      };
    }
  }

  project<T>(messages: readonly T[]): { readonly messages: readonly T[]; readonly changed: boolean } {
    const projected = this.projector.project(messages);
    try {
      if (projected.fallback === "BASELINE_INVALID_ANCHOR") this.saga.transition("ABANDONED", "PCH_HOOK_OUTPUT");
      else if (this.saga.latest()?.projection_state === "PREPARED") this.saga.transition("APPLIED", "PCH_HOOK_OUTPUT");
    } catch (error) { this.lastErrorValue = error instanceof Error ? error.message : String(error); }
    return { messages: projected.messages, changed: projected.changed };
  }

  projectDescriptors(
    descriptors: readonly RetainedContextDescriptor[],
    removedPersistedHarnessMessages: number,
  ): ContextProjectionDirective {
    const projected = this.projector.projectDescriptors(descriptors, removedPersistedHarnessMessages);
    try {
      if (projected.fallback === "BASELINE_INVALID_ANCHOR") this.saga.transition("ABANDONED", "PCH_HOOK_OUTPUT");
      else if (this.saga.latest()?.projection_state === "PREPARED") this.saga.transition("APPLIED", "PCH_HOOK_OUTPUT");
    } catch (error) { this.lastErrorValue = error instanceof Error ? error.message : String(error); }
    return projected;
  }

  beginProviderTurn(input: {
    readonly promptGenerationId: string;
    readonly payloadShapeSha256: string;
    readonly history: ProviderTurnHistorySummary;
    readonly toolSchemaBytes: number;
  }): void {
    try {
      const historySeeds: ContributionSeed[] = [];
      if (input.history.userBytes > 0) historySeeds.push({
        owner: "USER", inputSurface: "USER_HISTORY", logicalBytes: input.history.userBytes,
        segmentIdentityHmac: hmacSha256Hex(this.options.hmacKey, `${input.history.descriptorRootSha256}\0USER`),
        tokens: null, evidence: "UNOBSERVABLE",
      });
      if (input.history.assistantBytes + input.history.otherBytes > 0) historySeeds.push({
        owner: "PI", inputSurface: "ASSISTANT_HISTORY",
        logicalBytes: input.history.assistantBytes + input.history.otherBytes,
        segmentIdentityHmac: hmacSha256Hex(this.options.hmacKey, `${input.history.descriptorRootSha256}\0PI`),
        tokens: null, evidence: "UNOBSERVABLE",
      });
      historySeeds.push({
        owner: "PI", inputSurface: "TOOL_SCHEMAS", logicalBytes: input.toolSchemaBytes,
        tokens: null, evidence: "UNOBSERVABLE",
      });
      this.turns.begin({
        promptGenerationId: input.promptGenerationId, payloadShapeSha256: input.payloadShapeSha256,
        history: input.history, toolSchemaBytes: input.toolSchemaBytes,
        contextEnvelopeSha256: this.currentCompile?.envelope.record_sha256 ?? null,
        layout: this.currentLayout,
        contributions: [...this.currentContributionSeeds, ...historySeeds],
      });
      if (this.saga.latest()?.projection_state === "APPLIED") this.saga.transition("REQUEST_OBSERVED", "PCH_HOOK_OUTPUT");
    } catch (error) { this.lastErrorValue = error instanceof Error ? error.message : String(error); }
  }

  settleProviderTurn(input: {
    readonly usage: ProviderUsage | null;
    readonly responseStatus: number | null;
    readonly outcome: "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
    readonly assistantTextBytes: number;
    readonly toolArgumentBytes: number;
  }): ProviderTurnLedgerRecord | null {
    try {
      const outputSeeds: ContributionSeed[] = [];
      if (input.assistantTextBytes > 0) outputSeeds.push({
        owner: "OUTPUT", outputSurface: "ASSISTANT_TEXT",
        logicalBytes: input.assistantTextBytes, tokens: null, evidence: "UNOBSERVABLE",
      });
      if (input.toolArgumentBytes > 0) outputSeeds.push({
        owner: "OUTPUT", outputSurface: "TOOL_CALL_ARGUMENTS",
        logicalBytes: input.toolArgumentBytes, tokens: null, evidence: "UNOBSERVABLE",
      });
      const ledger = this.turns.settle({
        usage: input.usage, responseStatus: input.responseStatus, outcome: input.outcome, outputSeeds,
      });
      this.lastLedgerValue = ledger;
      const latest = this.saga.latest();
      if (latest?.projection_state === "REQUEST_OBSERVED" || latest?.projection_state === "OUTCOME_UNKNOWN") {
        this.saga.transition("COMPLETED", "PCH_HOOK_OUTPUT");
      }
      return ledger;
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  captureToolResult(input: {
    readonly seed: InputContextSeed;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly result: string;
    readonly isError: boolean;
  }): EvidenceCaptureResult {
    const descriptor = describeToolCapture(input.toolName, input.toolInput, input.result, input.isError);
    const captured = descriptor.reusableCurrentSource && descriptor.path
      ? this.catalog.captureFile({ workspaceId: input.seed.workspaceId, subject: input.seed.subject, path: descriptor.path })
      : this.catalog.captureToolResult({
        workspaceId: input.seed.workspaceId, subject: input.seed.subject, toolName: input.toolName,
        toolInput: input.toolInput, result: input.result, isError: input.isError, descriptor,
      });
    if (captured.receipt) {
      const rawCandidate = this.catalog.candidate(captured.receipt.receipt_id);
      if (rawCandidate) {
        const content = captured.artifact ? Buffer.from(this.options.artifacts.open(captured.artifact.locator)).toString("utf8") : null;
        const candidate = sealInputContextRecord(inputContextHashDomains.contextCandidate, "record_sha256", {
          ...Object.fromEntries(Object.entries(rawCandidate).filter(([key]) => key !== "record_sha256")),
          estimated_tokens: content === null ? null : estimateTokens(content),
        } as Omit<ContextCandidateRecord, "record_sha256">);
        this.captured.set(candidate.candidate_id, {
          candidate, content, receiptId: captured.receipt.receipt_id,
          subjectBindingSha256: input.seed.subject.bindingSha256,
          sourcePath: descriptor.path === null ? null
            : relative(this.options.workspaceRoot, resolve(this.options.workspaceRoot, descriptor.path)).replace(/\\/gu, "/"),
        });
        while (this.captured.size > 128) this.captured.delete(this.captured.keys().next().value!);
      }
    }
    return captured;
  }

  guardMutation(
    effect: NormalizedEffect, toolInput: Readonly<Record<string, unknown>> = {},
  ): { readonly allow: boolean; readonly reason: string | null } {
    if (this.currentMode !== "AUTO_GUARDED" || !mutationTools.has(effect.toolName.toLowerCase())
      || effect.effectClass !== "LOCAL_REVERSIBLE_WRITE") return { allow: true, reason: null };
    if (!existsSync(effect.normalizedTarget)) return { allow: true, reason: null };
    if (["edit", "edit_file"].includes(effect.toolName.toLowerCase())
      && exactEditPreimageProvesCurrentSource(effect.normalizedTarget, toolInput)) {
      return { allow: true, reason: null };
    }
    const receiptId = this.catalog.receiptForPath(effect.normalizedTarget);
    if (!receiptId) return { allow: false, reason: "PCH FRESH_READ_REQUIRED: existing mutation target lacks a current exact-source receipt." };
    const decision = this.mutationGuard.prepare([receiptId]);
    return decision.allow ? { allow: true, reason: null }
      : { allow: false, reason: `PCH SOURCE_VERSION_CHANGED: ${decision.checks.map((check) => `${check.receiptId}:${check.reasonCode}`).join(",")}. Fresh-read before retry.` };
  }

  capturesToolResults(): boolean {
    return this.options.config.enabled && this.currentMode !== "OFF";
  }

  context(request: ContextToolRequest): Promise<ContextToolResponse> { return this.contextTool.execute(request); }
  integrationSnapshot(): InputContextConsumerSnapshot | null {
    if (!this.currentCompile || !this.currentLayout || !this.currentToolSurface || !this.currentProfile) return null;
    const candidates = [...this.currentCandidates.values()].map((entry) => entry.candidate);
    return sealInputContextConsumerSnapshot({
      schema_version: 1,
      envelope_sha256: this.currentCompile.envelope.record_sha256,
      layout_manifest_sha256: this.currentLayout.record_sha256,
      tool_surface_plan_sha256: this.currentToolSurface.record_sha256,
      compile_profile: this.currentProfile,
      memory_candidate_count: candidates.filter((entry) => entry.source_kind === "MEMORY").length,
      evidence_candidate_count: candidates.filter((entry) => entry.source_kind !== "MEMORY" && entry.source_kind !== "AUTHORITY").length,
      output_contribution_count: this.currentContributionSeeds.filter((entry) => entry.owner === "OUTPUT").length,
      additional_model_requests: 0,
      additional_provider_requests: 0,
    });
  }
  markRecoveryProfile(): void { this.recoveryRequested = true; }
  lastError(): string | null { return this.lastErrorValue; }
  lastLedger(): ProviderTurnLedgerRecord | null { return this.lastLedgerValue; }
  shutdown(): void {
    if (this.turns.hasPending()) this.settleProviderTurn({
      usage: null, responseStatus: null, outcome: "OUTCOME_UNKNOWN", assistantTextBytes: 0, toolArgumentBytes: 0,
    });
    this.projector.reset();
  }

  private nowMs(): number { return (this.options.nowMs ?? Date.now)(); }

  private demand(
    seed: InputContextSeed,
    runtimeFingerprintSha256: string,
    contextWindowTokens: number | null,
    currentInputTokens: number | null,
  ): ContextDemandRecord {
    const profile = this.recoveryRequested ? "RECOVERY" as const
      : this.captured.size > 0 ? "TARGETED_EVIDENCE" as const : "RETAINED_DELTA" as const;
    this.recoveryRequested = false;
    const ratio = contextWindowTokens && currentInputTokens !== null ? currentInputTokens / contextWindowTokens : null;
    const material = {
      subject: seed.subject, profile, next: seed.nextActionSha256, obligations: seed.obligations,
      source: seed.sourceClosureRootSha256, acceptance: seed.acceptanceClosureRootSha256,
      runtime: runtimeFingerprintSha256,
    };
    return sealInputContextRecord(inputContextHashDomains.contextDemand, "record_sha256", {
      schema_version: 1 as const,
      demand_id: idFromSha256("IC_DEMAND", canonicalJsonSha256(material)),
      subject: seed.subject,
      profile,
      next_action_sha256: seed.nextActionSha256,
      obligations: seed.obligations,
      source_closure_root_sha256: seed.sourceClosureRootSha256,
      acceptance_closure_root_sha256: seed.acceptanceClosureRootSha256,
      context_pressure: ratio === null ? "UNKNOWN" as const : ratio >= 0.9 ? "HIGH" as const : ratio >= 0.7 ? "MEDIUM" as const : "LOW" as const,
      runtime_fingerprint_sha256: runtimeFingerprintSha256,
    });
  }

  private candidates(
    seed: InputContextSeed,
    additions: readonly InputContextAddition[],
    memory: MemoryContextMessage | null,
  ): Map<string, CandidateContent> {
    const values = new Map<string, CandidateContent>();
    const obligationIds = seed.obligations.map((entry) => entry.obligation_id);
    for (const addition of additions) {
      if (!addition.content || !["PCH_WORKFLOW_CONTROL", "PCH_PROTECTED_AUTHORITY"].includes(addition.inputSurface)) continue;
      const evidence = sha256Hex(addition.content);
      const candidate = sealInputContextRecord(inputContextHashDomains.contextCandidate, "record_sha256", {
        schema_version: 1 as const,
        candidate_id: idFromSha256("IC_CANDIDATE", evidence),
        source_kind: "AUTHORITY" as const,
        content_freshness: "NOT_APPLICABLE" as const,
        scope_authorization: "AUTHORIZED" as const,
        semantic_applicability: "CURRENT" as const,
        representation_fidelity: "EXACT_DECODED" as const,
        trust: "AUTHORITY" as const,
        obligation_ids: obligationIds,
        evidence_sha256: evidence,
        dependency_signature_sha256: seed.subject.bindingSha256,
        artifact_locator: null,
        estimated_tokens: estimateTokens(addition.content),
        classification: "INTERNAL" as const,
      });
      values.set(candidate.candidate_id, {
        candidate, content: addition.content, receiptId: null, subjectBindingSha256: seed.subject.bindingSha256,
        sourcePath: null,
      });
    }
    if (memory?.content) {
      const evidence = sha256Hex(memory.content);
      const candidate = sealInputContextRecord(inputContextHashDomains.contextCandidate, "record_sha256", {
        schema_version: 1 as const,
        candidate_id: idFromSha256("IC_CANDIDATE", evidence),
        source_kind: "MEMORY" as const,
        content_freshness: "NOT_APPLICABLE" as const,
        scope_authorization: "AUTHORIZED" as const,
        semantic_applicability: "CURRENT" as const,
        representation_fidelity: "TYPED_EXTRACT" as const,
        trust: "UNTRUSTED_CONTEXT" as const,
        obligation_ids: [],
        evidence_sha256: evidence,
        dependency_signature_sha256: memory.details.manifestSha256,
        artifact_locator: null,
        estimated_tokens: estimateTokens(memory.content),
        classification: "INTERNAL" as const,
      });
      values.set(candidate.candidate_id, {
        candidate, content: memory.content, receiptId: null, subjectBindingSha256: seed.subject.bindingSha256,
        sourcePath: null,
      });
    }
    for (const [id, captured] of this.captured) {
      if (captured.subjectBindingSha256 === seed.subject.bindingSha256) values.set(id, captured);
    }
    return values;
  }

  private optionalSegments(
    compile: ContextCompileResult,
    contents: ReadonlyMap<string, CandidateContent>,
  ): EnrichedLayoutSegment[] {
    return compile.envelope.items.flatMap((item) => {
      if (!["INLINE_EXACT", "INLINE_TYPED_EXTRACT", "MANDATORY_INLINE"].includes(item.disposition)) return [];
      const value = contents.get(item.candidate_id);
      if (!value?.content || value.candidate.source_kind === "AUTHORITY") return [];
      return [{
        type: surfaceForCandidate(value.candidate),
        lifecycle: "GENERATION_STABLE" as const,
        sourceBindingSha256: value.candidate.record_sha256,
        semanticVersion: "pch-context-v1",
        content: value.content,
        containsUserContent: true,
        owner: ownerForCandidate(value.candidate),
        inputSurface: surfaceForCandidate(value.candidate),
      }];
    });
  }

  private toolSnapshot(): ContextToolSnapshot | null {
    const compile = this.currentCompile;
    if (!compile) return null;
    const contents = new Map(this.currentCandidates);
    return {
      epoch: this.options.config.epoch,
      subjectBindingSha256: compile.envelope.subject.bindingSha256,
      envelopeSha256: compile.envelope.record_sha256,
      workingSetCandidateIds: compile.workingSet.items.map((item) => item.candidate_id),
      onDemandCandidateIds: compile.onDemandCandidateIds,
      source: (candidateId) => {
        const value = contents.get(candidateId);
        if (!value) return null;
        return {
          candidateId,
          status: candidateStatus(value.candidate),
          byteLength: value.content === null ? null : Buffer.byteLength(value.content, "utf8"),
          open: () => value.receiptId ? this.catalog.open(value.receiptId)
            : value.content === null ? null : Buffer.from(value.content, "utf8"),
          ...(value.sourcePath === null ? {} : { structural: async () => {
            const bytes = value.receiptId ? this.catalog.open(value.receiptId)
              : value.content === null ? null : Buffer.from(value.content, "utf8");
            if (bytes === null) return { bytes: Buffer.from("{}"), status: "INSUFFICIENT" as const };
            const result = await this.structural.extractBytes(value.sourcePath!, bytes);
            return { bytes: Buffer.from(JSON.stringify(result), "utf8"), status: result.status };
          } }),
        };
      },
    };
  }
}
