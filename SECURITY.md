# Security policy

## Supported version

Pi Coding Harness is currently a research preview. Security fixes target the
latest `main` branch; no older release line receives backports yet.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow from the repository Security
tab. Do not open a public issue for a vulnerability or include credentials,
session data, provider payloads, or local authority databases in a report.

Include the smallest safe reproduction, affected commit, expected boundary,
observed behavior, and whether the issue involves:

- Extension/Host authentication or replay protection;
- SQLite authority, leases, fencing, CAS, or recovery;
- Worker scope, mirror isolation, PatchSet integration, or command execution;
- secret handling, Memory encryption, telemetry, or provider payloads;
- local path access, credentials, or session controls.

You should receive an acknowledgement within seven days. A coordinated fix and
disclosure timeline will be agreed after reproduction and impact are confirmed.

## Public hardening discussions

Non-sensitive defense-in-depth improvements may use a normal issue or pull
request. When uncertain, report privately first.
