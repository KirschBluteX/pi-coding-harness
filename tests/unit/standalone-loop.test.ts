import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSingle } from "../../src/standalone/loop.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const frame = "a".repeat(64);
const runtime = { provider: "fixture", api: "openai-chat-completions", base_url: "http://localhost/v1",
  model: "fixture", thinking_level: "configured", context_window: 16_384 };

function status(nextAction: string, contractReview: object | null = null) {
  return {
    active: true, flow: { goalId: "GOAL-1", objective: "Edit file", mode: "BUILD", phase: "BUILDING",
      workCell: "CELL-1", routeHealth: "H0_CONTINUE", nextAction, blocker: null, unresolvedOperationIds: [] },
    contract_review: contractReview, plan_review: null, open_clarifications: [],
    control_frame: { control_frame_sha256: frame }, changed_files: [],
  };
}

describe("standalone Single loop", () => {
  it("reconciles Host effects before repairing a transcript interrupted between tool results", async () => {
    const calls: string[] = [];
    const presented: string[] = [];
    let current = {
      ...status("EXECUTE_WORK"),
      flow: { ...status("EXECUTE_WORK").flow, unresolvedOperationIds: ["OP-2"] },
    };
    const host = { async request(method: string) {
      calls.push(method);
      if (method === "enter" || method === "status") return current;
      if (method === "turn_projection") return { system_prompt: "Host-guided" };
      if (method === "reconcile") { current = status("EXECUTE_WORK"); return { status: current }; }
      if (method === "provider_begin") return { provider_attempt_id: "ATTEMPT-1", cache_request_id: null };
      if (method === "provider_settle" || method === "generation_settled") return {};
      if (method === "generation_turn") return { decision: "CONTINUE", directive: null };
      throw new Error(`Unexpected ${method}`);
    } };
    const model = { async turn(messages: readonly { role: string; tool_call_id?: string; content: unknown }[]) {
      expect(calls.indexOf("reconcile")).toBeLessThan(calls.indexOf("provider_begin"));
      expect(messages.slice(-3).map((message) => [message.role, message.tool_call_id])).toEqual([
        ["assistant", undefined], ["tool", "CALL-1"], ["tool", "CALL-2"],
      ]);
      expect(messages.at(-1)?.content).toMatch(/lost during interruption.*do not replay/is);
      return { text: "Need fresh evidence", toolCalls: [], usage: null, finishReason: "stop" };
    } };
    const result = await runSingle({
      host, model, cwd: process.cwd(), sessionId: "SESSION-1", objective: "Edit file",
      intent: "BUILD", runtime, recoverGoalId: "GOAL-1",
      onAssistantText: (text) => { presented.push(text); },
      initialMessages: [
        { role: "system", content: "Old system prompt" },
        { role: "user", content: "Edit file" },
        { role: "assistant", content: null, tool_calls: [
          { id: "CALL-1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "CALL-2", type: "function", function: { name: "edit", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "CALL-1", content: "previous result" },
      ],
    });
    expect(result.status).toBe("STOPPED");
    expect(presented).toEqual(["Need fresh evidence"]);
    expect(calls).toContain("reconcile");
    expect(calls).not.toContain("tool_preflight");
    expect(result.messages.filter((message) => message.role === "tool" && message.tool_call_id === "CALL-2")).toHaveLength(1);
  });

  it("does not ask the model to replay a tool while Host reconciliation remains unresolved", async () => {
    const pending = {
      ...status("RECONCILE_OPERATION"),
      flow: { ...status("RECONCILE_OPERATION").flow, unresolvedOperationIds: ["OP-1"] },
    };
    const calls: string[] = [];
    const host = { async request(method: string) {
      calls.push(method);
      if (method === "enter" || method === "status") return pending;
      if (method === "turn_projection") return { system_prompt: "Host-guided" };
      if (method === "reconcile") return { status: pending };
      if (method === "generation_settled") return {};
      throw new Error(`Unexpected ${method}`);
    } };
    const model = { async turn() { throw new Error("Model must not run while effect is unresolved"); } };
    const result = await runSingle({
      host, model, cwd: process.cwd(), sessionId: "SESSION-1", objective: "Edit file",
      intent: "BUILD", runtime, recoverGoalId: "GOAL-1",
      initialMessages: [
        { role: "system", content: "Old system prompt" },
        { role: "user", content: "Edit file" },
        { role: "assistant", content: null, tool_calls: [
          { id: "CALL-1", type: "function", function: { name: "edit", arguments: "{}" } },
        ] },
      ],
    });
    expect(result.reason).toMatch(/outcome remains unknown/i);
    expect(calls).not.toContain("provider_begin");
    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("does not call the model while an explicit Goal Contract review is pending", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-loop-review-"));
    roots.push(cwd);
    const review = { decision_requirement_revision_id: "REV-1", requirement_revision_sha256: frame,
      decision_frontier_sha256: frame, contract_diff: {}, requirement_diff: {} };
    const methods: string[] = [];
    const host = { async request(method: string) {
      methods.push(method);
      if (method === "enter") return status("REVIEW_CONTRACT", review);
      throw new Error(`Unexpected ${method}`);
    } };
    const model = { async turn() { throw new Error("Model must not be called"); } };
    const result = await runSingle({ host, model, cwd, sessionId: "SESSION-1", objective: "Edit file",
      intent: "BUILD", runtime });
    expect(result.reason).toMatch(/review/i);
    expect(methods).toEqual(["enter"]);
  });

  it("records each provider attempt and observes a Host-authorized edit before completion", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-loop-edit-"));
    roots.push(cwd);
    writeFileSync(resolve(cwd, "file.txt"), "original");
    const methods: string[] = [];
    let current = status("EXECUTE_WORK");
    const host = { async request(method: string) {
      methods.push(method);
      if (method === "enter" || method === "status") return current;
      if (method === "turn_projection") return { system_prompt: "Host-guided", changed: true,
        control_frame: { control_frame_sha256: frame }, generation_governor: { decision: "CONTINUE" } };
      if (method === "provider_begin") return { recorded: true, provider_attempt_id: "ATTEMPT-1", cache_request_id: null };
      if (method === "provider_settle") return { ledger_sha256: frame, cache: null };
      if (method === "tool_preflight") return { allow: true, managed: true, capture: true, reason: null };
      if (method === "tool_result") return { operation_id: "OP-1", control_frame: { control_frame_sha256: frame } };
      if (method === "tool_end") { current = status("NONE"); return { status: current, control_frame: { control_frame_sha256: frame } }; }
      if (method === "generation_turn" || method === "generation_settled") return { decision: "TERMINAL", directive: null };
      throw new Error(`Unexpected ${method}`);
    } };
    let modelCalls = 0;
    const model = { async turn() {
      modelCalls += 1;
      return { text: "", toolCalls: [{ id: "call-1", name: "edit",
        arguments: { path: "file.txt", oldText: "original", newText: "changed" } }],
        usage: { input: 10, output: 4, cacheRead: null, cacheWrite: null, reasoning: null }, finishReason: "tool_calls" };
    } };
    const result = await runSingle({ host, model, cwd, sessionId: "SESSION-1", objective: "Edit file",
      intent: "BUILD", runtime });
    expect(result.status).toBe("COMPLETED");
    expect(modelCalls).toBe(1);
    expect(methods.indexOf("provider_begin")).toBeLessThan(methods.indexOf("provider_settle"));
    expect(methods.indexOf("tool_preflight")).toBeLessThan(methods.indexOf("tool_result"));
    expect(methods.indexOf("tool_result")).toBeLessThan(methods.indexOf("tool_end"));
    expect(readFileSync(resolve(cwd, "file.txt"), "utf8")).toBe("changed");
  });
});
