# Testes PRAC dirigidos — PRAC-SOAK-2026-08-31

**Par fixado:** gateway `f2de2ec` (#253) + profile `a35e5b5` (#207)  
**Prompt:** `glitch-topstep-v17.1`  
**Instrumento:** MNQ / `CON.F.US.MNQ.U26`  
**Modo:** `armed` (supervisionado — não unattended)

Registrar em cada teste: horário UTC, estado inicial, ação, esperado, observado, evidência (JSON/screenshot/log).

| # | Teste | Status | Operador | Evidência |
|---|-------|--------|----------|-----------|
| 1 | Entrada protegida | **PASS** (3 MNQ — cap 3) | agent + operador | `test-01-entry-protected.json` |
| 2 | Partial close | **PASS** (retry pós-fix; falha anterior documentada) | agent + operador | `test-02-partial-close-retry.json`, `test-02-partial-close.json` |
| 3 | Alteração durante `status:8` | **PASS** (MARKET — janela não capturada live) | agent + operador | `test-03-status8.json` |
| 4 | Cancelamento manual OCO | **PASS** (SL pré-baseline + TP iter 16) | agent + operador | `test-04-manual-oco-cancel.json` |
| 5 | Perda/recuperação SignalR | **PASS** (acceptance stream gap) | agent + operador | `test-05-signalr-recovery.json` |
| 6 | Restart durante alocação bracket | **PASS** | agent | `test-06-restart-bracket.json` |
| 7 | Restart pós-registro intent, pré-receipt | **PASS** | agent | `test-07-intent-delivery.json` |
| 8 | Timeout mutation + reconciliação | **PASS** | agent | `test-08-timeout-mutation.json` |
| 9 | Flatten com ordens próprias working | **PASS** | agent | `test-09-flatten-working-orders.json` |
| 10 | Daily capture com posição aberta | **PASS** | agent | `test-10-daily-capture.json` |
| 11 | Breakeven automático sem intent | **PASS** | agent | `test-11-breakeven.json` |

## Critério para iniciar soak

Só após **11/11 aprovados**, flat confirmado, zero receipt ambíguo, fault matrix verde, operador identificado.

## Notas por teste

### Teste 1 — Entrada protegida
- [x] Flat confirmado no ProjectX e no gateway
- [x] Intent emitida (qty **3** — pedido 5 bloqueado por `GLITCH_MAX_CONTRACTS=3`)
- [x] Receipt + ordem venue + SL/TP nativos (`3469609013/14/15`)
- [x] `protection_status: confirmed` com preços não-nulos (`SL 29407.75`, `TP 29457.75`)

### Teste 2 — Partial close
- [x] Posição protegida qty 3 antes do teste (retry `65a4b5bc…`)
- [x] Partial EXIT qty 1 emitido (`f9294ebc…`, order `3469707621`)
- [x] Gateway reportou posição **2** após submit
- [x] Receipt terminal — **PASS:** `partial_exit_reconciled_pending_protection` / `submitted`
- [x] Proteção sobrevivente — **PASS:** `protection_status: confirmed`, `unprotected_open_quantity: 0`
- [x] Saga — **PASS:** `active_state: null` (terminal)
- [ ] Tranche attribution — stale Aug-26 ainda visível no packet; proteção confirmada mesmo assim (follow-up §4.4)
- [x] Falha anterior — `test-02-partial-close.json` + flatten `test-02-flatten-recovery.json`

### Teste 3 — `status:8`
- [x] Entrada 3 MNQ + bracket nativo (`ba8be6a5…`, orders `3470509441/42/43`)
- [x] Nenhum snapshot com `confirmed` e preço null — **PASS**
- [x] Estado final `confirmed` com SL/TP priced (`29475` / `29525`) — **PASS**
- [ ] MOVE_STOP durante `status:8` — **não observado** (entrada MARKET; 1º poll já `proven`; ver `tests/protection.test.ts`)

### Teste 4 — Cancel manual OCO
- [x] Gateway detecta proteção incompleta — **PASS:** `protection_status: pending`, `stop_child_not_observed` no baseline; ambas pernas ausentes no final
- [x] `unprotected_open_quantity: 3` + alerta critical no `/health`
- [x] Nova entrada bloqueada — **PASS:** `maximum_additional_contracts: 0`, ENTER qty 1 rejeitado
- [x] EXIT disponível — **PASS:** `supported_actions` inclui `EXIT`
- [x] Cancel operador observado — SL antes do baseline; TP removido em poll iter 16 (`23:40:32Z`, working_orders 1→0)

### Teste 5 — SignalR
- [x] Transições `connected → reconnecting → connected` (market hub) — **PASS**
- [x] `operational_generation` incrementou (1→2) — **PASS**
- [x] Recuperação em ~16s (< 30s) — **PASS** (amostra única; p95 formal = soak)
- [x] Gap: `state_complete=false`, packet não resolvível durante gap — **PASS**
- [ ] Desconexão SignalR física real — não exercitada (endpoint supervisionado `force-stream-gap`)

### Teste 6 — Restart alocação bracket
- [x] Sem duplicate entry
- [x] Estado classificado (concluído/pendente/ambíguo)

### Teste 7 — Intent delivery
- [x] `/intent/status` ≠ `not_seen` após restart
- [x] Profile não descarta por 404 legacy (delivery 200)

### Teste 8 — Timeout mutation
- [x] Sem retry cego; fail-closed para nova exposição

### Teste 9 — Flatten
- [x] `completed` só com flat + zero own working orders

### Teste 10 — Daily capture
- [x] Nova entrada bloqueada; EXIT/redução disponível

### Teste 11 — Breakeven automático
- [x] `daily_capture_locked` após seed economics + restart com posição aberta
- [x] `capture_lock_stop_tightened` — stop 29180.75→29200.75 (`intent` `788bde75…`); tighten-only; sem intent Hermes
- [x] Fixes aplicados: `clampCaptureLockBreakevenStop`, `maybeRetightenStopsAfterCaptureLock`, cleanup seeds PRAC
