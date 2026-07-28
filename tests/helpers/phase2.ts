import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import type { PlanPackage, PlanningSnapshot, RequirementPackage } from "../../src/planning/types.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve("fixtures", name), "utf8")) as T;
}

export function validRequirement(): RequirementPackage {
  const pkg = fixture<RequirementPackage>("requirements.valid.json") as RequirementPackage & { integrity: { requirements_payload_sha256: string; artifact_sha256: string } };
  const hash = canonicalJsonSha256(pkg.requirements);
  pkg.integrity.requirements_payload_sha256 = hash;
  pkg.integrity.artifact_sha256 = hash;
  return pkg;
}

export function validPlan(requirement = validRequirement()): PlanPackage {
  const pkg = fixture<PlanPackage>("plan.valid.json") as PlanPackage & {
    package: { requirement_id: string; requirement_payload_sha256: string };
    integrity: { requirement_payload_sha256: string; plan_payload_sha256: string; artifact_sha256: string };
  };
  pkg.package.requirement_id = requirement.package.requirement_id;
  pkg.package.requirement_payload_sha256 = requirement.integrity.requirements_payload_sha256;
  pkg.integrity.requirement_payload_sha256 = requirement.integrity.requirements_payload_sha256;
  const hash = canonicalJsonSha256(pkg.plan);
  pkg.integrity.plan_payload_sha256 = hash;
  pkg.integrity.artifact_sha256 = hash;
  return pkg;
}

export function rehashRequirement(pkg: RequirementPackage): RequirementPackage {
  const mutable = pkg as RequirementPackage & { integrity: { requirements_payload_sha256: string; artifact_sha256: string } };
  const hash = canonicalJsonSha256(mutable.requirements);
  mutable.integrity.requirements_payload_sha256 = hash;
  mutable.integrity.artifact_sha256 = hash;
  return mutable;
}

export function rehashPlan(pkg: PlanPackage): PlanPackage {
  const mutable = pkg as PlanPackage & { integrity: { plan_payload_sha256: string; artifact_sha256: string } };
  const hash = canonicalJsonSha256(mutable.plan);
  mutable.integrity.plan_payload_sha256 = hash;
  mutable.integrity.artifact_sha256 = hash;
  return mutable;
}

export function validPlanningSnapshot(requirement = validRequirement(), plan = validPlan(requirement)): PlanningSnapshot {
  return {
    goalId: requirement.package.goal_id,
    goalVersion: 3,
    requirement,
    plan,
    stageStatuses: Object.fromEntries(plan.plan.stages.map((stage) => [stage.id, "READY"])),
    invalidatedIds: new Set(),
    blockingDecisionIds: [],
    unknownEffectIds: [],
    environmentMatches: true,
    leaseValid: true,
    failureOccurrences: {},
  };
}
