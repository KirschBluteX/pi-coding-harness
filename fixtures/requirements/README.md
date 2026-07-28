# Requirement semantic fixtures

`tests/helpers/phase2.ts` loads `../requirements.valid.json` and recomputes
PCH-CJ1 integrity hashes. Performance-contract and planning tests use the helper
so the normative Requirement payload is maintained in one place.
