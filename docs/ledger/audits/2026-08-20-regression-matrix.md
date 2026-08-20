# TS-AUDIT-11 — Paired regression matrix (gateway)

**Date:** 2026-08-20  
**Issue:** [#166](https://github.com/GlitchTrader/glitch-topstep/issues/166)  
**Profile companion:** GTHP-AUDIT-04 (#126)

## Matrix (audit finding → automated gate)

| Audit item | Gateway test file | Status |
|------------|-------------------|--------|
| GTHP-AUDIT-01 decision index | (profile) `test_state_store.py` | covered in profile PR |
| TS-AUDIT-05 rearm partial | `tests/rearm-latch-regression.test.ts` | green on main |
| TS-AUDIT-06 auth refresh | `tests/projectx-auth-manager.test.ts` | green on main |
| TS-AUDIT-07 flatten saga | `tests/flatten-saga.test.ts` | green on main |
| TS-AUDIT-08 evidence drain | `tests/evidence-write-queue.test.ts` | branch `feat/audit-08-evidence-drain` |
| TS-DATA-01 hygiene | `tests/data-evidence-hygiene.test.ts` | branch `feat/data-evidence-hygiene-phase-b` |

CI entrypoint: `npm run check` (build + full test suite). Non-blocking soak/PRAC gates remain manual per TS-R1-04 doctrine.
