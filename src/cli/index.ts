#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSafeRoot } from "../artifacts/atomic-file.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const help = `PCH Single (independent, in development)

Usage:
  pch run "task" --workspace PATH --data-root PATH --base-url URL --model ID --context-window N
  pch plan "task" --workspace PATH --data-root PATH --base-url URL --model ID --context-window N
  pch resume GOAL-ID --workspace PATH --data-root PATH --base-url URL --model ID --context-window N
  pch status --workspace PATH --data-root PATH
  pch doctor --workspace PATH --data-root PATH

Options:
  --api-key-env NAME    Environment variable containing the gateway key (default PCH_API_KEY)
  --config PATH         PCH Host config (default package config/default.json)
  --max-turns N         Bound model turns (default 24)

No Host, database or model request starts for help. Run and resume require an explicit
non-system data root; provider credentials stay in the named environment variable.
`;

interface CliArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

function parse(args: readonly string[]): CliArguments {
  const command = args[0] ?? "help";
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (value === "--help") return { command: "help", positional: [], options: {} };
    const key = value.slice(2);
    if (!["workspace", "data-root", "base-url", "model", "context-window", "api-key-env", "config", "max-turns"].includes(key)) {
      throw new TypeError(`Unknown option ${value}`);
    }
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) {
      throw new TypeError(`Invalid or repeated option ${value}`);
    }
    options[key] = args[++index]!;
  }
  return { command, positional, options };
}

function required(options: CliArguments["options"], name: string): string {
  const value = options[name]?.trim();
  if (!value) throw new TypeError(`--${name} is required`);
  return value;
}

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
  const target = resolve(path);
  if (process.platform === "win32" && /^[cC]:[\\/]/u.test(target)) {
    throw new TypeError(`${label} must use a non-system drive; C: was not selected for this workspace`);
  }
  return target;
}

function directory(path: string, label: string): string {
  const target = absolutePath(path, label);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new TypeError(`${label} does not exist as a directory`);
  return target;
}

function integer(value: string | undefined, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return number;
}

function modelOptions(parsed: CliArguments, env: NodeJS.ProcessEnv) {
  const rawURL = required(parsed.options, "base-url");
  let url: URL;
  try { url = new URL(rawURL); }
  catch { throw new TypeError("--base-url is invalid"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new TypeError("--base-url must be HTTPS, except for a local test gateway");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("--base-url must not contain credentials, query parameters or a fragment");
  }
  const model = required(parsed.options, "model");
  const contextWindow = integer(required(parsed.options, "context-window"), "--context-window", 1_024, 4_000_000);
  const credentialEnvName = parsed.options["api-key-env"] ?? "PCH_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnvName)) throw new TypeError("--api-key-env is invalid");
  const apiKey = env[credentialEnvName];
  if (!apiKey) throw new TypeError(`Gateway credential is missing in ${credentialEnvName}`);
  return {
    apiKey, credentialEnvName,
    runtime: {
      provider: "openai-compatible", api: "openai-chat-completions", base_url: url.toString(),
      model, thinking_level: "unspecified", context_window: contextWindow,
    },
  } as const;
}

function configureLocalStorage(dataRoot: string): void {
  const root = prepareSafeRoot(dataRoot);
  const temporary = prepareSafeRoot(resolve(root, "tmp"));
  const cache = prepareSafeRoot(resolve(root, "cache"));
  process.env.TEMP = temporary;
  process.env.TMP = temporary;
  process.env.TMPDIR = temporary;
  process.env.XDG_CACHE_HOME = cache;
  process.env.NPM_CONFIG_CACHE = prepareSafeRoot(resolve(cache, "npm"));
}

function displayStatus(status: {
  readonly flow?: { readonly goalId: string; readonly phase: string; readonly nextAction: string; readonly blocker: string | null } | null;
  readonly changed_files?: readonly { readonly path: string; readonly change: string }[];
}): string {
  const flow = status.flow;
  if (!flow) return "No active PCH Goal.";
  const files = (status.changed_files ?? []).map((file) => `${file.change} ${file.path}`);
  return `${flow.goalId} · ${flow.phase} · next=${flow.nextAction}${flow.blocker ? `\nBlocked: ${flow.blocker}` : ""}`
    + (files.length ? `\nChanged files:\n${files.join("\n")}` : "");
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parse(args);
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    process.stdout.write(help);
    return 0;
  }
  if (!["run", "plan", "resume", "status", "doctor"].includes(parsed.command)) {
    throw new TypeError(`Unknown PCH command ${parsed.command}`);
  }
  const cwd = directory(required(parsed.options, "workspace"), "Workspace");
  const dataRoot = absolutePath(required(parsed.options, "data-root"), "Data root");
  const configPath = parsed.options.config
    ? absolutePath(parsed.options.config, "Config path") : resolve(packageRoot, "config", "default.json");
  if (!existsSync(configPath)) throw new TypeError(`PCH Host config does not exist: ${configPath}`);
  const { assertWalRuntimeSafe } = await import("../authority/sqlite-runtime.js");
  assertWalRuntimeSafe();
  if (parsed.command === "doctor") {
    process.stdout.write(`PCH paths ready · workspace=${cwd} · data=${dataRoot}\n`);
    return 0;
  }
  let modelConfiguration: ReturnType<typeof modelOptions> | null = null;
  let maxTurns = 24;
  if (parsed.command !== "status") {
    if (parsed.command === "resume") {
      if (!parsed.positional[0] || parsed.positional.length !== 1) throw new TypeError("resume requires exactly one Goal ID");
    } else if (!parsed.positional.join(" ").trim()) {
      throw new TypeError(`${parsed.command} requires a task objective`);
    }
    modelConfiguration = modelOptions(parsed, env);
    maxTurns = parsed.options["max-turns"] === undefined ? 24
      : integer(parsed.options["max-turns"], "--max-turns", 1, 200);
  }
  configureLocalStorage(dataRoot);
  const { spawnCodingHarnessHost } = await import("../harness/host/client.js");
  const client = spawnCodingHarnessHost({
    entryPath: resolve(packageRoot, "dist", "harness", "host", "entry.js"),
    cwd, packageRoot, configPath, dataRoot, timeoutMs: 30_000,
  });
  const host = { request: (method: string, params: unknown) => client.request(method as never, params as never) };
  try {
    if (parsed.command === "status") {
      const discovery = await client.request("discover_goals", { cwd, session_id: `SESSION-INSPECT-${randomUUID()}` });
      if (discovery.recoverable.length === 0) process.stdout.write("No recoverable PCH Goals.\n");
      else for (const candidate of discovery.recoverable) {
        process.stdout.write(`${candidate.goal_id} · ${candidate.status} · ${candidate.goal_title} · next=${candidate.next_action_code}\n`);
      }
      return 0;
    }
    const { apiKey, credentialEnvName, runtime } = modelConfiguration!;
    const { OpenAiCompatibleModel } = await import("../standalone/provider.js");
    const { SessionHistoryStore } = await import("../standalone/history.js");
    const { runSingle } = await import("../standalone/loop.js");
    const history = new SessionHistoryStore(dataRoot);
    const model = new OpenAiCompatibleModel({ apiKey, baseURL: runtime.base_url, model: runtime.model });
    let sessionId = `SESSION-${randomUUID().toUpperCase()}`;
    let objective = parsed.positional.join(" ").trim();
    let recoverGoalId: string | undefined;
    let initialMessages;
    if (parsed.command === "resume") {
      recoverGoalId = parsed.positional[0];
      const discovery = await client.request("discover_goals", { cwd, session_id: `SESSION-INSPECT-${randomUUID()}` });
      const candidate = discovery.recoverable.find((row) => row.goal_id === recoverGoalId);
      if (!candidate?.controller_session_id) throw new TypeError("Goal has no recoverable controller session");
      sessionId = candidate.controller_session_id;
      const saved = history.load(sessionId);
      if (!saved || saved.goalId !== recoverGoalId || resolve(saved.workspace) !== cwd) {
        throw new TypeError("Checked conversation is unavailable for this Goal; no effect was replayed");
      }
      initialMessages = saved.messages;
      objective = candidate.objective;
    }
    const readline = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    const abort = new AbortController();
    const onInterrupt = () => abort.abort();
    process.once("SIGINT", onInterrupt);
    let lastPresentation = "";
    try {
      const result = await runSingle({
        host, model, cwd, sessionId, objective,
        intent: parsed.command === "plan" ? "PLAN" : "BUILD", runtime,
        ...(recoverGoalId === undefined ? {} : { recoverGoalId }),
        ...(initialMessages === undefined ? {} : { initialMessages }),
        maxTurns,
        signal: abort.signal, credentialEnvName,
        approveContract: async (review) => {
          if (!readline) return null;
          process.stdout.write(`\nGoal Contract review:\n${JSON.stringify({
            contract_changes: review.contract_diff, requirement_changes: review.requirement_diff,
          }, null, 2).slice(0, 24_000)}\n`);
          const answer = (await readline.question("Approve [a], request changes [r], or decide later [Enter]? ")).trim().toLowerCase();
          if (answer === "a") return { action: "APPROVE" as const };
          if (answer === "r") {
            const feedback = (await readline.question("Required changes: ")).trim();
            return feedback ? { action: "REJECT" as const, feedback } : null;
          }
          return null;
        },
        choosePlan: async (review) => {
          if (!readline) return null;
          process.stdout.write(`\nFrozen Plan: ${review.summary}\n`);
          const answer = (await readline.question("Build [b], keep plan [k], revise [r], or decide later [Enter]? ")).trim().toLowerCase();
          return answer === "b" ? "BUILD" : answer === "k" ? "KEEP" : answer === "r" ? "REVISE" : null;
        },
        chooseClarification: async (question) => {
          if (!readline) return null;
          process.stdout.write(`\n${question.question}\n${question.options.map((option) => `${option.id}: ${option.label} — ${option.impact}`).join("\n")}\n`);
          const answer = (await readline.question("Choose option ID or press Enter to wait: ")).trim();
          return question.options.some((option) => option.id === answer) ? answer : null;
        },
        saveMessages: (messages, status) => {
          if (status.flow) history.save({ sessionId, goalId: status.flow.goalId, workspace: cwd, messages });
        },
        onStatus: (status) => {
          const next = status.flow ? `${status.flow.phase}:${status.flow.nextAction}` : "inactive";
          if (next !== lastPresentation) { process.stdout.write(`PCH · ${next}\n`); lastPresentation = next; }
        },
        onAssistantText: (text) => {
          const visible = text.length <= 12_000 ? text : `${text.slice(0, 12_000)}\n[Model text truncated for display]`;
          process.stdout.write(`${visible}\n`);
        },
      });
      process.stdout.write(`${result.status}: ${result.reason}\n${displayStatus(result.hostStatus)}\n`);
      if (abort.signal.aborted && result.hostStatus.active) {
        await client.request("control", { action: "pause", reason: "User interrupted the standalone CLI" });
      }
      return result.status === "COMPLETED" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      readline?.close();
    }
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const selectedEnv = process.argv[process.argv.indexOf("--api-key-env") + 1];
    const key = process.env[/^[A-Za-z_][A-Za-z0-9_]*$/u.test(selectedEnv ?? "") ? selectedEnv! : "PCH_API_KEY"];
    process.stderr.write(`PCH error: ${key ? message.replaceAll(key, "[redacted]") : message}\n`);
    process.exitCode = 1;
  });
}
