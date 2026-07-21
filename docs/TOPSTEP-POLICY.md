# Topstep policy model

**Last verified:** July 21, 2026

This document distinguishes provider API facts from locally modeled firm rules. Topstep remains the final authority.

## API facts

Topstep officially permits automated strategies through TopstepX API Access for supported account stages and provides:

- live and historical market data
- direct order execution
- account, order, position, and trade streams
- custom risk logic
- one API subscription across linked TopstepX accounts

API trading must originate from the trader's personal device. Topstep currently prohibits VPS, VPN, and remote-server API trading. There is no separate API sandbox.

Source:

- https://help.topstep.com/en/articles/11187768-topstepx-api-access

## ProjectX facts

The documented trader API exposes:

- account ID, name, balance, tradability, visibility, and sometimes simulated/live status
- contracts with tick size and tick value
- positions
- open and historical orders
- trades, PnL, and fees
- quotes, prints, and market depth
- historical bars
- market entries with provider-side stop and target brackets

The public trader API does not currently document direct fields for:

- MLL floor
- payout eligibility
- winning-day progress
- consistency percentage
- scaling tier
- payout processing state
- call-up state

Glitch must model and reconcile those states locally.

Sources:

- https://gateway.docs.projectx.com/docs/realtime/
- https://gateway.docs.projectx.com/docs/api-reference/account/search-accounts/
- https://gateway.docs.projectx.com/docs/api-reference/order/order-place/

## Maximum Loss Limit model

### Trading Combine

Let:

- `S` = starting balance
- `D` = initial maximum loss allowance
- `H` = highest qualifying end-of-day balance

```text
floor = min(S, S - D + max(0, H - S))
```

### Express Funded Account

```text
floor = min(0, -D + max(0, H))
```

After the floor locks at zero or a payout establishes a zero floor:

```text
floor = 0
```

Current usable buffer:

```text
buffer = conservativeEquity - floor
```

Conservative equity marks longs at bid and shorts at ask, then subtracts fee and slippage reserves in trade-risk calculations.

The current implementation receives `H`, payout state, and lock state from configuration. This is temporary. Production code must persist EOD balances, reconcile them with the dashboard, and require an explicit correction event when local and provider states disagree.

Source:

- https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit

## Internal risk budget

Provider liquidation limits are not normal operating budgets.

```text
fractionBudget = currentBuffer * configuredRiskFraction
dailyRemaining = max(0, internalDailyRisk - realizedLossToday)
allowedRisk     = min(fractionBudget, dailyRemaining)
```

Trade risk:

```text
rawRisk = abs(referencePrice - stopPrice) * pointValue * quantity
risk     = rawRisk + slippageReserve + feeReserve
```

The intent is rejected when:

```text
risk > allowedRisk
```

## Compliance posture

Glitch TopTrader must not implement account stacking or disposable high-risk attempts. Topstep explicitly prohibits repeatedly blowing accounts through aggressive attempts and may deny payouts or close accounts for program-gaming behavior.

The business objective is consistent, responsible positive expectancy and account survival—not exploiting a nominal reset price.

Sources:

- https://help.topstep.com/en/articles/10305426-prohibited-trading-strategies-at-topstep
- https://help.topstep.com/en/articles/10296582-prohibited-conduct

## Account class

The user selects the account. The code does not need an elaborate paper/live abstraction.

The initial direct gateway still defaults to:

```text
GLITCH_REQUIRE_SIMULATED=true
```

This is a development guard, not the permanent product model. It can later be relaxed only through an explicit versioned promotion with venue evidence.
