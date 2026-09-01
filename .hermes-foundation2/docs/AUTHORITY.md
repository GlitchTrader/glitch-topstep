# Operator authority contract

## Roles

```text
Alan   = human operator; may use judgment and may make mistakes
Hermes = AI operator; may use judgment, trade, learn, and may make mistakes
Glitch = builder-owned infrastructure; must not induce either operator into error
```

Hermes is not a suggestion engine behind a deterministic strategy. The profile exists to give Hermes current evidence, relevant memory, useful trading skills, and a reliable path to the local gateway.

## Cognition owned by Hermes

Hermes owns:

- whether an edge currently exists;
- direction, timing, quantity, stop, target, hold, exit, and no-action judgment;
- interpretation of incomplete or contradictory evidence;
- regime adaptation without a fixed strategy;
- trade review, hypothesis formation, learning, contradiction, promotion, revision, and rollback.

No worker function may convert packet metadata into an invisible second strategy.

## Validation owned by the profile worker

The profile worker may validate only what is necessary for a truthful wire handoff:

- exact packet, account alias, instrument, operator profile, and snapshot identity;
- strict JSON schema and known fields;
- finite confidence and prices;
- positive integer entry quantity;
- complete MARKET entry fields;
- stop and target on the correct directional sides of current reference price;
- explicit human forced-direction directives.

The worker must not reject a decision merely because:

- fewer than five frames are available;
- gateway data quality is incomplete;
- the packet says new exposure is not currently supported;
- a supplied capacity or buffer value is small;
- the account is simulated or live;
- a preferred indicator, setup, regime, confidence, risk percentage, or daily target is absent;
- the operator is currently positioned and proposes an action the gateway has not implemented yet.

The gateway receives the attributable intent and performs current factual execution verification. Unsupported or unsafe execution becomes an explicit receipt.

## Learning

Hermes may learn. The builder must not require permission for ordinary cognition or turn one preferred lesson into hard execution policy.

Durable memory still requires truthful attribution. Completed canonical outcomes are stronger evidence than balance changes, position disappearance, transport errors, or local guesses. Persisted overlays default to proposed state so they remain inspectable and reversible.

Duplicate intent UUID retries are gateway-owned replay. The profile must not resubmit a changed body under the same `intent_id` or use wall-clock TTL, callback delay, or retry counters to bypass gateway reconciliation.

## Scheduling

Cadence controls when Hermes observes and decides. It does not define whether the market is tradable. The default flat and positioned cadence is every minute. Operators may explicitly reduce flat cadence for cost or attention reasons without changing trading eligibility. `GLITCH_TOPSTEP_DECISION_FRAME_COUNT` controls only how many recent frames are supplied as context; it never suppresses a model call. A first available frame, unchanged evidence, stale quotes, incomplete history, and data-quality warnings remain evidence for Hermes whenever cadence invokes the cycle.

## Daily economics

When the gateway publishes `daily_economics`, Hermes may use intraday PnL mirrors and calibration bands for cognition (eval target progress, approved-account preservation). Glitch must never reject `ENTER_*` solely because daily PnL crossed a band. See `docs/specs/GTHP-017.md` and gateway `docs/specs/TS-R3-04.md`.

## Builder responsibility

Codex owns the reliability of the profile distribution, launcher, persistence, schema validation, and delivery. Failures must be visible, append-only, and recoverable. Codex must not choose the trade.
