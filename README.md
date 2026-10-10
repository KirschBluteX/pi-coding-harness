# Pi Coding Harness

[![CI](https://github.com/KirschBluteX/pi-coding-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/KirschBluteX/pi-coding-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

PCH 1.3 is a **Single-agent** coding harness with an independent CLI and an optional Pi Coding Agent adapter.
It scopes work, verifies changes with local evidence and restores the task after interruption.

[简体中文](README.zh-CN.md) · [User guide](docs/USER-GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Validation](docs/VALIDATION.md) · [Implementation specification](docs/PI-CODING-HARNESS-BLUEPRINT.md)

## What it does

- **Direct execution:** one Agent reads, edits and tests the real workspace. Small changes use one WorkCell.
- **Verified completion:** scope, lease, preimage, readback and fresh test evidence gate a successful delivery.
- **Recovery:** SQLite/CAS preserve the Goal, decisions, route, completed evidence and unresolved operations.
- **Bounded overhead:** three managed tools, local deterministic checks, current-evidence reuse and background accounting.
- **Passive until entered:** loading the extension starts no Host, opens no database and adds no model request.

The independent CLI uses an explicit OpenAI-compatible gateway, model and context window; the Pi adapter keeps the
current Pi provider, model and thinking level. Neither mode starts extra planner, reviewer or Worker sessions. Multi
execution has been removed from 1.3; old records remain readable.

PCH is useful when a change needs explicit acceptance, interruption recovery or controlled scope. Those guarantees
have overhead. This version does not claim that every tiny task uses fewer tokens or finishes faster than native Pi.

## Requirements

This delivery was exercised on Windows with PowerShell 7 (`pwsh`), npm 11 and Node.js 24.19.0. The Pi adapter was
tested with Pi Coding Agent 0.82.1 and declares `>=0.81.0 <=0.82.1`. Node.js must be `>=22.22.3 <23` or `>=24.15.0`
with the SQLite WAL-reset fix; `pch doctor` checks the embedded SQLite version without opening a database.
The Pi adapter also needs Bash for local commands. If Git Bash is installed on a custom drive, set Pi's `shellPath`
accordingly
(for example, `"X:/Git/bin/bash.exe"` in Pi `settings.json`).

## Independent CLI

Clone the repository to a non-system drive, run `npm ci` and `npm run build:runtime`, then start the CLI from any
working directory. On Windows, set `TEMP`, `TMP` and `NPM_CONFIG_CACHE` to non-system-drive paths before installing.
The selected data root holds authority, session history, CLI temporary files and its npm cache.

```powershell
$cli = (Resolve-Path ./dist/cli/index.js).Path
$env:PCH_API_KEY = '<your gateway key>'
node $cli doctor --workspace X:/my-project --data-root X:/PCH-data
node $cli plan 'Inspect the project' --workspace X:/my-project --data-root X:/PCH-data --base-url https://gateway.example/v1 --model your-model --context-window 64000
node $cli status --workspace X:/my-project --data-root X:/PCH-data
```

`run` starts a Build Goal; `plan` stops for an explicit Build/Keep/Revise choice. Use `resume GOAL-ID` with the same
workspace, data root and gateway options after interruption. The CLI cannot approve its own Goal Contract or replay
an unknown effect. Keep the key in a named environment variable; use `--api-key-env NAME` to select another name.
The CLI is a candidate for the first formal release while X-drive performance and longer-run experience remain open.

## Pi adapter install

Clone to the drive where you want the workspace, then run:

```powershell
git clone https://github.com/KirschBluteX/pi-coding-harness.git
cd pi-coding-harness
npm ci
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/doctor.ps1
```

Runtime data defaults to `~/.pi/agent/coding-harness`. To keep it on another drive, set an absolute `data.root` in
`config/default.json` before installation. A lifecycle `-DataRoot` argument overrides that invocation only.
Build output is recreated from checked source so retired executables cannot survive an upgrade.

## Pi adapter use

```text
/coding build fix the CSV parser and run its tests
/coding plan review a staged refactor before implementation
/coding
/coding recover <goal-id>
/coding status
/coding pause
/coding resume
/coding replan the current API assumption is invalid
/coding exit
```

Build proposes a small Goal Contract for one user review, then freezes the route and executes. Plan stops for
Build/Keep/Revise. The Widget carries routine progress. Existing `/coding single build ...` syntax still works.
See the user guide for headless contract review, clarification and cancellation commands.

## Upgrade from 1.2

Single tasks keep their existing authority and recovery state. The retired Worker config fields are ignored.
SQL migrations and immutable historical records are preserved.

An unfinished task that requested Multi fails recovery with `LEGACY_MULTI_UNAVAILABLE` before a new controller
takes its lease. Reconcile and cancel it in PCH 1.2.1 before upgrading that workspace, or use a separate workspace.
No old Multi task is silently converted into Single. See [upgrade details](docs/USER-GUIDE.md#upgrading-from-12).

## Verification and limits

```powershell
npm run verify
```

Verification covers types, lint, tests, SQL/JSON/Markdown, install/upgrade/uninstall, arbitrary-cwd imports,
performance and source closure. Current results are in [Validation](docs/VALIDATION.md) and
[project state](PROJECT-STATUS.md). Paid provider tests use separate isolated workspaces and bounded stop conditions.

The Single functional checks pass. Local durable-write and Cache C1 accounting latency exceeded their budgets on
the tested X-drive environment; performance qualification remains open. This code delivery does not create a Release.

Cache remains C0 for unsupported provider contracts. Missing usage or unknown gateway pricing is reported as unknown.
Natural compaction at a production-sized context window and broad comparative cost claims remain outside the
demonstrated evidence. The old Multi/four-way benchmark is outside this edition's scope.

For the Pi adapter, API keys belong in Pi's credential configuration. Keep credentials and runtime databases out of Git.
See [SECURITY.md](SECURITY.md) for reporting security issues and [LICENSE](LICENSE) for Apache-2.0 terms.
