import { normalizeMemoryPath, normalizeMemoryTags } from "./admission.js";
import type { EffectiveMemoryClaim, MemoryCandidateRank, MemoryQuery, TypedPolicy } from "./types.js";

export interface RankedMemoryClaim {
  readonly value: EffectiveMemoryClaim;
  readonly reason: string;
  readonly exactMatches: number;
  readonly lexicalMatches: number;
  readonly relevanceRank: number | null;
}

const scopeRank = { GOAL: 2, WORKSPACE: 1 } as const;

function exactMatches(value: EffectiveMemoryClaim, query: MemoryQuery): number {
  const tags = new Set(normalizeMemoryTags(query.tags));
  const dependencies = new Set(normalizeMemoryTags(query.dependencyKeys));
  const paths = new Set((query.pathKeys ?? []).map(normalizeMemoryPath).filter((path): path is string => path !== null));
  return value.claim.tags.reduce((count, tag) => count + (tags.has(tag) ? 1 : 0), 0)
    + value.claim.dependencyKeys.reduce((count, key) => count + (dependencies.has(key) ? 1 : 0), 0)
    + (value.claim.pathKey && paths.has(value.claim.pathKey) ? 1 : 0);
}

export function rankMemoryChannel(
  values: readonly EffectiveMemoryClaim[],
  query: MemoryQuery,
  candidateRanks: ReadonlyMap<string, MemoryCandidateRank>,
): RankedMemoryClaim[] {
  return values.map((value) => {
    const candidate = candidateRanks.get(value.claim.claimId);
    const exact = Math.max(exactMatches(value, query), candidate?.exactMatches ?? 0);
    const lexical = candidate?.lexicalMatches ?? 0;
    const relevance = candidate?.relevanceRank ?? null;
    const reason = [
      value.endorsed ? "ENDORSED" : null,
      `${value.claim.scope}_SCOPE`,
      exact > 0 ? `EXACT_${exact}` : null,
      lexical > 0 ? `LEXICAL_${lexical}` : null,
      relevance === null ? null : "BM25",
      value.claim.sourceAttestation.resolver,
    ].filter(Boolean).join("+");
    return { value, reason, exactMatches: exact, lexicalMatches: lexical, relevanceRank: relevance };
  }).sort((left, right) => {
    const channel = left.value.claim.channel;
    if (channel === "POLICY") {
      const policyOrder = [
        scopeRank[right.value.claim.scope] - scopeRank[left.value.claim.scope],
        right.exactMatches - left.exactMatches,
        Number(right.value.endorsed) - Number(left.value.endorsed),
        right.lexicalMatches - left.lexicalMatches,
        left.relevanceRank === null || right.relevanceRank === null ? 0 : left.relevanceRank - right.relevanceRank,
        right.value.claim.validFromMs - left.value.claim.validFromMs,
      ];
      const difference = policyOrder.find((entry) => entry !== 0);
      if (difference !== undefined) return difference;
    } else if (channel === "EVIDENCE") {
      if (right.exactMatches !== left.exactMatches) return right.exactMatches - left.exactMatches;
      if (right.lexicalMatches !== left.lexicalMatches) return right.lexicalMatches - left.lexicalMatches;
      if (left.relevanceRank !== null || right.relevanceRank !== null) {
        if (left.relevanceRank === null) return 1;
        if (right.relevanceRank === null) return -1;
        if (left.relevanceRank !== right.relevanceRank) return left.relevanceRank - right.relevanceRank;
      }
      if (scopeRank[right.value.claim.scope] !== scopeRank[left.value.claim.scope]) {
        return scopeRank[right.value.claim.scope] - scopeRank[left.value.claim.scope];
      }
    } else {
      if (right.exactMatches !== left.exactMatches) return right.exactMatches - left.exactMatches;
      if (right.lexicalMatches !== left.lexicalMatches) return right.lexicalMatches - left.lexicalMatches;
      if (scopeRank[right.value.claim.scope] !== scopeRank[left.value.claim.scope]) {
        return scopeRank[right.value.claim.scope] - scopeRank[left.value.claim.scope];
      }
      if (Number(right.value.endorsed) !== Number(left.value.endorsed)) {
        return Number(right.value.endorsed) - Number(left.value.endorsed);
      }
    }
    if (right.value.claim.validFromMs !== left.value.claim.validFromMs) {
      return right.value.claim.validFromMs - left.value.claim.validFromMs;
    }
    return left.value.claim.claimId.localeCompare(right.value.claim.claimId);
  });
}

function policyPolarity(payload: TypedPolicy): { readonly negative: boolean; readonly subject: string } {
  const normalized = payload.statement.normalize("NFKC").trim().toLowerCase().replace(/[.!。！]+$/gu, "");
  const negativePrefix = /^(?:do not|don't|never|avoid|must not)\s+/u;
  const negative = negativePrefix.test(normalized);
  const withoutPolarity = normalized.replace(negativePrefix, "");
  const subject = withoutPolarity.replace(/^(?:always|prefer|use|must)\s+/u, "").trim();
  return { negative, subject };
}

export function conflictingPolicyClaimIds(values: readonly RankedMemoryClaim[]): ReadonlySet<string> {
  const conflicts = new Set<string>();
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    const left = values[leftIndex];
    if (!left || left.value.claim.payload.type !== "TYPED_POLICY") continue;
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const right = values[rightIndex];
      if (!right || right.value.claim.payload.type !== "TYPED_POLICY") continue;
      if (left.value.claim.scope !== right.value.claim.scope || left.exactMatches !== right.exactMatches
        || left.value.endorsed !== right.value.endorsed
        || left.value.claim.payload.policyKind !== right.value.claim.payload.policyKind
        || left.value.claim.payload.appliesTo.join("\0") !== right.value.claim.payload.appliesTo.join("\0")) continue;
      const leftMeaning = policyPolarity(left.value.claim.payload);
      const rightMeaning = policyPolarity(right.value.claim.payload);
      if (leftMeaning.subject && leftMeaning.subject === rightMeaning.subject && leftMeaning.negative !== rightMeaning.negative) {
        conflicts.add(left.value.claim.claimId);
        conflicts.add(right.value.claim.claimId);
      }
    }
  }
  return conflicts;
}
