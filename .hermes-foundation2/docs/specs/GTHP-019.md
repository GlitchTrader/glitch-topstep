# GTHP-019 — Persistent wake triggers and durable changeWhen monitor

**Status:** done  
**Priority:** P1  
**Issue:** [#62](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/62)  
**Profile version:** 0.1.23  
**Depends on:** GTHP-009, GTHP-018  
**Gateway dependency:** `glitch-topstep:TS-R4-07` (session.phase for SESSION_PHASE triggers)

## Problem

Fixed cron cadence misses fast regime changes. Glitch V2 `changeWhen` / wake triggers let Hermes run when evidence crosses thresholds. Profile references `active-wake-triggers.json` but durable evaluation between ticks is thin.

## Invariant

| Layer | Rule |
|-------|------|
| **Triggers** | Schedule **invocation** only; Hermes still decides action. |
| **Storage** | `supervisor/active-wake-triggers.json` survives restarts; schema versioned. |
| **Dedup** | Fired triggers respect cooldown window; events auditable. |
| **Quiescence** | GTHP-018 skip applies when flat + quiescent unless `invocation_reason` is `condition_change` (wake-fired). |

## Schema `glitch.topstep.wake_triggers.v1`

Runtime artifact: `state/supervisor/active-wake-triggers.json`

```json
{
  "schema_version": "glitch.topstep.wake_triggers.v1",
  "packet_id": "uuid",
  "triggers": [],
  "updated_utc": "ISO-8601",
  "cooldown_seconds": 120,
  "eval_snapshot": { "price": 20000.0, "phase": "regular", "updated_utc": "..." },
  "fire_history": {
    "PRICE_CROSS:ABOVE:20000.0": {
      "last_fired_utc": "...",
      "last_packet_id": "...",
      "wake_reason": "PRICE_CROSS:ABOVE:20000.0",
      "source": "monitor|cycle"
    }
  }
}
```

### Trigger types

| Type | Fields | Fires when |
|------|--------|------------|
| `PRICE_CROSS` | `direction` (`ABOVE`/`BELOW`), `price` | Prior eval price on opposite side of level and current crosses through |
| `SESSION_PHASE` | `phase` (`regular`/`maintenance`/`asia`) | `session.phase` transitions into target from a different known phase |

`TAPE_BURST` and `DOM_IMBALANCE` are deferred until gateway tape/DOM wake fields stabilize (ponytail).

Hermes must still list explicit `PRICE_CROSS` triggers matching `change_condition` price phrases; `SESSION_PHASE` triggers are optional supplements.

## Monitor architecture

1. **Cron** `glitch-topstep-wake-monitor` (every minute) runs `launch-wake-trigger-monitor.py`.
2. Launcher starts detached `run-wake-trigger-monitor.py --loop` if not already running (`state/wake-monitor.lock`).
3. Monitor polls `GET /packet` every `GLITCH_TOPSTEP_WAKE_POLL_SECONDS` (default 15s).
4. On fire (not in cooldown, direct cycle not locked): records `wake_trigger_fired` event, writes `pending-wake-invocation.json`, launches `launch-topstep-cycle.py`.
5. Direct cycle reads pending wake, sets `invocation_reason=condition_change`, logs `wake_reason` on cognition events, bypasses GTHP-018 quiescence skip.

Positioned accounts still invoke on every cron minute via `invocation_reason=positioned`; wake monitor does not double-launch when positioned.

## Events

- `wake_trigger_fired` — auditable fire with `wake_reason`, `cooldown_seconds`, `source`.
- `decision_ready` / `decision_failed` / skips — include `wake_reason` when wake-fired.

## Acceptance

- [x] Documented trigger schema (PRICE_CROSS, SESSION_PHASE).
- [x] Monitor evaluates triggers against gateway packet between cron ticks.
- [x] `wake_reason` in `events.jsonl` on trigger-fired cycle.
- [x] Dedup cooldown documented and tested.
- [x] GTHP-018 quiescence bypass for `condition_change`.
- [x] Tests: dedup, persistence, monitor launch, positioned behavior.

## Stop line

No pre-baked ENTER/EXIT; no hidden strategy in trigger definitions.

## Related

- GTHP-018, GTHP-023
- `glitch-topstep:TS-R4-07`
- V2 `GLITCH_V2_MODIFICATIONS.md` wake / changeWhen sections
