import type { Clock } from "../foundation/clock.js";
import { sha256Hex } from "../foundation/crypto.js";
import { VersionConflictError } from "../foundation/errors.js";
import { createId, idFromSha256 } from "../foundation/ids.js";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json.js";
import { runImmediateTransaction, type AuthorityConnection } from "./database.js";
import { assertEventType, createEventHashes, type EventType, type StoredEvent } from "./event-chain.js";
import { AuthorityRepository, type PersistedCommandResult } from "./repositories.js";

export type AuthorityActor = "USER" | "AGENT" | "RUNTIME";

export type AuthorityTransactionFaultPoint =
  | "before-begin" | "after-begin" | "after-idempotency" | "after-version-check"
  | "after-memory-claim-write" | "after-memory-claim-head-write" | "after-memory-claim-index-outbox-write"
  | "after-memory-action-write" | "after-memory-action-head-write" | "after-memory-action-index-outbox-write"
  | "after-memory-checkpoint-write"
  | "after-domain-write" | "after-event-write" | "after-projection-write" | "after-outbox-write"
  | "after-receipt-write" | "before-commit" | "after-commit" | "before-return";

export interface AuthorityTransactionMeta {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: AuthorityActor;
}

export interface AuthorityTransactionPrelude {
  readonly currentVersion: number;
  readonly nowMs: number;
}

export interface AuthorityTransactionContext extends AuthorityTransactionPrelude {
  readonly sequence: number;
}

export interface AuthorityTransactionEvent {
  readonly eventType: EventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuthorityTransactionLifecycle<TDomainResult> {
  readonly beforeMutation?: (context: AuthorityTransactionPrelude) => void;
  readonly mutate: (context: AuthorityTransactionContext) => TDomainResult;
  readonly event: (domainResult: TDomainResult) => AuthorityTransactionEvent;
}

export interface AuthorityTransactionResult extends PersistedCommandResult {
  readonly reused: boolean;
}

export interface AuthorityTransactionInput {
  readonly goalId: string;
  readonly commandSha256: string;
  readonly meta: AuthorityTransactionMeta;
}

function stableCommandId(goalId: string, idempotencyKey: string): string {
  return idFromSha256("CMD", sha256Hex(`${goalId}\0${idempotencyKey}`));
}

export class AuthorityTransactionKernel {
  private readonly repository: AuthorityRepository;

  constructor(
    private readonly connection: AuthorityConnection,
    private readonly clock: Clock,
  ) {
    this.repository = new AuthorityRepository(connection);
  }

  execute<TDomainResult>(
    input: AuthorityTransactionInput,
    lifecycle: AuthorityTransactionLifecycle<TDomainResult>,
    onFault?: (point: AuthorityTransactionFaultPoint) => void,
  ): AuthorityTransactionResult {
    const { goalId, commandSha256, meta } = input;
    const idempotencyKeySha256 = sha256Hex(meta.idempotencyKey);
    const commandId = stableCommandId(goalId, meta.idempotencyKey);
    onFault?.("before-begin");
    const transactionBody = () => {
      onFault?.("after-begin");
      const existing = this.repository.commandResult(commandId, goalId, idempotencyKeySha256, commandSha256);
      onFault?.("after-idempotency");
      if (existing) return { result: existing, reused: true };

      const currentVersion = this.repository.goalVersion(goalId);
      if (meta.expectedVersion !== currentVersion) {
        throw new VersionConflictError(meta.expectedVersion, currentVersion);
      }
      onFault?.("after-version-check");

      const nowMs = this.clock.now();
      const prelude: AuthorityTransactionPrelude = { currentVersion, nowMs };
      lifecycle.beforeMutation?.(prelude);
      const head = this.repository.eventHead(goalId);
      const context: AuthorityTransactionContext = { ...prelude, sequence: head.sequence + 1 };
      const store = this.repository.storeMeta();
      const domainResult = lifecycle.mutate(context);
      onFault?.("after-domain-write");

      const eventInput = lifecycle.event(domainResult);
      assertEventType(eventInput.eventType);
      const hashes = createEventHashes(eventInput.payload, {
        storeId: store.storeId,
        goalId,
        sequence: context.sequence,
        eventType: eventInput.eventType,
        commandId,
        prevEventSha256: head.eventSha256,
        storeGeneration: store.storeGeneration,
        leaderEpoch: store.leaderEpoch,
      });
      const event: StoredEvent & { actor: string; idempotencyKeySha256: string; occurredAtMs: number } = {
        eventId: createId("EVT"),
        goalId,
        sequence: context.sequence,
        eventType: eventInput.eventType,
        commandId,
        ...hashes,
        prevEventSha256: head.eventSha256,
        storeId: store.storeId,
        storeGeneration: store.storeGeneration,
        leaderEpoch: store.leaderEpoch,
        actor: meta.actor,
        idempotencyKeySha256,
        occurredAtMs: nowMs,
      };
      this.repository.appendEvent(event);
      onFault?.("after-event-write");
      onFault?.("after-projection-write");

      const outboxPayload = {
        eventId: event.eventId,
        eventSha256: event.eventSha256,
        eventType: event.eventType,
        sequence: context.sequence,
      };
      this.repository.appendOutbox({
        outboxId: createId("OUT"),
        goalId,
        topic: "authority.event",
        payloadJson: canonicalJson(outboxPayload),
        payloadSha256: canonicalJsonSha256(outboxPayload),
        sequence: context.sequence,
      });
      onFault?.("after-outbox-write");

      const result: PersistedCommandResult = {
        goalId,
        eventSequence: context.sequence,
        goalVersion: context.sequence,
        eventSha256: event.eventSha256,
        eventType: event.eventType,
      };
      this.repository.appendCommandReceipt({
        commandId,
        goalId,
        idempotencyKeySha256,
        commandSha256,
        expectedVersion: meta.expectedVersion,
        committedVersion: context.sequence,
        resultJson: canonicalJson(result),
        resultSha256: canonicalJsonSha256(result),
        eventSequence: context.sequence,
      });
      onFault?.("after-receipt-write");
      onFault?.("before-commit");
      return { result, reused: false };
    };
    const outcome = this.connection.isTransaction
      ? transactionBody()
      : runImmediateTransaction(this.connection, transactionBody);
    onFault?.("after-commit");
    onFault?.("before-return");
    return { ...outcome.result, reused: outcome.reused };
  }
}
