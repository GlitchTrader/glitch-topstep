# Plano de ataque — REAUDIT P0 + P1 (2026-08-21)

Authority: `docs/ledger/ledger.json` + profile `docs/ledger/ledger.json`  
Baseline merged: gateway **#210** (`a346ced`), profile **#163** (`097808b`)  
Stop line: **nenhuma promoção armed** com P0 aberto ou sem proof fault/soak/rollback.

Wave 1 (#210/#163) entregou incrementos parciais — ver `reconciliation.reaudit_wave_1` nos ledgers. Este plano cobre **o que falta** para fechar acceptance de cada P0/P1.

---

## Ordem de implementação (global)

Cada linha = **1 PR individual** (gateway ou profile), CI verde, ledger `implementation_note` atualizado. Issues só fecham quando acceptance completo.

| # | Ordem | Item | Repo | Pri | Depende de | Entregável (fechar acceptance) |
|---|-------|------|------|-----|------------|--------------------------------|
| 1 | 1.1 | **TS-REAUDIT-02** | gateway | P0 | — | Tabela `evidence_outbox` pending/applied; persist-before-enqueue; shutdown bloqueia com backlog; kill/ENOSPC/restart matrix |
| 2 | 1.2 | **TS-REAUDIT-08** | gateway | P0 | 02 | Classificar disposers críticos; `failed_shutdown` + lock retention; testes AppService com evidence backlog e disposer fault |
| 3 | 1.3 | **TS-REAUDIT-01** | gateway | P0 | — | Expiry margin + auth gate de nova exposição; prova de consumidor único; teste 100× concurrent refresh |
| 4 | 1.4 | **TS-REAUDIT-03** | gateway | P0 | — | Matriz completa receipt×venue; restart fixtures em `flatten-workflow.test.ts`; fases persistidas |
| 5 | 1.5 | **GTHP-REAUDIT-01** | profile | P0 | — | Transação SQLite única (decision + export cursor); kill injection dual-write; migration report |
| 6 | 1.6 | **TS-REAUDIT-04** | gateway + profile | P0 | 01,05 | Fixtures pareadas CI; retention generation; testes crash registered/inflight/ambiguous |
| 7 | 1.7 | **GTHP-AUDIT-03** | profile | P1→P0 path | 01,04 | Outbox fsync + estados explícitos; alinhar com delivery status (não descartar em 404) |
| 8 | 2.1 | **TS-REAUDIT-05** | gateway | P1 | 02 | LRU/TTL em `provider-event-recorder`; métricas cache; soak multi-dia heap slope |
| 9 | 2.2 | **TS-REAUDIT-06** | gateway | P1 | 01,03 | Supervisor vs gates parity shadow; `unprotected_since` como gate authority gradual |
| 10 | 2.3 | **GTHP-REAUDIT-02** | profile | P1 | 01 | Learning/calibration leem SQLite ou tail incremental; rotation default-off + métricas |
| 11 | 2.4 | **GTHP-AUDIT-02** | profile | P1 | 01 | Rotação JSONL + tail bounded em todos os readers |
| 12 | 3.1 | **TS-REAUDIT-07** | gateway | P1 | 01,03,04 | Ports AuthenticatedProjectX, FlattenSaga, EvidenceOutbox, OutcomeProjection; composition test |
| 13 | 3.2 | **GTHP-AUDIT-04** | profile | P1 | — | Workflows extraídos (DecisionJournal, DeliveryRecovery); reduzir `parity.py` monólito |
| 14 | 3.3 | **GTHP-AUDIT-01** | profile | P0 | 01 | Fechar sync pós-bootstrap (overlap com REAUDIT-01 — fechar junto ou absorver) |
| 15 | 4.1 | **TS-REAUDIT-10** | gateway + profile | P0 | 01–04,08 | Fault matrix CI gate + proof JSON com SHAs em release manifest |
| 16 | 4.2 | **GTHP-REAUDIT-04** | profile | P1 | 01,02,10 | Ruff + Pyright ratchet; branch coverage; mutation 404-discard |
| 17 | 4.3 | **TS-REAUDIT-11** | gateway | P1 | 06,08 | Alertas acionáveis (health thresholds + hysteresis); não só doc |
| 18 | 4.4 | **GTHP-AUDIT-06** | profile | P1 | 01,03 | Paired regression gates (overlap REAUDIT-04/10) |
| 19 | 4.5 | **GTHP-AUDIT-05** | profile | P1 | gateway TS-AUDIT-10 | Docs/operator v3 authority — verificar se já coberto por paired v11 |
| 20 | 5.1 | **GTHP-REAUDIT-03** | profile + gateway | P0 | 09,12 | Manifest assinado byte-identical; validador em ambos release workflows |
| 21 | 5.2 | **TS-REAUDIT-12** | gateway + profile | P0 | 10,11,03 | Rollback rehearsal automatizado; armed runbook + proof no manifest |

**Fora do escopo REAUDIT (decisão operador):** TS-MULTI-04 (#126).

---

## Fases resumidas

### Fase 1 — Integridade crítica (P0)
**Exit:** zero regressões crash/terminality; issues #184–#187, #191, #140 fechadas.

Ordem: **02 → 08 → 01 → 03 → GTHP-01 → 04 → GTHP-AUDIT-03**

### Fase 2 — Runtime bounded + safety verdadeiro (P1)
**Exit:** heap/disk estáveis; supervisor/gate zero divergência inexplicada em soak.

Ordem: **05 → 06 → GTHP-02 → GTHP-AUDIT-02**

### Fase 3 — Arquitetura (P1)
**Exit:** um binding produção por port; scripts profile decompostos.

Ordem: **07 → GTHP-AUDIT-04 → GTHP-AUDIT-01 (residual)**

### Fase 4 — Qualidade e operações (P0/P1)
**Exit:** fault matrix + CI gates + SLOs operacionais.

Ordem: **10 → GTHP-04 → 11 → GTHP-AUDIT-06 → GTHP-AUDIT-05**

### Fase 5 — Release pareado (P0)
**Exit:** rollback ensaiado; manifest imutável; armed com human approval.

Ordem: **GTHP-03 → 12**

---

## Wave 1 already merged — residual por item

| Item | Merged (#210/#163) | Ainda falta |
|------|-------------------|-------------|
| TS-REAUDIT-01 | AppService → AuthManager; apiClient() | expiry margin, exposure gate, integration tests |
| TS-REAUDIT-02 | evidence close não engolido | outbox table, persist-before-enqueue, kill matrix |
| TS-REAUDIT-03 | saga `ownWorkingOrders`; table tests | restart paths, full receipt matrix |
| TS-REAUDIT-04 | GET /intent/status; profile retain 404 | paired fixtures, retention tests |
| TS-REAUDIT-05 | outcome hot cache; rearm clear on flat | provider hash bound, soak |
| TS-REAUDIT-06 | unprotected_since_utc persistente | supervisor authority, soak parity |
| TS-REAUDIT-07 | IntentDeliveryStatus port | demais ports + composition tests |
| TS-REAUDIT-08 | stopSerial + dispose failed | classificação crítico/best-effort; AppService tests |
| TS-REAUDIT-09 | ✅ done | — |
| TS-REAUDIT-10 | regression matrix file | fault injection proof CI |
| TS-REAUDIT-11 | SLO doc OPERATIONS | alertas acionáveis |
| TS-REAUDIT-12 | runbook doc OPERATIONS | manifest validator + rehearsal |
| GTHP-REAUDIT-01 | sync_meta cursor; ensure_model_attempt | atomic txn, kill injection |
| GTHP-REAUDIT-02 | — | incremental reads, rotation |
| GTHP-REAUDIT-03 | gateway_commit required | pair manifest signed, gateway validator |
| GTHP-REAUDIT-04 | — | ruff/pyright/coverage/mutation |

---

## Ritual por PR

```powershell
# gateway
npm run check

# profile
python -m unittest discover -s tests
python scripts/regenerate_sha256sums.py
```

Ledger: `implementation_note` + `pull_request`; issue → `done` só após acceptance completo.
