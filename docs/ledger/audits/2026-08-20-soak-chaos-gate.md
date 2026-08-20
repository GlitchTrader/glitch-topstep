# TS-AUDIT-13 — Soak and chaos gate (gateway)

**Date:** 2026-08-20  
**Issue:** [#168](https://github.com/GlitchTrader/glitch-topstep/issues/168)

## Gate stages

| Stage | Behavior |
|-------|----------|
| Report | `scripts/validate-soak-evidence.mjs` validates soak JSON attached to release evidence |
| Beta | CI test `tests/soak-evidence-gate.test.ts` blocks regressions in required chaos matrix |
| Armed | Human approval + non-empty `paired_release_ref` + zero `invariants_violated` |

## Required chaos scenarios

- `reconnect`
- `rate_limit_429`
- `auth_expiry`
- `disk_pressure`
- `partial_restart`

Minimum soak duration: **24 hours**.

## Evidence schema

`glitch.topstep.soak_evidence.v1` with `paired_release_ref` pointing at `glitch.topstep.paired_release.v1`.
