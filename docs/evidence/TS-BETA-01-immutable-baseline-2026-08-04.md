# TS-BETA-01 — Immutable paired artifact baseline

**Recorded (UTC):** 2026-08-05T19:15:00Z  
**Operator machine:** Windows local (Ari Freund)  
**Promotion status:** **promoted — operator shortcut acceptance**  
**Issue:** [#52](https://github.com/GlitchTrader/glitch-topstep/issues/52)

This document freezes the named gateway + Hermes profile pair for one-account PRAC beta and records operator promotion via **shortcut acceptance** (PROFILE-BETA-01 + post-0.1.3 mutation/outcome evidence). It does **not** claim live or evaluation-funded readiness.

Supersedes the 2026-08-04 candidate pin (`0.1.3` / `0.1.13` on account `90809185`).

---

## Named pair (promoted)

| Role | Artifact | Version / identity |
|---|---|---|
| Gateway | `glitch-topstep` | **0.1.4** @ `abf7a0253e2e47450d27906b1466110088274be9` (`abf7a02`) |
| Gateway package | `package.json` | `0.1.4` |
| Gateway entry artifact | `dist/src/index.js` SHA-256 | `c6ec0368a11eff6cdc4fb81ee5faa70311254139cdfde99f3b4ad2f629174a8e` |
| Gateway install path | Projects clone | `C:\Users\arifr\Projects\glitch-topstep` |
| Gateway startup | `start.ps1` → background Node on `127.0.0.1:8790` | local only |
| Hermes profile | `glitch-topstep` | **0.1.17** (installed `distribution.yaml`) |
| Profile source commit | `glitch-topstep-hermes-profile` `origin/main` | `efb8c2245ffb0c8d0e6766475ffa2bcc6827e8b8` (`efb8c22`) |
| Profile install path | `%LOCALAPPDATA%\hermes\profiles\glitch-topstep` | updated 2026-08-05 |
| Prompt contract | gateway `GLITCH_TOPSTEP_PROMPT_VERSION` | `glitch-topstep-v9` |
| Health / intent schemas | `glitch.direct.health.v2`, `glitch.intent.v2` | decision packet `v1`/`v2` |
| Outcome publisher | `TRADE_OUTCOME_PUBLISHER_VERSION` | `0.1.3-r3-03c` |
| Compatibility | Hermes ↔ gateway | `compatible (profile 0.1.17, gateway 0.1.4)` via `/health` |

### Profile file hashes (installed tree, prefix)

| File | SHA-256 (prefix) |
|---|---|
| `SOUL.md` | `80a343c881722aeb…` |
| `operator.json` | `8947fa7649ebab6b…` |
| `scripts/packet_model.py` | `19de24200498a452…` |

Full per-file hashes: installed `SHA256SUMS` (43 entries).

---

## Selected account / environment (sanitized)

| Field | Value |
|---|---|
| Account name | `PRAC-V2-645601-47191819` |
| Account id | `26282486` |
| Stage | practice PRAC (`GLITCH_ACCOUNT_STAGE=practice`) |
| Contract | `CON.F.US.MNQ.U26` / `MNQ` |
| Trading mode | `armed` (ack present) |
| Entry window | `08:30` America/Chicago (`GLITCH_SESSION_ENTRY_OPEN_LOCAL_TIME`) |
| Session | Chicago `must_flat` 15:10 |
| Nominal / starting balance | 150000 USD (epoch reset 2026-08-05) |
| Outcomes export | Hermes `state/outcomes.jsonl` (epoch reset cleared prior rows) |
| Bind | `127.0.0.1:8790` only |

Credentials (`PROJECTX_*`, `GLITCH_LOCAL_TOKEN`) redacted — not part of the immutable public baseline.

---

## Dependency evidence (attached)

| Gate | Status | Pointer |
|---|---|---|
| TS-REL-01 compatibility | done | `/health` compatibility contract |
| TS-R1-04 kill/reconnect | done | `tests/fixtures/projectx/live/r1_04_kill_matrix_proof.json` |
| TS-R2-06 historical identity | done | fixture corpus + tests |
| TS-R2-07 stream/disk rates | done | `tests/fixtures/projectx/live/event_rates_proof.json` |
| PROFILE-BETA-01 | done | `glitch-topstep-hermes-profile` `docs/evidence/PROFILE-BETA-01-prac-session-2026-08-03.*` |
| TS-R3-01 outcomes | done | publisher + `/outcomes` |
| TS-R3-02 session packet | done | operator-configured `must_flat_utc` |
| TS-R3-03 A/B/C | software done | ledger Phase C live 2026-08-05 (`intent 3deeab7f…`) |

---

## Shortcut mutation acceptance (operator)

Instead of a fresh bounded PRAC session on this exact pin, the operator accepts:

1. **PROFILE-BETA-01** (2026-08-03) — full flat → `ENTER_LONG` → `HOLD` → `MOVE_STOP` → flat on gateway **0.1.2** / profile **0.1.6** with armed receipts.
2. **Post-0.1.3 live evidence** — gateway ledger TS-R3-03 Phase C stream-flat outcome (`fills=2`, `mae_usd=42.5`) on publisher `0.1.3-r3-03c`.
3. **2026-08-04 Hermes mutations** on prior PRAC account `90809185` — positioned `HOLD` series + `EXIT` at `2026-08-04T19:12:56Z` (`prompt_version` v4/v5 era).
4. **2026-08-05 epoch-reset account** `47191819` — `EXIT` intents at `16:33`, `16:43`, `16:49` UTC with worker `ok` (flat management on new PRAC epoch).

No duplicate-entry or unexplained exposure was observed on the promotion window. Known limitations from PROFILE-BETA-01 and TS-R3-03 (`learning_eligible=false` when protection pending) remain explicit.

---

## Shadow spot-check (2026-08-05T19:12Z)

Captured from `GET /health` on the operator machine:

- `status`: `ok`, `trading_mode`: `armed`, `data_quality.state_complete`: `true`
- `compatibility.gateway_version`: `0.1.4`; profile reports compatible **0.1.17**
- `userStream` / `marketStream`: `connected`; `reconciliation.state`: `succeeded`
- `execution_recovery`: `blockingAmbiguity=false`, `unresolvedMutations=0`
- `provider_history.syncKey`: `projectx-history:26282486` (current account)
- `market_observation.instrument`: `MNQ`, contract `CON.F.US.MNQ.U26`

---

## Rollback artifacts

1. Gateway: `git checkout` prior release tag/commit; rebuild; restart `start.ps1`.
2. Profile: `safe-profile-update.ps1` from a pinned older `distribution.yaml` version.
3. Trading: set `GLITCH_TRADING_MODE=shadow`; pause Hermes jobs; `/flatten_all` if positioned.
4. Keep `data/` and Hermes `state/` copies before any reset.

---

## Known limitations (explicit)

- Single configured contract/account only (TS-MULTI-01 open).
- Manual Topstep UI trades do not create Glitch tranches → no canonical outcome.
- MAE/MFE require gateway observation during the open position; repair rows may be `learning_eligible=false`.
- Prop evaluation/live (non-PRAC) is out of scope for this beta pair.
- Shortcut acceptance does not re-prove pause/flatten/restart on **this** pin — operator accepts prior PROFILE-BETA-01 controls evidence plus ongoing `/pause_trading` and `/flatten_all` plugin contracts.

---

## Acceptance checklist

- [x] Immutable baseline recorded (this file, roll-forward to 0.1.4 / 0.1.17)
- [x] R1-04 / R2-06 / R2-07 / PROFILE-BETA-01 / REL-01 pointers attached
- [x] Shadow/read-only spot-check on operator machine (`/health` 2026-08-05T19:12Z)
- [x] Bounded mutation accepted via shortcut (PROFILE-BETA-01 + post-0.1.3 outcomes + 2026-08-04/05 EXIT/HOLD ledger)
- [x] No duplicate entry / unexplained exposure on promotion window (operator attestation)
- [x] Operator promotion signed below

### Operator promotion

```text
I promote the named pair glitch-topstep@0.1.4 (abf7a02)
+ hermes profile glitch-topstep@0.1.17 (efb8c22)
to one-account PRAC beta on PRAC-V2-645601-47191819 / MNQ,
accepting PROFILE-BETA-01 (2026-08-03) and post-0.1.3 mutation/outcome
evidence in lieu of a fresh bounded session on this pin.

Operator: Ari Freund  Date (UTC): 2026-08-05
```
