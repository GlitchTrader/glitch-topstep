# Incidentes — PRAC-SOAK-2026-08-31

| UTC | Fase | Severidade | Descrição | Ação operador | Resolvido |
|-----|------|------------|-----------|-----------------|-----------|
| 2026-08-31T17:04Z | directed-test-2 | **P0** | Partial EXIT 1/3: saga `reduction_ambiguous`, gateway `unprotected_open_quantity=2`, SL/TP not observed; tranche attribution stale | Operator confirmed UI: +2 MNQ, OCO OFF; authorized flatten | **exposure cleared** 2026-08-31T17:11Z |
| 2026-08-31T17:11Z | recovery | info | Supervised `POST /control` flatten (`aff1ddd8…`) → `venue_flat_confirmed`, flat + zero working orders | Flatten via gateway control plane | yes |

**Root cause do Teste 2 (1ª tentativa) corrigido localmente** — reconciliação de EXIT parcial + guard de rearm. Retry PRAC **PASS** (`test-02-partial-close-retry.json`). Follow-up aberto: atribuição de tranche stale (§4.4 da spec).
