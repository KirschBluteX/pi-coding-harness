import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptRoot, "..");
const args = process.argv.slice(2);

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function isWithin(parent, child) {
  const delta = relative(resolve(parent), resolve(child));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : entry.isFile() ? [child] : [];
  });
}

function sumUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    const value = Number(usage[key] ?? 0);
    if (Number.isFinite(value) && value >= 0) target[key] += value;
  }
}

function compactUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
    .map((key) => [key, Number.isFinite(Number(usage[key])) ? Number(usage[key]) : null]));
}

function run(command, commandArgs, cwd, allowFailure = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

const modelsPath = valueAfter("--models");
const profileModulePath = valueAfter("--profile-module");
const runtimeStatusPath = valueAfter("--runtime-status");
const reportPath = resolve(projectRoot, valueAfter("--report") ?? "reports/provider-backed-compaction.json");
const recoveryPhasePath = valueAfter("--recover-phase");
const priorReportPath = valueAfter("--prior-report");
const keepRuntime = args.includes("--keep-runtime");
if ((!modelsPath && !profileModulePath) || !runtimeStatusPath || (recoveryPhasePath && !priorReportPath)) {
  throw new Error("Usage: node scripts/verify-provider-backed-compaction.mjs (--models <models.json> | --profile-module <profile.mjs>) --runtime-status <task-status.json> [--recover-phase <phase-root> --prior-report <report.json>] [--report <path>] [--keep-runtime]");
}

const resolvedRuntimeStatusPath = resolve(runtimeStatusPath);
if (!existsSync(resolvedRuntimeStatusPath)) {
  throw new Error("The supplied runtime-status file does not exist");
}

let modelsConfig;
let modelsConfigSha256;
if (modelsPath) {
  const resolvedModelsPath = resolve(modelsPath);
  if (!existsSync(resolvedModelsPath)) throw new Error("The supplied Pi models file does not exist");
  modelsConfig = JSON.parse(readFileSync(resolvedModelsPath, "utf8"));
  modelsConfigSha256 = sha256File(resolvedModelsPath);
} else {
  const resolvedProfileModulePath = resolve(profileModulePath);
  if (!existsSync(resolvedProfileModulePath)) throw new Error("The supplied Pi profile Module does not exist");
  const profileModule = await import(pathToFileURL(resolvedProfileModulePath).href);
  if (typeof profileModule.buildPiModelsConfig !== "function") {
    throw new Error("The supplied Pi profile Module does not export buildPiModelsConfig()");
  }
  modelsConfig = profileModule.buildPiModelsConfig();
  modelsConfigSha256 = sha256(JSON.stringify(modelsConfig));
}
const runtimeStatus = JSON.parse(readFileSync(resolvedRuntimeStatusPath, "utf8"));
const runtime = runtimeStatus.configuration ?? {};
const providerId = String(runtime.provider ?? "");
const modelId = String(runtime.model ?? "");
const thinkingLevel = String(runtime.thinking_level ?? "");
const providerConfig = modelsConfig.providers?.[providerId];
const modelConfig = providerConfig?.models?.find((model) => model.id === modelId);
if (!providerId || !modelId || !thinkingLevel || !providerConfig || !modelConfig) {
  throw new Error("Runtime selection is not present in the supplied Pi models configuration");
}
const observedModel = runtimeStatus.pch?.finalState?.model;
if (providerConfig.api !== runtime.client_wire_api
  || observedModel?.provider !== providerId
  || observedModel?.api !== providerConfig.api
  || observedModel?.id !== modelId
  || observedModel?.baseUrl !== providerConfig.baseUrl
  || observedModel?.contextWindow !== modelConfig.contextWindow
  || runtimeStatus.pch?.finalState?.thinkingLevel !== thinkingLevel) {
  throw new Error("Runtime-status and Pi models configuration disagree");
}
const credentialMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(String(providerConfig.apiKey ?? ""));
if (!credentialMatch || !process.env[credentialMatch[1]]) {
  throw new Error("The Pi models configuration must reference an available process-scoped credential environment variable");
}
const credentialName = credentialMatch[1];
const credential = process.env[credentialName];

const piEntry = resolve(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const extensionEntry = resolve(projectRoot, "src", "index.ts");
const hostEntry = resolve(projectRoot, "dist", "harness", "host", "entry.js");
for (const path of [piEntry, extensionEntry, hostEntry]) {
  if (!existsSync(path)) throw new Error(`Required runtime entry is missing: ${path}`);
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA is required");
const runtimeParent = resolve(localAppData, "Temp", "pch-cp");
const resolvedRecoveryPhasePath = recoveryPhasePath ? resolve(recoveryPhasePath) : null;
const runtimeRoot = resolvedRecoveryPhasePath
  ? dirname(resolvedRecoveryPhasePath)
  : resolve(runtimeParent, `pcc-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`);
if (!isWithin(runtimeParent, runtimeRoot) || runtimeRoot === runtimeParent
  || (resolvedRecoveryPhasePath
    ? resolvedRecoveryPhasePath !== resolve(runtimeRoot, "rr") || !existsSync(resolvedRecoveryPhasePath)
    : existsSync(runtimeRoot))) {
  throw new Error("Compaction probe runtime root is unsafe, missing, or already exists");
}
if (!resolvedRecoveryPhasePath) mkdirSync(runtimeRoot, { recursive: true });

const secrets = [credential].filter(Boolean);
function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}

function baseEnvironment(phaseRoot, homes) {
  const environment = {};
  for (const name of [
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "APPDATA", "LOCALAPPDATA",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE",
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    [credentialName]: credential,
    PI_CODING_AGENT_DIR: homes.agentHome,
    USERPROFILE: homes.userHome,
    HOME: homes.userHome,
    TEMP: resolve(phaseRoot, "tmp"),
    TMP: resolve(phaseRoot, "tmp"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

function preparePhase(name) {
  const phaseRoot = resolve(runtimeRoot, name);
  const workspace = resolve(phaseRoot, "workspace");
  const agentHome = resolve(phaseRoot, "homes", "pi-agent");
  const userHome = resolve(phaseRoot, "homes", "pi-user");
  for (const path of [workspace, agentHome, userHome, resolve(phaseRoot, "tmp")]) mkdirSync(path, { recursive: true });
  writeFileSync(resolve(workspace, "README.md"), "# Compaction probe\n\nThis isolated workspace is read-only test context.\n", "utf8");
  writeJson(resolve(agentHome, "models.json"), modelsConfig);
  writeJson(resolve(agentHome, "models-store.json"), {});
  writeJson(resolve(agentHome, "auth.json"), {});
  writeJson(resolve(agentHome, "settings.json"), {
    compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 64 },
  });
  return { name, phaseRoot, workspace, homes: { agentHome, userHome } };
}

function phaseFromRoot(phaseRoot) {
  const phase = {
    name: "rr",
    phaseRoot,
    workspace: resolve(phaseRoot, "workspace"),
    homes: {
      agentHome: resolve(phaseRoot, "homes", "pi-agent"),
      userHome: resolve(phaseRoot, "homes", "pi-user"),
    },
  };
  for (const path of [phase.workspace, phase.homes.agentHome, phase.homes.userHome, resolve(phaseRoot, "tmp")]) {
    if (!existsSync(path)) throw new Error("Recovery-only Compaction phase is incomplete");
  }
  return phase;
}

function piArguments() {
  return [
    piEntry,
    "--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions",
    "--extension", extensionEntry,
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--tools", "read,grep,find,ls,bash,coding_flow,coding_clarify,coding_context,coding_delegate",
    "--provider", providerId, "--model", modelId, "--thinking", thinkingLevel,
  ];
}

function terminateTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { child.kill("SIGKILL"); } catch { /* Process may have exited concurrently. */ }
}

function authorityPath(userHome) {
  const root = resolve(userHome, ".pi", "agent", "coding-harness", "workspaces");
  return filesUnder(root).find((path) => path.endsWith("authority.sqlite")) ?? null;
}

function authorityLeaseExpiry(userHome) {
  const path = authorityPath(userHome);
  if (!path || statSync(path).size === 0) return null;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const available = database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='execution_leases'").get();
    if (!available) return null;
    const row = database.prepare("SELECT max(expires_at_ms) expires_at_ms FROM execution_leases").get();
    const value = Number(row?.expires_at_ms);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } finally {
    database.close();
  }
}

async function waitForLeaseExpiry(userHome) {
  const startedAtMs = Date.now();
  const initialExpiryMs = authorityLeaseExpiry(userHome);
  if (initialExpiryMs === null || initialExpiryMs <= startedAtMs) {
    return { expired: true, initial_remaining_ms: Math.max(0, (initialExpiryMs ?? startedAtMs) - startedAtMs), waited_ms: 0 };
  }
  const deadlineMs = initialExpiryMs + 5_000;
  while (Date.now() < deadlineMs) {
    const expiresAtMs = authorityLeaseExpiry(userHome);
    if (expiresAtMs === null || expiresAtMs <= Date.now()) {
      return { expired: true, initial_remaining_ms: initialExpiryMs - startedAtMs, waited_ms: Date.now() - startedAtMs };
    }
    const delayMs = Math.min(500, Math.max(25, expiresAtMs - Date.now() + 25));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  return { expired: false, initial_remaining_ms: initialExpiryMs - startedAtMs, waited_ms: Date.now() - startedAtMs };
}

function authoritySnapshot(userHome) {
  const path = authorityPath(userHome);
  if (!path) return null;
  if (statSync(path).size === 0) {
    return { sha256: sha256File(path), bytes: 0, integrity: null, error: "EMPTY_AUTHORITY_DATABASE" };
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql) => database.prepare(sql).get();
    const all = (sql) => database.prepare(sql).all();
    const table = (name) => Boolean(one(`SELECT 1 present FROM sqlite_master WHERE type='table' AND name='${name}'`));
    const cachePending = table("cache_logical_requests_v2") ? one(`SELECT count(*) count FROM cache_logical_requests_v2 r
      LEFT JOIN cache_request_attributions_v2 a ON a.request_id=r.request_id WHERE a.request_id IS NULL`)?.count : null;
    const providerPending = table("provider_turn_attempts_v2") ? one(`SELECT count(*) count FROM provider_turn_attempts_v2 s
      WHERE s.transition_ordinal=0 AND NOT EXISTS (SELECT 1 FROM provider_turn_attempts_v2 t
        WHERE t.attempt_id=s.attempt_id AND t.transition_ordinal=1)`)?.count : null;
    return {
      sha256: sha256File(path),
      bytes: statSync(path).size,
      integrity: one("PRAGMA integrity_check")?.integrity_check ?? null,
      foreign_key_violations: all("PRAGMA foreign_key_check").length,
      goal_heads: table("task_flow_goal_heads_v1")
        ? all("SELECT status,next_action_code FROM task_flow_goal_heads_v1 ORDER BY goal_id") : [],
      compaction_attempts: table("harness_compaction_attempts_v21")
        ? Number(one("SELECT count(*) count FROM harness_compaction_attempts_v21")?.count ?? 0) : 0,
      compaction_heads: table("harness_compaction_heads_v21")
        ? all(`SELECT h.state,h.ordinal,t.reason_code FROM harness_compaction_heads_v21 h
            JOIN harness_compaction_transitions_v21 t ON t.attempt_id=h.attempt_id AND t.ordinal=h.ordinal
            ORDER BY h.attempt_id`) : [],
      compaction_transitions: table("harness_compaction_transitions_v21")
        ? all("SELECT state,reason_code,count(*) count FROM harness_compaction_transitions_v21 GROUP BY state,reason_code ORDER BY state,reason_code") : [],
      cache_pending: cachePending === null ? null : Number(cachePending),
      provider_pending: providerPending === null ? null : Number(providerPending),
    };
  } finally {
    database.close();
  }
}

async function waitForCompactionState(userHome, state, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = authoritySnapshot(userHome);
    if (snapshot?.compaction_heads.some((head) => head.state === state)) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return authoritySnapshot(userHome);
}

function managedObjective() {
  return [
    "/coding single plan Create an implementation plan for migrating a production datastore.",
    "The datastore engine, allowed downtime, rollback target, and data-loss tolerance are intentionally unspecified.",
    "Treat those as blocking user decisions, preserve them as explicit clarification points, and do not modify files.",
    "Keep the plan scoped to this isolated workspace and do not invent missing production facts.",
  ].join(" ");
}

async function runPi(phase, mode) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  const result = {
    mode,
    started_at: new Date().toISOString(),
    exit_code: null,
    signal: null,
    event_counts: {},
    compaction_events: [],
    responses: {},
    status_updates: [],
    notifications: [],
    usage: totals,
    session_stats: null,
    final_state: null,
    interrupted_at_authority: null,
    stderr_sha256: null,
    stderr_excerpt: null,
  };
  const child = spawn(process.execPath, piArguments(), {
    cwd: phase.workspace,
    env: baseEnvironment(phase.phaseRoot, phase.homes),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderr = "";
  let lastEventAt = Date.now();
  let compactSent = false;
  let finalizing = false;
  let interruptionStarted = false;
  let recoveredEntrySent = false;
  let recoveredResumeSent = false;
  let initialAccepted = false;

  const send = (command) => {
    if (child.exitCode === null && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const close = () => {
    if (child.exitCode === null && child.stdin.writable) child.stdin.end();
  };
  const beginFinal = () => {
    if (finalizing) return;
    finalizing = true;
    send({ id: "final-status", type: "prompt", message: "/coding status" });
  };
  const sendCompact = () => {
    if (compactSent || finalizing || mode === "recover") return;
    compactSent = true;
    send({
      id: "manual-compact",
      type: "compact",
      customInstructions: "Preserve the active Goal, blocking clarifications, next action, and read-only workspace constraint exactly.",
    });
  };

  async function interruptWhenOwned() {
    if (interruptionStarted) return;
    interruptionStarted = true;
    const snapshot = await waitForCompactionState(phase.homes.userHome, "PI_OWNED");
    result.interrupted_at_authority = snapshot;
    if (!snapshot?.compaction_heads.some((head) => head.state === "PI_OWNED")) {
      result.interruption_error = "PI_OWNED authority was not observed after compaction_start";
    }
    terminateTree(child);
  }

  function handleResponse(event) {
    result.responses[event.id] = {
      command: event.command ?? null,
      success: event.success === true,
      error_sha256: event.success === true ? null : sha256(redact(event.error ?? event.message ?? "unknown")),
    };
    if (event.id === "initial") initialAccepted = event.success === true;
    if (event.id === "manual-compact" && mode === "success") {
      beginFinal();
      return;
    }
    if (event.id === "final-status") send({ id: "final-stats", type: "get_session_stats" });
    else if (event.id === "final-stats") {
      result.session_stats = event.data ?? null;
      send({ id: "final-state", type: "get_state" });
    } else if (event.id === "final-state") {
      result.final_state = event.data ?? null;
      setTimeout(close, 250).unref();
    }
  }

  function handleEvent(event) {
    lastEventAt = Date.now();
    result.event_counts[event.type] = (result.event_counts[event.type] ?? 0) + 1;
    if (event.type === "response" && event.id) handleResponse(event);
    if (event.type === "message_end" && event.message?.role === "assistant") sumUsage(totals, event.message.usage);
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus" && event.statusKey === "coding-harness") {
        const statusText = String(event.statusText ?? "").slice(0, 512);
        result.status_updates.push(statusText);
        if (mode === "recover" && !recoveredResumeSent && /\bnext=RECONCILE_COMPACTION\b/u.test(statusText)) {
          recoveredResumeSent = true;
          send({ id: "recover-resume", type: "prompt", message: "/coding resume" });
        }
      } else if (event.method === "notify") {
        const message = String(event.message ?? "").slice(0, 512);
        result.notifications.push({ type: event.notifyType ?? null, message });
        if (mode === "recover" && (event.notifyType === "error"
          || (recoveredResumeSent && /Compaction (?:verified|reconciled|aborted).*managed mutation may continue/iu.test(message)))) {
          beginFinal();
        }
      } else if (["select", "confirm", "input", "editor"].includes(event.method)) {
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
    }
    if (event.type === "compaction_start") {
      result.compaction_events.push({
        reason: event.reason ?? null,
        started_at: new Date().toISOString(),
        ended_at: null,
        aborted: null,
        result_present: null,
        usage: null,
        error_sha256: null,
      });
      if (mode === "interrupt") void interruptWhenOwned();
    }
    if (event.type === "compaction_end") {
      const target = [...result.compaction_events].reverse().find((entry) => entry.ended_at === null)
        ?? { reason: event.reason ?? null, started_at: null };
      target.ended_at = new Date().toISOString();
      target.aborted = event.aborted === true;
      target.result_present = event.result !== undefined;
      target.usage = compactUsage(event.result?.usage);
      target.error_sha256 = typeof event.errorMessage === "string" ? sha256(redact(event.errorMessage)) : null;
      if (!result.compaction_events.includes(target)) result.compaction_events.push(target);
    }
    if (event.type === "agent_settled"
      && initialAccepted
      && (mode === "success" || mode === "interrupt")) sendCompact();
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const boundary = stdoutBuffer.indexOf("\n");
      if (boundary < 0) break;
      const line = stdoutBuffer.slice(0, boundary).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(boundary + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); } catch { result.parse_errors = (result.parse_errors ?? 0) + 1; }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += redact(chunk.toString("utf8"));
  });
  child.stdin.on("error", () => undefined);

  if (mode === "recover") {
    recoveredEntrySent = true;
    send({ id: "recover-enter", type: "prompt", message: managedObjective() });
  } else {
    send({ id: "initial", type: "prompt", message: managedObjective() });
  }

  const monitor = setInterval(() => {
    if (child.exitCode !== null) return;
    if (Date.now() - lastEventAt >= 90_000) {
      result.stall_guard_triggered = true;
      send({ id: "stall-abort", type: "abort" });
      setTimeout(() => terminateTree(child), 2_000).unref();
    }
  }, 1_000);

  await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code, signal) => {
      result.exit_code = code;
      result.signal = signal;
      resolveExit();
    });
  });
  clearInterval(monitor);
  result.ended_at = new Date().toISOString();
  result.stderr_sha256 = sha256(stderr);
  result.stderr_excerpt = stderr.trim().slice(0, 1_000) || null;
  result.authority = authoritySnapshot(phase.homes.userHome);
  result.recovered_entry_sent = recoveredEntrySent;
  return result;
}

function liveCompactionVerified(success) {
  return success.responses["manual-compact"]?.success === true
    && success.compaction_events.some((event) => event.ended_at && event.result_present && !event.aborted && !event.error_sha256)
    && success.authority?.integrity === "ok"
    && success.authority?.foreign_key_violations === 0
    && success.authority?.compaction_heads.length === 1
    && success.authority.compaction_heads[0]?.state === "VERIFIED"
    && success.authority.cache_pending === 0
    && success.authority.provider_pending === 0;
}

function restartRecoveryVerified(recovered) {
  return recovered?.authority?.integrity === "ok"
    && recovered.authority?.foreign_key_violations === 0
    && recovered.authority?.compaction_heads.length === 1
    && ["VERIFIED", "RECONCILED"].includes(recovered.authority.compaction_heads[0]?.state)
    && recovered.authority.compaction_transitions.some((entry) => entry.reason_code === "RECOVERY_EXACT_FRONTIER"
      || entry.reason_code === "AUTHORITY_FRONTIER_REPROJECTED")
    && recovered.authority.cache_pending === 0
    && recovered.authority.provider_pending === 0;
}

const runtimeSelectionReport = {
  provider: providerId,
  api: providerConfig.api,
  model: modelId,
  thinking_level: thinkingLevel,
  context_window: modelConfig.contextWindow,
  max_tokens: modelConfig.maxTokens,
  base_url_sha256: sha256(String(providerConfig.baseUrl ?? "")),
  models_config_sha256: modelsConfigSha256,
  runtime_status_sha256: sha256File(resolvedRuntimeStatusPath),
};

const probeSettings = {
  topology: "SINGLE",
  compaction_trigger: "PI_RPC_MANUAL",
  keep_recent_tokens: 64,
  reserve_tokens: 2048,
  provider_event_stall_seconds: 90,
  payload_mutation: false,
  warmup_or_filler_requests: 0,
};

let report;
try {
  if (resolvedRecoveryPhasePath) {
    const resolvedPriorReportPath = resolve(priorReportPath);
    if (!existsSync(resolvedPriorReportPath)) throw new Error("Recovery-only prior report is missing");
    const priorReport = JSON.parse(readFileSync(resolvedPriorReportPath, "utf8"));
    if (priorReport.report_id !== "PCH-PROVIDER-BACKED-COMPACTION"
      || priorReport.gates?.live_provider_compaction_verified !== true
      || priorReport.gates?.durable_pi_owned_observed_before_interruption !== true
      || priorReport.runtime_selection?.models_config_sha256 !== runtimeSelectionReport.models_config_sha256
      || priorReport.runtime_selection?.runtime_status_sha256 !== runtimeSelectionReport.runtime_status_sha256) {
      throw new Error("Recovery-only prior report does not bind a qualified matching interruption");
    }
    const recoveryPhase = phaseFromRoot(resolvedRecoveryPhasePath);
    const recoveryInput = authoritySnapshot(recoveryPhase.homes.userHome);
    const recoveryEligible = recoveryInput?.integrity === "ok"
      && recoveryInput.foreign_key_violations === 0
      && recoveryInput.compaction_heads.length === 1
      && recoveryInput.compaction_heads[0]?.state === "PI_OWNED"
      && recoveryInput.cache_pending === 0
      && recoveryInput.provider_pending === 0;
    const leaseWait = recoveryEligible ? await waitForLeaseExpiry(recoveryPhase.homes.userHome) : null;
    const recovered = recoveryEligible && leaseWait?.expired ? await runPi(recoveryPhase, "recover") : null;
    const recoveryVerified = restartRecoveryVerified(recovered);
    report = {
      schema_version: 1,
      report_id: "PCH-PROVIDER-BACKED-COMPACTION-RECOVERY",
      created_at: new Date().toISOString(),
      status: recoveryVerified ? "PASS" : "FAIL",
      mode: "RECOVERY_ONLY",
      prior_report_sha256: sha256File(resolvedPriorReportPath),
      runtime_selection: runtimeSelectionReport,
      probe_settings: { ...probeSettings, recovery_only: true },
      gates: { restart_recovery_verified: recoveryVerified },
      recovery_input_authority: recoveryInput,
      restart_lease_wait: leaseWait,
      restart_recovery: recovered,
      limitations: [
        "This report reuses the PI_OWNED authority bound by prior_report_sha256 and makes no live or interruption Provider request.",
        "No credential, raw prompt, raw assistant text, or Provider payload is persisted in this report.",
      ],
    };
  } else {
    const successPhase = preparePhase("ok");
    const success = await runPi(successPhase, "success");
    const successVerified = liveCompactionVerified(success);
    const recoveryPhase = successVerified ? preparePhase("rr") : null;
    const interrupted = recoveryPhase ? await runPi(recoveryPhase, "interrupt") : null;
    const interruptedOwned = interrupted?.interrupted_at_authority?.compaction_heads.some((head) => head.state === "PI_OWNED") === true;
    const leaseWait = recoveryPhase && interruptedOwned ? await waitForLeaseExpiry(recoveryPhase.homes.userHome) : null;
    const recovered = recoveryPhase && interruptedOwned && leaseWait?.expired ? await runPi(recoveryPhase, "recover") : null;
    const recoveryVerified = restartRecoveryVerified(recovered);
    const status = successVerified && interruptedOwned && recoveryVerified ? "PASS" : "FAIL";
    report = {
      schema_version: 1,
      report_id: "PCH-PROVIDER-BACKED-COMPACTION",
      created_at: new Date().toISOString(),
      status,
      runtime_selection: runtimeSelectionReport,
      probe_settings: probeSettings,
      gates: {
        live_provider_compaction_verified: successVerified,
        durable_pi_owned_observed_before_interruption: interruptedOwned,
        restart_recovery_verified: recoveryVerified,
      },
      live_success: success,
      restart_interruption: interrupted,
      restart_lease_wait: leaseWait,
      restart_recovery: recovered,
      limitations: [
        "The successful Provider-backed path uses Pi's manual native compaction trigger with a reduced test-only keepRecentTokens threshold; it is not evidence that the production 272000-token window naturally crosses its threshold.",
        "The recovery path interrupts after durable PI_OWNED authority is observed; the Provider may or may not have accepted the native summary request before process-tree termination.",
        "No credential, raw prompt, raw assistant text, or Provider payload is persisted in this report.",
      ],
    };
  }
  writeJson(reportPath, report);
  if (report.status !== "PASS") process.exitCode = 1;
} catch (error) {
  report = {
    schema_version: 1,
    report_id: "PCH-PROVIDER-BACKED-COMPACTION",
    created_at: new Date().toISOString(),
    status: "ERROR",
    error: redact(error instanceof Error ? error.stack : error).slice(0, 4_000),
  };
  writeJson(reportPath, report);
  process.exitCode = 1;
} finally {
  if (!resolvedRecoveryPhasePath && !keepRuntime && report?.status === "PASS") {
    if (!isWithin(runtimeParent, runtimeRoot) || runtimeRoot === runtimeParent) throw new Error("Refusing unsafe probe cleanup");
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}

process.stdout.write(`${report.status} ${reportPath}\n`);
