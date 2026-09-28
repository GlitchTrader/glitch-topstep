# Passo 1 — diagnóstico health_build_ms / SQLite (POST324)

Soak: `PRAC-SOAK-2026-09-28-POST324`  
Janela pedida: `2026-09-28T18:00:00Z` … `19:41:00Z`  
Fonte: `health-samples.jsonl` (sampler 30s timeout) + leitura de código.

## health_build_ms na janela

| sample | recorded_utc | status | health_build_ms |
|--------|--------------|--------|-----------------|
| 19–24,26–27,34–35 | 18:03–18:43, 19:18–19:23 | ERROR | *(ausente — timeout / unable to connect)* |
| 25 | 18:33:18Z | degraded | **857** |
| 28 | 18:48:17Z | degraded | **748** |
| 29 | 18:53:27Z | degraded | **532** |
| 30 | 18:58:12Z | degraded | **545** |
| 31 | 19:03:07Z | degraded | **971** |
| 32 | 19:08:23Z | degraded | **471** |
| 33 | 19:13:14Z | degraded | **906** |
| 36 | 19:28:10Z | degraded | **566** |
| 37 | 19:33:18Z | degraded | **567** |
| 38 | 19:38:15Z | degraded | **500** |

Pré-janela (degraded ainda respondendo): 17:43–17:58 → 309–396 ms.  
Fase limpa do mesmo soak: tipicamente 100–250 ms.

## Correlação com health_unreachable

- Amostras `ERROR` **não têm** `health_build_ms`: o sampler não completou GET `/health` (30s) ou a porta não aceitou conexão.
- Parte desses gaps coincide com kills do watchdog (`stopping PID …` em `data/gateway-watchdog.log` às 18:01, 18:07, 18:23, 18:41, 18:59, 19:23, 19:41) — processo ausente explica `Unable to connect`.
- Timeouts **depois** de `restart complete` (ex.: 18:13–18:28 após restart 18:07) indicam listener vivo mas thread sem servir HTTP a tempo → stall do event loop, não “só lento”.
- Quando `/health` volta na mesma tempestade, `health_build_ms` fica **2–4×** a baseline limpa (471–971 vs ~150), correlacionado com a janela de `health_unreachable` / recovery.

## Hipótese SQLite (código)

Confirmada como risco estrutural na mesma thread do HTTP:

| Store | Arquivo | pragmas |
|-------|---------|---------|
| execução | `sqlite-execution-store.ts:58-62` | `DatabaseSync`, `synchronous=FULL`, `busy_timeout=5000` |
| control | `durable-control-store.ts:35-36` | idem FULL + busy_timeout=5000 |
| outcome-feed | `sqlite-outcome-feed.ts:46-47` | idem FULL + busy_timeout=5000 |
| evidência | `sqlite-provider-evidence-store.ts` | `synchronous=NORMAL` (já mais leve) |

`/health` autenticado (`service.ts` health builder) chama, entre outros:

- `executionStore.recoveryStatus()` — SELECT sync
- `executionStore.updateUnprotectedSince(...)` — pode **escrever** `runtime_meta` (FULL fsync) no hot path
- `controlStore.status()` / flatten age — SELECT sync
- ownership abre **segunda** conexão read-only no mesmo `glitch-topstep.sqlite` (`projectx-order-ownership.ts:65-67`) com `busy_timeout=5000` → reader pode esperar writer até 5s por statement

`local-gateway.ts:142-144`: `/health` não faz REST; o hang não é ProjectX HTTP — é trabalho sync na thread que aceita sockets.

## Telemetria de escrita por store

- Fila de evidência: já tem `last_write_latency_ms` / `max_write_latency_ms`.
- Execução / control / outcome-feed: adicionados via `SqliteWriteLatencyTracker` e expostos em `/health` como `sqlite_write_latency.{execution,control,outcome_feed,evidence_queue}`.

## Veredito Passo 1

**Não descartada.** Consistente e suficiente para autorizar Passo 2:

1. Latência de build elevada na tempestade (evidência direta de `health_build_ms`).
2. Unreachability total alinhada a stall de event loop e/ou processo morto pelo watchdog.
3. Código prova writes/reads SQLite sync FULL (+ segunda conexão) no caminho de `/health`.

Passo 2 (isolar `/health` de writes / busy) é a correção estrutural. Passo 3a/3b mitiga o gatilho REST/storm em PR separado.
