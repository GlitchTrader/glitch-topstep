# Architecture

## Objective

Glitch Topstep is a Topstep-first AI trading system built directly on ProjectX. It is not a port of NinjaTrader, Apex rules, replication, or a generic prop-firm compliance engine.

```text
ProjectX / TopstepX
        │
        ▼
Glitch Topstep gateway
  provider truth · evidence · calculations · execution · recovery
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
Provider evidence boundary
  parse payload
  redact secret-like fields
  persist raw + normalized evidence
  assign sequence + payload hash
  preserve explicit provider relationships
            │ persistence succeeds
            ▼
VenueStateStore
  connection generation
  stream health and payload faults
  reconciliation state
  account-wide conservative bid/ask marking
            │
            ├────────────────────────┐
            ▼                        ▼
DecisionPacketService         Hard execution calculations
  current packet               tick and point value
  issued snapshot lease        stop-aware protected loss
  sanitized identity           hard contract ceiling
  explicit data quality        hard loss-floor headroom
            │                        │
            ▼                        │
Hermes Topstep operator               │
  chooses the trade                   │
            │ strict intent           │
            └──────────────┬──────────┘
                           ▼
ExecutionCoordinator
  serialized intent handling
  issued-packet identity
  account/instrument/profile/prompt identity
  current venue freshness and reconciliation
  structural geometry and hard boundaries
  durable outbox and entry-settlement latch
                           │
                           ▼
ProjectX order mutation
  entry · close · provider-side protection

Query-only ownership projection
  durable Glitch intent + submitted provider order ID
  exact ProjectX order evidence
  exact ProjectX trade.orderId relationships
  contradiction reporting
  protection remains unknown without child/OCO evidence
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
- parsing, normalization, and attributable evidence;
- tick, point-value, fee, slippage, and bracket calculations;
- stream health, reconnect generation, and REST reconciliation;
- hard contract capacity and hard loss-floor survival;
- order identity, idempotency, ownership, protection, restart recovery, and receipts.

The factual plane must continue to protect existing exposure when Hermes is unavailable. It must expose every rejection and ambiguity so cognition and learning can review what happened.

## Provider evidence boundary

ProjectX evidence is persisted in `projectx-evidence.sqlite` before accepted realtime payloads mutate `VenueStateStore`.

Each event contains:

- monotonic local sequence;
- local receipt time and provider timestamp when available;
- REST, user-stream, market-stream, or lifecycle source;
- connection generation;
- account, contract, and provider entity identity when available;
- an explicit related-provider identity when ProjectX supplies one;
- recursively sanitized raw payload;
- normalized payload used by Glitch;
- SHA-256 hash of the stored event content.

The first explicit relationship is user trade → order. For a normalized `TradeInfo`, `trade.orderId` is stored as `related_provider_entity_id`. The relation is indexed and included in the evidence hash. Older persisted trade events are migrated by reading their normalized `orderId`, backfilling the relation, and recomputing the hash.

If a realtime payload parses but cannot be persisted, Glitch does not silently advance state. The stream becomes degraded and REST reconciliation is requested.

REST account, contract, position, and open-order snapshots are persisted before they replace reconciled state. Raw REST envelopes are not yet retained; this remains an explicit evidence gap.

### Durability and retention

Execution identity and provider telemetry use separate SQLite databases because their failure and retention requirements differ.

`glitch-topstep.sqlite`:

- WAL;
- `synchronous=FULL`;
- durable intents, issued packets, outbox states, mutation latches, and receipts;
- no automatic retention in the execution path.

`projectx-evidence.sqlite`:

- WAL;
- `synchronous=NORMAL` to avoid blocking the Node event loop for every quote, print, or DOM update;
- REST, lifecycle, account, position, order, and user-trade evidence retained;
- only high-frequency `projectx_market_stream` events are bounded by configurable count retention;
- sequence values remain monotonic across pruning and restart.

The evidence API is authenticated and bounded:

```text
GET /evidence?limit=100
```

It exists for acceptance, debugging, replay, and ownership research. It is not injected into Hermes by default.

## Exact order and fill ownership

The ownership view is a read-only projection over the two durable databases. It does not mutate execution state and cannot authorize an order amendment.

```text
durable Glitch intent
  + submitted execution_outbox providerOrderId/customTag
  + exact ProjectX order evidence with that order ID
  + exact ProjectX trade evidence where trade.orderId matches
  = attributable entry order and fills
```

The projection validates:

- configured account and contract against the durable execution request;
- intent account, instrument, action, side, and quantity;
- observed order account, contract, custom tag, side, type, and size;
- fill account, contract, side, positive size, voided state, and cumulative quantity;
- uniqueness of each provider order ID across durable Glitch intents.

Contradictions produce `status=incomplete` and explicit issues. A provider order acknowledgement without later evidence produces `provider_acknowledged`; an exact order or fill event produces `provider_observed` only when identity remains consistent.

The authenticated view is:

```text
GET /ownership
```

It permanently reports:

```text
protection.status = unknown
protection.reason = provider_child_order_relation_not_observed
```

The following are prohibited as ownership evidence:

- price proximity;
- timing proximity;
- side similarity;
- quantity proximity;
- working-order geometry;
- aggregate position state alone.

A nearby stop or target is not attributed. `MOVE_STOP`, `MOVE_TP`, bracket correction, and protection reconstruction remain disabled until ProjectX supplies an explicit child-order, OCO, or equivalent relationship that can be reconciled durably.

## Truthful packets

`DecisionPacketService` publishes current evidence on every request. Issued snapshot hashes remain valid only for a bounded lease, allowing model latency without serving a frozen packet as current truth.

Packets contain:

- sanitized account alias and contract description;
- current quote and account state;
- explicit freshness, data-quality issues, and connection generations;
- policy authority and hard loss-floor headroom;
- current technical execution capabilities;
- entry-submission and recovery state;
- a strict output template.

An incomplete packet may still reach Hermes. The gateway independently rejects order mutation when current execution truth is incomplete or stale.

## Intent contract

The current wire contract is `glitch.intent.v2`.

Hermes supplies:

- account alias, not numeric provider account ID;
- instrument identity, not provider contract ID;
- `operator_profile: glitch-topstep`;
- `prompt_version: glitch-topstep-v2`;
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

The gateway recalculates geometry from current venue truth at execution time. The next milestone must identify provider-created stop/target identities through an explicit relation, then correct them to exact intended absolute prices when required.

## Durable execution and recovery

Execution persistence already includes:

- unique intent identity;
- durable issued-packet leases;
- atomic outbox before provider mutation;
- `prepared`, `submitting`, `submitted`, `rejected`, and `ambiguous` mutation states;
- serialized intent handling;
- durable entry-submission settlement latch;
- orphan-intent, interrupted-outbox, ambiguous-call, and missing-receipt reconstruction;
- historical custom-tag recovery for entries;
- authoritative flat-state recovery for closes.

The settlement latch prevents a second entry while a submitted entry has not yet appeared in reconciled ProjectX order or position state. This is execution correctness, not a trading strategy.

Still missing:

- historical order/trade ingestion after offline intervals;
- aggregate position ownership;
- provider order groups;
- provider-created stop/target ownership;
- exact protective-leg reconstruction and amendments;
- canonical completed outcomes;
- EOD balance, account-stage, payout, and session authority.

The companion profile independently persists cognition attempts, outbox, decisions, receipts, frame history, episodes, guidance, and plans. Provider truth remains exclusively in this gateway.

## Current transport sources

ProjectX connection URLs, realtime subscription names, and payload contracts must come from current official documentation and observed sanitized runtime evidence. When official documentation and observed payloads disagree, Glitch records the discrepancy and fails visibly rather than making fields optional to suppress errors.
