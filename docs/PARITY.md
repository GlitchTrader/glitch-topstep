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
| Ambiguous entry recovery | Implemented by exact historical custom-tag identity | Real transport-timeout fixture |
| Ambiguous close recovery | Implemented from authoritative flat position state | Real disconnect fixture |
| Orphan and missing-receipt reconstruction | Implemented | Actual crash fixtures |
| Persistent issued decision leases | Implemented | Process restart during model latency |
| Fill-to-bracket ownership | Missing, P0 | Entry, fill, stop, and target provider events |
| Exact structural bracket correction | Missing, P0 | Provider child-order identity and amendment proof |
| `MOVE_STOP` / `MOVE_TP` | Missing | Exact-leg mutation and sibling non-interference |
| Multiple independent entry tranches | Missing | Per-tranche ownership and restart reconstruction |
| Canonical completed outcomes | Missing | After-fee fill attribution, MFE, MAE, exit cause |
| Provider event journal and replay | Missing | Integrated raw/normalized event persistence |
| Multi-timeframe normalized market evidence | Missing | Integrated 1m/5m/15m/60m ProjectX series |
| Tape, delta, depth, and liquidity features | Raw streams only | Deterministic aggregation and replay fixtures |
| Instrument-general Topstep support | Configurable single contract | At least two Topstep-supported contracts |
| Topstep account-stage and payout lifecycle | Manual evidence only | Provider/dashboard provenance and reconciliation |
| Session, holiday, and early-close truth | Missing | Authoritative calendar and failure visibility |
| Replay and comparative evaluation | Missing | Identical evidence corpus across cognition versions |
| Hermes autonomous cognition | Implemented in companion profile | Actual Windows/Hermes acceptance |
| First complete payout lifecycle | Missing | Reconciled account progression and payout evidence |

## Consolidated implementation sequence

1. **Authority, runtime truth, durable intent identity, and mutation recovery — implemented in software.**
2. Real ProjectX read-only and crash-window acceptance.
3. Integrated provider event journal and replay corpus.
4. Provider bracket ownership, protection reconstruction, and exact amendments.
5. Canonical outcomes and Hermes learning input.
6. Multi-timeframe and order-flow evidence.
7. Automatic Topstep policy and session truth.
8. One-account shadow evaluation, promotion review, and payout lifecycle.

## Promotion rule

Tests prove software contracts; they do not prove profitability or live readiness. `armed` promotion requires named runtime evidence for all P0 execution rows, followed by a frozen, attributable, after-fee shadow or simulated sample. Profitability remains an empirical property of the operator and evidence, not a claim inferred from architecture.
