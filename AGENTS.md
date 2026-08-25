# Glitch Topstep Gateway — agent entry point

Canonical repo: `GlitchTrader/glitch-topstep`  
Paired profile: `GlitchTrader/glitch-topstep-hermes-profile` (Python only — never mix TypeScript into the profile)

## Before you change code

1. Read `docs/plans/2026-08-20-nt-adaptation-roadmap.md` for wave order and frozen policies (daily capture entry lock, intent-free automatic breakeven).
2. Read `docs/plans/2026-08-25-complete-audit-implementation-plan.md` for current P0 (C1–C4) and wave order from the 2026-08-25 architecture audit.
3. Read `docs/ledger/ledger.json` for item status — update ledger when closing work.
4. Paired releases: bump `release/paired-contract.json` and the profile copy **together** when the wire contract changes.
5. Run `npm run check` before every PR.

## Repository map

| Area | Path |
|------|------|
| HTTP gateway | `src/server/local-gateway.ts` |
| Execution / intents | `src/execution/` |
| Market / packets | `src/market/`, `src/hermes/packet-builder.ts` |
| ProjectX | `src/projectx/` |
| Paired contract | `release/paired-contract.json` |
| State machines | `src/domain/state-machines.ts` |
| Tests | `tests/` |
| Operations | `docs/OPERATIONS.md`, `start.ps1` |

## Forbidden

- Blocking trades or inflating `NOTHING` for data lag (TS-DATA-01 stop line).
- Simultaneous multi-instrument exposure (TS-MULTI-04) without portfolio-risk proof.
- Weakening automatic breakeven or daily-capture protection (TS-AUTH-02 stop line).
- Direct ProjectX mutation from the profile — gateway only.

## Builder skills (`.codex/skills/`)

| Skill | Use when |
|-------|----------|
| `topstep-route-work` | Unsure which repo or wave owns the change |
| `topstep-hermes-pairing` | Paired release, compatibility manifest, prompt version |
| `topstep-projectx-contracts` | ProjectX identity, contract resolution, auth |
| `topstep-execution-safety` | Intents, protection, flatten, recovery |
| `topstep-live-acceptance` | Credentialed PRAC / soak evidence |
| `topstep-doc-ledger` | Ledger + issue hygiene |
| `topstep-release-pair` | Armed promotion and rollback runbook |

## Local run

```powershell
cd glitch-topstep
copy .env.example .env   # GLITCH_LOCAL_TOKEN, PROJECTX_*
npm run check
powershell -File start.ps1
```

Default: `http://127.0.0.1:8790`
