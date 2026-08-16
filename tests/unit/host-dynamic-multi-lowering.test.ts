import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import {
  inspectDynamicMultiProposalV2,
  lowerInspectedDynamicMultiV2,
  type DurableDynamicMultiAdmissionEvidenceV2,
  type HostDynamicMultiAdmissionRequestV2,
} from "../../src/harness/host/dynamic-multi-lowering.js";
import { finalizeTopologyMeasurementReceiptV2 } from "../../src/harness-v2/topology-gate.js";
import { finalizeComparableWorkloadV1 } from "../../src/harness-v2/workload-comparability.js";
import type { ExecutionV2Preparation } from "../../src/harness/execution-v2/repository.js";

const roots: string[] = [];
const hash = (value: string): string => sha256Hex(value);

function fixture() {
  const workspace = mkdtempSync(resolve(tmpdir(), "pch-dynamic-multi-lowering-"));
  roots.push(workspace);
  mkdirSync(resolve(workspace, "src"), { recursive: true });
  const source = "export const input = 1;\n";
  writeFileSync(resolve(workspace, "src", "input.ts"), source, "utf8");
  const workspaceSecret = Buffer.from("dynamic-multi-lowering-workspace-secret", "utf8");
  const baselineScopeManifest = [{
    path_hmac: hmacSha256Hex(workspaceSecret, "src/input.ts"),
    kind: "FILE",
    bytes: Buffer.byteLength(source, "utf8"),
    sha256: hash(source),
  }] as const;
  const preparation: ExecutionV2Preparation = {
    goalId: "GOAL-DYNAMIC-MULTI-LOWERING",
    runId: "RUN-DYNAMIC-MULTI-LOWERING",
    workCellId: "WORK-CELL-DYNAMIC-MULTI-LOWERING",
    workCellSha256: hash("work-cell"),
    workCellOutcome: "Inspect the authorized source",
    workCellObligationIds: ["OBLIGATION-DYNAMIC-MULTI"],
    workCellRequirementIds: ["REQUIREMENT-DYNAMIC-MULTI"],
    workCellDecisionRefs: [{ decision_id: "DECISION-DYNAMIC-MULTI", sha256: hash("decision") }],
    workCellReadRoots: ["src/input.ts"],
    workCellWriteRoots: [],
    workCellEffectClasses: ["LOCAL_REVERSIBLE"],
    workCellOracleSha256: hash("frozen-oracle"),
    comparableWorkCellSemanticsSha256: hash("comparable-work-cell"),
    comparableRequirementContentRootSha256: hash("comparable-requirements"),
    comparableObligationContentRootSha256: hash("comparable-obligations"),
    comparableDecisionContentRootSha256: hash("comparable-decisions"),
    comparableOracleSetSha256: hash("comparable-oracle"),
    comparableScopeSha256: hash("comparable-scope"),
    comparableEffectPolicySha256: hash("comparable-effects"),
    planRevisionId: "PLAN-REVISION-DYNAMIC-MULTI",
    planRevisionSha256: hash("plan"),
    inputClosureSha256: hash("input-closure"),
    authorizationId: "AUTHORIZATION-DYNAMIC-MULTI",
    authorizationSha256: hash("authorization"),
    baselineSha256: hash("baseline-record"),
    baselineContentRootSha256: canonicalJsonSha256(baselineScopeManifest),
    baselineScopeManifest,
    environmentSha256: hash("environment"),
    oracleSetSha256: hash("oracle-set"),
    configSha256: hash("config"),
    predecessorAuthorityHeadSha256: hash("predecessor"),
  };
  const shared = {
    task: "Inspect the exact frozen input and submit typed evidence",
    capabilities: ["SOURCE_DISCOVERY"],
    effect_ceiling: "READ_ONLY",
    read_roots: ["src/input.ts"],
    write_roots: [],
    exact_input_refs: [{ path: "src/input.ts", sha256: hash(source), classification: "INTERNAL" }],
    decision_refs: [],
    output_schema_sha256: hash("output-schema"),
    oracle_sha256: hash("untrusted-caller-oracle"),
    provider_profile_sha256: hash("untrusted-caller-provider"),
    privacy_class: "INTERNAL",
    taint_classes: [],
    max_turns: 2,
    max_tool_calls: 8,
    max_input_tokens: 8_000,
    max_output_tokens: 2_000,
    max_retries: 1,
    no_progress_limit: 2,
    deadline_ms: 70_000,
  } as const;
  const runtimeFingerprintSha256 = hash("runtime");
  const comparableWorkload = finalizeComparableWorkloadV1({
    work_cell_semantics_sha256: preparation.comparableWorkCellSemanticsSha256,
    requirement_content_root_sha256: preparation.comparableRequirementContentRootSha256,
    obligation_content_root_sha256: preparation.comparableObligationContentRootSha256,
    decision_content_root_sha256: preparation.comparableDecisionContentRootSha256,
    oracle_set_sha256: preparation.comparableOracleSetSha256,
    scope_sha256: preparation.comparableScopeSha256,
    effect_policy_sha256: preparation.comparableEffectPolicySha256,
    input_content_root_sha256: preparation.baselineContentRootSha256,
    environment_sha256: preparation.environmentSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    comparison_config_sha256: preparation.configSha256,
    provider_profile_sha256: runtimeFingerprintSha256,
    cache_epoch_sha256: hash("cache-epoch"),
  });
  return {
    workspace,
    workspaceSecret,
    preparation,
    runtimeFingerprintSha256,
    comparableWorkload,
    shards: [
      { ...shared, key: "A", dependencies: [] },
      { ...shared, key: "B", dependencies: [] },
      { ...shared, key: "C", dependencies: [{ key: "A", condition: "EVIDENCE_ACCEPTED" }] },
    ],
  } as const;
}

function admissionFor(request: HostDynamicMultiAdmissionRequestV2): DurableDynamicMultiAdmissionEvidenceV2 {
  const closure = {
    goal_id: request.goal_id,
    run_id: request.run_id,
    work_cell_id: request.work_cell_id,
    plan_revision_id: request.plan_revision_id,
    plan_revision_sha256: request.plan_revision_sha256,
    input_closure_sha256: request.input_closure_sha256,
    runtime_fingerprint_sha256: request.runtime_fingerprint_sha256,
    config_sha256: request.config_sha256,
    baseline_sha256: request.baseline_sha256,
    baseline_content_root_sha256: request.baseline_content_root_sha256,
    environment_sha256: request.environment_sha256,
  } as const;
  return {
    strong_single: finalizeTopologyMeasurementReceiptV2({
      ...closure, kind: "STRONG_SINGLE", graph_proposal_sha256: null, correctness: "PASS",
      quality_basis_points: 10_000, wall_time_ms: 100, provider_requests: 3,
      input_tokens: 12_000, output_tokens: 3_000, user_interventions: 0, safety_events: 0,
      source_evidence_sha256: hash("single-evidence"),
      predecessor_authority_head_sha256: hash("measurement-predecessor"), observed_at_ms: 9_000,
    }),
    candidate: finalizeTopologyMeasurementReceiptV2({
      ...closure, kind: "DYNAMIC_MULTI_SIMULATION", graph_proposal_sha256: request.graph_proposal_sha256,
      correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 80, provider_requests: 3,
      input_tokens: 12_000, output_tokens: 3_000, user_interventions: 0, safety_events: 0,
      source_evidence_sha256: hash("simulator"),
      predecessor_authority_head_sha256: hash("measurement-predecessor"), observed_at_ms: 9_500,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Host Dynamic Multi semantic lowering", () => {
  it("derives topology metrics and authority fields instead of trusting caller hashes", () => {
    const value = fixture();
    const closure = {
      workspace: value.workspace,
      workspaceSecret: value.workspaceSecret,
      preparation: value.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: value.runtimeFingerprintSha256,
      comparableWorkload: value.comparableWorkload,
      shards: value.shards,
      independentValidation: true,
      nowMs: 10_000,
    } as const;
    const inspected = inspectDynamicMultiProposalV2(closure);
    expect(inspected.request).toMatchObject({
      total_node_count: 3,
      independent_node_count: 2,
      cross_partition_dependency_count: 1,
      write_scope_conflict_count: 0,
      task_packets_complete: true,
    });
    const { shards: _shards, ...withoutShards } = closure;
    void _shards;
    const lowered = lowerInspectedDynamicMultiV2({
      ...withoutShards, admissionEvidence: admissionFor(inspected.request), inspected,
    });
    expect(lowered.gate).toMatchObject({ verdict: "ALLOW", effective_topology: "MULTI" });
    expect(lowered.topology).toMatchObject({ revision: 2, effective_topology: "MULTI" });
    expect(lowered.graph?.nodes).toHaveLength(3);
    expect(lowered.graph?.nodes.every((node) => node.oracle_sha256 === value.preparation.workCellOracleSha256)).toBe(true);
    expect(lowered.graph?.nodes.every((node) => node.provider_profile_sha256 === value.runtimeFingerprintSha256)).toBe(true);
    expect(lowered.graph?.nodes.every((node) => node.requirement_ids[0] === "REQUIREMENT-DYNAMIC-MULTI")).toBe(true);
    expect(lowered.graph?.nodes.every((node) => node.decision_refs[0]?.decision_id === "DECISION-DYNAMIC-MULTI")).toBe(true);
  });

  it("records a Strong Single denial without creating a graph when measurement is absent", () => {
    const value = fixture();
    const closure = {
      workspace: value.workspace,
      workspaceSecret: value.workspaceSecret,
      preparation: value.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: value.runtimeFingerprintSha256,
      comparableWorkload: value.comparableWorkload,
      shards: value.shards,
      independentValidation: false,
      nowMs: 10_000,
    } as const;
    const inspected = inspectDynamicMultiProposalV2(closure);
    const { shards: _shards, ...withoutShards } = closure;
    void _shards;
    const lowered = lowerInspectedDynamicMultiV2({ ...withoutShards, admissionEvidence: null, inspected });
    expect(lowered.gate).toMatchObject({
      verdict: "DENY",
      effective_topology: "SINGLE",
      reason_code: "STRONG_SINGLE_BASELINE_REQUIRED",
    });
    expect(lowered.graph).toBeNull();
  });

  it("rejects stale bytes, unauthorized scope, and provider-unsafe privacy before admission", () => {
    const stale = fixture();
    const staleNode = { ...stale.shards[0], exact_input_refs: [{
      ...stale.shards[0].exact_input_refs[0], sha256: hash("stale"),
    }] };
    expect(() => inspectDynamicMultiProposalV2({
      workspace: stale.workspace,
      workspaceSecret: stale.workspaceSecret,
      preparation: stale.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: stale.runtimeFingerprintSha256,
      comparableWorkload: stale.comparableWorkload,
      shards: [staleNode, stale.shards[1]],
      independentValidation: true,
      nowMs: 10_000,
    })).toThrow(/hash is stale/u);

    const outside = fixture();
    writeFileSync(resolve(outside.workspace, "outside.ts"), "outside\n", "utf8");
    const outsideNode = { ...outside.shards[0], read_roots: ["outside.ts"], exact_input_refs: [{
      path: "outside.ts", sha256: hash("outside\n"), classification: "INTERNAL",
    }] };
    expect(() => inspectDynamicMultiProposalV2({
      workspace: outside.workspace,
      workspaceSecret: outside.workspaceSecret,
      preparation: outside.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: outside.runtimeFingerprintSha256,
      comparableWorkload: outside.comparableWorkload,
      shards: [outsideNode, outside.shards[1]],
      independentValidation: true,
      nowMs: 10_000,
    })).toThrow(/scope exceeds/u);

    const secret = fixture();
    const secretNode = { ...secret.shards[0], privacy_class: "SECRET", exact_input_refs: [{
      ...secret.shards[0].exact_input_refs[0], classification: "SECRET",
    }] };
    expect(() => inspectDynamicMultiProposalV2({
      workspace: secret.workspace,
      workspaceSecret: secret.workspaceSecret,
      preparation: secret.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: secret.runtimeFingerprintSha256,
      comparableWorkload: secret.comparableWorkload,
      shards: [secretNode, secret.shards[1]],
      independentValidation: true,
      nowMs: 10_000,
    })).toThrow(/SENSITIVE or SECRET/u);
  });

  it("rejects live bytes outside the authorized baseline and unverified PUBLIC downgrades", () => {
    const drifted = fixture();
    const changed = "export const input = 2;\n";
    writeFileSync(resolve(drifted.workspace, "src", "input.ts"), changed, "utf8");
    const driftedNode = { ...drifted.shards[0], exact_input_refs: [{
      ...drifted.shards[0].exact_input_refs[0], sha256: hash(changed),
    }] };
    expect(() => inspectDynamicMultiProposalV2({
      workspace: drifted.workspace,
      workspaceSecret: drifted.workspaceSecret,
      preparation: drifted.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: drifted.runtimeFingerprintSha256,
      comparableWorkload: drifted.comparableWorkload,
      shards: [driftedNode, drifted.shards[1]],
      independentValidation: true,
      nowMs: 10_000,
    })).toThrow(/outside the authorized baseline/u);

    const publicInput = fixture();
    const publicNode = { ...publicInput.shards[0], privacy_class: "PUBLIC", exact_input_refs: [{
      ...publicInput.shards[0].exact_input_refs[0], classification: "PUBLIC",
    }] };
    expect(() => inspectDynamicMultiProposalV2({
      workspace: publicInput.workspace,
      workspaceSecret: publicInput.workspaceSecret,
      preparation: publicInput.preparation,
      currentTopologyRevision: 1,
      runtimeFingerprintSha256: publicInput.runtimeFingerprintSha256,
      comparableWorkload: publicInput.comparableWorkload,
      shards: [publicNode, publicInput.shards[1]],
      independentValidation: true,
      nowMs: 10_000,
    })).toThrow(/verified privacy Adapter/u);
  });
});
