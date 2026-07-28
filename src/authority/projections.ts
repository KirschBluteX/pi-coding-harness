import type { AuthorityConnection } from "./database.js";
import { AuthorityRepository, type GoalRow, type LeaseRow } from "./repositories.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { verifyEventChain } from "./event-chain.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

export interface GoalSnapshot {
  readonly goal: GoalRow;
  readonly goalVersion: number;
  readonly eventCount: number;
  readonly eventHeadSha256: string | null;
  readonly commandReceiptCount: number;
  readonly lease: LeaseRow | null;
  readonly projectionSha256: string;
}

export function rebuildGoalSnapshot(connection: AuthorityConnection, goalId: string): GoalSnapshot {
  const repository = new AuthorityRepository(connection);
  const goal = repository.goal(goalId);
  const chain = verifyEventChain(repository.events(goalId));
  const core = {
    goal,
    goalVersion: chain.count,
    eventCount: chain.count,
    eventHeadSha256: chain.headSha256,
    commandReceiptCount: repository.commandReceiptCount(goalId),
    lease: repository.lease(goalId),
  };
  return { ...core, projectionSha256: canonicalJsonSha256(core) };
}

export function verifyAuthorityIntegrity(connection: AuthorityConnection): { goalCount: number; eventCount: number } {
  const repository = new AuthorityRepository(connection);
  const sqlite = repository.integrity();
  if (sqlite.integrity !== "ok" || sqlite.foreignKeyFailures !== 0) {
    throw new AuthorityIntegrityError(`SQLite integrity failed: ${sqlite.integrity}; foreignKeys=${sqlite.foreignKeyFailures}`);
  }
  let eventCount = 0;
  const goals = repository.goalIds();
  for (const goalId of goals) {
    const events = repository.events(goalId);
    verifyEventChain(events);
    eventCount += events.length;
    repository.verifyCommandReceipts(goalId);
  }
  return { goalCount: goals.length, eventCount };
}
