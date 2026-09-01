"""Capture PRAC test evidence JSON from gateway endpoints."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))

from gateway_client import request_json  # noqa: E402


def load_token(name: str) -> str:
    token = os.environ.get(name, "").strip()
    if token:
        return token
    for raw in (ROOT / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError(f"{name} not configured")


def main() -> int:
    token = load_token("GLITCH_LOCAL_TOKEN")
    exit_intent = sys.argv[1] if len(sys.argv) > 1 else None
    entry_intent = sys.argv[2] if len(sys.argv) > 2 else None
    out: dict = {"recorded_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    _, out["health"] = request_json("/health", token=token)
    _, out["packet"] = request_json("/packet", token=token)
    if exit_intent:
        _, out["exit_receipt"] = request_json(f"/intent/receipt?intent_id={exit_intent}", token=token)
        _, out["exit_status"] = request_json(f"/intent/status?intent_id={exit_intent}", token=token)
    if entry_intent:
        _, out["entry_receipt"] = request_json(f"/intent/receipt?intent_id={entry_intent}", token=token)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
