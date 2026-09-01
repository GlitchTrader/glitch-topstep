"""NT parity helpers adapted for Glitch Topstep Hermes profile."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from distribution_manifest import PROMPT_VERSION
from common import (
    append_jsonl,
    parse_utc,
    read_json,
    read_jsonl,
    read_optional_json,
    request_json,
    utc_now,
    write_json_atomic,
)

CURRENT_PLAN_SCHEMA = "glitch.topstep.portfolio_plan.v1"
CURRENT_GUIDANCE_SCHEMA = "glitch.topstep.guidance.v1"
RETRYABLE_ATTEMPT_STATUSES = frozenset(
    {"started", "failed", "execution_failed", "delivery_incomplete"}
)


WAKE_TRIGGER_SCHEMA = "glitch.topstep.wake_triggers.v1"
WAKE_TRIGGER_TYPES = frozenset({"PRICE_CROSS", "SESSION_PHASE"})
SESSION_PHASE_VALUES = frozenset({"regular", "maintenance", "asia"})
# ponytail: TAPE_BURST and DOM_IMBALANCE deferred until gateway tape/DOM wake fields stabilize.


def wake_trigger_path(supervisor: Path) -> Path:
    return supervisor / "active-wake-triggers.json"


def wake_trigger_cooldown_seconds() -> int:
    raw = os.environ.get("GLITCH_TOPSTEP_WAKE_TRIGGER_COOLDOWN_SECONDS", "120")
    try:
        value = int(raw)
    except ValueError:
        value = 120
    return max(0, value)


def wake_trigger_key(trigger: dict[str, Any]) -> str:
    trigger_type = str(trigger.get("type") or "")
    if trigger_type == "PRICE_CROSS":
        return f"PRICE_CROSS:{trigger.get('direction')}:{trigger.get('price')}"
    if trigger_type == "SESSION_PHASE":
        return f"SESSION_PHASE:{trigger.get('phase')}"
    return json.dumps(trigger, sort_keys=True, separators=(",", ":"))


def wake_reason_label(trigger: dict[str, Any]) -> str:
    trigger_type = str(trigger.get("type") or "")
    if trigger_type == "PRICE_CROSS":
        return f"PRICE_CROSS:{trigger.get('direction')}:{trigger.get('price')}"
    if trigger_type == "SESSION_PHASE":
        return f"SESSION_PHASE:{trigger.get('phase')}"
    return wake_trigger_key(trigger)


def validate_wake_triggers(triggers: Any) -> None:
    if not isinstance(triggers, list):
        raise ValueError("wake_triggers_invalid")
    for trigger_index, trigger in enumerate(triggers):
        if not isinstance(trigger, dict):
            raise ValueError(f"wake_trigger_invalid:{trigger_index}")
        trigger_type = trigger.get("type")
        if trigger_type not in WAKE_TRIGGER_TYPES:
            raise ValueError(f"wake_trigger_type_invalid:{trigger_index}")
        if trigger_type == "PRICE_CROSS":
            allowed = {"type", "direction", "price"}
            if set(trigger) != allowed:
                raise ValueError(f"wake_trigger_fields_invalid:{trigger_index}")
            if trigger.get("direction") not in {"ABOVE", "BELOW"}:
                raise ValueError(f"wake_trigger_direction_invalid:{trigger_index}")
            price = trigger.get("price")
            if (
                not isinstance(price, (int, float))
                or isinstance(price, bool)
                or not math.isfinite(float(price))
            ):
                raise ValueError(f"wake_trigger_price_invalid:{trigger_index}")
        elif trigger_type == "SESSION_PHASE":
            allowed = {"type", "phase"}
            if set(trigger) != allowed:
                raise ValueError(f"wake_trigger_fields_invalid:{trigger_index}")
            if trigger.get("phase") not in SESSION_PHASE_VALUES:
                raise ValueError(f"wake_trigger_phase_invalid:{trigger_index}")


def explicit_price_crosses(condition: str) -> set[tuple[str, float]]:
    pattern = re.compile(
        r"\b(above|over|below|under)\s+([0-9]+(?:\.[0-9]+)?)",
        re.IGNORECASE,
    )
    crosses: set[tuple[str, float]] = set()
    for match in pattern.finditer(condition):
        direction = "ABOVE" if match.group(1).lower() in {"above", "over"} else "BELOW"
        crosses.add((direction, float(match.group(2))))
    return crosses


def require_explicit_wake_triggers(
    audit: dict[str, Any],
    triggers: list[dict[str, Any]],
) -> None:
    """Advisory helper only; change_condition price language is not a worker gate."""
    _ = audit
    _ = triggers


def packet_current_price(packet: dict[str, Any]) -> float | None:
    market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
    value = market.get("last")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
        return float(value)
    return None


def packet_one_minute_range(packet: dict[str, Any]) -> tuple[float, float] | None:
    market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
    try:
        close = float(market["last"])
    except (KeyError, TypeError, ValueError):
        return None
    window = order_flow_window(packet, 60)
    if window is not None:
        try:
            return float(window["low_price"]), float(window["high_price"])
        except (KeyError, TypeError, ValueError):
            pass
    for high_key, low_key in (("session_high", "session_low"), ("high", "low")):
        try:
            return float(market[low_key]), float(market[high_key])
        except (KeyError, TypeError, ValueError):
            continue
    return close, close


def prior_frame_price(state: Path, packet: dict[str, Any]) -> float | None:
    frames_dir = state / "minute-frames"
    if not frames_dir.is_dir():
        return None
    current_id = parse_utc(packet["created_utc"]).strftime("%Y%m%dT%H%MZ")
    for path in sorted(frames_dir.glob("*.json"), reverse=True):
        if path.stem >= current_id:
            continue
        frame = read_optional_json(path)
        if not frame:
            continue
        prior_packet = frame.get("packet")
        if isinstance(prior_packet, dict):
            price = packet_current_price(prior_packet)
            if price is not None:
                return price
    return None


def read_wake_trigger_document(state: Path) -> dict[str, Any] | None:
    path = wake_trigger_path(state / "supervisor")
    if not path.is_file():
        return None
    try:
        value = read_json(path)
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def packet_session_phase(packet: dict[str, Any]) -> str | None:
    session = packet.get("session") if isinstance(packet.get("session"), dict) else {}
    phase = session.get("phase")
    if phase in SESSION_PHASE_VALUES:
        return str(phase)
    return None


def prior_eval_snapshot(state: Path, packet: dict[str, Any]) -> tuple[float | None, str | None]:
    document = read_wake_trigger_document(state)
    snapshot = document.get("eval_snapshot") if isinstance(document, dict) else None
    prior_price: float | None = None
    prior_phase: str | None = None
    if isinstance(snapshot, dict):
        raw_price = snapshot.get("price")
        if isinstance(raw_price, (int, float)) and not isinstance(raw_price, bool):
            if math.isfinite(float(raw_price)):
                prior_price = float(raw_price)
        raw_phase = snapshot.get("phase")
        if raw_phase in SESSION_PHASE_VALUES:
            prior_phase = str(raw_phase)
    if prior_price is None:
        prior_price = prior_frame_price(state, packet)
    return prior_price, prior_phase


def update_wake_eval_snapshot(state: Path, packet: dict[str, Any]) -> None:
    document = read_wake_trigger_document(state)
    if not isinstance(document, dict):
        return
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    current_price = packet_current_price(packet)
    current_phase = packet_session_phase(packet)
    snapshot: dict[str, Any] = {"updated_utc": utc_now()}
    if current_price is not None:
        snapshot["price"] = current_price
    if current_phase is not None:
        snapshot["phase"] = current_phase
    document["eval_snapshot"] = snapshot
    write_json_atomic(wake_trigger_path(supervisor), document)


def trigger_in_cooldown(document: dict[str, Any], trigger: dict[str, Any]) -> bool:
    cooldown = wake_trigger_cooldown_seconds()
    if cooldown <= 0:
        return False
    history = document.get("fire_history")
    if not isinstance(history, dict):
        return False
    entry = history.get(wake_trigger_key(trigger))
    if not isinstance(entry, dict):
        return False
    fired_utc = entry.get("last_fired_utc")
    if not isinstance(fired_utc, str):
        return False
    try:
        fired_at = parse_utc(fired_utc)
    except (ValueError, TypeError):
        return False
    return (parse_utc(utc_now()) - fired_at).total_seconds() < cooldown


def record_wake_trigger_fire(
    state: Path,
    trigger: dict[str, Any],
    packet: dict[str, Any],
    *,
    source: str,
) -> None:
    document = read_wake_trigger_document(state) or {
        "schema_version": WAKE_TRIGGER_SCHEMA,
        "triggers": [],
    }
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    history = document.get("fire_history")
    if not isinstance(history, dict):
        history = {}
    packet_id = str(packet.get("packet_id") or "")
    history[wake_trigger_key(trigger)] = {
        "last_fired_utc": utc_now(),
        "last_packet_id": packet_id,
        "wake_reason": wake_reason_label(trigger),
        "source": source,
    }
    document["fire_history"] = history
    write_json_atomic(wake_trigger_path(supervisor), document)
    append_jsonl(
        state / "events.jsonl",
        {
            "schema_version": "glitch.topstep.cycle_event.v2",
            "event": "wake_trigger_fired",
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "wake_reason": wake_reason_label(trigger),
            "wake_trigger": trigger,
            "source": source,
            "cooldown_seconds": wake_trigger_cooldown_seconds(),
        },
    )


def _price_cross_fired(
    trigger: dict[str, Any],
    previous: float | None,
    current: float | None,
    current_range: tuple[float, float] | None,
) -> bool:
    if previous is None or current is None:
        return False
    try:
        level = float(trigger["price"])
    except (KeyError, TypeError, ValueError):
        return False
    current_low, current_high = current_range or (current, current)
    direction = trigger.get("direction")
    if direction == "ABOVE" and previous <= level < max(current, current_high):
        return True
    if direction == "BELOW" and previous >= level > min(current, current_low):
        return True
    return False


def _session_phase_fired(
    trigger: dict[str, Any],
    previous_phase: str | None,
    current_phase: str | None,
) -> bool:
    if previous_phase is None or current_phase is None:
        return False
    target = trigger.get("phase")
    return previous_phase != target and current_phase == target


def evaluate_wake_triggers(
    state: Path,
    packet: dict[str, Any],
    *,
    record_fire: bool = False,
    source: str = "cycle",
) -> dict[str, Any] | None:
    document = read_wake_trigger_document(state)
    if not isinstance(document, dict):
        update_wake_eval_snapshot(state, packet)
        return None
    triggers = document.get("triggers")
    if not isinstance(triggers, list) or not triggers:
        update_wake_eval_snapshot(state, packet)
        return None
    previous_price, previous_phase = prior_eval_snapshot(state, packet)
    current_price = packet_current_price(packet)
    current_range = packet_one_minute_range(packet)
    current_phase = packet_session_phase(packet)
    for trigger in triggers:
        if not isinstance(trigger, dict):
            continue
        trigger_type = trigger.get("type")
        fired = False
        if trigger_type == "PRICE_CROSS":
            fired = _price_cross_fired(trigger, previous_price, current_price, current_range)
        elif trigger_type == "SESSION_PHASE":
            fired = _session_phase_fired(trigger, previous_phase, current_phase)
        if not fired:
            continue
        if trigger_in_cooldown(document, trigger):
            continue
        detail = {
            "wake_reason": wake_reason_label(trigger),
            "wake_trigger": trigger,
            "trigger_key": wake_trigger_key(trigger),
        }
        if record_fire:
            record_wake_trigger_fire(state, trigger, packet, source=source)
        update_wake_eval_snapshot(state, packet)
        return detail
    update_wake_eval_snapshot(state, packet)
    return None


def wake_trigger_fired(state: Path, packet: dict[str, Any]) -> bool:
    return evaluate_wake_triggers(state, packet) is not None


def persist_wake_triggers(state: Path, intent: dict[str, Any], packet_id: str) -> None:
    triggers = intent.get("wake_triggers")
    if not isinstance(triggers, list):
        triggers = []
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    existing = read_wake_trigger_document(state) or {}
    fire_history = existing.get("fire_history")
    eval_snapshot = existing.get("eval_snapshot")
    document: dict[str, Any] = {
        "schema_version": WAKE_TRIGGER_SCHEMA,
        "packet_id": packet_id,
        "triggers": triggers,
        "updated_utc": utc_now(),
        "cooldown_seconds": wake_trigger_cooldown_seconds(),
    }
    if isinstance(fire_history, dict):
        document["fire_history"] = fire_history
    if isinstance(eval_snapshot, dict):
        document["eval_snapshot"] = eval_snapshot
    write_json_atomic(wake_trigger_path(supervisor), document)


def pending_wake_path(supervisor: Path) -> Path:
    return supervisor / "pending-wake-invocation.json"


def write_pending_wake_invocation(state: Path, wake_detail: dict[str, Any], packet: dict[str, Any]) -> None:
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    write_json_atomic(
        pending_wake_path(supervisor),
        {
            "schema_version": "glitch.topstep.pending_wake.v1",
            "recorded_utc": utc_now(),
            "packet_id": str(packet.get("packet_id") or ""),
            "wake_reason": wake_detail.get("wake_reason"),
            "wake_trigger": wake_detail.get("wake_trigger"),
            "trigger_key": wake_detail.get("trigger_key"),
        },
    )


def read_pending_wake_invocation(state: Path) -> dict[str, Any] | None:
    path = pending_wake_path(state / "supervisor")
    value = read_optional_json(path)
    return value if isinstance(value, dict) else None


def clear_pending_wake_invocation(state: Path) -> None:
    path = pending_wake_path(state / "supervisor")
    path.unlink(missing_ok=True)


def cycle_wake_fields(
    reason: str | None,
    wake_detail: dict[str, Any] | None,
) -> dict[str, Any]:
    fields: dict[str, Any] = {"invocation_reason": reason}
    if wake_detail:
        fields["wake_reason"] = wake_detail.get("wake_reason")
        fields["wake_trigger"] = wake_detail.get("wake_trigger")
    return fields


def monitor_should_launch_cycle(
    state: Path,
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
    *,
    flat_decision_interval_minutes: int,
) -> dict[str, Any] | None:
    wake_detail = evaluate_wake_triggers(state, packet)
    if not wake_detail:
        return None
    reason = invocation_reason(
        packet,
        state,
        directive,
        flat_decision_interval_minutes=flat_decision_interval_minutes,
    )
    if reason is not None and reason not in {"condition_change"}:
        return None
    lock_path = state / "direct-cycle.lock"
    if lock_path.is_file():
        return None
    return wake_detail


def last_evidence_exists(state: Path) -> bool:
    return (state / "last-evidence.json").is_file()


def latest_prior_attempt(state: Path, packet_id: str) -> dict[str, Any] | None:
    attempts_dir = state / "attempts"
    if not attempts_dir.is_dir():
        return None
    latest_path: Path | None = None
    latest_mtime = 0.0
    for path in attempts_dir.glob("*.json"):
        if path.stem == packet_id:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime >= latest_mtime:
            latest_mtime = mtime
            latest_path = path
    if latest_path is None:
        return None
    try:
        value = read_json(latest_path)
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def packet_positioned(packet: dict[str, Any]) -> bool:
    account = packet.get("account")
    if not isinstance(account, dict):
        return False
    return int(account.get("instrument_open_contracts") or 0) != 0


def respect_session_gate_enabled() -> bool:
    import os

    return os.environ.get("GLITCH_TOPSTEP_RESPECT_SESSION_GATE", "true").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def session_gate_override_enabled() -> bool:
    import os

    return os.environ.get("GLITCH_TOPSTEP_SESSION_GATE_OVERRIDE", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def packet_session_closed(packet: dict[str, Any]) -> bool:
    session = packet.get("session")
    if not isinstance(session, dict):
        return False
    return session.get("entry_window_open") is False


def packet_session_phase(packet: dict[str, Any]) -> str | None:
    session = packet.get("session")
    if not isinstance(session, dict):
        return None
    phase = session.get("phase")
    if isinstance(phase, str) and phase.strip():
        return phase.strip()
    return None


def session_maintenance_skip_details(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """GTHP-018 follow-on: skip flat Luna during gateway session.phase=maintenance."""
    if directive is not None or packet_positioned(packet):
        return None
    phase = packet_session_phase(packet)
    if phase != "maintenance":
        return None
    return {
        "reason": "session_maintenance",
        "session_phase": phase,
    }


def flat_outside_session_window(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
) -> bool:
    if not respect_session_gate_enabled() or session_gate_override_enabled():
        return False
    if directive is not None or packet_positioned(packet):
        return False
    return packet_session_closed(packet)


def _env_truthy(name: str, *, default: str = "false") -> bool:
    import os

    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes"}


def market_quiescence_gate_enabled() -> bool:
    """GTHP-018: skip flat Luna when quote is stale and tape is quiescent."""
    if _env_truthy("GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT", default="true"):
        return True
    # ponytail: legacy alias until operators migrate .env
    return _env_truthy("GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE")


def max_quiescent_trade_count_60s() -> int:
    import os

    try:
        return max(0, int(os.environ.get("GLITCH_TOPSTEP_QUIESCENT_MAX_TRADE_COUNT_60S", "0")))
    except ValueError:
        return 0


def packet_stream_health(packet: dict[str, Any]) -> dict[str, Any] | None:
    stream_health = packet.get("stream_health")
    if isinstance(stream_health, dict) and stream_health:
        return stream_health
    return None


def order_flow_window(packet: dict[str, Any], window_seconds: int) -> dict[str, Any] | None:
    order_flow = packet.get("order_flow")
    if not isinstance(order_flow, dict):
        return None
    observation = order_flow.get("observation")
    if not isinstance(observation, dict):
        return None
    windows = observation.get("windows")
    if not isinstance(windows, list):
        return None
    for window in windows:
        if isinstance(window, dict) and window.get("window_seconds") == window_seconds:
            return window
    return None


def packet_trade_count_60s(packet: dict[str, Any]) -> int | None:
    stream_health = packet_stream_health(packet)
    if stream_health is not None:
        trade_count = stream_health.get("trade_count_60s")
        if isinstance(trade_count, bool):
            pass
        elif isinstance(trade_count, int):
            return trade_count
        elif isinstance(trade_count, float) and math.isfinite(trade_count):
            return int(trade_count)
    window = order_flow_window(packet, 60)
    if window is None:
        return None
    trade_count = window.get("trade_count")
    if isinstance(trade_count, bool):
        return None
    if isinstance(trade_count, int):
        return trade_count
    if isinstance(trade_count, float) and math.isfinite(trade_count):
        return int(trade_count)
    return None


def packet_quote_age_ms(packet: dict[str, Any]) -> float | None:
    observation = quote_age_observation(packet)
    return observation.get("normalized_quote_age_ms")


def packet_raw_quote_age_ms(packet: dict[str, Any]) -> float | None:
    observation = quote_age_observation(packet)
    raw = observation.get("raw_quote_age_ms")
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def quote_age_observation(packet: dict[str, Any]) -> dict[str, Any]:
    from common import max_quote_age_ms

    stream_health = packet_stream_health(packet)
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )
    sources = [source for source in (stream_health, data_quality) if isinstance(source, dict)]
    issues: list[str] = []
    raw: float | None = None
    for source in sources:
        source_issues = source.get("issues")
        if isinstance(source_issues, list):
            issues.extend(str(item) for item in source_issues)
        preserved = source.get("raw_quote_age_ms")
        if isinstance(preserved, (int, float)) and not isinstance(preserved, bool):
            candidate = float(preserved)
            raw = candidate if raw is None else min(raw, candidate)
            continue
        quote_age = source.get("quote_age_ms")
        if isinstance(quote_age, (int, float)) and not isinstance(quote_age, bool):
            candidate = float(quote_age)
            if candidate < 0:
                raw = candidate if raw is None else min(raw, candidate)

    primary = stream_health if stream_health is not None else data_quality
    primary_age = None
    if isinstance(primary, dict):
        quote_age = primary.get("quote_age_ms")
        if isinstance(quote_age, (int, float)) and not isinstance(quote_age, bool):
            primary_age = float(quote_age)
    normalized = (
        0.0
        if primary_age is not None and primary_age < 0
        else (
            float(max(0, int(round(primary_age))))
            if primary_age is not None
            else None
        )
    )
    clock_skew = (
        (raw is not None and raw < 0)
        or "quote_clock_skew" in issues
        or any(source.get("clock_skew_detected") is True for source in sources)
    )
    return {
        "raw_quote_age_ms": int(round(raw)) if raw is not None and raw < 0 else None,
        "normalized_quote_age_ms": normalized,
        "clock_skew_detected": clock_skew,
        "max_quote_age_ms": max_quote_age_ms(),
    }


def packet_reconnect_pending(packet: dict[str, Any]) -> bool:
    stream_health = packet_stream_health(packet)
    if stream_health is not None and stream_health.get("reconnect_pending") is True:
        return True
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )
    issues = data_quality.get("issues")
    if isinstance(issues, list):
        return any(
            issue in issues
            for issue in ("market_stream_reconnecting", "user_stream_reconnecting")
        )
    return False


def packet_quote_stale(packet: dict[str, Any]) -> bool:
    from common import max_quote_age_ms

    if packet_reconnect_pending(packet):
        return False
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )
    issues = data_quality.get("issues")
    if isinstance(issues, list) and "quote_stale" in issues:
        return True
    quote_age = packet_quote_age_ms(packet)
    if quote_age is not None:
        return quote_age > max_quote_age_ms()
    return False


def market_quiescent_skip_details(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not market_quiescence_gate_enabled():
        return None
    if directive is not None or packet_positioned(packet):
        return None
    if packet_reconnect_pending(packet):
        return None
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )
    if data_quality.get("state_complete") is not True:
        return None
    if not packet_quote_stale(packet):
        return None
    trade_count = packet_trade_count_60s(packet)
    if trade_count is None or trade_count > max_quiescent_trade_count_60s():
        return None
    quote_observation = quote_age_observation(packet)
    details: dict[str, Any] = {
        "reason": "market_quiescent",
        **quote_observation,
        "quote_age_ms": quote_observation["normalized_quote_age_ms"],
        "trade_count_60s": trade_count,
        "order_flow_trade_count_60s": trade_count,
    }
    if packet_stream_health(packet) is not None:
        details["evidence_source"] = "stream_health"
    return details


def market_quiescent_skip_reason(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
) -> str | None:
    details = market_quiescent_skip_details(packet, directive)
    return str(details["reason"]) if details else None


def stale_gateway_skip_reason(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
) -> str | None:
    """Deprecated alias for market_quiescent_skip_reason (GTHP-018)."""
    return market_quiescent_skip_reason(packet, directive)


PACKET_PROTECTION_STATUSES = frozenset({
    "pending",
    "confirmed",
    "failed",
    "unknown",
})


def packet_protection_status(packet: dict[str, Any]) -> str | None:
    """GTHP-020: Hermes-facing bracket verification state when positioned."""
    if not packet_positioned(packet):
        return None
    protection = packet.get("protection")
    if not isinstance(protection, dict):
        return "unknown"
    status = protection.get("protection_status")
    if isinstance(status, str) and status in PACKET_PROTECTION_STATUSES:
        return status
    # ponytail: pre-0.1.6 gateways expose protection.status only
    legacy = protection.get("status")
    if legacy == "proven":
        return "confirmed"
    if legacy == "pending":
        return "pending"
    if legacy == "incomplete":
        return "failed"
    return "unknown"


def protection_status_allows_amendment(status: str | None) -> bool:
    return status == "confirmed"


def protection_status_management_guidance(status: str | None) -> str | None:
    if status is None:
        return None
    if status == "confirmed":
        return (
            "protection.protection_status is confirmed — SL/TP verified on venue; "
            "full management including MOVE_STOP and MOVE_TP is available."
        )
    if status == "pending":
        return (
            "protection.protection_status is pending — venue brackets may still be landing; "
            "prefer HOLD, name the wait in the audit, and use EXIT if protection fails to confirm."
        )
    if status == "failed":
        return (
            "protection.protection_status is failed — venue SL/TP not verified within the gateway "
            "timeout; prioritize risk-reducing EXIT; do not submit MOVE_STOP or MOVE_TP."
        )
    return (
        "protection.protection_status is unknown — reconciliation incomplete; "
        "prefer HOLD or risk-reducing EXIT; do not submit MOVE_STOP or MOVE_TP."
    )


def invocation_reason(
    packet: dict[str, Any],
    state: Path,
    directive: dict[str, Any] | None,
    *,
    flat_decision_interval_minutes: int,
) -> str | None:
    packet_id = str(packet.get("packet_id") or "")
    account = packet.get("account") if isinstance(packet.get("account"), dict) else {}
    is_positioned = int(account.get("instrument_open_contracts") or 0) != 0

    if directive is not None:
        return "operator_directive"
    if is_positioned:
        return "positioned"
    if flat_outside_session_window(packet, directive):
        if wake_trigger_fired(state, packet):
            return "condition_change"
        return None
    if wake_trigger_fired(state, packet):
        return "condition_change"
    if not last_evidence_exists(state):
        return "first_packet"
    prior = latest_prior_attempt(state, packet_id)
    if prior is not None and prior.get("status") in RETRYABLE_ATTEMPT_STATUSES:
        return "retry_after_failure"
    minute = parse_utc(packet["created_utc"]).minute
    if minute % flat_decision_interval_minutes == 0:
        return "scheduled"
    return None


def read_trading_learning_artifact(path: Path, schema_version: str) -> dict[str, Any] | None:
    value = read_optional_json(path)
    if not value or value.get("schema_version") != schema_version:
        return None
    if value.get("trading_influence") != "outcome_backed":
        return None
    prompt_version = value.get("prompt_version") or value.get("decision_prompt_version")
    if prompt_version != PROMPT_VERSION:
        return None
    return value


def _truncate_text(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def _order_flow_delta(packet: dict[str, Any], seconds: int) -> float | None:
    window = order_flow_window(packet, seconds)
    if not isinstance(window, dict):
        return None
    delta = window.get("rolling_delta")
    if isinstance(delta, (int, float)) and not isinstance(delta, bool):
        return float(delta)
    return None


def compute_cycle_evidence_delta(
    current_packet: dict[str, Any],
    prior_frame: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(prior_frame, dict):
        return None
    prior_packet = prior_frame.get("packet")
    if not isinstance(prior_packet, dict):
        return None

    current_price = packet_current_price(current_packet)
    prior_price = packet_current_price(prior_packet)
    delta: dict[str, Any] = {
        "prior_minute_id": prior_frame.get("minute_id"),
        "prior_captured_utc": prior_frame.get("captured_utc"),
    }
    if current_price is not None and prior_price is not None:
        price_change = current_price - prior_price
        delta["price_change"] = round(price_change, 4)
        if prior_price:
            delta["price_change_bps"] = round(
                (price_change / prior_price) * 10_000,
                4,
            )
    for seconds in (15, 60, 300):
        current_value = _order_flow_delta(current_packet, seconds)
        prior_value = _order_flow_delta(prior_packet, seconds)
        if current_value is not None or prior_value is not None:
            delta[f"delta_{seconds}s"] = {
                "current": current_value,
                "prior": prior_value,
                "change": (
                    None
                    if current_value is None or prior_value is None
                    else round(current_value - prior_value, 4)
                ),
            }
    if len(delta) <= 2 and current_price is None:
        return None
    return delta


def repeated_change_condition_warning(
    decisions: list[dict[str, Any]],
    *,
    min_repeat: int = 2,
) -> str | None:
    if len(decisions) < min_repeat:
        return None
    recent = decisions[-min_repeat:]
    values: list[str] = []
    for row in recent:
        intent = row.get("intent") if isinstance(row.get("intent"), dict) else {}
        audit = (
            intent.get("decision_audit")
            if isinstance(intent.get("decision_audit"), dict)
            else {}
        )
        text = str(audit.get("change_condition") or "").strip().lower()
        if not text:
            return None
        values.append(text)
    if len(set(values)) == 1:
        return (
            "Prior change_condition text repeated across recent cycles; "
            "rewrite with current-cycle price, flow, and structure deltas."
        )
    return None


def delivery_diagnostic_detail(result: dict[str, Any]) -> dict[str, Any]:
    body = result.get("body") if isinstance(result.get("body"), dict) else {}
    detail: dict[str, Any] = {}
    for key in ("code", "field", "error", "message", "status"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            detail[key] = value.strip()[:240]
    http_status = result.get("http_status")
    if isinstance(http_status, int):
        detail["http_status"] = http_status
    return detail


FULL_CHANGE_CONDITION_TAIL = 2


def compact_decision_row(
    row: dict[str, Any],
    *,
    preserve_change_condition: bool = False,
) -> dict[str, Any]:
    intent = row.get("intent") if isinstance(row.get("intent"), dict) else {}
    audit = (
        intent.get("decision_audit")
        if isinstance(intent.get("decision_audit"), dict)
        else {}
    )
    change_condition = str(audit.get("change_condition") or "")
    if preserve_change_condition:
        change_condition_value = change_condition.strip() or None
    else:
        change_condition_value = (
            _truncate_text(change_condition, 240) if change_condition else None
        )
    return {
        "recorded_utc": row.get("recorded_utc"),
        "packet_id": row.get("packet_id"),
        "action": intent.get("action"),
        "intent_id": intent.get("intent_id"),
        "reason": _truncate_text(str(intent.get("reason") or ""), 240) or None,
        "final_choice": audit.get("final_choice"),
        "change_condition": change_condition_value,
    }


def compact_receipt_row(row: dict[str, Any]) -> dict[str, Any] | None:
    result = row.get("result") if isinstance(row.get("result"), dict) else {}
    body = result.get("body") if isinstance(result.get("body"), dict) else {}
    status = body.get("status") or row.get("status")
    code = body.get("code") or row.get("rejection_reason")
    http_status = result.get("http_status")
    compact = {
        "recorded_utc": row.get("recorded_utc"),
        "intent_id": row.get("intent_id"),
        "packet_id": row.get("packet_id"),
        "http_status": http_status,
        "status": status,
        "code": code,
    }
    for detail_key in ("field", "error", "message"):
        detail_value = body.get(detail_key)
        if isinstance(detail_value, str) and detail_value.strip():
            compact[detail_key] = detail_value.strip()[:240]
    if not any(
        compact.get(key) is not None
        for key in ("http_status", "status", "code", "field", "error", "message")
    ):
        return None
    return compact


def compact_outcome_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "outcome_id": row.get("outcome_id"),
        "recorded_utc": row.get("recorded_utc"),
        "classification": row.get("classification"),
        "exit_reason": row.get("exit_reason"),
        "r_multiple": row.get("r_multiple"),
        "net_pnl_usd": row.get("net_pnl_usd"),
    }


def summarize_outcomes_for_cycle(
    outcomes: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not outcomes:
        return None
    net_pnl = 0.0
    fees = 0.0
    longs = shorts = wins = losses = inconclusive = 0
    for row in outcomes:
        pnl = row.get("realized_pnl_usd")
        if pnl is None:
            pnl = row.get("net_pnl_usd")
        if isinstance(pnl, (int, float)) and not isinstance(pnl, bool):
            pnl_value = float(pnl)
            net_pnl += pnl_value
            if row.get("learning_eligible") is False:
                inconclusive += 1
            elif pnl_value > 0:
                wins += 1
            elif pnl_value < 0:
                losses += 1
            else:
                inconclusive += 1
        else:
            inconclusive += 1
        fee = row.get("fees_usd")
        if isinstance(fee, (int, float)) and not isinstance(fee, bool):
            fees += float(fee)
        side = str(row.get("side") or "").upper()
        if side == "LONG":
            longs += 1
        elif side == "SHORT":
            shorts += 1
    trade_count = len(outcomes)
    net_after_fees = net_pnl - fees
    return {
        "trade_count": trade_count,
        "net_pnl_usd": round(net_pnl, 2),
        "fees_usd": round(fees, 2),
        "net_after_fees_usd": round(net_after_fees, 2),
        "expectancy_after_fees_usd": round(net_after_fees / trade_count, 4),
        "longs": longs,
        "shorts": shorts,
        "wins": wins,
        "losses": losses,
        "inconclusive": inconclusive,
    }


def compact_cycle_ledger_context(
    *,
    decisions: list[dict[str, Any]],
    receipts: list[dict[str, Any]],
    outcomes: list[dict[str, Any]],
) -> dict[str, Any]:
    compact_decisions = [
        compact_decision_row(
            row,
            preserve_change_condition=index >= len(decisions) - FULL_CHANGE_CONDITION_TAIL,
        )
        for index, row in enumerate(decisions)
    ]
    compact_receipts = [
        item
        for item in (compact_receipt_row(row) for row in receipts)
        if item is not None
    ]
    return {
        "decisions": compact_decisions,
        "receipts": compact_receipts,
        "outcomes": [compact_outcome_row(row) for row in outcomes],
        "outcome_summary": summarize_outcomes_for_cycle(outcomes),
    }


def learning_context(supervisor: Path) -> dict[str, Any]:
    overlay = read_optional_json(supervisor / "active-cognitive-overlay.json")
    if (
        not overlay
        or overlay.get("status") not in {"active", "promoted"}
        or not (overlay.get("replacement_text") or overlay.get("instruction"))
    ):
        overlay = None
    return {
        "current_plan": read_trading_learning_artifact(
            supervisor / "current-plan.json",
            CURRENT_PLAN_SCHEMA,
        ),
        "current_guidance": read_trading_learning_artifact(
            supervisor / "current-guidance.json",
            CURRENT_GUIDANCE_SCHEMA,
        ),
        "active_cognitive_overlay": overlay,
        "outcome_backed_lessons": summarized_outcome_backed_lessons(supervisor),
    }


def summarized_outcome_backed_lessons(
    supervisor: Path,
    max_rows: int = 5,
    max_chars: int = 4_000,
) -> list[dict[str, Any]]:
    rows = [
        {
            "lesson_id": row.get("lesson_id"),
            "summary": row.get("summary") or row.get("lesson"),
            "source_review_id": row.get("source_review_id"),
            "recorded_utc": row.get("recorded_utc"),
        }
        for row in read_jsonl(supervisor / "lessons.jsonl")
        if row.get("trading_influence") == "outcome_backed"
    ]
    selected: list[dict[str, Any]] = []
    used_chars = 0
    for row in reversed(rows):
        row_chars = len(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
        if len(selected) >= max_rows or used_chars + row_chars > max_chars:
            break
        selected.append(row)
        used_chars += row_chars
    return list(reversed(selected))


def apply_cognitive_overlay(prompt: str, overlay: dict[str, Any] | None) -> str:
    if not isinstance(overlay, dict) or overlay.get("status") not in {"active", "promoted"}:
        return prompt
    if overlay.get("operation") != "replace" or overlay.get("target") != "core_prompt":
        return prompt
    expected = str(overlay.get("expected_old_text") or "")
    replacement = str(overlay.get("replacement_text") or "")
    expected_hash = str(overlay.get("expected_old_sha256") or "")
    if (
        not expected
        or not replacement
        or len(expected) > 600
        or len(replacement) > 600
        or prompt.count(expected) != 1
        or hashlib.sha256(expected.encode("utf-8")).hexdigest() != expected_hash
    ):
        return prompt
    return prompt.replace(expected, replacement, 1)


def active_trade_state(state: Path, packet: dict[str, Any]) -> dict[str, Any]:
    """Simplified Topstep open-trade continuity from packet + local ledger."""
    account = packet.get("account") if isinstance(packet.get("account"), dict) else {}
    net = int(account.get("instrument_open_contracts") or 0)
    decisions = read_jsonl(state / "decisions.jsonl")
    outcomes = read_jsonl(state / "outcomes.jsonl")
    closed_entries = {str(row.get("intent_id")) for row in outcomes if row.get("intent_id")}
    previous = read_optional_json(state / "supervisor" / "active-trade-state.json") or {}
    previous_trade = previous.get("trade") if isinstance(previous.get("trade"), dict) else {}

    trade: dict[str, Any] | None = None
    if net != 0:
        side = "long" if net > 0 else "short"
        open_entries: list[dict[str, Any]] = []
        management: list[dict[str, Any]] = []
        account_name = str(account.get("name") or packet.get("account", {}).get("name") or "")
        for row in decisions:
            intent = row.get("intent") if isinstance(row.get("intent"), dict) else {}
            if str(intent.get("account") or "") != account_name:
                continue
            action = str(intent.get("action") or "")
            intent_id = str(intent.get("intent_id") or "")
            if action in {"ENTER_LONG", "ENTER_SHORT"} and intent_id not in closed_entries:
                if (action == "ENTER_LONG") == (side == "long"):
                    open_entries.append(intent)
            elif action in {"HOLD", "EXIT"}:
                management.append(intent)

        entry_ids = [str(row.get("intent_id")) for row in open_entries if row.get("intent_id")]
        same_trade = (
            previous_trade.get("entry_intent_ids") == entry_ids
            and previous_trade.get("side") == side
        )
        unrealized = float(account.get("unrealized_pnl") or 0)
        peak = (
            max(float(previous_trade.get("peak_unrealized_pnl_usd", unrealized) or unrealized), unrealized)
            if same_trade
            else unrealized
        )
        trough = (
            min(float(previous_trade.get("trough_unrealized_pnl_usd", unrealized) or unrealized), unrealized)
            if same_trade
            else unrealized
        )
        created_values = [str(row.get("created_utc")) for row in open_entries if row.get("created_utc")]
        entry_utc = min(created_values) if created_values else str(previous_trade.get("entry_decision_utc") or "")
        if entry_utc:
            management = [row for row in management if str(row.get("created_utc") or "") >= entry_utc]
        try:
            age_seconds = max(
                0,
                int((datetime.now(timezone.utc) - parse_utc(entry_utc)).total_seconds()),
            )
        except (TypeError, ValueError):
            age_seconds = None
        trade = {
            "account": account_name,
            "instrument": packet.get("instrument"),
            "side": side,
            "quantity": abs(net),
            "unrealized_pnl_usd": unrealized,
            "peak_unrealized_pnl_usd": peak,
            "trough_unrealized_pnl_usd": trough,
            "rollback_from_peak_usd": peak - unrealized,
            "entry_decision_utc": entry_utc or None,
            "trade_age_seconds": age_seconds,
            "entry_intent_ids": entry_ids,
            "entry_plans": [
                {
                    "intent_id": row.get("intent_id"),
                    "quantity": row.get("quantity"),
                    "planned_stop": row.get("stop_loss"),
                    "planned_targets": [
                        row.get(key)
                        for key in ("take_profit_1", "take_profit_2", "take_profit_3")
                        if row.get(key) is not None
                    ],
                    "reason": row.get("reason"),
                }
                for row in open_entries
            ],
            "recent_management": [
                {
                    "intent_id": row.get("intent_id"),
                    "created_utc": row.get("created_utc"),
                    "action": row.get("action"),
                    "stop_loss": row.get("stop_loss"),
                    "take_profit_1": row.get("take_profit_1"),
                    "reason": row.get("reason"),
                }
                for row in management[-20:]
            ],
        }

    value = {
        "schema_version": "glitch.topstep.active_trade_state.v1",
        "recorded_utc": utc_now(),
        "trade": trade,
    }
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    write_json_atomic(supervisor / "active-trade-state.json", value)
    return value


def classify_delivery_result(result: dict[str, Any]) -> str:
    if not isinstance(result, dict):
        return "transport_uncertain"
    if result.get("transport_error"):
        return "transport_uncertain"
    status = result.get("http_status")
    if not isinstance(status, int):
        return "transport_uncertain"
    if status in {408, 425, 429} or status >= 500:
        return "transport_uncertain"
    if isinstance(result.get("body"), dict):
        body = result["body"]
        if body.get("code") in {
            "intent_delivery_unreconciled",
            "intent_already_processing_or_recovery_required",
        }:
            return "transport_uncertain"
    if status >= 400:
        return "terminal_rejection"
    body = result.get("body")
    if isinstance(body, dict):
        executor = body.get("executor")
        executor_code = body.get("executor_code")
        if executor == "failed":
            return "terminal_rejection"
        if executor == "skipped" and executor_code != "no_op_action":
            return "terminal_rejection"
        if executor == "pending":
            return "transport_uncertain"
    return "successful"


GATEWAY_COGNITIVE_REJECTION_CODES = frozenset({
    "stop_would_widen",
    "target_would_widen",
    "stop_wrong_side_of_market",
    "target_wrong_side_of_entry",
    "move_stop_unavailable",
    "protection_not_proven",
    "action_not_supported_in_current_packet",
    "position_already_flat",
    "position_not_found",
    "target_tranche_not_found",
    "target_tranche_already_flat",
    "exit_quantity_exceeds_tranche_remaining",
    "exit_quantity_exceeds_attributable_remaining",
    "exit_quantity_invalid",
    "target_intent_id_required",
    "protective_leg_unresolved",
    "position_side_unknown",
    "amendment_current_price_missing",
    "amendment_market_reference_missing",
    "amendment_entry_reference_missing",
    "no_execution_action",
})

GATEWAY_SYSTEM_DEFECT_CODES = frozenset({
    "intent_schema_invalid",
    "intent_delivery_unreconciled",
    "intent_already_processing_or_recovery_required",
    "intent_body_conflict",
    "projectx_mutation_rejected",
    "projectx_mutation_outcome_ambiguous",
    "protection_cancel_failed",
    "decision_packet_unknown_or_expired",
    "action_not_implemented",
    "trading_disabled_by_operator",
    "account_name_mismatch",
    "snapshot_hash_mismatch",
})


def classify_gateway_rejection(result: dict[str, Any]) -> str | None:
    if classify_delivery_result(result) != "terminal_rejection":
        return None
    body = result.get("body") if isinstance(result.get("body"), dict) else {}
    code = str(body.get("code") or body.get("executor_code") or "")
    if code in GATEWAY_COGNITIVE_REJECTION_CODES:
        return "cognitive_rejection"
    if code in GATEWAY_SYSTEM_DEFECT_CODES:
        return "system_defect"
    http_status = result.get("http_status")
    if isinstance(http_status, int) and 400 <= http_status < 500:
        return "cognitive_rejection"
    return "system_defect"


def outcome_execution_summary(outcome: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "exit_reason",
        "entry_price",
        "exit_price",
        "stop_price",
        "target_price",
        "mae_usd",
        "mfe_usd",
        "mae_ticks",
        "mfe_ticks",
        "initial_risk_usd",
        "r_multiple",
        "protection_confirmed",
        "side",
        "quantity",
        "fills",
    )
    summary = {key: outcome.get(key) for key in keys if key in outcome}
    attribution = outcome.get("attribution")
    if isinstance(attribution, dict):
        if attribution.get("protection_status"):
            summary["protection_status"] = attribution["protection_status"]
        for key in ("closing_order_id", "stop_order_id", "target_order_id", "entry_order_id"):
            if key in attribution:
                summary[key] = attribution.get(key)
    evidence = outcome.get("evidence")
    if isinstance(evidence, dict) and evidence.get("order_ids") is not None:
        summary["order_ids"] = evidence.get("order_ids")
    return summary


def debrief_facts(
    outcome: dict[str, Any],
    outcome_execution: dict[str, Any],
    entry_intent: dict[str, Any] | None,
) -> dict[str, Any]:
    intent = entry_intent if isinstance(entry_intent, dict) else {}
    return {
        "outcome_id": outcome.get("outcome_id"),
        "intent_id": outcome.get("intent_id"),
        "account": outcome.get("account"),
        "instrument": outcome.get("instrument"),
        "entry_utc": outcome.get("entry_utc"),
        "exit_utc": outcome.get("exit_utc"),
        "realized_pnl_usd": outcome.get("realized_pnl_usd"),
        "fees_usd": outcome.get("fees_usd"),
        "learning_eligible": outcome.get("learning_eligible"),
        "entry_action": intent.get("action"),
        "exit_reason": outcome_execution.get("exit_reason"),
        "mae_usd": outcome_execution.get("mae_usd"),
        "mfe_usd": outcome_execution.get("mfe_usd"),
        "initial_risk_usd": outcome_execution.get("initial_risk_usd"),
        "r_multiple": outcome_execution.get("r_multiple"),
        "protection_status": outcome_execution.get("protection_status"),
        "entry_price": outcome_execution.get("entry_price", outcome.get("entry_price")),
        "exit_price": outcome_execution.get("exit_price", outcome.get("exit_price")),
        "stop_price": outcome_execution.get("stop_price", outcome.get("stop_price")),
        "target_price": outcome_execution.get("target_price", outcome.get("target_price")),
        "side": outcome_execution.get("side", outcome.get("side")),
        "quantity": outcome_execution.get("quantity", outcome.get("quantity")),
        "fills": outcome_execution.get("fills", outcome.get("fills")),
        "order_ids": outcome_execution.get("order_ids"),
        "closing_order_id": outcome_execution.get("closing_order_id"),
        "stop_order_id": outcome_execution.get("stop_order_id"),
        "target_order_id": outcome_execution.get("target_order_id"),
        "entry_order_id": outcome_execution.get("entry_order_id"),
    }


def collect_market_path(
    frames_root: Path,
    entry: datetime,
    exit_time: datetime,
) -> list[dict[str, Any]]:
    """Collect minute-frame last/high/low between entry and exit (inclusive).

    Frames are named by minute_id (e.g. 20260811T2059Z.json), not packet_id UUID.
    Matching on packet_id therefore never finds a path — iterate by packet created_utc.
    """
    market_path: list[dict[str, Any]] = []
    if not frames_root.is_dir():
        return market_path
    for path in sorted(frames_root.glob("*.json")):
        frame = read_optional_json(path)
        if not isinstance(frame, dict):
            continue
        packet = frame.get("packet")
        if not isinstance(packet, dict):
            continue
        market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
        stamp_raw = packet.get("created_utc") or frame.get("captured_utc")
        try:
            stamp = parse_utc(stamp_raw)
        except (TypeError, ValueError):
            continue
        if stamp < entry:
            continue
        if stamp > exit_time:
            break
        try:
            close = float(market["last"])
        except (KeyError, TypeError, ValueError):
            continue
        market_path.append(
            {
                "minute_id": frame.get("minute_id"),
                "close": close,
                "high": float(market.get("high", close)),
                "low": float(market.get("low", close)),
            }
        )
    return market_path


def stable_facts_sha256(facts: dict[str, Any]) -> str:
    body = json.dumps(facts, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def debrief_prompt_evidence(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prompt_rows: list[dict[str, Any]] = []
    for row in rows:
        prompt_rows.append(
            {
                "facts": row["facts"],
                "facts_sha256": row["facts_sha256"],
                "entry_decision": row.get("entry_decision"),
                "market_path": row.get("market_path"),
                "related_decision_count": len(row.get("related_decisions") or []),
            }
        )
    return prompt_rows


def is_registered_delivery_conflict(result: dict[str, Any]) -> bool:
    if not isinstance(result, dict):
        return False
    body = result.get("body")
    return isinstance(body, dict) and body.get("code") == "intent_body_conflict"


def delivery_wire_path(state: Path, packet_id: str) -> Path:
    return state / "delivery-wire" / f"{packet_id}.json"


def load_delivery_wire(state: Path, packet_id: str) -> dict[str, Any] | None:
    payload = read_optional_json(delivery_wire_path(state, packet_id))
    if not isinstance(payload, dict):
        return None
    wire = payload.get("wire")
    return wire if isinstance(wire, dict) else None


def save_delivery_wire(state: Path, packet_id: str, wire: dict[str, Any]) -> None:
    delivery_wire_path(state, packet_id).parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(
        delivery_wire_path(state, packet_id),
        {
            "schema_version": "glitch.topstep.delivery_wire.v1",
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "intent_id": str(wire.get("intent_id") or ""),
            "wire": wire,
        },
    )


def clear_delivery_wire(state: Path, packet_id: str) -> None:
    try:
        delivery_wire_path(state, packet_id).unlink(missing_ok=True)
    except OSError:
        pass


def reconcile_registered_delivery(
    intent_id: str,
    packet_id: str,
    state: Path,
    post_intent: Callable[[dict[str, Any]], dict[str, Any]],
    fetch_receipt: Callable[[str], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    wire = load_delivery_wire(state, packet_id)
    if wire is not None:
        retry = post_intent(wire)
        if not is_registered_delivery_conflict(retry):
            return retry
    if fetch_receipt is not None and intent_id:
        receipt = fetch_receipt(intent_id)
        if isinstance(receipt, dict):
            return {"http_status": 200, "body": receipt}
    append_jsonl(
        state / "events.jsonl",
        {
            "schema_version": "glitch.topstep.cycle_event.v2",
            "event": "intent_delivery_unreconciled",
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "intent_id": intent_id,
        },
    )
    return {
        "http_status": 503,
        "body": {
            "code": "intent_delivery_unreconciled",
            "intent_id": intent_id,
        },
    }


def deliver_packet_intent(
    state: Path,
    packet_id: str,
    intent: dict[str, Any],
    directive: dict[str, Any] | None,
    post_intent: Callable[[dict[str, Any]], dict[str, Any]],
    prepare_intent_for_delivery: Callable[
        [dict[str, Any], dict[str, Any] | None],
        dict[str, Any],
    ],
    fetch_receipt: Callable[[str], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    """POST /intent with frozen wire identity across transport-uncertain retries."""
    wire = load_delivery_wire(state, packet_id)
    if wire is None:
        wire = prepare_intent_for_delivery(intent, directive)
        save_delivery_wire(state, packet_id, wire)
    result = post_intent(wire)
    if is_registered_delivery_conflict(result):
        result = reconcile_registered_delivery(
            str(intent.get("intent_id") or ""),
            packet_id,
            state,
            post_intent,
            fetch_receipt,
        )
    return result


def mark_attempt_from_receipt(state: Path, packet_id: str, result: dict[str, Any]) -> None:
    path = state / "attempts" / f"{packet_id}.json"
    if not path.is_file():
        return
    attempt = read_json(path)
    classification = classify_delivery_result(result)
    if classification == "terminal_rejection":
        attempt["status"] = "execution_failed"
    elif classification == "transport_uncertain":
        attempt["status"] = "delivery_incomplete"
    else:
        attempt["status"] = "completed"
    attempt["completed_utc"] = utc_now()
    write_json_atomic(path, attempt)


def pending_outbox(state: Path) -> tuple[str, Path] | None:
    outbox_dir = state / "outbox"
    if not outbox_dir.is_dir():
        return None
    for path in sorted(outbox_dir.glob("*.json")):
        receipt_path = state / "receipts" / f"{path.stem}.json"
        if not receipt_path.is_file():
            return path.stem, path
        receipt = read_optional_json(receipt_path)
        if isinstance(receipt, dict) and classify_delivery_result(
            receipt.get("result") if isinstance(receipt.get("result"), dict) else {}
        ) == "transport_uncertain":
            return path.stem, path
    return None


def intent_is_entry(intent: dict[str, Any]) -> bool:
    return str(intent.get("action") or "") in {"ENTER_LONG", "ENTER_SHORT"}


def _minute_frames_dir(state_or_frames_root: Path) -> Path:
    nested = state_or_frames_root / "minute-frames"
    if nested.is_dir():
        return nested
    return state_or_frames_root


def frame_for_packet_id(state_or_frames_root: Path, packet_id: str) -> dict[str, Any] | None:
    # ponytail: O(n) scan over minute-frames; fine at typical retention sizes
    frames_dir = _minute_frames_dir(state_or_frames_root)
    if not frames_dir.is_dir():
        return None
    for path in sorted(frames_dir.glob("*.json")):
        frame = read_optional_json(path)
        if not isinstance(frame, dict):
            continue
        packet = frame.get("packet")
        if isinstance(packet, dict) and str(packet.get("packet_id") or "") == packet_id:
            return frame
    return None


def packet_for_outbox_id(state: Path, packet_id: str) -> dict[str, Any] | None:
    frame = frame_for_packet_id(state, packet_id)
    if frame is None:
        return None
    packet = frame.get("packet")
    return packet if isinstance(packet, dict) else None


def prune_delivered_outboxes(state: Path) -> int:
    outbox_dir = state / "outbox"
    if not outbox_dir.is_dir():
        return 0
    pruned = 0
    for path in outbox_dir.glob("*.json"):
        receipt_path = state / "receipts" / f"{path.stem}.json"
        if not receipt_path.is_file():
            continue
        receipt = read_optional_json(receipt_path)
        if not isinstance(receipt, dict):
            continue
        result = receipt.get("result") if isinstance(receipt.get("result"), dict) else {}
        if classify_delivery_result(result) == "transport_uncertain":
            continue
        try:
            path.unlink(missing_ok=True)
            pruned += 1
        except OSError:
            continue
    return pruned


def discard_stale_outbox_intent(
    state: Path,
    outbox_path: Path,
    packet_id: str,
    intent: dict[str, Any],
    *,
    token: str,
) -> bool:
    """Discard only when the decision packet was never captured locally.

    A newer gateway packet never mutates a completed decision. Entry delivery is
    permitted only while its frozen v3 scope and price range remain valid.
    """
    del token  # retained for call-site compatibility
    reason: str | None = None
    if packet_for_outbox_id(state, packet_id) is None:
        reason = "stored_packet_not_found"
    if reason is None:
        return False
    try:
        outbox_path.unlink(missing_ok=True)
    except OSError:
        return False
    append_jsonl(
        state / "events.jsonl",
        {
            "schema_version": "glitch.topstep.cycle_event.v2",
            "event": "intent_discarded_stale_packet",
            "reason": reason,
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "action": str(intent.get("action") or ""),
        },
    )
    return True


ENTRY_GEOMETRY_ERRORS = frozenset({
    "long_geometry_invalid",
    "short_geometry_invalid",
    "entry_range_superseded",
    "entry_scope_superseded",
    "entry_intent_expired",
})


def discard_unexecutable_entry_outbox(
    state: Path,
    outbox_path: Path,
    packet_id: str,
    intent: dict[str, Any],
    error: BaseException,
) -> bool:
    """Discard entry outbox when live quote no longer sits between stop and target.

    Pending outbox retries validate against the stored decision packet, then
    prepare_intent_for_delivery re-checks geometry and the frozen range on the
    fresh quote. Superseded entries are dropped once so the next cycle performs
    one fresh comparison; the old range is never widened.
    """
    if not intent_is_entry(intent):
        return False
    if str(error) not in ENTRY_GEOMETRY_ERRORS:
        return False
    try:
        outbox_path.unlink(missing_ok=True)
    except OSError:
        return False
    clear_delivery_wire(state, packet_id)
    append_jsonl(
        state / "events.jsonl",
        {
            "schema_version": "glitch.topstep.cycle_event.v2",
            "event": "intent_discarded_geometry_invalid",
            "reason": str(error),
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "intent_id": str(intent.get("intent_id") or ""),
            "action": str(intent.get("action") or ""),
            "stop_loss": intent.get("stop_loss"),
            "take_profit_1": intent.get("take_profit_1"),
        },
    )
    return True


FLAT_ABSTENTION_CLASSIFICATIONS = frozenset({
    "justified_abstention",
    "avoided_adverse_movement",
    "missed_directional_participation",
    "ambiguous",
})


def suggest_flat_abstention_classification(
    *,
    initial_price: float,
    forward_high: float,
    forward_low: float,
    forward_close: float,
    tick_size: float = 0.25,
) -> str:
    # ponytail: coarse price-path heuristic; Hermes may override in hourly review
    up = forward_high - initial_price
    down = initial_price - forward_low
    move = abs(forward_close - initial_price)
    noise = max(tick_size * 8, initial_price * 0.00005)
    if move <= noise and max(up, down) <= noise * 2:
        return "justified_abstention"
    if up > down * 1.5 and up > noise * 2:
        return "missed_directional_participation"
    if down > up * 1.5 and down > noise * 2:
        return "avoided_adverse_movement"
    return "ambiguous"


def wait_for_packet_rollover(
    packet: dict[str, Any],
    wait_seconds: float,
    *,
    token: str,
) -> dict[str, Any]:
    if wait_seconds <= 0 or not packet:
        return packet
    try:
        created = parse_utc(packet["created_utc"])
        age_seconds = (datetime.now(timezone.utc) - created).total_seconds()
    except (KeyError, TypeError, ValueError):
        return packet
    if age_seconds < 50:
        return packet
    packet_id = str(packet.get("packet_id") or "")
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
        status, candidate = request_json("/packet", token=token)
        if status == 200 and isinstance(candidate, dict):
            if str(candidate.get("packet_id") or "") != packet_id:
                return candidate
    return packet


def debrief_evidence(state: Path, outcomes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    decisions = read_jsonl(state / "decisions.jsonl")
    receipts_by_packet: dict[str, dict[str, Any]] = {}
    for path in (state / "receipts").glob("*.json"):
        receipt = read_optional_json(path)
        if isinstance(receipt, dict):
            receipts_by_packet[path.stem] = receipt

    frames_root = state / "minute-frames"
    evidence: list[dict[str, Any]] = []
    for outcome in outcomes:
        intent_id = str(outcome.get("intent_id") or "")
        entry = parse_utc(outcome["entry_utc"])
        exit_time = parse_utc(outcome["exit_utc"])
        account = str(outcome.get("account") or "")

        related_decisions = []
        for row in decisions:
            intent = row.get("intent") if isinstance(row.get("intent"), dict) else {}
            if str(intent.get("account") or "") != account:
                continue
            try:
                stamp = parse_utc(row.get("recorded_utc"))
            except (TypeError, ValueError):
                continue
            if entry - timedelta(seconds=90) <= stamp <= exit_time + timedelta(seconds=90):
                related_decisions.append(row)

        entry_row = next(
            (
                row
                for row in decisions
                if isinstance(row.get("intent"), dict)
                and str(row["intent"].get("intent_id") or "") == intent_id
            ),
            None,
        )
        entry_intent = entry_row.get("intent") if isinstance(entry_row, dict) else None
        packet_id = str(
            (entry_row or {}).get("packet_id")
            or (entry_intent or {}).get("packet_id")
            or ""
        )
        if not packet_id:
            for row in related_decisions:
                packet_id = str(row.get("packet_id") or "")
                if packet_id:
                    break

        market_path = collect_market_path(frames_root, entry, exit_time)

        evidence.append(
            {
                "outcome": outcome,
                "outcome_execution": outcome_execution_summary(outcome),
                "entry_decision": entry_intent,
                "related_decisions": related_decisions,
                "delivery_receipt": receipts_by_packet.get(packet_id),
                "market_path": market_path,
            }
        )
    for row in evidence:
        execution = row.get("outcome_execution")
        if not isinstance(execution, dict):
            execution = {}
        facts = debrief_facts(
            row["outcome"],
            execution,
            row.get("entry_decision") if isinstance(row.get("entry_decision"), dict) else None,
        )
        row["facts"] = facts
        row["facts_sha256"] = stable_facts_sha256(facts)
    return evidence
