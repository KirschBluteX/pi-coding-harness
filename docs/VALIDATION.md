# PCH 1.3.0 Single validation

The Single code delivery has passing functional, lifecycle and isolated live-model evidence. The full performance
gate is **not passed** on the tested machine: durable writes and Cache C1 accounting exceed the existing budgets.
No Release or tag is part of this delivery. Final source-closure checks are recorded in
[project state](../PROJECT-STATUS.md) and its [machine-readable receipts](../manifests/PROJECT-STATE.json).

## Environment and scope

Validation date: 2026-10-10. Windows x64, PowerShell 7, npm 11, Node.js 24.19.0 with SQLite 3.53.3, and Pi 0.82.1.
The workspace, test data, temporary directories and npm cache were on X:, an NTFS volume on an NVMe SSD.
Git Bash was selected explicitly for Pi's local commands. These observations do not qualify every version in the
declared peer/engine range.

The supported flow is Single Plan/Build with user contract review, scoped execution, current oracle evidence,
interruption recovery, Memory, Input Context, Compaction, Output and conservative cache accounting. Public Multi
entry points, Worker execution and scheduling have been removed. SQL migrations 001-035 are unchanged; historical
codecs and integrity checks remain. Recovery rejects a historical requested/effective Multi Goal before acquiring
a new control lease. See [the upgrade instructions](USER-GUIDE.md#upgrading-from-12).

## Functional and installation evidence

| Check | Observed result |
|---|---|
| TypeScript, ESLint and runtime build | PASS; the final schema-fixture edit also passed compile and affected lint |
| Fresh serial Vitest suite | 105 files, 834 passed, 0 functional failures, 6 opt-in performance cases skipped |
| Host, Bridge and IPC regression set | 89 passed, including phase guidance after tool transitions and automatic WorkCell advancement |
| Runtime schema upgrade gate | 36 passed; each old schema is isolated and remains unchanged after refused runtime opening |
| Lifecycle | Install, upgrade and uninstall test files passed; installation tests also exercise doctor, WhatIf, configured data roots and explicit overrides |
| SQL | All 35 migrations passed; integrity `ok`, no foreign-key failures |
| Clean package installation | `npm ci` succeeded; real `pi install` and automatic extension discovery succeeded from an unrelated working directory |
| Pi-free package installation | A fresh 1.3.0 tarball installed without the optional Pi peer; the CLI active-loop smoke from an unrelated X-drive working directory made one local SSE request, displayed model text, and left the Goal recoverable |

An earlier full Vitest run recorded 813 passed, 6 failed and 6 skipped. Five failures were schema fixture cases
exceeding their existing 15-second case limit; the sixth was the new WorkCell guidance regression before its fix.
The final fresh full-suite run passed 834 tests after those fixes and the independent CLI additions. Parameterized
cases with identical display names remain separate cases. The six opt-in cases are not functional passes; four
current performance gates were exercised separately below.

A later final review found that shell cancellation ended only the direct CLI child process. New focused tests first
reproduced an orphaned validation descendant and missing direct-argument execution. The standalone shell now uses
the existing bounded process-tree runner. After that change, both affected unit files passed (8 tests), the
standalone Host integration file passed (2 tests), and TypeScript compile and ESLint passed. The 834-test full-suite
count is from before this narrow final fix; these later checks are separate and are not added to that count.

The first GitHub Windows CI run for this source found one test-fixture path error: its OS temporary directory was on
C:, so the independent CLI correctly rejected that data root before the test could check URL credentials. The fixture
now selects a repository-local `.tmp` path on the checkout drive. The focused entry test (2 cases), compile and lint
passed after the correction; the previous CI run's 835 passes and one failure are not called a green full-suite run.
The historical Memory v2/phase-6 performance cases were not enabled.

Schema fixtures now build each migration prefix once, checkpoint it and copy it into an isolated database per case.
The same 36 assertions finished in 34.83 seconds locally, versus about 302 seconds during the earlier run. The
15-second case limit and production migration logic are unchanged. This is a local test-setup observation.

The installed-package check used a deterministic local SSE provider stub. It verified that inactive loading and
rejected Multi entry create neither authority data nor provider requests; default Single entry reaches the real
Host, honors the configured X-drive data root and exposes only `coding_flow`, `coding_clarify` and `coding_context`.
Schema-35 integrity and foreign-key checks passed. The stub's text authorized no mutation. This check verifies
installation and transport, while the next check separately exercises a real model.

The independent CLI was also packed and installed with no Pi peer. `help`, `doctor` and `status` ran from an unrelated
X-drive working directory. The final installed-package active-loop smoke used a local SSE provider, observed exactly
one request with Host-controlled tools, displayed its text and stopped at a user review without applying changes.
The earlier bounded actual-gateway one-turn probe reached the Host through the independent CLI; an empty-directory
`ls` result is now represented as `[empty directory]` so the Host receives a valid nonempty tool result. That probe
left a recoverable Goal and is not a completed task or a cost/performance benchmark. It was not repeated after the
later display-only CLI change.

Local evidence files, intentionally excluded from Git:

- `reports/vitest-summary.json`, `reports/host-guidance-tests.json`, `reports/schema-upgrade-tests.json`;
- `reports/lifecycle-validation.json` and `reports/sql-validation.json`;
- `.tmp/installed-probe-450ed1c9-1c29-4a6a-947e-ae05c9d9767e/result.json`.

## Real model smoke

An isolated CSV parser task ran through real Pi, Bridge and Host using the user's OpenAI-compatible gateway. The
test session selected `gpt-6.1-sol` with thinking off; these are probe settings, not product defaults. A synthetic
USER event approved only that fixture's contract. The model submitted a route, edited the two authorized files,
ran `npm test`, and closed the Goal as `SUCCEEDED`. Seven separate holdout assertions passed.

| Measurement | Observed value |
|---|---:|
| Assistant responses / observed provider turns | 9 |
| Elapsed time, including probe instrumentation | 96,415 ms |
| Provider-reported input | 25,209 tokens |
| Provider-reported output | 2,120 tokens |
| Provider-reported cache read | 73,088 tokens |
| Dollar cost | UNKNOWN: gateway pricing was not supplied |

The fixture covered quoted commas, doubled quotes, unclosed-quote rejection, preservation of ordinary/empty fields,
and the existing exported API. Two earlier probes stopped at the first actionable failure. They exposed ambiguous
facet/subject guidance and missing phase guidance between Pi tool cycles. The fixes clarify the existing contract
and carry changed workflow guidance in existing responses; authority validation and USER review remain intact.

The later multi-WorkCell guidance correction is covered by deterministic Host/Bridge tests. The paid single-WorkCell
probe was not repeated after that correction. Its local receipt is
`.tmp/single-live-1791629548425-fd359667/result.json`. Credentials and raw conversations are not committed.

## Local performance

`npm run verify:performance` stopped at its first failed gate. The remaining three current performance files were
then run once, serially, with their opt-in flags and an isolated X-drive data root. No provider request was issued.
All thresholds below are the existing budgets; SQLite remained WAL with `synchronous=FULL`.

| Metric | P95 | Budget | Result |
|---|---:|---:|---|
| Single event commit | 63.84 ms | 20 ms | FAIL |
| Snapshot read | 3.96 ms | 8 ms | PASS |
| CAS put, 1 MiB | 74.44 ms | 35 ms | FAIL |
| Lease renewal | 0.041 ms | 8 ms | PASS |
| Automatic intake | 0.011 ms | 1 ms | PASS |
| DirectCell finalization | 1.16 ms | 15 ms | PASS |
| RouteHealth, 100 obligations / 256 records | 0.015 ms | 5 ms | PASS |
| GenerationGovernor turn decision | 0.024 ms | 1 ms | PASS |
| Operation preflight excluding commit/readback | 7.24 ms | 15 ms | PASS |
| Operation authority readback | 2.04 ms | 20 ms | PASS |
| Memory v3 metadata, 50k rows | 0.257 ms | 12 ms | PASS |
| Bounded Vault recall | 16.96 ms | 35 ms | PASS |
| Memory projection | 0.141 ms | 2 ms | PASS |
| Cache C1 prepare | 97.30 ms | 20 ms | FAIL |
| Cache C1 settle | 96.94 ms | 20 ms | FAIL |
| Cache C1 ordered round trip | 154.93 ms | 45 ms | FAIL |

Cache C1 P50 also exceeded its budgets. All 110 prepared requests settled with confirmed synthetic usage, no pending
entries and no accounting errors. This is local ledger evidence, not proof of provider cache hits. Task Flow and
Memory v3 passed their complete local gates; the phase-1 and Cache C1 gates failed. Raw samples, P50 values and
environment fingerprints are retained in `reports/phase-1-performance.json`, `reports/task-flow-v1-performance.json`,
`reports/memory-v3-performance.json`, `reports/cache-v2-performance.json` and
`reports/performance-followup-tests.json`.

The event transaction body P95 was 0.80 ms while its commit/flush P95 was 63.15 ms. A separate 100-sample storage
probe, after 10 warmups, reproduced the delay without PCH: bare SQLite WAL/FULL commit P95 111.28 ms, and file
`fsync` P95 50.17 ms; an in-memory SQLite transaction P95 was 0.004 ms. The receipt is
`reports/storage-floor.json`. The authority transaction, database and artifact-store implementations are unchanged
in this delivery. These measurements locate a substantial limit at the local durable-I/O boundary; they do not
identify a particular device, driver or background process as its cause, nor certify performance on another host.
Requalify the failed gates on the intended deployment data volume when that environment changes.

## Reproduction and evidence limits

Use a WAL-safe Node runtime for both `node` and npm's launched process. On Windows, a colocated `npm.ps1` may select
a different Node executable despite PATH ordering. Set `TEMP`, `TMP`, npm's cache and `PCH_PERFORMANCE_DATA_ROOT`
to the intended non-system volume before validation. `PCH_PERFORMANCE_DATA_ROOT` selects the benchmark's deployment
volume; it does not change the product's configured `data.root`.

For a fresh checkout, install dependencies, then run `npm run verify`. The aggregate intentionally fails when a
hard performance budget is exceeded. Deterministic CI runs the functional and source-closure checks separately;
a green CI badge does not certify local performance. Development state records the final closure commands and
the remaining performance qualification instead of replacing a failed result with a skip.

This evidence does not establish a percentage cost or speed improvement over native Pi, universal token savings,
production-length natural compaction, long-running reliability, or support for operating systems not exercised
here. Removing Worker startup, workspace mirrors, Multi scheduling and comparability telemetry reduces supported
machinery, but is not a substitute for a matched workload/cost experiment. Unknown gateway prices remain unknown.
