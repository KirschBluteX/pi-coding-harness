import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJsonSha256, parseCanonicalJson } from "../authority/canonical-json.js";
import type { LeaseToken } from "../authority/lease.js";
import type {
  AuthorityRecoveryMaterial, ObservationRecoveryMaterial, PlanRevisionMaterial, RequirementRevisionMaterial,
} from "../authority/repositories/recovery.js";
import type { AuthorityStore } from "../authority/transactions.js";
import type { PromptGenerationRecord } from "../context/prompt-generation.js";
import type { PromptRequestRecord } from "../context/prompt-request.js";
import type { ProtectedRef, ProtectedTaskState } from "../context/protected-projection.js";
import { validateProtectedState } from "../context/protected-projection.js";
import type { ResponseContract } from "../output/response-contract.js";
import type { PlanPackage, RequirementPackage, StageRuntimeStatus } from "../planning/types.js";
import {
  effectivePlanContinuationResolution,
  PLAN_CONTINUE_BUILD,
  PLAN_CONTINUE_KEEP,
  PLAN_CONTINUE_REVISE,
} from "../planning/plan-continuation.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";

export type RecoveredSessionPhase = "CLARIFYING" | "SPECIFYING" | "PLANNING" | "BUILDING" | "VERIFYING" | "TERMINAL" | "PAUSED" | "RECOVERING";

export interface RecoveryResult {
  readonly material: AuthorityRecoveryMaterial;
  readonly requirement: RequirementPackage | null;
  readonly plan: PlanPackage | null;
  readonly mode: "PLAN" | "BUILD";
  readonly phase: RecoveredSessionPhase;
  readonly routeHealth: string;
  readonly nextAction: string;
  readonly currentStageId: string | null;
  readonly stageStatuses: Readonly<Record<string, StageRuntimeStatus>>;
  readonly pendingEffectIds: readonly string[];
  readonly promptGeneration: PromptGenerationRecord | null;
  readonly promptRequest: PromptRequestRecord | null;
  readonly responseContract: ResponseContract | null;
  readonly protectedState: ProtectedTaskState;
  readonly checkpointCount: number;
  readonly checkpointSha256: string | null;
  readonly checkpointExact: boolean;
  readonly leaseTakeover: boolean;
}

interface OutputObservationV3 {
  readonly schema_version: 3;
  readonly observation_id: string;
  readonly response_contract_id: string;
  readonly response_contract_sha256: string;
  readonly response_contract: ResponseContract;
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityIntegrityError(`Recovery ${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9._:-]{0,127}$/u.test(value)) {
    throw new AuthorityIntegrityError(`Recovery ${field} has an invalid identifier`);
  }
  return value;
}

function ref(id: string, value: unknown): ProtectedRef {
  return { id, sha256: canonicalJsonSha256(value) };
}

function requirementPackage(material: RequirementRevisionMaterial, goal: AuthorityRecoveryMaterial["goal"], value: unknown): RequirementPackage {
  const requirements = object(value, "Requirement payload") as RequirementPackage["requirements"];
  return {
    schema_version: 1,
    package: {
      requirement_id: material.requirementId, goal_id: goal.goalId,
      goal_version: Math.max(1, material.createdEventSequence - 1), revision: material.revision,
      parent_requirement_id: material.parentRequirementId, profile: material.profile, status: "FROZEN",
      created_at: new Date(material.createdAtMs).toISOString(), source_intake_sha256: material.triggerEvidenceSha256,
    },
    requirements,
    integrity: {
      canonicalization: "PCH-CJ1", requirements_payload_sha256: material.payloadSha256,
      artifact_sha256: material.artifact.sha256,
    },
  };
}

function planPackage(material: PlanRevisionMaterial, goal: AuthorityRecoveryMaterial["goal"], requirement: RequirementPackage, value: unknown): PlanPackage {
  const plan = object(value, "Plan payload") as PlanPackage["plan"];
  return {
    schema_version: 2,
    package: {
      plan_id: material.planId, goal_id: goal.goalId, goal_version: Math.max(1, material.createdEventSequence - 1),
      revision: material.revision, parent_plan_id: material.parentPlanId, intent: goal.intent, status: "FROZEN",
      created_at: new Date(material.createdAtMs).toISOString(), source_intake_sha256: material.triggerEvidenceSha256,
      requirement_id: requirement.package.requirement_id,
      requirement_payload_sha256: requirement.integrity.requirements_payload_sha256,
      supersedes_plan_id: material.parentPlanId,
    },
    plan,
    integrity: {
      canonicalization: "PCH-CJ1", requirement_payload_sha256: requirement.integrity.requirements_payload_sha256,
      plan_payload_sha256: material.payloadSha256, artifact_sha256: material.artifact.sha256,
    },
  };
}

function latest(observations: readonly ObservationRecoveryMaterial[], type: ObservationRecoveryMaterial["observationType"]): ObservationRecoveryMaterial | null {
  return observations.filter((entry) => entry.observationType === type).at(-1) ?? null;
}

function readRecoveryArtifact(
  artifacts: ArtifactStore,
  record: { readonly locator: string; readonly sha256: string; readonly byteLength: number },
): unknown {
  const bytes = artifacts.open(record.locator);
  if (bytes.byteLength !== record.byteLength) {
    throw new AuthorityIntegrityError(`Recovery CAS byte length mismatch at ${record.locator}`);
  }
  const value = parseCanonicalJson(Buffer.from(bytes).toString("utf8"));
  if (canonicalJsonSha256(value) !== record.sha256) {
    throw new AuthorityIntegrityError(`Recovery CAS semantic hash mismatch at ${record.locator}`);
  }
  return value;
}

export function recoverPromptGenerationObservation(
  material: Pick<AuthorityRecoveryMaterial, "observations">,
  artifacts: ArtifactStore,
): PromptGenerationRecord | null {
  const observation = latest(material.observations, "PROMPT_GENERATION");
  if (!observation) return null;
  const record = readRecoveryArtifact(artifacts, observation.artifact) as PromptGenerationRecord;
  if (assertId(record.prompt_generation_id, "PromptGeneration ID") !== observation.observationId) {
    throw new AuthorityIntegrityError("PromptGeneration observation ID substitution");
  }
  return record;
}

function currentStage(material: AuthorityRecoveryMaterial): string | null {
  const running = material.stages.find((stage) => stage.status === "RUNNING" || stage.status === "WAITING_USER"
    || stage.status === "RECOVERING" || stage.status === "NEEDS_RECONCILIATION");
  if (running) return running.stageId;
  const payloadStage = material.latestTransition?.payload.stageId;
  return typeof payloadStage === "string" && material.stages.some((stage) => stage.stageId === payloadStage) ? payloadStage : null;
}

function recoveredLifecycle(material: AuthorityRecoveryMaterial): Pick<RecoveryResult, "mode" | "phase" | "routeHealth" | "nextAction"> {
  const transitionAction = material.latestTransition?.payload.action;
  const transitionTarget = material.latestTransition?.payload.to;
  const transitionStatus = material.latestTransition?.payload.toStatus;
  const delivered = material.receipts.some((receipt) => receipt.receiptType === "DELIVERY" && receipt.result === "SUCCEEDED");
  const planContinuation = material.plan
    ? effectivePlanContinuationResolution(material.receipts, material.plan.createdEventSequence)
    : null;
  if (material.pendingEffects.length > 0) return {
    mode: "PLAN", phase: "RECOVERING", routeHealth: "RECONCILING",
    nextAction: `Reconcile pending effects: ${material.pendingEffects.map((effect) => effect.effectId).join(", ")}.`,
  };
  if (transitionAction === "pause") return { mode: "PLAN", phase: "PAUSED", routeHealth: "HEALTHY", nextAction: "Run /coding resume to continue." };
  if (transitionAction === "cancel" || transitionStatus === "CANCELED") return { mode: "PLAN", phase: "TERMINAL", routeHealth: "HEALTHY", nextAction: "Goal canceled; authority evidence retained." };
  if (transitionStatus === "SUCCEEDED" || delivered) return { mode: "PLAN", phase: "TERMINAL", routeHealth: "HEALTHY", nextAction: "Goal delivered; inspect the delivery evidence or submit a new Goal." };
  if (material.blockingDecisionIds.length > 0) return {
    mode: "PLAN", phase: "CLARIFYING", routeHealth: "NEEDS_USER",
    nextAction: `Resolve material clarifications: ${material.blockingDecisionIds.join(", ")}.`,
  };
  const transitionSequence = material.latestTransition?.sequence ?? 0;
  const invalidationAction = material.latestInvalidation?.payload.action;
  const invalidationSequence = material.latestInvalidation?.sequence ?? 0;
  if (invalidationAction === "revise_requirement"
    && invalidationSequence > (material.requirement?.createdEventSequence ?? 0)) {
    return { mode: "PLAN", phase: "SPECIFYING", routeHealth: "DEGRADED", nextAction: "Create the required RequirementRevision." };
  }
  if (invalidationAction === "replan" && invalidationSequence > (material.plan?.createdEventSequence ?? 0)) {
    return { mode: "PLAN", phase: "PLANNING", routeHealth: "DEGRADED", nextAction: "Create the required PlanRevision." };
  }
  // A resolved, Plan-bound continuation receipt supersedes the older wait_user
  // projection. Unresolved Decisions already returned above and remain blocking.
  if (planContinuation?.selection === PLAN_CONTINUE_BUILD) {
    return { mode: "BUILD", phase: "BUILDING", routeHealth: material.routeDecision?.planHealthStatus ?? "HEALTHY", nextAction: "Authorize the first eligible Stage from the user-approved frozen Plan." };
  }
  if (planContinuation?.selection === PLAN_CONTINUE_REVISE) {
    return { mode: "PLAN", phase: "PLANNING", routeHealth: "DEGRADED", nextAction: "Create the user-requested PlanRevision." };
  }
  if (planContinuation?.selection === PLAN_CONTINUE_KEEP) {
    return { mode: "PLAN", phase: "TERMINAL", routeHealth: "HEALTHY", nextAction: "Plan delivery complete; inspect the frozen Requirement and Plan." };
  }
  if (transitionTarget === "CLARIFYING") return { mode: "PLAN", phase: "CLARIFYING", routeHealth: "NEEDS_USER", nextAction: "Resolve the material clarification before specification." };
  if (transitionTarget === "SPECIFYING" && transitionSequence > (material.requirement?.createdEventSequence ?? 0)) {
    return { mode: "PLAN", phase: "SPECIFYING", routeHealth: "HEALTHY", nextAction: "Create and freeze RequirementPackage." };
  }
  if (transitionTarget === "PLANNING" && transitionSequence > (material.plan?.createdEventSequence ?? 0)) {
    return { mode: "PLAN", phase: "PLANNING", routeHealth: "HEALTHY", nextAction: "Create and freeze PlanPackage." };
  }
  if (transitionTarget === "VERIFYING") return { mode: "BUILD", phase: "VERIFYING", routeHealth: "HEALTHY", nextAction: "Verify the current Stage exit criteria and acceptance evidence." };
  if (!material.requirement) return { mode: "PLAN", phase: "SPECIFYING", routeHealth: "HEALTHY", nextAction: "Create and freeze RequirementPackage." };
  if (!material.plan) return { mode: "PLAN", phase: "PLANNING", routeHealth: "HEALTHY", nextAction: "Create and freeze PlanPackage." };
  if (material.goal.intent === "PLAN_ONLY" && material.plan) return {
    mode: "PLAN", phase: "PLANNING", routeHealth: "HEALTHY",
    nextAction: "Open the required post-Plan continuation Decision.",
  };
  return { mode: "BUILD", phase: "BUILDING", routeHealth: material.routeDecision?.planHealthStatus ?? "HEALTHY", nextAction: "Authorize the next eligible Stage through BuildEntryGate." };
}

function responseContract(value: unknown): ResponseContract {
  const candidate = object(value, "ResponseContract");
  assertId(candidate.contract_id, "ResponseContract.contract_id");
  if (candidate.schema_version !== 3 || candidate.goal_level_rebound_guard !== true
    || candidate.hard_truncation_allowed !== false || candidate.rewrite_request_allowed !== false
    || !Array.isArray(candidate.mandatory_slots)) {
    throw new AuthorityIntegrityError("Recovered ResponseContract violates the Phase 3 contract");
  }
  return candidate as unknown as ResponseContract;
}

function outputObservationContract(
  material: ObservationRecoveryMaterial,
  value: unknown,
): ResponseContract {
  const output = object(value, "OutputObservation") as unknown as OutputObservationV3;
  if (output.schema_version !== 3 || output.observation_id !== material.observationId) {
    throw new AuthorityIntegrityError("Legacy or substituted OutputObservation cannot provide exact recovery");
  }
  const contract = responseContract(output.response_contract);
  if (contract.contract_id !== output.response_contract_id
    || canonicalJsonSha256(contract) !== output.response_contract_sha256) {
    throw new AuthorityIntegrityError("OutputObservation ResponseContract binding failed");
  }
  return contract;
}

export class RecoveryCoordinator {
  constructor(private readonly authority: AuthorityStore, private readonly artifacts: ArtifactStore) {}

  recover(goalId: string, lease: LeaseToken): RecoveryResult {
    const material = this.authority.readRecoveryMaterial(goalId);
    if (lease.goalId !== goalId) throw new AuthorityIntegrityError("Recovery lease belongs to another Goal");
    const requirement = material.requirement
      ? requirementPackage(material.requirement, material.goal, this.readArtifact(material.requirement.artifact)) : null;
    const plan = material.plan
      ? planPackage(material.plan, material.goal, requirement ?? this.missingRequirement(), this.readArtifact(material.plan.artifact)) : null;
    if (requirement && canonicalJsonSha256(requirement.requirements) !== requirement.integrity.requirements_payload_sha256) {
      throw new AuthorityIntegrityError("Recovered Requirement semantic payload hash mismatch");
    }
    if (plan && canonicalJsonSha256(plan.plan) !== plan.integrity.plan_payload_sha256) {
      throw new AuthorityIntegrityError("Recovered Plan semantic payload hash mismatch");
    }
    const decoded = new Map<ObservationRecoveryMaterial, unknown>();
    for (const observation of material.observations) {
      // Raw tool evidence can be text or binary. Recovery needs its immutable ref,
      // not a JSON decode; structured projection observations remain refs as well.
      if (observation.observationType !== "TOOL_RESULT_PROJECTION") {
        decoded.set(observation, this.readArtifact(observation.artifact));
      }
    }
    const promptGenerationObservation = latest(material.observations, "PROMPT_GENERATION");
    const promptRequestObservation = latest(material.observations, "PROMPT_REQUEST");
    const outputObservation = latest(material.observations, "OUTPUT_OBSERVATION");
    const promptGeneration = promptGenerationObservation
      ? decoded.get(promptGenerationObservation) as PromptGenerationRecord : null;
    const promptRequest = promptRequestObservation ? decoded.get(promptRequestObservation) as PromptRequestRecord : null;
    if (promptGeneration && assertId(promptGeneration.prompt_generation_id, "PromptGeneration ID") !== promptGenerationObservation?.observationId) {
      throw new AuthorityIntegrityError("PromptGeneration observation ID substitution");
    }
    if (promptRequest && assertId(promptRequest.prompt_request_id, "PromptRequest ID") !== promptRequestObservation?.observationId) {
      throw new AuthorityIntegrityError("PromptRequest observation ID substitution");
    }
    const responseContracts = new Map<ObservationRecoveryMaterial, ResponseContract>();
    for (const observation of material.observations) {
      if (observation.observationType === "OUTPUT_OBSERVATION") {
        responseContracts.set(observation, outputObservationContract(observation, decoded.get(observation)));
      }
    }
    const contract = outputObservation ? responseContracts.get(outputObservation) ?? null : null;
    const lifecycle = recoveredLifecycle(material);
    const stageId = currentStage(material);
    const protectedState = this.buildProtectedState({
      material, requirement, plan, lease, lifecycle, currentStageId: stageId,
      promptGenerationObservation, promptGeneration, promptRequestObservation, promptRequest,
      outputObservation, responseContract: contract, decoded,
    });
    const chain = this.authority.verifyCheckpointChain(goalId);
    const checkpoint = this.authority.readLatestCheckpoint(goalId);
    const historicalDerivedRefs: ProtectedRef[] = [];
    for (const artifact of material.historicalRequirementArtifacts) {
      const payload = object(this.readArtifact(artifact), "historical Requirement payload") as RequirementPackage["requirements"];
      const hash = canonicalJsonSha256(payload.acceptance_criteria);
      historicalDerivedRefs.push({ id: idFromSha256("ACCEPTANCE", hash), sha256: hash });
      for (const entry of [...payload.constraints, ...payload.assumptions]) historicalDerivedRefs.push(ref(entry.id, entry));
    }
    for (const artifact of material.historicalPlanArtifacts) {
      const payload = object(this.readArtifact(artifact), "historical Plan payload") as PlanPackage["plan"];
      for (const entry of [...payload.constraints, ...payload.assumptions]) historicalDerivedRefs.push(ref(entry.id, entry));
    }
    for (const historicalContract of responseContracts.values()) {
      historicalDerivedRefs.push(ref(historicalContract.contract_id, historicalContract));
    }
    for (const observation of material.observations) {
      if (observation.observationType !== "PROMPT_GENERATION") continue;
      const generation = decoded.get(observation) as PromptGenerationRecord | undefined;
      if (!generation || assertId(generation.prompt_generation_id, "PromptGeneration ID") !== observation.observationId) {
        throw new AuthorityIntegrityError("Historical PromptGeneration observation ID substitution");
      }
      const cacheLineage = {
        cache_lineage_hmac_sha256: generation.cache_lineage_hmac_sha256,
        prefix_generation: generation.prefix_generation,
      };
      historicalDerivedRefs.push(ref(idFromSha256("CACHE_LINEAGE", canonicalJsonSha256(cacheLineage)), cacheLineage));
    }
    if (checkpoint) this.verifyCheckpointReferences(checkpoint.record.protected_state, protectedState, material, historicalDerivedRefs);
    const leaseTakeover = checkpoint !== null && checkpoint.record.protected_state.lease_generation !== lease.generation;
    const checkpointAtHead = checkpoint?.record.goal_version === material.goalVersion;
    const effectiveProtectedState = checkpointAtHead && !leaseTakeover ? checkpoint.record.protected_state : protectedState;
    const effectiveStageId = checkpointAtHead && !leaseTakeover
      ? checkpoint.record.protected_state.current_stage?.id ?? stageId : stageId;
    const checkpointExact = checkpointAtHead && !leaseTakeover
      && checkpoint?.record.protected_state_sha256 === canonicalJsonSha256(effectiveProtectedState);
    return {
      material, requirement, plan, ...lifecycle,
      nextAction: checkpointAtHead && !leaseTakeover ? checkpoint.record.protected_state.next_action : lifecycle.nextAction,
      currentStageId: effectiveStageId,
      stageStatuses: Object.fromEntries(material.stages.map((stage) => [stage.stageId, stage.status])),
      pendingEffectIds: material.pendingEffects.map((effect) => effect.effectId),
      promptGeneration, promptRequest, responseContract: contract, protectedState: effectiveProtectedState,
      checkpointCount: chain.count, checkpointSha256: chain.headSha256, checkpointExact, leaseTakeover,
    };
  }

  private buildProtectedState(input: {
    readonly material: AuthorityRecoveryMaterial;
    readonly requirement: RequirementPackage | null;
    readonly plan: PlanPackage | null;
    readonly lease: LeaseToken;
    readonly lifecycle: Pick<RecoveryResult, "phase" | "nextAction">;
    readonly currentStageId: string | null;
    readonly promptGenerationObservation: ObservationRecoveryMaterial | null;
    readonly promptGeneration: PromptGenerationRecord | null;
    readonly promptRequestObservation: ObservationRecoveryMaterial | null;
    readonly promptRequest: PromptRequestRecord | null;
    readonly outputObservation: ObservationRecoveryMaterial | null;
    readonly responseContract: ResponseContract | null;
    readonly decoded: ReadonlyMap<ObservationRecoveryMaterial, unknown>;
  }): ProtectedTaskState {
    const { material, requirement, plan } = input;
    const acceptanceValue = requirement?.requirements.acceptance_criteria ?? { objective_sha256: material.goal.objectiveSha256 };
    const acceptanceHash = canonicalJsonSha256(acceptanceValue);
    const acceptance = { id: idFromSha256("ACCEPTANCE", acceptanceHash), sha256: acceptanceHash };
    const constraints = (plan?.plan.constraints ?? requirement?.requirements.constraints ?? []).map((entry) => ref(entry.id, entry));
    const assumptions = (plan?.plan.assumptions ?? requirement?.requirements.assumptions ?? []).map((entry) => ref(entry.id, entry));
    const currentStageValue = input.currentStageId && plan ? plan.plan.stages.find((stage) => stage.id === input.currentStageId) ?? null : null;
    const promptGenerationRef = input.promptGenerationObservation?.ref ?? null;
    const promptRequestRef = input.promptRequestObservation?.ref ?? null;
    const cacheLineage = input.promptGeneration ? {
      cache_lineage_hmac_sha256: input.promptGeneration.cache_lineage_hmac_sha256,
      prefix_generation: input.promptGeneration.prefix_generation,
    } : null;
    const evidence = material.observations.filter((entry) => entry.observationType === "TOOL_RESULT_PROJECTION").map((entry) => entry.ref);
    const executionPhase = input.lifecycle.phase === "CLARIFYING" ? "CLARIFYING"
      : input.lifecycle.phase === "SPECIFYING" ? "SPECIFYING"
      : input.lifecycle.phase === "PLANNING" ? "PLANNING"
        : input.lifecycle.phase === "BUILDING" ? "BUILDING"
          : input.lifecycle.phase === "VERIFYING" ? "VERIFYING"
            : input.lifecycle.phase === "TERMINAL" ? "TERMINAL"
              : requirement ? plan ? "BUILDING" : "PLANNING" : "SPECIFYING";
    const state: ProtectedTaskState = {
      objective: material.goal.objective, acceptance_contract: acceptance,
      constraints, latest_correction: material.latestCorrection ? { id: material.latestCorrection.eventId, sha256: material.latestCorrection.eventSha256 } : null,
      assumptions,
      requirement_revision: material.requirement ? { id: material.requirement.requirementId, sha256: material.requirement.payloadSha256 } : null,
      plan_revision: material.plan ? { id: material.plan.planId, sha256: material.plan.payloadSha256 } : null,
      execution_phase: executionPhase,
      current_stage: currentStageValue ? { id: currentStageValue.id, sha256: canonicalJsonSha256(currentStageValue) } : null,
      next_action: input.lifecycle.nextAction,
      pending_effects: material.pendingEffects.map((effect) => effect.ref),
      // A checkpoint cannot contain the receipt created by its own transaction. Excluding all
      // checkpoint receipts keeps the exact projection stable before and after that commit.
      receipts: material.receipts.filter((receipt) => receipt.receiptType !== "CHECKPOINT").map((receipt) => receipt.ref),
      failure_signatures: material.failureSignatures, route_decision: material.routeDecision?.ref ?? null,
      active_performance_trial: material.activePerformanceTrial?.ref ?? null, prompt_generation: promptGenerationRef, prompt_request: promptRequestRef,
      cache_lineage: cacheLineage ? ref(idFromSha256("CACHE_LINEAGE", canonicalJsonSha256(cacheLineage)), cacheLineage) : null,
      response_contract: input.responseContract ? ref(input.responseContract.contract_id, input.responseContract) : null,
      evidence_frontier: evidence, lease_generation: input.lease.generation,
    };
    validateProtectedState(state);
    return state;
  }

  private verifyCheckpointReferences(
    checkpoint: ProtectedTaskState,
    current: ProtectedTaskState,
    material: AuthorityRecoveryMaterial,
    historicalDerivedRefs: readonly ProtectedRef[],
  ): void {
    const known = new Map<string, Set<string>>();
    const add = (entry: ProtectedRef | null): void => {
      if (!entry) return;
      const values = known.get(entry.id) ?? new Set<string>();
      values.add(entry.sha256);
      known.set(entry.id, values);
    };
    add(current.acceptance_contract);
    const provisionalAcceptance = { objective_sha256: material.goal.objectiveSha256 };
    add(ref(idFromSha256("ACCEPTANCE", canonicalJsonSha256(provisionalAcceptance)), provisionalAcceptance));
    for (const entry of [...current.constraints, ...current.assumptions, ...current.pending_effects, ...current.receipts, ...current.evidence_frontier]) add(entry);
    for (const entry of [current.latest_correction, current.requirement_revision, current.plan_revision, current.current_stage,
      current.route_decision, current.active_performance_trial, current.prompt_generation, current.prompt_request,
      current.cache_lineage, current.response_contract]) add(entry);
    for (const observation of material.observations) add(observation.ref);
    for (const stage of material.stages) add({ id: stage.stageId, sha256: stage.specSha256 });
    for (const entry of material.historicalRefs) add(entry);
    for (const entry of historicalDerivedRefs) add(entry);
    const required = [checkpoint.acceptance_contract, ...checkpoint.constraints, ...checkpoint.assumptions,
      ...checkpoint.pending_effects, ...checkpoint.receipts, ...checkpoint.evidence_frontier,
      checkpoint.latest_correction, checkpoint.requirement_revision, checkpoint.plan_revision, checkpoint.current_stage,
      checkpoint.route_decision, checkpoint.active_performance_trial, checkpoint.prompt_generation,
      checkpoint.prompt_request, checkpoint.cache_lineage, checkpoint.response_contract].filter((entry): entry is ProtectedRef => entry !== null);
    for (const entry of required) {
      if (!known.get(entry.id)?.has(entry.sha256)) {
        throw new AuthorityIntegrityError(`Checkpoint reference is not backed by immutable authority material: ${entry.id}`);
      }
    }
  }

  private readArtifact(record: { readonly locator: string; readonly sha256: string; readonly byteLength: number }): unknown {
    return readRecoveryArtifact(this.artifacts, record);
  }

  private missingRequirement(): RequirementPackage {
    throw new AuthorityIntegrityError("Plan recovery requires its frozen Requirement revision");
  }
}
