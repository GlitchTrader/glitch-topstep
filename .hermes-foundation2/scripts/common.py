from __future__ import annotations

import json
import hashlib
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from compatibility import (
    PROFILE_COMPATIBILITY,
    compatibility_issues,
    compatibility_summary,
    verify_gateway_compatibility,
)
from outcome_store import OutcomeStore

PROFILE_NAME = "glitch-topstep"
DEFAULT_GATEWAY_URL = "http://127.0.0.1:8790"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def profile_root(profile: str = PROFILE_NAME) -> Path:
    explicit = os.environ.get("HERMES_HOME")
    if explicit:
        return Path(explicit).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return (Path(local_app_data) / "hermes" / "profiles" / profile).resolve()
    return (Path.home() / ".hermes" / "profiles" / profile).resolve()


def state_root(profile: Path) -> Path:
    """Durable runtime state under the installed Hermes profile."""
    return profile / "state"


# ponytail: profile .env wins for cron routing keys — Hermes daemon may carry stale values
_DOTENV_FORCE_OVERRIDE_PREFIXES = ("GLITCH_TOPSTEP_",)


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key in os.environ and not key.startswith(_DOTENV_FORCE_OVERRIDE_PREFIXES):
            continue
        os.environ[key] = value


def configure_environment(root: Path | None = None) -> Path:
    resolved = (root or profile_root()).resolve()
    load_dotenv(resolved / ".env")
    return resolved


def use_hermes_model_routing() -> bool:
    return os.environ.get("GLITCH_TOPSTEP_USE_HERMES_MODEL", "true").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def read_model_config(root: Path) -> tuple[str, str]:
    """Read model.default and model.provider from config.yaml (no PyYAML)."""
    model = "gpt-5.6-luna"
    provider = "openai-codex"
    path = root / "config.yaml"
    try:
        exists = path.is_file()
    except OSError:
        exists = False
    if not exists:
        return model, provider
    in_model = False
    try:
        lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    except OSError:
        # Installed Hermes state can be unreadable in hermetic CI. Model routing
        # must fall back safely instead of reaching outside the checked-out profile.
        return model, provider
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("model:"):
            in_model = True
            continue
        if in_model and line and not line[0].isspace() and ":" in stripped:
            in_model = False
        if not in_model:
            continue
        if stripped.startswith("default:"):
            model = stripped.split(":", 1)[1].strip() or model
        elif stripped.startswith("provider:"):
            provider = stripped.split(":", 1)[1].strip() or provider
    return model, provider


def hermes_model_version_label(
    root: Path,
    *,
    model_env: str,
    fallback: str,
) -> str:
    if use_hermes_model_routing():
        return read_model_config(root)[0]
    return os.environ.get(model_env, fallback).strip() or fallback


def hermes_chat_model_cli_args(
    root: Path,
    *,
    model_env: str,
    provider_env: str,
) -> list[str]:
    if use_hermes_model_routing():
        return []
    model = os.environ.get(model_env, "gpt-5.6-luna").strip() or "gpt-5.6-luna"
    provider = os.environ.get(provider_env, "openai-codex").strip() or "openai-codex"
    return ["--model", model, "--provider", provider]


def gateway_url() -> str:
    value = os.environ.get("GLITCH_TOPSTEP_GATEWAY_URL", DEFAULT_GATEWAY_URL).strip().rstrip("/")
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


def local_token() -> str:
    token = os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GLITCH_TOPSTEP_LOCAL_TOKEN is not configured")
    return token


def max_quote_age_ms() -> int:
    try:
        return max(1, int(os.environ.get("GLITCH_TOPSTEP_MAX_QUOTE_AGE_MS", "6000")))
    except ValueError:
        return 6000


def gateway_packet_evidence_is_fresh(packet: dict[str, Any]) -> bool:
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )
    if data_quality.get("state_complete") is not True:
        return False
    quote_age = data_quality.get("quote_age_ms")
    if isinstance(quote_age, (int, float)) and not isinstance(quote_age, bool):
        if float(quote_age) > max_quote_age_ms():
            return False
    return True


def gateway_feed_is_fresh() -> bool:
    """Gateway /health ok, compatible, and current packet evidence complete and not stale."""
    try:
        health_status, health = request_json("/health")
        if health_status != 200 or health.get("status") not in {"ok", "degraded"}:
            return False
        verify_gateway_compatibility(health)
        packet_status, packet = request_json("/packet", token=local_token())
        if packet_status != 200 or not isinstance(packet, dict):
            return False
        return gateway_packet_evidence_is_fresh(packet)
    except (RuntimeError, OSError, ValueError, TypeError):
        return False


def request_timeout_seconds() -> float:
    raw = os.environ.get("GLITCH_TOPSTEP_REQUEST_TIMEOUT_SECONDS", "20")
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 20.0


def request_json(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    token: str | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {"Accept": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        gateway_url() + path,
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=request_timeout_seconds()) as response:
            payload = response.read().decode("utf-8", errors="replace")
            value = json.loads(payload or "{}")
            if not isinstance(value, dict):
                raise ValueError("gateway response must be a JSON object")
            return int(response.status), value
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            value = json.loads(payload or "{}")
        except json.JSONDecodeError:
            value = {"error": "http_error", "message": payload}
        if not isinstance(value, dict):
            value = {"error": "http_error", "body": value}
        return int(error.code), value


def sync_gateway_outcomes_meta(state: Path) -> dict[str, Any]:
    """Project the revisioned gateway feed locally using a durable sequence cursor."""
    token = os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip()
    if not token:
        return {"added": 0, "http_status": None}
    path = state / "outcomes.jsonl"
    store = OutcomeStore(state)
    try:
        store.bootstrap_jsonl(path)
        cursor_path = state / "outcome-feed-cursor.json"
        cursor = read_optional_json(cursor_path) or {}
        after_sequence = max(int(cursor.get("sequence") or 0), store.cursor())
        status, body = request_json(
            f"/outcomes/feed?after_sequence={after_sequence}&limit=1000",
            token=token,
        )
        if status == 503:
            status, body = request_json("/outcomes?limit=100", token=token)
            legacy_rows = body.get("outcomes", []) if isinstance(body, dict) else []
            revisions = [
                {
                    "sequence": after_sequence + index,
                    "revision": 1,
                    "status": "legacy",
                    "content_hash": hashlib.sha256(
                        json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8")
                    ).hexdigest(),
                    "outcome": row,
                }
                for index, row in enumerate(legacy_rows, start=1)
                if isinstance(row, dict)
            ]
        else:
            revisions = body.get("revisions", []) if isinstance(body, dict) else []
        if status != 200 or not isinstance(body, dict) or not isinstance(revisions, list):
            return {"added": 0, "revised": 0, "http_status": status, "sequence": after_sequence}
        revisions = [
            item for item in revisions
            if isinstance(item, dict)
            and isinstance(item.get("outcome"), dict)
            and item["outcome"].get("schema_version") == "glitch.topstep.trade_outcome.v1"
        ]
        high = body.get("high_water_sequence")
        result = store.apply(revisions, high if isinstance(high, int) else None, utc_now())
        store.export_jsonl(path)
        write_json_atomic(cursor_path, {
            "schema_version": "glitch.topstep.outcome_cursor.v1",
            "sequence": result["sequence"],
            "updated_utc": utc_now(),
        })
        return {
            "added": result["added"],
            "revised": result["revised"],
            "http_status": status,
            "sequence": result["sequence"],
            "retention_floor_sequence": body.get("retention_floor_sequence"),
            "storage": store.status(),
        }
    finally:
        store.close()


def sync_gateway_outcomes(state: Path) -> int:
    """Append new canonical trade outcomes exposed by the gateway."""
    return int(sync_gateway_outcomes_meta(state).get("added") or 0)


def sync_gateway_execution_facts(state: Path) -> dict[str, Any]:
    """Append immediate execution facts separately from directional learning."""
    token = os.environ.get("GLITCH_TOPSTEP_LOCAL_TOKEN", "").strip()
    if not token:
        return {"added": 0, "http_status": None, "sequence": 0}
    cursor_path = state / "execution-facts-cursor.json"
    cursor = read_optional_json(cursor_path) or {}
    after_sequence = int(cursor.get("sequence") or 0)
    status, body = request_json(
        f"/execution/facts?after_sequence={after_sequence}&limit=1000",
        token=token,
    )
    if status != 200:
        return {"added": 0, "http_status": status, "sequence": after_sequence}
    facts = body.get("facts")
    if not isinstance(facts, list):
        return {"added": 0, "http_status": status, "sequence": after_sequence}
    added = 0
    high_sequence = after_sequence
    existing_sequences = {
        int(row.get("sequence"))
        for row in read_jsonl(state / "execution-facts.jsonl")
        if isinstance(row.get("sequence"), int)
    }
    for fact in facts:
        if not isinstance(fact, dict) or not isinstance(fact.get("sequence"), int):
            continue
        high_sequence = max(high_sequence, int(fact["sequence"]))
        if int(fact["sequence"]) in existing_sequences:
            continue
        append_jsonl(state / "execution-facts.jsonl", fact)
        existing_sequences.add(int(fact["sequence"]))
        added += 1
    write_json_atomic(cursor_path, {
        "schema_version": "glitch.topstep.execution_facts_cursor.v1",
        "sequence": high_sequence,
        "updated_utc": utc_now(),
    })
    return {"added": added, "http_status": status, "sequence": high_sequence}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def read_optional_json(path: Path) -> dict[str, Any] | None:
    try:
        return read_json(path) if path.is_file() else None
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    result: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, separators=(",", ":"), ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_jsonl_atomic(path: Path, values: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            for value in values:
                stream.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def tail_jsonl(path: Path, count: int) -> list[dict[str, Any]]:
    return read_jsonl(path)[-max(0, count):]


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def process_start_utc(pid: int) -> datetime | None:
    if pid <= 0 or sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        if not ctypes.windll.kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        return datetime.fromtimestamp(
            (ticks - 116444736000000000) / 10_000_000,
            tz=timezone.utc,
        )
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def process_matches_owner(pid: int, started_utc: Any) -> bool:
    if not process_is_alive(pid):
        return False
    actual = process_start_utc(pid)
    if actual is None:
        return True
    try:
        recorded = datetime.fromisoformat(str(started_utc).replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except (TypeError, ValueError):
        return False
    return abs((actual - recorded).total_seconds()) <= 30


def acquire_cycle_lock(lock_path: Path, unreadable_grace_seconds: int = 15) -> bool:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                owner = read_json(lock_path)
                if process_matches_owner(int(owner.get("pid", 0)), owner.get("started_utc")):
                    return False
                lock_path.unlink()
                continue
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                try:
                    if time.time() - lock_path.stat().st_mtime <= unreadable_grace_seconds:
                        return False
                    lock_path.unlink()
                    continue
                except (FileNotFoundError, OSError):
                    continue
        else:
            try:
                started = process_start_utc(os.getpid())
                payload = json.dumps(
                    {
                        "pid": os.getpid(),
                        "started_utc": (started or datetime.now(timezone.utc))
                        .isoformat()
                        .replace("+00:00", "Z"),
                    },
                    separators=(",", ":"),
                )
                os.write(descriptor, payload.encode("utf-8"))
            finally:
                os.close(descriptor)
            return True
    return False


def prune_files(paths: Iterable[Path], keep: int) -> None:
    ordered = sorted(paths, key=lambda item: item.name, reverse=True)
    for path in ordered[max(0, keep):]:
        try:
            path.unlink()
        except OSError:
            pass


def extract_single_json_object(text: str, *, schema: str | None = None) -> dict[str, Any]:
    stripped = text.strip()
    try:
        value = json.loads(stripped)
        if not isinstance(value, dict):
            raise ValueError("model output must be a JSON object")
        return value
    except json.JSONDecodeError as original_error:
        decoder = json.JSONDecoder()
        candidates: list[dict[str, Any]] = []
        for index, character in enumerate(stripped):
            if character != "{":
                continue
            try:
                candidate, _ = decoder.raw_decode(stripped, index)
            except json.JSONDecodeError:
                continue
            if not isinstance(candidate, dict):
                continue
            if schema is None or candidate.get("schema_version") == schema:
                candidates.append(candidate)
        unique = []
        seen = set()
        for candidate in candidates:
            encoded = json.dumps(candidate, sort_keys=True, separators=(",", ":"))
            if encoded not in seen:
                seen.add(encoded)
                unique.append(candidate)
        if len(unique) != 1:
            raise original_error
        return unique[0]
