import { buildMemoryWorkingSet } from "./context-projector.js";
import type { MemoryChannel, MemoryEngineConfig, MemoryRetrievalResult, MemorySelection } from "./types.js";
import type { MemoryV3RecallResult } from "./v3-retrieval.js";

const scopeRank = { GOAL: 2, WORKSPACE: 1 } as const;

function matchScore(selection: MemorySelection): number {
  return [...selection.reason.matchAll(/(?:EXACT|LEXICAL)_(\d+)/gu)]
    .reduce((score, match) => score + Number(match[1] ?? 0), 0);
}

function rank(channel: MemoryChannel, values: readonly MemorySelection[]): MemorySelection[] {
  return [...values].sort((left, right) => {
    const leftScore = matchScore(left);
    const rightScore = matchScore(right);
    if (channel === "POLICY" && scopeRank[right.scope] !== scopeRank[left.scope]) {
      return scopeRank[right.scope] - scopeRank[left.scope];
    }
    if (rightScore !== leftScore) return rightScore - leftScore;
    if (channel !== "POLICY" && scopeRank[right.scope] !== scopeRank[left.scope]) {
      return scopeRank[right.scope] - scopeRank[left.scope];
    }
    if (Number(right.endorsed) !== Number(left.endorsed)) return Number(right.endorsed) - Number(left.endorsed);
    const leftV3 = left.reason.includes("V3") ? 1 : 0;
    const rightV3 = right.reason.includes("V3") ? 1 : 0;
    if (rightV3 !== leftV3) return rightV3 - leftV3;
    if (right.version !== left.version) return right.version - left.version;
    return left.claimId.localeCompare(right.claimId);
  });
}

function selectChannel(
  values: readonly MemorySelection[],
  channel: MemoryChannel,
  channelLimit: number,
  state: { remainingResults: number; remainingTokens: number; omitted: string[] },
): MemorySelection[] {
  const selected: MemorySelection[] = [];
  for (const value of rank(channel, values)) {
    if (selected.length >= channelLimit || state.remainingResults <= 0 || value.tokenEstimate > state.remainingTokens) {
      state.omitted.push(value.claimId);
      continue;
    }
    selected.push(value);
    state.remainingResults -= 1;
    state.remainingTokens -= value.tokenEstimate;
  }
  return selected;
}

export function mergeMemoryRetrieval(
  baseline: MemoryRetrievalResult,
  current: MemoryV3RecallResult,
  config: MemoryEngineConfig,
): MemoryRetrievalResult {
  const byIdentity = new Map<string, MemorySelection>();
  for (const value of [...baseline.selected, ...current.selections]) {
    const identity = `${value.claimId}\0${value.version}`;
    if (!byIdentity.has(identity) || value.reason.includes("V3")) byIdentity.set(identity, value);
  }
  const values = [...byIdentity.values()];
  const state = {
    remainingResults: config.maxResults,
    remainingTokens: config.softProjectionTokens,
    omitted: [...baseline.omittedClaimIds, ...current.omittedClaimIds],
  };
  const policy = selectChannel(values.filter((value) => value.channel === "POLICY"), "POLICY", config.maxPolicyResults, state);
  const evidence = selectChannel(values.filter((value) => value.channel === "EVIDENCE"), "EVIDENCE", config.maxEvidenceResults, state);
  const experience = selectChannel(values.filter((value) => value.channel === "EXPERIENCE"), "EXPERIENCE", config.maxExperienceResults, state);
  const conflicts = [...new Set([...baseline.workingSet.conflicts, ...current.conflicts])].sort();
  const abstentions = [...new Set([...baseline.workingSet.abstentions, ...current.abstentions])].sort();

  let workingSet = buildMemoryWorkingSet(policy, evidence, experience, conflicts, abstentions);
  while (workingSet.tokenEstimate > config.hardProjectionTokens) {
    const removed = experience.pop() ?? evidence.pop() ?? policy.pop();
    if (!removed) break;
    state.omitted.push(removed.claimId);
    workingSet = buildMemoryWorkingSet(policy, evidence, experience, conflicts, abstentions);
  }
  const selected = [...policy, ...evidence, ...experience];
  if (workingSet.tokenEstimate > config.hardProjectionTokens) {
    return {
      ...baseline,
      selected: [],
      omittedClaimIds: [...new Set([...state.omitted, ...selected.map((entry) => entry.claimId)])].sort(),
      workingSet: buildMemoryWorkingSet([], [], [], conflicts, abstentions),
      reason: "PROJECTION_HARD_BUDGET_EXCEEDED",
      additionalModelRequests: 0,
    };
  }
  return {
    ...baseline,
    selected,
    omittedClaimIds: [...new Set(state.omitted)].sort(),
    workingSet,
    reason: selected.length > 0 ? "SELECTED" : conflicts.length > 0 ? "POLICY_CONFLICT" : "NO_ELIGIBLE_MEMORY",
    additionalModelRequests: 0,
  };
}
