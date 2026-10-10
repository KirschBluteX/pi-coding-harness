import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingHarnessHostRuntime } from "../../src/harness/host/runtime.js";
import { SessionHistoryStore } from "../../src/standalone/history.js";
import { runSingle } from "../../src/standalone/loop.js";
import type { ChatModel, ModelTurn } from "../../src/standalone/provider.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "pch-independent-"));
  roots.push(root);
  const cwd = resolve(root, "workspace");
  mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n");
  writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const hostOptions = {
    packageRoot, configPath: resolve(packageRoot, "config", "default.json"),
    dataRoot: resolve(root, "data"), hostSecret: Buffer.alloc(32, 7),
  };
  const contract = withAcceptanceV2({
    user_outcomes: ["The local file is updated and verified"], scope: ["src/example.ts"],
    non_goals: ["No external deployment"], constraints: ["Keep the change local"],
    obligations: [{ key: "verified-output", priority: "MUST", statement: "The final workspace passes npm test",
      oracle: { command: "npm test" } }],
    authorization_ceiling: "LOCAL_REVERSIBLE",
  });
  const route = {
    outcomes: ["The bounded change is implemented"], goal_fit_assessment: passingGoalFitAssessment(),
    work_cells: [{
      key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
      read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE"],
      oracle: { command: "npm test" }, risk: "LOW", reversible: true,
    }],
    near_horizon: ["bounded-change"],
  };
  const modelRuntime = { provider: "fixture", api: "openai-chat-completions", base_url: "http://localhost/v1",
    model: "fixture", thinking_level: "unspecified", context_window: 32_768 };
  return { cwd, hostOptions, contract, route, modelRuntime };
}

describe("independent Single lifecycle", () => {
  it("uses one Host for USER review, managed edit, fresh validation and terminal closure", async () => {
    const { cwd, hostOptions, contract, route, modelRuntime } = fixture();
    const runtime = new CodingHarnessHostRuntime(hostOptions);
    const actions = [
      [{ id: "CALL-CONTRACT", name: "coding_flow", arguments: { action: "submit_contract", contract } }],
      [{ id: "CALL-ROUTE", name: "coding_flow", arguments: { action: "submit_route", route } }],
      [
        { id: "CALL-EDIT", name: "edit", arguments: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" } },
        { id: "CALL-TEST", name: "bash", arguments: { command: "npm test" } },
      ],
      [{ id: "CALL-COMPLETE", name: "coding_flow", arguments: { action: "complete" } }],
    ] as const;
    let modelCalls = 0;
    const model: ChatModel = { async turn(): Promise<ModelTurn> {
      const toolCalls = actions[modelCalls++];
      if (!toolCalls) throw new TypeError("Unexpected extra model request");
      return { text: "", toolCalls, usage: null, finishReason: "tool_calls" };
    } };
    try {
      const result = await runSingle({
        host: { request: (method, params) => runtime.dispatch(method, params) },
        model, cwd, sessionId: "SESSION-INDEPENDENT-1",
        objective: "Update and verify src/example.ts", intent: "BUILD",
        runtime: modelRuntime,
        approveContract: async () => ({ action: "APPROVE" }),
      });
      expect(result.status).toBe("COMPLETED");
      expect(modelCalls).toBe(4);
      expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(result.hostStatus.changed_files).toMatchObject([{ path: "src/example.ts", change: "MODIFIED" }]);
    } finally { runtime.close(); }
  }, 60_000);

  it("recovers after an observed edit whose tool response was not saved, without replaying the edit", async () => {
    const { cwd, hostOptions, contract, route, modelRuntime } = fixture();
    const history = new SessionHistoryStore(hostOptions.dataRoot);
    const sessionId = "SESSION-INTERRUPTED-1";
    let goalId: string | undefined;
    let modelCalls = 0;
    const firstModel: ChatModel = { async turn(): Promise<ModelTurn> {
      const actions = [
        [{ id: "CALL-CONTRACT", name: "coding_flow", arguments: { action: "submit_contract", contract } }],
        [{ id: "CALL-ROUTE", name: "coding_flow", arguments: { action: "submit_route", route } }],
        [{ id: "CALL-EDIT", name: "edit", arguments: {
          path: "src/example.ts", oldText: "value = 1", newText: "value = 2",
        } }],
      ] as const;
      const toolCalls = actions[modelCalls++];
      if (!toolCalls) throw new TypeError("Unexpected extra model request before interruption");
      return { text: "", toolCalls, usage: null, finishReason: "tool_calls" };
    } };
    const firstHost = new CodingHarnessHostRuntime(hostOptions);
    try {
      await expect(runSingle({
        host: { request: (method, params) => firstHost.dispatch(method, params) },
        model: firstModel, cwd, sessionId, objective: "Update and verify src/example.ts",
        intent: "BUILD", runtime: modelRuntime, approveContract: async () => ({ action: "APPROVE" }),
        saveMessages: (messages, status) => {
          if (!status.flow) return;
          goalId = status.flow.goalId;
          const last = messages.at(-1);
          if (last?.role === "tool" && last.tool_call_id === "CALL-EDIT") {
            throw new Error("Simulated crash before transcript persistence");
          }
          history.save({ sessionId, goalId, workspace: cwd, messages });
        },
      })).rejects.toThrow(/Simulated crash/);
    } finally { firstHost.close(); }
    expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 2;\n");
    const saved = history.load(sessionId);
    expect(saved?.goalId).toBe(goalId);
    expect(saved?.messages.at(-1)?.role).toBe("assistant");
    let recoveryCalls = 0;
    const recoveryModel: ChatModel = { async turn(messages): Promise<ModelTurn> {
      if (recoveryCalls++ === 0) {
        expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "CALL-EDIT" });
        expect(messages.at(-1)?.content).toMatch(/lost during interruption.*do not replay/is);
        return { text: "", toolCalls: [{ id: "CALL-TEST", name: "bash", arguments: { command: "npm test" } }],
          usage: null, finishReason: "tool_calls" };
      }
      return { text: "", toolCalls: [{ id: "CALL-COMPLETE", name: "coding_flow",
        arguments: { action: "complete" } }], usage: null, finishReason: "tool_calls" };
    } };
    const secondHost = new CodingHarnessHostRuntime(hostOptions);
    try {
      const result = await runSingle({
        host: { request: (method, params) => secondHost.dispatch(method, params) },
        model: recoveryModel, cwd, sessionId, objective: "Update and verify src/example.ts",
        intent: "BUILD", runtime: modelRuntime, recoverGoalId: goalId!,
        initialMessages: saved!.messages,
        saveMessages: (messages, status) => {
          if (status.flow) history.save({ sessionId, goalId: status.flow.goalId, workspace: cwd, messages });
        },
      });
      expect(result.status).toBe("COMPLETED");
      expect(recoveryCalls).toBe(2);
      expect(readFileSync(resolve(cwd, "src", "example.ts"), "utf8")).toBe("export const value = 2;\n");
    } finally { secondHost.close(); }
  }, 60_000);
});
