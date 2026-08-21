---
name: topstep-release-pair
description: Paired armed promotion and rollback runbook.
---

# topstep-release-pair

Record exact gateway and profile SHAs in release artifacts.

Run: clean install, upgrade, rollback, path-with-spaces tests before armed promotion.

Rollback must preserve durable outbox/recovery state (TS-REAUDIT-12).
