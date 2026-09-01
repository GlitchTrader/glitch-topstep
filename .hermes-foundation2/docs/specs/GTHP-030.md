# GTHP-030 — Prompt polish and intent contract test matrix

**Priority:** P1 (prompt hygiene post-#73)  
**Status:** done  
**Issue:** #89  
**Depends on:** GTHP-028, GTHP-029

## Problem

External review (2026-08-07) rated the v9 prompt ~9/10 after #73 fixes. Four small gaps remained:

1. `wake_triggers` copy still said "flat NOTHING or HOLD" despite HOLD being positioned-only.
2. Duplicate memory-read instructions could imply mandatory external memory search.
3. Skip/gate diagnostics could surface negative `quote_age_ms` while the model packet showed `0`.
4. Intent contract tests covered samples but not a full per-action valid/invalid matrix.

## Scope

### `scripts/run-topstep-cycle.py`

- [x] Clarify `wake_triggers`: optional for flat `NOTHING` and positioned `HOLD` separately.
- [x] Single memory instruction: `recent_glitch_ledger` primary; optional one read-only memory search.

### `scripts/packet_model.py` + `scripts/parity.py`

- [x] Preserve `raw_quote_age_ms` and `clock_skew_detected` when sanitizing negative ages.
- [x] `market_quiescent_skip_details` uses normalized age + explicit skew fields for events.

### Tests

- [x] `IntentContractMatrixTests` — valid/invalid samples per action (ENTER_*, HOLD, NOTHING, MOVE_*, EXIT).

## Non-goals

- Gateway `gateway-mode.ts` gate detail strings (separate gateway follow-up).
- Participation metrics (#75) or structural levels (#74).

## Acceptance

- Prompt text has no flat+HOLD contradiction.
- Skip events never log negative `quote_age_ms` without a normalized companion.
- Unittest matrix covers all primary wire actions.

## Related

- Issue #75 (P3 calibration)
- Issue #74 (P2 structural evidence)
