# TS-EXEC-01 — immediate lifecycle facts (2026-08-20)

Proof bundle for closing gateway issue #123 and Hermes GTHP-LEARN-02 (#107) pairing.

## Gateway surface

- `GET /execution/facts?after_sequence=&limit=` — schema `glitch.topstep.execution_facts.v1`
- Stable `fact_id` = `fact:{intent_id}:{phase}` with monotonic `sequence` and `revision`
- Phases: admission, submission, provider accept/reject, partial fill, protection, amendment, exit, flat (`src/execution/lifecycle-facts.ts`)
- Diagnostics bucket: `decision_latency_ms`, transport/slippage/fees nullable until enriched (`tests/lifecycle-facts.test.ts`)

## Live sample

`tests/fixtures/gateway/execution_facts_live_sample.json`:

- `health_execution_facts.live` = 90, `superseded` = 0
- Sample facts include `intent_admitted` and `intent_rejected` with attributable provider detail (instrument inactive), **not** directional lessons

## Hermes consumer (GTHP-LEARN-02)

- `scripts/common.py` → `sync_gateway_execution_facts()` appends to `execution-facts.jsonl` separately from trade outcomes
- `scripts/run-topstep-learning.py` syncs facts every run; learning prompts treat infrastructure facts as execution evidence, not strategy lessons
- Paired fixture: `tests/fixtures/paired/exec01_execution_facts_page.json`
- Tests: `tests/test_paired_contracts.py` (`Exec01ExecutionFactsFixtures`), `tests/test_learning.py` (`test_sync_gateway_execution_facts`)

## Regression commands

```powershell
cd C:\Users\arifr\Projects\glitch-topstep
npm run check -- tests/lifecycle-facts.test.ts tests/execution-facts-fixture.test.ts

cd C:\Users\arifr\Projects\glitch-topstep-hermes-profile
python -m unittest tests.test_paired_contracts.Exec01ExecutionFactsFixtures tests.test_learning.LearningTests.test_sync_gateway_execution_facts -v
```

## Residual

Slippage/fee enrichment fields remain null until provider receipts supply them; schema allows null and separates transport failures from directional learning per stop-line.
