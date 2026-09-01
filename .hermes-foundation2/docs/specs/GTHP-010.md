# GTHP-010 — Gateway/profile/schema compatibility

**Issue:** #22  
**Priority:** P0 release correctness  
**Profile version:** 0.1.6

## Invariant

A trading profile is deployable only when its gateway, packet schema, intent schema, prompt contract, controls, and learning/outcome expectations are one compatible release set. README prose is not sufficient authority.

## Changes

- Add `scripts/compatibility.py` as the machine-readable profile compatibility manifest.
- `verify_gateway_compatibility()` in `common.py` fails closed when `/health` is missing the gateway contract or reports an incompatible version, schema, or capability set.
- `run-topstep-cycle.py` verifies compatibility before fetching `/packet`.
- `gateway_feed_is_fresh()` requires compatibility before learning uses live evidence.
- `/topstep_status` reports compatibility summary; `/trade` refuses to resume jobs on an incompatible pair.
- `setup.ps1` reports `distribution_version` `0.1.6` and warns when the local gateway is unreachable or incompatible.
- Ledger binds profile beta acceptance to gateway `TS-BETA-01` with gateway `0.1.2` as the tested pair.

## Preserved boundaries

- No automatic gateway update from the profile.
- No live-readiness or profitability claim.
- No hidden strategy compatibility rule.
- `topstep-build-intent` may emit `MOVE_STOP`, `MOVE_TP`, partial `EXIT`, and `target_intent_id` when the current packet advertises those actions in `execution.supported_actions`.

## Evidence

- `scripts/compatibility.py`
- `scripts/common.py`
- `scripts/run-topstep-cycle.py`
- `plugins/topstep-control/__init__.py`
- `setup.ps1`
- `tests/test_compatibility.py`
- regenerated `SHA256SUMS`

The change committed only after `py_compile` and the complete profile unittest suite passed.
