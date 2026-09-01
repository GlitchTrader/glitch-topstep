"""PRAC supervised flatten via POST /control (operator token)."""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))

from gateway_client import request_json  # noqa: E402


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    env_path = ROOT / ".env"
    if env_path.is_file():
        for raw in env_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = raw.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError(f"{name} not configured")


def main() -> int:
    operator_token = load_env("GLITCH_OPERATOR_TOKEN")
    model_token = load_env("GLITCH_LOCAL_TOKEN")
    reason = sys.argv[1] if len(sys.argv) > 1 else "Operator authorized supervised flatten."

    status, packet = request_json("/packet", token=model_token)
    if status != 200 or not isinstance(packet, dict):
        print(json.dumps({"error": "packet_fetch_failed", "status": status}))
        return 1

    account = packet.get("account") or {}
    contract = packet.get("contract") or {}
    open_qty = int(account.get("instrument_open_contracts") or 0)
    pre = {
        "submitted_utc": utc_now(),
        "phase": "pre_flatten",
        "open_qty": open_qty,
        "protection_status": (packet.get("protection") or {}).get("protection_status"),
        "unprotected_open_quantity": (packet.get("protection") or {}).get("unprotected_open_quantity"),
    }
    print(json.dumps(pre, indent=2))

    if open_qty <= 0:
        print(json.dumps({"result": "already_flat", "checked_utc": utc_now()}, indent=2))
        return 0

    control_id = str(uuid.uuid4())
    command = {
        "schema_version": "glitch.topstep.control.v1",
        "control_id": control_id,
        "action": "flatten",
        "account_id": int(account.get("id") or 0),
        "contract_id": str(contract.get("id") or ""),
        "issuer": "local_operator",
        "created_utc": utc_now(),
        "reason": reason,
    }
    submit_status, control = request_json("/control", method="POST", token=operator_token, body=command)
    print(json.dumps({
        "phase": "flatten_submitted",
        "http_status": submit_status,
        "control_id": control_id,
        "control": control,
    }, indent=2))
    if submit_status not in {200, 202}:
        return 2

    poll: list[dict] = []
    final: dict | None = None
    for iteration in range(45):
        time.sleep(4)
        control_status, control_body = request_json(f"/control?control_id={control_id}", token=operator_token)
        packet_status, current = request_json("/packet", token=model_token)
        snapshot = {
            "iter": iteration + 1,
            "checked_utc": utc_now(),
            "control_http": control_status,
            "control_status": control_body.get("status") if isinstance(control_body, dict) else None,
            "control_detail": control_body.get("detail") if isinstance(control_body, dict) else None,
            "open_qty": int((current.get("account") or {}).get("instrument_open_contracts") or 0)
            if packet_status == 200 and isinstance(current, dict) else None,
            "working_orders": int((current.get("account") or {}).get("working_orders") or 0)
            if packet_status == 200 and isinstance(current, dict) else None,
            "protection_status": (current.get("protection") or {}).get("protection_status")
            if packet_status == 200 and isinstance(current, dict) else None,
        }
        poll.append(snapshot)
        final = snapshot
        if snapshot.get("control_status") == "completed" and (snapshot.get("open_qty") or 0) == 0:
            break
        if snapshot.get("control_status") == "failed":
            break

    out = {
        "result_utc": utc_now(),
        "control_id": control_id,
        "command": command,
        "poll": poll,
        "final": final,
        "success": bool(
            final
            and final.get("control_status") == "completed"
            and (final.get("open_qty") or 0) == 0
        ),
    }
    print(json.dumps(out, indent=2))
    return 0 if out["success"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
