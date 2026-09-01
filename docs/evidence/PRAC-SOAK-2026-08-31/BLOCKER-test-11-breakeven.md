# BLOCKER — Teste 11 breakeven automático

**Data:** 2026-09-01 UTC  
**Conta:** PRAC 26919346  
**Evidência:** `test-11-breakeven.json`

## O que passou

- Entrada protegida 1 MNQ confirmada (`intent_id` `52bf0013…`, order `3471593554`)
- `daily_capture_locked=true` após seed `trade-outcomes` ($800, `exit_utc=2027-03-04T12:00:00Z`) + restart
- Flatten cleanup concluído (`control_status=completed`)

## O que falhou

- Stop não moveu: `pre_stop_price=29458.0`, `post_stop_price=29458.0`
- Nenhum evento `capture_lock_stop_tightened` em `data/events.jsonl`
- Critério AUTO_BREAKEVEN tighten-only não demonstrado live

## Hipótese

`onDailyCaptureLatched` → `tightenOwnedStopsAfterCaptureLock()` corre no primeiro packet após latch; se proteção ainda não está `proven` nesse instante, tighten retorna 0 e não há retry automático até próximo latch (já durável).

## Fix produto (2026-09-01)

Implementado `maybeRetightenStopsAfterCaptureLock()` em `src/service.ts`: após cada reconciliação bem-sucedida, se `daily_capture_locked` durável e posição aberta, re-invoca `tightenOwnedStopsAfterCaptureLock()` (idempotente).

**Retry PRAC:** rebuild (`npm run build`) + `python scripts/prac-directed-test-11-minimal.py` com gateway `ok`/`state_complete=true` (evitar `account_state_stale`).

## Próximo passo (operador / engenharia)

1. **Retry PRAC:** posição aberta + proteção `confirmed` estável ≥30s → seed economics → restart → aguardar 60s → verificar stop/events; ou
2. ~~**Fix produto:** re-invocar tighten idempotente quando proteção transiciona para `proven` com `daily_capture_locked` já latched.~~ **Feito** — ver acima.

## Estado venue

- Flat confirmado após cleanup do teste
