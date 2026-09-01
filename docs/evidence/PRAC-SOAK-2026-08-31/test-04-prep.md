# Teste 4 — Cancelamento manual OCO (preparação)

**Status:** **PASS** — ver `test-04-manual-oco-cancel.json` (2026-08-31 ~23:38–23:41Z)  
**Pré-requisito:** posição protegida qty 3 (intent `ba8be6a5-3e5d-4ced-aba5-c2b3e562d2a7`)

## Critérios (directed-tests.md)

- [ ] Gateway detecta proteção incompleta após cancel manual de uma perna
- [ ] Nova entrada bloqueada se aplicável; EXIT/recovery/flatten permanecem disponíveis

## Estado inicial verificado (2026-08-31 ~23:29Z)

| Campo | Gateway | UI operador |
|-------|---------|-------------|
| Posição | 3 MNQ | +3 @ ~29495 |
| `protection_status` | `confirmed` | SL/TP no gráfico |
| SL | 29475 (`3470509442`) | -3 @ 29475 |
| TP | 29525 (`3470509443`) | Limit -3 @ 29527.25* |
| `unprotected_open_quantity` | 0 | — |
| OCO painel | — | OFF (ordens nativas existem) |

\* Divergência TP: confirmar preço exato no ticket da ordem `3470509443` no ProjectX.

## O que o operador deve fazer no ProjectX

1. **Autorizar** explicitamente no chat: `"teste 4"` ou `"cancelar perna OCO"`.
2. Com posição **+3 MNQ** e SL/TP working, **cancelar manualmente uma perna** (recomendado: **TP/Limit** primeiro — menor risco que cancelar só o stop).
3. Observar se o ProjectX cancela automaticamente a perna irmã (Auto OCO) ou deixa perna órfã.
4. **Não** fechar a posição inteira — só cancelar uma perna do bracket.
5. Screenshot + horário UTC após o cancel.

## O que o agente fará após o cancel (supervisionado)

1. `python scripts/prac-poll-state.py 30 4` — monitorar `protection_status`, `unprotected_open_quantity`, working orders.
2. `python scripts/prac-capture-evidence.py <entry_intent_id>` — snapshot `/health` + `/packet`.
3. Tentar (opcional) `ENTER_LONG` qty 1 — deve ser **rejeitado** se gate de nova exposição bloquear por proteção incompleta.
4. Confirmar que `EXIT` / flatten via `prac-operator-flatten-once.py` continua disponível.
5. Gravar `test-04-manual-oco-cancel.json`.

## Lacunas de script

- Não existe `prac-directed-test-04-*.py` — usar poll + capture + tentativa de ENTER manual ou script novo mínimo.
- Não há automação para cancel no ProjectX (correto — ação manual do operador).

## Riscos

- Cancelar **só o stop** deixa posição desprotegida — ter flatten pronto.
- Auto OCO pode cancelar **ambas** as pernas → gateway deve mostrar `pending`/`failed`, não `confirmed`.
- Após teste 4, **flatten** recomendado antes do Teste 5.

## Próxima ação sugerida ao operador

**Opção A — Teste 4:** autorizar cancel manual de uma perna OCO (preferir TP).  
**Opção B — Pausar:** flatten supervisionado agora e retomar Teste 4 com entrada fresca depois.
