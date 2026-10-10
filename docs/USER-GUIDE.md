# Pi Coding Harness user guide

## What changes when you enter

Pi behaves normally until `/coding`. After entry, a local Host tracks the coding Goal, shows compact status, gates
writes and preserves recovery state. The current Pi provider/model/thinking/context
configuration is reused unchanged.

## Start a task

Interactive:

```text
/coding
```

The Goal picker offers recovery or a new task. New tasks ask for Plan or Build and the objective.
Build is recommended for a concrete fix; execution always uses the current Single Agent.

Direct:

```text
/coding build 修复 CSV 解析器的引号边界问题并运行现有测试
/coding plan 设计并评估支付模块的可回滚拆分路线
```

### Single execution

The current Agent reads, edits and verifies the real workspace under PCH's operation gate. PCH creates no additional
Agent sessions. `/coding single build ...` remains accepted; the `single` word is optional.
Multi execution is unavailable in 1.3. See [upgrading from 1.2](#upgrading-from-12) for existing data.

### Plan or Build

**Build** does not force a full PRD. It creates the smallest complete contract and near-term route, then implements.
Material ambiguities are asked in one batch with a recommendation.

The proposed Goal Contract is reviewed once by the user before its scope and acceptance requirements are frozen.
The model cannot approve its own contract. In a session without interactive UI, review the displayed proposal and use
`/coding review approve` or `/coding review reject <feedback>`. Contract approval starts the next productive turn.

**Plan** creates a detailed contract only to the level the product/task needs, checks the route for missing
acceptance, unsafe assumptions, rollback, performance and avoidable work, and freezes it without modifying target
files. Pi then asks:

- Enter Build (recommended when ready)
- Keep plan only
- Revise technical route

## During execution

The Widget shows Goal, topology, WorkCell, route health, next action and blocker. Normal progress uses the Widget
instead of repeated chat. Tool work may be silent; Pi should speak when it needs a decision, hits a blocker or has
final verified evidence.

```text
/coding status
/coding pause
/coding resume
/coding replan 当前库版本不支持原方案中的 API
/coding cache
```

Without Pi UI, material questions remain OPEN until the user explicitly selects an advertised option:

```text
/coding clarify FORMAT=json
/coding clarify FORMAT=json,COMPAT=strict
```

`pause` stops new execution at an authority boundary. `resume` first reconciles an unknown effect when needed.
`replan` changes technical route; it does not silently change user behavior/scope/acceptance. Cancellation requires
Pi UI confirmation:

```text
/coding cancel
```

Exit flushes local observation work, stops the Host and removes Harness tools while preserving other extension tools:

```text
/coding exit
```

## Memory

Memory is workspace-scoped, encrypted and optional. It supports both guarded automatic capture and explicit control.
Automatic capture is deterministic and conservative: explicit durable preferences and verified user decisions are
eligible; quotations, temporary directions, uncertainty, secrets and ambiguous text are rejected or proposed.

Use `/memory help` to see the exact installed grammar. Typical actions are status, explicit remember, recall,
correction, forget and purge. `forget` is reversible hiding. `purge` destroys reachable encrypted content/key material
for the selected scope while retaining non-content audit so recovery cannot restore it.

## Context and compaction

PCH injects only current workflow authority, a short output policy and bounded relevant evidence. Larger exact evidence
is deferred. The Agent can call `coding_context` to retrieve a current item or signed continuation without rereading a
whole document. This reduces PCH-added context; it does not remove Pi's native conversation history.

Before Pi native compaction, PCH records an exact semantic frontier. After compaction it verifies Goal, route,
WorkCell and pending-effect state. A mismatch blocks mutation and asks for reconciliation rather than silently
continuing from a wrong summary.

## Cache

Cache uses non-mutating C1 only for a supported provider integration matching the active Pi runtime. Other providers,
APIs or base URLs automatically use C0. `/coding cache` shows the configured and effective arms, confirmed positive
reads, unknown zero values, pending observations and token-read share. It never interprets normalized zero as a miss,
adds provider fields, or guarantees a future hit rate.

## Performance optimization

PCH prefers a faster valid route during planning. It does not benchmark every small task. Automatic user-project
profiling needs an explicit request or credible hotspot plus representative workloads and correctness tests. A trial
freezes primary, regression and holdout workloads, compares paired samples, rejects any correctness regression and
keeps rollback available.

PCH overhead and your project's runtime improvement are reported separately.

## Recovery

Reopening the same Pi session automatically validates its existing Goal binding without starting a model request.
Use `/coding` to choose a recoverable Goal, or `/coding recover <goal-id>` in a session without a UI. Use
`/coding new build <objective>` to explicitly begin new work. Recovery verifies SQLite, takes a lease, reconciles
pending writes and restores the exact next action. It reuses completed WorkCells whose evidence is still current.

### Upgrading from 1.2

Single Goals and schema 35 data remain compatible. The old `worker_timeout_ms`, `max_parallel_workers` and
`worker_runtime` config fields are ignored and discarded from the effective configuration; they may be deleted.
No historical tables, events or artifacts are erased during upgrade.

An unfinished Goal that requested Multi is never converted into Single, including one still waiting for admission.
Recovery returns `LEGACY_MULTI_UNAVAILABLE` before taking its controller lease. Reconcile and cancel that Goal using
PCH 1.2.1 before upgrading its workspace, or continue Single work in a separate workspace. Do not delete the database
to bypass a pending effect. Completed Multi records remain available as historical data.

## Installation and data

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/doctor.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/upgrade.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

Default data is `~/.pi/agent/coding-harness`. Uninstall preserves it. Export-and-delete is explicit:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1 `
  -ExportPath X:\PCH-Export -DeleteData
```

Never put API keys or credentials in PCH prompts, config, source or migration manifests.
