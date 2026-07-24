# Roadmap

Progress is evidence-gated, not calendar-gated. Tests prove software contracts; real ProjectX sessions prove integration; attributable after-fee samples evaluate the operator. None alone proves profitability or live readiness.

## R0 — Topstep-first authority and truthful scaffold

- [x] strict TypeScript project
- [x] official ProjectX REST adapter
- [x] official ProjectX SignalR adapter
- [x] canonical state store
- [x] hard Topstep loss-floor models
- [x] stop-aware protected-loss calculation
- [x] strict Glitch intent parser
- [x] loopback health, state, packet, and intent API
- [x] shadow mode
- [x] dedicated `glitch-topstep` Hermes profile
- [x] explicit operator/builder authority contract
- [x] remove simulated-only, entry-window, daily-budget, and risk-fraction cognition gates
- [x] explicit stream, payload, reconnect-generation, and reconciliation truth
- [x] current packets with bounded issued-decision leases
- [x] nonblocking Hermes cognition launcher
- [x] deterministic unit tests for the implemented contracts

## R1 — real ProjectX read-only proof

- [ ] authenticate using a real TopstepX ProjectX key
- [ ] capture sanitized official payload examples
- [ ] reconcile selected account and active contract
- [ ] prove every user-hub subscription
- [ ] prove quote, print, and DOM subscriptions
- [ ] prove disconnect, reconnect, generation invalidation, and REST reconciliation
- [ ] persist raw provider events for replay
- [ ] compare local balance, positions, orders, fills, and PnL with TopstepX UI
- [ ] compare local hard loss-floor evidence with authoritative dashboard/account state

## R2 — durable execution identity

- [ ] SQLite WAL store and migrations
- [ ] monotonic event sequence
- [ ] durable unique intent identity
- [ ] atomic outbox persisted before provider mutation
- [ ] provider mutation attempt and acknowledgement state
- [ ] ambiguous transport recovery by custom tag
- [ ] order-group state machine
- [ ] startup reconstruction
- [ ] bounded recovery close/flatten
- [ ] zero duplicate entries across process and machine restart fixtures

## R3 — provider order and protection ownership

- [ ] reconcile entry order and actual fills
- [ ] identify provider-created stop and target orders
- [ ] prove side, quantity, contract, and parent intent ownership
- [ ] correct tick-distance brackets to exact intended absolute prices
- [ ] fail visibly and reduce risk when protection cannot be proven
- [ ] reconstruct protection after restart
- [ ] `MOVE_STOP`
- [ ] `MOVE_TP`
- [ ] exact-leg mutation with sibling non-interference
- [ ] independently protected additions and multiple tranches
- [ ] full exit ownership and residual-order cleanup

## R4 — canonical outcomes and learning evidence

- [ ] canonical completed Topstep outcome from provider fills
- [ ] after-fee realized result
- [ ] MFE, MAE, duration, and exit cause
- [ ] planned versus realized risk and reward
- [ ] account-policy effects and attribution confidence
- [ ] explicit incomplete or contradictory outcomes
- [ ] gateway outcome publication to the Hermes profile
- [ ] rejection and transport episodes available to review without becoming false trade outcomes

## R5 — Topstep policy and session authority

- [ ] canonical product and account-stage record
- [ ] provider/dashboard source provenance and hashes
- [ ] EOD balance and hard loss-floor history
- [ ] floor correction workflow
- [ ] Trading Combine lifecycle
- [ ] Express Funded lifecycle
- [ ] payout eligibility, pending, processed, and post-payout reconciliation
- [ ] scaling tier and authoritative contract ceiling
- [ ] session flat deadlines
- [ ] holiday, early-close, timezone, and DST truth
- [ ] explicit contradiction and stale-source handling

## R6 — instrument-general observation engine

- [ ] active Topstep contract discovery and rollover evidence
- [ ] native tick, point value, session, and fee metadata
- [ ] 1m, 5m, 15m, and 60m OHLCV normalization
- [ ] gap and timestamp provenance
- [ ] session and prior-session structure
- [ ] volatility, trend, range, and location evidence
- [ ] trade-tape, aggressor volume, cumulative delta, depth, and liquidity evidence
- [ ] descriptive normalized features without a coded entry strategy
- [ ] acceptance on at least two Topstep-supported products

## R7 — replay and comparative evaluation

- [ ] replay raw provider events into canonical packets
- [ ] deterministic decision and receipt replay
- [ ] simulated fills, fees, and slippage
- [ ] compare cognition versions on identical evidence
- [ ] freeze inclusion, exclusion, regime, and missing-data rules before evaluation
- [ ] report expectancy, drawdown, MFE/MAE capture, churn, rejection, rule survival, and uncertainty
- [ ] prevent one sample from silently becoming hard-coded strategy policy

## R8 — one-account market-readiness evidence

- [ ] actual Windows/Hermes installation acceptance
- [ ] one configured Topstep account
- [ ] zero duplicate entries
- [ ] zero unexplained unprotected exposure
- [ ] complete reconnect and restart recovery
- [ ] complete attribution
- [ ] reconciled after-fee shadow sample
- [ ] explicit operator promotion review
- [ ] first complete account and payout lifecycle evidence

## R9 — scale only after evidence

- [ ] additional Topstep-supported instruments
- [ ] additional account products and stages
- [ ] portfolio-level correlated exposure evidence
- [ ] Topstep-native account/copy capabilities only when officially supported and reconciled
- [ ] extract reusable venue-neutral contracts only after the Topstep implementation is proven

## Permanent boundaries

- no Apex or NinjaTrader implementation assumptions in the Topstep core;
- no fixed strategy, indicator trigger, quantity schedule, risk percentage, profit quota, grid, or martingale rule in Glitch;
- no credentials or numeric provider identifiers in Hermes;
- no hidden cognition gate based on packet quality, capacity, policy, or minimum history;
- no profitability, payout, unattended-operation, funded-stage, or live-readiness claim inferred from tests or architecture.
