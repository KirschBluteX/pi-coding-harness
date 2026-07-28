import type { CodingHarnessConfig } from "../config/types.js";
import type { TaskFlowIntent, TaskFlowLane } from "./domain.js";

export interface TaskFlowAdmission {
  readonly action: "BYPASS" | "MANAGED";
  readonly objective: string;
  readonly taskText: string;
  readonly intent: TaskFlowIntent | null;
  readonly lane: TaskFlowLane | null;
  readonly marker: "auto" | "plan" | "build" | null;
  readonly reasonCodes: readonly string[];
  readonly additionalModelRequests: 0;
}

const explicitPattern = /^\s*(plan|build)\s*:\s*([^\s][\s\S]*)$/iu;
const durableAction = /(?:实现|修改|修复|重构|创建|新增|删除|迁移|安装|升级|优化|测试|验证|编译|部署|落地|编写|开发|write|edit|fix|implement|refactor|create|add|delete|migrate|install|upgrade|optimi[sz]e|test|verify|build|deploy)/iu;
const conversational = /^(?:什么是|为何|为什么|如何理解|解释|介绍|讲解|请说明|告诉我|how\b|what\b|why\b|explain\b|describe\b|tell me\b)/iu;
const productOrArchitecture = /(?:产品|prd|用户流程|架构|跨模块|端到端|全量|全面|整个项目|architecture|multi[- ]module|end[- ]to[- ]end)/iu;
const riskyOrIrreversible = /(?:不可逆|生产环境|线上|部署|删除数据|清库|支付|发布|凭据|密钥|权限|安全边界|数据库迁移|migration|database schema|production|deploy|credential|secret|permission)/iu;
const ambiguity = /(?:看情况|你决定|酌情|最好|大概|可能|不确定|合理即可|as appropriate|maybe|roughly|unsure)/iu;
const boundedTarget = /(?:[A-Za-z]:[\\/]|\/[A-Za-z0-9_.-]|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|sql|ps1)\b|单文件|这个文件|这些文件|this file|these files)/iu;
const verification = /(?:测试|验证|编译|单测|lint|typecheck|test|verify|compile|build)/iu;
const explicitNoMutation = /(?:不要修改|不得修改|无需修改|只读|仅(?:检查|分析|解释|说明)|do not modify|must not modify|without modifying|read[- ]only|only (?:inspect|analy[sz]e|explain|describe))/iu;
const workspaceMutation = /(?:实现|修改|修复|重构|创建|新增|删除|迁移|安装|升级|优化|落地|编写|开发|implement|modify|edit|fix|refactor|create|add|delete|migrate|install|upgrade|optimi[sz]e|write (?:code|tests?|files?))/iu;

const piFileEnvelope = /^\s*<file name="[^"\r\n]{1,4096}">\r?\n([\s\S]*?)\r?\n<\/file>\s*$/u;
const maximumObjectiveLength = 512;
const maximumTaskTextLength = 32_768;

function unwrapPiFileEnvelope(value: string): { readonly text: string; readonly unwrapped: boolean } {
  const match = piFileEnvelope.exec(value);
  return match ? { text: match[1]!, unwrapped: true } : { text: value, unwrapped: false };
}

function projectObjective(value: string): { readonly objective: string; readonly projected: boolean } {
  const normalized = value.normalize("NFC").trim();
  const forbiddenControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (!normalized || normalized.length > maximumTaskTextLength || forbiddenControl) {
    throw new TypeError(`Task Flow input must be printable text of at most ${maximumTaskTextLength} characters`);
  }
  const singleLine = normalized.replace(/[\t\r\n ]+/gu, " ").trim();
  if (singleLine.length <= maximumObjectiveLength) return { objective: singleLine, projected: singleLine !== normalized };
  let end = maximumObjectiveLength - 3;
  const finalCodeUnit = singleLine.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1;
  return { objective: `${singleLine.slice(0, end)}...`, projected: true };
}

function configuredIntent(value: CodingHarnessConfig["execution"]["default_intent"]): TaskFlowIntent | null {
  if (value === "BUILD") return "BUILD";
  if (value === "PLAN_ONLY") return "PLAN";
  return null;
}

function classifyTaskFlowInputUnprojected(text: string, config: { readonly execution: Pick<CodingHarnessConfig["execution"], "default_intent"> }): Omit<TaskFlowAdmission, "taskText"> {
  const explicit = explicitPattern.exec(text);
  if (explicit) {
    const marker = explicit[1]!.toLowerCase() as "plan" | "build";
    const objective = explicit[2]!.trim();
    const intent: TaskFlowIntent = marker === "plan" ? "PLAN" : "BUILD";
    const lane = selectTaskFlowLane(objective);
    return { action: "MANAGED", objective, intent, lane, marker, reasonCodes: ["EXPLICIT_INTENT", `LANE_${lane}`], additionalModelRequests: 0 };
  }
  const objective = text.trim();
  if (!objective || objective.startsWith("/")) return { action: "BYPASS", objective, intent: null, lane: null, marker: null, reasonCodes: ["EMPTY_OR_COMMAND"], additionalModelRequests: 0 };
  const configured = configuredIntent(config.execution.default_intent);
  if (configured) {
    const lane = selectTaskFlowLane(objective);
    return { action: "MANAGED", objective, intent: configured, lane, marker: "auto", reasonCodes: ["CONFIGURED_INTENT", `LANE_${lane}`], additionalModelRequests: 0 };
  }
  if (!durableAction.test(objective) || (conversational.test(objective) && !boundedTarget.test(objective))) {
    return { action: "BYPASS", objective, intent: null, lane: null, marker: "auto", reasonCodes: ["AUTO_CONVERSATION_OR_NO_DURABLE_ACTION"], additionalModelRequests: 0 };
  }
  const lane = selectTaskFlowLane(objective);
  const intent: TaskFlowIntent = ambiguity.test(objective) || lane === "ADAPTIVE_ROUTE" ? "PLAN" : "BUILD";
  return { action: "MANAGED", objective, intent, lane, marker: "auto", reasonCodes: ["AUTO_DURABLE_ACTION", `AUTO_${intent}`, `LANE_${lane}`], additionalModelRequests: 0 };
}

export function classifyTaskFlowInput(text: string, config: { readonly execution: Pick<CodingHarnessConfig["execution"], "default_intent"> }): TaskFlowAdmission {
  const envelope = unwrapPiFileEnvelope(text);
  const classified = classifyTaskFlowInputUnprojected(envelope.text, config);
  const taskText = classified.objective;
  if (!taskText) return { ...classified, taskText };
  const projection = projectObjective(taskText);
  const projectionReasons = classified.action === "MANAGED"
    ? [envelope.unwrapped ? "PI_FILE_ENVELOPE_UNWRAPPED" : null, projection.projected ? "OBJECTIVE_PROJECTED" : null]
      .filter((entry): entry is string => entry !== null)
    : [];
  return {
    ...classified, objective: projection.objective, taskText,
    reasonCodes: [...classified.reasonCodes, ...projectionReasons],
  };
}

export function selectTaskFlowLane(objective: string): TaskFlowLane {
  if (productOrArchitecture.test(objective) || riskyOrIrreversible.test(objective) || ambiguity.test(objective)) return "ADAPTIVE_ROUTE";
  return boundedTarget.test(objective) && verification.test(objective) ? "DIRECT_CELL" : "ADAPTIVE_ROUTE";
}

export function requiresWorkspaceMutation(objective: string): boolean {
  const normalized = objective.normalize("NFC").trim();
  return normalized.length > 0 && !explicitNoMutation.test(normalized) && workspaceMutation.test(normalized);
}

export function mayUseDirectCell(input: {
  readonly lane: TaskFlowLane;
  readonly boundedScope: boolean;
  readonly oracleKnown: boolean;
  readonly reversible: boolean;
  readonly materialDecisionOpen: boolean;
  readonly migrationOrExternalEffect: boolean;
  readonly workCellCount: number;
}): boolean {
  return input.lane === "DIRECT_CELL" && input.boundedScope && input.oracleKnown && input.reversible
    && !input.materialDecisionOpen && !input.migrationOrExternalEffect && input.workCellCount === 1;
}
