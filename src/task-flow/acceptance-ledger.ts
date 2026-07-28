import { canonicalJsonSha256, omitProperty } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { GoalContractRecord, TaskObligationRecord } from "./domain.js";

export type AcceptanceFacetKind =
  | "SOURCE_ROOT" | "SOURCE_EXPLICIT" | "INFERRED_OUTCOME"
  | "NEGATIVE_CONSTRAINT" | "NON_GOAL" | "UNRESOLVED_AMBIGUITY";
export type AcceptanceLinkRelation = "COVERS" | "CONSTRAINS" | "DERIVED_FROM_ROOT" | "UNRESOLVED";

export interface AcceptanceSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly quote_sha256: string;
}

export interface AcceptanceFacetRecord {
  readonly facet_id: string;
  readonly kind: AcceptanceFacetKind;
  readonly statement: string;
  readonly source_span: AcceptanceSourceSpan | null;
  readonly ordinal: number;
  readonly record_sha256: string;
}

export interface AcceptanceLinkRecord {
  readonly link_id: string;
  readonly facet_id: string;
  readonly obligation_id: string | null;
  readonly relation: AcceptanceLinkRelation;
  readonly record_sha256: string;
}

export interface AcceptanceLedgerRecord {
  readonly schema_version: 1;
  readonly ledger_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly source_intake_sha256: string;
  readonly source_content_sha256: string;
  readonly source_fidelity: "EXACT" | "LEGACY_HASH_ONLY";
  readonly source_length: number;
  readonly facets: readonly AcceptanceFacetRecord[];
  readonly links: readonly AcceptanceLinkRecord[];
  readonly unresolved_facet_ids: readonly string[];
  readonly record_sha256: string;
}

function spanOf(source: string, statement: string): AcceptanceSourceSpan | null {
  const start = source.indexOf(statement);
  if (start < 0) return null;
  return { start, end: start + statement.length, quote_sha256: sha256Hex(statement) };
}

function sealFacet(contractId: string, ordinal: number, kind: AcceptanceFacetKind, statement: string, source: string): AcceptanceFacetRecord {
  const sourceSpan = kind === "SOURCE_ROOT" ? {
    start: 0, end: source.length, quote_sha256: sha256Hex(source),
  } : spanOf(source, statement);
  const effectiveKind = kind === "SOURCE_EXPLICIT" && sourceSpan === null ? "INFERRED_OUTCOME" : kind;
  const facetId = idFromSha256("FACET", canonicalJsonSha256({ contractId, ordinal, effectiveKind, statement, sourceSpan }));
  const body = { facet_id: facetId, kind: effectiveKind, statement, source_span: sourceSpan, ordinal };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-FACET-V1", ...body }) };
}

function sealLink(facetId: string, obligationId: string | null, relation: AcceptanceLinkRelation): AcceptanceLinkRecord {
  const linkId = idFromSha256("ACCEPT_LINK", canonicalJsonSha256({ facetId, obligationId, relation }));
  const body = { link_id: linkId, facet_id: facetId, obligation_id: obligationId, relation };
  return { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-LINK-V1", ...body }) };
}

function mustAt(obligations: readonly TaskObligationRecord[], index: number): TaskObligationRecord {
  const must = obligations.filter((entry) => entry.priority === "MUST");
  return must[Math.min(index, must.length - 1)]!;
}

export function buildAcceptanceLedger(input: {
  readonly source: string;
  readonly contract: GoalContractRecord;
  readonly sourceFidelity?: "EXACT" | "LEGACY_HASH_ONLY";
  readonly unresolvedAmbiguities?: readonly string[];
}): AcceptanceLedgerRecord {
  const source = input.source.normalize("NFC");
  const sourceFidelity = input.sourceFidelity ?? "EXACT";
  if (!source || (sourceFidelity === "EXACT" && sha256Hex(source) !== input.contract.source_intake_sha256)) {
    throw new TypeError("AcceptanceLedger source does not match the frozen intake");
  }
  const facets: AcceptanceFacetRecord[] = [];
  facets.push(sealFacet(input.contract.contract_id, facets.length, "SOURCE_ROOT", source, source));
  for (const outcome of input.contract.user_outcomes) {
    facets.push(sealFacet(input.contract.contract_id, facets.length, "SOURCE_EXPLICIT", outcome, source));
  }
  for (const constraint of input.contract.constraints) {
    facets.push(sealFacet(input.contract.contract_id, facets.length, "NEGATIVE_CONSTRAINT", constraint, source));
  }
  for (const nonGoal of input.contract.non_goals) {
    facets.push(sealFacet(input.contract.contract_id, facets.length, "NON_GOAL", nonGoal, source));
  }
  for (const ambiguity of input.unresolvedAmbiguities ?? []) {
    if (ambiguity.trim()) facets.push(sealFacet(input.contract.contract_id, facets.length, "UNRESOLVED_AMBIGUITY", ambiguity.trim(), source));
  }

  const links: AcceptanceLinkRecord[] = [];
  const root = facets[0]!;
  for (const obligation of input.contract.obligations) {
    links.push(sealLink(root.facet_id, obligation.obligation_id, "DERIVED_FROM_ROOT"));
  }
  const outcomeFacets = facets.filter((entry) => entry.kind === "SOURCE_EXPLICIT" || entry.kind === "INFERRED_OUTCOME");
  outcomeFacets.forEach((facet, index) => links.push(sealLink(facet.facet_id, mustAt(input.contract.obligations, index).obligation_id, "COVERS")));
  const must = input.contract.obligations.filter((entry) => entry.priority === "MUST");
  for (const facet of facets.filter((entry) => entry.kind === "NEGATIVE_CONSTRAINT" || entry.kind === "NON_GOAL")) {
    for (const obligation of must) links.push(sealLink(facet.facet_id, obligation.obligation_id, "CONSTRAINS"));
  }
  for (const facet of facets.filter((entry) => entry.kind === "UNRESOLVED_AMBIGUITY")) {
    links.push(sealLink(facet.facet_id, null, "UNRESOLVED"));
  }
  const unresolvedFacetIds = facets.filter((entry) => entry.kind === "UNRESOLVED_AMBIGUITY").map((entry) => entry.facet_id);
  const ledgerId = idFromSha256("ACCEPTANCE", canonicalJsonSha256({ contract: input.contract.record_sha256, facets, links }));
  const body = {
    schema_version: 1 as const, ledger_id: ledgerId, goal_id: input.contract.goal_id,
    contract_id: input.contract.contract_id, source_intake_sha256: input.contract.source_intake_sha256,
    source_content_sha256: sha256Hex(source), source_fidelity: sourceFidelity, source_length: source.length,
    facets, links, unresolved_facet_ids: unresolvedFacetIds,
  };
  const record = { ...body, record_sha256: canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-LEDGER-V1", ...body }) };
  assertAcceptanceLedger(record, input.contract);
  return record;
}

export function assertAcceptanceLedger(value: AcceptanceLedgerRecord, contract: GoalContractRecord): void {
  if (value.schema_version !== 1 || value.goal_id !== contract.goal_id || value.contract_id !== contract.contract_id
    || value.source_intake_sha256 !== contract.source_intake_sha256
    || (value.source_fidelity === "EXACT" && value.source_content_sha256 !== value.source_intake_sha256)
    || !["EXACT", "LEGACY_HASH_ONLY"].includes(value.source_fidelity)) {
    throw new TypeError("AcceptanceLedger contract binding is invalid");
  }
  const facetIds = new Set(value.facets.map((entry) => entry.facet_id));
  const obligationIds = new Set(contract.obligations.map((entry) => entry.obligation_id));
  if (facetIds.size !== value.facets.length || value.facets.length === 0 || value.facets[0]?.kind !== "SOURCE_ROOT") {
    throw new TypeError("AcceptanceLedger facets are invalid");
  }
  for (const link of value.links) {
    if (!facetIds.has(link.facet_id) || (link.obligation_id !== null && !obligationIds.has(link.obligation_id))) {
      throw new TypeError("AcceptanceLedger link references an unknown subject");
    }
  }
  const covered = new Set(value.links.filter((entry) => entry.relation === "COVERS" || entry.relation === "CONSTRAINS")
    .map((entry) => entry.obligation_id));
  if (contract.obligations.some((entry) => entry.priority === "MUST" && !covered.has(entry.obligation_id))) {
    throw new TypeError("AcceptanceLedger leaves a MUST obligation without source-bound coverage");
  }
  if (value.unresolved_facet_ids.some((id) => !facetIds.has(id))) throw new TypeError("AcceptanceLedger unresolved facet is unknown");
  const body = omitProperty(value, "record_sha256");
  if (canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-LEDGER-V1", ...body }) !== value.record_sha256) {
    throw new TypeError("AcceptanceLedger record hash mismatch");
  }
}
