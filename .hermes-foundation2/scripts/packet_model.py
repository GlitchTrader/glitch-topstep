"""Sanitize gateway packets for model prompts.

The current decision packet stays evidence-rich but compacts nested market
observation and order-flow blobs. Historical minute frames are continuity
snapshots with the same semantic top-level fields, without prompt-template
noise, lease metadata, or non-essential ledger tails.
"""
from __future__ import annotations

import copy
from typing import Any

FRAME_SNAPSHOT_SCHEMA = "glitch.topstep.frame_snapshot.v2"

# Top-level packet keys preserved in every frame snapshot.
FRAME_PACKET_KEYS = (
    "schema_version",
    "packet_id",
    "created_utc",
    "venue",
    "firm",
    "instrument",
    "decision_scope",
    "market_universe",
    "account",
    "contract",
    "market",
    "market_observation",
    "order_flow",
    "data_quality",
    "execution",
    "policy",
    "session",
    "daily_economics",
    "position_state",
    "protection",
    "reconciliation",
    "session_activity",
    "orders_working",
)

FRAME_ACCOUNT_KEYS = (
    "name",
    "balance",
    "unrealized_pnl",
    "conservative_equity",
    "total_open_contracts",
    "instrument_open_contracts",
    "can_trade",
    "working_orders",
)

FRAME_MARKET_KEYS = (
    "snapshot_hash",
    "quote_timestamp",
    "last",
    "bid",
    "ask",
    "spread_ticks",
    "session_high",
    "session_low",
)

FRAME_EXECUTION_KEYS = (
    "gateway_mode",
    "supported_actions",
    "maximum_additional_contracts",
    "new_exposure_technically_supported",
)

FRAME_POLICY_KEYS = (
    "max_contracts",
    "current_buffer_usd",
    "hard_loss_floor_usd",
    "loss_model",
)

FRAME_SESSION_KEYS = ("entry_window_open", "must_flat_utc", "phase", "phase_authority")

FRAME_SKIP_WHEN_FLAT = frozenset(
    {"protection", "reconciliation", "session_activity", "orders_working"}
)

CYCLE_ORDER_FLOW_WINDOWS = frozenset({15, 60, 300})


def _finite_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if number == number:  # NaN guard without importing math
            return number
    return None


def sanitize_quote_age_ms(value: Any) -> int | None:
    number = _finite_number(value)
    if number is None:
        return None
    return max(0, int(round(number)))


def sanitize_market_for_model(market: dict[str, Any]) -> dict[str, Any]:
    out = _pick(market, FRAME_MARKET_KEYS)
    last = _finite_number(market.get("last"))
    high = _finite_number(market.get("session_high"))
    low = _finite_number(market.get("session_low"))
    session_open = _finite_number(market.get("session_open"))
    reliable = True
    if last is not None and high is not None and low is not None:
        if high == low == last:
            reliable = False
        elif (
            session_open is not None
            and high == low == session_open == last
        ):
            reliable = False
    out["session_levels_reliable"] = reliable
    if not reliable:
        out["session_levels_note"] = (
            "session_high/low mirror last or session_open; "
            "prefer order_flow 60s high/low or observation range features"
        )
    return out


def sanitize_data_quality_for_model(data_quality: Any) -> Any:
    if not isinstance(data_quality, dict):
        return data_quality
    out = copy.deepcopy(data_quality)
    raw_quote_age = out.get("quote_age_ms")
    if "quote_age_ms" in out:
        sanitized = sanitize_quote_age_ms(raw_quote_age)
        if sanitized is not None:
            out["quote_age_ms"] = sanitized
        else:
            out.pop("quote_age_ms", None)
    raw_number = _finite_number(raw_quote_age)
    if raw_number is not None and raw_number < 0:
        out["raw_quote_age_ms"] = int(round(raw_number))
        out["clock_skew_detected"] = True
        issues = out.get("issues")
        if not isinstance(issues, list):
            issues = []
            out["issues"] = issues
        if "quote_clock_skew" not in issues:
            issues.append("quote_clock_skew")
    return out


def sanitize_stream_health_for_model(stream_health: Any) -> Any:
    if not isinstance(stream_health, dict):
        return stream_health
    out = copy.deepcopy(stream_health)
    raw_quote_age = out.get("quote_age_ms")
    sanitized = sanitize_quote_age_ms(raw_quote_age)
    if sanitized is not None:
        out["quote_age_ms"] = sanitized
    else:
        out.pop("quote_age_ms", None)
    raw_number = _finite_number(raw_quote_age)
    if raw_number is not None and raw_number < 0:
        out["raw_quote_age_ms"] = int(round(raw_number))
        out["clock_skew_detected"] = True
    return out


def sanitize_depth_for_model(
    depth: Any,
    *,
    market: dict[str, Any] | None = None,
    tick_size: float | None = None,
) -> Any:
    if not isinstance(depth, dict):
        return {"available": False}
    compact = _pick(
        depth,
        (
            "best_bid",
            "best_ask",
            "spread_ticks",
            "imbalance_ratio",
            "bid_volume",
            "ask_volume",
            "unavailable_reason",
        ),
    )
    best_bid = _finite_number(compact.get("best_bid"))
    best_ask = _finite_number(compact.get("best_ask"))
    spread = _finite_number(compact.get("spread_ticks"))
    has_levels = any(
        _finite_number(compact.get(key)) not in (None, 0)
        for key in ("best_bid", "best_ask", "bid_volume", "ask_volume")
    )
    # Respect gateway availability; never revive a flagged book just because levels exist.
    gateway_available = depth.get("available")
    inconsistent = (
        best_bid is not None and best_ask is not None and best_bid >= best_ask
    ) or (spread is not None and spread <= 0)
    diverged = False
    if (
        isinstance(market, dict)
        and tick_size is not None
        and tick_size > 0
        and best_bid is not None
        and best_ask is not None
    ):
        market_bid = _finite_number(market.get("bid"))
        market_ask = _finite_number(market.get("ask"))
        if market_bid is not None and market_ask is not None:
            # ponytail: 8 ticks matches gateway DEPTH_QUOTE_MAX_DIVERGENCE_TICKS
            max_ticks = 8
            if (
                abs(best_bid - market_bid) / tick_size > max_ticks
                or abs(best_ask - market_ask) / tick_size > max_ticks
            ):
                diverged = True
    available = (
        gateway_available is not False
        and has_levels
        and not inconsistent
        and not diverged
    )
    compact["available"] = available
    if not available:
        compact["imbalance_ratio"] = None
        reason = compact.get("unavailable_reason") or depth.get("unavailable_reason")
        if inconsistent:
            reason = reason or "invalid_depth_geometry"
        elif diverged:
            reason = reason or "depth_bbo_diverges_from_quote"
        if reason:
            compact["unavailable_reason"] = reason
        compact.setdefault(
            "note",
            "depth reconstruction unavailable; do not infer book imbalance",
        )
    return compact


def annotate_partial_timeframes(timeframes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for row in timeframes:
        item = copy.deepcopy(row)
        if item.get("latest_bar_partial") is True:
            features = item.get("features")
            if isinstance(features, dict):
                volume_z = _finite_number(features.get("volume_z_score_20"))
                adjusted = _finite_number(
                    features.get("progress_adjusted_volume_z_score_20")
                )
                if adjusted is not None:
                    item.setdefault(
                        "partial_bar_note",
                        "partial bar; prefer progress_adjusted_volume_z_score_20 over raw volume_z_score_20",
                    )
                elif volume_z is not None and volume_z <= -2:
                    item["partial_bar_note"] = (
                        "partial bar with depressed volume_z_score_20; "
                        "treat volume context as incomplete"
                    )
        annotated.append(item)
    return annotated


def detect_continuity_gap(frames: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return a gap summary when minute frame minute_ids are not contiguous."""
    minute_ids: list[str] = []
    for frame in frames:
        minute_id = frame.get("minute_id")
        if isinstance(minute_id, str) and len(minute_id) >= 13:
            minute_ids.append(minute_id)
    if len(minute_ids) < 2:
        return None
    minute_ids.sort()
    gaps: list[dict[str, Any]] = []
    for left, right in zip(minute_ids, minute_ids[1:]):
        left_dt = _minute_id_to_dt(left)
        right_dt = _minute_id_to_dt(right)
        if left_dt is None or right_dt is None:
            continue
        delta_minutes = int((right_dt - left_dt).total_seconds() // 60)
        if delta_minutes > 1:
            gaps.append(
                {
                    "after_minute_id": left,
                    "before_minute_id": right,
                    "missing_minutes": delta_minutes - 1,
                }
            )
    if not gaps:
        return None
    return {
        "present": True,
        "gaps": gaps,
        "note": "minute-frame continuity holes; treat recent_frames path as partially sampled",
    }


def _minute_id_to_dt(minute_id: str):
    from datetime import datetime, timezone

    try:
        return datetime.strptime(minute_id, "%Y%m%dT%H%MZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _order_flow_window_seconds(window: dict[str, Any]) -> int | None:
    seconds = window.get("window_seconds")
    if isinstance(seconds, str):
        value = seconds.removesuffix("s")
        if value.isdigit():
            return int(value)
        return None
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
        return int(seconds)
    return None


def _pick(mapping: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: mapping[key] for key in keys if key in mapping}


def _packet_positioned(packet: dict[str, Any]) -> bool:
    account = packet.get("account")
    if isinstance(account, dict):
        for field in ("instrument_open_contracts", "total_open_contracts"):
            value = account.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if int(value) > 0:
                    return True
    position = packet.get("position_state")
    if isinstance(position, dict):
        side = str(position.get("side") or "").upper()
        if side and side != "FLAT":
            return True
    return False


def _strip_provider_ids(packet: dict[str, Any], *, drop_template: bool) -> dict[str, Any]:
    value = copy.deepcopy(packet)
    account = value.get("account")
    if isinstance(account, dict):
        account.pop("id", None)
    contract = value.get("contract")
    if isinstance(contract, dict):
        contract.pop("id", None)
        contract.pop("symbol_id", None)
    if drop_template:
        value.pop("required_output_template", None)
    value.pop("expires_utc", None)
    return value


def compact_timeframe_observation(timeframe: dict[str, Any]) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "timeframe_minutes": timeframe.get("timeframe_minutes"),
        "latest_bar_utc": timeframe.get("latest_bar_utc"),
        "latest_bar_partial": timeframe.get("latest_bar_partial"),
        "current_partial_bar": timeframe.get("current_partial_bar"),
        "prior_completed_bar": timeframe.get("prior_completed_bar"),
        "partial_progress": timeframe.get("partial_progress"),
        "bar_identity_issues": timeframe.get("bar_identity_issues"),
    }
    features = timeframe.get("features")
    if isinstance(features, dict):
        compact["features"] = features
    close = timeframe.get("close")
    if close is not None and "features" not in compact:
        compact["close"] = close
    return compact


def compact_market_observation_state(state: Any) -> Any:
    if not isinstance(state, dict):
        return state
    observation = state.get("observation")
    if not isinstance(observation, dict):
        return {
            "last_succeeded_utc": state.get("last_succeeded_utc"),
            "last_error": state.get("last_error"),
        }
    timeframes = observation.get("timeframes")
    compact_timeframes: list[dict[str, Any]] = []
    if isinstance(timeframes, list):
        for row in timeframes:
            if isinstance(row, dict):
                compact_timeframes.append(compact_timeframe_observation(row))
        compact_timeframes = annotate_partial_timeframes(compact_timeframes)
    elif isinstance(timeframes, dict):
        for key, row in timeframes.items():
            if isinstance(row, dict):
                item = compact_timeframe_observation(row)
                item.setdefault("timeframe_minutes", key)
                compact_timeframes.append(item)
    return {
        "last_succeeded_utc": state.get("last_succeeded_utc"),
        "last_error": state.get("last_error"),
        "observation": {
            "schema_version": observation.get("schema_version"),
            "instrument": observation.get("instrument"),
            "timeframes": compact_timeframes,
        },
    }


def compact_order_flow_state(
    state: Any,
    *,
    market: dict[str, Any] | None = None,
    tick_size: float | None = None,
) -> Any:
    if not isinstance(state, dict):
        return state
    observation = state.get("observation")
    if not isinstance(observation, dict):
        return {
            "last_succeeded_utc": state.get("last_succeeded_utc"),
            "last_error": state.get("last_error"),
        }
    windows = observation.get("windows")
    compact_windows: list[dict[str, Any]] = []
    if isinstance(windows, list):
        for window in windows:
            if not isinstance(window, dict):
                continue
            seconds = _order_flow_window_seconds(window)
            if seconds in CYCLE_ORDER_FLOW_WINDOWS:
                compact_windows.append(window)
        compact_windows.sort(
            key=lambda row: _order_flow_window_seconds(row) or 0,
        )
    elif isinstance(windows, dict):
        for key in ("15s", "15", "60s", "60", "300s", "300"):
            window = windows.get(key)
            if isinstance(window, dict):
                compact_windows.append(window)
    depth = observation.get("depth")
    compact_depth = sanitize_depth_for_model(
        depth,
        market=market if isinstance(market, dict) else None,
        tick_size=tick_size,
    )
    return {
        "last_succeeded_utc": state.get("last_succeeded_utc"),
        "last_error": state.get("last_error"),
        "observation": {
            "schema_version": observation.get("schema_version"),
            "windows": compact_windows,
            "depth": compact_depth,
            "issues": observation.get("issues") or [],
        },
    }


def compact_packet_evidence(packet: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(packet)
    market = value.get("market")
    contract = value.get("contract")
    tick_size = None
    if isinstance(contract, dict):
        tick_size = _finite_number(contract.get("tick_size"))
    if isinstance(market, dict):
        value["market"] = sanitize_market_for_model(market)
    if "data_quality" in value:
        value["data_quality"] = sanitize_data_quality_for_model(
            value.get("data_quality")
        )
    if "stream_health" in value:
        value["stream_health"] = sanitize_stream_health_for_model(
            value.get("stream_health")
        )
    if "market_observation" in value:
        value["market_observation"] = compact_market_observation_state(
            value.get("market_observation")
        )
    if "order_flow" in value:
        value["order_flow"] = compact_order_flow_state(
            value.get("order_flow"),
            market=value.get("market") if isinstance(value.get("market"), dict) else None,
            tick_size=tick_size,
        )
    return value


def continuity_packet_for_cycle(
    packet: dict[str, Any],
    *,
    positioned: bool | None = None,
) -> dict[str, Any]:
    slim = _strip_provider_ids(packet, drop_template=True)
    if positioned is None:
        positioned = _packet_positioned(slim)
    out: dict[str, Any] = {}
    for key in FRAME_PACKET_KEYS:
        if key not in slim:
            continue
        if not positioned and key in FRAME_SKIP_WHEN_FLAT:
            continue
        value = slim[key]
        if key == "account" and isinstance(value, dict):
            out[key] = _pick(value, FRAME_ACCOUNT_KEYS)
        elif key == "market" and isinstance(value, dict):
            out[key] = sanitize_market_for_model(value)
        elif key == "data_quality":
            out[key] = sanitize_data_quality_for_model(value)
        elif key == "stream_health":
            out[key] = sanitize_stream_health_for_model(value)
        elif key == "execution" and isinstance(value, dict):
            out[key] = _pick(value, FRAME_EXECUTION_KEYS)
        elif key == "policy" and isinstance(value, dict):
            out[key] = _pick(value, FRAME_POLICY_KEYS)
        elif key == "session" and isinstance(value, dict):
            out[key] = _pick(value, FRAME_SESSION_KEYS)
        elif key == "market_observation":
            out[key] = compact_market_observation_state(value)
        elif key == "order_flow":
            contract = slim.get("contract")
            tick_size = (
                _finite_number(contract.get("tick_size"))
                if isinstance(contract, dict)
                else None
            )
            market_for_depth = out.get("market")
            if not isinstance(market_for_depth, dict):
                market_for_depth = slim.get("market") if isinstance(slim.get("market"), dict) else None
            out[key] = compact_order_flow_state(
                value,
                market=market_for_depth if isinstance(market_for_depth, dict) else None,
                tick_size=tick_size,
            )
        else:
            out[key] = value
    return out


def packet_for_model(
    packet: dict[str, Any],
    *,
    profile_name: str,
    core_model: str,
    prompt_version: str,
) -> dict[str, Any]:
    value = _strip_provider_ids(packet, drop_template=False)
    template = value.get("required_output_template")
    if isinstance(template, dict):
        template = copy.deepcopy(template)
        template["operator_profile"] = profile_name
        template["model_version"] = core_model
        template["prompt_version"] = prompt_version
        value["required_output_template"] = template
    return value


def packet_for_cycle(
    packet: dict[str, Any],
    *,
    profile_name: str,
    core_model: str,
    prompt_version: str,
) -> dict[str, Any]:
    value = _strip_provider_ids(packet, drop_template=True)
    value = compact_packet_evidence(value)
    return value


def frame_for_model(frame: dict[str, Any]) -> dict[str, Any]:
    packet = frame.get("packet")
    if not isinstance(packet, dict):
        return {
            "schema_version": FRAME_SNAPSHOT_SCHEMA,
            "minute_id": frame.get("minute_id"),
            "captured_utc": frame.get("captured_utc"),
            "packet": {},
        }

    return {
        "schema_version": FRAME_SNAPSHOT_SCHEMA,
        "minute_id": frame.get("minute_id"),
        "captured_utc": frame.get("captured_utc"),
        "packet": continuity_packet_for_cycle(packet),
    }


def frame_packet_keys(packet: dict[str, Any]) -> set[str]:
    return {key for key in FRAME_PACKET_KEYS if key in packet}
