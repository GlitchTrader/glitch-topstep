# GTHP-021 — Learning calibration and similar-decision grouping

**Status:** open  
**Priority:** P2  
**Issue:** [#64](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/64)  
**Profile version target:** 0.1.23+  
**Depends on:** GTHP-012, GTHP-015

## Problem

GTHP-012 debriefs individual trades. V2 calibration groups **similar setups** so Hermes can see recurring patterns without auto-trading from clusters.

## Invariant

| Layer | Rule |
|-------|------|
| **Output** | Descriptive clusters in learning artifacts (labels, counts, outcome stats). |
| **Overlays** | `outcome_backed` gate unchanged; no auto-activate from similarity alone. |
| **Abstention** | No pressure to trade because cluster "should" fire. |

## Acceptance

- Learning worker emits similarity summaries (e.g. by session phase, structure tag, rejection class).
- Direct-cycle ledger may reference **bounded** cluster tail when configured.
- Tests: clusters are descriptive; no new execution path.
- `docs/OPERATIONS.md` documents conservative overlay policy.

## Stop line

Clusters inform cognition only—no intent submission, no gateway gates, no quotas.

## Related

- GTHP-012, GTHP-015, GTHP-020
