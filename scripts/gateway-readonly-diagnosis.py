"""Read-only gateway diagnosis before PRAC/soak - capture, classify, optional single restart."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PROFILE_SCRIPTS = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
PROFILE_STATE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/state"
EVAL_PROFILE = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep-evaluation"
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(PROFILE_SCRIPTS))

from prac_gateway_helpers import load_token, restart_gateway, wait_gateway_ready  # noqa: E402

DIAG_SCHEMA = "glitch.topstep.gateway_readonly_diagnosis.v1"
BLOCKED_CLASSIFICATION = "blocked_operational_instability"

RESTART_AUTHORIZED_CAUSES = frozenset(
    {
        "gateway_unreachable",
        "process_stalled",
        "stream_stale_recoverable",
        "circuit_breaker_transient",
        "state_incomplete_recoverable",
    }
)

NO_RESTART_CAUSES = frozenset(
    {
        "maintenance_outage",
        "external_projectx_outage",
        "authentication_failure",
        "ambiguous_mutation",
        "unprotected_exposure",
        "recovery_blocked",
        "not_flat",
        "prac_cycle_active",
        "operational_instability",
    }
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _http_get(path: str) -> tuple[int | None, dict[str, Any] | None, str | None]:
    try:
        from gateway_client import request_json

        token = load_token()
        status, body = request_json(path, token=token)
        return status, body if isinstance(body, dict) else None, None
    except Exception as exc:
        return None, None, str(exc)


def _tail_file(path: Path, lines: int = 80) -> list[str]:
    if not path.is_file():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]


def _last_jsonl_row(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    for line in reversed(path.read_text(encoding="utf-8", errors="replace").splitlines()):
        if line.strip():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def _age_seconds(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
    except (TypeError, ValueError):
        return None


def _gateway_processes(port: int = 8790) -> list[dict[str, Any]]:
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-Command",
                (
                    f"$c=Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; "
                    "if ($c) { $c | Select-Object OwningProcess,State | ConvertTo-Json -Compress }"
                ),
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        if not out:
            return []
        doc = json.loads(out)
        if isinstance(doc, dict):
            return [doc]
        if isinstance(doc, list):
            return doc
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        pass
    return []


def _hermes_cron_status() -> dict[str, Any]:
    try:
        proc = subprocess.run(
            ["hermes", "-p", "glitch-topstep", "cron", "status"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {
            "exit_code": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
            "scheduler_running": "Gateway is not running" not in proc.stdout,
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": str(exc)}


def _read_owner_lock(state: Path) -> dict[str, Any] | None:
    path = state / "model-owner.lock.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"error": "unreadable"}


def _read_evaluation_lease(state: Path) -> dict[str, Any] | None:
    path = state / "evaluation-lease.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"error": "unreadable"}


def _circuit_breaker_open(health: dict[str, Any] | None) -> bool:
    if not health:
        return False
    cb = health.get("read_circuit_breaker") or {}
    if cb.get("open") is True:
        return True
    for key in ("bars", "quotes", "orders"):
        section = cb.get(key)
        if isinstance(section, dict) and section.get("open") is True:
            return True
    return False


def _bar_partial(packet: dict[str, Any] | None) -> bool:
    if not packet:
        return False
    mo = packet.get("market_observation") or {}
    obs = mo.get("observation") if isinstance(mo.get("observation"), dict) else {}
    for tf in obs.get("timeframes") or []:
        if isinstance(tf, dict) and tf.get("timeframe_minutes") == 1 and tf.get("latest_bar_partial") is True:
            return True
    return False


def capture_gateway_diagnosis(*, port: int = 8790) -> dict[str, Any]:
    health_status, health, health_err = _http_get("/health")
    packet_status, packet, packet_err = _http_get("/packet")

    decisions_path = PROFILE_STATE / "decisions.jsonl"
    receipts_dir = PROFILE_STATE / "receipts"
    last_decision = _last_jsonl_row(decisions_path)
    last_receipt_file = None
    if receipts_dir.is_dir():
        files = sorted(receipts_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if files:
            try:
                last_receipt_file = json.loads(files[0].read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                last_receipt_file = {"error": "unreadable"}

    mo = (health or {}).get("market_observation") or {}
    dq = (health or {}).get("data_quality") or {}
    inv = (health or {}).get("invariant_metrics") or {}
    recovery = (health or {}).get("execution_recovery") or {}
    operational = dq.get("operational") or {}

    open_qty = int((packet or {}).get("account", {}).get("instrument_open_contracts") or 0) if packet else None
    unprotected = int(inv.get("unprotected_open_quantity") or 0)

    diagnosis = {
        "schema_version": DIAG_SCHEMA,
        "captured_utc": utc_now(),
        "gateway_reachable": health_status == 200,
        "health": {
            "http_status": health_status,
            "error": health_err,
            "body": health,
        },
        "packet": {
            "http_status": packet_status,
            "error": packet_err,
            "body": packet,
            "note": "packet_id_not_used_as_session_identity",
        },
        "circuit_breaker": (health or {}).get("read_circuit_breaker"),
        "market_observation": {
            "last_succeeded_utc": mo.get("last_succeeded_utc"),
            "last_error": mo.get("last_error"),
            "age_seconds": _age_seconds(mo.get("last_succeeded_utc")),
        },
        "reconnect_generation": {
            "operational_generation": operational.get("generation"),
            "market_stream": operational.get("marketStream"),
            "user_stream": operational.get("userStream"),
            "recovery": (health or {}).get("recovery"),
        },
        "processes": {
            "gateway_listeners": _gateway_processes(port),
            "data_logs": {
                "stdout_tail": _tail_file(DATA / "gateway.stdout.log", 40),
                "stderr_tail": _tail_file(DATA / "gateway.stderr.log", 40),
            },
        },
        "account": {
            "flat": open_qty == 0 if open_qty is not None else None,
            "open_contracts": open_qty,
            "unprotected_open_quantity": unprotected,
            "recovery_blocking": recovery.get("blockingNewExposure"),
            "gateway_status": (health or {}).get("status"),
            "state_complete": dq.get("state_complete"),
        },
        "cron_ownership": {
            "hermes_cron": _hermes_cron_status(),
            "model_owner": _read_owner_lock(PROFILE_STATE),
            "evaluation_lease": _read_evaluation_lease(PROFILE_STATE),
            "evaluation_home_isolated": str(EVAL_PROFILE.resolve()),
        },
        "evidence_chain_age": {
            "last_decision": last_decision,
            "last_decision_age_seconds": _age_seconds((last_decision or {}).get("recorded_utc")),
            "last_receipt": last_receipt_file,
            "last_receipt_age_seconds": _age_seconds((last_receipt_file or {}).get("recorded_utc")),
        },
        "bar_1m_partial": _bar_partial(packet),
    }
    return diagnosis


def classify_blocking(diagnosis: dict[str, Any]) -> dict[str, Any]:
    health = (diagnosis.get("health") or {}).get("body") or {}
    packet = (diagnosis.get("packet") or {}).get("body") or {}
    account = diagnosis.get("account") or {}
    mo = diagnosis.get("market_observation") or {}
    reasons: list[str] = []

    if not diagnosis.get("gateway_reachable"):
        reasons.append("gateway_unreachable")
    elif str(health.get("status") or "") == "degraded":
        reasons.append("state_incomplete")
    elif health.get("data_quality", {}).get("state_complete") is not True:
        reasons.append("state_incomplete")

    if mo.get("last_error"):
        err = str(mo.get("last_error")).lower()
        if "circuit breaker" in err or "circuit_breaker" in err:
            reasons.append("circuit_breaker")
        elif "auth" in err or "401" in err or "403" in err:
            reasons.append("authentication")
        elif "projectx" in err or "fetch failed" in err or "timeout" in err:
            reasons.append("external_projectx_outage")
        else:
            reasons.append("stream_stale")

    mo_age = mo.get("age_seconds")
    if isinstance(mo_age, (int, float)) and mo_age > 300:
        reasons.append("stream_stale")

    if _circuit_breaker_open(health):
        reasons.append("circuit_breaker")

    if diagnosis.get("bar_1m_partial"):
        reasons.append("bar_1m_partial")

    if account.get("unprotected_open_quantity", 0) > 0:
        reasons.append("unprotected_exposure")

    if account.get("recovery_blocking") is True:
        reasons.append("recovery_blocked")

    if account.get("flat") is False:
        reasons.append("not_flat")

    owner = (diagnosis.get("cron_ownership") or {}).get("model_owner") or {}
    if str(owner.get("owner_kind") or "") in {"direct_cycle", "production"}:
        reasons.append("prac_cycle_active")

    if not diagnosis.get("gateway_reachable") and not diagnosis.get("processes", {}).get("gateway_listeners"):
        reasons.append("process_stalled")

    # Primary classification
    classification = "unknown"
    if "maintenance" in json.dumps(health).lower():
        classification = "maintenance_outage"
    elif "authentication" in reasons:
        classification = "authentication_failure"
    elif "external_projectx_outage" in reasons:
        classification = "external_projectx_outage"
    elif "circuit_breaker" in reasons:
        classification = "circuit_breaker_transient"
    elif "stream_stale" in reasons:
        classification = "stream_stale_recoverable"
    elif "process_stalled" in reasons or "gateway_unreachable" in reasons:
        classification = "gateway_unreachable"
    elif "state_incomplete" in reasons:
        classification = "state_incomplete_recoverable"
    elif "bar_1m_partial" in reasons:
        classification = "bar_1m_partial"
    elif "unprotected_exposure" in reasons or "recovery_blocked" in reasons or "not_flat" in reasons:
        classification = "unsafe_to_restart"
    elif health.get("status") == "ok" and health.get("data_quality", {}).get("state_complete") is True:
        classification = "stable"

    restart_authorized = classification in RESTART_AUTHORIZED_CAUSES
    if classification in NO_RESTART_CAUSES or classification == "unsafe_to_restart":
        restart_authorized = False

    safe_pre_restart = (
        account.get("flat") is True
        and int(account.get("unprotected_open_quantity") or 0) == 0
        and account.get("recovery_blocking") is not True
        and "prac_cycle_active" not in reasons
        and "unprotected_exposure" not in reasons
    )

    return {
        "classification": classification,
        "reasons": sorted(set(reasons)),
        "restart_authorized": restart_authorized and safe_pre_restart,
        "safe_pre_restart": safe_pre_restart,
        "lanes_blocked": classification != "stable",
    }


def _lease_available() -> tuple[bool, dict[str, Any] | None]:
    lease = _read_evaluation_lease(PROFILE_STATE)
    active = False
    if lease:
        try:
            from evaluation_lease import evaluation_lease_active

            active = evaluation_lease_active(PROFILE_STATE)
        except ImportError:
            active = bool(lease.get("run_id"))
    return not active, lease


def _sync_profile_token_env() -> None:
    """Profile scripts expect GLITCH_TOPSTEP_LOCAL_TOKEN; gateway .env uses GLITCH_LOCAL_TOKEN."""
    if os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip():
        return
    try:
        os.environ["GLITCH_TOPSTEP_LOCAL_TOKEN"] = load_token()
    except RuntimeError:
        pass


def run_stability_window(*, max_minutes: float = 8.0, required_samples: int = 5) -> dict[str, Any]:
    _sync_profile_token_env()
    profile_scripts = ROOT.parent / "glitch-topstep-hermes-profile" / "scripts"
    if profile_scripts.is_dir():
        sys.path.insert(0, str(profile_scripts))
        try:
            from operational_stability_gate import run_operational_stability_window
            from shadow_gateway_readonly import fetch_gateway_health_raw, fetch_gateway_packet_readonly
        except ImportError:
            pass
        else:

            def _lease_checker() -> tuple[bool, str | None]:
                ok, _doc = _lease_available()
                return ok, "lease_occupied" if not ok else None

            result = run_operational_stability_window(
                health_fetcher=fetch_gateway_health_raw,
                packet_fetcher=fetch_gateway_packet_readonly,
                required_samples=required_samples,
                max_duration_seconds=max_minutes * 60,
                bar_close_aware=True,
                lease_checker=_lease_checker,
            )
            lease_ok, lease_doc = _lease_available()
            result["lease_available"] = lease_ok
            result["lease"] = lease_doc
            if result.get("confirmed") and not lease_ok:
                result["confirmed"] = False
                result["classification"] = BLOCKED_CLASSIFICATION
                result["stop_reason"] = "lease_occupied"
            return result

    # ponytail: fallback poll via gateway_client when profile path unavailable
    samples: list[dict[str, Any]] = []
    ok_streak = 0
    started = time.monotonic()
    while time.monotonic() - started < max_minutes * 60 and ok_streak < required_samples:
        hs, health, err = _http_get("/health")
        ps, packet, _ = _http_get("/packet")
        sample_ok = (
            hs == 200
            and isinstance(health, dict)
            and health.get("status") == "ok"
            and (health.get("data_quality") or {}).get("state_complete") is True
            and not _circuit_breaker_open(health)
            and not _bar_partial(packet)
        )
        samples.append({"ok": sample_ok, "status": (health or {}).get("status"), "error": err})
        ok_streak = ok_streak + 1 if sample_ok else 0
        if ok_streak < required_samples:
            time.sleep(30)
    confirmed = ok_streak >= required_samples
    return {
        "confirmed": confirmed,
        "classification": None if confirmed else BLOCKED_CLASSIFICATION,
        "samples": samples,
        "consecutive_ok": ok_streak,
    }


def wait_for_bar_complete(*, timeout_seconds: float = 300.0, poll_seconds: float = 5.0) -> dict[str, Any]:
    started = time.monotonic()
    while time.monotonic() - started < timeout_seconds:
        _, packet, _ = _http_get("/packet")
        if not _bar_partial(packet):
            return {"ready": True, "waited_seconds": round(time.monotonic() - started, 2)}
        time.sleep(poll_seconds)
    return {"ready": False, "reason": "bar_still_partial", "waited_seconds": round(time.monotonic() - started, 2)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Gateway read-only diagnosis before PRAC/soak")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "docs" / "evidence" / "gateway-diagnosis")
    parser.add_argument("--restart-if-authorized", action="store_true")
    parser.add_argument("--stability-after-restart", action="store_true", default=True)
    parser.add_argument(
        "--stability-window",
        action="store_true",
        help="Run bounded stability window (read-only, no restart)",
    )
    parser.add_argument("--wait-bar-complete", action="store_true", help="Wait for 1m bar close before diagnosis")
    args = parser.parse_args()

    out_dir = args.output_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    bar_wait = None
    if args.wait_bar_complete:
        bar_wait = wait_for_bar_complete()
        (out_dir / f"bar-wait-{stamp}.json").write_text(json.dumps(bar_wait, indent=2) + "\n", encoding="utf-8")
        if not bar_wait.get("ready"):
            report = {
                "generated_utc": utc_now(),
                "classification": "bar_1m_partial",
                "bar_wait": bar_wait,
                "lanes": {"prac": "BLOCKED", "evaluation_soak": "BLOCKED"},
            }
            path = out_dir / f"gateway-diagnosis-verdict-{stamp}.json"
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"blocked": "bar_1m_partial", "output": str(path)}, indent=2))
            return 1

    pre = capture_gateway_diagnosis()
    pre_path = out_dir / f"gateway-diagnosis-pre-{stamp}.json"
    pre_path.write_text(json.dumps(pre, indent=2) + "\n", encoding="utf-8")

    verdict = classify_blocking(pre)
    verdict_path = out_dir / f"gateway-diagnosis-verdict-{stamp}.json"
    report = {
        "generated_utc": utc_now(),
        "pre_diagnosis_path": str(pre_path),
        "verdict": verdict,
        "restart_performed": False,
        "post_diagnosis_path": None,
        "stability_window": None,
        "lanes": {
            "prac": "BLOCKED",
            "evaluation_soak": "BLOCKED",
            "shadow": "PENDING",
            "paper": "PENDING",
        },
    }

    if verdict["classification"] == "stable":
        report["lanes"]["prac"] = "READY_PENDING_OPERATOR"
        report["lanes"]["evaluation_soak"] = "READY_PENDING_PRAC_FIRST_CYCLE"

    if args.stability_window and not args.restart_if_authorized:
        stability = run_stability_window()
        report["stability_window"] = stability
        stab_path = out_dir / f"gateway-stability-window-{stamp}.json"
        stab_path.write_text(json.dumps(stability, indent=2) + "\n", encoding="utf-8")
        if stability.get("confirmed"):
            report["lanes"]["prac"] = "READY_PENDING_OPERATOR"
            report["lanes"]["evaluation_soak"] = "READY_PENDING_PRAC_FIRST_CYCLE"
            report["classification"] = "stable"
        else:
            report["classification"] = stability.get("classification") or BLOCKED_CLASSIFICATION
            report["lanes"]["prac"] = "BLOCKED"
            report["lanes"]["evaluation_soak"] = "BLOCKED"

    if args.restart_if_authorized and verdict.get("restart_authorized"):
        restart_gateway(None, skip_build=True)
        time.sleep(3)
        wait_gateway_ready(120)
        post = capture_gateway_diagnosis()
        post_path = out_dir / f"gateway-diagnosis-post-{stamp}.json"
        post_path.write_text(json.dumps(post, indent=2) + "\n", encoding="utf-8")
        report["restart_performed"] = True
        report["post_diagnosis_path"] = str(post_path)
        if args.stability_after_restart:
            stability = run_stability_window()
            report["stability_window"] = stability
            stab_path = out_dir / f"gateway-stability-window-{stamp}.json"
            stab_path.write_text(json.dumps(stability, indent=2) + "\n", encoding="utf-8")
            if stability.get("confirmed"):
                report["lanes"]["prac"] = "READY_PENDING_OPERATOR"
                report["lanes"]["evaluation_soak"] = "READY_PENDING_PRAC_FIRST_CYCLE"
            else:
                report["classification"] = BLOCKED_CLASSIFICATION
                report["lanes"]["prac"] = "BLOCKED"
                report["lanes"]["evaluation_soak"] = "BLOCKED"
    elif verdict.get("lanes_blocked", True) and verdict["classification"] != "stable":
        report["classification"] = verdict["classification"]

    verdict_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    ok = report["lanes"].get("prac") != "BLOCKED" and (
        report.get("stability_window", {}).get("confirmed") is True
        if args.stability_window
        else report["lanes"].get("prac") != "BLOCKED"
    )
    print(
        json.dumps(
            {
                "verdict": report.get("verdict", verdict),
                "stability_confirmed": (report.get("stability_window") or {}).get("confirmed"),
                "output": str(verdict_path),
            },
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
