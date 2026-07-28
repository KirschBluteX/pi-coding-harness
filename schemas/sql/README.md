# SQL schema contract

Migrations are forward-only and run in numeric order inside an exclusive
AuthorityStore migration transaction.

- `001_core.sql`: authoritative Goal/Requirement/Plan/Stage/WorkItem/Attempt/
  Assumption/Decision/Receipt/Event/Effect/Lease/Checkpoint records and
  rebuildable heads. Requirement revisions hold `TASK_SPEC` or product `PRD`
  packages; every Plan revision binds one frozen Requirement revision.
- `002_experiments.sql`: independent module epochs, immutable trial specs/samples/
  verdicts, PromptGeneration/PromptRequest chains, truthful cache observations,
  Goal-level output observations, tool-result projections, and bounded telemetry.
  Active trial authority remains in core WorkItem/Attempt/checkpoint records.
- `003_memory.sql`: optional versioned Memory records and FTS5 projection. Apply
  only after the runtime probe proves FTS5 is available; otherwise use tag/path
  fallback without blocking core Goal execution.
- `004_memory_fts.sql`: optional legacy Memory FTS5 projection.
- `005_memory_claims.sql`: Memory v2.1 attested claim/action authority and bounded
  index outbox.
- `006_memory_claims_fts.sql`: optional Memory v2.1 FTS5 projection.
- `007_memory_checkpoint.sql`: immutable Memory checkpoint references used across
  compaction and recovery.
- `008_memory_v3_vault.sql`: content-free Memory 3.0 workspace event stream,
  idempotent commands, Vault metadata, HMAC terms, actions, and rebuildable heads.

The SQL files are normative design artifacts in this blueprint delivery. Their
successful parse does not claim that AuthorityStore has been implemented.
Implementation must run migration, crash, corruption, rollback, and concurrent
writer tests before Phase 1 exits.
