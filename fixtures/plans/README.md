# Plan semantic fixtures

`tests/helpers/phase2.ts` loads `../plan.valid.json`, rebinds it to the current
Requirement fixture, and recomputes PCH-CJ1 integrity hashes. Plan-health tests
use that helper to exercise route decisions without duplicating a full Plan.
