"""PRAC directed test helper — partial/full EXIT from current /packet (supervised)."""
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
    quantity = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    target_intent_id = sys.argv[2] if len(sys.argv) > 2 else None
    token = load_gateway_token()
    status, packet = request_json("/packet", token=token)
    if status != 200 or not isinstance(packet, dict):
        print(json.dumps({"error": "packet_fetch_failed", "status": status}))
        return 1

    open_qty = int(packet["account"].get("instrument_open_contracts") or 0)
    if open_qty <= 0:
        print(json.dumps({"error": "no_open_position", "open_qty": open_qty}))
        return 2
    if quantity > open_qty:
        print(json.dumps({"error": "exit_quantity_exceeds_position", "requested": quantity, "open": open_qty}))
        return 3

    tranches = packet.get("protection", {}).get("tranches") or []
    if target_intent_id is None and len(tranches) == 1:
        target_intent_id = tranches[0].get("intent_id")

    market = packet["market"]
    intent_id = str(uuid.uuid4())
    now = utc_now()
    body = {
        "schema_version": "glitch.intent.v3",
        "intent_id": intent_id,
        "created_utc": now,
        "instrument": packet["instrument"],
        "account": packet["account"]["name"],
        "operator_profile": "glitch-topstep",
        "action": "EXIT",
        "confidence": 0.85,
        "snapshot_hash": market["snapshot_hash"],
        "packet_id": packet["packet_id"],
        "contract_id": packet["contract"]["id"],
        "scope_hash": packet["decision_scope"]["scope_hash"],
        "scope_generation": packet["decision_scope"]["generation"],
        "expires_utc": packet["expires_utc"],
        "model_version": "prac-directed-test-2",
        "prompt_version": "glitch-topstep-v17.1",
        "reason": "PRAC directed test 2 — partial EXIT (operator authorized).",
        "decision_audit": {
            "bull_case": "Supervised partial reduction preserves survivor protection.",
            "bear_case": "Not applicable.",
            "flat_case": "Positioned with proven protection before partial exit.",
            "aggressive_case": "Reduce one contract while validating ProtectedReductionSaga.",
            "conservative_case": "Target tranche explicitly; qty=1 only.",
            "decisive_evidence": "PRAC-SOAK-2026-08-31 directed test 2.",
            "disconfirming_evidence": "Abort if survivor loses stop coverage.",
            "change_condition": "Flatten if protection becomes unconfirmed.",
            "final_choice": "EXIT",
        },
        "quantity": quantity,
    }
    if target_intent_id:
        body["target_intent_id"] = target_intent_id

    receipt_status, receipt = request_json(
        "/intent",
        method="POST",
        token=token,
        body=body,
    )
    out = {
        "submitted_utc": utc_now(),
        "intent_id": intent_id,
        "target_intent_id": target_intent_id,
        "quantity": quantity,
        "position_before": open_qty,
        "http_status": receipt_status,
        "receipt": receipt,
    }
    print(json.dumps(out, indent=2))
    return 0 if receipt_status in {202, 200} else 4


if __name__ == "__main__":
    raise SystemExit(main())
