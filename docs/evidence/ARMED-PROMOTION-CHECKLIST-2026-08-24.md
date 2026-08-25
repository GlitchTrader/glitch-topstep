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
- Local fix: read `profile.paired-contract.json` in `release.yml` + `build-paired-release-manifest.mjs`
- Local manifest: `release/paired-release.json` (`pair_digest=d6e33655…`)

## PROD-08

`TS-PROD-08` ledger status **done** (branch protection + `armed-production` env). Human gate exercised via environment approval on the release run; not a substitute for attaching the published artifact to issue #116.

## Armed promotion status

**Blocked** until `paired-release-candidate` completes green and artifact is recorded in ledger/issue #116. Runtime is already `armed` on operator device with ack; process promotion is evidence + immutable pair manifest.
