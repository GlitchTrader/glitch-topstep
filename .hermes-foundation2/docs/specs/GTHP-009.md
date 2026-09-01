# GTHP-009 — Flat evidence remains available to Hermes

**Issue:** #21  
**Priority:** P0 cognition correctness  
**Profile version:** 0.1.5

## Invariant

Scheduling may decide when a model call occurs for explicit operator cost or attention reasons. It may not convert market evidence into a hidden eligibility rule. When cadence invokes a cycle, Hermes receives the available evidence and owns whether to enter, hold, amend, exit, or do nothing.

## Changes

- Flat cadence defaults to every minute.
- `GLITCH_TOPSTEP_DECISION_FRAME_COUNT` is only the recent-frame context-window size.
- The first captured frame can reach Hermes; there is no fixed-frame warmup veto.
- Unchanged-evidence and stale-quote skip features remain optional operator scheduling controls but default false.
- Stale quote age, incomplete data, and unchanged evidence remain visible in the prompt.
- Positioned actions derive from the current packet's `execution.supported_actions`, including MOVE_STOP/MOVE_TP when advertised.
- The active prompt contains no daily percentage/dollar PnL objective, fixed risk percentage, trade quota, loss entitlement, or quantity baseline.

## Preserved boundaries

The worker still validates packet/account/instrument/profile/snapshot identity, strict schema, finite values, positive integer entry quantity, complete market-entry fields, directional stop/target geometry, and explicit operator forced-direction directives.

The gateway still owns current account/venue capacity, loss floor, mutation ownership, protection, reconciliation, and receipts.

## Evidence

- `scripts/run-topstep-cycle.py`
- `SOUL.md`
- `docs/AUTHORITY.md`
- `tests/test_direct_cycle.py`
- regenerated `SHA256SUMS`

The one-shot rewrite committed only after `py_compile` and the complete profile unittest suite passed.
