import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  assertProviderCallPlanV1,
  captureProviderRuntimeProfileV1,
  finalizeProviderCallPlanV1,
  type ProviderCallPlanDraftV1,
} from "../../src/provider-v2/domain.js";

const hash = (value: string): string => sha256Hex(value);

function draft(): ProviderCallPlanDraftV1 {
  const profile = captureProviderRuntimeProfileV1({
    resolved: {
      runtime: {
        provider: "configured-provider",
        api: "openai-responses",
        base_url: "http://127.0.0.1:58493/v1",
        model: "configured-model",
        thinking_level: "high",
        context_window: 272_000,
      },
      source: "SUPERVISOR_INHERITED",
      fallback_reason: null,
    },
    sourceProfileId: null,
    currentPiConfigSha256: hash("pi-config"),
    runtimeFingerprintSha256: hash("runtime"),
  });
  return {
    goal_id: "GOAL-PROVIDER-001",
    run_id: "RUN-PROVIDER-001",
    graph_revision_id: "GRAPH-PROVIDER-001",
    graph_revision_sha256: hash("graph"),
    node_id: "NODE-PROVIDER-001",
    node_spec_sha256: hash("node"),
    packet_id: "TASK_PACKET-PROVIDER-001",
    attempt: 1,
    lease_generation: 1,
    fencing_token: 1,
    logical_request_id: "LOGICAL-REQUEST-001",
    plan_nonce_sha256: hash("plan-nonce"),
    request_class: "WORKER",
    purpose_kind: "TASK_EXECUTION",
    purpose: "Resolve the bounded implementation uncertainty and return a typed proposal",
    uncertainty_id: "UNCERTAINTY-001",
    uncertainty_sha256: hash("uncertainty"),
    expected_information_gain: { basis_points: 7_500, evidence_sha256: hash("gain") },
    expected_loss_if_skipped: { basis_points: 6_000, evidence_sha256: hash("loss") },
    minimum_input_closure_sha256: hash("minimum-input"),
    privacy_class: "INTERNAL",
    allowed_fields: [
      { field_path: "/task/requirements", content_sha256: hash("requirements"), classification: "INTERNAL" },
      { field_path: "/task/oracle", content_sha256: hash("oracle-field"), classification: "PUBLIC" },
    ],
    redaction_receipt_id: "REDACTION-001",
    redaction_receipt_sha256: hash("redaction"),
    provider_profile: profile,
    request_budget: {
      budget_envelope_sha256: hash("budget-envelope"),
      soft_max_requests: 1,
      soft_max_input_tokens: 32_000,
      soft_max_output_tokens: 8_000,
      soft_max_cost_microusd: 2_000_000,
      soft_max_latency_ms: 120_000,
      deadline_at_ms: 1_800_000_120_000,
    },
    admission_reason: "REDUCE_MATERIAL_UNCERTAINTY",
    cache: {
      mode: "C0",
      lineage_sha256: null,
      adapter_integration_id: null,
      adapter_security_epoch: null,
      adapter_usage_semantics_id: "openai-responses-usage-v1",
      session_capability: "NONE",
      session_capability_sha256: null,
    },
    success_evidence: {
      kind: "TYPED_WORKER_PROPOSAL",
      output_schema_sha256: hash("output-schema"),
      evidence_requirement_sha256: hash("success-evidence"),
    },
    local_oracle: {
      owner: "HOST",
      oracle_sha256: hash("local-oracle"),
      covered_obligation_ids: ["OBLIGATION-002", "OBLIGATION-001"],
    },
    fallback: { kind: "LOCAL_REPLAN", evidence_sha256: hash("fallback") },
    attempt_limit: 1,
    transport_request_limit: 1,
    fan_out_limit: 1,
    fan_out_independence_evidence_sha256: null,
    fan_out_branch_information_sha256s: [],
    no_progress_limit: 1,
    evidence_saturation_sha256: hash("evidence-saturation"),
    stop_conditions: [
      "PRIVACY_VIOLATION",
      "SUCCESS_EVIDENCE_OBSERVED",
      "DEADLINE_REACHED",
      "SOFT_BUDGET_EXHAUSTED",
      "MAX_ATTEMPTS_REACHED",
      "NO_PROGRESS",
      "EVIDENCE_SATURATION",
    ],
    predecessor_authority_head_sha256: hash("event-head"),
    created_at_ms: 1_800_000_000_000,
  };
}

describe("ProviderCallPlan V1", () => {
  it("seals one Pi-config-bound proposal-only call with a Host oracle", () => {
    const plan = finalizeProviderCallPlanV1(draft());

    expect(() => assertProviderCallPlanV1(plan)).not.toThrow();
    expect(plan.provider_call_plan_id).toMatch(/^PROVIDER_PLAN-/u);
    expect(plan.provider_profile.source).toBe("SUPERVISOR_INHERITED");
    expect(plan.provider_output_authority).toBe("UNVERIFIED_PROPOSAL");
    expect(plan.local_oracle.owner).toBe("HOST");
    expect(plan.allowed_fields.map((field) => field.field_path)).toEqual([
      "/task/oracle",
      "/task/requirements",
    ]);
    expect(plan.local_oracle.covered_obligation_ids).toEqual(["OBLIGATION-001", "OBLIGATION-002"]);
  });

  it("defaults to one call and uses typed purpose admission instead of keyword matching", () => {
    const seed = draft();
    const {
      attempt_limit: _attemptLimit,
      fan_out_limit: _fanOutLimit,
      fan_out_independence_evidence_sha256: _independence,
      fan_out_branch_information_sha256s: _branches,
      no_progress_limit: _noProgress,
      ...withoutCallPolicy
    } = seed;
    void _attemptLimit;
    void _fanOutLimit;
    void _independence;
    void _branches;
    void _noProgress;

    const plan = finalizeProviderCallPlanV1({
      ...withoutCallPolicy,
      purpose: "Analyze a material output-format uncertainty and return a typed implementation proposal",
    });
    expect(plan).toMatchObject({ attempt_limit: 1, fan_out_limit: 1, no_progress_limit: 1 });

    expect(() => finalizeProviderCallPlanV1({
      ...withoutCallPolicy,
      purpose_kind: "DETERMINISTIC_TEST_ORCHESTRATION" as never,
    })).toThrow("purpose kind");
  });

  it("requires current Pi runtime provenance and an explicit fallback reason", () => {
    expect(() => captureProviderRuntimeProfileV1({
      resolved: {
        runtime: {
          provider: "configured-provider",
          api: "openai-responses",
          model: "configured-model",
          thinking_level: "high",
          context_window: 272_000,
        },
        source: "PI_CONFIG",
        fallback_reason: null,
      },
      sourceProfileId: null,
      currentPiConfigSha256: hash("pi-config"),
      runtimeFingerprintSha256: hash("runtime"),
    })).toThrow("exact source profile");

    expect(() => captureProviderRuntimeProfileV1({
      resolved: {
        runtime: {
          provider: "configured-provider",
          api: "openai-responses",
          model: "configured-model",
          thinking_level: "high",
          context_window: 272_000,
        },
        source: "SUPERVISOR_FALLBACK",
        fallback_reason: null,
      },
      sourceProfileId: "ROLE-PROFILE-001",
      currentPiConfigSha256: hash("pi-config"),
      runtimeFingerprintSha256: hash("runtime"),
    })).toThrow("failed Pi profile and reason");
  });

  it("admits fan-out only with independent information evidence for every branch", () => {
    const base = draft();
    const evaluator: ProviderCallPlanDraftV1 = {
      ...base,
      request_class: "EVALUATOR",
      purpose_kind: "INDEPENDENT_EVALUATION",
      admission_reason: "INDEPENDENT_RISK_COVERAGE",
      success_evidence: {
        ...base.success_evidence,
        kind: "TYPED_EVALUATION_PROPOSAL",
      },
      request_budget: { ...base.request_budget, soft_max_requests: 2 },
      transport_request_limit: 2,
      fan_out_limit: 2,
      fan_out_independence_evidence_sha256: hash("independence"),
      fan_out_branch_information_sha256s: [hash("branch-b"), hash("branch-a")],
    };
    const plan = finalizeProviderCallPlanV1(evaluator);
    expect(plan.fan_out_branch_information_sha256s).toEqual([hash("branch-a"), hash("branch-b")].sort());

    expect(() => finalizeProviderCallPlanV1({
      ...evaluator,
      fan_out_independence_evidence_sha256: null,
    })).toThrow("independent information evidence");
    expect(() => finalizeProviderCallPlanV1({
      ...evaluator,
      fan_out_branch_information_sha256s: [hash("same"), hash("same")],
    })).toThrow("unique and canonically sorted");
  });

  it("requires Adapter-specific evidence before a plan can claim C1 or affinity", () => {
    const base = draft();
    expect(() => finalizeProviderCallPlanV1({
      ...base,
      cache: { ...base.cache, mode: "C1" },
    })).toThrow("requires Adapter-specific lineage");

    expect(() => finalizeProviderCallPlanV1({
      ...base,
      cache: {
        ...base.cache,
        session_capability: "ADAPTER_DECLARED_AFFINITY",
        session_capability_sha256: hash("affinity"),
      },
    })).toThrow("C0 cannot claim");
  });

  it("rejects authority escalation, hash tampering, and unknown fields", () => {
    const plan = finalizeProviderCallPlanV1(draft());
    expect(() => assertProviderCallPlanV1({
      ...plan,
      provider_output_authority: "PASS" as never,
    })).toThrow("unverified proposal");
    expect(() => assertProviderCallPlanV1({
      ...plan,
      purpose: "A substituted purpose",
    })).toThrow("record hash");
    expect(() => assertProviderCallPlanV1({
      ...plan,
      unexpected_authority: true,
    } as never)).toThrow("unknown or missing fields");
  });
});
