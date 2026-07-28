import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { classifyLocalValidationCommand } from "./normalize.js";

export interface OraclePolicyDecision {
  readonly allow: boolean;
  readonly reason_code: string;
  readonly message: string;
  readonly command: string;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly package_script_graph_sha256: string | null;
  readonly network: "STATIC_EXTERNAL_EFFECT_SCREEN";
  readonly environment: "PI_INHERITED_NOT_SANDBOXED";
}

const forbiddenEffect = /(?:\b(?:curl|wget|invoke-webrequest|invoke-restmethod|start-bitstransfer|ssh|scp|sftp|ftp)\b|\bnpm\s+(?:install|i|publish)\b|\bpnpm\s+(?:add|install|publish)\b|\byarn\s+(?:add|install|publish)\b|\bgit\s+(?:push|fetch|pull)\b|\bdocker\s+(?:push|login)\b|\bkubectl\b|\bterraform\s+apply\b|\bhttps?:\/\/|\bfetch\s*\(|\baxios\b|\brequests?\.(?:get|post|put|delete)\s*\()/iu;
const nestedNpmScript = /\bnpm(?:\.cmd)?\s+(?:run\s+([a-z0-9_.:-]+)|test)(?=\s|$)/giu;
const maximumScriptCount = 64;
const maximumScriptBytes = 256 * 1024;
const localBuildExecutable = /^(?:(?:\.[\\/])?node_modules[\\/]\.bin[\\/](esbuild|microbundle)(?:\.cmd)?|npx(?:\.cmd)?\s+--no-install\s+(esbuild|microbundle)(?:\.cmd)?)(?:\s|$)/iu;
const outputOption = /(?:^|\s)(?:--outfile|--outdir|--metafile|--output|-o)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/giu;
const outputOptionMarker = /(?:^|\s)(?:--outfile|--outdir|--metafile|--output|-o)(?==|\s|$)/giu;
const goTestCommand = /^go(?:\.exe)?\s+test(?:\s|$)/iu;

interface PackageScriptGraph {
  readonly scripts: Readonly<Record<string, string>>;
  readonly sha256: string;
}

function packageScripts(cwd: string): Readonly<Record<string, string>> | null {
  const path = resolve(cwd, "package.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: unknown };
  if (typeof parsed.scripts !== "object" || parsed.scripts === null || Array.isArray(parsed.scripts)) return {};
  return Object.fromEntries(Object.entries(parsed.scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => [name, value.trim()]));
}

function npmScriptName(command: string): string | null {
  if (/^npm(?:\.cmd)?\s+test(?:\s|$)/iu.test(command)) return "test";
  return /^npm(?:\.cmd)?\s+run\s+([a-z0-9_.:-]+)(?:\s|$)/iu.exec(command)?.[1] ?? null;
}

function commandPreview(command: string): string {
  const singleLine = command.replace(/[\r\n\t]+/gu, " ").trim();
  return JSON.stringify(singleLine.length <= 180 ? singleLine : `${singleLine.slice(0, 177)}...`);
}

function contained(cwd: string, candidate: string): boolean {
  if (!candidate || candidate.includes("\0")) return false;
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  const delta = relative(root, target);
  return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function localBuildOutputPaths(command: string): readonly string[] | null {
  if (!localBuildExecutable.test(command)) return [];
  const paths = [...command.matchAll(outputOption)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const markers = [...command.matchAll(outputOptionMarker)];
  return paths.length === markers.length ? paths : null;
}

function policyMessage(reasonCode: string, command: string): string {
  const shown = commandPreview(command);
  switch (reasonCode) {
    case "ORACLE_NOT_FROZEN": return `Validation Oracle denied ${shown}: the command is not in the frozen oracle.`;
    case "ORACLE_SHELL_COMPOSITION_DENIED": return `Validation Oracle denied ${shown}: split shell-composed checks into separate oracle.commands[] entries.`;
    case "ORACLE_NPM_EXEC_DENIED": return `Validation Oracle denied ${shown}: npm exec may install or access the network. Use an existing npm script or an installed allowlisted node_modules/.bin binary; commands[] does not expand the allowlist.`;
    case "ORACLE_LONG_RUNNING_MODE_DENIED": return `Validation Oracle denied ${shown}: --watch, --serve and -w cannot be terminating validation oracles.`;
    case "ORACLE_GO_TEST_ARGUMENT_DENIED": return `Validation Oracle denied ${shown}: go test accepts only bounded validation flags; execution wrappers, overlays, output binaries and unbounded arguments are forbidden.`;
    case "ORACLE_GO_TEST_PACKAGE_DENIED": return `Validation Oracle denied ${shown}: go test package selectors must be local workspace-relative paths.`;
    case "ORACLE_GO_MODULE_NOT_FOUND": return `Validation Oracle denied ${shown}: the workspace has no go.mod or go.work dependency boundary.`;
    case "ORACLE_BUILD_OUTPUT_INVALID": return `Validation Oracle denied ${shown}: every build output option must have an explicit local path.`;
    case "ORACLE_BUILD_OUTPUT_OUTSIDE_WORKSPACE": return `Validation Oracle denied ${shown}: build output paths must remain inside the workspace.`;
    case "ORACLE_COMMAND_NOT_ALLOWLISTED": return `Validation Oracle denied ${shown}: use npm test, an allowed npm run script, or an installed allowlisted local binary.`;
    default: return `Validation Oracle policy denied ${shown} (${reasonCode}).`;
  }
}

function resolvePackageScriptGraph(cwd: string, root: string): PackageScriptGraph | null {
  const scripts = packageScripts(cwd);
  if (scripts === null || !scripts[root]) return null;
  const pending = [root];
  const visited = new Set<string>();
  const graph: Record<string, string> = {};
  let totalBytes = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (visited.size > maximumScriptCount) throw new TypeError("Oracle package script graph is too large");
    for (const lifecycleName of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[lifecycleName];
      if (!body || graph[lifecycleName] !== undefined) continue;
      totalBytes += Buffer.byteLength(body, "utf8");
      if (totalBytes > maximumScriptBytes) throw new TypeError("Oracle package script graph exceeds its byte bound");
      graph[lifecycleName] = body;
      for (const match of body.matchAll(nestedNpmScript)) pending.push(match[1] ?? "test");
    }
  }
  return { scripts: graph, sha256: canonicalJsonSha256({ domain: "PCH-ORACLE-SCRIPT-GRAPH-V1", scripts: graph }) };
}

export function evaluateOraclePolicy(input: {
  readonly command: string;
  readonly cwd: string;
  readonly declared_commands: readonly string[];
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
}): OraclePolicyDecision {
  const command = input.command.trim().normalize("NFC");
  const timeout = input.timeout_ms ?? 120_000;
  const maximumOutput = input.max_output_bytes ?? 50 * 1024;
  let packageScriptGraphSha256: string | null = null;
  const deny = (reason: string): OraclePolicyDecision => ({
    allow: false, reason_code: reason, message: policyMessage(reason, command), command, timeout_ms: timeout,
    max_output_bytes: maximumOutput, package_script_graph_sha256: packageScriptGraphSha256,
    network: "STATIC_EXTERNAL_EFFECT_SCREEN", environment: "PI_INHERITED_NOT_SANDBOXED",
  });
  if (!input.declared_commands.includes(command)) return deny("ORACLE_NOT_FROZEN");
  const classification = classifyLocalValidationCommand(command);
  if (!classification.allow) {
    const reason = classification.reason_code === "LOCAL_VALIDATION_SHELL_COMPOSITION_DENIED" ? "ORACLE_SHELL_COMPOSITION_DENIED"
      : classification.reason_code === "LOCAL_VALIDATION_NPM_EXEC_DENIED" ? "ORACLE_NPM_EXEC_DENIED"
        : classification.reason_code === "LOCAL_VALIDATION_LONG_RUNNING_MODE_DENIED" ? "ORACLE_LONG_RUNNING_MODE_DENIED"
          : classification.reason_code === "LOCAL_VALIDATION_GO_TEST_ARGUMENT_DENIED" ? "ORACLE_GO_TEST_ARGUMENT_DENIED"
            : classification.reason_code === "LOCAL_VALIDATION_GO_TEST_PACKAGE_DENIED" ? "ORACLE_GO_TEST_PACKAGE_DENIED"
          : "ORACLE_COMMAND_NOT_ALLOWLISTED";
    return deny(reason);
  }
  if (goTestCommand.test(command) && !existsSync(resolve(input.cwd, "go.mod")) && !existsSync(resolve(input.cwd, "go.work"))) {
    return deny("ORACLE_GO_MODULE_NOT_FOUND");
  }
  const buildOutputs = localBuildOutputPaths(command);
  if (buildOutputs === null) return deny("ORACLE_BUILD_OUTPUT_INVALID");
  if (buildOutputs.some((path) => !contained(input.cwd, path))) return deny("ORACLE_BUILD_OUTPUT_OUTSIDE_WORKSPACE");
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 900_000) return deny("ORACLE_TIMEOUT_INVALID");
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 4_096 || maximumOutput > 8_388_608) return deny("ORACLE_OUTPUT_BOUND_INVALID");
  if (forbiddenEffect.test(command)) return deny("ORACLE_EXTERNAL_EFFECT_DENIED");
  const scriptName = npmScriptName(command);
  if (scriptName !== null) {
    let graph: PackageScriptGraph | null;
    try { graph = resolvePackageScriptGraph(input.cwd, scriptName); }
    catch { return deny("ORACLE_PACKAGE_JSON_INVALID"); }
    if (graph === null) return deny("ORACLE_SCRIPT_NOT_FOUND");
    packageScriptGraphSha256 = graph.sha256;
    if (Object.values(graph.scripts).some((script) => forbiddenEffect.test(script))) {
      return deny("ORACLE_SCRIPT_EXTERNAL_EFFECT_DENIED");
    }
  }
  return {
    allow: true, reason_code: "ORACLE_POLICY_PASS", message: "Validation Oracle policy passed.", command, timeout_ms: timeout,
    max_output_bytes: maximumOutput, package_script_graph_sha256: packageScriptGraphSha256,
    network: "STATIC_EXTERNAL_EFFECT_SCREEN", environment: "PI_INHERITED_NOT_SANDBOXED",
  };
}
