import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { assertContained, prepareSafeRoot, publishAtomicNoReplace } from "../artifacts/atomic-file.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { SUPPORTED_MIGRATION_VERSION } from "../authority/migrate.js";
import { AuthorityStore } from "../authority/transactions.js";
import type { CodingHarnessConfig } from "../config/types.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { MemoryEngineConfig, MemoryRetrievalResult } from "../memory/types.js";
import { buildMemoryWorkingSet, memoryContextMessage, type MemoryContextMessage } from "../memory/context-projector.js";
import type { MemoryCommandRequest } from "../memory/commands.js";
import { MemoryCaptureCoordinator, type MemoryCaptureObservation } from "../memory/capture.js";
import { MemoryV3Engine, type MemoryV3ReconcileResult } from "../memory/v3-engine.js";
import { MemoryVault } from "../memory/vault.js";
import { mergeMemoryRetrieval } from "../memory/retrieval-merge.js";

export interface CodingHarnessResources {
  readonly authority: AuthorityStore;
  readonly artifacts: ArtifactStore;
  readonly workspaceSecret: Uint8Array;
}

export interface TaskFlowMemoryContext {
  readonly goalId: string;
  readonly objectiveSha256: string;
  readonly contractSha256: string | null;
  readonly routeSha256: string | null;
  readonly workCellId: string | null;
  readonly mode: "PLAN" | "BUILD";
}

export interface CodingHarnessServiceOptions {
  readonly config: CodingHarnessConfig;
  readonly packageRoot: string;
  readonly migrationPath: string;
  readonly memoryRecallEnabled?: boolean;
  readonly memoryRecallFallbackReason?: string | null;
  readonly dataRoot?: string;
  readonly now?: () => number;
  readonly inputContextMigrationPath?: string | false;
  readonly harnessMigrationPath?: string | false;
  readonly onPatchTransactionFault?: (
    point: "AFTER_PREPARE" | "AFTER_APPLY" | "AFTER_RECOVERY_APPLY",
    path: string | null,
  ) => void;
}

function memoryEngineConfig(config: CodingHarnessConfig): MemoryEngineConfig {
  return {
    enabled: config.modules.memory.enabled,
    mode: config.modules.memory.mode,
    epoch: config.modules.memory.epoch,
    softProjectionTokens: config.modules.memory.soft_projection_tokens,
    hardProjectionTokens: config.modules.memory.hard_projection_tokens,
    maxResults: config.modules.memory.max_results,
    maxPolicyResults: config.modules.memory.max_policy_results,
    maxEvidenceResults: config.modules.memory.max_evidence_results,
    maxExperienceResults: config.modules.memory.max_experience_results,
    maxStructuredScanRows: config.modules.memory.max_structured_scan_rows,
    maxPayloadBytes: config.modules.memory.max_payload_bytes,
    indexDrainBatch: config.modules.memory.index_drain_batch,
    indexDrainDebounceMs: config.modules.memory.index_drain_debounce_ms,
  };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function installKey(root: string): Uint8Array {
  const path = resolve(root, "install.key");
  assertContained(root, path);
  if (!existsSync(path)) publishAtomicNoReplace(root, path, randomBytes(32));
  if (lstatSync(path).isSymbolicLink()) throw new TypeError("Coding Harness install key cannot be a symlink");
  const key = readFileSync(path);
  if (key.byteLength !== 32) throw new TypeError("Coding Harness install key must contain exactly 32 bytes");
  return key;
}

export class CodingHarnessServices {
  private readonly now: () => number;
  private resourcesValue: CodingHarnessResources | null = null;
  private cwd: string | null = null;
  private sessionId: string | null = null;
  private workspaceId: string | null = null;
  private memoryCapture: MemoryCaptureCoordinator | null = null;
  private memoryV3: MemoryV3Engine | null = null;
  private memoryV3InitError: string | null = null;
  private memoryV3Reconcile: MemoryV3ReconcileResult | null = null;
  private lastInputText = "";
  private taskFlowMemoryContext: TaskFlowMemoryContext | null = null;

  constructor(private readonly options: CodingHarnessServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  initialize(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
    if (this.resourcesValue) return;
    const configuredRoot = this.options.dataRoot ?? this.options.config.data?.root ?? "~/.pi/agent/coding-harness";
    const root = prepareSafeRoot(expandHome(configuredRoot));
    const key = installKey(root);
    const cwd = resolve(ctx.cwd);
    const workspaceHmac = hmacSha256Hex(key, cwd.replaceAll("\\", "/").toLowerCase().normalize("NFC"));
    const workspaceId = idFromSha256("WS", workspaceHmac);
    const workspaceRoot = prepareSafeRoot(resolve(root, "workspaces", workspaceHmac));
    const artifacts = new ArtifactStore(resolve(workspaceRoot, "artifacts"));
    const authority = AuthorityStore.open({
      databasePath: resolve(workspaceRoot, "authority.sqlite"),
      migrationPath: this.options.migrationPath,
      experimentsMigrationPath: resolve(this.options.packageRoot, "schemas", "sql", "002_experiments.sql"),
      clock: { now: this.now, monotonicNow: this.now },
      ...(this.options.config.modules.memory.enabled ? {
        memoryMigrations: {
          structuredPath: resolve(this.options.packageRoot, "schemas", "sql", "003_memory.sql"),
          ftsPath: resolve(this.options.packageRoot, "schemas", "sql", "004_memory_fts.sql"),
          claimsPath: resolve(this.options.packageRoot, "schemas", "sql", "005_memory_claims.sql"),
          claimsFtsPath: resolve(this.options.packageRoot, "schemas", "sql", "006_memory_claims_fts.sql"),
          checkpointPath: resolve(this.options.packageRoot, "schemas", "sql", "007_memory_checkpoint.sql"),
          vaultPath: resolve(this.options.packageRoot, "schemas", "sql", "008_memory_v3_vault.sql"),
          lifecyclePath: resolve(this.options.packageRoot, "schemas", "sql", "009_memory_v3_lifecycle.sql"),
          captureV31Path: resolve(this.options.packageRoot, "schemas", "sql", "010_memory_v3_1_capture.sql"),
          nowMs: this.now(),
        },
      } : {}),
      taskFlowMigrationPath: resolve(this.options.packageRoot, "schemas", "sql", "011_task_flow_kernel_v1.sql"),
      inputContextMigrationPath: this.options.inputContextMigrationPath
        ?? (SUPPORTED_MIGRATION_VERSION >= 12
          ? resolve(this.options.packageRoot, "schemas", "sql", "012_input_context_v1.sql")
          : false),
      harnessMigrationPath: this.options.harnessMigrationPath ?? false,
      ...(this.options.config.data?.sqlite_busy_timeout_ms === undefined
        ? {} : { busyTimeoutMs: this.options.config.data.sqlite_busy_timeout_ms }),
    });
    this.resourcesValue = { authority, artifacts, workspaceSecret: key };
    if (this.options.config.modules.memory.enabled) {
      try {
        const vault = new MemoryVault(workspaceRoot, key, this.options.config.modules.memory.max_payload_bytes);
        this.memoryV3 = new MemoryV3Engine(
          authority, vault, key, this.options.config.modules.memory.max_payload_bytes, this.now,
        );
        this.memoryV3Reconcile = this.memoryV3.reconcile(workspaceId);
      } catch (error) {
        this.memoryV3InitError = error instanceof Error ? error.message : String(error);
      }
    }
    this.memoryCapture = new MemoryCaptureCoordinator(
      authority,
      this.options.config.modules.memory.capture_mode,
      this.options.config.modules.memory.capture_epoch,
      this.memoryV3 ?? {
        storeCapture: () => ({
          accepted: false, reason: this.memoryV3InitError ?? "MEMORY_V3_UNAVAILABLE",
          record: null, additionalModelRequests: 0,
        }),
      },
      key,
    );
    this.cwd = cwd;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.workspaceId = workspaceId;
  }

  resources(): CodingHarnessResources | null { return this.resourcesValue; }

  setTaskFlowMemoryContext(context: TaskFlowMemoryContext | null): void {
    this.taskFlowMemoryContext = context;
  }

  observeTaskFlowMemoryInput(text: string, goalIntake: boolean): MemoryCaptureObservation | null {
    const context = this.taskFlowMemoryContext;
    if (!this.workspaceId || !this.sessionId || text.trim().startsWith("/")) return null;
    this.lastInputText = text;
    if (!this.memoryCapture) return null;
    return this.memoryCapture.observe({
      workspaceId: this.workspaceId,
      goalId: context?.goalId ?? null,
      text,
      sourceKind: "USER_INPUT",
      sourceActor: "USER",
      decisionActor: "RUNTIME",
      sourceLocator: `pi-input://${this.sessionId}/${sha256Hex(text).slice(0, 24)}`,
      sourceSessionHmac: hmacSha256Hex(this.requiredResources().workspaceSecret, this.sessionId),
      observedAtMs: this.now(),
      authorityContextSha256: context ? canonicalJsonSha256(context) : null,
      intentOwnership: goalIntake ? "GOAL_INTAKE" : context?.mode === "BUILD" ? "ACTIVE_BUILD" : "NONE",
      maxBytes: Math.min(this.options.config.modules.memory.max_payload_bytes, 16_384),
    });
  }

  memoryProjection(): MemoryContextMessage | null {
    const result = this.retrieveMemory();
    return result ? memoryContextMessage(result.workingSet) : null;
  }

  memoryRetrievalFor(text: string): MemoryRetrievalResult | null { return this.retrieveMemory(text); }

  memoryCommand(request: MemoryCommandRequest): string {
    const memoryV3 = this.memoryV3;
    const workspaceId = this.workspaceId;
    const context = this.taskFlowMemoryContext;
    const goalId = context?.goalId ?? null;
    const config = this.options.config.modules.memory;
    if (request.action === "status") {
      const capture = this.memoryCapture?.status();
      const workspace = workspaceId && memoryV3
        ? this.requiredResources().authority.readMemoryV3WorkspaceStatus(workspaceId) : null;
      const integrityFailures = this.memoryV3Reconcile?.integrityFailureClaimIds.length ?? 0;
      const recall = this.memoryRecallEnabled() ? config.mode
        : config.enabled ? "EMPTY_OPTIONAL_PROJECTION" : config.mode;
      return `Memory recall=${recall} capture=${capture?.mode ?? config.capture_mode}`
        + ` circuit=${capture?.circuit ?? "OPEN"} vault=${!memoryV3 ? "UNAVAILABLE" : integrityFailures ? "DEGRADED" : "OK"}`
        + ` proposed=${workspace?.proposed ?? 0} index=${memoryV3 ? "V3_TERMS" : "DISABLED"}`
        + `${this.options.memoryRecallFallbackReason ? " recallFallback=ACTIVATION_EVIDENCE_INVALID" : ""}`
        + `${integrityFailures ? ` integrityFailures=${integrityFailures}` : ""}.`;
    }
    if (!config.enabled) return "Memory OFF; optional projection is unchanged.";
    if (!this.memoryRecallEnabled() && (request.action === "list" || request.action === "conflicts")) {
      return "Memory recall is EMPTY_OPTIONAL_PROJECTION because activation evidence is unavailable.";
    }
    if (!workspaceId || !this.cwd) return "Memory workspace is unavailable.";
    const mutationContext = {
      goalId, workspaceId, workspaceRoot: this.cwd,
      authorityContextSha256: context ? canonicalJsonSha256(context) : null,
    };
    if (request.action === "proposed") {
      if (!memoryV3) return "Memory Vault is unavailable; no proposal can be approved.";
      const page = memoryV3.proposalPage(workspaceId, goalId, Math.min(request.limit, config.max_results), request.afterProposalId);
      if (page.items.length === 0) return "No proposed claims.";
      const lines = page.items.map(({ proposal, opened }) =>
        `${opened.record.claimId} proposal=${proposal.proposalId} ${opened.record.channel}/${opened.record.scope} expires=${proposal.expiresAtMs}: ${opened.body.content_text}`);
      if (page.nextCursor) lines.push(`next: /memory proposed --after ${page.nextCursor} --limit ${request.limit}`);
      return lines.join("\n");
    }
    if (request.action === "reject_all") {
      if (!memoryV3) return "Memory Vault is unavailable; no proposal can be rejected.";
      const result = memoryV3.rejectAllProposals(mutationContext, request.limit);
      return `Memory proposals rejected=${result.rejected} failed=${result.failedClaimIds.length}`
        + `${result.nextCursor ? ` remaining_cursor=${result.nextCursor}` : ""}.`;
    }
    if (request.action === "cleanup") {
      if (!memoryV3) return "Memory Vault is unavailable; cleanup was not run.";
      this.memoryV3Reconcile = memoryV3.reconcile(workspaceId);
      return `Memory cleanup retired=${this.memoryV3Reconcile.retiredObservationIds.length}`
        + ` expired=${this.memoryV3Reconcile.expiredProposalIds.length}`
        + ` reconciled=${this.memoryV3Reconcile.completedCaptureIntentIds.length}`
        + ` integrityFailures=${this.memoryV3Reconcile.integrityFailureClaimIds.length}.`;
    }
    if (request.action === "list") {
      const rendered: string[] = [];
      if (memoryV3) {
        for (const head of this.requiredResources().authority.readMemoryV3CandidateHeads(workspaceId, goalId, config.max_results)) {
          if (!request.includeForgotten && (head.proposalState !== "ACTIVE" || head.visibility !== "VISIBLE" || head.purgeState !== "PRESENT")) continue;
          try {
            const opened = memoryV3.open(head.claimId, workspaceId, goalId);
            if (!opened || (request.query && !opened.body.content_text.toLowerCase().includes(request.query.toLowerCase()))) continue;
            rendered.push(`${head.claimId} v${head.version} ${head.channel}/${head.scope} state=${head.proposalState}/${head.visibility}/${head.purgeState}: ${opened.body.content_text}`);
          } catch {
            if (request.includeForgotten) rendered.push(`${head.claimId} v${head.version}: [content unavailable]`);
          }
        }
      }
      return rendered.length ? rendered.join("\n") : "Memory: no claims in the active scope.";
    }
    if (request.action === "conflicts") {
      const result = this.retrieveMemory();
      return result?.workingSet.conflicts.length
        ? `Memory conflicts: ${result.workingSet.conflicts.join(", ")}. Use /memory why, edit, forget, or endorse to resolve.`
        : "Memory conflicts: none.";
    }
    if (request.action === "why") {
      if (memoryV3) {
        try {
          const opened = memoryV3.open(request.claimId, workspaceId, goalId);
          if (opened) return JSON.stringify({
            claimId: opened.record.claimId, version: opened.record.version, scope: opened.record.scope,
            channel: opened.record.channel, classification: opened.record.classification,
            proposalState: opened.head.proposalState, visibility: opened.head.visibility,
            purgeState: opened.head.purgeState, endorsed: opened.head.endorsed,
            source: opened.body.source, content: opened.body.content_text,
          });
        } catch { return `Memory ${request.claimId} exists but its local Vault material failed integrity checks.`; }
      }
      return `Memory ${request.claimId} is not visible in the active scope.`;
    }
    if (!memoryV3) return "Memory Vault is unavailable; mutation was not applied.";
    const result = request.action === "add" ? memoryV3.addUserPolicy({ statement: request.value, scope: request.scope }, mutationContext)
      : request.action === "evidence_file" ? memoryV3.addProjectEvidence({ path: request.locator, description: request.description, scope: request.scope }, mutationContext)
        : request.action === "evidence_receipt" ? memoryV3.addReceiptEvidence({ receiptId: request.locator, description: request.description, scope: request.scope }, mutationContext)
          : request.action === "experience_receipt" ? memoryV3.addReceiptExperience({ receiptId: request.locator, lesson: request.value, scope: request.scope }, mutationContext)
            : request.action === "edit" ? memoryV3.correct(request.claimId, request.value, mutationContext)
              : request.action === "approve" ? memoryV3.approve(request.claimId, mutationContext)
                : request.action === "reject" ? memoryV3.reject(request.claimId, mutationContext)
                  : request.action === "endorse" ? memoryV3.endorse(request.claimId, mutationContext)
                    : request.action === "unendorse" ? memoryV3.unendorse(request.claimId, mutationContext)
                      : request.action === "forget" ? memoryV3.forget(request.claimId, mutationContext)
                        : request.action === "restore" ? memoryV3.restore(request.claimId, mutationContext)
                          : request.action === "purge" ? memoryV3.purge(request.claimId, mutationContext) : null;
    if (!result) return "Invalid Memory command arguments.";
    if ("record" in result) return result.accepted && result.record
      ? `Memory ${result.reason}: ${result.record.claimId} v${result.record.version}.`
      : `Memory rejected: ${result.reason}.`;
    return result.accepted && result.action
      ? `Memory ${result.reason}: ${result.action.claimId} (${result.action.actionId}).${result.limitation ? ` ${result.limitation}` : ""}`
      : `Memory rejected: ${result.reason}.`;
  }

  shutdown(): void {
    this.resourcesValue?.authority.close();
    this.resourcesValue = null;
    this.memoryCapture = null;
    this.memoryV3 = null;
    this.memoryV3Reconcile = null;
    this.memoryV3InitError = null;
    this.taskFlowMemoryContext = null;
  }

  private retrieveMemory(queryText = this.lastInputText): MemoryRetrievalResult | null {
    if (!this.memoryV3 || !this.workspaceId || !this.cwd || !this.memoryRecallEnabled()) return null;
    const query = {
      workspaceId: this.workspaceId,
      goalId: this.taskFlowMemoryContext?.goalId ?? null,
      workspaceRoot: this.cwd,
      text: queryText,
      tags: this.taskFlowMemoryContext?.workCellId ? [this.taskFlowMemoryContext.workCellId] : [],
      nowMs: this.now(),
    };
    const config = memoryEngineConfig(this.options.config);
    const empty: MemoryRetrievalResult = {
      indexMode: "TAG_PATH", mode: config.mode, epoch: config.epoch,
      selected: [], omittedClaimIds: [], workingSet: buildMemoryWorkingSet([], [], [], [], []),
      reason: "NO_ELIGIBLE_MEMORY", indexWatermark: 0, indexLagCount: 0, additionalModelRequests: 0,
    };
    try {
      return mergeMemoryRetrieval(empty, this.memoryV3.retrieve(query, config), config);
    } catch (error) {
      this.memoryV3InitError = error instanceof Error ? error.message : String(error);
      return empty;
    }
  }

  private memoryRecallEnabled(): boolean {
    return this.options.config.modules.memory.enabled && this.options.memoryRecallEnabled !== false;
  }

  private requiredResources(): CodingHarnessResources {
    if (!this.resourcesValue) throw new TypeError("Coding Harness services are not initialized");
    return this.resourcesValue;
  }
}
