# Pi Coding Harness review gates

Reviews are deterministic, risk-triggered gates. They do not add an independent model request. The Agent performing
the current normal turn may reason about the change; local validators and tests decide authority.

## 1. Trigger matrix

| Gate | Trigger | Required evidence | Blocks on |
|---|---|---|---|
| RG-01 Design consistency | public Interface, domain record, state transition or config changes | blueprint mapping and affected Interface tests | conflicting authority/ownership |
| RG-02 Assumption | new runtime/provider/filesystem/SDK fact | probe or cited source plus bounded applicability | unverified load-bearing assumption |
| RG-03 Authority/schema | SQL, immutable record, hash, head, lease or transaction changes | forward migration, fault injection, integrity/rebuild | mutable authority or partial commit |
| RG-04 Effect/recovery | write/delete/command/reconcile path changes | prepare/dispatch/readback/unknown/retry crash matrix | blind retry or unowned effect |
| RG-05 Single/Multi parity | shared Goal/route/context/Memory behavior changes | both topology tests or explicit nonapplicability | one topology loses a hard gate |
| RG-06 Worker isolation | TaskPacket, scope, sandbox, model or integration changes | escape/secret/symlink/conflict/fencing/timeout tests | canonical direct write or leakage |
| RG-07 Context/privacy | prompt, Memory, CAS retrieval, telemetry or provider ledger changes | raw-content absence, scope/validity, fallback and token accounting | secret/raw prompt leakage |
| RG-08 Compaction | protected frontier or Pi compaction hooks change | before/crash/after/mismatch/restart matrix | silent semantic drift |
| RG-09 Cache/provider | provider payload or cache observation changes | concrete adapter contract, finality level, natural epoch | undocumented mutation/false claim |
| RG-10 Performance | synchronous hot path, copy/scan/query, budget or target optimizer changes | affected P50/P95 raw samples and correctness gates | material regression or invalid comparator |
| RG-11 UX/output | command grammar, question, Widget or response policy changes | cancellation/error/headless/format tests | hidden decision or missing required output |
| RG-12 Release | package/dependency/docs/lifecycle changes or final delivery | clean install/full verify/arbitrary cwd/self-contained | old surface, external dependency, missing evidence |

## 2. Design consistency checklist

- One owner exists for each mutable decision.
- Interface states invariants, ordering, error modes and configuration; implementation does not leak extra caller work.
- SQLite/CAS remain authority; chat, Widget, Worker text and Markdown remain projections.
- Build stays minimal; Plan stays non-mutating until explicit continuation.
- Single and Multi share Goal/acceptance but use topology-appropriate execution.
- Provider/model/thinking/context remain user-controlled.
- Optional Module failure has an explicit baseline and no hard-gate weakening.
- No new compatibility alias, duplicate command, duplicate context actuator or hypothetical Adapter seam.

## 3. Failure/adversarial checklist

Test the applicable cases:

1. crash before transaction, inside transaction, after commit, before tool, after tool but before readback;
2. duplicate command/idempotency key, stale version, stale lease and stale fencing token;
3. path traversal, absolute path, case/Unicode variant, symlink/reparse point and scope overlap;
4. secret in task, Worker narrative, patch, telemetry and artifact;
5. malformed/oversized/replayed IPC and unexpected fields;
6. Worker timeout, abort, Host restart, orphan recovery, PatchTransaction partial apply, external postimage and failed compensation;
7. compaction with pending effect/Worker and semantic mismatch after compaction;
8. Memory contradiction, stale claim, forget/purge/tamper and private-to-shared leakage;
9. Context stale authorization, invalid cursor, over-budget evidence and projection unknown outcome;
10. provider usage absent/zero/inconsistent, `message_end` omitted, both completion hooks delivered, payload changed by
    a later extension and lineage rotation;
11. repeated identical failure signature, raw patch changed but effective Route unchanged, repeated no-progress managed
    route and canceled user decision;
12. exact edit preimage absent/duplicate/overlapping/oversized/raced, validation run before last write, changed
    fixture/environment and false delivery claim.

## 4. Performance review

Review only after correctness tests pass. Compare the same code path, environment, workload, model configuration and
quality outcome. Separate PCH synchronous time from provider and target-project time. A faster invalid result loses.
For optional features, test baseline and feature in a frozen paired order where possible. Do not rerun an unchanged
epoch because documentation or conversation state changed.

Hot-path review asks:

- Can this parse/query/hash be cached by content/version?
- Is broad filesystem copying needed, or can roots be narrowed?
- Can telemetry/index work be queued without losing a hard receipt?
- Is an RPC redundant after another response already proves the transition?
- Is repeated model-visible text stable, shorter or retrievable on demand?
- Would Multi save wall time after startup/integration, or only add roles?

## 5. Review disposition

Every triggered review records one of:

- `PASS`: applicable evidence current;
- `PASS_WITH_EXTERNAL_LIMIT`: local implementation correct, provider/workload proof unavailable and feature remains at
  baseline;
- `REPAIR_REQUIRED`: local reversible correction available;
- `REPLAN_REQUIRED`: route/Interface assumption disproved;
- `USER_DECISION_REQUIRED`: behavior/scope/acceptance/preference choice is material;
- `BLOCKED`: no valid correction route without an external condition.

On `REPAIR_REQUIRED` or `REPLAN_REQUIRED`, update project state/route before continuing. Do not preserve a wrong route
to avoid changing a plan. Do not label an optimizable issue blocked.

## 6. Final release gate

Release requires all of the following from the final target root:

- clean dependency install, compile, lint, build and complete test suite;
- SQL 001-019, JSON and Markdown validation;
- lifecycle install/upgrade/doctor/uninstall matrix;
- inactive zero-Host/SQLite/RPC/prompt/provider test;
- Single and Multi authority/integration/recovery tests;
- Memory, Input Context, Compaction, Cache C1 positive-evidence/C0 fallback and Output tests;
- current P50/P95 local performance suite;
- no secret, old public name, fixed model/thinking/window, old blueprint, external absolute runtime path, reparse point,
  dependency/build/report/runtime state in the release closure;
- installed Pi probe from an unrelated cwd;
- manifest hashes and `PROJECT-STATUS.md` agree with machine-readable state.

Structural checks alone cannot release PCH. A provider-dependent benefit stays explicitly unproven while its feature
remains at the safe baseline.
