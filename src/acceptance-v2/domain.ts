import type { GoalContractRecord } from "../task-flow/domain.js";

export type AcceptanceFacetKindV2 = "OUTCOME" | "INVARIANT" | "QUALITY" | "CONSTRAINT" | "NON_GOAL";
export type AcceptanceSubjectKindV2 = "USER_OUTCOME" | "CONSTRAINT" | "NON_GOAL";
export type FacetObligationRelationV2 = "SATISFIES" | "CONSTRAINS" | "BOUNDS";
export type AcceptanceQualificationBasisV2 = "NATIVE_EXACT" | "LEGACY_REQUALIFIED";
export type EvidenceRequirementKindV2 = "HOST_ORACLE" | "PRESERVATION_REVIEW" | "OPERATION_CLOSURE";

export interface AcceptanceSourceRevisionV2 {
  readonly schema_version: 2;
  readonly source_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly revision: number;
  readonly parent_source_revision_id: string | null;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly encoding: "UTF-8";
  readonly fidelity: "EXACT";
  readonly record_sha256: string;
}

export interface SourceSpanRefV2 {
  readonly schema_version: 2;
  readonly span_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly source_revision_id: string;
  readonly source_sha256: string;
  readonly start_byte: number;
  readonly end_byte_exclusive: number;
  readonly quote_sha256: string;
  readonly record_sha256: string;
}

export interface AcceptanceFacetV2 {
  readonly schema_version: 2;
  readonly facet_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly semantic_key: string;
  readonly kind: AcceptanceFacetKindV2;
  readonly subject: {
    readonly kind: AcceptanceSubjectKindV2;
    readonly index: number;
  };
  readonly semantic_statement: string;
  readonly source_span_ids: readonly string[];
  readonly derivation: "CURRENT_AGENT_TYPED_PROPOSAL";
  readonly record_sha256: string;
}

export interface AcceptanceObligationV2 {
  readonly schema_version: 2;
  readonly acceptance_obligation_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly task_obligation_id: string;
  readonly semantic_key: string;
  readonly priority: "MUST" | "SHOULD" | "MAY";
  readonly statement: string;
  readonly frozen_oracle_sha256: string;
  readonly dependency_ids: readonly string[];
  readonly task_obligation_sha256: string;
  readonly record_sha256: string;
}

export interface FacetObligationBindingV2 {
  readonly schema_version: 2;
  readonly binding_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly facet_id: string;
  readonly acceptance_obligation_id: string;
  readonly relation: FacetObligationRelationV2;
  readonly record_sha256: string;
}

export interface EvidenceRequirementV2 {
  readonly schema_version: 2;
  readonly evidence_requirement_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly binding_id: string;
  readonly requirement_kind: EvidenceRequirementKindV2;
  readonly frozen_oracle_sha256: string;
  readonly required_inputs: readonly (
    "AUTHORIZATION" | "TERMINAL_TRANSITION" | "POSTIMAGE" | "ENVIRONMENT" | "INTEGRATION_SET" | "TOPOLOGY_REVISION"
  )[];
  readonly freshness_policy: "CURRENT_POSTIMAGE";
  readonly execution_owner: "HOST";
  readonly record_sha256: string;
}

export interface AcceptanceAuthorityRootV2 {
  readonly schema_version: 2;
  readonly authority_root_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly contract_sha256: string;
  readonly generation: number;
  readonly qualification_basis: AcceptanceQualificationBasisV2;
  readonly predecessor_authority_head_sha256: string;
  readonly legacy_event_head_sha256: string | null;
  readonly requalification_receipt_sha256: string | null;
  readonly source_revision_id: string;
  readonly source_root_sha256: string;
  readonly span_root_sha256: string;
  readonly facet_root_sha256: string;
  readonly obligation_root_sha256: string;
  readonly binding_root_sha256: string;
  readonly evidence_requirement_root_sha256: string;
  readonly facet_count: number;
  readonly obligation_count: number;
  readonly binding_count: number;
  readonly evidence_requirement_count: number;
  readonly unresolved_material_count: 0;
  readonly record_sha256: string;
}

export interface AcceptanceFacetProposalV2 {
  readonly key: string;
  readonly kind: AcceptanceFacetKindV2;
  readonly subject: {
    readonly kind: AcceptanceSubjectKindV2;
    readonly index: number;
  };
  readonly source_quotes?: readonly {
    readonly quote: string;
    readonly occurrence: number;
  }[];
  readonly source_binding?: "ENTIRE_INTAKE";
  readonly obligation_keys: readonly string[];
}

export interface AcceptanceAuthorityInputV2 {
  readonly predecessor_authority_head_sha256: string;
  readonly qualification_basis: AcceptanceQualificationBasisV2;
  readonly parent_source_revision_id?: string | null;
  readonly legacy_event_head_sha256?: string | null;
  readonly requalification_receipt_sha256?: string | null;
}

export interface AcceptanceBundleV2 {
  readonly source: AcceptanceSourceRevisionV2;
  readonly source_bytes: Uint8Array;
  readonly spans: readonly SourceSpanRefV2[];
  readonly facets: readonly AcceptanceFacetV2[];
  readonly obligations: readonly AcceptanceObligationV2[];
  readonly bindings: readonly FacetObligationBindingV2[];
  readonly evidence_requirements: readonly EvidenceRequirementV2[];
  readonly authority: AcceptanceAuthorityRootV2;
  readonly contract: GoalContractRecord;
}

export interface AcceptanceProjectionV2 {
  readonly source: AcceptanceSourceRevisionV2;
  readonly spans: readonly SourceSpanRefV2[];
  readonly facets: readonly AcceptanceFacetV2[];
  readonly obligations: readonly AcceptanceObligationV2[];
  readonly bindings: readonly FacetObligationBindingV2[];
  readonly evidence_requirements: readonly EvidenceRequirementV2[];
  readonly authority: AcceptanceAuthorityRootV2;
}

export interface OracleExecutionObservationV2 {
  readonly schema_version: 2;
  readonly observation_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly attempt_id: string;
  readonly terminal_transition_id: string;
  readonly terminal_transition_sha256: string;
  readonly observed_postcondition: "PASS" | "FAIL" | "UNKNOWN";
  readonly output_sha256: string;
  readonly record_sha256: string;
}

export interface OraclePassReceiptV2 {
  readonly schema_version: 2;
  readonly pass_receipt_id: string;
  readonly authority_root_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly work_cell_id: string;
  readonly evidence_requirement_id: string;
  readonly attempt_id: string;
  readonly terminal_transition_id: string;
  readonly terminal_transition_sha256: string;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly postimage_root_sha256: string;
  readonly environment_sha256: string;
  readonly integration_root_sha256: string;
  readonly topology_revision_sha256: string;
  readonly observation_root_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly record_sha256: string;
}

export interface AcceptanceEvidenceBindingV2 {
  readonly schema_version: 2;
  readonly evidence_binding_id: string;
  readonly authority_root_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly work_cell_id: string;
  readonly facet_obligation_binding_id: string;
  readonly evidence_requirement_id: string;
  readonly pass_receipt_id: string;
  readonly input_closure_sha256: string;
  readonly witness_root_sha256: string;
  readonly record_sha256: string;
}

export interface WorkCellCompletionReceiptV2 {
  readonly schema_version: 2;
  readonly completion_receipt_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly work_cell_id: string;
  readonly authority_root_id: string;
  readonly revision: number;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly final_postimage_root_sha256: string;
  readonly operation_closure_sha256: string;
  readonly integration_root_sha256: string;
  readonly preservation_review_sha256: string;
  readonly evidence_binding_root_sha256: string;
  readonly obligation_root_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly record_sha256: string;
}

export interface DeliverableManifestV2 {
  readonly schema_version: 2;
  readonly deliverable_manifest_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly route_id: string;
  readonly authority_root_id: string;
  readonly revision: number;
  readonly final_baseline_id: string;
  readonly final_postimage_root_sha256: string;
  readonly completion_root_sha256: string;
  readonly evidence_root_sha256: string;
  readonly artifact_root_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly record_sha256: string;
}
