import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { assertGoalContract, type GoalContractRecord, type TaskObligationRecord } from "../task-flow/domain.js";
import type {
  AcceptanceAuthorityInputV2,
  AcceptanceAuthorityRootV2,
  AcceptanceBundleV2,
  AcceptanceFacetKindV2,
  AcceptanceFacetProposalV2,
  AcceptanceFacetV2,
  AcceptanceObligationV2,
  AcceptanceProjectionV2,
  AcceptanceQualificationBasisV2,
  AcceptanceSourceRevisionV2,
  AcceptanceSubjectKindV2,
  EvidenceRequirementKindV2,
  EvidenceRequirementV2,
  FacetObligationBindingV2,
  FacetObligationRelationV2,
  SourceSpanRefV2,
} from "./domain.js";

const maximumSourceBytes = 131_072;
const maximumBindingCount = 4_096;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const semanticKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const subjectKinds = new Set<AcceptanceSubjectKindV2>(["USER_OUTCOME", "CONSTRAINT", "NON_GOAL"]);
const facetKinds = new Set<AcceptanceFacetKindV2>(["OUTCOME", "INVARIANT", "QUALITY", "CONSTRAINT", "NON_GOAL"]);

interface NormalizedAcceptanceFacetProposalV2 {
  readonly key: string;
  readonly kind: AcceptanceFacetKindV2;
  readonly subject: { readonly kind: AcceptanceSubjectKindV2; readonly index: number };
  readonly source_quotes: readonly { readonly quote: string; readonly occurrence: number }[];
  readonly source_binding: "ENTIRE_INTAKE" | null;
  readonly obligation_keys: readonly string[];
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertSealed(domain: string, value: Record<string, unknown>, label: string): void {
  const { record_sha256: recordSha256, ...body } = value;
  if (typeof recordSha256 !== "string" || recordSha256 !== canonicalJsonSha256({ domain, ...body })) {
    throw new TypeError(`${label} record hash is invalid`);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label}.${unexpected[0]} is not allowed`);
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSchemaV2(value: { readonly schema_version: unknown }, label: string): void {
  if (value.schema_version !== 2) throw new TypeError(`${label}.schema_version must be 2`);
}

function assertCanonicalIds(ids: readonly string[], label: string): void {
  const canonical = [...ids].sort(compareCanonicalText);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== canonical[index])) {
    throw new TypeError(`${label} must use unique canonical ID order`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sourceBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.length < 1 || bytes.length > maximumSourceBytes) {
    throw new TypeError(`Acceptance V2 source must contain 1..${maximumSourceBytes} UTF-8 bytes`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Acceptance V2 source must contain valid exact UTF-8 bytes");
  }
  return bytes;
}

function sourceStatement(contract: GoalContractRecord, kind: AcceptanceSubjectKindV2, index: number): string {
  const collection = kind === "USER_OUTCOME" ? contract.user_outcomes
    : kind === "CONSTRAINT" ? contract.constraints : contract.non_goals;
  const value = collection[index];
  if (value === undefined) throw new TypeError(`Acceptance facet subject ${kind}[${index}] is outside the frozen contract`);
  return value;
}

function assertKindMatchesSubject(kind: AcceptanceFacetKindV2, subject: AcceptanceSubjectKindV2): void {
  const valid = subject === "USER_OUTCOME"
    ? kind === "OUTCOME" || kind === "INVARIANT" || kind === "QUALITY"
    : subject === "CONSTRAINT" ? kind === "CONSTRAINT" : kind === "NON_GOAL";
  if (!valid) throw new TypeError(`Acceptance facet kind ${kind} cannot bind ${subject}`);
}

interface QuoteOccurrenceIndex {
  readonly positions: number[];
  cursor: number;
}

function locateOccurrence(
  source: Uint8Array,
  quote: Uint8Array,
  occurrence: number,
  indexes: Map<string, QuoteOccurrenceIndex>,
): number {
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > source.length) {
    throw new TypeError("Acceptance source quote occurrence is outside the bounded exact source");
  }
  const haystack = Buffer.from(source);
  const needle = Buffer.from(quote);
  const key = needle.toString("base64");
  let index = indexes.get(key);
  if (!index) {
    index = { positions: [], cursor: 0 };
    indexes.set(key, index);
  }
  while (index.positions.length < occurrence) {
    const found = haystack.indexOf(needle, index.cursor);
    if (found < 0) throw new TypeError("Acceptance source quote occurrence does not exist in the exact intake bytes");
    index.positions.push(found);
    index.cursor = found + 1;
  }
  return index.positions[occurrence - 1]!;
}

function normalizeProposal(value: unknown, index: number): NormalizedAcceptanceFacetProposalV2 {
  const item = record(value, `Acceptance facet proposal[${index}]`);
  exactKeys(item, ["key", "kind", "subject", "source_quotes", "source_binding", "obligation_keys"], `Acceptance facet proposal[${index}]`);
  if (typeof item.key !== "string" || !semanticKeyPattern.test(item.key)) {
    throw new TypeError(`Acceptance facet proposal[${index}].key must be a stable kebab-case key`);
  }
  if (typeof item.kind !== "string" || !facetKinds.has(item.kind as AcceptanceFacetKindV2)) {
    throw new TypeError(`Acceptance facet proposal[${index}].kind is invalid`);
  }
  const subject = record(item.subject, `Acceptance facet proposal[${index}].subject`);
  exactKeys(subject, ["kind", "index"], `Acceptance facet proposal[${index}].subject`);
  if (typeof subject.kind !== "string" || !subjectKinds.has(subject.kind as AcceptanceSubjectKindV2)
    || !Number.isSafeInteger(subject.index) || Number(subject.index) < 0) {
    throw new TypeError(`Acceptance facet proposal[${index}].subject is invalid`);
  }
  const entireIntake = item.source_binding === "ENTIRE_INTAKE";
  if (item.source_binding !== undefined && !entireIntake) {
    throw new TypeError(`Acceptance facet proposal[${index}].source_binding is invalid`);
  }
  if (entireIntake === Array.isArray(item.source_quotes)) {
    throw new TypeError(`Acceptance facet proposal[${index}] requires either 1..16 exact source quotes or ENTIRE_INTAKE`);
  }
  if (Array.isArray(item.source_quotes) && (item.source_quotes.length < 1 || item.source_quotes.length > 16)) {
    throw new TypeError(`Acceptance facet proposal[${index}] requires 1..16 exact source quotes`);
  }
  const sourceQuotes = (Array.isArray(item.source_quotes) ? item.source_quotes : []).map((value, quoteIndex) => {
    const quote = record(value, `Acceptance facet proposal[${index}].source_quotes[${quoteIndex}]`);
    exactKeys(quote, ["quote", "occurrence"], `Acceptance facet proposal[${index}].source_quotes[${quoteIndex}]`);
    if (typeof quote.quote !== "string" || Buffer.byteLength(quote.quote, "utf8") < 1
      || Buffer.byteLength(quote.quote, "utf8") > 8_192 || !Number.isSafeInteger(quote.occurrence)) {
      throw new TypeError(`Acceptance facet proposal[${index}].source_quotes[${quoteIndex}] is invalid`);
    }
    return { quote: quote.quote, occurrence: Number(quote.occurrence) };
  });
  if (!Array.isArray(item.obligation_keys) || item.obligation_keys.length < 1
    || item.obligation_keys.some((key) => typeof key !== "string" || !semanticKeyPattern.test(key))) {
    throw new TypeError(`Acceptance facet proposal[${index}].obligation_keys must bind at least one frozen obligation`);
  }
  const obligationKeys = item.obligation_keys as string[];
  if (new Set(obligationKeys).size !== obligationKeys.length) {
    throw new TypeError(`Acceptance facet proposal[${index}] repeats an obligation key`);
  }
  const normalized = {
    key: item.key,
    kind: item.kind as AcceptanceFacetKindV2,
    subject: { kind: subject.kind as AcceptanceSubjectKindV2, index: Number(subject.index) },
    source_quotes: sourceQuotes,
    source_binding: entireIntake ? "ENTIRE_INTAKE" as const : null,
    obligation_keys: obligationKeys,
  };
  assertKindMatchesSubject(normalized.kind, normalized.subject.kind);
  return normalized;
}

export function assertAcceptanceFacetProposalsV2(value: unknown): asserts value is readonly AcceptanceFacetProposalV2[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new TypeError("acceptance_facets must contain 1..256 typed proposals");
  }
  value.forEach((proposal, index) => normalizeProposal(proposal, index));
}

function expectedSubjects(contract: GoalContractRecord): Set<string> {
  return new Set([
    ...contract.user_outcomes.map((_, index) => `USER_OUTCOME:${index}`),
    ...contract.constraints.map((_, index) => `CONSTRAINT:${index}`),
    ...contract.non_goals.map((_, index) => `NON_GOAL:${index}`),
  ]);
}

function linkRelation(kind: AcceptanceFacetKindV2): FacetObligationRelationV2 {
  if (kind === "CONSTRAINT") return "CONSTRAINS";
  if (kind === "NON_GOAL") return "BOUNDS";
  return "SATISFIES";
}

function requirementKind(kind: AcceptanceFacetKindV2): EvidenceRequirementKindV2 {
  if (kind === "INVARIANT") return "PRESERVATION_REVIEW";
  if (kind === "CONSTRAINT" || kind === "NON_GOAL") return "OPERATION_CLOSURE";
  return "HOST_ORACLE";
}

function obligationMap(contract: GoalContractRecord): Map<string, TaskObligationRecord> {
  return new Map(contract.obligations.map((obligation) => [obligation.semantic_key, obligation]));
}

function memberRoot(domain: string, members: readonly { readonly record_sha256: string }[]): string {
  return canonicalJsonSha256({ domain, members: members.map((member) => member.record_sha256).sort() });
}

function authorityRootId(
  root: Omit<AcceptanceAuthorityRootV2, "authority_root_id" | "record_sha256">,
): string {
  return idFromSha256(
    "ACCEPT_AUTHORITY",
    canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-AUTHORITY-IDENTITY-V2", ...root }),
  );
}

function assertSha256(value: string | null | undefined, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
}

function assertQualification(
  basis: AcceptanceQualificationBasisV2,
  legacyHead: string | null,
  requalificationReceipt: string | null,
): void {
  if (basis === "NATIVE_EXACT") {
    if (legacyHead !== null || requalificationReceipt !== null) {
      throw new TypeError("Native Acceptance V2 cannot claim a legacy requalification receipt");
    }
    return;
  }
  if (basis !== "LEGACY_REQUALIFIED") {
    throw new TypeError("Acceptance V2 qualification_basis is invalid");
  }
  assertSha256(legacyHead, "legacy_event_head_sha256");
  assertSha256(requalificationReceipt, "requalification_receipt_sha256");
}

export function finalizeAcceptanceV2(input: {
  readonly goalId: string;
  readonly contract: GoalContractRecord;
  readonly source: string | Uint8Array;
  readonly facets: readonly AcceptanceFacetProposalV2[];
  readonly authority: AcceptanceAuthorityInputV2;
}): AcceptanceBundleV2 {
  if (input.goalId !== input.contract.goal_id) throw new TypeError("Acceptance V2 Goal/contract binding is invalid");
  const bytes = sourceBytes(input.source);
  if (sha256Hex(bytes) !== input.contract.source_intake_sha256) {
    throw new TypeError("Acceptance V2 requires the exact frozen UTF-8 intake bytes");
  }
  assertSha256(input.authority.predecessor_authority_head_sha256, "predecessor_authority_head_sha256");
  const legacyHead = input.authority.legacy_event_head_sha256 ?? null;
  const requalificationReceipt = input.authority.requalification_receipt_sha256 ?? null;
  assertQualification(input.authority.qualification_basis, legacyHead, requalificationReceipt);
  const parentSourceRevisionId = input.authority.parent_source_revision_id ?? null;
  if ((input.contract.version === 1) !== (parentSourceRevisionId === null)) {
    throw new TypeError("Acceptance V2 source revision parent does not match the contract revision");
  }

  const sourceBase = {
    schema_version: 2 as const,
    source_revision_id: idFromSha256("ACCEPT_SOURCE_REV", canonicalJsonSha256({
      goal: input.goalId, contract: input.contract.record_sha256, content: sha256Hex(bytes),
    })),
    goal_id: input.goalId,
    contract_id: input.contract.contract_id,
    revision: input.contract.version,
    parent_source_revision_id: parentSourceRevisionId,
    content_sha256: sha256Hex(bytes),
    byte_length: bytes.length,
    encoding: "UTF-8" as const,
    fidelity: "EXACT" as const,
  };
  const source: AcceptanceSourceRevisionV2 = sealed("PCH-ACCEPTANCE-SOURCE-REVISION-V2", sourceBase);
  const proposals = input.facets.map(normalizeProposal).sort((left, right) => compareCanonicalText(left.key, right.key));
  if (new Set(proposals.map((proposal) => proposal.key)).size !== proposals.length) {
    throw new TypeError("Acceptance facet semantic keys must be unique");
  }
  const bindingCount = proposals.reduce((count, proposal) => count + proposal.obligation_keys.length, 0);
  if (bindingCount > maximumBindingCount) {
    throw new TypeError(`Acceptance V2 cannot exceed ${maximumBindingCount} facet/obligation bindings`);
  }
  const coveredSubjects = new Set(proposals.map((proposal) => `${proposal.subject.kind}:${proposal.subject.index}`));
  const expected = expectedSubjects(input.contract);
  if (coveredSubjects.size !== expected.size || [...coveredSubjects].some((subject) => !expected.has(subject))) {
    throw new TypeError("Acceptance facets must cover every frozen contract subject at least once");
  }

  const obligations: AcceptanceObligationV2[] = [...input.contract.obligations]
    .sort((left, right) => compareCanonicalText(left.semantic_key, right.semantic_key))
    .map((obligation) => sealed("PCH-ACCEPTANCE-OBLIGATION-V2", {
      schema_version: 2 as const,
      acceptance_obligation_id: idFromSha256("ACCEPT_OBLIGATION", canonicalJsonSha256({
        contract: input.contract.record_sha256, obligation: obligation.record_sha256,
      })),
      goal_id: input.goalId,
      contract_id: input.contract.contract_id,
      task_obligation_id: obligation.obligation_id,
      semantic_key: obligation.semantic_key,
      priority: obligation.priority,
      statement: obligation.statement,
      frozen_oracle_sha256: canonicalJsonSha256(obligation.oracle),
      dependency_ids: [...obligation.dependencies].sort(),
      task_obligation_sha256: obligation.record_sha256,
    }));
  const proposalObligations = obligationMap(input.contract);
  const acceptanceObligations = new Map(obligations.map((obligation) => [obligation.semantic_key, obligation]));
  const spans: SourceSpanRefV2[] = [];
  const facets: AcceptanceFacetV2[] = [];
  const bindings: FacetObligationBindingV2[] = [];
  const evidenceRequirements: EvidenceRequirementV2[] = [];
  const satisfiedMust = new Set<string>();
  const quoteIndexes = new Map<string, QuoteOccurrenceIndex>();

  for (const proposal of proposals) {
    const spanIds = new Set<string>();
    const sourceRanges = proposal.source_binding === "ENTIRE_INTAKE"
      ? [{ start: 0, quoteBytes: bytes }]
      : proposal.source_quotes.map((sourceQuote) => ({
          start: locateOccurrence(bytes, Buffer.from(sourceQuote.quote, "utf8"), sourceQuote.occurrence, quoteIndexes),
          quoteBytes: Buffer.from(sourceQuote.quote, "utf8"),
        }));
    for (const { start, quoteBytes } of sourceRanges) {
      const span = sealed("PCH-SOURCE-SPAN-V2", {
        schema_version: 2 as const,
        span_id: idFromSha256("SOURCE_SPAN", canonicalJsonSha256({
          source: source.record_sha256, start, end: start + quoteBytes.length, quote: sha256Hex(quoteBytes),
        })),
        goal_id: input.goalId,
        contract_id: input.contract.contract_id,
        source_revision_id: source.source_revision_id,
        source_sha256: source.content_sha256,
        start_byte: start,
        end_byte_exclusive: start + quoteBytes.length,
        quote_sha256: sha256Hex(quoteBytes),
      });
      if (!spans.some((current) => current.span_id === span.span_id)) spans.push(span);
      spanIds.add(span.span_id);
    }
    const facet = sealed("PCH-ACCEPTANCE-FACET-V2", {
      schema_version: 2 as const,
      facet_id: idFromSha256("ACCEPT_FACET", canonicalJsonSha256({
        contract: input.contract.record_sha256, key: proposal.key, kind: proposal.kind,
        subject: proposal.subject, spans: [...spanIds].sort(),
      })),
      goal_id: input.goalId,
      contract_id: input.contract.contract_id,
      semantic_key: proposal.key,
      kind: proposal.kind,
      subject: proposal.subject,
      semantic_statement: sourceStatement(input.contract, proposal.subject.kind, proposal.subject.index),
      source_span_ids: [...spanIds].sort(),
      derivation: "CURRENT_AGENT_TYPED_PROPOSAL" as const,
    });
    facets.push(facet);
    const relation = linkRelation(proposal.kind);
    for (const obligationKey of [...proposal.obligation_keys].sort()) {
      const taskObligation = proposalObligations.get(obligationKey);
      const obligation = acceptanceObligations.get(obligationKey);
      if (!taskObligation || !obligation) {
        throw new TypeError(`Acceptance facet ${proposal.key} maps unknown obligation ${obligationKey}`);
      }
      if (relation === "SATISFIES" && taskObligation.priority !== "MUST") {
        throw new TypeError(`Acceptance facet ${proposal.key} can satisfy only MUST obligations`);
      }
      const binding = sealed("PCH-FACET-OBLIGATION-BINDING-V2", {
        schema_version: 2 as const,
        binding_id: idFromSha256("FACET_BINDING", canonicalJsonSha256({
          facet: facet.record_sha256, obligation: obligation.record_sha256, relation,
        })),
        goal_id: input.goalId,
        contract_id: input.contract.contract_id,
        facet_id: facet.facet_id,
        acceptance_obligation_id: obligation.acceptance_obligation_id,
        relation,
      });
      bindings.push(binding);
      const kind = requirementKind(proposal.kind);
      evidenceRequirements.push(sealed("PCH-EVIDENCE-REQUIREMENT-V2", {
        schema_version: 2 as const,
        evidence_requirement_id: idFromSha256("EVIDENCE_REQ", canonicalJsonSha256({
          binding: binding.record_sha256, kind, oracle: obligation.frozen_oracle_sha256,
        })),
        goal_id: input.goalId,
        contract_id: input.contract.contract_id,
        binding_id: binding.binding_id,
        requirement_kind: kind,
        frozen_oracle_sha256: obligation.frozen_oracle_sha256,
        required_inputs: [
          "AUTHORIZATION", "TERMINAL_TRANSITION", "POSTIMAGE", "ENVIRONMENT", "INTEGRATION_SET", "TOPOLOGY_REVISION",
        ] as const,
        freshness_policy: "CURRENT_POSTIMAGE" as const,
        execution_owner: "HOST" as const,
      }));
      if (relation === "SATISFIES") satisfiedMust.add(taskObligation.obligation_id);
    }
  }

  const mustIds = input.contract.obligations.filter((obligation) => obligation.priority === "MUST")
    .map((obligation) => obligation.obligation_id);
  if (mustIds.some((obligationId) => !satisfiedMust.has(obligationId))) {
    throw new TypeError("Acceptance V2 leaves a MUST obligation without an explicit source-bound SATISFIES binding");
  }
  const sourceRoot = memberRoot("PCH-ACCEPTANCE-SOURCE-ROOT-V2", [source]);
  const spanRoot = memberRoot("PCH-ACCEPTANCE-SPAN-ROOT-V2", spans);
  const facetRoot = memberRoot("PCH-ACCEPTANCE-FACET-ROOT-V2", facets);
  const obligationRoot = memberRoot("PCH-ACCEPTANCE-OBLIGATION-ROOT-V2", obligations);
  const bindingRoot = memberRoot("PCH-ACCEPTANCE-BINDING-ROOT-V2", bindings);
  const evidenceRoot = memberRoot("PCH-EVIDENCE-REQUIREMENT-ROOT-V2", evidenceRequirements);
  const authorityIdentity = {
    schema_version: 2 as const,
    goal_id: input.goalId,
    contract_id: input.contract.contract_id,
    contract_sha256: input.contract.record_sha256,
    generation: input.contract.version,
    qualification_basis: input.authority.qualification_basis,
    predecessor_authority_head_sha256: input.authority.predecessor_authority_head_sha256,
    legacy_event_head_sha256: legacyHead,
    requalification_receipt_sha256: requalificationReceipt,
    source_revision_id: source.source_revision_id,
    source_root_sha256: sourceRoot,
    span_root_sha256: spanRoot,
    facet_root_sha256: facetRoot,
    obligation_root_sha256: obligationRoot,
    binding_root_sha256: bindingRoot,
    evidence_requirement_root_sha256: evidenceRoot,
    facet_count: facets.length,
    obligation_count: obligations.length,
    binding_count: bindings.length,
    evidence_requirement_count: evidenceRequirements.length,
    unresolved_material_count: 0 as const,
  } satisfies Omit<AcceptanceAuthorityRootV2, "authority_root_id" | "record_sha256">;
  const authority: AcceptanceAuthorityRootV2 = sealed("PCH-ACCEPTANCE-AUTHORITY-ROOT-V2", {
    ...authorityIdentity,
    authority_root_id: authorityRootId(authorityIdentity),
  });
  const bundle = {
    source,
    source_bytes: bytes,
    spans: spans.sort((left, right) => compareCanonicalText(left.span_id, right.span_id)),
    facets: facets.sort((left, right) => compareCanonicalText(left.semantic_key, right.semantic_key)),
    obligations: obligations.sort((left, right) => compareCanonicalText(left.acceptance_obligation_id, right.acceptance_obligation_id)),
    bindings: bindings.sort((left, right) => compareCanonicalText(left.binding_id, right.binding_id)),
    evidence_requirements: evidenceRequirements.sort((left, right) => compareCanonicalText(left.evidence_requirement_id, right.evidence_requirement_id)),
    authority,
    contract: input.contract,
  } satisfies AcceptanceBundleV2;
  assertAcceptanceBundleV2(bundle);
  return bundle;
}

export function acceptanceProjectionV2(bundle: AcceptanceBundleV2): AcceptanceProjectionV2 {
  return {
    source: bundle.source,
    spans: bundle.spans,
    facets: bundle.facets,
    obligations: bundle.obligations,
    bindings: bundle.bindings,
    evidence_requirements: bundle.evidence_requirements,
    authority: bundle.authority,
  };
}

export function assertAcceptanceBundleV2(bundle: AcceptanceBundleV2): void {
  exactKeys(bundle as unknown as Record<string, unknown>, [
    "source", "source_bytes", "spans", "facets", "obligations", "bindings",
    "evidence_requirements", "authority", "contract",
  ], "Acceptance bundle");
  assertGoalContract(bundle.contract);
  const bytes = sourceBytes(bundle.source_bytes);
  exactKeys(bundle.authority as unknown as Record<string, unknown>, [
    "schema_version", "authority_root_id", "goal_id", "contract_id", "contract_sha256", "generation",
    "qualification_basis", "predecessor_authority_head_sha256", "legacy_event_head_sha256",
    "requalification_receipt_sha256", "source_revision_id", "source_root_sha256", "span_root_sha256",
    "facet_root_sha256", "obligation_root_sha256", "binding_root_sha256",
    "evidence_requirement_root_sha256", "facet_count", "obligation_count", "binding_count",
    "evidence_requirement_count", "unresolved_material_count", "record_sha256",
  ], "Acceptance authority root");
  assertSchemaV2(bundle.authority, "Acceptance authority root");
  assertQualification(
    bundle.authority.qualification_basis,
    bundle.authority.legacy_event_head_sha256,
    bundle.authority.requalification_receipt_sha256,
  );
  assertSha256(bundle.authority.predecessor_authority_head_sha256, "predecessor_authority_head_sha256");
  if (bundle.authority.generation !== bundle.contract.version
    || bundle.authority.unresolved_material_count !== 0) {
    throw new TypeError("Acceptance V2 authority generation or unresolved material count is invalid");
  }
  exactKeys(bundle.source as unknown as Record<string, unknown>, [
    "schema_version", "source_revision_id", "goal_id", "contract_id", "revision",
    "parent_source_revision_id", "content_sha256", "byte_length", "encoding", "fidelity", "record_sha256",
  ], "Acceptance source");
  assertSchemaV2(bundle.source, "Acceptance source");
  const expectedSourceRevisionId = idFromSha256("ACCEPT_SOURCE_REV", canonicalJsonSha256({
    goal: bundle.contract.goal_id,
    contract: bundle.contract.record_sha256,
    content: sha256Hex(bytes),
  }));
  if (bundle.source.revision !== bundle.contract.version
    || (bundle.source.revision === 1) !== (bundle.source.parent_source_revision_id === null)
    || bundle.source.encoding !== "UTF-8" || bundle.source.fidelity !== "EXACT"
    || bundle.source.source_revision_id !== expectedSourceRevisionId) {
    throw new TypeError("Acceptance V2 source revision identity is invalid");
  }
  if (bundle.contract.goal_id !== bundle.authority.goal_id
    || bundle.contract.contract_id !== bundle.authority.contract_id
    || bundle.contract.record_sha256 !== bundle.authority.contract_sha256
    || bundle.source.goal_id !== bundle.authority.goal_id
    || bundle.source.contract_id !== bundle.authority.contract_id
    || bundle.source.content_sha256 !== sha256Hex(bytes)
    || bundle.source.byte_length !== bytes.length
    || bundle.source.source_revision_id !== bundle.authority.source_revision_id) {
    throw new TypeError("Acceptance V2 bundle identity closure is invalid");
  }
  assertSealed("PCH-ACCEPTANCE-SOURCE-REVISION-V2", bundle.source as unknown as Record<string, unknown>, "Acceptance source");
  assertCanonicalIds(bundle.spans.map((span) => span.span_id), "Acceptance spans");
  const spanIds = new Set<string>();
  for (const span of bundle.spans) {
    exactKeys(span as unknown as Record<string, unknown>, [
      "schema_version", "span_id", "goal_id", "contract_id", "source_revision_id", "source_sha256",
      "start_byte", "end_byte_exclusive", "quote_sha256", "record_sha256",
    ], "Acceptance span");
    assertSchemaV2(span, "Acceptance span");
    assertSealed("PCH-SOURCE-SPAN-V2", span as unknown as Record<string, unknown>, "Acceptance span");
    if (span.goal_id !== bundle.authority.goal_id || span.contract_id !== bundle.authority.contract_id
      || span.source_revision_id !== bundle.source.source_revision_id || span.source_sha256 !== bundle.source.content_sha256
      || span.start_byte < 0 || span.end_byte_exclusive > bytes.length || span.end_byte_exclusive <= span.start_byte) {
      throw new TypeError("Acceptance V2 span identity or bounds are invalid");
    }
    const slice = bytes.subarray(span.start_byte, span.end_byte_exclusive);
    try { new TextDecoder("utf-8", { fatal: true }).decode(slice); } catch {
      throw new TypeError("Acceptance V2 span cuts through a UTF-8 code point");
    }
    const expectedSpanId = idFromSha256("SOURCE_SPAN", canonicalJsonSha256({
      source: bundle.source.record_sha256,
      start: span.start_byte,
      end: span.end_byte_exclusive,
      quote: sha256Hex(slice),
    }));
    if (sha256Hex(slice) !== span.quote_sha256 || span.span_id !== expectedSpanId || spanIds.has(span.span_id)) {
      throw new TypeError("Acceptance V2 span quote or identity is invalid");
    }
    spanIds.add(span.span_id);
  }
  const canonicalFacets = [...bundle.facets].sort((left, right) => (
    compareCanonicalText(left.semantic_key, right.semantic_key)
    || compareCanonicalText(left.facet_id, right.facet_id)
  ));
  if (bundle.facets.some((facet, index) => facet.facet_id !== canonicalFacets[index]?.facet_id)) {
    throw new TypeError("Acceptance facets must use canonical semantic-key order");
  }
  const facetIds = new Set<string>();
  const facetKeys = new Set<string>();
  const coveredSubjects = new Set<string>();
  for (const facet of bundle.facets) {
    exactKeys(facet as unknown as Record<string, unknown>, [
      "schema_version", "facet_id", "goal_id", "contract_id", "semantic_key", "kind", "subject",
      "semantic_statement", "source_span_ids", "derivation", "record_sha256",
    ], "Acceptance facet");
    assertSchemaV2(facet, "Acceptance facet");
    exactKeys(facet.subject as unknown as Record<string, unknown>, ["kind", "index"], "Acceptance facet.subject");
    assertSealed("PCH-ACCEPTANCE-FACET-V2", facet as unknown as Record<string, unknown>, "Acceptance facet");
    if (!facetKinds.has(facet.kind) || !subjectKinds.has(facet.subject.kind)
      || !Number.isSafeInteger(facet.subject.index) || facet.subject.index < 0) {
      throw new TypeError("Acceptance V2 facet semantic binding is invalid");
    }
    assertKindMatchesSubject(facet.kind, facet.subject.kind);
    const expectedStatement = sourceStatement(bundle.contract, facet.subject.kind, facet.subject.index);
    assertCanonicalIds(facet.source_span_ids, `Acceptance facet ${facet.semantic_key} source spans`);
    const expectedFacetId = idFromSha256("ACCEPT_FACET", canonicalJsonSha256({
      contract: bundle.contract.record_sha256,
      key: facet.semantic_key,
      kind: facet.kind,
      subject: facet.subject,
      spans: facet.source_span_ids,
    }));
    if (facet.goal_id !== bundle.authority.goal_id || facet.contract_id !== bundle.authority.contract_id
      || facet.semantic_statement !== expectedStatement || !semanticKeyPattern.test(facet.semantic_key)
      || facet.source_span_ids.length < 1 || facet.source_span_ids.some((id) => !spanIds.has(id))
      || facet.derivation !== "CURRENT_AGENT_TYPED_PROPOSAL" || facet.facet_id !== expectedFacetId
      || facetIds.has(facet.facet_id) || facetKeys.has(facet.semantic_key)) {
      if (facet.semantic_statement !== expectedStatement) {
        throw new TypeError("Acceptance V2 facet semantic binding is invalid");
      }
      throw new TypeError("Acceptance V2 facet membership is invalid");
    }
    facetIds.add(facet.facet_id);
    facetKeys.add(facet.semantic_key);
    coveredSubjects.add(`${facet.subject.kind}:${facet.subject.index}`);
  }
  const expectedFacetSubjects = expectedSubjects(bundle.contract);
  if (coveredSubjects.size !== expectedFacetSubjects.size
    || [...coveredSubjects].some((subject) => !expectedFacetSubjects.has(subject))) {
    throw new TypeError("Acceptance V2 facets do not cover the frozen contract subjects");
  }
  const contractObligations = new Map(bundle.contract.obligations.map((obligation) => [obligation.obligation_id, obligation]));
  assertCanonicalIds(bundle.obligations.map((obligation) => obligation.acceptance_obligation_id), "Acceptance obligations");
  const obligationIds = new Set<string>();
  const acceptanceObligations = new Map<string, AcceptanceObligationV2>();
  const boundTaskObligationIds = new Set<string>();
  for (const obligation of bundle.obligations) {
    exactKeys(obligation as unknown as Record<string, unknown>, [
      "schema_version", "acceptance_obligation_id", "goal_id", "contract_id", "task_obligation_id",
      "semantic_key", "priority", "statement", "frozen_oracle_sha256", "dependency_ids",
      "task_obligation_sha256", "record_sha256",
    ], "Acceptance obligation");
    assertSchemaV2(obligation, "Acceptance obligation");
    assertSealed("PCH-ACCEPTANCE-OBLIGATION-V2", obligation as unknown as Record<string, unknown>, "Acceptance obligation");
    const taskObligation = contractObligations.get(obligation.task_obligation_id);
    const expectedDependencies = taskObligation ? [...taskObligation.dependencies].sort() : [];
    const expectedObligationId = taskObligation ? idFromSha256("ACCEPT_OBLIGATION", canonicalJsonSha256({
      contract: bundle.contract.record_sha256,
      obligation: taskObligation.record_sha256,
    })) : null;
    if (obligation.goal_id !== bundle.authority.goal_id || obligation.contract_id !== bundle.authority.contract_id
      || !taskObligation || obligation.semantic_key !== taskObligation.semantic_key
      || obligation.priority !== taskObligation.priority || obligation.statement !== taskObligation.statement
      || obligation.frozen_oracle_sha256 !== canonicalJsonSha256(taskObligation.oracle)
      || canonicalJsonSha256(obligation.dependency_ids) !== canonicalJsonSha256(expectedDependencies)
      || obligation.task_obligation_sha256 !== taskObligation.record_sha256
      || obligation.acceptance_obligation_id !== expectedObligationId
      || obligationIds.has(obligation.acceptance_obligation_id)
      || boundTaskObligationIds.has(obligation.task_obligation_id)) {
      if (taskObligation && (obligation.statement !== taskObligation.statement
        || obligation.frozen_oracle_sha256 !== canonicalJsonSha256(taskObligation.oracle)
        || obligation.task_obligation_sha256 !== taskObligation.record_sha256)) {
        throw new TypeError("Acceptance V2 obligation binding is invalid");
      }
      throw new TypeError("Acceptance V2 obligation membership is invalid");
    }
    obligationIds.add(obligation.acceptance_obligation_id);
    acceptanceObligations.set(obligation.acceptance_obligation_id, obligation);
    boundTaskObligationIds.add(obligation.task_obligation_id);
  }
  if (boundTaskObligationIds.size !== contractObligations.size
    || [...contractObligations.keys()].some((id) => !boundTaskObligationIds.has(id))) {
    throw new TypeError("Acceptance V2 obligations do not cover the frozen contract");
  }
  const facetsById = new Map(bundle.facets.map((facet) => [facet.facet_id, facet]));
  assertCanonicalIds(bundle.bindings.map((binding) => binding.binding_id), "Acceptance bindings");
  const bindingIds = new Set<string>();
  const bindingsById = new Map<string, FacetObligationBindingV2>();
  const boundFacetIds = new Set<string>();
  const satisfiedMustIds = new Set<string>();
  for (const binding of bundle.bindings) {
    exactKeys(binding as unknown as Record<string, unknown>, [
      "schema_version", "binding_id", "goal_id", "contract_id", "facet_id",
      "acceptance_obligation_id", "relation", "record_sha256",
    ], "Acceptance binding");
    assertSchemaV2(binding, "Acceptance binding");
    assertSealed("PCH-FACET-OBLIGATION-BINDING-V2", binding as unknown as Record<string, unknown>, "Acceptance binding");
    const facet = facetsById.get(binding.facet_id);
    const obligation = acceptanceObligations.get(binding.acceptance_obligation_id);
    const expectedRelation = facet ? linkRelation(facet.kind) : null;
    const expectedBindingId = facet && obligation && expectedRelation ? idFromSha256("FACET_BINDING", canonicalJsonSha256({
      facet: facet.record_sha256,
      obligation: obligation.record_sha256,
      relation: expectedRelation,
    })) : null;
    if (binding.goal_id !== bundle.authority.goal_id || binding.contract_id !== bundle.authority.contract_id
      || !facet || !obligation || binding.relation !== expectedRelation
      || binding.binding_id !== expectedBindingId
      || bindingIds.has(binding.binding_id)) {
      if (facet && obligation && binding.relation !== expectedRelation) {
        throw new TypeError("Acceptance V2 binding semantic relation is invalid");
      }
      throw new TypeError("Acceptance V2 binding membership is invalid");
    }
    if (binding.relation === "SATISFIES") {
      if (obligation.priority !== "MUST") {
        throw new TypeError("Acceptance V2 binding semantic relation is invalid");
      }
      satisfiedMustIds.add(obligation.task_obligation_id);
    }
    bindingIds.add(binding.binding_id);
    bindingsById.set(binding.binding_id, binding);
    boundFacetIds.add(binding.facet_id);
  }
  if (boundFacetIds.size !== facetIds.size || [...facetIds].some((id) => !boundFacetIds.has(id))) {
    throw new TypeError("Acceptance V2 leaves a facet without an obligation binding");
  }
  const mustTaskObligationIds = bundle.contract.obligations
    .filter((obligation) => obligation.priority === "MUST")
    .map((obligation) => obligation.obligation_id);
  if (mustTaskObligationIds.some((id) => !satisfiedMustIds.has(id))) {
    throw new TypeError("Acceptance V2 leaves a MUST obligation without a SATISFIES binding");
  }
  const requirementIds = new Set<string>();
  assertCanonicalIds(
    bundle.evidence_requirements.map((requirement) => requirement.evidence_requirement_id),
    "Acceptance evidence requirements",
  );
  const requiredBindingIds = new Set<string>();
  const expectedRequiredInputs: EvidenceRequirementV2["required_inputs"] = [
    "AUTHORIZATION", "TERMINAL_TRANSITION", "POSTIMAGE", "ENVIRONMENT", "INTEGRATION_SET", "TOPOLOGY_REVISION",
  ];
  for (const requirement of bundle.evidence_requirements) {
    exactKeys(requirement as unknown as Record<string, unknown>, [
      "schema_version", "evidence_requirement_id", "goal_id", "contract_id", "binding_id",
      "requirement_kind", "frozen_oracle_sha256", "required_inputs", "freshness_policy",
      "execution_owner", "record_sha256",
    ], "Evidence requirement");
    assertSchemaV2(requirement, "Evidence requirement");
    assertSealed("PCH-EVIDENCE-REQUIREMENT-V2", requirement as unknown as Record<string, unknown>, "Evidence requirement");
    const binding = bindingsById.get(requirement.binding_id);
    const facet = binding ? facetsById.get(binding.facet_id) : undefined;
    const obligation = binding ? acceptanceObligations.get(binding.acceptance_obligation_id) : undefined;
    const expectedRequirementKind = facet ? requirementKind(facet.kind) : null;
    const expectedRequirementId = binding && obligation && expectedRequirementKind
      ? idFromSha256("EVIDENCE_REQ", canonicalJsonSha256({
          binding: binding.record_sha256,
          kind: expectedRequirementKind,
          oracle: obligation.frozen_oracle_sha256,
        }))
      : null;
    if (requirement.goal_id !== bundle.authority.goal_id || requirement.contract_id !== bundle.authority.contract_id
      || !binding || !facet || !obligation || requirement.requirement_kind !== expectedRequirementKind
      || requirement.frozen_oracle_sha256 !== obligation.frozen_oracle_sha256
      || requirement.evidence_requirement_id !== expectedRequirementId
      || canonicalJsonSha256(requirement.required_inputs) !== canonicalJsonSha256(expectedRequiredInputs)
      || requirement.freshness_policy !== "CURRENT_POSTIMAGE" || requirement.execution_owner !== "HOST"
      || requirementIds.has(requirement.evidence_requirement_id) || requiredBindingIds.has(requirement.binding_id)) {
      if (binding && facet && obligation
        && (requirement.requirement_kind !== requirementKind(facet.kind)
          || requirement.frozen_oracle_sha256 !== obligation.frozen_oracle_sha256)) {
        throw new TypeError("Acceptance V2 evidence requirement binding is invalid");
      }
      throw new TypeError("Acceptance V2 evidence requirement membership is invalid");
    }
    requirementIds.add(requirement.evidence_requirement_id);
    requiredBindingIds.add(requirement.binding_id);
  }
  if (requiredBindingIds.size !== bindingIds.size || [...bindingIds].some((id) => !requiredBindingIds.has(id))) {
    throw new TypeError("Acceptance V2 leaves a binding without an evidence requirement");
  }
  if (bundle.authority.source_root_sha256 !== memberRoot("PCH-ACCEPTANCE-SOURCE-ROOT-V2", [bundle.source])
    || bundle.authority.span_root_sha256 !== memberRoot("PCH-ACCEPTANCE-SPAN-ROOT-V2", bundle.spans)
    || bundle.authority.facet_root_sha256 !== memberRoot("PCH-ACCEPTANCE-FACET-ROOT-V2", bundle.facets)
    || bundle.authority.obligation_root_sha256 !== memberRoot("PCH-ACCEPTANCE-OBLIGATION-ROOT-V2", bundle.obligations)
    || bundle.authority.binding_root_sha256 !== memberRoot("PCH-ACCEPTANCE-BINDING-ROOT-V2", bundle.bindings)
    || bundle.authority.evidence_requirement_root_sha256 !== memberRoot("PCH-EVIDENCE-REQUIREMENT-ROOT-V2", bundle.evidence_requirements)
    || bundle.authority.facet_count !== bundle.facets.length
    || bundle.authority.obligation_count !== bundle.obligations.length
    || bundle.authority.binding_count !== bundle.bindings.length
    || bundle.authority.evidence_requirement_count !== bundle.evidence_requirements.length
    || bundle.authority.facet_count < 1 || bundle.authority.facet_count > 256
    || bundle.authority.obligation_count < 1 || bundle.authority.obligation_count > 256
    || bundle.authority.binding_count < 1 || bundle.authority.binding_count > maximumBindingCount
    || bundle.authority.evidence_requirement_count < 1
    || bundle.authority.evidence_requirement_count > maximumBindingCount) {
    throw new TypeError("Acceptance V2 authority root does not match its explicit members");
  }
  const { authority_root_id: storedAuthorityRootId, ...sealedAuthorityIdentity } = bundle.authority;
  const { record_sha256: authorityRecordSha256, ...authorityIdentity } = sealedAuthorityIdentity;
  assertSha256(authorityRecordSha256, "Acceptance authority record_sha256");
  if (storedAuthorityRootId !== authorityRootId(authorityIdentity)) {
    throw new TypeError("Acceptance V2 authority root identity is invalid");
  }
  assertSealed("PCH-ACCEPTANCE-AUTHORITY-ROOT-V2", bundle.authority as unknown as Record<string, unknown>, "Acceptance authority root");
}
