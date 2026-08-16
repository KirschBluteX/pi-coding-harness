import { execFile, spawn, type ChildProcess } from "node:child_process";

export interface BoundedCommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface BoundedCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

interface ProcessExit {
  readonly exitCode: number;
}

function boundedPositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is outside its supported bound`);
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
    }, (error) => {
      if (error) reject(new Error(`Windows process-tree termination failed for PID ${pid}`, { cause: error }));
      else resolve();
    });
  });
}

async function terminatePosixProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("Process-tree termination lacks a child PID");
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  await wait(250);
  try { process.kill(-pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  process.kill(-pid, "SIGKILL");
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("Process-tree termination lacks a child PID");
  if (process.platform === "win32") await runTaskkill(pid);
  else await terminatePosixProcessGroup(child);
}

function closeWithin(close: Promise<ProcessExit>, timeoutMs: number): Promise<ProcessExit> {
  return Promise.race([
    close,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Terminated process did not close within its bound")), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export async function runBoundedCommand(input: BoundedCommandInput): Promise<BoundedCommandResult> {
  if (!input.command.trim()) throw new TypeError("Bounded command is empty");
  boundedPositiveInteger(input.timeoutMs, "Bounded command timeout", 24 * 60 * 60 * 1_000);
  boundedPositiveInteger(input.maximumOutputBytes, "Bounded command output limit", 64 * 1024 * 1024);

  const child = spawn(input.command, {
    cwd: input.cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let violationResolve!: (error: Error) => void;
  const violation = new Promise<Error>((resolve) => { violationResolve = resolve; });
  let violationRaised = false;
  const raise = (error: Error): void => {
    if (violationRaised) return;
    violationRaised = true;
    violationResolve(error);
  };
  const capture = (chunk: Buffer): void => {
    if (violationRaised) return;
    bytes += chunk.byteLength;
    if (bytes > input.maximumOutputBytes) {
      raise(new TypeError("Bounded command output exceeded its limit"));
      return;
    }
    chunks.push(Buffer.from(chunk));
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const close = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1 }));
  });
  const abort = (): void => raise(new TypeError("Bounded command was aborted"));
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => raise(new TypeError("Bounded command timed out")), input.timeoutMs);
  timer.unref?.();
  if (input.signal.aborted) abort();

  try {
    const outcome = await Promise.race([
      close.then((result) => ({ kind: "CLOSED" as const, result })),
      violation.then((error) => ({ kind: "VIOLATION" as const, error })),
    ]);
    if (outcome.kind === "CLOSED") {
      return { exitCode: outcome.result.exitCode, output: Buffer.concat(chunks).toString("utf8") };
    }
    try {
      await terminateProcessTree(child);
      await closeWithin(close, 10_000);
    } catch (terminationError) {
      throw new Error("Bounded command could not prove process-tree termination", { cause: terminationError });
    }
    throw outcome.error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    child.stdout?.removeListener("data", capture);
    child.stderr?.removeListener("data", capture);
  }
}
