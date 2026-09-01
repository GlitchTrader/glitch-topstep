# GTHP-011 — Direct-cycle prompt payload optimization

**Issue:** #43  
**Priority:** P1  
**Profile version:** 0.1.19  
**Prompt version:** `glitch-topstep-v5` (unchanged; slimming is transport-only)

## Goal

Reduce peak direct-cycle stdin by ~40–50% without introducing hidden cognition gates or changing intent wire semantics.

## Phase 1 quick wins

- `decision_packet` omits duplicate `required_output_template` (template stays once in the envelope root).
- `packet_for_cycle()` compacts nested `market_observation` (features-only timeframes) and `order_flow` (15s/60s/300s windows + shallow depth).
- `recent_frames` exclude the current-minute duplicate after `capture_frame()`; flat cycles default to four historical frames (`GLITCH_TOPSTEP_FLAT_FRAME_COUNT`).
- `recent_glitch_ledger` tails shrink to four compact rows per stream; the two latest `change_condition` values stay full; older rows truncate `change_condition` and `reason`.
- `outcome_summary` aggregates trade count, net/fees, expectancy, side mix, and win/loss/inconclusive counts without full outcome blobs.
- Operator instruction text consolidated to `CYCLE_OPERATOR_INSTRUCTION` without doctrine loss.

## Preserved boundaries

- No automatic veto from data_quality, policy, capacity, or daily_economics mirrors.
- Gateway remains authoritative for factual execution checks.
- `prompt_version` bump is not required when only transport slimming changes.

## Evidence

- `scripts/packet_model.py`
- `scripts/run-topstep-cycle.py`
- `scripts/parity.py`
- `tests/test_packet_model.py`
- `tests/test_direct_cycle.py`
