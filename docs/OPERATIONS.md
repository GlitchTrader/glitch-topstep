# Operations

## Deployment rule

Run on the trader's personal local device. Do not deploy this Topstep adapter to a VPS, VPN, remote server, or centralized cloud executor.

A commercial product should install a customer-side gateway and keep credentials local.

## One-account beta pair (TS-BETA-01)

Immutable candidate baseline: [`docs/evidence/TS-BETA-01-immutable-baseline-2026-08-04.md`](evidence/TS-BETA-01-immutable-baseline-2026-08-04.md).

Pin: gateway **0.1.3** (`c83a22f`) + Hermes profile **0.1.13** (`a7f37a6`) on the named PRAC account/MNQ. Status stays candidate until the operator signs the promotion block in that file.

## Initial configuration

1. Link TopstepX to ProjectX.
2. Purchase ProjectX API Access.
3. Generate an API key in TopstepX settings.
4. Copy `.env.example` to `.env`.
5. Set exact account and active contract identifiers.
6. Keep `GLITCH_TRADING_MODE=shadow`.
7. Keep `GLITCH_ENTRY_WINDOW_OPEN=false` until a session-policy service is implemented.
8. Run `npm run check` and `npm start`.

## Epoch / account reset checklist

Do this **every** time you reset epoch state or switch to a new Topstep/PRAC account. New accounts often default to Position Brackets; protected API entries then fail with `Brackets cannot be used with Position Brackets`.

1. **Enable Auto OCO Brackets** on the account in TopstepX (disable Position Brackets if both appear).
2. Confirm account ID / name / contract / loss-floor fields in gateway `.env`.
3. Confirm `GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH` points at Hermes `state/outcomes.jsonl`.
4. Restart gateway; prove `/health` is `armed` or `shadow` as intended and `state_complete=true`.
5. Run one protected round-trip (ENTER → fill → flat) before trusting learning/outcomes.

## Shadow acceptance

Before any armed test, prove:

- the configured account ID and name resolve uniquely
- the configured contract is active
- REST positions and orders match the TopstepX UI
- SignalR quote, order, position, and trade events arrive
- reconnect resubscription works
- no event gap is silently accepted
- `/packet` remains stable until authoritative state changes
- malformed and wrong-account intents fail
- valid entries are journaled as shadowed
- stop-aware risk matches an independent spreadsheet
- MLL floor matches the Topstep dashboard

## Armed acknowledgement

The scaffold requires:

```text
GLITCH_TRADING_MODE=armed
GLITCH_ARMED_ACK=I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY
```

This exists only to prevent accidental activation. Do not use it as a substitute for the handoff gates.

## Local API

All sensitive endpoints require:

```text
Authorization: Bearer <GLITCH_LOCAL_TOKEN>
```

Keep the server bound to `127.0.0.1`. Do not expose port 8790 to the LAN or internet.

## Secret handling

- never commit `.env`
- never send the API key to Hermes
- never write the API key or JWT to logs
- store production secrets in the local OS credential store
- rotate the API key after any suspected exposure
- ensure ledger payloads cannot contain authorization headers

## Failure behavior

The correct default is no new entry.

No entry when:

- REST login or session validation fails
- either SignalR hub is disconnected or unreconciled
- account, position, order, or quote state is stale
- state completeness is false
- account identity differs from configuration
- contract identity differs from configuration
- the decision snapshot hash differs
- session policy is closed or unknown
- monetary risk exceeds budget
- working orders or an existing instrument position are present in the initial implementation

Risk-reducing exits should remain available after the corresponding ownership and stale-state rules are explicitly implemented.
