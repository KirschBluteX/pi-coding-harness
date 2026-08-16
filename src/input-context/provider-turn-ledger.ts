import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import type {
  ContextLayoutManifestRecord, ContributionOwner, InputSurface, OutputSurface,
  ProviderTurnAttemptRecord, ProviderTurnContributionRecord, ProviderTurnLedgerRecord,
  ProviderTurnGoalBindingRecord, ProviderTurnRequestRecord, TokenEvidence,
} from "./domain.js";
import { providerTurnContributionSha256 } from "./repository.js";

interface PendingProviderTurn {
  readonly started: ProviderTurnAttemptRecord;
  readonly promptGenerationId: string;
  readonly ledger: ProviderTurnLedgerRecord | null;
}

export interface ProviderTurnAuthority {
  beginProviderTurn(
    request: ProviderTurnRequestRecord,
    started: ProviderTurnAttemptRecord,
    binding?: ProviderTurnGoalBindingRecord,
  ): unknown;
  readLatestProviderTurnRequest(promptGenerationId: string): ProviderTurnRequestRecord | null;
  readPendingProviderTurns(limit?: number): readonly PendingProviderTurn[];
  completeProviderTurn(ledger: ProviderTurnLedgerRecord, terminal: ProviderTurnAttemptRecord): unknown;
}

export interface ProviderTurnHistorySummary {
  readonly descriptorRootSha256: string;
  readonly messageCount: number;
  readonly logicalBytes: number;
  readonly userBytes: number;
  readonly assistantBytes: number;
  readonly otherBytes: number;
}

export interface ProviderUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
}

export interface ContributionSeed {
  readonly owner: ContributionOwner;
  readonly inputSurface?: InputSurface;
  readonly outputSurface?: OutputSurface;
  readonly segmentIdentityHmac?: string | null;
  readonly logicalBytes?: number | null;
  readonly tokens?: number | null;
  readonly evidence?: TokenEvidence;
  readonly included?: boolean;
  readonly duplicateOf?: string | null;
}

interface PendingAttempt {
  readonly promptRequest: ProviderTurnRequestRecord;
  readonly attempt: ProviderTurnAttemptRecord;
  readonly contextEnvelopeSha256: string | null;
  readonly layout: ContextLayoutManifestRecord | null;
  readonly inputSeeds: readonly ContributionSeed[];
}

function finiteToken(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class ProviderTurnLedgerCoordinator {
  private readonly pending = new Map<string, PendingAttempt>();

  constructor(
    private readonly authority: ProviderTurnAuthority,
    private readonly hmacKey: string | Uint8Array,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.recoverPending();
  }

  begin(input: {
    readonly promptGenerationId: string;
    readonly payloadShapeSha256: string;
    readonly history: ProviderTurnHistorySummary;
    readonly toolSchemaBytes: number;
    readonly contextEnvelopeSha256: string | null;
    readonly layout: ContextLayoutManifestRecord | null;
    readonly contributions: readonly ContributionSeed[];
    readonly goalBinding?: {
      readonly goalId: string;
      readonly runId: string;
      readonly sessionId: string;
    };
  }): ProviderTurnAttemptRecord {
    const previous = this.authority.readLatestProviderTurnRequest(input.promptGenerationId);
    const requestSequence = previous === null ? 0 : previous.request_sequence + 1;
    const logicalRequestHmac = hmacSha256Hex(this.hmacKey, canonicalJson({
      domain: "PCH-PROVIDER-TURN-LOGICAL-REQUEST-V2",
      promptGenerationId: input.promptGenerationId,
      payloadShapeSha256: input.payloadShapeSha256,
      history: input.history,
      toolSchemaBytes: input.toolSchemaBytes,
    }));
    const promptRequest = sealInputContextRecord(inputContextHashDomains.providerTurnRequest, "record_sha256", {
      schema_version: 1 as const,
      prompt_request_id: idFromSha256("PROMPT_REQ", canonicalJsonSha256({
        generation: input.promptGenerationId, sequence: requestSequence, logicalRequestHmac,
      })),
      prompt_generation_id: input.promptGenerationId,
      previous_prompt_request_id: previous?.prompt_request_id ?? null,
      request_sequence: requestSequence,
      logical_request_hmac_sha256: logicalRequestHmac,
      payload_shape_sha256: input.payloadShapeSha256,
      message_descriptor_root_sha256: input.history.descriptorRootSha256,
      message_count: input.history.messageCount,
      logical_message_bytes: input.history.logicalBytes,
      user_history_bytes: input.history.userBytes,
      assistant_history_bytes: input.history.assistantBytes,
      other_history_bytes: input.history.otherBytes,
      tool_schema_bytes: input.toolSchemaBytes,
      created_at_ms: this.nowMs(),
    });
    const attemptId = idFromSha256("IC_ATTEMPT", canonicalJsonSha256({ request: promptRequest.prompt_request_id, attempt: 1 }));
    const attempt = sealInputContextRecord(inputContextHashDomains.providerTurnAttempt, "record_sha256", {
      schema_version: 1 as const,
      attempt_id: attemptId,
      prompt_request_id: promptRequest.prompt_request_id,
      attempt_number: 1,
      transition_ordinal: 0,
      request_identity_hmac: promptRequest.logical_request_hmac_sha256,
      payload_identity_hmac: null,
      payload_finality: "PCH_HOOK_INPUT" as const,
      started_at_ms: this.nowMs(),
      completed_at_ms: null,
      response_status: null,
      outcome: "STARTED" as const,
      usage_contribution_sha256: null,
    });
    const binding = input.goalBinding === undefined ? undefined : sealInputContextRecord(
      inputContextHashDomains.providerTurnGoalBinding,
      "record_sha256",
      {
        schema_version: 1 as const,
        prompt_request_id: promptRequest.prompt_request_id,
        prompt_request_sha256: promptRequest.record_sha256,
        goal_id: input.goalBinding.goalId,
        run_id: input.goalBinding.runId,
        session_id: input.goalBinding.sessionId,
        created_at_ms: promptRequest.created_at_ms,
      },
    );
    this.authority.beginProviderTurn(promptRequest, attempt, binding);
    this.pending.set(attempt.attempt_id, {
      promptRequest, attempt, contextEnvelopeSha256: input.contextEnvelopeSha256,
      layout: input.layout, inputSeeds: input.contributions,
    });
    return attempt;
  }

  settle(input: {
    readonly attemptId?: string;
    readonly usage: ProviderUsage | null;
    readonly responseStatus: number | null;
    readonly outcome: "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
    readonly outputSeeds: readonly ContributionSeed[];
  }): ProviderTurnLedgerRecord | null {
    const attemptId = input.attemptId ?? this.implicitPendingAttemptId();
    if (attemptId === null) return null;
    const pending = this.pending.get(attemptId);
    if (!pending && input.attemptId !== undefined) {
      throw new TypeError(`Provider-turn attempt ${attemptId} is not pending`);
    }
    if (!pending) return null;
    const usage = input.usage;
    const reasoning = finiteToken(usage?.reasoning ?? null);
    const output = finiteToken(usage?.output ?? null);
    const uncachedInput = finiteToken(usage?.input ?? null);
    const cacheRead = finiteToken(usage?.cacheRead ?? null);
    const cacheWrite = finiteToken(usage?.cacheWrite ?? null);
    const completeInput = uncachedInput !== null && cacheRead !== null && cacheWrite !== null;
    const completeOutput = output !== null;
    const attributedReasoning = reasoning !== null && output !== null ? Math.min(reasoning, output) : null;
    const seeds: ContributionSeed[] = [...pending.inputSeeds, ...input.outputSeeds];
    seeds.push({
      owner: "PROVIDER", inputSurface: "UNATTRIBUTED_INPUT", tokens: completeInput ? uncachedInput + cacheRead + cacheWrite : null,
      evidence: completeInput ? "PROVIDER_REPORTED" : "UNOBSERVABLE",
    });
    if (attributedReasoning !== null) seeds.push({
      owner: "PROVIDER", outputSurface: "REASONING", tokens: attributedReasoning, evidence: "PROVIDER_REPORTED",
    });
    seeds.push({
      owner: "PROVIDER", outputSurface: "UNATTRIBUTED_OUTPUT",
      tokens: completeOutput ? output - (attributedReasoning ?? 0) : null,
      evidence: completeOutput ? "PROVIDER_REPORTED" : "UNOBSERVABLE",
    });
    const contributions = seeds.map((seed, ordinal): ProviderTurnContributionRecord => ({
      contribution_id: idFromSha256("IC_CONTRIB", canonicalJsonSha256({ request: pending.promptRequest.prompt_request_id, ordinal, seed })),
      owner: seed.owner,
      input_surface: seed.inputSurface ?? null,
      output_surface: seed.outputSurface ?? null,
      segment_identity_hmac: seed.segmentIdentityHmac ?? null,
      logical_bytes: seed.logicalBytes ?? null,
      tokens: seed.tokens ?? null,
      evidence: seed.evidence ?? (seed.tokens === undefined || seed.tokens === null ? "UNOBSERVABLE" : "LOCAL_ESTIMATE"),
      included: seed.included ?? true,
      duplicate_of: seed.duplicateOf ?? null,
    }));
    const ledger = sealInputContextRecord(inputContextHashDomains.providerTurnLedger, "record_sha256", {
      schema_version: 1 as const,
      prompt_request_id: pending.promptRequest.prompt_request_id,
      prompt_generation_id: pending.promptRequest.prompt_generation_id,
      context_envelope_sha256: pending.contextEnvelopeSha256,
      layout_manifest_sha256: pending.layout?.record_sha256 ?? null,
      contributions,
      provider_uncached_input_tokens: uncachedInput,
      provider_cache_read_tokens: cacheRead,
      provider_cache_write_tokens: cacheWrite,
      provider_generated_output_tokens: output,
      provider_reasoning_tokens: reasoning,
      attributed_input_tokens: completeInput ? 0 : null,
      unattributed_input_tokens: completeInput ? uncachedInput + cacheRead + cacheWrite : null,
      attributed_output_tokens: completeOutput ? attributedReasoning ?? 0 : null,
      unattributed_output_tokens: completeOutput ? output - (attributedReasoning ?? 0) : null,
      accounting_completeness: completeInput && completeOutput ? "COMPLETE" as const
        : usage === null ? "UNOBSERVABLE" as const : "PARTIAL" as const,
      additional_model_requests: 0 as const,
      additional_provider_requests: 0 as const,
      created_at_ms: this.nowMs(),
    });
    const usageOrdinal = contributions.length - 1;
    const usageSha256 = providerTurnContributionSha256(ledger.prompt_request_id, usageOrdinal, contributions[usageOrdinal]!);
    const { record_sha256: _startHash, ...attemptBinding } = pending.attempt;
    void _startHash;
    const terminal = sealInputContextRecord(inputContextHashDomains.providerTurnAttempt, "record_sha256", {
      ...attemptBinding,
      transition_ordinal: 1,
      completed_at_ms: Math.max(pending.attempt.started_at_ms, this.nowMs()),
      response_status: input.responseStatus,
      outcome: input.outcome,
      usage_contribution_sha256: usageSha256,
    });
    this.authority.completeProviderTurn(ledger, terminal);
    this.pending.delete(attemptId);
    return ledger;
  }

  hasPending(attemptId?: string): boolean {
    return attemptId === undefined ? this.pending.size > 0 : this.pending.has(attemptId);
  }

  pendingAttemptIds(): readonly string[] { return [...this.pending.keys()]; }

  recoverPending(limit = 64): number {
    const pending = this.authority.readPendingProviderTurns(limit);
    for (const entry of pending) {
      const completion = this.recoveryCompletion(entry);
      this.authority.completeProviderTurn(completion.ledger, completion.terminal);
    }
    return pending.length;
  }

  private recoveryCompletion(entry: PendingProviderTurn): {
    readonly ledger: ProviderTurnLedgerRecord;
    readonly terminal: ProviderTurnAttemptRecord;
  } {
    if (entry.started.outcome !== "STARTED" || entry.started.transition_ordinal !== 0) {
      throw new TypeError("Provider-turn recovery requires a STARTED transition");
    }
    const ledger = entry.ledger ?? this.unobservableLedger(entry);
    if (ledger.prompt_request_id !== entry.started.prompt_request_id
      || ledger.prompt_generation_id !== entry.promptGenerationId) {
      throw new TypeError("Provider-turn recovery ledger binding is invalid");
    }
    const usageOrdinal = [...ledger.contributions].findLastIndex((contribution) =>
      contribution.included && contribution.output_surface !== null);
    if (usageOrdinal < 0) throw new TypeError("Provider-turn recovery ledger has no included output contribution");
    const { record_sha256: _startHash, ...attemptBinding } = entry.started;
    void _startHash;
    const terminal = sealInputContextRecord(inputContextHashDomains.providerTurnAttempt, "record_sha256", {
      ...attemptBinding,
      transition_ordinal: 1,
      completed_at_ms: Math.max(entry.started.started_at_ms, ledger.created_at_ms),
      response_status: null,
      outcome: "OUTCOME_UNKNOWN" as const,
      usage_contribution_sha256: providerTurnContributionSha256(
        ledger.prompt_request_id,
        usageOrdinal,
        ledger.contributions[usageOrdinal]!,
      ),
    });
    return { ledger, terminal };
  }

  private unobservableLedger(entry: PendingProviderTurn): ProviderTurnLedgerRecord {
    const contribution = (surface: "UNATTRIBUTED_INPUT" | "UNATTRIBUTED_OUTPUT", ordinal: number): ProviderTurnContributionRecord => ({
      contribution_id: idFromSha256("IC_CONTRIB", canonicalJsonSha256({
        request: entry.started.prompt_request_id,
        ordinal,
        seed: { owner: "PROVIDER", surface, evidence: "UNOBSERVABLE" },
      })),
      owner: "PROVIDER",
      input_surface: surface === "UNATTRIBUTED_INPUT" ? surface : null,
      output_surface: surface === "UNATTRIBUTED_OUTPUT" ? surface : null,
      segment_identity_hmac: null,
      logical_bytes: null,
      tokens: null,
      evidence: "UNOBSERVABLE",
      included: true,
      duplicate_of: null,
    });
    return sealInputContextRecord(inputContextHashDomains.providerTurnLedger, "record_sha256", {
      schema_version: 1 as const,
      prompt_request_id: entry.started.prompt_request_id,
      prompt_generation_id: entry.promptGenerationId,
      context_envelope_sha256: null,
      layout_manifest_sha256: null,
      contributions: [contribution("UNATTRIBUTED_INPUT", 0), contribution("UNATTRIBUTED_OUTPUT", 1)],
      provider_uncached_input_tokens: null,
      provider_cache_read_tokens: null,
      provider_cache_write_tokens: null,
      provider_generated_output_tokens: null,
      provider_reasoning_tokens: null,
      attributed_input_tokens: null,
      unattributed_input_tokens: null,
      attributed_output_tokens: null,
      unattributed_output_tokens: null,
      accounting_completeness: "UNOBSERVABLE" as const,
      additional_model_requests: 0 as const,
      additional_provider_requests: 0 as const,
      created_at_ms: Math.max(entry.started.started_at_ms, this.nowMs()),
    });
  }

  private implicitPendingAttemptId(): string | null {
    if (this.pending.size === 0) return null;
    if (this.pending.size > 1) {
      throw new TypeError("Provider-turn settle requires attemptId when multiple attempts are pending");
    }
    return this.pending.keys().next().value as string;
  }
}
