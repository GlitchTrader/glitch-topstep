---
name: topstep-supervisor-ledger
description: Maintain append-only Topstep debrief, guidance, planning, daily-journal, and cognitive-candidate streams.
---

# Supervisor Ledger

- Keep episodes, hourly reviews, guidance, plans, daily journals, cognitive candidates, and corrections in separate append-only streams.
- `build-requests.jsonl` holds Codex handoff records (`proposed` until the operator explicitly approves).
- `observations.jsonl` holds evidence-linked analysis and health findings.
- Preserve stable identifiers and source outcome IDs.
- Replace only explicit current-pointer files such as `current-plan.json` and `current-guidance.json`; their historical streams remain append-only.
- Distinguish strategy findings from gateway, transport, provider, rule, or data defects.
- Record unresolved contradictions rather than selecting a convenient version of truth.
- Never write provider credentials, JWTs, numeric account IDs, or numeric contract IDs to Hermes ledgers.
