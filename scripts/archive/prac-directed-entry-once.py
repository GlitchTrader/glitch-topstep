"""PRAC directed test helper — submit one protected ENTER from current /packet (supervised)."""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))
sys.path.insert(0, str(ROOT / "scripts"))

from common import request_json  # noqa: E402


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def round_tick(value: float, tick: float) -> float:
    steps = round(value / tick)
    return round(steps * tick, 10)


def load_gateway_token() -> str:
    token = os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip()
    if token:
        return token
    env_path = ROOT / ".env"
    if env_path.is_file():
        for raw in env_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = raw.strip()
            if line.startswith("GLITCH_LOCAL_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GLITCH_LOCAL_TOKEN / GLITCH_TOPSTEP_LOCAL_TOKEN not configured")


def main() -> int:
    quantity = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    token = load_gateway_token()
    status, packet = request_json("/packet", token=token)
    if status != 200 or not isinstance(packet, dict):
        print(json.dumps({"error": "packet_fetch_failed", "status": status}))
        return 1

    market = packet["market"]
    execution = packet["execution"]
    max_qty = int(execution.get("maximum_additional_contracts") or 0)
    if quantity > max_qty:
        print(
            json.dumps(
                {
                    "error": "quantity_exceeds_gateway_capacity",
                    "requested": quantity,
                    "maximum_additional_contracts": max_qty,
                    "max_contracts_policy": packet.get("policy", {}).get("max_contracts"),
                }
            )
        )
        return 2

    tick = float(packet["contract"]["tick_size"])
    ask = float(market["ask"])
    bid = float(market["bid"])
    stop = round_tick(ask - 20.0, tick)
    target = round_tick(ask + 30.0, tick)
    band_half = max(tick * 2, 1.0)
    intent_id = str(uuid.uuid4())
    now = utc_now()
    body = {
        "schema_version": "glitch.intent.v3",
        "intent_id": intent_id,
        "created_utc": now,
        "instrument": packet["instrument"],
        "account": packet["account"]["name"],
        "operator_profile": "glitch-topstep",
        "action": "ENTER_LONG",
        "confidence": 0.85,
        "snapshot_hash": market["snapshot_hash"],
        "packet_id": packet["packet_id"],
        "contract_id": packet["contract"]["id"],
        "scope_hash": packet["decision_scope"]["scope_hash"],
        "scope_generation": packet["decision_scope"]["generation"],
        "expires_utc": packet["expires_utc"],
        "model_version": "prac-directed-test-1",
        "prompt_version": "glitch-topstep-v17.1",
        "reason": "PRAC directed test 1 — protected MNQ entry (operator authorized).",
        "decision_audit": {
            "bull_case": "Operator-authorized PRAC test 1 entry with native bracket.",
            "bear_case": "Not applicable for supervised acceptance entry.",
            "flat_case": "Flat account with all execution gates passing.",
            "aggressive_case": "Single supervised protected long to validate bracket confirmation.",
            "conservative_case": "Use minimum geometry-valid stop/target with MARKET entry.",
            "decisive_evidence": "PRAC-SOAK-2026-08-31 directed test 1.",
            "disconfirming_evidence": "None for supervised acceptance path.",
            "change_condition": "Abort if protection not confirmed within verification window.",
            "final_choice": "ENTER_LONG",
        },
        "quantity": quantity,
        "order_type": "MARKET",
        "stop_loss": stop,
        "take_profit_1": target,
        "entry_price_min": round_tick(ask - band_half, tick),
        "entry_price_max": round_tick(ask + band_half, tick),
    }

    receipt_status, receipt = request_json(
        "/intent",
        method="POST",
        token=token,
        body=body,
    )
    out = {
        "submitted_utc": utc_now(),
        "intent_id": intent_id,
        "quantity": quantity,
        "geometry": {
            "ask": ask,
            "bid": bid,
            "stop_loss": stop,
            "take_profit_1": target,
        },
        "http_status": receipt_status,
        "receipt": receipt,
    }
    print(json.dumps(out, indent=2))
    return 0 if receipt_status in {202, 200} else 3


if __name__ == "__main__":
    raise SystemExit(main())
