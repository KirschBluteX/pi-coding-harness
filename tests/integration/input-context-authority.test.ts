import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection, type AuthorityConnection } from "../../src/authority/database.js";
import type { LeaseToken } from "../../src/authority/lease.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { inputContextHashDomains, sealInputContextRecord } from "../../src/input-context/canonical.js";
import {
  type ContextEnvelopeRecord,
  type ContextWorkingSetRecord,
  type ProjectKnowledgeClaimRecord,
  type ProjectSourceManifestRecord,
  type ProviderTurnAttemptRecord,
  type ProviderTurnContributionRecord,
  type ProviderTurnLedgerRecord,
  type ProviderTurnRequestRecord,
  type ReadEvidenceReceiptRecord,
} from "../../src/input-context/domain.js";
import { InputContextRepository } from "../../src/input-context/repository.js";
import { makeExecutionSubjectRef } from "../../src/task-flow/domain.js";
import { createTestAuthority, type TestAuthority } from "../helpers/authority.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";
import {
  taskAcceptanceFacets, taskAdmissionMetadata, taskContractProposal, taskFlowMemoryMigrations,
} from "../helpers/task-flow.js";

interface Fixture {
  readonly authority: TestAuthority;
  readonly connection: AuthorityConnection;
  readonly repository: InputContextRepository;
  readonly goalId: string;
  readonly contractSha256: string;
  readonly lease: LeaseToken;
  goalVersion: number;
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    closeAuthorityConnection(fixture.connection);
    fixture.authority.close();
  }
});

function createFixture(): Fixture {
  const authority = createTestAuthority({
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
  });
  const goalId = "GOAL-INPUT-CONTEXT-001";
  const admitted = authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW", goalId,
    workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true },
    originSessionId: "SESSION-INPUT-CONTEXT-001", objective: "Verify Input Context authority",
    intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("input"), activationSha256: sha256Hex("activation"),
    sourceText: "input",
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, { expectedVersion: 0, idempotencyKey: "admit-input-context", actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, "SESSION-INPUT-CONTEXT-001", 60_000);
  const submitted = authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  },
    { expectedVersion: admitted.goalVersion, idempotencyKey: "contract-input-context", actor: "RUNTIME", lease });
  const contract = authority.store.readTaskFlowView(goalId)?.contract;
  if (!contract) throw new Error("Input Context fixture contract was not frozen");
  const connection = openAuthorityConnection({ path: authority.databasePath });
  const fixture = {
    authority, connection, repository: new InputContextRepository(connection), goalId,
    contractSha256: contract.record_sha256, lease, goalVersion: submitted.goalVersion,
  };
  fixtures.push(fixture);
  return fixture;
}

function promptRequest(fixture: Fixture): ProviderTurnRequestRecord {
  const request = sealInputContextRecord(inputContextHashDomains.providerTurnRequest, "record_sha256", {
    schema_version: 1 as const,
    prompt_request_id: "PROMPT-REQUEST-IC-001",
    prompt_generation_id: "PROMPT-GENERATION-IC-001",
    previous_prompt_request_id: null,
    request_sequence: 0,
    logical_request_hmac_sha256: sha256Hex("logical-request"),
    payload_shape_sha256: sha256Hex("payload-shape"),
    message_descriptor_root_sha256: sha256Hex("message-descriptors"),
    message_count: 1,
    logical_message_bytes: 32,
    user_history_bytes: 32,
    assistant_history_bytes: 0,
    other_history_bytes: 0,
    tool_schema_bytes: 64,
    created_at_ms: fixture.authority.clock.now(),
  });
  return request;
}

function contributionHash(
  promptRequestId: string,
  ordinal: number,
  contribution: ProviderTurnContributionRecord,
): string {
  return canonicalJsonSha256({
    domain: inputContextHashDomains.providerTurnContribution,
    prompt_request_id: promptRequestId,
    ordinal,
    contribution,
  });
}

function subject(fixture: Fixture) {
  return makeExecutionSubjectRef({
    kind: "GOAL" as const, goalId: fixture.goalId, subjectId: fixture.goalId, routeRevision: null,
    goalContractSha256: fixture.contractSha256, executionAuthorizationSha256: null,
  });
}

function readReceipt(fixture: Fixture): ReadEvidenceReceiptRecord {
  return sealInputContextRecord(inputContextHashDomains.readEvidenceReceipt, "receipt_sha256", {
    schema_version: 1 as const, receipt_id: "READ-EVIDENCE-IC-001", workspace_id: "WS-TEST-001",
    subject: subject(fixture), source_kind: "FILE_RANGE" as const, capture_kind: "LINE_RANGE" as const,
    evidence_sha256: sha256Hex("evidence"), artifact_ref_hmac: sha256Hex("artifact"),
    dependency_signature_sha256: sha256Hex("dependency"), source_scope_hmac: sha256Hex("scope"),
    source_version_handle_hmac: sha256Hex("version"), query_completeness: "NOT_APPLICABLE" as const,
    content_freshness: "HASH_CURRENT" as const, scope_authorization: "AUTHORIZED" as const,
    semantic_applicability: "CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
    classification: "INTERNAL" as const, adapter_version: "builtin-read-1", observed_at_ms: fixture.authority.clock.now(),
  });
}

function workingSetEnvelope(fixture: Fixture): { workingSet: ContextWorkingSetRecord; envelope: ContextEnvelopeRecord } {
  const currentSubject = subject(fixture);
  const workingSet = sealInputContextRecord(inputContextHashDomains.contextWorkingSet, "record_sha256", {
    schema_version: 1 as const, working_set_id: "WORKING-SET-IC-001", subject: currentSubject,
    profile: "TARGETED_EVIDENCE" as const, context_demand_sha256: sha256Hex("demand"),
    retained_root_sha256: sha256Hex("retained"), source_closure_root_sha256: sha256Hex("source-closure"),
    acceptance_closure_root_sha256: sha256Hex("acceptance-closure"), items: [], created_at_ms: fixture.authority.clock.now(),
  });
  const envelope = sealInputContextRecord(inputContextHashDomains.contextEnvelope, "record_sha256", {
    schema_version: 1 as const, envelope_id: "ENVELOPE-IC-001", subject: currentSubject,
    profile: workingSet.profile, prompt_generation_id: null, retained_root_sha256: workingSet.retained_root_sha256,
    source_closure_root_sha256: workingSet.source_closure_root_sha256,
    acceptance_closure_root_sha256: workingSet.acceptance_closure_root_sha256,
    mandatory_coverage_root_sha256: sha256Hex("coverage"), context_demand_root_sha256: workingSet.context_demand_sha256,
    items: [], estimated_projected_tokens: 0, fit_disposition: "FIT" as const,
  });
  return { workingSet, envelope };
}

function projectEvidence(fixture: Fixture): { manifest: ProjectSourceManifestRecord; claim: ProjectKnowledgeClaimRecord } {
  const currentSubject = subject(fixture);
  const manifest = sealInputContextRecord(inputContextHashDomains.projectSourceManifest, "record_sha256", {
    schema_version: 1 as const, manifest_id: "MANIFEST-IC-001", workspace_id: "WS-TEST-001", subject: currentSubject,
    entries: [{
      source_id: "SOURCE-IC-001", source_kind: "PROJECT_GUIDE" as const,
      workspace_path_hmac: sha256Hex("AGENTS.md"), content_sha256: sha256Hex("source-bytes"),
      source_version_handle_hmac: sha256Hex("source-version"), trust: "VERIFIED_EVIDENCE" as const,
      content_freshness: "HASH_CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
      classification: "INTERNAL" as const,
    }],
    created_at_ms: fixture.authority.clock.now(),
  });
  const claim = sealInputContextRecord(inputContextHashDomains.projectKnowledgeClaim, "record_sha256", {
    schema_version: 1 as const, claim_id: "CLAIM-IC-001", manifest_id: manifest.manifest_id,
    source_id: "SOURCE-IC-001", subject: currentSubject, semantic_key: "verification.command",
    statement_sha256: sha256Hex("npm test"), source_range_sha256: sha256Hex("range"),
    evidence_sha256: sha256Hex("claim-evidence"), trust: "VERIFIED_EVIDENCE" as const,
    content_freshness: "HASH_CURRENT" as const, scope_authorization: "AUTHORIZED" as const,
    semantic_applicability: "CURRENT" as const, representation_fidelity: "EXACT_RAW" as const,
    authority_status: "EVIDENCE_ONLY" as const, frozen_goal_contract_sha256: null,
    created_at_ms: fixture.authority.clock.now(),
  });
  return { manifest, claim };
}

describe("Input Context authority repository", () => {
  it("persists generic subjects, envelopes and project evidence idempotently", () => {
    const fixture = createFixture();
    const receipt = readReceipt(fixture);
    expect(fixture.repository.insertReadEvidenceReceipt(receipt).reused).toBe(false);
    expect(fixture.repository.insertReadEvidenceReceipt(receipt)).toEqual({ reused: true, record: receipt });
    expect(fixture.repository.readEvidenceReceipt(receipt.receipt_id)).toEqual(receipt);

    const pair = workingSetEnvelope(fixture);
    expect(fixture.repository.storeWorkingSetEnvelope(pair.workingSet, pair.envelope).reused).toBe(false);
    expect(fixture.repository.storeWorkingSetEnvelope(pair.workingSet, pair.envelope).reused).toBe(true);
    expect(fixture.repository.readEnvelope(pair.envelope.record_sha256)).toEqual(pair.envelope);

    const project = projectEvidence(fixture);
    fixture.repository.insertProjectSourceManifest(project.manifest);
    fixture.repository.insertProjectKnowledgeClaim(project.claim);
    expect(fixture.repository.readProjectSourceManifest(project.manifest.manifest_id)).toEqual(project.manifest);
    expect(fixture.repository.readProjectKnowledgeClaims(project.manifest.manifest_id)).toEqual([project.claim]);
    expect(fixture.repository.verifyIntegrity()).toMatchObject({
      readEvidenceReceipts: 1, workingSets: 1, projectSourceManifests: 1, projectKnowledgeClaims: 1,
    });
  });

  it("rejects immutable tamper and detects hash corruption after a hostile trigger removal", () => {
    const fixture = createFixture();
    const receipt = readReceipt(fixture);
    fixture.repository.insertReadEvidenceReceipt(receipt);
    expect(() => fixture.connection.prepare("UPDATE read_evidence_receipts_v1 SET evidence_sha256=? WHERE receipt_id=?")
      .run(sha256Hex("tamper"), receipt.receipt_id)).toThrow("immutable");
    fixture.connection.exec("DROP TRIGGER no_update_read_evidence_receipts_v1");
    fixture.connection.prepare("UPDATE read_evidence_receipts_v1 SET evidence_sha256=? WHERE receipt_id=?")
      .run(sha256Hex("hostile-tamper"), receipt.receipt_id);
    expect(() => fixture.repository.verifyIntegrity()).toThrow("failed semantic or hash verification");
  });

  it("rejects parent substitution and an unknown project source", () => {
    const fixture = createFixture();
    const project = projectEvidence(fixture);
    fixture.repository.insertProjectSourceManifest(project.manifest);
    const { record_sha256: priorRecordSha256, ...claimBody } = project.claim;
    void priorRecordSha256;
    const forged = sealInputContextRecord(inputContextHashDomains.projectKnowledgeClaim, "record_sha256", {
      ...claimBody, source_id: "SOURCE-UNKNOWN",
    });
    expect(() => fixture.repository.insertProjectKnowledgeClaim(forged)).toThrow("absent from its manifest");
  });

  it("persists request start before the immutable provider-turn reconciliation", () => {
    const fixture = createFixture();
    const request = promptRequest(fixture);
    expect(fixture.connection.prepare("SELECT count(*) count FROM input_context_prompt_requests_v2 WHERE prompt_request_id=?")
      .get(request.prompt_request_id)).toEqual({ count: 0 });

    const input: ProviderTurnContributionRecord = {
      contribution_id: "CONTRIBUTION-IC-INPUT-001", owner: "INPUT_CONTEXT", input_surface: "PCH_EVIDENCE",
      output_surface: null, segment_identity_hmac: sha256Hex("segment-input"), logical_bytes: 40,
      tokens: 10, evidence: "PROVIDER_REPORTED", included: true, duplicate_of: null,
    };
    const output: ProviderTurnContributionRecord = {
      contribution_id: "CONTRIBUTION-IC-OUTPUT-001", owner: "PROVIDER", input_surface: null,
      output_surface: "ASSISTANT_TEXT", segment_identity_hmac: null, logical_bytes: null,
      tokens: 2, evidence: "PROVIDER_REPORTED", included: true, duplicate_of: null,
    };
    const ledger: ProviderTurnLedgerRecord = sealInputContextRecord(
      inputContextHashDomains.providerTurnLedger,
      "record_sha256",
      {
        schema_version: 1 as const, prompt_request_id: request.prompt_request_id,
        prompt_generation_id: request.prompt_generation_id, context_envelope_sha256: null,
        layout_manifest_sha256: null, contributions: [input, output],
        provider_uncached_input_tokens: 10, provider_cache_read_tokens: 0,
        provider_cache_write_tokens: 0, provider_generated_output_tokens: 2,
        provider_reasoning_tokens: 0, attributed_input_tokens: 10, unattributed_input_tokens: 0,
        attributed_output_tokens: 2, unattributed_output_tokens: 0,
        accounting_completeness: "COMPLETE" as const, additional_model_requests: 0 as const,
        additional_provider_requests: 0 as const, created_at_ms: fixture.authority.clock.now(),
      },
    );
    const started: ProviderTurnAttemptRecord = sealInputContextRecord(
      inputContextHashDomains.providerTurnAttempt,
      "record_sha256",
      {
        schema_version: 1 as const, attempt_id: "PROVIDER-ATTEMPT-IC-001",
        prompt_request_id: request.prompt_request_id, attempt_number: 1, transition_ordinal: 0,
        request_identity_hmac: request.logical_request_hmac_sha256,
        payload_identity_hmac: null,
        payload_finality: "PCH_HOOK_OUTPUT" as const, started_at_ms: fixture.authority.clock.now(),
        completed_at_ms: null, response_status: null, outcome: "STARTED" as const,
        usage_contribution_sha256: null,
      },
    );
    const { record_sha256: startedRecordSha256, ...startedBody } = started;
    void startedRecordSha256;
    const terminal: ProviderTurnAttemptRecord = sealInputContextRecord(
      inputContextHashDomains.providerTurnAttempt,
      "record_sha256",
      {
        ...startedBody, transition_ordinal: 1, completed_at_ms: fixture.authority.clock.now() + 1,
        response_status: 200, outcome: "RESPONDED" as const,
        usage_contribution_sha256: contributionHash(request.prompt_request_id, 1, output),
      },
    );

    const invalidStarted = sealInputContextRecord(inputContextHashDomains.providerTurnAttempt, "record_sha256", {
      ...startedBody, request_identity_hmac: sha256Hex("wrong-request-identity"),
    });
    expect(() => fixture.repository.beginProviderTurn(request, invalidStarted)).toThrow("identity");
    expect(fixture.repository.readLatestProviderTurnRequest(request.prompt_generation_id)).toBeNull();
    expect(fixture.repository.beginProviderTurn(request, started)).toEqual({ requestReused: false, attemptReused: false });
    expect(fixture.repository.beginProviderTurn(request, started)).toEqual({ requestReused: true, attemptReused: true });
    expect(fixture.repository.readProviderTurnLedger(request.prompt_request_id)).toBeNull();
    expect(fixture.repository.verifyIntegrity()).toMatchObject({ providerTurnLedgers: 0, providerTurnAttempts: 1 });
    expect(() => fixture.repository.appendProviderTurnAttempt(terminal)).toThrow("ledger");
    expect(fixture.repository.insertProviderTurnLedger(ledger)).toEqual({ reused: false, record: ledger });
    expect(fixture.repository.appendProviderTurnAttempt(terminal)).toEqual({ reused: false, record: terminal });
    expect(fixture.repository.appendProviderTurnAttempt(terminal)).toEqual({ reused: true, record: terminal });
    expect(fixture.repository.readProviderTurnAttempts(request.prompt_request_id)).toEqual([started, terminal]);
    expect(fixture.repository.verifyIntegrity()).toMatchObject({ providerTurnLedgers: 1, providerTurnAttempts: 2 });
  });
});
