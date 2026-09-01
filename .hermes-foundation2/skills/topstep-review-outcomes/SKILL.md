---
name: topstep-review-outcomes
description: Review canonical completed Topstep outcomes, execution receipts, fees, buffer impact, and decision quality.
---

# Review Outcomes

Review only canonical `glitch.topstep.trade_outcome.v1` records marked learning-eligible.

1. Join the outcome to its intent, decision packet, provider orders, fills, protection evidence, exit, realized PnL, fees, and supplied account-policy state using stable IDs.
2. Use authoritative v1.1 execution fields when present: `exit_reason`, `entry_price`, `exit_price`, `stop_price`, `target_price`, `mae_usd`, `mfe_usd`, `initial_risk_usd`, `r_multiple`, and `protection_confirmed`.
3. Separate cognitive quality from transport, policy, market-data, gateway, protection, or reconciliation defects. System defects are not strategy lessons.
3. Evaluate stop and target geometry, quantity, market path, timing, fees, slippage, adverse/favorable excursion when supplied, and the effect on real account buffer.
4. Evaluate payout progress only when authoritative fields are present. Do not infer winning days, MLL changes, or payout eligibility from incomplete data.
5. Preserve losses, rejected intents, unknowns, contradictions, and missing evidence. Never improve a result after the fact.

Produce one append-only episode with what worked, what failed, risk quality, plausible alternatives, lesson candidates, and uncertainty.
