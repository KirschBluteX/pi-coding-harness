import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  parseHostApplicationRequest,
  validateHostApplicationResult,
  type HostApplicationRequest,
  type HostMethod,
  type HostParams,
  type HostResult,
} from "./application-protocol.js";
import { assertHostResponse, makeHostRequest, MAX_IPC_LINE_BYTES, parseIpcLine } from "./protocol.js";

interface PendingRequest {
  readonly nonce: string;
  readonly method: HostMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface LateResponseTombstone {
  readonly nonce: string;
  readonly method: HostMethod;
  readonly expiresAtMs: number;
}

const LATE_RESPONSE_TTL_MS = 10 * 60_000;

export interface HostClientOptions {
  readonly timeoutMs?: number;
  readonly maxPending?: number;
}

export class HostRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lateResponses = new Map<string, LateResponseTombstone>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private closed = false;
  private readonly closeLines: () => void;
  private stderrTail = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly secret: Uint8Array, options: HostClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxPending = options.maxPending ?? 64;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    this.closeLines = () => lines.close();
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-16_384);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => this.failAll(new Error(
      `Coding Harness Host exited code=${code ?? "null"} signal=${signal ?? "null"}${this.stderrTail ? ` stderr=${this.stderrTail.trim()}` : ""}`,
    )));
  }

  request<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs = this.timeoutMs): Promise<HostResult<M>> {
    if (this.closed || this.child.stdin.destroyed) return Promise.reject(new Error("Coding Harness Host is not available"));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Coding Harness Host request limit reached"));
    let applicationRequest: HostApplicationRequest;
    try {
      applicationRequest = parseHostApplicationRequest(method, params);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestId = `REQ-${randomUUID().toUpperCase()}`;
    const nonce = randomBytes(16).toString("hex");
    const envelope = makeHostRequest(this.secret, {
      request_id: requestId, nonce, method: applicationRequest.method, params: applicationRequest.params,
    });
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_IPC_LINE_BYTES) return Promise.reject(new Error("Coding Harness Host request is too large"));
    return new Promise<HostResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.rememberTimedOut(requestId, nonce, applicationRequest.method);
        reject(new Error(`Coding Harness Host request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        nonce,
        method: applicationRequest.method,
        resolve: (value) => resolve(value as HostResult<M>),
        reject,
        timer,
      });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request("shutdown", null, 2_000); } catch { /* Process teardown below is authoritative. */ }
    this.closed = true;
    this.closeLines();
    this.failAll(new Error("Coding Harness Host client closed"));
    this.secret.fill(0);
    if (!this.child.killed) this.child.kill();
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = parseIpcLine(line);
      assertHostResponse(this.secret, value);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const pending = this.pending.get(value.request_id);
    if (!pending) {
      const late = this.lateResponses.get(value.request_id);
      if (late) this.lateResponses.delete(value.request_id);
      if (late && late.expiresAtMs > Date.now() && late.nonce === value.nonce) {
        if (value.ok) {
          try { validateHostApplicationResult(late.method, value.result); }
          catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))); }
        }
        return;
      }
      this.failAll(new Error("Coding Harness Host response binding mismatch"));
      return;
    }
    if (pending.nonce !== value.nonce) {
      this.failAll(new Error("Coding Harness Host response binding mismatch"));
      return;
    }
    if (value.ok) {
      try {
        const result = validateHostApplicationResult(pending.method, value.result);
        clearTimeout(pending.timer);
        this.pending.delete(value.request_id);
        pending.resolve(result);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.request_id);
    pending.reject(Object.assign(new Error(value.error?.message ?? "Coding Harness Host request failed"), { code: value.error?.code }));
  }

  private rememberTimedOut(requestId: string, nonce: string, method: HostMethod): void {
    const now = Date.now();
    for (const [id, tombstone] of this.lateResponses) {
      if (tombstone.expiresAtMs <= now) this.lateResponses.delete(id);
    }
    const limit = this.maxPending * 4;
    while (this.lateResponses.size >= limit) {
      const oldest = this.lateResponses.keys().next().value;
      if (oldest === undefined) break;
      this.lateResponses.delete(oldest);
    }
    this.lateResponses.set(requestId, { nonce, method, expiresAtMs: now + LATE_RESPONSE_TTL_MS });
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.lateResponses.clear();
    this.closeLines();
    this.secret.fill(0);
    if (!this.child.killed) this.child.kill();
  }
}

export interface SpawnHostOptions extends HostClientOptions {
  readonly entryPath: string;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly configPath: string;
  readonly dataRoot?: string;
}

export function spawnCodingHarnessHost(options: SpawnHostOptions): HostRpcClient {
  const secret = randomBytes(32);
  const child = spawn(process.execPath, [options.entryPath], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PCH_HOST_SECRET: secret.toString("hex"),
      PCH_PACKAGE_ROOT: options.packageRoot,
      PCH_CONFIG_PATH: options.configPath,
      ...(options.dataRoot === undefined ? {} : { PCH_DATA_ROOT: options.dataRoot }),
    },
  });
  return new HostRpcClient(child, secret, options);
}
