# Contributing to Pi Coding Harness

Pi Coding Harness treats recovery, authority, and evidence boundaries as public
contracts. A contribution is complete only when its behavior and failure modes
are demonstrated by fresh evidence.

## Before changing code

1. Read `AGENTS.md` and run:

   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/show-resume-context.ps1
   ```

2. Read only the relevant part of the normative
   `docs/PI-CODING-HARNESS-BLUEPRINT.md`, the affected source, and nearby tests.
3. Confirm whether the change affects authority, durable schema, Worker scope,
   recovery, privacy, provider behavior, or a public command.

`docs/PI-CODING-HARNESS-BLUEPRINT.md` is the only normative architecture source.
Architecture summaries and UI projections must not become competing authority.

## Development setup

```powershell
npm ci
npm run compile
npm run lint
npm test
npm run build
```

Use the narrowest test that can disprove the current change while iterating.
Run the aggregated release checks once the change cluster is stable:

```powershell
npm run verify
```

## Pull request expectations

A pull request should include:

- the observable behavior or invariant being changed;
- the authority owner and affected compatibility boundary;
- a regression, integration, fault, or lifecycle test that can fail for the
  original reason;
- exact commands and fresh results;
- explicit limitations, deferred provider evidence, or manual checks;
- schema and migration updates when durable state changes.

Do not weaken a gate, turn a failed check into a skip, or use generated output as
proof of runtime behavior. Worker narrative and UI state never authorize a side
effect.

## Security and privacy

Never commit credentials, `.env` files, runtime databases, raw provider payloads,
session data, dependency directories, build output, or reports. Follow
`SECURITY.md` for vulnerabilities and sensitive findings.

## Licensing

By submitting a contribution, you agree that it is licensed under Apache-2.0.
Do not copy code from incompatible sources. Preserve the MIT notice for Pi
Coding Agent, and update `THIRD_PARTY_NOTICES.md` when adding derived code.
