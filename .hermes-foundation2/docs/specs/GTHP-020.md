# GTHP-020 — Bracket verification consumption (`protection.protection_status`)

**Status:** done  
**Priority:** P1  
**Profile version target:** 0.1.22+  
**Depends on:** GTHP-009, GTHP-012  
**Gateway dependency:** `glitch-topstep:TS-R4-08` (`protection.protection_status` on `decision_packet.v2`)

## Problem

Gateway 0.1.6+ exposes post-entry bracket verification as `protection.protection_status` (`pending` | `confirmed` | `failed` | `unknown`). Hermes must consume this field for positioned management without auto-flattening or hidden ENTER vetoes.

## Invariant

| Layer | Rule |
|-------|------|
| **Evidence** | `protection.protection_status` is factual venue/reconciliation state from the gateway. |
| **Cognition** | Skills and cycle prompt guide management by status; failed/unknown prioritize risk-reducing `EXIT`. |
| **Worker** | `validate_intent` rejects `MOVE_STOP`/`MOVE_TP` unless status is `confirmed` (parity with gateway `protection_not_proven`). |
| **Flat** | Field absent or ignored when flat. |
| **Learning** | Unchanged — outcome `protection_status` attribution remains separate. |

## Status semantics

| Status | Hermes behavior |
|--------|-----------------|
| `confirmed` | Full management including amendments. |
| `pending` | Prefer `HOLD`; `EXIT` allowed; amendments blocked client-side. |
| `failed` | Prioritize `EXIT`; amendments blocked; name failed protection in audit. |
| `unknown` | Conservative `HOLD`/`EXIT`; amendments blocked. |

## Acceptance

- `parity.packet_protection_status` with legacy `protection.status` fallback.
- `run-topstep-cycle.py` prompt + `protection_management` envelope + amendment guard.
- `SOUL.md`, `topstep-assess-risk`, `topstep-build-intent` reference the field.
- `docs/OPERATIONS.md` operator note on `failed`.
- Regression tests in `tests/test_direct_cycle.py`.
- `tested_gateway_version` → 0.1.6.

## Stop line

No auto-flatten, no flat-cycle skip, no ENTER veto from protection status.

## Related

- GTHP-018 (quiescence skip precedent)
- `glitch-topstep:TS-R4-08`, `docs/OPERATIONS.md` (gateway operator retry)
