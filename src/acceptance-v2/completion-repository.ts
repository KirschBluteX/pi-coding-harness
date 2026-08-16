import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { WorkCellCompletionReceiptV2 } from "./domain.js";
import { currentExecutionLineageV2 } from "./execution-lineage.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface RecordWorkCellCompletionTriggerV2 {
  readonly goal_id: string;
  readonly work_cell_id: string;
}

export interface CompletionTransactionStampV2 {
  readonly created_at_ms: number;
  readonly created_event_sequence: number;
}

export interface WorkCellCompletionClosureV2 {
  readonly receipt: WorkCellCompletionReceiptV2;
  readonly evidence_binding_ids: readonly string[];
  readonly acceptance_obligation_ids: readonly string[];
}

export interface GoalCompletionEvidenceSummaryV2 {
  readonly acceptance_obligation_ids: readonly string[];
  readonly receipt_refs: readonly string[];
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Completion V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Completion V2 ${key} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AuthorityIntegrityError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "");
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch { /* normalized below */ }
  throw new AuthorityIntegrityError(`${label} is invalid`);
}

function memberRoot(domain: string, hashes: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...hashes].sort() });
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertSealed(domain: string, value: Record<string, unknown>): void {
  const actual = text(value, "record_sha256");
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "record_sha256"));
  if (canonicalJsonSha256({ domain, ...body }) !== actual) throw new AuthorityIntegrityError("Completion V2 record hash mismatch");
}

function assertStamp(stamp: CompletionTransactionStampV2): void {
  if (!Number.isSafeInteger(stamp.created_at_ms) || stamp.created_at_ms < 0
    || !Number.isSafeInteger(stamp.created_event_sequence) || stamp.created_event_sequence < 1) {
    throw new AuthorityIntegrityError("Completion V2 transaction stamp is invalid");
  }
}

export class AcceptanceCompletionV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  readGoalEvidenceSummary(goalId: string): GoalCompletionEvidenceSummaryV2 {
    const rows = this.connection.prepare(`SELECT r.completion_receipt_id,r.record_sha256,
        m.acceptance_obligation_id,m.ordinal
      FROM goal_contract_heads_v1 contract
      JOIN route_skeleton_heads_v1 route ON route.goal_id=contract.goal_id
      JOIN work_cells_v1 cell ON cell.goal_id=contract.goal_id AND cell.route_id=route.route_id
      JOIN work_cell_completion_receipts_v2 r ON r.work_cell_id=cell.work_cell_id
        AND r.contract_id=contract.contract_id AND r.route_id=route.route_id
        AND r.revision=(SELECT MAX(latest.revision) FROM work_cell_completion_receipts_v2 latest
          WHERE latest.work_cell_id=cell.work_cell_id AND latest.contract_id=contract.contract_id
            AND latest.route_id=route.route_id)
      JOIN work_cell_completion_obligation_members_v2 m ON m.completion_receipt_id=r.completion_receipt_id
      WHERE contract.goal_id=? ORDER BY cell.ordinal,m.ordinal`).all(goalId) as Record<string, unknown>[];
    const obligations = [...new Set(rows.map((row) => text(row, "acceptance_obligation_id")))].sort();
    const receipts = [...new Map(rows.map((row) => [
      text(row, "completion_receipt_id"), sha(row.record_sha256, "Completion receipt SHA-256"),
    ])).values()];
    return { acceptance_obligation_ids: obligations, receipt_refs: receipts };
  }

  recordWorkCellCompletion(
    trigger: RecordWorkCellCompletionTriggerV2,
    stamp: CompletionTransactionStampV2,
  ): WorkCellCompletionClosureV2 {
    if (!this.connection.isTransaction) {
      throw new AuthorityIntegrityError("Completion V2 must be recorded inside the authority transaction");
    }
    assertStamp(stamp);
    const predecessor = this.eventHead(trigger.goal_id);
    if (stamp.created_event_sequence !== predecessor.sequence + 1) {
      throw new AuthorityIntegrityError("Completion V2 transaction sequence is not the next Goal event");
    }
    const head = this.currentClosure(trigger, stamp.created_at_ms);
    const obligationIds = stringArray(head.obligation_ids_json, "Completion V2 WorkCell obligation scope");
    const evidence = this.currentEvidence(head, obligationIds);
    const operationHashes = this.operationClosure(trigger);
    const evidenceIds = evidence.map((row) => text(row, "evidence_binding_id"));
    const evidenceHashes = evidence.map((row) => sha(row.evidence_binding_sha256, "Evidence binding SHA-256"));
    const obligations = new Map<string, string>();
    for (const row of evidence) obligations.set(
      text(row, "acceptance_obligation_id"),
      sha(row.obligation_sha256, "Acceptance obligation SHA-256"),
    );
    const obligationMemberIds = [...obligations.keys()].sort();
    const integrationRoots = new Set(evidence.map((row) => sha(row.integration_root_sha256, "Integration root SHA-256")));
    if (integrationRoots.size !== 1) throw new AuthorityIntegrityError("Completion V2 evidence spans multiple integration roots");
    const preservationHashes = evidence
      .filter((row) => text(row, "requirement_kind") === "PRESERVATION_REVIEW")
      .map((row) => sha(row.evidence_binding_sha256, "Preservation evidence SHA-256"));
    const revision = integer(this.connection.prepare(`SELECT COALESCE(MAX(revision),0)+1 revision
      FROM work_cell_completion_receipts_v2 WHERE work_cell_id=?`).get(trigger.work_cell_id) as Record<string, unknown>, "revision");
    const body = {
      schema_version: 2 as const,
      completion_receipt_id: idFromSha256("WORK_CELL_COMPLETION", canonicalJsonSha256({
        authority: text(head, "authority_root_id"), work_cell: trigger.work_cell_id,
        authorization: text(head, "authorization_sha256"), evidence: evidenceHashes,
        operations: operationHashes, revision,
      })),
      goal_id: trigger.goal_id,
      contract_id: text(head, "contract_id"),
      route_id: text(head, "route_id"),
      work_cell_id: trigger.work_cell_id,
      authority_root_id: text(head, "authority_root_id"),
      revision,
      authorization_id: text(head, "authorization_id"),
      authorization_sha256: text(head, "authorization_sha256"),
      final_postimage_root_sha256: text(head, "content_root_sha256"),
      operation_closure_sha256: memberRoot("PCH-OPERATION-CLOSURE-ROOT-V2", operationHashes),
      integration_root_sha256: [...integrationRoots][0]!,
      preservation_review_sha256: memberRoot("PCH-PRESERVATION-REVIEW-ROOT-V2", preservationHashes),
      evidence_binding_root_sha256: memberRoot("PCH-ACCEPTANCE-EVIDENCE-BINDING-ROOT-V2", evidenceHashes),
      obligation_root_sha256: memberRoot("PCH-COMPLETION-OBLIGATION-ROOT-V2", [...obligations.values()]),
      predecessor_authority_head_sha256: predecessor.sha256,
    };
    const receipt = sealed("PCH-WORK-CELL-COMPLETION-RECEIPT-V2", body);
    this.insertReceipt(receipt, stamp);
    this.insertMembers(receipt, evidenceIds, obligationMemberIds, stamp.created_event_sequence);
    return { receipt, evidence_binding_ids: evidenceIds, acceptance_obligation_ids: obligationMemberIds };
  }

  private currentClosure(trigger: RecordWorkCellCompletionTriggerV2, nowMs: number): Record<string, unknown> {
    const row = this.connection.prepare(`SELECT c.goal_id,c.contract_id,c.route_id,c.work_cell_id,c.obligation_ids_json,h.status,
        z.authorization_id,z.record_sha256 AS authorization_sha256,z.lease_generation,z.fencing_token,z.revoked_at_ms,
        z.expires_at_ms AS authorization_expires_at_ms,
        ch.contract_id AS current_contract_id,rh.route_id AS current_route_id,ar.authority_root_id,
        l.generation AS current_lease_generation,l.fencing_token AS current_fencing_token,l.expires_at_ms AS lease_expires_at_ms,
        b.content_root_sha256,b.environment_sha256,b.created_event_sequence AS baseline_sequence
      FROM work_cells_v1 c JOIN work_cell_heads_v1 h ON h.work_cell_id=c.work_cell_id
      JOIN execution_authorizations_v1 z ON z.work_cell_id=c.work_cell_id
      JOIN goal_contract_heads_v1 ch ON ch.goal_id=c.goal_id JOIN route_skeleton_heads_v1 rh ON rh.goal_id=c.goal_id
      JOIN acceptance_authority_roots_v2 ar ON ar.contract_id=c.contract_id JOIN execution_leases l ON l.goal_id=c.goal_id
      JOIN workspace_baselines_v1 b ON b.goal_id=c.goal_id
        AND b.created_event_sequence=(SELECT MAX(x.created_event_sequence) FROM workspace_baselines_v1 x WHERE x.goal_id=c.goal_id)
      WHERE c.goal_id=? AND c.work_cell_id=? ORDER BY z.created_event_sequence DESC LIMIT 1`)
      .get(trigger.goal_id, trigger.work_cell_id) as Record<string, unknown> | undefined;
    if (!row || text(row, "status") !== "RUNNING" || row.revoked_at_ms !== null
      || text(row, "contract_id") !== text(row, "current_contract_id")
      || text(row, "route_id") !== text(row, "current_route_id")
      || integer(row, "lease_generation") !== integer(row, "current_lease_generation")
      || integer(row, "fencing_token") !== integer(row, "current_fencing_token")
      || integer(row, "authorization_expires_at_ms") <= nowMs
      || integer(row, "lease_expires_at_ms") <= nowMs) {
      throw new AuthorityIntegrityError("Completion V2 requires the current fenced running WorkCell");
    }
    const unresolved = integer(this.connection.prepare(`SELECT count(*) count FROM operation_heads_v1
      WHERE goal_id=? AND work_cell_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')`)
      .get(trigger.goal_id, trigger.work_cell_id) as Record<string, unknown>, "count");
    if (unresolved !== 0) throw new AuthorityIntegrityError("Completion V2 has unresolved Operations");
    return row;
  }

  private currentEvidence(head: Record<string, unknown>, taskObligationIds: readonly string[]): readonly Record<string, unknown>[] {
    const lastMutationSequence = integer(this.connection.prepare(`SELECT COALESCE(MAX(t.created_event_sequence),0) sequence
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND a.work_cell_id=? AND a.operation_kind IN ('WRITE','EDIT','DELETE','MOVE','COMMAND')
        AND t.state='COMMITTED'`).get(
      text(head, "goal_id"), text(head, "work_cell_id"),
    ) as Record<string, unknown>, "sequence");
    const placeholders = taskObligationIds.map(() => "?").join(",");
    const rows = this.connection.prepare(`SELECT r.evidence_requirement_id,r.requirement_kind,
        o.acceptance_obligation_id,o.record_sha256 AS obligation_sha256,e.evidence_binding_id,
        e.record_sha256 AS evidence_binding_sha256,e.created_event_sequence,p.postimage_root_sha256,
        p.environment_sha256,p.integration_root_sha256,p.topology_revision_sha256
      FROM acceptance_authority_requirement_members_v2 m
      JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=m.evidence_requirement_id
      JOIN facet_obligation_bindings_v2 f ON f.binding_id=r.binding_id
      JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=f.acceptance_obligation_id
      LEFT JOIN acceptance_evidence_bindings_v2 e ON e.authority_root_id=m.authority_root_id
        AND e.work_cell_id=? AND e.evidence_requirement_id=r.evidence_requirement_id
        AND e.created_event_sequence=(SELECT MAX(x.created_event_sequence) FROM acceptance_evidence_bindings_v2 x
          WHERE x.authority_root_id=m.authority_root_id AND x.work_cell_id=?
            AND x.evidence_requirement_id=r.evidence_requirement_id)
      LEFT JOIN oracle_pass_receipts_v2 p ON p.pass_receipt_id=e.pass_receipt_id
      WHERE m.authority_root_id=? AND o.task_obligation_id IN (${placeholders})
      ORDER BY r.evidence_requirement_id`).all(
      text(head, "work_cell_id"), text(head, "work_cell_id"), text(head, "authority_root_id"), ...taskObligationIds,
    ) as Record<string, unknown>[];
    const lineage = currentExecutionLineageV2(this.connection, {
      goal_id: text(head, "goal_id"), route_id: text(head, "route_id"),
      work_cell_id: text(head, "work_cell_id"), authorization_sha256: text(head, "authorization_sha256"),
    });
    if (rows.some((row) => row.evidence_binding_id !== null
      && text(row, "topology_revision_sha256") !== lineage.topology_revision_sha256)) {
      throw new AuthorityIntegrityError("Completion V2 evidence topology is stale");
    }
    if (rows.some((row) => row.evidence_binding_id !== null
      && text(row, "integration_root_sha256") !== lineage.integration_root_sha256)) {
      throw new AuthorityIntegrityError("Completion V2 evidence integration lineage is stale");
    }
    if (rows.length === 0 || rows.some((row) => row.evidence_binding_id === null
      || text(row, "postimage_root_sha256") !== text(head, "content_root_sha256")
      || text(row, "environment_sha256") !== text(head, "environment_sha256")
      || integer(head, "baseline_sequence") < lastMutationSequence
      || integer(row, "created_event_sequence") <= lastMutationSequence
      || integer(row, "created_event_sequence") <= integer(head, "baseline_sequence"))) {
      throw new AuthorityIntegrityError("Completion V2 evidence closure is incomplete or stale");
    }
    return rows;
  }

  private operationClosure(trigger: RecordWorkCellCompletionTriggerV2): readonly string[] {
    const rows = this.connection.prepare(`SELECT t.transition_sha256 FROM operation_heads_v1 h
      JOIN operation_transitions_v1 t ON t.attempt_id=h.attempt_id AND t.transition_sha256=h.transition_sha256
      WHERE h.goal_id=? AND h.work_cell_id=? AND h.state IN ('COMMITTED','FAILED','RECONCILED')
      ORDER BY t.transition_sha256`).all(trigger.goal_id, trigger.work_cell_id) as Record<string, unknown>[];
    const hashes = rows.map((row) => sha(row.transition_sha256, "Operation transition SHA-256"));
    if (hashes.length === 0) throw new AuthorityIntegrityError("Completion V2 has no terminal Operation closure");
    return hashes;
  }

  private eventHead(goalId: string): { readonly sequence: number; readonly sha256: string } {
    const row = this.connection.prepare("SELECT sequence,event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Completion predecessor event is missing");
    return {
      sequence: integer(row, "sequence"),
      sha256: sha(row.event_sha256, "Completion predecessor event"),
    };
  }

  private insertReceipt(receipt: WorkCellCompletionReceiptV2, stamp: CompletionTransactionStampV2): void {
    this.connection.prepare(`INSERT INTO work_cell_completion_receipts_v2(
      completion_receipt_id,goal_id,contract_id,route_id,work_cell_id,authority_root_id,revision,authorization_id,
      authorization_sha256,final_postimage_root_sha256,operation_closure_sha256,integration_root_sha256,
      preservation_review_sha256,evidence_binding_root_sha256,obligation_root_sha256,predecessor_authority_head_sha256,
      record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.completion_receipt_id, receipt.goal_id, receipt.contract_id, receipt.route_id, receipt.work_cell_id,
      receipt.authority_root_id, receipt.revision, receipt.authorization_id, receipt.authorization_sha256,
      receipt.final_postimage_root_sha256, receipt.operation_closure_sha256, receipt.integration_root_sha256,
      receipt.preservation_review_sha256, receipt.evidence_binding_root_sha256, receipt.obligation_root_sha256,
      receipt.predecessor_authority_head_sha256, receipt.record_sha256, stamp.created_at_ms, stamp.created_event_sequence,
    );
  }

  private insertMembers(
    receipt: WorkCellCompletionReceiptV2,
    evidenceIds: readonly string[],
    obligationIds: readonly string[],
    sequence: number,
  ): void {
    const evidenceInsert = this.connection.prepare(`INSERT INTO work_cell_completion_evidence_members_v2(
      completion_receipt_id,evidence_binding_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    evidenceIds.forEach((id, ordinal) => evidenceInsert.run(receipt.completion_receipt_id, id, receipt.authority_root_id,
      receipt.goal_id, receipt.contract_id, receipt.route_id, receipt.work_cell_id, ordinal, sequence));
    const obligationInsert = this.connection.prepare(`INSERT INTO work_cell_completion_obligation_members_v2(
      completion_receipt_id,acceptance_obligation_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    obligationIds.forEach((id, ordinal) => obligationInsert.run(receipt.completion_receipt_id, id, receipt.authority_root_id,
      receipt.goal_id, receipt.contract_id, receipt.route_id, receipt.work_cell_id, ordinal, sequence));
  }

  verifyIntegrity(): { readonly completions: number } {
    const rows = this.connection.prepare("SELECT * FROM work_cell_completion_receipts_v2 ORDER BY completion_receipt_id")
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const completionId = text(row, "completion_receipt_id");
      assertSealed("PCH-WORK-CELL-COMPLETION-RECEIPT-V2", {
        schema_version: 2, completion_receipt_id: completionId, goal_id: text(row, "goal_id"),
        contract_id: text(row, "contract_id"), route_id: text(row, "route_id"), work_cell_id: text(row, "work_cell_id"),
        authority_root_id: text(row, "authority_root_id"), revision: integer(row, "revision"),
        authorization_id: text(row, "authorization_id"), authorization_sha256: text(row, "authorization_sha256"),
        final_postimage_root_sha256: text(row, "final_postimage_root_sha256"),
        operation_closure_sha256: text(row, "operation_closure_sha256"), integration_root_sha256: text(row, "integration_root_sha256"),
        preservation_review_sha256: text(row, "preservation_review_sha256"),
        evidence_binding_root_sha256: text(row, "evidence_binding_root_sha256"),
        obligation_root_sha256: text(row, "obligation_root_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        record_sha256: text(row, "record_sha256"),
      });
      const evidence = this.connection.prepare(`SELECT e.record_sha256,r.requirement_kind,m.ordinal
        FROM work_cell_completion_evidence_members_v2 m
        JOIN acceptance_evidence_bindings_v2 e ON e.evidence_binding_id=m.evidence_binding_id
        JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=e.evidence_requirement_id
        WHERE m.completion_receipt_id=? ORDER BY m.ordinal`).all(completionId) as Record<string, unknown>[];
      evidence.forEach((member, ordinal) => {
        if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Completion V2 evidence ordinal gap");
      });
      const evidenceHashes = evidence.map((member) => sha(member.record_sha256, "Completion evidence SHA-256"));
      const preservationHashes = evidence.filter((member) => text(member, "requirement_kind") === "PRESERVATION_REVIEW")
        .map((member) => sha(member.record_sha256, "Completion preservation SHA-256"));
      const obligations = this.connection.prepare(`SELECT o.record_sha256,m.ordinal
        FROM work_cell_completion_obligation_members_v2 m
        JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=m.acceptance_obligation_id
        WHERE m.completion_receipt_id=? ORDER BY m.ordinal`).all(completionId) as Record<string, unknown>[];
      obligations.forEach((member, ordinal) => {
        if (integer(member, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Completion V2 obligation ordinal gap");
      });
      if (memberRoot("PCH-ACCEPTANCE-EVIDENCE-BINDING-ROOT-V2", evidenceHashes) !== text(row, "evidence_binding_root_sha256")
        || memberRoot("PCH-PRESERVATION-REVIEW-ROOT-V2", preservationHashes) !== text(row, "preservation_review_sha256")
        || memberRoot("PCH-COMPLETION-OBLIGATION-ROOT-V2", obligations.map((member) => sha(member.record_sha256, "Completion obligation SHA-256")))
          !== text(row, "obligation_root_sha256")) {
        throw new AuthorityIntegrityError("Completion V2 member closure mismatch");
      }
    }
    return { completions: rows.length };
  }
}
