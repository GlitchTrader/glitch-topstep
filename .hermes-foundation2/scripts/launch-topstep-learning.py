"""Launch the slow Topstep learning worker without occupying Hermes cron."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from common import PROFILE_NAME, configure_environment


def lock_is_active(path: Path, stale_seconds: int) -> bool:
    try:
        return time.time() - path.stat().st_mtime <= stale_seconds
    except FileNotFoundError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = configure_environment()
    state = root / "state"
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    lock_path = state / "learning-cycle.lock"
    if lock_is_active(lock_path, max(args.timeout_seconds * 4, 1800)):
        print(json.dumps({"launched": False, "reason": "learning_cycle_already_running"}))
        return 0

    command = [
        sys.executable,
        str(Path(__file__).with_name("run-topstep-learning.py")),
        "--profile", args.profile,
        "--timeout-seconds", str(args.timeout_seconds),
    ]
    if args.dry_run:
        command.append("--dry-run")
    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    log_path = supervisor / "learning-worker.log"
    with log_path.open("a", encoding="utf-8") as output:
        output.write(json.dumps({
            "event": "learning_worker_launched",
            "launched_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "profile": args.profile,
        }, separators=(",", ":")) + "\n")
        output.flush()
        process = subprocess.Popen(
            command,
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=sys.platform != "win32",
        )
    print(json.dumps({"launched": True, "pid": process.pid, "worker": "run-topstep-learning.py"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
