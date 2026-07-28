import { describe, expect, it } from "vitest";
import { validatePerformanceContract, type PerformanceContract } from "../../src/performance/contract.js";
import { validRequirement } from "../helpers/phase2.js";

describe("PerformanceContract policy", () => {
  it("accepts the activated bounded contract", () => {
    const contract = validRequirement().requirements.performance_contract;
    expect(validatePerformanceContract(contract, new Set(["AC-DEMO-001"])).valid).toBe(true);
  });

  it("rejects AUTO without a frozen HOLDOUT role", () => {
    const contract = structuredClone(validRequirement().requirements.performance_contract) as PerformanceContract & { workloads: PerformanceContract["workloads"] };
    (contract as unknown as { workloads: unknown[] }).workloads = contract.workloads.filter((workload) => workload.role !== "HOLDOUT");
    expect(validatePerformanceContract(contract).issues.map((entry) => entry.code)).toContain("HOLDOUT_REQUIRED");
  });

  it("rejects an unqualified AUTO activation and unbounded payback", () => {
    const contract = structuredClone(validRequirement().requirements.performance_contract);
    (contract as { activation_basis: string }).activation_basis = "BASELINE_DEFAULT";
    (contract.trial_protocol.automatic_benefit_horizon as { estimated_payback_executions: number }).estimated_payback_executions = 101;
    const codes = validatePerformanceContract(contract).issues.map((entry) => entry.code);
    expect(codes).toContain("ACTIVATION_BASIS");
    expect(codes).toContain("PAYBACK_HORIZON");
  });
});
