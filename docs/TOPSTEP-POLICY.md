# Topstep policy evidence

**Last reviewed:** July 24, 2026

This document separates official provider facts, operator-confirmed account facts, local calculations, and trading judgment. Topstep remains the final authority.

## Product boundary

Glitch Topstep is tailored to Topstep accounts connected through the official ProjectX trader API. It does not import Apex rules, NinjaTrader assumptions, master/follower replication, or generic prop-firm policy.

The configured account and contract are the current acceptance scope, not a permanent MNQ strategy or account-class abstraction.

## Evidence authority

Every account-policy field must name its authority:

- `provider_reconciled` — derived from current provider/dashboard evidence and persisted with provenance;
- `operator_configured` — supplied by the human operator because the API does not expose the fact;
- unknown or contradictory facts remain explicit and must not be silently guessed.

Hermes receives these fields as evidence. Glitch uses only authoritative hard boundaries required to make order mutation factually safe.

## ProjectX evidence

The trader API currently provides account, contract, order, position, trade, quote, print, depth, and historical-bar surfaces. It does not expose every Topstep commercial-program field directly.

Account stage, payout state, scaling state, qualifying EOD balance, loss-floor lock, session deadlines, and related program facts therefore require a separate versioned policy-evidence pipeline. The current scaffold receives several of these facts through configuration. This is not production authority.

## Hard loss-floor model

The gateway currently supports three explicit models.

### Trading Combine end-of-day trail

Let:

- `S` = starting balance;
- `D` = initial maximum-loss allowance;
- `H` = highest qualifying end-of-day balance.

```text
floor = min(S, S - D + max(0, H - S))
```

### Express Funded end-of-day trail

Expressed relative to the starting balance, where `H` is the highest qualifying
end-of-day **profit**:

```text
relativeFloor = min(0, -D + max(0, H))
```

When authoritative evidence says the floor is locked at breakeven or a payout has
established that floor:

```text
relativeFloor = 0
```

### Frame

Both trailing models are converted into the same absolute frame as
`conservativeEquity` before use:

```text
floor = S + relativeFloor
```

This conversion is mandatory. `conservativeEquity` is a ProjectX account balance
plus unrealized PnL, so returning a relative floor to that consumer overstates
hard headroom by roughly the starting balance and effectively disables the
`hard_loss_floor_breach` rejection. `tests/mll.test.ts` pins the frame.

### Explicit reconciled floor

When a current authoritative source supplies the exact hard floor:

```text
floor = operatorOrProviderSuppliedFloor
```

The configuration must identify whether that value is operator-configured or provider-reconciled.

## Current hard headroom

```text
currentBuffer = conservativeEquity - hardLossFloor
```

Conservative equity marks longs at bid and shorts at ask.

`currentBuffer` is not a recommended risk budget. It is the remaining distance to an authoritative hard loss boundary.

## Protected trade calculation

```text
rawRisk = submittedStopTicks * tickValue * quantity
protectedRisk = rawRisk + slippageReserve + feeReserve
```

`submittedStopTicks` is the tick distance actually sent on the ProjectX bracket.
It is rounded away from the reference price, so pricing the requested stop level
instead would understate the risk the account bears whenever the reference price
is not tick-aligned.

Glitch rejects entry only when the current protected loss would reach or cross the hard loss floor, or when another factual execution invariant fails.

Glitch does not derive or enforce:

- a fixed percentage of buffer;
- a daily internal loss budget;
- a fixed quantity schedule;
- a daily profit target;
- a winning-day quota;
- an entry window invented by the builder;
- a simulated-only cognition rule.

Those are strategy or operator-policy choices unless Topstep exposes them as an authoritative hard order boundary.

## Contract capacity

The current configured `maxContracts` is treated as a hard account ceiling, not a sizing recommendation. Production must derive and version this value from authoritative current account-stage evidence.

Hermes remains responsible for selecting quantity. Glitch independently rejects quantity above the hard ceiling.

## Account and payout lifecycle

Production parity requires a canonical account-policy record containing at least:

- Topstep product and account stage;
- starting balance and current balance;
- current hard loss floor and its source;
- qualifying highest EOD balance;
- floor lock state;
- maximum contract tier;
- payout eligibility, pending, processed, and post-payout state;
- scaling state;
- required flat deadlines;
- holiday, early-close, timezone, and DST evidence;
- source URLs or provider evidence hashes;
- verification time and contradiction history.

No payout, scaling, funded-stage, or live-readiness claim may be inferred from account name, balance changes, or incomplete local state.

## Decision versus execution

Hermes may choose a decision from incomplete policy evidence. Glitch may refuse the resulting order mutation when a required hard execution fact cannot be proven.

That refusal must produce an explicit receipt. The attempted decision remains available to review and learning; the builder must not hide it behind an eligibility gate.
