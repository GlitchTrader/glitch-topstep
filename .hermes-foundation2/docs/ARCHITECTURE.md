# Architecture

## Runtime boundary

The profile is the cognition package. The Node gateway is the ProjectX adapter and factual execution authority. Neither layer contains a deterministic trading strategy.

```text
Glitch Topstep Node service
  GET /health   truthful dependency state
  GET /state    current account and venue evidence
  GET /packet   sanitized decision evidence
  POST /intent  factual execution verification and delivery
       │ bearer-authenticated localhost
       ▼
Python operator launcher
  return native cron immediately
  start one separately locked worker
       │
       ▼
Python operator worker
  capture available frame history
  invoke an isolated Hermes session when scheduled
  normalize and validate exact wire identity
  persist outbox before delivery
       │
       ▼
Hermes model
  observe · reason · choose · review · learn
  memory retrieval only during the trading cycle
  no terminal, browser, MCP, file, or provider toolsets
       │ strict glitch.intent.v2
       ▼
Python worker → local gateway → ProjectX
```

The Node service owns all ProjectX authentication. The profile sees only a sanitized account alias, contract description, market evidence, policy evidence, data-quality evidence, and current execution capabilities.

## Authority

```text
Hermes decides.
Glitch verifies factual execution safety, translates, reconciles, journals, and protects.
ProjectX owns venue truth.
Topstep owns final account-rule authority.
```

The worker validates schema, fixed identity, finite values, entry field completeness, and basic directional geometry. It does not enforce a strategy, a risk percentage, a daily quota, an eligibility flag, or a supplied quantity list. Current gateway rejection remains visible as an attributable outcome episode.

## Decision cadence

Native Hermes cron runs every minute and launches the worker without waiting for model latency. By default, the worker considers one isolated decision every minute while flat or positioned. `GLITCH_TOPSTEP_FLAT_DECISION_INTERVAL_MINUTES` may reduce flat-book observation frequency, but it is scheduling only and never a statement that a trade is permitted or forbidden.

Operator directives may wake a cycle. While positioned, the worker invokes Hermes with every available recent frame. While flat, the worker waits until `GLITCH_TOPSTEP_DECISION_FRAME_COUNT` minute frames exist (default **5**) before the first model call. That flat warmup is scheduling continuity, not a cognition veto: once the window is full, Hermes receives compact frame snapshots plus the current decision packet and may still choose NOTHING on thin evidence.

## Truth and degradation

A gateway packet may explicitly report incomplete, stale, reconnecting, or contradictory venue state. Hermes may still reason about that evidence and choose an intent. The gateway independently refuses order mutation when it cannot prove factual execution safety.

This separation prevents two failure modes:

- hiding a strategy inside deterministic code;
- allowing the infrastructure to execute from false or unreconciled venue truth.

## Decision persistence

For every gateway packet:

```text
attempts/<packet>.json   model-call lifecycle
outbox/<packet>.json     validated intent persisted before delivery
receipts/<packet>.json   gateway response
decisions.jsonl          append-only cognition record
receipts.jsonl           append-only delivery record
events.jsonl             failures and corrections
```

A packet cannot trigger a second model call after an attempt record exists. An existing outbox may be delivered again only while the gateway still accepts its exact issued snapshot identity.

## Learning

The 30-minute cron job launches a separately locked process and returns immediately. The learning worker syncs gateway outcomes on every run, independent of the direct decision cron, and calls Sol only when canonical evidence makes a loop due:

- debrief new canonical outcomes;
- hourly review when new episodes exist;
- five-hour plan when new reviews exist;
- daily journal after the session when episodes exist.

Learning consumes only `glitch.topstep.trade_outcome.v1`. Position disappearance, account-balance changes, and local guesses are not accepted as completed-trade truth.

Cognitive changes are written as candidates by default. Automatic persisted-overlay activation is a configurable operational choice, not permission for the gateway or builder to become the trading strategist.
