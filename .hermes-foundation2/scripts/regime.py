"""Deterministic market-regime labels from gateway decision packet v2 evidence."""

from __future__ import annotations

from typing import Any

REGIMES = frozenset(
    {
        "TREND_UP",
        "TREND_DOWN",
        "CHOP",
        "LOW_LIQUIDITY",
        "DATA_DEGRADED",
    }
)

# ponytail: single-pass heuristics on last bar features; upgrade path = gateway regime field or ML overlay
_DEFAULT_QUOTE_AGE_MS = 5000
_RANGE_EXTREME = 0.70
_RANGE_MID_LOW = 0.35
_RANGE_MID_HIGH = 0.65
_SLOPE_EPS_BPS = 2.0
_LOW_LIQUIDITY_TRADE_COUNT = 3


def _timeframe_features(packet: dict[str, Any], minutes: int) -> dict[str, Any] | None:
    observation_state = packet.get("market_observation")
    if not isinstance(observation_state, dict):
        return None
    observation = observation_state.get("observation")
    if not isinstance(observation, dict):
        return None
    for timeframe in observation.get("timeframes") or []:
        if not isinstance(timeframe, dict):
            continue
        if timeframe.get("timeframe_minutes") == minutes:
            features = timeframe.get("features")
            return features if isinstance(features, dict) else None
    return None


def _order_flow_window(packet: dict[str, Any], seconds: int) -> dict[str, Any] | None:
    flow_state = packet.get("order_flow")
    if not isinstance(flow_state, dict):
        return None
    observation = flow_state.get("observation")
    if not isinstance(observation, dict):
        return None
    for window in observation.get("windows") or []:
        if not isinstance(window, dict):
            continue
        if window.get("window_seconds") == seconds:
            return window
    return None


def _quote_age_stale(packet: dict[str, Any]) -> bool:
    quality = packet.get("data_quality")
    if not isinstance(quality, dict):
        return False
    issues = quality.get("issues") or []
    if isinstance(issues, list) and "quote_stale" in issues:
        return True
    quote_age = quality.get("quote_age_ms")
    if isinstance(quote_age, (int, float)) and quote_age > _DEFAULT_QUOTE_AGE_MS:
        return True
    return False


def _data_degraded(packet: dict[str, Any]) -> bool:
    quality = packet.get("data_quality")
    if isinstance(quality, dict):
        if not quality.get("state_complete", True):
            return True
        issues = quality.get("issues") or []
        if isinstance(issues, list) and issues:
            return True

    market_obs = packet.get("market_observation")
    if isinstance(market_obs, dict) and market_obs.get("last_error"):
        return True

    order_flow = packet.get("order_flow")
    if isinstance(order_flow, dict) and order_flow.get("last_error"):
        return True

    return _quote_age_stale(packet)


def _low_liquidity(packet: dict[str, Any]) -> bool:
    window = _order_flow_window(packet, 60)
    if not window:
        return False
    trade_count = window.get("trade_count")
    if isinstance(trade_count, int) and trade_count < _LOW_LIQUIDITY_TRADE_COUNT:
        return True
    trades_per_second = window.get("trades_per_second")
    if isinstance(trades_per_second, (int, float)) and trades_per_second < 0.05:
        return True
    return False


def _slope_sign(value: Any) -> int:
    if not isinstance(value, (int, float)):
        return 0
    if value > _SLOPE_EPS_BPS:
        return 1
    if value < -_SLOPE_EPS_BPS:
        return -1
    return 0


def _trend_from_htf(features: dict[str, Any] | None) -> str | None:
    if not features:
        return None

    range_pos = features.get("range_position_20")
    slope20 = _slope_sign(features.get("ema_20_slope_bps"))
    slope50 = _slope_sign(features.get("ema_50_slope_bps"))

    if isinstance(range_pos, (int, float)):
        if range_pos >= _RANGE_EXTREME and slope20 >= 0 and slope50 >= 0:
            return "TREND_UP"
        if range_pos <= (1 - _RANGE_EXTREME) and slope20 <= 0 and slope50 <= 0:
            return "TREND_DOWN"
        if _RANGE_MID_LOW <= range_pos <= _RANGE_MID_HIGH:
            if slope20 != 0 and slope50 != 0 and slope20 != slope50:
                return "CHOP"

    if slope20 > 0 and slope50 > 0:
        return "TREND_UP"
    if slope20 < 0 and slope50 < 0:
        return "TREND_DOWN"
    if slope20 != 0 and slope50 != 0 and slope20 != slope50:
        return "CHOP"
    return None


def detect_regime(packet: dict[str, Any]) -> str:
    """Return one regime label from packet v2 market, data-quality, and order-flow evidence."""
    if _data_degraded(packet):
        return "DATA_DEGRADED"
    if _low_liquidity(packet):
        return "LOW_LIQUIDITY"

    htf = _trend_from_htf(_timeframe_features(packet, 60))
    if htf:
        return htf

    ltf = _trend_from_htf(_timeframe_features(packet, 5))
    if ltf:
        return ltf

    return "CHOP"
