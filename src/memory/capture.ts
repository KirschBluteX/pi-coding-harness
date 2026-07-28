import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { classifyMemorySecurityRisk } from "./security.js";
import type { MemoryChannel, MemoryClassification, MemoryScope, TypedPolicy } from "./types.js";
import type { MemoryCaptureCommandResult } from "../authority/repositories/memory-v3.js";
import {
  explicitUserMemoryBody, hasWeakUserMemoryPreference, legacyUserMemoryBody,
} from "./capture-signal.js";

export type MemoryCaptureMode = "MANUAL_CAPTURE" | "GUARDED_AUTO";
export type MemoryCaptureRoute = "EXPLICIT_AUTO" | "AUTHORITY_DERIVED" | "PROPOSE_ONLY" | "REJECT";
export type MemoryCaptureActor = "USER" | "AGENT" | "RUNTIME";
export type MemoryCaptureSourceKind = "USER_INPUT" | "AUTHORITY_DECISION" | "ROUTE_FAILURE" | "AGENT_PROPOSAL";
export type CurrentIntentDisposition = "MEMORY_ELIGIBLE" | "REQUIREMENT_FIRST" | "PLAN_FIRST" | "UNCERTAIN_PROPOSE";
export type MemoryPolicyOperator = "PREFER" | "AVOID" | "REQUIRE" | "FORBID" | "SET";

export interface StructuredMemoryPolicy extends TypedPolicy {
  readonly semanticKey: string;
  readonly operator: MemoryPolicyOperator;
  readonly value: string;
}

export interface MemoryCaptureCandidate {
  readonly workspaceId: string;
  readonly goalId: string | null;
  readonly text: string;
  readonly sourceKind: MemoryCaptureSourceKind;
  readonly sourceActor: MemoryCaptureActor;
  readonly decisionActor: "RUNTIME";
  readonly sourceLocator: string;
  readonly scope?: MemoryScope;
  readonly channel?: MemoryChannel;
  readonly classification?: MemoryClassification;
  readonly intentOwnership?: "NONE" | "GOAL_INTAKE" | "REQUIREMENT_REVISION" | "PLAN_REVISION" | "ACTIVE_BUILD";
  readonly authorityVerified?: boolean;
  readonly userDecisionReceipt?: boolean;
  readonly failureSignatureSha256?: string | null;
  readonly sourceSessionHmac?: string | null;
  readonly observedAtMs?: number;
  readonly authorityContextSha256?: string | null;
  readonly identityHmacKey?: Uint8Array;
  readonly maxBytes?: number;
}

export interface MemoryCaptureDecision {
  readonly route: MemoryCaptureRoute;
  readonly disposition: CurrentIntentDisposition;
  readonly reasonCodes: readonly string[];
  readonly workspaceId: string;
  readonly goalId: string | null;
  readonly sourceKind: MemoryCaptureSourceKind;
  readonly sourceActor: MemoryCaptureActor;
  readonly decisionActor: "RUNTIME";
  readonly scope: MemoryScope;
  readonly channel: MemoryChannel;
  readonly classification: MemoryClassification;
  readonly candidateSha256: string;
  readonly sourceLocatorSha256: string;
  readonly sourceContentSha256: string;
  readonly sourceSessionHmac: string | null;
  readonly sourceDayBucket: number;
  readonly conceptSha256: string | null;
  readonly authorityContextSha256: string | null;
  readonly semanticKeySha256: string | null;
  readonly valueSha256: string | null;
  readonly normalizedText: string | null;
  readonly policy: StructuredMemoryPolicy | null;
  readonly additionalModelRequests: 0;
}

const temporaryScopePattern = /(?:仅|只)?(?:本次|这次|此次|本轮|这一轮|当前(?:任务|请求|阶段|文件)|今天|现在)|暂时|临时|这一个任务|这个请求/u;
const taskActionPattern = /(?:请|需要|帮我|直接)?(?:检查|审查|分析|修改|修复|实现|删除|创建|重命名|运行|测试|提交|安装|迁移)(?:一下|这个|当前|本次|文件|代码)?/u;
const requirementPattern = /(?:验收(?:标准)?|范围|非目标|用户流程|需求(?:变更)?|行为变更)/u;
const planPattern = /(?:修改|调整|重做|重构|更新|生成).{0,10}(?:架构|迁移|阶段|依赖|技术路线|计划|蓝图)|(?:架构|迁移|阶段|依赖|技术路线|计划|蓝图).{0,10}(?:修改|调整|重做|重构|更新|生成)/u;
const anchoredGoalPattern = /^\s*(?:plan|build)\s*:/iu;
const negatedCapturePattern = /(?:不要|无需|不用|别)(?:再|替我|帮我)?\s*(?:记住|记下|保存)|(?:删除|忘掉|清除).{0,8}(?:记忆|偏好)/u;
const quotedOrHypotheticalPattern = /(?:如果|假如|假设|例如|比如|设想|有人说|他说|她说|文档(?:中)?写(?:着|道)?).{0,24}(?:记住|偏好|习惯)|[“『「"'][^”』」"']{0,80}(?:记住|偏好|习惯)[^”』」"']{0,80}[”』」"']/u;
const captureQuestionPattern = /(?:是否|能否|可否|可不可以|要不要|会不会).{0,12}(?:记住|记下|保存)|(?:记住|记下|保存).{0,12}(?:吗|么)[？?]?$/u;
const workspaceScopePattern = /(?:所有|任意|每个)(?:代码)?项目|跨项目|全局(?:偏好|习惯|规则)|今后(?:的)?所有项目/u;
const goalScopePattern = /(?:当前|这个|本|该)(?:代码)?项目|在此项目(?:中|内)?/u;
const shaPattern = /^[a-f0-9]{64}$/iu;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function memoryPolicySemantics(statement: string): StructuredMemoryPolicy {
  const variants: Array<{ pattern: RegExp; operator: MemoryPolicyOperator }> = [
    { pattern: /^\s*(?:do\s+not|don't|never)\s+/iu, operator: "FORBID" },
    { pattern: /^\s*(?:avoid)\s+/iu, operator: "AVOID" },
    { pattern: /^\s*(?:must|always)\s+/iu, operator: "REQUIRE" },
    { pattern: /^\s*(?:prefer)\s+/iu, operator: "PREFER" },
    { pattern: /^\s*(?:我)?(?:不要|禁止|绝不)\s*/u, operator: "FORBID" },
    { pattern: /^\s*(?:我)?(?:避免)\s*/u, operator: "AVOID" },
    { pattern: /^\s*(?:我)?(?:必须|始终|总是)\s*/u, operator: "REQUIRE" },
    { pattern: /^\s*(?:我(?:(?:一直|通常|一贯|总是)\s*)?(?:更)?|我的长期)?(?:偏好|喜欢|习惯|倾向于|优先(?:选择)?)\s*(?:是|为|：|:)?\s*/u, operator: "PREFER" },
  ];
  let operator: MemoryPolicyOperator = "SET";
  let subject = statement;
  for (const variant of variants) {
    if (!variant.pattern.test(statement)) continue;
    operator = variant.operator;
    subject = statement.replace(variant.pattern, "").trim();
    break;
  }
  const semanticSubject = normalize(subject)
    .replace(/[，。！？；：,.!?;:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim().toLowerCase() || normalize(statement).toLowerCase();
  return {
    type: "TYPED_POLICY",
    policyKind: operator === "REQUIRE" || operator === "FORBID" ? "CONSTRAINT" : "PREFERENCE",
    semanticKey: `policy.${sha256Hex(semanticSubject).slice(0, 32)}`,
    operator,
    value: semanticSubject,
    statement,
    appliesTo: [],
  };
}

export function memoryCaptureConceptSha256(
  policy: StructuredMemoryPolicy | null,
  channel: MemoryChannel,
  scope: MemoryScope,
  goalId: string | null,
  failureSignatureSha256: string | null,
  identityHmacKey?: Uint8Array,
): string | null {
  const proposition = policy ? canonicalJson({
    domain: "PCH-MEMORY-V3.1-EXACT-PROPOSITION-V2",
    channel,
    scope,
    scopeGoalId: scope === "GOAL" ? goalId : null,
    semanticKey: policy.semanticKey,
    operator: policy.operator,
    value: policy.value,
    appliesTo: [...policy.appliesTo].map((entry) => normalize(entry).toLowerCase()).sort(),
  }) : failureSignatureSha256 && shaPattern.test(failureSignatureSha256)
    ? canonicalJson({
      domain: "PCH-MEMORY-V3.1-EXACT-FAILURE-PROPOSITION-V2",
      channel,
      scope,
      scopeGoalId: scope === "GOAL" ? goalId : null,
      failureSignatureSha256: failureSignatureSha256.toLowerCase(),
    }) : null;
  if (proposition === null) return null;
  return identityHmacKey && identityHmacKey.byteLength >= 16
    ? hmacSha256Hex(identityHmacKey, proposition)
    : sha256Hex(proposition);
}

function disposition(candidate: MemoryCaptureCandidate, text: string, explicit: boolean): CurrentIntentDisposition {
  const weakPreference = !explicit && hasWeakUserMemoryPreference(text);
  if (candidate.intentOwnership === "GOAL_INTAKE" || anchoredGoalPattern.test(candidate.text)) return "REQUIREMENT_FIRST";
  if (candidate.intentOwnership === "REQUIREMENT_REVISION") return "REQUIREMENT_FIRST";
  if (candidate.intentOwnership === "PLAN_REVISION") return "PLAN_FIRST";
  if (temporaryScopePattern.test(text) && (explicit || weakPreference)) {
    return explicit ? "UNCERTAIN_PROPOSE" : "REQUIREMENT_FIRST";
  }
  if (candidate.intentOwnership === "ACTIVE_BUILD" && taskActionPattern.test(text)) return explicit ? "UNCERTAIN_PROPOSE" : "PLAN_FIRST";
  if (!explicit && !weakPreference && requirementPattern.test(text)) return "REQUIREMENT_FIRST";
  if (!explicit && !weakPreference && planPattern.test(text)) return "PLAN_FIRST";
  if (!explicit && !weakPreference && taskActionPattern.test(text)) return "REQUIREMENT_FIRST";
  return "MEMORY_ELIGIBLE";
}

function decision(
  candidate: MemoryCaptureCandidate,
  route: MemoryCaptureRoute,
  current: CurrentIntentDisposition,
  reasons: readonly string[],
  normalizedText: string | null,
  policy: StructuredMemoryPolicy | null,
): MemoryCaptureDecision {
  const sourceLocatorSha256 = sha256Hex(normalize(candidate.sourceLocator));
  const sourceContentSha256 = sha256Hex(normalizedText ?? normalize(candidate.text));
  const scopeText = normalizedText ?? normalize(candidate.text);
  const scope = candidate.scope ?? (workspaceScopePattern.test(scopeText) ? "WORKSPACE"
    : goalScopePattern.test(scopeText) && candidate.goalId ? "GOAL"
      : candidate.goalId ? "GOAL" : "WORKSPACE");
  const channel = candidate.channel ?? (candidate.sourceKind === "ROUTE_FAILURE" ? "EXPERIENCE" : "POLICY");
  const semanticKeySha256 = policy ? sha256Hex(policy.semanticKey) : null;
  const valueSha256 = policy ? sha256Hex(policy.value) : null;
  const sourceSessionHmac = candidate.sourceSessionHmac && shaPattern.test(candidate.sourceSessionHmac)
    ? candidate.sourceSessionHmac.toLowerCase() : null;
  const observedAtMs = candidate.observedAtMs ?? 0;
  const sourceDayBucket = Number.isSafeInteger(observedAtMs) && observedAtMs >= 0
    ? Math.floor(observedAtMs / 86_400_000) : 0;
  const conceptSha256 = memoryCaptureConceptSha256(
    policy,
    channel,
    scope,
    candidate.goalId,
    candidate.failureSignatureSha256 ?? null,
    candidate.identityHmacKey,
  );
  const authorityContextSha256 = candidate.authorityContextSha256 && shaPattern.test(candidate.authorityContextSha256)
    ? candidate.authorityContextSha256.toLowerCase() : null;
  const candidateSha256 = canonicalJsonSha256({
    domain: "PCH-MEMORY-CAPTURE-CANDIDATE-V3",
    workspaceId: candidate.workspaceId, goalId: candidate.goalId, sourceKind: candidate.sourceKind,
    sourceActor: candidate.sourceActor, sourceLocatorSha256, sourceContentSha256, scope, channel,
    classification: candidate.classification ?? "INTERNAL", semanticKeySha256, valueSha256,
    failureSignatureSha256: candidate.failureSignatureSha256 ?? null, sourceSessionHmac, sourceDayBucket,
    authorityContextSha256, conceptSha256,
    nonUserSourceLocatorSha256: candidate.sourceKind === "USER_INPUT" ? null : sourceLocatorSha256,
  });
  return {
    route, disposition: current, reasonCodes: [...reasons], workspaceId: candidate.workspaceId,
    goalId: candidate.goalId, sourceKind: candidate.sourceKind, sourceActor: candidate.sourceActor,
    decisionActor: "RUNTIME", scope, channel, classification: candidate.classification ?? "INTERNAL",
    candidateSha256, sourceLocatorSha256, sourceContentSha256, sourceSessionHmac, sourceDayBucket,
    conceptSha256, authorityContextSha256, semanticKeySha256, valueSha256,
    normalizedText, policy, additionalModelRequests: 0,
  };
}

export function classifyMemoryCapture(candidate: MemoryCaptureCandidate): MemoryCaptureDecision {
  const maximum = candidate.maxBytes ?? 16_384;
  const raw = normalize(candidate.text);
  if (!candidate.workspaceId || !candidate.sourceLocator || !raw) {
    return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["INVALID_OR_EMPTY_CANDIDATE"], null, null);
  }
  if (Buffer.byteLength(raw, "utf8") > maximum) {
    return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["CANDIDATE_OVERSIZE"], null, null);
  }
  const risk = classifyMemorySecurityRisk(raw);
  if (risk) return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", [risk], null, null);

  if (candidate.sourceKind === "ROUTE_FAILURE") {
    const verified = candidate.authorityVerified === true
      && typeof candidate.failureSignatureSha256 === "string" && shaPattern.test(candidate.failureSignatureSha256);
    return verified
      ? decision(candidate, "PROPOSE_ONLY", "UNCERTAIN_PROPOSE", ["VERIFIED_ROUTE_FAILURE_REQUIRES_REVIEW"], raw, null)
      : decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["UNVERIFIED_AUTHORITY_SOURCE"], null, null);
  }
  if (candidate.sourceKind === "AUTHORITY_DECISION") {
    if (candidate.authorityVerified !== true || candidate.userDecisionReceipt !== true) {
      return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["UNVERIFIED_OR_NON_USER_DECISION"], null, null);
    }
    const policy = memoryPolicySemantics(raw);
    return decision(candidate, "AUTHORITY_DERIVED", "MEMORY_ELIGIBLE", ["VERIFIED_USER_DECISION"], raw, policy);
  }
  if (candidate.sourceKind === "AGENT_PROPOSAL" || candidate.sourceActor === "AGENT") {
    return decision(candidate, "PROPOSE_ONLY", "UNCERTAIN_PROPOSE", ["MODEL_ORIGIN_REQUIRES_APPROVAL"], raw, memoryPolicySemantics(raw));
  }

  if (negatedCapturePattern.test(raw) || quotedOrHypotheticalPattern.test(raw) || captureQuestionPattern.test(raw)) {
    return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["NON_ASSERTED_MEMORY_TEXT"], null, null);
  }

  const body = explicitUserMemoryBody(raw);
  const legacyBody = body === null ? legacyUserMemoryBody(raw) : null;
  const current = disposition(candidate, body ?? raw, body !== null);
  if (current !== "MEMORY_ELIGIBLE") {
    const route = body !== null && current === "UNCERTAIN_PROPOSE" ? "PROPOSE_ONLY" : "REJECT";
    return decision(candidate, route, current, [current], route === "PROPOSE_ONLY" ? body : null,
      route === "PROPOSE_ONLY" && body ? memoryPolicySemantics(body) : null);
  }
  if (body === null) {
    if (legacyBody !== null) {
      return decision(candidate, "PROPOSE_ONLY", "UNCERTAIN_PROPOSE", ["LEGACY_NON_CHINESE_REQUIRES_APPROVAL"],
        legacyBody, memoryPolicySemantics(legacyBody));
    }
    if (hasWeakUserMemoryPreference(raw)) {
      return decision(candidate, "PROPOSE_ONLY", "UNCERTAIN_PROPOSE", ["IMPLICIT_DURABLE_SIGNAL_REQUIRES_EVIDENCE"],
        raw, memoryPolicySemantics(raw));
    }
    return decision(candidate, "REJECT", "MEMORY_ELIGIBLE", ["NO_DURABLE_MEMORY_SIGNAL"], null, null);
  }
  return decision(candidate, "EXPLICIT_AUTO", "MEMORY_ELIGIBLE", ["EXPLICIT_DURABLE_USER_DIRECTIVE"], body, memoryPolicySemantics(body));
}

export interface MemoryCaptureAuthority {
  recordMemoryCaptureDecision(
    decision: MemoryCaptureDecision,
    idempotencyKey: string,
  ): MemoryCaptureCommandResult;
}

export interface MemoryCaptureSinkResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly record: { readonly claimId: string; readonly version: number } | null;
  readonly additionalModelRequests: 0;
  readonly captureAuthorityResult?: MemoryCaptureCommandResult | null;
}

export interface MemoryCaptureSink {
  storeCapture(decision: MemoryCaptureDecision, idempotencyKey: string): MemoryCaptureSinkResult;
}

export interface MemoryCaptureObservation {
  readonly decision: MemoryCaptureDecision | null;
  readonly recorded: boolean;
  readonly authorityResult: MemoryCaptureCommandResult | null;
  readonly storageResult: MemoryCaptureSinkResult | null;
  readonly reason: "CAPTURE_MODE_MANUAL" | "CAPTURE_CIRCUIT_OPEN" | "SECURITY_REJECT_NOT_RECORDED"
    | "LOW_VALUE_REJECT_NOT_RECORDED" | "RECORDED" | "CAPTURE_STORAGE_FAILED";
  readonly additionalModelRequests: 0;
}

export interface MemoryCaptureTelemetrySnapshot {
  readonly observed: number;
  readonly recorded: number;
  readonly proposed: number;
  readonly rejected: number;
  readonly securityRejected: number;
  readonly storageFailures: number;
  readonly idempotentReuses: number;
  readonly latencyMicrosTotal: number;
  readonly latencyMicrosMax: number;
}

function emptyCaptureTelemetry(): MemoryCaptureTelemetrySnapshot {
  return {
    observed: 0, recorded: 0, proposed: 0, rejected: 0, securityRejected: 0,
    storageFailures: 0, idempotentReuses: 0, latencyMicrosTotal: 0, latencyMicrosMax: 0,
  };
}

export class MemoryCaptureCoordinator {
  private circuitReason: string | null = null;
  private telemetryValue: MemoryCaptureTelemetrySnapshot = emptyCaptureTelemetry();

  constructor(
    private readonly authority: MemoryCaptureAuthority,
    private readonly mode: MemoryCaptureMode,
    private readonly epoch: string,
    private readonly sink?: MemoryCaptureSink,
    private readonly identityHmacKey?: Uint8Array,
  ) {
    if (!epoch) throw new TypeError("Memory capture epoch is required");
    if (mode === "GUARDED_AUTO" && (!identityHmacKey || identityHmacKey.byteLength < 16)) {
      throw new TypeError("Guarded Memory capture requires a workspace identity HMAC key");
    }
  }

  observe(candidate: MemoryCaptureCandidate): MemoryCaptureObservation {
    const started = performance.now();
    if (this.mode !== "GUARDED_AUTO") {
      return this.finish({ decision: null, recorded: false, authorityResult: null, storageResult: null,
        reason: "CAPTURE_MODE_MANUAL", additionalModelRequests: 0 }, started);
    }
    if (this.circuitReason !== null) {
      return this.finish({ decision: null, recorded: false, authorityResult: null, storageResult: null,
        reason: "CAPTURE_CIRCUIT_OPEN", additionalModelRequests: 0 }, started);
    }
    const capture = classifyMemoryCapture({
      ...candidate,
      ...(this.identityHmacKey ? { identityHmacKey: this.identityHmacKey } : {}),
    });
    if (capture.reasonCodes.some((reason) => reason === "SENSITIVE_MATERIAL_REJECTED" || reason === "PROMPT_INJECTION_RISK_REJECTED")) {
      return this.finish({ decision: capture, recorded: false, authorityResult: null, storageResult: null,
        reason: "SECURITY_REJECT_NOT_RECORDED", additionalModelRequests: 0 }, started);
    }
    if (capture.route === "REJECT") {
      return this.finish({ decision: capture, recorded: false, authorityResult: null, storageResult: null,
        reason: "LOW_VALUE_REJECT_NOT_RECORDED", additionalModelRequests: 0 }, started);
    }
    const idempotencyKey = `capture:${this.epoch}:${capture.candidateSha256}:${capture.route}`;
    try {
      const storageResult = this.sink?.storeCapture(capture, idempotencyKey) ?? null;
      const authorityResult = this.sink
        ? storageResult?.captureAuthorityResult ?? null
        : this.authority.recordMemoryCaptureDecision(capture, idempotencyKey);
      if (storageResult && !storageResult.accepted) {
        this.circuitReason = storageResult.reason;
        return this.finish({ decision: capture, recorded: authorityResult !== null, authorityResult, storageResult,
          reason: "CAPTURE_STORAGE_FAILED", additionalModelRequests: 0 }, started);
      }
      return this.finish({ decision: capture, recorded: authorityResult !== null, authorityResult, storageResult,
        reason: "RECORDED", additionalModelRequests: 0 }, started);
    } catch (error) {
      this.circuitReason = error instanceof Error ? error.message : "UNKNOWN_CAPTURE_FAILURE";
      return this.finish({ decision: capture, recorded: false, authorityResult: null, storageResult: null,
        reason: "CAPTURE_STORAGE_FAILED", additionalModelRequests: 0 }, started);
    }
  }

  status(): {
    readonly mode: MemoryCaptureMode;
    readonly circuit: "CLOSED" | "OPEN";
    readonly reason: string | null;
    readonly telemetry: MemoryCaptureTelemetrySnapshot;
  } {
    return {
      mode: this.mode,
      circuit: this.circuitReason === null ? "CLOSED" : "OPEN",
      reason: this.circuitReason,
      telemetry: { ...this.telemetryValue },
    };
  }

  private finish(observation: MemoryCaptureObservation, started: number): MemoryCaptureObservation {
    const latencyMicros = Math.max(0, Math.ceil((performance.now() - started) * 1_000));
    const current = this.telemetryValue;
    this.telemetryValue = {
      observed: current.observed + 1,
      recorded: current.recorded + Number(observation.recorded),
      proposed: current.proposed + Number(observation.decision?.route === "PROPOSE_ONLY"),
      rejected: current.rejected + Number(observation.decision?.route === "REJECT"),
      securityRejected: current.securityRejected + Number(observation.reason === "SECURITY_REJECT_NOT_RECORDED"),
      storageFailures: current.storageFailures + Number(observation.reason === "CAPTURE_STORAGE_FAILED"),
      idempotentReuses: current.idempotentReuses + Number(observation.authorityResult?.reused === true),
      latencyMicrosTotal: current.latencyMicrosTotal + latencyMicros,
      latencyMicrosMax: Math.max(current.latencyMicrosMax, latencyMicros),
    };
    return observation;
  }
}
