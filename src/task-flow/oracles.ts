import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { classifyLocalValidationCommand, type LocalValidationCommandClassification } from "../effects/normalize.js";
import type { TaskObligationRecord } from "./domain.js";

function normalizedCommand(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().normalize("NFC") : null;
}

function commandPreview(command: string): string {
  const normalized = command.replace(/[\r\n\t]+/gu, " ").trim();
  return JSON.stringify(normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`);
}

function unsupportedCommandMessage(
  label: string,
  command: string,
  classification: LocalValidationCommandClassification,
): string {
  const prefix = `${label} rejects ${commandPreview(command)}`;
  if (classification.reason_code === "LOCAL_VALIDATION_SHELL_COMPOSITION_DENIED") {
    return `${prefix}: shell composition is forbidden. Put each independently allowed command in oracle.commands[] instead of using &&, ;, pipes or redirects.`;
  }
  if (classification.reason_code === "LOCAL_VALIDATION_NPM_EXEC_DENIED") {
    return `${prefix}: npm exec may install a package or access the network. Use an existing npm test or npm run test|lint|build|verify|check|typecheck|bench:* script, or call an installed allowlisted node_modules/.bin binary directly. oracle.commands[] only separates commands; it does not expand the executable allowlist.`;
  }
  if (classification.reason_code === "LOCAL_VALIDATION_LONG_RUNNING_MODE_DENIED") {
    return `${prefix}: validation must terminate, so --watch, --serve and -w modes are forbidden.`;
  }
  if (classification.reason_code === "LOCAL_VALIDATION_GO_TEST_ARGUMENT_DENIED") {
    return `${prefix}: go test allows only local package selectors and bounded flags (-run=, -count=, -timeout=, -parallel=, -vet=, -short, -failfast, -race or -v). Execution wrappers, overlays and output binaries are forbidden.`;
  }
  if (classification.reason_code === "LOCAL_VALIDATION_GO_TEST_PACKAGE_DENIED") {
    return `${prefix}: go test package selectors must be workspace-relative paths such as . or ./internal/package; remote module paths and parent traversal are forbidden.`;
  }
  return `${prefix}: it is not an allowlisted local validation command. Allowed forms are bounded local go test; npm test; npm run test|lint|build|verify|check|typecheck|bench:*; or npx --no-install/direct node_modules/.bin invocations of eslint, tsc, vitest, jest, mocha, karma, prettier, esbuild or microbundle. oracle.commands[] only separates commands; it does not expand the executable allowlist.`;
}

export function oracleCommands(oracle: Readonly<Record<string, unknown>>): readonly string[] {
  const command = normalizedCommand(oracle.command);
  const commands = Array.isArray(oracle.commands)
    ? oracle.commands.map(normalizedCommand).filter((value): value is string => value !== null) : [];
  return [...new Set(command ? [command, ...commands] : commands)];
}

export function assertExecutableOracle(label: string, oracle: Readonly<Record<string, unknown>>): void {
  if (oracle.command !== undefined && oracle.commands !== undefined) {
    throw new TypeError(`${label} must use command or commands, not both`);
  }
  if (oracle.command !== undefined && normalizedCommand(oracle.command) === null) {
    throw new TypeError(`${label}.command must be a non-empty string`);
  }
  if (oracle.commands !== undefined && (!Array.isArray(oracle.commands)
    || oracle.commands.length === 0
    || oracle.commands.some((command) => normalizedCommand(command) === null))) {
    throw new TypeError(`${label}.commands must be a non-empty array of non-empty strings`);
  }
  const commands = oracleCommands(oracle);
  const declaredCount = oracle.command === undefined ? (Array.isArray(oracle.commands) ? oracle.commands.length : 0) : 1;
  if (commands.length === 0) throw new TypeError(`${label} requires an executable local command`);
  if (commands.length !== declaredCount) throw new TypeError(`${label} contains duplicate commands`);
  for (const command of commands) {
    const classification = classifyLocalValidationCommand(command);
    if (!classification.allow) throw new TypeError(unsupportedCommandMessage(label, command, classification));
  }
}

export function workCellOracleCoversObligation(
  workCellOracle: Readonly<Record<string, unknown>>,
  obligation: TaskObligationRecord,
): boolean {
  if (canonicalJsonSha256(workCellOracle) === canonicalJsonSha256(obligation.oracle)) return true;
  const requiredCommands = oracleCommands(obligation.oracle);
  const providedCommands = new Set(oracleCommands(workCellOracle));
  if (requiredCommands.length > 0 && requiredCommands.every((command) => providedCommands.has(command))) return true;
  const mappings = workCellOracle.obligation_oracles;
  if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) return false;
  const mapped = (mappings as Readonly<Record<string, unknown>>)[obligation.semantic_key];
  return typeof mapped === "object" && mapped !== null && !Array.isArray(mapped)
    && canonicalJsonSha256(mapped) === canonicalJsonSha256(obligation.oracle);
}

export function assertWorkCellOracleCoverage(
  workCellKey: string,
  workCellOracle: Readonly<Record<string, unknown>>,
  obligations: readonly TaskObligationRecord[],
): void {
  const missing = obligations.filter((obligation) => !workCellOracleCoversObligation(workCellOracle, obligation));
  if (missing.length > 0) {
    throw new TypeError(
      `WorkCell ${workCellKey} oracle does not prove obligation oracle(s): ${missing.map((entry) => entry.semantic_key).join(", ")}`,
    );
  }
}
