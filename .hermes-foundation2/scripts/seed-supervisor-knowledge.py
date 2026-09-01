"""Install NT-adapted supervisor knowledge seeds into the live Topstep profile."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import configure_environment, profile_root, write_json_atomic


SEED_FILES = (
    "current-guidance.json",
    "current-plan.json",
    "proposed-cognitive-overlay.json",
)


def seed_supervisor(profile: str, *, force: bool) -> int:
    root = profile_root(profile)
    seeds = root / "supervisor-seeds"
    supervisor = profile_root(profile) / "state" / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    installed = 0
    for name in SEED_FILES:
        source = seeds / name
        if not source.is_file():
            continue
        destination = supervisor / name
        if destination.is_file() and not force:
            continue
        value = json.loads(source.read_text(encoding="utf-8"))
        write_json_atomic(destination, value)
        installed += 1
        print(json.dumps({"installed": name, "path": str(destination)}, separators=(",", ":")))
    return 0 if installed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="glitch-topstep")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    configure_environment()
    return seed_supervisor(args.profile, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
