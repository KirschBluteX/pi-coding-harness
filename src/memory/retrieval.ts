import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { normalizeMemoryPath, normalizeMemoryTags } from "./admission.js";
import { memorySearchTerms } from "./cjk.js";
import { buildMemoryWorkingSet } from "./context-projector.js";
import { conflictingPolicyClaimIds, rankMemoryChannel, type RankedMemoryClaim } from "./ranking.js";
import { verifySourceAttestation, type ReceiptAttestationReader } from "./source-resolvers.js";
import type {
  EffectiveMemoryClaim, MemoryCandidateRank, MemoryChannel, MemoryEngineConfig, MemoryQuery,
  MemoryRetrievalResult, MemorySelection,
} from "./types.js";

export interface MemoryReadStore extends ReceiptAttestationReader {
  memoryIndexMode(): "TAG_PATH" | "FTS5";
  memoryIndexWatermark(workspaceId: string): number;
  memoryPendingIndexCount(workspaceId?: string): number;
  readMemoryCandidates(workspaceId: string, goalId: string | null, channels: readonly string[], limit: number): EffectiveMemoryClaim[];
  readMemoryByIds(workspaceId: string, goalId: string | null, claimIds: readonly string[]): EffectiveMemoryClaim[];
  memoryFtsMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryChannel[],
    query: string,
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[];
  memoryStructuredMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly MemoryChannel[],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[];
  readEndorsedMemories(workspaceId: string, goalId: string | null, channels: readonly string[], limit: number): EffectiveMemoryClaim[];
  memoryPendingMatches(
    workspaceId: string,
    goalId: string | null,
    channels: readonly string[],
    terms: readonly string[],
    limit: number,
  ): MemoryCandidateRank[];
  verifyMemoryClaimAuthority(record: EffectiveMemoryClaim["claim"]): void;
}

function channelsForMode(mode: MemoryEngineConfig["mode"]): MemoryChannel[] {
  if (mode === "OFF") return [];
  if (mode === "EXPLICIT_ONLY") return ["POLICY"];
  if (mode === "VERIFIED_JIT") return ["POLICY", "EVIDENCE"];
  return ["POLICY", "EVIDENCE", "EXPERIENCE"];
}

function ftsQuery(text: string): string {
  return memorySearchTerms(text).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function structuredTerms(query: MemoryQuery): string[] {
  return [...new Set([
    ...memorySearchTerms(query.text), ...normalizeMemoryTags(query.tags), ...normalizeMemoryTags(query.dependencyKeys),
    ...(query.pathKeys ?? []).map(normalizeMemoryPath).filter((value): value is string => value !== null),
  ])].sort().slice(0, 128);
}

function empty(config: MemoryEngineConfig, indexMode: MemoryRetrievalResult["indexMode"], reason: string): MemoryRetrievalResult {
  return {
    indexMode,
    mode: config.mode,
    epoch: config.epoch,
    selected: [],
    omittedClaimIds: [],
    workingSet: buildMemoryWorkingSet([], [], [], [], []),
    reason,
    indexWatermark: 0,
    indexLagCount: 0,
    additionalModelRequests: 0,
  };
}

function selection(entry: RankedMemoryClaim): MemorySelection {
  const claim = entry.value.claim;
  const projectionText = claim.payload.type === "TYPED_POLICY" ? claim.payload.statement
    : claim.payload.type === "EVIDENCE_LOCATOR" ? claim.payload.locator
      : claim.payload.lesson;
  return {
    claimId: claim.claimId,
    version: claim.version,
    channel: claim.channel,
    scope: claim.scope,
    payload: claim.payload,
    projectionText,
    tokenEstimate: claim.contentTokenEstimate,
    reason: entry.reason,
    sourceLocator: claim.sourceAttestation.locator,
    sourceSha256: claim.sourceAttestation.sourceSha256,
    claimSha256: claim.claimSha256,
    endorsed: entry.value.endorsed,
  };
}

function rankMap(
  structured: readonly MemoryCandidateRank[],
  fts: readonly MemoryCandidateRank[],
  pending: readonly MemoryCandidateRank[],
): Map<string, MemoryCandidateRank> {
  const result = new Map<string, MemoryCandidateRank>();
  for (const entry of fts) result.set(entry.claimId, entry);
  // A pending current version supersedes any stale FTS row for the same claim.
  for (const entry of pending) result.set(entry.claimId, entry);
  for (const entry of structured) {
    const prior = result.get(entry.claimId);
    result.set(entry.claimId, {
      claimId: entry.claimId,
      channel: entry.channel,
      exactMatches: entry.exactMatches,
      lexicalMatches: prior?.lexicalMatches ?? 0,
      relevanceRank: prior?.relevanceRank ?? null,
    });
  }
  return result;
}

function candidateFrontier(
  ranks: ReadonlyMap<string, MemoryCandidateRank>,
  config: MemoryEngineConfig,
): MemoryCandidateRank[] {
  const limits: Readonly<Record<MemoryChannel, number>> = {
    POLICY: Math.max(2, config.maxPolicyResults * 2),
    EVIDENCE: Math.max(2, config.maxEvidenceResults * 2),
    EXPERIENCE: Math.max(2, config.maxExperienceResults * 2),
  };
  const ordered = [...ranks.values()].sort((left, right) => {
    if (left.channel !== right.channel) return left.channel.localeCompare(right.channel);
    if (right.exactMatches !== left.exactMatches) return right.exactMatches - left.exactMatches;
    if (right.lexicalMatches !== left.lexicalMatches) return right.lexicalMatches - left.lexicalMatches;
    if (left.relevanceRank !== null || right.relevanceRank !== null) {
      if (left.relevanceRank === null) return 1;
      if (right.relevanceRank === null) return -1;
      if (left.relevanceRank !== right.relevanceRank) return left.relevanceRank - right.relevanceRank;
    }
    return left.claimId.localeCompare(right.claimId);
  });
  const counts: Record<MemoryChannel, number> = { POLICY: 0, EVIDENCE: 0, EXPERIENCE: 0 };
  return ordered.filter((entry) => {
    if (counts[entry.channel] >= limits[entry.channel]) return false;
    counts[entry.channel] += 1;
    return true;
  });
}

function withinBudget(
  ranked: readonly RankedMemoryClaim[],
  limit: number,
  remainingTokens: number,
  omitted: string[],
): { readonly selected: MemorySelection[]; readonly used: number } {
  const selected: MemorySelection[] = [];
  let used = 0;
  for (const entry of ranked) {
    if (selected.length >= limit || entry.value.claim.contentTokenEstimate + used > remainingTokens) {
      omitted.push(entry.value.claim.claimId);
      continue;
    }
    selected.push(selection(entry));
    used += entry.value.claim.contentTokenEstimate;
  }
  return { selected, used };
}

export function retrieveMemory(repository: MemoryReadStore, config: MemoryEngineConfig, query: MemoryQuery): MemoryRetrievalResult {
  if (!config.enabled || config.mode === "OFF") return empty(config, "DISABLED", "MEMORY_OFF");
  const mode = repository.memoryIndexMode();
  const channels = channelsForMode(config.mode);
  const expression = ftsQuery(query.text);
  const terms = structuredTerms(query);
  const searchLimit = Math.min(config.maxStructuredScanRows, Math.max(config.maxResults * 2, 2));
  const structured = repository.memoryStructuredMatches(query.workspaceId, query.goalId, channels, terms, searchLimit);
  let fts: MemoryCandidateRank[] = [];
  let indexFallback = false;
  if (mode === "FTS5" && expression && config.mode !== "EXPLICIT_ONLY") {
    try { fts = repository.memoryFtsMatches(query.workspaceId, query.goalId, channels, expression, terms, searchLimit); }
    catch (error) {
      if (error instanceof AuthorityIntegrityError) throw error;
      indexFallback = true;
    }
  }
  const pendingRanks = mode === "FTS5" && config.mode !== "EXPLICIT_ONLY"
    ? repository.memoryPendingMatches(query.workspaceId, query.goalId, channels, terms, searchLimit)
    : [];
  const ranks = rankMap(structured, fts, pendingRanks);
  const ids = new Set(candidateFrontier(ranks, config).map((entry) => entry.claimId));
  const endorsed = repository.readEndorsedMemories(query.workspaceId, query.goalId, channels, config.maxResults * 2);
  for (const value of endorsed) ids.add(value.claim.claimId);
  const candidates = ids.size > 0
    ? repository.readMemoryByIds(query.workspaceId, query.goalId, [...ids])
    : repository.readMemoryCandidates(query.workspaceId, query.goalId, channels, config.maxStructuredScanRows);
  const byId = new Map([...candidates, ...endorsed].map((value) => [value.claim.claimId, value]));
  const eligible: EffectiveMemoryClaim[] = [];
  const abstentions: string[] = [];
  for (const value of byId.values()) {
    const claim = value.claim;
    if (!channels.includes(claim.channel) || value.forgotten || claim.validFromMs > query.nowMs
      || (claim.expiresAtMs !== null && claim.expiresAtMs <= query.nowMs)) continue;
    const source = verifySourceAttestation(
      repository, claim.sourceAttestation, query.workspaceId, query.workspaceRoot, config.maxPayloadBytes, query.nowMs,
    );
    if (!source.current) {
      abstentions.push(`${claim.claimId}:${source.reason}`);
      continue;
    }
    eligible.push(value);
  }
  const rankedPolicy = rankMemoryChannel(eligible.filter((value) => value.claim.channel === "POLICY"), query, ranks);
  const conflictIds = conflictingPolicyClaimIds(rankedPolicy);
  const conflicts = [...conflictIds].sort();
  const safePolicy = rankedPolicy.filter((entry) => !conflictIds.has(entry.value.claim.claimId));
  const rankedEvidence = rankMemoryChannel(eligible.filter((value) => value.claim.channel === "EVIDENCE"), query, ranks);
  const rankedExperience = rankMemoryChannel(eligible.filter((value) => value.claim.channel === "EXPERIENCE"), query, ranks);

  const omitted: string[] = [...conflicts];
  let remaining = config.softProjectionTokens;
  let remainingResults = config.maxResults;
  const policy = withinBudget(safePolicy, Math.min(config.maxPolicyResults, remainingResults), remaining, omitted);
  remaining -= policy.used;
  remainingResults -= policy.selected.length;
  const evidence = withinBudget(rankedEvidence, Math.min(config.maxEvidenceResults, remainingResults), remaining, omitted);
  remaining -= evidence.used;
  remainingResults -= evidence.selected.length;
  const experience = withinBudget(rankedExperience, Math.min(config.maxExperienceResults, remainingResults), remaining, omitted);
  const workingSet = buildMemoryWorkingSet(policy.selected, evidence.selected, experience.selected, conflicts, abstentions);
  if (workingSet.tokenEstimate > config.hardProjectionTokens) {
    return empty(config, mode, "PROJECTION_HARD_BUDGET_EXCEEDED");
  }
  for (const selected of [...policy.selected, ...evidence.selected, ...experience.selected]) {
    const value = byId.get(selected.claimId);
    if (!value) throw new AuthorityIntegrityError(`Selected Memory claim ${selected.claimId} disappeared`);
    repository.verifyMemoryClaimAuthority(value.claim);
  }
  const selected = [...policy.selected, ...evidence.selected, ...experience.selected];
  const indexWatermark = repository.memoryIndexWatermark(query.workspaceId);
  const indexLagCount = repository.memoryPendingIndexCount(query.workspaceId);
  return {
    indexMode: indexFallback ? "TAG_PATH" : mode,
    mode: config.mode,
    epoch: config.epoch,
    selected,
    omittedClaimIds: [...new Set(omitted)].sort(),
    workingSet,
    reason: selected.length > 0 ? "SELECTED" : conflicts.length > 0 ? "POLICY_CONFLICT" : "NO_ELIGIBLE_MEMORY",
    indexWatermark,
    indexLagCount,
    additionalModelRequests: 0,
  };
}

export function memoryRecallFingerprint(result: MemoryRetrievalResult): string {
  return canonicalJsonSha256({
    epoch: result.epoch, mode: result.mode, manifest: result.workingSet.manifestSha256,
    selected: result.selected.map((entry) => entry.claimId), omitted: result.omittedClaimIds,
  });
}
