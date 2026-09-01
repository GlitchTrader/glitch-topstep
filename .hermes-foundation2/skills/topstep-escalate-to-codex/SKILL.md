---
name: topstep-escalate-to-codex
description: Turn a Hermes supervisor finding into a bounded, approval-gated Codex build request for the Topstep profile or gateway.
---

# Escalate to Codex

Use only from Hermes chat when analysis shows a source-controlled change is needed in the Topstep Hermes profile, gateway repo, or docs.

1. Record the finding in `state/supervisor/observations.jsonl`.
2. Append one `glitch.topstep.supervisor.build_request.v1` record to `state/supervisor/build-requests.jsonl` with status `proposed`.
3. State the exact files/scope, acceptance criteria, evidence episode IDs, and rollback.
4. Wait for explicit operator approval before changing status to `approved`.

An approved request is available to a separately invoked builder. It does not schedule Codex, run trading cycles, poll market data, or imply approval from a recommendation. Hermes trading remains independent while a request is pending or being built.

Never include ProjectX credentials, JWTs, numeric account IDs, or numeric contract IDs in build requests or observations.
