# SQL schema contract

Pi Coding Harness stores durable runtime authority in SQLite WAL. Migration files define the forward-only physical
schema history; the [implementation blueprint](../../docs/PI-CODING-HARNESS-BLUEPRINT.md) remains the normative
behavioral authority.

The current public repository state uses authority schema **35**.

## Migration map

| Range | Durable boundary |
|---|---|
| `001`–`002` | Core Goal, Requirement, Plan, WorkItem, Attempt, Decision, Receipt, Event, Effect, Lease, Checkpoint, experiment, provider-observation, and performance records |
| `003`–`010` | Memory generations, optional FTS projections, attested claims, checkpoints, encrypted vault metadata, lifecycle, correction, forgetting, and capture authority |
| `011`–`019` | Task Flow, Input Context, Coding Harness execution, Cache v2, Compaction 2.1, provider-turn accounting, target-performance receipts, control-plane state, and PatchTransaction history |
| `020`–`027` | Acceptance v2, intake decisions, Goal Fit, plan-change invalidation, dynamic-Multi planning, active-Goal changes, review identity, and change acceptance |
| `028`–`035` | Dynamic-Multi execution and integration journals, provider call plans and Goal binding, strong-Single rollout, workload comparability, proposal authority, and session-to-Goal binding |

The numbered files in this directory are the exact migration sequence. Their names identify the boundary introduced
at each revision, from [`001_core.sql`](001_core.sql) through
[`035_session_goal_binding_v1.sql`](035_session_goal_binding_v1.sql).

## Application rules

- Migrations run in numeric order inside an exclusive AuthorityStore migration transaction.
- Applied migration hashes are checked; an existing migration is never rewritten in place.
- Optional FTS migrations activate only after the runtime proves FTS5 support. Core authority remains available
  through bounded tag/path fallbacks when FTS5 is unavailable.
- Startup verifies SQLite integrity, foreign keys, migration order, and the current projection heads before granting a
  lease or authorizing mutation.
- Older supported databases migrate forward. PCH does not implement schema downgrade or backward mutation paths.
- Passing SQL parse and migration checks proves the physical contract, not end-to-end correctness; lifecycle, crash,
  reconciliation, fencing, and concurrent-writer behavior are verified separately.
