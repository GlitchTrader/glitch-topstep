# Roadmap

Progress is evidence-gated, not calendar-gated. Tests prove software contracts; real ProjectX sessions prove integration; attributable after-fee samples evaluate the operator. None alone proves profitability or live readiness.

## R0 — Topstep-first authority and truthful scaffold

- [x] strict TypeScript project
- [x] official ProjectX REST adapter
- [x] official ProjectX SignalR adapter
- [x] canonical account, position, order, quote, print, and depth state
- [x] explicit Alan / Hermes / Glitch authority contract
- [x] no hidden simulated-only, entry-window, daily-budget, or risk-fraction strategy gates
- [x] hard Topstep loss-floor models
- [x] stop-aware protected-loss calculation
- [x] per-contract fee and slippage reserves
- [x] strict operator-profile and prompt-version intent identity
- [x] loopback health, state, packet, evidence, ownership, and intent API
- [x] explicit stream, payload, reconnect-generation, and reconciliation truth
- [x] shared freshness truth across health, packet, and execution
- [x] account-wide conservative PnL with missing evidence made explicit
- [x] shadow mode
- [x] dedicated `glitch-topstep` Hermes profile
- [x] deterministic tests for implemented contracts

## R1 — durable execution identity and recovery

- [x] SQLite WAL store and migration marker
- [x] foreign keys and synchronous `FULL` durable writes
- [x] durable unique intent identity
- [x] durable issued-packet leases and invalidation
- [x] outbox persisted before provider mutation
- [x] mutation lifecycle: `prepared`, `submitting`, `submitted`, `rejected`, `ambiguous`
- [x] authoritative provider rejection versus ambiguous transport distinction
- [x] serialized intent handling
- [x] durable entry-submission settlement latch
- [x] entry recovery by unique historical custom tag plus full order identity
- [x] close recovery only from authoritative flat position state
- [x] orphan intent recovery
- [x] prepared outbox recovery
- [x] terminal state without receipt recovery
- [x] no-op receipt recovery
- [x] recovery health and new-exposure block during ambiguity or settlement
- [ ] actual process-kill fixture before outbox creation
- [ ] actual process-kill fixture before provider call
- [ ] actual process-kill fixture during ambiguous transport
- [ ] actual process-kill fixture after provider response but before receipt
- [ ] Windows machine-restart persistence fixture
- [ ] bounded recovery flatten for owned but unresolved exposure
- [ ] zero duplicate entries in a real ProjectX acceptance session

## R2 — real ProjectX read-only proof

- [ ] authenticate using a real TopstepX ProjectX key
- [ ] capture sanitized official payload fixtures
- [ ] reconcile selected account and active contract
- [ ] prove every user-hub subscription
- [ ] prove quote, print, and DOM subscriptions
- [ ] prove disconnect, reconnect, generation invalidation, and REST reconciliation
- [ ] compare all account positions and conservative PnL with TopstepX UI
- [ ] compare local hard loss-floor evidence with authoritative dashboard/account state
- [ ] prove historical order search, timestamp boundaries, and custom-tag retention
- [ ] prove historical trade search, timestamp boundaries, and `trade.orderId` retention
- [ ] prove History/retrieveBars ordering, timeframe, limit, and partial-bar semantics
- [ ] determine any undocumented order/trade or bar result cap or pagination requirement
- [ ] compare deterministic replay with the same TopstepX account state
- [ ] measure quote, print, and DOM event rates on the target machine
- [ ] validate evidence retention against actual disk growth

## R3 — provider evidence, history, and replay foundation

- [x] one integrated monotonic provider-event journal
- [x] dedicated `projectx-evidence.sqlite` WAL store
- [x] persist normalized REST account, contract, position, and open-order snapshots before state replacement
- [x] persist sanitized raw and normalized user-stream events before state mutation
- [x] persist sanitized raw and normalized market-stream events before state mutation
- [x] persist lifecycle and reconnect evidence
- [x] payload SHA-256 hashes and monotonic sequences
- [x] recursively redact secret-like payload fields
- [x] bounded authenticated evidence inspection
- [x] separate execution `FULL` durability from telemetry `NORMAL` durability
- [x] bounded market-stream event retention
- [x] preserve REST, lifecycle, account, position, order, and user-trade evidence during market pruning
- [x] explicit related-provider identity field and index
- [x] backward-compatible relation migration and trade-order backfill
- [x] durable historical order/trade cursor
- [x] bounded timestamp windows with cursor advancement only after complete window retrieval
- [x] configurable correction overlap
- [x] persistent content/version heads across process restart
- [x] suppress unchanged historical overlap evidence
- [x] append changed provider versions
- [x] reject strictly older provider versions without blocking same-timestamp corrections
- [x] coalesce concurrent sync runs and wait for active work during shutdown
- [x] expose history status through `/health` and the service-start ledger
- [x] deterministic query-only state rebuild from retained evidence
- [x] stable canonical state and evidence hashes
- [x] through-sequence replay and bounded batched SQLite scans
- [x] explicit sequence-gap, invalid-payload, unsupported-event, and truncation reporting
- [x] terminal order, flat position, correction, and voided-trade replay semantics
- [x] offline replay CLI; no large replay on the trading gateway event loop
- [ ] persist raw REST response envelopes where contract-drift forensics require them
- [ ] evidence archive/export workflow
- [ ] real disk-full and write-failure acceptance
- [ ] compare replay against live state across every observed ProjectX payload variant

## R4 — provider order and protection ownership

- [x] query-only ownership projection over execution and evidence databases
- [x] durable submitted entry identity from intent, custom tag, and provider order ID
- [x] exact user-stream order ownership by provider order ID
- [x] exact REST open-order ownership by provider order ID
- [x] exact historical-order ownership by provider order ID
- [x] exact fill ownership only when `trade.orderId` matches the submitted entry
- [x] historical-fill continuity after offline intervals
- [x] voided-fill handling and latest trade correction by provider trade ID
- [x] detect account, contract, side, type, size, custom-tag, overfill, and duplicate-order contradictions
- [x] authenticated `/ownership` inspection
- [x] keep protection status `unknown` without explicit child/OCO relation
- [x] prohibit ownership inference from price, timing, side similarity, or working-order geometry
- [ ] identify provider-created stop and target orders from an explicit relationship
- [ ] prove aggregate open-position ownership without proximity inference
- [ ] persist order groups and protective-leg identity
- [ ] correct tick-distance brackets to exact intended absolute prices
- [ ] fail visibly and reduce risk when protection cannot be proven
- [ ] reconstruct protection after restart
- [ ] `MOVE_STOP`
- [ ] `MOVE_TP`
- [ ] exact-leg mutation with sibling non-interference
- [ ] independently protected additions and multiple tranches
- [ ] full exit ownership and residual-order cleanup

## R5 — canonical outcomes and learning evidence

- [ ] canonical completed Topstep outcome from provider fills
- [ ] after-fee realized result
- [ ] MFE, MAE, duration, and exit cause
- [ ] planned versus realized risk and reward
- [ ] account-policy effects and attribution confidence
- [ ] explicit incomplete or contradictory outcomes
- [ ] gateway outcome publication to the Hermes profile
- [ ] rejection and transport episodes available to review without becoming false trade outcomes

## R6 — Topstep policy and session authority

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

## R7 — instrument-general observation engine

- [ ] active Topstep contract discovery and rollover evidence
- [x] configured contract tick and point-value metadata
- [x] native 1m, 5m, 15m, and 60m ProjectX bar retrieval
- [x] OHLCV validation, chronological normalization, and duplicate timestamp replacement
- [x] rejected-bar counts, timestamp gaps, and live partial-bar provenance
- [x] ATR-14 and realized-volatility evidence
- [x] rolling VWAP-20 and distance evidence
- [x] EMA-20, EMA-50, EMA-200, distances, and slopes
- [x] range location, candle body/wicks, close location, and volume z-score
- [x] preserve the last successful observation during source failure
- [x] refresh on startup, reconnect, and every minute with coalescing and shutdown waiting
- [x] include exact observation state in packet identity
- [x] publish observation degradation without turning it into an execution gate
- [x] prohibit signal, score, action, or strategy eligibility fields in the feature contract
- [ ] session and prior-session structure
- [ ] trade-tape, aggressor volume, cumulative delta, depth, and liquidity aggregation
- [ ] acceptance on at least two Topstep-supported products

## R8 — replay and comparative evaluation

- [x] replay retained provider events into canonical state
- [x] replay exact orders, trades, quote, print, depth, and REST snapshot corrections
- [x] report incomplete retained corpora rather than claiming full truth
- [ ] reconstruct canonical packets from replayed state and policy evidence
- [ ] deterministic decision and receipt replay
- [ ] simulated fills, fees, and slippage
- [ ] compare cognition versions on identical evidence
- [ ] freeze inclusion, exclusion, regime, and missing-data rules before evaluation
- [ ] report expectancy, drawdown, MFE/MAE capture, churn, rejection, rule survival, and uncertainty
- [ ] prevent one sample from silently becoming hard-coded strategy policy

## R9 — one-account market-readiness evidence

- [ ] actual Windows/Hermes installation acceptance
- [ ] one configured Topstep account
- [ ] zero duplicate entries
- [ ] zero unexplained unprotected exposure
- [ ] complete reconnect and restart recovery
- [ ] complete attribution
- [ ] reconciled after-fee shadow sample
- [x] explicit operator promotion review (TS-BETA-01, 2026-08-05 shortcut acceptance)
- [ ] first complete account and payout lifecycle evidence

## R10 — scale only after evidence

- [ ] additional Topstep-supported instruments
- [ ] additional account products and stages
- [ ] portfolio-level correlated exposure evidence
- [ ] Topstep-native account/copy capabilities only when officially supported and reconciled
- [ ] extract reusable venue-neutral contracts only after the Topstep implementation is proven

## Permanent boundaries

- no Apex or NinjaTrader implementation assumptions in the Topstep core;
- no fixed strategy, indicator trigger, quantity schedule, risk percentage, profit quota, grid, or martingale rule in Glitch;
- no credentials or numeric provider identifiers in Hermes;
- no hidden cognition gate based on packet quality, capacity, policy, bars, features, or minimum history;
- no order, fill, position, stop, target, or OCO ownership inferred only from price, timing, side similarity, or geometry;
- no profitability, payout, unattended-operation, funded-stage, or live-readiness claim inferred from tests or architecture.
