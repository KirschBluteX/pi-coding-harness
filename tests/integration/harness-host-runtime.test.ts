import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodingHarnessHostRuntime } from "../../src/harness/host/runtime.js";
import type { HostStatus } from "../../src/harness/host/application-protocol.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { ProjectionDeltaLedger, type ContextProjectionDelta } from "../../src/input-context/projection-delta.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { loadConfig } from "../../src/config/load-config.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment, passingMaterialChangeGoalFitAssessment } from "../helpers/goal-fit.js";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];

function transportDelta(delta: ContextProjectionDelta) {
  return {
    schema_version: delta.schema_version, lineage_id: delta.lineage_id,
    previous_sequence_root: delta.previous_sequence_root, previous_count: delta.previous_count,
    append: delta.append.map((entry) => ({
      content_sha256: entry.contentSha256, role: entry.role, custom_type: entry.customType,
    })),
    new_sequence_root: delta.new_sequence_root, new_count: delta.new_count,
    full_reconcile: delta.full_reconcile,
  };
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "pch-host-"));
  roots.push(root);
  const cwd = resolve(root, "workspace");
  mkdirSync(cwd);
  const options = {
    packageRoot,
    configPath: resolve(packageRoot, "config", "default.json"),
    dataRoot: resolve(root, "data"),
    hostSecret: Buffer.alloc(32, 9),
    now: () => 10_000,
  };
  return { root, cwd, options };
}

function approveSessionContract(session: TaskFlowSession): void {
  const review = session.contractReview();
  if (!review) throw new TypeError("Test fixture expected a pending Goal Contract review");
  session.resolveContractReview({
    expectedDecisionRequirementRevisionId: review.decisionRequirementRevisionId,
    expectedRequirementRevisionSha256: review.requirementRevisionSha256,
    expectedDecisionFrontierSha256: review.decisionFrontierSha256,
    action: "APPROVE",
    selectedValue: true,
    turnId: `HOST-TEST-REVIEW-${review.decisionRequirementRevisionId}`,
  });
}

async function submitApprovedHostBuild(
  host: CodingHarnessHostRuntime,
  controlFrameSha256: string,
  contract: Parameters<TaskFlowSession["submitContract"]>[0],
  route: Parameters<TaskFlowSession["submitRoute"]>[0],
): Promise<unknown> {
  const drafted = await host.dispatch("submit_contract", {
    ...contract,
    control_frame_sha256: controlFrameSha256,
  }) as {
    status: {
      contract_review: {
        decision_requirement_revision_id: string;
        requirement_revision_sha256: string;
        decision_frontier_sha256: string;
      };
    };
  };
  const review = drafted.status.contract_review;
  const reviewed = await host.dispatch("resolve_contract_review", {
    expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
    expected_requirement_revision_sha256: review.requirement_revision_sha256,
    expected_decision_frontier_sha256: review.decision_frontier_sha256,
    action: "APPROVE",
    selected_value: true,
  }) as { status: { control_frame: { control_frame_sha256: string } } };
  return host.dispatch("submit_route", {
    ...route,
    control_frame_sha256: reviewed.status.control_frame.control_frame_sha256,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Coding Harness Host runtime", () => {
  it("lazily enters a Single BUILD and recovers it after Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-001", objective: "Create a bounded local file", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    expect(await host.dispatch("status", null)).toMatchObject({ active: false });
    expect(await host.dispatch("enter", enter)).toMatchObject({ active: true, topology: "SINGLE", intent: "BUILD" });
    const first = await host.dispatch("status", null) as { flow: { goalId: string }; harness: { runId: string } };
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({
      active: true,
      flow: { goalId: first.flow.goalId },
      harness: { runId: first.harness.runId },
    });
    resumed.close();
  });

  it("discovers and binds an active Goal created before session-binding authority", async () => {
    const { cwd, options } = fixture();
    const sessionId = "SESSION-HOST-LEGACY-UNBOUND";
    const legacy = new TaskFlowSession({
      config: loadConfig(options.configPath), packageRoot,
      migrationPath: resolve(packageRoot, "schemas", "sql", "001_core.sql"),
      harnessMigrationPath: resolve(packageRoot, "schemas", "sql", "013_coding_harness_v1.sql"),
      dataRoot: options.dataRoot, now: options.now,
    });
    legacy.initialize({
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: () => undefined },
    } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">, {
      recovery: { kind: "NONE" }, runtimeInstanceId: "HOST-LEGACY-PRE-BINDING",
    });
    expect(legacy.startFromInput("plan: recover a legacy unbound Goal", {
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: () => undefined },
    } as unknown as Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">)).toMatchObject({ action: "transform" });
    legacy.createHarnessRun({
      topology: "SINGLE", createdByHostHmac: "a".repeat(64),
      configSha256: "b".repeat(64), decisionSha256: "c".repeat(64),
    });
    const goalId = legacy.current()!.goalId;
    expect(legacy.sessionGoalBinding()).toBeNull();
    legacy.shutdown();

    const runtime = {
      provider: "configured-provider", api: "configured-api", model: "configured-model",
      thinking_level: "configured", context_window: 32_768,
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    expect(await host.dispatch("discover_goals", { cwd, session_id: sessionId })).toMatchObject({
      current_session_binding: null,
      recoverable: [{
        goal_id: goalId, binding_state: "UNBOUND", binding_receipt_sha256: null,
        controller_session_id: null, controller_live: false,
      }],
    });
    expect(await host.dispatch("enter", {
      entry_mode: "RECOVER", cwd, session_id: sessionId, goal_id: goalId, allow_transfer: false, runtime,
    })).toMatchObject({
      active: true,
      flow: { goalId, nextAction: "SUBMIT_CONTRACT" },
      session_binding: { goal_id: goalId, revision: 1, state: "BOUND", auto_resume: true },
    });
    host.close();
  });

  it("discovers, resumes and unbinds the exact Goal without objective replay", async () => {
    const { cwd, options } = fixture();
    const runtime = {
      provider: "configured-provider", api: "configured-api", model: "configured-model",
      thinking_level: "configured", context_window: 32_768,
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    const entered = await host.dispatch("enter", {
      entry_mode: "NEW",
      cwd,
      session_id: "SESSION-HOST-BOUND",
      objective: "Persist one exact Goal binding",
      intent: "PLAN",
      topology: "SINGLE",
      runtime,
    }) as HostStatus;
    expect(entered).toMatchObject({
      active: true,
      session_binding: { session_id: "SESSION-HOST-BOUND", state: "BOUND", auto_resume: true },
      presentation: {
        schema_version: 2, presentation_state_code: "DEFINING_GOAL",
        attention: "NONE", primary_target: "WORK",
        lifecycle: { current_stage: "CONTRACT" },
      },
      current_work_cell: null,
      changed_files: [],
    });
    const marker = entered.session_binding!;

    const discoveryHost = new CodingHarnessHostRuntime(options);
    const discovery = await discoveryHost.dispatch("discover_goals", {
      cwd,
      session_id: "SESSION-HOST-BOUND",
    });
    expect(discovery).toMatchObject({
      current_session_binding: { goal_id: marker.goal_id, binding_receipt_sha256: marker.binding_receipt_sha256 },
      recoverable: [{ goal_id: marker.goal_id, goal_title: "Persist one exact Goal binding" }],
    });
    expect(await discoveryHost.dispatch("status", null)).toMatchObject({ active: false });
    discoveryHost.close();
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    const recovered = await resumed.dispatch("enter", {
      entry_mode: "RESUME",
      cwd,
      session_id: "SESSION-HOST-BOUND",
      binding_marker: marker,
      runtime,
    });
    expect(recovered).toMatchObject({
      active: true,
      flow: { goalId: marker.goal_id, objective: "Persist one exact Goal binding" },
      session_binding: { binding_receipt_sha256: marker.binding_receipt_sha256 },
    });
    const exited = await resumed.dispatch("unbind_session", {
      expected_binding_receipt_sha256: marker.binding_receipt_sha256,
    });
    expect(exited).toMatchObject({ session_binding: { state: "UNBOUND", auto_resume: false, revision: 2 } });
    resumed.close();
  });

  it("rejects marker substitution and a duplicate live runtime for the same Pi session", async () => {
    const { cwd, options } = fixture();
    const runtime = {
      provider: "configured-provider", api: "configured-api", model: "configured-model",
      thinking_level: "configured", context_window: 32_768,
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    const entered = await host.dispatch("enter", {
      entry_mode: "NEW",
      cwd,
      session_id: "SESSION-HOST-RUNTIME-FENCE",
      objective: "Fence duplicate runtime instances",
      intent: "PLAN",
      topology: "SINGLE",
      runtime,
    }) as HostStatus;
    const marker = entered.session_binding!;
    const duplicate = new CodingHarnessHostRuntime(options);
    await expect(duplicate.dispatch("enter", {
      entry_mode: "RESUME",
      cwd,
      session_id: marker.session_id,
      binding_marker: marker,
      runtime,
    })).rejects.toThrow(/another live session or runtime instance/iu);
    duplicate.close();
    host.close();

    const substituted = new CodingHarnessHostRuntime(options);
    await expect(substituted.dispatch("enter", {
      entry_mode: "RESUME",
      cwd,
      session_id: marker.session_id,
      binding_marker: { ...marker, goal_id: "GOAL-SUBSTITUTED" },
      runtime,
    })).rejects.toThrow(/marker does not match current authority/iu);
    substituted.close();
  });

  it("dispatches an admitted managed tool before returning from blocking preflight", async () => {
    const { cwd, options } = fixture();
    mkdirSync(resolve(cwd, "src"));
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-TOOL-PREFLIGHT", objective: "Update and verify src/example.ts",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
      });
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-TOOL-PREFLIGHT", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["write"], all_tools: ["write"],
      }) as { control_frame: { control_frame_sha256: string } };
      const built = await submitApprovedHostBuild(host, projected.control_frame.control_frame_sha256, withAcceptanceV2({
          user_outcomes: ["The local file is updated and verified"], scope: ["src/example.ts"],
          non_goals: ["No external deployment"], constraints: ["Keep the change local"],
          obligations: [{ key: "verified-output", priority: "MUST", statement: "The final workspace passes npm test", oracle: { command: "npm test" } }],
          authorization_ceiling: "LOCAL_REVERSIBLE",
        }), {
          outcomes: ["The bounded change is implemented"],
          goal_fit_assessment: passingGoalFitAssessment(),
          work_cells: [{
            key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
            read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE"],
            oracle: { command: "npm test" }, risk: "LOW", reversible: true,
          }],
          near_horizon: ["bounded-change"],
      }) as { status: { flow: { goalId: string }; control_frame: { control_frame_sha256: string } } };

      const admission = await host.dispatch("tool_preflight", {
        toolCallId: "EDIT-PREFLIGHT-1", toolName: "edit",
        input: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" }, cwd,
        control_frame_sha256: built.status.control_frame.control_frame_sha256,
      });
      expect(admission).toMatchObject({ allow: true, managed: true });
      const session = (host as unknown as { session: {
        resources(): { authority: { readUnresolvedTaskFlowOperations(goalId: string): readonly { state: string }[] } };
      } }).session;
      expect(session.resources().authority.readUnresolvedTaskFlowOperations(built.status.flow.goalId)).toMatchObject([
        { state: "DISPATCHED" },
      ]);
      expect((await host.dispatch("status", null)).changed_files).toEqual([]);

      writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
      await host.dispatch("tool_result", {
        tool_call_id: "EDIT-PREFLIGHT-1", tool_name: "edit",
        tool_input: { path: "src/example.ts", oldText: "value = 1", newText: "value = 2" },
        is_error: false, text: "Updated src/example.ts",
      });
      const committed = await host.dispatch("status", null);
      expect(committed).toMatchObject({
        current_work_cell: { title: "Update and verify the file" },
        changed_files: [{ path: "src/example.ts", change: "MODIFIED", work_cell_id: expect.any(String) }],
        presentation: { schema_version: 2, presentation_state_code: "BUILDING", lifecycle: { current_stage: "BUILD" } },
      });
    } finally {
      host.close();
    }
  });

  it("reuses every formatter batch postimage as fresh Host evidence", async () => {
    const { cwd, options } = fixture();
    mkdirSync(resolve(cwd, "src"));
    const sourceA = "package example\n\nvar A = 1\n";
    const sourceB = "package example\n\nvar B = 2\n";
    writeFileSync(resolve(cwd, "src", "a.go"), sourceA, "utf8");
    writeFileSync(resolve(cwd, "src", "b.go"), sourceB, "utf8");
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-FORMATTER-BATCH", objective: "Format the authorized Go files",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
      });
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-FORMATTER-BATCH", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["read", "bash"], all_tools: ["read", "bash"],
      }) as { control_frame: { control_frame_sha256: string } };
      const built = await submitApprovedHostBuild(host, projected.control_frame.control_frame_sha256, withAcceptanceV2({
          user_outcomes: ["Both Go files are formatted and verified"], scope: ["src"],
          non_goals: ["No external deployment"], constraints: ["Keep the change local"],
          obligations: [{ key: "verified-output", priority: "MUST", statement: "The final workspace passes npm test", oracle: { command: "npm test" } }],
          authorization_ceiling: "LOCAL_REVERSIBLE",
        }), {
          outcomes: ["The bounded format is complete"],
          goal_fit_assessment: passingGoalFitAssessment(),
          work_cells: [{
            key: "bounded-format", outcome: "Format and verify both files", obligation_keys: ["verified-output"],
            read_roots: ["src"], write_roots: ["src"], effect_classes: ["LOCAL_REVERSIBLE"],
            oracle: { command: "npm test" }, risk: "LOW", reversible: true,
          }],
          near_horizon: ["bounded-format"],
      }) as { status: { control_frame: { control_frame_sha256: string } } };
      await host.dispatch("tool_result", {
        tool_call_id: "READ-FORMATTER-A", tool_name: "read", tool_input: { path: "src/a.go" },
        is_error: false, text: sourceA,
      });
      const readB = await host.dispatch("tool_result", {
        tool_call_id: "READ-FORMATTER-B", tool_name: "read", tool_input: { path: "src/b.go" },
        is_error: false, text: sourceB,
      }) as { control_frame: { control_frame_sha256: string } };
      const toolInput = { command: "gofmt -w src/a.go src/b.go", timeout: 30 };
      expect(await host.dispatch("tool_preflight", {
        toolCallId: "GOFMT-BATCH-1", toolName: "bash", input: toolInput, cwd,
        control_frame_sha256: readB.control_frame.control_frame_sha256
          ?? built.status.control_frame.control_frame_sha256,
      })).toMatchObject({ allow: true, managed: true, capture: true });
      const firstResult = await host.dispatch("tool_result", {
        tool_call_id: "GOFMT-BATCH-1", tool_name: "bash", tool_input: toolInput,
        is_error: false, text: "(no output)",
      }) as { control_frame: { control_frame_sha256: string } };
      expect(await host.dispatch("tool_preflight", {
        toolCallId: "GOFMT-BATCH-2", toolName: "bash", input: toolInput, cwd,
        control_frame_sha256: firstResult.control_frame.control_frame_sha256,
      })).toMatchObject({ allow: true, managed: true, capture: true });
    } finally {
      host.close();
    }
  });

  it("closes fresh terminal evidence locally when the Agent settles", async () => {
    const { cwd, options } = fixture();
    mkdirSync(resolve(cwd, "src"));
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-SETTLED-CLOSURE", objective: "Update and verify src/example.ts",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
      });
      const session = (host as unknown as { session: TaskFlowSession }).session;
      session.submitContract(withAcceptanceV2({
        user_outcomes: ["The local file is updated and verified"], scope: ["src/example.ts"],
        non_goals: ["No external deployment"], constraints: ["Keep the change local"],
        obligations: [{
          key: "verified-output", priority: "MUST", statement: "The final workspace passes npm test",
          oracle: { command: "npm test" },
        }],
        authorization_ceiling: "LOCAL_REVERSIBLE",
      }));
      approveSessionContract(session);
      session.submitRoute({
        outcomes: ["The bounded change is implemented"],
        goal_fit_assessment: passingGoalFitAssessment(),
        work_cells: [{
          key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
          read_roots: ["src/example.ts"], write_roots: ["src/example.ts"], effect_classes: ["LOCAL_REVERSIBLE"],
          oracle: { command: "npm test" }, risk: "LOW", reversible: true,
        }],
        near_horizon: ["bounded-change"],
      });
      expect(session.prepareToolOperation({
        toolCallId: "WRITE-SETTLED", toolName: "write",
        input: { path: "src/example.ts", content: "export const value = 2;\n" }, cwd,
      })).toMatchObject({ allow: true, managed: true });
      writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 2;\n", "utf8");
      session.observeToolResult("WRITE-SETTLED", false, "written");
      const validationAdmission = session.prepareToolOperation({
        toolCallId: "VALIDATE-SETTLED", toolName: "bash", input: { command: "npm test" }, cwd,
      });
      expect(validationAdmission.reason).toBeNull();
      expect(validationAdmission).toMatchObject({ allow: true, managed: true });
      expect(session.observeToolResult("VALIDATE-SETTLED", false, "tests passed"))
        .toMatch(/Fresh oracle closure is ready/u);
      expect(session.current()).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
      await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-SETTLED-CLOSURE",
        system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      });

      await host.dispatch("generation_settled", null);
      const terminal = await host.dispatch("status", null);
      expect(terminal).toMatchObject({
        flow: { phase: "SUCCEEDED", nextAction: "NONE" },
        presentation: { presentation_state_code: "COMPLETED", attention: "NONE", primary_target: "DELIVERABLE" },
        session_binding: { state: "TERMINAL", auto_resume: false },
        changed_files: [{ path: "src/example.ts", change: "MODIFIED" }],
      });
      expect(session.resources()!.authority.verifyExecutionV2Integrity()).toMatchObject({
        strongSingleRollouts: 1,
        strongSingleWorkloadBindings: 1,
        workloadComparabilityReceipts: 0,
        mismatches: 0,
      });
    } finally {
      host.close();
    }
  });

  it("recovers an OPEN clarification envelope after Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-CLARIFY", objective: "Resolve a durable output decision", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const decision = {
      id: "FORMAT", question: "Which output format?", whyItMatters: "It changes the public contract",
      changeKind: "BEHAVIOR" as const, materiality: "HIGH" as const, reversible: false, privacyRelated: false,
      options: [{ id: "json", label: "JSON", impact: "Machine-readable" }, { id: "text", label: "Text", impact: "Human-readable" }],
      recommendedOptionId: "json", recommendationReason: "Stable schema", dependsOnDecisionIds: [],
    };
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    const projected = await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CLARIFY-1", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
      current_input_tokens: 10, active_tools: ["coding_clarify"], all_tools: ["coding_clarify"],
    }) as { control_frame: { control_frame_sha256: string } };
    await host.dispatch("clarify_selected", {
      control_frame_sha256: projected.control_frame.control_frame_sha256,
      decisions: [{ ...decision, selectedOptionId: null }],
    });
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({ open_clarifications: [decision] });
    resumed.close();
  });

  it("rejects rebinding one Host to a different entry contract", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    const enter = {
      cwd, session_id: "SESSION-HOST-002", objective: "Inspect bounded sources", intent: "PLAN", topology: "MULTI",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    await host.dispatch("enter", enter);
    await expect(host.dispatch("enter", { ...enter, topology: "SINGLE" })).rejects.toThrow("different entry contract");
    host.close();
  });

  it("treats a requested Multi topology as permission until benefit evidence exists", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      const status = await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-MULTI-BENEFIT-GATE", objective: "Inspect one bounded source file",
        intent: "BUILD", topology: "MULTI",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      expect(status).toMatchObject({
        topology: "MULTI",
        harness: { requestedTopology: "MULTI", effectiveTopology: "SINGLE" },
      });
    } finally {
      host.close();
    }
  });

  it("rejects a different objective or intent after Host restart instead of binding it to the recovered Goal", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-RECOVERY-BINDING", objective: "Preserve the original bounded objective",
      intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 32_768 },
    } as const;
    const first = new CodingHarnessHostRuntime(options);
    await first.dispatch("enter", enter);
    first.close();

    const resumed = new CodingHarnessHostRuntime(options);
    await expect(resumed.dispatch("enter", { ...enter, objective: "Silently replace the recovered objective" }))
      .rejects.toThrow(/different objective or intent/u);
    await expect(resumed.dispatch("enter", { ...enter, intent: "PLAN" }))
      .rejects.toThrow(/different objective or intent/u);
    expect(await resumed.dispatch("enter", enter)).toMatchObject({
      active: true, intent: "BUILD", flow: { objective: enter.objective },
    });
    resumed.close();
  });

  it("persists and verifies a native compaction frontier across Host restart", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-COMPACTION", objective: "Inspect the bounded source", intent: "PLAN", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    const prepared = await host.dispatch("compaction", { phase: "before" }) as { checkpoint_sha256: string };
    expect(prepared.checkpoint_sha256).toMatch(/^COMPACTION-/u);
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    await resumed.dispatch("enter", enter);
    await expect(resumed.dispatch("compaction", { phase: "after" })).resolves.toEqual({ verified: true });
    await expect(resumed.dispatch("compaction", { phase: "after" })).rejects.toThrow("durable preflight");
    resumed.close();
  });

  it("blocks authority mutation during native compaction and exposes restart recovery", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-COMPACTION-GATE", objective: "Guard the compaction frontier",
      intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    await host.dispatch("compaction", { phase: "before" });
    await expect(host.dispatch("control", { action: "pause" })).rejects.toThrow("compaction");
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    const recovered = await resumed.dispatch("enter", enter) as { flow: { nextAction: string; blocker: string } };
    expect(recovered.flow).toMatchObject({
      nextAction: "RECONCILE_COMPACTION",
      blocker: expect.stringContaining("resume"),
    });
    await expect(resumed.dispatch("control", { action: "resume" })).resolves.toMatchObject({
      message: expect.stringContaining("Compaction"),
      status: { flow: { blocker: null } },
    });
    await expect(resumed.dispatch("control", { action: "pause" })).resolves.toMatchObject({
      status: { flow: { phase: "WAITING_USER", nextAction: "RESUME" } },
    });
    resumed.close();
  });

  it("aborts active Multi workers when cancellation becomes authoritative", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-CANCEL-WORKER", objective: "Cancel bounded worker execution",
      intent: "BUILD", topology: "MULTI",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    });
    const abort = new AbortController();
    (host as unknown as { workerJob: unknown }).workerJob = {
      id: "WORKER-JOB-CANCEL", aborts: [abort], state: "RUNNING", workerCount: 1,
      startedAtMs: 10_000, result: null, error: null, completion: new Promise<void>(() => undefined),
    };
    await host.dispatch("control", { action: "cancel", reason: "User confirmed cancellation" });
    expect(abort.signal.aborted).toBe(true);
    host.close();
  });

  it("aborts active Multi workers after an active-Goal turn is durably captured", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-ACTIVE-INPUT-WORKER", objective: "Revise bounded worker execution",
      intent: "BUILD", topology: "MULTI",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    });
    const abort = new AbortController();
    (host as unknown as { workerJob: unknown }).workerJob = {
      id: "WORKER-JOB-ACTIVE-INPUT", aborts: [abort], state: "RUNNING", workerCount: 1,
      startedAtMs: 10_000, result: null, error: null, completion: new Promise<void>(() => undefined),
    };

    await host.dispatch("active_goal_input", { text: "Also preserve the adjacent parser." });

    expect(abort.signal.aborted).toBe(true);
    host.close();
  });

  it("carries a material active-Goal change through the public Host flow", async () => {
    const { cwd, options } = fixture();
    mkdirSync(resolve(cwd, "src"));
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-MATERIAL-FLOW", objective: "Update and verify src/example.ts",
        intent: "BUILD", topology: "SINGLE",
        runtime: {
          provider: "configured-provider", api: "configured-api", model: "configured-model",
          thinking_level: "configured", context_window: 65_536,
        },
      });
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-HOST-MATERIAL-FLOW", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      }) as { control_frame: { control_frame_sha256: string } };
      const contract = {
        ...withAcceptanceV2({
          user_outcomes: ["The local file is updated and verified"], scope: ["src/example.ts"],
          non_goals: ["No external deployment"], constraints: ["Keep the change local"],
          obligations: [{
            key: "verified-output", priority: "MUST" as const,
            statement: "The final workspace passes npm test", oracle: { command: "npm test" },
          }],
          authorization_ceiling: "LOCAL_REVERSIBLE" as const,
        }),
        goal_fit_assessment: passingGoalFitAssessment(),
      };
      const route = {
        outcomes: ["The bounded change is implemented"],
        goal_fit_assessment: passingGoalFitAssessment(),
        work_cells: [{
          key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
          read_roots: ["src/example.ts"], write_roots: ["src/example.ts"],
          effect_classes: ["LOCAL_REVERSIBLE" as const], oracle: { command: "npm test" },
          risk: "LOW" as const, reversible: true,
        }],
        near_horizon: ["bounded-change"],
      };
      await submitApprovedHostBuild(host, projected.control_frame.control_frame_sha256, contract, route);
      const session = (host as unknown as { session: TaskFlowSession }).session;
      const authority = session.resources()!.authority;
      const goalId = session.current()!.goalId;
      const basePlan = authority.readTaskFlowPlanV2(goalId)!;
      const captured = await host.dispatch("active_goal_input", {
        text: "Also update the adjacent parser and preserve the public error contract.",
      }) as { status: { control_frame: { control_frame_sha256: string } } };
      const [turn] = authority.readPendingActiveGoalUserTurns(goalId);
      if (!turn) throw new TypeError("Expected a Host-captured material turn");
      const classified = await host.dispatch("classify_active_goal_input", {
        control_frame_sha256: captured.status.control_frame.control_frame_sha256,
        user_turn_id: turn.user_turn_id,
        expected_user_turn_sha256: turn.record_sha256,
        classification: "CHANGE_REQUEST",
        materiality: "HIGH",
        change_kind: "SCOPE",
        changed_subjects: basePlan.subjects.map(({ kind, id }) => ({ kind, id })),
      }) as { status: { flow: { nextAction: string }; control_frame: { control_frame_sha256: string } } };
      expect(classified.status.flow.nextAction).toBe("SUBMIT_CONTRACT");
      const drafted = await host.dispatch("submit_contract", {
        ...contract,
        scope: ["src/example.ts", "src/adjacent-parser.ts"],
        control_frame_sha256: classified.status.control_frame.control_frame_sha256,
      }) as {
        status: {
          contract_review: {
            decision_requirement_revision_id: string;
            requirement_revision_sha256: string;
            decision_frontier_sha256: string;
          };
        };
      };
      const review = drafted.status.contract_review;
      const reviewed = await host.dispatch("resolve_contract_review", {
        expected_decision_requirement_revision_id: review.decision_requirement_revision_id,
        expected_requirement_revision_sha256: review.requirement_revision_sha256,
        expected_decision_frontier_sha256: review.decision_frontier_sha256,
        action: "APPROVE",
        selected_value: true,
      }) as { status: { control_frame: { control_frame_sha256: string } } };
      const completed = await host.dispatch("submit_route", {
        ...route,
        work_cells: [{ ...route.work_cells[0]!, key: "material-host-change" }],
        near_horizon: ["material-host-change"],
        goal_fit_assessment: passingMaterialChangeGoalFitAssessment(),
        control_frame_sha256: reviewed.status.control_frame.control_frame_sha256,
      }) as { status: { flow: { phase: string; nextAction: string } } };
      expect(completed.status.flow).toMatchObject({ phase: "BUILDING", nextAction: "EXECUTE_WORK" });
      expect(authority.readTaskFlowPlanStageGateV2(goalId, "MATERIAL_CHANGE")).not.toBeNull();
      expect(authority.readActiveGoalChangeTransitionByTurn(turn.user_turn_id)).not.toBeNull();
      expect(authority.verifyTaskFlowPlanV2Integrity()).toMatchObject({
        activeGoalChangeTransitions: 1,
        decisionPlanBindings: 1,
        changeAcceptances: 1,
        headMismatches: 0,
      });
    } finally {
      host.close();
    }
  });

  it("persists a compact provider-turn ledger without prompt content", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-PROVIDER", objective: "Verify the provider ledger", intent: "BUILD", topology: "SINGLE",
      runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
    });
    const systemPrompt = "BASE";
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CACHE-1",
      system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begun = await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex("shape"),
      history: {
        descriptor_root_sha256: sha256Hex("descriptors"), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    }) as { recorded: boolean; provider_attempt_id: string; cache_request_id: null };
    expect(begun).toMatchObject({
      recorded: true,
      provider_attempt_id: expect.stringMatching(/^IC_ATTEMPT-/u),
      cache_request_id: null,
    });
    const settled = await host.dispatch("provider_settle", {
      provider_attempt_id: begun.provider_attempt_id,
      cache_request_id: null,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5 },
      response_status: 200, latency_ms: 12, outcome: "RESPONDED",
      assistant_text_bytes: 24, tool_argument_bytes: 16,
    });
    expect(settled).toMatchObject({ ledger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), cache: null });
    const status = await host.dispatch("status", null) as {
      decision_inbox: null | { provider?: Readonly<Record<string, unknown>> };
    };
    expect(status.decision_inbox?.provider).toMatchObject({
      requests: 1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      cost_usd: null,
      accounting_completeness: "COMPLETE",
      scope: "GOAL_BOUND_OBSERVED",
    });
    host.close();
    const resumed = new CodingHarnessHostRuntime(options);
    try {
      const recovered = await resumed.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-PROVIDER", objective: "Verify the provider ledger",
        intent: "BUILD", topology: "SINGLE",
        runtime: {
          provider: "configured-provider", api: "configured-api", model: "configured-model",
          thinking_level: "configured", context_window: 65_536,
        },
      }) as { decision_inbox: null | { provider?: Readonly<Record<string, unknown>> } };
      expect(recovered.decision_inbox?.provider).toMatchObject({
        requests: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 50,
        accounting_completeness: "COMPLETE", scope: "GOAL_BOUND_OBSERVED",
      });
    } finally {
      resumed.close();
    }
  });

  it("settles interleaved provider attempts by Host-issued identity", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-PROVIDER-INTERLEAVED", objective: "Verify interleaved provider accounting",
      intent: "BUILD", topology: "MULTI",
      runtime: {
        provider: "configured-provider", api: "configured-api", model: "configured-model",
        thinking_level: "configured", context_window: 65_536,
      },
    });
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-PROVIDER-INTERLEAVED",
      system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begin = async (suffix: string) => await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex(`shape-${suffix}`),
      history: {
        descriptor_root_sha256: sha256Hex(`descriptors-${suffix}`), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    }) as { provider_attempt_id: string; cache_request_id: null };
    const first = await begin("first");
    const second = await begin("second");
    expect(first.provider_attempt_id).not.toBe(second.provider_attempt_id);

    const settle = async (providerAttemptId: string, output: number) => await host.dispatch("provider_settle", {
      provider_attempt_id: providerAttemptId,
      cache_request_id: null,
      usage: { input: 100, output, cacheRead: 50, cacheWrite: 0, reasoning: 5 },
      response_status: 200, latency_ms: 12, outcome: "RESPONDED",
      assistant_text_bytes: 24, tool_argument_bytes: 16,
    }) as { ledger_sha256: string };
    const secondResult = await settle(second.provider_attempt_id, 22);
    const firstResult = await settle(first.provider_attempt_id, 20);
    expect(secondResult.ledger_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstResult.ledger_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstResult.ledger_sha256).not.toBe(secondResult.ledger_sha256);
    host.close();
  });

  it("activates Cache C1 only for the verified provider contract and reports confirmed usage", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    const entered = await host.dispatch("enter", {
      cwd, session_id: "SESSION-HOST-CACHE-C1", objective: "Verify Cache C1 attribution",
      intent: "BUILD", topology: "SINGLE",
      runtime: {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      },
    });
    expect(entered).toMatchObject({
      cache: {
        configured: true, enabled: true, arm: "C1_PREFIX", effective_arm: "C1_PREFIX",
        provider_integration: "codex-local-openai-responses-positive-usage-v1", reason: "ACTIVE",
      },
    });
    const systemPrompt = "BASE";
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CACHE-2",
      system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begun = await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex("cache-shape"),
      history: {
        descriptor_root_sha256: sha256Hex("cache-descriptors"), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    }) as { provider_attempt_id: string; cache_request_id: string };
    expect(begun.cache_request_id).toMatch(/^CACHE_REQ-/u);
    const settled = await host.dispatch("provider_settle", {
      provider_attempt_id: begun.provider_attempt_id,
      cache_request_id: begun.cache_request_id,
      usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
      response_status: 200, latency_ms: 12, outcome: "RESPONDED",
      assistant_text_bytes: 24, tool_argument_bytes: 16,
    });
    expect(settled).toMatchObject({ cache: { observation_state: "HIT", evidence_level: "PROVIDER_USAGE" } });
    const diagnostic = await host.dispatch("cache_diagnostic", null) as { message: string };
    expect(diagnostic.message).toContain("effectiveArm=C1_PREFIX");
    expect(diagnostic.message).toContain("confirmedHits=1");
    expect(diagnostic.message).toContain("tokenReadShare=0.4444");
    host.close();
  });

  it("reconciles a Cache C1 request abandoned by Host restart as unobservable", async () => {
    const { cwd, options } = fixture();
    const enter = {
      cwd, session_id: "SESSION-HOST-CACHE-RESTART", objective: "Recover Cache C1 attribution",
      intent: "BUILD", topology: "SINGLE",
      runtime: {
        provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1",
        model: "user-selected-model", thinking_level: "max", context_window: 272_000,
      },
    } as const;
    const host = new CodingHarnessHostRuntime(options);
    await host.dispatch("enter", enter);
    await host.dispatch("turn_projection", {
      agent_run_id: "AGENT-RUN-CACHE-RESTART", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
      current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
    });
    const begun = await host.dispatch("provider_begin", {
      payload_shape_sha256: sha256Hex("cache-restart-shape"),
      history: {
        descriptor_root_sha256: sha256Hex("cache-restart-descriptors"), message_count: 1,
        logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
      },
      tool_schema_bytes: 128,
    }) as { cache_request_id: string };
    expect(begun.cache_request_id).toMatch(/^CACHE_REQ-/u);
    expect((await host.dispatch("cache_diagnostic", null) as { message: string }).message).toContain("pending=1");
    host.close();

    const resumed = new CodingHarnessHostRuntime(options);
    try {
      await resumed.dispatch("enter", enter);
      expect((await resumed.dispatch("cache_diagnostic", null) as { message: string }).message)
        .toContain("requests=1 settled=1 pending=0");
      await resumed.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-CACHE-RESTART-RESUMED", system_prompt_sha256: sha256Hex("BASE"), system_prompt: "BASE",
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
      });
      for (let index = 0; index < 2; index += 1) {
        const next = await resumed.dispatch("provider_begin", {
          payload_shape_sha256: sha256Hex(`cache-restart-shape-${index}`),
          history: {
            descriptor_root_sha256: sha256Hex(`cache-restart-descriptors-${index}`), message_count: 1,
            logical_bytes: 32, user_bytes: 32, assistant_bytes: 0, other_bytes: 0,
          },
          tool_schema_bytes: 128,
        }) as { provider_attempt_id: string; cache_request_id: string };
        await resumed.dispatch("provider_settle", {
          provider_attempt_id: next.provider_attempt_id,
          cache_request_id: next.cache_request_id,
          usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 5 },
          response_status: 200, latency_ms: 12, outcome: "RESPONDED",
          assistant_text_bytes: 24, tool_argument_bytes: 16,
        });
      }
      const diagnostic = await resumed.dispatch("cache_diagnostic", null) as { message: string };
      expect(diagnostic.message).toContain("requests=3 settled=3 pending=0");
      expect(diagnostic.message).toContain("confirmedHits=2 unobservable=1 errors=0");
    } finally {
      resumed.close();
    }
  });

  it("rejects ambiguous or unbounded deferred-context requests", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-CONTEXT-NEGATIVE", objective: "Inspect deferred evidence",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-1",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read", "write"],
      }) as { control_frame: { control_frame_sha256: string } };
      const frame = { control_frame_sha256: projected.control_frame.control_frame_sha256 };
      await expect(host.dispatch("context_fetch", { ...frame, cursor: "signed", selector: "CURRENT_ON_DEMAND" }))
        .rejects.toThrow("cursor request is invalid");
      await expect(host.dispatch("context_fetch", { ...frame, selector: "CURRENT_ON_DEMAND", candidate_ids: [] }))
        .rejects.toThrow("1..10");
      await expect(host.dispatch("context_fetch", { ...frame, selector: "CURRENT_ON_DEMAND", unknown: true }))
        .rejects.toThrow("unknown fields");
    } finally {
      host.close();
    }
  });

  it("rejects a ControlFrame after the bound authority state advances", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-STALE-FRAME", objective: "Fence stale model actions",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-2",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      }) as { control_frame: { control_frame_sha256: string } };
      const frame = projected.control_frame.control_frame_sha256;
      await expect(host.dispatch("control", { action: "pause", control_frame_sha256: frame })).resolves.toBeDefined();
      await expect(host.dispatch("control", { action: "resume", control_frame_sha256: frame }))
        .rejects.toThrow("PCH_STALE_CONTROL_FRAME");
    } finally {
      host.close();
    }
  });

  it("keeps one ControlFrame valid throughout a long active Agent run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime({ ...options, now: () => Date.now() });
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-LEASE-HEARTBEAT", objective: "Keep the active execution lease alive",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-LEASE-HEARTBEAT",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_flow"], all_tools: ["coding_flow"],
      }) as { control_frame: { control_frame_sha256: string } };
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(host.dispatch("control", {
        action: "pause", control_frame_sha256: projected.control_frame.control_frame_sha256,
      })).resolves.toBeDefined();
      const paused = await host.dispatch("status", null) as { control_frame: { control_frame_sha256: string } };
      await host.dispatch("generation_settled", null);
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(host.dispatch("control", {
        action: "resume", control_frame_sha256: paused.control_frame.control_frame_sha256,
      })).rejects.toThrow("PCH_STALE_CONTROL_FRAME");
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });

  it("governs repeated no-progress turns locally and resets after the Agent settles", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-GOVERNOR", objective: "Bound repeated generation routes",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-GOVERNOR-1",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read"],
      }) as { generation_governor: { decision: string } };
      expect(projected.generation_governor.decision).toBe("CONTINUE");
      expect(await host.dispatch("generation_turn", { turn_index: 0 })).toMatchObject({
        decision: "CONTINUE", no_progress_turns: 1,
      });
      expect(await host.dispatch("generation_turn", { turn_index: 1 })).toMatchObject({
        decision: "NUDGE", no_progress_turns: 2, directive: expect.any(String),
      });
      expect(await host.dispatch("generation_turn", { turn_index: 2 })).toMatchObject({
        decision: "HALT_AUTOMATION", no_progress_turns: 3,
      });
      expect(await host.dispatch("generation_settled", null)).toMatchObject({
        decision: "CONTINUE", directive: null,
      });
    } finally {
      host.close();
    }
  });

  it("settles an unknown provider outcome with null usage instead of leaving it pending", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-UNKNOWN-USAGE", objective: "Account an interrupted provider turn",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-UNKNOWN-USAGE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: [], all_tools: [],
      });
      const begun = await host.dispatch("provider_begin", {
        payload_shape_sha256: sha256Hex("shape"),
        history: {
          descriptor_root_sha256: sha256Hex("history"), message_count: 1,
          logical_bytes: 20, user_bytes: 20, assistant_bytes: 0, other_bytes: 0,
        },
        tool_schema_bytes: 0,
      }) as { provider_attempt_id: string };
      await expect(host.dispatch("provider_settle", {
        provider_attempt_id: begun.provider_attempt_id,
        cache_request_id: null, usage: null, response_status: null, latency_ms: null,
        outcome: "OUTCOME_UNKNOWN", assistant_text_bytes: 0, tool_argument_bytes: 0,
      })).resolves.toMatchObject({ ledger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    } finally {
      host.close();
    }
  });

  it("requires a full projection reconcile after the Bridge and Host sequence roots diverge", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-PROJECTION-RECONCILE", objective: "Reconcile compact context deltas",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-PROJECTION-RECONCILE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["read"], all_tools: ["read"],
      });
      const bridge = new ProjectionDeltaLedger("projection-reconcile");
      const one = { contentSha256: sha256Hex("one"), role: "user", customType: null };
      const two = { contentSha256: sha256Hex("two"), role: "assistant", customType: null };
      const first = bridge.plan([one]);
      expect(await host.dispatch("context_project", {
        delta: transportDelta(first), removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: true, reconcile_required: false } });
      bridge.commit(first);

      const append = bridge.plan([one, two]);
      const mismatched = { ...transportDelta(append), previous_sequence_root: sha256Hex("host-mismatch") };
      expect(await host.dispatch("context_project", {
        delta: mismatched, removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: false, reconcile_required: true } });

      const reconciled = bridge.plan([one, two], true);
      expect(await host.dispatch("context_project", {
        delta: transportDelta(reconciled), removed_persisted_messages: 0,
      })).toMatchObject({ projection_ack: { accepted: true, reconcile_required: false, count: 2 } });
    } finally {
      host.close();
    }
  });

  it("rejects an exact managed route only after two unchanged no-progress turns", async () => {
    const { cwd, options } = fixture();
    const host = new CodingHarnessHostRuntime(options);
    try {
      await host.dispatch("enter", {
        cwd, session_id: "SESSION-HOST-STALLED-ROUTE", objective: "Stop a repeated invalid context route",
        intent: "BUILD", topology: "SINGLE",
        runtime: { provider: "configured-provider", api: "configured-api", model: "configured-model", thinking_level: "configured", context_window: 65_536 },
      });
      const systemPrompt = "BASE";
      const projected = await host.dispatch("turn_projection", {
        agent_run_id: "AGENT-RUN-STALLED-ROUTE",
        system_prompt_sha256: sha256Hex(systemPrompt), system_prompt: systemPrompt,
        current_input_tokens: 10, active_tools: ["coding_context"], all_tools: ["coding_context"],
      }) as { control_frame: { control_frame_sha256: string } };
      const request = {
        control_frame_sha256: projected.control_frame.control_frame_sha256,
        selector: "CURRENT_ON_DEMAND", candidate_ids: [],
      };
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("1..10");
      await host.dispatch("generation_turn", { turn_index: 0 });
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("1..10");
      await host.dispatch("generation_turn", { turn_index: 1 });
      await expect(host.dispatch("context_fetch", request)).rejects.toThrow("PCH_GENERATION_ROUTE_STALLED");
    } finally {
      host.close();
    }
  });
});
