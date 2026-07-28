import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { canonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";

export type StoredEffectClass = "READ_ONLY" | "LOCAL_REVERSIBLE_WRITE" | "EXTERNAL_IDEMPOTENT_WRITE" | "EXTERNAL_UNKNOWN_WRITE" | "IRREVERSIBLE";
export type StoredEffectOutcome = "COMMITTED" | "FAILED" | "UNKNOWN_OUTCOME" | "RECONCILED_COMMITTED" | "RECONCILED_FAILED";

export interface PreparedEffectRecord {
  readonly goalId: string;
  readonly workItem: {
    readonly workItemId: string;
    readonly planId: string;
    readonly stageId: string;
    readonly logicalKey: string;
    readonly actionSpec: Readonly<Record<string, unknown>>;
    readonly effectClass: StoredEffectClass;
    readonly specSha256: string;
    readonly declaredInputClosureSha256: string | null;
  };
  readonly attempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly leaseGeneration: number;
    readonly fencingToken: number;
  };
  readonly effect: {
    readonly effectId: string;
    readonly normalizedTargetSha256: string;
    readonly normalizedPayloadSha256: string;
    readonly idempotencyKeyHmac: string;
    readonly preconditionSha256: string | null;
    readonly intentReceiptId: string;
  };
}

export class EffectRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertWorkItemAndAttempt(input: PreparedEffectRecord, startedAtMs: number, eventSequence: number): void {
    const stage = this.connection.prepare("SELECT plan_id,goal_id FROM plan_stages WHERE stage_id=?").get(input.workItem.stageId) as { plan_id?: unknown; goal_id?: unknown } | undefined;
    if (stage?.plan_id !== input.workItem.planId || stage.goal_id !== input.goalId) {
      throw new AuthorityIntegrityError("Effect WorkItem Stage/Plan/Goal binding failed");
    }
    this.connection.prepare(`INSERT OR IGNORE INTO work_items(
      work_item_id,goal_id,plan_id,stage_id,logical_key,action_spec_json,effect_class,spec_sha256,
      declared_input_closure_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      input.workItem.workItemId, input.goalId, input.workItem.planId, input.workItem.stageId,
      input.workItem.logicalKey, canonicalJson(input.workItem.actionSpec), input.workItem.effectClass,
      input.workItem.specSha256, input.workItem.declaredInputClosureSha256, eventSequence,
    );
    const existing = this.connection.prepare("SELECT goal_id,plan_id,stage_id,effect_class,spec_sha256 FROM work_items WHERE work_item_id=?").get(input.workItem.workItemId) as Record<string, unknown> | undefined;
    if (!existing || existing.goal_id !== input.goalId || existing.plan_id !== input.workItem.planId
      || existing.stage_id !== input.workItem.stageId || existing.effect_class !== input.workItem.effectClass
      || existing.spec_sha256 !== input.workItem.specSha256) {
      throw new AuthorityIntegrityError("WorkItem identity substitution detected");
    }
    this.connection.prepare(`INSERT INTO attempts(
      attempt_id,work_item_id,attempt_number,lease_generation,fencing_token,started_at_ms
    ) VALUES(?,?,?,?,?,?)`).run(
      input.attempt.attemptId, input.workItem.workItemId, input.attempt.attemptNumber,
      input.attempt.leaseGeneration, input.attempt.fencingToken, startedAtMs,
    );
  }

  insertEffect(input: PreparedEffectRecord, eventSequence: number): void {
    this.connection.prepare(`INSERT INTO effects(
      effect_id,goal_id,work_item_id,attempt_id,effect_class,normalized_target_sha256,
      normalized_payload_sha256,idempotency_key_hmac,precondition_sha256,intent_receipt_id,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.effect.effectId, input.goalId, input.workItem.workItemId, input.attempt.attemptId,
      input.workItem.effectClass, input.effect.normalizedTargetSha256, input.effect.normalizedPayloadSha256,
      input.effect.idempotencyKeyHmac, input.effect.preconditionSha256, input.effect.intentReceiptId, eventSequence,
    );
  }

  attemptId(effectId: string, goalId: string): string {
    const row = this.connection.prepare("SELECT attempt_id FROM effects WHERE effect_id=? AND goal_id=?").get(effectId, goalId) as { attempt_id?: unknown } | undefined;
    if (typeof row?.attempt_id !== "string") throw new AuthorityIntegrityError(`Effect ${effectId} does not exist for Goal ${goalId}`);
    return row.attempt_id;
  }

  insertOutcome(input: {
    readonly outcomeId: string;
    readonly effectId: string;
    readonly outcome: StoredEffectOutcome;
    readonly outcomeReceiptId: string;
    readonly targetReadbackSha256: string | null;
  }, endedAtMs: number, eventSequence: number): void {
    const attemptId = this.attemptId(input.effectId, this.goalId(input.effectId));
    const attemptOutcome = input.outcome === "COMMITTED" || input.outcome === "RECONCILED_COMMITTED" ? "SUCCEEDED"
      : input.outcome === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "FAILED";
    this.connection.prepare("UPDATE attempts SET ended_at_ms=?,outcome=? WHERE attempt_id=?")
      .run(endedAtMs, attemptOutcome, attemptId);
    // UNKNOWN_OUTCOME deliberately leaves the unique terminal row empty so later reconciliation can append a final outcome.
    if (input.outcome === "UNKNOWN_OUTCOME") return;
    this.connection.prepare(`INSERT INTO effect_outcomes(
      outcome_id,effect_id,outcome,outcome_receipt_id,target_readback_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?)`).run(
      input.outcomeId, input.effectId, input.outcome, input.outcomeReceiptId,
      input.targetReadbackSha256, eventSequence,
    );
  }

  terminalOutcome(effectId: string): StoredEffectOutcome | null {
    const row = this.connection.prepare("SELECT outcome FROM effect_outcomes WHERE effect_id=?").get(effectId) as { outcome?: unknown } | undefined;
    return typeof row?.outcome === "string" ? row.outcome as StoredEffectOutcome : null;
  }

  private goalId(effectId: string): string {
    const row = this.connection.prepare("SELECT goal_id FROM effects WHERE effect_id=?").get(effectId) as { goal_id?: unknown } | undefined;
    if (typeof row?.goal_id !== "string") throw new AuthorityIntegrityError(`Effect ${effectId} does not exist`);
    return row.goal_id;
  }
}
