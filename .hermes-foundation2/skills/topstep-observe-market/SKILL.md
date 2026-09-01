---
name: topstep-observe-market
description: Observe the bounded Glitch Topstep decision packet and recent frame path without issuing or submitting a trade.
---

# Observe Market

Use only `CURRENT_CYCLE.decision_packet` and `CURRENT_CYCLE.recent_frames` for current market and account facts.

`decision_packet` is the full current gateway snapshot (including the output template). `recent_frames` are compact minute continuity snapshots with the same semantic market, account, policy, and execution fields, but without output templates or packet lease metadata.

1. Require the current packet schema, exact snapshot hash, current quote, `data_quality.state_complete`, and account alias. Numeric ProjectX identifiers are intentionally absent and must never be requested or invented.
2. Use `market_observation` timeframes (1m, 5m, 15m, 60m) and the compact `recent_frames` path to describe price direction, acceleration, spread, session range location, volatility, and state changes. Use `order_flow` rolling windows for tape context. Treat absent information as unknown; do not invent indicators, DOM, news, bars, or sentiment.
3. When flat, frame the next-five-minute path. When positioned, frame the next-one-minute path and the evidence that would justify `HOLD`, `MOVE_STOP`, `MOVE_TP`, partial or full `EXIT`, or scale-in only when `execution.supported_actions` includes the matching `ENTER_*` action.
4. **Location and failed continuation:** report whether price is at a range edge (`range_position_20` near 0 or 1), session extreme, prior pivot, or mid-range. Note sweeps, reclaims, failed acceptance, exhaustion, and whether a continuation attempt just failed. Pass both continuation and reversion readings to thesis; neither is automatic.
5. Distinguish market evidence from account and policy evidence. `policy.current_buffer_usd`, `execution.new_exposure_technically_supported`, `execution.maximum_additional_contracts`, and `policy.max_contracts` are authoritative constraints, not market signals.
6. Data health: `market_stream_state=connected` is acceptable when `data_quality.state_complete=true` and `data_quality.issues` is empty. `data_quality.optional_issues` (such as missing DOM depth) is non-blocking evidence quality, not an execution veto. Do not treat connected market stream as unhealthy by default. Quote freshness uses `data_quality.quote_age_ms` together with `data_quality.issues` (e.g. `quote_stale`, `quote_clock_skew`); negative ages are clamped to zero in the model packet. Do not apply a hardcoded millisecond threshold unless the packet flags staleness.
7. Session range: when `market.session_levels_reliable` is false, do not treat `session_high`/`session_low` as structural edges; prefer `order_flow` 60s window highs/lows and observation `range_position_20`.
8. Depth: when `order_flow.observation.depth.available` is false, do not infer book imbalance. Also treat depth as unavailable when bid/ask geometry is inconsistent (`best_bid >= best_ask`, `spread_ticks <= 0`, or material disagreement with `market.bid`/`market.ask`), even if `available` is still true. Depth gaps belong in `optional_issues`, not as a `state_complete` failure.
9. Continuity: when `CURRENT_CYCLE.continuity_gap.present` is true, treat `recent_frames` as a partially sampled path and cite the gap in missing evidence.
10. Partial bars: prefer `progress_adjusted_volume_z_score_20` over raw `volume_z_score_20` when `latest_bar_partial` is true.
11. Plans, guidance, and memory are hypotheses. Fresh authenticated gateway facts win whenever they conflict.

Pass a compact observation to risk and thesis: path, location (edge vs mid-range), spread, volatility clues, directional evidence, contradictory evidence, failed-continuation reading, missing evidence, inferred regime label (TREND_UP, TREND_DOWN, CHOP, LOW_LIQUIDITY, DATA_DEGRADED), and data quality. This skill never emits an intent.
