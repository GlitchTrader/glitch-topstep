# Glitch Topstep authority contract

## Purpose

Glitch Topstep exists to equip an AI trading operator with truthful TopstepX/ProjectX evidence and reliable execution tools. It is not a deterministic strategy hidden behind Hermes.

## Roles

```text
Alan   = human operator; may exercise judgment and may make mistakes
Hermes = AI operator; may exercise judgment, trade, learn, and may make mistakes
Glitch = Codex-owned execution system; must not induce either operator into error
ProjectX = venue account, order, position, fill, and market transport truth
Topstep = final account-rule and commercial-program authority
```

The builder is accountable for Glitch's factual correctness. A model decision can be wrong. A human decision can be wrong. Glitch may not misstate data, apply the wrong identity, mutate the wrong order, silently lose protection, duplicate an intent, or report healthy state when its dependencies disagree.

## What Hermes owns

Hermes owns:

- whether an edge exists;
- direction, timing, quantity, stop, target, and management intent;
- interpretation of regime, structure, volatility, flow, and uncertainty;
- whether imperfect evidence is sufficient for a decision;
- trade review, hypothesis formation, learning, contradiction, promotion, and rollback;
- the choice to enter, hold, exit, or do nothing.

Glitch must expose evidence clearly. It must not convert that evidence into a second strategy.

## What Glitch owns

Glitch owns:

- authenticated ProjectX connectivity;
- account and contract identity binding;
- schema and transport validation;
- exact tick, point-value, fee, and bracket calculations;
- current order, position, fill, quote, and connection truth;
- hard Topstep account capacity and hard loss-floor survival;
- idempotent order mutation;
- native protection, reconciliation, restart recovery, journaling, and attribution;
- explicit evidence whenever it cannot prove a fact.

## Permitted deterministic rejection

Glitch may reject an executable intent when execution would be factually invalid or unsafe because of the software layer itself, including:

- unknown, expired, or mismatched decision identity;
- wrong account, contract, instrument, or provider identity;
- malformed schema or impossible numeric geometry;
- stale, disconnected, contradictory, or unreconciled venue state;
- quantity above an authoritative hard contract ceiling;
- protected downside reaching an authoritative hard loss floor;
- an order mutation whose ownership cannot be proven;
- duplicate or transport-ambiguous execution;
- inability to prove native protection.

A rejection must be explicit, attributable, append-only, and available to learning.

## Forbidden deterministic policy

Glitch must not encode or enforce:

- a directional thesis or market regime preference;
- a fixed strategy, indicator trigger, setup checklist, or entry score;
- an arbitrary risk percentage, daily profit target, trade quota, or frequency target;
- paper-versus-live classification as a cognitive rule;
- a rule that incomplete history automatically means no model call;
- a rule that a capacity, buffer, policy, confidence, or quality field automatically decides the trade;
- a learning approval gate based on one builder's preferred strategy;
- Apex, replication, master/follower, NinjaTrader, or generic prop-firm assumptions in the Topstep core.
- wall-clock TTL, callback delay, retry count, or resume counter as authority to resubmit or terminalize an intent;
- time-based recovery-close or visibility-pending shortcuts that bypass provider reconciliation.

Operator controls such as `disabled`, `shadow`, and `armed` are explicit human authority over order mutation. They are not market strategy.

Ambiguous provider transport remains nonterminal until custom-tag, historical order search, or authoritative position truth reconciles the outcome. Reconciliation timers may observe stale state; they must not authorize duplicate exposure.

## Evidence semantics

Every packet field is evidence unless it names an objective execution capability or hard venue/account boundary.

- `data_quality` describes what Glitch can currently prove.
- `policy.authority` states where account-rule facts came from.
- `current_buffer_usd` is hard loss-floor headroom, not a recommended trade budget.
- `maximum_additional_contracts` is a venue/account ceiling, not a sizing recommendation.
- gateway rejection is an outcome episode, not a reason to hide the attempted decision.
- rolling tape, trade count, spread, depth, imbalance, volatility, and session structure remain evidence for Hermes; none independently authorizes or forbids an entry.

## Topstep-first boundary

This edition is tailored to Topstep. It must follow current Topstep and ProjectX contracts from primary sources and observed runtime payloads. It must not import NinjaTrader implementation constraints or Apex-specific logic.

The selected account and contract are the current acceptance scope, not a permanent MNQ strategy. Additional Topstep-supported products should reuse the same venue-neutral observation, intent, execution, and outcome contracts.

## TS-AUDIT-03 decision: quiet tape

Full spec, acceptance criteria, and non-goals: [`docs/specs/TS-AUDIT-03.md`](specs/TS-AUDIT-03.md). This section states the durable authority rationale; the spec file states the point-in-time change.

A 60-second window with zero prints is not an execution boundary. It does not invalidate the selected account, contract, quantity, bracket, venue state, ownership, or protection. The observation remains in `order_flow` so Hermes can judge whether the market is too thin, inactive, or simply between prints.

Applied to the change test:

1. It does not prevent Glitch from causing a factual execution error.
2. It is not an authoritative Topstep or ProjectX prohibition.
3. The measurement can be recorded precisely without becoming a gate.
4. Removing the gate merely allows Hermes to exercise judgment.

Therefore `order_flow_no_trades_60s` belongs in cognition and is not part of `armed` execution admission.

## Change test

Before adding a deterministic rule, ask:

1. Does this prevent Glitch from causing a factual execution error?
2. Is the boundary authoritative and observable?
3. Can the reason be recorded precisely?
4. Would removing the rule merely allow Hermes to exercise judgment?

If the answer to question 4 is yes while questions 1–3 are no, the rule belongs in cognition, not Glitch.
