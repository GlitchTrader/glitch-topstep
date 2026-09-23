"""PRAC directed test 5 — SignalR loss/recovery via supervised acceptance stream gap."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))

from gateway_client import request_json  # noqa: E402


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


def stream_snapshot(health: dict) -> dict:
    dq = (health or {}).get("data_quality") or {}
    op = dq.get("operational") or {}
    user = op.get("userStream") or {}
    market = op.get("marketStream") or {}
    recon = op.get("reconciliation") or {}
    return {
        "operational_generation": op.get("generation"),
        "user_stream_state": user.get("state"),
        "user_stream_generation": user.get("generation"),
        "market_stream_state": market.get("state"),
        "market_stream_generation": market.get("generation"),
        "reconciliation_state": recon.get("state"),
        "reconciliation_generation": recon.get("generation"),
        "state_complete": dq.get("state_complete"),
        "last_changed_user": user.get("lastChangedAt"),
        "last_changed_market": market.get("lastChangedAt"),
        "reconciliation_last_succeeded": recon.get("lastSucceededAt"),
    }


def load_evidence_timeline() -> list[dict]:
    data_dir = ROOT / "data"
    db_path = data_dir / "projectx-evidence.sqlite"
    if not db_path.is_file():
        return []
    interesting = {
        "user_reconnecting",
        "market_reconnecting",
        "user_reconnected_and_subscribed",
        "market_reconnected_and_subscribed",
        "user_closed",
        "market_closed",
        "accounts_snapshot",
        "positions_snapshot",
        "open_orders_snapshot",
    }
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            """
            SELECT sequence, event_type, source, generation, received_utc
            FROM provider_events
            WHERE source IN ('projectx_lifecycle', 'projectx_rest')
            ORDER BY sequence ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "sequence": int(row[0]),
            "event_type": str(row[1]),
            "source": str(row[2]),
            "generation": int(row[3]),
            "received_utc": str(row[4]),
        }
        for row in rows
        if str(row[1]) in interesting
    ]


def ms_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        a = datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = datetime.fromisoformat(end.replace("Z", "+00:00"))
        return int((b - a).total_seconds() * 1000)
    except ValueError:
        return None


def main() -> int:
    token = load_token()
    started = utc_now()
    out: dict = {
        "test_id": 5,
        "title": "Perda/recuperação SignalR (acceptance stream gap supervisionado)",
        "started_utc": started,
        "operator_authorized": True,
        "method": "POST /acceptance/force-stream-gap (GLITCH_ACCEPTANCE_STREAM_GAP=1)",
    }

    _, health_before = request_json("/health", token=token)
    out["baseline"] = stream_snapshot(health_before if isinstance(health_before, dict) else {})
    timeline_before_len = len(load_evidence_timeline())

    gap_started = time.time()
    gap_status, gap_body = request_json(
        "/acceptance/force-stream-gap",
        method="POST",
        token=token,
        body={},
    )
    out["gap_http_status"] = gap_status
    out["gap_response"] = gap_body
    if gap_status != 200:
        out["result"] = "FAIL"
        out["failure_reason"] = gap_body
        print(json.dumps(out, indent=2))
        return 2

    phases = (gap_body or {}).get("phases") or []
    out["phases"] = phases
    baseline_gen = phases[0].get("operational_generation") if phases else None
    gap_gen = next((p.get("operational_generation") for p in phases if p.get("label") == "after_stream_gap"), None)
    settled_gen = phases[-1].get("operational_generation") if phases else None
    out["generation"] = {
        "baseline": baseline_gen,
        "after_stream_gap": gap_gen,
        "after_reconciliation": settled_gen,
        "incremented": gap_gen is not None and baseline_gen is not None and gap_gen > baseline_gen,
    }

    recovered = False
    polls: list[dict] = []
    for iteration in range(30):
        time.sleep(1)
        _, health = request_json("/health", token=token)
        snap = stream_snapshot(health if isinstance(health, dict) else {})
        snap["iter"] = iteration + 1
        polls.append(snap)
        if (
            snap.get("market_stream_state") == "connected"
            and snap.get("user_stream_state") == "connected"
            and snap.get("reconciliation_state") == "succeeded"
            and snap.get("state_complete") is True
        ):
            recovered = True
            break

    out["recovery_polls"] = polls
    out["recovered"] = recovered
    elapsed_ms = int((time.time() - gap_started) * 1000)
    out["elapsed_ms"] = {
        "gap_to_recovered_health": elapsed_ms if recovered else None,
    }

    timeline = load_evidence_timeline()
    out["evidence_timeline_new_events"] = timeline[timeline_before_len:]
    reconnecting = [e for e in timeline if e["event_type"].endswith("_reconnecting")]
    reconnected = [e for e in timeline if e["event_type"].endswith("_reconnected_and_subscribed")]

    gap_phase = next((p for p in phases if p.get("label") == "after_stream_gap"), None)
    settled_phase = phases[-1] if phases else None
    reconcile_ms = ms_between(
        gap_phase.get("recorded_utc") if gap_phase else None,
        settled_phase.get("recorded_utc") if settled_phase else None,
    )
    out["elapsed_ms"]["gap_phase_to_settled_phase"] = reconcile_ms

    out["observed"] = {
        "generation_incremented": out["generation"].get("incremented"),
        "gap_state_complete_false": gap_phase.get("state_complete") is False if gap_phase else None,
        "gap_reconciliation_not_current": gap_phase.get("reconciliation_current") is False if gap_phase else None,
        "settled_reconciliation_current": settled_phase.get("reconciliation_current") if settled_phase else None,
        "settled_state_complete": settled_phase.get("state_complete") if settled_phase else None,
        "health_recovered": recovered,
        "reconnecting_events_in_timeline": len(reconnecting),
        "reconnected_events_in_timeline": len(reconnected),
    }

    thresholds = {"resubscribe_p95_ms": 10_000, "reconcile_p95_ms": 30_000}
    out["thresholds_ms"] = thresholds
    out["threshold_notes"] = (
        "PRAC single-sample latency; p95 requer soak — comparar elapsed gap_to_recovered vs limites."
    )
    final_poll = polls[-1] if polls else {}
    passed = bool(
        out["generation"].get("incremented")
        and gap_phase
        and gap_phase.get("state_complete") is False
        and gap_phase.get("market_stream_state") in {"reconnecting", "disconnected"}
        and recovered
        and final_poll.get("state_complete") is True
        and final_poll.get("reconciliation_state") == "succeeded"
        and final_poll.get("market_stream_state") == "connected"
        and final_poll.get("user_stream_state") == "connected"
        and (elapsed_ms < thresholds["reconcile_p95_ms"])
    )
    out["finished_utc"] = utc_now()
    out["result"] = "PASS" if passed else "FAIL"
    print(json.dumps(out, indent=2))
    return 0 if passed else 4


if __name__ == "__main__":
    raise SystemExit(main())
