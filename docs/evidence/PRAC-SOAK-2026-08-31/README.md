# PRAC soak + directed tests — sessão 2026-08-31

**Status:** testes dirigidos **11/11 PASS** — soak 72h **liberado**  
**Par base:** gateway `f2de2ec` (#253) + fixes em PR pendente + profile `a35e5b5` (#207)  
**Prompt:** `glitch-topstep-v17.1` | **health:** `glitch.direct.health.v3`

## Preparação

| Etapa | Resultado |
|-------|-----------|
| `npm run check` | verde pós-fixes (partial exit + breakeven) |
| `npm run reaudit:fault-matrix` | verde |
| `prac-soak-checklist.ps1` | 6/6 PASS |
| Testes dirigidos 1–11 | **PASS** — ver `directed-tests.md` |
| Gateway + Hermes scheduler | rodando |

Evidência: `docs/evidence/PRAC-SOAK-2026-08-31/`

## Soak 72h

**Instruções completas:** [`SOAK-72H-RUNBOOK.md`](SOAK-72H-RUNBOOK.md)

Início rápido:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prac-soak-checklist.ps1 `
  -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-31

powershell -ExecutionPolicy Bypass -File scripts/prac-soak-sample.ps1 `
  -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-31 `
  -IntervalSeconds 300 `
  -DurationHours 72
```

## Classificação de evidência

| Fase | Classificação |
|------|----------------|
| Automatizado | `source-tested` |
| Preflight PRAC | checklist 6/6 |
| Testes dirigidos | **11/11 PASS** → `PRAC-proven` (parcial) |
| Soak 72h | _pendente_ |
| Armed promotion | _não autorizada até soak + sign-off_ |
