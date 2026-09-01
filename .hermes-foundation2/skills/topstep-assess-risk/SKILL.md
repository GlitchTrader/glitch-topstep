---
name: topstep-assess-risk
description: Assess Topstep buffer, deterministic risk allowance, account state, and execution capacity from the current gateway packet.
---

# Assess Risk

Use the current packet as the sole risk authority. Incomplete or degraded evidence is information to declare in the audit—not an automatic cognitive veto before reasoning. The gateway may still reject execution on hard factual invalidity.

1. Read `data_quality.state_complete` and `data_quality.issues` as **execution-critical** venue completeness (streams, quote/state age). Read `data_quality.optional_issues` (e.g. `order_flow_depth_unavailable`) as missing optional evidence — never treat optional gaps as an entry veto when `execution.new_exposure_technically_supported` is true. Also read `account.can_trade`, quote freshness (`quote_age_ms`), `execution.new_exposure_technically_supported`, `execution.gateway_mode`, and `execution.gateway_mode_downgrade_reason` as factual context. State blocking reasons explicitly when they exist; do not silently forbid cognition when evidence is imperfect but still usable.
2. Treat nominal account size as a program label, not available loss capital. The meaningful risk state is the supplied liquidation floor, conservative equity, current buffer (`policy.current_buffer_usd`), deterministic allowed risk, daily risk state, and `policy.max_contracts`.
3. When `daily_economics` is present, read `trading_day_id`, `realized_pnl_usd`, `unrealized_pnl_usd`, `net_daily_pnl_usd`, `net_daily_pnl_pct`, `calibration_band_pct`, and optional `profit_target_remaining_usd` as labeled mirrors only. Compare band position for calibration (“was today well-sized?”), not as a gateway veto. Evaluation stages may press toward `profit_target_remaining_usd` when edge remains; approved stages may prioritize preservation inside the upper band. Null fields mean unknown — do not invent dashboard truth.
4. Choose quantity as a positive integer up to `policy.max_contracts` and `execution.maximum_additional_contracts`. The gateway computes admissibility from current account-wide exposure and policy. Never invent fallback capacity.
5. Define a structural absolute stop before choosing quantity. Check that the proposed geometry is plausible and that the chosen quantity does not conflict with the packet's allowed risk context. Glitch performs final monetary validation.
6. The gateway supports protected entries, scale-in when advertised in `execution.supported_actions`, `HOLD`, exact-leg `MOVE_STOP`, exact-leg `MOVE_TP`, partial or full `EXIT`, and `NOTHING`. When positioned, manage actively from current evidence; do not treat `HOLD` as the default. Use `protection.tranches` and `target_intent_id` when more than one tranche remains open. Read `protection.protection_status`: only `confirmed` supports `MOVE_STOP`/`MOVE_TP`; `pending` favors `HOLD` while brackets land; `failed` or `unknown` require explicit failed-protection reasoning and prioritize risk-reducing `EXIT`.
7. Stale quotes, incomplete state, observation `last_error`, or order-flow `last_error` reduce confidence and must be named in the audit. They do not automatically replace symmetric evaluation of `ENTER_LONG`, `ENTER_SHORT`, and `NOTHING` unless hard execution facts make new exposure impossible. Risk-reducing EXIT remains preferable when current ownership is unambiguous.
8. Payout milestones and winning-day thresholds may change the value of preserving the account, but they never force activity.

Return a compact assessment: allowed actions, feasible quantity ceiling, current exposure, real buffer, deterministic risk allowance, factual constraints, and declared uncertainties.
