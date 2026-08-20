# TS-PROD-08 — branch protection and armed gate proof (2026-08-20)

Captured after enabling residual PROD-08 controls.

## Branch protection

| Repo | `enforce_admins` | Required checks | Force-push | Deletion | Conversation resolution |
|------|------------------|-----------------|------------|----------|-------------------------|
| `GlitchTrader/glitch-topstep` | `true` | `test`, `dependency-review`, `codeql` | disabled | disabled | enabled |
| `GlitchTrader/glitch-topstep-hermes-profile` | `true` | `test`, `dependency-review`, `codeql` | disabled | disabled | enabled |

Commands:

```powershell
gh api repos/GlitchTrader/glitch-topstep/branches/main/protection/enforce_admins --jq .enabled
gh api repos/GlitchTrader/glitch-topstep-hermes-profile/branches/main/protection/enforce_admins --jq .enabled
```

## Armed-production environment

Both repositories have GitHub Environment `armed-production` with:

- required reviewer: `arifreund18`
- `can_admins_bypass=false`
- deployment branch policy: protected branches only

Used by:

- gateway workflow `paired-release-candidate` (`.github/workflows/release.yml`)
- profile workflow `profile-release-candidate` (Hermes `.github/workflows/release.yml`)

## Break-glass

Documented in each repo `docs/OPERATIONS.md` (4-hour audited window; re-enable `enforce_admins` immediately).

## SBOM / attestation

- Gateway release job: `npm sbom` CycloneDX + `paired-release.json` + `actions/attest-build-provenance`
- Profile release job: CycloneDX over distribution-owned files + `profile-release.json` + attestation

## Runtime armed ack (not a substitute for the environment gate)

```text
GLITCH_TRADING_MODE=armed
GLITCH_ARMED_ACK=I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY
```
