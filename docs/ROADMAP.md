# Roadmap

Progress is evidence-gated, not calendar-gated.

## R0 — scaffold

- [x] strict TypeScript project
- [x] official ProjectX REST adapter
- [x] official ProjectX SignalR adapter
- [x] canonical state store
- [x] MLL model
- [x] stop-aware risk budget
- [x] strict Glitch intent parser
- [x] loopback packet and intent API
- [x] shadow mode
- [x] deterministic tests

## R1 — live read-only adapter proof

- [ ] authenticate using a real TopstepX ProjectX key
- [ ] reconcile account and contract selection
- [ ] prove all user-hub subscriptions
- [ ] prove quote, trade, and DOM subscriptions
- [ ] reconnect and REST reconciliation
- [ ] persist provider events
- [ ] compare local balance, positions, orders, and PnL with UI
- [ ] compare local MLL mirror with dashboard

## R2 — durable execution state

- [ ] SQLite event store and migrations
- [ ] atomic intent outbox
- [ ] durable idempotency
- [ ] order-group state machine
- [ ] fill and child-bracket reconciliation
- [ ] exact structural-price correction
- [ ] startup reconstruction
- [ ] bounded recovery flatten
- [ ] `MOVE_STOP`
- [ ] `MOVE_TP`
- [ ] full exit ownership rules

## R3 — account lifecycle and policy

- [ ] authoritative session calendar
- [ ] holidays and special closes
- [ ] EOD balance capture
- [ ] MLL correction workflow
- [ ] Combine lifecycle
- [ ] XFA lifecycle
- [ ] payout eligibility and pending state
- [ ] post-payout reconciliation
- [ ] scaling-tier state
- [ ] policy package versioning and source hashes

## R4 — Hermes operator profile

- [ ] installable `glitch-toptrader` profile
- [ ] no terminal, browser, MCP, or venue credentials
- [ ] five-minute flat cadence
- [ ] one-minute positioned cadence
- [ ] bounded current packet and ledger
- [ ] isolated scheduled sessions
- [ ] strict JSON output
- [ ] separate learning worker
- [ ] evidence-gated cognitive overlays

## R5 — one-account acceptance

- [ ] one MNQ account
- [ ] one entry tranche
- [ ] one stop and target
- [ ] zero duplicate entries
- [ ] zero unprotected exposure
- [ ] complete restart recovery
- [ ] complete attribution
- [ ] reconciled after-fee sample
- [ ] first payout lifecycle

## R6 — replication

- [ ] Topstep native copier observation
- [ ] follower drift and unlink detection
- [ ] payout unlink recovery
- [ ] identical stage/tier requirements
- [ ] portfolio-level correlated risk
- [ ] scale to additional accounts only after evidence

## R7 — second venue

- [ ] extract canonical core package
- [ ] implement approved Tradovate adapter
- [ ] preserve the same intent, risk, event, and recovery contracts
