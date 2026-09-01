"""Launch the durable wake-trigger monitor without occupying Hermes cron."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from common import (
    PROFILE_NAME,
    configure_environment,
    read_optional_json,
    state_root,
    utc_now,
    write_json_atomic,
)


def lock_is_active(path: Path, stale_seconds: float) -> bool:
    try:
        return time.time() - path.stat().st_mtime <= stale_seconds
    except FileNotFoundError:
        return False


def pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # ponytail: OpenProcess would be cleaner; tasklist is available without pywin32.
        probe = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return str(pid) in (probe.stdout or "")
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def monitor_already_running(supervisor: Path, lock_path: Path, poll_seconds: float) -> bool:
    launcher = read_optional_json(supervisor / "wake-monitor-launcher.json")
    if isinstance(launcher, dict):
        try:
            pid = int(launcher.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        if pid_is_running(pid):
            return True
    # Heartbeat from the loop; allow several missed polls before relaunch.
    return lock_is_active(lock_path, max(poll_seconds * 20, 300))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    args = parser.parse_args()
    root = configure_environment()
    state = state_root(root)
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    lock_path = state / "wake-monitor.lock"
    poll_seconds = float(os.environ.get("GLITCH_TOPSTEP_WAKE_POLL_SECONDS", "15"))
    if monitor_already_running(supervisor, lock_path, poll_seconds):
        print(json.dumps({"launched": False, "reason": "wake_monitor_already_running"}))
        return 0

    command = [
        sys.executable,
        str(Path(__file__).with_name("run-wake-trigger-monitor.py")),
        "--profile",
        args.profile,
        "--loop",
    ]
    # CREATE_NO_WINDOW alone — DETACHED_PROCESS can fight it and flash consoles on Windows.
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    if sys.platform == "win32":
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    log_path = supervisor / "wake-monitor.log"
    environment = os.environ.copy()
    environment["HERMES_HOME"] = str(root)
    with log_path.open("a", encoding="utf-8", newline="\n") as output:
        output.write(
            json.dumps(
                {
                    "event": "wake_monitor_launched",
                    "launched_utc": datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "profile": args.profile,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        output.flush()
        process = subprocess.Popen(
            command,
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            env=environment,
            creationflags=creationflags,
            start_new_session=sys.platform != "win32",
        )
    write_json_atomic(
        supervisor / "wake-monitor-launcher.json",
        {
            "schema_version": "glitch.topstep.wake_monitor_launcher.v1",
            "recorded_utc": utc_now(),
            "pid": process.pid,
        },
    )
    print(json.dumps({"launched": True, "pid": process.pid, "worker": "run-wake-trigger-monitor.py"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
