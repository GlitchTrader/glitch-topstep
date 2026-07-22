# Glitch TopTrader

A direct prop-firm trading gateway for Glitch, starting with the official **ProjectX / TopstepX API**.

This repository removes NinjaTrader from the first direct-provider path without removing the deterministic boundary that makes Glitch defensible:

```text
ProjectX market/account streams
             │
             ▼
Glitch TopTrader state + policy + risk
             │ bounded decision packet
             ▼
Hermes persistent operator
             │ strict glitch.intent.v2
             ▼
Glitch TopTrader validation + execution
             │
             ▼
ProjectX orders and provider-side brackets
```

## Status

**Scaffold, shadow-only by default. Not live-ready.**

Implemented:

- ProjectX API-key authentication and 24-hour session renewal surface
- Official REST endpoints for accounts, contracts, bars, orders, positions, and trades
- Official SignalR subscriptions for account, order, position, trade, quote, print, and DOM updates
- Canonical venue state with conservative bid/ask marking
- Topstep Combine/XFA maximum-loss-floor model
- Stop-aware monetary risk calculation
- Firm/account/contract/snapshot identity binding
- Strict `glitch.intent.v2` parser
- Absolute Glitch stop/target geometry translated to ProjectX bracket ticks
- Authenticated loopback API for state, decision packets, and intents
- `disabled`, `shadow`, and explicitly acknowledged `armed` modes
- Append-only local execution receipts
- 21 deterministic tests

Not yet implemented or accepted:

- verified connection against a real TopstepX API subscription
- authoritative automatic MLL and payout-state reconciliation
- exchange holiday and special-close calendar
- durable intent idempotency across process restarts
- fill-to-bracket ownership reconciliation
- restart reconstruction of open AI-owned orders
- `MOVE_STOP` and `MOVE_TP`
- native copier lifecycle and payout unlink recovery
- Hermes profile package and scheduled operator/learning workers
- profitability, payout, XFA, PA, or Live Funded Account evidence

## Safety posture

The model never receives ProjectX credentials and never chooses the account ID or contract ID. Those values are configured locally and checked again before execution.

The gateway defaults to:

```text
GLITCH_TRADING_MODE=shadow
GLITCH_REQUIRE_SIMULATED=true
GLITCH_ENTRY_WINDOW_OPEN=false
```

Even `armed` mode will not start unless the operator sets the exact scaffold acknowledgement documented in `.env.example`. That acknowledgement is not a readiness claim; it only prevents accidental arming during development.

## Requirements

- Node.js 22+
- A TopstepX-linked ProjectX API subscription and API key for live integration work
- A personal local device; Topstep currently prohibits VPS, VPN, and remote-server API trading
- A separately installed Hermes runtime for the later operator profile

## Local setup

```bash
cp .env.example .env
npm install
npm run check
npm run build
npm start
```

The local gateway binds to `127.0.0.1:8790` by default.

```text
GET  /health   no authentication; operational status only
GET  /state    bearer token required
GET  /packet   bearer token required
POST /intent   bearer token required; strict glitch.intent.v2
```

Example:

```bash
curl -H "Authorization: Bearer $GLITCH_LOCAL_TOKEN" \
  http://127.0.0.1:8790/packet
```

## Design rule

```text
Hermes proposes.
Glitch validates, sizes, executes, reconciles, journals, and protects.
ProjectX owns venue order and position truth.
Topstep owns final account-rule enforcement.
```

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TOPSTEP-POLICY.md`](docs/TOPSTEP-POLICY.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- [`docs/HANDOFF.md`](docs/HANDOFF.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
