## Summary

TS-R3-01 implemented the trade outcome publisher, `GET /outcomes`, and Hermes `sync_gateway_outcomes()`, but live PRAC sessions after 2026-08-03 never produce canonical outcomes. Receipts and SQLite execution state confirm real armed fills, while `trade-outcomes.jsonl`, Hermes `outcomes.jsonl`, and `trade_episode_count` remain empty.

## Root cause

`TradeOutcomePublisher` only runs when REST reconcile observes `beforeOpen > 0 && afterOpen === 0`. `GatewayUserPosition` stream events call `applyPosition()` between reconciles and often mark the instrument flat before reconcile runs, so `beforeOpen === 0` and publication is skipped.

## Plan (ledger authority)

Spec: `docs/specs/TS-R3-03.md`  
Ledger: `TS-R3-03` in `docs/ledger/ledger.json`

### Phase A — Reliable flat detection (P0)
- Detect flat on stream or reconcile
- Capture open tranches before venue state goes flat
- Deduplicate by `intent_id`; emit `trade_outcomes_published` event

### Phase B — Hermes mirror + learning loop (P0)
- Configure `GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH`
- Verify `sync_gateway_outcomes()` and learning debrief produces `trade-episodes.jsonl`

### Phase C — Outcome enrichment v1.1 (P1)
- Fills, slippage, MAE/MFE, buffer impact, explicit `exit_reason`
- Keep `learning_eligible` strict (proven protection + attributable entry + provider trades)

### Phase D — Backfill (P2)
- Idempotent script from SQLite + `Trade/search` for prior PRAC sessions

## Acceptance

- [ ] PRAC round-trip produces row in `data/trade-outcomes.jsonl` and `GET /outcomes`
- [ ] Hermes `state/outcomes.jsonl` mirrors via export path
- [ ] Learning-eligible trade yields `trade_episode_count >= 1` after debrief
- [ ] Regression: stream-flat-before-reconcile still publishes
- [ ] Enriched outcome includes fills/MAE/MFE when evidence exists

## Stop line

Do not treat TS-R3-01 as production-complete for learning until live PRAC flat publishes at least one canonical outcome and Hermes debriefs it.
