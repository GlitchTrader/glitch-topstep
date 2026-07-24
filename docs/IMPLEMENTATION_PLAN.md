# Plano de implementação — Glitch Topstep v3

## Fase 1 — Loop fechado (execução confiável)
- [x] Idempotência de intents (`packet_id` + `action`)
- [x] Reconciliação (`reconciliation` no packet)
- [x] Outcomes canônicos → `outcomes.jsonl` do perfil Hermes
- [x] Verificação de proteção (stop/target nos working orders)

## Fase 2 — Mercado enriquecido
- [x] Níveis estruturais (`market.levels`)
- [x] Volume relativo (`features.relative_volume`)
- [x] Correlação ES/MNQ (`market.correlation`)
- [x] Micro-bars quando posicionado ou pós-entrada

## Fase 3 — Decisão assistida
- [x] `execution.setup_candidates` (pré-filtro determinístico)
- [x] `MOVE_STOP` com prova de stop ownership + `Order/modify`
- [x] Policy: perdas consecutivas, risco diário restante

## Fase 4 — Hermes
- [x] Skills v2 (`topstep-observe-market`, `topstep-assess-risk`, `topstep-build-intent`)
- [x] Validação `MOVE_STOP` + `setup_candidates` no ciclo
- [x] `GLITCH_TOPSTEP_OUTCOMES_PATH` no perfil

## Fase 5 — Roadmap glitch → topstep (2026-07-24)
- [x] `launch-topstep-cycle.py` (cron não-bloqueante)
- [x] Telegram PnL de trade fechado + resumo diário
- [x] `reconcile_topstep_outcomes.py` → `canonical-outcomes.jsonl`
- [x] Decision episodes + cognitive firewall no learning
- [x] `reset-topstep-epoch.ps1`
- [x] Skill `topstep-escalate-to-codex` + `build-requests.jsonl`

- Calendário econômico / eventos
- Dashboard operacional
- Cognitive overlays calibrados por outcomes reais
- Payout phase / trailing drawdown EOD autoritativo Topstep
