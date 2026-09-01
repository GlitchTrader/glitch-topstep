# Soak PRAC 72h — runbook operacional

**Sessão:** PRAC-SOAK-2026-08-31  
**Pré-requisito:** 11/11 testes dirigidos **PASS** (`directed-tests.md`)  
**Modo:** `armed` **supervisionado** — operador identificado; **não** unattended  
**Conta:** PRAC `26919346` / MNQ `CON.F.US.MNQ.U26`

---

## 1. Par fixado para a janela

Registre no início e **não altere** gateway/profile/commits durante as 72h:

| Artefato | SHA / versão | Notas |
|----------|--------------|-------|
| Gateway (este repo) | _preencher após merge do PR de fixes_ | `git rev-parse --short HEAD` |
| Profile Hermes | `a35e5b5` (#207) | `glitch-topstep-v17.1` |
| `paired-contract.json` | _versão no merge_ | Deve bater com profile |

```powershell
cd glitch-topstep
git rev-parse HEAD
git rev-parse --short HEAD
npm run check
npm run reaudit:fault-matrix
```

Profile (repo separado):

```powershell
cd $env:LOCALAPPDATA\hermes\profiles\glitch-topstep
git rev-parse --short HEAD
python scripts/preflight-pairing.py
```

---

## 2. Preflight imediato (T0)

1. **Flat** no ProjectX e no gateway (`instrument_open_contracts = 0`, zero working orders own).
2. **Gateway Node** único em `:8790` — `GlitchTopstep_Gateway` / `start.ps1` (sem `GLITCH_KILL_POINT`, sem `GLITCH_ACCEPTANCE_STREAM_GAP`).
3. **Hermes cron scheduler** — não confundir com HTTP 8790:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ensure-hermes-gateway-scheduler.ps1
hermes -p glitch-topstep cron status
```

4. **Checklist automatizado:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prac-soak-checklist.ps1 `
  -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-31
```

5. **Baseline de evidência** (se ainda não existir):

```powershell
python scripts/prac-capture-evidence.py --out docs/evidence/PRAC-SOAK-2026-08-31/preflight-T0.json
```

6. Preencher `session-manifest.json` com operador, UTC início, SHAs acima.

---

## 3. Iniciar sampler 72h

Janela contínua **72 horas corridas**. Amostra `/health` a cada **5 min** (ajustável):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prac-soak-sample.ps1 `
  -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-31 `
  -IntervalSeconds 300 `
  -DurationHours 72
```

- Saída: `health-samples.jsonl` (append).
- **Ctrl+C** encerra cedo — documentar em `incidents.md` se interromper.
- Manter consola visível ou log redirecionado; **não** Task Scheduler unattended.

Recomendado em paralelo (outra consola):

```powershell
# Watchdog gateway (se instalado)
Get-ScheduledTask GlitchTopstep_GatewayWatchdog -ErrorAction SilentlyContinue

# Tail de alertas críticos
Get-Content data/gateway.stderr.log -Wait -Tail 20
```

---

## 4. Durante o soak — o que monitorar

A cada turno operacional (mínimo 2×/dia), verificar:

| Sinal | Fonte | Abortar soak se |
|-------|--------|-----------------|
| `state_complete=false` persistente >30 min | `/health` | Sim — reiniciar gateway; registrar incidente |
| `unprotected_open_quantity > 0` | `/health` | Sim — flatten supervisionado; investigar |
| `ambiguousMutations > 0` não resolvido | `/health` | Sim |
| `auth_degraded=true` | `/health` | Sim até refresh OK |
| `health_alerts` critical | `/health` | Sim — classificar em `incidents.md` |
| Posição não autorizada | ProjectX UI + `/packet` | Sim |
| Commit gateway/profile alterado | git | Sim — soak invalidado |

**Permitido (supervisionado):** restart do gateway por `quote_geometry_invalid`, janela de manutenção Topstep, flatten operador autorizado.

**Proibido:** novos deploys, mudança de prompt/profile, testes kill-matrix, `GLITCH_ACCEPTANCE_STREAM_GAP` em produção soak.

---

## 5. Trading supervisionado (opcional)

O soak mede **estabilidade runtime**, não PnL. Se o cycle Hermes emitir intents:

- Respeitar `maximum_additional_contracts` e gates do packet.
- Não forçar entrada com daily capture latched.
- Documentar intents/receipts em `intent-receipts.jsonl` (append manual ou export).

---

## 6. Encerramento (T0 + 72h)

1. Parar sampler (Ctrl+C se ainda rodando).
2. Confirmar **flat** + zero ambiguidade:

```powershell
python scripts/prac-poll-state.py
powershell -ExecutionPolicy Bypass -File scripts/prac-soak-checklist.ps1 `
  -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-31
```

3. Gerar resumo de métricas:

```powershell
python -c "
import json, statistics
from pathlib import Path
p = Path('docs/evidence/PRAC-SOAK-2026-08-31/health-samples.jsonl')
rows = [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines() if l.strip() and 'error' not in l]
build = [r['health_build_ms'] for r in rows if 'health_build_ms' in r]
print(json.dumps({
  'samples': len(rows),
  'health_build_ms_p50': statistics.median(build) if build else None,
  'health_build_ms_p95': sorted(build)[int(len(build)*0.95)] if len(build)>1 else None,
  'degraded_samples': sum(1 for r in rows if r.get('status')=='degraded'),
  'state_incomplete_samples': sum(1 for r in rows if r.get('state_complete') is False),
}, indent=2))
" | Set-Content docs/evidence/PRAC-SOAK-2026-08-31/metrics-summary.json
```

4. Preencher `operator-signoff.md` (directed + soak).
5. Atualizar `docs/ledger/ledger.json` se fechar item de soak.

---

## 7. Critérios PASS para promoção pós-soak

- [ ] 72h completas ou abort documentado com causa raiz
- [ ] `health-samples.jsonl` sem buracos >30 min inexplicados
- [ ] Zero receipt ambíguo terminal não resolvido
- [ ] `npm run reaudit:fault-matrix` verde no SHA congelado
- [ ] Par gateway/profile inalterado durante janela
- [ ] Operador sign-off em `operator-signoff.md`
- [ ] Rollback drill referenciado (`rollback-result.md`)

**Classificação alvo:** `PRAC-proven` → revisão armed promotion (`topstep-release-pair` skill).

---

## 8. Rollback rápido

Se soak abortar por regressão:

1. Flatten operador: `python scripts/prac-operator-flatten-once.py "Soak abort"`
2. Reverter gateway para SHA anterior; profile para tag pareada anterior.
3. Registrar em `incidents.md` + `rollback-result.md`.
4. Não retomar soak até novo 11/11 no SHA corrigido.
