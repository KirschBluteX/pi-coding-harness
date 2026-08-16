# Pi Coding Harness user guide

## What changes when you enter

Pi behaves normally until `/coding`. After entry, a local Host tracks the coding Goal, shows compact status, gates
writes, preserves recovery state and optionally runs isolated Workers. The current Pi provider/model/thinking/context
configuration is reused unchanged.

## Start a task

Interactive:

```text
/coding
```

Pi asks three things: Single or Multi, Plan or Build, and the objective. The recommendations are Single and Build
because they have the least overhead for ordinary fixes.

Direct:

```text
/coding single build 修复 CSV 解析器的引号边界问题并运行现有测试
/coding multi plan 设计并评估支付模块的可回滚拆分路线
```

### Single or Multi

Use **Single** for a small fix, tightly coupled refactor, one module, or when you want the lowest startup cost. The
current Agent reads, edits and verifies the real workspace under PCH's operation gate.

Use **Multi** for independent modules, parallel research/implementation, or a long task where role-local context is
worth extra Worker tokens. Workers see only assigned roots and a short TaskPacket. They edit temporary mirrors; the
Host verifies and integrates their patches. Multi can consume more total tokens while reducing wall time and context
interference. It is not automatically better for every task.

### Plan or Build

**Build** does not force a full PRD. It creates the smallest complete contract and near-term route, then implements.
Material ambiguities are asked in one batch with a recommendation.

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

In Multi, memory remains Supervisor-private unless the exact claim/version is explicitly marked verified shared.

## Context and compaction

PCH injects only current workflow authority, a short output policy and bounded relevant evidence. Larger exact evidence
is deferred. The Agent can call `coding_context` to retrieve a current item or signed continuation without rereading a
whole document. This reduces PCH-added context; it does not remove Pi's native conversation history.

Before Pi native compaction, PCH records an exact semantic frontier. After compaction it verifies Goal, route,
WorkCell, Worker and pending-effect state. A mismatch blocks mutation and asks for reconciliation rather than silently
continuing from a wrong summary.

## Cache

Cache runs in non-mutating C1 when Pi is using the verified `geekspace/openai-completions` runtime. Other providers,
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

If Pi or the Host exits, run the same `/coding ...` entry from the same workspace/session context. PCH verifies SQLite,
takes a lease, fences orphaned Workers, reconciles pending writes and restores the exact next action. It does not redo
a completed WorkCell whose input/evidence closure is still current.

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
