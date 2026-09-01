# GTHP-025 — Neutral intent template and advisory change_condition contract

**Priority:** P0  
**Profile version:** 0.1.25  
**Prompt version:** glitch-topstep-v8

## Problem

Flat-cycle prompts anchored `required_output_template.action` and `decision_audit.final_choice` to `NOTHING` (or `HOLD` when positioned), biasing Hermes toward abstention. The cycle instruction also declared `wake_triggers` mandatory while the gateway rejects unknown fields (`intent_schema_invalid` / HTTP 422 when `wake_triggers` leaked or when contract confusion produced invalid wire shapes). `require_explicit_wake_triggers` parsed price language in `change_condition` and failed validation when triggers were absent — conflicting with advisory participation doctrine and blocking delivery.

## Invariant

- Hermes rebuilds action from current evidence each cycle; the template must not pre-select `action`, `confidence`, or `final_choice`.
- `change_condition` is accountability text, not a rigid worker gate.
- `wake_triggers` is optional local scheduling metadata for flat `NOTHING`/`HOLD` only; never a gateway field.
- Entry and management actions must not include `wake_triggers`.

## Changes

- `scripts/run-topstep-cycle.py`: neutral `build_prompt` template; per-action contract in `CYCLE_OPERATOR_INSTRUCTION`; relax wake validation; strip `wake_triggers` in `post_intent` as defense in depth.
- `scripts/parity.py`: `require_explicit_wake_triggers` becomes advisory no-op.
- `SOUL.md`, `skills/topstep-build-intent/SKILL.md`: rebuild-each-cycle and advisory `change_condition` language.
- `prompt_version` bump to `glitch-topstep-v8`; distribution `0.1.25`.

## Preserved boundaries

- No gateway schema change in this profile release.
- No trade quota, cadence gate, or hidden strategy rule in code.
- Wake monitor and `persist_wake_triggers` behavior unchanged when triggers are supplied.

## Evidence

- `scripts/run-topstep-cycle.py`
- `scripts/parity.py`
- `SOUL.md`
- `skills/topstep-build-intent/SKILL.md`
- `tests/test_direct_cycle.py`
- regenerated `SHA256SUMS`

## Follow-up (separate repos / issues)

- Gateway: return `field` + `error` detail on HTTP 422 (`intent_schema_invalid`) — profile issue #73.
- P1 packet data quality fixes — issue #73.
- P2 structural evidence — issue #74.
- P3 statistical calibration — issue #75.
