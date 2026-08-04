"""Monitor gateway flat transitions and trade outcome publication (TS-R3-03 Phase B)."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HERMES_STATE = Path(
    r"C:\Users\arifr\AppData\Local\hermes\profiles\glitch-topstep\state"
)
HERMES_OUTCOMES = HERMES_STATE / "outcomes.jsonl"
HERMES_EPISODES = HERMES_STATE / "trade-episodes.jsonl"
LEARNING_STATUS = HERMES_STATE / "supervisor" / "learning-worker-status.json"
EVENTS = DATA / "events.jsonl"
GW_OUTCOMES = DATA / "trade-outcomes.jsonl"
POLL_SECONDS = 15
MAX_HOURS = 12


def load_env_token() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("GLITCH_LOCAL_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("GLITCH_LOCAL_TOKEN missing")


def gateway_get(path: str, token: str) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:8790{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def line_count(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def tail_jsonl(path: Path, limit: int = 3) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows[-limit:]


def published_events() -> list[dict]:
    if not EVENTS.is_file():
        return []
    rows = []
    for line in EVENTS.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("event") == "trade_outcomes_published":
            rows.append(row)
    return rows


def learning_trade_episode_count() -> int | None:
    if not LEARNING_STATUS.is_file():
        return None
    try:
        data = json.loads(LEARNING_STATUS.read_text(encoding="utf-8"))
        return int(data.get("trade_episode_count", 0))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] {message}", flush=True)


def main() -> int:
    token = load_env_token()
    deadline = time.time() + MAX_HOURS * 3600
    last_open: int | None = None
    saw_position = False
    saw_flat_after_position = False

    log("MONITOR_START baseline flat; waiting for positioned trade then flat + outcomes")

    while time.time() < deadline:
        try:
            packet = gateway_get("/packet", token)
            outcomes = gateway_get("/outcomes?limit=10", token)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            log(f"GATEWAY_UNREACHABLE {error}")
            time.sleep(POLL_SECONDS)
            continue

        open_contracts = int(packet.get("account", {}).get("instrument_open_contracts", 0))
        outcome_count = int(outcomes.get("count", 0))
        gw_lines = line_count(GW_OUTCOMES)
        hermes_lines = line_count(HERMES_OUTCOMES)
        episode_count = learning_trade_episode_count()
        publish_events = published_events()

        if last_open is not None and open_contracts != last_open:
            log(f"POSITION_CHANGE {last_open} -> {open_contracts}")
        last_open = open_contracts

        if open_contracts > 0:
            saw_position = True
            protection = packet.get("protection", {}).get("status", "unknown")
            log(
                f"POSITIONED open={open_contracts} protection={protection} "
                f"must_flat={packet.get('session', {}).get('must_flat_utc')}"
            )
        elif saw_position:
            saw_flat_after_position = True
            log(
                f"FLAT_DETECTED outcomes_api={outcome_count} gw_file={gw_lines} "
                f"hermes_file={hermes_lines} publish_events={len(publish_events)} "
                f"trade_episodes={episode_count}"
            )

        success = (
            saw_flat_after_position
            and outcome_count > 0
            and gw_lines > 0
            and len(publish_events) > 0
        )
        if success:
            latest = outcomes.get("outcomes", [])
            latest_event = publish_events[-1] if publish_events else {}
            log("SUCCESS trade_outcome pipeline confirmed")
            print("=== OUTCOME_PUBLISHED ===", flush=True)
            print(json.dumps({
                "outcome_count": outcome_count,
                "gateway_outcomes": tail_jsonl(GW_OUTCOMES, 1),
                "hermes_outcomes": tail_jsonl(HERMES_OUTCOMES, 1),
                "publish_event": latest_event,
                "trade_episode_count": episode_count,
                "hermes_episodes": tail_jsonl(HERMES_EPISODES, 1),
            }, indent=2), flush=True)
            return 0

        if saw_flat_after_position and outcome_count == 0:
            log("FLAT_BUT_NO_OUTCOME_YET rechecking...")

        time.sleep(POLL_SECONDS)

    log("MONITOR_TIMEOUT no published outcome within window")
    return 1


if __name__ == "__main__":
    sys.exit(main())
