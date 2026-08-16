import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { assertAcceptanceFacetProposalsV2 } from "../acceptance-v2/finalize.js";
import type { AcceptanceFacetProposalV2 } from "../acceptance-v2/domain.js";
import type { GoalFitAssessmentProposalV2 } from "../intake-v2/domain.js";
import { normalizeGoalFitAssessmentProposalV2 } from "../intake-v2/finalize.js";
import { mayUseDirectCell } from "./admission.js";
import {
  assertTargetPerformanceRoute,
  bindTargetPerformanceBudget,
  normalizeTargetPerformanceAcceptancePolicy,
} from "../performance/task-flow-policy.js";
import { assertExecutableOracle, assertWorkCellOracleCoverage, oracleCommands } from "./oracles.js";
import {
  assertGoalContract,
  assertRouteSkeleton,
  sealTaskFlowRecord,
  type AuthorizationCeiling,
  type DeferredOutcomeRecord,
  type GoalContractRecord,
  type RouteAlternativeRecord,
  type RouteAssumptionRecord,
  type RouteQualificationReceiptRecord,
  type RouteRiskRecord,
  type RouteSkeletonRecord,
  type TaskFlowLane,
  type TaskObligationRecord,
  type WorkCellRecord,
} from "./domain.js";

export interface ObligationProposal {
  readonly key: string;
  readonly priority: "MUST" | "SHOULD" | "MAY";
  readonly statement: string;
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly dependencies?: readonly string[];
}

export interface GoalContractProposal {
  readonly user_outcomes: readonly string[];
  readonly scope: readonly string[];
  readonly non_goals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly assumption_refs?: readonly string[];
  readonly decision_refs?: readonly string[];
  readonly obligations: readonly ObligationProposal[];
  readonly acceptance_policy?: Readonly<Record<string, unknown>>;
  readonly authorization_ceiling: AuthorizationCeiling;
}

export interface GoalContractAuthorityProposalV2 extends GoalContractProposal {
  readonly acceptance_facets: readonly AcceptanceFacetProposalV2[];
  readonly goal_fit_assessment: GoalFitAssessmentProposalV2;
}

export interface WorkCellProposal {
  readonly key: string;
  readonly outcome: string;
  readonly obligation_keys: readonly string[];
  readonly dependencies?: readonly string[];
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly effect_classes: readonly AuthorizationCeiling[];
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reversible: boolean;
  readonly budget?: Readonly<Record<string, unknown>>;
}

export interface RouteAssumptionProposal {
  readonly key: string;
  readonly statement: string;
  readonly evidence_refs?: readonly string[];
  readonly status: "SUPPORTED" | "OPEN" | "INVALIDATED";
}

export interface RouteRiskProposal {
  readonly key: string;
  readonly statement: string;
  readonly likelihood: "LOW" | "MEDIUM" | "HIGH";
  readonly impact: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly mitigation: string;
  readonly evidence_refs?: readonly string[];
}

export interface RouteAlternativeProposal {
  readonly key: string;
  readonly summary: string;
  readonly disposition: "SELECTED" | "RESERVE" | "REJECTED";
  readonly reason: string;
  readonly evidence_refs?: readonly string[];
}

export interface DeferredOutcomeProposal {
  readonly key: string;
  readonly outcome: string;
  readonly obligation_keys: readonly string[];
  readonly dependencies?: readonly string[];
  readonly expansion_trigger: "WORK_CELL_CLOSED" | "EVIDENCE_CHANGED" | "DECISION_RESOLVED";
  readonly commitment: "REVERSIBLE" | "EXPENSIVE_TO_REVERSE" | "USER_AUTHORITY_REQUIRED";
  readonly evidence_refs?: readonly string[];
}

export interface RouteProposal {
  readonly lane?: TaskFlowLane;
  readonly outcomes: readonly string[];
  readonly assumptions?: readonly RouteAssumptionProposal[];
  readonly risks?: readonly RouteRiskProposal[];
  readonly alternatives?: readonly RouteAlternativeProposal[];
  readonly work_cells: readonly WorkCellProposal[];
  readonly near_horizon?: readonly string[];
  readonly deferred_outcomes?: readonly DeferredOutcomeProposal[];
}

export interface RouteAuthorityProposalV2 extends RouteProposal {
  readonly goal_fit_assessment: GoalFitAssessmentProposalV2;
}

const authorizationCeilings = ["READ_ONLY", "LOCAL_REVERSIBLE", "EXTERNAL_IDEMPOTENT", "IRREVERSIBLE_REQUIRES_USER"] as const;

function proposalRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function proposalExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label}.${unexpected[0]} is not allowed; use only ${allowed.join(", ")}`);
  }
}

function proposalString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function proposalStringArray(value: unknown, label: string, optional = false): void {
  if (value === undefined && optional) return;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  value.forEach((entry, index) => proposalString(entry, `${label}[${index}]`));
}

function proposalRecordArray(value: unknown, label: string, optional = false): Record<string, unknown>[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => proposalRecord(entry, `${label}[${index}]`));
}

function proposalEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new TypeError(`${label} must be one of ${allowed.join(", ")}`);
}

function assertGoalContractProposalShape(value: unknown): asserts value is GoalContractProposal {
  const proposal = proposalRecord(value, "GoalContract proposal");
  proposalExactKeys(proposal, [
    "user_outcomes", "scope", "non_goals", "constraints", "assumption_refs", "decision_refs",
    "obligations", "acceptance_policy", "authorization_ceiling",
  ], "GoalContract proposal");
  proposalStringArray(proposal.user_outcomes, "GoalContract proposal.user_outcomes");
  proposalStringArray(proposal.scope, "GoalContract proposal.scope");
  for (const key of ["non_goals", "constraints", "assumption_refs", "decision_refs"] as const) {
    proposalStringArray(proposal[key], `GoalContract proposal.${key}`, true);
  }
  if (proposal.acceptance_policy !== undefined) proposalRecord(proposal.acceptance_policy, "GoalContract proposal.acceptance_policy");
  proposalEnum(proposal.authorization_ceiling, authorizationCeilings, "GoalContract proposal.authorization_ceiling");
  const obligations = proposalRecordArray(proposal.obligations, "GoalContract proposal.obligations");
  obligations.forEach((entry, index) => {
    const label = `GoalContract proposal.obligations[${index}]`;
    proposalExactKeys(entry, ["key", "priority", "statement", "oracle", "dependencies"], label);
    proposalString(entry.key, `${label}.key`);
    proposalEnum(entry.priority, ["MUST", "SHOULD", "MAY"], `${label}.priority`);
    proposalString(entry.statement, `${label}.statement`);
    proposalRecord(entry.oracle, `${label}.oracle`);
    proposalStringArray(entry.dependencies, `${label}.dependencies`, true);
  });
}

export function splitGoalContractAuthorityProposalV2(value: unknown): {
  readonly contract: GoalContractProposal;
  readonly acceptanceFacets: readonly AcceptanceFacetProposalV2[];
  readonly goalFitAssessment: GoalFitAssessmentProposalV2;
} {
  const proposal = proposalRecord(value, "GoalContract Authority V2 proposal");
  proposalExactKeys(proposal, [
    "user_outcomes", "acceptance_facets", "scope", "non_goals", "constraints", "assumption_refs", "decision_refs",
    "obligations", "acceptance_policy", "authorization_ceiling", "goal_fit_assessment",
  ], "GoalContract Authority V2 proposal");
  assertAcceptanceFacetProposalsV2(proposal.acceptance_facets);
  const goalFitAssessment = normalizeGoalFitAssessmentProposalV2(proposal.goal_fit_assessment);
  const { acceptance_facets: acceptanceFacets, goal_fit_assessment: _goalFitAssessment, ...contract } = proposal;
  void _goalFitAssessment;
  assertGoalContractProposalShape(contract);
  return {
    contract,
    acceptanceFacets,
    goalFitAssessment,
  };
}

export function splitRouteAuthorityProposalV2(value: unknown): {
  readonly route: RouteProposal;
  readonly goalFitAssessment: GoalFitAssessmentProposalV2;
} {
  const proposal = proposalRecord(value, "Route Authority V2 proposal");
  proposalExactKeys(proposal, [
    "lane", "outcomes", "assumptions", "risks", "alternatives", "work_cells", "near_horizon",
    "deferred_outcomes", "goal_fit_assessment",
  ], "Route Authority V2 proposal");
  const goalFitAssessment = normalizeGoalFitAssessmentProposalV2(proposal.goal_fit_assessment);
  const { goal_fit_assessment: _goalFitAssessment, ...route } = proposal;
  void _goalFitAssessment;
  assertRouteProposalShape(route);
  return { route, goalFitAssessment };
}

function assertRouteProposalShape(value: unknown): asserts value is RouteProposal {
  const proposal = proposalRecord(value, "Route proposal");
  proposalExactKeys(proposal, [
    "lane", "outcomes", "assumptions", "risks", "alternatives", "work_cells", "near_horizon", "deferred_outcomes",
  ], "Route proposal");
  if (proposal.lane !== undefined) proposalEnum(proposal.lane, ["DIRECT_CELL", "ADAPTIVE_ROUTE"], "Route proposal.lane");
  proposalStringArray(proposal.outcomes, "Route proposal.outcomes");
  proposalStringArray(proposal.near_horizon, "Route proposal.near_horizon", true);
  const cells = proposalRecordArray(proposal.work_cells, "Route proposal.work_cells");
  cells.forEach((entry, index) => {
    const label = `Route proposal.work_cells[${index}]`;
    proposalExactKeys(entry, [
      "key", "outcome", "obligation_keys", "dependencies", "read_roots", "write_roots",
      "effect_classes", "oracle", "risk", "reversible", "budget",
    ], label);
    proposalString(entry.key, `${label}.key`); proposalString(entry.outcome, `${label}.outcome`);
    proposalStringArray(entry.obligation_keys, `${label}.obligation_keys`);
    proposalStringArray(entry.dependencies, `${label}.dependencies`, true);
    proposalStringArray(entry.read_roots, `${label}.read_roots`);
    proposalStringArray(entry.write_roots, `${label}.write_roots`);
    if (!Array.isArray(entry.effect_classes)) throw new TypeError(`${label}.effect_classes must be an array`);
    entry.effect_classes.forEach((effect, effectIndex) => proposalEnum(effect, authorizationCeilings, `${label}.effect_classes[${effectIndex}]`));
    proposalRecord(entry.oracle, `${label}.oracle`);
    proposalEnum(entry.risk, ["LOW", "MEDIUM", "HIGH", "CRITICAL"], `${label}.risk`);
    if (typeof entry.reversible !== "boolean") throw new TypeError(`${label}.reversible must be a boolean`);
    if (entry.budget !== undefined) proposalRecord(entry.budget, `${label}.budget`);
  });
  proposalRecordArray(proposal.assumptions, "Route proposal.assumptions", true).forEach((entry, index) => {
    const label = `Route proposal.assumptions[${index}]`;
    proposalExactKeys(entry, ["key", "statement", "status", "evidence_refs"], label);
    proposalString(entry.key, `${label}.key`); proposalString(entry.statement, `${label}.statement`);
    proposalEnum(entry.status, ["SUPPORTED", "OPEN", "INVALIDATED"], `${label}.status`);
    proposalStringArray(entry.evidence_refs, `${label}.evidence_refs`, true);
  });
  proposalRecordArray(proposal.risks, "Route proposal.risks", true).forEach((entry, index) => {
    const label = `Route proposal.risks[${index}]`;
    proposalExactKeys(entry, ["key", "statement", "likelihood", "impact", "mitigation", "evidence_refs"], label);
    proposalString(entry.key, `${label}.key`); proposalString(entry.statement, `${label}.statement`);
    proposalEnum(entry.likelihood, ["LOW", "MEDIUM", "HIGH"], `${label}.likelihood`);
    proposalEnum(entry.impact, ["LOW", "MEDIUM", "HIGH", "CRITICAL"], `${label}.impact`);
    proposalString(entry.mitigation, `${label}.mitigation`);
    proposalStringArray(entry.evidence_refs, `${label}.evidence_refs`, true);
  });
  proposalRecordArray(proposal.alternatives, "Route proposal.alternatives", true).forEach((entry, index) => {
    const label = `Route proposal.alternatives[${index}]`;
    proposalExactKeys(entry, ["key", "summary", "disposition", "reason", "evidence_refs"], label);
    proposalString(entry.key, `${label}.key`); proposalString(entry.summary, `${label}.summary`);
    proposalEnum(entry.disposition, ["SELECTED", "RESERVE", "REJECTED"], `${label}.disposition`);
    proposalString(entry.reason, `${label}.reason`);
    proposalStringArray(entry.evidence_refs, `${label}.evidence_refs`, true);
  });
  proposalRecordArray(proposal.deferred_outcomes, "Route proposal.deferred_outcomes", true).forEach((entry, index) => {
    const label = `Route proposal.deferred_outcomes[${index}]`;
    proposalExactKeys(entry, [
      "key", "outcome", "obligation_keys", "dependencies", "expansion_trigger", "commitment", "evidence_refs",
    ], label);
    proposalString(entry.key, `${label}.key`); proposalString(entry.outcome, `${label}.outcome`);
    proposalStringArray(entry.obligation_keys, `${label}.obligation_keys`);
    proposalStringArray(entry.dependencies, `${label}.dependencies`, true);
    proposalEnum(entry.expansion_trigger, ["WORK_CELL_CLOSED", "EVIDENCE_CHANGED", "DECISION_RESOLVED"], `${label}.expansion_trigger`);
    proposalEnum(entry.commitment, ["REVERSIBLE", "EXPENSIVE_TO_REVERSE", "USER_AUTHORITY_REQUIRED"], `${label}.commitment`);
    proposalStringArray(entry.evidence_refs, `${label}.evidence_refs`, true);
  });
}

function normalizedText(value: string, label: string, maximum = 32_768): string {
  const text = value.normalize("NFC").trim();
  const forbiddenControl = [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (!text || text.length > maximum || forbiddenControl) {
    throw new TypeError(`${label} must be bounded printable text`);
  }
  return text;
}

function normalizedList(values: readonly string[] | undefined, label: string, maximum = 256): string[] {
  if (!values) return [];
  if (values.length > maximum) throw new TypeError(`${label} exceeds its bound`);
  const result = values.map((value, index) => normalizedText(value, `${label}[${index}]`, 4_096));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function normalizedKey(value: string, label: string): string {
  const key = normalizedText(value, label, 160);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(key)) throw new TypeError(`${label} is not a stable semantic key`);
  return key;
}

function derivedId(prefix: string, ...parts: readonly unknown[]): string {
  return idFromSha256(prefix, sha256Hex(canonicalJsonSha256(parts)));
}

function effectRank(value: AuthorizationCeiling): number {
  return value === "READ_ONLY" ? 0 : value === "LOCAL_REVERSIBLE" ? 1 : value === "EXTERNAL_IDEMPOTENT" ? 2 : 3;
}

function ensureAcyclic(entries: readonly { readonly key: string; readonly dependencies: readonly string[] }[]): void {
  const dependencies = new Map(entries.map((entry) => [entry.key, entry.dependencies]));
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (key: string): void => {
    if (complete.has(key)) return;
    if (active.has(key)) throw new TypeError(`Dependency cycle reaches ${key}`);
    active.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (!dependencies.has(dependency)) throw new TypeError(`Unknown dependency ${dependency}`);
      visit(dependency);
    }
    active.delete(key);
    complete.add(key);
  };
  for (const entry of entries) visit(entry.key);
}

export function finalizeGoalContract(input: {
  readonly goalId: string;
  readonly objective: string;
  readonly intent: GoalContractRecord["intent"];
  readonly lane: GoalContractRecord["lane"];
  readonly sourceIntakeSha256: string;
  readonly version: number;
  readonly parentContractId: string | null;
  readonly proposal: GoalContractProposal;
  readonly createdAtMs: number;
}): GoalContractRecord {
  assertGoalContractProposalShape(input.proposal);
  if (input.proposal.obligations.length === 0 || input.proposal.obligations.length > 256) {
    throw new TypeError("GoalContract requires 1..256 obligations");
  }
  const userOutcomes = normalizedList(input.proposal.user_outcomes, "user_outcomes");
  const mustProposals = input.proposal.obligations.filter((entry) => entry.priority === "MUST");
  const mustStatements = mustProposals.map((entry, index) => normalizedText(
    entry.statement, `MUST obligation[${index}] statement`,
  ).toLocaleLowerCase("en-US"));
  if (new Set(mustStatements).size !== mustStatements.length) {
    throw new TypeError("GoalContract MUST obligation statements must remain independently distinguishable");
  }
  const proposalHash = canonicalJsonSha256(input.proposal);
  const contractId = derivedId("CONTRACT", input.goalId, input.version, proposalHash);
  const keys = input.proposal.obligations.map((entry, index) => normalizedKey(entry.key, `obligations[${index}].key`));
  if (new Set(keys).size !== keys.length) throw new TypeError("Obligation semantic keys must be unique");
  const obligationIds = new Map(keys.map((key) => [key, derivedId("OBLIGATION", contractId, key)]));
  const dependencies = input.proposal.obligations.map((entry, index) => ({
    key: keys[index]!,
    dependencies: normalizedList(entry.dependencies, `obligations[${index}].dependencies`).map((key) => normalizedKey(key, "obligation dependency")),
  }));
  ensureAcyclic(dependencies);
  const obligations = input.proposal.obligations.map((entry, ordinal) => {
    const key = keys[ordinal]!;
    const dependencyIds = dependencies[ordinal]!.dependencies.map((dependency) => {
      const id = obligationIds.get(dependency);
      if (!id) throw new TypeError(`Unknown obligation dependency ${dependency}`);
      return id;
    });
    assertExecutableOracle(`Obligation ${key} oracle`, entry.oracle);
    return sealTaskFlowRecord<TaskObligationRecord, "record_sha256">("PCH-TASK-OBLIGATION-V1", {
      obligation_id: obligationIds.get(key)!, contract_id: contractId, goal_id: input.goalId,
      semantic_key: key, priority: entry.priority,
      statement: normalizedText(entry.statement, `obligation ${key} statement`),
      oracle: entry.oracle, dependencies: dependencyIds, ordinal,
    }, "record_sha256");
  });
  const acceptancePolicy = normalizeTargetPerformanceAcceptancePolicy({
    objective: input.objective,
    contractId,
    obligationKeys: keys,
    acceptancePolicy: input.proposal.acceptance_policy,
  });
  const record = sealTaskFlowRecord<GoalContractRecord, "record_sha256">("PCH-GOAL-CONTRACT-V1", {
    schema_version: 1, contract_id: contractId, goal_id: input.goalId, version: input.version,
    parent_contract_id: input.parentContractId, intent: input.intent, lane: input.lane,
    objective: normalizedText(input.objective, "objective"),
    user_outcomes: userOutcomes,
    scope: normalizedList(input.proposal.scope, "scope"),
    non_goals: normalizedList(input.proposal.non_goals, "non_goals"),
    constraints: normalizedList(input.proposal.constraints, "constraints", 512),
    assumption_refs: normalizedList(input.proposal.assumption_refs, "assumption_refs", 512),
    decision_refs: normalizedList(input.proposal.decision_refs, "decision_refs", 512),
    obligations, acceptance_policy: acceptancePolicy,
    authorization_ceiling: input.proposal.authorization_ceiling,
    source_intake_sha256: input.sourceIntakeSha256, created_at_ms: input.createdAtMs,
  }, "record_sha256");
  assertGoalContract(record);
  return record;
}

export function finalizeRoute(input: {
  readonly contract: GoalContractRecord;
  readonly revision: number;
  readonly parentRouteId: string | null;
  readonly proposal: RouteProposal;
  readonly createdAtMs: number;
  readonly materialDecisionOpen?: boolean;
  readonly boundedScopeOverride?: boolean;
  readonly priorRoute?: RouteSkeletonRecord | null;
}): RouteSkeletonRecord {
  assertRouteProposalShape(input.proposal);
  if (input.priorRoute && (input.priorRoute.route_id !== input.parentRouteId
    || input.priorRoute.revision + 1 !== input.revision || input.priorRoute.goal_id !== input.contract.goal_id)) {
    throw new TypeError("RouteSkeleton prior route does not bind the requested revision");
  }
  if (input.proposal.work_cells.length === 0 || input.proposal.work_cells.length > 3) {
    throw new TypeError("RouteSkeleton v2 admits only 1..3 current or near-horizon WorkCells");
  }
  const keys = input.proposal.work_cells.map((entry, index) => normalizedKey(entry.key, `work_cells[${index}].key`));
  const deferredProposals = input.proposal.deferred_outcomes ?? [];
  if (deferredProposals.length > 256) throw new TypeError("RouteSkeleton deferred outcomes exceed 256");
  const deferredKeys = deferredProposals.map((entry, index) => normalizedKey(entry.key, `deferred_outcomes[${index}].key`));
  const allKeys = [...keys, ...deferredKeys];
  if (new Set(allKeys).size !== allKeys.length) throw new TypeError("Route subject logical keys must be unique");
  const obligationIds = new Map(input.contract.obligations.map((entry) => [entry.semantic_key, entry.obligation_id]));
  let workCellProposals = [...input.proposal.work_cells];
  let workDependencies = workCellProposals.map((entry, index) => ({
    key: keys[index]!,
    dependencies: normalizedList(entry.dependencies, `work_cells[${index}].dependencies`).map((key) => normalizedKey(key, "WorkCell dependency")),
  }));
  for (const entry of workDependencies) for (const dependency of entry.dependencies) if (!keys.includes(dependency)) throw new TypeError(`WorkCell ${entry.key} cannot depend on deferred or unknown subject ${dependency}`);
  const deferredDependencies = deferredProposals.map((entry, index) => ({
    key: deferredKeys[index]!,
    dependencies: normalizedList(entry.dependencies, `deferred_outcomes[${index}].dependencies`).map((key) => normalizedKey(key, "DeferredOutcome dependency")),
  }));
  if (deferredProposals.length === 0) {
    const hasDependent = new Set(workDependencies.flatMap((entry) => entry.dependencies));
    const terminalKeys = keys.filter((key) => !hasDependent.has(key));
    const terminalIndex = keys.reduce((selected, key, index) => terminalKeys.includes(key) ? index : selected, -1);
    if (terminalIndex < 0) throw new TypeError("RouteSkeleton has no terminal WorkCell for final acceptance");
    const terminal = workCellProposals[terminalIndex]!;
    const closureObligations = input.contract.obligations.filter((entry) => entry.priority === "MUST");
    const closureKeys = [...new Set([
      ...closureObligations.map((entry) => entry.semantic_key),
      ...terminal.obligation_keys,
    ])];
    const coveredObligations = input.contract.obligations.filter((entry) => closureKeys.includes(entry.semantic_key));
    const commands = [...new Set([
      ...closureObligations.flatMap((entry) => oracleCommands(entry.oracle)),
      ...oracleCommands(terminal.oracle),
    ])];
    const existingMappings = typeof terminal.oracle.obligation_oracles === "object"
      && terminal.oracle.obligation_oracles !== null && !Array.isArray(terminal.oracle.obligation_oracles)
      ? terminal.oracle.obligation_oracles as Readonly<Record<string, unknown>> : {};
    const oracleRest = Object.fromEntries(Object.entries(terminal.oracle)
      .filter(([key]) => !["command", "commands", "obligation_oracles"].includes(key)));
    const terminalOracle: Readonly<Record<string, unknown>> = {
      ...oracleRest,
      ...(commands.length === 1 ? { command: commands[0] } : commands.length > 1 ? { commands } : {}),
      obligation_oracles: {
        ...existingMappings,
        ...Object.fromEntries(coveredObligations.map((entry) => [entry.semantic_key, entry.oracle])),
      },
    };
    const terminalDependencies = [...new Set([
      ...workDependencies[terminalIndex]!.dependencies,
      ...terminalKeys.filter((key) => key !== keys[terminalIndex]),
    ])];
    const finalReadRoots = [...new Set(workCellProposals.flatMap((entry) => [...entry.read_roots, ...entry.write_roots]))];
    workCellProposals = workCellProposals.map((entry, index) => index === terminalIndex ? {
      ...entry,
      obligation_keys: closureKeys,
      dependencies: terminalDependencies,
      read_roots: finalReadRoots,
      oracle: terminalOracle,
    } : entry);
    workDependencies = workDependencies.map((entry, index) => index === terminalIndex
      ? { ...entry, dependencies: terminalDependencies } : entry);
  }
  ensureAcyclic([...workDependencies, ...deferredDependencies]);
  const effectiveProposal = { ...input.proposal, work_cells: workCellProposals };
  const proposalSha256 = canonicalJsonSha256(effectiveProposal);
  const routeId = derivedId("ROUTE", input.contract.contract_id, input.revision, proposalSha256);
  const cellIds = new Map(keys.map((key) => [key, derivedId("CELL", routeId, key)]));
  const deferredIds = new Map(deferredKeys.map((key) => [key, derivedId("DEFERRED", routeId, key)]));
  const subjectIds = new Map([...cellIds, ...deferredIds]);
  for (const entry of workDependencies) for (const dependency of entry.dependencies) if (!cellIds.has(dependency)) throw new TypeError(`WorkCell ${entry.key} cannot depend on deferred or unknown subject ${dependency}`);
  const cells = workCellProposals.map((entry, ordinal) => {
    const key = keys[ordinal]!;
    const covered = normalizedList(entry.obligation_keys, `WorkCell ${key} obligation_keys`).map((obligationKey) => {
      const obligationId = obligationIds.get(normalizedKey(obligationKey, "obligation key"));
      if (!obligationId) throw new TypeError(`WorkCell ${key} covers unknown obligation ${obligationKey}`);
      return obligationId;
    });
    if (covered.length === 0) throw new TypeError(`WorkCell ${key} must cover an obligation`);
    const readRoots = normalizedList(entry.read_roots, `WorkCell ${key} read_roots`);
    const writeRoots = normalizedList(entry.write_roots, `WorkCell ${key} write_roots`);
    if (readRoots.length + writeRoots.length === 0) throw new TypeError(`WorkCell ${key} requires a bounded read or write scope`);
    if (entry.effect_classes.length === 0 || new Set(entry.effect_classes).size !== entry.effect_classes.length) throw new TypeError(`WorkCell ${key} effect classes must be nonempty and unique`);
    if (entry.effect_classes.some((effect) => effectRank(effect) > effectRank(input.contract.authorization_ceiling))) throw new TypeError(`WorkCell ${key} exceeds the GoalContract authorization ceiling`);
    assertExecutableOracle(`WorkCell ${key} oracle`, entry.oracle);
    const coveredObligations = input.contract.obligations.filter((obligation) => covered.includes(obligation.obligation_id));
    assertWorkCellOracleCoverage(key, entry.oracle, coveredObligations);
    return sealTaskFlowRecord<WorkCellRecord, "spec_sha256">("PCH-WORK-CELL-V1", {
      schema_version: 1, work_cell_id: cellIds.get(key)!, goal_id: input.contract.goal_id,
      contract_id: input.contract.contract_id, route_id: routeId, logical_key: key, ordinal,
      horizon: ordinal === 0 ? "CURRENT" : "NEAR",
      outcome: normalizedText(entry.outcome, `WorkCell ${key} outcome`), obligation_ids: covered,
      dependencies: workDependencies[ordinal]!.dependencies.map((dependency) => cellIds.get(dependency)!),
      read_roots: readRoots, write_roots: writeRoots, effect_classes: [...entry.effect_classes],
      oracle: entry.oracle, risk: entry.risk, reversible: entry.reversible,
      budget: bindTargetPerformanceBudget(entry.budget, input.contract),
    }, "spec_sha256");
  });
  const deferredOutcomes = deferredProposals.map((entry, index) => {
    const key = deferredKeys[index]!;
    const covered = normalizedList(entry.obligation_keys, `DeferredOutcome ${key} obligation_keys`).map((obligationKey) => {
      const obligationId = obligationIds.get(normalizedKey(obligationKey, "obligation key"));
      if (!obligationId) throw new TypeError(`DeferredOutcome ${key} covers unknown obligation ${obligationKey}`);
      return obligationId;
    });
    if (covered.length === 0) throw new TypeError(`DeferredOutcome ${key} must cover an obligation`);
    return sealTaskFlowRecord<DeferredOutcomeRecord, "record_sha256">("PCH-DEFERRED-OUTCOME-V1", {
      deferred_outcome_id: deferredIds.get(key)!, key, outcome: normalizedText(entry.outcome, `DeferredOutcome ${key} outcome`),
      obligation_ids: covered, dependencies: deferredDependencies[index]!.dependencies.map((dependency) => subjectIds.get(dependency)!),
      expansion_trigger: entry.expansion_trigger, commitment: entry.commitment,
      evidence_refs: normalizedList(entry.evidence_refs, `DeferredOutcome ${key} evidence_refs`),
    }, "record_sha256");
  });
  const roots = cells.flatMap((cell) => [...cell.read_roots, ...cell.write_roots]);
  const boundedScope = (input.boundedScopeOverride ?? true) && deferredOutcomes.length === 0 && roots.length > 0 && roots.length <= 32 && roots.every((root) => root !== "." && root !== "./");
  const oracleKnown = cells.every((cell) => Object.keys(cell.oracle).length > 0);
  const reversible = cells.every((cell) => cell.reversible && cell.risk === "LOW");
  const migrationOrExternalEffect = effectRank(input.contract.authorization_ceiling) > effectRank("LOCAL_REVERSIBLE")
    || cells.some((cell) => cell.effect_classes.some((effect) => effectRank(effect) > effectRank("LOCAL_REVERSIBLE")))
    || /(?:migration|migrate|deploy|production|credential|secret|database schema|数据库迁移|部署|生产环境|凭据|密钥)/iu.test(`${input.contract.objective}\n${input.proposal.outcomes.join("\n")}`);
  const proposalLane = input.proposal.lane ?? null;
  const requestedLane = proposalLane ?? input.contract.lane;
  const evidenceDirect = mayUseDirectCell({
    lane: "DIRECT_CELL", boundedScope, oracleKnown, reversible,
    materialDecisionOpen: input.materialDecisionOpen ?? false, migrationOrExternalEffect,
    workCellCount: cells.length,
  });
  const evidenceCandidateLane: TaskFlowLane = evidenceDirect ? "DIRECT_CELL" : "ADAPTIVE_ROUTE";
  const priorSelectedLane = input.priorRoute?.lane ?? null;
  const selectedLane: TaskFlowLane = proposalLane === "ADAPTIVE_ROUTE" || priorSelectedLane === "ADAPTIVE_ROUTE"
    ? "ADAPTIVE_ROUTE" : evidenceCandidateLane;
  const hysteresisAction: NonNullable<RouteQualificationReceiptRecord["hysteresis_action"]> =
    priorSelectedLane === "ADAPTIVE_ROUTE" && evidenceCandidateLane === "DIRECT_CELL" ? "HELD_ADAPTIVE"
      : priorSelectedLane === "DIRECT_CELL" && selectedLane === "ADAPTIVE_ROUTE" ? "PROMOTED"
        : priorSelectedLane === null && selectedLane !== input.contract.lane ? "INITIAL_RECLASSIFY" : "NONE";
  const reasonCodes = selectedLane === "DIRECT_CELL" ? [
    "SECOND_STAGE_DIRECT_PROVEN",
    ...(hysteresisAction === "INITIAL_RECLASSIFY" ? ["INITIAL_LANE_RECLASSIFIED"] : []),
  ] : [
    ...(proposalLane === "ADAPTIVE_ROUTE" ? ["ADAPTIVE_ROUTE_EXPLICITLY_PROPOSED"] : []),
    ...(hysteresisAction === "HELD_ADAPTIVE" ? ["HYSTERESIS_ADAPTIVE_HELD"] : []),
    ...((hysteresisAction === "PROMOTED" || (input.contract.lane === "DIRECT_CELL" && selectedLane === "ADAPTIVE_ROUTE"))
      ? ["DIRECT_CELL_PROMOTED"] : []),
    ...(!boundedScope ? ["SCOPE_NOT_DIRECT_BOUNDED"] : []), ...(!oracleKnown ? ["ORACLE_UNKNOWN"] : []),
    ...(!reversible ? ["NOT_LOW_RISK_REVERSIBLE"] : []), ...((input.materialDecisionOpen ?? false) ? ["MATERIAL_DECISION_OPEN"] : []),
    ...(migrationOrExternalEffect ? ["MIGRATION_OR_EXTERNAL_EFFECT"] : []),
    ...(evidenceCandidateLane === "ADAPTIVE_ROUTE" && proposalLane !== "ADAPTIVE_ROUTE" && hysteresisAction !== "PROMOTED"
      ? ["SECOND_STAGE_ADAPTIVE_REQUIRED"] : []),
  ];
  const qualification = sealTaskFlowRecord<RouteQualificationReceiptRecord, "record_sha256">("PCH-ROUTE-QUALIFICATION-V2", {
    schema_version: 2, qualification_id: derivedId("QUALIFICATION", routeId, proposalSha256),
    goal_id: input.contract.goal_id, contract_id: input.contract.contract_id,
    contract_sha256: input.contract.record_sha256, proposal_sha256: proposalSha256,
    admission_lane_hint: input.contract.lane, requested_lane: requestedLane, proposal_lane: proposalLane,
    evidence_candidate_lane: evidenceCandidateLane, prior_selected_lane: priorSelectedLane,
    hysteresis_action: hysteresisAction, work_cell_count: cells.length, selected_lane: selectedLane,
    bounded_scope: boundedScope, oracle_known: oracleKnown, reversible,
    material_decision_open: input.materialDecisionOpen ?? false, migration_or_external_effect: migrationOrExternalEffect,
    evidence_refs: [input.contract.record_sha256, input.contract.source_intake_sha256, ...cells.map((cell) => cell.spec_sha256), ...deferredOutcomes.map((entry) => entry.record_sha256)],
    reason_codes: reasonCodes, created_at_ms: input.createdAtMs,
  }, "record_sha256");
  const assumptions = (input.proposal.assumptions ?? []).map((entry, index) => {
    const key = normalizedKey(entry.key, `assumptions[${index}].key`);
    return sealTaskFlowRecord<RouteAssumptionRecord, "record_sha256">("PCH-ROUTE-ASSUMPTION-V1", {
      assumption_id: derivedId("ASSUMPTION", routeId, key), key,
      statement: normalizedText(entry.statement, `assumption ${key}`),
      evidence_refs: normalizedList(entry.evidence_refs, `assumption ${key} evidence_refs`), status: entry.status,
    }, "record_sha256");
  });
  const risks = (input.proposal.risks ?? []).map((entry, index) => {
    const key = normalizedKey(entry.key, `risks[${index}].key`);
    return sealTaskFlowRecord<RouteRiskRecord, "record_sha256">("PCH-ROUTE-RISK-V1", {
      risk_id: derivedId("RISK", routeId, key), key, statement: normalizedText(entry.statement, `risk ${key}`),
      likelihood: entry.likelihood, impact: entry.impact, mitigation: normalizedText(entry.mitigation, `risk ${key} mitigation`),
      evidence_refs: normalizedList(entry.evidence_refs, `risk ${key} evidence_refs`),
    }, "record_sha256");
  });
  const alternatives = (input.proposal.alternatives ?? []).map((entry, index) => {
    const key = normalizedKey(entry.key, `alternatives[${index}].key`);
    return sealTaskFlowRecord<RouteAlternativeRecord, "record_sha256">("PCH-ROUTE-ALTERNATIVE-V1", {
      alternative_id: derivedId("ALTERNATIVE", routeId, key), key,
      summary: normalizedText(entry.summary, `alternative ${key}`), disposition: entry.disposition,
      reason: normalizedText(entry.reason, `alternative ${key} reason`),
      evidence_refs: normalizedList(entry.evidence_refs, `alternative ${key} evidence_refs`),
    }, "record_sha256");
  });
  const horizonKeys = input.proposal.near_horizon?.map((key) => normalizedKey(key, "near_horizon key")) ?? keys;
  if (horizonKeys.length !== keys.length || keys.some((key) => !horizonKeys.includes(key))) throw new TypeError("RouteSkeleton v2 near_horizon must contain every submitted WorkCell exactly once");
  const horizonIds = horizonKeys.map((key) => cellIds.get(key)!);
  const acceptanceCoverage: Record<string, readonly string[]> = {};
  for (const obligation of input.contract.obligations) acceptanceCoverage[obligation.obligation_id] = [
    ...cells.filter((cell) => cell.obligation_ids.includes(obligation.obligation_id)).map((cell) => cell.work_cell_id),
    ...deferredOutcomes.filter((entry) => entry.obligation_ids.includes(obligation.obligation_id)).map((entry) => entry.deferred_outcome_id),
  ];
  assertTargetPerformanceRoute(input.contract, cells);
  const record = sealTaskFlowRecord<RouteSkeletonRecord, "record_sha256">("PCH-ROUTE-SKELETON-V2", {
    schema_version: 2, route_id: routeId, goal_id: input.contract.goal_id,
    contract_id: input.contract.contract_id, revision: input.revision, parent_route_id: input.parentRouteId,
    lane: selectedLane, outcomes: normalizedList(input.proposal.outcomes, "route outcomes"),
    assumptions, risks, alternatives, acceptance_coverage: acceptanceCoverage,
    work_cells: cells, near_horizon: horizonIds, qualification, deferred_outcomes: deferredOutcomes,
    created_at_ms: input.createdAtMs,
  }, "record_sha256");
  assertRouteSkeleton(record, input.contract);
  return record;
}
