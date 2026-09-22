# Flat-idle user-stream premise — SignalR standalone probe evidence

## Classification

`contract-valid flat-idle` premise support (not acceptance; not an ops waiver)

## Date

- Probe window (UTC): **2026-09-22T17:02:41.749Z → 2026-09-22T17:04:42.506Z** (2 minutes)
- Packaged (evidence promotion): 2026-09-22 (PR #307 follow-up)

## Scope

- **Standalone** ProjectX/TopstepX SignalR hubs only (`user` + `market`)
- **No** glitch-topstep gateway process
- **No** Hermes / smoke / multimarket probe / PRAC / soak
- Account resolved by the probe script via REST `Account/search` → first active account
  (`accountId=25775680` in this capture — not the PRAC account `26919346`; premise is
  “idle user hub emits no GatewayUser* after subscribe”, not account-identity proof)
- Contract: `CON.F.US.MNQ.Z26`

## Method

- Script: `scripts/probe-signalr-hubs-standalone.mjs` (workspace ops probe; not re-run for this package)
- Duration: `duration_minutes=2`
- User hub invokes: `SubscribeAccounts`, `SubscribeOrders`, `SubscribePositions`, `SubscribeTrades`
- Market hub subscribed for quote/trade (and depth when configured)
- Lifecycle only recorded in the JSONL; **no** `GatewayUser*` payload lines appear between
  `subscribed` and `closed_deliberate`

## Artifact

| Field | Value |
|-------|--------|
| Original path | `docs/evidence/signalr-standalone-probe-2026-09-22T17-02-41-748Z.jsonl` |
| Packaged copy | `signalr-standalone-probe-2026-09-22T17-02-41-748Z.jsonl` (this directory) |
| SHA-256 | `25B912FED42BD5469E6859C1342B1F7B1B104CE82D8CA98BB92614399C93EA49` |
| Integrity | Byte-identical copy of the original JSONL; **not** regenerated |

## Gateway / investigation context SHA

- Controlled-validation / investigation context around this day used gateway merge
  **`fbe0249`** (`fix(ops): correct controlled-validation openOrders and BBO gates (#306)`).
- Flat-idle gate contract PR: **#307** (`fix/controlled-validation-flat-idle-contract`).
- This package does **not** claim the probe was executed under a specific gateway process
  SHA (gateway was intentionally out of scope).

## Result summary (from artifact)

| Field | Value |
|-------|--------|
| `total_events` | 9 (start/login/lookup/connect/subscribe/close/summary — lifecycle only) |
| `instability_events` | 0 |
| `verdict` | `stable_standalone_no_flapping_without_gateway` |
| User hub `GatewayUser*` payloads in window | **0** |

## How this is used

Supports the documented premise that a connected, subscribed user hub may emit **no**
account/order/position/trade events while idle — therefore `userStream.lastEventAt=null`
can be **contract-valid flat-idle**, not proof of a dead subscription by itself.

It does **not**:

- accept PRAC/soak
- relax position / order / reconciliation / BBO gates
- authorize trading with unknown position or unknown working orders
- eliminate the ProjectX suspended-bracket gap limitation (`docs/PROJECTX-API-REFERENCE.md` §7.6;
  see `docs/ops/controlled-validation-user-lasteventat.md`)
