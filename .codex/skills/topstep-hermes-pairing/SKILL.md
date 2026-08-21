---
name: topstep-hermes-pairing
description: Paired gateway/profile releases, compatibility, and prompt version bumps.
---

# topstep-hermes-pairing

## Activates when

Changing `paired-contract.json`, prompt version, protocol revision, or compatibility manifest.

## Steps

1. Edit gateway `release/paired-contract.json` and profile `paired-contract.json` to match (byte-identical fields).
2. Bump `prompt_version` in gateway `src/domain/operator.ts` and profile `scripts/run-topstep-cycle.py` + `distribution_manifest.py` together.
3. Regenerate profile `SHA256SUMS` after script changes.
4. Run gateway `tests/paired-compatibility.test.ts` and profile `tests/test_paired_contracts.py`.
5. Record exact commits in release notes / ledger.

## Stop line

Never ship a profile prompt version ahead of the gateway packet semantics it depends on.
