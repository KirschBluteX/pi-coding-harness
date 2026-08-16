import type { CodingHarnessConfig } from "../config/types.js";
import { classifySpecificationRoute } from "./route-classifier.js";
import type { IntakeFacts, SpecificationRoute } from "./types.js";

export type PersistedSpecificationRoute = Exclude<SpecificationRoute, "BYPASS">;
export type RuntimeRequirementProfile = "TASK_SPEC" | "PRD";
export type RuntimePlanningDepth = "LIGHT" | "STANDARD" | "FULL";
export type IntakeClassificationSource =
  | "AUTO_STRUCTURAL"
  | "AUTO_WITH_USER_OVERRIDE"
  | "USER_CONFIG"
  | "AUTO_LOCAL_RULES"
  | "LEGACY_DERIVED";
export type IntakeClassificationConfidence = "HIGH" | "MEDIUM" | "LEGACY";

export interface IntakeClassificationRecord {
  readonly specificationRoute: PersistedSpecificationRoute;
  readonly reasonCodes: readonly string[];
  readonly confidence: IntakeClassificationConfidence;
  readonly source: IntakeClassificationSource;
  readonly facts: IntakeFacts;
  readonly additionalModelRequests: 0;
}

export type GoalIntakeSelection =
  | {
      readonly specificationRoute: "BYPASS";
      readonly requirementProfile: null;
      readonly planningDepth: null;
      readonly reasonCodes: readonly string[];
      readonly source: "USER_CONFIG";
      readonly additionalModelRequests: 0;
    }
  | {
      readonly specificationRoute: PersistedSpecificationRoute;
      readonly requirementProfile: RuntimeRequirementProfile;
      readonly planningDepth: RuntimePlanningDepth;
      readonly classification: IntakeClassificationRecord;
      readonly additionalModelRequests: 0;
    };

const fileReference = /(?:^|[\s"'`(])(?:\.{0,2}[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]+\.[a-z0-9]{1,12}\b|\b(?:readme(?:\.md)?|package\.json|tsconfig\.json|pyproject\.toml|cargo\.toml)\b/giu;
const listItem = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)\S/mu;
const sectionHeading = /^\s*[^\r\n:：]{1,80}[:：]\s*(?:\S.*)?$/gmu;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function structuralComplexity(objective: string): {
  readonly level: 1 | 2 | 3 | 4;
  readonly fileCount: number;
  readonly clauseCount: number;
  readonly listItemCount: number;
  readonly sectionCount: number;
  readonly distinctPathRoots: number;
} {
  const fileMatches = [...objective.matchAll(fileReference)].map((match) => match[0].trim());
  const clauses = objective.split(/[.!?;。！？；\r\n]+/u).map((value) => value.trim()).filter(Boolean);
  const listItems = objective.split(/\r?\n/u).filter((line) => listItem.test(line)).length;
  const sections = [...objective.matchAll(sectionHeading)].length;
  const roots = new Set(fileMatches.map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, "").split("/", 1)[0]));
  let score = 1;
  if (objective.length >= 240 || clauses.length >= 3 || fileMatches.length >= 2 || listItems >= 2) score += 1;
  if (objective.length >= 800 || clauses.length >= 6 || fileMatches.length >= 4 || listItems >= 4 || sections >= 2) score += 1;
  if (objective.length >= 2_400 || clauses.length >= 12 || listItems >= 10 || sections >= 5) score += 1;
  return {
    level: Math.min(4, score) as 1 | 2 | 3 | 4,
    fileCount: fileMatches.length,
    clauseCount: clauses.length,
    listItemCount: listItems,
    sectionCount: sections,
    distinctPathRoots: roots.size,
  };
}

export function inferIntakeFacts(objective: string): IntakeFacts {
  const normalized = objective.normalize("NFC").trim();
  const structure = structuralComplexity(normalized);
  return {
    requiresPersistentWork: true,
    objectiveClear: normalized.length > 0,
    filesKnown: structure.fileCount > 0,
    acceptanceClear: structure.listItemCount >= 2 || structure.sectionCount >= 2,
    lowRisk: false,
    expectedSteps: structure.level >= 3 ? 3 : 2,
    productOrUserFlow: false,
    crossModule: structure.distinctPathRoots >= 2,
    highRework: false,
    highImpactUnknowns: 0,
    irreversibleOrSensitive: false,
    semanticAssessment: "UNRESOLVED",
    structuralComplexity: structure.level,
  };
}

function defaultProfile(route: PersistedSpecificationRoute): RuntimeRequirementProfile {
  return route === "PRD" ? "PRD" : "TASK_SPEC";
}

function defaultDepth(route: PersistedSpecificationRoute): RuntimePlanningDepth {
  if (route === "BUILD_LIGHT") return "LIGHT";
  return route === "PRD" ? "FULL" : "STANDARD";
}

export function classifyGoalIntake(objective: string, config: CodingHarnessConfig): GoalIntakeSelection {
  if (config.execution.planning_depth === "BYPASS") {
    return {
      specificationRoute: "BYPASS",
      requirementProfile: null,
      planningDepth: null,
      reasonCodes: ["USER_DEPTH_BYPASS"],
      source: "USER_CONFIG",
      additionalModelRequests: 0,
    };
  }

  const facts = inferIntakeFacts(objective);
  const automatic = classifySpecificationRoute(facts);
  const automaticRoute = automatic.route === "BYPASS" ? "TASK_SPEC" : automatic.route;
  const profileOverride = config.requirements.profile === "AUTO" ? null : config.requirements.profile;
  const depthOverride = config.execution.planning_depth === "AUTO" ? null : config.execution.planning_depth;
  const explicitLight = profileOverride === "TASK_SPEC" && depthOverride === "LIGHT";
  const provisionalRoute: PersistedSpecificationRoute = explicitLight
    ? "BUILD_LIGHT"
    : profileOverride === "PRD"
      ? "PRD"
      : profileOverride === "TASK_SPEC" && automaticRoute === "PRD"
        ? "TASK_SPEC"
        : automaticRoute;
  const requirementProfile = profileOverride ?? defaultProfile(provisionalRoute);
  const planningDepth = depthOverride ?? defaultDepth(provisionalRoute);
  const specificationRoute: PersistedSpecificationRoute = requirementProfile === "PRD"
    ? "PRD"
    : provisionalRoute === "BUILD_LIGHT" && planningDepth === "LIGHT"
      ? "BUILD_LIGHT"
      : "TASK_SPEC";
  const overrideReasons = [
    ...(profileOverride ? ["USER_PROFILE_OVERRIDE"] : []),
    ...(depthOverride ? ["USER_DEPTH_OVERRIDE"] : []),
  ];
  const source: IntakeClassificationSource = overrideReasons.length === 0
    ? "AUTO_STRUCTURAL"
    : profileOverride !== null && depthOverride !== null
      ? "USER_CONFIG"
      : "AUTO_WITH_USER_OVERRIDE";
  const reasonCodes = unique([
    ...automatic.reasonCodes,
    "SEMANTIC_CONTRACT_REVIEW_REQUIRED",
    ...overrideReasons,
  ]);
  return {
    specificationRoute,
    requirementProfile,
    planningDepth,
    classification: {
      specificationRoute,
      reasonCodes,
      confidence: overrideReasons.length > 0 ? "HIGH" : "MEDIUM",
      source,
      facts,
      additionalModelRequests: 0,
    },
    additionalModelRequests: 0,
  };
}

export function validateIntakeClassificationRecord(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["classification must be an object"];
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!new Set(["BUILD_LIGHT", "TASK_SPEC", "PRD"]).has(String(record.specificationRoute))) issues.push("specificationRoute is invalid");
  if (!Array.isArray(record.reasonCodes) || record.reasonCodes.length === 0
    || record.reasonCodes.some((entry) => typeof entry !== "string" || !/^[A-Z0-9_:-]+$/u.test(entry))) issues.push("reasonCodes are invalid");
  if (!new Set(["HIGH", "MEDIUM", "LEGACY"]).has(String(record.confidence))) issues.push("confidence is invalid");
  if (!new Set(["AUTO_STRUCTURAL", "AUTO_LOCAL_RULES", "AUTO_WITH_USER_OVERRIDE", "USER_CONFIG", "LEGACY_DERIVED"])
    .has(String(record.source))) issues.push("source is invalid");
  if (record.additionalModelRequests !== 0) issues.push("additionalModelRequests must be zero");
  const facts = record.facts;
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return [...issues, "facts must be an object"];
  const factRecord = facts as Record<string, unknown>;
  for (const key of ["requiresPersistentWork", "objectiveClear", "filesKnown", "acceptanceClear", "lowRisk", "productOrUserFlow", "crossModule", "highRework", "irreversibleOrSensitive"]) {
    if (typeof factRecord[key] !== "boolean") issues.push(`facts.${key} must be boolean`);
  }
  if (!Number.isSafeInteger(factRecord.expectedSteps) || Number(factRecord.expectedSteps) < 0) issues.push("facts.expectedSteps is invalid");
  if (!Number.isSafeInteger(factRecord.highImpactUnknowns) || Number(factRecord.highImpactUnknowns) < 0) issues.push("facts.highImpactUnknowns is invalid");
  const historical = record.source === "AUTO_LOCAL_RULES" || record.source === "LEGACY_DERIVED";
  if (!historical || factRecord.semanticAssessment !== undefined) {
    if (factRecord.semanticAssessment !== "UNRESOLVED" && factRecord.semanticAssessment !== "USER_CONFIRMED"
      && factRecord.semanticAssessment !== "CONTRACT_DERIVED") issues.push("facts.semanticAssessment is invalid");
  }
  if (!historical || factRecord.structuralComplexity !== undefined) {
    if (!Number.isSafeInteger(factRecord.structuralComplexity)
      || Number(factRecord.structuralComplexity) < 1 || Number(factRecord.structuralComplexity) > 4) {
      issues.push("facts.structuralComplexity is invalid");
    }
  }
  return issues;
}

export function validateGoalClassificationCompatibility(
  classification: IntakeClassificationRecord,
  requirementProfile: RuntimeRequirementProfile,
  planningDepth: RuntimePlanningDepth,
): readonly string[] {
  const issues: string[] = [];
  if (classification.specificationRoute === "BUILD_LIGHT"
    && (requirementProfile !== "TASK_SPEC" || planningDepth !== "LIGHT")) {
    issues.push("BUILD_LIGHT requires TASK_SPEC and LIGHT planning depth");
  }
  if (classification.specificationRoute === "PRD" && requirementProfile !== "PRD") {
    issues.push("PRD route requires PRD requirement profile");
  }
  if (classification.specificationRoute === "TASK_SPEC" && requirementProfile !== "TASK_SPEC") {
    issues.push("TASK_SPEC route requires TASK_SPEC requirement profile");
  }
  return issues;
}

export function legacyIntakeClassification(
  requirementProfile: RuntimeRequirementProfile,
  planningDepth: RuntimePlanningDepth,
): IntakeClassificationRecord {
  const specificationRoute: PersistedSpecificationRoute = requirementProfile === "PRD"
    ? "PRD"
    : planningDepth === "LIGHT" ? "BUILD_LIGHT" : "TASK_SPEC";
  return {
    specificationRoute,
    reasonCodes: ["LEGACY_PROFILE_DEPTH_DERIVATION"],
    confidence: "LEGACY",
    source: "LEGACY_DERIVED",
    facts: {
      requiresPersistentWork: true,
      objectiveClear: false,
      filesKnown: false,
      acceptanceClear: false,
      lowRisk: false,
      expectedSteps: planningDepth === "LIGHT" ? 1 : planningDepth === "FULL" ? 3 : 2,
      productOrUserFlow: false,
      crossModule: false,
      highRework: false,
      highImpactUnknowns: 0,
      irreversibleOrSensitive: false,
      semanticAssessment: "UNRESOLVED",
      structuralComplexity: planningDepth === "LIGHT" ? 1 : planningDepth === "FULL" ? 3 : 2,
    },
    additionalModelRequests: 0,
  };
}
