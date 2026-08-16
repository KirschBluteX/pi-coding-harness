import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { StoredEffectClass } from "../authority/repositories/effects.js";
import { sha256Hex } from "../foundation/crypto.js";

export interface ToolInvocation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export interface NormalizedEffect {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly effectClass: StoredEffectClass;
  readonly normalizedTarget: string;
  readonly normalizedTargetSha256: string;
  readonly normalizedPayloadSha256: string;
  readonly semanticPayloadSha256: string;
  readonly failureClassSha256: string;
  readonly actionSpec: Readonly<Record<string, unknown>>;
  readonly specSha256: string;
  readonly withinWorkspace: boolean;
  readonly classificationReason: string;
  readonly normalizedTargets?: readonly string[];
}

const readTools = new Set(["read", "grep", "find", "ls"]);
const writeTools = new Set(["write", "edit"]);
const pathKeys = ["path", "file_path", "filePath", "target", "destination"];
const readOnlyShell = /^(?:rg|grep|find|ls|dir|pwd|wc(?:\.exe)?|git\s+(?:status|diff|show|log|describe)|get-content|get-childitem|select-string|resolve-path|test-path|node\s+--version|go(?:\.exe)?\s+version)(?:\s|$)/iu;
const validationBinary = "eslint|tsc|vitest|jest|mocha|karma|prettier|esbuild|microbundle";
const localValidationShell = new RegExp(
  `^(?:npm(?:\\.cmd)?\\s+(?:test|run\\s+(?:test|lint|build|verify|check|typecheck|bench(?:mark)?)(?::[a-z0-9_.-]+)*)|npx(?:\\.cmd)?\\s+--no-install\\s+(?:${validationBinary})|(?:\\.[\\\\/])?node_modules[\\\\/]\\.bin[\\\\/](?:${validationBinary})(?:\\.cmd)?)(?:\\s|$)`,
  "iu",
);
const goTestShell = /^go(?:\.exe)?\s+test(?:\s|$)/iu;
const localGoPackage = /^(?:\.|\.\/(?!\.\.(?:\/|$))[a-z0-9_./-]+)$/iu;
const safeGoTestFlag = /^-(?:count=[1-9][0-9]*|timeout=[1-9][0-9]*(?:ns|us|µs|ms|s|m|h)|run=[a-z0-9_./^$*+?()[\]{}-]+|parallel=[1-9][0-9]*|vet=(?:off|all)|short|failfast|race|v)$/iu;
const npmExec = /^npm(?:\.cmd)?\s+(?:exec|x)(?:\s|$)/iu;
const localBuildBinary = /^(?:(?:\.[\\/])?node_modules[\\/]\.bin[\\/]|npx(?:\.cmd)?\s+--no-install\s+)(?:esbuild|microbundle)(?:\.cmd)?(?:\s|$)/iu;
const longRunningBuildMode = /(?:^|\s)(?:--watch(?:=\S+)?|--serve(?:=\S+)?|-w)(?:\s|$)/iu;
const irreversibleShell = /(?:\brm\s+-rf\b|\bremove-item\b[^\r\n]*(?:-recurse|-force)|\bformat\b|\bgit\s+push\b[^\r\n]*--force|\bterraform\s+apply\b|\bkubectl\s+delete\b|\bDROP\s+(?:DATABASE|TABLE)\b)/iu;

export type LocalValidationCommandReasonCode =
  | "LOCAL_VALIDATION_ALLOWED"
  | "LOCAL_VALIDATION_EMPTY"
  | "LOCAL_VALIDATION_SHELL_COMPOSITION_DENIED"
  | "LOCAL_VALIDATION_NPM_EXEC_DENIED"
  | "LOCAL_VALIDATION_LONG_RUNNING_MODE_DENIED"
  | "LOCAL_VALIDATION_GO_TEST_ARGUMENT_DENIED"
  | "LOCAL_VALIDATION_GO_TEST_PACKAGE_DENIED"
  | "LOCAL_VALIDATION_PATH_DENIED"
  | "LOCAL_VALIDATION_COMMAND_NOT_ALLOWLISTED";

export interface LocalValidationCommandClassification {
  readonly allow: boolean;
  readonly reason_code: LocalValidationCommandReasonCode;
  readonly command: string;
  readonly local_build_binary: boolean;
}

function stringField(input: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function contained(cwd: string, target: string): boolean {
  const delta = relative(resolve(cwd), resolve(target));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function normalizePathTarget(cwd: string, candidate: string | null): { target: string; withinWorkspace: boolean } {
  const target = resolve(cwd, candidate ?? ".");
  return { target: target.replaceAll("\\", "/").normalize("NFC"), withinWorkspace: contained(cwd, target) };
}

function shellExpansionStarts(command: string, index: number): boolean {
  if (command[index] !== "$") return false;
  const next = command[index + 1] ?? "";
  return next === "(" || next === "{" || /[a-z0-9_?!#$*@-]/iu.test(next);
}

function splitSafeShellConjunction(command: string): string[] | null {
  if (/%[a-z_][a-z0-9_]*%/iu.test(command)) return null;
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\r" || character === "\n") return null;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      else if (character === "`" || shellExpansionStarts(command, index)) return null;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      const segment = command.slice(start, index).trim();
      if (!segment) return null;
      segments.push(segment);
      index += 1;
      start = index + 1;
      continue;
    }
    if (";&|<>`".includes(character) || shellExpansionStarts(command, index)) return null;
  }
  if (quote !== null || escaped) return null;
  const final = command.slice(start).trim();
  if (!final) return null;
  segments.push(final);
  return segments;
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let active = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const finish = (): void => {
    if (!active) return;
    words.push(word);
    word = "";
    active = false;
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      active = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      else word += character;
      active = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      active = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      active = true;
    } else if (/\s/u.test(character)) {
      finish();
    } else {
      word += character;
      active = true;
    }
  }
  if (quote !== null || escaped) return null;
  finish();
  return words;
}

function unsafeProbePathToken(token: string, cwd: string): boolean {
  const values = [token];
  const separator = token.indexOf("=");
  if (separator >= 0 && separator < token.length - 1) values.push(token.slice(separator + 1));
  return values.some((value) => /^(?:alias|cert|env|function|variable|wsman|hklm|hkcu):/iu.test(value)
    || value.startsWith("~")
    || /(^|[\\/])\.\.([\\/]|$)/u.test(value)
    || (isAbsolute(value) && !contained(cwd, value)));
}

function safeReadOnlyShellSegment(segment: string, cwd: string): boolean {
  if (!readOnlyShell.test(segment)) return false;
  const words = shellWords(segment);
  if (!words?.length || words.some((word) => unsafeProbePathToken(word, cwd))) return false;
  const executable = words[0]!.toLowerCase();
  const options = words.slice(1).map((word) => word.toLowerCase());
  if (executable === "find" && options.some((option) => /^(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-f(?:print|printf|ls))/u.test(option))) {
    return false;
  }
  if (executable === "rg" && options.some((option) => option === "--pre" || option.startsWith("--pre="))) return false;
  if (executable === "git" && options.some((option) => option === "--output" || option.startsWith("--output=")
    || option === "--ext-diff" || option === "--textconv")) return false;
  return true;
}

function isReadOnlyShellCommand(command: string, cwd: string): boolean {
  const segments = splitSafeShellConjunction(command.trim().normalize("NFC"));
  return segments !== null && segments.every((segment) => safeReadOnlyShellSegment(segment, cwd));
}

function exactReadGlobCandidate(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  pathCandidate: string | null,
): string | null {
  if (toolName !== "grep" || pathCandidate === null) return pathCandidate;
  const glob = stringField(input, ["glob"]);
  if (glob === null || isAbsolute(glob) || [..."*?[]{}!"].some((character) => glob.includes(character))
    || glob.split(/[\\/]/u).includes("..")) return pathCandidate;
  return join(pathCandidate, glob);
}

type LocalFormatter =
  | { readonly kind: "SINGLE"; readonly path: string }
  | { readonly kind: "MULTI"; readonly paths: readonly string[] }
  | { readonly kind: "COMPOSED" };

const maximumLocalFormatterTargets = 8;

function localFormatter(command: string): LocalFormatter | null {
  const segments = splitSafeShellConjunction(command.trim().normalize("NFC"));
  if (!segments?.length) return null;
  const words = shellWords(segments[0]!);
  if (!words || !/^gofmt(?:\.exe)?$/iu.test(words[0] ?? "")) return null;
  const flags = words.slice(1).filter((word) => word.startsWith("-"));
  const paths = [...new Set(words.slice(1).filter((word) => !word.startsWith("-")))];
  if (!flags.includes("-w") || flags.some((flag) => flag !== "-w" && flag !== "-s") || paths.length === 0) return null;
  if (paths.some((path) => isAbsolute(path) || path.split(/[\\/]/u).includes("..") || !/\.go$/iu.test(path))) return null;
  if (segments.length > 1) return { kind: "COMPOSED" };
  return paths.length === 1 ? { kind: "SINGLE", path: paths[0]! } : { kind: "MULTI", paths };
}

export function classifyLocalValidationCommand(command: string, cwd = resolve(".")): LocalValidationCommandClassification {
  const normalized = command.trim().normalize("NFC");
  const result = (allow: boolean, reasonCode: LocalValidationCommandReasonCode): LocalValidationCommandClassification => ({
    allow, reason_code: reasonCode, command: normalized, local_build_binary: localBuildBinary.test(normalized),
  });
  if (!normalized) return result(false, "LOCAL_VALIDATION_EMPTY");
  const segments = splitSafeShellConjunction(normalized);
  if (segments?.length !== 1) return result(false, "LOCAL_VALIDATION_SHELL_COMPOSITION_DENIED");
  if (npmExec.test(normalized)) return result(false, "LOCAL_VALIDATION_NPM_EXEC_DENIED");
  if (localBuildBinary.test(normalized) && longRunningBuildMode.test(normalized)) {
    return result(false, "LOCAL_VALIDATION_LONG_RUNNING_MODE_DENIED");
  }
  if (goTestShell.test(normalized)) {
    const args = normalized.split(/\s+/u).slice(2);
    const flags = args.filter((value) => value.startsWith("-"));
    if (flags.some((value) => !safeGoTestFlag.test(value))) {
      return result(false, "LOCAL_VALIDATION_GO_TEST_ARGUMENT_DENIED");
    }
    const packages = args.filter((value) => !value.startsWith("-"));
    if (packages.length > 8 || packages.some((value) => !localGoPackage.test(value) || value.split("/").includes(".."))) {
      return result(false, "LOCAL_VALIDATION_GO_TEST_PACKAGE_DENIED");
    }
    return result(true, "LOCAL_VALIDATION_ALLOWED");
  }
  const words = shellWords(normalized);
  if (!words?.length || words.some((word) => unsafeProbePathToken(word, cwd))) {
    return result(false, "LOCAL_VALIDATION_PATH_DENIED");
  }
  if (!localValidationShell.test(normalized)) return result(false, "LOCAL_VALIDATION_COMMAND_NOT_ALLOWLISTED");
  return result(true, "LOCAL_VALIDATION_ALLOWED");
}

export function isSupportedLocalValidationCommand(command: string): boolean {
  return classifyLocalValidationCommand(command).allow;
}

function shellFailureClass(command: string, classificationReason: string): string {
  const value = command.trim().normalize("NFC");
  if (/^go(?:\.exe)?\s+test(?:\s|$)/iu.test(value)) return "GO_TEST";
  if (/^npm(?:\.cmd)?\s+test(?:\s|$)/iu.test(value)) return "NPM_TEST";
  const npmRun = /^npm(?:\.cmd)?\s+run\s+([a-z0-9_.:-]+)/iu.exec(value);
  if (npmRun) return `NPM_RUN:${npmRun[1]?.toLowerCase() ?? "unknown"}`;
  const npx = /^npx(?:\.cmd)?\s+--no-install\s+([a-z0-9_.-]+)/iu.exec(value);
  if (npx) return `NPX_NO_INSTALL:${npx[1]?.toLowerCase() ?? "unknown"}`;
  const local = /^(?:\.[\\/])?node_modules[\\/]\.bin[\\/]([a-z0-9_.-]+)/iu.exec(value);
  if (local) return `LOCAL_BIN:${local[1]?.toLowerCase().replace(/\.cmd$/u, "") ?? "unknown"}`;
  return classificationReason;
}

export function normalizeToolEffect(invocation: ToolInvocation): NormalizedEffect {
  const toolName = invocation.toolName.trim().toLowerCase();
  const command = stringField(invocation.input, ["command"]);
  const formatter = toolName === "bash" && command ? localFormatter(command) : null;
  const formatterTargets = formatter?.kind === "MULTI"
    ? formatter.paths.map((path) => normalizePathTarget(invocation.cwd, path)) : [];
  const declaredPathCandidate = stringField(invocation.input, pathKeys);
  const pathCandidate = formatter?.kind === "SINGLE"
    ? formatter.path
    : exactReadGlobCandidate(toolName, invocation.input, declaredPathCandidate);
  let effectClass: StoredEffectClass;
  let classificationReason: string;
  if (readTools.has(toolName)) {
    effectClass = "READ_ONLY";
    classificationReason = "BUILTIN_READ_TOOL";
  } else if (writeTools.has(toolName) || (toolName === "coding_integrate" && pathCandidate !== null
    && ["CREATE", "MODIFY", "DELETE"].includes(String(invocation.input.operation)))) {
    effectClass = "LOCAL_REVERSIBLE_WRITE";
    classificationReason = toolName === "coding_integrate" ? "HARNESS_DETERMINISTIC_INTEGRATION" : "BUILTIN_FILE_WRITE";
  } else if (toolName === "bash" && command && irreversibleShell.test(command)) {
    effectClass = "IRREVERSIBLE";
    classificationReason = "IRREVERSIBLE_SHELL_SIGNATURE";
  } else if (formatter?.kind === "SINGLE") {
    effectClass = "LOCAL_REVERSIBLE_WRITE";
    classificationReason = "ALLOWLISTED_LOCAL_FORMATTER";
  } else if (formatter?.kind === "MULTI" && formatterTargets.length <= maximumLocalFormatterTargets
    && formatterTargets.every((target) => target.withinWorkspace)) {
    effectClass = "LOCAL_REVERSIBLE_WRITE";
    classificationReason = "ALLOWLISTED_LOCAL_FORMATTER_BATCH";
  } else if (formatter?.kind === "MULTI") {
    effectClass = "EXTERNAL_UNKNOWN_WRITE";
    classificationReason = "OVERSIZED_LOCAL_FORMATTER_BATCH";
  } else if (formatter?.kind === "COMPOSED") {
    effectClass = "EXTERNAL_UNKNOWN_WRITE";
    classificationReason = "COMPOSED_LOCAL_FORMATTER";
  } else if (toolName === "bash" && command && isReadOnlyShellCommand(command, invocation.cwd)) {
    effectClass = "READ_ONLY";
    classificationReason = "ALLOWLISTED_LOCAL_PROBE";
  } else if (toolName === "bash" && command && classifyLocalValidationCommand(command, invocation.cwd).allow) {
    effectClass = "LOCAL_REVERSIBLE_WRITE";
    classificationReason = "ALLOWLISTED_LOCAL_VALIDATION";
  } else {
    effectClass = "EXTERNAL_UNKNOWN_WRITE";
    classificationReason = toolName === "bash" ? "UNCLASSIFIED_SHELL" : "UNCLASSIFIED_CUSTOM_TOOL";
  }
  const pathTarget = normalizePathTarget(invocation.cwd, pathCandidate);
  const normalizedTargets = formatter?.kind === "MULTI" && classificationReason === "ALLOWLISTED_LOCAL_FORMATTER_BATCH"
    ? formatterTargets.map((target) => target.target) : undefined;
  const normalizedTarget = normalizedTargets
    ? `bash:gofmt-batch:${canonicalJsonSha256(normalizedTargets)}`
    : pathCandidate === null
    ? readTools.has(toolName) ? pathTarget.target
      : `${toolName}:${command ? sha256Hex(command.normalize("NFC")) : "opaque"}`
    : pathTarget.target;
  const payloadProjection = {
    input_sha256: canonicalJsonSha256(invocation.input),
    tool_call_id: invocation.toolCallId,
    tool_name: toolName,
  };
  const semanticPayloadSha256 = canonicalJsonSha256({ input: invocation.input, tool_name: toolName });
  const failureClassSha256 = canonicalJsonSha256({
    classification_reason: classificationReason,
    command_class: toolName === "bash" && command ? shellFailureClass(command, classificationReason) : null,
    target_sha256: writeTools.has(toolName) || formatter?.kind === "SINGLE" ? sha256Hex(normalizedTarget) : null,
    target_set_sha256: normalizedTargets ? canonicalJsonSha256(normalizedTargets.map((target) => sha256Hex(target))) : null,
    tool_name: toolName,
  });
  const actionSpec = {
    classification_reason: classificationReason,
    normalized_target_sha256: sha256Hex(normalizedTarget),
    ...(normalizedTargets ? { normalized_target_sha256s: normalizedTargets.map((target) => sha256Hex(target)) } : {}),
    outcome_evidence: classificationReason === "ALLOWLISTED_LOCAL_VALIDATION" ? "TOOL_EXIT_AND_RESULT" : "TARGET_READBACK",
    tool_name: toolName,
    ...(toolName === "coding_integrate" ? { operation: invocation.input.operation } : {}),
  };
  return {
    toolCallId: invocation.toolCallId,
    toolName,
    effectClass,
    normalizedTarget,
    normalizedTargetSha256: sha256Hex(normalizedTarget),
    normalizedPayloadSha256: canonicalJsonSha256(payloadProjection),
    semanticPayloadSha256,
    failureClassSha256,
    actionSpec,
    specSha256: sha256Hex(canonicalJson(actionSpec)),
    withinWorkspace: normalizedTargets ? formatterTargets.every((target) => target.withinWorkspace)
      : pathCandidate === null || pathTarget.withinWorkspace,
    classificationReason,
    ...(normalizedTargets ? { normalizedTargets } : {}),
  };
}
