# PCH implementation playbook

The authoritative specification is [PI-CODING-HARNESS-BLUEPRINT.md](PI-CODING-HARNESS-BLUEPRINT.md).
This playbook describes efficient maintenance of the Single edition, not a calendar or a requirement to add features.

## 1. Efficient execution protocol

1. Run `scripts/show-resume-context.ps1` and inspect existing changes.
2. Read only the current decision, affected owner/callers and relevant blueprint sections.
3. Establish the smallest decisive failure or characterization before changing behavior.
4. Fix one related slice; run affected checks without repeating full validation or model benchmarks.
5. Update state after a material decision, boundary change or verification milestone.
6. At candidate exit, validate the complete current surface and installed behavior once.

All model work is the current Pi turn. Do not create a separate planner, critic, Worker, output rewrite or status
request. Deterministic decisions belong in existing local owners. Reuse current receipts; revalidate stale closures.

## 2. Current completion boundary

P0-P12 are historical implementation stages covering authority, Goal/route workflow, Single, optional context and
release closure. P5 Multi execution has been retired. Its SQL/history codecs remain for integrity, not execution.
P13 consolidates the Single product surface and its upgrade and validation behavior.

| Slice | Exit evidence |
|---|---|
| Entry and config | No Multi selection/tool/RPC; inactive path passive; old Worker config discarded; configured data root honored |
| Single work | Exact user contract freeze, bounded route, prepared/dispatched/observed/committed effects and fresh acceptance |
| Recovery | Exact binding, lease/fencing, pending effect and compaction guards; old Multi recovery refused before lease |
| Efficiency | No redundant topology choice, Worker startup, rollout collection or repeated equivalent completion work |
| Delivery | Source/metadata/docs agree; tests and installed arbitrary-cwd behavior pass; evidence limits explicit |

## 3. Protected contracts

- SQL 001-035 and immutable events/receipts are not rewritten to remove a retired feature.
- `/coding` remains the public entry. `single` is optional; `multi` is an actionable error.
- User contract approval cannot be performed by a model-visible tool.
- Models, thinking and provider selection come from Pi. Unknown price or usage is never reported as zero cost.
- DirectCell remains available. New prompts, questions or validation steps need a concrete correctness reason.
- New file writes invalidate the relevant oracle evidence; completed evidence is reused only for its current closure.
- Unknown side effects require reconciliation before retry. Performance gains never override this rule.

## 4. Verification protocol

Use affected tests during implementation and `npm run verify` at the candidate exit. That command covers local
performance, types, lint, build, full tests, SQL/JSON/Markdown, state projection, lifecycle, arbitrary-cwd imports and
source closure. It reuses the already successful build for lifecycle verification. `build:runtime` removes stale
generated output only after successful type checking and refuses linked output directories.

Paid smoke runs use a new isolated root, supplied Pi configuration and explicit request/time bounds. Stop at the
first actionable Harness defect, preserve the failed receipt and repair before starting a new run. An unchanged
successful epoch is not repeated for documentation edits. A small smoke is not a broad performance benchmark.

## 5. Completion record

Record the source revision, exact commands, result counts, runtime fingerprint, meaningful limits and the precise
next action in `manifests/PROJECT-STATE.json` using `scripts/update-project-state.ps1`. Regenerate migration/source
manifests once the change is stable. Reports and model artifacts stay out of the repository; checked documentation
may summarize their non-secret evidence. Commit/push/publish only within the user's actual authorization.
