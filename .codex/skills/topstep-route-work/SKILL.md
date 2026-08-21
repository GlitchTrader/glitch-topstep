---
name: topstep-route-work
description: Route Glitch Topstep work to the correct repo, wave, and files.
---

# topstep-route-work

## Activates when

The task touches Topstep/ProjectX, Hermes profile, gateway, or paired release — and the owner repo is unclear.

## Authority

- Gateway code: `glitch-topstep` only.
- Cognition/delivery: `glitch-topstep-hermes-profile` only.
- Wave order: `docs/plans/2026-08-20-nt-adaptation-roadmap.md`.
- Ledger: `docs/ledger/ledger.json` (each repo).

## Route table

| Topic | Repo | Primary files |
|-------|------|---------------|
| Packet / scanner / market | gateway | `src/hermes/`, `src/market/` |
| Intent execution / protection | gateway | `src/execution/` |
| Cognition cycle / outbox | profile | `scripts/run-topstep-cycle.py` |
| Learning / overlay | profile | `scripts/run-topstep-learning.py` |
| Paired contract | both | `release/paired-contract.json`, profile `paired-contract.json` |

## Required checks

- `npm run check` (gateway)
- `python -m unittest discover -s tests` (profile)

## Stop line

Do not implement gateway logic in the profile or Python in the gateway.
