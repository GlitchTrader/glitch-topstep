# PRAC overnight soak — 2026-09-11

## Classification

`blocked`

`gateway_supervised_overnight=false`

## Transition

The smoke passed and was reconciled, but the overnight soak was not started.

### Original block rationale (process supervisor)

The ensemble runner executes one envelope per process and does not provide an official long-running Hermes supervisor. An ad-hoc loop was not used because it could leave a live position unmanaged after an abnormal exit.

### Re-evaluation (2026-09-11) — gateway authority

Re-audited without assuming a separate supervisor is required. Conclusion: **gateway venue-side protection + admission gates cover Hermes death when stops are already confirmed**, but the overnight release criteria still fail because:

1. On `protection_status: failed` / exhausted rearm, the gateway **does not auto-flatten** (`docs/OPERATIONS.md`).
2. Safety supervisor remains **observe-only**.
3. No reproducible Hermes-runner-death test matrix with live position.
4. Absolute “zero unprotected exposure” is not an enforced autonomous invariant (operator flatten still required in failure path; see historical unprotected incident evidence).

Full analysis: [`gateway-authority-reevaluation.md`](./gateway-authority-reevaluation.md).

**Missing function (minimal):** fail-closed autonomous flatten when unprotected open quantity persists after protection verification / rearm failure — not a process-restart watchdog.

## Smoke gate that approved transition

- Six profiles invoked on one common envelope
- Global decision: `no_selection` / `INSUFFICIENT_ENSEMBLE_AGREEMENT`
- Orders: `0`
- Intents: `0`
- Account: flat
- Reconciliation: succeeded

## Final gateway state

- Gateway SHA (smoke): `4943b3265bb83836867a6ff0f0d61296d3567e61`
- Gateway SHA (post-sync / re-eval): `50e68db592d5cb1543402c8bae0c2b2718253fe5`
- Profile SHA: `a1ac0f5bef81a15a0693241e732d1c33abb8e361` (`origin/main`)
- Health: `ok` (at smoke)
- Open contracts / working orders (smoke): `0` / `0`
- Hermes/soak processes: not started

No reset, order, intent, fill, write, or exposure was created by the blocked transition or by this re-evaluation. No canary, promotion, dynamic routing, or new session was started.

## Required follow-up

Ship and test gateway fail-closed flatten on protection/rearm failure (ownership-proven). Then set `gateway_supervised_overnight=true` and only then auto-chain smoke → overnight with fail-stop. Until then overnight remains blocked.
