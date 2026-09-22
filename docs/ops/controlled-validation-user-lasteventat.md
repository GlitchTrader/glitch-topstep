# Controlled validation gates — user stream / flat-idle contract

Date: 2026-09-22  
Schema: `glitch.topstep.controlled_validation_gates.v2`  
PR: #307

## Observation

On the 2026-09-22 controlled validation, after restart the user hub reported
`state=connected` with `lastEventAt=null` while the account was flat
(`positions=[]`, `openOrders=[]`). Market hub had a recent `lastEventAt`.
Investigation class: **contract-valid flat-idle**
(`docs/evidence/CONTROLLED-VALIDATION-20260922-POST306/user-stream-contract-investigation.md`).

Standalone SignalR premise evidence (zero user payloads in 2 minutes after
subscribe): `docs/evidence/FLAT-IDLE-USER-STREAM-PREMISE-20260922/`.

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
3. Reconciliation **fresh** via `reconciliationFresh` (**fail-closed on generation**):
   - `state=succeeded` (not `running` / `failed`)
   - `operational.generation` **and** `reconciliation.generation` both present as
     non-negative integers — **missing or invalid ⇒ fail** (never skipped)
   - generations **equal**
   - `lastSucceededAt` within max age on capture clock
   - health issues must **not** include `reconciliation_not_current` or
     `account_state_stale`
4. User hub `connected` (not reconnecting)
5. Market stream connected **and** recent events on capture clock
6. BBO complete and fresh (see below) — missing BBO ⇒ `insufficient`, never pass

Any open position, working order, pending recovery, stale/missing generation,
stale recon, missing market events, or stale/missing BBO → mode `insufficient`
(fail closed).

## BBO freshness (capture-only)

Never evaluate quote age with wall-clock `Date.now()` against frozen JSON.

Order of evidence:

1. `health.data_quality.quote_age_ms` from the capture (preferred)
2. Else `quote.timestamp` / `packet.market.quote_timestamp` vs capture clock:
   - `capture_now_ms` / `now_ms` input, else
   - `health.recorded_utc`, else
   - `state.capturedAt`
3. If neither age source is available → `bbo_capture_age_unavailable` (fail closed)

## Accepted ProjectX risk (provider limitation — not an ops waiver)

ProjectX user hub has **no replay/cursor/backfill**. During a disconnect gap:

1. Fills in the gap may still be recoverable later via REST `Order/search` /
   `Trade/search`.
2. A **suspended bracket (`status: 8`) created during the gap can be invisible**
   both on the user stream (missed) and on REST (`searchOpen` / `search` do not
   surface it) until the parent entry fills and the bracket becomes working
   (`status: 1`). Protection state is genuinely unknowable in that interval.

Source: `docs/PROJECTX-API-REFERENCE.md` §7.6.

**`flat_idle_user_stream` does not remove this provider limitation.** It only
allows a missing/stale user `lastEventAt` when independent confirmations are
present (flat positions, empty `openOrders`, fresh matched-generation
reconciliation, connected user hub, recent market events, fresh BBO).

This accepted risk is **not** authorization to trade, arm, or continue with an
unknown position or unknown working order. Position / order / BBO / reconciliation
gates remain fail-closed and are never relaxed by flat-idle mode.

## CLI

```text
node scripts/evaluate-controlled-validation-gates.mjs \
  --health health.json --state state.json [--packet packet.json] \
  [--packet-latency-ms N] [--capture-now-ms EPOCH_MS]
```

When `--capture-now-ms` is omitted, the evaluator uses `health.recorded_utc`
(or `state.capturedAt`). Do not re-evaluate old artifacts with a live wall clock.
