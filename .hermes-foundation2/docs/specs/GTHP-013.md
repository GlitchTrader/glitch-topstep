# GTHP-013 — Idempotent intent delivery

**Issue:** [#47](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/47)  
**Priority:** P0  
**Gateway:** `GET /intent/receipt?intent_id=` (capability `intent_receipt_lookup`)

## Problem

After gateway registers an `intent_id`, a profile transport failure leaves the outbox retrying with a **refreshed** `snapshot_hash`. The gateway returns `intent_body_conflict` and management intents (`MOVE_STOP`, `EXIT`, …) stall.

## Solution

1. **Frozen delivery wire** — `state/delivery-wire/<packet_id>.json` stores the exact POST body from the first delivery attempt.
2. **Retries** reuse the frozen wire; `prepare_intent_for_delivery` does not refresh `snapshot_hash` while the wire exists.
3. **`intent_body_conflict`** triggers reconcile: re-POST frozen wire (gateway duplicate replay) or `GET /intent/receipt`.
4. **`intent_delivery_unreconciled`** stays `delivery_incomplete`; outbox retained.

## Files

- `scripts/parity.py` — `deliver_packet_intent`, wire persistence, reconcile
- `scripts/run-topstep-cycle.py` — `deliver_intent` wrapper
- `tests/test_direct_cycle.py` — fixtures

## Out of scope

- Weakening gateway body-hash rules
- Changing `glitch.intent.v2` schema
