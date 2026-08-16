import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_METHODS,
  parseHostApplicationRequest,
  validateHostApplicationResult,
} from "../../src/harness/host/application-protocol.js";
import { makeHostRequest, makeHostResponse, assertHostRequest, assertHostResponse, parseIpcLine } from "../../src/harness/host/protocol.js";
import { HostRpcClient } from "../../src/harness/host/client.js";
import { HostIpcServer } from "../../src/harness/host/server.js";

const secret = Buffer.alloc(32, 7);

describe("Coding Harness Host IPC", () => {
  it("authenticates strict request and response envelopes", () => {
    const request = makeHostRequest(secret, { request_id: "REQ-TEST-0001", nonce: "a".repeat(32), method: "status", params: null });
    expect(() => assertHostRequest(secret, request)).not.toThrow();
    expect(() => assertHostRequest(secret, { ...request, method: "enter" })).toThrow("IPC_AUTH_FAILED");
    expect(() => assertHostRequest(secret, { ...request, extra: true })).toThrow("IPC_REQUEST_INVALID");
    const response = makeHostResponse(secret, { request_id: request.request_id, nonce: request.nonce, ok: true, result: {}, error: null });
    expect(() => assertHostResponse(secret, response)).not.toThrow();
    expect(() => assertHostResponse(secret, { ...response, ok: false })).toThrow("IPC_RESPONSE_INVALID");
  });

  it("rejects replay without dispatching the method twice", async () => {
    let calls = 0;
    const server = new HostIpcServer(secret, () => { calls += 1; return { stopped: true }; });
    const request = makeHostRequest(secret, { request_id: "REQ-TEST-0002", nonce: "b".repeat(32), method: "shutdown", params: null });
    const first = parseIpcLine((await server.handleLine(JSON.stringify(request)))!.trim());
    assertHostResponse(secret, first);
    const second = parseIpcLine((await server.handleLine(JSON.stringify(request)))!.trim());
    assertHostResponse(secret, second);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("IPC_REPLAY");
    expect(calls).toBe(1);
  });

  it("serializes stream dispatch and ignores unauthenticated lines", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const errors: Error[] = [];
    const server = new HostIpcServer(secret, () => ({ stopped: true }), { onProtocolError: (error) => errors.push(error) });
    const stop = server.serve(input, output);
    input.write("{}\n");
    input.write(`${JSON.stringify(makeHostRequest(secret, { request_id: "REQ-TEST-0003", nonce: "c".repeat(32), method: "shutdown", params: null }))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(errors).toHaveLength(1);
    expect(Buffer.concat(chunks).toString("utf8")).toContain('"ok":true');
  });

  it("uses one closed application catalog for params, routing, and results", async () => {
    expect(HOST_METHODS).toContain("enter");
    expect(HOST_METHODS).toContain("complete");
    expect(HOST_METHODS).toContain("resolve_contract_review");
    expect(HOST_METHODS).not.toContain("submit_build");
    expect(HOST_METHODS).not.toContain("coding");
    expect(HOST_METHODS).not.toContain("worker_wait");
    expect(HOST_METHODS).not.toContain("tool_start");
    expect(new Set(HOST_METHODS).size).toBe(HOST_METHODS.length);
    expect(parseHostApplicationRequest("status", null)).toEqual({ method: "status", params: null });
    expect(() => parseHostApplicationRequest("coding", null)).toThrow("Unknown Coding Harness Host method");
    expect(() => parseHostApplicationRequest("worker_wait", { job_id: "JOB-1", wait_ms: 1 }))
      .toThrow("Unknown Coding Harness Host method");
    expect(() => parseHostApplicationRequest("tool_start", { tool_call_id: "CALL-1" }))
      .toThrow("Unknown Coding Harness Host method");
    expect(() => parseHostApplicationRequest("submit_build", {}))
      .toThrow("Unknown Coding Harness Host method");
    expect(() => parseHostApplicationRequest("status", {})).toThrow("Invalid Coding Harness Host params");
    expect(parseHostApplicationRequest("complete", {
      control_frame_sha256: "a".repeat(64),
      outcome_evidence: [{
        obligation_key: "browser-clients", operation_id: "OPERATION-1",
        witnesses: [{ path: "tests/browser.test.ts", locator: "browser clients retain behavior" }],
      }],
    })).toMatchObject({ method: "complete" });
    expect(() => parseHostApplicationRequest("complete", {
      control_frame_sha256: "a".repeat(64), outcome_evidence: [],
    })).toThrow("complete params are invalid");
    expect(parseHostApplicationRequest("resolve_contract_review", {
      expected_decision_requirement_revision_id: "DECISION-REVISION-1",
      expected_requirement_revision_sha256: "b".repeat(64),
      expected_decision_frontier_sha256: "c".repeat(64),
      action: "APPROVE",
      selected_value: true,
    })).toMatchObject({ method: "resolve_contract_review" });
    const continuation = {
      control_frame_sha256: "d".repeat(64),
      expected_route_sha256: "e".repeat(64),
      expected_plan_revision_sha256: "f".repeat(64),
      expected_stage_gate_sha256: "1".repeat(64),
      choice: "BUILD",
    } as const;
    expect(parseHostApplicationRequest("continue_plan", continuation)).toMatchObject({ method: "continue_plan" });
    for (const key of Object.keys(continuation)) {
      const incomplete = { ...continuation } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => parseHostApplicationRequest("continue_plan", incomplete)).toThrow("continue_plan params are invalid");
    }
    expect(() => parseHostApplicationRequest("continue_plan", { ...continuation, unexpected: true }))
      .toThrow("continue_plan params are invalid");
    expect(() => parseHostApplicationRequest("continue_plan", { ...continuation, expected_stage_gate_sha256: "not-a-sha" }))
      .toThrow("continue_plan params are invalid");
    expect(() => parseHostApplicationRequest("continue_plan", { choice: "BUILD" }))
      .toThrow("continue_plan params are invalid");
    const activeGoalInput = { text: "Preserve the adjacent parser." } as const;
    expect(parseHostApplicationRequest("active_goal_input", activeGoalInput))
      .toMatchObject({ method: "active_goal_input" });
    expect(() => parseHostApplicationRequest("active_goal_input", {}))
      .toThrow("active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("active_goal_input", { ...activeGoalInput, unexpected: true }))
      .toThrow("active_goal_input params are invalid");
    const activeGoalClassification = {
      control_frame_sha256: "2".repeat(64),
      user_turn_id: "USER_TURN-1",
      expected_user_turn_sha256: "3".repeat(64),
      classification: "DISCUSSION_ONLY",
      materiality: "LOW",
      change_kind: null,
      changed_subjects: [],
    } as const;
    expect(parseHostApplicationRequest("classify_active_goal_input", activeGoalClassification))
      .toMatchObject({ method: "classify_active_goal_input" });
    for (const key of Object.keys(activeGoalClassification)) {
      const incomplete = { ...activeGoalClassification } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => parseHostApplicationRequest("classify_active_goal_input", incomplete))
        .toThrow("classify_active_goal_input params are invalid");
    }
    expect(() => parseHostApplicationRequest("classify_active_goal_input", {
      ...activeGoalClassification, unexpected: true,
    })).toThrow("classify_active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("classify_active_goal_input", {
      ...activeGoalClassification, expected_user_turn_sha256: "not-a-sha",
    })).toThrow("classify_active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("classify_active_goal_input", {
      ...activeGoalClassification,
      classification: "CHANGE_REQUEST",
      change_kind: "SCOPE",
      changed_subjects: [{ kind: "WORK_CELL", id: "CELL-1", unexpected: true }],
    })).toThrow("classify_active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("control", {
      control_frame_sha256: "not-a-sha", action: "DESTROY", unexpected: true,
    })).toThrow("control params are invalid");
    expect(() => parseHostApplicationRequest("resolve_contract_review", {
      expected_decision_requirement_revision_id: "DECISION-REVISION-1",
      expected_requirement_revision_sha256: "b".repeat(64),
      expected_decision_frontier_sha256: "c".repeat(64),
      action: "EDIT",
      selected_value: { feedback: "change scope" },
    })).toThrow("resolve_contract_review params are invalid");
    expect(() => parseHostApplicationRequest("enter", {})).toThrow("entry contract is invalid");
    expect(() => parseHostApplicationRequest("enter", {
      cwd: "X:\\workspace",
      session_id: "SESSION-1",
      objective: "Build the bounded target",
      intent: "BUILD",
      topology: "SINGLE",
      runtime: {
        provider: "configured-provider",
        api: "configured-api",
        model: "configured-model",
        thinking_level: "configured",
        context_window: 32_768,
        unexpected: true,
      },
    })).toThrow("entry contract is invalid");
    expect(parseHostApplicationRequest("context_fetch", {
      control_frame_sha256: "a".repeat(64), selector: "CURRENT_ON_DEMAND", candidate_ids: [],
    }).method).toBe("context_fetch");
    const legacyDiscovery = {
      current_session_binding: null,
      recoverable: [{
        goal_id: "GOAL-LEGACY-UNBOUND", goal_title: "Legacy unbound Goal", objective: "Recover safely",
        intent: "PLAN_ONLY", status: "WAITING_USER", next_action_code: "REVIEW_CONTRACT",
        binding_state: "UNBOUND", controller_session_id: null, controller_live: false,
        binding_receipt_sha256: null,
      }],
    } as const;
    expect(validateHostApplicationResult("discover_goals", legacyDiscovery)).toEqual(legacyDiscovery);
    expect(() => validateHostApplicationResult("discover_goals", {
      ...legacyDiscovery,
      recoverable: [{ ...legacyDiscovery.recoverable[0], binding_receipt_sha256: "not-a-sha" }],
    })).toThrow("Invalid Coding Harness Host result");
    expect(() => validateHostApplicationResult("shutdown", { stopped: false })).toThrow("Invalid Coding Harness Host result");
    expect(() => validateHostApplicationResult("status", {
      active: false, flow: null, harness: null, execution_subject: null, context: null,
      cache: { configured: false, enabled: false, arm: "C0", effective_arm: "C0", provider_integration: null, reason: "DISABLED" },
      output: { enabled: false, mode: "NORMAL" }, decision_inbox: { forged: true },
      generation_governor: null, runtime: null, intent: null, topology: null, control_frame: null,
    })).toThrow("Invalid Coding Harness Host result");

    let calls = 0;
    const server = new HostIpcServer(secret, () => { calls += 1; return { stopped: false }; });
    const unknown = makeHostRequest(secret, {
      request_id: "REQ-TEST-0004", nonce: "d".repeat(32), method: "coding", params: null,
    });
    const unknownResponse = parseIpcLine((await server.handleLine(JSON.stringify(unknown)))!.trim());
    assertHostResponse(secret, unknownResponse);
    expect(unknownResponse).toMatchObject({ ok: false, error: { code: "HOST_METHOD_UNKNOWN" } });
    expect(calls).toBe(0);

    const invalidResult = makeHostRequest(secret, {
      request_id: "REQ-TEST-0005", nonce: "e".repeat(32), method: "shutdown", params: null,
    });
    const invalidResponse = parseIpcLine((await server.handleLine(JSON.stringify(invalidResult)))!.trim());
    assertHostResponse(secret, invalidResponse);
    expect(invalidResponse).toMatchObject({ ok: false, error: { code: "HOST_RESULT_INVALID" } });
    expect(calls).toBe(1);
  });

  it("round-trips exact active Goal UTF-8 text without NFC normalization", () => {
    const text = "e\u0301";

    expect(parseHostApplicationRequest("active_goal_input", { text })).toEqual({
      method: "active_goal_input",
      params: { text },
    });
  });

  it("bounds active Goal input by raw UTF-8 bytes", () => {
    const exactLimit = "\u00e9".repeat(65_536);

    expect(parseHostApplicationRequest("active_goal_input", { text: exactLimit })).toEqual({
      method: "active_goal_input",
      params: { text: exactLimit },
    });
    expect(() => parseHostApplicationRequest("active_goal_input", { text: `${exactLimit}a` }))
      .toThrow("active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("active_goal_input", { text: "" }))
      .toThrow("active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("active_goal_input", { text: " \t\r\n" }))
      .toThrow("active_goal_input params are invalid");
    expect(() => parseHostApplicationRequest("active_goal_input", { text: "\ud800" }))
      .toThrow("active_goal_input params are invalid");
  });

  it("binds each client response to the requested method result validator", async () => {
    const clientSecret = Buffer.alloc(32, 8);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, killed: false,
      kill(): boolean { this.killed = true; return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
    stdin.once("data", (chunk: Buffer) => {
      const request = parseIpcLine(chunk.toString("utf8").trim());
      assertHostRequest(clientSecret, request);
      stdout.write(`${JSON.stringify(makeHostResponse(clientSecret, {
        request_id: request.request_id,
        nonce: request.nonce,
        ok: true,
        result: { stopped: false },
        error: null,
      }))}\n`);
    });
    const client = new HostRpcClient(child, clientSecret, { timeoutMs: 1_000 });
    await expect(client.request("shutdown", null)).rejects.toMatchObject({ code: "HOST_RESULT_INVALID" });
    expect(child.killed).toBe(true);
  });

  it("ignores an authenticated late response after timeout and keeps serving requests", async () => {
    const clientSecret = Buffer.alloc(32, 9);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, killed: false,
      kill(): boolean { this.killed = true; return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
    let requestCount = 0;
    stdin.on("data", (chunk: Buffer) => {
      const request = parseIpcLine(chunk.toString("utf8").trim());
      assertHostRequest(clientSecret, request);
      requestCount += 1;
      const respond = (): void => {
        stdout.write(`${JSON.stringify(makeHostResponse(clientSecret, {
          request_id: request.request_id, nonce: request.nonce, ok: true,
          result: { stopped: true }, error: null,
        }))}\n`);
      };
      if (requestCount === 1) setTimeout(respond, 30);
      else respond();
    });
    const client = new HostRpcClient(child, clientSecret, { timeoutMs: 10 });
    await expect(client.request("shutdown", null)).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(child.killed).toBe(false);
    await expect(client.request("shutdown", null)).resolves.toEqual({ stopped: true });
    expect(child.killed).toBe(false);
    await client.close();
  });

  it("fails closed when an authenticated late response arrives after its tombstone expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const clientSecret = Buffer.alloc(32, 10);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin, stdout, stderr, killed: false,
        kill(): boolean { this.killed = true; return true; },
      }) as unknown as ChildProcessWithoutNullStreams;
      const captured: { request?: { readonly request_id: string; readonly nonce: string } } = {};
      stdin.once("data", (chunk: Buffer) => {
        const parsed = parseIpcLine(chunk.toString("utf8").trim());
        assertHostRequest(clientSecret, parsed);
        captured.request = { request_id: parsed.request_id, nonce: parsed.nonce };
      });
      const client = new HostRpcClient(child, clientSecret, { timeoutMs: 10 });
      const pending = client.request("shutdown", null);
      const rejection = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      vi.setSystemTime(new Date("2026-01-01T00:10:00.100Z"));
      const request = captured.request;
      if (!request) throw new Error("request was not captured");
      const response = makeHostResponse(clientSecret, {
        request_id: request.request_id, nonce: request.nonce, ok: true,
        result: { stopped: true }, error: null,
      });
      (client as unknown as { onLine(line: string): void }).onLine(JSON.stringify(response));
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
