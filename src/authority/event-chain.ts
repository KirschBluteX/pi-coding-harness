import { AuthorityIntegrityError } from "../foundation/errors.js";
import { sha256Hex } from "../foundation/crypto.js";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json.js";

const eventDomain = "PCH-EVENT-V1";

export const eventTypes = [
  "GOAL_ADMITTED", "GOAL_CORRECTED", "REQUIREMENT_PROPOSED", "REQUIREMENT_VALIDATED",
  "REQUIREMENT_FROZEN", "REQUIREMENT_SUPERSEDED", "REQUIREMENT_ITEM_RECORDED", "PLAN_PROPOSED",
  "PLAN_VALIDATED", "PLAN_FROZEN", "PLAN_SUPERSEDED", "BUILD_STARTED", "STAGE_AUTHORIZED",
  "STAGE_TRANSITIONED", "WORK_ITEM_STARTED", "ATTEMPT_RECORDED", "ASSUMPTION_RECORDED",
  "ASSUMPTION_REFUTED", "RECEIPT_ATTACHED", "EFFECT_PREPARED", "EFFECT_RECONCILED",
  "PLAN_HEALTH_EVALUATED", "ROUTE_DECIDED", "DEPENDENCY_INVALIDATED", "DECISION_REQUESTED",
  "DECISION_RESOLVED", "MILESTONE_CHECKPOINTED", "PROGRESS_SNAPSHOTTED", "COMPACTION_PREPARED",
  "COMPACTION_VERIFIED", "LEASE_ACQUIRED", "LEASE_RENEWED", "LEASE_RELEASED", "GOAL_TRANSITIONED",
  "MEMORY_VERSIONED", "MEMORY_CLAIMED", "MEMORY_ACTIONED", "EXPERIMENT_EPOCH_CHANGED",
  "GOAL_CONTRACT_FROZEN", "GOAL_CONTRACT_DRAFTED", "CONTRACT_REVIEW_RESOLVED",
  "ROUTE_SKELETON_FROZEN", "WORKSPACE_BASELINE_RECORDED",
  "WORK_CELL_AUTHORIZED", "WORK_CELL_TRANSITIONED", "OPERATION_PREPARED",
  "OPERATION_TRANSITIONED", "EVIDENCE_ATTESTED", "ROUTE_HEALTH_EVALUATED",
  "DELIVERABLE_CLOSED",
  "PLAN_CONTINUATION_RESOLVED",
  "CONTRACT_REVISION_OPENED",
  "ACTIVE_GOAL_USER_TURN_CAPTURED",
  "ACTIVE_GOAL_USER_TURN_CLASSIFIED",
  "MANAGED_RUN_CREATED", "HARNESS_TOPOLOGY_REVISED", "WORK_SHARDS_DEFINED",
  "WORK_SHARD_LEASED", "WORKER_RUN_STARTED", "WORKER_RUN_TRANSITIONED",
  "WORK_SHARD_REQUEUED", "WORKER_RESULT_SUBMITTED", "PATCH_TRANSACTION_PREPARED", "HARNESS_INTEGRATION_RECORDED",
  "SINGLE_SHARD_TRANSITIONED", "MANAGED_RUN_CONTROLLED", "MEMORY_VISIBILITY_BOUND",
  "TOPOLOGY_MEASUREMENTS_RECORDED", "TOPOLOGY_ADMISSION_RECORDED", "EXECUTION_GRAPH_COMMITTED", "EXECUTION_NODE_LEASED",
  "PROVIDER_INVOCATION_TRANSITIONED",
  "EXECUTION_NODE_ATTEMPT_OUTCOME_RECORDED",
  "EXECUTION_WORKER_PROPOSAL_SUBMITTED", "EXECUTION_HOST_ORACLE_RECEIPT_RECORDED", "EXECUTION_HOST_RECEIPT_RECORDED",
  "EXECUTION_INTEGRATION_PREPARED", "EXECUTION_INTEGRATION_TRANSITIONED", "EXECUTION_STOPPED",
  "EXECUTION_GRAPH_TERMINAL_RECORDED",
  "STRONG_SINGLE_ROLLOUT_RECORDED", "DYNAMIC_MULTI_PROPOSAL_RECORDED",
] as const;
export type EventType = typeof eventTypes[number];
const eventTypeSet: ReadonlySet<string> = new Set(eventTypes);

export function assertEventType(value: string): asserts value is EventType {
  if (!eventTypeSet.has(value)) throw new AuthorityIntegrityError(`Unsupported event type: ${value}`);
}

export interface EventHashFields {
  readonly storeId: string;
  readonly goalId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly commandId: string;
  readonly payloadSha256: string;
  readonly prevEventSha256: string | null;
  readonly storeGeneration: number;
  readonly leaderEpoch: number;
}

export interface StoredEvent extends EventHashFields {
  readonly eventId: string;
  readonly payloadJson: string;
  readonly eventSha256: string;
}

function framed(value: string): Uint8Array {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "ascii"), bytes]);
}

export function computeEventSha256(fields: EventHashFields): string {
  const values = [
    eventDomain,
    fields.storeId,
    fields.goalId,
    String(fields.sequence),
    fields.eventType,
    fields.commandId,
    fields.payloadSha256,
    fields.prevEventSha256 ?? "",
    String(fields.storeGeneration),
    String(fields.leaderEpoch),
  ];
  return sha256Hex(Buffer.concat(values.map(framed)));
}

export function createEventHashes(payload: unknown, fields: Omit<EventHashFields, "payloadSha256">): { payloadJson: string; payloadSha256: string; eventSha256: string } {
  const payloadJson = canonicalJson(payload);
  const payloadSha256 = canonicalJsonSha256(payload);
  return { payloadJson, payloadSha256, eventSha256: computeEventSha256({ ...fields, payloadSha256 }) };
}

export function verifyEventChain(events: readonly StoredEvent[]): { count: number; headSha256: string | null } {
  let previous: string | null = null;
  let expectedSequence = 1;
  for (const event of events) {
    if (event.sequence !== expectedSequence) throw new AuthorityIntegrityError(`Event sequence gap at ${event.eventId}`);
    if (event.prevEventSha256 !== previous) throw new AuthorityIntegrityError(`Event predecessor mismatch at ${event.eventId}`);
    let payload: unknown;
    try {
      payload = JSON.parse(event.payloadJson) as unknown;
    } catch (error) {
      throw new AuthorityIntegrityError(`Event payload is invalid JSON at ${event.eventId}`, error);
    }
    if (canonicalJson(payload) !== event.payloadJson) throw new AuthorityIntegrityError(`Event payload is not canonical at ${event.eventId}`);
    if (sha256Hex(event.payloadJson) !== event.payloadSha256) throw new AuthorityIntegrityError(`Event payload hash mismatch at ${event.eventId}`);
    if (computeEventSha256(event) !== event.eventSha256) throw new AuthorityIntegrityError(`Event hash mismatch at ${event.eventId}`);
    previous = event.eventSha256;
    expectedSequence += 1;
  }
  return { count: events.length, headSha256: previous };
}
