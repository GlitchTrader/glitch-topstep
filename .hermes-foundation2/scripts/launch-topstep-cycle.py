"""Launch the Glitch Topstep operator without occupying Hermes native cron."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import PROFILE_NAME, configure_environment


def worker_command(args: argparse.Namespace) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).with_name("run-topstep-cycle.py")),
        "--profile",
        args.profile,
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--packet-rollover-wait-seconds",
        str(args.packet_rollover_wait_seconds),
    ]
    if args.dry_run:
        command.append("--dry-run")
    return command


def launch(args: argparse.Namespace) -> dict[str, object]:
    root = configure_environment()
    events = root / "state" / "events"
    events.mkdir(parents=True, exist_ok=True)
    log_path = events / "direct-worker.log"

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )

    environment = os.environ.copy()
    environment["HERMES_HOME"] = str(root)
    with log_path.open("a", encoding="utf-8", newline="\n") as output:
        output.write(
            json.dumps(
                {
                    "event": "direct_worker_launched",
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
            worker_command(args),
            cwd=str(Path(__file__).parent),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            env=environment,
            creationflags=creationflags,
            start_new_session=sys.platform != "win32",
        )

    return {
        "launched": True,
        "pid": process.pid,
        "worker": "run-topstep-cycle.py",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.environ.get("GLITCH_TOPSTEP_MODEL_TIMEOUT_SECONDS", "240")),
    )
    parser.add_argument(
        "--packet-rollover-wait-seconds",
        type=float,
        default=float(os.environ.get("GLITCH_TOPSTEP_PACKET_ROLLOVER_WAIT_SECONDS", "5")),
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(launch(args), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
