import type { AuthorityConnection } from "./database.js";
import { runImmediateTransaction } from "./database.js";
import { AuthorityRepository, type LeaseRow } from "./repositories.js";
import { LeaseConflictError, StaleFencingTokenError } from "../foundation/errors.js";

export interface LeaseToken {
  readonly goalId: string;
  readonly ownerSessionId: string;
  readonly ownerInstanceId: string | null;
  readonly generation: number;
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

function token(row: LeaseRow): LeaseToken {
  return {
    goalId: row.goalId,
    ownerSessionId: row.ownerSessionId,
    ownerInstanceId: row.ownerInstanceId,
    generation: row.generation,
    fencingToken: row.fencingToken,
    expiresAtMs: row.expiresAtMs,
  };
}

function assertLeaseDuration(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError("Lease TTL must be a positive integer");
}

export class LeaseManager {
  private readonly repository: AuthorityRepository;

  constructor(private readonly connection: AuthorityConnection) {
    this.repository = new AuthorityRepository(connection);
  }

  acquire(
    goalId: string,
    ownerSessionId: string,
    nowMs: number,
    ttlMs: number,
    ownerInstanceId = ownerSessionId,
  ): LeaseToken {
    assertLeaseDuration(ttlMs);
    if (!ownerInstanceId.trim() || ownerInstanceId.length > 256) throw new TypeError("Lease runtime instance ID is invalid");
    return runImmediateTransaction(this.connection, () => {
      this.repository.goal(goalId);
      const current = this.repository.lease(goalId);
      if (!current) {
        const created: LeaseRow = {
          goalId,
          ownerSessionId,
          ownerInstanceId,
          generation: 1,
          fencingToken: 1,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + ttlMs,
          releasedAtMs: null,
          lastProgressEventSequence: Math.max(1, this.repository.goalVersion(goalId)),
          rowVersion: 1,
        };
        this.repository.insertLease(created);
        return token(this.repository.lease(goalId) ?? created);
      }
      const currentIsLive = current.releasedAtMs === null && current.expiresAtMs > nowMs;
      const sameRuntime = current.ownerSessionId === ownerSessionId
        && (current.ownerInstanceId === null || current.ownerInstanceId === ownerInstanceId);
      if (sameRuntime && currentIsLive) return token(current);
      if (currentIsLive) throw new LeaseConflictError(`Goal ${goalId} is owned by another live session or runtime instance`);
      const replacement: LeaseRow = {
        ...current,
        ownerSessionId,
        ownerInstanceId,
        generation: current.generation + 1,
        fencingToken: current.fencingToken + 1,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        releasedAtMs: null,
        lastProgressEventSequence: Math.max(1, this.repository.goalVersion(goalId)),
        rowVersion: current.rowVersion + 1,
      };
      if (!this.repository.replaceLease(current, replacement)) throw new LeaseConflictError(`Lease takeover lost CAS for ${goalId}`);
      return token(replacement);
    });
  }

  renew(currentToken: LeaseToken, nowMs: number, ttlMs: number, lastProgressEventSequence: number): LeaseToken {
    assertLeaseDuration(ttlMs);
    if (!Number.isSafeInteger(lastProgressEventSequence) || lastProgressEventSequence < 1) {
      throw new RangeError("Lease progress sequence must be a positive integer");
    }
    const requestedExpiry = nowMs + ttlMs;
    const observed = this.assertCurrent(currentToken, nowMs);
    if (observed.expiresAtMs >= requestedExpiry && observed.lastProgressEventSequence >= lastProgressEventSequence) {
      return token(observed);
    }
    return runImmediateTransaction(this.connection, () => {
      const current = this.assertCurrent(currentToken, nowMs);
      const expiresAtMs = Math.max(current.expiresAtMs, requestedExpiry);
      const progressSequence = Math.max(current.lastProgressEventSequence, lastProgressEventSequence);
      if (expiresAtMs === current.expiresAtMs && progressSequence === current.lastProgressEventSequence) {
        return token(current);
      }
      const renewed: LeaseRow = {
        ...current,
        expiresAtMs,
        lastProgressEventSequence: progressSequence,
        rowVersion: current.rowVersion + 1,
      };
      if (!this.repository.replaceLease(current, renewed)) throw new StaleFencingTokenError(`Lease renewal lost CAS for ${current.goalId}`);
      return token(renewed);
    });
  }

  release(currentToken: LeaseToken, nowMs: number): void {
    runImmediateTransaction(this.connection, () => {
      const current = this.assertCurrent(currentToken, nowMs);
      const released: LeaseRow = { ...current, releasedAtMs: nowMs, rowVersion: current.rowVersion + 1 };
      if (!this.repository.replaceLease(current, released)) {
        throw new StaleFencingTokenError(`Lease release lost CAS for ${current.goalId}`);
      }
    });
  }

  assertCurrent(currentToken: LeaseToken, nowMs: number): LeaseRow {
    const current = this.repository.lease(currentToken.goalId);
    const instanceMismatch = current?.ownerInstanceId !== null
      && current?.ownerInstanceId !== currentToken.ownerInstanceId;
    if (!current || current.ownerSessionId !== currentToken.ownerSessionId || instanceMismatch
      || current.generation !== currentToken.generation || current.fencingToken !== currentToken.fencingToken) {
      throw new StaleFencingTokenError(`Stale fencing token for ${currentToken.goalId}`);
    }
    if (current.releasedAtMs !== null) throw new StaleFencingTokenError(`Lease released for ${currentToken.goalId}`);
    if (current.expiresAtMs <= nowMs) throw new StaleFencingTokenError(`Lease expired for ${currentToken.goalId}`);
    return current;
  }
}
