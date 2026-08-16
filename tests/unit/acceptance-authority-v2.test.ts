import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection, runImmediateTransaction } from "../../src/authority/database.js";
import {
  assertAcceptanceBundleV2,
  finalizeAcceptanceV2,
} from "../../src/acceptance-v2/finalize.js";
import type { AcceptanceFacetProposalV2 } from "../../src/acceptance-v2/domain.js";
import { AcceptanceAuthorityV2Repository } from "../../src/acceptance-v2/repository.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeGoalContract } from "../../src/task-flow/finalize.js";
import { TaskFlowRepository } from "../../src/task-flow/repository.js";
import {
  createTaskFlowAuthority, taskAcceptanceFacets, taskAdmissionMetadata, taskContractProposal,
} from "../helpers/task-flow.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

function contract(source: string | Uint8Array) {
  const objective = typeof source === "string" ? source : "invalid source fixture";
  return finalizeGoalContract({
    goalId: "GOAL-AUTHORITY-V2",
    objective,
    intent: "BUILD",
    lane: "ADAPTIVE_ROUTE",
    sourceIntakeSha256: sha256Hex(source),
    version: 1,
    parentContractId: null,
    createdAtMs: 1,
    proposal: {
      user_outcomes: ["Parser behavior and latency are accepted"],
      scope: ["src/parser.ts"],
      constraints: ["Do not use the network"],
      non_goals: ["Do not deploy"],
      obligations: [{
        key: "parser-accepted",
        priority: "MUST",
        statement: "Parser behavior and latency are accepted",
        oracle: { commands: ["npm test"] },
      }],
      authorization_ceiling: "LOCAL_REVERSIBLE",
    },
  });
}

function facets(): AcceptanceFacetProposalV2[] {
  return [
    {
      key: "parser-behavior",
      kind: "OUTCOME",
      subject: { kind: "USER_OUTCOME", index: 0 },
      source_quotes: [{ quote: "parser target", occurrence: 1 }],
      obligation_keys: ["parser-accepted"],
    },
    {
      key: "parser-latency",
      kind: "QUALITY",
      subject: { kind: "USER_OUTCOME", index: 0 },
      source_quotes: [{ quote: "parser target", occurrence: 2 }],
      obligation_keys: ["parser-accepted"],
    },
    {
      key: "network-constraint",
      kind: "CONSTRAINT",
      subject: { kind: "CONSTRAINT", index: 0 },
      source_quotes: [{ quote: "without network", occurrence: 1 }],
      obligation_keys: ["parser-accepted"],
    },
    {
      key: "deployment-bound",
      kind: "NON_GOAL",
      subject: { kind: "NON_GOAL", index: 0 },
      source_quotes: [{ quote: "no deploy", occurrence: 1 }],
      obligation_keys: ["parser-accepted"],
    },
  ];
}

function freezeStoredAuthority(
  authority: ReturnType<typeof createTaskFlowAuthority>,
  goalId: string,
  source: string,
): string {
  const admitted = authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW",
    goalId,
    workspace: {
      workspaceId: `WS-${goalId}`,
      workspaceHmac: sha256Hex(`workspace:${goalId}`),
      filesystemKind: "LOCAL_TEST",
      localLockingVerified: true,
    },
    originSessionId: `SESSION-${goalId}`,
    objective: `Persist Acceptance Authority for ${goalId}`,
    intent: "BUILD",
    lane: "DIRECT_CELL",
    sourceIntakeSha256: sha256Hex(source),
    sourceText: source,
    activationSha256: sha256Hex(`activation:${goalId}`),
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, { expectedVersion: 0, idempotencyKey: `admit:${goalId}`, actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, `SESSION-${goalId}`, 60_000);
  authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT",
    goalId,
    proposal: taskContractProposal(),
    acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: admitted.goalVersion,
    idempotencyKey: `freeze:${goalId}`,
    actor: "RUNTIME",
    lease,
  });
  const contractId = authority.store.readTaskFlowView(goalId)?.contract?.contract_id;
  if (!contractId) throw new Error("Acceptance Authority V2 fixture did not freeze a contract");
  return contractId;
}

describe("Acceptance Authority V2", () => {
  it("allows multiple facets for one subject and seals an order-independent authority root", () => {
    const source = "parser target; parser target; without network; no deploy";
    const frozen = contract(source);
    const input = {
      goalId: frozen.goal_id,
      contract: frozen,
      source,
      authority: {
        qualification_basis: "NATIVE_EXACT" as const,
        predecessor_authority_head_sha256: sha256Hex("event-head"),
      },
    };
    const first = finalizeAcceptanceV2({ ...input, facets: facets() });
    const reordered = finalizeAcceptanceV2({ ...input, facets: facets().reverse() });

    expect(first.facets.filter((facet) => facet.subject.kind === "USER_OUTCOME")).toHaveLength(2);
    expect(first.authority.record_sha256).toBe(reordered.authority.record_sha256);
    expect(first.bindings.map((binding) => binding.relation).sort()).toEqual([
      "BOUNDS", "CONSTRAINS", "SATISFIES", "SATISFIES",
    ]);
    expect(new Set(first.evidence_requirements.map((requirement) => requirement.requirement_kind))).toEqual(
      new Set(["HOST_ORACLE", "OPERATION_CLOSURE"]),
    );
    const secondOccurrence = first.spans.find((span) => span.start_byte === 15);
    expect(secondOccurrence?.quote_sha256).toBe(sha256Hex("parser target"));
  });

  it("rejects invalid UTF-8 source bytes before creating authority", () => {
    const source = Uint8Array.from([0xc3, 0x28]);
    const frozen = contract(source);
    expect(() => finalizeAcceptanceV2({
      goalId: frozen.goal_id,
      contract: frozen,
      source,
      facets: facets(),
      authority: {
        qualification_basis: "NATIVE_EXACT",
        predecessor_authority_head_sha256: sha256Hex("event-head"),
      },
    })).toThrow("valid exact UTF-8");
  });

  it("rejects a stored span that cuts through a UTF-8 code point", () => {
    const source = "\u{1f680} parser target; parser target; without network; no deploy";
    const frozen = contract(source);
    const bundle = finalizeAcceptanceV2({
      goalId: frozen.goal_id,
      contract: frozen,
      source,
      facets: facets(),
      authority: {
        qualification_basis: "NATIVE_EXACT",
        predecessor_authority_head_sha256: sha256Hex("event-head"),
      },
    });
    const first = bundle.spans[0]!;
    const body = {
      ...first,
      start_byte: 1,
      end_byte_exclusive: 3,
      quote_sha256: sha256Hex(bundle.source_bytes.subarray(1, 3)),
    };
    const { record_sha256: oldHash, ...withoutHash } = body;
    const forged = {
      ...withoutHash,
      record_sha256: canonicalJsonSha256({ domain: "PCH-SOURCE-SPAN-V2", ...withoutHash }),
    };
    expect(forged.record_sha256).not.toBe(oldHash);
    expect(() => assertAcceptanceBundleV2({
      ...bundle,
      spans: [forged, ...bundle.spans.slice(1)],
    })).toThrow("UTF-8 code point");
  });

  it("rejects a legacy qualification without both legacy bindings", () => {
    const source = "parser target; parser target; without network; no deploy";
    const frozen = contract(source);
    expect(() => finalizeAcceptanceV2({
      goalId: frozen.goal_id,
      contract: frozen,
      source,
      facets: facets(),
      authority: {
        qualification_basis: "LEGACY_REQUALIFIED",
        predecessor_authority_head_sha256: sha256Hex("event-head"),
      },
    })).toThrow("legacy_event_head_sha256");
  });

  it("round-trips an explicit authority graph and rejects substitution after reopen", () => {
    const authority = createTaskFlowAuthority();
    try {
      const goalId = "GOAL-AUTHORITY-V2-ROUNDTRIP";
      const source = "roundtrip exact intake";
      const admitted = authority.store.transactTaskFlow({
        type: "ADMIT_TASK_FLOW",
        goalId,
        workspace: {
          workspaceId: "WS-AUTHORITY-V2",
          workspaceHmac: sha256Hex("authority-v2-workspace"),
          filesystemKind: "LOCAL_TEST",
          localLockingVerified: true,
        },
        originSessionId: "SESSION-AUTHORITY-V2",
        objective: "Persist and recover Acceptance Authority V2",
        intent: "BUILD",
        lane: "DIRECT_CELL",
        sourceIntakeSha256: sha256Hex(source),
        sourceText: source,
        activationSha256: sha256Hex("authority-v2-activation"),
        ...taskAdmissionMetadata("DIRECT_CELL"),
      }, { expectedVersion: 0, idempotencyKey: "admit-authority-v2", actor: "RUNTIME" });
      const lease = authority.store.acquireLease(goalId, "SESSION-AUTHORITY-V2", 60_000);
      authority.store.transactTaskFlow({
        type: "SUBMIT_GOAL_CONTRACT",
        goalId,
        proposal: taskContractProposal(),
        acceptanceFacets: taskAcceptanceFacets(),
        goalFitAssessment: passingGoalFitAssessment(),
      }, {
        expectedVersion: admitted.goalVersion,
        idempotencyKey: "freeze-authority-v2",
        actor: "RUNTIME",
        lease,
      });
      const contractId = authority.store.readTaskFlowView(goalId)?.contract?.contract_id;
      if (!contractId) throw new Error("Acceptance Authority V2 fixture did not freeze a contract");
      const beforeReopen = authority.store.readTaskFlowAcceptanceV2(contractId);
      if (!beforeReopen) throw new Error("Acceptance Authority V2 was not readable before reopen");

      const connection = openAuthorityConnection({ path: authority.databasePath });
      try {
        const repository = new AcceptanceAuthorityV2Repository(connection);
        const restored = repository.readBundle(contractId);
        if (!restored) throw new Error("Acceptance Authority V2 did not survive reopen");
        expect(Buffer.from(restored.source_bytes).toString("utf8")).toBe(source);
        expect(restored.authority.record_sha256).toBe(beforeReopen.authority.record_sha256);
        expect(repository.verifyIntegrity()).toEqual({ authorityRoots: 1 });
        expect(() => repository.insert(restored, 99)).toThrow(/authority transaction/u);
        expect(runImmediateTransaction(connection, () => repository.insert(restored, 99))).toBe(true);

        const obligationsById = new Map(restored.obligations.map((entry) => [
          entry.acceptance_obligation_id, entry.semantic_key,
        ]));
        const rebuild = (predecessorAuthorityHeadSha256: string) => finalizeAcceptanceV2({
          goalId,
          contract: restored.contract,
          source: restored.source_bytes,
          facets: restored.facets.map((facet) => ({
            key: facet.semantic_key,
            kind: facet.kind,
            subject: facet.subject,
            source_binding: "ENTIRE_INTAKE",
            obligation_keys: restored.bindings
              .filter((binding) => binding.facet_id === facet.facet_id)
              .map((binding) => obligationsById.get(binding.acceptance_obligation_id)!),
          })),
          authority: {
            qualification_basis: "NATIVE_EXACT",
            predecessor_authority_head_sha256: predecessorAuthorityHeadSha256,
          },
        });
        expect(rebuild(restored.authority.predecessor_authority_head_sha256).authority.record_sha256)
          .toBe(restored.authority.record_sha256);
        const substitute = rebuild(sha256Hex("substituted-authority-head"));
        expect(() => runImmediateTransaction(connection, () => repository.insert(substitute, 100)))
          .toThrow("authority root substitution");
      } finally {
        closeAuthorityConnection(connection);
      }
    } finally {
      authority.close();
    }
  });

  it("rejects foreign identities, facet substitution, and cross-root members in storage", () => {
    const authority = createTaskFlowAuthority();
    try {
      const contractA = freezeStoredAuthority(authority, "GOAL-AUTHORITY-V2-A", "exact source A");
      const contractB = freezeStoredAuthority(authority, "GOAL-AUTHORITY-V2-B", "exact source B");
      const connection = openAuthorityConnection({ path: authority.databasePath });
      try {
        const repository = new AcceptanceAuthorityV2Repository(connection);
        const a = repository.readBundle(contractA);
        const b = repository.readBundle(contractB);
        if (!a || !b) throw new Error("Acceptance Authority V2 composite fixture is incomplete");
        const bSpan = b.spans[0]!;
        const bQuote = b.source_bytes.subarray(bSpan.start_byte, bSpan.end_byte_exclusive);
        const reject = (action: () => void): void => {
          expect(() => runImmediateTransaction(connection, action)).toThrow();
        };

        reject(() => connection.prepare(`INSERT INTO acceptance_source_spans_v2(
          span_id,goal_id,contract_id,source_revision_id,source_sha256,start_byte,end_byte_exclusive,
          quote_bytes,quote_sha256,record_sha256,created_event_sequence
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          "SPAN-FOREIGN-A-B",
          a.authority.goal_id,
          a.authority.contract_id,
          b.source.source_revision_id,
          b.source.content_sha256,
          bSpan.start_byte,
          bSpan.end_byte_exclusive,
          Buffer.from(bQuote),
          bSpan.quote_sha256,
          sha256Hex("foreign span record"),
          101,
        ));

        reject(() => connection.prepare(`INSERT INTO acceptance_facets_v2(
          facet_id,goal_id,contract_id,semantic_key,kind,subject_kind,subject_index,
          semantic_statement,derivation,record_sha256,created_event_sequence
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          "FACET-FOREIGN-A-B",
          a.authority.goal_id,
          b.authority.contract_id,
          "foreign-goal-contract",
          "OUTCOME",
          "USER_OUTCOME",
          0,
          "Foreign Goal/contract pairs cannot become authority",
          "CURRENT_AGENT_TYPED_PROPOSAL",
          sha256Hex("foreign facet record"),
          102,
        ));

        reject(() => connection.prepare(`INSERT INTO acceptance_facet_span_members_v2(
          facet_id,span_id,goal_id,contract_id,source_revision_id,ordinal,created_event_sequence
        ) VALUES(?,?,?,?,?,?,?)`).run(
          a.facets[0]!.facet_id,
          bSpan.span_id,
          a.authority.goal_id,
          a.authority.contract_id,
          a.source.source_revision_id,
          99,
          103,
        ));

        reject(() => connection.prepare(`INSERT INTO acceptance_authority_binding_members_v2(
          authority_root_id,binding_id,goal_id,contract_id,ordinal,created_event_sequence
        ) VALUES(?,?,?,?,?,?)`).run(
          a.authority.authority_root_id,
          b.bindings[0]!.binding_id,
          a.authority.goal_id,
          a.authority.contract_id,
          99,
          104,
        ));

        const uniqueColumns = (table: string): readonly string[][] => {
          const indexes = connection.prepare(`PRAGMA index_list('${table}')`).all() as Record<string, unknown>[];
          return indexes.filter((row) => Number(row.unique) === 1).map((row) => (
            connection.prepare(`PRAGMA index_info('${String(row.name)}')`).all() as Record<string, unknown>[]
          ).map((column) => String(column.name)));
        };
        expect(uniqueColumns("acceptance_source_spans_v2")).toContainEqual([
          "span_id", "goal_id", "contract_id",
        ]);
        expect(uniqueColumns("acceptance_authority_binding_members_v2")).toContainEqual([
          "authority_root_id", "binding_id", "goal_id", "contract_id",
        ]);
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        closeAuthorityConnection(connection);
      }
    } finally {
      authority.close();
    }
  });

  it("rejects foreign and stale source parents while accepting the current revision parent", () => {
    const authority = createTaskFlowAuthority();
    try {
      const contractAId = freezeStoredAuthority(authority, "GOAL-AUTHORITY-V2-PARENT-A", "parent source A");
      const contractBId = freezeStoredAuthority(authority, "GOAL-AUTHORITY-V2-PARENT-B", "parent source B");
      const connection = openAuthorityConnection({ path: authority.databasePath });
      try {
        const repository = new AcceptanceAuthorityV2Repository(connection);
        const first = repository.readBundle(contractAId);
        const foreign = repository.readBundle(contractBId);
        if (!first || !foreign) throw new Error("Acceptance Authority V2 parent fixture is incomplete");
        const taskFlow = new TaskFlowRepository(connection);
        const proposal = taskContractProposal();
        const secondContract = finalizeGoalContract({
          goalId: first.authority.goal_id,
          objective: first.contract.objective,
          intent: first.contract.intent,
          lane: first.contract.lane,
          sourceIntakeSha256: first.source.content_sha256,
          version: 2,
          parentContractId: first.contract.contract_id,
          createdAtMs: 2,
          proposal,
        });
        runImmediateTransaction(connection, () => taskFlow.insertContractCore(secondContract, 201));
        const acceptance = (parentSourceRevisionId: string) => finalizeAcceptanceV2({
          goalId: secondContract.goal_id,
          contract: secondContract,
          source: first.source_bytes,
          facets: taskAcceptanceFacets(),
          authority: {
            qualification_basis: "NATIVE_EXACT",
            predecessor_authority_head_sha256: first.authority.record_sha256,
            parent_source_revision_id: parentSourceRevisionId,
          },
        });
        expect(() => runImmediateTransaction(connection, () => repository.insert(
          acceptance(foreign.source.source_revision_id), 202,
        ))).toThrow("source parent identity mismatch");

        const second = acceptance(first.source.source_revision_id);
        runImmediateTransaction(connection, () => {
          repository.insert(second, 203);
          taskFlow.publishContract(secondContract, 203);
        });
        expect(repository.readBundle(secondContract.contract_id)?.authority.record_sha256)
          .toBe(second.authority.record_sha256);

        const thirdContract = finalizeGoalContract({
          goalId: first.authority.goal_id,
          objective: first.contract.objective,
          intent: first.contract.intent,
          lane: first.contract.lane,
          sourceIntakeSha256: first.source.content_sha256,
          version: 3,
          parentContractId: secondContract.contract_id,
          createdAtMs: 3,
          proposal,
        });
        runImmediateTransaction(connection, () => taskFlow.insertContractCore(thirdContract, 204));
        const stale = finalizeAcceptanceV2({
          goalId: thirdContract.goal_id,
          contract: thirdContract,
          source: first.source_bytes,
          facets: taskAcceptanceFacets(),
          authority: {
            qualification_basis: "NATIVE_EXACT",
            predecessor_authority_head_sha256: second.authority.record_sha256,
            parent_source_revision_id: first.source.source_revision_id,
          },
        });
        expect(() => runImmediateTransaction(connection, () => repository.insert(stale, 205)))
          .toThrow("source parent identity mismatch");
      } finally {
        closeAuthorityConnection(connection);
      }
    } finally {
      authority.close();
    }
  });

  it("fails restart integrity when an explicit authority member is missing", () => {
    const authority = createTaskFlowAuthority();
    try {
      const goalId = "GOAL-AUTHORITY-V2-MEMBER";
      const source = "member integrity exact intake";
      const admitted = authority.store.transactTaskFlow({
        type: "ADMIT_TASK_FLOW",
        goalId,
        workspace: {
          workspaceId: "WS-AUTHORITY-V2-MEMBER",
          workspaceHmac: sha256Hex("authority-v2-member-workspace"),
          filesystemKind: "LOCAL_TEST",
          localLockingVerified: true,
        },
        originSessionId: "SESSION-AUTHORITY-V2-MEMBER",
        objective: "Detect a missing Acceptance Authority member",
        intent: "BUILD",
        lane: "DIRECT_CELL",
        sourceIntakeSha256: sha256Hex(source),
        sourceText: source,
        activationSha256: sha256Hex("authority-v2-member-activation"),
        ...taskAdmissionMetadata("DIRECT_CELL"),
      }, { expectedVersion: 0, idempotencyKey: "admit-authority-v2-member", actor: "RUNTIME" });
      const lease = authority.store.acquireLease(goalId, "SESSION-AUTHORITY-V2-MEMBER", 60_000);
      authority.store.transactTaskFlow({
        type: "SUBMIT_GOAL_CONTRACT",
        goalId,
        proposal: taskContractProposal(),
        acceptanceFacets: taskAcceptanceFacets(),
        goalFitAssessment: passingGoalFitAssessment(),
      }, {
        expectedVersion: admitted.goalVersion,
        idempotencyKey: "freeze-authority-v2-member",
        actor: "RUNTIME",
        lease,
      });
      const contractId = authority.store.readTaskFlowView(goalId)?.contract?.contract_id;
      if (!contractId) throw new Error("Acceptance Authority V2 fixture did not freeze a contract");

      const connection = openAuthorityConnection({ path: authority.databasePath });
      try {
        const repository = new AcceptanceAuthorityV2Repository(connection);
        const intact = repository.readBundle(contractId);
        if (!intact) throw new Error("Acceptance Authority V2 member fixture is incomplete");
        connection.exec("DROP TRIGGER no_delete_acceptance_authority_facet_members_v2");
        connection.prepare(`DELETE FROM acceptance_authority_facet_members_v2
          WHERE authority_root_id=(SELECT authority_root_id FROM acceptance_authority_roots_v2 WHERE contract_id=?)
            AND ordinal=0`).run(contractId);
        expect(() => repository.verifyIntegrity()).toThrow(/authority facet members/u);
        expect(() => runImmediateTransaction(connection, () => repository.insert(intact, 999)))
          .toThrow(/authority facet members/u);
      } finally {
        closeAuthorityConnection(connection);
      }
    } finally {
      authority.close();
    }
  });

  it("fails restart integrity for ordinal or derived-column corruption", () => {
    const authority = createTaskFlowAuthority();
    try {
      const contractId = freezeStoredAuthority(
        authority,
        "GOAL-AUTHORITY-V2-CANONICAL-ORDINAL",
        "canonical ordinal and derived root intake",
      );
      const connection = openAuthorityConnection({ path: authority.databasePath });
      try {
        const repository = new AcceptanceAuthorityV2Repository(connection);
        const bundle = repository.readBundle(contractId);
        if (!bundle) throw new Error("Acceptance Authority V2 ordinal fixture is incomplete");
        const rootId = bundle.authority.authority_root_id;
        connection.exec("DROP TRIGGER no_update_acceptance_authority_facet_members_v2");
        const moveOrdinal = connection.prepare(`UPDATE acceptance_authority_facet_members_v2
          SET ordinal=? WHERE authority_root_id=? AND ordinal=?`);
        moveOrdinal.run(99, rootId, 0);
        moveOrdinal.run(0, rootId, 1);
        moveOrdinal.run(1, rootId, 99);
        expect(() => repository.verifyIntegrity()).toThrow(/canonical ordinal order/u);

        moveOrdinal.run(99, rootId, 0);
        moveOrdinal.run(0, rootId, 1);
        moveOrdinal.run(1, rootId, 99);
        expect(repository.verifyIntegrity()).toEqual({ authorityRoots: 1 });

        connection.exec("DROP TRIGGER no_update_acceptance_obligations_v2");
        connection.prepare(`UPDATE acceptance_obligations_v2 SET dependency_root_sha256=?
          WHERE contract_id=?`).run(sha256Hex("corrupt dependency root"), contractId);
        expect(() => repository.verifyIntegrity()).toThrow(/dependency root mismatch/u);
      } finally {
        closeAuthorityConnection(connection);
      }
    } finally {
      authority.close();
    }
  });
});
