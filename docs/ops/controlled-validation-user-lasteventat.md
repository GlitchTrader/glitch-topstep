# Controlled validation gates — user stream / flat-idle contract

Date: 2026-09-22  
Schema: `glitch.topstep.controlled_validation_gates.v2`

## Observation

On the 2026-09-22 controlled validation, after restart the user hub reported
`state=connected` with `lastEventAt=null` while the account was flat
(`positions=[]`, `openOrders=[]`). Market hub had a recent `lastEventAt`.
Investigation class: **contract-valid flat-idle**
(`docs/evidence/CONTROLLED-VALIDATION-20260922-POST306/user-stream-contract-investigation.md`).

## Stream subscription proof (unchanged)

`src/projectx/stream-subscriptions.ts` connection-health proof requires:

- `userStream.state === "connected"`
- `marketStream.state === "connected"`
- `marketStream.lastEventAt` present

It does **not** require `userStream.lastEventAt`.

## Gate contract (v2)

`evaluateControlledValidationGates` exposes `user_stream_mode`:

| Mode | Meaning |
|------|---------|
| `recent_events` | `userStream.lastEventAt` fresh on the **capture clock** |
| `flat_idle_user_stream` | lastEventAt null/stale **and** every flat-idle precondition holds |
| `insufficient` | fail closed |

Gate `user_stream_recent_events` is true when mode is `recent_events` **or**
`flat_idle_user_stream`. The boolean `gates.flat_idle_user_stream` is informational
(true only when that mode is active) and is **not** a mandatory gate by itself.

### `flat_idle_user_stream` preconditions (all required)

1. Account flat (`positions` present, all size/quantity 0)
2. `openOrders=[]` confirmed (no ambiguity)
3. Reconciliation **fresh**: `state=succeeded`, generation matches operational
   generation when both present, `lastSucceededAt` within max age on capture clock,
   health issues must **not** include `reconciliation_not_current` or
   `account_state_stale`, and state must not be `running`/`failed`
4. User hub `connected` (not reconnecting)
5. Market stream connected **and** recent events on capture clock
6. BBO complete and fresh (see below)

Any open position, working order, pending recovery, stale recon, missing market
events, or stale/missing BBO → mode `insufficient` (fail closed).

## BBO freshness (capture-only)

Never evaluate quote age with wall-clock `Date.now()` against frozen JSON.

Order of evidence:

1. `health.data_quality.quote_age_ms` from the capture (preferred)
2. Else `quote.timestamp` / `packet.market.quote_timestamp` vs capture clock:
   - `capture_now_ms` / `now_ms` input, else
   - `health.recorded_utc`, else
   - `state.capturedAt`
3. If neither age source is available → `bbo_capture_age_unavailable` (fail closed)

## CLI

```text
node scripts/evaluate-controlled-validation-gates.mjs \
  --health health.json --state state.json [--packet packet.json] \
  [--packet-latency-ms N] [--capture-now-ms EPOCH_MS]
```

When `--capture-now-ms` is omitted, the evaluator uses `health.recorded_utc`
(or `state.capturedAt`). Do not re-evaluate old artifacts with a live wall clock.
