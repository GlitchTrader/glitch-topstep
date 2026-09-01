# Codex handoff

> **Contributor onboarding moved to [`README.md`](../README.md)** (install, develop, push, operator controls).

## What is implemented

The repository contains a standalone Hermes distribution aligned to the current `glitch-topstep` gateway contract:

- profile identity `glitch-topstep`;
- sanitized packet consumption from localhost;
- five-frame capture and adaptive cadence;
- isolated Luna sessions with memory-only tools;
- strict single-intent normalization and validation;
- durable outbox and receipt records;
- deterministic operator controls including strict-contract flatten;
- isolated Sol learning loops driven only by canonical outcomes;
- checksum-verified setup with fresh jobs paused;
- standard-library tests and CI.

## Verify locally

```powershell
python -m unittest discover -s tests -p "test_*.py"
python -m py_compile scripts\*.py plugins\topstep-control\__init__.py
```

Then install into Hermes and run:

```text
/topstep_status
/trade
```

## Gateway integration tasks

1. Rename any remaining `glitch-toptrader` package, prompt, or operator-profile values to `glitch-topstep`.
2. Confirm `/packet` returns `operator_profile: glitch-topstep` in its output template.
3. Expose canonical completed outcomes matching `docs/OUTCOME-CONTRACT.md`.
4. Add persistent gateway idempotency and restart reconstruction before armed acceptance.
5. Add connection-generation and post-reconnect reconciliation state to packets.
6. Add verified protection ownership before enabling amendments.
7. Add an authenticated deterministic control surface if gateway mode changes should be driven from the profile; current `/trade` controls cognition only.

## Profile tasks after gateway maturity

- promote `MOVE_STOP`, `MOVE_TP`, partial `EXIT`, and multi-tranche `target_intent_id` in SOUL, skills, and cycle validation when gateway PM acceptance is green;
- add payout/account-phase context to prompts only after authoritative policy state exists;
- add native copier health and payout-unlink context;
- calibrate cognitive-overlay evidence thresholds from paper results;
- add Windows installation acceptance against the actual Hermes release.
