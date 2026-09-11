# Independent account preflight and packet timeout diagnosis

Captured: `2026-09-11T18:12:42Z`

Status remains: `blocked` + `needs-human-review` + `shadow-only`.

No restart, smoke, order, sizing, or configuration change was performed.

## Independent account preflight

Command:

```text
python scripts/gateway-account-preflight.py --profile-root <canonical-profile> --output <evidence>
```

The preflight did not call `/packet` and did not use cached packet evidence.
It queried authenticated `/health`, `/state`, and `/ownership`.

Observed:

- `/health`: HTTP 200;
- `/state`: HTTP 200;
- `/ownership`: HTTP 200;
- account open quantity from `/state`: `0`;
- `unprotected_open_quantity`: `0` from non-packet state/ownership health data;
- recovery blocking flags: false;
- no active local PRAC owner or evaluation lease;
- gateway/profile pairing matched;
- gateway commit: `64469847c0df58f468717e46a23204a982a1d222`;
- profile commit: `041f60b9eb6a3591d9e9de2195ebe68bb192a044`;
- paired-contract SHA256: `83992e681f3ea0784667f36dae509e1f04e96318cc61fed5b0e58f5b22d8897a`.

The preflight returned `safe_pre_restart=false` and exit code `2` because:

- reconciliation freshness could not be confirmed from the current health
  response;
- no valid current user-stream event timestamp was available;
- the authenticated state did not expose explicit
  `gateway_supervised_overnight=false`;
- delivery-disabled state was not explicitly provable from the returned
  semantic fields.

These are deliberate fail-closed results. Flatness is confirmed independently
for this capture, but that does not authorize a restart while freshness and
operational-mode assertions are unavailable.

Evidence JSON:
`gateway-account-preflight-20260911T181226Z.json`

## `/packet` timeout diagnosis

The existing source audit and sanitized incident evidence identify the hot
path as:

`active position scope → ensurePacketMarketObservationFresh → refreshForPacket / market observation refresh → packet construction`

The bounded observation-refresh budget is 4 seconds, but the refresh promise
continues in the shared serial `UniverseRefreshQueue` after the race returns.
Previous incident evidence recorded 55–76 second `__all__` refresh jobs,
coalesced MNQ waiters, ProjectX `retrieveBars` and `Trade.search` timeouts,
SignalR disconnects, and event-loop starvation. This explains why an 8-second
client timeout can occur even though the isolated refresh unit tests respect a
4-second budget.

The current log tail also shows repeated partial-BBO rejection
(`quote_bbo_incomplete`) and a ProjectX trade-search timeout/retry. The read
circuit breaker was not open. No evidence attributes the timeout to an order
write or mutation.

Prior supporting evidence:

- `docs/evidence/gateway-diagnosis/2026-09-09-v11-packet-timeout-investigation-20260909T110547Z/investigation-report.json`
- `docs/evidence/gateway-diagnosis/2026-09-08-packet-partial-investigation-20260908T230112Z/investigation-report.json`
- `docs/evidence/gateway-pre-smoke-20260911/gateway-diagnosis-pre-20260911T175811Z.json`

The remaining unresolved item is a fresh semantic reconciliation/user-stream
timestamp and explicit operational-mode fields. Until those are available,
the restart gate must remain false.

## Code and validation

Added the read-only independent preflight:

- `scripts/gateway-account-preflight.py`
- `scripts/test_gateway_account_preflight.py`

Focused tests: `3 passed`.

`npm run check`: `667 passed, 0 failed, 0 skipped`.

No profile files were changed. No credential or `.env` content was recorded.
