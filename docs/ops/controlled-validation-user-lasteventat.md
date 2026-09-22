# Controlled validation gates — `user.lastEventAt` note

Date: 2026-09-22

## Observation

On the 2026-09-22 controlled validation, after restart the user hub reported
`state=connected` with `lastEventAt=null` while the account was flat
(`positions=[]`, `openOrders=[]`). Market hub had a recent `lastEventAt`.

## Contract today

`src/projectx/stream-subscriptions.ts` proof failures require:

- `userStream.state === "connected"`
- `marketStream.state === "connected"`
- `marketStream.lastEventAt` present

They do **not** require `userStream.lastEventAt` for connection-health proof.

## Gate policy (unchanged)

`evaluateControlledValidationGates` still **fail-closes** when
`user_stream_recent_events` is false (including `lastEventAt=null`).

Flat-idle null `lastEventAt` is therefore documented as a known tension with
field observations, but it is **not** an automatic pass. A separate contract /
product decision is required before any flat-idle exemption.
