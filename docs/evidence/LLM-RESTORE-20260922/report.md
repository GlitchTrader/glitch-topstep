# LLM restore evidence — 2026-09-22

## Root causes

1. **Gateway `/health` hot path** — `SqliteProviderEvidenceStore.status()` ran full-table `COUNT(*)` on ~505k `provider_events` rows (~562MB DB) on every authenticated health poll, blocking the Node event loop for 1.7–3.5s (and queuing `/packet` past the profile's 20s client timeout). Cycles died with `timed out` before cognition.
2. **Ensemble argv ceiling (Windows)** — `prac_live_ensemble._invoke_hermes` passed the multimarket envelope JSON as `-q` argv. CreateProcess failed with `WinError 206` (filename/extension too long). Cycles reported `multimarket_shadow_ensemble_completed` with `latency_ms=0` and launcher errors — no model call.

## Fixes

| Repo | Change |
|------|--------|
| `glitch-topstep` | Maintain O(1) evidence counters; health status uses MIN/MAX only. Idempotent `updateUnprotectedSince`. |
| `glitch-topstep-hermes-profile` | Shared `hermes_executable.resolve`; ensemble prompt via `--query-file -` (stdin). |

## Real LLM call (single profile probe)

- **profile home**: `%LOCALAPPDATA%\hermes\profiles\glitch-topstep`
- **specialty**: `structure` (skills `topstep-observe-market`, `topstep-form-thesis`)
- **executable**: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`
- **transport**: `hermes chat ... --query-file -` (stdin JSON prompt including instruction + envelope)
- **duration_ms**: 13376 (see `single-invoke.json`)
- **model result**: `state=missing_required_evidence` (probe envelope intentionally incomplete)
- **orders_sent**: 0
- **projectx_mutations**: 0
- **Glitch NT**: `Hermes_Gateway_glitch` remained Ready / untouched

## Gateway latency after fix

Authenticated `/health` wall ~120–400ms (`health_build_ms` ~90–400) vs prior 2–22s. `/packet` ~29ms when streams settled.

## Tests

- Gateway: `npm run check` (712 pass)
- Profile: `python -m unittest tests.test_prac_live_ensemble tests.test_hermes_executable`
