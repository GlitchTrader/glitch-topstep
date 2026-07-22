# Codex handoff

## Current state

The repository contains a compiling and tested direct ProjectX scaffold. No external API call was executed during the initial implementation because no credentials or API sandbox were available.

The companion cognition package now exists in:

```text
GlitchTrader/glitch-topstep-hermes-profile
profile: glitch-topstep
```

The gateway packet template and intent parser enforce that exact profile identity.

Initial local gateway verification performed:

```text
tsc --project tsconfig.json
node --test dist/tests/*.test.js
```

Initial result before profile alignment:

```text
21 tests passed
0 failed
```

The first GitHub Actions run also installed Microsoft SignalR and passed `npm run check`.

## Read first

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/TOPSTEP-POLICY.md`
4. `docs/THREAT-MODEL.md`
5. `src/domain/operator.ts`
6. `src/risk/risk-engine.ts`
7. `src/projectx/client.ts`
8. `src/projectx/realtime.ts`
9. `src/execution/coordinator.ts`
10. the companion profile's `docs/HANDOFF.md`

## Immediate gateway tasks

### 1. Verify ProjectX payload contracts

Use a real API subscription in shadow mode. Capture sanitized examples for:

- login and validate
- account search
- available contracts
- open positions
- open orders
- each SignalR event
- reconnect behavior

Update parsers only from observed or official contracts. Do not make fields optional merely to suppress errors.

### 2. Add connection health and generation IDs

Current state completeness does not yet include hub connection state.

Add:

- `userHubConnected`
- `marketHubConnected`
- `lastUserEventAt`
- `lastMarketEventAt`
- `reconciliationGeneration`

Any disconnect must invalidate current entry packets. After reconnect, perform REST reconciliation before publishing a new executable packet.

### 3. Replace JSONL-only execution identity with SQLite

Implement:

- migrations
- intent unique index
- packet table
- outbox table
- order groups
- provider orders
- fills
- state transitions
- reconciliation events

Persist the outbox before `Order/place`. Reconcile ambiguous transport failures by custom tag before retrying.

### 4. Implement provider bracket ownership proof

After an entry:

- wait for the entry order and fill event
- identify provider-created stop and target orders
- prove both quantity and side
- modify to exact structural prices if tick-distance anchoring differs
- fail closed and flatten if protection cannot be proven

Do not enable armed acceptance before this passes.

### 5. Implement automatic policy state

Replace manual environment values for:

- highest EOD balance
- MLL lock
- payout processed
- daily realized PnL
- entry window

with a versioned local policy state machine and explicit operator reconciliation against the Topstep dashboard where the API lacks fields.

### 6. Publish canonical completed outcomes

The profile learning worker accepts only:

```text
glitch.topstep.trade_outcome.v1
```

Implement a canonical append-only outcome stream containing stable intent/outcome identity, fills, protection evidence, realized PnL, fees, buffer impact, and explicit `learning_eligible`. Do not make the profile infer completed trades from balances or position disappearance.

### 7. Perform installed profile integration

With the gateway in shadow mode:

1. install `glitch-topstep-hermes-profile`;
2. use the same local bearer token in both repositories;
3. run profile setup and confirm both jobs start paused;
4. run `/topstep_status`;
5. run `/trade`;
6. prove a five-frame flat cycle produces one strict intent and a shadow receipt;
7. prove a positioned packet invokes each minute and permits only HOLD or EXIT;
8. prove `/pause_trading` stops model calls;
9. prove `/flatten_all` produces a strict risk-reducing EXIT receipt.

## Known deliberate limitations

- one configured account
- one configured contract
- one entry tranche
- no `MOVE_STOP` or `MOVE_TP`
- in-memory duplicate set
- manually supplied MLL lifecycle inputs
- manually supplied entry-window state
- no ProjectX sandbox
- no native copier management
- no LFA continuity solution
- profile learning awaits the canonical outcome stream

These are explicit scaffolding boundaries, not hidden TODOs.
