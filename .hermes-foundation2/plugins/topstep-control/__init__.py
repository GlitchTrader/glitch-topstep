"""Deterministic Glitch Topstep slash commands; no LLM turn is involved."""
from __future__ import annotations

import json
import os
import tempfile
import uuid
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import sys

PROFILE_NAME = "glitch-topstep"
JOB_NAMES = (
    "glitch-topstep-direct-operator",
    "glitch-topstep-learning-supervisor",
    "glitch-topstep-wake-monitor",
)


def _ensure_scripts_path() -> None:
    scripts = _profile_root() / "scripts"
    path = str(scripts)
    if scripts.is_dir() and path not in sys.path:
        sys.path.insert(0, path)


def _compatibility_summary(health: dict[str, Any]) -> str:
    _ensure_scripts_path()
    from compatibility import compatibility_summary

    return compatibility_summary(health)


def _verify_gateway_compatibility(health: dict[str, Any]) -> None:
    _ensure_scripts_path()
    from compatibility import verify_gateway_compatibility

    verify_gateway_compatibility(health)


def _profile_root() -> Path:
    explicit = os.environ.get("HERMES_HOME")
    if explicit:
        return Path(explicit).resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return (Path(local_app_data) / "hermes" / "profiles" / PROFILE_NAME).resolve()
    return (Path.home() / ".hermes" / "profiles" / PROFILE_NAME).resolve()


def _load_dotenv() -> None:
    path = _profile_root() / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def _gateway_url() -> str:
    _load_dotenv()
    value = os.environ.get("GLITCH_TOPSTEP_GATEWAY_URL", "http://127.0.0.1:8790").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    host = (parsed.hostname or "").lower()
    loopback = host in {"localhost", "127.0.0.1", "::1"}
    if parsed.username or parsed.password or parsed.path not in {"", "/"}:
        raise RuntimeError("GLITCH_TOPSTEP_GATEWAY_URL must be a bare HTTP(S) origin")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("GLITCH_TOPSTEP_GATEWAY_URL must use HTTP(S)")
    if parsed.scheme != "https" and not loopback:
        raise RuntimeError("non-loopback gateway URLs must use HTTPS")
    return value


def _token() -> str:
    _load_dotenv()
    value = os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip()
    if not value:
        raise RuntimeError("GLITCH_TOPSTEP_LOCAL_TOKEN is not configured in the profile .env file.")
    return value


def _operator_token() -> str:
    _load_dotenv()
    value = os.environ.get("GLITCH_TOPSTEP_OPERATOR_TOKEN", "").strip()
    if not value:
        raise RuntimeError("GLITCH_TOPSTEP_OPERATOR_TOKEN is not configured in the profile .env file.")
    return value


def _request(path: str, *, method: str = "GET", body: dict[str, Any] | None = None, authenticated: bool = True, token: str | None = None) -> tuple[int, dict[str, Any]]:
    import urllib.error
    import urllib.request

    headers = {"Accept": "application/json"}
    if authenticated:
        headers["Authorization"] = f"Bearer {token or _token()}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(_gateway_url() + path, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.loads(response.read().decode("utf-8", errors="replace") or "{}")
            return int(response.status), value if isinstance(value, dict) else {"body": value}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            value = json.loads(payload or "{}")
        except json.JSONDecodeError:
            value = {"error": "http_error", "message": payload}
        return int(error.code), value if isinstance(value, dict) else {"body": value}


def _job(name: str) -> Optional[dict[str, Any]]:
    from cron.jobs import list_jobs
    return next((job for job in list_jobs(include_disabled=True) if job.get("name") == name), None)


def _direct_worker_status() -> str:
    path = _profile_root() / "state" / "supervisor" / "direct-worker-status.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return "unknown"
    status = str(value.get("status") or "unknown")
    recorded = str(value.get("recorded_utc") or "").strip()
    suffix = f" @ {recorded}" if recorded else ""
    if status != "failed":
        return f"{status}{suffix}"
    error = str(value.get("error") or "").strip()
    if error:
        return f"failed ({error[:160]}){suffix}"
    return f"failed{suffix}"


def _pause_jobs(reason: str) -> str:
    from cron.jobs import pause_job
    states = []
    for name in JOB_NAMES:
        job = _job(name)
        if not job:
            states.append(f"{name}=not-installed")
        elif not job.get("enabled", True):
            states.append(f"{name}=already-paused")
        else:
            if pause_job(job["id"], reason=reason) is None:
                raise RuntimeError(f"Hermes could not pause {name}.")
            states.append(f"{name}=paused")
    return ", ".join(states)


def _resume_jobs() -> str:
    from cron.jobs import resume_job
    states = []
    for name in JOB_NAMES:
        job = _job(name)
        if not job:
            raise RuntimeError(f"{name} is not installed. Run setup.ps1 first.")
        if job.get("enabled", True):
            states.append(f"{name}=already-running")
        else:
            if resume_job(job["id"]) is None:
                raise RuntimeError(f"Hermes could not resume {name}.")
            states.append(f"{name}=running")
    return ", ".join(states)


def _status_text() -> str:
    health_status, health = _request("/health", authenticated=False)
    jobs = [_job(name) for name in JOB_NAMES]
    if any(job is None for job in jobs):
        job_state = "not-installed"
    elif all(job.get("enabled", True) for job in jobs if job):
        job_state = "running"
    elif all(not job.get("enabled", True) for job in jobs if job):
        job_state = "paused"
    else:
        job_state = "partial"
    if health_status != 200:
        return (
            f"Glitch Topstep gateway: unavailable; Hermes jobs: {job_state}; "
            f"operator worker: {_direct_worker_status()}."
        )
    mode = str(health.get("trading_mode") or "unknown")
    compatibility = _compatibility_summary(health)
    try:
        state_status, state = _request("/state")
    except Exception:
        state_status, state = 0, {}
    account = state.get("account", {}) if isinstance(state, dict) else {}
    account_name = account.get("name") or "unknown"
    can_trade = account.get("canTrade") if isinstance(account, dict) else None
    state_text = "available" if state_status == 200 else "unavailable"
    return (
        f"Glitch Topstep gateway: {mode}; compatibility: {compatibility}; "
        f"state: {state_text}; account: {account_name}; "
        f"canTrade: {can_trade}; Hermes jobs: {job_state}; "
        f"operator worker: {_direct_worker_status()}."
    )


def _trade(_raw_args: str) -> str:
    status, health = _request("/health", authenticated=False)
    if status != 200 or health.get("status") != "ok":
        raise RuntimeError("The Glitch Topstep gateway is not healthy; jobs remain paused.")
    _verify_gateway_compatibility(health)
    mode = str(health.get("trading_mode") or "unknown")
    if mode == "disabled":
        raise RuntimeError("The gateway is disabled. Start it in shadow or armed mode before enabling Hermes cycles.")
    jobs = _resume_jobs()
    return f"Glitch Topstep cognition is ON; gateway mode is {mode}; jobs: {jobs}."


def _pause(_raw_args: str) -> str:
    return "Glitch Topstep cognition is OFF; jobs: " + _pause_jobs("operator_slash_command") + "."


def _write_directive(bias: str, raw_args: str, directive_type: str) -> str:
    now = datetime.now(timezone.utc)
    value = {
        "schema_version": "glitch.topstep.operator_directive.v1",
        "directive_id": str(uuid.uuid4()),
        "created_utc": now.isoformat().replace("+00:00", "Z"),
        "expires_utc": (now + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        "status": "pending",
        "bias": bias,
        "directive_type": directive_type,
        "rationale": raw_args.strip() or f"Operator requested a {bias} {directive_type} for the next cycle.",
        "source": "glitch-topstep-chat",
    }
    state = _profile_root() / "state"
    state.mkdir(parents=True, exist_ok=True)
    path = state / "operator-directive.json"
    fd, name = tempfile.mkstemp(prefix="operator-directive.", suffix=".tmp", dir=state)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, separators=(",", ":"))
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass
    with (state / "operator-directives.jsonl").open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    if directive_type == "forced_entry":
        return f"One protected {bias} experiment is queued for the next eligible flat cycle. The gateway retains final risk and execution authority."
    return f"A {bias} advisory is queued for the next cycle and expires in 15 minutes."


def _entry_eligible_execution(execution: dict[str, Any]) -> bool:
    # ponytail: v2 packets expose new_exposure_technically_supported; legacy alias entry_actions_enabled
    if execution.get("entry_actions_enabled") is True:
        return True
    if execution.get("new_exposure_technically_supported") is not True:
        return False
    actions = execution.get("supported_actions")
    if isinstance(actions, list) and not any(
        action in actions for action in ("ENTER_LONG", "ENTER_SHORT")
    ):
        return False
    quantities = execution.get("valid_entry_quantities")
    if isinstance(quantities, list) and quantities:
        return True
    return int(execution.get("maximum_additional_contracts") or 0) > 0


def _require_flat_eligible() -> dict[str, Any]:
    status, packet = _request("/packet")
    if status != 200:
        raise RuntimeError("The current decision packet is unavailable.")
    account = packet.get("account") if isinstance(packet, dict) else None
    execution = packet.get("execution") if isinstance(packet, dict) else None
    if not isinstance(account, dict) or int(account.get("instrument_open_contracts") or 0) != 0:
        raise RuntimeError("The configured account is not flat; no forced entry was queued.")
    if not isinstance(execution, dict) or not _entry_eligible_execution(execution):
        raise RuntimeError("The current packet is not entry-eligible; no forced entry was queued.")
    quantities = execution.get("valid_entry_quantities")
    if not isinstance(quantities, list) or not quantities:
        max_additional = int(execution.get("maximum_additional_contracts") or 0)
        if max_additional <= 0:
            raise RuntimeError("The current packet has no valid entry quantity.")
    return packet


def _long(raw_args: str) -> str:
    _require_flat_eligible()
    _resume_jobs()
    return _write_directive("long", raw_args, "forced_entry")


def _short(raw_args: str) -> str:
    _require_flat_eligible()
    _resume_jobs()
    return _write_directive("short", raw_args, "forced_entry")


def _bias_long(raw_args: str) -> str:
    return _write_directive("long", raw_args, "advisory")


def _bias_short(raw_args: str) -> str:
    return _write_directive("short", raw_args, "advisory")


def _bias_neutral(raw_args: str) -> str:
    return _write_directive("neutral", raw_args, "advisory")


def build_exit_intent(packet: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    action = "EXIT"
    return {
        "schema_version": "glitch.intent.v2",
        "intent_id": str(uuid.uuid4()),
        "created_utc": now,
        "instrument": packet["instrument"],
        "account": packet["account"]["name"],
        "operator_profile": PROFILE_NAME,
        "action": action,
        "confidence": 1.0,
        "snapshot_hash": packet["market"]["snapshot_hash"],
        "model_version": "operator-control",
        "prompt_version": "operator-flatten-v1",
        "reason": "Operator requested immediate flatten and paused scheduled cognition.",
        "decision_audit": {
            "bull_case": "Irrelevant to an explicit risk-reducing operator command.",
            "bear_case": "Irrelevant to an explicit risk-reducing operator command.",
            "flat_case": "The requested terminal state is flat.",
            "aggressive_case": "Remain exposed, contrary to the operator command.",
            "conservative_case": "Exit current exposure immediately.",
            "decisive_evidence": "The authenticated operator requested flatten.",
            "disconfirming_evidence": "No market evidence overrides a human risk-reducing command.",
            "change_condition": "A later explicit operator command may resume cognition.",
            "final_choice": action,
        },
    }


def _flatten(_raw_args: str) -> str:
    jobs = _pause_jobs("operator_flatten")
    status, packet = _request("/packet")
    if status != 200:
        raise RuntimeError(f"Jobs were paused, but the current packet is unavailable; jobs: {jobs}.")
    account = packet.get("account") if isinstance(packet, dict) else None
    if not isinstance(account, dict) or int(account.get("instrument_open_contracts") or 0) == 0:
        return f"Account is already flat; cognition remains paused; jobs: {jobs}."
    contract = packet.get("contract") if isinstance(packet, dict) else None
    if not isinstance(contract, dict) or not str(contract.get("id") or ""):
        raise RuntimeError("Current packet has no exact contract identity for flatten.")
    command = {
        "schema_version": "glitch.topstep.control.v1",
        "control_id": str(uuid.uuid4()),
        "action": "flatten",
        "account_id": int(account.get("id") or 0),
        "contract_id": str(contract["id"]),
        "issuer": "hermes-topstep-control",
        "created_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "reason": "Authenticated operator requested immediate flatten.",
    }
    result_status, result = _request("/control", method="POST", body=command, token=_operator_token())
    if result_status not in {200, 202}:
        raise RuntimeError(f"Flatten was rejected ({result_status}): {json.dumps(result, separators=(',', ':'))}")
    return f"Flatten intent submitted; cognition remains paused; jobs: {jobs}."


def register(ctx) -> None:
    commands = {
        "trade": (_trade, "Enable scheduled Topstep trading cognition; gateway mode remains independently configured."),
        "pause-trading": (_pause, "Pause the Topstep operator and learning jobs."),
        "flatten-all": (_flatten, "Pause cognition and submit one deterministic EXIT for the configured account."),
        "topstep-status": (lambda _args: _status_text(), "Show gateway, account, and Hermes job state."),
        "long": (_long, "Queue one protected operator-directed long for the next eligible cycle."),
        "short": (_short, "Queue one protected operator-directed short for the next eligible cycle."),
        "bias-long": (_bias_long, "Add a soft long advisory for the next cycle."),
        "bias-short": (_bias_short, "Add a soft short advisory for the next cycle."),
        "bias-neutral": (_bias_neutral, "Add a neutral advisory for the next cycle."),
    }
    for name, (handler, description) in commands.items():
        ctx.register_command(name, handler=handler, description=description)
        ctx.register_command(name.replace("-", "_"), handler=handler, description=description)
