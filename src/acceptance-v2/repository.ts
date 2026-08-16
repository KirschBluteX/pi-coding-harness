import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import type { GoalContractRecord } from "../task-flow/domain.js";
import { assertGoalContract } from "../task-flow/domain.js";
import type {
  AcceptanceAuthorityRootV2,
  AcceptanceBundleV2,
  AcceptanceFacetV2,
  AcceptanceObligationV2,
  AcceptanceProjectionV2,
  AcceptanceSourceRevisionV2,
  EvidenceRequirementV2,
  FacetObligationBindingV2,
  SourceSpanRefV2,
} from "./domain.js";
import { acceptanceProjectionV2, assertAcceptanceBundleV2 } from "./finalize.js";

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Acceptance V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Acceptance V2 ${key} is invalid`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function jsonArray<T>(row: Record<string, unknown>, key: string): readonly T[] {
  try {
    const value = JSON.parse(text(row, key)) as unknown;
    if (!Array.isArray(value)) throw new TypeError();
    return value as readonly T[];
  } catch (error) {
    throw new AuthorityIntegrityError(`Acceptance V2 ${key} is invalid JSON`, error);
  }
}

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
    count?: unknown;
  } | undefined;
  return Number(row?.count ?? 0) === 1;
}

interface AuthorityMemberSpec {
  readonly label: string;
  readonly table: string;
  readonly idColumn: string;
  readonly entityTable: string;
  readonly orderColumn: string;
  readonly countColumn: "facet_count" | "obligation_count" | "binding_count" | "evidence_requirement_count" | null;
}

const authorityMemberSpecs = {
  spans: {
    label: "span", table: "acceptance_authority_span_members_v2", idColumn: "span_id",
    entityTable: "acceptance_source_spans_v2", orderColumn: "span_id", countColumn: null,
  },
  facets: {
    label: "facet", table: "acceptance_authority_facet_members_v2", idColumn: "facet_id",
    entityTable: "acceptance_facets_v2", orderColumn: "semantic_key", countColumn: "facet_count",
  },
  obligations: {
    label: "obligation", table: "acceptance_authority_obligation_members_v2", idColumn: "acceptance_obligation_id",
    entityTable: "acceptance_obligations_v2", orderColumn: "acceptance_obligation_id", countColumn: "obligation_count",
  },
  bindings: {
    label: "binding", table: "acceptance_authority_binding_members_v2", idColumn: "binding_id",
    entityTable: "facet_obligation_bindings_v2", orderColumn: "binding_id", countColumn: "binding_count",
  },
  requirements: {
    label: "requirement", table: "acceptance_authority_requirement_members_v2", idColumn: "evidence_requirement_id",
    entityTable: "evidence_requirements_v2", orderColumn: "evidence_requirement_id", countColumn: "evidence_requirement_count",
  },
} as const satisfies Record<string, AuthorityMemberSpec>;

function authorityMemberIds(
  connection: AuthorityConnection,
  root: Record<string, unknown>,
  spec: AuthorityMemberSpec,
): readonly string[] {
  const authorityRootId = text(root, "authority_root_id");
  const goalId = text(root, "goal_id");
  const contractId = text(root, "contract_id");
  const rows = connection.prepare(`SELECT ${spec.idColumn},goal_id,contract_id,ordinal
    FROM ${spec.table} WHERE authority_root_id=? ORDER BY ordinal`).all(authorityRootId) as Record<string, unknown>[];
  const ids = rows.map((row, ordinal) => {
    if (integer(row, "ordinal") !== ordinal || text(row, "goal_id") !== goalId
      || text(row, "contract_id") !== contractId) {
      throw new AuthorityIntegrityError(`Acceptance V2 authority ${spec.label} members are invalid`);
    }
    return text(row, spec.idColumn);
  });
  if (new Set(ids).size !== ids.length) {
    throw new AuthorityIntegrityError(`Acceptance V2 authority ${spec.label} members are invalid`);
  }
  const canonicalIds = (connection.prepare(
    `SELECT ${spec.idColumn} id FROM ${spec.entityTable} WHERE goal_id=? AND contract_id=?
      ORDER BY ${spec.orderColumn},${spec.idColumn}`,
  ).all(goalId, contractId) as Record<string, unknown>[]).map((row) => text(row, "id"));
  if (ids.some((id, index) => id !== canonicalIds[index])) {
    throw new AuthorityIntegrityError(`Acceptance V2 authority ${spec.label} members are not in canonical ordinal order`);
  }
  const entityCount = connection.prepare(
    `SELECT count(*) count FROM ${spec.entityTable} WHERE goal_id=? AND contract_id=?`,
  ).get(goalId, contractId) as Record<string, unknown> | undefined;
  if (integer(entityCount ?? {}, "count") !== ids.length
    || (spec.countColumn !== null && integer(root, spec.countColumn) !== ids.length)) {
    throw new AuthorityIntegrityError(`Acceptance V2 authority ${spec.label} members do not match the sealed root`);
  }
  return ids;
}

function placeholders(count: number): string {
  if (count < 1) throw new AuthorityIntegrityError("Acceptance V2 authority has an empty required member set");
  return Array.from({ length: count }, () => "?").join(",");
}

export class AcceptanceAuthorityV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "acceptance_authority_roots_v2");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Authority/Acceptance migration 020 is not available");
  }

  insert(bundle: AcceptanceBundleV2, eventSequence: number): boolean {
    this.assertAvailable();
    if (!this.connection.isTransaction) {
      throw new AuthorityIntegrityError("Acceptance V2 authority must be recorded inside the authority transaction");
    }
    assertAcceptanceBundleV2(bundle);
    const existing = this.connection.prepare(
      "SELECT record_sha256 FROM acceptance_authority_roots_v2 WHERE contract_id=?",
    ).get(bundle.contract.contract_id) as { record_sha256?: unknown } | undefined;
    if (existing) {
      if (existing.record_sha256 !== bundle.authority.record_sha256) {
        throw new AuthorityIntegrityError("Acceptance V2 authority root substitution");
      }
      const restored = this.readBundle(bundle.contract.contract_id);
      if (!restored || restored.authority.record_sha256 !== bundle.authority.record_sha256) {
        throw new AuthorityIntegrityError("Acceptance V2 authority root cannot be reconstructed");
      }
      return true;
    }

    this.connection.prepare(`INSERT INTO acceptance_source_revisions_v2(
      source_revision_id,goal_id,contract_id,revision,parent_source_revision_id,source_bytes,
      content_sha256,byte_length,encoding,fidelity,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      bundle.source.source_revision_id,
      bundle.source.goal_id,
      bundle.source.contract_id,
      bundle.source.revision,
      bundle.source.parent_source_revision_id,
      Buffer.from(bundle.source_bytes),
      bundle.source.content_sha256,
      bundle.source.byte_length,
      bundle.source.encoding,
      bundle.source.fidelity,
      bundle.source.record_sha256,
      eventSequence,
    );

    const insertSpan = this.connection.prepare(`INSERT INTO acceptance_source_spans_v2(
      span_id,goal_id,contract_id,source_revision_id,source_sha256,start_byte,end_byte_exclusive,
      quote_bytes,quote_sha256,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const span of bundle.spans) insertSpan.run(
      span.span_id,
      span.goal_id,
      span.contract_id,
      span.source_revision_id,
      span.source_sha256,
      span.start_byte,
      span.end_byte_exclusive,
      Buffer.from(bundle.source_bytes.subarray(span.start_byte, span.end_byte_exclusive)),
      span.quote_sha256,
      span.record_sha256,
      eventSequence,
    );

    const insertFacet = this.connection.prepare(`INSERT INTO acceptance_facets_v2(
      facet_id,goal_id,contract_id,semantic_key,kind,subject_kind,subject_index,
      semantic_statement,derivation,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFacetSpan = this.connection.prepare(`INSERT INTO acceptance_facet_span_members_v2(
      facet_id,span_id,goal_id,contract_id,source_revision_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?)`);
    for (const facet of bundle.facets) {
      insertFacet.run(
        facet.facet_id,
        facet.goal_id,
        facet.contract_id,
        facet.semantic_key,
        facet.kind,
        facet.subject.kind,
        facet.subject.index,
        facet.semantic_statement,
        facet.derivation,
        facet.record_sha256,
        eventSequence,
      );
      facet.source_span_ids.forEach((spanId, ordinal) => insertFacetSpan.run(
        facet.facet_id,
        spanId,
        facet.goal_id,
        facet.contract_id,
        bundle.source.source_revision_id,
        ordinal,
        eventSequence,
      ));
    }

    const insertObligation = this.connection.prepare(`INSERT INTO acceptance_obligations_v2(
      acceptance_obligation_id,goal_id,contract_id,task_obligation_id,semantic_key,priority,
      statement,frozen_oracle_sha256,dependency_ids_json,dependency_root_sha256,
      task_obligation_sha256,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const obligation of bundle.obligations) insertObligation.run(
      obligation.acceptance_obligation_id,
      obligation.goal_id,
      obligation.contract_id,
      obligation.task_obligation_id,
      obligation.semantic_key,
      obligation.priority,
      obligation.statement,
      obligation.frozen_oracle_sha256,
      canonicalJson(obligation.dependency_ids),
      canonicalJsonSha256(obligation.dependency_ids),
      obligation.task_obligation_sha256,
      obligation.record_sha256,
      eventSequence,
    );

    const insertBinding = this.connection.prepare(`INSERT INTO facet_obligation_bindings_v2(
      binding_id,goal_id,contract_id,facet_id,acceptance_obligation_id,relation,
      record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    for (const binding of bundle.bindings) insertBinding.run(
      binding.binding_id,
      binding.goal_id,
      binding.contract_id,
      binding.facet_id,
      binding.acceptance_obligation_id,
      binding.relation,
      binding.record_sha256,
      eventSequence,
    );

    const insertRequirement = this.connection.prepare(`INSERT INTO evidence_requirements_v2(
      evidence_requirement_id,goal_id,contract_id,binding_id,requirement_kind,frozen_oracle_sha256,
      required_inputs_json,required_inputs_sha256,freshness_policy,execution_owner,
      record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const requirement of bundle.evidence_requirements) insertRequirement.run(
      requirement.evidence_requirement_id,
      requirement.goal_id,
      requirement.contract_id,
      requirement.binding_id,
      requirement.requirement_kind,
      requirement.frozen_oracle_sha256,
      canonicalJson(requirement.required_inputs),
      canonicalJsonSha256(requirement.required_inputs),
      requirement.freshness_policy,
      requirement.execution_owner,
      requirement.record_sha256,
      eventSequence,
    );

    const root = bundle.authority;
    this.connection.prepare(`INSERT INTO acceptance_authority_roots_v2(
      authority_root_id,goal_id,contract_id,contract_sha256,generation,qualification_basis,
      predecessor_authority_head_sha256,legacy_event_head_sha256,requalification_receipt_sha256,
      source_revision_id,source_root_sha256,span_root_sha256,facet_root_sha256,obligation_root_sha256,
      binding_root_sha256,evidence_requirement_root_sha256,facet_count,obligation_count,binding_count,
      evidence_requirement_count,unresolved_material_count,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      root.authority_root_id,
      root.goal_id,
      root.contract_id,
      root.contract_sha256,
      root.generation,
      root.qualification_basis,
      root.predecessor_authority_head_sha256,
      root.legacy_event_head_sha256,
      root.requalification_receipt_sha256,
      root.source_revision_id,
      root.source_root_sha256,
      root.span_root_sha256,
      root.facet_root_sha256,
      root.obligation_root_sha256,
      root.binding_root_sha256,
      root.evidence_requirement_root_sha256,
      root.facet_count,
      root.obligation_count,
      root.binding_count,
      root.evidence_requirement_count,
      root.unresolved_material_count,
      root.record_sha256,
      eventSequence,
    );

    const members = [
      ["acceptance_authority_span_members_v2", "span_id", bundle.spans.map((entry) => entry.span_id)],
      ["acceptance_authority_facet_members_v2", "facet_id", bundle.facets.map((entry) => entry.facet_id)],
      ["acceptance_authority_obligation_members_v2", "acceptance_obligation_id", bundle.obligations.map((entry) => entry.acceptance_obligation_id)],
      ["acceptance_authority_binding_members_v2", "binding_id", bundle.bindings.map((entry) => entry.binding_id)],
      ["acceptance_authority_requirement_members_v2", "evidence_requirement_id", bundle.evidence_requirements.map((entry) => entry.evidence_requirement_id)],
    ] as const;
    for (const [table, idColumn, ids] of members) {
      const insertMember = this.connection.prepare(`INSERT INTO ${table}(
        authority_root_id,${idColumn},goal_id,contract_id,ordinal,created_event_sequence
      ) VALUES(?,?,?,?,?,?)`);
      ids.forEach((id, ordinal) => insertMember.run(
        root.authority_root_id,
        id,
        root.goal_id,
        root.contract_id,
        ordinal,
        eventSequence,
      ));
    }
    return false;
  }

  read(contractId: string): AcceptanceProjectionV2 | null {
    const bundle = this.readBundle(contractId);
    return bundle ? acceptanceProjectionV2(bundle) : null;
  }

  readBundle(contractId: string): AcceptanceBundleV2 | null {
    this.assertAvailable();
    const rootRow = this.connection.prepare("SELECT * FROM acceptance_authority_roots_v2 WHERE contract_id=?")
      .get(contractId) as Record<string, unknown> | undefined;
    if (!rootRow) return null;
    const spanIds = authorityMemberIds(this.connection, rootRow, authorityMemberSpecs.spans);
    const facetIds = authorityMemberIds(this.connection, rootRow, authorityMemberSpecs.facets);
    const obligationIds = authorityMemberIds(this.connection, rootRow, authorityMemberSpecs.obligations);
    const bindingIds = authorityMemberIds(this.connection, rootRow, authorityMemberSpecs.bindings);
    const requirementIds = authorityMemberIds(this.connection, rootRow, authorityMemberSpecs.requirements);
    const contractRow = this.connection.prepare("SELECT contract_json FROM goal_contract_versions_v1 WHERE contract_id=?")
      .get(contractId) as Record<string, unknown> | undefined;
    if (!contractRow) throw new AuthorityIntegrityError("Acceptance V2 contract is missing");
    const contract = JSON.parse(text(contractRow, "contract_json")) as GoalContractRecord;
    assertGoalContract(contract);
    const sourceRow = this.connection.prepare("SELECT * FROM acceptance_source_revisions_v2 WHERE contract_id=?")
      .get(contractId) as Record<string, unknown> | undefined;
    if (!sourceRow || !(sourceRow.source_bytes instanceof Uint8Array)) {
      throw new AuthorityIntegrityError("Acceptance V2 exact source is missing");
    }
    const sourceBytes = Buffer.from(sourceRow.source_bytes);
    const source: AcceptanceSourceRevisionV2 = {
      schema_version: 2,
      source_revision_id: text(sourceRow, "source_revision_id"),
      goal_id: text(sourceRow, "goal_id"),
      contract_id: text(sourceRow, "contract_id"),
      revision: integer(sourceRow, "revision"),
      parent_source_revision_id: nullableText(sourceRow, "parent_source_revision_id"),
      content_sha256: text(sourceRow, "content_sha256"),
      byte_length: integer(sourceRow, "byte_length"),
      encoding: text(sourceRow, "encoding") as "UTF-8",
      fidelity: text(sourceRow, "fidelity") as "EXACT",
      record_sha256: text(sourceRow, "record_sha256"),
    };
    const spansById = new Map((this.connection.prepare(
      `SELECT * FROM acceptance_source_spans_v2 WHERE span_id IN (${placeholders(spanIds.length)})`,
    ).all(...spanIds) as Record<string, unknown>[]).map((row) => [text(row, "span_id"), row]));
    const spans = spanIds.map((spanId): SourceSpanRefV2 => {
      const row = spansById.get(spanId);
      if (!row) throw new AuthorityIntegrityError("Acceptance V2 authority span member is missing");
      if (!(row.quote_bytes instanceof Uint8Array)) {
        throw new AuthorityIntegrityError("Acceptance V2 stored quote bytes are missing");
      }
      const startByte = integer(row, "start_byte");
      const endByteExclusive = integer(row, "end_byte_exclusive");
      if (!Buffer.from(row.quote_bytes).equals(sourceBytes.subarray(startByte, endByteExclusive))) {
        throw new AuthorityIntegrityError("Acceptance V2 stored quote bytes differ from the exact source slice");
      }
      return ({
      schema_version: 2,
      span_id: text(row, "span_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      source_revision_id: text(row, "source_revision_id"),
      source_sha256: text(row, "source_sha256"),
      start_byte: startByte,
      end_byte_exclusive: endByteExclusive,
      quote_sha256: text(row, "quote_sha256"),
      record_sha256: text(row, "record_sha256"),
      });
    });
    const facetsById = new Map((this.connection.prepare(
      `SELECT * FROM acceptance_facets_v2 WHERE facet_id IN (${placeholders(facetIds.length)})`,
    ).all(...facetIds) as Record<string, unknown>[]).map((row) => [text(row, "facet_id"), row]));
    const facets = facetIds.map((facetId): AcceptanceFacetV2 => {
      const row = facetsById.get(facetId);
      if (!row) throw new AuthorityIntegrityError("Acceptance V2 authority facet member is missing");
      return ({
      schema_version: 2,
      facet_id: text(row, "facet_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      semantic_key: text(row, "semantic_key"),
      kind: text(row, "kind") as AcceptanceFacetV2["kind"],
      subject: {
        kind: text(row, "subject_kind") as AcceptanceFacetV2["subject"]["kind"],
        index: integer(row, "subject_index"),
      },
      semantic_statement: text(row, "semantic_statement"),
      source_span_ids: (this.connection.prepare(
        "SELECT span_id,ordinal FROM acceptance_facet_span_members_v2 WHERE facet_id=? ORDER BY ordinal",
      ).all(text(row, "facet_id")) as Record<string, unknown>[]).map((member, ordinal) => {
        if (integer(member, "ordinal") !== ordinal) {
          throw new AuthorityIntegrityError("Acceptance V2 facet span members have an ordinal gap");
        }
        return text(member, "span_id");
      }),
      derivation: text(row, "derivation") as "CURRENT_AGENT_TYPED_PROPOSAL",
      record_sha256: text(row, "record_sha256"),
      });
    });
    const obligationsById = new Map((this.connection.prepare(
      `SELECT * FROM acceptance_obligations_v2 WHERE acceptance_obligation_id IN (${placeholders(obligationIds.length)})`,
    ).all(...obligationIds) as Record<string, unknown>[]).map((row) => [text(row, "acceptance_obligation_id"), row]));
    const obligations = obligationIds.map((obligationId): AcceptanceObligationV2 => {
      const row = obligationsById.get(obligationId);
      if (!row) throw new AuthorityIntegrityError("Acceptance V2 authority obligation member is missing");
      const dependencyIds = jsonArray<string>(row, "dependency_ids_json");
      if (text(row, "dependency_root_sha256") !== canonicalJsonSha256(dependencyIds)) {
        throw new AuthorityIntegrityError("Acceptance V2 obligation dependency root mismatch");
      }
      return ({
      schema_version: 2,
      acceptance_obligation_id: text(row, "acceptance_obligation_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      task_obligation_id: text(row, "task_obligation_id"),
      semantic_key: text(row, "semantic_key"),
      priority: text(row, "priority") as AcceptanceObligationV2["priority"],
      statement: text(row, "statement"),
      frozen_oracle_sha256: text(row, "frozen_oracle_sha256"),
      dependency_ids: dependencyIds,
      task_obligation_sha256: text(row, "task_obligation_sha256"),
      record_sha256: text(row, "record_sha256"),
      });
    });
    const bindingsById = new Map((this.connection.prepare(
      `SELECT * FROM facet_obligation_bindings_v2 WHERE binding_id IN (${placeholders(bindingIds.length)})`,
    ).all(...bindingIds) as Record<string, unknown>[]).map((row) => [text(row, "binding_id"), row]));
    const bindings = bindingIds.map((bindingId): FacetObligationBindingV2 => {
      const row = bindingsById.get(bindingId);
      if (!row) throw new AuthorityIntegrityError("Acceptance V2 authority binding member is missing");
      return ({
      schema_version: 2,
      binding_id: text(row, "binding_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      facet_id: text(row, "facet_id"),
      acceptance_obligation_id: text(row, "acceptance_obligation_id"),
      relation: text(row, "relation") as FacetObligationBindingV2["relation"],
      record_sha256: text(row, "record_sha256"),
      });
    });
    const requirementsById = new Map((this.connection.prepare(
      `SELECT * FROM evidence_requirements_v2 WHERE evidence_requirement_id IN (${placeholders(requirementIds.length)})`,
    ).all(...requirementIds) as Record<string, unknown>[]).map((row) => [text(row, "evidence_requirement_id"), row]));
    const requirements = requirementIds.map((requirementId): EvidenceRequirementV2 => {
      const row = requirementsById.get(requirementId);
      if (!row) throw new AuthorityIntegrityError("Acceptance V2 authority requirement member is missing");
      const requiredInputs = jsonArray<EvidenceRequirementV2["required_inputs"][number]>(row, "required_inputs_json");
      if (text(row, "required_inputs_sha256") !== canonicalJsonSha256(requiredInputs)) {
        throw new AuthorityIntegrityError("Acceptance V2 evidence required-input root mismatch");
      }
      return ({
      schema_version: 2,
      evidence_requirement_id: text(row, "evidence_requirement_id"),
      goal_id: text(row, "goal_id"),
      contract_id: text(row, "contract_id"),
      binding_id: text(row, "binding_id"),
      requirement_kind: text(row, "requirement_kind") as EvidenceRequirementV2["requirement_kind"],
      frozen_oracle_sha256: text(row, "frozen_oracle_sha256"),
      required_inputs: requiredInputs,
      freshness_policy: text(row, "freshness_policy") as "CURRENT_POSTIMAGE",
      execution_owner: text(row, "execution_owner") as "HOST",
      record_sha256: text(row, "record_sha256"),
      });
    });
    const authority: AcceptanceAuthorityRootV2 = {
      schema_version: 2,
      authority_root_id: text(rootRow, "authority_root_id"),
      goal_id: text(rootRow, "goal_id"),
      contract_id: text(rootRow, "contract_id"),
      contract_sha256: text(rootRow, "contract_sha256"),
      generation: integer(rootRow, "generation"),
      qualification_basis: text(rootRow, "qualification_basis") as AcceptanceAuthorityRootV2["qualification_basis"],
      predecessor_authority_head_sha256: text(rootRow, "predecessor_authority_head_sha256"),
      legacy_event_head_sha256: nullableText(rootRow, "legacy_event_head_sha256"),
      requalification_receipt_sha256: nullableText(rootRow, "requalification_receipt_sha256"),
      source_revision_id: text(rootRow, "source_revision_id"),
      source_root_sha256: text(rootRow, "source_root_sha256"),
      span_root_sha256: text(rootRow, "span_root_sha256"),
      facet_root_sha256: text(rootRow, "facet_root_sha256"),
      obligation_root_sha256: text(rootRow, "obligation_root_sha256"),
      binding_root_sha256: text(rootRow, "binding_root_sha256"),
      evidence_requirement_root_sha256: text(rootRow, "evidence_requirement_root_sha256"),
      facet_count: integer(rootRow, "facet_count"),
      obligation_count: integer(rootRow, "obligation_count"),
      binding_count: integer(rootRow, "binding_count"),
      evidence_requirement_count: integer(rootRow, "evidence_requirement_count"),
      unresolved_material_count: integer(rootRow, "unresolved_material_count") as 0,
      record_sha256: text(rootRow, "record_sha256"),
    };
    const bundle: AcceptanceBundleV2 = {
      source,
      source_bytes: sourceBytes,
      spans,
      facets,
      obligations,
      bindings,
      evidence_requirements: requirements,
      authority,
      contract,
    };
    assertAcceptanceBundleV2(bundle);
    return bundle;
  }

  verifyIntegrity(): { readonly authorityRoots: number } {
    if (!this.available()) return { authorityRoots: 0 };
    const contracts = this.connection.prepare(
      "SELECT contract_id FROM acceptance_authority_roots_v2 ORDER BY contract_id",
    ).all() as Record<string, unknown>[];
    for (const row of contracts) this.readBundle(text(row, "contract_id"));
    return { authorityRoots: contracts.length };
  }
}
