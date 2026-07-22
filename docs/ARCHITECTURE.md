# Architecture

## Objective

Glitch Topstep is the venue-neutral direct execution version of Glitch. ProjectX/TopstepX is the first adapter, not the domain model.

The system should eventually support:

```text
Glitch.Core
  ├─ ProjectX / TopstepX
  ├─ Tradovate
  └─ NinjaTrader Glitch bridge
```

This scaffold is a single TypeScript package, but its modules already follow those boundaries so they can be split into packages after the contract stabilizes.

The persistent cognition package is a separate repository and Hermes profile:

```text
GlitchTrader/glitch-topstep-hermes-profile
profile identity: glitch-topstep
```

## Authority order

1. Current provider account, position, order, fill, and quote state
2. Deterministic Glitch policy and risk calculations
3. Immutable decision packets, intents, receipts, and event ledger
4. Operator-confirmed facts
5. Hermes memory and learning artifacts
6. Inference

No lower layer may override a higher one.

## Runtime topology

```text
ProjectX REST
  auth, account discovery, contracts, bars, reconciliation, mutations

ProjectX User SignalR Hub
  accounts, positions, orders, trades

ProjectX Market SignalR Hub
  quotes, prints, depth
            │
            ▼
VenueStateStore
  canonical in-memory account and market state
  conservative bid/ask PnL marking
            │
            ├───────────────┐
            ▼               ▼
DecisionPacketService    Risk engine
  bounded packet          MLL floor
  stable snapshot hash    buffer
  strict template         stop-aware loss
            │               capacity
            ▼               │
Hermes profile            │
  glitch-topstep          │
  judgment only           │
            │               │
            └────intent─────┘
                    │
                    ▼
ExecutionCoordinator
  schema
  operator-profile identity
  account/contract identity
  freshness
  session gate
  simulated-account gate
  stop/target geometry
  quantity and monetary risk
  idempotency
                    │
                    ▼
ProjectX Order/place
  market entry
  provider-side stop bracket
  provider-side target bracket
```

## Safety plane and cognition plane

The system must keep these separate.

### Safety plane

Event-driven and deterministic:

- token/session health
- stream health and gap detection
- account and quote freshness
- MLL and daily-risk budget
- order state machine
- native protection verification
- session-close flattening
- restart reconciliation
- kill switches

### Cognition plane

Scheduled or event-triggered by the companion profile:

- five-minute flat-book decisions
- one-minute positioned decisions
- trade debriefs
- hourly supervision
- planning
- daily learning
- evidence-gated cognitive changes

The safety plane must continue to function when Hermes is unavailable.

## Intent contract

The scaffold reuses `glitch.intent.v2` rather than inventing a provider-specific model contract.

The model supplies:

- account name, not numeric provider account ID
- instrument root, not provider contract ID
- canonical `operator_profile: glitch-topstep`
- action
- confidence
- absolute structural stop and target prices
- compact evidence audit

Trusted configuration resolves the numeric account and exact active contract. The parser rejects any other operator-profile identity. This prevents a different profile or stale renamed client from reaching execution.

The first scaffold executes only:

- `ENTER_LONG`
- `ENTER_SHORT`
- `EXIT`
- `HOLD`
- `NOTHING`

`MOVE_STOP` and `MOVE_TP` are parsed as known actions but rejected until protective-order ownership can be reconstructed and verified.

## Absolute geometry over provider transport

Hermes reasons in absolute prices. ProjectX initial brackets use tick distances.

For a long entry:

```text
stopTicks   = ceil((referenceAsk - absoluteStop) / tickSize)
targetTicks = floor((absoluteTarget - referenceAsk) / tickSize)
```

For a short entry, the direction reverses and the reference is the executable bid.

The next execution milestone must reconcile actual fill and provider-created protective orders, then modify them to the exact intended absolute levels when required and still valid.

## State persistence

The current event ledger is append-only JSONL. It is enough for scaffold receipts, not production recovery.

The next storage layer should be SQLite with:

- WAL mode
- monotonic event sequence
- intent uniqueness constraint
- packet, intent, order, trade, and reconciliation tables
- durable order-group state machine
- EOD balance and MLL history
- payout lifecycle state
- migration discipline

The companion profile maintains its own cognition-side attempts, outbox, receipts, frame history, episodes, guidance, and plans. Provider truth remains exclusively in this gateway.

## Transport facts used by this scaffold

Official connection endpoints checked July 21, 2026:

```text
REST:       https://api.topstepx.com
User hub:   https://rtc.topstepx.com/hubs/user
Market hub: https://rtc.topstepx.com/hubs/market
```

Official subscriptions:

```text
SubscribeAccounts
SubscribeOrders(accountId)
SubscribePositions(accountId)
SubscribeTrades(accountId)
SubscribeContractQuotes(contractId)
SubscribeContractTrades(contractId)
SubscribeContractMarketDepth(contractId)
```

Sources:

- https://gateway.docs.projectx.com/docs/getting-started/connection-urls/
- https://gateway.docs.projectx.com/docs/realtime/
