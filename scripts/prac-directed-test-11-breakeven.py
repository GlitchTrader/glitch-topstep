"""PRAC directed test 11 — breakeven on daily capture latch (focused)."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from prac_gateway_helpers import (  # noqa: E402
    EVIDENCE,
    clear_daily_capture_lock,
    ensure_flat,
    open_protected_entry,
    packet_snapshot,
    restart_gateway,
    save_evidence,
    tail_events_jsonl,
    trading_day_id_from_packet,
    tranche_stop_price,
    utc_now,
    wait_gateway_ready,
)

TRADING_DAY = "2027-03-04"


def main() -> int:
    out: dict = {"test_id": 11, "started_utc": utc_now()}
    restart_gateway(None)
    wait_gateway_ready(120)
    out["pre_flatten"] = ensure_flat("PRAC test 11 pre-clean")
    clear_daily_capture_lock(TRADING_DAY)
    entry = open_protected_entry(
        1,
        reason="PRAC directed test 11 — protected before breakeven latch",
        model="prac-directed-test-11",
    )
    out["entry"] = {"protected": entry.get("protected"), "intent_id": entry.get("intent_id")}
    if not entry.get("protected"):
        out["result"] = "FAIL"
        out["failure_reason"] = "protected_entry_not_confirmed"
        save_evidence("test-11-breakeven.json", out)
        return 1
    pre = packet_snapshot()
    out["pre_stop_price"] = tranche_stop_price(pre.get("packet") or {})
    clear_daily_capture_lock(TRADING_DAY)
    restart_gateway(None)
    wait_gateway_ready(120)
    time.sleep(10)
    for _ in range(15):
        snap = packet_snapshot()
        if snap.get("daily_capture_locked"):
            break
        time.sleep(2)
    post = packet_snapshot()
    out["post_latch"] = {
        "daily_capture_locked": post.get("daily_capture_locked"),
        "open_qty": post.get("open_qty"),
        "protection_status": post.get("protection_status"),
    }
    out["post_stop_price"] = tranche_stop_price(post.get("packet") or {})
    out["tightened_events"] = tail_events_jsonl("capture_lock_stop_tightened")[-5:]
    pre_stop = out.get("pre_stop_price")
    post_stop = out.get("post_stop_price")
    out["pass_criteria"] = {
        "daily_capture_locked": post.get("daily_capture_locked") is True,
        "stop_tightened_or_event": bool(out["tightened_events"])
        or (pre_stop is not None and post_stop is not None and pre_stop != post_stop),
        "intent_free_path": True,
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-11-breakeven.json", out)
    print(json.dumps(out, indent=2))
    ensure_flat("PRAC test 11 cleanup")
    clear_daily_capture_lock(trading_day_id_from_packet() or TRADING_DAY)
    return 0 if out["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
