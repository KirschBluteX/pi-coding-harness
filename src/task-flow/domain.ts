import { canonicalJsonSha256 } from "../authority/canonical-json.js";

export type TaskFlowIntent = "PLAN" | "BUILD";
export type TaskFlowLane = "DIRECT_CELL" | "ADAPTIVE_ROUTE";
export type AuthorizationCeiling = "READ_ONLY" | "LOCAL_REVERSIBLE" | "EXTERNAL_IDEMPOTENT" | "IRREVERSIBLE_REQUIRES_USER";
export type WorkCellStatus = "PROPOSED" | "READY" | "RUNNING" | "WAITING_USER" | "REPAIRING" | "SUCCEEDED" | "INVALIDATED" | "FAILED";
export type OperationState = "PREPARED" | "DISPATCHED" | "OBSERVED" | "COMMITTED" | "FAILED" | "OUTCOME_UNKNOWN" | "RECONCILED";
export type RouteHealthLevel = "H0_CONTINUE" | "H1_RETRY" | "H2_REPAIR" | "H3_REFRAME" | "H4_ASK" | "H5_RECONCILE_OR_STOP";
export type EvidenceResult = "PASS" | "FAIL" | "UNKNOWN";

export interface ExecutionSubjectRef {
  readonly kind: "NONE" | "GOAL" | "WORK_CELL";
  readonly goalId: string | null;
  readonly subjectId: string | null;
  readonly routeRevision: number | null;
  readonly goalContractSha256: string | null;
  readonly executionAuthorizationSha256: string | null;
  readonly bindingSha256: string;
}

export interface TaskObligationRecord {
  readonly obligation_id: string;
  readonly contract_id: string;
  readonly goal_id: string;
  readonly semantic_key: string;
  readonly priority: "MUST" | "SHOULD" | "MAY";
  readonly statement: string;
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly dependencies: readonly string[];
  readonly ordinal: number;
  readonly record_sha256: string;
}

export interface GoalContractRecord {
  readonly schema_version: 1;
  readonly contract_id: string;
  readonly goal_id: string;
  readonly version: number;
  readonly parent_contract_id: string | null;
  readonly intent: TaskFlowIntent;
  /** Admission hint only. The current RouteSkeleton owns the executable lane. */
  readonly lane: TaskFlowLane;
  readonly objective: string;
  readonly user_outcomes: readonly string[];
  readonly scope: readonly string[];
  readonly non_goals: readonly string[];
  readonly constraints: readonly string[];
  readonly assumption_refs: readonly string[];
  readonly decision_refs: readonly string[];
  readonly obligations: readonly TaskObligationRecord[];
  readonly acceptance_policy: Readonly<Record<string, unknown>>;
  readonly authorization_ceiling: AuthorizationCeiling;
  readonly source_intake_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface RouteQualificationReceiptRecord {
  readonly schema_version: 1 | 2;
  readonly qualification_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly contract_sha256: string;
  readonly proposal_sha256: string;
  readonly admission_lane_hint: TaskFlowLane;
  readonly requested_lane: TaskFlowLane;
  readonly proposal_lane?: TaskFlowLane | null;
  readonly evidence_candidate_lane?: TaskFlowLane;
  readonly prior_selected_lane?: TaskFlowLane | null;
  readonly hysteresis_action?: "NONE" | "INITIAL_RECLASSIFY" | "PROMOTED" | "HELD_ADAPTIVE";
  readonly work_cell_count?: number;
  readonly selected_lane: TaskFlowLane;
  readonly bounded_scope: boolean;
  readonly oracle_known: boolean;
  readonly reversible: boolean;
  readonly material_decision_open: boolean;
  readonly migration_or_external_effect: boolean;
  readonly evidence_refs: readonly string[];
  readonly reason_codes: readonly string[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface RouteAssumptionRecord {
  readonly assumption_id: string;
  readonly key: string;
  readonly statement: string;
  readonly evidence_refs: readonly string[];
  readonly status: "SUPPORTED" | "OPEN" | "INVALIDATED";
  readonly record_sha256: string;
}

export interface RouteRiskRecord {
  readonly risk_id: string;
  readonly key: string;
  readonly statement: string;
  readonly likelihood: "LOW" | "MEDIUM" | "HIGH";
  readonly impact: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly mitigation: string;
  readonly evidence_refs: readonly string[];
  readonly record_sha256: string;
}

export interface RouteAlternativeRecord {
  readonly alternative_id: string;
  readonly key: string;
  readonly summary: string;
  readonly disposition: "SELECTED" | "RESERVE" | "REJECTED";
  readonly reason: string;
  readonly evidence_refs: readonly string[];
  readonly record_sha256: string;
}

export interface DeferredOutcomeRecord {
  readonly deferred_outcome_id: string;
  readonly key: string;
  readonly outcome: string;
  readonly obligation_ids: readonly string[];
  readonly dependencies: readonly string[];
  readonly expansion_trigger: "WORK_CELL_CLOSED" | "EVIDENCE_CHANGED" | "DECISION_RESOLVED";
  readonly commitment: "REVERSIBLE" | "EXPENSIVE_TO_REVERSE" | "USER_AUTHORITY_REQUIRED";
  readonly evidence_refs: readonly string[];
  readonly record_sha256: string;
}

export interface WorkCellRecord {
  readonly schema_version: 1;
  readonly work_cell_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly logical_key: string;
  readonly ordinal: number;
  readonly horizon: "CURRENT" | "NEAR" | "LATER";
  readonly outcome: string;
  readonly obligation_ids: readonly string[];
  readonly dependencies: readonly string[];
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly effect_classes: readonly AuthorizationCeiling[];
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reversible: boolean;
  readonly budget: Readonly<Record<string, unknown>>;
  readonly spec_sha256: string;
}

export interface RouteSkeletonRecord {
  readonly schema_version: 1 | 2;
  readonly route_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly revision: number;
  readonly parent_route_id: string | null;
  readonly lane: TaskFlowLane;
  readonly outcomes: readonly string[];
  readonly assumptions: readonly (Readonly<Record<string, unknown>> | RouteAssumptionRecord)[];
  readonly risks: readonly (Readonly<Record<string, unknown>> | RouteRiskRecord)[];
  readonly alternatives: readonly (Readonly<Record<string, unknown>> | RouteAlternativeRecord)[];
  readonly acceptance_coverage: Readonly<Record<string, readonly string[]>>;
  readonly work_cells: readonly WorkCellRecord[];
  readonly near_horizon: readonly string[];
  readonly qualification?: RouteQualificationReceiptRecord;
  readonly deferred_outcomes?: readonly DeferredOutcomeRecord[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface WorkspaceBaselineRecord {
  readonly schema_version: 1;
  readonly baseline_id: string;
  readonly workspace_id: string;
  readonly goal_id: string;
  readonly filesystem_identity_hmac: string;
  readonly content_root_sha256: string;
  readonly environment_sha256: string;
  readonly oracle_set_sha256: string;
  readonly scope_manifest: readonly Readonly<Record<string, unknown>>[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ExecutionAuthorizationRecord {
  readonly schema_version: 1;
  readonly authorization_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly work_cell_id: string;
  readonly baseline_id: string;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly effect_ceiling: AuthorizationCeiling;
  readonly decision_closure_sha256: string;
  readonly allowed_scope_sha256: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface OperationAttemptRecord {
  readonly schema_version: 1;
  readonly attempt_id: string;
  readonly operation_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly authorization_id: string;
  readonly attempt_number: number;
  readonly operation_kind: "READ" | "WRITE" | "EDIT" | "DELETE" | "MOVE" | "COMMAND" | "VALIDATION" | "EXTERNAL";
  readonly normalized_target_hmac: string;
  readonly normalized_payload_sha256: string;
  readonly execution_fingerprint_sha256: string;
  readonly baseline_sha256: string;
  readonly environment_sha256: string;
  readonly oracle_sha256: string;
  readonly idempotency_key_hmac: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface OperationReconcileLocatorRecord {
  readonly schema_version: 1;
  readonly locator_id: string;
  readonly attempt_id: string;
  readonly goal_id: string;
  readonly target_relative: string;
  readonly preimage_sha256: string;
  readonly expected_postimage_sha256: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface OperationTransitionRecord {
  readonly schema_version: 1;
  readonly transition_id: string;
  readonly attempt_id: string;
  readonly ordinal: number;
  readonly state: OperationState;
  readonly output_sha256: string | null;
  readonly readback_sha256: string | null;
  readonly failure_signature_sha256: string | null;
  readonly postcondition: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
  readonly predecessor_sha256: string | null;
  readonly created_at_ms: number;
  readonly transition_sha256: string;
}

export interface EvidenceAttestationRecord {
  readonly schema_version: 1;
  readonly attestation_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string | null;
  readonly operation_id: string | null;
  readonly obligation_id: string | null;
  readonly oracle_sha256: string;
  readonly input_closure_sha256: string;
  readonly output_sha256: string;
  readonly baseline_sha256: string;
  readonly environment_sha256: string;
  readonly result: EvidenceResult;
  readonly freshness: "CURRENT" | "STALE" | "UNKNOWN";
  readonly postcondition: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
  readonly artifact_id: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface RouteHealthRecord {
  readonly schema_version: 1;
  readonly health_id: string;
  readonly goal_id: string;
  readonly route_id: string;
  readonly work_cell_id: string | null;
  readonly trigger_sha256: string;
  readonly failure_signature_sha256: string | null;
  readonly occurrence: number;
  readonly level: RouteHealthLevel;
  readonly reason_code: string;
  readonly selected_route_id: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface TaskDecisionEntryRecord {
  readonly schema_version: 1;
  readonly decision_entry_id: string;
  readonly goal_id: string;
  readonly contract_id: string | null;
  readonly route_id: string | null;
  readonly decision_key: string;
  readonly authority_actor: "USER" | "RUNTIME";
  readonly materiality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reversible: boolean;
  readonly privacy_related: boolean;
  readonly question_hmac: string;
  readonly recommendation: Readonly<Record<string, unknown>>;
  readonly selection: Readonly<Record<string, unknown>> | null;
  readonly state: "OPEN" | "RESOLVED" | "EXPIRED" | "CANCELED" | "SUPERSEDED";
  readonly binding_sha256: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly record_sha256: string;
}

export interface DeliverableManifestRecord {
  readonly schema_version: 1;
  readonly deliverable_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly final_baseline_id: string;
  readonly obligation_closure_sha256: string;
  readonly evidence_root_sha256: string;
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly result: "SUCCEEDED" | "FAILED" | "CANCELED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

type UnknownRecord = Record<string, unknown>;
const idPattern = /^[A-Z][A-Z0-9_:-]{0,159}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const controlCharacters = new Set(Array.from({ length: 32 }, (_, index) => index === 9 || index === 10 || index === 13
  ? null : String.fromCharCode(index)).filter((entry): entry is string => entry !== null).concat(String.fromCharCode(127)));

function object(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are not the frozen contract`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} must be a bounded PCH ID`);
}

function nullableId(value: unknown, label: string): asserts value is string | null {
  if (value !== null) id(value, label);
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
}

function nullableSha(value: unknown, label: string): asserts value is string | null {
  if (value !== null) sha(value, label);
}

function text(value: unknown, label: string, maximum = 32768): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || [...value].some((entry) => controlCharacters.has(entry))) {
    throw new TypeError(`${label} must be bounded printable text`);
  }
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} must be a bounded integer`);
}

function strings(value: unknown, label: string, maximum = 4096): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded string array`);
  for (const [index, item] of value.entries()) text(item, `${label}[${index}]`, 4096);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${label} is outside the frozen enum`);
}

function verifyHash(domain: string, value: UnknownRecord, field: string): void {
  const expected = canonicalJsonSha256({ domain, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)) });
  if (value[field] !== expected) throw new TypeError(`${field} does not bind the canonical ${domain} record`);
}

export function sealTaskFlowRecord<T extends object, K extends keyof T & string>(domain: string, value: Omit<T, K>, field: K): T {
  const record = value as UnknownRecord;
  return { ...record, [field]: canonicalJsonSha256({ domain, ...record }) } as T;
}

export function assertExecutionSubjectRef(value: unknown): asserts value is ExecutionSubjectRef {
  const item = object(value, "ExecutionSubjectRef");
  exactKeys(item, ["kind", "goalId", "subjectId", "routeRevision", "goalContractSha256", "executionAuthorizationSha256", "bindingSha256"], "ExecutionSubjectRef");
  oneOf(item.kind, ["NONE", "GOAL", "WORK_CELL"] as const, "ExecutionSubjectRef.kind");
  nullableId(item.goalId, "ExecutionSubjectRef.goalId");
  nullableId(item.subjectId, "ExecutionSubjectRef.subjectId");
  if (item.routeRevision !== null) integer(item.routeRevision, "ExecutionSubjectRef.routeRevision", 1);
  nullableSha(item.goalContractSha256, "ExecutionSubjectRef.goalContractSha256");
  nullableSha(item.executionAuthorizationSha256, "ExecutionSubjectRef.executionAuthorizationSha256");
  sha(item.bindingSha256, "ExecutionSubjectRef.bindingSha256");
  if (item.kind === "NONE" && [item.goalId, item.subjectId, item.routeRevision, item.goalContractSha256, item.executionAuthorizationSha256].some((entry) => entry !== null)) throw new TypeError("NONE subject cannot carry an execution binding");
  if (item.kind === "GOAL" && (item.goalId === null || item.subjectId !== item.goalId || item.goalContractSha256 === null || item.executionAuthorizationSha256 !== null)) throw new TypeError("GOAL subject binding is incomplete");
  if (item.kind === "WORK_CELL" && (item.goalId === null || item.subjectId === null || item.routeRevision === null || item.goalContractSha256 === null || item.executionAuthorizationSha256 === null)) throw new TypeError("WORK_CELL subject binding is incomplete");
  verifyHash("PCH-EXECUTION-SUBJECT-V1", item, "bindingSha256");
}

function assertObligation(value: unknown, contractId: string, goalId: string, ordinal: number): asserts value is TaskObligationRecord {
  const item = object(value, "TaskObligation");
  exactKeys(item, ["obligation_id", "contract_id", "goal_id", "semantic_key", "priority", "statement", "oracle", "dependencies", "ordinal", "record_sha256"], "TaskObligation");
  id(item.obligation_id, "TaskObligation.obligation_id"); id(item.contract_id, "TaskObligation.contract_id"); id(item.goal_id, "TaskObligation.goal_id");
  if (item.contract_id !== contractId || item.goal_id !== goalId) throw new TypeError("TaskObligation parent substitution");
  text(item.semantic_key, "TaskObligation.semantic_key", 160); oneOf(item.priority, ["MUST", "SHOULD", "MAY"] as const, "TaskObligation.priority"); text(item.statement, "TaskObligation.statement"); object(item.oracle, "TaskObligation.oracle"); strings(item.dependencies, "TaskObligation.dependencies"); integer(item.ordinal, "TaskObligation.ordinal", 0, 4095); if (item.ordinal !== ordinal) throw new TypeError("TaskObligation ordinals must be contiguous"); sha(item.record_sha256, "TaskObligation.record_sha256"); verifyHash("PCH-TASK-OBLIGATION-V1", item, "record_sha256");
}

export function assertGoalContract(value: unknown): asserts value is GoalContractRecord {
  const item = object(value, "GoalContract");
  exactKeys(item, ["schema_version", "contract_id", "goal_id", "version", "parent_contract_id", "intent", "lane", "objective", "user_outcomes", "scope", "non_goals", "constraints", "assumption_refs", "decision_refs", "obligations", "acceptance_policy", "authorization_ceiling", "source_intake_sha256", "created_at_ms", "record_sha256"], "GoalContract");
  if (item.schema_version !== 1) throw new TypeError("GoalContract schema_version must be 1"); id(item.contract_id, "GoalContract.contract_id"); id(item.goal_id, "GoalContract.goal_id"); integer(item.version, "GoalContract.version", 1); nullableId(item.parent_contract_id, "GoalContract.parent_contract_id");
  if ((item.version === 1) !== (item.parent_contract_id === null)) throw new TypeError("GoalContract parent/version invariant failed");
  oneOf(item.intent, ["PLAN", "BUILD"] as const, "GoalContract.intent"); oneOf(item.lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "GoalContract.lane"); text(item.objective, "GoalContract.objective");
  strings(item.user_outcomes, "GoalContract.user_outcomes", 256); strings(item.scope, "GoalContract.scope", 256); strings(item.non_goals, "GoalContract.non_goals", 256); strings(item.constraints, "GoalContract.constraints", 512); strings(item.assumption_refs, "GoalContract.assumption_refs", 512); strings(item.decision_refs, "GoalContract.decision_refs", 512); object(item.acceptance_policy, "GoalContract.acceptance_policy");
  oneOf(item.authorization_ceiling, ["READ_ONLY", "LOCAL_REVERSIBLE", "EXTERNAL_IDEMPOTENT", "IRREVERSIBLE_REQUIRES_USER"] as const, "GoalContract.authorization_ceiling"); sha(item.source_intake_sha256, "GoalContract.source_intake_sha256"); integer(item.created_at_ms, "GoalContract.created_at_ms");
  if (!Array.isArray(item.obligations) || item.obligations.length === 0 || item.obligations.length > 4096) throw new TypeError("GoalContract obligations must be non-empty and bounded");
  const obligations = item.obligations as unknown[];
  const ids = new Set<string>(); const keys = new Set<string>(); let must = 0;
  for (let index = 0; index < obligations.length; index += 1) { const obligation = obligations[index]; assertObligation(obligation, item.contract_id, item.goal_id, index); if (ids.has(obligation.obligation_id) || keys.has(obligation.semantic_key)) throw new TypeError("GoalContract obligations must be unique"); ids.add(obligation.obligation_id); keys.add(obligation.semantic_key); if (obligation.priority === "MUST") must += 1; }
  if (must === 0) throw new TypeError("GoalContract requires at least one MUST obligation");
  for (const obligation of obligations) { assertObligation(obligation, item.contract_id, item.goal_id, Number((obligation as UnknownRecord).ordinal)); for (const dependency of obligation.dependencies) if (!ids.has(dependency)) throw new TypeError("TaskObligation dependency is unknown"); }
  sha(item.record_sha256, "GoalContract.record_sha256"); verifyHash("PCH-GOAL-CONTRACT-V1", item, "record_sha256");
}

function assertWorkCell(value: unknown, routeId: string, contract: GoalContractRecord, ordinal: number): asserts value is WorkCellRecord {
  const item = object(value, "WorkCell");
  exactKeys(item, ["schema_version", "work_cell_id", "goal_id", "contract_id", "route_id", "logical_key", "ordinal", "horizon", "outcome", "obligation_ids", "dependencies", "read_roots", "write_roots", "effect_classes", "oracle", "risk", "reversible", "budget", "spec_sha256"], "WorkCell");
  if (item.schema_version !== 1) throw new TypeError("WorkCell schema_version must be 1"); id(item.work_cell_id, "WorkCell.work_cell_id"); id(item.goal_id, "WorkCell.goal_id"); id(item.contract_id, "WorkCell.contract_id"); id(item.route_id, "WorkCell.route_id");
  if (item.goal_id !== contract.goal_id || item.contract_id !== contract.contract_id || item.route_id !== routeId) throw new TypeError("WorkCell parent substitution");
  text(item.logical_key, "WorkCell.logical_key", 160); integer(item.ordinal, "WorkCell.ordinal", 0, 4095); if (item.ordinal !== ordinal) throw new TypeError("WorkCell ordinals must be contiguous"); oneOf(item.horizon, ["CURRENT", "NEAR", "LATER"] as const, "WorkCell.horizon"); text(item.outcome, "WorkCell.outcome"); strings(item.obligation_ids, "WorkCell.obligation_ids"); strings(item.dependencies, "WorkCell.dependencies"); strings(item.read_roots, "WorkCell.read_roots"); strings(item.write_roots, "WorkCell.write_roots");
  if (!Array.isArray(item.effect_classes) || item.effect_classes.length === 0) throw new TypeError("WorkCell.effect_classes must be non-empty"); for (const effect of item.effect_classes) oneOf(effect, ["READ_ONLY", "LOCAL_REVERSIBLE", "EXTERNAL_IDEMPOTENT", "IRREVERSIBLE_REQUIRES_USER"] as const, "WorkCell.effect_classes"); object(item.oracle, "WorkCell.oracle"); oneOf(item.risk, ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const, "WorkCell.risk"); if (typeof item.reversible !== "boolean") throw new TypeError("WorkCell.reversible must be boolean"); object(item.budget, "WorkCell.budget");
  const obligationIds = new Set(contract.obligations.map((entry) => entry.obligation_id)); for (const obligationId of item.obligation_ids) if (!obligationIds.has(obligationId)) throw new TypeError("WorkCell covers an unknown obligation"); if (item.obligation_ids.length === 0) throw new TypeError("WorkCell must cover at least one obligation");
  sha(item.spec_sha256, "WorkCell.spec_sha256"); verifyHash("PCH-WORK-CELL-V1", item, "spec_sha256");
}

function assertRouteQualification(value: unknown, contract: GoalContractRecord): asserts value is RouteQualificationReceiptRecord {
  const item = object(value, "RouteQualificationReceipt");
  const v1Keys = ["schema_version", "qualification_id", "goal_id", "contract_id", "contract_sha256", "proposal_sha256", "admission_lane_hint", "requested_lane", "selected_lane", "bounded_scope", "oracle_known", "reversible", "material_decision_open", "migration_or_external_effect", "evidence_refs", "reason_codes", "created_at_ms", "record_sha256"];
  const v2Keys = [...v1Keys.slice(0, 8), "proposal_lane", "evidence_candidate_lane", "prior_selected_lane", "hysteresis_action", "work_cell_count", ...v1Keys.slice(8)];
  if (item.schema_version === 1) exactKeys(item, v1Keys, "RouteQualificationReceipt");
  else if (item.schema_version === 2) exactKeys(item, v2Keys, "RouteQualificationReceipt");
  else throw new TypeError("RouteQualificationReceipt schema_version must be 1 or 2");
  id(item.qualification_id, "RouteQualificationReceipt.qualification_id"); id(item.goal_id, "RouteQualificationReceipt.goal_id"); id(item.contract_id, "RouteQualificationReceipt.contract_id");
  if (item.goal_id !== contract.goal_id || item.contract_id !== contract.contract_id || item.contract_sha256 !== contract.record_sha256) throw new TypeError("RouteQualificationReceipt contract binding is invalid");
  sha(item.contract_sha256, "RouteQualificationReceipt.contract_sha256"); sha(item.proposal_sha256, "RouteQualificationReceipt.proposal_sha256");
  oneOf(item.admission_lane_hint, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.admission_lane_hint"); oneOf(item.requested_lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.requested_lane"); oneOf(item.selected_lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.selected_lane");
  if (item.admission_lane_hint !== contract.lane) throw new TypeError("RouteQualificationReceipt admission hint substitution");
  for (const key of ["bounded_scope", "oracle_known", "reversible", "material_decision_open", "migration_or_external_effect"] as const) if (typeof item[key] !== "boolean") throw new TypeError(`RouteQualificationReceipt.${key} must be boolean`);
  strings(item.evidence_refs, "RouteQualificationReceipt.evidence_refs", 256); strings(item.reason_codes, "RouteQualificationReceipt.reason_codes", 32); integer(item.created_at_ms, "RouteQualificationReceipt.created_at_ms");
  const directEligible = item.bounded_scope && item.oracle_known && item.reversible && !item.material_decision_open && !item.migration_or_external_effect;
  if (item.schema_version === 1) {
    if (item.selected_lane === "DIRECT_CELL" && (!directEligible || item.requested_lane !== "DIRECT_CELL")) throw new TypeError("RouteQualificationReceipt cannot select an unqualified DirectCell");
    sha(item.record_sha256, "RouteQualificationReceipt.record_sha256"); verifyHash("PCH-ROUTE-QUALIFICATION-V1", item, "record_sha256");
    return;
  }
  if (item.proposal_lane !== null) oneOf(item.proposal_lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.proposal_lane");
  oneOf(item.evidence_candidate_lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.evidence_candidate_lane");
  if (item.prior_selected_lane !== null) oneOf(item.prior_selected_lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteQualificationReceipt.prior_selected_lane");
  oneOf(item.hysteresis_action, ["NONE", "INITIAL_RECLASSIFY", "PROMOTED", "HELD_ADAPTIVE"] as const, "RouteQualificationReceipt.hysteresis_action");
  integer(item.work_cell_count, "RouteQualificationReceipt.work_cell_count", 1, 3);
  const expectedCandidate = directEligible && item.work_cell_count === 1 ? "DIRECT_CELL" : "ADAPTIVE_ROUTE";
  if (item.evidence_candidate_lane !== expectedCandidate) throw new TypeError("RouteQualificationReceipt evidence candidate is inconsistent");
  if (item.selected_lane === "DIRECT_CELL" && (item.evidence_candidate_lane !== "DIRECT_CELL"
    || item.proposal_lane === "ADAPTIVE_ROUTE" || item.prior_selected_lane === "ADAPTIVE_ROUTE")) {
    throw new TypeError("RouteQualificationReceipt cannot select DirectCell through an unsafe demotion");
  }
  const expectedAction = item.prior_selected_lane === "ADAPTIVE_ROUTE" && item.evidence_candidate_lane === "DIRECT_CELL"
    ? "HELD_ADAPTIVE"
    : item.prior_selected_lane === "DIRECT_CELL" && item.selected_lane === "ADAPTIVE_ROUTE"
      ? "PROMOTED"
      : item.prior_selected_lane === null && item.selected_lane !== item.admission_lane_hint
        ? "INITIAL_RECLASSIFY" : "NONE";
  if (item.hysteresis_action !== expectedAction) throw new TypeError("RouteQualificationReceipt hysteresis action is inconsistent");
  if (item.hysteresis_action === "HELD_ADAPTIVE" && item.selected_lane !== "ADAPTIVE_ROUTE") throw new TypeError("Held Adaptive route must remain Adaptive");
  sha(item.record_sha256, "RouteQualificationReceipt.record_sha256"); verifyHash("PCH-ROUTE-QUALIFICATION-V2", item, "record_sha256");
}

function assertTypedRouteEntry(value: unknown, kind: "ASSUMPTION" | "RISK" | "ALTERNATIVE"): void {
  const item = object(value, `Route${kind}`);
  if (kind === "ASSUMPTION") {
    exactKeys(item, ["assumption_id", "key", "statement", "evidence_refs", "status", "record_sha256"], "RouteAssumption");
    id(item.assumption_id, "RouteAssumption.assumption_id"); text(item.key, "RouteAssumption.key", 160); text(item.statement, "RouteAssumption.statement"); strings(item.evidence_refs, "RouteAssumption.evidence_refs", 256); oneOf(item.status, ["SUPPORTED", "OPEN", "INVALIDATED"] as const, "RouteAssumption.status"); sha(item.record_sha256, "RouteAssumption.record_sha256"); verifyHash("PCH-ROUTE-ASSUMPTION-V1", item, "record_sha256");
  } else if (kind === "RISK") {
    exactKeys(item, ["risk_id", "key", "statement", "likelihood", "impact", "mitigation", "evidence_refs", "record_sha256"], "RouteRisk");
    id(item.risk_id, "RouteRisk.risk_id"); text(item.key, "RouteRisk.key", 160); text(item.statement, "RouteRisk.statement"); oneOf(item.likelihood, ["LOW", "MEDIUM", "HIGH"] as const, "RouteRisk.likelihood"); oneOf(item.impact, ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const, "RouteRisk.impact"); text(item.mitigation, "RouteRisk.mitigation"); strings(item.evidence_refs, "RouteRisk.evidence_refs", 256); sha(item.record_sha256, "RouteRisk.record_sha256"); verifyHash("PCH-ROUTE-RISK-V1", item, "record_sha256");
  } else {
    exactKeys(item, ["alternative_id", "key", "summary", "disposition", "reason", "evidence_refs", "record_sha256"], "RouteAlternative");
    id(item.alternative_id, "RouteAlternative.alternative_id"); text(item.key, "RouteAlternative.key", 160); text(item.summary, "RouteAlternative.summary"); oneOf(item.disposition, ["SELECTED", "RESERVE", "REJECTED"] as const, "RouteAlternative.disposition"); text(item.reason, "RouteAlternative.reason"); strings(item.evidence_refs, "RouteAlternative.evidence_refs", 256); sha(item.record_sha256, "RouteAlternative.record_sha256"); verifyHash("PCH-ROUTE-ALTERNATIVE-V1", item, "record_sha256");
  }
}

function assertDeferredOutcome(value: unknown, routeId: string, contract: GoalContractRecord): asserts value is DeferredOutcomeRecord {
  const item = object(value, "DeferredOutcome");
  exactKeys(item, ["deferred_outcome_id", "key", "outcome", "obligation_ids", "dependencies", "expansion_trigger", "commitment", "evidence_refs", "record_sha256"], "DeferredOutcome");
  id(item.deferred_outcome_id, "DeferredOutcome.deferred_outcome_id"); text(item.key, "DeferredOutcome.key", 160); text(item.outcome, "DeferredOutcome.outcome"); strings(item.obligation_ids, "DeferredOutcome.obligation_ids"); strings(item.dependencies, "DeferredOutcome.dependencies"); oneOf(item.expansion_trigger, ["WORK_CELL_CLOSED", "EVIDENCE_CHANGED", "DECISION_RESOLVED"] as const, "DeferredOutcome.expansion_trigger"); oneOf(item.commitment, ["REVERSIBLE", "EXPENSIVE_TO_REVERSE", "USER_AUTHORITY_REQUIRED"] as const, "DeferredOutcome.commitment"); strings(item.evidence_refs, "DeferredOutcome.evidence_refs", 256);
  const obligations = new Set(contract.obligations.map((entry) => entry.obligation_id)); for (const obligationId of item.obligation_ids) if (!obligations.has(obligationId)) throw new TypeError("DeferredOutcome covers an unknown obligation"); if (item.obligation_ids.length === 0) throw new TypeError("DeferredOutcome must cover an obligation");
  sha(item.record_sha256, "DeferredOutcome.record_sha256"); verifyHash("PCH-DEFERRED-OUTCOME-V1", item, "record_sha256");
  if (!item.deferred_outcome_id.startsWith("DEFERRED")) throw new TypeError(`DeferredOutcome ${item.deferred_outcome_id} is invalid for route ${routeId}`);
}

export function assertRouteSkeleton(value: unknown, contract: GoalContractRecord): asserts value is RouteSkeletonRecord {
  const item = object(value, "RouteSkeleton");
  if (item.schema_version === 1) exactKeys(item, ["schema_version", "route_id", "goal_id", "contract_id", "revision", "parent_route_id", "lane", "outcomes", "assumptions", "risks", "alternatives", "acceptance_coverage", "work_cells", "near_horizon", "created_at_ms", "record_sha256"], "RouteSkeleton");
  else if (item.schema_version === 2) exactKeys(item, ["schema_version", "route_id", "goal_id", "contract_id", "revision", "parent_route_id", "lane", "outcomes", "assumptions", "risks", "alternatives", "acceptance_coverage", "work_cells", "near_horizon", "qualification", "deferred_outcomes", "created_at_ms", "record_sha256"], "RouteSkeleton");
  else throw new TypeError("RouteSkeleton schema_version must be 1 or 2");
  id(item.route_id, "RouteSkeleton.route_id"); id(item.goal_id, "RouteSkeleton.goal_id"); id(item.contract_id, "RouteSkeleton.contract_id"); if (item.goal_id !== contract.goal_id || item.contract_id !== contract.contract_id) throw new TypeError("RouteSkeleton contract substitution"); integer(item.revision, "RouteSkeleton.revision", 1); nullableId(item.parent_route_id, "RouteSkeleton.parent_route_id"); if ((item.revision === 1) !== (item.parent_route_id === null)) throw new TypeError("RouteSkeleton parent/revision invariant failed"); oneOf(item.lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"] as const, "RouteSkeleton.lane"); if (item.schema_version === 1 && item.lane !== contract.lane) throw new TypeError("Legacy RouteSkeleton lane differs from GoalContract"); strings(item.outcomes, "RouteSkeleton.outcomes", 256); if (!Array.isArray(item.assumptions) || !Array.isArray(item.risks) || !Array.isArray(item.alternatives)) throw new TypeError("RouteSkeleton structured arrays are invalid"); object(item.acceptance_coverage, "RouteSkeleton.acceptance_coverage"); strings(item.near_horizon, "RouteSkeleton.near_horizon", 3); integer(item.created_at_ms, "RouteSkeleton.created_at_ms");
  const routeId = item.route_id;
  const maximumCells = item.schema_version === 2 ? 3 : 4096;
  if (!Array.isArray(item.work_cells) || item.work_cells.length === 0 || item.work_cells.length > maximumCells) throw new TypeError("RouteSkeleton work_cells must be non-empty and bounded");
  const workCells = item.work_cells as unknown[];
  const cellIds = new Set<string>(); for (let index = 0; index < workCells.length; index += 1) { const cell = workCells[index]; assertWorkCell(cell, routeId, contract, index); if (cellIds.has(cell.work_cell_id)) throw new TypeError("RouteSkeleton WorkCell IDs must be unique"); cellIds.add(cell.work_cell_id); }
  for (const cell of workCells) { assertWorkCell(cell, routeId, contract, Number((cell as UnknownRecord).ordinal)); for (const dependency of cell.dependencies) if (!cellIds.has(dependency) || dependency === cell.work_cell_id) throw new TypeError("WorkCell dependency is invalid"); }
  for (const current of item.near_horizon) if (!cellIds.has(current)) throw new TypeError("NearHorizon references an unknown WorkCell");
  const coverageSubjects = new Set(cellIds);
  if (item.schema_version === 2) {
    assertRouteQualification(item.qualification, contract); if (item.qualification.selected_lane !== item.lane) throw new TypeError("RouteSkeleton lane differs from qualification receipt");
    for (const assumption of item.assumptions) assertTypedRouteEntry(assumption, "ASSUMPTION"); for (const risk of item.risks) assertTypedRouteEntry(risk, "RISK"); for (const alternative of item.alternatives) assertTypedRouteEntry(alternative, "ALTERNATIVE");
    if (!Array.isArray(item.deferred_outcomes) || item.deferred_outcomes.length > 256) throw new TypeError("RouteSkeleton deferred outcomes are invalid");
    for (const deferred of item.deferred_outcomes) { assertDeferredOutcome(deferred, routeId, contract); if (coverageSubjects.has(deferred.deferred_outcome_id)) throw new TypeError("RouteSkeleton subject IDs must be unique"); coverageSubjects.add(deferred.deferred_outcome_id); }
    const nearHorizon = item.near_horizon;
    const typedWorkCells = workCells as WorkCellRecord[];
    if (nearHorizon.length !== typedWorkCells.length || typedWorkCells.some((cell) => !nearHorizon.includes(cell.work_cell_id))) throw new TypeError("RouteSkeleton v2 must expose every admitted WorkCell in NearHorizon");
    if (item.lane === "DIRECT_CELL" && (workCells.length !== 1 || item.deferred_outcomes.length !== 0)) throw new TypeError("DirectCell requires one WorkCell and no deferred outcome");
  } else if (item.lane === "DIRECT_CELL" && (item.work_cells.length !== 1 || item.near_horizon.length !== 1)) throw new TypeError("DirectCell requires exactly one current WorkCell");
  const coverage = item.acceptance_coverage as Record<string, unknown>; for (const [obligationId, subjects] of Object.entries(coverage)) { id(obligationId, "RouteSkeleton acceptance obligation"); strings(subjects, `RouteSkeleton acceptance coverage ${obligationId}`); for (const subject of subjects) if (!coverageSubjects.has(subject)) throw new TypeError("RouteSkeleton acceptance coverage references an unknown subject"); }
  const must = contract.obligations.filter((entry) => entry.priority === "MUST").map((entry) => entry.obligation_id); const covered = new Set<string>([...workCells.flatMap((entry) => { assertWorkCell(entry, routeId, contract, Number((entry as UnknownRecord).ordinal)); return [...entry.obligation_ids]; }), ...(item.schema_version === 2 ? (item.deferred_outcomes as DeferredOutcomeRecord[]).flatMap((entry) => [...entry.obligation_ids]) : [])]); for (const obligationId of must) if (!covered.has(obligationId)) throw new TypeError("RouteSkeleton does not cover every MUST obligation");
  sha(item.record_sha256, "RouteSkeleton.record_sha256"); verifyHash(item.schema_version === 2 ? "PCH-ROUTE-SKELETON-V2" : "PCH-ROUTE-SKELETON-V1", item, "record_sha256");
}

export function assertOperationAttempt(value: unknown): asserts value is OperationAttemptRecord {
  const item = object(value, "OperationAttempt");
  exactKeys(item, ["schema_version", "attempt_id", "operation_id", "goal_id", "work_cell_id", "authorization_id", "attempt_number", "operation_kind", "normalized_target_hmac", "normalized_payload_sha256", "execution_fingerprint_sha256", "baseline_sha256", "environment_sha256", "oracle_sha256", "idempotency_key_hmac", "created_at_ms", "record_sha256"], "OperationAttempt");
  if (item.schema_version !== 1) throw new TypeError("OperationAttempt schema_version must be 1"); for (const key of ["attempt_id", "operation_id", "goal_id", "work_cell_id", "authorization_id"] as const) id(item[key], `OperationAttempt.${key}`); integer(item.attempt_number, "OperationAttempt.attempt_number", 1); oneOf(item.operation_kind, ["READ", "WRITE", "EDIT", "DELETE", "MOVE", "COMMAND", "VALIDATION", "EXTERNAL"] as const, "OperationAttempt.operation_kind"); for (const key of ["normalized_target_hmac", "normalized_payload_sha256", "execution_fingerprint_sha256", "baseline_sha256", "environment_sha256", "oracle_sha256", "idempotency_key_hmac"] as const) sha(item[key], `OperationAttempt.${key}`); integer(item.created_at_ms, "OperationAttempt.created_at_ms"); sha(item.record_sha256, "OperationAttempt.record_sha256"); verifyHash("PCH-OPERATION-ATTEMPT-V1", item, "record_sha256");
}

export function assertOperationReconcileLocator(value: unknown): asserts value is OperationReconcileLocatorRecord {
  const item = object(value, "OperationReconcileLocator");
  exactKeys(item, ["schema_version", "locator_id", "attempt_id", "goal_id", "target_relative", "preimage_sha256", "expected_postimage_sha256", "created_at_ms", "record_sha256"], "OperationReconcileLocator");
  if (item.schema_version !== 1) throw new TypeError("OperationReconcileLocator schema_version must be 1");
  id(item.locator_id, "OperationReconcileLocator.locator_id"); id(item.attempt_id, "OperationReconcileLocator.attempt_id"); id(item.goal_id, "OperationReconcileLocator.goal_id");
  text(item.target_relative, "OperationReconcileLocator.target_relative", 4096);
  if (/^(?:[A-Za-z]:[\\/]|[\\/])|(?:^|\/)\.\.(?:\/|$)/u.test(item.target_relative)) throw new TypeError("OperationReconcileLocator target must be workspace-relative");
  sha(item.preimage_sha256, "OperationReconcileLocator.preimage_sha256"); nullableSha(item.expected_postimage_sha256, "OperationReconcileLocator.expected_postimage_sha256");
  integer(item.created_at_ms, "OperationReconcileLocator.created_at_ms"); sha(item.record_sha256, "OperationReconcileLocator.record_sha256");
  verifyHash("PCH-OPERATION-RECONCILE-LOCATOR-V1", item, "record_sha256");
}

export function assertOperationTransition(value: unknown): asserts value is OperationTransitionRecord {
  const item = object(value, "OperationTransition");
  exactKeys(item, ["schema_version", "transition_id", "attempt_id", "ordinal", "state", "output_sha256", "readback_sha256", "failure_signature_sha256", "postcondition", "predecessor_sha256", "created_at_ms", "transition_sha256"], "OperationTransition");
  if (item.schema_version !== 1) throw new TypeError("OperationTransition schema_version must be 1"); id(item.transition_id, "OperationTransition.transition_id"); id(item.attempt_id, "OperationTransition.attempt_id"); integer(item.ordinal, "OperationTransition.ordinal", 0, 32); oneOf(item.state, ["PREPARED", "DISPATCHED", "OBSERVED", "COMMITTED", "FAILED", "OUTCOME_UNKNOWN", "RECONCILED"] as const, "OperationTransition.state"); nullableSha(item.output_sha256, "OperationTransition.output_sha256"); nullableSha(item.readback_sha256, "OperationTransition.readback_sha256"); nullableSha(item.failure_signature_sha256, "OperationTransition.failure_signature_sha256"); oneOf(item.postcondition, ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"] as const, "OperationTransition.postcondition"); nullableSha(item.predecessor_sha256, "OperationTransition.predecessor_sha256"); if ((item.ordinal === 0) !== (item.predecessor_sha256 === null) || (item.ordinal === 0 && item.state !== "PREPARED")) throw new TypeError("OperationTransition predecessor invariant failed"); integer(item.created_at_ms, "OperationTransition.created_at_ms"); sha(item.transition_sha256, "OperationTransition.transition_sha256"); verifyHash("PCH-OPERATION-TRANSITION-V1", item, "transition_sha256");
}

export function assertEvidenceAttestation(value: unknown): asserts value is EvidenceAttestationRecord {
  const item = object(value, "EvidenceAttestation");
  exactKeys(item, ["schema_version", "attestation_id", "goal_id", "work_cell_id", "operation_id", "obligation_id", "oracle_sha256", "input_closure_sha256", "output_sha256", "baseline_sha256", "environment_sha256", "result", "freshness", "postcondition", "artifact_id", "created_at_ms", "record_sha256"], "EvidenceAttestation");
  if (item.schema_version !== 1) throw new TypeError("EvidenceAttestation schema_version must be 1"); id(item.attestation_id, "EvidenceAttestation.attestation_id"); id(item.goal_id, "EvidenceAttestation.goal_id"); nullableId(item.work_cell_id, "EvidenceAttestation.work_cell_id"); nullableId(item.operation_id, "EvidenceAttestation.operation_id"); nullableId(item.obligation_id, "EvidenceAttestation.obligation_id"); for (const key of ["oracle_sha256", "input_closure_sha256", "output_sha256", "baseline_sha256", "environment_sha256"] as const) sha(item[key], `EvidenceAttestation.${key}`); oneOf(item.result, ["PASS", "FAIL", "UNKNOWN"] as const, "EvidenceAttestation.result"); oneOf(item.freshness, ["CURRENT", "STALE", "UNKNOWN"] as const, "EvidenceAttestation.freshness"); oneOf(item.postcondition, ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"] as const, "EvidenceAttestation.postcondition"); nullableId(item.artifact_id, "EvidenceAttestation.artifact_id"); integer(item.created_at_ms, "EvidenceAttestation.created_at_ms"); sha(item.record_sha256, "EvidenceAttestation.record_sha256"); verifyHash("PCH-EVIDENCE-ATTESTATION-V1", item, "record_sha256");
}

export function assertRouteHealth(value: unknown): asserts value is RouteHealthRecord {
  const item = object(value, "RouteHealth");
  exactKeys(item, ["schema_version", "health_id", "goal_id", "route_id", "work_cell_id", "trigger_sha256", "failure_signature_sha256", "occurrence", "level", "reason_code", "selected_route_id", "created_at_ms", "record_sha256"], "RouteHealth");
  if (item.schema_version !== 1) throw new TypeError("RouteHealth schema_version must be 1"); for (const key of ["health_id", "goal_id", "route_id"] as const) id(item[key], `RouteHealth.${key}`); nullableId(item.work_cell_id, "RouteHealth.work_cell_id"); sha(item.trigger_sha256, "RouteHealth.trigger_sha256"); nullableSha(item.failure_signature_sha256, "RouteHealth.failure_signature_sha256"); integer(item.occurrence, "RouteHealth.occurrence"); oneOf(item.level, ["H0_CONTINUE", "H1_RETRY", "H2_REPAIR", "H3_REFRAME", "H4_ASK", "H5_RECONCILE_OR_STOP"] as const, "RouteHealth.level"); text(item.reason_code, "RouteHealth.reason_code", 160); nullableId(item.selected_route_id, "RouteHealth.selected_route_id"); integer(item.created_at_ms, "RouteHealth.created_at_ms"); sha(item.record_sha256, "RouteHealth.record_sha256"); verifyHash("PCH-ROUTE-HEALTH-V1", item, "record_sha256");
}

export function assertTaskDecisionEntry(value: unknown): asserts value is TaskDecisionEntryRecord {
  const item = object(value, "TaskDecisionEntry");
  exactKeys(item, ["schema_version", "decision_entry_id", "goal_id", "contract_id", "route_id", "decision_key", "authority_actor", "materiality", "reversible", "privacy_related", "question_hmac", "recommendation", "selection", "state", "binding_sha256", "created_at_ms", "expires_at_ms", "record_sha256"], "TaskDecisionEntry");
  if (item.schema_version !== 1) throw new TypeError("TaskDecisionEntry schema_version must be 1");
  id(item.decision_entry_id, "TaskDecisionEntry.decision_entry_id"); id(item.goal_id, "TaskDecisionEntry.goal_id"); nullableId(item.contract_id, "TaskDecisionEntry.contract_id"); nullableId(item.route_id, "TaskDecisionEntry.route_id");
  text(item.decision_key, "TaskDecisionEntry.decision_key", 160); oneOf(item.authority_actor, ["USER", "RUNTIME"] as const, "TaskDecisionEntry.authority_actor"); oneOf(item.materiality, ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const, "TaskDecisionEntry.materiality");
  if (typeof item.reversible !== "boolean" || typeof item.privacy_related !== "boolean") throw new TypeError("TaskDecisionEntry flags must be boolean");
  sha(item.question_hmac, "TaskDecisionEntry.question_hmac"); object(item.recommendation, "TaskDecisionEntry.recommendation"); if (item.selection !== null) object(item.selection, "TaskDecisionEntry.selection"); oneOf(item.state, ["OPEN", "RESOLVED", "EXPIRED", "CANCELED", "SUPERSEDED"] as const, "TaskDecisionEntry.state");
  if ((item.state === "RESOLVED") !== (item.selection !== null)) throw new TypeError("Resolved TaskDecisionEntry must have exactly one selection");
  sha(item.binding_sha256, "TaskDecisionEntry.binding_sha256"); integer(item.created_at_ms, "TaskDecisionEntry.created_at_ms"); if (item.expires_at_ms !== null) integer(item.expires_at_ms, "TaskDecisionEntry.expires_at_ms", item.created_at_ms + 1);
  sha(item.record_sha256, "TaskDecisionEntry.record_sha256"); verifyHash("PCH-TASK-DECISION-V1", item, "record_sha256");
}

export function makeExecutionSubjectRef(input: Omit<ExecutionSubjectRef, "bindingSha256">): ExecutionSubjectRef {
  return { ...input, bindingSha256: canonicalJsonSha256({ domain: "PCH-EXECUTION-SUBJECT-V1", ...input }) };
}
