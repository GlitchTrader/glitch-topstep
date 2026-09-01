"""Poll gateway state during PRAC directed tests."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))

from gateway_client import request_json  # noqa: E402


def load_token() -> str:
    token = os.environ.get("GLITCH_LOCAL_TOKEN", "").strip()
    if token:
        return token
    for raw in (ROOT / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("GLITCH_LOCAL_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GLITCH_LOCAL_TOKEN not configured")


def main() -> int:
    token = load_token()
    iterations = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    snapshots: list[dict] = []
    for iteration in range(iterations):
        _, health = request_json("/health", token=token)
        _, packet = request_json("/packet", token=token)
        protection = (packet or {}).get("protection") or {}
        execution = (packet or {}).get("execution") or {}
        snapshot = {
            "iter": iteration + 1,
            "open_qty": int(((packet or {}).get("account") or {}).get("instrument_open_contracts") or 0),
            "working_orders": int(((packet or {}).get("account") or {}).get("working_orders") or 0),
            "protection_status": protection.get("protection_status"),
            "unprotected_open_quantity": protection.get("unprotected_open_quantity"),
            "protected_reduction_saga": execution.get("protected_reduction_saga"),
            "recovery": (health or {}).get("recovery", {}).get("status") if isinstance(health, dict) else None,
        }
        receipts = execution.get("recent_receipts") or []
        if receipts:
            latest = receipts[-1]
            snapshot["latest_receipt"] = {
                "status": latest.get("status"),
                "code": latest.get("code"),
            }
        print(json.dumps(snapshot))
        snapshots.append(snapshot)
        time.sleep(interval)
    print(json.dumps({"final": snapshots[-1] if snapshots else None}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
