# v5 packet timeout / health divergence — root cause (2026-09-08)

**Evidência:** `docs/evidence/gateway-diagnosis/2026-09-08-bar-close-aware-stability-v5/`
**Gateway:** não reiniciado · **v5:** não repetir · **PRAC/soak:** bloqueados

## 1. Timeouts `/packet` (16:41–16:44Z)

| Fato | Detalhe |
|------|---------|
| Cliente profile | 3 tentativas × 8s timeout em `/packet` |
| Servidor | `/packet` aguardava `ensurePacketMarketObservationFresh()` sem limite HTTP |
| Cadeia | `refreshForPacket` → `enqueueUniverseRefresh` (serial) → 4× `retrieveBars`/contrato |
| ProjectX | `operationDeadlineMs` default **60s** por chamada |
| Registro v5 | 6 eventos `gateway_timeout` com `duration_ms` ~8000 por tentativa |

**Causa:** bloqueio síncrono da rota HTTP na refresh de market observation (history API), não timeout mascarado como amostra válida.

## 2. Divergência health/packet

| Endpoint | Comportamento |
|----------|----------------|
| `/health` | Snapshot venue síncrono; **não** chama `retrieveBars` |
| `/packet` | `await refresh()` antes de `buildSnapshot` + packet |

**Amostra v5 índice 1 (16:46:01Z):** health `state_complete=true`, packet `state_complete=false`, issue `quote_geometry_invalid`.

**Mecanismo:** fetches sequenciais no stability gate. Health captura quote válido; packet, após refresh lento (~7 min desde amostra 0), usa snapshot posterior com BBO cruzado (`bestBid >= bestAsk`).

`quote_geometry_invalid` é **causa** de `state_complete=false` no packet (via `evaluateSnapshotDataQuality`), não artefato do gate.

## 3. Correção gateway (PR separado)

- `boundedPacketObservationRefresh`: budget default 4s (`GLITCH_PACKET_MARKET_OBSERVATION_REFRESH_BUDGET_MS`)
- Skip refresh se observation age &lt; `PACKET_OBSERVATION_STALE_MS` (30s)
- Timeout → serve cached observation + `optional_issues: market_observation_refresh_timeout`
- **Não** aumentar só o timeout do cliente profile

## 4. Artefato histórico

`test_timeout_blocked_bar_close_window` MemoryError (~54 min) é pré-`ef70bbc`; não avaliar gate atual por esse run.

## 5. Bloqueio externo residual

`quote_geometry_invalid` em runtime live pode ser provider/market data (BBO cruzado); requer v6 com gateway corrigido para separar timeout de geometria.
