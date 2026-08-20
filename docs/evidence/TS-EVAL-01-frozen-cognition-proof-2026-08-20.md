# TS-EVAL-01 — frozen cognition evaluation proof (2026-08-20)

Evaluation-only acceptance for issue #68.

## Workflow

| Step | Artifact |
|------|----------|
| Freeze corpus | `glitch-topstep-hermes-profile/tests/fixtures/frozen_corpus/minute-frames/` |
| Build baseline run | `run-frozen-cognition.py` → `glitch.topstep.cognition_run.v1` |
| Build candidate run | same corpus hash, different archived decisions |
| Diff | `evaluate-frozen-cognition.py` → `glitch.topstep.cognition_diff.v1` |

Documented in gateway `docs/OPERATIONS.md` § Comparative cognition evaluation.

## Fixture diff (2026-08-20)

Corpus: 2 minute-frames (`20260820T1200Z`, `20260820T1201Z`).

| Prompt | Frame | action | rejection | abstention |
|--------|-------|--------|-----------|------------|
| v9 baseline | 1201Z | ENTER_LONG | cognitive_rejection | — |
| v10 candidate | 1201Z | NOTHING | — | missed_directional_participation |

`changed_frames`: 1 · `armed_promotion_allowed`: false

## Regression

```powershell
cd C:\Users\arifr\Projects\glitch-topstep-hermes-profile
python -m unittest tests.test_frozen_cognition_eval -v
```

## Residual

Live two-prompt replay against operator production minute-frames remains optional archival; fixture + CI prove the contract.
