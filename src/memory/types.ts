import type { CommandResult, MutationMeta } from "../authority/transactions.js";

export type MemoryMode = "OFF" | "EXPLICIT_ONLY" | "VERIFIED_JIT" | "EXPERIMENTAL";
export type MemoryChannel = "POLICY" | "EVIDENCE" | "EXPERIENCE";
export type MemoryScope = "GOAL" | "WORKSPACE";
export type MemoryClaimStatus = "PROPOSED" | "ACTIVE";
export type MemoryClassification = "PUBLIC" | "INTERNAL";
export type MemoryIndexMode = "DISABLED" | "TAG_PATH" | "FTS5" | "ERROR";
export type MemorySourceKind = "USER_EXPLICIT" | "PROJECT_FILE" | "AUTHORITY_RECEIPT";
export type SourceResolverKind = "USER_INPUT" | "PROJECT_FILE" | "AUTHORITY_RECEIPT";

export interface TypedPolicy {
  readonly type: "TYPED_POLICY";
  readonly policyKind: "PREFERENCE" | "WORKSPACE_RULE" | "CONSTRAINT";
  readonly statement: string;
  readonly appliesTo: readonly string[];
  readonly semanticKey?: string;
  readonly operator?: "PREFER" | "AVOID" | "REQUIRE" | "FORBID" | "SET";
  readonly value?: string;
}

export interface EvidenceLocator {
  readonly type: "EVIDENCE_LOCATOR";
  readonly evidenceKind: "PROJECT_FILE" | "AUTHORITY_RECEIPT";
  readonly locator: string;
  readonly description: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

export interface ExperienceRecord {
  readonly type: "EXPERIENCE_RECORD";
  readonly lesson: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNKNOWN_OUTCOME" | "WAIVED";
  readonly receiptId: string;
  readonly failureSignatureSha256: string | null;
}

export type MemoryClaimPayload = TypedPolicy | EvidenceLocator | ExperienceRecord;

export interface SourceAttestation {
  readonly resolver: SourceResolverKind;
  readonly sourceKind: MemorySourceKind;
  readonly locator: string;
  readonly sourceSha256: string;
  readonly verifiedAtMs: number;
  readonly binding: Readonly<Record<string, string | number | null>>;
  readonly attestationSha256: string;
}

export interface MemoryClaimVersionInput {
  readonly claimId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly actorGoalId: string;
  readonly scope: MemoryScope;
  readonly scopeGoalId: string | null;
  readonly channel: MemoryChannel;
  readonly status: MemoryClaimStatus;
  readonly payload: MemoryClaimPayload;
  readonly payloadSha256: string;
  readonly sourceAttestation: SourceAttestation;
  readonly tags: readonly string[];
  readonly pathKey: string | null;
  readonly dependencyKeys: readonly string[];
  readonly classification: MemoryClassification;
  readonly validFromMs: number;
  readonly expiresAtMs: number | null;
  readonly supersedesVersion: number | null;
  readonly contentText: string;
  readonly contentSha256: string;
  readonly contentTokenEstimate: number;
  readonly claimSha256: string;
}

export interface MemoryClaimVersionRecord extends MemoryClaimVersionInput {
  readonly createdEventSequence: number;
}

export type MemoryActionType = "ENDORSE" | "REVOKE_ENDORSEMENT" | "FORGET" | "RESTORE";
export type MemoryActionFamily = "ENDORSEMENT" | "VISIBILITY";

export interface MemoryClaimActionInput {
  readonly actionId: string;
  readonly claimId: string;
  readonly targetVersion: number;
  readonly workspaceId: string;
  readonly actorGoalId: string;
  readonly actionType: MemoryActionType;
  readonly actionFamily: MemoryActionFamily;
  readonly reason: string;
  readonly predecessorActionId: string | null;
  readonly actionSha256: string;
  readonly createdAtMs: number;
}

export interface MemoryClaimActionRecord extends MemoryClaimActionInput {
  readonly createdEventSequence: number;
}

export interface MemoryMutationContext {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly mutation: MutationMeta;
}

export interface AddUserPolicyIntent {
  readonly statement: string;
  readonly scope: MemoryScope;
  readonly policyKind?: TypedPolicy["policyKind"];
  readonly tags?: readonly string[];
  readonly pathKey?: string | null;
  readonly dependencyKeys?: readonly string[];
  readonly classification?: MemoryClassification;
  readonly expiresAtMs?: number | null;
}

export interface AddProjectEvidenceIntent {
  readonly path: string;
  readonly description?: string;
  readonly scope: MemoryScope;
  readonly lineStart?: number | null;
  readonly lineEnd?: number | null;
  readonly tags?: readonly string[];
  readonly dependencyKeys?: readonly string[];
}

export interface AddReceiptEvidenceIntent {
  readonly receiptId: string;
  readonly description?: string;
  readonly scope: MemoryScope;
  readonly tags?: readonly string[];
  readonly dependencyKeys?: readonly string[];
}

export interface AddReceiptExperienceIntent {
  readonly receiptId: string;
  readonly lesson: string;
  readonly scope: MemoryScope;
  readonly tags?: readonly string[];
  readonly dependencyKeys?: readonly string[];
}

export interface MemoryWriteResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly record: MemoryClaimVersionInput | null;
  readonly authorityResult: CommandResult | null;
  readonly additionalModelRequests: 0;
}

export interface MemoryActionResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly action: MemoryClaimActionInput | null;
  readonly authorityResult: CommandResult | null;
  readonly additionalModelRequests: 0;
}

export interface MemoryQuery {
  readonly workspaceId: string;
  readonly goalId: string | null;
  readonly workspaceRoot: string;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly pathKeys?: readonly string[];
  readonly dependencyKeys?: readonly string[];
  readonly nowMs: number;
  readonly promptGenerationId?: string | null;
}

export interface MemoryCandidateRank {
  readonly claimId: string;
  readonly channel: MemoryChannel;
  readonly relevanceRank: number | null;
  readonly exactMatches: number;
  readonly lexicalMatches: number;
}

export interface MemorySelection {
  readonly claimId: string;
  readonly version: number;
  readonly channel: MemoryChannel;
  readonly scope: MemoryScope;
  readonly payload: MemoryClaimPayload;
  readonly projectionText: string;
  readonly tokenEstimate: number;
  readonly reason: string;
  readonly sourceLocator: string;
  readonly sourceSha256: string;
  readonly claimSha256: string;
  readonly endorsed: boolean;
}

export interface MemoryWorkingSet {
  readonly policySnapshotSha256: string;
  readonly evidenceDeltaSha256: string;
  readonly manifestSha256: string;
  readonly policy: readonly MemorySelection[];
  readonly evidence: readonly MemorySelection[];
  readonly experience: readonly MemorySelection[];
  readonly conflicts: readonly string[];
  readonly abstentions: readonly string[];
  readonly projection: string;
  readonly tokenEstimate: number;
}

export interface MemoryRetrievalResult {
  readonly indexMode: MemoryIndexMode;
  readonly mode: MemoryMode;
  readonly epoch: string;
  readonly selected: readonly MemorySelection[];
  readonly omittedClaimIds: readonly string[];
  readonly workingSet: MemoryWorkingSet;
  readonly reason: string;
  readonly indexWatermark: number;
  readonly indexLagCount: number;
  readonly additionalModelRequests: 0;
}

export interface MemoryRecallObservation {
  readonly observationId: string;
  readonly workspaceId: string;
  readonly goalId: string | null;
  readonly epoch: string;
  readonly mode: MemoryMode;
  readonly selectedManifestSha256: string;
  readonly selectedCount: number;
  readonly conflictCount: number;
  readonly abstentionCount: number;
  readonly indexLagCount: number;
  readonly tokenEstimate: number;
  readonly latencyMicros: number;
  readonly createdAtMs: number;
}

export interface MemoryCheckpointClaimRef {
  readonly claim_id: string;
  readonly version: number;
  readonly channel: MemoryChannel;
  readonly claim_sha256: string;
  readonly source_sha256: string;
}

export interface MemoryCheckpointSnapshotRecord {
  readonly schema_version: 1;
  readonly record_type: "MEMORY_CHECKPOINT_SNAPSHOT";
  readonly record_id: string;
  readonly checkpoint_id: string;
  readonly checkpoint_sha256: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly memory_epoch: string;
  readonly memory_mode: MemoryMode;
  readonly manifest_sha256: string;
  readonly policy_snapshot_sha256: string;
  readonly evidence_delta_sha256: string;
  readonly selected_claims: readonly MemoryCheckpointClaimRef[];
  readonly index_mode: MemoryIndexMode;
  readonly index_watermark: number;
  readonly index_lag_count: number;
  readonly created_at: string;
  readonly record_sha256: string;
}

export interface MemoryEngineConfig {
  readonly enabled: boolean;
  readonly mode: MemoryMode;
  readonly epoch: string;
  readonly softProjectionTokens: number;
  readonly hardProjectionTokens: number;
  readonly maxResults: number;
  readonly maxPolicyResults: number;
  readonly maxEvidenceResults: number;
  readonly maxExperienceResults: number;
  readonly maxStructuredScanRows: number;
  readonly maxPayloadBytes: number;
  readonly indexDrainBatch: number;
  readonly indexDrainDebounceMs: number;
}

export interface MemoryExplanation {
  readonly claimId: string;
  readonly version: number;
  readonly status: MemoryClaimStatus;
  readonly channel: MemoryChannel;
  readonly sourceAttestation: SourceAttestation;
  readonly claimSha256: string;
  readonly scope: MemoryScope;
  readonly classification: MemoryClassification;
  readonly endorsed: boolean;
  readonly forgotten: boolean;
  readonly reason: string;
  readonly additionalModelRequests: 0;
}

export interface MemoryIndexDrainResult {
  readonly processed: number;
  readonly remaining: number;
  readonly workspaceWatermarks: Readonly<Record<string, number>>;
}

export interface MemoryReceiptAttestationSource {
  readonly receiptId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly result: "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNKNOWN_OUTCOME" | "WAIVED";
  readonly bodySha256: string;
  readonly outputSha256: string | null;
  readonly failureSignatureSha256: string | null;
  readonly issuedEventSequence: number;
  readonly eventSha256: string;
}

export interface EffectiveMemoryClaim {
  readonly claim: MemoryClaimVersionRecord;
  readonly endorsed: boolean;
  readonly forgotten: boolean;
}
