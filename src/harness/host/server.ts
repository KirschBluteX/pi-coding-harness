import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  parseHostApplicationRequest,
  validateHostApplicationResult,
  type HostMethod,
  type HostParams,
} from "./application-protocol.js";
import { assertHostRequest, makeHostResponse, parseIpcLine } from "./protocol.js";

export interface HostDispatchError extends Error {
  readonly code?: string;
}

export type HostDispatcher = (method: HostMethod, params: HostParams<HostMethod>) => unknown;

export interface HostServerOptions {
  readonly replayWindow?: number;
  readonly onProtocolError?: (error: Error) => void;
}

export class HostIpcServer {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly replayWindow: number;

  constructor(
    private readonly secret: Uint8Array,
    private readonly dispatch: HostDispatcher,
    options: HostServerOptions = {},
  ) {
    this.replayWindow = options.replayWindow ?? 4_096;
    if (!Number.isSafeInteger(this.replayWindow) || this.replayWindow < 1) throw new TypeError("IPC replay window is invalid");
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
  }

  private readonly onProtocolError: (error: Error) => void;

  async handleLine(line: string): Promise<string | null> {
    let value: unknown;
    try {
      value = parseIpcLine(line);
      assertHostRequest(this.secret, value);
    } catch (error) {
      this.onProtocolError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
    const request = value;
    if (this.seen.has(request.nonce)) {
      return `${JSON.stringify(makeHostResponse(this.secret, {
        request_id: request.request_id, nonce: request.nonce, ok: false, result: null,
        error: { code: "IPC_REPLAY", message: "Request nonce was already consumed" },
      }))}\n`;
    }
    this.seen.add(request.nonce);
    this.order.push(request.nonce);
    if (this.order.length > this.replayWindow) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    try {
      const applicationRequest = parseHostApplicationRequest(request.method, request.params);
      const result = validateHostApplicationResult(
        applicationRequest.method,
        await this.dispatch(applicationRequest.method, applicationRequest.params),
      );
      return `${JSON.stringify(makeHostResponse(this.secret, {
        request_id: request.request_id, nonce: request.nonce, ok: true, result, error: null,
      }))}\n`;
    } catch (error) {
      const typed: HostDispatchError = error instanceof Error ? error : new Error(String(error));
      return `${JSON.stringify(makeHostResponse(this.secret, {
        request_id: request.request_id, nonce: request.nonce, ok: false, result: null,
        error: { code: typed.code ?? "HOST_METHOD_FAILED", message: typed.message.slice(0, 2_048) },
      }))}\n`;
    }
  }

  serve(input: Readable, output: Writable): () => void {
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    let writes = Promise.resolve();
    lines.on("line", (line) => {
      writes = writes.then(async () => {
        const response = await this.handleLine(line);
        if (response !== null && !output.destroyed) output.write(response);
      }).catch((error: unknown) => this.onProtocolError(error instanceof Error ? error : new Error(String(error))));
    });
    return () => lines.close();
  }
}
