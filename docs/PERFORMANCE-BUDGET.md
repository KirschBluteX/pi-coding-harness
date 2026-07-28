# Pi Coding Harness performance budget

Performance is a hard gate after correctness, safety, acceptance and state integrity. The budgets below govern PCH
local overhead; target-project speed is a separate contract.

## 1. Accounting

Every measured run separates:

- provider wall time and TTFT;
- PCH synchronous local time;
- SQLite transaction/flush time;
- filesystem readback and scoped-mirror copy time;
- Worker startup/model/tool/integration time;
- uncached input, cache read/write, generated output, reasoning and tool arguments;
- PCH additional model/provider requests;
- target-project workload time.

P50/P95 are computed from raw samples in one fixed environment. A skipped, unobservable or unmatched measure is
`UNKNOWN`, never zero or PASS. Reports contain environment fingerprint, sample count and raw or reproducible source.
The release verifier creates an isolated epoch on the declared deployment data-root volume (default
`~/.pi/agent/coding-harness`); process `TEMP` is scratch configuration and cannot silently substitute another disk.

## 2. Fast-path gates

| Path | P50 | P95 | Hard requirement |
|---|---:|---:|---|
| PCH inactive hook | local in-memory only | local in-memory only | Host/SQLite/RPC/prompt/model/provider operations = 0 |
| automatic intake classification | <= 0.5 ms | <= 1 ms | deterministic, no model request |
| authority single-event commit | report | <= 20 ms | 100 warm samples, WAL `synchronous=FULL` |
| authority snapshot read | report | <= 8 ms | 100 warm samples |
| lease renew | report | <= 8 ms | 100 warm samples |
| CAS put, 1 MiB | report | <= 35 ms | local volume |
| DirectCell finalization | report | <= 15 ms | fresh oracle closure |
| RouteHealth, 100 obligations/256 records | report | <= 5 ms | no critic request |
| GenerationGovernor turn decision | report | <= 1 ms | local only; no provider/model request |
| write operation preflight excluding commit/readback | report | <= 15 ms | scope/lease/effect/preimage checks retained |
| write operation post-commit authority refresh | report | <= 20 ms | current view and version readback retained |
| Memory disabled | report | <= 1 ms | no projection and no model request |
| Memory v3 metadata, 50k rows | report | <= 12 ms | bounded query |
| Memory v3 bounded Vault recall | report | <= 35 ms | at most 6 selected bodies; fresh file/hash/envelope verification |
| Memory projection | report | <= 2 ms | bounded token quota |

Each threshold is per Interface call. A workflow may need multiple durable commits; implementations must coalesce only
when atomicity and failure semantics remain correct. A live lease is reused while more than half its configured TTL
remains; renewal near expiry and every authority mutation's in-transaction lease/fencing validation remain mandatory.

## 3. Task-class user-wait budgets

| Class | Expected route | PCH policy |
|---|---|---|
| Short | Single Build/DirectCell | no full PRD, no Worker, no profiler, one near WorkCell, one final oracle pass |
| Medium | Single or small Multi/AdaptiveRoute | 1-3 near WorkCells; optional parallel exploration only with expected benefit |
| Long | rolling Single/Multi | bounded active frontier, background telemetry, milestone checkpoint only at material transitions |

For all classes:

- additional model requests for planning/review/Memory/Output/status/compaction = 0;
- additional provider requests for warmup/cache measurement = 0;
- routine progress chat = 0 when Widget is available;
- transition results reuse their embedded status; only missing next/health/blocker deltas are model-visible, routine transitions add no status RPC and identical Widget text is ignored;
- the Agent does not probe `PI_MODEL`, `PI_SESSION`, provider, thinking or context-window environment/config values;
- no repeated read/test whose input closure is unchanged;
- no full test suite until the change surface or phase exit requires it.
- RouteRevision transports only replacement current/near WorkCells and changed metadata; unchanged metadata is rebuilt
  locally, and a fully finalized semantic no-op is rejected before authority mutation.
- Single reads may reuse the entire frozen Route scope while writes stay current-WorkCell scoped.
- exact edit preimage proof is local and bounded to a regular non-link file of 8 MiB, at most 64 unique non-overlapping
  edits and 1 MiB of edit arguments; otherwise the existing fresh-read path remains mandatory.
- finite validation timeout hints are normalized to 1-900 seconds locally instead of spending a model turn on a
  rejection that cannot change the authority budget.

Release reports P50/P95 for the available local Modules and separately records end-to-end provider-dependent fields as
`NOT_MEASURED_LOCAL`. A wall-time ratio is not compared across different models, prompts, workloads or quality results.

## 4. Multi admission budget

Multi has fixed costs: model/session startup, scoped copy, TaskPacket construction, extra generated tokens and serial
integration. The route should use Multi only when at least one is true:

1. two or more ready shards can overlap useful wall time;
2. role-local context materially reduces interference/rework risk;
3. independent verification is required by risk;
4. a cheaper user-configured role model provides positive expected value without reducing a hard gate.

Do not create PLANNER/EXPLORER/VERIFIER merely to fill roles. Copy is capped at 8,192 files/128 MiB per Worker.
`max_parallel_workers` is capped at eight and defaults to four. Timeout defaults to 15 minutes per Worker and remains
user-configurable in the validated range.

## 5. Input Context budget

- Runtime context window and current input usage come from Pi.
- Reserve 1,024 output tokens before optional evidence.
- Default soft/hard evidence additions: 512/2,048 estimated tokens.
- Deferred fetch: at most 10 items and 1 MiB per batch; signed cursor expires after 5 minutes.
- Workflow/protected/output additions use stable canonical bytes; volatile timestamps/paths are excluded.
- Exact evidence degrades to structural or deferred before protected authority is lost.

Input Context cannot claim reduced native Pi history. Measure only PCH contributions and provider-reported totals.

## 6. Cache budget and promotion

Cache C1 adds no payload mutation. Pi's provider hook dispatches Host accounting asynchronously, so the Host RPC and
SQLite transaction are not awaited before the provider call. The background accounting path must nevertheless stay
bounded: after 10 warmups, 100 sequential SQLite-backed samples require prepare P50/P95 at most 8/20 ms, settle P50/P95
at most 8/20 ms, and back-to-back ordered prepare-plus-settle P50/P95 at most 12/45 ms. Production prepare and settle
are separated by provider execution and neither Host RPC is awaited by the provider request. It is effective only for the verified
provider/API/base-URL contract and otherwise uses the C0 fallback without repository work. Positive provider `cacheRead` is
attributable; normalized zero remains unobservable. Diagnostics report confirmed hits, unknown requests and token-read
share separately. No fixed 90% target is a gate, and descriptive historical shares are not future guarantees. Any C2-C4
candidate must be non-inferior on correctness and user wait and show practical net benefit without filler or warmup.
`message_end` and recovery `turn_end` share one idempotent settlement owner; observing both produces one ledger. Missing
both stays `OUTCOME_UNKNOWN` rather than being converted into a synthetic zero.

## 7. Output budget

The stable directive is at most 24 estimated input tokens. Soft generated-text budgets are:

| Class | Tokens |
|---|---:|
| tool action prose | 0 |
| acknowledgement | 32 |
| question plus recommendation | 160 |
| status fallback | 80 |
| final result | 320 |

These are soft. Required evidence, risk, uncertainty and user-requested format expand. Hard truncation and rewrite model
requests are forbidden. Provider output accounting includes reasoning/tool arguments where observable.

## 8. Target-project optimization

The default `BASELINE_GUARD` performs no trial. `AUTO_GUARDED` requires a frozen PerformanceContract with PRIMARY,
REGRESSION and candidate-blind HOLDOUT workloads, correctness obligations, metric direction, practical threshold,
maximum three candidates, wall-time/user-blocking limits and rollback. All preregistered valid pairs count; no selective
discard. Any correctness failure rejects the candidate.

## 9. Regression response

When a local optional Module exceeds budget:

1. preserve correctness and record the sample/environment;
2. bypass only that optional Module to its baseline when configured;
3. identify synchronous I/O, repeated parsing, broad scan, copy scope or excess IPC;
4. repair and rerun only the affected performance test;
5. run the full performance suite at release exit.

Authority/effect/recovery gates cannot be bypassed for latency. A material regression blocks release.
