# Plano de implementação — Auditoria consolidada 2026-08-24

**Authority:** `docs/ledger/audits/2026-08-24-consolidated-architecture-audit.md`  
**Baseline merged:** gateway `197cbe1`, profile `51126c1` (commits auditados)  
**Plano anterior:** `docs/plans/2026-08-21-reaudit-p0-p1-attack-plan.md`  
**Stop line:** nenhuma promoção `armed` com P0 aberto ou sem proof fault/soak/rollback.

---

## 1. Leitura executiva — o que faz sentido

A auditoria está correta no diagnóstico geral: a base é sólida (contratos pareados, intents, proteção, reconciliação, testes), mas **integridade operacional pós-crash** ainda impede promoção `armed`.

### Validado e acionável

| Achado | Veredito | Motivo |
|--------|----------|--------|
| **C1** Dual-write SQLite/JSONL | ✅ Real, P0 | Janela entre append JSONL e dequeue SQLite; cursor pode pular linha parcial |
| **C2** Locks TOCTOU / PID-only | ✅ Real, P0 | Perfil: check-then-unlink; gateway: `process.kill(pid, 0)` sem identidade de boot |
| **C3** Timeout Hermes sem kill-tree | ✅ Real, P0 | `subprocess.run(timeout=...)` libera lock antes de confirmar término da árvore |
| **C4** Múltiplas fontes de estado | ✅ Real, P0 (arquitetural) | Consequência de C1; SQLite deve ser autoridade, JSONL projeção |
| **W1** `read_jsonl()` O(N) | ✅ Real, P1 | Usado em learning, parity, reconciliação — escala mal em soak |
| **W2** Reescrita completa JSONL | ✅ Real, P1 | `upsert_unique`, `reconcile_corrected_episodes` — risco de perda/reordenação |
| **W4** `frame_for_packet_id` linear | ✅ Real, P1 | Lookup O(arquivos) no outbox |
| **W5** Pruning sem refs | ✅ Real, P1 | NT `d2b8e9e` já corrigiu; Topstep ainda pode apagar frame referenciado |
| **W6** Pruning JSONL não-atômico | ✅ Real, P1 | `write_text` direto |
| **W7** ProjectX sem limite de resposta | ✅ Real, P1 | `response.text()` em `client.ts:295` |
| **W9** Shutdown HTTP sem deadline | ✅ Real, P1 | `server.close()` aguarda requests presos |
| **W3, W8, W10** | ✅ Real, P2 | Decomposição, retry policy, sanitização — importantes, não bloqueiam armed |

### Já endereçado parcialmente (não repetir do zero)

Trail A (#220 gateway / #175 profile) já entregou incrementos que **reduzem** mas **não fecham** acceptance:

- `C7_export_idempotent`: fila SQLite com `INSERT OR IGNORE` — falta sequência monotônica no payload exportado + verificação antes de re-exportar + cursor só em linha completa.
- `C1_model_owner_preempt`: SIGTERM + grace + generation fencing — falta compare-and-delete atômico e identidade completa (process start, invocation ID).
- Fault matrix scaffold (#223): `tests/reaudit-fault-matrix.test.ts` — falta injeção kill durante export/lock/delivery e proof no manifest.

### Não fazer / já coberto

| Recomendação da auditoria | Decisão |
|---------------------------|---------|
| Remover limite 64 KB do gateway | **Não.** Manter; eventual bump configurável (256 KB) só com métrica `payload_too_large` |
| Copiar `fit_debrief_evidence` do Hermes NT | **Não.** Já incorporado em `run-topstep-learning.py` |
| Importar blocos `catch {}` silenciosos do NT pruning | **Não.** Falhas devem virar evento operacional + métrica |
| TS-MULTI-04 multi-exposição | **Fora de escopo** (decisão operador) |

---

## 2. Mapeamento achados → ledger existente

| Achado audit | Ledger / issue | Status |
|--------------|----------------|--------|
| C1, C4, W2 | `GTHP-REAUDIT-01`, `GTHP-AUDIT-01` | partial_merged |
| C2 (profile) | `GTHP-REAUDIT-01`, trail A `C1_model_owner_preempt` | partial_merged |
| C2 (gateway) | `TS-REAUDIT-08` (shutdown/lock retention) | partial_merged |
| C3 | **Novo:** `GTHP-RUNTIME-02` (ProcessSupervisor) | open |
| C4 (delivery/outbox) | `GTHP-AUDIT-03`, `TS-REAUDIT-04` | partial_merged |
| W1, W2 | `GTHP-REAUDIT-02`, `GTHP-AUDIT-02` | open |
| W3 | `GTHP-AUDIT-04` | open |
| W4 | **Novo:** `GTHP-DATA-02` (frame index) | open |
| W5, W6 | **Novo:** `GTHP-RETENTION-01` (referential + atomic prune) | open |
| W7 | **Novo:** `TS-DATA-02` (ProjectX response cap) | open |
| W8 | P2 — alinhar com `TS-REAUDIT-01` auth facade | partial |
| W9 | `TS-REAUDIT-08` | partial_merged |
| W10 | P2 — `TS-OBS-02` log sanitization | open |
| Fault injection proof | `TS-REAUDIT-10`, `TS-REAUDIT-12` | partial_merged |

---

## 3. Princípios de solução (transversais)

1. **SQLite = autoridade operacional.** JSONL, frames em disco e receipts são projeções ou artefatos de evidência — nunca fonte primária mutável.
2. **Export idempotente.** Todo registro exportado carrega `export_sequence`; re-export verifica existência antes de append; dequeue só após append confirmado.
3. **Locks com identidade, não só PID.** Proprietário = `{ pid, process_start_utc, invocation_id, generation, acquired_utc }`; remoção só com compare-and-swap (rename `.stale` → unlink) ou lease SQLite.
4. **Ownership só libera após `wait()` confirmado.** Supervisor único para cycle, learning e repair; `start_new_session=True`; `terminate_process_tree` no timeout.
5. **Pruning referencial.** Coletar IDs de outbox, receipts, delivery-wire antes de remover frames; cadência ≤1/h; métricas preserved/removed/failed.
6. **Bounded I/O everywhere.** Resposta ProjectX ≤4 MB stream; corpo gateway 64 KB (configurável); leituras JSONL via tail/cursor/SQLite.
7. **Falhas visíveis.** Sem swallow silencioso; evento operacional + métrica; trading continua quando seguro.

---

## 4. Ondas de implementação

Cada linha = **1 PR** (gateway ou profile), CI verde, ledger atualizado. Issues fecham só com acceptance completo.

### Onda A — P0 integridade (bloqueia armed)

**Exit:** zero duplicidade de decisão, zero ambiguidade de ownership, recovery determinístico após kill.

| # | Item | Repo | Entregável | Testes de acceptance |
|---|------|------|------------|----------------------|
| A1 | **C1 export idempotente** | profile | `export_pending_jsonl()` com `export_sequence` no payload; check `jsonl_contains_sequence`; cursor avança só até última linha `\n`-terminada | Kill entre append e DELETE; restart → 0 duplicatas |
| A2 | **C1 cursor parcial** | profile | `read_jsonl_incremental()` não avança offset além de linha completa | Fixture com linha truncada → linha recuperada no próximo read |
| A3 | **C2 lock atômico profile** | profile | `remove_stale_lock(expected)` compare-and-rename; owner record completo | Dois processos concorrentes → exatamente um dono; steal não remove lock do novo dono |
| A4 | **C2 runtime lock gateway** | gateway | Adicionar `process_start_utc` ou inode+start time; stale só se identidade não bate | PID reuse simulado → lock não removido erroneamente |
| A5 | **C3 ProcessSupervisor** | profile | Módulo `process_supervisor.py`; usado por cycle, learning, repair; tree kill + stdout/stderr cap | Timeout → processo morto confirmado antes de lock release |
| A6 | **C4 delivery + outbox** | profile + gateway | Alinhar `GTHP-AUDIT-03` + `TS-REAUDIT-04`: estados explícitos; 404 ≠ safe delete se outbox pending | Crash registered/inflight/ambiguous matrix |
| A7 | **Fault matrix CI** | gateway + profile | Estender `reaudit-fault-matrix.test.ts`: export crash, lock steal, delivery ambiguous; proof JSON com SHAs no manifest | `npm run reaudit:fault-matrix` verde em CI release |

**Ordem:** A1 → A2 → A3 → A5 → A4 → A6 → A7  
(A3/A5 profile antes de A4 gateway — ownership profile é mais crítico para intents.)

### Onda B — P1 runtime bounded (bloqueia soak prolongado)

**Exit:** heap/disco estáveis 72h+; latência learning previsível; pruning seguro.

| # | Item | Repo | Entregável | Testes de acceptance |
|---|------|------|------------|----------------------|
| B1 | **W5 referential pruning** | profile | Portar lógica NT `d2b8e9e`: scan outbox/receipts/delivery-wire; preserve referenced; cadência 1/h | Frame referenciado >72h não removido |
| B2 | **W6 atomic JSONL prune** | profile | temp + fsync + replace em `prune_jsonl_by_age` | Kill durante prune → arquivo íntegro ou backup |
| B3 | **W4 frame index** | profile | Tabela SQLite `frame_index(packet_id, path)` ou nome de arquivo = packet_id | Lookup O(1) vs scan de diretório |
| B4 | **W1/W2 incremental reads** | profile | Learning/parity usam SQLite ou `tail_jsonl(n)`; deprecar `read_jsonl` full-file nos hot paths | Learning com 10k rows: memória bounded |
| B5 | **W7 ProjectX response cap** | gateway | Stream read ≤4 MB; cancel + `response_too_large` | Mock 5 MB → erro limpo, sem OOM |
| B6 | **W9 shutdown deadline** | gateway | Track conexões ativas; `stop()` com timeout 30s; destroy stuck | Request longa → shutdown completa ≤ deadline |
| B7 | **Métricas operacionais** | gateway + profile | heap, disk, export backlog, prune preserved/removed, learning batch trimmed | Expostas em `/health` ou facts JSONL |

**Ordem:** B1 → B2 → B3 → B4 → B5 → B6 → B7

### Onda C — P2 arquitetura e operabilidade

**Exit:** scripts decompostos; retry/sanitize centralizados; SLOs acionáveis.

| # | Item | Repo | Entregável |
|---|------|------|------------|
| C1 | **W3 decomposição learning** | profile | Extrair `DecisionJournal`, `DeliveryOutbox`, `OutcomeProjection`, `LearningEvidence`, `HermesInvoker` |
| C2 | **W8 retry policy** | gateway | Classe por operação: read retry+jitter; mutation reconcile-only; auth revalidate |
| C3 | **W10 log sanitization** | gateway + profile | Filtro central: tokens, Authorization, URLs sensíveis |
| C4 | **TS-REAUDIT-11 alertas** | gateway | Thresholds + hysteresis em health (não só doc) |
| C5 | **TS-REAUDIT-12 rollback rehearsal** | gateway + profile | Manifest assinado + ensaio automatizado |

**Ordem:** C1 paralelo a C2/C3; C4/C5 após Onda A completa.

---

## 5. Detalhe de solução por achado crítico

### C1 — Dual-write SQLite/JSONL

**Problema:** write JSONL → crash → row ainda na fila → re-export duplica.

**Solução mínima (lazy senior):**

```python
# state_store.py — padrão idempotente
for row in pending_rows:
    if jsonl_contains_sequence(path, row["sequence"]):
        delete_queue_row(row["sequence"])  # já exportado
        continue
    append_jsonl(path, {**payload, "export_sequence": row["sequence"]})
    delete_queue_row(row["sequence"])  # uma row por transação sqlite
```

**Cursor parcial:** ao ler incremental, split por `\n`; só persistir offset após última linha completa.

**Não fazer:** migrar tudo para JSONL-only ou remover SQLite — SQLite já é o índice; reforçar autoridade.

### C2 — Locks

**Profile:** substituir check+unlink por `path.replace(stale_path)` condicionado a owner match byte-a-byte.

**Gateway:** `RuntimeScopeLock` já usa `wx` (bom); enriquecer payload com identidade de processo além de PID.

**Ideal (se TOCTOU persistir):** `msvcrt.locking` (Windows) ou lease SQLite com TTL + heartbeat.

### C3 — ProcessSupervisor

**Um módulo, três callers:** `run-topstep-cycle.py`, `run-topstep-learning.py`, repair scripts.

```python
with ProcessSupervisor(timeout=...) as sup:
    result = sup.run(command, input=prompt)
# lock released only after sup.confirmed_dead
```

`start_new_session=True` + `os.killpg` / `taskkill /T` no Windows.

### C4 — Estado fragmentado

**Curto prazo:** fechar A1–A6 (export + outbox + delivery status).

**Médio prazo (Onda C):** correções append-only no SQLite; JSONL materializado por job de export, nunca editado in-place.

---

## 6. Incorporação Glitch NT (`d2b8e9e`)

Portar para `prune_state_retention.py`:

1. Coletar `packet_id` de `outbox/`, `receipts/`, `delivery-wire/`.
2. Union com janela 72h (configurável, mínimo 24h).
3. Prune no máximo 1×/hora; registrar métricas.
4. Executar fora do hot path (timer/cron, não inline no cycle).
5. **Melhorar vs NT:** log structured + contador, nunca `catch {}` vazio.

---

## 7. Gate de promoção armed

Todas as condições abaixo devem ser verdadeiras:

- [ ] Onda A (A1–A7) merged; issues `GTHP-REAUDIT-01`, `TS-REAUDIT-04`, `TS-REAUDIT-08`, `TS-REAUDIT-10` fechadas
- [ ] `npm run reaudit:fault-matrix` no pipeline de release
- [ ] PRAC soak executado (`scripts/prac-soak-checklist.ps1`) com evidence ref
- [ ] Onda B1–B3 merged (pruning + frame index) — mínimo para operação 72h
- [ ] Manifest pareado assinado (`GTHP-REAUDIT-03` / `TS-REAUDIT-12`)
- [ ] Human approval gate (PROD-08)

**Não requerido para armed (mas antes de produção contínua):** Onda B4–B7 completa, Onda C.

---

## 8. Ritual por PR

```powershell
# gateway
npm run check
npm run reaudit:fault-matrix   # quando tocar fault/recovery

# profile (checkout glitch-topstep-hermes-profile)
python -m unittest discover -s tests
python scripts/regenerate_sha256sums.py
```

Ledger: atualizar `implementation_note`, `pull_request`, status do item; issue → `done` só após acceptance.

---

## 9. Estimativa de esforço (ordem de grandeza)

| Onda | PRs | Risco | Esforço |
|------|-----|-------|---------|
| A (P0) | 7 | Alto — touch recovery path | 2–3 semanas |
| B (P1) | 7 | Médio — performance/IO | 2 semanas |
| C (P2) | 5 | Baixo — refactor | contínuo pós-armed shadow |

---

## 10. Próximo passo imediato

Abrir **PR profile A1+A2** (`GTHP-REAUDIT-01` residual): export idempotente com `export_sequence` + cursor seguro. É o menor diff com maior redução de risco C1/C4 e desbloqueia fault-injection A7.

Em paralelo, esboçar **A5 ProcessSupervisor** — C3 é o único P0 sem issue ledger dedicada hoje.
