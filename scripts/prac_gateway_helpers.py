"""Shared helpers for PRAC directed tests (gateway lifecycle, intents, evidence)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "evidence" / "PRAC-SOAK-2026-08-31"
PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
sys.path.insert(0, str(PROFILE))

from gateway_client import request_json  # noqa: E402

__all__ = ["request_json"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_token(name: str = "GLITCH_LOCAL_TOKEN") -> str:
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


def round_tick(value: float, tick: float) -> float:
    steps = round(value / tick)
    return round(steps * tick, 10)


def save_evidence(name: str, payload: dict[str, Any]) -> Path:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE / name
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def stop_gateway() -> None:
    subprocess.run(
        [
            "powershell",
            "-Command",
            (
                "$port = if ($env:GLITCH_LOCAL_PORT) { [int]$env:GLITCH_LOCAL_PORT } else { 8790 }; "
                "Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | "
                "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
            ),
        ],
        cwd=str(ROOT),
        check=False,
    )
    time.sleep(2)


def restart_gateway(kill_point: str | None = None, *, skip_build: bool = True) -> None:
    stop_gateway()
    args = ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "prac-gateway-restart.ps1")]
    if skip_build:
        args.append("-SkipBuild")
    if kill_point:
        args.extend(["-KillPoint", kill_point])
    subprocess.run(args, cwd=str(ROOT), check=True)


def wait_gateway_ready(timeout_s: float = 90.0) -> dict[str, Any]:
    token = load_token()
    deadline = time.time() + timeout_s
    last: dict[str, Any] = {"error": "timeout"}
    while time.time() < deadline:
        try:
            status, health = request_json("/health", token=token)
            if status == 200 and isinstance(health, dict):
                dq = (health.get("data_quality") or {}).get("operational") or {}
                if dq.get("state_complete") is True:
                    return health
                last = health
        except Exception as exc:  # ponytail: urllib errors during crash/restart
            last = {"error": str(exc)}
        time.sleep(2)
    return last


def packet_snapshot() -> dict[str, Any]:
    token = load_token()
    status, packet = request_json("/packet", token=token)
    if status != 200 or not isinstance(packet, dict):
        return {"http_status": status, "packet": packet}
    account = packet.get("account") or {}
    execution = packet.get("execution") or {}
    protection = packet.get("protection") or {}
    return {
        "http_status": status,
        "open_qty": int(account.get("instrument_open_contracts") or 0),
        "working_orders": int(account.get("working_orders") or 0),
        "protection_status": protection.get("protection_status"),
        "recovery_blocked": execution.get("recovery_blocked"),
        "maximum_additional_contracts": execution.get("maximum_additional_contracts"),
        "supported_actions": execution.get("supported_actions") or [],
        "daily_capture_locked": execution.get("daily_capture_locked"),
        "packet": packet,
    }


def intent_status(intent_id: str) -> dict[str, Any]:
    token = load_token()
    status, body = request_json(f"/intent/status?intent_id={intent_id}", token=token)
    return {"http_status": status, "body": body}


def build_enter_body(packet: dict[str, Any], *, quantity: int, reason: str, model: str) -> dict[str, Any]:
    market = packet["market"]
    tick = float(packet["contract"]["tick_size"])
    ask = float(market["ask"])
    stop = round_tick(ask - 20.0, tick)
    target = round_tick(ask + 30.0, tick)
    band_half = max(tick * 2, 1.0)
    now = utc_now()
    return {
        "schema_version": "glitch.intent.v3",
        "intent_id": str(uuid.uuid4()),
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
        "model_version": model,
        "prompt_version": "glitch-topstep-v17.1",
        "reason": reason,
        "decision_audit": {
            "bull_case": reason,
            "bear_case": "Not applicable.",
            "flat_case": "Supervised PRAC directed test.",
            "aggressive_case": "Minimum qty supervised path.",
            "conservative_case": "Geometry-valid bracket.",
            "decisive_evidence": "PRAC-SOAK-2026-08-31",
            "disconfirming_evidence": "Abort if protection fails.",
            "change_condition": "Flatten on unconfirmed protection.",
            "final_choice": "ENTER_LONG",
        },
        "quantity": quantity,
        "order_type": "MARKET",
        "stop_loss": stop,
        "take_profit_1": target,
        "entry_price_min": round_tick(ask - band_half, tick),
        "entry_price_max": round_tick(ask + band_half, tick),
    }


def submit_intent(body: dict[str, Any], *, timeout_s: float = 45.0) -> dict[str, Any]:
    token = load_token()
    started = time.time()
    try:
        status, receipt = request_json("/intent", method="POST", token=token, body=body)
        return {
            "submitted_utc": utc_now(),
            "elapsed_ms": int((time.time() - started) * 1000),
            "http_status": status,
            "receipt": receipt,
            "transport_error": None,
        }
    except Exception as exc:
        return {
            "submitted_utc": utc_now(),
            "elapsed_ms": int((time.time() - started) * 1000),
            "http_status": None,
            "receipt": None,
            "transport_error": str(exc),
        }


def wait_kill_in_stderr(kill_point: str, timeout_s: float = 30.0) -> bool:
    stderr_path = ROOT / "data" / "gateway.stderr.log"
    deadline = time.time() + timeout_s
    needle = f"GLITCH_KILL:{kill_point}"
    while time.time() < deadline:
        if stderr_path.is_file() and needle in stderr_path.read_text(encoding="utf-8", errors="replace"):
            return True
        time.sleep(1)
    return False


def wait_gateway_down(timeout_s: float = 30.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            request_json("/health", token=load_token())
        except Exception:
            return True
        time.sleep(1)
    return False


def ensure_flat(reason: str = "PRAC cleanup flatten") -> dict[str, Any]:
    snap = packet_snapshot()
    if (snap.get("open_qty") or 0) <= 0 and (snap.get("working_orders") or 0) <= 0:
        return {"already_flat": True, "snapshot": snap}
    script = ROOT / "scripts" / "prac-operator-flatten-once.py"
    proc = subprocess.run(
        [sys.executable, str(script), reason],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=240,
    )
    return {
        "already_flat": False,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-4000:] if proc.stdout else "",
        "stderr": proc.stderr[-2000:] if proc.stderr else "",
        "post": packet_snapshot(),
    }


def wait_tradable_packet(max_attempts: int = 12) -> dict[str, Any]:
    """Wait until packet allows new exposure; restart gateway on quote_geometry_invalid."""
    last: dict[str, Any] = {"error": "uninitialized"}
    for attempt in range(max_attempts):
        try:
            last = packet_snapshot()
        except Exception as exc:
            last = {"error": str(exc)}
            if attempt in {1, 4, 7}:
                restart_gateway(None)
                wait_gateway_ready(90)
            else:
                time.sleep(5)
            continue
        packet = last.get("packet") or {}
        execution = packet.get("execution") or {}
        dq = packet.get("data_quality") or {}
        issues = dq.get("issues") or []
        if (
            last.get("http_status") == 200
            and not execution.get("recovery_blocked")
            and execution.get("new_exposure_technically_supported") is not False
            and "quote_geometry_invalid" not in issues
        ):
            return last
        if attempt in {2, 5, 8}:
            restart_gateway(None)
            wait_gateway_ready(90)
        else:
            time.sleep(5)
    return last


def open_protected_entry(qty: int = 1, *, reason: str, model: str) -> dict[str, Any]:
    import subprocess

    out: dict[str, Any] = {"attempts": []}
    for attempt in range(2):
        tradable = wait_tradable_packet(6)
        out["attempts"].append({"attempt": attempt + 1, "tradable_ok": tradable.get("http_status") == 200})
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "prac-directed-entry-once.py"), str(qty)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )
        attempt_out: dict[str, Any] = {"exit_code": proc.returncode, "stdout_tail": (proc.stdout or "")[-2000:]}
        out["attempts"][-1]["entry_script"] = attempt_out
        if proc.returncode != 0:
            restart_gateway(None)
            wait_gateway_ready(90)
            continue
        for _ in range(40):
            time.sleep(3)
            snap = packet_snapshot()
            attempt_out["poll"] = {
                "open_qty": snap.get("open_qty"),
                "protection_status": snap.get("protection_status"),
            }
            if (snap.get("open_qty") or 0) >= qty and snap.get("protection_status") == "confirmed":
                out["protected"] = True
                out["intent_id"] = None
                try:
                    lines = [line for line in (proc.stdout or "").splitlines() if line.strip().startswith("{")]
                    if lines:
                        out["intent_id"] = json.loads(lines[-1]).get("intent_id")
                except json.JSONDecodeError:
                    pass
                return out
        restart_gateway(None)
        wait_gateway_ready(90)
    out["protected"] = False
    return out


def tail_events_jsonl(needle: str, *, max_lines: int = 500) -> list[str]:
    path = ROOT / "data" / "events.jsonl"
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-max_lines:]
    return [line for line in lines if needle in line]


def trading_day_id_from_packet() -> str | None:
    snap = packet_snapshot()
    packet = snap.get("packet") or {}
    econ = packet.get("daily_economics") or {}
    return econ.get("trading_day_id")


def seed_daily_capture_lock(trading_day_id: str) -> None:
    db = ROOT / "data" / "glitch-topstep.sqlite"
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT OR IGNORE INTO daily_capture_locks (trading_day_id, reached_utc) VALUES (?, ?)",
            (trading_day_id, utc_now()),
        )
        conn.commit()
    finally:
        conn.close()


def clear_prac_trade_outcome_seeds() -> int:
    """Remove supervised PRAC economics seeds so daily capture does not pre-latch."""
    db = ROOT / "data" / "trade-outcomes.sqlite"
    if not db.is_file():
        return 0
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT outcome_id FROM outcomes_current WHERE outcome_id LIKE 'prac-seed-%'",
        ).fetchall()
        for (outcome_id,) in rows:
            conn.execute("DELETE FROM outcome_revisions WHERE outcome_id = ?", (outcome_id,))
            conn.execute("DELETE FROM outcomes_current WHERE outcome_id = ?", (outcome_id,))
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def seed_trade_outcome_realized(
    pnl_usd: float,
    *,
    exit_utc: str | None = None,
    trading_day_id: str | None = None,
) -> None:
    """Seed trade-outcomes feed so daily_capture.reached becomes true on next gateway load."""
    db = ROOT / "data" / "trade-outcomes.sqlite"
    if not db.is_file():
        return
    recorded = exit_utc or utc_now()
    outcome_id = f"prac-seed-{uuid.uuid4().hex[:12]}"
    intent_id = f"prac-seed-intent-{uuid.uuid4().hex[:12]}"
    payload = {
        "schema_version": "glitch.topstep.trade_outcome.v1",
        "outcome_id": outcome_id,
        "intent_id": intent_id,
        "account": "PRAC",
        "instrument": "MNQ",
        "entry_utc": recorded,
        "exit_utc": recorded,
        "realized_pnl_usd": pnl_usd,
        "fees_usd": 0,
        "learning_eligible": False,
        "note": f"PRAC directed test seed for {trading_day_id or 'unknown-day'}",
    }
    payload_json = json.dumps(payload, separators=(",", ":"))
    content_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT revision FROM outcomes_current WHERE outcome_id = ?",
            (outcome_id,),
        ).fetchone()
        revision = int(row[0]) + 1 if row else 1
        conn.execute(
            """
            INSERT INTO outcome_revisions
            (outcome_id, intent_id, revision, status, content_hash, payload_json, recorded_utc)
            VALUES (?, ?, ?, 'enriched', ?, ?, ?)
            """,
            (outcome_id, intent_id, revision, content_hash, payload_json, recorded),
        )
        sequence = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            """
            INSERT INTO outcomes_current
            (outcome_id, intent_id, revision, sequence, status, content_hash, payload_json, updated_utc)
            VALUES (?, ?, ?, ?, 'enriched', ?, ?, ?)
            ON CONFLICT(outcome_id) DO UPDATE SET
              intent_id=excluded.intent_id,
              revision=excluded.revision,
              sequence=excluded.sequence,
              status=excluded.status,
              content_hash=excluded.content_hash,
              payload_json=excluded.payload_json,
              updated_utc=excluded.updated_utc
            """,
            (outcome_id, intent_id, revision, sequence, content_hash, payload_json, recorded),
        )
        conn.commit()
    finally:
        conn.close()
    jsonl = ROOT / "data" / "trade-outcomes.jsonl"
    with jsonl.open("a", encoding="utf-8") as handle:
        handle.write(payload_json + "\n")


def tranche_stop_price(packet: dict[str, Any]) -> float | None:
    tranches = (packet.get("protection") or {}).get("tranches") or []
    if not tranches:
        return None
    tranche = tranches[0]
    stop = (tranche.get("protection") or {}).get("stop") or {}
    price = stop.get("price")
    if price is not None:
        return float(price)
    return tranche.get("stop_price")


def clear_prac_recovery_latch_when_flat() -> dict[str, Any]:
    """ponytail: supervised PRAC only — clear kill-matrix latch when venue is flat."""
    snap = packet_snapshot()
    if (snap.get("open_qty") or 0) > 0 or (snap.get("working_orders") or 0) > 0:
        return {"cleared": False, "reason": "not_flat", "snapshot": snap}
    db = ROOT / "data" / "glitch-topstep.sqlite"
    conn = sqlite3.connect(str(db))
    cleared: dict[str, Any] = {"cleared": True, "mutations": [], "latch": None}
    try:
        latch = conn.execute(
            "SELECT value FROM runtime_meta WHERE key = 'entry_submission_latch'"
        ).fetchone()
        cleared["latch"] = latch[0] if latch else None
        rows = conn.execute(
            """
            SELECT intent_id, state, last_error
            FROM execution_outbox
            WHERE state IN ('ambiguous', 'submitting', 'prepared')
            """
        ).fetchall()
        now = utc_now()
        for intent_id, state, last_error in rows:
            conn.execute(
                """
                UPDATE execution_outbox
                SET state = 'confirmed_not_submitted',
                    resolved_utc = ?,
                    provider_order_id = NULL,
                    last_error = COALESCE(last_error, 'prac_supervised_flat_recovery_clear')
                WHERE intent_id = ? AND state IN ('ambiguous', 'submitting', 'prepared')
                """,
                (now, intent_id),
            )
            receipt_id = str(uuid.uuid4())
            payload = {
                "schema_version": "glitch.direct.execution_receipt.v1",
                "receipt_id": receipt_id,
                "recorded_utc": now,
                "intent_id": intent_id,
                "mode": "armed",
                "status": "rejected",
                "code": "mutation_confirmed_not_submitted_after_restart",
                "detail": f"PRAC supervised clear while flat (was {state}: {last_error})",
            }
            conn.execute(
                """
                INSERT OR REPLACE INTO execution_receipts
                (receipt_id, intent_id, recorded_utc, status, code, payload_json)
                VALUES (?, ?, ?, 'rejected', ?, ?)
                """,
                (
                    receipt_id,
                    intent_id,
                    now,
                    payload["code"],
                    json.dumps(payload, separators=(",", ":")),
                ),
            )
            cleared["mutations"].append({"intent_id": intent_id, "prior_state": state})
        conn.execute("DELETE FROM runtime_meta WHERE key = 'entry_submission_latch'")
        conn.commit()
    finally:
        conn.close()
    cleared["post"] = packet_snapshot()
    return cleared


def clear_daily_capture_lock(trading_day_id: str | None) -> None:
    if not trading_day_id:
        return
    db = ROOT / "data" / "glitch-topstep.sqlite"
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("DELETE FROM daily_capture_locks WHERE trading_day_id = ?", (trading_day_id,))
        conn.commit()
    finally:
        conn.close()


def ensure_production_services_running(*, skip_build: bool = True) -> dict[str, Any]:
    """Restart gateway in production mode (no kill/acceptance flags) and ensure Hermes cron scheduler."""
    restart_gateway(None, skip_build=skip_build)
    health = wait_gateway_ready(120)
    dq = (health.get("data_quality") or {}).get("operational") or {}
    out: dict[str, Any] = {
        "finished_utc": utc_now(),
        "gateway": {
            "ready": dq.get("state_complete") is True,
            "trading_mode": health.get("trading_mode"),
            "lifecycle_state": (health.get("lifecycle") or {}).get("state"),
        },
        "hermes_cron": {},
    }
    ensure = subprocess.run(
        [
            "powershell",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ROOT / "scripts" / "ensure-hermes-gateway-scheduler.ps1"),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    out["hermes_cron"]["ensure_exit_code"] = ensure.returncode
    out["hermes_cron"]["ensure_stdout"] = ensure.stdout.strip()
    out["hermes_cron"]["ensure_stderr"] = ensure.stderr.strip()
    cron = subprocess.run(
        ["hermes", "-p", "glitch-topstep", "cron", "status"],
        capture_output=True,
        text=True,
        check=False,
    )
    out["hermes_cron"]["status_stdout"] = cron.stdout.strip()
    out["hermes_cron"]["scheduler_running"] = "Gateway is not running" not in cron.stdout
    return out
