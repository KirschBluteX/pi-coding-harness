# Project status

> Checked development projection; product authority remains SQLite/CAS.

- Product: Pi Coding Harness
- Version: 1.2.1
- Authority schema: 19
- State: PASS
- Current phase: P11
- Current stage: RELEASE_VERIFIED
- State generation: 46
- Updated: 2026-07-28T23:35:44.3390854+08:00

## Goal

Release-verify the repaired real Pi user path on Node 24.18.0: one-transaction blocking preflight dispatch, authorization and canonical-workspace fencing across takeover, durable reconciliation, clarification recovery, strict Host protocol, and all lifecycle/arbitrary-cwd gates without weakening FULL durability.

## Evidence

- Completed receipts: 41
- Authoritative artifacts: 17
- Verification: PASS

## Latest correction

PCH-COR-RECOVERY-FIRST-CLARIFICATION: Bridge recovery no longer starts a model/provider turn while an OPEN clarification is unresolved. Interactive users resolve the durable choices locally before one productive continuation turn; headless users receive the exact slash-command choices, and clarification submission failure fully deactivates the half-entered Bridge.

## Do not repeat

- Do not rerun a full architecture review after context compaction when its input closure is unchanged.
- Do not restore phase-specific activation and dogfood scripts as release dependencies.
- Do not infer provider cache misses or benefits from unknown usage fields.
- Do not remove a frozen fixture without first updating every current consumer and its replacement evidence.
- Do not leave both old and renamed local package paths registered in Pi.
- Do not add an unanchored artifacts/, reports/, telemetry/ or other runtime-directory rule that can hide a source Module.
- Do not classify normalized zero cached_tokens as a provider Cache miss.
- Do not renew a healthy live Goal lease on every mutation; retain threshold renewal and in-transaction fencing validation.
- Do not combine Cache prepare and settle latency claims with provider latency or claim observed historical shares as a guaranteed future hit rate.
- Do not add PROJECT-STATE.json or PROJECT-STATUS.md hashes to migration/source closure while those files reference final manifest hashes.
- Do not rerun pch-smoke-prd01-003 after its hidden quality, authority closure, root-cause audit and deterministic regressions all passed.
- Do not resume or score pch-formal-002; its inherited GEEKSPACE_API_KEY was unauthorized and its six model-backed tasks performed zero model work.
- Do not rerun pch-formal-003 or rewrite its raw 6/8 score; any user-authorized retest must use a new run ID and frozen source epoch.
- Do not remove changed-source rereads or post-mutation fresh validation merely because an audit reports repeated targets or commands.
- Do not restore fake SUPERVISOR WorkShards in Single topology for accounting symmetry.
- Do not present message_end rewriting, UI hiding or GenerationGovernor as savings for provider tokens already generated.
- Do not reuse one turn-start ControlFrame after a same-turn authority mutation; consume the Host frame receipt before the next managed action.
- Do not silently discard unknown Contract or Route proposal fields or ask the model to infer optional field shapes.
- Do not resume or score pch-smoke-prd01-005; it was intentionally terminated after exposing same-turn ControlFrame and Route proposal contract defects, and exists only as diagnostic evidence.
- Do not resume or score pch-smoke-prd01-006; it intentionally stopped at the first stale-frame signal and is bound to the pre-heartbeat 1.2.1 source epoch.
- Do not rerun full release verification, regenerate release closure, refresh the Pi installation or restart a model benchmark after each small repair; aggregate a stable defect cluster first.
- Do not resume or score pch-smoke-prd01-007; it loaded stale dist and exists only as execution-closure diagnostic evidence.
- Do not resume or score pch-smoke-prd01-008; it proved heartbeat continuity and exposed the oracle diagnostic defect before fail-fast termination.
- Do not start a model-backed benchmark from an ambient GEEKSPACE_API_KEY or presence-only credential check; require the participant-specific variable and a successful zero-token /v1/models preflight.
- Do not treat catalog_sha256 as the complete stress freeze identity; bind and verify the full manifest SHA-256.
- Do not run or resume Codex on the frozen stress task before a hash-valid PCH FIRST_PASS seal, or after a Codex stress run index already exists.
- Do not run a release gate before the final PRD-01 candidate and do not add a second formal PRD-01 after it; score the next provider-authenticated run directly.
- Do not add a STRESS_FULL product route solely to mirror a benchmark class; compare the class through the legal PRD/FULL PCH contract.
- Do not force the frozen stress route in the benchmark prompt or manifest when the live deterministic classifier disagrees; fix and regression-test the general intake evidence rule before running the model.
- Do not resume or score pch-candidate-prd01-002; the controller interrupted Pi after willRetry=true, so its partial token, latency and quality data are diagnostic only.
- Do not terminate a Pi run on the first zero-token provider error while agent_end declares willRetry=true; wait for bounded retry recovery or exhaustion.
- Do not rerun PRD-01 after pch-candidate-prd01-003; it completed 26/26 hidden/focused quality and authority closure.
- Do not rank the pch-candidate-prd01-003 cumulative latency or token delta against formal-003 Codex as a win or loss; the PCH path contains two external network interruptions and three process sessions.
- Do not start STRESS-01, the one permitted Codex stress execution, or a full release gate until the user explicitly resumes after PRD-01 review.
- Do not submit a complete Route when next=SUBMIT_ROUTE and a prior Route exists; use submit_route_revision with the changed horizon and changed metadata.
- Do not reject a finite model validation timeout solely because it exceeds 900 seconds; clamp it to the authority ceiling without widening that ceiling.
- Do not treat the PRD-01 post-run repair as measured token or latency improvement; no new model-backed run was performed.
- Do not patch dependency-owned node_modules or claim the Pi 0.82.1 shrinkwrap advisory is a bundled PCH runtime vulnerability; keep the peer boundary explicit and re-probe when a newer Pi release exists.
- Do not move authority-bound managed Host payload semantics ahead of ControlFrame binding and GenerationGovernor route registration; invalid repeated routes must remain observable to deterministic governance.
- Do not retain obsolete product identities even as negative comparison text in active development state; self-contained release scanning treats the whole active artifact as public surface.
- Do not terminate Task Flow separately from its ManagedRun; use the atomic Task Flow/Harness application transaction and preserve rollback coverage.
- Do not bind a new objective or intent to a recovered Goal after Host restart.
- Do not let slash commands replace the default Memory recall query.
- Do not pair a stable Cache partition or family ID with a per-request created_at_ms identity hash.
- Do not use Host-side long polling on the Bridge execution lane when cancellation or shutdown must remain prompt.
- Do not treat an authenticated response for a bounded timed-out request as an unknown-response attack; match it against a TTL-bounded tombstone.
- Do not repeat full authority and Task Flow scans within one unchanged SQLite data_version generation.
- Do not open or migrate SQLite WAL authority with embedded SQLite 3.51.2 or another runtime in the documented WAL-reset vulnerable range.
- Do not keep the only copy of an OPEN clarification question or its options in Bridge process memory.
- Do not accept an authenticated late Host response solely because a tombstone exists; enforce its expiry at receipt time.
- Do not model Pi tool_call as occurring before tool_execution_start; Pi 0.82.1 emits tool_execution_start first and invokes blocking tool_call immediately before actual execution.
- Do not infer NOT_DISPATCHED from PREPARED state alone after restart or takeover when a real tool could already have mutated the workspace.
- Do not let a current lease token continue an OperationAttempt authorized under an older lease generation or fencing token.
- Do not split managed PREPARED and DISPATCHED across two Host RPCs or two FULL-durability authority commits.
- Do not perform PatchTransaction canonical writes after a one-time lease check; hold the lease fence across each actual filesystem mutation and recheck before the next file.
- Do not restore worker_wait or tool_start to the closed Host protocol; worker_poll and atomic tool_preflight are the supported seams.
- Do not treat process TEMP placement as deployment-volume performance evidence; fingerprint and benchmark the actual declared/default data-root volume.
- Do not unconditionally send the entry objective after Host recovery when open clarifications remain; project and resolve the durable choices locally first.

## Open risks

- Geekspace normalized zero Cache usage remains unobservable, so request miss rate cannot be derived from current Pi 0.82.1 usage objects.
- Provider/API/base-URL combinations without a verified integration intentionally fall back to C0.
- Pi versions beyond the tested peer range require a fresh compatibility probe.
- PRD-01 did not naturally trigger compaction; only deterministic compaction and recovery tests currently pass.
- The post-PRD-01 overhead repairs have deterministic evidence but no new provider-backed measurement of token, output, RouteRevision or latency reduction.
- The provider exposed no monetary cost in Pi usage objects; token and latency evidence cannot be converted to an audited currency cost.
- The tested Pi Coding Agent 0.82.1 peer/dev package shrinkwrap contains brace-expansion 5.0.7 (high DoS advisory); bundled PCH runtime dependencies audit clean, project overrides cannot replace the dependency-owned shrinkwrap, and no newer tested Pi release is available.
- WAL remains auto-checkpoint-disabled and can grow during a long Host lifetime; synchronous same-thread PASSIVE checkpoint is rejected until measured or moved behind a proven off-main-thread maintenance Module.

## Blockers

- None.

## Next action

Optional only: prototype and measure an off-main-thread WalMaintenance Module under steady-state, concurrent, shutdown, and crash workloads before considering any WAL checkpoint policy change.
