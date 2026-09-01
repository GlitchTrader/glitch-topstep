# Operations

## Startup order

1. Start the local `glitch-topstep` Node gateway in `shadow` mode.
2. Verify `GET /health` locally.
3. Install and configure this profile.
4. Run `/topstep_status`.
5. Run `/trade` to begin scheduled cognition.
6. Inspect decision and receipt ledgers before considering any gateway mode change.

## Safe defaults

- Profile jobs: paused on first setup.
- Gateway execution mode: controlled only in the gateway repository.
- Cognitive overlays: proposed, not activated.
- Scheduled model toolsets: memory only.
- Flat cognition: one call per minute by default; operators may reduce flat cadence explicitly.
- Flat cognition outside the gateway `session.entry_window_open` window is skipped by default (`GLITCH_TOPSTEP_RESPECT_SESSION_GATE=true`); positioned cycles, operator directives, and wake triggers still invoke. Set `GLITCH_TOPSTEP_SESSION_GATE_OVERRIDE=true` for PRAC acceptance outside RTH.
- Flat cognition during **market quiescence** (stale quote plus minimal tape) is skipped by default (`GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT=true`, GTHP-018). When `packet.stream_health` is present (gateway ≥0.1.6), the gate prefers `stream_health.quote_age_ms` and `stream_health.trade_count_60s`; otherwise it falls back to `data_quality` + `order_flow`. Quiescence is not applied while `stream_health.reconnect_pending` is true (or stream reconnect issues are present). Thresholds: `GLITCH_TOPSTEP_MAX_QUOTE_AGE_MS` (default 6000) or `quote_stale` in `data_quality.issues`, and 60s trade count at or below `GLITCH_TOPSTEP_QUIESCENT_MAX_TRADE_COUNT_60S` (default 0). Events record `market_quiescent`, not `session_closed`. Legacy `GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE=true` is an alias. Set `GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT=false` to invoke Luna on every flat cadence tick regardless of tape. The learning supervisor is never gated by quiescence. **Wake-fired cycles** (`invocation_reason=condition_change`, GTHP-019) bypass quiescence and log `wake_reason` in `events.jsonl`.
- **Wake triggers (GTHP-019):** Hermes persists triggers in `state/supervisor/active-wake-triggers.json` (`glitch.topstep.wake_triggers.v1`). Supported types: `PRICE_CROSS`, `SESSION_PHASE` (gateway `session.phase` from TS-R4-07). Cron job `glitch-topstep-wake-monitor` keeps `run-wake-trigger-monitor.py` polling between direct-operator ticks. Env: `GLITCH_TOPSTEP_WAKE_POLL_SECONDS` (default 15), `GLITCH_TOPSTEP_WAKE_TRIGGER_COOLDOWN_SECONDS` (default 120 dedup window). Monitor status: `state/supervisor/wake-monitor-status.json`. Triggers schedule invocation only — no pre-baked ENTER/EXIT.
- Positioned cognition: one call per minute; manage with `HOLD`, `MOVE_STOP`, `MOVE_TP`, partial or full `EXIT`, and scale-in only when advertised in `execution.supported_actions`.
- **Participation breadth (GTHP-022, `glitch-topstep-v6`):** Hermes may enter on partial timeframe alignment when a locally falsifiable, protected thesis exists. Retest, closed candle, persistent flow, and full HTF agreement are confidence boosters, not universal gates. Do not increase frequency via quotas, artificial stop tightening, or size increases.
- **Bracket verification (GTHP-020, gateway ≥0.1.6):** When positioned, `protection.protection_status` is `pending` | `confirmed` | `failed` | `unknown`. Hermes blocks `MOVE_STOP`/`MOVE_TP` unless `confirmed`. On `failed`, inspect venue working orders and consider `EXIT`; the gateway does not auto-flatten. See gateway `docs/OPERATIONS.md` for operator retry.

## Incident controls

`/pause_trading` stops new model calls but does not cancel provider orders or remove protection.

`/flatten_all` performs three actions:

1. pause both Hermes jobs;
2. fetch the current authenticated packet;
3. submit a deterministic human-authored EXIT through the same strict intent endpoint.

If the gateway is unavailable, jobs remain paused and the command reports that it could not prove flatten submission. Use the provider UI as the final human control.

## Logs and state

The profile-local `state/` directory is intentionally excluded from distribution updates. Back it up before migration, but never copy it into another account without reviewing account aliases and gateway configuration.

`/topstep_status` reports the detached operator worker's actual `running`, `ok`, or `failed` state from `state/supervisor/direct-worker-status.json`. The cron launcher can finish successfully before that worker does, so use the worker state when diagnosing decision delivery.

Do not commit `.env`, sessions, memory, state, or logs.

## Profile updates (Windows)

Always record `source: github.com/GlitchTrader/glitch-topstep-hermes-profile` in the installed `distribution.yaml`. Never install or update from a local clone path — Hermes copies `.git` into the profile and future updates fail with `PermissionError`.

Canonical update command:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\scripts\safe-profile-update.ps1"
```

`config.yaml` holds operator model routing (`model.default`, `provider`, etc.). Hermes profile update preserves it by default, so `setup.ps1` does not checksum-verify `config.yaml` (same as `distribution.yaml`). To replace it with the distribution default, rerun with `-ForceConfig`.

Contributors: after changing distribution-owned files, run `python scripts/regenerate_sha256sums.py` before merging. CI rejects drift.

## Release version checklist

When cutting a profile release paired with a gateway build:

1. Bump `distribution.yaml` `version`.
2. Update `scripts/distribution_manifest.py` `TESTED_GATEWAY_VERSION` (and `MIN_GATEWAY_VERSION` only when the floor moves).
3. Confirm `PROMPT_VERSION` matches the direct-cycle contract (`glitch-topstep-v*`).
4. Run the full unittest suite and `python scripts/regenerate_sha256sums.py`.
5. Verify `GET /health` on the target gateway reports a compatible `compatibility.gateway_version`.
6. Bump `GLITCH_TOPSTEP_PROMPT_VERSION` in the gateway repo (`src/domain/operator.ts`) to the same `glitch-topstep-v*` string as `PROMPT_VERSION` in this profile. Mismatch causes `intent_schema_invalid` / `prompt_version_mismatch` on every intent.
7. Run `safe-profile-update.ps1` on a Windows operator host after merge.

### Gateway prompt pairing (operator shortcut)

When the profile bumps `prompt_version` (e.g. v0.1.31 → `glitch-topstep-v9`) but the local gateway clone is stale:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\scripts\sync-glitch-topstep-prompt-v9.ps1" `
  -GatewayPath C:\Users\arifr\Projects\glitch-topstep `
  -CreatePr -MergePr
```

Then restart the gateway (`Stop-Process` on port 8790 PID, `.\start.ps1`). Patch: `patches/glitch-topstep-v9-prompt-version.patch`.

`tests/test_compatibility.py` fails on drift between `parity.PROMPT_VERSION`, `distribution_manifest`, and `PROFILE_COMPATIBILITY`.

### Linux / operator preflight

```bash
python scripts/preflight-pairing.py --gateway-root ~/Projects/glitch-topstep
```

Sync a stale local gateway clone to `glitch-topstep-v9`:

```bash
bash scripts/sync-glitch-topstep-prompt-v9.sh --gateway-path ~/Projects/glitch-topstep
```

Apply gateway issue #73 packet/422 changes when the bot cannot push `glitch-topstep` directly:

```bash
cd ~/Projects/glitch-topstep
git checkout main && git pull origin main
git checkout -b fix/issue-73-packet-quality
git apply --index "$(dirname "$0")/../patches/glitch-topstep-issue-73-gateway.patch"  # from profile repo root:
# git apply --index patches/glitch-topstep-issue-73-gateway.patch
npm run check
git commit -m "feat: packet data quality and structured 422 diagnostics (#73)"
git push -u origin fix/issue-73-packet-quality
```

Patch file: `patches/glitch-topstep-issue-73-gateway.patch` (pairs with profile **0.1.32**).

### ProjectX Auto OCO Brackets (operator configuration)

When entries fail with ProjectX errors mentioning **Position Brackets** vs **Auto OCO Brackets**:

1. Open the TopstepX / ProjectX account settings for the trading account.
2. Disable **Auto OCO Brackets** (or align bracket mode with Glitch's explicit stop/target submission path).
3. Confirm working protective orders are not duplicated after a rejected entry.
4. Restart the gateway after any account-level bracket setting change.
5. Re-run `python scripts/preflight-pairing.py` and submit a flat `NOTHING` intent to verify `202` / `no_execution_action` (not `422` / `prompt_version_mismatch`).

This is an operator configuration fix; the gateway cannot override ProjectX account bracket mode.

`setup.ps1` and `safe-profile-update.ps1` also run `ensure_hermes_distribution_patch.py`, which idempotently patches Hermes `profile_distribution.py` for Windows-safe profile updates (re-applied after Hermes agent upgrades).
