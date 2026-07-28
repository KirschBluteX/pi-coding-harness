import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { AuthorityStore, CommandResult, MutationMeta } from "../authority/transactions.js";
import type { LeaseToken } from "../authority/lease.js";
import type { Clock } from "../foundation/clock.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { createId, idFromSha256 } from "../foundation/ids.js";
import {
  normalizeToolEffect, type NormalizedEffect, type ToolInvocation,
} from "../effects/normalize.js";
import {
  evaluateOraclePolicy, type OraclePolicyDecision,
} from "../effects/oracle-policy.js";
import {
  evaluatePerformancePhase, measurementsFromBenchmarkOutput,
  type TargetPerformanceMeasurementRecord, type TargetPerformanceVerdictRecord,
} from "../performance/task-flow-measurements.js";
import {
  targetPerformanceContract, targetPerformancePhase,
} from "../performance/task-flow-policy.js";
import {
  sealTaskFlowRecord,
  type EvidenceAttestationRecord,
  type ExecutionSubjectRef,
  type OperationAttemptRecord,
  type OperationReconcileLocatorRecord,
  type OperationState,
  type OperationTransitionRecord,
  type RouteHealthRecord,
  type WorkCellRecord,
  type WorkspaceBaselineRecord,
} from "./domain.js";
import { assessRouteHealth, type RouteHealthInput } from "./health.js";
import { oracleCommands, workCellOracleCoversObligation } from "./oracles.js";
import type { TaskFlowCurrentView } from "./repository.js";

export interface TaskFlowOperationAdmission {
  readonly allow: boolean;
  readonly managed: boolean;
  readonly reason: string | null;
  readonly oracle_policy?: OraclePolicyDecision;
}

export interface TaskFlowAttestationInput {
  readonly operation_id: string;
  readonly obligation_keys?: readonly string[];
}

export interface TaskFlowOperationState {
  readonly goalId: string;
  readonly contractRevisionRequested: boolean;
  readonly lease: Pick<LeaseToken, "generation" | "fencingToken">;
  readonly view: TaskFlowCurrentView;
}

/**
 * Application-facing effects required by the Task Flow operation state machine.
 * The Adapter supplies workspace and session mechanics; lifecycle ordering and
 * authority invariants stay inside the Task Flow Module.
 */
export interface TaskFlowOperationAdapter {
  current(): TaskFlowOperationState | null;
  workspaceRoot(): string;
  workspaceSecret(): Uint8Array;
  executionSubject(): ExecutionSubjectRef;
  ensureLease(): void;
  mutation(idempotencyKey: string): MutationMeta;
  accept(result: CommandResult): void;
  targetWithinRoots(target: string, roots: readonly string[]): boolean;
  hashTarget(path: string): string;
  captureBaseline(cell: WorkCellRecord): WorkspaceBaselineRecord;
  completeWork(): string;
  authorizeNextWork(): boolean;
  clearBlocker(): void;
  retryLimit(): number;
}

interface PendingOperation {
  readonly toolCallId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly normalized: NormalizedEffect;
  readonly operationKind: OperationAttemptRecord["operation_kind"];
  readonly validationCommand: string | null;
  readonly expectedPostimageSha256: string | null;
  state: OperationState;
}

interface ValidationAttempt {
  readonly attemptId: string;
  readonly operationId: string;
}

function operationKind(normalized: NormalizedEffect): OperationAttemptRecord["operation_kind"] {
  if (normalized.classificationReason === "ALLOWLISTED_LOCAL_VALIDATION") return "VALIDATION";
  if (normalized.toolName === "write") return "WRITE";
  if (normalized.toolName === "edit") return "EDIT";
  if (normalized.toolName === "coding_integrate") {
    const operation = normalized.actionSpec.operation;
    if (operation === "CREATE") return "WRITE";
    if (operation === "MODIFY") return "EDIT";
    if (operation === "DELETE") return "DELETE";
  }
  return normalized.effectClass === "IRREVERSIBLE" || normalized.effectClass === "EXTERNAL_UNKNOWN_WRITE"
    ? "EXTERNAL" : "COMMAND";
}

function ceilingRank(value: WorkCellRecord["effect_classes"][number]): number {
  return value === "READ_ONLY" ? 0 : value === "LOCAL_REVERSIBLE" ? 1 : value === "EXTERNAL_IDEMPOTENT" ? 2 : 3;
}

export class TaskFlowOperationLifecycle {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly passedValidationCommands = new Map<string, Set<string>>();
  private readonly passedValidationAttempts = new Map<string, Map<string, ValidationAttempt>>();

  constructor(
    private readonly authority: AuthorityStore,
    private readonly clock: Clock,
    private readonly adapter: TaskFlowOperationAdapter,
  ) {}

  prepare(invocation: ToolInvocation): TaskFlowOperationAdmission {
    const state = this.adapter.current();
    if (!state) return { allow: true, managed: false, reason: null };
    if (state.contractRevisionRequested) {
      return {
        allow: false, managed: false,
        reason: "GoalContract revision is open; submit the revised contract before any BUILD mutation.",
      };
    }
    const normalized = normalizeToolEffect(invocation);
    if (normalized.effectClass === "READ_ONLY") {
      if (!normalized.withinWorkspace) {
        return { allow: false, managed: false, reason: "PCH denies reads outside the active workspace." };
      }
      const cell = this.currentCell(state);
      const routeReadRoots = state.view.route?.work_cells.flatMap((entry) => [...entry.read_roots, ...entry.write_roots]) ?? [];
      if (state.view.status === "BUILDING" && cell && normalized.classificationReason === "BUILTIN_READ_TOOL"
        && !this.adapter.targetWithinRoots(normalized.normalizedTarget, routeReadRoots)) {
        return { allow: false, managed: false, reason: "Read target is outside the frozen Route read scope." };
      }
      return { allow: true, managed: false, reason: null };
    }
    if (state.view.unresolvedOperationIds.length > 0) {
      return {
        allow: false, managed: false,
        reason: "Reconcile the durable unresolved Operation before preparing another mutation.",
      };
    }
    if (state.view.status !== "BUILDING" || !state.view.authorization || !state.view.workCellId) {
      return {
        allow: false, managed: false,
        reason: "PCH Task Flow is not write-authorized; complete contract/route/continuation first.",
      };
    }
    if ([...this.pending.values()].some((operation) => !["COMMITTED", "FAILED", "RECONCILED"].includes(operation.state))) {
      return { allow: false, managed: false, reason: "PCH permits one mutating or validation Operation at a time." };
    }
    const cell = this.currentCell(state);
    if (!cell) return { allow: false, managed: false, reason: "Current WorkCell is missing from the current route." };
    const kind = operationKind(normalized);
    if (kind === "EXTERNAL" || normalized.effectClass === "IRREVERSIBLE") {
      return {
        allow: false, managed: false,
        reason: "External, unknown, or irreversible effects require a separate user Decision and are not implicitly authorized by BUILD.",
      };
    }
    const requiredCeiling = kind === "VALIDATION" ? "READ_ONLY"
      : ["WRITE", "EDIT", "DELETE"].includes(kind) ? "LOCAL_REVERSIBLE" : "EXTERNAL_IDEMPOTENT";
    if (ceilingRank(requiredCeiling) > ceilingRank(state.view.authorization.effect_ceiling)
      || !cell.effect_classes.some((value) => ceilingRank(value) >= ceilingRank(requiredCeiling))) {
      return { allow: false, managed: false, reason: "Operation exceeds the current WorkCell effect ceiling." };
    }
    if (["WRITE", "EDIT", "DELETE"].includes(kind)
      && !this.adapter.targetWithinRoots(normalized.normalizedTarget, cell.write_roots)) {
      return { allow: false, managed: false, reason: "Operation target is outside the current WorkCell write scope." };
    }
    const requestedTimeoutMs = typeof invocation.input.timeout === "number"
      && Number.isFinite(invocation.input.timeout) && invocation.input.timeout >= 1
      ? Math.min(900_000, Math.max(1_000, Math.floor(invocation.input.timeout * 1_000)))
      : undefined;
    const oraclePolicy = kind === "VALIDATION" ? evaluateOraclePolicy({
      command: typeof invocation.input.command === "string" ? invocation.input.command : "",
      cwd: invocation.cwd,
      declared_commands: oracleCommands(cell.oracle),
      ...(requestedTimeoutMs === undefined ? {} : { timeout_ms: requestedTimeoutMs }),
      max_output_bytes: 50 * 1024,
    }) : null;
    if (oraclePolicy && !oraclePolicy.allow) {
      return { allow: false, managed: false, reason: oraclePolicy.message, oracle_policy: oraclePolicy };
    }
    try {
      this.adapter.ensureLease();
      const current = this.requiredState();
      const authorization = current.view.authorization;
      if (!authorization) throw new AuthorityIntegrityError("ExecutionAuthorization disappeared before Operation prepare");
      const baseline = this.authority.readTaskFlowBaseline(authorization.baseline_id);
      if (!baseline) throw new AuthorityIntegrityError("ExecutionAuthorization baseline is missing");
      const preimageSha256 = this.targetPreimage(normalized, kind);
      const subject = this.adapter.executionSubject();
      const operationId = idFromSha256("OPERATION", sha256Hex(canonicalJson({
        goalId: current.goalId, subject: subject.bindingSha256, tool: normalized.toolName,
        target: normalized.normalizedTargetSha256, semanticPayload: normalized.semanticPayloadSha256,
      })));
      const attemptNumber = this.authority.readTaskFlowOperationAttemptCount(current.goalId, operationId) + 1;
      const fingerprint = canonicalJsonSha256({
        subject, normalizedTarget: normalized.normalizedTargetSha256,
        normalizedPayload: normalized.normalizedPayloadSha256, preimageSha256,
        baseline: baseline.record_sha256, environment: baseline.environment_sha256,
        oracle: canonicalJsonSha256(cell.oracle), oraclePolicy: oraclePolicy ? canonicalJsonSha256(oraclePolicy) : null,
        leaseGeneration: current.lease.generation, fencingToken: current.lease.fencingToken,
        authorization: authorization.record_sha256,
      });
      const attemptId = idFromSha256("ATTEMPT", sha256Hex(`${operationId}\0${attemptNumber}\0${fingerprint}`));
      const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
        schema_version: 1, attempt_id: attemptId, operation_id: operationId, goal_id: current.goalId,
        work_cell_id: current.view.workCellId!, authorization_id: authorization.authorization_id,
        attempt_number: attemptNumber, operation_kind: kind,
        normalized_target_hmac: hmacSha256Hex(this.adapter.workspaceSecret(), normalized.normalizedTarget),
        normalized_payload_sha256: normalized.normalizedPayloadSha256,
        execution_fingerprint_sha256: fingerprint, baseline_sha256: baseline.record_sha256,
        environment_sha256: baseline.environment_sha256, oracle_sha256: canonicalJsonSha256(cell.oracle),
        idempotency_key_hmac: hmacSha256Hex(this.adapter.workspaceSecret(), `${operationId}\0${fingerprint}`),
        created_at_ms: this.clock.now(),
      }, "record_sha256");
      const prepared = this.operationTransition(attemptId, 0, "PREPARED", null, null, null, "UNKNOWN", null);
      const dispatched = this.operationTransition(
        attemptId, 1, "DISPATCHED", null, null, null, "UNKNOWN", prepared.transition_sha256,
      );
      const reconcileLocator = ["WRITE", "EDIT", "DELETE"].includes(kind)
        ? this.reconcileLocator(attempt, normalized, invocation.input, preimageSha256) : null;
      const result = this.authority.transactTaskFlow({
        type: "PREPARE_AND_DISPATCH_OPERATION", goalId: current.goalId,
        attempt, prepared, dispatched, reconcileLocator,
      }, this.adapter.mutation(`task-flow:operation:prepare-dispatch:${attempt.record_sha256}`));
      this.adapter.accept(result);
      this.pending.set(invocation.toolCallId, {
        toolCallId: invocation.toolCallId, operationId, attemptId, normalized, operationKind: kind,
        validationCommand: kind === "VALIDATION" && typeof invocation.input.command === "string"
          ? invocation.input.command.trim().normalize("NFC") : null,
        expectedPostimageSha256: this.expectedPostimage(kind, invocation.input), state: "DISPATCHED",
      });
      return { allow: true, managed: true, reason: null, ...(oraclePolicy ? { oracle_policy: oraclePolicy } : {}) };
    } catch (error) {
      return {
        allow: false, managed: false,
        reason: `PCH Operation preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  observe(toolCallId: string, isError: boolean, text: string, reportedOutputSha256?: string): string | null {
    const pending = this.pending.get(toolCallId);
    if (!pending) return null;
    if (pending.state !== "DISPATCHED") return null;
    if (reportedOutputSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(reportedOutputSha256)) {
      throw new TypeError("Tool result SHA-256 is invalid");
    }
    const outputSha256 = reportedOutputSha256 ?? sha256Hex(text);
    if (isError) {
      const failure = canonicalJsonSha256({ operationId: pending.operationId, outputSha256, reason: "TOOL_RESULT_ERROR" });
      this.transitionPending(pending, "FAILED", outputSha256, null, failure, "FAIL");
      this.assessFailure(failure, false, true);
      return `PCH_OPERATION_FAILED operation=${pending.operationId}; repair the cause before a changed attempt.`;
    }
    let performanceMeasurements: readonly TargetPerformanceMeasurementRecord[] = [];
    if (pending.operationKind === "VALIDATION" && pending.validationCommand) {
      const state = this.requiredState();
      const cell = this.currentCell(state);
      const contract = state.view.contract ? targetPerformanceContract(state.view.contract) : null;
      const phase = cell ? targetPerformancePhase(cell) : null;
      if (contract && phase && contract.workloads.some((entry) => entry.command === pending.validationCommand)) {
        try {
          performanceMeasurements = measurementsFromBenchmarkOutput({
            goalId: state.goalId, workCellId: cell!.work_cell_id, contract, phase,
            operationId: pending.attemptId, command: pending.validationCommand,
            outputSha256, text, createdAtMs: this.clock.now(),
          });
        } catch (error) {
          const failure = canonicalJsonSha256({
            operationId: pending.operationId, reason: "PERFORMANCE_RESULT_INVALID",
            error: error instanceof Error ? error.message : String(error), outputSha256,
          });
          this.transitionPending(pending, "FAILED", outputSha256, null, failure, "FAIL");
          this.assessFailure(failure, false, true);
          return `PCH_PERFORMANCE_RESULT_INVALID operation=${pending.operationId}; ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    let readbackSha256: string;
    try {
      readbackSha256 = ["WRITE", "EDIT", "DELETE"].includes(pending.operationKind)
        ? this.adapter.hashTarget(pending.normalized.normalizedTarget) : outputSha256;
    } catch (error) {
      this.transitionPending(pending, "OUTCOME_UNKNOWN", outputSha256, null,
        canonicalJsonSha256({ operationId: pending.operationId, error: error instanceof Error ? error.message : String(error) }), "UNKNOWN");
      this.assessFailure(canonicalJsonSha256({ operationId: pending.operationId, reason: "READBACK_FAILED" }), true, false);
      return `PCH_OUTCOME_UNKNOWN operation=${pending.operationId}; reconcile by readback before retry.`;
    }
    if (pending.expectedPostimageSha256 !== null && readbackSha256 !== pending.expectedPostimageSha256) {
      const failure = canonicalJsonSha256({
        operationId: pending.operationId, reason: "POSTIMAGE_MISMATCH",
        expected: pending.expectedPostimageSha256, actual: readbackSha256,
      });
      this.transitionPending(pending, "OUTCOME_UNKNOWN", outputSha256, readbackSha256, failure, "FAIL");
      this.assessFailure(failure, true, false);
      return `PCH_OUTCOME_UNKNOWN operation=${pending.operationId}; postimage mismatch requires reconciliation.`;
    }
    this.transitionPending(pending, "OBSERVED", outputSha256, readbackSha256, null, "PASS");
    this.transitionPending(pending, "COMMITTED", outputSha256, readbackSha256, null, "PASS");
    if (performanceMeasurements.length > 0) this.authority.insertTargetPerformanceMeasurements(performanceMeasurements);
    if (pending.operationKind !== "VALIDATION") {
      const cellId = this.currentCell(this.requiredState())?.work_cell_id;
      if (cellId) this.clearValidationProgress(cellId);
      return `PCH_OPERATION_COMMITTED operation=${pending.operationId}; readback=${readbackSha256}.`;
    }
    const cell = this.currentCell(this.requiredState());
    if (!cell || !pending.validationCommand) {
      return `PCH_OPERATION_COMMITTED operation=${pending.operationId}; automatic validation finalization is unavailable.`;
    }
    const passed = this.passedValidationCommands.get(cell.work_cell_id) ?? new Set<string>();
    passed.add(pending.validationCommand);
    this.passedValidationCommands.set(cell.work_cell_id, passed);
    const attempts = this.passedValidationAttempts.get(cell.work_cell_id) ?? new Map<string, ValidationAttempt>();
    attempts.set(pending.validationCommand, { attemptId: pending.attemptId, operationId: pending.operationId });
    this.passedValidationAttempts.set(cell.work_cell_id, attempts);
    const missing = oracleCommands(cell.oracle).filter((command) => !passed.has(command));
    if (missing.length > 0) {
      return `PCH_OPERATION_COMMITTED operation=${pending.operationId}; remaining validation commands=${missing.length}.`;
    }
    const performanceVerdict = this.evaluateCurrentPerformancePhase(
      cell, new Set([...attempts.values()].map((entry) => entry.attemptId)),
    );
    if (performanceVerdict?.verdict === "FAIL") {
      this.clearValidationProgress(cell.work_cell_id);
      const failure = canonicalJsonSha256({
        domain: "PCH-TARGET-PERFORMANCE-GATE-FAILURE-V1", verdict: performanceVerdict.record_sha256,
      });
      this.assessFailure(failure, false, true);
      return `PCH_PERFORMANCE_GATE_FAILED operation=${pending.operationId}; reasons=${performanceVerdict.reasons.join(",")}.`;
    }
    const contract = this.requiredState().view.contract;
    if (!contract) throw new AuthorityIntegrityError("Automatic finalization requires a current GoalContract");
    const byOperation = new Map<string, string[]>();
    for (const obligation of contract.obligations.filter((entry) => cell.obligation_ids.includes(entry.obligation_id))) {
      const matchingCommand = oracleCommands(obligation.oracle).find((command) => attempts.has(command));
      if (!matchingCommand) throw new AuthorityIntegrityError(`No fresh validation Operation proves ${obligation.semantic_key}`);
      const operationId = attempts.get(matchingCommand)!.operationId;
      const keys = byOperation.get(operationId) ?? [];
      keys.push(obligation.semantic_key);
      byOperation.set(operationId, keys);
    }
    const attested = this.attestBatch([...byOperation].map(([operationId, obligationKeys]) => ({
      operation_id: operationId, obligation_keys: obligationKeys,
    })));
    const completed = this.adapter.completeWork();
    this.clearValidationProgress(cell.work_cell_id);
    return `PCH_OPERATION_COMMITTED operation=${pending.operationId}; ${attested} ${completed}`;
  }

  finish(toolCallId: string, isError: boolean, text: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending || ["COMMITTED", "FAILED", "RECONCILED", "OUTCOME_UNKNOWN"].includes(pending.state)) return;
    if (isError) void this.observe(toolCallId, true, text);
    else if (pending.state === "DISPATCHED") {
      const failure = canonicalJsonSha256({ operationId: pending.operationId, reason: "MISSING_TOOL_RESULT" });
      this.transitionPending(pending, "OUTCOME_UNKNOWN", text ? sha256Hex(text) : null, null, failure, "UNKNOWN");
      this.assessFailure(failure, true, false);
    }
  }

  reconcile(operationId?: string, authorizeNext = true): string {
    const state = this.requiredState();
    this.adapter.ensureLease();
    const unresolved = this.authority.readUnresolvedTaskFlowOperations(state.goalId)
      .filter((snapshot) => operationId === undefined || snapshot.attempt.operation_id === operationId);
    if (unresolved.length === 0) return "No unresolved Task Flow Operation requires reconciliation.";
    const results: string[] = [];
    for (const snapshot of unresolved) {
      if (snapshot.state === "OBSERVED") {
        const locator = snapshot.reconcileLocator;
        const mutation = snapshot.attempt.operation_kind !== "VALIDATION";
        const target = locator ? resolve(this.adapter.workspaceRoot(), locator.target_relative) : null;
        const currentReadback = target && this.contained(this.adapter.workspaceRoot(), target)
          ? this.adapter.hashTarget(target) : null;
        if (!mutation || (locator && currentReadback === locator.expected_postimage_sha256
          && currentReadback === snapshot.readbackSha256 && snapshot.postcondition === "PASS")) {
          const transition = this.operationTransition(snapshot.attempt.attempt_id, snapshot.ordinal + 1, "COMMITTED",
            snapshot.outputSha256, snapshot.readbackSha256, snapshot.failureSignatureSha256,
            snapshot.postcondition, snapshot.transitionSha256);
          this.accept(this.authority.transactTaskFlow({
            type: "RECONCILE_OPERATION", goalId: state.goalId, transition, disposition: "APPLIED",
          }, this.adapter.mutation(`task-flow:reconcile:${transition.transition_sha256}`)));
          results.push(`${snapshot.attempt.operation_id}=COMMITTED_FROM_OBSERVED`);
          continue;
        }
      }
      if (!["PREPARED", "DISPATCHED", "OBSERVED", "OUTCOME_UNKNOWN"].includes(snapshot.state)) {
        throw new AuthorityIntegrityError("Unsupported unresolved Operation state");
      }
      let disposition: "APPLIED" | "NOT_APPLIED" | "APPLIED_UNVERIFIED" | "SAFE_TO_RETRY";
      let readbackSha256: string | null = null;
      if (snapshot.attempt.operation_kind === "VALIDATION") {
        disposition = "SAFE_TO_RETRY";
      } else {
        const locator = snapshot.reconcileLocator;
        if (!locator) throw new AuthorityIntegrityError("Mutating Operation lacks a local reconciliation locator");
        const target = resolve(this.adapter.workspaceRoot(), locator.target_relative);
        if (!this.contained(this.adapter.workspaceRoot(), target)) {
          throw new AuthorityIntegrityError("Reconciliation locator escapes the workspace");
        }
        readbackSha256 = this.adapter.hashTarget(target);
        disposition = locator.expected_postimage_sha256 !== null && readbackSha256 === locator.expected_postimage_sha256
          ? "APPLIED" : readbackSha256 === locator.preimage_sha256 ? "NOT_APPLIED" : "APPLIED_UNVERIFIED";
      }
      const postcondition = disposition === "APPLIED" ? "PASS" : disposition === "NOT_APPLIED" ? "FAIL" : "UNKNOWN";
      const failureSha256 = snapshot.failureSignatureSha256 ?? canonicalJsonSha256({
        operationId: snapshot.attempt.operation_id,
        reason: "RECOVERY_OUTCOME_RECONCILED",
        priorState: snapshot.state,
        disposition,
      });
      const transition = this.operationTransition(snapshot.attempt.attempt_id, snapshot.ordinal + 1, "RECONCILED",
        snapshot.outputSha256, readbackSha256, failureSha256, postcondition, snapshot.transitionSha256);
      this.accept(this.authority.transactTaskFlow({
        type: "RECONCILE_OPERATION", goalId: state.goalId, transition, disposition,
      }, this.adapter.mutation(`task-flow:reconcile:${transition.transition_sha256}`)));
      results.push(`${snapshot.attempt.operation_id}=${disposition}`);
    }
    this.pending.clear();
    this.adapter.clearBlocker();
    if (authorizeNext && state.view.nextActionCode === "AUTHORIZE_WORK") this.adapter.authorizeNextWork();
    return `Task Flow reconciliation committed: ${results.join(", ")}; next=${state.view.nextActionCode}.`;
  }

  attest(input: TaskFlowAttestationInput): string {
    return this.attestBatch([input]);
  }

  private attestBatch(inputs: readonly TaskFlowAttestationInput[]): string {
    if (inputs.length === 0) throw new TypeError("Attestation batch must not be empty");
    const state = this.requiredState();
    this.adapter.ensureLease();
    const cell = this.currentCell(state);
    const contract = state.view.contract;
    if (!cell || !contract) throw new AuthorityIntegrityError("Attestation lacks current WorkCell or GoalContract");
    const resolved = inputs.map((input) => {
      const snapshot = this.authority.readTaskFlowOperation(state.goalId, input.operation_id);
      const outputSha256 = snapshot?.outputSha256 ?? null;
      if (!snapshot || snapshot.state !== "COMMITTED" || snapshot.attempt.operation_kind !== "VALIDATION"
        || snapshot.postcondition !== "PASS" || outputSha256 === null) {
        throw new TypeError("Attestation requires a committed current validation Operation with PASS postcondition");
      }
      if (snapshot.attempt.work_cell_id !== state.view.workCellId) {
        throw new TypeError("Validation Operation is not owned by the current WorkCell");
      }
      const requested = input.obligation_keys?.length
        ? new Set(input.obligation_keys)
        : new Set(contract.obligations.filter((entry) => cell.obligation_ids.includes(entry.obligation_id))
          .map((entry) => entry.semantic_key));
      const obligations = contract.obligations.filter((entry) => requested.has(entry.semantic_key)
        && cell.obligation_ids.includes(entry.obligation_id));
      if (obligations.length !== requested.size || obligations.length === 0) {
        throw new TypeError("Attestation contains an unknown or out-of-cell obligation key");
      }
      if (obligations.some((obligation) => !workCellOracleCoversObligation(cell.oracle, obligation))) {
        throw new TypeError("Validation oracle does not prove every requested obligation oracle");
      }
      return { snapshot, outputSha256, obligations };
    });
    const obligationKeys = resolved.flatMap((entry) => entry.obligations.map((obligation) => obligation.semantic_key));
    if (new Set(obligationKeys).size !== obligationKeys.length) {
      throw new TypeError("Attestation batch cannot prove the same obligation more than once");
    }
    const baseline = this.adapter.captureBaseline(cell);
    this.accept(this.authority.transactTaskFlow({
      type: "RECORD_WORKSPACE_BASELINE", goalId: state.goalId, baseline,
    }, this.adapter.mutation(`task-flow:baseline:post-validation:${baseline.record_sha256}`)));
    for (const { snapshot, outputSha256, obligations } of resolved) {
      for (const obligation of obligations) {
        const attestation = sealTaskFlowRecord<EvidenceAttestationRecord, "record_sha256">("PCH-EVIDENCE-ATTESTATION-V1", {
          schema_version: 1,
          attestation_id: idFromSha256("ATTESTATION", sha256Hex(`${snapshot.attempt.operation_id}\0${obligation.obligation_id}\0${baseline.record_sha256}`)),
          goal_id: state.goalId, work_cell_id: cell.work_cell_id, operation_id: snapshot.attempt.operation_id,
          obligation_id: obligation.obligation_id, oracle_sha256: canonicalJsonSha256(obligation.oracle),
          input_closure_sha256: canonicalJsonSha256({
            executionFingerprint: snapshot.attempt.execution_fingerprint_sha256,
            finalBaseline: baseline.record_sha256, obligation: obligation.record_sha256,
          }),
          output_sha256: outputSha256, baseline_sha256: baseline.record_sha256,
          environment_sha256: baseline.environment_sha256, result: "PASS", freshness: "CURRENT",
          postcondition: "PASS", artifact_id: null, created_at_ms: this.clock.now(),
        }, "record_sha256");
        this.accept(this.authority.transactTaskFlow({
          type: "ATTEST_EVIDENCE", goalId: state.goalId, attestation,
        }, this.adapter.mutation(`task-flow:attest:${attestation.record_sha256}`)));
      }
    }
    return `EvidenceAttestation PASS for ${obligationKeys.join(", ")}; baseline=${baseline.baseline_id}.`;
  }

  private transitionPending(
    pending: PendingOperation, state: OperationState, outputSha256: string | null,
    readbackSha256: string | null, failureSha256: string | null,
    postcondition: OperationTransitionRecord["postcondition"],
  ): void {
    const goal = this.requiredState();
    const snapshot = this.authority.readTaskFlowOperation(goal.goalId, pending.operationId);
    if (!snapshot) throw new AuthorityIntegrityError("Operation head disappeared before transition");
    const transition = this.operationTransition(
      pending.attemptId, snapshot.ordinal + 1, state, outputSha256, readbackSha256,
      failureSha256, postcondition, snapshot.transitionSha256,
    );
    this.accept(this.authority.transactTaskFlow({
      type: "TRANSITION_OPERATION", goalId: goal.goalId, transition,
    }, this.adapter.mutation(`task-flow:operation:${transition.transition_sha256}`)));
    pending.state = state;
  }

  private operationTransition(
    attemptId: string, ordinal: number, state: OperationState, outputSha256: string | null,
    readbackSha256: string | null, failureSha256: string | null,
    postcondition: OperationTransitionRecord["postcondition"], predecessorSha256: string | null,
  ): OperationTransitionRecord {
    return sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: createId("TRANSITION"), attempt_id: attemptId, ordinal, state,
      output_sha256: outputSha256, readback_sha256: readbackSha256,
      failure_signature_sha256: failureSha256, postcondition, predecessor_sha256: predecessorSha256,
      created_at_ms: this.clock.now(),
    }, "transition_sha256");
  }

  private assessFailure(signature: string, unknownEffect: boolean, localRepairAvailable: boolean): void {
    const state = this.requiredState();
    const route = state.view.route;
    if (!route) return;
    const occurrence = this.authority.readTaskFlowFailureOccurrence(state.goalId, signature);
    const assessment: RouteHealthInput = {
      ...this.healthyAssessment(state), unknownEffect, localRepairAvailable,
      failureSignatureSha256: signature, failureOccurrence: Math.max(1, occurrence), transientFailure: !unknownEffect,
    };
    const decision = assessRouteHealth(assessment);
    const health = sealTaskFlowRecord<RouteHealthRecord, "record_sha256">("PCH-ROUTE-HEALTH-V1", {
      schema_version: 1, health_id: createId("HEALTH"), goal_id: state.goalId, route_id: route.route_id,
      work_cell_id: state.view.workCellId, trigger_sha256: decision.triggerSha256,
      failure_signature_sha256: assessment.failureSignatureSha256, occurrence: assessment.failureOccurrence,
      level: decision.level, reason_code: decision.reasonCode, selected_route_id: null, created_at_ms: this.clock.now(),
    }, "record_sha256");
    this.accept(this.authority.transactTaskFlow({
      type: "RECORD_TASK_FLOW_HEALTH", goalId: state.goalId, health,
    }, this.adapter.mutation(`task-flow:health:${canonicalJsonSha256(assessment)}`)));
  }

  private healthyAssessment(state: TaskFlowOperationState): RouteHealthInput {
    const contract = state.view.contract;
    const route = state.view.route;
    const currentRecordCount = (contract ? 1 + contract.obligations.length : 0)
      + (route ? 1 + route.work_cells.length : 0)
      + (state.view.authorization ? 1 : 0) + (state.view.latestHealth ? 1 : 0);
    return {
      activeObligationCount: contract?.obligations.length ?? 0, currentRecordCount,
      unknownEffect: false, authorityIntegrityFailure: false, materialDecisionOpen: false,
      assumptionInvalidated: false, acceptanceUnreachable: false, failureSignatureSha256: null,
      failureOccurrence: 0, retryLimit: Math.max(1, this.adapter.retryLimit()), transientFailure: false,
      localRepairAvailable: false, routeAlternativeAvailable: true, progressObserved: false,
    };
  }

  private evaluateCurrentPerformancePhase(
    cell: WorkCellRecord,
    currentAttemptIds: ReadonlySet<string>,
  ): TargetPerformanceVerdictRecord | null {
    const state = this.requiredState();
    const contract = state.view.contract ? targetPerformanceContract(state.view.contract) : null;
    const phase = targetPerformancePhase(cell);
    if (!contract || !phase) return null;
    const latest = (records: readonly TargetPerformanceMeasurementRecord[]): TargetPerformanceMeasurementRecord[] => {
      const byMetric = new Map<string, TargetPerformanceMeasurementRecord>();
      for (const record of records) {
        const key = `${record.workload_key}\0${record.metric_key}`;
        const prior = byMetric.get(key);
        if (!prior || record.created_at_ms > prior.created_at_ms
          || (record.created_at_ms === prior.created_at_ms && record.measurement_id > prior.measurement_id)) {
          byMetric.set(key, record);
        }
      }
      return [...byMetric.values()];
    };
    const current = latest(this.authority.readTargetPerformanceMeasurements(state.goalId, phase)
      .filter((record) => currentAttemptIds.has(record.operation_id)));
    const baseline = latest([
      ...this.authority.readTargetPerformanceMeasurements(state.goalId, "BASELINE"),
      ...this.authority.readTargetPerformanceMeasurements(state.goalId, "BASELINE_PROFILE"),
    ]);
    const verdict = evaluatePerformancePhase({
      goalId: state.goalId, workCellId: cell.work_cell_id, contract, phase,
      measurements: current, baseline, createdAtMs: this.clock.now(),
    });
    this.authority.insertTargetPerformanceVerdict(verdict);
    return verdict;
  }

  private targetPreimage(normalized: NormalizedEffect, kind: OperationAttemptRecord["operation_kind"]): string {
    return ["WRITE", "EDIT", "DELETE"].includes(kind)
      ? this.adapter.hashTarget(normalized.normalizedTarget)
      : canonicalJsonSha256({ target: normalized.normalizedTargetSha256, kind });
  }

  private reconcileLocator(
    attempt: OperationAttemptRecord,
    normalized: NormalizedEffect,
    input: Readonly<Record<string, unknown>>,
    preimageSha256: string,
  ): OperationReconcileLocatorRecord {
    const targetRelative = relative(this.adapter.workspaceRoot(), normalized.normalizedTarget).replaceAll("\\", "/");
    if (!targetRelative || targetRelative.startsWith("../") || isAbsolute(targetRelative)) {
      throw new TypeError("Operation reconciliation target must be a workspace-relative file");
    }
    const expectedPostimageSha256 = this.expectedPostimage(attempt.operation_kind, input);
    return sealTaskFlowRecord<OperationReconcileLocatorRecord, "record_sha256">("PCH-OPERATION-RECONCILE-LOCATOR-V1", {
      schema_version: 1, locator_id: idFromSha256("LOCATOR", sha256Hex(`${attempt.attempt_id}\0${targetRelative}`)),
      attempt_id: attempt.attempt_id, goal_id: attempt.goal_id, target_relative: targetRelative,
      preimage_sha256: preimageSha256, expected_postimage_sha256: expectedPostimageSha256,
      created_at_ms: this.clock.now(),
    }, "record_sha256");
  }

  private expectedPostimage(
    kind: OperationAttemptRecord["operation_kind"],
    input: Readonly<Record<string, unknown>>,
  ): string | null {
    if (kind === "DELETE") return sha256Hex("PCH-ABSENT-V1");
    if (!["WRITE", "EDIT"].includes(kind)) return null;
    if (typeof input.content_sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.content_sha256)) return input.content_sha256;
    return typeof input.content === "string" ? sha256Hex(Buffer.from(input.content, "utf8")) : null;
  }

  private currentCell(state: TaskFlowOperationState): WorkCellRecord | null {
    const id = state.view.workCellId;
    return id ? state.view.route?.work_cells.find((cell) => cell.work_cell_id === id) ?? null : null;
  }

  private clearValidationProgress(cellId: string): void {
    this.passedValidationCommands.delete(cellId);
    this.passedValidationAttempts.delete(cellId);
  }

  private contained(root: string, candidate: string): boolean {
    const delta = relative(resolve(root), resolve(candidate));
    return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
  }

  private accept(result: CommandResult): void {
    this.adapter.accept(result);
  }

  private requiredState(): TaskFlowOperationState {
    const state = this.adapter.current();
    if (!state) throw new TypeError("No active Task Flow Goal");
    return state;
  }
}
