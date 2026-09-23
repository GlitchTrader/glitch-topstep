# Plano de ataque — TS-REAUDIT (2026-08-21)

Authority: `docs/ledger/ledger.json` → `reaudit_program_2026_08_20`  
Stop line global: **nenhuma promoção armed com P0 aberto ou sem proof de fault/soak/rollback**.

## Fase 1 — Integridade crítica (P0, PRs individuais)

| Ordem | Item | Issue | Repo | Entregável | Depende de |
|-------|------|-------|------|------------|------------|
| 1.1 | GTHP-REAUDIT-01 | profile #140 | profile | SQLite authority journaling | — |
| 1.2 | **TS-REAUDIT-01** | #184 | gateway | `ProjectXAuthManager` como única sessão REST no `AppService` | TS-AUDIT-06 |
| 1.3 | **TS-REAUDIT-02** | #185 | gateway | Evidence outbox durável antes de fila memória | TS-AUDIT-08 |
| 1.4 | **TS-REAUDIT-03** | #186 | gateway | Predicado terminal flatten inclui `ownWorkingOrders===0` em **todos** os ramos | TS-AUDIT-07 |
| 1.5 | **TS-REAUDIT-04** | #187 | gateway + profile | Contrato `intent delivery status` pareado; Hermes nunca apaga em 404 receipt-only | GTHP-AUDIT-03 |
| 1.6 | **TS-REAUDIT-08** | #191 | gateway | `stopSerial` falha se disposer crítico não termina | TS-REAUDIT-02 |

**Exit gate fase 1:** regressões crash/terminality verdes; ledger items → `done`; issues fechadas.

## Fase 2 — Runtime limitado e safety verdadeiro (P1)

| Item | Issue | Entregável |
|------|-------|------------|
| TS-REAUDIT-05 | #188 | Caches com TTL/LRU; métricas heap |
| TS-REAUDIT-06 | #189 | `unprotected_since_utc` persistente; supervisor vs gates |
| GTHP-REAUDIT-02 | #141 | Journal reads incrementais |

## Fase 3 — Arquitetura e contrato (P1)

| Item | Issue | Entregável |
|------|-------|------------|
| TS-REAUDIT-07 | #190 | Ports + composition root único |
| TS-REAUDIT-09 | #192 | ✅ done (#204/#153) |

## Fase 4 — Qualidade e operações

| Item | Issue | Entregável |
|------|-------|------------|
| TS-REAUDIT-10 | #193 | Fault injection matrix + proof |
| TS-REAUDIT-11 | #194 | SLOs + alertas |
| GTHP-REAUDIT-04 | #143 | CI lint/types/coverage |

## Fase 5 — Release pareado

| Item | Issue | Entregável |
|------|-------|------------|
| GTHP-REAUDIT-03 | #142 | Gate manifest imutável |
| TS-REAUDIT-12 | #195 | Runbook armed/rollback |

## Execução imediata (esta sessão)

1. **Runtime ops:** desabilitar `Hermes_Gateway_*` (duplicata do node `start.ps1`); manter só `GlitchTopstep_Gateway`.
2. **Profile hotfix:** `ensure_model_attempt` — outbox sem attempt não pode explodir em `read_json`.
3. **REAUDIT-03:** corrigir ramo fallback em `flatten-control-saga.ts` + teste `closed` + residual orders.
4. **REAUDIT-01 (início):** branch `reaudit/01-auth-session` — `AppService` usa `ProjectXAuthManager` em vez de `ProjectXApiClient` solto.

## Ritual por PR

```powershell
# gateway
npm run check
# profile (quando aplicável)
python -m unittest discover -s tests
```

Ledger: marcar item `done` + fechar issue só após CI verde e critérios de acceptance do item.
