## Symptom

`GatewayUserOrder` events can poison the user stream: `user_stream` → `degraded`, `lastError: Error:invalid_number:id`, `lastEventAt: null`. Hermes then sees `quote_stale` / `account_state_stale` and skips LLM cycles (`stale_gateway_quote`).

Observed **2026-07-29 ~20:27 UTC** immediately after an `ENTER_SHORT` submission (rejected 422 by ProjectX for bracket/OCO config).

## Root cause

`parseOrder` in `src/projectx/schemas.ts` uses `requiredNumber(input, "id")`. ProjectX SignalR payload delivered `id` as a **string**, not a number.

Stack (live gateway):

```
parseOrder → requiredNumber → invalid_number:id
GatewayUserOrder handler → recordAndApply → payloadFault → markStream degraded
```

## Proposed fix

Coerce numeric strings in `requiredNumber` (or a `coercedNumber` helper) when `typeof field === "string"` and `Number(field)` is finite — at minimum for provider `id`, `accountId`, and other ID fields on orders/positions/trades.

Undocumented alternate field names (`accountId` for account identity, `orderID`, `tradeId`, `positionId`) are **not** accepted until a sanitized live payload proves they occur on the wire. On user-stream parse faults, the gateway logs `userStreamPayloadFaultDetail` (field keys + id `typeof` only).

## Workaround

Restart gateway (`start.ps1`) reconnects user stream; degrades again on next string-id order event.

## Related

- Runtime incident tied to ENTER_SHORT bracket rejection (operator: enable **Auto OCO Brackets** in TopstepX; gateway uses tick-distance brackets on `placeOrder`).
