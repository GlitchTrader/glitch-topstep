# Glitch Topstep

A Topstep-first AI trading gateway built directly on the official ProjectX / TopstepX API.

```text
ProjectX market and account truth
             │
             ▼
Glitch Topstep
  normalize · calculate · verify · execute · reconcile · protect · journal
             │ sanitized evidence packet
             ▼
Hermes Topstep operator
  observe · reason · decide · review · learn
             │ strict glitch.intent.v2
             ▼
Glitch Topstep → ProjectX orders and provider-side protection
```

The dedicated cognition package is maintained in [`GlitchTrader/glitch-topstep-hermes-profile`](https://github.com/GlitchTrader/glitch-topstep-hermes-profile).

## Authority

```text
Hermes decides.
Glitch verifies factual execution safety, translates, reconciles, journals, and protects.
ProjectX owns venue truth.
Topstep owns final account-rule authority.
```

Glitch is not a second deterministic trading strategy. Market observations, data quality, account stage, loss-floor headroom, and capacity are evidence for Hermes. Glitch rejects order mutation only when identity, venue truth, geometry, ownership, transport, protection, or an authoritative hard account boundary cannot be proven.

See [`docs/AUTHORITY.md`](docs/AUTHORITY.md).

## Status

**Experimental, shadow by default, not yet live-ready.**

Implemented:

- ProjectX API-key authentication and session validation;
- official REST surfaces for accounts, contracts, bars, orders, positions, and trades;
- official SignalR subscriptions for account, order, position, trade, quote, print, and DOM updates;
- explicit user-stream, market-stream, connection-generation, and reconciliation health;
- malformed realtime payloads surfaced as degraded truth rather than silently ignored;
- conservative bid/ask account marking;
- configured Topstep hard loss-floor models and protected monetary-risk calculation;
- account, contract, instrument, operator-profile, packet, and snapshot identity binding;
- current decision packets with leased issued identities rather than frozen stale packets;
- strict `glitch.intent.v2` parser;
- absolute structural stop/target geometry translated to ProjectX bracket ticks;
- authenticated loopback API for health, state, packets, and intents;
- explicit `disabled`, `shadow`, and acknowledged `armed` operator modes;
- append-only local execution receipts;
- dedicated Hermes operator and learning profile.

Still required before live promotion:

- verified connection and sanitized payload evidence from a real TopstepX API subscription;
- durable SQLite intent identity and outbox-before-submit;
- transport-ambiguous submission recovery;
- fill-to-bracket ownership reconciliation;
- restart reconstruction of AI-owned orders and positions;
- exact structural bracket correction after fill;
- verified `MOVE_STOP` and `MOVE_TP`;
- canonical completed outcomes for Hermes learning;
- authoritative account-stage, loss-floor, payout, scaling, session, holiday, and special-close reconciliation;
- instrument-general observation features and acceptance beyond the initial configured contract;
- frozen after-fee shadow evidence, first complete account lifecycle, and payout evidence.

The current parity and promotion ledger is [`docs/PARITY.md`](docs/PARITY.md).

## Factual safety posture

The model never receives ProjectX credentials and never chooses numeric provider account or contract IDs. Those values are configured locally and rechecked before execution.

The gateway defaults to:

```text
GLITCH_TRADING_MODE=shadow
```

`shadow` verifies and journals decisions without calling ProjectX order mutations. `armed` requires an explicit operator acknowledgement, but that acknowledgement is not a readiness claim.

## Requirements

- Node.js 22+
- A TopstepX-linked ProjectX API subscription and API key for real integration work
- A personal local device compatible with current Topstep API requirements
- A separately installed Hermes runtime and the `glitch-topstep` profile for autonomous cognition

## Local setup

```bash
cp .env.example .env
npm install
npm run check
npm start
```

The local gateway binds to `127.0.0.1:8790` by default.

```text
GET  /health   no authentication; truthful operational status only
GET  /state    bearer token required
GET  /packet   bearer token required
POST /intent   bearer token required; strict glitch.intent.v2
```

```bash
curl -H "Authorization: Bearer $GLITCH_LOCAL_TOKEN" \
  http://127.0.0.1:8790/packet
```

## Hermes profile

Install the companion profile after the gateway is running in shadow mode:

```powershell
hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --alias
hermes -p glitch-topstep auth add openai-codex --type oauth
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\setup.ps1"
```

Use the same local bearer token in the gateway and profile `.env`. The profile never receives ProjectX credentials.

## Documentation

- [`docs/AUTHORITY.md`](docs/AUTHORITY.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TOPSTEP-POLICY.md`](docs/TOPSTEP-POLICY.md)
- [`docs/PARITY.md`](docs/PARITY.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- [`docs/HANDOFF.md`](docs/HANDOFF.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
