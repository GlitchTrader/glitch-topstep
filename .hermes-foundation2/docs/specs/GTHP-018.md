# GTHP-018 — Market quiescence evidence gate (flat direct-operator)

**Status:** done  
**Priority:** P1  
**Issue:** [#61](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/61)  
**Profile version target:** 0.1.20+  
**Depends on:** GTHP-009, GTHP-014 (supersedes clock semantics)  
**Gateway dependency:** `glitch-topstep:TS-R4-07` (stream-health fields; interim env stale skip OK)

## Problem

GTHP-014 skips flat Luna cycles when `entry_window_open` is false. After TS-R3-02, `entry_window_open` stays `true` outside RTH because `must_flat_utc` points to the next session day. CME maintenance (frozen quote, zero tape) is **not** captured—operators rely on `GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE=true` as an ad-hoc workaround.

## Invariant

| Layer | Rule |
|-------|------|
| **Evidence** | Market quiescence = labeled combination of stale quote + minimal/zero tape (configurable thresholds). |
| **Profile worker** | May skip flat direct-operator Luna when quiescent; records `market_quiescent`, not `session_closed`. |
| **Learning** | `run-topstep-learning.py` **never** gated by quiescence. |
| **Positioned** | Always invoke Luna; wake triggers unchanged. |
| **Hermes** | No strategy embedded in skip logic. |

## Acceptance

- Flat + quiescent evidence → `llm_skipped` with reason `market_quiescent`.
- Thresholds env-configurable; defaults documented in `docs/OPERATIONS.md`.
- Learning supervisor runs on schedule regardless of quiescence.
- Tests prove skip only when flat; positioned path unaffected.
- GTHP-014 `session_closed` path deprecated or narrowed to explicit operator session override only.

## Stop line

No wall-clock maintenance table as sole gate; no learning suppression; no ENTER veto.

## Related

- GTHP-014, GTHP-019
- `glitch-topstep:TS-R4-07`
- PRAC evidence 2026-08-05 16:00–17:00 CDT maintenance window
