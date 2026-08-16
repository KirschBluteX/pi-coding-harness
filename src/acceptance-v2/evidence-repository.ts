import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { idFromSha256 } from "../foundation/ids.js";
import { assertGoalContract, type GoalContractRecord } from "../task-flow/domain.js";
import { oracleCommands, workCellOracleCoversObligation } from "../task-flow/oracles.js";
import type {
  AcceptanceEvidenceBindingV2,
  OracleExecutionObservationV2,
  OraclePassReceiptV2,
} from "./domain.js";
import { currentExecutionLineageV2 } from "./execution-lineage.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface RecordOracleEvidenceTriggerV2 {
  readonly attempt_id: string;
}

export interface RecordOracleExecutionDescriptorTriggerV2 {
  readonly attempt_id: string;
  readonly command: string;
  readonly policy_sha256: string;
}

export interface OracleExecutionDescriptorV2 {
  readonly schema_version: 2;
  readonly descriptor_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly attempt_id: string;
  readonly command: string;
  readonly command_sha256: string;
  readonly evidence_role: "FROZEN_ORACLE" | "SUPPLEMENTAL_VALIDATION";
  readonly work_cell_oracle_sha256: string;
  readonly policy_sha256: string;
  readonly execution_fingerprint_sha256: string;
  readonly record_sha256: string;
}

export interface AuthorityTransactionStampV2 {
  readonly created_at_ms: number;
  readonly created_event_sequence: number;
}

export interface OraclePassReceiptStoredV2 extends OraclePassReceiptV2 {
  readonly observation_id: string;
}

export interface AcceptanceEvidenceWitnessV2 {
  readonly ordinal: number;
  readonly path_hmac: string;
  readonly locator_sha256: string;
  readonly content_sha256: string;
}

export interface OracleEvidenceClosureV2 {
  readonly observation: OracleExecutionObservationV2;
  readonly pass_receipt: OraclePassReceiptStoredV2;
  readonly evidence_binding: AcceptanceEvidenceBindingV2;
  readonly witnesses: readonly AcceptanceEvidenceWitnessV2[];
}

export interface OraclePassEvidenceRefV2 {
  readonly obligation_id: string;
  readonly oracle_pass_receipt_id: string;
  readonly oracle_pass_receipt_sha256: string;
  readonly evidence_requirement_id: string;
  readonly operation_attempt_id: string;
  readonly operation_attempt_sha256: string;
  readonly terminal_transition_id: string;
  readonly terminal_transition_sha256: string;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Acceptance evidence V2 ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Acceptance evidence V2 ${key} is invalid`);
  return value;
}

function jsonObject(row: Record<string, unknown>, key: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(text(row, key));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  } catch { /* normalized below */ }
  throw new AuthorityIntegrityError(`Acceptance evidence V2 ${key} is invalid JSON`);
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AuthorityIntegrityError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function sealed<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

function assertSealed(domain: string, value: Record<string, unknown>, label: string): void {
  const actual = text(value, "record_sha256");
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "record_sha256"));
  if (actual !== canonicalJsonSha256({ domain, ...body })) {
    throw new AuthorityIntegrityError(`${label} record hash mismatch`);
  }
}

function memberRoot(domain: string, hashes: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...hashes].sort() });
}

function assertStamp(stamp: AuthorityTransactionStampV2): void {
  if (!Number.isSafeInteger(stamp.created_at_ms) || stamp.created_at_ms < 0
    || !Number.isSafeInteger(stamp.created_event_sequence) || stamp.created_event_sequence < 1) {
    throw new AuthorityIntegrityError("Acceptance evidence V2 transaction stamp is invalid");
  }
}

/**
 * Creates evidence authority from stored Host facts. The Interface accepts only
 * stable references; verdicts, roots, identities and PASS are derived locally.
 */
export class AcceptanceEvidenceV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return this.connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='oracle_execution_descriptors_v2'",
    ).get() !== undefined;
  }

  recordOracleExecutionDescriptor(
    trigger: RecordOracleExecutionDescriptorTriggerV2,
    stamp: AuthorityTransactionStampV2,
  ): OracleExecutionDescriptorV2 {
    if (!this.connection.isTransaction) {
      throw new AuthorityIntegrityError("Oracle execution descriptor must be recorded inside the authority transaction");
    }
    assertStamp(stamp);
    const command = trigger.command.trim().normalize("NFC");
    if (!command || command.length > 8_192 || command.includes("\0") || command !== trigger.command) {
      throw new AuthorityIntegrityError("Oracle execution descriptor command is not canonical");
    }
    const policySha256 = sha(trigger.policy_sha256, "Oracle execution policy");
    const row = this.connection.prepare(`SELECT a.goal_id,a.work_cell_id,a.operation_kind,a.oracle_sha256,
        a.execution_fingerprint_sha256,c.oracle_json
      FROM operation_attempts_v1 a JOIN work_cells_v1 c ON c.work_cell_id=a.work_cell_id
      WHERE a.attempt_id=?`).get(trigger.attempt_id) as Record<string, unknown> | undefined;
    if (!row || text(row, "operation_kind") !== "VALIDATION") {
      throw new AuthorityIntegrityError("Oracle execution descriptor requires a stored validation attempt");
    }
    const workCellOracle = jsonObject(row, "oracle_json");
    const workCellOracleSha256 = canonicalJsonSha256(workCellOracle);
    if (workCellOracleSha256 !== text(row, "oracle_sha256")) {
      throw new AuthorityIntegrityError("Oracle execution descriptor does not match the frozen WorkCell oracle");
    }
    const commandSha256 = canonicalJsonSha256({ domain: "PCH-ORACLE-COMMAND-V2", command });
    const evidenceRole = oracleCommands(workCellOracle).includes(command)
      ? "FROZEN_ORACLE" as const : "SUPPLEMENTAL_VALIDATION" as const;
    const body = {
      schema_version: 2 as const,
      descriptor_id: idFromSha256("ORACLE_DESCRIPTOR", canonicalJsonSha256({
        attempt_id: trigger.attempt_id, command_sha256: commandSha256, policy_sha256: policySha256,
      })),
      goal_id: text(row, "goal_id"), work_cell_id: text(row, "work_cell_id"), attempt_id: trigger.attempt_id,
      command, command_sha256: commandSha256, evidence_role: evidenceRole,
      work_cell_oracle_sha256: workCellOracleSha256, policy_sha256: policySha256,
      execution_fingerprint_sha256: text(row, "execution_fingerprint_sha256"),
    };
    const descriptor = sealed("PCH-ORACLE-EXECUTION-DESCRIPTOR-V2", body);
    const result = this.connection.prepare(`INSERT INTO oracle_execution_descriptors_v2(
      descriptor_id,goal_id,work_cell_id,attempt_id,command_text,command_sha256,evidence_role,
      work_cell_oracle_sha256,policy_sha256,execution_fingerprint_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(descriptor_id) DO NOTHING`).run(
      descriptor.descriptor_id, descriptor.goal_id, descriptor.work_cell_id, descriptor.attempt_id,
      descriptor.command, descriptor.command_sha256, descriptor.evidence_role, descriptor.work_cell_oracle_sha256,
      descriptor.policy_sha256, descriptor.execution_fingerprint_sha256, descriptor.record_sha256,
      stamp.created_at_ms, stamp.created_event_sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.readOracleExecutionDescriptor(descriptor.descriptor_id);
      if (!existing || existing.record_sha256 !== descriptor.record_sha256) {
        throw new AuthorityIntegrityError("Oracle execution descriptor identity substitution");
      }
    }
    return descriptor;
  }

  recordOracleEvidence(
    trigger: RecordOracleEvidenceTriggerV2,
    stamp: AuthorityTransactionStampV2,
  ): readonly OracleEvidenceClosureV2[] {
    if (!this.connection.isTransaction) {
      throw new AuthorityIntegrityError("Acceptance evidence V2 must be recorded inside the authority transaction");
    }
    assertStamp(stamp);
    const operation = this.operationClosure(trigger.attempt_id, stamp.created_at_ms);
    const requirements = this.requirementClosures(operation);
    return requirements.map((requirement) => this.recordRequirementOracleEvidence(operation, requirement, stamp));
  }

  passEvidenceByAttempt(attemptId: string): readonly OraclePassEvidenceRefV2[] {
    return (this.connection.prepare(`SELECT o.task_obligation_id obligation_id,
        p.pass_receipt_id oracle_pass_receipt_id,p.record_sha256 oracle_pass_receipt_sha256,
        p.evidence_requirement_id,p.attempt_id operation_attempt_id,a.record_sha256 operation_attempt_sha256,
        p.terminal_transition_id,p.terminal_transition_sha256
      FROM oracle_pass_receipts_v2 p
      JOIN operation_attempts_v1 a ON a.attempt_id=p.attempt_id
      JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=p.evidence_requirement_id
      JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
      JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
      WHERE p.attempt_id=? ORDER BY o.task_obligation_id,p.pass_receipt_id`).all(
      attemptId,
    ) as Record<string, unknown>[]).map((row) => ({
      obligation_id: text(row, "obligation_id"),
      oracle_pass_receipt_id: text(row, "oracle_pass_receipt_id"),
      oracle_pass_receipt_sha256: text(row, "oracle_pass_receipt_sha256"),
      evidence_requirement_id: text(row, "evidence_requirement_id"),
      operation_attempt_id: text(row, "operation_attempt_id"),
      operation_attempt_sha256: text(row, "operation_attempt_sha256"),
      terminal_transition_id: text(row, "terminal_transition_id"),
      terminal_transition_sha256: text(row, "terminal_transition_sha256"),
    }));
  }

  private recordRequirementOracleEvidence(
    operation: Record<string, unknown>,
    requirement: Record<string, unknown>,
    stamp: AuthorityTransactionStampV2,
  ): OracleEvidenceClosureV2 {
    const baseline = this.freshPostimage(operation);
    const predecessor = this.eventHead(text(operation, "goal_id"));
    if (stamp.created_event_sequence !== predecessor.sequence + 1) {
      throw new AuthorityIntegrityError("Acceptance evidence V2 transaction sequence is not the next Goal event");
    }
    const lineage = currentExecutionLineageV2(this.connection, {
      goal_id: text(operation, "goal_id"), route_id: text(operation, "route_id"),
      work_cell_id: text(operation, "work_cell_id"), authorization_sha256: text(operation, "authorization_sha256"),
    });
    const integrationRoot = lineage.integration_root_sha256;
    const topologyRoot = lineage.topology_revision_sha256;
    const outputSha256 = sha(operation.output_sha256, "Validation output");

    const observation = sealed("PCH-ORACLE-EXECUTION-OBSERVATION-V2", {
      schema_version: 2 as const,
      observation_id: idFromSha256("ORACLE_OBSERVATION", canonicalJsonSha256({
        attempt: text(operation, "attempt_id"), transition: text(operation, "transition_sha256"), output: outputSha256,
      })),
      goal_id: text(operation, "goal_id"), work_cell_id: text(operation, "work_cell_id"),
      attempt_id: text(operation, "attempt_id"), terminal_transition_id: text(operation, "transition_id"),
      terminal_transition_sha256: text(operation, "transition_sha256"), observed_postcondition: "PASS" as const,
      output_sha256: outputSha256,
    });
    const passReceipt = sealed("PCH-ORACLE-PASS-RECEIPT-V2", {
      schema_version: 2 as const,
      pass_receipt_id: idFromSha256("ORACLE_PASS", canonicalJsonSha256({
        observation: observation.record_sha256, requirement: text(requirement, "evidence_requirement_id"),
        baseline: text(baseline, "record_sha256"), integration: integrationRoot, topology: topologyRoot,
      })),
      authority_root_id: text(requirement, "authority_root_id"), goal_id: text(operation, "goal_id"),
      contract_id: text(operation, "contract_id"), route_id: text(operation, "route_id"),
      work_cell_id: text(operation, "work_cell_id"), evidence_requirement_id: text(requirement, "evidence_requirement_id"),
      observation_id: observation.observation_id, attempt_id: observation.attempt_id,
      terminal_transition_id: observation.terminal_transition_id,
      terminal_transition_sha256: observation.terminal_transition_sha256,
      authorization_id: text(operation, "authorization_id"), authorization_sha256: text(operation, "authorization_sha256"),
      lease_generation: integer(operation, "lease_generation"), fencing_token: integer(operation, "fencing_token"),
      postimage_root_sha256: text(baseline, "content_root_sha256"),
      environment_sha256: text(baseline, "environment_sha256"), integration_root_sha256: integrationRoot,
      topology_revision_sha256: topologyRoot, observation_root_sha256: outputSha256,
      predecessor_authority_head_sha256: predecessor.sha256,
    });
    const witness: AcceptanceEvidenceWitnessV2 = {
      ordinal: 0,
      path_hmac: text(operation, "normalized_target_hmac"),
      locator_sha256: text(operation, "transition_sha256"),
      content_sha256: outputSha256,
    };
    const witnessHash = canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-EVIDENCE-WITNESS-V2", ...witness });
    const witnessRoot = memberRoot("PCH-ACCEPTANCE-EVIDENCE-WITNESS-ROOT-V2", [witnessHash]);
    const inputClosure = canonicalJsonSha256({
      authority: text(requirement, "authority_root_id"), requirement: text(requirement, "record_sha256"),
      authorization: text(operation, "authorization_sha256"), transition: observation.terminal_transition_sha256,
      postimage: text(baseline, "record_sha256"), environment: text(baseline, "environment_sha256"),
      integration: integrationRoot, topology: topologyRoot,
    });
    const evidenceBinding = sealed("PCH-ACCEPTANCE-EVIDENCE-BINDING-V2", {
      schema_version: 2 as const,
      evidence_binding_id: idFromSha256("EVIDENCE_BINDING", canonicalJsonSha256({
        pass: passReceipt.record_sha256, binding: text(requirement, "binding_id"), witness: witnessRoot,
      })),
      authority_root_id: text(requirement, "authority_root_id"), goal_id: text(operation, "goal_id"),
      contract_id: text(operation, "contract_id"), work_cell_id: text(operation, "work_cell_id"),
      facet_obligation_binding_id: text(requirement, "binding_id"),
      evidence_requirement_id: text(requirement, "evidence_requirement_id"),
      pass_receipt_id: passReceipt.pass_receipt_id, input_closure_sha256: inputClosure,
      witness_root_sha256: witnessRoot,
    });

    this.insertObservation(observation, stamp);
    this.insertPassReceipt(passReceipt, stamp);
    this.insertBinding(evidenceBinding, witness, stamp);
    return { observation, pass_receipt: passReceipt, evidence_binding: evidenceBinding, witnesses: [witness] };
  }

  private readOracleExecutionDescriptor(descriptorId: string): OracleExecutionDescriptorV2 | null {
    const row = this.connection.prepare("SELECT * FROM oracle_execution_descriptors_v2 WHERE descriptor_id=?")
      .get(descriptorId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const descriptor: OracleExecutionDescriptorV2 = {
      schema_version: 2,
      descriptor_id: text(row, "descriptor_id"), goal_id: text(row, "goal_id"),
      work_cell_id: text(row, "work_cell_id"), attempt_id: text(row, "attempt_id"),
      command: text(row, "command_text"), command_sha256: text(row, "command_sha256"),
      evidence_role: text(row, "evidence_role") as OracleExecutionDescriptorV2["evidence_role"],
      work_cell_oracle_sha256: text(row, "work_cell_oracle_sha256"),
      policy_sha256: text(row, "policy_sha256"),
      execution_fingerprint_sha256: text(row, "execution_fingerprint_sha256"),
      record_sha256: text(row, "record_sha256"),
    };
    assertSealed("PCH-ORACLE-EXECUTION-DESCRIPTOR-V2", descriptor as unknown as Record<string, unknown>, "Oracle execution descriptor");
    const expectedId = idFromSha256("ORACLE_DESCRIPTOR", canonicalJsonSha256({
      attempt_id: descriptor.attempt_id,
      command_sha256: descriptor.command_sha256,
      policy_sha256: descriptor.policy_sha256,
    }));
    if (descriptor.command !== descriptor.command.trim().normalize("NFC")
      || canonicalJsonSha256({ domain: "PCH-ORACLE-COMMAND-V2", command: descriptor.command }) !== descriptor.command_sha256
      || descriptor.descriptor_id !== expectedId
      || !["FROZEN_ORACLE", "SUPPLEMENTAL_VALIDATION"].includes(descriptor.evidence_role)) {
      throw new AuthorityIntegrityError("Stored oracle execution descriptor is invalid");
    }
    return descriptor;
  }

  private operationClosure(attemptId: string, nowMs: number): Record<string, unknown> {
    const row = this.connection.prepare(`SELECT a.attempt_id,a.goal_id,a.work_cell_id,a.authorization_id,
        a.operation_kind,a.normalized_target_hmac,a.environment_sha256,a.oracle_sha256,
        a.execution_fingerprint_sha256 AS attempt_execution_fingerprint_sha256,
        d.descriptor_id,d.command_text,d.command_sha256,d.evidence_role,d.work_cell_oracle_sha256,
        d.policy_sha256,d.execution_fingerprint_sha256 AS descriptor_execution_fingerprint_sha256,d.record_sha256 AS descriptor_record_sha256,
        h.state,t.transition_id,t.transition_sha256,t.output_sha256,t.postcondition,t.created_event_sequence AS terminal_sequence,
        z.contract_id,z.route_id,z.work_cell_id AS authorized_work_cell_id,
        z.record_sha256 AS authorization_sha256,z.lease_generation,z.fencing_token,
        z.revoked_at_ms,z.expires_at_ms AS authorization_expires_at_ms,c.obligation_ids_json,c.oracle_json,
        wh.status AS work_cell_status,ch.contract_id AS current_contract_id,rh.route_id AS current_route_id,
        l.generation AS current_lease_generation,l.fencing_token AS current_fencing_token,l.expires_at_ms AS lease_expires_at_ms,
        p.state AS predecessor_state
      FROM operation_attempts_v1 a JOIN operation_heads_v1 h ON h.attempt_id=a.attempt_id
      JOIN oracle_execution_descriptors_v2 d ON d.attempt_id=a.attempt_id
      JOIN operation_transitions_v1 t ON t.attempt_id=h.attempt_id AND t.transition_sha256=h.transition_sha256
      JOIN execution_authorizations_v1 z ON z.authorization_id=a.authorization_id
      LEFT JOIN operation_transitions_v1 p ON p.attempt_id=t.attempt_id AND p.transition_sha256=t.predecessor_sha256
      JOIN work_cells_v1 c ON c.work_cell_id=a.work_cell_id JOIN work_cell_heads_v1 wh ON wh.work_cell_id=c.work_cell_id
      JOIN goal_contract_heads_v1 ch ON ch.goal_id=a.goal_id JOIN route_skeleton_heads_v1 rh ON rh.goal_id=a.goal_id
      JOIN execution_leases l ON l.goal_id=a.goal_id WHERE a.attempt_id=?`).get(attemptId) as Record<string, unknown> | undefined;
    if (row && text(row, "evidence_role") !== "FROZEN_ORACLE") {
      throw new AuthorityIntegrityError("Supplemental validation cannot authorize frozen Acceptance evidence");
    }
    if (!row || text(row, "operation_kind") !== "VALIDATION"
      || text(row, "state") !== "COMMITTED" || text(row, "predecessor_state") !== "OBSERVED"
      || text(row, "postcondition") !== "PASS" || row.output_sha256 === null
      || text(row, "work_cell_status") !== "RUNNING" || row.revoked_at_ms !== null
      || text(row, "work_cell_id") !== text(row, "authorized_work_cell_id")
      || text(row, "contract_id") !== text(row, "current_contract_id")
      || text(row, "route_id") !== text(row, "current_route_id")
      || integer(row, "lease_generation") !== integer(row, "current_lease_generation")
      || integer(row, "fencing_token") !== integer(row, "current_fencing_token")
      || text(row, "attempt_execution_fingerprint_sha256") !== text(row, "descriptor_execution_fingerprint_sha256")
      || integer(row, "authorization_expires_at_ms") <= nowMs || integer(row, "lease_expires_at_ms") <= nowMs) {
      throw new AuthorityIntegrityError("Oracle evidence requires a current fenced terminal Host validation PASS");
    }
    const descriptor = this.readOracleExecutionDescriptor(text(row, "descriptor_id"));
    if (!descriptor || descriptor.record_sha256 !== text(row, "descriptor_record_sha256")) {
      throw new AuthorityIntegrityError("Oracle evidence requires an intact Host execution descriptor");
    }
    return row;
  }

  private requirementClosures(operation: Record<string, unknown>): readonly Record<string, unknown>[] {
    const rows = this.connection.prepare(`SELECT r.evidence_requirement_id,r.binding_id,r.frozen_oracle_sha256,
        r.freshness_policy,r.execution_owner,r.record_sha256,m.authority_root_id,ar.goal_id,ar.contract_id,
        b.acceptance_obligation_id,o.task_obligation_id,g.contract_json
      FROM evidence_requirements_v2 r JOIN acceptance_authority_requirement_members_v2 m
        ON m.evidence_requirement_id=r.evidence_requirement_id
      JOIN acceptance_authority_roots_v2 ar ON ar.authority_root_id=m.authority_root_id
      JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
      JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
      JOIN goal_contract_versions_v1 g ON g.contract_id=ar.contract_id
      WHERE ar.goal_id=? AND ar.contract_id=? ORDER BY r.evidence_requirement_id`)
      .all(text(operation, "goal_id"), text(operation, "contract_id")) as Record<string, unknown>[];
    let obligationIds: unknown;
    try { obligationIds = JSON.parse(text(operation, "obligation_ids_json")); } catch { obligationIds = null; }
    if (!Array.isArray(obligationIds) || obligationIds.some((value) => typeof value !== "string")) {
      throw new AuthorityIntegrityError("Authorized WorkCell obligation closure is invalid");
    }
    const workCellOracle = jsonObject(operation, "oracle_json");
    if (text(operation, "oracle_sha256") !== canonicalJsonSha256(workCellOracle)
      || text(operation, "work_cell_oracle_sha256") !== text(operation, "oracle_sha256")
      || canonicalJsonSha256({ domain: "PCH-ORACLE-COMMAND-V2", command: text(operation, "command_text") })
        !== text(operation, "command_sha256")) {
      throw new AuthorityIntegrityError("Stored oracle execution descriptor is outside the current WorkCell oracle");
    }
    const eligible = rows.filter((row) => {
      if (text(row, "goal_id") !== text(operation, "goal_id")
        || text(row, "contract_id") !== text(operation, "contract_id")
        || text(row, "freshness_policy") !== "CURRENT_POSTIMAGE" || text(row, "execution_owner") !== "HOST") {
        throw new AuthorityIntegrityError("Frozen Host evidence requirement closure is invalid");
      }
      if (!(obligationIds as string[]).includes(text(row, "task_obligation_id"))) return false;
      const contractValue = jsonObject(row, "contract_json");
      assertGoalContract(contractValue);
      const contract: GoalContractRecord = contractValue;
      const obligation = contract.obligations.find((entry) => entry.obligation_id === text(row, "task_obligation_id"));
      if (!obligation || text(row, "frozen_oracle_sha256") !== canonicalJsonSha256(obligation.oracle)
        || !workCellOracleCoversObligation(workCellOracle, obligation)) {
        throw new AuthorityIntegrityError("Frozen evidence requirement is not covered by its authorized WorkCell oracle");
      }
      return oracleCommands(obligation.oracle).includes(text(operation, "command_text"));
    });
    if (eligible.length === 0) {
      throw new AuthorityIntegrityError("Executed oracle command does not cover any current frozen Host evidence requirement");
    }
    return eligible;
  }

  private freshPostimage(operation: Record<string, unknown>): Record<string, unknown> {
    const row = this.connection.prepare(`SELECT baseline_id,content_root_sha256,environment_sha256,record_sha256,created_event_sequence
      FROM workspace_baselines_v1 WHERE goal_id=? ORDER BY created_event_sequence DESC LIMIT 1`)
      .get(text(operation, "goal_id")) as Record<string, unknown> | undefined;
    const lastMutation = Number((this.connection.prepare(`SELECT COALESCE(MAX(t.created_event_sequence),0) sequence
      FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
      WHERE a.goal_id=? AND a.work_cell_id=? AND a.operation_kind IN ('WRITE','EDIT','DELETE','MOVE','COMMAND')
        AND t.state='COMMITTED'`).get(text(operation, "goal_id"), text(operation, "work_cell_id")) as Record<string, unknown>).sequence);
    if (!row || text(row, "environment_sha256") !== text(operation, "environment_sha256")
      || integer(row, "created_event_sequence") <= integer(operation, "terminal_sequence")
      || integer(row, "created_event_sequence") < lastMutation) {
      throw new AuthorityIntegrityError("Oracle evidence requires a current post-validation Host baseline");
    }
    return row;
  }

  private eventHead(goalId: string): { readonly sha256: string; readonly sequence: number } {
    const row = this.connection.prepare("SELECT sequence,event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Acceptance evidence predecessor event head is missing");
    return {
      sha256: sha(row.event_sha256, "Acceptance evidence predecessor event head"),
      sequence: integer(row, "sequence"),
    };
  }

  private insertObservation(record: OracleExecutionObservationV2, stamp: AuthorityTransactionStampV2): void {
    const result = this.connection.prepare(`INSERT INTO oracle_execution_observations_v2(
      observation_id,goal_id,work_cell_id,attempt_id,terminal_transition_id,terminal_transition_sha256,
      observed_postcondition,output_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id) DO NOTHING`).run(
      record.observation_id, record.goal_id, record.work_cell_id, record.attempt_id, record.terminal_transition_id,
      record.terminal_transition_sha256, record.observed_postcondition, record.output_sha256, record.record_sha256,
      stamp.created_at_ms, stamp.created_event_sequence,
    );
    if (Number(result.changes) === 0) {
      const existing = this.connection.prepare(`SELECT goal_id,work_cell_id,attempt_id,terminal_transition_id,
        terminal_transition_sha256,observed_postcondition,output_sha256,record_sha256
        FROM oracle_execution_observations_v2 WHERE observation_id=?`).get(record.observation_id) as
        Record<string, unknown> | undefined;
      if (!existing || text(existing, "goal_id") !== record.goal_id
        || text(existing, "work_cell_id") !== record.work_cell_id
        || text(existing, "attempt_id") !== record.attempt_id
        || text(existing, "terminal_transition_id") !== record.terminal_transition_id
        || text(existing, "terminal_transition_sha256") !== record.terminal_transition_sha256
        || text(existing, "observed_postcondition") !== record.observed_postcondition
        || text(existing, "output_sha256") !== record.output_sha256
        || text(existing, "record_sha256") !== record.record_sha256) {
        throw new AuthorityIntegrityError("Oracle observation identity substitution");
      }
    }
  }

  private insertPassReceipt(record: OraclePassReceiptStoredV2, stamp: AuthorityTransactionStampV2): void {
    this.connection.prepare(`INSERT INTO oracle_pass_receipts_v2(
      pass_receipt_id,authority_root_id,goal_id,contract_id,route_id,work_cell_id,evidence_requirement_id,
      observation_id,attempt_id,terminal_transition_id,terminal_transition_sha256,authorization_id,authorization_sha256,
      lease_generation,fencing_token,postimage_root_sha256,environment_sha256,integration_root_sha256,
      topology_revision_sha256,observation_root_sha256,predecessor_authority_head_sha256,record_sha256,
      created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.pass_receipt_id, record.authority_root_id, record.goal_id, record.contract_id, record.route_id,
      record.work_cell_id, record.evidence_requirement_id, record.observation_id, record.attempt_id,
      record.terminal_transition_id, record.terminal_transition_sha256, record.authorization_id,
      record.authorization_sha256, record.lease_generation, record.fencing_token, record.postimage_root_sha256,
      record.environment_sha256, record.integration_root_sha256, record.topology_revision_sha256,
      record.observation_root_sha256, record.predecessor_authority_head_sha256, record.record_sha256,
      stamp.created_at_ms, stamp.created_event_sequence,
    );
  }

  private insertBinding(
    record: AcceptanceEvidenceBindingV2,
    witness: AcceptanceEvidenceWitnessV2,
    stamp: AuthorityTransactionStampV2,
  ): void {
    this.connection.prepare(`INSERT INTO acceptance_evidence_bindings_v2(
      evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id,facet_obligation_binding_id,
      evidence_requirement_id,pass_receipt_id,input_closure_sha256,witness_root_sha256,record_sha256,
      created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.evidence_binding_id, record.authority_root_id, record.goal_id, record.contract_id, record.work_cell_id,
      record.facet_obligation_binding_id, record.evidence_requirement_id, record.pass_receipt_id,
      record.input_closure_sha256, record.witness_root_sha256, record.record_sha256,
      stamp.created_at_ms, stamp.created_event_sequence,
    );
    this.connection.prepare(`INSERT INTO acceptance_evidence_witness_members_v2(
      evidence_binding_id,authority_root_id,goal_id,contract_id,work_cell_id,ordinal,path_hmac,
      locator_sha256,content_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      record.evidence_binding_id, record.authority_root_id, record.goal_id, record.contract_id,
      record.work_cell_id, witness.ordinal, witness.path_hmac, witness.locator_sha256,
      witness.content_sha256, stamp.created_event_sequence,
    );
  }

  verifyIntegrity(): { readonly observations: number; readonly passReceipts: number; readonly evidenceBindings: number } {
    const descriptorRows = this.connection.prepare(
      "SELECT * FROM oracle_execution_descriptors_v2 ORDER BY descriptor_id",
    ).all() as Record<string, unknown>[];
    const descriptorAttempts = new Set<string>();
    for (const row of descriptorRows) {
      const descriptor = this.readOracleExecutionDescriptor(text(row, "descriptor_id"));
      const host = this.connection.prepare(`SELECT a.goal_id,a.work_cell_id,a.operation_kind,a.oracle_sha256,
          a.execution_fingerprint_sha256,c.oracle_json
        FROM operation_attempts_v1 a JOIN work_cells_v1 c ON c.work_cell_id=a.work_cell_id
        WHERE a.attempt_id=?`).get(text(row, "attempt_id")) as Record<string, unknown> | undefined;
      const event = this.connection.prepare("SELECT payload_json FROM events WHERE goal_id=? AND sequence=?")
        .get(text(row, "goal_id"), integer(row, "created_event_sequence")) as Record<string, unknown> | undefined;
      let eventDescriptors: unknown = null;
      try { eventDescriptors = event ? jsonObject(event, "payload_json").oracleDescriptorIds : null; } catch { /* invalid below */ }
      if (!descriptor || !host || text(host, "operation_kind") !== "VALIDATION"
        || descriptor.goal_id !== text(host, "goal_id") || descriptor.work_cell_id !== text(host, "work_cell_id")
        || descriptor.work_cell_oracle_sha256 !== text(host, "oracle_sha256")
        || descriptor.execution_fingerprint_sha256 !== text(host, "execution_fingerprint_sha256")
        || descriptor.evidence_role !== (oracleCommands(jsonObject(host, "oracle_json")).includes(descriptor.command)
          ? "FROZEN_ORACLE" : "SUPPLEMENTAL_VALIDATION")
        || !Array.isArray(eventDescriptors) || !eventDescriptors.includes(descriptor.descriptor_id)) {
        throw new AuthorityIntegrityError("Oracle execution descriptor does not rebuild from its Host attempt event");
      }
      descriptorAttempts.add(descriptor.attempt_id);
    }
    const observations = this.connection.prepare("SELECT * FROM oracle_execution_observations_v2 ORDER BY observation_id")
      .all() as Record<string, unknown>[];
    const observationsById = new Map<string, Record<string, unknown>>();
    for (const row of observations) {
      const observationId = text(row, "observation_id");
      assertSealed("PCH-ORACLE-EXECUTION-OBSERVATION-V2", {
        schema_version: 2, observation_id: observationId, goal_id: text(row, "goal_id"),
        work_cell_id: text(row, "work_cell_id"), attempt_id: text(row, "attempt_id"),
        terminal_transition_id: text(row, "terminal_transition_id"),
        terminal_transition_sha256: text(row, "terminal_transition_sha256"),
        observed_postcondition: text(row, "observed_postcondition"), output_sha256: text(row, "output_sha256"),
        record_sha256: text(row, "record_sha256"),
      }, "Oracle observation");
      const expectedId = idFromSha256("ORACLE_OBSERVATION", canonicalJsonSha256({
        attempt: text(row, "attempt_id"), transition: text(row, "terminal_transition_sha256"),
        output: text(row, "output_sha256"),
      }));
      const host = this.connection.prepare(`SELECT a.goal_id,a.work_cell_id,a.operation_kind,
          t.state,t.postcondition,t.output_sha256,t.transition_sha256,p.state AS predecessor_state
        FROM operation_attempts_v1 a JOIN operation_transitions_v1 t ON t.attempt_id=a.attempt_id
        LEFT JOIN operation_transitions_v1 p ON p.attempt_id=t.attempt_id AND p.transition_sha256=t.predecessor_sha256
        WHERE a.attempt_id=? AND t.transition_id=?`).get(
        text(row, "attempt_id"), text(row, "terminal_transition_id"),
      ) as Record<string, unknown> | undefined;
      if (observationId !== expectedId || !descriptorAttempts.has(text(row, "attempt_id"))
        || !host || text(host, "goal_id") !== text(row, "goal_id")
        || text(host, "work_cell_id") !== text(row, "work_cell_id")
        || text(host, "operation_kind") !== "VALIDATION" || text(host, "state") !== "COMMITTED"
        || text(host, "predecessor_state") !== "OBSERVED" || text(host, "postcondition") !== "PASS"
        || text(row, "observed_postcondition") !== "PASS"
        || text(host, "output_sha256") !== text(row, "output_sha256")
        || text(host, "transition_sha256") !== text(row, "terminal_transition_sha256")) {
        throw new AuthorityIntegrityError("Oracle observation is not a committed Host PASS observation");
      }
      observationsById.set(observationId, row);
    }
    const passes = this.connection.prepare("SELECT * FROM oracle_pass_receipts_v2 ORDER BY pass_receipt_id")
      .all() as Record<string, unknown>[];
    const passesById = new Map<string, Record<string, unknown>>();
    const passBaselineById = new Map<string, string>();
    for (const row of passes) {
      const passReceiptId = text(row, "pass_receipt_id");
      assertSealed("PCH-ORACLE-PASS-RECEIPT-V2", {
        schema_version: 2, pass_receipt_id: text(row, "pass_receipt_id"), authority_root_id: text(row, "authority_root_id"),
        goal_id: text(row, "goal_id"), contract_id: text(row, "contract_id"), route_id: text(row, "route_id"),
        work_cell_id: text(row, "work_cell_id"), evidence_requirement_id: text(row, "evidence_requirement_id"),
        observation_id: text(row, "observation_id"), attempt_id: text(row, "attempt_id"),
        terminal_transition_id: text(row, "terminal_transition_id"), terminal_transition_sha256: text(row, "terminal_transition_sha256"),
        authorization_id: text(row, "authorization_id"), authorization_sha256: text(row, "authorization_sha256"),
        lease_generation: integer(row, "lease_generation"), fencing_token: integer(row, "fencing_token"),
        postimage_root_sha256: text(row, "postimage_root_sha256"), environment_sha256: text(row, "environment_sha256"),
        integration_root_sha256: text(row, "integration_root_sha256"), topology_revision_sha256: text(row, "topology_revision_sha256"),
        observation_root_sha256: text(row, "observation_root_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        record_sha256: text(row, "record_sha256"),
      }, "Oracle PASS receipt");
      const observation = observationsById.get(text(row, "observation_id"));
      const requirement = this.connection.prepare(`SELECT r.record_sha256,r.binding_id
        FROM evidence_requirements_v2 r JOIN acceptance_authority_requirement_members_v2 m
          ON m.evidence_requirement_id=r.evidence_requirement_id
        WHERE m.authority_root_id=? AND r.evidence_requirement_id=?`).get(
        text(row, "authority_root_id"), text(row, "evidence_requirement_id"),
      ) as Record<string, unknown> | undefined;
      const authorization = this.connection.prepare(`SELECT goal_id,contract_id,route_id,work_cell_id,
        record_sha256,lease_generation,fencing_token FROM execution_authorizations_v1 WHERE authorization_id=?`)
        .get(text(row, "authorization_id")) as Record<string, unknown> | undefined;
      const predecessor = this.connection.prepare("SELECT event_sha256 FROM events WHERE goal_id=? AND sequence=?")
        .get(text(row, "goal_id"), integer(row, "created_event_sequence") - 1) as Record<string, unknown> | undefined;
      const baselines = this.connection.prepare(`SELECT b.record_sha256 FROM workspace_baselines_v1 b
        JOIN operation_transitions_v1 t ON t.transition_id=?
        WHERE b.goal_id=? AND b.content_root_sha256=? AND b.environment_sha256=?
          AND b.created_event_sequence>t.created_event_sequence AND b.created_event_sequence<?`)
        .all(text(row, "terminal_transition_id"), text(row, "goal_id"), text(row, "postimage_root_sha256"),
          text(row, "environment_sha256"), integer(row, "created_event_sequence")) as Record<string, unknown>[];
      const matchedBaselines = baselines.map((entry) => text(entry, "record_sha256")).filter((baselineSha256) =>
        passReceiptId === idFromSha256("ORACLE_PASS", canonicalJsonSha256({
          observation: observation ? text(observation, "record_sha256") : "",
          requirement: text(row, "evidence_requirement_id"), baseline: baselineSha256,
          integration: text(row, "integration_root_sha256"), topology: text(row, "topology_revision_sha256"),
        })));
      if (!observation || text(observation, "goal_id") !== text(row, "goal_id")
        || text(observation, "work_cell_id") !== text(row, "work_cell_id")
        || text(observation, "attempt_id") !== text(row, "attempt_id")
        || text(observation, "terminal_transition_id") !== text(row, "terminal_transition_id")
        || text(observation, "terminal_transition_sha256") !== text(row, "terminal_transition_sha256")
        || text(observation, "output_sha256") !== text(row, "observation_root_sha256")
        || !requirement || !authorization || matchedBaselines.length !== 1
        || text(authorization, "goal_id") !== text(row, "goal_id")
        || text(authorization, "contract_id") !== text(row, "contract_id")
        || text(authorization, "route_id") !== text(row, "route_id")
        || text(authorization, "work_cell_id") !== text(row, "work_cell_id")
        || text(authorization, "record_sha256") !== text(row, "authorization_sha256")
        || integer(authorization, "lease_generation") !== integer(row, "lease_generation")
        || integer(authorization, "fencing_token") !== integer(row, "fencing_token")
        || !predecessor || text(predecessor, "event_sha256") !== text(row, "predecessor_authority_head_sha256")) {
        throw new AuthorityIntegrityError("Oracle PASS receipt does not bind a PASS observation");
      }
      passesById.set(passReceiptId, row);
      passBaselineById.set(passReceiptId, matchedBaselines[0]!);
    }
    const bindings = this.connection.prepare("SELECT * FROM acceptance_evidence_bindings_v2 ORDER BY evidence_binding_id")
      .all() as Record<string, unknown>[];
    for (const row of bindings) {
      assertSealed("PCH-ACCEPTANCE-EVIDENCE-BINDING-V2", {
        schema_version: 2, evidence_binding_id: text(row, "evidence_binding_id"),
        authority_root_id: text(row, "authority_root_id"), goal_id: text(row, "goal_id"),
        contract_id: text(row, "contract_id"), work_cell_id: text(row, "work_cell_id"),
        facet_obligation_binding_id: text(row, "facet_obligation_binding_id"),
        evidence_requirement_id: text(row, "evidence_requirement_id"), pass_receipt_id: text(row, "pass_receipt_id"),
        input_closure_sha256: text(row, "input_closure_sha256"), witness_root_sha256: text(row, "witness_root_sha256"),
        record_sha256: text(row, "record_sha256"),
      }, "Acceptance evidence binding");
      const pass = passesById.get(text(row, "pass_receipt_id"));
      const requirement = this.connection.prepare("SELECT binding_id,record_sha256 FROM evidence_requirements_v2 WHERE evidence_requirement_id=?")
        .get(text(row, "evidence_requirement_id")) as Record<string, unknown> | undefined;
      const baselineSha256 = passBaselineById.get(text(row, "pass_receipt_id"));
      const expectedBindingId = pass && requirement ? idFromSha256("EVIDENCE_BINDING", canonicalJsonSha256({
        pass: text(pass, "record_sha256"), binding: text(requirement, "binding_id"),
        witness: text(row, "witness_root_sha256"),
      })) : null;
      const expectedInputClosure = pass && requirement && baselineSha256 ? canonicalJsonSha256({
        authority: text(pass, "authority_root_id"), requirement: text(requirement, "record_sha256"),
        authorization: text(pass, "authorization_sha256"), transition: text(pass, "terminal_transition_sha256"),
        postimage: baselineSha256, environment: text(pass, "environment_sha256"),
        integration: text(pass, "integration_root_sha256"), topology: text(pass, "topology_revision_sha256"),
      }) : null;
      if (!pass || text(pass, "authority_root_id") !== text(row, "authority_root_id")
        || text(pass, "goal_id") !== text(row, "goal_id") || text(pass, "contract_id") !== text(row, "contract_id")
        || text(pass, "work_cell_id") !== text(row, "work_cell_id")
        || text(pass, "evidence_requirement_id") !== text(row, "evidence_requirement_id")
        || !requirement || text(requirement, "binding_id") !== text(row, "facet_obligation_binding_id")
        || text(row, "evidence_binding_id") !== expectedBindingId
        || text(row, "input_closure_sha256") !== expectedInputClosure) {
        throw new AuthorityIntegrityError("Acceptance evidence binding does not bind its PASS receipt");
      }
      const witnesses = this.connection.prepare(`SELECT ordinal,path_hmac,locator_sha256,content_sha256
        FROM acceptance_evidence_witness_members_v2 WHERE evidence_binding_id=? ORDER BY ordinal`)
        .all(text(row, "evidence_binding_id")) as Record<string, unknown>[];
      const hashes = witnesses.map((witness, ordinal) => {
        if (integer(witness, "ordinal") !== ordinal) throw new AuthorityIntegrityError("Evidence witness ordinal gap");
        return canonicalJsonSha256({ domain: "PCH-ACCEPTANCE-EVIDENCE-WITNESS-V2", ordinal,
          path_hmac: text(witness, "path_hmac"), locator_sha256: text(witness, "locator_sha256"),
          content_sha256: text(witness, "content_sha256") });
      });
      if (hashes.length !== 1
        || memberRoot("PCH-ACCEPTANCE-EVIDENCE-WITNESS-ROOT-V2", hashes) !== text(row, "witness_root_sha256")) {
        throw new AuthorityIntegrityError("Acceptance evidence witness closure mismatch");
      }
    }
    return { observations: observations.length, passReceipts: passes.length, evidenceBindings: bindings.length };
  }
}
