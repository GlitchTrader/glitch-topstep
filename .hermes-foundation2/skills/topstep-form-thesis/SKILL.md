---
name: topstep-form-thesis
description: Form a falsifiable short-horizon market hypothesis and structural invalidation from bounded gateway evidence.
---

# Form Thesis

Judge bull, bear, and flat cases from current observable evidence. Aggressive and conservative cases are perspectives, not separate strategies.

## Regime labels

State one explicit regime label from packet evidence:

- `TREND_UP` — aligned higher-timeframe location and slope support continuation higher.
- `TREND_DOWN` — aligned higher-timeframe location and slope support continuation lower.
- `CHOP` — overlapping structure, conflicting slopes, or mid-range location without directional edge.
- `LOW_LIQUIDITY` — thin tape or sparse order-flow windows; reduce conviction and prefer smaller size or NOTHING.
- `DATA_DEGRADED` — incomplete state, `data_quality.issues` (including `quote_clock_skew` or `order_flow_depth_unavailable`), observation or order-flow `last_error`, stale quotes, or `CURRENT_CYCLE.continuity_gap.present`.

## HTF hierarchy

Prefer the 60m timeframe for regime and location: `range_position_20` extremes plus `ema_20_slope_bps` and `ema_50_slope_bps`. Use 5m for local structure and 1m for immediate timing and invalidation. Timeframes are complementary descriptions, not a mandatory confirmation stack. A valid short-horizon thesis may exist when they conflict; conflict lowers confidence and may require smaller quantity or a different stop, but does not automatically force `NOTHING`.

## Participation breadth

Evaluate the local hypotheses that fit the current evidence: continuation, pullback, breakout, failed breakout, short mean reversion, and transition. Do not require a named pattern or every hypothesis to be checked. Select `ENTER_LONG` or `ENTER_SHORT` when one hypothesis has a locally timely path, a favorable participation condition, a structural invalidation beyond normal one-minute noise, a reachable target within the next five minutes, and bounded positive expectancy after fees and slippage reserve.

For a flat decision, answer four questions in the audit:

1. What is the most likely path over the next five minutes?
2. Is the move initiating, progressing, or exhausting?
3. What observable condition would make participation favorable now, even if higher timeframes are mixed?
4. What exact structure would invalidate the thesis before reward is considered?

A retest, closed candle, sustained multi-window flow, or complete timeframe alignment may strengthen a thesis, but none is a universal entry gate. Do not replace missing evidence with assumptions; weigh the evidence that is actually present.

## Flat participation checklist (before NOTHING)

When flat and considering deliberate inaction, complete this checklist in `decision_audit` fields:

1. **Long trigger** — what price, structure, reclaim, or tape behavior would justify `ENTER_LONG`?
2. **Long invalidation** — what nearby structure falsifies the long case?
3. **Short trigger** — what price, structure, sweep, or tape behavior would justify `ENTER_SHORT`?
4. **Short invalidation** — what nearby structure falsifies the short case?
5. **Location** — is price at a range edge (`range_position_20` near 0 or 1, session extreme, prior pivot) or mid-range? If mid-range in `CHOP`, do not manufacture a trade.
6. **Failed continuation** — if a continuation attempt just failed, compare reversal vs renewed continuation on the same evidence; neither side is automatic.
7. **Asymmetry** — if one side has materially better bounded asymmetry, prefer the smallest supported quantity in `execution.valid_entry_quantities` rather than waiting for perfect confirmation.

When `recent_frames` is non-empty, open `decisive_evidence` with `prior_hypothesis=<CONFIRMED|INVALIDATED|PARTIALLY_CONFIRMED|UNCHANGED>` and cite material deltas from `cycle_evidence_delta` when present. Rewrite `change_condition` when `ledger_repetition_guidance` warns of stale wording.

`NOTHING` confidence must reflect evidence quality, not comfort. Symmetric, usable data with no edge belongs in **0.70–0.85**, not **0.95+**.

## Confidence for NOTHING

- Use confidence **0.95+** for NOTHING only when data is invalid or execution facts forbid action (`DATA_DEGRADED`, clear blocking `data_quality.issues`, or `new_exposure_technically_supported=false` when flat).
- Use **0.70–0.85** for NOTHING when structure conflicts, chop dominates, or evidence is symmetric but data is usable.
- Do not inflate NOTHING confidence merely because no trade feels comfortable.

## Price zones

Do not cite hardcoded price bands (e.g. "28010–28015") unless `reference_levels` or equivalent structural levels are present in the packet. Use supplied features, session range, and observation features instead.

## Thesis rules

1. When flat, state the most likely next-five-minute path and its concrete invalidation. When positioned, state the most likely next-one-minute path and choose among `HOLD`, `MOVE_STOP`, `MOVE_TP`, partial or full `EXIT`, and scale-in only when `execution.supported_actions` includes the matching `ENTER_*` action.
2. Consider continuation, pullback, breakout, mean reversion, scalp, and transition hypotheses without requiring a named archetype.
3. Define invalidation before reward. Place the absolute stop beyond relevant structure and normal noise, not at an arbitrary offset or cosmetic reward/risk point.
4. Select a target reachable within the stated horizon and regime. If structural risk is too large, choose a smaller quantity or NOTHING.
5. Do not force activity because a payout threshold, daily target, or prior plan exists. When `daily_economics` is present, weigh band position and stage (`policy.account_stage`) in the audit: approved accounts may favor preservation in the upper band; evaluation may continue when edge remains. Null mirror fields are unknown — never invent PnL. Preserve account survival, rule compliance, and evidence quality.
6. After a stop, require materially changed price or evidence before re-entry. Repeating the same thesis near the same level is churn.
7. HOLD is not passive certainty. If the prior `change_condition` has occurred, choose `MOVE_STOP`, `MOVE_TP`, `EXIT`, or explain genuinely new evidence that invalidates the old trigger.
8. `HOLD` and `NOTHING` carry the same burden of proof as every other action. When current evidence satisfies the prior review's `change_condition`, choose the newly supported action or identify genuinely new contrary evidence; price following the forecast is not sufficient reason to move the threshold.
9. Treat a flat `NOTHING` as active observation: preserve the developing path, favorable participation condition, and invalidation in `decisive_evidence`, `disconfirming_evidence`, and `change_condition`. Later learning may classify the matured decision, but must never invent counterfactual fills or PnL.

Choose `ENTER_LONG`, `ENTER_SHORT`, `HOLD`, `MOVE_STOP`, `MOVE_TP`, `EXIT`, or `NOTHING`. Pass only a compact factual audit; never reveal private chain-of-thought.
