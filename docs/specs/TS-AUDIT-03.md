# TS-AUDIT-03 — Quiet tape is cognition evidence

**Issue:** #47  
**Priority:** P1  
**Status:** implemented; repository verification pending

## Intent

Keep ProjectX order-flow measurements available to Hermes without converting one market condition into a hidden deterministic entry strategy.

## Invariant

Glitch may reject only when an intent is factually unexecutable, violates an authoritative account or venue boundary, lacks provable ownership/protection, or risks duplicate/ambiguous mutation. Market conviction belongs to Hermes.

## Change

1. Remove the `order_flow_trades_60s` execution gate.
2. Remove `order_flow_no_trades_60s` from `armed` downgrade reasons.
3. Preserve the complete `order_flow` object in every decision packet and decision-state hash.
4. Preserve state completeness, quote freshness, reconciliation, capacity, recovery, ownership, and protection checks.
5. Preserve risk-reduction permission under entry-only degraded state.

## Acceptance

- configured `armed` plus current reconciled venue state remains `armed` with zero 60-second prints;
- `order_flow.observation.windows[*].trade_count` remains in the packet;
- execution gates contain no tape-conviction predicate;
- stale quote and stale reconciliation still downgrade entry authority;
- the change cannot choose a direction, size, stop, target, or action;
- repository checks pass.

## Non-goals

No spread, depth, imbalance, volatility, session, or confidence threshold replaces the removed gate. No provider mutation is part of this spec.
