# Plano de implementação — Stream recovery e liveness (ProjectX SignalR)

**Authority:** evidência operacional 2026-08-26/27 + audit gateway (GPT + logs locais)  
**Baseline merged:** gateway `13ffbf7` (#244 reconnecting limbo), `main`  
**Relacionado:** #244 (in-process `reconnecting`), watchdog (`gateway-watchdog-policy.ts`), audit wave 2026-08-25  
**Stop line:** não relaxar gates de ENTER (`quote_stale`, `state_complete`, TS-DATA-01); não retry cego em mutações; watchdog permanece último recurso — mas não competidor de recovery in-process.

---

## 1. Diagnóstico (consolidado)

O gateway **não está caindo por crash** de processo Node em massa. Ele entra em **flapping degradado**:

1. **Liveness de quote agressivo (15s)** trata “sem quote no MNQ primário” como “Market Hub morto”, mesmo com **depth/trade** contínuos.
2. **Três camadas de recovery** competem: SignalR auto-reconnect → `restartHub()` → watchdog kill processo.
3. **Burst REST** após reconnect (`Promise.all` reconcile + history + observation + order flow).
4. **Retry** só para `ProjectXApiError`; timeouts de `fetch` não retentam reads idempotentes.
5. **Persistência pesada** (~500MB+ evidence, ~510k eventos) amplifica latência de `/health` em degraded.

### Evidência local (`projectx-evidence.sqlite`, 2026-08-27)

| `event_type` | count | nota |
|--------------|-------|------|
| `market_liveness_restart` | ~1489 | principal suspeito |
| `market_restart_failed` | ~714 | cascata após liveness |
| `depth` | ~294k | hub recebe tráfego |
| `market_trade` | ~126k | hub recebe tráfego |
| `quote` | ~86k | menos frequente que depth/trade |
| `user_reconnecting` | ~442 | secundário vs market |

Watchdog: restarts ~cada 6–10 min em storm (EDT evening 2026-08-26).  
Único cliente ProjectX na máquina operador: **node :8790** (verificado 2026-08-26).

### Conformidade API

Hubs `rtc.topstepx.com`, resubscribe após reconnect, sessão 24h / refresh 12h, `customTag` para recovery — **alinhado** com [ProjectX realtime docs](https://gateway.docs.projectx.com/docs/realtime/). O defeito é **política local de recovery**, não wire contract errado.

---

## 2. Princípio de desenho — duas camadas

Não misturar **hub vivo** com **mercado executável**:

| Camada | Campos / sinais | Decide |
|--------|-----------------|--------|
| **hub_liveness** | `quote_recent`, `trade_recent`, `depth_recent`, `any_market_event_recent`, `signalr_connection_state` | `restartHub`, stuck recovery, progresso de recovery |
| **execution_quality** | `quote_recent`, `quote_geometry_valid`, `quote_contract_matches`, `quote_age_ms` | `quote_stale`, `state_complete`, gates ENTER, packet freshness |

**Regra:** depth/trade recente **não** limpa `quote_stale` para cognição; só evita matar o hub.

**Venue truth vs recovery intent:** `VenueStateStore` continua observacional. `HubRecoveryController` (novo) registra intenção, tentativa, owner, `recovery_generation`, deadlines — não substitui estado do venue.

---

## 3. O que não fazer

| Item | Decisão |
|------|---------|
| `GLITCH_STREAM_LIVENESS_MS=60000` em **armed** como “fix” | **Não** — só experimento em shadow/PRAC com checklist e rollback; pode mascarar quote quebrado |
| Usar só `market.lastEventAt` sem qualificação | **Não** — separar hub_liveness vs execution_quality |
| `Promise.all` reconcile + resubscribe | **Não** — pipeline serial (seção 5) |
| Remover watchdog | **Não** — último recurso com progresso + deadline |
| Mega-PR state machine + scheduler | **Não** — PRs incrementais |
| Retry em mutações | **Proibido** (C1 audit) |

---

## 4. Métricas de sucesso

Medir **por sessão** (maintenance vs RTH vs asia) e **por condição** (quote gap com trade/depth ativo).

| Métrica | Baseline (ref.) | Target |
|---------|-----------------|--------|
| `market_liveness_restart` | ~1489 acumulado | ↓ >80% em RTH estável / 24h |
| `market_restart_failed` | correlacionado | **≈0** quando `any_market_event_recent` |
| Watchdog restarts | ~4–6/h em storm | <1/h RTH; por **causa** (tag no log) |
| `/health` p95 em `ok` | 15–25s em degraded | **<500 ms** (health não await ProjectX) |
| `degraded` maintenance | esperado 5–6 PM EDT | separar alert **unexpected_degraded** |
| reconnect → resubscribe | — | p95 < 10s |
| reconnect → reconcile done | — | p95 < 30s |
| REST requests/min | — | sem spike >2× baseline post-reconnect |
| SQLite commit p95 | — | documentar; sem regressão |
| quote gap com depth ativo | — | medir duração; não deve trigger liveness |

**Gate soak 72h PRAC** antes de declarar flap resolvido para autonomia prolongada (PROD-08 residual).

---

## 5. Ordem de PRs

```
PR-A  hub_liveness multi-evento + execution_quality separado + debounce documentado
PR-B  skip restart em reconnecting + recovery_generation + HubRecoveryController (market)
PR-C  retry transporte + deadline global + circuit breaker leve (reads)
PR-D  reconnect serial + reconcile barato (pos/orders only)
PR-E  health recovery fields + watchdog por progresso
      → soak 72h PRAC

PR-F  scheduler global com prioridades
PR-G  reconcile adaptativo + cache accounts/contracts
PR-H  métricas persistência + prune tuning
```

---

## 6. Fase 0 — Baseline (sem mudar comportamento)

| ID | Trabalho | Ganho | Risco |
|----|----------|-------|-------|
| 0.1 | Query `provider_events` por `event_type` / hora | Baseline objetivo | Nenhum (read-only) |
| 0.2 | Correlacionar watchdog.log ↔ lifecycle EDT | Provar cadeia | Nenhum |
| 0.3 | Doc baseline em `docs/evidence/` | Comparar PR-A+ | — |

**Não** aplicar env liveness 60s em armed (ver seção 3).

---

## 7. Fase 1 — P0 (PR-A, PR-B)

### PR-A — Hub liveness + debounce

**Arquivos:** `src/projectx/stream-supervisor.ts`, `src/projectx/realtime.ts`, `src/state/venue-state.ts` (se necessário), `tests/stream-supervisor.test.ts`

**Trabalho:**

1. `hub_liveness`: `any_market_event_recent` = max(quote, trade, depth) no contrato primário (ou todos observados).
2. `execution_quality`: manter/independent `quote_age_ms`, geometry, contract match em data_quality issues.
3. Debounce: 2–3 falhas **consecutivas** no timer liveness (intervalo max 5s).
4. Reset contador em qualquer evento hub válido.
5. Documentar worst-case delay: `livenessMs + (N-1)×5s` (ex.: 15s + 10s ≈ **25–30s** total).

| Ganho | Risco |
|-------|-------|
| Corta ~80% `market_liveness_restart` espúrios | Hub morto sem quote mas com depth bugado — mitigado por stuck 90s + execution_quality |
| Preserva safety ENTER | Testes de semântica dupla |

### PR-B — Recovery controller + generation

**Arquivos:** novo `src/projectx/hub-recovery-controller.ts` (ou `src/observability/`), `realtime.ts`, testes

**Trabalho:**

1. Estados: `connected → suspect → reconnecting → resubscribing → reconciling → recovered | failed`
2. `recovery_generation` incrementa em cada tentativa; callbacks stale ignorados.
3. Não `restartHub` por liveness se `signalr_connection_state === reconnecting` (stuck 90s cobre limbo longo).
4. Deadline absoluto in-process (ex.: 120s) antes de `failed` / escalar.

| Ganho | Risco |
|-------|-------|
| Base para health recovery + watchdog | Refactor médio; começar **market hub only** |

**Aceite PR-A+B:** soak 24h; `market_liveness_restart`/hora ↓; `npm run check` green.

---

## 8. Fase 2 — P1 (PR-C, PR-D, PR-E)

### PR-C — Retry transporte

**Arquivos:** `src/projectx/client.ts`, `src/projectx/retry-policy.ts`, testes

- Normalizar `TimeoutError`, fetch network errors → transitório em **reads idempotentes**.
- Deadline total por operação; max attempts; jitter; circuit breaker leve (reads).
- Limite concorrência REST global.
- `Retry-After` só quando header presente.
- **Nunca** mutações (`isMutationPath`).

| Ganho | Risco |
|-------|-------|
| Reconcile sob blip | Classificação errada — testes por tipo de erro |

### PR-D — Reconnect serial + reconcile barato

**Arquivos:** `src/service.ts`, possivelmente `src/projectx/realtime.ts` (`onReconnected`)

**Ordem rígida:**

```
SignalR connected
  → resubscribe + confirm subscriptions
  → reconcile (positions + orders only)
  → refresh observations (primary first)
  → history sync
```

**Reconcile barato (mesmo PR ou imediato):** accounts/contracts só startup, rollover, intervalo longo (15–30 min); ciclo 3s = positions + orders.

| Ganho | Risco |
|-------|-------|
| Menos REST storm; reconcile após canal vivo | Observation/history stale ~10–30s — packets invalidados até recovered |

### PR-E — Health recovery + watchdog progresso

**Arquivos:** `src/service.ts` (health), `src/observability/gateway-watchdog-policy.ts`, `scripts/gateway-health-watchdog.ps1`, testes

**Novos campos health (v2 extension ou nested):**

- `recovery.active`, `recovery.kind`, `recovery.started_at`
- `recovery.last_progress_at`, `recovery.attempt`, `recovery.deadline_at`

**Watchdog:**

- **Não** kill se `last_progress_at` recente.
- Kill se `active && stale progress && deadline expired`.
- Grace estendido (ex. 5 min) durante recovery com progresso.
- Tag causa no log watchdog.

| Ganho | Risco |
|-------|-------|
| Quebra loop kill durante `restartInFlight` travado | Schema health — documentar; paired contract só se wire público muda |

**Aceite Fase 2:** soak 72h PRAC; critérios seção 4.

---

## 9. Fase 3 — P2 (PR-F, PR-G, PR-H)

### PR-F — Scheduler REST único

Substituir timers independentes (`reconcile 3s`, `order flow 10s`, `observation 60s`, `history 60s`) por fila priorizada:

```
proteção / reconcile crítico
  > ordens / ownership
  > observação (primário)
  > histórico
  > scanner secundário
```

| Ganho | Risco |
|-------|-------|
| Previsibilidade; menos herd | Refactor `service.ts` grande; starvation se prioridade errada |

### PR-G — Reconcile adaptativo

- 3s quando positioned / recovery / streams unhealthy.
- 5–10s quando flat + streams healthy.
- Cache accounts/contracts (complementa PR-D).

### PR-H — Persistência

- Métricas: commit latency, queue depth, busy.
- Confirmar prune sob carga (`GLITCH_PROVIDER_MARKET_EVENT_RETENTION`).
- Opcional: backpressure evidence market sem bloquear handler SignalR (identity events sempre duráveis).

---

## 10. Matriz ganho × risco (resumo)

| ID | Ganho | Risco | Prioridade |
|----|-------|-------|------------|
| PR-A | Alto — corta flap | Divergência hub vivo vs quote stale | **P0** |
| PR-B | Alto — base recovery | Refactor | **P0** |
| PR-C | Médio — REST blip | Classificação retry | P1 |
| PR-D | Médio — burst REST | Stale observation breve | P1 |
| PR-E | Alto — loop watchdog | Health schema | P1 |
| PR-F | Médio sustentado | Big bang | P2 |
| PR-G | Médio — menos REST idle | Metadata stale | P2 |
| PR-H | Médio sob carga | Perda evidence se mal feito | P2 |

---

## 11. Riscos transversais

| Risco | Mitigação |
|-------|-----------|
| Hub “vivo” mas quote stale prolongado | Mais NOTHING, menos ENTER — **desejado**; não relaxar gates |
| Recovery serial lenta | `invalidateAll` até `recovered`; documentar em OPERATIONS |
| Health lento só em degraded | Separar `health_build_ms`; target 500ms só em `ok` |
| Circuit breaker pausa reads | Expor em health/supervisor; auto-clear |
| Maintenance 5–6 PM EDT | `unexpected_degraded` vs `expected_maintenance` em alertas |

---

## 12. Evidência para fechar

- [ ] PR-A+B merged; soak 24h métricas
- [ ] PR-C–E merged; soak 72h PRAC
- [ ] `docs/evidence/STREAM-RECOVERY-SOAK-2026-08-*.md`
- [ ] Ledgers atualizados; `npm run check` + fault matrix green
- [ ] OPERATIONS: recovery layers, maintenance EDT, critérios watchdog

---

## 13. Próximo passo imediato

1. **PR-A** — hub_liveness vs execution_quality + debounce (menor diff, maior ROI).
2. Baseline query 0.1 se ainda não capturado em evidence doc.
3. **Não** alterar `GLITCH_STREAM_LIVENESS_MS` em armed sem experimento formal.

---

## Referências

- [ProjectX Realtime](https://gateway.docs.projectx.com/docs/realtime/)
- [ProjectX Rate limits](https://gateway.docs.projectx.com/docs/getting-started/rate-limits)
- [Validate Session](https://gateway.docs.projectx.com/docs/getting-started/validate-session/)
- `src/projectx/stream-supervisor.ts`, `src/projectx/realtime.ts`
- `src/observability/gateway-watchdog-policy.ts`
- `docs/OPERATIONS.md` (watchdog, maintenance window)
- PR #244 — reconnecting limbo (in-process; não substitui este plano)
