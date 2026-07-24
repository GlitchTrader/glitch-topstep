# Architecture

## Objective

Glitch Topstep is a Topstep-first AI trading system built directly on ProjectX. It is not a port of NinjaTrader, Apex rules, replication, or a generic prop-firm compliance engine.

The first product boundary is:

```text
ProjectX / TopstepX
        │
        ▼
Glitch Topstep gateway
  provider truth · calculations · execution · recovery · evidence
        │ sanitized packet / strict intent
        ▼
Hermes profile: glitch-topstep
  observation · judgment · decision · review · learning
```

Venue-neutral contracts may be extracted later from proven Topstep behaviour. Premature abstraction must not weaken the tailored Topstep implementation.

## Authority

```text
Alan   = human operator; judgment authority
Hermes = AI operator; cognition and trading-decision authority
Glitch = builder-owned factual execution system
ProjectX = venue account, order, position, fill, and market transport truth
Topstep = final account-program and rule authority
```

Hermes may make a bad trade. Alan may make a bad trade. Glitch may not cause either operator to act on false identity, false state, incorrect calculations, duplicate execution, wrong-order mutation, or missing protection.

See [`AUTHORITY.md`](AUTHORITY.md).

## Runtime topology

```text
ProjectX REST
  authentication · discovery · bars · reconciliation · mutations

ProjectX User SignalR Hub
  account · position · order · trade events

ProjectX Market SignalR Hub
  quote · print · depth events
            │
            ▼
VenueStateStore
  parsed provider evidence
  connection generation
  stream health and payload faults
  reconciliation state
  conservative bid/ask marking
            │
            ├──────────────────────┐
            ▼                      ▼
DecisionPacketService       Hard execution calculations
  current packet             tick and point value
  issued snapshot lease      stop-aware protected loss
  sanitized identity         hard contract ceiling
  explicit data quality      hard loss-floor headroom
            │                      │
            ▼                      │
Hermes Topstep operator             │
  chooses the trade                 │
            │ strict intent         │
            └──────────────┬────────┘
                           ▼
ExecutionCoordinator
  issued-packet identity
  account/instrument/profile identity
  current venue freshness and reconciliation
  schema and finite values
  structural geometry
  current hard account boundaries
  idempotency and ownership milestones
                           │
                           ▼
ProjectX order mutation
  entry · close · provider-side protection
```

## Cognition and factual execution

These planes are separate, but not because cognition is untrusted.

### Hermes cognition

Hermes owns:

- whether an edge exists;
- direction and timing;
- quantity and structural stop/target intent;
- interpretation of data quality, uncertainty, regime, structure, flow, and policy evidence;
- trade review and learning.

Glitch must not encode an indicator trigger, setup score, risk percentage, daily quota, preferred regime, or implicit no-trade policy.

### Glitch factual execution

Glitch owns:

- credentials and provider transport;
- exact provider identities;
- parsing and normalization;
- tick, point-value, fee, slippage, and bracket calculations;
- stream health, reconnect generation, and REST reconciliation;
- hard contract capacity and hard loss-floor survival;
- order identity, idempotency, ownership, protection, restart recovery, and receipts.

The factual plane must continue to protect existing exposure when Hermes is unavailable. It must also expose every rejection so cognition and learning can review what happened.

## Truthful packets

`DecisionPacketService` publishes current evidence on every request. Issued snapshot hashes remain valid only for a bounded lease, allowing model latency without serving a frozen packet as current truth.

Packets contain:

- sanitized account alias and contract description;
- current quote and account state;
- explicit `data_quality` issues and connection generations;
- policy authority and hard loss-floor headroom;
- current technical execution capabilities;
- a strict output template.

An incomplete packet may still reach Hermes. The gateway independently rejects order mutation when current execution truth is incomplete or stale.

## Intent contract

The current wire contract is `glitch.intent.v2`.

Hermes supplies:

- account alias, not numeric provider account ID;
- instrument identity, not provider contract ID;
- `operator_profile: glitch-topstep`;
- action and confidence;
- absolute structural stop and target prices for entries;
- compact adversarial evidence audit.

Trusted local configuration resolves numeric provider identities. The gateway currently supports:

- `ENTER_LONG`
- `ENTER_SHORT`
- `EXIT`
- `HOLD`
- `NOTHING`

`MOVE_STOP` and `MOVE_TP` remain known but non-executable until durable protective-order ownership is implemented.

## Absolute geometry over provider transport

Hermes reasons in absolute prices. ProjectX initial brackets use tick distances.

For a long entry:

```text
stopTicks   = ceil((currentAsk - absoluteStop) / tickSize)
targetTicks = floor((absoluteTarget - currentAsk) / tickSize)
```

For a short entry, the direction reverses and the executable reference is current bid.

The gateway recalculates geometry from current venue truth at execution time. The next milestone must prove the actual fill and provider-created stop/target identities, then correct them to exact intended absolute prices when required.

## Persistence and recovery

The current JSONL ledger is evidence for the scaffold, not production recovery. P0 requires SQLite with:

- WAL mode and migrations;
- monotonic event sequence;
- unique durable intent identity;
- atomic outbox persisted before provider mutation;
- packets, intents, provider orders, fills, order groups, and reconciliations;
- restart reconstruction;
- ambiguous transport recovery by provider tag;
- EOD balance, hard loss-floor, account-stage, and payout history.

The companion profile independently persists cognition attempts, outbox, decisions, receipts, frame history, episodes, guidance, and plans. Provider truth remains exclusively in this gateway.

## Current transport sources

ProjectX connection URLs, realtime subscription names, and payload contracts must come from current official documentation and observed sanitized runtime evidence. When official documentation and observed payloads disagree, Glitch records the discrepancy and fails visibly rather than making fields optional to suppress errors.
