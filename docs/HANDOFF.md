# Codex handoff

## Current state

The repository contains a compiling and tested direct ProjectX scaffold. No external API call was executed during this implementation because no credentials or API sandbox were available.

Local verification performed:

```text
tsc --project tsconfig.json
node --test dist/tests/*.test.js
```

Result:

```text
21 tests passed
0 failed
```

The package registry was unavailable in the execution environment, so the Microsoft SignalR package itself was not downloaded or exercised. TypeScript compilation covered the adapter through its declared local interface; Codex must run `npm install` and compile against the actual package.

## Read first

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/TOPSTEP-POLICY.md`
4. `docs/THREAT-MODEL.md`
5. `src/risk/risk-engine.ts`
6. `src/projectx/client.ts`
7. `src/projectx/realtime.ts`
8. `src/execution/coordinator.ts`

## Immediate tasks

### 1. Install and verify the actual Microsoft SignalR package

Run:

```bash
npm install
npm run check
```

Remove the temporary `@ts-ignore` on the SignalR import after confirming package declarations and exact .NET/JS callback signatures.

### 2. Verify ProjectX payload contracts

Use a real API subscription in shadow mode. Capture sanitized examples for:

- login and validate
- account search
- available contracts
- open positions
- open orders
- each SignalR event
- reconnect behavior

Update parsers only from observed or official contracts. Do not make fields optional merely to suppress errors.

### 3. Add connection health and generation IDs

Current state completeness does not yet include hub connection state.

Add:

- `userHubConnected`
- `marketHubConnected`
- `lastUserEventAt`
- `lastMarketEventAt`
- `reconciliationGeneration`

Any disconnect must invalidate current entry packets. After reconnect, perform REST reconciliation before publishing a new executable packet.

### 4. Replace JSONL-only execution identity with SQLite

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

### 5. Implement provider bracket ownership proof

After an entry:

- wait for the entry order and fill event
- identify provider-created stop and target orders
- prove both quantity and side
- modify to exact structural prices if tick-distance anchoring differs
- fail closed and flatten if protection cannot be proven

Do not enable armed mode before this passes.

### 6. Implement automatic policy state

Replace manual environment values for:

- highest EOD balance
- MLL lock
- payout processed
- daily realized PnL
- entry window

with a versioned local policy state machine and explicit operator reconciliation against the Topstep dashboard where the API lacks fields.

### 7. Build the Hermes profile only after the gateway packet is stable

The profile must contain no ProjectX credentials and no execution tool. It should access only the authenticated local `/packet` and `/intent` surfaces through a narrow deterministic tool or worker.

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

These are explicit scaffolding boundaries, not hidden TODOs.
