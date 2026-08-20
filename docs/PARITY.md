# Glitch Topstep parity ledger

This ledger tracks promotion and runtime evidence for the Topstep-native gateway. It maps useful behavioural contracts from other Glitch editions where they still apply. **It is not an NT port checklist** — see [`TOPSTEP-NATIVE.md`](TOPSTEP-NATIVE.md) for design principles.

Donor repositories are read-only. A row is complete only when implementation, deterministic tests, and required runtime evidence agree.

| Capability | Topstep state | Remaining acceptance evidence |
|---|---|---|
| Agent authority, no hidden deterministic strategy | Implemented | Real operator review and profile installation |
| Account, contract, instrument, profile, and prompt identity | Implemented | Real sanitized ProjectX session |
| User and market stream health | Implemented | Real disconnect/reconnect fixture |
| Session phase and stream_health packet mirrors | Implemented | `session.phase`, `stream_health.*` in decision packet v2 (TS-R4-07) |
| Post-entry bracket verification (`protection_status`) | Implemented in software — [#86](https://github.com/GlitchTrader/glitch-topstep/issues/86) | `protection.protection_status` pending\|confirmed\|failed\|unknown; 30s timeout; live fill fixture |
| REST reconciliation after reconnect | Implemented | Compare restored state with TopstepX UI |
| Truthful `/health`, packet, and execution freshness | Implemented | Runtime stale/future timestamp fixture |
| Account-wide conservative equity | Implemented | Reconcile every open contract against TopstepX UI |
| Hard loss-floor calculation | Implemented for configured models | Automatic authoritative account lifecycle |
| Protected market entry translation | Scaffold implemented | Real provider bracket and fill evidence |
| Durable SQLite intent identity | Implemented | Process and Windows restart fixtures |
| Atomic UUID plus body-hash claim | Implemented | Process-kill and Windows restart fixtures |
| Same UUID with different body conflict | Implemented | Operator acceptance of conflict receipt |
| Durable outbox before provider mutation | Implemented | Kill-point fixtures around every transition |
| Serialized entry settlement latch | Implemented | Real order/position propagation fixture |
| Ambiguous entry recovery | Implemented by exact historical custom-tag identity | Real transport-timeout fixture |
| Ambiguous close recovery | Implemented from authoritative flat position state | Real disconnect fixture |
| Orphan and missing-receipt reconstruction | Implemented | Actual crash fixtures |
| Persistent issued decision leases | Implemented | Process restart during model latency |
| Provider event journal | Integrated | Real payload-rate, reconnect, and disk-failure acceptance |
| Evidence-before-state ordering | Implemented | Real SignalR payload fixture |
| Sanitized raw realtime evidence | Implemented | Validate against current ProjectX payloads |
| Normalized REST reconciliation evidence | Implemented | Sanitized REST envelopes stored with snapshot identity; inspect `GET /evidence?source=projectx_rest` |
| Bounded market-event retention | Implemented | Tune retention from observed quote/print/DOM rates |
| Authenticated evidence inspection | Implemented | Operator acceptance and replay tooling |
| Explicit provider relationship index | Implemented | Validate `trade.orderId` retention on real payloads |
| Durable historical order/trade cursor | Implemented | Real ProjectX timestamp-boundary and restart acceptance |
| Bounded history windows and correction overlap | Implemented | Verify undocumented result caps or pagination behavior |
| Historical provider-version deduplication | Implemented | Real correction, void, and late-update payload fixtures |
| Submitted entry-order ownership | Implemented from durable provider order ID | Real offline interval and order-correction acceptance |
| Fill ownership | Implemented only from exact `trade.orderId` relation | Real partial, corrected, and voided fill fixtures |
| Ownership contradiction detection | Implemented | Real duplicate/correction payload acceptance |
| Authenticated ownership inspection | Implemented | Operator acceptance of `/ownership` output |
| Aggregate position ownership | Unknown by design | Explicit provider relation or deterministic reconstruction contract |
| Provider-created stop/target ownership | Implemented in software — [#17](https://github.com/GlitchTrader/glitch-topstep/issues/17) | `customTag` SL/TP binding; live acceptance + nonterminal entry proof on sanitized payloads |
| Exact structural bracket correction | Implemented in software — [#17](https://github.com/GlitchTrader/glitch-topstep/issues/17) | `modifyOrder` amendment receipts; sibling non-interference on live payloads |
| `MOVE_STOP` | Implemented in software — [#24](https://github.com/GlitchTrader/glitch-topstep/issues/24) | Live acceptance 2026-07-30: short+long cycles, venue stop moved, idempotent replay (`move_stop_reconciled`) |
| `MOVE_TP` | Implemented in software — [#25](https://github.com/GlitchTrader/glitch-topstep/issues/25) | Live acceptance 2026-07-30: short+long cycles, venue TP moved |
| Partial scale-out (`EXIT` quantity) | Implemented in software — [#26](https://github.com/GlitchTrader/glitch-topstep/issues/26) | Full flat `EXIT` live 2026-07-30 (202/`close_contract_submitted`); partial qty not exercised (1 MNQ contract) |
| Multiple independent entry tranches | Implemented in software (Phase A+B+C) — [#27](https://github.com/GlitchTrader/glitch-topstep/issues/27), [#37](https://github.com/GlitchTrader/glitch-topstep/pull/37), [#38](https://github.com/GlitchTrader/glitch-topstep/pull/38) | Live A/B/C `all_pass: true` on PRAC nova (`data/pm4-phase-c-e2e.json`, 2026-07-31, `PM4_E2E_RESTART=1`) |
| Canonical completed outcomes | Implemented v1.1; Phase C live MAE/MFE on PRAC — [#70](https://github.com/GlitchTrader/glitch-topstep/issues/70) | `learning_eligible=true` with proven protection + debrief; optional backfill (Phase D); commission if ProjectX exposes it |
| Session, holiday, and early-close truth | Session packet fields implemented (operator-configured) — [#65](https://github.com/GlitchTrader/glitch-topstep/issues/65) | Authoritative Topstep-verified calendar; holiday/early-close |
| Daily economics mirror (`daily_economics`) | Implemented (reconciled outcomes + operator config) — [#76](https://github.com/GlitchTrader/glitch-topstep/issues/76) | Operator reconciliation against Topstep dashboard intraday PnL; cognition evidence only |
| Deterministic provider replay | Implemented offline and query-only | Compare replay state with real TopstepX state and observed corrections |
| Replay gaps, truncation, and invalid payload reporting | Implemented | Tune retention/export so required corpora remain complete |
| Native 1m/5m/15m/60m ProjectX bars | Implemented | Verify real History API boundaries, ordering, limits, and partial bars |
| Multi-timeframe normalization, gaps, and partial-bar provenance | Implemented | Compare against TopstepX chart output |
| Strategy-neutral ATR, volatility, VWAP, EMA, location, candle, and volume features | Implemented | Validate numerical parity against independent fixtures |
| Market observation packet identity | Implemented without execution gating | Real Hermes observation and cost/latency acceptance |
| Rolling 15s/60s/300s Buy/Sell tape and delta | Implemented from official TradeLogType | Compare against real TopstepX tape fixtures |
| Rolling tape VWAP, trade rate, size, and price path | Implemented | Validate high-rate and quiet-market behavior |
| Bounded DOM reconstruction with Reset/currentVolume semantics | Implemented, always `book_complete=false` | Prove full-book reconstruction contract on real payloads |
| Depth spread, top-level volume, and imbalance | Implemented as descriptive partial evidence | Compare against real DOM snapshots and resets |
| Order-flow packet identity and health | Implemented without execution gating | Real Hermes latency and retention acceptance |
| Instrument-general Topstep support | Operator allowlist (MNQ, MES, MCL→MCLE) resolved from the ProjectX catalog; every candidate observed, exactly one armed per account (`account_selection.v1`, `simultaneous_exposure_enabled=false`) | Live armed session on a second contract with per-contract outcome attribution — MCL/MCLE outcome is still `unknown` |
| Topstep account-stage and payout lifecycle | Manual evidence only | Provider/dashboard provenance and reconciliation |
| Replay and comparative cognition evaluation | Replay foundation implemented | Identical evidence corpus across cognition versions |
| Hermes autonomous cognition | Implemented in companion profile | Actual Windows/Hermes acceptance |
| First complete payout lifecycle | Missing | Reconciled account progression and payout evidence |

## Consolidated implementation sequence

1. **Authority, runtime truth, durable intent identity, and mutation recovery — implemented in software.**
2. **Integrated ProjectX evidence journal — implemented in software.**
3. **Exact submitted-entry and fill ownership from explicit provider IDs — implemented in software.**
4. **Durable offline order/trade history continuity — implemented in software.**
5. **Deterministic offline provider replay — implemented in software.**
6. **Native multi-timeframe ProjectX market evidence — implemented in software.**
7. **Rolling tape and bounded depth evidence — implemented in software.**
8. Real ProjectX read-only, payload-rate, bar/history/order-flow boundary, disconnect, correction, replay comparison, and crash-window acceptance.
9. **Position management (PM)** — phased roadmap below; Hermes must not advertise actions the gateway has not accepted.
10. Canonical outcomes and Hermes learning input.
11. Session structure and automatic Topstep policy/session truth.
12. One-account shadow evaluation, promotion review, and payout lifecycle.

## Position management roadmap (PM)

Topstep-native position management is **not** NT Master/Follower replication. Each phase earns ledger acceptance before the Hermes profile adds the corresponding `supported_actions` or intent shape.

| Phase | Track | Issue | Unblocks | Hermes impact |
|---|---|---|---|---|
| **PM-0** | Protection ownership + nonterminal entry proof | [#17](https://github.com/GlitchTrader/glitch-topstep/issues/17) | `protection.status: proven`, `open_protected` terminal state | No new actions; truthful `protection` block in packet |
| **PM-1** | `MOVE_STOP` exact-leg amendment | [#24](https://github.com/GlitchTrader/glitch-topstep/issues/24) | Runner / breakeven stop moves | Add `MOVE_STOP` to `supported_actions` after acceptance |
| **PM-2** | `MOVE_TP` exact-leg amendment | [#25](https://github.com/GlitchTrader/glitch-topstep/issues/25) | Target extension / trail | Add `MOVE_TP` after acceptance |
| **PM-3** | Partial scale-out | [#26](https://github.com/GlitchTrader/glitch-topstep/issues/26) | Bank partial profit, leave runner | `EXIT` with optional `quantity` / `exit_fraction` |
| **PM-4** | Multi-tranche entries (optional) | [#27](https://github.com/GlitchTrader/glitch-topstep/issues/27) | Scale-in as separate decisions | Per-tranche evidence in packet / outcomes |

### PM-0 acceptance (blocks all later phases)

- Provider stop and target child IDs bound to entry via explicit `trade.orderId` / `customTag` — never inferred from price proximity.
- Entry receipt stays nonterminal until reconciled position + protective geometry match intent.
- `protection.status` must not remain `unknown` while position is open.
- Process restart reconstructs ownership from durable order/trade history before any replay.

### PM-1 / PM-2 acceptance (amendments)

- Amendment intents select one protective leg by provider identity.
- REST modify → pending receipt → reconciled terminal (applied / rejected / ambiguous).
- Sibling leg and position quantity unchanged on success.
- Same UUID/body idempotent replay; no blind resubmit after timeout.

### PM-3 acceptance (partial exit)

- Partial `EXIT` reduces attributable quantity only; default remains full flat.
- Document ProjectX bracket rescale/rebind behavior on partial close.
- Packet reflects remaining quantity and protection state truthfully.

**ProjectX bracket matrix (PRAC MNQ, 2026-08-19/20):**

| Side | Partial EXIT qty 1 of 2 | Exited-tranche brackets | Survivor brackets | Notes |
|------|-------------------------|-------------------------|-------------------|-------|
| SHORT | Venue accepted (`placeOrder` market) | Still visible in open_orders snapshot beside survivor (possible REST lag / orphans) | A SL/TP stayed; MOVE_STOP OK; MOVE_TP `target_would_widen` | Fixture `partial_exit_protection_transition.json` |
| LONG | Venue accepted | Cancelled / absent after EXIT B | A SL/TP proven; MOVE_STOP + MOVE_TP OK | Fixture `partial_exit_protection_transition_long.json` |

Gateway path: cancel only targeted tranche brackets → submit reduction → durable saga `reduction_ambiguous` → rearm stop-first if survivor naked (`degraded_stop_only` → `reduced_protected`). Rollback: `GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1`.

### PM-4 acceptance (multi-tranche, defer)

- Each tranche: intent UUID + entry order ID + protective children.
- Explicit policy for partial exit targeting (tranche vs FIFO/LIFO).
- Restart recovers all open tranches from provider history.

**Live prerequisite (TopstepX):** protected entries require **Auto OCO Brackets** enabled on the account. If ProjectX returns `Brackets cannot be used with Position Brackets`, disable Position Brackets or enable Auto OCO in the Topstep dashboard before running E2E or live entries.

**Current gateway state (live, 2026-07-31):** PR [#38](https://github.com/GlitchTrader/glitch-topstep/pull/38) live-validated on PRAC-V2-645601-15979101. PM-4 Phase C E2E with `PM4_E2E_RESTART=1` **`all_pass: true`** (`data/pm4-phase-c-e2e.json`, 14:21–14:31 UTC, Hermes paused): scenario A (SHORT multi-tranche + MOVE + flat), scenario B (two tranches survive gateway restart with `ownership_two_tranches`), scenario C (LONG mirror). Root cause closed in this pass: open-order evidence was unioning every historical `open_orders_snapshot`, so cancelled brackets stayed "working" forever and stole `remaining_qty` from live intents after restart; ownership now uses only the newest snapshot plus newer realtime order events. Venue behaviours the fixes still depend on: Auto OCO cancels the whole bracket group on partial exit (survivor re-arm), ProjectX rejects reused protective `customTag`s (generation `-rN-`), and `MOVE_STOP` edits in place (re-arm must use last venue price). Run only one E2E process at a time; ProjectX velocity control may absorb early attempts after recent trading.

## Promotion rule

Tests prove software contracts; they do not prove profitability or live readiness. `armed` promotion requires named runtime evidence for all P0 execution rows, followed by a frozen, attributable, after-fee shadow or simulated sample. Profitability remains an empirical property of the operator and evidence, not a claim inferred from architecture.
