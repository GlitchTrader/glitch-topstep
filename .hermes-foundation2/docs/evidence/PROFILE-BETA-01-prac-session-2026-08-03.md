# PROFILE-BETA-01 — PRAC armed session evidence

**Date (UTC):** 2026-08-03, ~13:55–14:03  
**Operator:** Alan (local Windows machine)  
**Account:** PRAC-V2-645601-15979101 (simulated)  
**Instrument:** MNQ  
**Gateway mode:** armed  
**Purpose:** Cross-repository profile acceptance evidence for [glitch-topstep-hermes-profile#24](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/24)

---

## Immutable identity

| Artifact | Value |
|---|---|
| Hermes profile | `glitch-topstep` **v0.1.6** |
| Profile source | `github.com/GlitchTrader/glitch-topstep-hermes-profile` |
| Profile installed | `2026-08-03T13:15:30+00:00` |
| `prompt_version` | `glitch-topstep-v4` |
| Model | `gpt-5.6-luna` (openai-codex) |
| Gateway | `glitch-topstep` **v0.1.2** |
| Gateway commit (running clone) | `fb50580` + local `prompt_version` v4 patch ([PR #59](https://github.com/GlitchTrader/glitch-topstep/pull/59)) |
| Gateway URL | `http://127.0.0.1:8790` |
| Profile path | `%LOCALAPPDATA%\hermes\profiles\glitch-topstep` |
| Gateway path | `C:\Users\arifr\Projects\glitch-topstep` |
| Cron | `glitch-topstep-direct-operator` active (`* * * * *`) |

---

## Episode summary

One bounded PRAC trade episode demonstrating flat abstention, entry, positioned management, and return to flat.

| UTC | Action | Venue contracts | Receipt |
|---|---|---:|---|
| 13:55:43 | `NOTHING` | 0 | `202 / ignored / no_execution_action` |
| 13:57:07 | **`ENTER_LONG`** | 0→1 | `202 / pending / entry_submitted_pending_reconciliation` |
| 13:58:46 | `HOLD` | 1 | `202 / ignored / no_execution_action` |
| 13:59:41 | **`MOVE_STOP`** | 1→0 | `202 / pending / move_stop_submitted_pending_reconciliation` |
| 14:00:46 | `NOTHING` | 0 | `202 / ignored / no_execution_action` |
| 14:02:37 | `NOTHING` | 0 | `202 / ignored / no_execution_action` |

**Narrative:** ~8 minutes of disciplined flat `NOTHING`, then a single-contract long entry with structural stop/target, one-minute `HOLD`, tightened stop via `MOVE_STOP`, position closed (flat by 14:00), resumed flat observation.

---

## Key intent highlights

### ENTER_LONG (13:57:07Z)

- `intent_id`: `774b92f8-61a2-5c3a-b68e-e7f722bf1cf0`
- `quantity`: 1
- `order_type`: MARKET
- `stop_loss`: 28507.5
- `take_profit_1`: 28620
- `change_condition`: invalidation below 28515 or bearish 60s/300s flow with rejection below 28539.5
- `final_choice`: ENTER_LONG

### MOVE_STOP (13:59:41Z)

- `intent_id`: `7190dddb-d671-5659-a523-ddc1a43dbc6e`
- `new_stop_price`: 28578.25 (tighten below immediate structure 28585.25)
- `change_condition`: reassess target if acceptance above 28610 with renewed buy flow; exit/manage if loss below 28585.25
- `final_choice`: MOVE_STOP

---

## Acceptance checklist mapping

- [x] Flat scheduled cognition with truthful abstention (`NOTHING` ×3 before entry)
- [x] Positioned cognition (`HOLD` at 1 contract)
- [x] Active management (`MOVE_STOP`, not HOLD-only)
- [x] Gateway accepted intents (`prompt_version` v4 paired; no `prompt_version_mismatch`)
- [x] Armed mutation path exercised (entry + stop amendment)
- [x] No duplicate entry (0 → 1 → 0 contract path)
- [x] Worker completed cycles (`direct-worker-status`: ok)
- [ ] Final reconciliation receipts (pending → terminal) — attach follow-up if available in gateway journal

---

## Operator watch log (excerpt)

```
09:55:51 | mode=armed | pos=0 | action=NOTHING | receipt=202/ignored/no_execution_action | worker=ok
09:57:09 | mode=armed | pos=1 | action=ENTER_LONG | receipt=202/pending/entry_submitted_pending_reconciliation | worker=ok
09:58:59 | mode=armed | pos=1 | action=HOLD | receipt=202/ignored/no_execution_action | worker=ok
09:59:46 | mode=armed | pos=1 | action=MOVE_STOP | receipt=202/pending/move_stop_submitted_pending_reconciliation | worker=ok
10:00:49 | mode=armed | pos=0 | action=NOTHING | receipt=202/ignored/no_execution_action | worker=ok
```

---

## Attached raw artifacts

Same directory:

- `PROFILE-BETA-01-prac-session-2026-08-03.decisions.jsonl` — 6 decision records
- `PROFILE-BETA-01-prac-session-2026-08-03.receipts.jsonl` — 6 delivery receipts

No credentials, tokens, or ProjectX numeric IDs beyond sanitized account alias.

---

## Known limitations (explicit)

- Gateway `trade_outcome.v1` not yet published → learning overlay remains observational
- Entry receipts show `pending/..._pending_reconciliation` at capture time (async venue reconcile)
- Running gateway includes unpromoted PR #59 (`prompt_version` v4) atop `fb50580`
