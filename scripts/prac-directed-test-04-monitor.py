"""PRAC test 4 — poll for manual OCO leg cancel, then capture final state."""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def snapshot_fields(packet: dict, health: dict | None, iteration: int) -> dict:
    protection = (packet or {}).get("protection") or {}
    account = (packet or {}).get("account") or {}
    execution = (packet or {}).get("execution") or {}
    stop = protection.get("stop") or {}
    target = protection.get("target") or {}
    out = {
        "iter": iteration,
        "utc": utc_now(),
        "open_qty": int(account.get("instrument_open_contracts") or 0),
        "working_orders": int(account.get("working_orders") or 0),
        "protection_status": protection.get("protection_status"),
        "unprotected_open_quantity": protection.get("unprotected_open_quantity"),
        "stop_order_id": stop.get("provider_order_id"),
        "stop_price": stop.get("price"),
        "target_order_id": target.get("provider_order_id"),
        "target_price": target.get("price"),
        "protected_reduction_saga": execution.get("protected_reduction_saga"),
        "recovery": (health or {}).get("recovery", {}).get("status") if isinstance(health, dict) else None,
    }
    receipts = execution.get("recent_receipts") or []
    if receipts:
        latest = receipts[-1]
        out["latest_receipt"] = {"status": latest.get("status"), "code": latest.get("code")}
    return out


def protection_changed(baseline: dict, current: dict) -> bool:
    if baseline.get("protection_status") != current.get("protection_status"):
        return True
    if int(current.get("unprotected_open_quantity") or 0) > int(baseline.get("unprotected_open_quantity") or 0):
        return True
    if int(current.get("working_orders") or 0) < int(baseline.get("working_orders") or 0):
        return True
    if baseline.get("stop_order_id") and not current.get("stop_order_id"):
        return True
    if baseline.get("target_order_id") and not current.get("target_order_id"):
        return True
    if baseline.get("protection_status") == "confirmed" and current.get("protection_status") != "confirmed":
        return True
    return False


def main() -> int:
    token = load_token()
    iterations = int(sys.argv[1]) if len(sys.argv) > 1 else 45
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    entry_intent = sys.argv[3] if len(sys.argv) > 3 else "ba8be6a5-3e5d-4ced-aba5-c2b3e562d2a7"

    _, health0 = request_json("/health", token=token)
    _, packet0 = request_json("/packet", token=token)
    baseline = snapshot_fields(packet0 or {}, health0, 0)
    snapshots = [baseline]
    change_detected_at: str | None = None
    change_snapshot: dict | None = None

    print(json.dumps({"phase": "baseline", "snapshot": baseline}))
    sys.stdout.flush()

    for iteration in range(1, iterations + 1):
        time.sleep(interval)
        _, health = request_json("/health", token=token)
        _, packet = request_json("/packet", token=token)
        snap = snapshot_fields(packet or {}, health, iteration)
        snapshots.append(snap)
        print(json.dumps(snap))
        sys.stdout.flush()
        if protection_changed(baseline, snap):
            change_detected_at = snap["utc"]
            change_snapshot = snap
            break

    _, health_f = request_json("/health", token=token)
    _, packet_f = request_json("/packet", token=token)
    _, entry_receipt = request_json(f"/intent/receipt?intent_id={entry_intent}", token=token)

    result = {
        "recorded_utc": utc_now(),
        "entry_intent_id": entry_intent,
        "baseline": baseline,
        "change_detected": change_detected_at is not None,
        "change_detected_at": change_detected_at,
        "change_snapshot": change_snapshot,
        "poll_iterations": len(snapshots) - 1,
        "poll_interval_s": interval,
        "snapshots": snapshots,
        "final_health": health_f,
        "final_packet": packet_f,
        "entry_receipt": entry_receipt,
        "awaiting_operator_cancel": not change_detected_at and baseline.get("protection_status") == "confirmed",
    }
    print(json.dumps({"phase": "final", "result": result}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
