import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { parse, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AuthorityStore, MutationMeta, TransactionFaultPoint } from "../../src/authority/transactions.js";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { TaskFlowSession } from "../../src/runtime/task-flow-session.js";
import { classifyTaskFlowInput } from "../../src/task-flow/admission.js";
import { finalizeGoalContract, finalizeRoute } from "../../src/task-flow/finalize.js";
import { assessRouteHealth } from "../../src/task-flow/health.js";
import type { TaskFlowAuthorityCommand } from "../../src/task-flow/commands.js";
import { declaredPerformanceRoot } from "../helpers/performance-root.js";
import { GenerationGovernor } from "../../src/control/generation-governor.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { withAcceptanceV2 } from "../helpers/acceptance-v2.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";
import { approvePendingTaskFlowContract } from "../helpers/task-flow-session.js";

const enabled = process.env.PCH_TASK_FLOW_PERFORMANCE === "1";
const sampleCount = 160;

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function sample(action: () => unknown, count = sampleCount): number[] {
  for (let index = 0; index < 16; index += 1) action();
  return Array.from({ length: count }, () => {
    const started = performance.now();
    action();
    return performance.now() - started;
  });
}

function loadDevelopmentConfig(): CodingHarnessConfig {
  return JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;
}

describe.skipIf(!enabled)("Task Flow Kernel critical-path performance", () => {
  it("meets local budgets and separates SQLite commit from operation preflight", () => {
    const performanceRoot = declaredPerformanceRoot("task-flow");
    mkdirSync(performanceRoot.epochRoot, { recursive: true });
    const root = mkdtempSync(resolve(performanceRoot.epochRoot, "pch-tfk-perf-"));
    const cwd = resolve(root, "workspace");
    mkdirSync(resolve(cwd, "src"), { recursive: true });
    writeFileSync(resolve(cwd, "src", "example.ts"), "export const value = 1;\n", "utf8");
    const config = loadDevelopmentConfig();
    const context = {
      cwd,
      sessionManager: { getSessionId: () => "SESSION-TASK-FLOW-PERF" } as ExtensionContext["sessionManager"],
      ui: { notify: () => undefined } as unknown as ExtensionContext["ui"],
    };
    const session = new TaskFlowSession({
      config, packageRoot: resolve("."), migrationPath: resolve("schemas", "sql", "001_core.sql"),
      dataRoot: resolve(root, "data"), now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    });
    try {
      const admissionSamples = sample(() => classifyTaskFlowInput(
        "build: modify src/example.ts and run tests", config,
      ));
      const goalContractProposal = {
        user_outcomes: ["The local file is correct and verified"], scope: ["src/example.ts"],
        non_goals: ["No external deployment"], constraints: ["Keep the change local"],
        obligations: [{ key: "verified-output", priority: "MUST" as const,
          statement: "The final workspace passes npm test", oracle: { command: "npm test" } }],
        authorization_ceiling: "LOCAL_REVERSIBLE" as const,
      };
      const contractProposal = withAcceptanceV2(goalContractProposal);
      const routeCoreProposal = {
        outcomes: ["The bounded change is implemented"],
        work_cells: [{
          key: "bounded-change", outcome: "Update and verify the file", obligation_keys: ["verified-output"],
          read_roots: ["src/example.ts"], write_roots: ["src/example.ts"],
          effect_classes: ["LOCAL_REVERSIBLE" as const], oracle: { command: "npm test" },
          risk: "LOW" as const, reversible: true,
        }], near_horizon: ["bounded-change"],
      };
      const routeProposal = { ...routeCoreProposal, goal_fit_assessment: passingGoalFitAssessment() };
      const finalizationSamples = sample(() => {
        const contract = finalizeGoalContract({
          goalId: "GOAL-TASK-FLOW-PERF", objective: "Modify and verify one file", intent: "BUILD",
          lane: "DIRECT_CELL", sourceIntakeSha256: "a".repeat(64), version: 1,
          parentContractId: null, proposal: goalContractProposal, createdAtMs: 1,
        });
        finalizeRoute({ contract, revision: 1, parentRouteId: null, proposal: routeCoreProposal, createdAtMs: 1 });
      });
      const healthInput = {
        activeObligationCount: 100, currentRecordCount: 256, unknownEffect: false,
        authorityIntegrityFailure: false, materialDecisionOpen: false, assumptionInvalidated: false,
        acceptanceUnreachable: false, failureSignatureSha256: null, failureOccurrence: 0,
        retryLimit: 2, transientFailure: false, localRepairAvailable: false,
        routeAlternativeAvailable: true, progressObserved: true,
      };
      const healthSamples = sample(() => assessRouteHealth(healthInput));
      const generationGovernorSamples = sample(() => {
        const governor = new GenerationGovernor();
        const frontier = { controlFrameSha256: sha256Hex("performance-frontier"), terminal: false, userDecisionRequired: false };
        governor.beginAgentRun("PERFORMANCE-RUN", frontier);
        governor.recordProviderTurn();
        governor.observeTurn(0, frontier);
      });

      session.initialize(context);
      expect(session.startFromInput("build: modify src/example.ts and run tests", context)).toMatchObject({ action: "transform" });
      session.submitContract(contractProposal);
      approvePendingTaskFlowContract(session);
      session.submitRoute(routeProposal);
      const store = session.resources()?.authority;
      if (!store) throw new TypeError("Task Flow performance AuthorityStore is unavailable");
      for (let index = 0; index < 16; index += 1) {
        const callId = `WRITE-PERF-WARMUP-${index}`;
        expect(session.prepareToolOperation({
          toolCallId: callId, toolName: "write",
          input: { path: "src/example.ts", content: "export const value = 1;\n" }, cwd,
        })).toMatchObject({ allow: true, managed: true });
        expect(session.observeToolResult(callId, false, "wrote current content")).toMatch(/PCH_OPERATION_COMMITTED/u);
      }
      const originalTransactTaskFlow = store.transactTaskFlow.bind(store);
      let transactionObserver: ((point: TransactionFaultPoint) => void) | null = null;
      store.transactTaskFlow = ((command: TaskFlowAuthorityCommand, mutation: MutationMeta, observer?: (point: TransactionFaultPoint) => void) =>
        originalTransactTaskFlow(command, mutation, (point) => {
          transactionObserver?.(point);
          observer?.(point);
        })) as AuthorityStore["transactTaskFlow"];

      const operationTotalSamples: number[] = [];
      const operationBodySamples: number[] = [];
      const operationCommitSamples: number[] = [];
      const operationReadbackSamples: number[] = [];
      const operationExcludingCommitSamples: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const marks: Partial<Record<TransactionFaultPoint, number>> = {};
        const started = performance.now();
        transactionObserver = (point) => {
          if (["before-begin", "after-begin", "before-commit", "after-commit"].includes(point)) marks[point] = performance.now();
        };
        const callId = `WRITE-PERF-${index}`;
        const admission = session.prepareToolOperation({
          toolCallId: callId, toolName: "write",
          input: { path: "src/example.ts", content: "export const value = 1;\n" }, cwd,
        });
        const ended = performance.now();
        transactionObserver = null;
        expect(admission).toMatchObject({ allow: true, managed: true });
        const beforeBegin = marks["before-begin"] ?? started;
        const afterBegin = marks["after-begin"] ?? beforeBegin;
        const beforeCommit = marks["before-commit"] ?? afterBegin;
        const afterCommit = marks["after-commit"] ?? beforeCommit;
        const total = ended - started;
        const body = beforeCommit - afterBegin;
        const commit = afterCommit - beforeCommit;
        const readback = ended - afterCommit;
        operationTotalSamples.push(total);
        operationBodySamples.push(body);
        operationCommitSamples.push(commit);
        operationReadbackSamples.push(readback);
        operationExcludingCommitSamples.push(Math.max(0, total - commit - readback));
        expect(session.observeToolResult(callId, false, "wrote current content")).toMatch(/PCH_OPERATION_COMMITTED/u);
      }

      const budgets = {
        auto_admission_p95_ms: 1,
        direct_cell_finalization_p95_ms: 15,
        route_health_100_obligations_256_records_p95_ms: 5,
        generation_governor_turn_p95_ms: 1,
        operation_preflight_excluding_commit_readback_p95_ms: 15,
        operation_authority_readback_p95_ms: 20,
      };
      const metrics = {
        auto_admission_p95_ms: percentile(admissionSamples, 0.95),
        direct_cell_finalization_p95_ms: percentile(finalizationSamples, 0.95),
        route_health_100_obligations_256_records_p95_ms: percentile(healthSamples, 0.95),
        generation_governor_turn_p95_ms: percentile(generationGovernorSamples, 0.95),
        operation_preflight_excluding_commit_readback_p95_ms: percentile(operationExcludingCommitSamples, 0.95),
        operation_preflight_total_p95_ms: percentile(operationTotalSamples, 0.95),
        operation_transaction_body_p95_ms: percentile(operationBodySamples, 0.95),
        operation_synchronous_commit_p95_ms: percentile(operationCommitSamples, 0.95),
        operation_authority_readback_p95_ms: percentile(operationReadbackSamples, 0.95),
        operation_filesystem_readback_p95_ms: 0,
        additional_model_requests: 0,
        additional_provider_requests: 0,
      };
      const status = (Object.keys(budgets) as (keyof typeof budgets)[])
        .every((key) => metrics[key] <= budgets[key]) ? "PASS" : "FAIL";
      const report = {
        schema_version: 1, report_type: "PCH_TASK_FLOW_V1_PERFORMANCE", status,
        generated_at: new Date().toISOString(), sample_count_per_metric: sampleCount, operation_warmup_count: 16,
        fingerprint: {
          host: hostname(), platform: process.platform, arch: process.arch, node: process.version,
          sqlite: process.versions.sqlite, cpu: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length,
          total_memory_bytes: totalmem(), authority_data_root: performanceRoot.dataRoot,
          authority_data_root_source: performanceRoot.dataRootSource,
          authority_database_volume_root: parse(resolve(root, "data")).root,
          source_project_volume_root: parse(resolve(".")).root, sqlite_durability: "WAL_SYNCHRONOUS_FULL",
        },
        scale: { active_obligations: 100, current_records: 256 }, budgets, metrics,
        samples: {
          admission_ms: admissionSamples, finalization_ms: finalizationSamples, route_health_ms: healthSamples,
          generation_governor_ms: generationGovernorSamples,
          operation_preflight_total_ms: operationTotalSamples, operation_transaction_body_ms: operationBodySamples,
          operation_synchronous_commit_ms: operationCommitSamples,
          operation_authority_readback_ms: operationReadbackSamples,
          operation_preflight_excluding_commit_readback_ms: operationExcludingCommitSamples,
        },
        additional_model_requests: 0, additional_provider_requests: 0,
      };
      writeFileSync(resolve("reports", "task-flow-v1-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      expect(status, JSON.stringify(metrics)).toBe("PASS");
    } finally {
      session.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
