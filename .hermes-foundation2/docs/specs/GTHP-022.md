# GTHP-022 — Participation breadth (partial timeframe alignment)

**Status:** done  
**Priority:** P1 cognition doctrine  
**Profile version target:** 0.1.21 (`prompt_version` `glitch-topstep-v6`)  
**Depends on:** GTHP-009, GTHP-011, GTHP-017

## Problem

Operator review found Hermes staying flat too often when a locally falsifiable thesis existed. Prior SOUL and `topstep-form-thesis` language could be read as requiring full higher-timeframe agreement, closed candles, retests, or sustained multi-window order flow before `ENTER_*`. That conflicts with GTHP-009: imperfect evidence is not an automatic veto, and activity pressure is never evidence.

## Invariant

| Layer | Rule |
|-------|------|
| **Timeframes** | 60m = regime/location; 5m = structure; 1m = timing. Complementary, not a mandatory confirmation stack. |
| **Hypotheses** | Continuation, pullback, breakout, failed breakout, short mean reversion, transition — evaluate what fits; no checklist quota. |
| **Flat audit** | Path (5m), move phase, favorable participation condition, structural invalidation. |
| **Boosters** | Retest, closed candle, persistent flow, full alignment may raise confidence — never universal gates. |
| **Frequency** | More valid local theses, not smaller stops, larger size, or trade quotas. `missed_directional_participation` informs review only. |
| **Gateway / worker** | Unchanged — no new execution gates or cadence vetoes. |

## Non-goals

- Trade quotas or daily frequency targets.
- Thinning stops or increasing size to force participation.
- Reversing GTHP-018 market quiescence or GTHP-014 session skip.
- Using `missed_directional_participation` as entry pressure.

## Changes

1. **SOUL.md** — three `ALTERADO` bullets: partial alignment, expanded hypotheses, frequency discipline.
2. **skills/topstep-form-thesis/SKILL.md** — HTF hierarchy rewrite; new Participation breadth section with flat audit questions.
3. **scripts/run-topstep-cycle.py** — `ALTERED PARTICIPATION GUIDANCE` in `CYCLE_OPERATOR_INSTRUCTION`.
4. **scripts/distribution_manifest.py** — `PROMPT_VERSION` → `glitch-topstep-v6`.

## Verification

- `python -m unittest discover -s tests -p 'test_*.py'`
- `python scripts/regenerate_sha256sums.py`
- `tests/test_compatibility.py` prompt_version alignment
