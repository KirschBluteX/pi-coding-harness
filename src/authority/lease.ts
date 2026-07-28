import type { AuthorityConnection } from "./database.js";
import { runImmediateTransaction } from "./database.js";
import { AuthorityRepository, type LeaseRow } from "./repositories.js";
import { LeaseConflictError, StaleFencingTokenError } from "../foundation/errors.js";

export interface LeaseToken {
  readonly goalId: string;
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

function token(row: LeaseRow): LeaseToken {
  return {
    goalId: row.goalId,
    ownerSessionId: row.ownerSessionId,
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

  acquire(goalId: string, ownerSessionId: string, nowMs: number, ttlMs: number): LeaseToken {
    assertLeaseDuration(ttlMs);
    return runImmediateTransaction(this.connection, () => {
      this.repository.goal(goalId);
      const current = this.repository.lease(goalId);
      if (!current) {
        const created: LeaseRow = {
          goalId,
          ownerSessionId,
          generation: 1,
          fencingToken: 1,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + ttlMs,
          lastProgressEventSequence: Math.max(1, this.repository.goalVersion(goalId)),
          rowVersion: 1,
        };
        this.repository.insertLease(created);
        return token(created);
      }
      if (current.ownerSessionId === ownerSessionId && current.expiresAtMs > nowMs) return token(current);
      if (current.expiresAtMs > nowMs) throw new LeaseConflictError(`Goal ${goalId} is owned by another live session`);
      const replacement: LeaseRow = {
        ...current,
        ownerSessionId,
        generation: current.generation + 1,
        fencingToken: current.fencingToken + 1,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
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

  assertCurrent(currentToken: LeaseToken, nowMs: number): LeaseRow {
    const current = this.repository.lease(currentToken.goalId);
    if (!current || current.ownerSessionId !== currentToken.ownerSessionId || current.generation !== currentToken.generation || current.fencingToken !== currentToken.fencingToken) {
      throw new StaleFencingTokenError(`Stale fencing token for ${currentToken.goalId}`);
    }
    if (current.expiresAtMs <= nowMs) throw new StaleFencingTokenError(`Lease expired for ${currentToken.goalId}`);
    return current;
  }
}
