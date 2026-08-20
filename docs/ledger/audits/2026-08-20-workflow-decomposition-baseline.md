# TS-AUDIT-09 — Workflow decomposition baseline (gateway)

**Date:** 2026-08-20  
**Issue:** [#164](https://github.com/GlitchTrader/glitch-topstep/issues/164)

| Module | Role |
|--------|------|
| `src/service/flatten-workflow.ts` | Flatten control transitions (pure) |
| `src/service/auth-session-workflow.ts` | Startup scope fetch retry |
| `src/service/reconciliation-service.ts` | ReconciliationEngine cycle |
| `src/service/lifecycle-supervisor.ts` | LifecycleSupervisor |
| `src/execution/protection-supervisor.ts` | Protection coverage evaluation |
| `src/projectx/auth-manager.ts` | ProjectX AuthManager |

Regression: `tests/flatten-workflow.test.ts`, `tests/protection-supervisor.test.ts`, `tests/workflow-decomposition.test.ts`.
