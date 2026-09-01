"""Print a comparison table of gateway packets captured in local minute-frames."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from common import configure_environment, state_root


def parse_utc(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except (TypeError, ValueError):
        return None


def short(value: Any, length: int = 10) -> str:
    text = str(value or "")
    if len(text) > length:
        return f"{text[:length]}…"
    return text


def trade_count_60s(packet: dict[str, Any]) -> int | None:
    stream_health = packet.get("stream_health")
    if isinstance(stream_health, dict):
        trade_count = stream_health.get("trade_count_60s")
        if isinstance(trade_count, bool):
            pass
        elif isinstance(trade_count, int):
            return trade_count
        elif isinstance(trade_count, float):
            return int(trade_count)
    order_flow = packet.get("order_flow")
    if not isinstance(order_flow, dict):
        return None
    observation = order_flow.get("observation")
    if not isinstance(observation, dict):
        return None
    for window in observation.get("windows") or []:
        if isinstance(window, dict) and window.get("window_seconds") == 60:
            count = window.get("trade_count")
            if isinstance(count, (int, float)) and not isinstance(count, bool):
                return int(count)
    return None


def bar_1m_close(packet: dict[str, Any]) -> float | None:
    market_observation = packet.get("market_observation")
    if not isinstance(market_observation, dict):
        return None
    observation = market_observation.get("observation")
    if not isinstance(observation, dict):
        return None
    for timeframe in observation.get("timeframes") or []:
        if not isinstance(timeframe, dict) or timeframe.get("timeframe_minutes") != 1:
            continue
        features = timeframe.get("features")
        if isinstance(features, dict):
            close = features.get("latest_close")
            if isinstance(close, (int, float)) and not isinstance(close, bool):
                return float(close)
    return None


def row_from_frame(frame: dict[str, Any]) -> dict[str, Any]:
    packet = frame.get("packet")
    if not isinstance(packet, dict):
        packet = {}
    market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
    data_quality = (
        packet.get("data_quality") if isinstance(packet.get("data_quality"), dict) else {}
    )
    execution = packet.get("execution") if isinstance(packet.get("execution"), dict) else {}
    policy = packet.get("policy") if isinstance(packet.get("policy"), dict) else {}
    session = packet.get("session") if isinstance(packet.get("session"), dict) else {}
    account = packet.get("account") if isinstance(packet.get("account"), dict) else {}
    stream_health = (
        packet.get("stream_health") if isinstance(packet.get("stream_health"), dict) else {}
    )
    issues = data_quality.get("issues")
    issue_text = ",".join(issues) if isinstance(issues, list) and issues else "-"
    quote_age = stream_health.get("quote_age_ms")
    if quote_age is None:
        quote_age = data_quality.get("quote_age_ms")
    return {
        "utc": frame.get("captured_utc") or frame.get("minute_id"),
        "packet_id": short(packet.get("packet_id"), 10),
        "phase": session.get("phase"),
        "entry_open": session.get("entry_window_open"),
        "last": market.get("last"),
        "bid": market.get("bid"),
        "ask": market.get("ask"),
        "spread": market.get("spread_ticks"),
        "quote_age": quote_age,
        "state_ok": data_quality.get("state_complete"),
        "issues": issue_text,
        "trades_60s": trade_count_60s(packet),
        "reconnect": stream_health.get("reconnect_pending"),
        "pos": account.get("instrument_open_contracts"),
        "mode": execution.get("gateway_mode"),
        "new_exp": execution.get("new_exposure_technically_supported"),
        "buffer": policy.get("current_buffer_usd"),
        "bar_1m": bar_1m_close(packet),
        "hash": short(market.get("snapshot_hash"), 10),
    }


def changed_fields(current: dict[str, Any], previous: dict[str, Any]) -> str:
    skip = {"utc", "delta", "packet_id"}
    changed = [key for key in current if key not in skip and current.get(key) != previous.get(key)]
    return ",".join(changed) if changed else "-"


def load_frames(frames_dir: Path, *, window: timedelta) -> list[dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - window
    rows: list[tuple[datetime, dict[str, Any]]] = []
    for path in sorted(frames_dir.glob("*.json")):
        try:
            frame = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(frame, dict):
            continue
        timestamp = parse_utc(frame.get("captured_utc"))
        if timestamp is None:
            packet = frame.get("packet")
            if isinstance(packet, dict):
                timestamp = parse_utc(packet.get("created_utc"))
        if timestamp is None or timestamp < cutoff:
            continue
        rows.append((timestamp, row_from_frame(frame)))
    rows.sort(key=lambda item: item[0])
    return [row for _, row in rows]


def print_table(rows: list[dict[str, Any]], *, window_label: str) -> None:
    columns = [
        ("utc", "UTC captura"),
        ("phase", "Sessao"),
        ("entry_open", "EntryWin"),
        ("last", "Last"),
        ("bid", "Bid"),
        ("ask", "Ask"),
        ("spread", "Sprd"),
        ("quote_age", "Q_age_ms"),
        ("state_ok", "StComplete"),
        ("issues", "Issues"),
        ("trades_60s", "Trd60s"),
        ("reconnect", "Reconn"),
        ("pos", "Pos"),
        ("mode", "Mode"),
        ("new_exp", "NewExp"),
        ("buffer", "Buffer$"),
        ("bar_1m", "Bar1m"),
        ("hash", "SnapHash"),
        ("delta", "Mudou vs anterior"),
    ]
    if not rows:
        print(f"Nenhum minute-frame em {window_label}.")
        return

    previous: dict[str, Any] | None = None
    for row in rows:
        row["delta"] = "(base)" if previous is None else changed_fields(row, previous)
        previous = row

    widths = {
        key: max(len(label), *(len(str(row.get(key, ""))) for row in rows))
        for key, label in columns
    }
    header = " | ".join(label.ljust(widths[key]) for key, label in columns)
    separator = "-+-".join("-" * widths[key] for key, _ in columns)
    print(f"Minute-frames: {len(rows)} registros | janela: {window_label}\n")
    print(header)
    print(separator)
    for row in rows:
        print(" | ".join(str(row.get(key, "")).ljust(widths[key]) for key, _ in columns))

    phases = [str(row.get("phase") or "") for row in rows]
    if len(set(phases)) > 1:
        print("\n--- transicoes de sessao ---")
        last_phase: str | None = None
        for row in rows:
            phase = str(row.get("phase") or "")
            if phase != last_phase:
                print(f"  {row.get('utc')}  ->  {phase}")
                last_phase = phase

    print("\n--- packet_id por linha ---")
    for row in rows:
        print(f"  {row.get('utc')}  {row.get('packet_id')}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare gateway packets stored in local minute-frames.",
    )
    parser.add_argument(
        "--minutes",
        type=int,
        default=60,
        help="Lookback window in minutes (default: 60).",
    )
    args = parser.parse_args()
    minutes = max(1, int(args.minutes))
    window = timedelta(minutes=minutes)

    root = configure_environment()
    frames_dir = state_root(root) / "minute-frames"
    if not frames_dir.is_dir():
        print(f"Diretorio inexistente: {frames_dir}", file=sys.stderr)
        return 1

    rows = load_frames(frames_dir, window=window)
    label = f"ultimos {minutes} min"
    print_table(rows, window_label=label)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
