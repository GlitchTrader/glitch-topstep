# Plano de implementação — Auditoria completa 2026-08-25

**Authority:** `docs/ledger/audits/2026-08-25-complete-architecture-audit.md`  
**Plano anterior:** `docs/plans/2026-08-24-consolidated-audit-implementation-plan.md`  
**Baseline merged:** gateway `07d5aa0` (0.2.2), profile `86db664` (0.2.5, `glitch-topstep-v15`)  
**Pair digest:** `78739f348407f450e677da40d59b4e6939c17fa4959a80d6e154337510cb0a2a`  
**Stop line:** não declarar produção autônoma `armed` com P0 (C1–C4) aberto; não enfraquecer TS-AUTH-02 / TS-DATA-01 / TS-MULTI-04.

> **IDs renumerados:** C1–C4 neste plano são os do audit **2026-08-25**, não os do audit 2026-08-24 (dual-write, TOCTOU, etc. — já entregues em #191–#196 / #234–#239).

---

## 1. O que já fizemos (sessão 2026-08-24/25)

| Entrega | PRs | Cobre (parcial ou total) |
|---------|-----|--------------------------|
| Audit A/B/C gateway | #234, #235 | Response cap, retry-policy módulo, runtime lock identity, shutdown deadline, log sanitize, health alerts |
| Fault-matrix pareado | #236 + profile #195 | `profile_commit`, `test_fault_injection.py`, rollback rehearsal |
| C1 decomposição profile | #192–#195 | `workflows/*`, `parity.py` fino, session_gates, cycle_context |
| Profile durability | #191, #194 | export idempotente, lock atômico, ProcessSupervisor (timeout), pruning referencial |
| Promoção armed + sign-off | #237–#239, profile #196 | TS-REAUDIT-12 `done`, operator_sign_off, PRAC soak 6/6 |

### Gaps confirmados pelo audit 2026-08-25 (ainda abertos)

| ID | Achado | Por que ainda aberto |
|----|--------|----------------------|
| **C1** | Retry em mutações 429 | `retry-policy.ts` existe; `client.ts` ainda retenta POSTs de mutação |
| **C2** | Fila evidências sem bound físico | high-water parcial; `identity` sem limite; compact só após sucesso |
| **C3** | Bootstrap não drena export queue | `export_pending_jsonl` existe; `bootstrap_decisions()` não chama |
| **C4** | Preempção sem tree-kill | `process_supervisor` no timeout; `_request_owner_stand_down` só SIGTERM |
| **W1–W6** | Ver seção 2 | Parcial ou aberto |

---

## 2. O que precisa ser feito

### P0 — bloqueiam veredito “production-ready autônomo”

| ID | Trabalho | Repo | Arquivos |
|----|----------|------|----------|
| **C1** | Mutações `retryable: false`; reconciliar por `customTag`/`providerOrderId` | gateway | `src/projectx/client.ts`, `retry-policy.ts` |
| **C2** | Bound físico fila; compact `superseded` após falha | gateway | `src/projectx/evidence-write-queue.ts` |
| **C3** | `bootstrap_decisions()` → `export_pending_jsonl()` | profile | `scripts/state_store.py`, `workflows/decision_journal.py` |
| **C4** | Preempção via `terminate_process_tree` + confirmação | profile | `scripts/model_owner_lock.py`, `process_supervisor.py` |

### P1 — soak prolongado

| ID | Trabalho | Repo |
|----|----------|------|
| **W1** | Leituras incrementais (SQLite/tail) vs `read_jsonl()` full | profile |
| **W2** | `pruneExpiredPackets()` com refs recovery | gateway |
| **W5** | Métricas prune/export/fsync/fila (não só log) | ambos |

### P2 — manutenibilidade

| ID | Trabalho | Repo |
|----|----------|------|
| **W3** | Decompor `service.ts`, `coordinator.ts`, `run-topstep-cycle.py` | ambos |
| **W4** | Launchers → admissão única via `model-owner.lock` | profile |
| **W6** | Docs: `model-owner.lock`, intent v3; histórico separado | ambos |

### Fault matrix (estender TS-REAUDIT-10)

- 429 pós-aceite em mutação (C1)
- Crash export + bootstrap (C3)
- Preempção Windows (C4)
- SQLite evidence down prolongado (C2)

---

## 3. O que não faz sense

| Item | Decisão |
|------|---------|
| Rollback automático do runtime `armed` só por novo audit | Não — checklist #236–#239 com sign-off válido; C1–C4 são gaps de *autonomia prolongada* |
| Retry cego em mutações (status quo) | Não — risco ordem duplicada |
| Remover cap 64 KB gateway | Não — plano 2026-08-24 |
| TS-MULTI-04 sem prova portfolio | Fora de escopo |
| TS-DATA-01 / TS-AUTH-02 relax | Proibido |
| Supervisor monolítico antes de C4 | YAGNI — corrigir preempção primeiro |
| JSONL-only (inverter SQLite) | Errado — reforçar SQLite como autoridade |
| Reescrever retry-policy | Não — completar wiring C1 |
| Reabrir TS-REAUDIT-12 | Não — estender via TS-REAUDIT-10 |
| Breaking remove intent v2 agora | Adiar — W6 = docs |

---

## 4. Ordem de implantação

```
Wave 0 (P0)     C3 + C4 (profile)  ||  C1 + C2 (gateway)
                      ↓
                Fault matrix extend (S4)
                      ↓
Wave 1 (P1)     W2 (gateway)  ||  W1 + W5 (profile/ambos)
                      ↓
Wave 2 (P2)     W4 → W6 → W3 (contínuo)
                      ↓
Wave 3          Fechar REAUDIT residual no ledger
```

**Paralelo seguro:** C3∥C4; C1∥C2; após Wave 0: W2∥W1.

**Dependências:** fault matrix novos cenários **após** fixes C1–C4; soak 72h+ após Wave 0 + W2 mínimo; bump `paired-contract.json` só se wire mudar.

---

## 5. Etapas por onda

### Wave 0 — P0 integridade

| Task | Repo | Aceite |
|------|------|--------|
| 0.1 C3 bootstrap export | profile | Kill pós-SQLite pré-export → restart → decisão em `decisions.jsonl` |
| 0.2 C4 preempção tree-kill | profile | Windows: preempção mata árvore Hermes; lock só após término confirmado |
| 0.3 C1 mutation no-retry | gateway | `placeOrder`/modify/cancel/close: 429 sem retry; leituras retentam |
| 0.4 C2 fila bounded | gateway | SQLite down: memória estável; métrica `physical_depth` |
| 0.5 Fault matrix | ambos | Cenários C1–C4 no gate; proof JSON atualizado |

**PRs sugeridos:** profile (0.1+0.2), gateway (0.3+0.4), paired fault-matrix (0.5).

### Wave 1 — P1 runtime bounded

| Task | Aceite |
|------|--------|
| 1.1 W2 packet retention | Packets expirados removidos; refs intent/receipt preservados |
| 1.2 W1 incremental reads | Learning 10k decisões: memória bounded |
| 1.3 W5 observabilidade | Falhas prune/export em `/health` ou facts |

### Wave 2 — P2 manutenção

| Task | Aceite |
|------|--------|
| 2.1 W4 launchers | Toda admissão via `model-owner.lock` |
| 2.2 W6 docs | Procedimento atual documentado |
| 2.3 W3 decomposição | 1 vertical por PR; testes equivalentes |

### Wave 3 — Ledger REAUDIT

Fechar: GTHP-REAUDIT-01/02/04, TS-REAUDIT-02/08/10/11 conforme entregas acima.

---

## 6. Pontos de atenção

| Risco | Mitigação |
|-------|-----------|
| C1 + 429 em mutação | Prioridade máxima Wave 0 |
| C2 + SQLite down | Monitorar heap / `physical_depth` |
| C3 pós-crash | Learning cego sem bootstrap export |
| C4 Windows | Testar preempção em CI Windows |
| W2 pruning agressivo | Preservar refs recovery (padrão NT `d2b8e9e`) |

**Paired release:** Wave 0 → release pareado + `profile_commit` no fault-matrix; atualizar ledgers; PRAC soak 6/6 pós-merge.

---

## 7. Requerimentos

| Requisito | Estado |
|-----------|--------|
| `npm run check` + profile unittest | Verde (456 + 304) |
| Fault-matrix gate + profile checkout CI | #236 |
| Credenciais PRAC | Para soak pós-Wave 0 |
| PROD-08 | Nova aprovação `armed-production` após Wave 0 para autonomia prolongada |

### Evidência para fechar Wave 0

- [x] Testes C1–C4 verdes
- [x] `npm run reaudit:fault-matrix` com SHAs atualizados
- [x] Ledgers gateway + profile atualizados
- [x] PRAC preflight 6/6 pós-merge (`docs/evidence/PRAC-SOAK-2026-08-25-post-audit-wave.md`)
- [x] Review operador de C1 (mutação ambígua) (`docs/evidence/C1-OPERATOR-REVIEW-2026-08-25.md`)

---

## Próximo passo imediato

1. **PR profile:** C3 (`bootstrap_decisions` + `export_pending_jsonl`) + C4 (`terminate_process_tree` na preempção)
2. **PR gateway:** C1 (`retryable: false` em mutações) — pode abrir em paralelo
3. Estender fault matrix após merges Wave 0

Análise detalhada: subagent [Analyze new architecture audit](05683611-e993-4fe3-9335-adbcbcf4a10a).
