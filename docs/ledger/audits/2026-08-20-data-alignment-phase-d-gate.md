# TS-DATA-01 Phase D — Metrics gate

**Date:** 2026-08-20  
**Issue:** [#171](https://github.com/GlitchTrader/glitch-topstep/issues/171)

Phase D (order flow per scanner candidate, native `instrument_comparison`) stays **disabled** until:

1. Phases A–C are merged and stable for five or more sessions.
2. Operator sets `GLITCH_DATA_PHASE_D=1` **and** `GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC`.

Code entrypoint: `src/market/data-alignment-phase-d-gate.ts` (`isDataAlignmentPhaseDEnabled`).
