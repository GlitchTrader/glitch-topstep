# GTHP-023 — Selective V2 skills (orderflow, session, post-trade)

**Status:** open  
**Priority:** P2  
**Issue:** [#63](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/63)  
**Profile version target:** 0.1.23+  
**Depends on:** GTHP-010, GTHP-012  
**Gateway dependency:** `glitch-topstep:TS-R4-07`, `TS-R4-08` (optional packet fields)

## Problem

Glitch V2 ships ~19 skills; full port is YAGNI. Three skills cover the highest-value cognition gaps for Topstep-native operation without guardian or multi-account complexity.

## Proposed skills

| Skill | Purpose |
|-------|---------|
| `orderflow-liquidity` | Interpret tape/DOM windows in packet (15s/60s/300s). |
| `session-playbook` | Maintenance, open, lunch, close as doctrine—not gates. |
| `post-trade-review` | Structured debrief aligned with GTHP-012 outcomes. |

## Acceptance

- Each skill: `skills/<name>/SKILL.md` with activation boundaries and packet references.
- `SOUL.md` links skills; no contradiction with GTHP-009 / AUTHORITY.
- No auto-flatten, profit lock, or ENTER veto via skills.
- Prompt references skills by name only where needed (GTHP-011 slimming preserved).

## Stop line

No v2 guardian, `glitch-decision-v2` schema, or bulk skill import.

## Related

- GTHP-011, GTHP-012, GTHP-021
- `glitch-topstep:TS-R4-08`
