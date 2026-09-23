"""PRAC directed test 3 — status:8 / unpriced bracket leg must not read as confirmed."""
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
sys.path.insert(0, str(ROOT / "scripts"))

from common import request_json  # noqa: E402


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_token() -> str:
    token = os.environ.get("GLITCH_LOCAL_TOKEN", "").strip()
    if token:
        return token
    for raw in (ROOT / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("GLITCH_LOCAL_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GLITCH_LOCAL_TOKEN not configured")


def round_tick(value: float, tick: float) -> float:
    steps = round(value / tick)
    return round(steps * tick, 10)


def protection_snapshot(packet: dict) -> dict:
    protection = packet.get("protection") or {}
    tranches = protection.get("tranches") or []
    top_stop = protection.get("stop") or {}
    top_target = protection.get("target") or {}
    legs = []
    for tranche in tranches:
        prov = tranche.get("protection") or {}
        stop = prov.get("stop") or {}
        target = prov.get("target") or {}
        legs.append({
            "intent_id": tranche.get("intent_id"),
            "stop_order_id": stop.get("provider_order_id"),
            "stop_price": stop.get("price"),
            "target_order_id": target.get("provider_order_id"),
            "target_price": target.get("price"),
        })
    if not legs and (top_stop or top_target):
        legs.append({
            "intent_id": protection.get("intent_id"),
            "stop_order_id": top_stop.get("provider_order_id"),
            "stop_price": top_stop.get("price"),
            "target_order_id": top_target.get("provider_order_id"),
            "target_price": top_target.get("price"),
        })
    return {
        "checked_utc": utc_now(),
        "open_qty": int((packet.get("account") or {}).get("instrument_open_contracts") or 0),
        "protection_status": protection.get("protection_status"),
        "protection_internal_status": protection.get("status"),
        "unprotected_open_quantity": protection.get("unprotected_open_quantity"),
        "legs": legs,
    }


def wait_for_armed(token: str, timeout_s: float = 90.0) -> dict:
    deadline = time.time() + timeout_s
    last_packet: dict | None = None
    while time.time() < deadline:
        status, packet = request_json("/packet", token=token)
        if status == 200 and isinstance(packet, dict):
            last_packet = packet
            execution = packet.get("execution") or {}
            if execution.get("gateway_mode") == "armed":
                return packet
        time.sleep(2)
    mode = (last_packet or {}).get("execution", {}).get("gateway_mode")
    downgrade = (last_packet or {}).get("execution", {}).get("gateway_mode_downgrade_reason")
    raise RuntimeError(f"gateway not armed after {timeout_s}s: mode={mode} reason={downgrade}")


def submit_entry(token: str, quantity: int = 3) -> dict:
    packet = wait_for_armed(token)
    market = packet["market"]
    execution = packet["execution"]
    open_qty = int(packet["account"].get("instrument_open_contracts") or 0)
    if open_qty > 0:
        raise RuntimeError(f"expected flat before test 3, open={open_qty}")

    tick = float(packet["contract"]["tick_size"])
    ask = float(market["ask"])
    bid = float(market["bid"])
    stop_loss = round_tick(ask - 20.0, tick)
    take_profit = round_tick(ask + 30.0, tick)
    band_half = max(tick * 2, 1.0)
    max_qty = int(execution.get("maximum_additional_contracts") or 0)
    if quantity > max_qty:
        raise RuntimeError(f"quantity {quantity} exceeds gateway capacity {max_qty}")
    intent_id = str(uuid.uuid4())
    body = {
        "schema_version": "glitch.intent.v3",
        "intent_id": intent_id,
        "created_utc": utc_now(),
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
        "model_version": "prac-directed-test-3",
        "prompt_version": "glitch-topstep-v17.1",
        "reason": "PRAC directed test 3 — status:8 protection window.",
        "decision_audit": {
            "bull_case": "Bracket allocates suspended legs before fill; gateway must stay pending.",
            "bear_case": "False confirmed with null prices would be unsafe.",
            "flat_case": "Not applicable.",
            "aggressive_case": "Confirm early.",
            "conservative_case": "Pending until priced legs observed.",
            "decisive_evidence": "PRAC-SOAK-2026-08-31 test 3.",
            "disconfirming_evidence": "confirmed with null stop/target prices.",
            "change_condition": "Abort if protection confirmed without prices.",
            "final_choice": "ENTER_LONG",
        },
        "quantity": quantity,
        "order_type": "MARKET",
        "stop_loss": stop_loss,
        "take_profit_1": take_profit,
        "entry_price_min": round_tick(ask - band_half, tick),
        "entry_price_max": round_tick(ask + band_half, tick),
    }
    receipt_status, receipt = request_json("/intent", method="POST", token=token, body=body)
    return {
        "intent_id": intent_id,
        "http_status": receipt_status,
        "receipt": receipt,
        "geometry": {"ask": ask, "bid": bid, "stop_loss": stop_loss, "take_profit_1": take_profit},
    }


def submit_move_stop(token: str, entry_intent_id: str, new_stop: float) -> dict:
    status, packet = request_json("/packet", token=token)
    if status != 200:
        return {"error": "packet_fetch_failed", "status": status}
    market = packet["market"]
    intent_id = str(uuid.uuid4())
    body = {
        "schema_version": "glitch.intent.v3",
        "intent_id": intent_id,
        "created_utc": utc_now(),
        "instrument": packet["instrument"],
        "account": packet["account"]["name"],
        "operator_profile": "glitch-topstep",
        "action": "MOVE_STOP",
        "confidence": 0.7,
        "snapshot_hash": market["snapshot_hash"],
        "packet_id": packet["packet_id"],
        "contract_id": packet["contract"]["id"],
        "scope_hash": packet["decision_scope"]["scope_hash"],
        "scope_generation": packet["decision_scope"]["generation"],
        "expires_utc": packet["expires_utc"],
        "model_version": "prac-directed-test-3",
        "prompt_version": "glitch-topstep-v17.1",
        "reason": "PRAC test 3 — attempt amend during pending/unpriced protection window.",
        "decision_audit": {
            "bull_case": "Amend succeeds once stop is priced.",
            "bear_case": "Amend during status:8 must fail closed or defer.",
            "flat_case": "Not applicable.",
            "aggressive_case": "Force amend early.",
            "conservative_case": "Reject or defer until proven.",
            "decisive_evidence": "PRAC test 3 timing probe.",
            "disconfirming_evidence": "Silent success with unpriced leg.",
            "change_condition": "Stop if protection falsely confirmed.",
            "final_choice": "MOVE_STOP",
        },
        "target_intent_id": entry_intent_id,
        "new_stop_price": new_stop,
    }
    receipt_status, receipt = request_json("/intent", method="POST", token=token, body=body)
    return {"intent_id": intent_id, "http_status": receipt_status, "receipt": receipt}


def main() -> int:
    token = load_token()
    out: dict = {"test_id": 3, "started_utc": utc_now(), "polls": [], "move_stop_attempts": []}
    out["entry"] = submit_entry(token, 3)
    entry_intent_id = out["entry"]["intent_id"]
    entry_ok = out["entry"].get("http_status") in {200, 202}
    move_stop_sent = False
    false_confirmed = False

    for _ in range(80):
        time.sleep(0.5)
        _, packet = request_json("/packet", token=token)
        if not isinstance(packet, dict):
            continue
        snap = protection_snapshot(packet)
        out["polls"].append(snap)
        if snap["protection_status"] == "confirmed":
            for leg in snap["legs"]:
                if leg.get("stop_order_id") and leg.get("stop_price") is None:
                    false_confirmed = True
                if leg.get("target_order_id") and leg.get("target_price") is None:
                    false_confirmed = True
        if (
            entry_ok
            and not move_stop_sent
            and snap["open_qty"] > 0
            and (
                snap["protection_status"] in {"pending", "unknown", None}
                or any(leg.get("stop_price") is None for leg in snap["legs"])
            )
        ):
            tick = 0.25
            base_stop = out["entry"]["geometry"]["stop_loss"]
            attempt = submit_move_stop(token, entry_intent_id, round_tick(base_stop + tick, tick))
            attempt["poll_index"] = len(out["polls"])
            out["move_stop_attempts"].append(attempt)
            move_stop_sent = True
        if snap["protection_status"] == "confirmed" and snap["open_qty"] == 3:
            break

    final = out["polls"][-1] if out["polls"] else {}
    out["finished_utc"] = utc_now()
    out["observed"] = {
        "false_confirmed_with_null_prices": false_confirmed,
        "final_protection_status": final.get("protection_status"),
        "final_open_qty": final.get("open_qty"),
        "move_stop_attempts": len(out["move_stop_attempts"]),
    }
    out["result"] = "PASS" if (
        entry_ok
        and not false_confirmed
        and final.get("protection_status") == "confirmed"
        and final.get("open_qty") == 3
        and all(
            leg.get("stop_price") is not None and leg.get("target_price") is not None
            for leg in final.get("legs", [])
            if leg.get("stop_order_id") or leg.get("target_order_id")
        )
    ) else "FAIL"
    print(json.dumps(out, indent=2))
    return 0 if out["result"] == "PASS" else 4


if __name__ == "__main__":
    raise SystemExit(main())
