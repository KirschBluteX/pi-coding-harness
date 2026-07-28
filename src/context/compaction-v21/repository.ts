import type { AuthorityConnection } from "../../authority/database.js";
import { canonicalJson, parseCanonicalJson } from "../../authority/canonical-json.js";
import { runImmediateTransaction } from "../../authority/database.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import {
  assertHarnessCompactionAttempt, assertHarnessCompactionTransition,
  type HarnessCompactionAttempt, type HarnessCompactionCapsule, type HarnessCompactionState, type HarnessCompactionTransition,
} from "./domain.js";

export interface HarnessCompactionHead {
  readonly attempt: HarnessCompactionAttempt;
  readonly state: HarnessCompactionState;
  readonly ordinal: number;
  readonly transitionSha256: string;
}

const terminal = new Set<HarnessCompactionState>(["VERIFIED", "ABORTED", "RECONCILED"]);
const allowed: Readonly<Record<HarnessCompactionState, readonly HarnessCompactionState[]>> = {
  PREPARED: ["PI_OWNED", "ABORTED"], PI_OWNED: ["VERIFIED", "ABORTED", "RECOVERY_REQUIRED"],
  RECOVERY_REQUIRED: ["RECONCILED", "ABORTED"], VERIFIED: [], ABORTED: [], RECONCILED: [],
};

function storedText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`${label} is not stored text`);
  return value;
}

function storedNullableText(value: unknown, label: string): string | null {
  return value === null ? null : storedText(value, label);
}

function decodeAttempt(row: Record<string, unknown>): HarnessCompactionAttempt {
  const attempt = {
    schema_version: 1 as const, attempt_id: String(row.attempt_id), run_id: String(row.run_id), goal_id: String(row.goal_id),
    checkpoint_id: String(row.checkpoint_id), checkpoint_sha256: String(row.checkpoint_sha256),
    pre_capsule: parseCanonicalJson(String(row.pre_capsule_json)) as unknown as HarnessCompactionCapsule,
    pre_capsule_sha256: String(row.pre_capsule_sha256),
    strategy: String(row.strategy) as HarnessCompactionAttempt["strategy"], created_at_ms: Number(row.created_at_ms),
  };
  assertHarnessCompactionAttempt(attempt); return attempt;
}

export class HarnessCompactionRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  prepare(attempt: HarnessCompactionAttempt, prepared: HarnessCompactionTransition, piOwned: HarnessCompactionTransition): HarnessCompactionHead {
    assertHarnessCompactionAttempt(attempt); assertHarnessCompactionTransition(prepared); assertHarnessCompactionTransition(piOwned);
    if (prepared.attempt_id !== attempt.attempt_id || prepared.ordinal !== 0 || prepared.state !== "PREPARED" || prepared.predecessor_sha256 !== null
      || piOwned.attempt_id !== attempt.attempt_id || piOwned.ordinal !== 1 || piOwned.state !== "PI_OWNED"
      || piOwned.predecessor_sha256 !== prepared.transition_sha256) throw new AuthorityIntegrityError("Compaction prepare transition chain is invalid");
    return runImmediateTransaction(this.connection, () => {
      const existing = this.byId(attempt.attempt_id);
      if (existing) {
        if (canonicalJson(existing.attempt) !== canonicalJson(attempt)) throw new AuthorityIntegrityError("Compaction attempt identity collision");
        return existing;
      }
      const run = this.connection.prepare("SELECT goal_id FROM managed_runs_v1 WHERE run_id=?").get(attempt.run_id) as { goal_id?: unknown } | undefined;
      if (run?.goal_id !== attempt.goal_id) throw new AuthorityIntegrityError("Compaction attempt ManagedRun binding is invalid");
      const open = this.connection.prepare(`SELECT count(*) count FROM harness_compaction_heads_v21 h JOIN harness_compaction_attempts_v21 a ON a.attempt_id=h.attempt_id
        WHERE a.run_id=? AND h.state IN ('PREPARED','PI_OWNED','RECOVERY_REQUIRED')`).get(attempt.run_id) as { count?: unknown } | undefined;
      if (Number(open?.count ?? 0) !== 0) throw new AuthorityIntegrityError("ManagedRun already has an open compaction attempt");
      this.connection.prepare(`INSERT INTO harness_compaction_attempts_v21(attempt_id,run_id,goal_id,checkpoint_id,checkpoint_sha256,
        pre_capsule_json,pre_capsule_sha256,strategy,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        attempt.attempt_id, attempt.run_id, attempt.goal_id, attempt.checkpoint_id, attempt.checkpoint_sha256,
        canonicalJson(attempt.pre_capsule), attempt.pre_capsule_sha256, attempt.strategy, attempt.created_at_ms,
      );
      this.insertTransition(prepared); this.insertTransition(piOwned);
      this.connection.prepare("INSERT INTO harness_compaction_heads_v21(attempt_id,state,ordinal,transition_sha256) VALUES(?,?,?,?)")
        .run(attempt.attempt_id, piOwned.state, piOwned.ordinal, piOwned.transition_sha256);
      return { attempt, state: piOwned.state, ordinal: piOwned.ordinal, transitionSha256: piOwned.transition_sha256 };
    });
  }

  transition(value: HarnessCompactionTransition): HarnessCompactionHead {
    assertHarnessCompactionTransition(value);
    return runImmediateTransaction(this.connection, () => {
      const current = this.byId(value.attempt_id);
      if (!current) throw new AuthorityIntegrityError("Compaction attempt is unknown");
      if (value.ordinal !== current.ordinal + 1 || value.predecessor_sha256 !== current.transitionSha256
        || !allowed[current.state].includes(value.state)) throw new AuthorityIntegrityError("Compaction transition is illegal or stale");
      this.insertTransition(value);
      this.connection.prepare("UPDATE harness_compaction_heads_v21 SET state=?,ordinal=?,transition_sha256=? WHERE attempt_id=?")
        .run(value.state, value.ordinal, value.transition_sha256, value.attempt_id);
      return { attempt: current.attempt, state: value.state, ordinal: value.ordinal, transitionSha256: value.transition_sha256 };
    });
  }

  byId(attemptId: string): HarnessCompactionHead | null {
    const row = this.connection.prepare(`SELECT a.*,h.state,h.ordinal,h.transition_sha256 FROM harness_compaction_attempts_v21 a
      JOIN harness_compaction_heads_v21 h ON h.attempt_id=a.attempt_id WHERE a.attempt_id=?`).get(attemptId) as Record<string, unknown> | undefined;
    return row ? { attempt: decodeAttempt(row), state: String(row.state) as HarnessCompactionState,
      ordinal: Number(row.ordinal), transitionSha256: String(row.transition_sha256) } : null;
  }

  openForRun(runId: string): HarnessCompactionHead | null {
    const row = this.connection.prepare(`SELECT a.*,h.state,h.ordinal,h.transition_sha256 FROM harness_compaction_attempts_v21 a
      JOIN harness_compaction_heads_v21 h ON h.attempt_id=a.attempt_id
      WHERE a.run_id=? AND h.state IN ('PREPARED','PI_OWNED','RECOVERY_REQUIRED') ORDER BY a.created_at_ms DESC LIMIT 1`).get(runId) as Record<string, unknown> | undefined;
    return row ? { attempt: decodeAttempt(row), state: String(row.state) as HarnessCompactionState,
      ordinal: Number(row.ordinal), transitionSha256: String(row.transition_sha256) } : null;
  }

  verifyIntegrity(): void {
    const attempts = this.connection.prepare("SELECT attempt_id FROM harness_compaction_attempts_v21").all() as { attempt_id: string }[];
    for (const item of attempts) {
      const head = this.byId(item.attempt_id); if (!head) throw new AuthorityIntegrityError("Compaction head is missing");
      const rows = this.connection.prepare("SELECT * FROM harness_compaction_transitions_v21 WHERE attempt_id=? ORDER BY ordinal").all(item.attempt_id) as Record<string, unknown>[];
      let predecessor: string | null = null; let state: HarnessCompactionState | null = null;
      for (const row of rows) {
        const transition = { schema_version: 1 as const, transition_id: String(row.transition_id), attempt_id: String(row.attempt_id),
          ordinal: Number(row.ordinal), state: String(row.state) as HarnessCompactionState, reason_code: String(row.reason_code),
          observed_capsule_sha256: storedNullableText(row.observed_capsule_sha256, "observed_capsule_sha256"),
          predecessor_sha256: storedNullableText(row.predecessor_sha256, "predecessor_sha256"),
          transition_sha256: String(row.transition_sha256), created_at_ms: Number(row.created_at_ms) };
        assertHarnessCompactionTransition(transition);
        if (transition.predecessor_sha256 !== predecessor || (state && !allowed[state].includes(transition.state))) throw new AuthorityIntegrityError("Compaction transition chain is invalid");
        predecessor = transition.transition_sha256; state = transition.state;
      }
      if (state === null || state !== head.state || predecessor !== head.transitionSha256 || terminal.has(head.state) !== terminal.has(state)) throw new AuthorityIntegrityError("Compaction head projection mismatch");
    }
  }

  private insertTransition(value: HarnessCompactionTransition): void {
    this.connection.prepare(`INSERT INTO harness_compaction_transitions_v21(transition_id,attempt_id,ordinal,state,reason_code,
      observed_capsule_sha256,predecessor_sha256,transition_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      value.transition_id, value.attempt_id, value.ordinal, value.state, value.reason_code,
      value.observed_capsule_sha256, value.predecessor_sha256, value.transition_sha256, value.created_at_ms,
    );
  }
}
