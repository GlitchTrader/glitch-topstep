# PRAC soak — single_active_position (paired 0.2.2)

**Date:** 2026-08-21  
**Scope:** Credentialed PRAC validation after gateway #218/#173 and trail A+D.  
**Stop line:** Do not promote armed beyond current operator approval without this evidence ref in `paired-release.json`.

## Preconditions

- Gateway `main` ≥ `7a40542`, profile `main` ≥ trail A+D merge
- `/health`: `gateway_version` **0.2.2**, profile **0.2.2**, `trading_mode=armed`
- `account_selection.mode=single_active_position`, flat account at start
- Crons active: direct-operator, wake-monitor, learning-supervisor

## Scenarios (execute in order)

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | **Flat MNQ NOTHING** | Cycle completes; `cycle-empirical.jsonl` row; no duplicate JSONL decision |
| 2 | **Flat MES or MCL entry** | Winner handoff; `GET /packet?contract_id=` before POST; receipt `successful` or documented rejection |
| 3 | **Positioned management** | HOLD/MOVE_STOP on open instrument only; other candidates `flat_required` |
| 4 | **Auth stress** | Force token expiry (wait or restart gateway mid-session); no duplicate entry; auth gate blocks new exposure if degraded |
| 5 | **Delivery unknown recovery** | Simulate timeout (408/500); outbox `delivery_unknown` retained; retry without duplicate intent |
| 6 | **Flatten terminality** | Manual or recovery flatten → venue flat + zero working orders |

## Artifacts to capture

```
docs/evidence/PRAC-SOAK-2026-08-21/
  gateway-health.json
  cycle-empirical-sample.jsonl
  decisions-tail.jsonl
  receipts-tail.jsonl
  events-tail.jsonl
  soak-notes.md
```

Run checklist:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prac-soak-checklist.ps1
```

## Evidence ref for release

After soak: update `release/paired-release.json` via `paired-release-candidate` workflow with:

```
validation.prac_or_shadow_evidence_ref: docs/evidence/PRAC-SOAK-2026-08-21/soak-notes.md
```

## Fail criteria (stop soak)

- Duplicate `placeOrder` for same `intent_id`
- New exposure while `auth.degraded` or `blockingNewExposure`
- Simultaneous positions on two instruments
- JSONL decision duplicate for same `packet_id`
