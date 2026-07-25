# Glitch Topstep parity ledger

This ledger maps useful behavioural contracts from the NinjaTrader edition into a Topstep-first implementation. Donor repositories are read-only. A row is complete only when implementation, deterministic tests, and required runtime evidence agree.

| Capability | Topstep state | Remaining acceptance evidence |
|---|---|---|
| Agent authority, no hidden deterministic strategy | Implemented | Real operator review and profile installation |
| Account, contract, instrument, profile, and prompt identity | Implemented | Real sanitized ProjectX session |
| User and market stream health | Implemented | Real disconnect/reconnect fixture |
| REST reconciliation after reconnect | Implemented | Compare restored state with TopstepX UI |
| Truthful `/health`, packet, and execution freshness | Implemented | Runtime stale/future timestamp fixture |
| Account-wide conservative equity | Implemented | Reconcile every open contract against TopstepX UI |
| Hard loss-floor calculation | Implemented for configured models | Automatic authoritative account lifecycle |
| Protected market entry translation | Scaffold implemented | Real provider bracket and fill evidence |
| Durable SQLite intent identity | Implemented | Process and Windows restart fixtures |
| Durable outbox before provider mutation | Implemented | Kill-point fixtures around every transition |
| Serialized entry settlement latch | Implemented | Real order/position propagation fixture |
| Ambiguous entry recovery | Implemented by exact historical custom-tag identity | Real transport-timeout fixture |
| Ambiguous close recovery | Implemented from authoritative flat position state | Real disconnect fixture |
| Orphan and missing-receipt reconstruction | Implemented | Actual crash fixtures |
| Persistent issued decision leases | Implemented | Process restart during model latency |
| Provider event journal | Integrated | Real payload-rate, reconnect, and disk-failure acceptance |
| Evidence-before-state ordering | Implemented | Real SignalR payload fixture |
| Sanitized raw realtime evidence | Implemented | Validate against current ProjectX payloads |
| Normalized REST reconciliation evidence | Implemented | Raw REST envelopes remain an explicit gap |
| Bounded market-event retention | Implemented | Tune retention from observed quote/print/DOM rates |
| Authenticated evidence inspection | Implemented | Operator acceptance and replay tooling |
| Explicit provider relationship index | Implemented | Validate `trade.orderId` retention on real payloads |
| Durable historical order/trade cursor | Implemented | Real ProjectX timestamp-boundary and restart acceptance |
| Bounded history windows and correction overlap | Implemented | Verify undocumented result caps or pagination behavior |
| Historical provider-version deduplication | Implemented | Real correction, void, and late-update payload fixtures |
| Submitted entry-order ownership | Implemented from durable provider order ID | Real offline interval and order-correction acceptance |
| Fill ownership | Implemented only from exact `trade.orderId` relation | Real partial, corrected, and voided fill fixtures |
| Ownership contradiction detection | Implemented | Real duplicate/correction payload acceptance |
| Authenticated ownership inspection | Implemented | Operator acceptance of `/ownership` output |
| Aggregate position ownership | Unknown by design | Explicit provider relation or deterministic reconstruction contract |
| Provider-created stop/target ownership | Missing, P0 | Explicit child-order, OCO, or equivalent provider relation |
| Exact structural bracket correction | Missing, P0 | Protective child identity and amendment proof |
| `MOVE_STOP` / `MOVE_TP` | Missing | Exact-leg mutation and sibling non-interference |
| Multiple independent entry tranches | Missing | Per-tranche protection ownership and restart reconstruction |
| Canonical completed outcomes | Missing | After-fee fill attribution, MFE, MAE, exit cause |
| Deterministic provider replay | Implemented offline and query-only | Compare replay state with real TopstepX state and observed corrections |
| Replay gaps, truncation, and invalid payload reporting | Implemented | Tune retention/export so required corpora remain complete |
| Multi-timeframe normalized market evidence | Missing | Integrated 1m/5m/15m/60m ProjectX series |
| Tape, delta, depth, and liquidity features | Raw streams journaled | Deterministic aggregation and replay fixtures |
| Instrument-general Topstep support | Configurable single contract | At least two Topstep-supported contracts |
| Topstep account-stage and payout lifecycle | Manual evidence only | Provider/dashboard provenance and reconciliation |
| Session, holiday, and early-close truth | Missing | Authoritative calendar and failure visibility |
| Replay and comparative cognition evaluation | Replay foundation implemented | Identical evidence corpus across cognition versions |
| Hermes autonomous cognition | Implemented in companion profile | Actual Windows/Hermes acceptance |
| First complete payout lifecycle | Missing | Reconciled account progression and payout evidence |

## Consolidated implementation sequence

1. **Authority, runtime truth, durable intent identity, and mutation recovery — implemented in software.**
2. **Integrated ProjectX evidence journal — implemented in software.**
3. **Exact submitted-entry and fill ownership from explicit provider IDs — implemented in software.**
4. **Durable offline order/trade history continuity — implemented in software.**
5. **Deterministic offline provider replay — implemented in software.**
6. Real ProjectX read-only, payload-rate, timestamp-boundary, disconnect, correction, replay comparison, and crash-window acceptance.
7. Explicit protective-child ownership discovery and protection reconstruction.
8. Exact amendments and multiple protected tranches.
9. Canonical outcomes and Hermes learning input.
10. Multi-timeframe and order-flow evidence.
11. Automatic Topstep policy and session truth.
12. One-account shadow evaluation, promotion review, and payout lifecycle.

## Promotion rule

Tests prove software contracts; they do not prove profitability or live readiness. `armed` promotion requires named runtime evidence for all P0 execution rows, followed by a frozen, attributable, after-fee shadow or simulated sample. Profitability remains an empirical property of the operator and evidence, not a claim inferred from architecture.
