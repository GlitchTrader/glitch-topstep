# Armed promotion checklist — 2026-08-24

Paired pair: gateway **0.2.2** `@847ed5c` (#236) + profile **0.2.5** `@b0ecbfd` (#195).

## Results

| Step | Result |
|------|--------|
| Merge verify (both `main`) | **PASS** |
| Gateway restart (`start.ps1 -SkipBuild`) | **PASS** (PID 5900 replaced) |
| PRAC soak preflight (`scripts/prac-soak-checklist.ps1`) | **PASS** (6/6) |
| `npm run reaudit:fault-matrix` + profile proofs | **PASS** |
| Rollback rehearsal (`scripts/rollback-rehearsal.mjs`) | **PASS** |
| `paired-release-candidate` workflow | **FAIL** then fix queued |

## Health (post-restart)

- `status=ok`, `trading_mode=armed`, `lifecycle=ready`
- `auth_degraded=false`, `state_complete=true`, `unprotected_open_quantity=0`

## PRAC soak checks

| check | ok |
|-------|-----|
| gateway_version_0.2.2 | true |
| trading_mode_armed | true |
| lifecycle_ready | true |
| auth_not_degraded | true |
| state_complete | true |
| flat_start | true |

Evidence: `docs/evidence/PRAC-SOAK-2026-08-21/gateway-health-preflight.json`

## Fault matrix / rollback

- `release/reaudit-fault-matrix-proof.json` — gateway `847ed5c`, profile `b0ecbfd`
- `scripts/rollback-rehearsal.mjs` — `rollback_rehearsal_ok` (no separate manifest required)

## Release workflow

- Run: https://github.com/GlitchTrader/glitch-topstep/actions/runs/32796577821
- Inputs: `profile_commit=b0ecbfd`, `profile_version=0.2.5`, `prompt_version=glitch-topstep-v15`, `profile_manifest_sha256=43e21c08…`
- `armed-production` approval: granted
- Failure: step 10 `PROMPT_VERSION` sed targeted `profile/scripts/distribution_manifest.py`; prompt lives in `paired-contract.json` since profile C1 (#195)
- Run (retry): https://github.com/GlitchTrader/glitch-topstep/actions/runs/32797244666 — **SUCCESS**
- Artifact: `paired-release-5813d832e0e7cb65c203f28bf8bbeac3a2b89fc8`
- `pair_digest=78739f348407f450e677da40d59b4e6939c17fa4959a80d6e154337510cb0a2a`

## PROD-08

`TS-PROD-08` ledger status **done** (branch protection + `armed-production` env). Human gate exercised via environment approval on both release runs.

## Armed promotion status

**Complete — operator sign-off recorded.** Runtime is `armed` on operator device. Immutable pair manifest published in CI artifact; evidence attached to issue #116; operator approval recorded on `release/paired-release.json` and archived copy under `docs/evidence/paired-release-5813d83/`.

| Field | Value |
|-------|-------|
| `operator_id` | `arifreund18` |
| `signed_at_utc` | `2026-08-25T01:46:34.491Z` |
| `armed_promotion_approved` | `true` |
| `pair_digest` | `78739f348407f450e677da40d59b4e6939c17fa4959a80d6e154337510cb0a2a` |
