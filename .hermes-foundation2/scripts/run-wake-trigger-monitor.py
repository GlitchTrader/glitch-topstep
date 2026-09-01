"""Poll gateway evidence between cron ticks and launch direct-cycle on wake triggers."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from common import (
    PROFILE_NAME,
    configure_environment,
    local_token,
    read_optional_json,
    request_json,
    state_root,
    utc_now,
    verify_gateway_compatibility,
    write_json_atomic,
)
from parity import (
    monitor_should_launch_cycle,
    record_wake_trigger_fire,
    write_pending_wake_invocation,
)


def flat_decision_interval_minutes() -> int:
    raw = os.environ.get("GLITCH_TOPSTEP_FLAT_DECISION_INTERVAL_MINUTES", "5")
    try:
        return max(1, int(raw))
    except ValueError:
        return 5


def wake_poll_seconds() -> float:
    raw = os.environ.get("GLITCH_TOPSTEP_WAKE_POLL_SECONDS", "15")
    try:
        value = float(raw)
    except ValueError:
        value = 15.0
    return max(5.0, value)


def read_directive(state: Path) -> dict | None:
    path = state / "operator-directive.json"
    value = read_optional_json(path)
    if not isinstance(value, dict):
        return None
    if value.get("status") != "pending":
        return None
    return value


def launch_direct_cycle(root: Path) -> int:
    launch_script = Path(__file__).with_name("launch-topstep-cycle.py")
    environment = os.environ.copy()
    environment["HERMES_HOME"] = str(root)
    result = subprocess.run(
        [sys.executable, str(launch_script)],
        cwd=str(launch_script.parent),
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
    )
    return result.returncode


def poll_once(root: Path) -> dict[str, object]:
    state = state_root(root)
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    status_path = supervisor / "wake-monitor-status.json"

    health_status, health = request_json("/health")
    if health_status != 200 or health.get("status") not in {"ok", "degraded"}:
        write_json_atomic(
            status_path,
            {
                "schema_version": "glitch.topstep.wake_monitor_status.v1",
                "recorded_utc": utc_now(),
                "status": "gateway_unavailable",
            },
        )
        return {"polled": False, "reason": "gateway_unavailable"}

    verify_gateway_compatibility(health)
    token = local_token()
    packet_status, packet = request_json("/packet", token=token)
    if packet_status != 200 or not isinstance(packet, dict):
        write_json_atomic(
            status_path,
            {
                "schema_version": "glitch.topstep.wake_monitor_status.v1",
                "recorded_utc": utc_now(),
                "status": "packet_unavailable",
            },
        )
        return {"polled": False, "reason": "packet_unavailable"}

    directive = read_directive(state)
    wake_detail = monitor_should_launch_cycle(
        state,
        packet,
        directive,
        flat_decision_interval_minutes=flat_decision_interval_minutes(),
    )
    if not wake_detail:
        write_json_atomic(
            status_path,
            {
                "schema_version": "glitch.topstep.wake_monitor_status.v1",
                "recorded_utc": utc_now(),
                "status": "idle",
                "packet_id": packet.get("packet_id"),
            },
        )
        return {"polled": True, "launched": False}

    trigger = wake_detail.get("wake_trigger")
    if not isinstance(trigger, dict):
        return {"polled": True, "launched": False, "reason": "wake_trigger_invalid"}

    record_wake_trigger_fire(state, trigger, packet, source="monitor")
    write_pending_wake_invocation(state, wake_detail, packet)
    exit_code = launch_direct_cycle(root)
    write_json_atomic(
        status_path,
        {
            "schema_version": "glitch.topstep.wake_monitor_status.v1",
            "recorded_utc": utc_now(),
            "status": "launched",
            "packet_id": packet.get("packet_id"),
            "wake_reason": wake_detail.get("wake_reason"),
            "launch_exit_code": exit_code,
        },
    )
    return {
        "polled": True,
        "launched": True,
        "wake_reason": wake_detail.get("wake_reason"),
        "exit_code": exit_code,
    }


def refresh_lock(lock_path: Path) -> None:
    lock_path.write_text(utc_now(), encoding="utf-8")


def run_loop(root: Path) -> int:
    state = state_root(root)
    lock_path = state / "wake-monitor.lock"
    poll_seconds = wake_poll_seconds()
    if lock_path.is_file():
        try:
            age = time.time() - lock_path.stat().st_mtime
        except OSError:
            age = 0.0
        # Match launcher heartbeat window so a live loop is not treated as stale.
        if age < max(poll_seconds * 20, 300):
            print(json.dumps({"running": False, "reason": "monitor_already_running"}))
            return 0
        lock_path.unlink(missing_ok=True)

    refresh_lock(lock_path)
    try:
        while True:
            try:
                result = poll_once(root)
                print(json.dumps(result, separators=(",", ":")))
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "polled": False,
                            "error": f"{type(error).__name__}:{error}"[:500],
                        },
                        separators=(",", ":"),
                    )
                )
            refresh_lock(lock_path)
            time.sleep(poll_seconds)
    finally:
        lock_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    parser.add_argument("--once", action="store_true", help="Single poll iteration.")
    parser.add_argument("--loop", action="store_true", help="Continuous polling loop.")
    args = parser.parse_args()
    root = configure_environment()
    if args.once:
        print(json.dumps(poll_once(root), separators=(",", ":")))
        return 0
    if args.loop:
        return run_loop(root)
    print(json.dumps(poll_once(root), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
