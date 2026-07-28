import type { MemoryV3CandidateHeadMatch, MemoryV3ClaimHeadRecord, MemoryV3ClaimRecord } from "../authority/repositories/memory-v3.js";
import type { AuthorityStore } from "../authority/transactions.js";
import { hmacSha256Hex } from "../foundation/crypto.js";
import { normalizeMemoryPath, normalizeMemoryTags } from "./admission.js";
import { memorySearchTerms } from "./cjk.js";
import { decodeSourceAttestation, verifySourceAttestation } from "./source-resolvers.js";
import type {
  MemoryChannel, MemoryEngineConfig, MemoryQuery, MemorySelection, MemoryScope,
} from "./types.js";

export interface MemoryV3OpenedClaim {
  readonly record: MemoryV3ClaimRecord;
  readonly head: MemoryV3ClaimHeadRecord;
  readonly body: {
    readonly payload: MemorySelection["payload"];
    readonly source: unknown;
    readonly content_text: string;
    readonly content_token_estimate: number;
  };
}

export interface MemoryV3RecallResult {
  readonly selections: readonly MemorySelection[];
  readonly conflicts: readonly string[];
  readonly abstentions: readonly string[];
  readonly omittedClaimIds: readonly string[];
  readonly metadataCandidateCount: number;
  readonly decryptedCandidateCount: number;
  readonly integrityFailureCount: number;
  readonly additionalModelRequests: 0;
}

interface OpenCandidate {
  readonly selection: MemorySelection;
  readonly opened: MemoryV3OpenedClaim;
}

const channelOrder: readonly MemoryChannel[] = ["POLICY", "EVIDENCE", "EXPERIENCE"];

function termHmac(secret: Uint8Array, kind: string, value: string): string {
  return hmacSha256Hex(secret, `PCH-MEMORY-V3-TERM\0${kind}\0${value}`);
}

function queryTerms(secret: Uint8Array, query: MemoryQuery): string[] {
  const terms: Array<readonly [string, string]> = [];
  for (const term of memorySearchTerms(query.text)) terms.push(["CONTENT", term]);
  for (const term of normalizeMemoryTags(query.tags)) terms.push(["TAG", term]);
  for (const path of query.pathKeys ?? []) {
    const normalized = normalizeMemoryPath(path);
    if (normalized) terms.push(["PATH", normalized]);
  }
  for (const term of normalizeMemoryTags(query.dependencyKeys)) terms.push(["DEPENDENCY", term]);
  return [...new Set(terms.map(([kind, value]) => `${kind}\0${value}`))]
    .sort()
    .slice(0, 256)
    .map((entry) => {
      const separator = entry.indexOf("\0");
      return termHmac(secret, entry.slice(0, separator), entry.slice(separator + 1));
    });
}

function frontierLimit(config: MemoryEngineConfig, channel: MemoryChannel): number {
  const limit = channel === "POLICY" ? config.maxPolicyResults
    : channel === "EVIDENCE" ? config.maxEvidenceResults : config.maxExperienceResults;
  return Math.min(1_000, Math.max(1, limit));
}

function selection(opened: MemoryV3OpenedClaim, matchedTerms: number): MemorySelection {
  const source = decodeSourceAttestation(opened.body.source);
  const reason = [
    "V3",
    `${opened.record.scope}_SCOPE`,
    opened.head.endorsed ? "ENDORSED" : null,
    matchedTerms > 0 ? `EXACT_${matchedTerms}` : "GLOBAL_POLICY",
    source.resolver,
  ].filter((value): value is string => value !== null).join("+");
  return {
    claimId: opened.record.claimId,
    version: opened.record.version,
    channel: opened.record.channel,
    scope: opened.record.scope,
    payload: opened.body.payload,
    projectionText: opened.body.content_text,
    tokenEstimate: opened.body.content_token_estimate,
    reason,
    sourceLocator: source.locator,
    sourceSha256: source.sourceSha256,
    claimSha256: opened.record.claimSha256,
    endorsed: opened.head.endorsed,
  };
}

function activeAt(record: MemoryV3ClaimRecord, nowMs: number): boolean {
  return record.validFromMs <= nowMs && (record.expiresAtMs === null || record.expiresAtMs > nowMs);
}

function structuredIdentity(opened: MemoryV3OpenedClaim): { readonly scope: MemoryScope; readonly semanticKey: string } | null {
  const payload = opened.body.payload;
  return payload.type === "TYPED_POLICY" && payload.semanticKey
    ? { scope: opened.record.scope, semanticKey: payload.semanticKey.normalize("NFKC").toLowerCase() }
    : null;
}

function structuredConflicts(
  authority: AuthorityStore,
  secret: Uint8Array,
  query: MemoryQuery,
  config: MemoryEngineConfig,
  candidates: readonly OpenCandidate[],
  abstentions: string[],
  omitted: string[],
): ReadonlySet<string> {
  const conflicts = new Set<string>();
  const inspected = new Map<string, { readonly signature: string | null; readonly truncated: boolean; readonly ids: readonly string[] }>();
  for (const candidate of candidates) {
    if (candidate.selection.channel !== "POLICY") continue;
    const identity = structuredIdentity(candidate.opened);
    if (!identity) {
      conflicts.add(candidate.selection.claimId);
      abstentions.push(`${candidate.selection.claimId}:V3_POLICY_SEMANTICS_MISSING`);
      continue;
    }
    const key = `${identity.scope}\0${identity.semanticKey}`;
    let group = inspected.get(key);
    if (!group) {
      const semanticHmac = termHmac(secret, "SEMANTIC_KEY", identity.semanticKey);
      const result = authority.readMemoryV3SemanticPolicyHeads(
        query.workspaceId, query.goalId, identity.scope, semanticHmac,
        Math.min(5_000, config.maxStructuredScanRows),
      );
      const signatures = new Set<string>();
      const ids: string[] = [];
      let invalid = false;
      for (const head of result.matches) {
        const record = authority.readMemoryV3Claim(head.claimId, head.version);
        if (!record || record.semanticKeySha256 !== candidate.opened.record.semanticKeySha256) {
          invalid = true;
          ids.push(head.claimId);
          continue;
        }
        if (!activeAt(record, query.nowMs)) continue;
        if (!record.policyOperator || !record.valueSha256) invalid = true;
        else signatures.add(`${record.policyOperator}\0${record.valueSha256}`);
        ids.push(record.claimId);
      }
      const truncated = result.total > result.matches.length;
      group = {
        signature: !invalid && signatures.size === 1 ? [...signatures][0]! : null,
        truncated,
        ids: [...new Set(ids)].sort(),
      };
      inspected.set(key, group);
    }
    if (group.truncated) {
      conflicts.add(candidate.selection.claimId);
      abstentions.push(`${candidate.selection.claimId}:STRUCTURED_CONFLICT_FRONTIER_TRUNCATED`);
    } else if (group.signature === null) {
      group.ids.forEach((id) => conflicts.add(id));
      conflicts.add(candidate.selection.claimId);
    }
  }

  const duplicateWinners = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.selection.channel !== "POLICY" || conflicts.has(candidate.selection.claimId)) continue;
    const identity = structuredIdentity(candidate.opened);
    if (!identity) continue;
    const payload = candidate.opened.body.payload;
    if (payload.type !== "TYPED_POLICY") continue;
    const duplicateKey = `${identity.scope}\0${identity.semanticKey}\0${payload.operator}\0${candidate.opened.record.valueSha256}`;
    if (duplicateWinners.has(duplicateKey)) omitted.push(candidate.selection.claimId);
    else duplicateWinners.add(duplicateKey);
  }
  return conflicts;
}

export function retrieveMemoryV3(
  authority: AuthorityStore,
  openClaim: (head: MemoryV3ClaimHeadRecord, record: MemoryV3ClaimRecord) => MemoryV3OpenedClaim,
  secret: Uint8Array,
  config: MemoryEngineConfig,
  query: MemoryQuery,
): MemoryV3RecallResult {
  if (!config.enabled || config.mode === "OFF") {
    return { selections: [], conflicts: [], abstentions: [], omittedClaimIds: [], metadataCandidateCount: 0,
      decryptedCandidateCount: 0, integrityFailureCount: 0, additionalModelRequests: 0 };
  }
  const terms = queryTerms(secret, query);
  const matches: MemoryV3CandidateHeadMatch[] = [];
  for (const channel of channelOrder) {
    const configured = channel === "POLICY" ? config.maxPolicyResults
      : channel === "EVIDENCE" ? config.maxEvidenceResults : config.maxExperienceResults;
    if (configured === 0) continue;
    matches.push(...authority.readMemoryV3MatchingHeads(
      query.workspaceId, query.goalId, channel, terms, channel === "POLICY", frontierLimit(config, channel),
    ));
  }

  const candidates: OpenCandidate[] = [];
  const abstentions: string[] = [];
  const omitted: string[] = [];
  let decrypted = 0;
  let integrityFailures = 0;
  for (const match of matches) {
    const record = authority.readMemoryV3Claim(match.head.claimId, match.head.version);
    if (!record) {
      abstentions.push(`${match.head.claimId}:AUTHORITY_RECORD_MISSING`);
      integrityFailures += 1;
      continue;
    }
    if (!activeAt(record, query.nowMs)) {
      omitted.push(record.claimId);
      continue;
    }
    try {
      const opened = openClaim(match.head, record);
      decrypted += 1;
      const source = decodeSourceAttestation(opened.body.source);
      const verification = verifySourceAttestation(
        authority, source, query.workspaceId, query.workspaceRoot, config.maxPayloadBytes, query.nowMs,
      );
      if (!verification.current) {
        abstentions.push(`${record.claimId}:${verification.reason}`);
        continue;
      }
      candidates.push({ selection: selection(opened, match.matchedTerms), opened });
    } catch (error) {
      integrityFailures += 1;
      abstentions.push(`${record.claimId}:V3_INTEGRITY_FAILED`);
      void error;
    }
  }

  const conflictIds = structuredConflicts(authority, secret, query, config, candidates, abstentions, omitted);
  const seenPolicyDuplicates = new Set<string>();
  const selections = candidates.filter((candidate) => {
    if (conflictIds.has(candidate.selection.claimId)) return false;
    if (candidate.selection.channel !== "POLICY") return true;
    const identity = structuredIdentity(candidate.opened);
    const payload = candidate.opened.body.payload;
    if (!identity || payload.type !== "TYPED_POLICY") return false;
    const key = `${identity.scope}\0${identity.semanticKey}\0${payload.operator}\0${candidate.opened.record.valueSha256}`;
    if (seenPolicyDuplicates.has(key)) return false;
    seenPolicyDuplicates.add(key);
    return true;
  }).map((candidate) => candidate.selection);

  return {
    selections,
    conflicts: [...conflictIds].sort(),
    abstentions: [...new Set(abstentions)].sort(),
    omittedClaimIds: [...new Set([...omitted, ...conflictIds])].sort(),
    metadataCandidateCount: matches.length,
    decryptedCandidateCount: decrypted,
    integrityFailureCount: integrityFailures,
    additionalModelRequests: 0,
  };
}
