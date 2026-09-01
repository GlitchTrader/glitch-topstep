"""Minimal PRAC test 11 runner — avoids restart loops."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from prac_gateway_helpers import (  # noqa: E402
    clear_daily_capture_lock,
    clear_prac_trade_outcome_seeds,
    ensure_production_services_running,
    packet_snapshot,
    restart_gateway,
    save_evidence,
    seed_trade_outcome_realized,
    tail_events_jsonl,
    trading_day_id_from_packet,
    tranche_stop_price,
    utc_now,
    wait_gateway_ready,
)

def main() -> int:
    out = {"test_id": 11, "started_utc": utc_now()}
    out["cleared_outcome_seeds"] = clear_prac_trade_outcome_seeds()
    restart_gateway(None)
    wait_gateway_ready(120)
    trading_day = trading_day_id_from_packet()
    out["trading_day_id"] = trading_day
    clear_daily_capture_lock(trading_day)
    for attempt in range(3):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "prac-directed-entry-once.py"), "1"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=90,
        )
        out["entry_attempt"] = attempt + 1
        out["entry_exit_code"] = proc.returncode
        out["entry_stdout"] = proc.stdout[-1500:] if proc.stdout else ""
        if proc.returncode == 0:
            break
        if "quote_geometry_invalid" in (proc.stdout or "") or "venue_state_incomplete" in (proc.stdout or ""):
            restart_gateway(None)
            wait_gateway_ready(90)
            time.sleep(5)
            continue
        break
    else:
        proc = type("P", (), {"returncode": 3})()
    if proc.returncode != 0:
        out["result"] = "FAIL"
        out["failure_reason"] = "entry_script_failed"
        save_evidence("test-11-breakeven.json", out)
        return 1
    confirmed = False
    snap: dict = {}
    for _ in range(40):
        time.sleep(3)
        snap = packet_snapshot()
        if (snap.get("open_qty") or 0) >= 1 and snap.get("protection_status") == "confirmed":
            confirmed = True
            break
    out["pre_stop_price"] = tranche_stop_price((snap or {}).get("packet") or {})
    if not confirmed:
        out["result"] = "FAIL"
        out["failure_reason"] = "protection_not_confirmed"
        save_evidence("test-11-breakeven.json", out)
        return 1
    clear_daily_capture_lock(trading_day)
    packet = snap.get("packet") or {}
    econ = packet.get("daily_economics") or {}
    capture = econ.get("daily_capture") or {}
    exit_seed = capture.get("reset_start_utc")
    if exit_seed:
        exit_seed = exit_seed.replace("Z", "+00:00")
        from datetime import datetime, timedelta

        start = datetime.fromisoformat(exit_seed)
        exit_seed = (start + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    import re

    intent_match = re.search(r'"intent_id":\s*"([^"]+)"', out.get("entry_stdout") or "")
    entry_intent_id = intent_match.group(1) if intent_match else None
    out["entry_intent_id"] = entry_intent_id
    seed_trade_outcome_realized(800.0, exit_utc=exit_seed, trading_day_id=trading_day)
    restart_gateway(None)
    wait_gateway_ready(120)
    pre = out["pre_stop_price"]
    post_stop = pre
    post: dict = {}
    tightened_events: list[dict] = []
    passed = False
    for poll in range(40):
        time.sleep(3)
        post = packet_snapshot()
        post_stop = tranche_stop_price(post.get("packet") or {})
        tightened_events = [
            event
            for event in tail_events_jsonl("capture_lock_stop_tightened")
            if not entry_intent_id or (event.get("payload") or {}).get("tranche_intent_id") == entry_intent_id
        ]
        stop_moved = pre is not None and post_stop is not None and pre != post_stop
        if post.get("daily_capture_locked") and (tightened_events or stop_moved):
            passed = True
            out["pass_poll"] = poll + 1
            break
    out["post_stop_price"] = post_stop
    out["tightened_events"] = tightened_events[-5:]
    out["pass_criteria"] = {
        "daily_capture_locked": post.get("daily_capture_locked") is True,
        "stop_tightened_or_event": bool(out["tightened_events"])
        or (pre is not None and post_stop is not None and pre != post_stop),
        "intent_free_path": True,
    }
    out["result"] = "PASS" if passed else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-11-breakeven.json", out)
    print(json.dumps(out, indent=2))
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "prac-operator-flatten-once.py"), "PRAC test 11 cleanup"],
        cwd=str(ROOT),
        timeout=240,
    )
    clear_daily_capture_lock(trading_day)
    clear_prac_trade_outcome_seeds()
    ensure_production_services_running()
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
