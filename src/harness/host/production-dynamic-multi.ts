import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import {
  applyPatchFile,
  preparePatchTransaction,
  readPatchTransactionJournal,
  restorePatchTransactionPreimage,
} from "../../effects/patch-transaction.js";
import { evaluateOraclePolicy } from "../../effects/oracle-policy.js";
import { runBoundedCommand } from "../../effects/bounded-command.js";
import { hmacSha256Hex, sha256Hex } from "../../foundation/crypto.js";
import { idFromSha256 } from "../../foundation/ids.js";
import type {
  DynamicMultiEvidencePortV2,
  DynamicMultiIntegrationObservationV2,
  DynamicMultiIntegrationPortV2,
  DynamicMultiIntegrationResultV2,
  DynamicMultiOraclePortV2,
  DynamicMultiWorkerPortV2,
} from "../execution-v2/coordinator.js";
import type { WorkerPatchEntryV2 } from "../execution-v2/domain.js";
import { prepareExecutionIntegrationJournalV2 } from "../execution-v2/integration-journal.js";
import type { PatchSetRecord } from "../domain.js";
import { WorkerAttemptExecutor } from "../worker/attempt-executor-v2.js";
import type { TaskFlowSession } from "../../runtime/task-flow-session.js";
import {
  sealTaskFlowRecord,
  type OperationAttemptRecord,
  type OperationTransitionRecord,
} from "../../task-flow/domain.js";
import { oracleCommands } from "../../task-flow/oracles.js";
import type {
  DynamicMultiAdmissionAssessmentV2,
  DynamicMultiAdmissionInputV2,
  DynamicMultiHostPortsFactoryV2,
  DynamicMultiHostPortsV2,
} from "./runtime.js";
import type { InspectedDynamicMultiProposalV2 } from "./dynamic-multi-lowering.js";
import { simulateDynamicMultiAdmissionV1 } from "../../harness-v2/dynamic-multi-simulation.js";

const absentSha256 = sha256Hex("PCH-ABSENT-V1");
const maximumOracleOutputBytes = 8 * 1024 * 1024;

export interface ProductionDynamicMultiHostPortsOptionsV2 {
  readonly measure?: (
    input: DynamicMultiAdmissionInputV2,
    inspected?: InspectedDynamicMultiProposalV2,
  ) => DynamicMultiAdmissionAssessmentV2 | null | Promise<DynamicMultiAdmissionAssessmentV2 | null>;
  readonly worker?: DynamicMultiWorkerPortV2;
  readonly runOracle?: (input: {
    readonly command: string;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly exitCode: number; readonly output: string }>;
}

function productionAdmissionMeasurement(
  session: TaskFlowSession,
  input: DynamicMultiAdmissionInputV2,
  inspected?: InspectedDynamicMultiProposalV2,
  nowMs = Date.now(),
): DynamicMultiAdmissionAssessmentV2 | null {
  if (!inspected || inspected.request.graph_proposal_sha256 !== input.graph_proposal_sha256
    || canonicalJsonSha256(inspected.request) !== canonicalJsonSha256(input)) return null;
  const authority = session.resources()?.authority;
  if (!authority) return null;
  const comparison = authority.prepareWorkloadComparability({
    goalId: input.goal_id,
    runId: input.run_id,
    currentWorkload: input.workload,
    nowMs,
  });
  if (!comparison) return null;
  const baseline = comparison.rollout;
  const candidate = simulateDynamicMultiAdmissionV1({
    baseline,
    graph_proposal_sha256: input.graph_proposal_sha256,
    independent_node_count: input.independent_node_count,
    nodes: inspected.nodes.map((node) => ({
      node_id: node.key,
      capability: [...node.capabilities].sort().join("+"),
      dependency_ids: node.dependencies.map((dependency) => dependency.key),
      patch_proposal: node.effect_ceiling === "PATCH_PROPOSAL",
      work_weight: Math.max(1, node.task.length + node.exact_input_refs.length * 64 + node.max_tool_calls),
      exact_input_sha256s: node.exact_input_refs.map((ref) => ref.sha256),
    })),
  });
  return {
    comparability: comparison.receipt,
    strong_single: {
      correctness: baseline.correctness,
      quality_basis_points: baseline.quality_basis_points,
      wall_time_ms: baseline.wall_time_ms,
      provider_requests: baseline.provider_requests,
      input_tokens: baseline.input_tokens,
      output_tokens: baseline.output_tokens,
      user_interventions: baseline.user_interventions,
      safety_events: baseline.safety_events,
    },
    candidate,
  };
}

function contained(root: string, target: string): boolean {
  const delta = relative(resolve(root), resolve(target));
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function safeTarget(workspace: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).some((part) => part === "..")) {
    throw new TypeError("Dynamic Multi patch path is not workspace-relative");
  }
  const target = resolve(workspace, path);
  if (!contained(workspace, target)) throw new TypeError("Dynamic Multi patch path escapes the workspace");
  let parent = dirname(target);
  while (parent !== resolve(workspace)) {
    if (existsSync(parent)) {
      const entry = lstatSync(parent);
      if (entry.isSymbolicLink() || !entry.isDirectory() || !contained(workspace, realpathSync(parent))) {
        throw new TypeError("Dynamic Multi patch parent is not a safe workspace directory");
      }
    }
    const next = dirname(parent);
    if (next === parent || !contained(workspace, next)) throw new TypeError("Dynamic Multi patch parent escapes the workspace");
    parent = next;
  }
  return target;
}

function currentFileSha256(workspace: string, path: string): string | null {
  const target = safeTarget(workspace, path);
  if (!existsSync(target)) return null;
  const entry = lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isFile() || !contained(workspace, realpathSync(target))) {
    throw new TypeError("Dynamic Multi patch target is not a safe regular file");
  }
  return sha256Hex(readFileSync(target));
}

function expectedAfter(entry: WorkerPatchEntryV2): string | null {
  return entry.operation === "DELETE" ? null : entry.after_sha256;
}

function patchObservation(
  workspace: string,
  entries: readonly WorkerPatchEntryV2[],
  expectedPreimageRootSha256: string,
  captureCurrentRoot: () => string,
): DynamicMultiIntegrationObservationV2 {
  const current = entries.map((entry) => currentFileSha256(workspace, entry.path));
  const currentRoot = captureCurrentRoot();
  const allAfter = entries.every((entry, index) => current[index] === expectedAfter(entry));
  if (allAfter) return { status: "APPLIED", postimage_root_sha256: currentRoot };
  const allBefore = entries.every((entry, index) => current[index] === entry.before_sha256);
  const failure = canonicalJsonSha256({
    domain: "PCH-DYNAMIC-MULTI-PRODUCTION-INTEGRATION-OBSERVATION-V2",
    entries: entries.map((entry, index) => ({ path: entry.path, before: entry.before_sha256, after: entry.after_sha256, current: current[index] })),
  });
  return allBefore && currentRoot === expectedPreimageRootSha256
    ? { status: "NOT_APPLIED", current_postimage_root_sha256: currentRoot, failure_sha256: failure }
    : { status: "CONFLICT", current_postimage_root_sha256: currentRoot, failure_sha256: failure };
}

function transition(input: {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly state: OperationTransitionRecord["state"];
  readonly outputSha256: string | null;
  readonly readbackSha256: string | null;
  readonly failureSha256: string | null;
  readonly postcondition: OperationTransitionRecord["postcondition"];
  readonly predecessorSha256: string | null;
  readonly createdAtMs: number;
}): OperationTransitionRecord {
  return sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
    schema_version: 1,
    transition_id: idFromSha256("TRANSITION", sha256Hex(`${input.attemptId}\0${input.ordinal}\0${input.state}`)),
    attempt_id: input.attemptId,
    ordinal: input.ordinal,
    state: input.state,
    output_sha256: input.outputSha256,
    readback_sha256: input.readbackSha256,
    failure_signature_sha256: input.failureSha256,
    postcondition: input.postcondition,
    predecessor_sha256: input.predecessorSha256,
    created_at_ms: input.createdAtMs,
  }, "transition_sha256");
}

function productionEvidencePort(): DynamicMultiEvidencePortV2 {
  return {
    accept: ({ packet, proposal }) => {
      if (proposal.kind !== "EVIDENCE_PROPOSAL" || !("artifact_refs" in proposal.payload)) {
        throw new TypeError("Production evidence Adapter accepts only typed evidence proposals");
      }
      const exact = new Map(packet.exact_input_refs.map((ref) => [`${ref.sha256}:${ref.classification}`, ref]));
      if (proposal.payload.artifact_refs.length === 0
        || proposal.payload.artifact_refs.some((ref) => !exact.has(`${ref.sha256}:${ref.classification}`))) {
        throw new TypeError("Worker evidence proposal is not backed by the exact TaskPacket input closure");
      }
      return Promise.resolve({
        evidence_sha256: canonicalJsonSha256({
          domain: "PCH-DYNAMIC-MULTI-PRODUCTION-EVIDENCE-ACCEPTANCE-V2",
          packet: packet.packet_sha256,
          proposal: proposal.record_sha256,
          refs: proposal.payload.artifact_refs,
        }),
      });
    },
  };
}

function productionIntegrationPort(session: TaskFlowSession): DynamicMultiIntegrationPortV2 {
  const workspace = session.workspaceRoot();
  const resources = session.resources();
  if (!resources) throw new TypeError("Dynamic Multi integration requires active PCH resources");
  return {
    prepare: ({ proposal, patch_set: patchSet, artifacts, expected_preimage_root_sha256: preimage, signal }) => {
      if (signal.aborted) throw new TypeError("Dynamic Multi integration preparation was aborted");
      if (session.captureCurrentWorkspaceBaseline().content_root_sha256 !== preimage) {
        throw new TypeError("Dynamic Multi integration preparation lost the current workspace preimage");
      }
      const byHash = new Map(artifacts.map((artifact) => [artifact.metadata.sha256, artifact.metadata]));
      const adapted: PatchSetRecord = {
        schema_version: 1,
        patch_set_id: patchSet.patch_set_id,
        run_id: patchSet.run_id,
        shard_id: patchSet.node_id,
        worker_run_id: proposal.proposal_id,
        baseline_sha256: patchSet.baseline_sha256,
        entries: patchSet.entries.map((entry) => ({
          operation: entry.operation,
          path: entry.path,
          before_sha256: entry.before_sha256,
          after_sha256: entry.after_sha256,
          content_locator: entry.after_sha256 === null ? null : byHash.get(entry.after_sha256)?.locator ?? null,
          byte_length: entry.byte_length,
        })),
        patch_sha256: patchSet.record_sha256,
        created_at_ms: patchSet.created_at_ms,
      };
      const prepared = preparePatchTransaction({
        cwd: workspace,
        goalId: patchSet.goal_id,
        preimageRootSha256: preimage,
        patchSet: adapted,
        artifacts: resources.artifacts,
      });
      if (session.captureCurrentWorkspaceBaseline().content_root_sha256 !== preimage) {
        throw new TypeError("Dynamic Multi workspace changed while capturing its integration journal");
      }
      return Promise.resolve(prepareExecutionIntegrationJournalV2(prepared));
    },
    integrate: ({ packet, patch_set: patchSet, artifacts, journal,
      expected_preimage_root_sha256: preimage, signal }): Promise<DynamicMultiIntegrationResultV2> => {
      if (patchSet.baseline_sha256 !== packet.baseline_content_root_sha256) {
        return Promise.resolve({ status: "REJECTED", failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-FROZEN-BASELINE-MISMATCH-V2", patch: patchSet.record_sha256, baseline: packet.baseline_content_root_sha256 }) });
      }
      const bytesByHash = new Map(artifacts.map((artifact) => [artifact.metadata.sha256, artifact.bytes]));
      let mutated = false;
      let durableJournal: ReturnType<typeof readPatchTransactionJournal> | null = null;
      try {
        durableJournal = readPatchTransactionJournal(resources.artifacts, journal.journal_artifact.locator);
        if (durableJournal.journal_sha256 !== journal.journal_record_sha256
          || durableJournal.patch_set_id !== patchSet.patch_set_id
          || durableJournal.patch_sha256 !== patchSet.record_sha256
          || durableJournal.goal_id !== patchSet.goal_id || durableJournal.run_id !== patchSet.run_id
          || durableJournal.shard_id !== patchSet.node_id
          || durableJournal.preimage_root_sha256 !== preimage) {
          throw new TypeError("Dynamic Multi integration journal differs from its authority binding");
        }
        if (durableJournal.conflict_paths.length > 0) {
          return Promise.resolve({
            status: "REJECTED",
            failure_sha256: canonicalJsonSha256({
              domain: "PCH-DYNAMIC-MULTI-JOURNAL-PREIMAGE-CONFLICT-V2",
              journal: journal.record_sha256,
              paths: durableJournal.conflict_paths,
            }),
          });
        }
        if (session.captureCurrentWorkspaceBaseline().content_root_sha256 !== preimage) {
          return Promise.resolve({ status: "REJECTED", failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-CURRENT-PREIMAGE-ROOT-MISMATCH-V2", patch: patchSet.record_sha256, preimage }) });
        }
        for (const entry of patchSet.entries) {
          if (currentFileSha256(workspace, entry.path) !== entry.before_sha256) {
            return Promise.resolve({ status: "REJECTED", failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-PREIMAGE-MISMATCH-V2", entry: entry.record_sha256 }) });
          }
          if (entry.after_sha256 !== null && !bytesByHash.has(entry.after_sha256)) {
            return Promise.resolve({ status: "REJECTED", failure_sha256: canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-POSTIMAGE-MISSING-V2", entry: entry.record_sha256 }) });
          }
        }
        for (const entry of patchSet.entries) {
          if (signal.aborted) throw new TypeError("Dynamic Multi integration was aborted");
          const callId = idFromSha256("CALL", sha256Hex(`${packet.packet_sha256}\0${entry.record_sha256}`));
          const admission = session.prepareToolOperation({
            toolCallId: callId,
            toolName: "coding_integrate",
            cwd: workspace,
            input: {
              path: entry.path,
              operation: entry.operation,
              ...(entry.after_sha256 === null ? {} : { content_sha256: entry.after_sha256 }),
            },
          });
          if (!admission.allow) throw new TypeError(admission.reason ?? "Dynamic Multi integration preflight was rejected");
          const resources = session.resources();
          const binding = session.binding();
          const meta = binding?.mutation(`dynamic-multi:production-effect:${callId}`);
          if (!resources || !binding || !meta?.lease) throw new TypeError("Dynamic Multi integration lost its Goal lease");
          const content = entry.after_sha256 === null ? null : Buffer.from(bytesByHash.get(entry.after_sha256)!);
          resources.authority.withLeaseFence(meta.lease, () => {
            if (currentFileSha256(workspace, entry.path) !== entry.before_sha256) {
              throw new TypeError("Dynamic Multi patch preimage changed after operation prepare");
            }
            applyPatchFile(safeTarget(workspace, entry.path), entry.operation, content);
          });
          mutated = true;
          const after = currentFileSha256(workspace, entry.path);
          const expected = expectedAfter(entry);
          if (after !== expected) throw new TypeError("Dynamic Multi patch postimage readback failed");
          const observed = session.observeToolResult(callId, false, expected ?? absentSha256, expected ?? absentSha256) ?? "";
          if (/OUTCOME_UNKNOWN|FAILED/u.test(observed)) throw new TypeError(observed);
        }
        return Promise.resolve({
          status: "APPLIED",
          postimage_root_sha256: session.captureCurrentWorkspaceBaseline().content_root_sha256,
        });
      } catch (error) {
        if (mutated && durableJournal) {
          const binding = session.binding();
          const recovery = restorePatchTransactionPreimage({
            cwd: workspace,
            journal: durableJournal,
            artifacts: resources.artifacts,
            withMutationFence: (effect) => {
              const meta = binding?.mutation(`dynamic-multi:production-recovery:${journal.record_sha256}`);
              if (!meta?.lease) throw new TypeError("Dynamic Multi integration recovery lost its Goal lease");
              resources.authority.withLeaseFence(meta.lease, effect);
            },
          });
          if (recovery.outcome === "RESTORED"
            && session.captureCurrentWorkspaceBaseline().content_root_sha256 === preimage) {
            if (resources.authority.readUnresolvedTaskFlowOperations(patchSet.goal_id).length > 0) {
              session.reconcileOperations(undefined, false);
            }
            return Promise.resolve({
              status: "REJECTED",
              failure_sha256: canonicalJsonSha256({
                domain: "PCH-DYNAMIC-MULTI-INTEGRATION-RESTORED-V2",
                journal: journal.record_sha256,
                error: error instanceof Error ? error.message : String(error),
              }),
            });
          }
        }
        return Promise.resolve({
          status: mutated ? "OUTCOME_UNKNOWN" : "REJECTED",
          failure_sha256: canonicalJsonSha256({
            domain: "PCH-DYNAMIC-MULTI-PRODUCTION-INTEGRATION-FAILURE-V2",
            patch: patchSet.record_sha256,
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    },
    observe: ({ patch_set: patchSet, journal, expected_preimage_root_sha256: preimage }) => {
      const observation = patchObservation(
        workspace,
        patchSet.entries,
        preimage,
        () => session.captureCurrentWorkspaceBaseline().content_root_sha256,
      );
      if (observation.status !== "CONFLICT") return Promise.resolve(observation);
      try {
        const durableJournal = readPatchTransactionJournal(resources.artifacts, journal.journal_artifact.locator);
        if (durableJournal.journal_sha256 !== journal.journal_record_sha256
          || durableJournal.patch_set_id !== patchSet.patch_set_id
          || durableJournal.preimage_root_sha256 !== preimage) {
          throw new TypeError("Dynamic Multi recovery journal differs from its authority binding");
        }
        const binding = session.binding();
        const recovery = restorePatchTransactionPreimage({
          cwd: workspace,
          journal: durableJournal,
          artifacts: resources.artifacts,
          withMutationFence: (effect) => {
            const meta = binding?.mutation(`dynamic-multi:restart-recovery:${journal.record_sha256}`);
            if (!meta?.lease) throw new TypeError("Dynamic Multi restart recovery lost its Goal lease");
            resources.authority.withLeaseFence(meta.lease, effect);
          },
        });
        const currentRoot = session.captureCurrentWorkspaceBaseline().content_root_sha256;
        if (recovery.outcome === "RESTORED" && currentRoot === preimage) {
          if (resources.authority.readUnresolvedTaskFlowOperations(patchSet.goal_id).length > 0) {
            session.reconcileOperations(undefined, false);
          }
          return Promise.resolve({
            status: "NOT_APPLIED" as const,
            current_postimage_root_sha256: currentRoot,
            failure_sha256: canonicalJsonSha256({
              domain: "PCH-DYNAMIC-MULTI-PARTIAL-INTEGRATION-RESTORED-V2",
              journal: journal.record_sha256,
              restored: recovery.restored_paths,
            }),
          });
        }
      } catch {
        // Preserve the original conflict evidence when recovery cannot prove the preimage.
      }
      return Promise.resolve(observation);
    },
  };
}

function productionOraclePort(
  session: TaskFlowSession,
  now: () => number,
  runner: NonNullable<ProductionDynamicMultiHostPortsOptionsV2["runOracle"]>,
): DynamicMultiOraclePortV2 {
  return {
    validate: async ({ packet, postimage_root_sha256: postimage, oracle_sha256: oracleSha256,
      oracle_set_sha256: oracleSetSha256, environment_sha256: environmentSha256,
      covered_obligation_ids: coveredObligationIds, signal }) => {
      const resources = session.resources();
      const binding = session.binding();
      const view = binding ? resources?.authority.readTaskFlowView(binding.goalId) : null;
      const cell = view?.route?.work_cells.find((candidate) => candidate.work_cell_id === binding?.authorizedWorkCellId);
      const authorization = view?.authorization;
      const contract = view?.contract;
      if (!resources || !binding || !cell || !authorization || !contract) {
        throw new TypeError("Dynamic Multi Host oracle lacks current WorkCell authority");
      }
      if (canonicalJsonSha256(cell.oracle) !== oracleSha256
        || canonicalJsonSha256({
          domain: "PCH-EXECUTION-ORACLE-SET-V2", oracle: cell.oracle, obligations: cell.obligation_ids,
        }) !== oracleSetSha256
        || !coveredObligationIds.every((id) => cell.obligation_ids.includes(id))) {
        throw new TypeError("Dynamic Multi Host oracle closure differs from the current WorkCell");
      }
      const baseline = resources.authority.readTaskFlowBaseline(authorization.baseline_id);
      if (!baseline || baseline.environment_sha256 !== environmentSha256) {
        throw new TypeError("Dynamic Multi Host oracle environment differs from its authorization baseline");
      }
      const mutate = (commandInput: Parameters<typeof resources.authority.transactTaskFlow>[0], key: string) => {
        const result = resources.authority.transactTaskFlow(commandInput, binding.mutation(key));
        binding.advanceVersion(result.goalVersion);
      };
      const preOracleBaseline = session.captureCurrentWorkspaceBaseline();
      const baselineMismatches = [
        ...(preOracleBaseline.content_root_sha256 === postimage ? [] : ["CONTENT_ROOT"]),
        ...(preOracleBaseline.environment_sha256 === environmentSha256 ? [] : ["ENVIRONMENT"]),
      ];
      if (baselineMismatches.length > 0) {
        throw new TypeError(`Dynamic Multi Host oracle postimage differs from the real workspace baseline: ${baselineMismatches.join(",")}`);
      }
      const evidence: ReturnType<typeof resources.authority.readOraclePassEvidenceByAttempt>[number][] = [];
      for (const command of oracleCommands(cell.oracle)) {
        if (signal.aborted) throw new TypeError("Dynamic Multi Host oracle was aborted");
        const policy = evaluateOraclePolicy({
          command,
          cwd: session.workspaceRoot(),
          declared_commands: oracleCommands(cell.oracle),
          timeout_ms: 900_000,
          max_output_bytes: maximumOracleOutputBytes,
        });
        if (!policy.allow) throw new TypeError(policy.message);
        const createdAt = now();
        const operationId = idFromSha256("OPERATION", canonicalJsonSha256({
          domain: "PCH-DYNAMIC-MULTI-HOST-ORACLE-OPERATION-V2",
          packet: packet.packet_sha256,
          command,
          postimage,
        }));
        const attemptNumber = resources.authority.readTaskFlowOperationAttemptCount(binding.goalId, operationId) + 1;
        const fingerprint = canonicalJsonSha256({
          domain: "PCH-DYNAMIC-MULTI-HOST-ORACLE-EXECUTION-V2",
          packet: packet.packet_sha256,
          command,
          policy: canonicalJsonSha256(policy),
          baseline: baseline.record_sha256,
          environment: environmentSha256,
          authorization: authorization.record_sha256,
          attempt: attemptNumber,
        });
        const attemptId = idFromSha256("ATTEMPT", sha256Hex(`${operationId}\0${attemptNumber}\0${fingerprint}`));
        const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
          schema_version: 1,
          attempt_id: attemptId,
          operation_id: operationId,
          goal_id: binding.goalId,
          work_cell_id: cell.work_cell_id,
          authorization_id: authorization.authorization_id,
          attempt_number: attemptNumber,
          operation_kind: "VALIDATION",
          normalized_target_hmac: hmacSha256Hex(resources.workspaceSecret, command),
          normalized_payload_sha256: canonicalJsonSha256({ command }),
          execution_fingerprint_sha256: fingerprint,
          baseline_sha256: baseline.record_sha256,
          environment_sha256: environmentSha256,
          oracle_sha256: oracleSha256,
          idempotency_key_hmac: hmacSha256Hex(resources.workspaceSecret, `${operationId}\0${fingerprint}`),
          created_at_ms: createdAt,
        }, "record_sha256");
        const prepared = transition({
          attemptId, ordinal: 0, state: "PREPARED", outputSha256: null, readbackSha256: null,
          failureSha256: null, postcondition: "UNKNOWN", predecessorSha256: null, createdAtMs: createdAt,
        });
        const dispatched = transition({
          attemptId, ordinal: 1, state: "DISPATCHED", outputSha256: null, readbackSha256: null,
          failureSha256: null, postcondition: "UNKNOWN", predecessorSha256: prepared.transition_sha256,
          createdAtMs: createdAt,
        });
        mutate({
          type: "PREPARE_AND_DISPATCH_OPERATION",
          goalId: binding.goalId,
          attempt,
          prepared,
          dispatched,
          reconcileLocator: null,
          oracleExecution: { command, policySha256: canonicalJsonSha256(policy) },
        }, `dynamic-multi:production-oracle:${attemptId}:dispatch`);
        let run: Awaited<ReturnType<typeof runner>>;
        try {
          run = await runner({
            command,
            cwd: session.workspaceRoot(),
            timeoutMs: policy.timeout_ms,
            maximumOutputBytes: policy.max_output_bytes,
            signal,
          });
        } catch (error) {
          const failureSha256 = canonicalJsonSha256({
            domain: "PCH-DYNAMIC-MULTI-HOST-ORACLE-FAILURE-V2",
            error: error instanceof Error ? error.message : String(error),
          });
          const failed = transition({
            attemptId, ordinal: 2, state: "FAILED", outputSha256: null, readbackSha256: null,
            failureSha256, postcondition: "FAIL", predecessorSha256: dispatched.transition_sha256,
            createdAtMs: now(),
          });
          mutate({ type: "TRANSITION_OPERATION", goalId: binding.goalId, transition: failed },
            `dynamic-multi:production-oracle:${attemptId}:failed`);
          throw error;
        }
        const outputSha256 = sha256Hex(run.output);
        if (run.exitCode !== 0) {
          const failureSha256 = canonicalJsonSha256({
            domain: "PCH-DYNAMIC-MULTI-HOST-ORACLE-NONZERO-V2",
            exitCode: run.exitCode,
            outputSha256,
          });
          const failed = transition({
            attemptId, ordinal: 2, state: "FAILED", outputSha256, readbackSha256: outputSha256,
            failureSha256, postcondition: "FAIL", predecessorSha256: dispatched.transition_sha256,
            createdAtMs: now(),
          });
          mutate({ type: "TRANSITION_OPERATION", goalId: binding.goalId, transition: failed },
            `dynamic-multi:production-oracle:${attemptId}:nonzero`);
          throw new TypeError(`Dynamic Multi Host oracle failed with exit code ${run.exitCode}`);
        }
        const observed = transition({
          attemptId, ordinal: 2, state: "OBSERVED", outputSha256, readbackSha256: outputSha256,
          failureSha256: null, postcondition: "PASS", predecessorSha256: dispatched.transition_sha256,
          createdAtMs: now(),
        });
        mutate({ type: "TRANSITION_OPERATION", goalId: binding.goalId, transition: observed },
          `dynamic-multi:production-oracle:${attemptId}:observed`);
        const committed = transition({
          attemptId, ordinal: 3, state: "COMMITTED", outputSha256, readbackSha256: outputSha256,
          failureSha256: null, postcondition: "PASS", predecessorSha256: observed.transition_sha256,
          createdAtMs: now(),
        });
        mutate({ type: "TRANSITION_OPERATION", goalId: binding.goalId, transition: committed },
          `dynamic-multi:production-oracle:${attemptId}:committed`);
        const postimageBaseline = session.captureCurrentWorkspaceBaseline();
        if (postimageBaseline.content_root_sha256 !== postimage
          || postimageBaseline.environment_sha256 !== environmentSha256) {
          throw new TypeError("Dynamic Multi Host oracle changed the workspace baseline");
        }
        mutate({ type: "RECORD_WORKSPACE_BASELINE", goalId: binding.goalId, baseline: postimageBaseline },
          `dynamic-multi:production-oracle:${attemptId}:baseline`);
        mutate({
          type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
          goalId: binding.goalId,
          attemptId,
          terminalTransitionId: committed.transition_id,
        }, `dynamic-multi:production-oracle:${attemptId}:evidence`);
        evidence.push(...resources.authority.readOraclePassEvidenceByAttempt(attemptId));
      }
      const relevant = evidence.filter((entry) => coveredObligationIds.includes(entry.obligation_id));
      if (coveredObligationIds.some((id) => !relevant.some((entry) => entry.obligation_id === id))) {
        throw new TypeError("Dynamic Multi Host oracle did not prove every node obligation");
      }
      return { validation_evidence: relevant };
    },
  };
}

export function createProductionDynamicMultiHostPortsFactory(
  options: ProductionDynamicMultiHostPortsOptionsV2 = {},
): DynamicMultiHostPortsFactoryV2 {
  const executor = options.worker === undefined ? new WorkerAttemptExecutor({}) : null;
  const workerPort: DynamicMultiWorkerPortV2 = options.worker ?? {
    execute: (input) => executor!.execute(input),
  };
  const runner = options.runOracle ?? runBoundedCommand;
  return {
    create({ session, now }): DynamicMultiHostPortsV2 {
      return {
        measure: options.measure ?? ((input, inspected) => productionAdmissionMeasurement(session, input, inspected, now())),
        worker: workerPort,
        evidence: productionEvidencePort(),
        oracle: productionOraclePort(session, now, runner),
        integration: productionIntegrationPort(session),
      };
    },
  };
}
