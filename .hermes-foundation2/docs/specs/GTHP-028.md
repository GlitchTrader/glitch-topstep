# GTHP-028 — Neutral template placeholders and cycle delta audit

**Priority:** P1 (cognition)  
**Status:** done  
**Depends on:** GTHP-025  
**Prompt version:** glitch-topstep-v9

## Problem

External review of `glitch-topstep-v8` confirmed prompt doctrine improved (~8/10) but three gaps remained:

1. **Template shape:** removing `action`/`confidence` avoided NOTHING anchoring but increased omission risk. Neutral placeholders are required, not defaults.
2. **Behavioral inertia:** rebuild instructions alone did not force an explicit delta-vs-prior-frame audit or hypothesis lifecycle classification; `change_condition` text repeated across cycles.
3. **Residual confirmation language:** “honor prior change_condition” read like a prerequisite gate despite advisory doctrine.

## Scope

### Profile prompt / SOUL / skills

- [x] `required_output_template`: `action` = `<CHOOSE_FROM_supported_actions>`, `confidence` = `<0.0-1.0>`; never pre-filled `NOTHING`.
- [x] `cycle_evidence_delta` in prompt envelope when `recent_frames` is non-empty.
- [x] `decisive_evidence` must open with `prior_hypothesis=<CONFIRMED|INVALIDATED|PARTIALLY_CONFIRMED|UNCHANGED>` plus material deltas.
- [x] `ledger_repetition_guidance` when the same `change_condition` repeats across recent cycles.
- [x] Replace “honor prior change_condition” with observational-only language.
- [x] Clarify flat vs positioned actions: never `HOLD` while flat; never `NOTHING` while positioned.
- [x] Reinforce multi-tranche `target_intent_id` rules in operator instruction.
- [x] `normalize_intent` / `validate_intent` reject unreplaced placeholders.

### Operations

- [x] `safe-profile-update.ps1`: stale `direct-cycle.lock` recovery (shipped 0.1.28).

## Non-goals

- Trade quotas or anti-abstention pressure.
- Worker gates on `decision_scores` or hypothesis labels.
- Gateway packet source fixes (GTHP-029 profile sanitization + issue #73 gateway).

## Acceptance

- Schema validity on flat NOTHING/HOLD/ENTER samples in unittest prompt fixtures.
- Prompt envelope includes placeholders, `cycle_evidence_delta`, and repetition guidance.
- Manual replay should show fewer verbatim repeated `change_condition` strings across similar-structure flat cycles.

## Related

- GTHP-029 packet sanitization (#73 profile side)
- #74 P2 structural evidence
- #75 P3 calibration metrics
