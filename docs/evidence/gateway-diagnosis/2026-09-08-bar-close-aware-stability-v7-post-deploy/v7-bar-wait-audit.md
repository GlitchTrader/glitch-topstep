# v7 bar-wait audit — `bar_still_partial` após 301s

**Run:** `2026-09-08T18:54:29Z`  
**Gateway SHA deployed:** `8689332`  
**Script branch:** `feat/gateway-readonly-diagnosis-script` (pré-merge #268)  
**Veredito:** FAIL — janela stability nunca iniciou

## Artefatos analisados

| Arquivo | Conteúdo |
|---------|----------|
| `bar-wait-20260908T185429Z.json` | `ready=false`, `reason=bar_still_partial`, `waited_seconds=301.78` |
| `gateway-diagnosis-verdict-20260908T185429Z.json` | `classification=bar_1m_partial`, lanes PRAC/soak BLOCKED |
| `v7-run.log` | Bloqueio em bar-wait antes de diagnóstico completo |

**Nota:** Os artefatos v7 não gravaram `expected_close`, `latest_bar_utc` nem `prior_completed_bar_utc` — o `wait_for_bar_complete` legado só registrava `ready/reason/waited_seconds`.

## Causa raiz

O `wait_for_bar_complete` original em `scripts/gateway-readonly-diagnosis.py` (pré-fix) usava critério **errado**:

```python
while timeout:
    if not _bar_partial(packet):  # latest_bar_partial == False
        return ready
```

### Por que isso falha no feed real

1. **Bar 1m quase sempre `latest_bar_partial=true`** — enquanto o minuto corrente está aberto, o pacote reporta partial. Após o fechamento, o gateway rola imediatamente para o próximo minuto com `partial=true` de novo.
2. **Janela `partial=false` é rara ou inexistente** — com poll de 5s em 301s, é improvável capturar um instante transitório onde `partial=false`; na prática o feed ProjectX mantém `partial=true` continuamente (confirmado pós-deploy: `partial=True` em probes repetidos).
3. **Lógica correta já existe no profile** — `extract_bar_close_context`, `expected_close_for_context`, `is_post_close_sample` e `run_bar_close_aware_stability_window` em `operational_stability_gate.py` alinham por **relógio UTC** e `prior_completed_bar`, não por flag partial isolada.

### Campos que deveriam ter sido observados (probe pós-falha @ ~19:07 UTC)

| Campo | Valor típico |
|-------|----------------|
| `latest_bar_utc` | `2026-09-08T19:07:00.000Z` |
| `prior_completed_bar_utc` | `2026-09-08T19:06:00.000Z` |
| `expected_close` (derivado) | `2026-09-08T19:08:00Z` |
| `latest_bar_partial` | `true` (esperado intra-bar) |
| health `status` | `ok` |
| health `state_complete` | `true` |

**Health vs packet:** sem divergência de `state_complete` no probe; o bloqueio foi exclusivamente na lógica de bar-wait do script, não no gateway.

## Fatores descartados

| Hipótese | Evidência |
|----------|-----------|
| Late start / timezone | Script não usava `expected_close`; não havia alinhamento temporal |
| Clock drift | Irrelevante — esperava flag, não horário |
| `prior_completed_bar` ignorado | Função legada não consultava o campo |
| Gateway degradado | Health `ok` + `state_complete=true` pré-run |
| Restart necessário | Proibido e não indicado |

## Correção aplicada (pós-audit)

1. **`wait_for_bar_complete`** adicionado em `operational_stability_gate.py` (profile) — espera `expected_close` por relógio, valida janela pós-close via `is_post_close_sample` + `prior_completed_bar`; **não** aceita partial isolado.
2. **`gateway-readonly-diagnosis.py`** delega ao profile com `fetch_gateway_packet_readonly` e grava `polls` com timestamps reais.

## Implicação para v8

- Iniciar **antes** do próximo `expected_close` observável.
- Não repetir v6/v7 com o script legado.
- Se bar-wait falhar de novo → STOP (sem PRAC/soak).
