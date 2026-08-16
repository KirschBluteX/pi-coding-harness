import type { CanonicalJson } from "../authority/canonical-json.js";

export type RequirementKindV2 =
  | "OUTCOME" | "CONSTRAINT" | "NON_GOAL" | "QUALITY"
  | "PERFORMANCE" | "SECURITY" | "RECOVERY" | "UX";
export type RequirementPriorityV2 = "MUST" | "SHOULD" | "MAY";
export type TypedProposalOriginV2 =
  | "CURRENT_AGENT_TYPED_PROPOSAL" | "PROVIDER_TYPED_PROPOSAL" | "WORKER_TYPED_PROPOSAL";
export type DecisionKindV2 = "MATERIAL_UNKNOWN" | "DRAFT_REVIEW" | "ARCHITECTURE" | "ACCEPTANCE" | "RISK";
export type DecisionMaterialityV2 = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DecisionActionV2 = "APPROVE" | "REJECT" | "EDIT" | "DEFER";
export type DecisionAuthorityActorV2 = "USER" | "HOST_DEFAULT";
export type DecisionDueEventPurposeV2 = "DEFAULT_DEADLINE" | "DEFERRED_TRIGGER";
export type DecisionTriggerKindV2 = "IMMEDIATE" | "STAGE_ENTRY" | "EVIDENCE_CHANGE" | "CHANGE_REQUEST";
export type DecisionReversibilityV2 = "REVERSIBLE" | "EXPENSIVE_TO_REVERSE" | "IRREVERSIBLE";
export type GoalFitGateV2 =
  | "CONTRACT_REVIEW" | "CONTRACT_FREEZE" | "PLAN_ENTRY" | "IRREVERSIBLE_ARCHITECTURE"
  | "REPEATED_FAILURE" | "MATERIAL_CHANGE" | "FINAL_CLOSURE";
export type DecisionClosureStateV2 =
  | "APPROVED" | "REJECTED" | "EDITED" | "DEFERRED" | "DUE_DEFERRED" | "UNRESOLVED";
export type GoalFitVerdictV2 = "FIT" | "ASK_USER" | "REFRAME" | "REJECT";
export type GoalFitAssessmentStatusV2 = "PASS" | "ASK_USER" | "REFRAME" | "REJECT" | "NOT_APPLICABLE";
export type GoalFitGateSubjectKindV2 =
  | "REQUIREMENT_REVISION" | "PLAN_REVISION" | "CHANGE_ACCEPTANCE_CLOSURE"
  | "FAILURE_RECEIPT" | "DELIVERABLE_MANIFEST";

export interface RequirementItemProposalV2 {
  readonly key: string;
  readonly kind: RequirementKindV2;
  readonly priority: RequirementPriorityV2;
  readonly statement: string;
  readonly acceptance_facet_ids: readonly string[];
  readonly source_span_ids: readonly string[];
}

export interface RequirementRevisionV2 {
  readonly schema_version: 2;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly source_revision_id: string;
  readonly revision: number;
  readonly contract_revision: number;
  readonly parent_requirement_revision_id: string | null;
  readonly parent_requirement_revision_sha256: string | null;
  readonly proposal_origin: TypedProposalOriginV2;
  readonly source_root_sha256: string;
  readonly span_root_sha256: string;
  readonly facet_root_sha256: string;
  readonly requirements_root_sha256: string;
  readonly input_closure_sha256: string;
  readonly item_count: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface RequirementItemV2 {
  readonly schema_version: 2;
  readonly requirement_item_revision_id: string;
  readonly requirement_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly semantic_key: string;
  readonly kind: RequirementKindV2;
  readonly priority: RequirementPriorityV2;
  readonly statement: string;
  readonly acceptance_facet_ids: readonly string[];
  readonly source_span_ids: readonly string[];
  readonly trace_root_sha256: string;
  readonly record_sha256: string;
}

export interface RequirementRevisionClosureV2 {
  readonly revision: RequirementRevisionV2;
  readonly items: readonly RequirementItemV2[];
}

export interface DecisionDefaultV2 {
  readonly action: "APPROVE" | "REJECT";
  readonly value: CanonicalJson;
}

export interface DecisionRequirementProposalV2 {
  readonly key: string;
  readonly kind: DecisionKindV2;
  readonly question: string;
  readonly materiality: DecisionMaterialityV2;
  readonly blocking: boolean;
  readonly affected_requirement_keys: readonly string[];
  readonly source_span_ids: readonly string[];
  readonly trigger: {
    readonly kind: DecisionTriggerKindV2;
    readonly evidence_sha256: string;
  };
  readonly latest_resolution_stage: GoalFitGateV2;
  readonly default: DecisionDefaultV2;
  readonly reversibility: DecisionReversibilityV2;
  readonly affected_work_cell_ids: readonly string[];
  readonly proposal_origin: TypedProposalOriginV2;
}

export interface DecisionRequirementV2 {
  readonly schema_version: 2;
  readonly decision_requirement_revision_id: string;
  readonly decision_requirement_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_key: string;
  readonly kind: DecisionKindV2;
  readonly question: string;
  readonly materiality: DecisionMaterialityV2;
  readonly blocking: boolean;
  readonly affected_requirement_ids: readonly string[];
  readonly source_span_ids: readonly string[];
  readonly trigger_kind: DecisionTriggerKindV2;
  readonly trigger_sha256: string;
  readonly latest_resolution_stage: GoalFitGateV2;
  readonly default_action: "APPROVE" | "REJECT";
  readonly default_value: CanonicalJson;
  readonly default_sha256: string;
  readonly reversibility: DecisionReversibilityV2;
  readonly affected_work_cell_ids: readonly string[];
  readonly proposal_origin: TypedProposalOriginV2;
  readonly record_sha256: string;
}

export interface DecisionResolutionV2 {
  readonly schema_version: 2;
  readonly decision_resolution_id: string;
  readonly decision_requirement_revision_id: string;
  readonly decision_requirement_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly resolution_revision: number;
  readonly parent_resolution_id: string | null;
  readonly action: DecisionActionV2;
  readonly authority_actor: DecisionAuthorityActorV2;
  readonly at_stage: GoalFitGateV2;
  readonly decision_frontier_sha256: string;
  readonly action_payload_sha256: string;
  readonly authority_input_receipt_id: string;
  readonly due_event_receipt_id: string | null;
  readonly resolution_input_sha256: string;
  readonly authority_source_span_id: string | null;
  readonly selected_value: CanonicalJson;
  readonly selected_value_sha256: string;
  readonly edited_requirement_revision_id: string | null;
  readonly deferred_trigger_sha256: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface DecisionAuthorityInputReceiptV2 {
  readonly schema_version: 2;
  readonly authority_input_receipt_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_requirement_revision_id: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly decision_frontier_sha256: string;
  readonly action: DecisionActionV2;
  readonly action_payload_sha256: string;
  readonly at_gate: GoalFitGateV2;
  readonly authority_actor: DecisionAuthorityActorV2;
  readonly source_kind: "USER_TURN" | "HOST_DEFAULT_DUE";
  readonly session_id: string | null;
  readonly turn_id: string | null;
  readonly event_head_sha256: string;
  readonly due_event_receipt_id: string | null;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly encoding: "UTF-8";
  readonly fidelity: "EXACT";
  readonly captured_by: "HOST";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface DecisionAuthorityInputBundleV2 {
  readonly receipt: DecisionAuthorityInputReceiptV2;
  readonly source_bytes: Uint8Array;
}

export interface DecisionDueEventReceiptV2 {
  readonly schema_version: 2;
  readonly due_event_receipt_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_requirement_revision_id: string;
  readonly requirement_revision_id: string;
  readonly requirement_revision_sha256: string;
  readonly purpose: DecisionDueEventPurposeV2;
  readonly trigger_kind: Exclude<DecisionTriggerKindV2, "IMMEDIATE">;
  readonly trigger_sha256: string;
  readonly at_gate: GoalFitGateV2;
  readonly event_evidence_sha256: string;
  readonly event_head_sha256: string;
  readonly predecessor_resolution_sha256: string;
  readonly captured_by: "HOST";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface DecisionClosureMemberV2 {
  readonly decision_requirement_revision_id: string;
  readonly decision_requirement_id: string;
  readonly decision_resolution_id: string | null;
  readonly state: DecisionClosureStateV2;
}

export interface DecisionClosureV2 {
  readonly schema_version: 2;
  readonly decision_closure_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly gate: GoalFitGateV2;
  readonly decision_root_sha256: string;
  readonly resolution_root_sha256: string;
  readonly member_root_sha256: string;
  readonly unresolved_decision_ids: readonly string[];
  readonly rejected_decision_ids: readonly string[];
  readonly edited_decision_ids: readonly string[];
  readonly deferred_decision_ids: readonly string[];
  readonly due_deferred_decision_ids: readonly string[];
  readonly draft_review_approved: boolean;
  readonly qualified: boolean;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface DecisionClosureBundleV2 {
  readonly closure: DecisionClosureV2;
  readonly members: readonly DecisionClosureMemberV2[];
}

export interface GoalFitAssessmentFacetV2 {
  readonly status: GoalFitAssessmentStatusV2;
  readonly reason_codes: readonly string[];
  readonly subject_ids: readonly string[];
  readonly evidence_receipt_sha256s: readonly string[];
}

export type GoalFitFindingCoverageV2 = "ALL_CURRENT" | "NOT_APPLICABLE";

export interface GoalFitFindingFacetProposalV2 {
  readonly status: GoalFitAssessmentStatusV2;
  readonly reason_codes: readonly string[];
  readonly coverage: GoalFitFindingCoverageV2;
}

export interface GoalFitAssessmentProposalV2 {
  readonly proposal_origin: TypedProposalOriginV2;
  readonly outcome_fidelity: GoalFitFindingFacetProposalV2;
  readonly obligation_coverage: GoalFitFindingFacetProposalV2;
  readonly unnecessary_design: GoalFitFindingFacetProposalV2;
  readonly current_decisions: GoalFitFindingFacetProposalV2;
  readonly invalidations: GoalFitFindingFacetProposalV2;
  readonly gate_specific_evidence: GoalFitFindingFacetProposalV2;
}

export interface GoalFitGateInstanceReceiptV2 {
  readonly schema_version: 2;
  readonly gate_instance_receipt_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly gate: GoalFitGateV2;
  readonly gate_subject_kind: GoalFitGateSubjectKindV2;
  readonly gate_subject_id: string;
  readonly gate_subject_sha256: string;
  readonly requirement_revision_sha256: string;
  readonly decision_closure_sha256: string;
  readonly host_evidence_sha256s: readonly string[];
  readonly host_evidence_root_sha256: string;
  readonly event_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface GoalFitAssessmentV2 {
  readonly schema_version: 2;
  readonly goal_fit_assessment_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly gate: GoalFitGateV2;
  readonly gate_instance_receipt_id: string;
  readonly gate_instance_receipt_sha256: string;
  readonly proposal_origin: TypedProposalOriginV2;
  readonly outcome_fidelity: GoalFitAssessmentFacetV2;
  readonly obligation_coverage: GoalFitAssessmentFacetV2;
  readonly unnecessary_design: GoalFitAssessmentFacetV2;
  readonly current_decisions: GoalFitAssessmentFacetV2;
  readonly invalidations: GoalFitAssessmentFacetV2;
  readonly gate_specific_evidence: GoalFitAssessmentFacetV2;
  readonly plan_revision_sha256: string | null;
  readonly decision_plan_binding_root_sha256: string | null;
  readonly change_acceptance_closure_sha256: string | null;
  readonly invalidation_root_sha256: string | null;
  readonly oracle_evidence_root_sha256: string | null;
  readonly source_root_sha256: string;
  readonly requirement_root_sha256: string;
  readonly decision_closure_sha256: string;
  readonly input_closure_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface GoalFitReviewV2 {
  readonly schema_version: 2;
  readonly goal_fit_review_id: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly gate: GoalFitGateV2;
  readonly verdict: GoalFitVerdictV2;
  readonly review_owner: "HOST";
  readonly reason_codes: readonly string[];
  readonly source_root_sha256: string;
  readonly requirement_root_sha256: string;
  readonly decision_closure_sha256: string;
  readonly input_closure_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface GoalFitReviewAssessmentBindingV2 {
  readonly schema_version: 2;
  readonly goal_fit_review_id: string;
  readonly goal_fit_review_sha256: string;
  readonly goal_fit_assessment_id: string;
  readonly goal_fit_assessment_sha256: string;
  readonly gate_instance_receipt_id: string;
  readonly gate_instance_receipt_sha256: string;
  readonly requirement_revision_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly decision_closure_id: string;
  readonly gate: GoalFitGateV2;
  readonly derived_verdict: GoalFitVerdictV2;
  readonly derived_reason_codes: readonly string[];
  readonly derived_reason_code_root_sha256: string;
  readonly qualification_status: "CURRENT_ASSESSED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface AssessedGoalFitReviewBundleV2 {
  readonly gate_instance: GoalFitGateInstanceReceiptV2;
  readonly assessment: GoalFitAssessmentV2;
  readonly review: GoalFitReviewV2;
  readonly binding: GoalFitReviewAssessmentBindingV2;
}

export interface ContractFreezeReceiptV2 {
  readonly schema_version: 2;
  readonly contract_freeze_receipt_id: string;
  readonly goal_id: string;
  readonly contract_id: string;
  readonly authority_root_id: string;
  readonly requirement_revision_id: string;
  readonly decision_closure_id: string;
  readonly goal_fit_review_id: string;
  readonly generation: number;
  readonly predecessor_freeze_sha256: string;
  readonly contract_sha256: string;
  readonly source_root_sha256: string;
  readonly facet_root_sha256: string;
  readonly requirement_root_sha256: string;
  readonly decision_root_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface IntakeAuthorityProjectionV2 {
  readonly requirement: RequirementRevisionClosureV2;
  readonly decisions: readonly DecisionRequirementV2[];
  readonly authority_inputs: readonly DecisionAuthorityInputReceiptV2[];
  readonly due_events: readonly DecisionDueEventReceiptV2[];
  readonly resolutions: readonly DecisionResolutionV2[];
  readonly decision_closure: DecisionClosureBundleV2 | null;
  readonly goal_fit_review: GoalFitReviewV2 | null;
  readonly contract_freeze: ContractFreezeReceiptV2 | null;
  readonly projection_sha256: string;
}
