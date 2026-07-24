# Glitch Topstep parity ledger

This ledger maps the useful behavioural contracts from the NinjaTrader edition into a Topstep-first implementation. Donor repositories are read-only. A row is complete only when implementation, deterministic tests, and required runtime evidence agree.

| Capability | Topstep state | Acceptance evidence |
|---|---|---|
| Agent authority, no hidden deterministic strategy | Implemented in branch | `docs/AUTHORITY.md`; config, packet, risk, and profile tests |
| Account and contract identity binding | Scaffold implemented | Real ProjectX shadow session with sanitized payload captures |
| User and market stream health | Implemented in branch | reconnect, close, malformed-payload, and generation tests; real reconnect fixture pending |
| REST reconciliation after reconnect | Implemented in branch | real ProjectX disconnect/reconnect comparison pending |
| Truthful `/health` | Implemented in branch | endpoint reports degraded state and exact issues |
| Current packet publication with leased decision identity | Implemented in branch | packet changes with current state; issued hash remains resolvable until expiry |
| Factual hard loss-floor calculation | Implemented for configured models | authoritative automatic account lifecycle still pending |
| Protected market entry translation | Scaffold implemented | real shadow payload and provider bracket ownership pending |
| Durable idempotency and execution outbox | Missing, P0 | SQLite unique intent, outbox-before-submit, ambiguous transport recovery |
| Restart reconstruction | Missing, P0 | process-kill fixtures with zero duplicate entry and truthful final state |
| Fill-to-bracket ownership | Missing, P0 | prove entry, fill, stop, and target ownership from provider events |
| Exact structural bracket correction | Missing, P0 | reconcile provider-created brackets to absolute intended prices |
| `MOVE_STOP` / `MOVE_TP` | Missing | exact-leg mutation and sibling non-interference tests |
| Multiple independent entry tranches | Missing | per-tranche ownership, protected downside, and restart reconstruction |
| Canonical completed outcomes | Missing | after-fee fill attribution, MFE, MAE, exit cause, policy effects |
| Multi-timeframe bars and normalized market features | Missing | 1m/5m/15m/60m bars with timestamp and gap provenance |
| Tape, delta, depth, and liquidity features | Raw streams only | deterministic aggregation, freshness, and replay fixtures |
| Regime and structure evidence | Missing | descriptive features only; no coded entry strategy |
| Instrument-general Topstep support | Configurable single contract | test at least two Topstep-supported contracts with native metadata |
| Topstep account-stage and payout lifecycle | Manual evidence only | primary-source versioning plus observed dashboard/provider reconciliation |
| Session, holiday, and early-close truth | Missing | authoritative calendar and fail-visible source degradation |
| Replay and comparative evaluation | Missing | identical event corpus evaluated across cognition versions |
| Hermes autonomous observation and learning | Companion branch in progress | no packet-quality/capacity pre-gate; outcomes and learning remain attributable |
| Windows installation acceptance | Missing | actual Hermes release, personal Windows device, checksum and cron evidence |
| First complete payout lifecycle | Missing | reconciled account progression and payout evidence; no inferred claim |

## Current implementation sequence

1. Authority and truthful runtime state.
2. Durable SQLite execution identity and restart recovery.
3. Provider bracket ownership and exact amendments.
4. Canonical outcomes and Hermes learning input.
5. Multi-timeframe and order-flow observation engine.
6. Automatic Topstep policy and session truth.
7. Replay, paper evaluation, and one-account acceptance.
8. Additional Topstep instruments and account products.

## Promotion rule

Tests prove software contracts; they do not prove profitability or live readiness. `armed` promotion requires named runtime evidence for all P0 execution rows, followed by a frozen, attributable, after-fee shadow or simulated sample. Profitability remains an empirical property of the operator and evidence, not a claim inferred from architecture.
