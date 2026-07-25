# Glitch Topstep

A Topstep-first AI trading gateway built directly on the official ProjectX / TopstepX API.

```text
ProjectX market and account truth
             │
             ▼
Glitch Topstep
  normalize · persist evidence · calculate · verify · execute · reconcile · recover
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

Glitch is not a second deterministic trading strategy. Market observations, data quality, account stage, hard loss-floor headroom, and capacity are evidence for Hermes. Glitch rejects order mutation only when identity, venue truth, geometry, ownership, transport, protection, or an authoritative hard account boundary cannot be proven.

See [`docs/AUTHORITY.md`](docs/AUTHORITY.md).

## Status

**Experimental, shadow by default, not yet live-ready.**

Implemented:

- ProjectX API-key authentication and session validation;
- official REST surfaces for accounts, contracts, bars, orders, positions, and trades;
- official SignalR subscriptions for account, order, position, trade, quote, print, and DOM updates;
- explicit user-stream, market-stream, connection-generation, and REST-reconciliation truth;
- malformed realtime payloads surfaced as degraded state rather than silently ignored;
- account-wide conservative bid/ask marking, with missing contract or quote evidence made explicit;
- configured Topstep hard loss-floor models and stop-aware protected-loss calculations;
- fees and slippage reserves applied per contract;
- account, contract, instrument, operator-profile, prompt-version, packet, and snapshot identity binding;
- one factual freshness contract shared by `/health`, decision packets, and execution validation;
- current decision packets with durable, bounded issued identities rather than frozen stale packets;
- strict `glitch.intent.v2` parsing;
- absolute structural stop/target geometry translated to ProjectX bracket ticks;
- authenticated loopback API for health, state, packets, evidence, ownership, and intents;
- explicit `disabled`, `shadow`, and acknowledged `armed` operator modes;
- SQLite WAL execution state with foreign keys and `synchronous=FULL` durable writes;
- persistent unique intent identity and terminal receipt replay;
- outbox-before-submit for ProjectX entry and close mutations;
- explicit `prepared`, `submitting`, `submitted`, `rejected`, and `ambiguous` mutation states;
- startup and recurring reconciliation of orphan intents, interrupted outbox states, ambiguous submissions, and terminal states missing receipts;
- entry recovery only from one historical ProjectX order matching custom tag, account, contract, side, type, and quantity;
- close recovery only when current ProjectX position state proves the configured contract is flat;
- serialized mutation handling and a durable entry-submission settlement latch;
- new exposure blocked while an earlier provider mutation is ambiguous or unsettled;
- a separate `projectx-evidence.sqlite` journal with monotonic sequence numbers and payload hashes;
- realtime evidence persisted before accepted payloads mutate venue state;
- normalized REST account, contract, position, and order snapshots persisted before reconciliation replaces state;
- recursively redacted secret-like fields in persisted evidence;
- bounded high-frequency market-stream retention while REST, lifecycle, account, position, order, and user-trade evidence remains intact;
- explicit ProjectX relationship indexing, including `trade.orderId` as the exact fill-to-order relationship;
- submitted entry-order ownership derived from durable Glitch intent identity and exact ProjectX provider order ID;
- fill ownership derived only from ProjectX trades whose `orderId` exactly matches that submitted entry order;
- contradiction detection for account, contract, side, type, quantity, custom tag, overfill, and duplicate provider order identity;
- protection ownership explicitly reported as `unknown` until ProjectX supplies a verifiable child-order or OCO relationship;
- durable order/trade history synchronization on startup, reconnect, and a configurable cadence;
- bounded timestamp windows with a durable cursor advanced only after complete order and trade retrieval;
- configurable correction overlap with unchanged historical evidence suppressed across restart;
- changed provider records retained as new versions while strictly older versions cannot replace a newer durable head;
- historical order and fill evidence consumed by `/ownership` through the same exact provider-ID rules;
- history synchronization status exposed through `/health` and the service-start ledger;
- append-only JSONL execution evidence mirrored after SQLite commits;
- dedicated Hermes operator and learning profile.

Still required before live promotion:

- verified authentication and sanitized payload acceptance from a real TopstepX API subscription;
- actual process-kill and Windows restart fixtures for every durable execution window;
- raw REST response envelopes where needed for contract-drift forensics;
- verified ProjectX timestamp-boundary semantics and any undocumented history result limits or pagination behavior;
- real partial-fill, correction, void, and late-update acceptance;
- provider-created stop and target child identity or another explicit protection relationship;
- aggregate open-position ownership without inferring it from account-level position proximity;
- full reconstruction of AI-owned entries, fills, stops, targets, and open positions;
- exact structural bracket correction after fill;
- verified `MOVE_STOP` and `MOVE_TP`;
- independently protected additions and multiple tranches;
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

Before an armed mutation, Glitch durably commits intent and outbox identity. It never blindly retries an ambiguous ProjectX request. If provider evidence cannot prove what happened, health becomes degraded and new exposure remains blocked.

Accepted realtime events follow:

```text
parse → redact and persist raw/normalized evidence → mutate VenueStateStore
```

If evidence persistence fails, state does not silently advance.

Ownership follows only explicit identities:

```text
Glitch intent
  → durable submitted ProjectX providerOrderId and customTag
  → exact ProjectX order evidence with that order ID
  → exact ProjectX trade evidence where trade.orderId equals that order ID
```

Price proximity, timing proximity, side similarity, working-order geometry, and aggregate position state are not ownership evidence. A nearby stop or target remains unrelated until ProjectX exposes an explicit child-order or OCO relationship.

Historical continuity follows:

```text
durable cursor - correction overlap
  → bounded ProjectX order/trade window
  → persist changed provider records
  → advance cursor only after both retrievals succeed
```

A history failure degrades evidence health but does not become a hidden trading strategy gate. The next scheduled or reconnect run resumes from the last completed cursor.

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
GET  /health              no authentication; truthful operational, recovery, evidence, and history status
GET  /state               bearer token required
GET  /packet              bearer token required
GET  /evidence?limit=100  bearer token required; maximum 1000 events
GET  /ownership           bearer token required; exact entry/fill identity, protection remains unknown
POST /intent              bearer token required; strict glitch.intent.v2
```

```bash
curl -H "Authorization: Bearer $GLITCH_LOCAL_TOKEN" \
  "http://127.0.0.1:8790/ownership"
```

Execution and telemetry use separate stores:

```text
data/glitch-topstep.sqlite     execution identity and recovery; WAL/FULL
data/projectx-evidence.sqlite  provider evidence/history; WAL/NORMAL; bounded market-event retention
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
