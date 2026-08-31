# Glitch Topstep gateway — rebuild specification

Canonical reference for **what the HTTP/trading gateway must be** if rebuilt from scratch. This document summarizes objectives, requirements, and acceptance gates. Implementation detail lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); authority boundaries in [`AUTHORITY.md`](AUTHORITY.md); day-to-day ops in [`OPERATIONS.md`](OPERATIONS.md).

**Scope:** the Node process on `127.0.0.1:8790` started via `start.ps1`. It is **not** the Hermes `gateway run` cron scheduler (see [Operational split](#operational-split-two-processes)).

**Wire contract:** `release/paired-contract.json` (must stay byte-identical with the paired Hermes profile copy when changed).

---

## Mission

Equip an AI trading operator (Hermes) with **truthful TopstepX/ProjectX evidence** and **reliable order execution**, without inducing factual error: wrong identity, false healthy state, duplicate intents, wrong-order mutation, or unproven protection.

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

Topstep-first. Venue-neutral extraction may follow later; premature abstraction must not weaken the tailored implementation.

---

## Authority model

| Role | Owns |
|------|------|
| **Alan** | Human judgment; may make mistakes |
| **Hermes** | Whether to trade; direction, timing, sizing intent; learning |
| **Glitch (this gateway)** | Provider transport, identity, calculations, execution safety, recovery, attributable evidence |
| **ProjectX** | Venue account, order, position, fill, market transport truth |
| **Topstep** | Account-program and commercial rule authority |

Hermes may make a bad trade. Glitch must not misstate data, apply wrong identity, mutate the wrong order, silently lose protection, duplicate an intent, or report healthy state when dependencies disagree.

### Glitch may reject (deterministic safety)

- Unknown, expired, or mismatched decision/packet identity
- Wrong account, contract, instrument, or provider identity
- Malformed schema or impossible numeric geometry
- Stale, disconnected, contradictory, or unreconciled venue state
- Quantity above authoritative hard contract ceiling
- Protected downside reaching authoritative hard loss floor (MLL)
- Order mutation whose ownership cannot be proven
- Duplicate or transport-ambiguous execution
- Inability to prove native protection

Rejections must be explicit, attributable, append-only, and visible to learning.

### Glitch must not encode (forbidden policy)

- Directional thesis, regime preference, setup score, or indicator trigger
- Arbitrary risk %, daily profit target, trade quota, or frequency gate
- Blocking or inflating `NOTHING` for data lag, quiet tape, or missing depth (TS-DATA-01, TS-AUDIT-03)
- Simultaneous multi-instrument exposure without portfolio-risk proof (TS-MULTI-04)
- Weakening automatic breakeven or daily-capture protection (TS-AUTH-02)
- Direct ProjectX mutation from the Hermes profile
- Time-based resubmit/terminalize of ambiguous transport without reconciliation
- NinjaTrader, Apex, replication, or generic prop-firm assumptions in the core

**Change test** (from [`AUTHORITY.md`](AUTHORITY.md)): before adding a deterministic rule, ask whether it prevents a *factual* execution error with an *authoritative* observable boundary. If removing the rule only lets Hermes exercise judgment, the rule belongs in cognition, not the gateway.

---

## Functional requirements

### Paired capabilities

From `release/paired-contract.json` — **required** for a paired profile release:

| Capability | Purpose |
|------------|---------|
| `packet_supported_actions` | Actions valid for current packet/position state |
| `durable_mutation_receipts` | Durable provider mutation receipts |
| `restart_reconciliation` | Reconcile venue state after process restart |
| `bounded_entry_range_v1` | Executable entry geometry validation |
| `daily_capture_context_v1` | Daily-capture context on decision packets |
| `explicit_partial_completed_bars_v1` | Explicit partial-bar semantics in observation |
| `revisioned_outcome_feed_v1` | Canonical outcomes with revision cursor |
| `multi_instrument_observation_v1` | Multi-instrument observation plane |
| `protected_reduction_saga_v1` | Armed partial EXIT with proven stop coverage |

**Also advertised:** native protection, bracket verification, position management, tranche ownership, entry band guidance (advisory), immediate lifecycle facts, intent receipt lookup.

### HTTP API (local only)

Default `http://127.0.0.1:8790`. Sensitive routes require `Authorization: Bearer <GLITCH_LOCAL_TOKEN>`. Operator controls require `GLITCH_OPERATOR_TOKEN`.

| Endpoint | Role |
|----------|------|
| `GET /health` | Liveness, streams, reconciliation, invariant metrics, recovery, safety supervisor |
| `GET /packet` | Sanitized decision packet for Hermes (`glitch.direct.decision_packet.v2`) |
| `POST /intents` | Intent admission (`glitch.intent.v3`, v2 compat) — rebuild-target name; the current live route is `POST /intent` (singular), unreconciled with this spec (see README.md) |
| `GET /outcomes/feed` | **Sole canonical writer** of trade outcomes (`glitch.topstep.outcome_feed.v2`) |
| `GET /execution/facts` | Immediate lifecycle facts per `intent_id` |
| `GET /evidence` | Bounded ProjectX evidence for acceptance/debug |
| `GET /ownership` | Read-only order/fill ownership projection |
| `POST /control` | Flatten, pause (operator token) |

Hermes must consume outcomes via the HTTP feed and maintain its own cursor. `GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH` is emergency-only (second writer).

### Schemas and protocol

| Artifact | Schema |
|----------|--------|
| Health | `glitch.direct.health.v2` |
| Runtime intent | `glitch.intent.v3` |
| Decision packet | `glitch.direct.decision_packet.v2` |
| Outcome feed | `glitch.topstep.outcome_feed.v2` |
| Execution facts | `glitch.topstep.execution_fact.v1` |
| Protocol revision | `glitch.topstep.paired.v3` |

Bump `release/paired-contract.json` and the profile manifest **together** on any wire change.

---

## Internal architecture

```text
ProjectX REST
  auth · discovery · bars · reconciliation · mutations
  bounded historical order/trade windows

ProjectX User SignalR Hub
  account · position · order · trade events

ProjectX Market SignalR Hub
  quote · print · depth events
            │
            ▼
Provider evidence boundary
  parse · redact · persist raw + normalized · sequence · hash
            │ persistence succeeds
            ▼
VenueStateStore
  connection generation · stream health · reconciliation
  account-wide conservative bid/ask marking
            │
            ├──────────────────────────┐
            ▼                          ▼
DecisionPacketService          Hard execution calculations
  current packet                 tick · point value · MLL headroom
  issued snapshot lease          hard contract ceiling
  sanitized identity             stop-aware protected loss
  explicit data_quality
            │
            ▼
Hermes (external) chooses trade
            │ strict intent
            ▼
ExecutionCoordinator
  serialized intents · packet identity · freshness gates
  durable outbox · entry-settlement latch
            │
            ▼
ProjectX order mutation
  entry · close · provider-side protection
```

### Durability

| Store | Mode | Holds |
|-------|------|--------|
| `glitch-topstep.sqlite` | WAL, `synchronous=FULL` | Intents, issued packets, outbox, receipts — no auto-retention in hot path |
| `projectx-evidence.sqlite` | WAL, `synchronous=NORMAL` | REST + stream evidence; bounded market-stream retention only |
| `trade-outcomes.sqlite` | revision feed | Canonical completed outcomes |

**Invariant:** realtime payload that cannot be persisted must not silently advance `VenueStateStore`; degrade and request REST reconciliation.

### History and ownership

- `ProjectXHistorySyncService`: bounded windows, overlap, cursor advances only after orders **and** trades persist successfully.
- Ownership projection: durable intent + provider order ID + exact order/trade evidence → attributable fills; contradictions → `incomplete` with explicit issues.
- Ambiguous provider transport stays **nonterminal** until custom-tag, historical search, or position truth reconciles — no duplicate exposure from timers alone.

### Frozen distributed policies

From `release/paired-contract.json` → `distributed_contract.frozen_policies`:

1. **Daily capture blocks new entries** (intent-free; do not weaken)
2. **Automatic breakeven is intent-free** (do not weaken)
3. **Automatic paths tighten only** (no loosening via automation)

Cadence hints for the paired state machine: flat decision every 5 minutes, positioned management every 1 minute (profile-side; gateway enforces facts, not strategy).

---

## Non-functional requirements

### Deployment

- Run on the **trader's local device** only — not VPS, VPN, or cloud executor ([`OPERATIONS.md`](OPERATIONS.md)). This is a Topstep platform rule (see [TopstepX API Access](https://help.topstep.com/en/articles/11187768-topstepx-api-access): "all trading must originate from a personal device"), not an internal preference.
- Bind `127.0.0.1`; never expose port 8790 to LAN/internet.
- Trading modes: `shadow` (journal only) → `armed` (requires explicit `GLITCH_ARMED_ACK`).
- Credentials and ProjectX API keys stay in local `.env`.
- Auth uses ProjectX's API-key login (`POST /api/Auth/loginKey`), not the "authorized applications" OAuth-style flow — correct for a single-trader local executor, not a multi-tenant integration.

### Reliability and recovery

- In-process: SignalR auto-reconnect, `restartHub`, quote-silence and stuck-hub timeouts (~15s / ~90s).
- Process fallback: `scripts/gateway-health-watchdog.ps1` — restart via `start.ps1 -SkipBuild` when degraded with quote stale + stuck streams or stale reconciliation ≥3 minutes (`src/observability/gateway-watchdog-policy.ts`).
- ProjectX read circuit breaker: degrade explicitly; do not accept new exposure while `state_complete=false` when supervisor agrees.
- Protect existing exposure when Hermes is unavailable.
- Session token (`POST /api/Auth/validate`) must be revalidated before its ~24h expiry (`POST /api/Auth/loginKey` has no separate refresh-token flow); a failed revalidation degrades `/health` explicitly rather than mutating ProjectX with a stale token.
- ProjectX enforces per-endpoint rate limits: `50 req/30s` on `POST /api/History/retrieveBars`, `200 req/60s` on all other endpoints; excess returns `429`. History sync, REST reconciliation, and `/evidence` reads share this budget — track and back off explicitly rather than retrying blindly into `429`.

### Observability

`/health` must expose at minimum:

- `data_quality.state_complete`, `issues`, stream operational state
- `execution_recovery` (blocking ambiguity, unresolved mutations)
- `safety_supervisor` (mode fields for invariant tracking; currently observe-only — it reports, it does not yet gate execution, see `src/safety/safety-supervisor.ts`)
- Invariant metrics: unprotected quantity/seconds, flatten pending, reconciliation age, evidence queue depth

Alert on `execution_recovery_blocking=true` or `failed_shutdown` lifecycle.

### Session and flatten

- `GLITCH_SESSION_MUST_FLAT_LOCAL_TIME` (default 15:10 CT): closes `session.entry_window_open` until trading-day reset (17:00 CT).
- Quotes may still flow; mutations may fail when instrument inactive.
- Hermes must skip flat ENTER when entry window is closed.

---

## Acceptance criteria

### Shadow (before armed)

Prove via credentialed PRAC or equivalent:

- Configured account ID/name and contract resolve uniquely and match TopstepX UI, using the provider's `simulated`/`live` fields — not name heuristics — to distinguish PRAC from funded accounts
- REST positions/orders match UI; SignalR quote/order/position/trade events arrive
- Reconnect resubscription works; no silent event gap
- `/packet` stable until authoritative state changes
- Malformed and wrong-account intents fail with explicit codes
- Valid entries journaled as shadowed
- Stop-aware risk matches independent spreadsheet
- MLL floor matches Topstep dashboard

### Armed promotion

- Gateway + profile paired manifest byte-identical
- P0 REAUDIT ledger items done; fault matrix proof archived
- PRAC soak: zero residual owned orders through flatten controls
- `preflight-pairing.py` green against local gateway
- At least one protected round-trip (ENTER → fill → flat) before trusting learning/outcomes

### Rollback

1. `GLITCH_TRADING_MODE=shadow` or stop gateway
2. `POST /control` flatten if exposure remains
3. Reinstall prior paired release pair
4. Verify `execution_recovery.blockingNewExposure=false` before re-arming

---

## Operational split (two processes)

Do not conflate these in design or runbooks:

| Process | Port | Autostart (Windows) | Function |
|---------|------|---------------------|----------|
| **Glitch Topstep gateway** | 8790 | `GlitchTopstep_Gateway` → `start.ps1` | ProjectX adapter, packet, intents, outcomes |
| **Hermes cron scheduler** | — | `Startup\Hermes_Gateway_glitch-topstep.vbs` or `hermes gateway start` | `hermes cron` ticks, cycle/learning launchers |

Only the Node gateway binds 8790. Hermes `gateway run` does **not** replace it. Disable duplicate `Hermes_Gateway` / `Hermes_Gateway_glitch` tasks per `scripts/disable-hermes-gateway-scheduled-tasks.ps1`.

If `hermes cron status` reports gateway not running: `scripts/ensure-hermes-gateway-scheduler.ps1`.

---

## Rebuild order (suggested waves)

Minimal dependency order for a greenfield implementation:

| Wave | Deliverable | Exit proof |
|------|-------------|------------|
| **W0** | ProjectX auth, account/contract resolution, `/health` skeleton | Credentials resolve; REST smoke |
| **W1** | Evidence boundary + `projectx-evidence.sqlite` + stream connect | Events persist before state advance |
| **W2** | `VenueStateStore` + reconciliation + `/packet` v2 | `state_complete` true in PRAC; packet stable |
| **W3** | Hard calculations (tick, MLL, contract ceiling) on packet | Spreadsheet parity |
| **W4** | `ExecutionCoordinator` shadow mode + intent journal | Shadow intents attributed; rejects explicit |
| **W5** | Armed ENTER/EXIT + native protection + bracket verification | Protected round-trip PRAC |
| **W6** | Outcome feed + execution facts + ownership projection | Hermes feed cursor; learning debrief one trade |
| **W7** | Restart recovery + history sync + protected reduction saga | Restart mid-position; partial EXIT fixtures |
| **W8** | Multi-instrument observation + watchdog + soak | 72h PRAC with documented SLIs |

Do not implement cognition, ranking, or strategy in any wave. Pair with profile only after W5+ and `release/paired-contract.json` reflects actual capabilities.

---

## Related documents

| Document | Use when |
|----------|----------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Runtime topology, evidence, history, ownership detail |
| [`AUTHORITY.md`](AUTHORITY.md) | Permitted vs forbidden deterministic rules |
| [`OPERATIONS.md`](OPERATIONS.md) | Local run, armed promotion, watchdog, break-glass |
| [`AGENTS.md`](../AGENTS.md) | Repo map, forbidden stop lines, check before PR |
| [`release/paired-contract.json`](../release/paired-contract.json) | Wire capabilities and versions |
| [`docs/plans/2026-08-20-nt-adaptation-roadmap.md`](plans/2026-08-20-nt-adaptation-roadmap.md) | Wave order and frozen policies |
| [`docs/plans/2026-08-25-complete-audit-implementation-plan.md`](plans/2026-08-25-complete-audit-implementation-plan.md) | P0 audit items |

---

## Code map (current implementation)

| Area | Path |
|------|------|
| HTTP server | `src/server/local-gateway.ts` |
| Execution / intents | `src/execution/` |
| Market / packets | `src/market/`, `src/hermes/packet-builder.ts` |
| ProjectX client | `src/projectx/` |
| State machines | `src/domain/state-machines.ts` |
| Watchdog policy | `src/observability/gateway-watchdog-policy.ts` |
| Tests | `tests/` |
