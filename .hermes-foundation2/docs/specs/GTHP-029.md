# GTHP-029 — Packet evidence sanitization for model prompts

**Priority:** P1 (packet parity, profile side of #73)  
**Status:** done  
**Depends on:** GTHP-027

## Problem

Gateway packets can expose misleading fields to Hermes:

- `session_high` / `session_low` equal `last` or `session_open` at session start
- negative `quote_age_ms` from clock skew
- empty depth blobs without an explicit unavailability flag
- partial bars with extreme `volume_z_score_20` on incomplete volume

These are evidence-quality issues, not automatic cognition vetoes, but the model must not treat them as structural edges.

## Scope

### `scripts/packet_model.py`

- [x] `sanitize_market_for_model` — `session_levels_reliable` + note when unreliable
- [x] `sanitize_quote_age_ms` — clamp to `max(0, value)` in `data_quality` and `stream_health`
- [x] `sanitize_depth_for_model` — `available: false` + note when book data absent
- [x] `annotate_partial_timeframes` — `partial_bar_note` on depressed partial-bar volume z-score
- [x] `detect_continuity_gap` — minute-frame hole summary in `CURRENT_CYCLE`
- [x] `sanitize_data_quality_for_model` — `quote_clock_skew` issue when raw `quote_age_ms` was negative

### Operational

- [x] `scripts/preflight-pairing.py` — profile vs gateway prompt pairing check
- [x] `scripts/sync-glitch-topstep-prompt-v9.sh` — Linux gateway v9 sync
- [x] `docs/OPERATIONS.md` — ProjectX Auto OCO Brackets checklist

### `scripts/parity.py`

- [x] `packet_quote_age_ms` clamps negative ages
- [x] `compact_receipt_row` preserves gateway `field` / `error` / `message` on 422 receipts
- [x] `delivery_diagnostic_detail` for `intent_delivery_rejected` events

### Gateway (non-profile, issue #73)

- Return `field` + `error` on HTTP 422 (`intent_schema_invalid`)
- Emit truthful `session_high` / `session_low` and non-negative `quote_age_ms` at source

## Non-goals

- Worker gates on sanitized flags
- Gateway implementation in this profile repo

## Acceptance

- Unittest coverage for sanitization helpers and receipt detail compaction
- Model packet shows reliability flags without dropping raw values

## Related

- GTHP-028 cognition delta audit
- GitHub issue #73
