import type { CodingHarnessConfig } from "../config/types.js";
import { classifySpecificationRoute } from "./route-classifier.js";
import type { IntakeFacts, SpecificationRoute } from "./types.js";

export type PersistedSpecificationRoute = Exclude<SpecificationRoute, "BYPASS">;
export type RuntimeRequirementProfile = "TASK_SPEC" | "PRD";
export type RuntimePlanningDepth = "LIGHT" | "STANDARD" | "FULL";
export type IntakeClassificationSource = "AUTO_LOCAL_RULES" | "AUTO_WITH_USER_OVERRIDE" | "USER_CONFIG" | "LEGACY_DERIVED";
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

const fileReference = /(?:^|[\s"'`(])(?:\.{0,2}[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]+\.[a-z0-9]{1,12}\b|\b(?:readme(?:\.md)?|package\.json|tsconfig\.json|pyproject\.toml|cargo\.toml)\b/iu;
const ambiguitySignals = [
  /\b(?:tbd|to be decided|unclear|unspecified|choose|decide between|whichever|figure out the product requirements)\b/iu,
  /(?:待定|尚未确定|不明确|未指定|需要选择|自行决定产品需求)/u,
];
const acceptanceSignals = [
  /\b(?:must|should|expected|ensure|verify|test|tests|acceptance|exactly|regression)\b/iu,
  /(?:必须|应当|预期|确保|验证|测试|验收|精确|回归)/u,
];
const lowRiskSignals = [
  /\b(?:typo|spelling|documentation|readme|comment|one[- ]file|single[- ]file|rename|config(?:uration)? value|test assertion)\b/iu,
  /(?:错别字|拼写|文档|注释|单文件|一个文件|重命名|配置值|测试断言)/u,
];
const productSignals = [
  /\b(?:new product|new feature|user flow|workflow|onboarding|checkout|dashboard|multi[- ]role|user-facing|user experience|ui feature)\b/iu,
  /\b(?:target users?|measurable outcomes?|user flows?|new\b.{0,48}\bfeature)\b/iu,
  /(?:新产品|新功能|用户流程|工作流|引导流程|结账流程|仪表盘|多角色|用户体验|界面功能)/u,
];
const highReworkSignals = [
  /\b(?:architect(?:ure)?|redesign|rewrite|large refactor|from scratch|new service|new application|platform migration)\b/iu,
  /(?:架构|重新设计|重写|大规模重构|从零实现|新服务|新应用|平台迁移)/u,
];
const irreversibleOrSensitiveSignals = [
  /\b(?:destructive|drop table|delete production data|purge data|credential|secret rotation|payment|privacy|permission model|database migration)\b/iu,
  /(?:不可逆|破坏性|删除生产数据|清空数据|凭据|密钥轮换|支付|隐私|权限模型|数据库迁移)/u,
];
const explicitCrossModuleSignals = [
  /\b(?:cross[- ]module|multiple modules|across\s+multiple\s+[a-z0-9_.-]+\s+modules|frontend and backend|client and server|database and api|api and ui)\b/iu,
  /(?:跨模块|多个模块|前端和后端|客户端和服务端|数据库和接口|接口和界面)/u,
];
const domainSignals = [
  /\b(?:frontend|ui|screen|page|form|dashboard)\b|(?:前端|界面|页面|表单|仪表盘)/iu,
  /\b(?:backend|api|endpoint|server|service)\b|(?:后端|接口|服务端|服务)/iu,
  /\b(?:database|schema|sql|storage|migration)\b|(?:数据库|数据表|存储|迁移)/iu,
  /\b(?:auth|authentication|authorization|permission|role|login)\b|(?:认证|授权|权限|角色|登录)/iu,
];
const engineeringDomainSignals = [
  /\b(?:validat(?:e|ion)|diagnostic|error reporting|acceptance|regression tests?)\b/iu,
  /\b(?:imports?|configuration|generated[- ]config|resource targets?)\b/iu,
  /\b(?:plans?|planning|deferred|execution path)\b/iu,
  /\b(?:dependency graph|graph construction|module[- ]scoped|scope resolution|expansion)\b/iu,
];
const regressionBoundarySignals = [
  /\b(?:preserve|without regressions?|must continue|unrelated)\b/iu,
  /\b(?:existing[- ]style|existing behavior|backward compatibility|backwards compatibility)\b/iu,
  /\b(?:across|all variants?|unkeyed and keyed|module[- ]scoped)\b/iu,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const measurableOutcomeSection = /(?:\bmeasurable outcomes?\b|可量化(?:结果|成果|验收))\s*[:：]\s*([\s\S]*?)(?=(?:\bscope\b|\bnon-goals?\b|\buser flow\b|\bfailure paths?\b|\bquality requirements?\b|范围|非目标|用户流程|失败路径|质量要求)\s*[:：]|$)/iu;

/**
 * Returns a conservative lower bound for independently decidable acceptance
 * facets already stated by the user. It is deterministic, bounded, and never
 * asks a model to reinterpret the task.
 */
export function inferAcceptanceFacetMinimum(objective: string): number {
  const normalized = objective.normalize("NFC").trim();
  if (!normalized) return 1;
  const englishMustCount = [...normalized.matchAll(/\bmust(?:\s+not)?\b/giu)].length;
  const chineseMustCount = [...normalized.matchAll(/(?:必须|不得|务必|应当)/gu)].length;
  const section = measurableOutcomeSection.exec(normalized)?.[1] ?? "";
  const measurableCount = section
    ? section.split(/[;；]/u).map((value) => value.trim()).filter((value) => value.length >= 4).length
    : 0;
  return Math.min(6, Math.max(1, englishMustCount, chineseMustCount, measurableCount));
}

export function inferIntakeFacts(objective: string): IntakeFacts {
  const normalized = objective.normalize("NFC").trim();
  const highImpactUnknowns = matchesAny(normalized, ambiguitySignals) ? 1 : 0;
  const productOrUserFlow = matchesAny(normalized, productSignals);
  const highRework = matchesAny(normalized, highReworkSignals);
  const irreversibleOrSensitive = matchesAny(normalized, irreversibleOrSensitiveSignals);
  const domainCount = domainSignals.filter((pattern) => pattern.test(normalized)).length;
  const engineeringDomainCount = engineeringDomainSignals.filter((pattern) => pattern.test(normalized)).length;
  const regressionBoundaryCount = regressionBoundarySignals.filter((pattern) => pattern.test(normalized)).length;
  const complexEngineeringChange = engineeringDomainCount >= 3 && regressionBoundaryCount >= 2;
  const crossModule = matchesAny(normalized, explicitCrossModuleSignals) || domainCount >= 2 || complexEngineeringChange;
  const inferredHighRework = highRework || complexEngineeringChange;
  const filesKnown = fileReference.test(normalized);
  const acceptanceClear = matchesAny(normalized, acceptanceSignals);
  const lowRisk = matchesAny(normalized, lowRiskSignals)
    && !productOrUserFlow && !crossModule && !inferredHighRework && !irreversibleOrSensitive && highImpactUnknowns === 0;
  const objectiveClear = normalized.length > 0 && highImpactUnknowns === 0;
  const expectedSteps = lowRisk && filesKnown && acceptanceClear ? 1 : crossModule || inferredHighRework ? 3 : 2;
  return {
    requiresPersistentWork: true,
    objectiveClear,
    filesKnown,
    acceptanceClear,
    lowRisk,
    expectedSteps,
    productOrUserFlow,
    crossModule,
    highRework: inferredHighRework,
    highImpactUnknowns,
    irreversibleOrSensitive,
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
  const provisionalRoute: PersistedSpecificationRoute = profileOverride === "PRD"
    ? "PRD"
    : profileOverride === "TASK_SPEC" && automaticRoute === "PRD"
      ? "TASK_SPEC"
      : automaticRoute;
  const requirementProfile = profileOverride ?? defaultProfile(provisionalRoute);
  const depthOverride = config.execution.planning_depth === "AUTO" ? null : config.execution.planning_depth;
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
    ? "AUTO_LOCAL_RULES"
    : config.requirements.profile !== "AUTO" && config.execution.planning_depth !== "AUTO"
      ? "USER_CONFIG"
      : "AUTO_WITH_USER_OVERRIDE";
  const confidence: IntakeClassificationConfidence = overrideReasons.length > 0 || specificationRoute !== "TASK_SPEC" ? "HIGH" : "MEDIUM";
  const reasonCodes = unique([...automatic.reasonCodes, ...overrideReasons]);
  return {
    specificationRoute,
    requirementProfile,
    planningDepth,
    classification: {
      specificationRoute,
      reasonCodes,
      confidence,
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
  if (!new Set(["AUTO_LOCAL_RULES", "AUTO_WITH_USER_OVERRIDE", "USER_CONFIG", "LEGACY_DERIVED"]).has(String(record.source))) issues.push("source is invalid");
  if (record.additionalModelRequests !== 0) issues.push("additionalModelRequests must be zero");
  const facts = record.facts;
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return [...issues, "facts must be an object"];
  const factRecord = facts as Record<string, unknown>;
  for (const key of ["requiresPersistentWork", "objectiveClear", "filesKnown", "acceptanceClear", "lowRisk", "productOrUserFlow", "crossModule", "highRework", "irreversibleOrSensitive"]) {
    if (typeof factRecord[key] !== "boolean") issues.push(`facts.${key} must be boolean`);
  }
  if (!Number.isSafeInteger(factRecord.expectedSteps) || Number(factRecord.expectedSteps) < 0) issues.push("facts.expectedSteps is invalid");
  if (!Number.isSafeInteger(factRecord.highImpactUnknowns) || Number(factRecord.highImpactUnknowns) < 0) issues.push("facts.highImpactUnknowns is invalid");
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
      requiresPersistentWork: true, objectiveClear: false, filesKnown: false, acceptanceClear: false,
      lowRisk: false, expectedSteps: planningDepth === "LIGHT" ? 1 : planningDepth === "FULL" ? 3 : 2,
      productOrUserFlow: requirementProfile === "PRD", crossModule: false, highRework: false,
      highImpactUnknowns: 0, irreversibleOrSensitive: false,
    },
    additionalModelRequests: 0,
  };
}
