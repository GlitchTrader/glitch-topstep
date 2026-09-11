"""Independent, read-only account safety preflight.

This preflight deliberately does not call ``/packet`` and never infers
flatness from packet or cached packet evidence.  It uses authenticated
``/state`` and ``/ownership`` plus health/reconciliation metadata.  Missing or
stale evidence is a failure, not a pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
PROFILE_SCRIPTS = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/scripts"
try:
    if PROFILE_SCRIPTS.is_dir():
        sys.path.insert(0, str(PROFILE_SCRIPTS))
except OSError:
    # A locked Hermes home is a runtime failure, not a reason to use another
    # credential or profile location.  The request path will fail closed.
    pass

SCHEMA = "glitch.topstep.gateway_account_preflight.v1"
MAX_RECONCILIATION_AGE_SECONDS = 180


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def age_seconds(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _quantity_total(value: Any) -> float | None:
    direct = _number(value)
    if direct is not None:
        return abs(direct)
    if isinstance(value, list):
        totals = [_quantity_total(item) for item in value]
        if any(item is None for item in totals):
            return None
        return sum(item or 0 for item in totals)
    if isinstance(value, dict):
        for key in ("quantity", "open_quantity", "openContracts", "instrument_open_contracts"):
            if key in value:
                return _quantity_total(value[key])
        return None
    return None


def state_open_quantity(state: dict[str, Any]) -> float | None:
    for key in ("instrumentOpenContracts", "open_contracts", "openContracts"):
        if key in state:
            value = state[key]
            if isinstance(value, dict):
                numeric_values = [_number(item) for item in value.values()]
                if numeric_values and all(item is not None for item in numeric_values):
                    return sum(abs(item or 0) for item in numeric_values)
            return _quantity_total(value)
    for key in ("positions", "open_positions", "account_positions"):
        if key in state:
            value = state[key]
            if isinstance(value, list):
                quantities = [_quantity_total(item) for item in value]
                return sum(item or 0 for item in quantities) if all(item is not None for item in quantities) else None
            return _quantity_total(value)
    return None


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _git_head(path: Path) -> str | None:
    try:
        return subprocess.check_output(
            ["git", "-c", f"safe.directory={path}", "-C", str(path), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _paired_identity(profile_root: Path | None) -> dict[str, Any]:
    gateway_pair_path = ROOT / "release" / "paired-contract.json"
    gateway_pair = _read_json(gateway_pair_path)
    result: dict[str, Any] = {
        "gateway_commit": _git_head(ROOT),
        "gateway_pair_sha256": hashlib.sha256(gateway_pair_path.read_bytes()).hexdigest()
        if gateway_pair_path.is_file()
        else None,
        "profile_commit": _git_head(profile_root) if profile_root else None,
        "profile_pair_sha256": None,
        "matched": False,
        "reason": None,
    }
    if not gateway_pair or not profile_root:
        result["reason"] = "gateway_or_profile_pair_missing"
        return result
    profile_pair_path = profile_root / "paired-contract.json"
    profile_pair = _read_json(profile_pair_path)
    if not profile_pair:
        result["reason"] = "profile_pair_missing"
        return result
    result["profile_pair_sha256"] = hashlib.sha256(profile_pair_path.read_bytes()).hexdigest()
    def pair_value(doc: dict[str, Any], key: str) -> Any:
        if key == "prompt_version":
            return (doc.get("profile") or {}).get("prompt_version")
        if key == "intent_schema":
            return doc.get("runtime_intent_schema")
        if key == "protocol_version":
            return doc.get("protocol_revision")
        return doc.get(key)

    comparable = ("protocol_version", "prompt_version", "intent_schema", "paired_manifest_schema")
    result["matched"] = all(pair_value(gateway_pair, key) == pair_value(profile_pair, key) for key in comparable)
    result["reason"] = None if result["matched"] else "paired_fields_mismatch"
    return result


def _profile_lock_state() -> dict[str, Any]:
    state_root = Path.home() / "AppData/Local/hermes/profiles/glitch-topstep/state"
    lock = _read_json(state_root / "model-owner.lock.json")
    lease = _read_json(state_root / "evaluation-lease.json")
    active_owner = isinstance(lock, dict) and lock.get("owner_kind") in {"direct_cycle", "production"}
    active_lease = isinstance(lease, dict) and bool(lease.get("run_id"))
    return {"active_owner": active_owner, "active_evaluation_lease": active_lease}


def _get(path: str) -> tuple[int | None, dict[str, Any] | None, str | None]:
    try:
        from gateway_client import request_json

        token = os.environ.get("GLITCH_LOCAL_TOKEN", "").strip()
        if not token:
            env_path = ROOT / ".env"
            if env_path.is_file():
                for raw in env_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                    line = raw.strip()
                    if line.startswith("GLITCH_LOCAL_TOKEN="):
                        token = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        if not token:
            raise RuntimeError("GLITCH_LOCAL_TOKEN not configured")
        status, body = request_json(path, token=token)
        return status, body if isinstance(body, dict) else None, None
    except Exception as exc:  # sanitized type/message only
        return None, None, type(exc).__name__


def run_preflight(profile_root: Path | None) -> dict[str, Any]:
    if profile_root:
        profile_scripts = profile_root / "scripts"
        if profile_scripts.is_dir():
            sys.path.insert(0, str(profile_scripts))
    health_status, health, health_error = _get("/health")
    state_status, state, state_error = _get("/state")
    ownership_status, ownership, ownership_error = _get("/ownership")

    health = health or {}
    state = state or {}
    ownership = ownership or {}
    dq = health.get("data_quality") if isinstance(health.get("data_quality"), dict) else {}
    recovery = health.get("execution_recovery") if isinstance(health.get("execution_recovery"), dict) else {}
    operational = dq.get("operational") if isinstance(dq.get("operational"), dict) else {}
    reconciliation = operational.get("reconciliation") if isinstance(operational.get("reconciliation"), dict) else {}
    recon_ts = reconciliation.get("lastSucceededAt") or reconciliation.get("lastSucceeded") or reconciliation.get("last_succeeded_utc")
    recon_age = age_seconds(recon_ts)
    open_quantity = state_open_quantity(state)
    ownership_unprotected = ownership.get("unprotected_open_quantity")
    invariant_unprotected = (health.get("invariant_metrics") or {}).get("unprotected_open_quantity")
    unprotected = ownership_unprotected if ownership_unprotected is not None else invariant_unprotected
    stream_event = (operational.get("userStream") or {}).get("lastEventAt")
    stream_age = age_seconds(stream_event)
    pairing = _paired_identity(profile_root)
    locks = _profile_lock_state()

    checks = {
        "health_authenticated": health_status == 200,
        "state_endpoint_authenticated": state_status == 200,
        "ownership_endpoint_authenticated": ownership_status == 200,
        "account_flat_from_state": open_quantity is not None and open_quantity == 0,
        "unprotected_zero_from_non_packet_source": unprotected is not None and float(unprotected) == 0,
        "recovery_not_blocking": recovery.get("blockingNewExposure") is False
        and recovery.get("blockingAmbiguity") is False,
        "reconciliation_fresh": recon_age is not None and recon_age <= MAX_RECONCILIATION_AGE_SECONDS,
        "user_stream_or_reconciliation_timestamp": (
            stream_age is not None and stream_age <= MAX_RECONCILIATION_AGE_SECONDS
        ) or (recon_age is not None and recon_age <= MAX_RECONCILIATION_AGE_SECONDS),
        "no_active_prac_cycle": not locks["active_owner"] and not locks["active_evaluation_lease"],
        "paired_gateway_profile": pairing["matched"],
        "delivery_disabled": health.get("trading_mode") in {"disabled", "shadow"}
        and health.get("gateway_mode") != "armed",
        "gateway_supervised_overnight_false": health.get("gateway_supervised_overnight") is False,
    }
    safe = all(checks.values())
    return {
        "schema_version": SCHEMA,
        "captured_utc": utc_now(),
        "safe_pre_restart": safe,
        "fail_closed": not safe,
        "checks": checks,
        "account": {
            "open_quantity_from_state": open_quantity,
            "unprotected_open_quantity": unprotected,
            "source": "state_and_ownership_or_health_invariant;never_packet",
        },
        "freshness": {
            "reconciliation_timestamp": recon_ts,
            "reconciliation_age_seconds": recon_age,
            "user_stream_last_event_at": stream_event,
            "user_stream_age_seconds": stream_age,
        },
        "recovery": {
            "blocking_new_exposure": recovery.get("blockingNewExposure"),
            "blocking_ambiguity": recovery.get("blockingAmbiguity"),
        },
        "pairing": pairing,
        "locks": locks,
        "endpoints": {
            "/health": {"http_status": health_status, "error_type": health_error},
            "/state": {"http_status": state_status, "error_type": state_error},
            "/ownership": {"http_status": ownership_status, "error_type": ownership_error},
        },
        "packet_used_for_flatness": False,
        "packet_called": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    evidence = run_preflight(args.profile_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"safe_pre_restart": evidence["safe_pre_restart"], "output": str(args.output)}))
    return 0 if evidence["safe_pre_restart"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
