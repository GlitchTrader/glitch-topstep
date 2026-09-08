# v8 bar-close-aware stability — STOP (2026-09-08)

**Gateway SHA:** `3111e0b` (fix/bar-wait-alignment-v8 local)  
**Profile SHA:** `c0a2b55` + follow-up roll-detection fix (local)  
**Merge #268:** `61b925b` on origin/main  
**PRAC/soak:** **BLOQUEADOS** — bar-wait FAIL, STOP sem retry

## Veredito

| Critério | Resultado |
|----------|-----------|
| bar-wait (300s) | **FAIL** — `bar_still_partial` após 301.09s |
| Janela stability | **NÃO iniciada** |
| 5 fechamentos válidos | **0/5** |

## Causa (v8 polls)

O fix clock-aligned funcionou parcialmente — `polls` agora registram timestamps reais — mas a lógica de **janela pós-close de 5s** não cobre a latência do provider:

| Evento | Timestamp observado |
|--------|---------------------|
| `expected_close` | `:00` de cada minuto |
| Roll `latest_bar_utc` | **~`:08`** após o minuto (ex.: 19:12:08, 19:13:08) |
| `post_close_window` | 5s (`:00`–`:05`) |

**Efeito:** `is_post_close_sample` nunca é verdadeiro no feed live — quando o pacote finalmente rola, já passamos de `window_end`. O loop `now > window_end → sleep next_close` repetia por 5 ciclos até timeout.

Exemplo (poll 157→158):
- `19:12:07` — `latest_bar_utc=19:11:00` (bar antigo)
- `19:12:08` — `latest_bar_utc=19:12:00` (roll 8s tarde)

## Health vs packet

- `status=ok`, `state_complete=true` em ambos — **sem divergência**
- Bloqueio exclusivamente na lógica bar-wait / latência de roll

## Correção adicional (local, não re-executada)

- `_bar_roll_confirmed()` — detecta avanço de `prior_completed_bar_utc` ou `latest_bar_utc` após `expected_close`
- Removido loop destrutivo `missed_post_close_window` em `wait_for_bar_complete`

## Próximo passo (operador)

1. Merge fix branches (`fix/bar-wait-alignment-v8`) gateway + profile
2. Re-executar v9 **somente** com novo alinhamento — não repetir este run
3. Sem PRAC/soak até stability PASS
