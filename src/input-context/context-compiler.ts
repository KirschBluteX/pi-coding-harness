import { performance } from "node:perf_hooks";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256, createId } from "../foundation/ids.js";
import {
  assertContextCandidate, assertContextDemand,
  type ContextCandidateRecord, type ContextCompileReceiptRecord, type ContextDemandRecord,
  type ContextEnvelopeRecord, type ContextFitDisposition, type ContextWorkingSetRecord,
} from "./domain.js";
import { inputContextHashDomains, sealInputContextRecord } from "./canonical.js";
import { allocateContextBudget, type ContextBudget, type ContextBudgetInput } from "./budget.js";
import { validateCoverage, type CoverageResult } from "./coverage.js";
import { planDeliveries, type RetainedCandidateBinding } from "./delivery.js";

export interface ContextCompileInput {
  readonly demand: ContextDemandRecord;
  readonly candidates: readonly ContextCandidateRecord[];
  readonly retainedRootSha256: string;
  readonly retainedCandidates: readonly RetainedCandidateBinding[];
  readonly promptGenerationId: string | null;
  readonly budget: ContextBudgetInput;
  readonly unknownCandidateTokens: number;
  readonly nowMs: number;
}

export interface ContextCompileResult {
  readonly workingSet: ContextWorkingSetRecord;
  readonly envelope: ContextEnvelopeRecord;
  readonly receipt: ContextCompileReceiptRecord;
  readonly fitDisposition: ContextFitDisposition;
  readonly uncoveredMandatoryObligationIds: readonly string[];
  readonly onDemandCandidateIds: readonly string[];
  readonly coverage: CoverageResult;
  readonly budget: ContextBudget;
}

function validateInput(input: ContextCompileInput, validatedCandidates: WeakMap<object, string>): void {
  assertContextDemand(input.demand);
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (validatedCandidates.get(candidate) !== candidate.record_sha256) {
      assertContextCandidate(candidate);
      validatedCandidates.set(candidate, candidate.record_sha256);
    }
    if (ids.has(candidate.candidate_id)) throw new TypeError("ContextCompiler candidate IDs must be unique");
    ids.add(candidate.candidate_id);
  }
  if (!/^[a-f0-9]{64}$/u.test(input.retainedRootSha256)) throw new TypeError("ContextCompiler retained root is invalid");
  if (!Number.isSafeInteger(input.unknownCandidateTokens) || input.unknownCandidateTokens < 1) {
    throw new TypeError("ContextCompiler unknown candidate estimate must be positive");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new TypeError("ContextCompiler nowMs is invalid");
  if (input.demand.profile === "PASS_THROUGH" && input.candidates.length > 0) {
    throw new TypeError("PASS_THROUGH cannot compile provider-visible candidates");
  }
}

function fitDisposition(
  demand: ContextDemandRecord,
  coverage: CoverageResult,
  onDemandCandidateIds: readonly string[],
): ContextFitDisposition {
  if (coverage.uncoveredMandatoryObligationIds.length > 0) {
    return demand.profile === "RECOVERY" ? "RECOVERY_REQUIRED" : "BASELINE_FALLBACK";
  }
  if (onDemandCandidateIds.length > 0 || coverage.discoveryDebtObligationIds.length > 0) return "FIT_WITH_ON_DEMAND";
  return "FIT";
}

function fallbackFor(
  fit: ContextFitDisposition,
  demand: ContextDemandRecord,
): ContextCompileReceiptRecord["fallback"] {
  if (fit === "RECOVERY_REQUIRED") return "NATIVE_RECOVERY";
  if (fit === "BASELINE_FALLBACK") {
    return demand.obligations.some((obligation) => obligation.must_be_current) ? "FRESH_READ" : "PI_BASELINE";
  }
  return "NONE";
}

export class ContextCompiler {
  private readonly validatedCandidates = new WeakMap<object, string>();
  private lastCompile: { readonly inputClosureSha256: string; readonly result: ContextCompileResult } | null = null;

  constructor(private readonly hmacKey: string | Uint8Array) {}

  compile(input: ContextCompileInput): ContextCompileResult {
    const started = performance.now();
    validateInput(input, this.validatedCandidates);
    const budget = allocateContextBudget(input.budget);
    const inputClosureSha256 = canonicalJsonSha256({
      domain: "PCH-CONTEXT-COMPILE-INPUT-V1",
      demandSha256: input.demand.record_sha256,
      candidateSha256: input.candidates.map((candidate) => candidate.record_sha256).sort(),
      retainedRootSha256: input.retainedRootSha256,
      retainedCandidates: [...input.retainedCandidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
      promptGenerationId: input.promptGenerationId,
      budget,
      unknownCandidateTokens: input.unknownCandidateTokens,
    });
    if (this.lastCompile?.inputClosureSha256 === inputClosureSha256) return this.lastCompile.result;
    const delivery = planDeliveries({
      candidates: input.candidates, obligations: input.demand.obligations,
      retainedCandidates: input.retainedCandidates, evidenceTokenBudget: budget.evidenceTokens,
      optionalTokenBudget: Math.min(budget.evidenceTokens, input.budget.softEvidenceTokens),
      unknownCandidateTokens: input.unknownCandidateTokens, hmacKey: this.hmacKey,
    });
    const coverage = validateCoverage(input.demand.obligations, delivery.items);
    const fit = fitDisposition(input.demand, coverage, delivery.onDemandCandidateIds);
    const workingSetId = idFromSha256("IC_WORKSET", inputClosureSha256);
    const workingSet = sealInputContextRecord(inputContextHashDomains.contextWorkingSet, "record_sha256", {
      schema_version: 1 as const, working_set_id: workingSetId, subject: input.demand.subject,
      profile: input.demand.profile, context_demand_sha256: input.demand.record_sha256,
      retained_root_sha256: input.retainedRootSha256,
      source_closure_root_sha256: input.demand.source_closure_root_sha256,
      acceptance_closure_root_sha256: input.demand.acceptance_closure_root_sha256,
      items: delivery.items, created_at_ms: input.nowMs,
    });
    const envelopeId = idFromSha256("IC_ENVELOPE", canonicalJsonSha256({
      inputClosureSha256, fit, coverageRootSha256: coverage.rootSha256,
    }));
    const envelope = sealInputContextRecord(inputContextHashDomains.contextEnvelope, "record_sha256", {
      schema_version: 1 as const, envelope_id: envelopeId, subject: input.demand.subject,
      profile: input.demand.profile, prompt_generation_id: input.promptGenerationId,
      retained_root_sha256: input.retainedRootSha256,
      source_closure_root_sha256: input.demand.source_closure_root_sha256,
      acceptance_closure_root_sha256: input.demand.acceptance_closure_root_sha256,
      mandatory_coverage_root_sha256: coverage.rootSha256,
      context_demand_root_sha256: input.demand.record_sha256,
      items: delivery.items, estimated_projected_tokens: delivery.projectedTokens,
      fit_disposition: fit,
    });
    const durationMicros = Math.max(0, Math.ceil((performance.now() - started) * 1_000));
    const receipt = sealInputContextRecord(inputContextHashDomains.contextCompileReceipt, "receipt_sha256", {
      schema_version: 1 as const,
      compile_receipt_id: createId("IC_COMPILE"),
      working_set_id: workingSet.working_set_id,
      envelope_sha256: envelope.record_sha256,
      input_closure_sha256: inputClosureSha256,
      mandatory_obligation_count: coverage.mandatoryObligationIds.length,
      mandatory_covered_count: coverage.coveredMandatoryObligationIds.length,
      discovery_debt_count: coverage.discoveryDebtObligationIds.length,
      omitted_optional_count: delivery.omittedOptionalCount,
      fallback: fallbackFor(fit, input.demand),
      duration_micros: durationMicros,
      created_at_ms: input.nowMs,
    });
    const result = {
      workingSet, envelope, receipt, fitDisposition: fit,
      uncoveredMandatoryObligationIds: coverage.uncoveredMandatoryObligationIds,
      onDemandCandidateIds: delivery.onDemandCandidateIds,
      coverage, budget,
    };
    this.lastCompile = { inputClosureSha256, result };
    return result;
  }
}
