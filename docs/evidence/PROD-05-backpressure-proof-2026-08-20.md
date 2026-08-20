# TS-PROD-05 — bounded market-evidence backpressure (2026-08-20)

Proof bundle for closing issue #113 after PR #151 and live armed observation.

## Acceptance mapping

| Criterion | Evidence |
|-----------|----------|
| Durable commit before VenueState apply | `recordProviderEventBeforeApply` + `EvidenceWriteQueue` ack-before-apply test in `tests/evidence-write-queue.test.ts` |
| Identity never dropped; quote/depth coalesce deterministically | Burst test `never drops identity evidence in a burst above the TS-R2-07 rates`; coalesce tests retain newest quote per contract |
| High-water overflow degrades exposure without dropping identity | `high_water_hits > 0`, `dropped.print > 0`, `dropped.identity === 0`, `onDegraded` edge-triggered |
| Burst above TS-R2-07 rates | Synthetic **5×** observed rates for 10s using `tests/fixtures/projectx/live/event_rates_proof.json` |
| Shutdown drain or resumable cursor | `queue.close()` drains; `evidence_queue_drain_failed:pending=…:resume_cursor=…` when writes fail |

## Live armed gateway (2026-08-20T18:35Z)

Captured from `127.0.0.1:8790` while `trading_mode=armed`, `gateway_mode=armed`, `lifecycle=ready`:

Fixture: `tests/fixtures/gateway/execution_facts_live_sample.json` (`health_provider_evidence_queue` section).

| Metric | Value |
|--------|-------|
| `depth` | 3 |
| `identity_depth` | 0 |
| `degraded` | false |
| `enqueued` | 32 414 |
| `persisted` | 32 373 |
| `dropped.identity` | 0 |
| `coalesced.quote` | 21 |
| `coalesced.depth` | 17 |
| `max_write_latency_ms` | 122 |
| `write_failures` | 0 |
| `resume_cursor` | 33 612 336 |

## Regression commands

```powershell
cd C:\Users\arifr\Projects\glitch-topstep
npm run check -- tests/evidence-write-queue.test.ts
```

## Residual (non-blocking for this row)

Multi-hour soak publishing formal event-loop/HTTP/memory SLO dashboards remains operational monitoring, not a code gap. Burst regression + live queue health satisfy the ledger stop-line (no silent identity loss, no blocking apply-before-commit).
