# TS-BETA-01 — Immutable paired artifact baseline

**Recorded (UTC):** 2026-08-04T23:50:00Z  
**Operator machine:** Windows local (Ari Freund)  
**Promotion status:** **candidate — awaiting explicit operator promotion**  
**Issue:** [#52](https://github.com/GlitchTrader/glitch-topstep/issues/52)

This document freezes the named gateway + Hermes profile pair for one-account PRAC beta. It does **not** claim beta readiness by itself.

---

## Named pair

| Role | Artifact | Version / identity |
|---|---|---|
| Gateway | `glitch-topstep` | **0.1.3** @ `c83a22fb9f69b0298ee4a3c399897f3abf8df875` (`c83a22f`) |
| Gateway package | `package.json` | `0.1.3` |
| Gateway entry artifact | `dist/src/index.js` SHA-256 | `c6ec0368a11eff6cdc4fb81ee5faa70311254139cdfde99f3b4ad2f629174a8e` |
| Gateway install path | Projects clone | `C:\Users\arifr\Projects\glitch-topstep` |
| Gateway startup | `start.ps1` → background Node on `127.0.0.1:8790` | local only |
| Hermes profile | `glitch-topstep` | **0.1.13** (installed `distribution.yaml`) |
| Profile source commit | `glitch-topstep-hermes-profile` `origin/main` | `a7f37a62546bdb5eb271b53723365c50660c6d52` (`a7f37a6`) |
| Profile install path | `%LOCALAPPDATA%\hermes\profiles\glitch-topstep` | installed_at `2026-08-03T17:12:22+00:00` |
| Prompt contract | gateway `GLITCH_TOPSTEP_PROMPT_VERSION` | `glitch-topstep-v4` |
| Health / intent schemas | `glitch.direct.health.v2`, `glitch.intent.v2` | decision packet `v1`/`v2` |
| Outcome publisher | `TRADE_OUTCOME_PUBLISHER_VERSION` | `0.1.3-r3-03c` |
| Compatibility | Hermes ↔ gateway | via `/health` `compatibility` block (TS-REL-01) |

### Profile file hashes (installed tree)

| File | SHA-256 (prefix) |
|---|---|
| `distribution.yaml` | `583731a556184c28…` |
| `operator.json` | `61cf4c61d7d9e2ad…` |
| `SOUL.md` | `7e009833aad161a1…` |
| `config.yaml` | `05104e6eb0ccfa11…` |
| `SHA256SUMS` | `8970d55698daca12…` |

Full per-file hashes: installed `SHA256SUMS`.

---

## Selected account / environment (sanitized)

| Field | Value |
|---|---|
| Account name | `PRAC-V2-645601-90809185` |
| Account id | `26219092` |
| Stage | simulated PRAC (`GLITCH_REQUIRE_SIMULATED=true`) |
| Contract | `CON.F.US.MNQ.U26` / `MNQ` |
| Trading mode | `armed` (ack present) |
| Entry window | `GLITCH_ENTRY_WINDOW_OPEN=false` (operator-configured session) |
| Session | Chicago `must_flat` 15:10 (`GLITCH_SESSION_*`) |
| Loss model | `express_funded_eod` / XFA 150k / initial max loss 2000 |
| Max contracts | 3 |
| Outcomes export | Hermes `state/outcomes.jsonl` |
| Bind | `127.0.0.1:8790` only |

Credentials (`PROJECTX_*`, `GLITCH_LOCAL_TOKEN`) redacted — not part of the immutable public baseline.

---

## Dependency evidence (already attached)

| Gate | Status | Pointer |
|---|---|---|
| TS-REL-01 compatibility | done | `/health` compatibility contract |
| TS-R1-04 kill/reconnect | done | `tests/fixtures/projectx/live/r1_04_kill_matrix_proof.json` (`proof_passed=true`, 2026-08-03); `data/r1-04-run.log` |
| TS-R2-06 historical identity | done | fixture corpus + tests (ledger 2026-08-03) |
| TS-R2-07 stream/disk rates | done | `tests/fixtures/projectx/live/event_rates_proof.json` (2026-08-03) |
| PROFILE-BETA-01 | done (profile ledger) | `glitch-topstep-hermes-profile` `docs/evidence/PROFILE-BETA-01-prac-session-2026-08-03.*` against gateway **0.1.2** / profile **0.1.6** |
| TS-R3-01 outcomes | done | publisher + `/outcomes` |
| TS-R3-02 session packet | done | operator-configured `must_flat_utc` |
| TS-R3-03 A/B/C | software done; live MAE/MFE `learning_eligible` still open | PR #72/#73; repair of `a255faad` published fills without MAE/MFE |

---

## Rollback artifacts

1. Gateway: `git checkout 88f6782` (pre–Phase C) or previous package; rebuild; restart `start.ps1`.
2. Profile: re-run Hermes profile `setup.ps1` from a pinned commit older than `a7f37a6` (e.g. evidence-era commit in PROFILE-BETA-01 doc).
3. Trading: set `GLITCH_TRADING_MODE=shadow` and/or keep `GLITCH_ENTRY_WINDOW_OPEN=false`; cancel open orders via `scripts/cancel-open-orders.mjs`.
4. Keep `data/` and Hermes `state/` copies before any reset.

---

## Known limitations (explicit)

- Single configured contract/account only (TS-MULTI-01 open).
- Manual Topstep UI trades do not create Glitch tranches → no canonical outcome.
- Commission (~$0.50 Topstep) may not appear in ProjectX `Trade.fees`.
- MAE/MFE require an open position observed by the running gateway; restart mid-trade or post-hoc repair yields `mae_usd`/`mfe_usd` null and `learning_eligible=false`.
- `account_state_stale` can degrade `/health` during slow reconcile — not a silent trade authorize.
- Holiday/early-close calendar not authoritative (session fields operator-configured).
- Partial EXIT bracket behavior still needs explicit ProjectX evidence (issue #67).
- Prop evaluation/live (non-PRAC) is out of scope for this beta pair.
- PROFILE-BETA-01 mutation evidence was captured on gateway **0.1.2**; this baseline upgrades the gateway pin to **0.1.3** — operator promotion confirms the pair on current bits.

---

## Acceptance checklist (operator)

- [x] Immutable baseline recorded (this file)
- [x] R1-04 / R2-06 / R2-07 / PROFILE-BETA-01 / REL-01 pointers attached
- [ ] Shadow/read-only reconciliation spot-check on this machine against TopstepX UI (account, contract, position, orders, quotes, stream, health)
- [ ] One bounded protected PRAC mutation on **this** 0.1.3 pair (pending→terminal, restart/reconnect, pause, flatten, receipts) — or explicit operator acceptance that 2026-08-03 PROFILE-BETA-01 + post-0.1.3 outcome trades suffice
- [ ] No duplicate entry / unexplained exposure / unprotected attributable position on the promotion window
- [ ] Operator explicitly promotes: write date + signature below

### Operator promotion (required)

```text
I promote the named pair glitch-topstep@0.1.3 (c83a22f) + hermes profile glitch-topstep@0.1.13 (a7f37a6)
to one-account PRAC beta on PRAC-V2-645601-90809185 / MNQ.

Operator: _______________  Date (UTC): _______________
```

Until that line is signed, ledger `TS-BETA-01` remains `external_acceptance_required`.
