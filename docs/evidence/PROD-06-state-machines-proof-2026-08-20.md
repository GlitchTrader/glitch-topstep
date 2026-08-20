# TS-PROD-06 — explicit state-machine modules (2026-08-20)

Proof bundle for closing issue #114: coordinator/service decomposition into ports, transition contracts, and extracted modules without behavior loss.

## Acceptance mapping

| Criterion | Evidence |
|-----------|----------|
| IntentAdmission, ExecutionSaga, ProtectionSaga, ReconciliationService, OutcomeFeed, EvidenceIngestor, LifecycleSupervisor have explicit ports and state contracts | `src/domain/ports/*`, `src/execution/intent-admission.ts`, `execution-saga.ts`, `protection-saga-orchestrator.ts`, `src/service/reconciliation-service.ts`, `outcome-feed.ts`, `evidence-ingestor.ts`, `TRANSITION_GRAPHS` in `state-machines.ts` |
| Domain modules do not perform filesystem, network, clock, or SQLite IO directly | `tests/architecture-layers.test.ts` |
| Coordinator and service become thin orchestration/composition layers | `coordinator.ts` delegates early admission to `evaluateIntentAdmissionEarly`; `service.ts` `reconcile()` delegates to `runReconciliationCycle` |
| Characterization, transition, property, and fault tests stay green | `npm run check` (full suite) + `tests/state-machine-contracts.test.ts` |
| Automated architecture checks reject cycles and forbidden adapter imports | `tests/architecture-layers.test.ts` (domain IO + execution→service ban) |

## Modules extracted

### Domain ports (`src/domain/ports/`)

- `clock-port.ts` — injectable time
- `execution-store-port.ts` — intent registration, facts, recovery status
- `venue-mutation-port.ts` — place/modify/cancel contract
- `execution-ledger-port.ts` — append + durability status
- `outcome-feed-port.ts` — revisioned outcome feed surface
- `evidence-ingestor-port.ts` — bounded provider evidence ingest
- `lifecycle-supervisor-port.ts` — startup/shutdown lifecycle contract

### State machines (`src/domain/state-machines.ts`)

Seven explicit transition graphs via `TRANSITION_GRAPHS`:

1. Lifecycle
2. IntentAdmission
3. ExecutionSaga
4. ProtectionSaga
5. Reconciliation
6. OutcomeFeed
7. ProtectedReduction (durable partial-exit saga; aligned with `protected-reduction-saga.ts`)

### Execution layer

- `intent-admission.ts` — `evaluateIntentAdmissionEarly()` with reject/ignore/ambiguous/handoff/proceed union
- `execution-saga.ts` — saga transition helpers + port bundle type
- `protection-saga-orchestrator.ts` — re-exports protected reduction + ProtectionSaga contract

### Service layer

- `reconciliation-service.ts` — `runReconciliationCycle(runtime)` (body moved from `service.reconcile()`)
- `outcome-feed.ts` — `OutcomeFeed` wrapper implementing port + `shouldPublishOnFlat`
- `evidence-ingestor.ts` — `EvidenceIngestorAdapter` over `EvidenceWriteQueue`

## Regression commands

```powershell
cd C:\Users\arifr\Projects\glitch-topstep
npm run check
npm run check -- tests/state-machine-contracts.test.ts tests/architecture-layers.test.ts tests/execution-coordinator.test.ts
```

## Residual (non-blocking for this row)

Further slices can wire coordinator mutation paths through `ExecutionSagaPorts` and inject ports at construction time. This PR establishes contracts, transition tests, architecture gates, and the first behavioral extractions (IntentAdmission + ReconciliationService) without a big-bang rewrite.
