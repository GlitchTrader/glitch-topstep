# Topstep-native design

**Last reviewed:** July 28, 2026

Glitch Topstep is **not** a port of Glitch NinjaTrader. It is a venue-native operator stack for Topstep accounts on the official ProjectX trader API. The only design constraint is: **meet Topstep requirements using what Topstep and ProjectX actually provide.**

`docs/PARITY.md` tracks promotion and evidence acceptance. It borrows useful *behavioural contracts* from other Glitch editions where they still make sense. It is **not** a requirement to replicate NT indicators, NT order models, or NT strategy scaffolding.

## Principles

### 1. ProjectX is venue truth

REST and SignalR payloads define accounts, contracts, orders, positions, fills, quotes, prints, depth, and bars. Glitch persists evidence before mutating state, reconciles after disconnect, and surfaces parse faults as degraded health — never silent drops.

### 2. One configured scope first

Start with a single liquid micro contract (default acceptance: **MNQ**). Additional instruments are added by configuration (`GLITCH_INSTRUMENT`, `GLITCH_CONTRACT_ID`), not by hard-coding a multi-symbol NT portfolio.

### 3. Indicators from available data, not NT parity

Market cognition receives **descriptive** features built from ProjectX surfaces:

| Source | Features |
|--------|----------|
| `History/retrieveBars` | Multi-timeframe OHLCV, ATR, EMA/VWAP distances, range position, volume z-score |
| `GatewayTrade` tape | Rolling buy/sell delta, VWAP, trade rate (15s / 60s / 300s) |
| `GatewayDepth` | Bounded DOM snapshot (`book_complete=false` by design until full-book contract is proven) |
| `GatewayQuote` | Session OHLC, spread, quote age |

Do **not** port NT-only constructs (regime classifiers, setup candidates, ES correlation gates, RTH micro-bar entry windows) into the gateway. Those belong in Hermes judgment if ever needed.

### 4. Hermes decides; Glitch verifies

The gateway does not embed a second strategy. It exposes evidence, hard Topstep survival boundaries, and factual execution safety. `new_exposure_technically_supported` reflects venue completeness — not model conviction.

### 5. Armed is earned at runtime

`GLITCH_TRADING_MODE=armed` in `.env` is operator intent, not permission. Live order transport requires `gateway_mode: armed` (effective), which needs:

- `state_complete === true`
- quote age within `GLITCH_MAX_QUOTE_AGE_MS`
- reconciliation generation current
- order flow with trades in the 60s window

Otherwise the effective mode is `degraded_armed` and orders are not placed.

### 6. Protection follows ProjectX ownership

Brackets are placed via ProjectX tick-distance fields on `placeOrder`. Child-order ownership uses explicit `trade.orderId` and `customTag` evidence — not NT-style proximity heuristics. `MOVE_STOP` / `MOVE_TP` stay disabled until durable ownership is proven.

### 7. Policy facts are explicit

Topstep program fields the API does not expose (stage, payout, scaling, EOD qualifying balance) use `operator_configured` or `provider_reconciled` authority — see `docs/TOPSTEP-POLICY.md`. Unknown facts stay unknown.

## What we deliberately do not import

- NinjaTrader chart objects, ATM templates, or bar-type semantics
- Apex / generic prop-firm policy
- Master/follower replication
- Embedded entry windows, cooldown gates, or deterministic setup scoring in the gateway
- Permanent MNQ-only strategy abstractions (MNQ is acceptance scope, not architecture)

## Acceptance vs implementation

| Layer | Question |
|-------|----------|
| **Implemented** | Code exists and unit tests pass |
| **Accepted** | Proven against sanitized live ProjectX payloads and recorded in `docs/PARITY.md` / ledger |

Prefer small, native increments: fix parsers against real payloads, enrich the decision packet from ProjectX fields, prove bracket ownership — before adding new indicator families.

## Related docs

- [`AUTHORITY.md`](AUTHORITY.md) — role split (Alan / Hermes / Glitch / ProjectX / Topstep)
- [`TOPSTEP-POLICY.md`](TOPSTEP-POLICY.md) — loss-floor models and policy evidence
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime layout
- [`PARITY.md`](PARITY.md) — promotion and evidence ledger (not an NT port checklist)
