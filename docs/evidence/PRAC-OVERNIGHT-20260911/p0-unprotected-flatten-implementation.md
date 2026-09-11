# P0 unprotected fail-closed flatten — implementation evidence

## Status

`implemented` — unit matrix A–E green; `npm run check` green (666 tests).

`gateway_supervised_overnight`: still **false** until independent audit + paired validate + one-envelope smoke pass.

## Gap closed

When `protection_status=failed` or rearm is exhausted, and `unprotected_open_quantity > 0` with proven ownership, gateway submits idempotent `closePosition` and blocks new entries.

## Key paths

- `src/execution/unprotected-flatten.ts`
- `src/execution/coordinator.ts` → `flattenUnprotectedOwnedExposure`
- `src/service/reconciliation-service.ts` (after rearm)
- `src/storage/sqlite-execution-store.ts` (`unprotected_flatten_block` latch)
- `docs/OPERATIONS.md` updated

## Tests

`tests/hermes-death-unprotected-flatten.test.ts` — scenarios A–E + idempotency + ambiguity fail-closed.

## Orders

`orders_sent=0` during implementation and offline tests.
