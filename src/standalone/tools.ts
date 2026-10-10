import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeToolEffect } from "../effects/normalize.js";
import { runBoundedCommand } from "../effects/bounded-command.js";
import { sha256Hex } from "../foundation/crypto.js";
import type { HostResult, HostStatus } from "../harness/host/application-protocol.js";
import type { ModelToolCall } from "./provider.js";

export interface ToolHost {
  request(method: string, params: unknown): Promise<unknown>;
}

export interface ControlledToolInput {
  readonly host: ToolHost;
  readonly cwd: string;
  readonly controlFrameSha256: string;
  readonly call: ModelToolCall;
  readonly signal?: AbortSignal;
  readonly credentialEnvName?: string;
}

export interface ControlledToolResult {
  readonly text: string;
  readonly isError: boolean;
  readonly operationId: string | null;
  readonly controlFrameSha256: string;
  readonly workflowPrompt: string | null;
  readonly status?: HostStatus;
}

const toolNames = new Set(["read", "grep", "find", "ls", "write", "edit", "bash"]);
const maxResultBytes = 262_144;

function field(input: Readonly<Record<string, unknown>>, name: string, maximum = 65_536): string {
  const value = input[name];
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${name} must be a bounded nonempty string`);
  }
  return value;
}

function boundedInteger(value: unknown, defaultValue: number, maximum: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`Expected an integer in 1..${maximum}`);
  }
  return value as number;
}

function contained(cwd: string, candidate: string): boolean {
  const delta = relative(resolve(cwd), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function safePath(cwd: string, input: Readonly<Record<string, unknown>>, mustExist: boolean): string {
  const relativePath = field(input, "path", 4_096);
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new TypeError("Tool path must be workspace-relative");
  }
  const path = resolve(cwd, relativePath);
  if (!contained(cwd, path)) throw new TypeError("Tool path escapes the workspace");
  if (mustExist && !existsSync(path)) throw new TypeError(`Tool target does not exist: ${relativePath}`);
  const existing = existsSync(path) ? path : dirname(path);
  if (!existsSync(existing) || !contained(cwd, realpathSync(existing)) || lstatSync(existing).isSymbolicLink()) {
    throw new TypeError("Tool target resolves outside the workspace or through a link");
  }
  return path;
}

function boundedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxResultBytes) return text;
  return `${bytes.subarray(0, maxResultBytes).toString("utf8")}\n[PCH tool output truncated; full_sha256=${sha256Hex(bytes)}]`;
}

async function childOutput(command: string, args: readonly string[], cwd: string, timeoutMs: number,
  signal?: AbortSignal, credentialEnvName?: string): Promise<{ readonly text: string; readonly exitCode: number }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== credentialEnvName
    && !/(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)/iu.test(name)));
  const result = await runBoundedCommand({ command, args, cwd, timeoutMs,
    maximumOutputBytes: 1_048_576, signal: signal ?? new AbortController().signal, env });
  return { text: result.output, exitCode: result.exitCode };
}

async function runTool(name: string, input: Readonly<Record<string, unknown>>, cwd: string,
  timeoutMs: number, signal?: AbortSignal, credentialEnvName?: string): Promise<{ readonly text: string; readonly isError: boolean }> {
  if (signal?.aborted) throw new TypeError("Tool execution canceled before dispatch");
  if (name === "read") {
    const path = safePath(cwd, input, true);
    if (!statSync(path).isFile()) throw new TypeError("read requires a regular file");
    if (statSync(path).size > 4_194_304) throw new TypeError("File is too large for bounded read");
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    const offset = boundedInteger(input.offset, 1, Math.max(1, lines.length));
    const limit = boundedInteger(input.limit, 200, 500);
    return { text: lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join("\n"), isError: false };
  }
  if (name === "ls") {
    const path = safePath(cwd, input, true);
    if (!statSync(path).isDirectory()) throw new TypeError("ls requires a directory");
    const entries = readdirSync(path, { withFileTypes: true }).slice(0, 200)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    return { text: entries.length ? entries.join("\n") : "[empty directory]", isError: false };
  }
  if (name === "grep" || name === "find") {
    const path = safePath(cwd, input, true);
    const args = name === "grep"
      ? ["--line-number", "--no-heading", "--max-count", "200", "--", field(input, "pattern", 2_048), path]
      : ["--files", "--", path];
    const result = await childOutput("rg", args, cwd, Math.min(timeoutMs, 30_000), signal, credentialEnvName);
    return { text: result.text || "[no matches]", isError: result.exitCode > 1 };
  }
  if (name === "write") {
    const path = safePath(cwd, input, false);
    const content = field(input, "content", 1_048_576);
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { text: `Created ${relative(cwd, path).replaceAll("\\", "/")}`, isError: false };
  }
  if (name === "edit") {
    const path = safePath(cwd, input, true);
    if (!statSync(path).isFile()) throw new TypeError("edit requires a regular file");
    const oldText = field(input, "oldText", 262_144);
    const newText = typeof input.newText === "string" ? input.newText : null;
    if (newText === null || Buffer.byteLength(newText, "utf8") > 262_144) throw new TypeError("newText is invalid");
    const before = readFileSync(path, "utf8");
    const first = before.indexOf(oldText);
    if (first < 0 || before.indexOf(oldText, first + oldText.length) >= 0) {
      throw new TypeError("Exact oldText must occur once in the current file");
    }
    const next = `${before.slice(0, first)}${newText}${before.slice(first + oldText.length)}`;
    const temporary = resolve(dirname(path), `.pch-edit-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, next, { encoding: "utf8", flag: "wx", mode: statSync(path).mode });
      if (readFileSync(path, "utf8") !== before) throw new TypeError("File changed during exact edit");
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
    }
    return { text: `Edited ${relative(cwd, path).replaceAll("\\", "/")}`, isError: false };
  }
  if (name === "bash") {
    const command = field(input, "command", 16_384);
    const effect = normalizeToolEffect({ toolCallId: "LOCAL-CHECK", toolName: "bash", input, cwd });
    if (!(["READ_ONLY", "LOCAL_REVERSIBLE_WRITE"].includes(effect.effectClass))) {
      throw new TypeError("Standalone shell permits only Host-classified local probes and validation");
    }
    const shell = process.platform === "win32" ? "pwsh" : "sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
    const result = await childOutput(shell, args, cwd, timeoutMs, signal, credentialEnvName);
    return { text: `${result.text}\n[exit=${result.exitCode}]`, isError: result.exitCode !== 0 };
  }
  throw new TypeError(`Unsupported standalone tool: ${name}`);
}

export async function executeControlledTool(options: ControlledToolInput): Promise<ControlledToolResult> {
  const { host, cwd, call } = options;
  if (!toolNames.has(call.name)) {
    return { text: `Unsupported tool: ${call.name}`, isError: true, operationId: null,
      controlFrameSha256: options.controlFrameSha256, workflowPrompt: null };
  }
  const invocation = { toolCallId: call.id, toolName: call.name, input: call.arguments, cwd,
    control_frame_sha256: options.controlFrameSha256 };
  const admission = await host.request("tool_preflight", invocation) as HostResult<"tool_preflight">;
  const preparedFrame = admission.control_frame?.control_frame_sha256 ?? options.controlFrameSha256;
  if (!admission.allow) {
    return { text: admission.reason ?? "Host denied tool execution", isError: true, operationId: null,
      controlFrameSha256: preparedFrame, workflowPrompt: null };
  }
  let outcome: { readonly text: string; readonly isError: boolean };
  try {
    const timeoutMs = admission.oracle_policy && typeof admission.oracle_policy.timeout_ms === "number"
      ? admission.oracle_policy.timeout_ms : 120_000;
    outcome = await runTool(call.name, call.arguments, cwd, timeoutMs, options.signal, options.credentialEnvName);
  } catch (error) {
    outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
  }
  const fullText = outcome.text;
  let frame = preparedFrame;
  let operationId: string | null = null;
  let workflowPrompt: string | null = null;
  let status: HostStatus | undefined;
  if (admission.managed || admission.capture) {
    const observed = await host.request("tool_result", {
      tool_call_id: call.id, tool_name: call.name, tool_input: call.arguments,
      is_error: outcome.isError, text: boundedText(fullText), output_sha256: sha256Hex(fullText),
    }) as HostResult<"tool_result">;
    frame = observed.control_frame.control_frame_sha256;
    operationId = observed.operation_id;
    workflowPrompt = observed.workflow_prompt ?? null;
  }
  if (admission.managed) {
    const ended = await host.request("tool_end", {
      tool_call_id: call.id, is_error: outcome.isError, text: boundedText(fullText),
    }) as HostResult<"tool_end">;
    frame = ended.control_frame.control_frame_sha256;
    status = ended.status;
  }
  const text = boundedText(fullText);
  return { text, isError: outcome.isError, operationId, controlFrameSha256: frame, workflowPrompt,
    ...(status === undefined ? {} : { status }) };
}
