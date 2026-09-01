"""Run one Glitch Topstep cognition and delivery cycle.

The worker presents truthful gateway evidence to Hermes, validates only the
wire contract and fixed identities, persists the decision before delivery,
and lets the gateway perform final factual execution checks. Advisory market,
risk, policy, cadence, and learning context must never become a hidden trading
rule in this process.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from packet_model import (
    detect_continuity_gap,
    frame_for_model,
    packet_for_cycle,
    packet_for_model as build_model_packet,
)
from regime import detect_regime
from scanner_contract import comparison_template, validate_comparison_ledger
from common import (
    PROFILE_NAME,
    acquire_cycle_lock,
    append_jsonl,
    configure_environment,
    extract_single_json_object,
    hermes_chat_model_cli_args,
    hermes_model_version_label,
    local_token,
    parse_utc,
    profile_root,
    state_root,
    prune_files,
    read_json,
    read_model_config,
    read_optional_json,
    request_json,
    sync_gateway_outcomes,
    tail_jsonl,
    use_hermes_model_routing,
    utc_now,
    verify_gateway_compatibility,
    write_json_atomic,
)
from parity import (
    PROMPT_VERSION,
    active_trade_state,
    apply_cognitive_overlay,
    classify_delivery_result,
    clear_delivery_wire,
    compact_cycle_ledger_context,
    compute_cycle_evidence_delta,
    cycle_wake_fields,
    deliver_packet_intent,
    delivery_diagnostic_detail,
    discard_stale_outbox_intent,
    discard_unexecutable_entry_outbox,
    evaluate_wake_triggers,
    invocation_reason,
    flat_outside_session_window,
    market_quiescent_skip_details,
    session_maintenance_skip_details,
    packet_protection_status,
    protection_status_allows_amendment,
    protection_status_management_guidance,
    latest_prior_attempt,
    learning_context,
    mark_attempt_from_receipt,
    packet_for_outbox_id,
    pending_outbox,
    persist_wake_triggers,
    prune_delivered_outboxes,
    read_pending_wake_invocation,
    record_wake_trigger_fire,
    repeated_change_condition_warning,
    RETRYABLE_ATTEMPT_STATUSES,
    validate_wake_triggers,
    wait_for_packet_rollover,
)

TRADING_SOURCE = "trading"
ALLOWED_ACTIONS = {
    "ENTER_LONG",
    "ENTER_SHORT",
    "HOLD",
    "EXIT",
    "NOTHING",
    "MOVE_STOP",
    "MOVE_TP",
}
TARGET_INTENT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
AUDIT_FIELDS = {
    "bull_case",
    "bear_case",
    "flat_case",
    "aggressive_case",
    "conservative_case",
    "decisive_evidence",
    "disconfirming_evidence",
    "change_condition",
    "final_choice",
}
GATEWAY_REASON_MAX_LENGTH = 1000
GATEWAY_AUDIT_FIELD_MAX_LENGTH = 5000
ACTION_PLACEHOLDER = "<CHOOSE_FROM_supported_actions>"
CONFIDENCE_PLACEHOLDER = "<0.0-1.0>"
PRIOR_HYPOTHESIS_LABELS = (
    "CONFIRMED",
    "INVALIDATED",
    "PARTIALLY_CONFIRMED",
    "UNCHANGED",
)


def truncate_gateway_string(value: str, max_length: int) -> str:
    # ponytail: hard cap aligned with gateway stringField limits
    return value.strip()[:max_length]
CORE_FIELDS = {
    "schema_version",
    "intent_id",
    "created_utc",
    "instrument",
    "account",
    "operator_profile",
    "action",
    "confidence",
    "snapshot_hash",
    "model_version",
    "prompt_version",
    "reason",
    "decision_audit",
}
DECISION_IDENTITY_FIELDS = {
    "packet_id", "contract_id", "scope_hash", "scope_generation", "expires_utc",
}
CORE_FIELDS |= DECISION_IDENTITY_FIELDS
ENTRY_FIELDS = {
    "quantity", "order_type", "stop_loss", "take_profit_1",
    "entry_price_min", "entry_price_max", "supersedes_intent_id",
}
AMENDMENT_FIELDS = {"new_stop_price", "new_take_profit", "target_intent_id"}
EXIT_FIELDS = {"quantity", "exit_fraction", "target_intent_id"}
SUPPORTED_PACKET_SCHEMAS = {
    "glitch.direct.decision_packet.v1",
    "glitch.direct.decision_packet.v2",
}


def core_model(root: Path | None = None) -> str:
    return hermes_model_version_label(
        root or profile_root(),
        model_env="GLITCH_TOPSTEP_CORE_MODEL",
        fallback="gpt-5.6-luna",
    )


def core_provider(root: Path | None = None) -> str:
    if use_hermes_model_routing():
        return read_model_config(root or profile_root())[1]
    return os.environ.get("GLITCH_TOPSTEP_CORE_PROVIDER", "openai-codex").strip() or "openai-codex"



def packet_max_age_seconds() -> int:
    try:
        return max(1, int(os.environ.get("GLITCH_TOPSTEP_PACKET_MAX_AGE_SECONDS", "90")))
    except ValueError:
        return 90


def frame_retention() -> int:
    try:
        return max(decision_frame_count(), int(os.environ.get("GLITCH_TOPSTEP_FRAME_RETENTION", "180")))
    except ValueError:
        return max(decision_frame_count(), 180)


def decision_frame_count() -> int:
    try:
        return max(1, int(os.environ.get("GLITCH_TOPSTEP_DECISION_FRAME_COUNT", "5")))
    except ValueError:
        return 5


def adaptive_decision_frame_count(packet: dict[str, Any]) -> int:
    max_frames = decision_frame_count()
    if positioned(packet):
        return max_frames
    try:
        flat_frames = max(
            1,
            int(os.environ.get("GLITCH_TOPSTEP_FLAT_FRAME_COUNT", "4")),
        )
    except ValueError:
        flat_frames = 4
    return min(max_frames, flat_frames)


def flat_decision_interval_minutes() -> int:
    """Return scheduling cadence only; never infer trade eligibility from it."""
    try:
        return max(
            1,
            min(
                60,
                int(os.environ.get("GLITCH_TOPSTEP_FLAT_DECISION_INTERVAL_MINUTES", "1")),
            ),
        )
    except ValueError:
        return 1


def packet_is_current(
    packet: dict[str, Any],
    now: datetime | None = None,
) -> bool:
    current = now or datetime.now(timezone.utc)
    try:
        created = parse_utc(packet["created_utc"])
        expires = parse_utc(packet["expires_utc"]) if packet.get("expires_utc") else None
    except (KeyError, TypeError, ValueError):
        return False

    age_seconds = (current - created).total_seconds()
    if not -5 <= age_seconds <= packet_max_age_seconds():
        return False
    return expires is None or current < expires


def positioned(packet: dict[str, Any]) -> bool:
    account = packet.get("account")
    if not isinstance(account, dict):
        return False
    return int(account.get("instrument_open_contracts") or 0) != 0


def packet_minute(packet: dict[str, Any]) -> int:
    return parse_utc(packet["created_utc"]).minute


def should_invoke(
    packet: dict[str, Any],
    directive: dict[str, Any] | None = None,
    state: Path | None = None,
) -> bool:
    if state is None:
        if directive is not None or positioned(packet):
            return True
        return packet_minute(packet) % flat_decision_interval_minutes() == 0
    return (
        invocation_reason(
            packet,
            state,
            directive,
            flat_decision_interval_minutes=flat_decision_interval_minutes(),
        )
        is not None
    )


def skip_unchanged_evidence_enabled() -> bool:
    return os.environ.get(
        "GLITCH_TOPSTEP_SKIP_UNCHANGED_EVIDENCE",
        "false",
    ).strip().lower() in {"1", "true", "yes"}


def evidence_fingerprint(packet: dict[str, Any]) -> str:
    """Stable hash of decision-relevant gateway evidence (not packet lease noise)."""
    account = packet.get("account") if isinstance(packet.get("account"), dict) else {}
    market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
    execution = (
        packet.get("execution") if isinstance(packet.get("execution"), dict) else {}
    )
    data_quality = (
        packet.get("data_quality")
        if isinstance(packet.get("data_quality"), dict)
        else {}
    )

    order_flow_wrap = (
        packet.get("order_flow") if isinstance(packet.get("order_flow"), dict) else {}
    )
    order_flow = (
        order_flow_wrap.get("observation")
        if isinstance(order_flow_wrap.get("observation"), dict)
        else {}
    )

    market_obs_wrap = (
        packet.get("market_observation")
        if isinstance(packet.get("market_observation"), dict)
        else {}
    )
    market_obs = (
        market_obs_wrap.get("observation")
        if isinstance(market_obs_wrap.get("observation"), dict)
        else {}
    )

    trade_count_60s = None
    for window in order_flow.get("windows") or []:
        if isinstance(window, dict) and window.get("window_seconds") == 60:
            trade_count_60s = window.get("trade_count")
            break

    bar_1m_close = None
    bar_1m_utc = None
    for timeframe in market_obs.get("timeframes") or []:
        if not isinstance(timeframe, dict) or timeframe.get("timeframe_minutes") != 1:
            continue
        features = timeframe.get("features")
        if isinstance(features, dict):
            bar_1m_close = features.get("latest_close")
        bar_1m_utc = timeframe.get("latest_bar_utc")
        break

    payload = {
        "instrument_open_contracts": account.get("instrument_open_contracts"),
        "working_orders": account.get("working_orders"),
        "conservative_equity": account.get("conservative_equity"),
        "last": market.get("last"),
        "bid": market.get("bid"),
        "ask": market.get("ask"),
        "gateway_mode": execution.get("gateway_mode"),
        "new_exposure": execution.get("new_exposure_technically_supported"),
        "state_complete": data_quality.get("state_complete"),
        "issues": sorted(data_quality.get("issues") or []),
        "order_flow_through": order_flow.get("through_sequence"),
        "order_flow_trade_count_60s": trade_count_60s,
        "market_obs_generated_utc": market_obs.get("generated_utc"),
        "bar_1m_close": bar_1m_close,
        "bar_1m_utc": bar_1m_utc,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def read_last_evidence_fingerprint(root: Path) -> str | None:
    value = read_optional_json(root / "last-evidence.json")
    if (
        isinstance(value, dict)
        and value.get("schema_version") == "glitch.topstep.last_evidence.v1"
        and isinstance(value.get("fingerprint"), str)
    ):
        return value["fingerprint"]
    return None


def write_last_evidence_fingerprint(
    root: Path,
    packet: dict[str, Any],
    fingerprint: str,
) -> None:
    write_json_atomic(
        root / "last-evidence.json",
        {
            "schema_version": "glitch.topstep.last_evidence.v1",
            "recorded_utc": utc_now(),
            "packet_id": packet.get("packet_id"),
            "fingerprint": fingerprint,
        },
    )


def should_skip_unchanged_evidence(
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
    root: Path,
) -> bool:
    if not skip_unchanged_evidence_enabled():
        return False
    if directive is not None or positioned(packet):
        return False
    if should_retry_after_failure(root, str(packet.get("packet_id") or "")):
        return False
    fingerprint = evidence_fingerprint(packet)
    return fingerprint == read_last_evidence_fingerprint(root)


def should_retry_after_failure(root: Path, packet_id: str) -> bool:
    attempt = latest_prior_attempt(root, packet_id)
    if attempt is None:
        return False
    return attempt.get("status") in RETRYABLE_ATTEMPT_STATUSES


def capture_frame(packet: dict[str, Any], root: Path) -> Path:
    created = parse_utc(packet["created_utc"])
    minute_id = created.strftime("%Y%m%dT%H%MZ")
    path = root / "minute-frames" / f"{minute_id}.json"
    write_json_atomic(
        path,
        {
            "schema_version": "glitch.topstep.minute_frame.v2",
            "minute_id": minute_id,
            "captured_utc": utc_now(),
            "packet": packet,
        },
    )
    prune_files((root / "minute-frames").glob("*.json"), frame_retention())
    return path


def recent_frames(root: Path, limit: int | None = None) -> list[dict[str, Any]]:
    if limit is None:
        limit = decision_frame_count()
    values: list[dict[str, Any]] = []
    for path in sorted((root / "minute-frames").glob("*.json"))[-limit:]:
        value = read_optional_json(path)
        if value:
            values.append(value)
    return values


def exclude_current_cycle_frame(
    packet: dict[str, Any],
    frames: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    current_id = str(packet.get("packet_id") or "")
    current_minute = parse_utc(packet["created_utc"]).strftime("%Y%m%dT%H%MZ")
    filtered: list[dict[str, Any]] = []
    for frame in frames:
        frame_packet = frame.get("packet")
        if isinstance(frame_packet, dict):
            if str(frame_packet.get("packet_id") or "") == current_id:
                continue
        if str(frame.get("minute_id") or "") == current_minute:
            continue
        filtered.append(frame)
    return filtered


def cycle_recent_frames(
    root: Path,
    packet: dict[str, Any],
) -> list[dict[str, Any]]:
    limit = adaptive_decision_frame_count(packet)
    # ponytail: fetch one extra because capture_frame writes the current minute first
    return exclude_current_cycle_frame(packet, recent_frames(root, limit + 1))[:limit]


def packet_for_model(packet: dict[str, Any]) -> dict[str, Any]:
    return build_model_packet(
        packet,
        profile_name=PROFILE_NAME,
        core_model=core_model(),
        prompt_version=PROMPT_VERSION,
    )


def cycle_packet_for_model(packet: dict[str, Any]) -> dict[str, Any]:
    return packet_for_cycle(
        packet,
        profile_name=PROFILE_NAME,
        core_model=core_model(),
        prompt_version=PROMPT_VERSION,
    )


def read_directive(root: Path) -> dict[str, Any] | None:
    path = root / "operator-directive.json"
    value = read_optional_json(path)
    if (
        not value
        or value.get("schema_version") != "glitch.topstep.operator_directive.v1"
        or value.get("status") != "pending"
    ):
        return None

    try:
        expiry = parse_utc(value.get("expires_utc"))
    except (TypeError, ValueError):
        return None

    if datetime.now(timezone.utc) >= expiry:
        expired = {
            **value,
            "status": "expired",
            "expired_utc": utc_now(),
        }
        write_json_atomic(path, expired)
        return None

    return value


def consume_directive(
    root: Path,
    directive: dict[str, Any],
    packet_id: str,
) -> None:
    path = root / "operator-directive.json"
    current = read_optional_json(path)
    if (
        not current
        or current.get("directive_id") != directive.get("directive_id")
        or current.get("status") != "pending"
    ):
        return

    current.update(
        status="consumed",
        consumed_utc=utc_now(),
        packet_id=packet_id,
    )
    write_json_atomic(path, current)


def recent_context(root: Path) -> dict[str, Any]:
    supervisor = root / "supervisor"
    context = learning_context(supervisor)
    tail_limit = 4
    context.update(
        compact_cycle_ledger_context(
            decisions=tail_jsonl(root / "decisions.jsonl", tail_limit),
            receipts=tail_jsonl(root / "receipts.jsonl", tail_limit),
            outcomes=tail_jsonl(root / "outcomes.jsonl", tail_limit),
        )
    )
    return context


CYCLE_OPERATOR_INSTRUCTION = (
    "Apply the Glitch Topstep SOUL and loaded skills to CURRENT_CYCLE. "
    "You are the trading operator, not a suggestion engine. "
    "Rebuild LONG, SHORT, and flat hypotheses from the current packet and frame path each cycle; "
    "do not repeat prior ledger narrative or default to the previous action. "
    "While flat evaluate ENTER_LONG, ENTER_SHORT, and NOTHING symmetrically; never choose HOLD while flat. "
    "When positioned evaluate HOLD, MOVE_STOP, MOVE_TP, partial or full EXIT, and scale-in "
    "only when execution.supported_actions includes the matching ENTER_* action; never choose NOTHING while positioned. "
    "Choose only from execution.supported_actions. "
    "Multi-tranche protection requires target_intent_id on MOVE_STOP, MOVE_TP, and targeted partial EXIT. "
    "decision_packet is the full current gateway snapshot; recent_frames are compact minute continuity "
    "snapshots (semantic fields only, no templates or lease metadata). "
    "cycle_evidence_delta summarizes material changes since the immediately prior frame when present. "
    "data_quality, capacity, policy, and daily_economics mirrors are evidence to reason about, "
    "not automatic cognitive vetoes. Do not invent missing facts. "
    "When market_universe has multiple candidates, complete CURRENT_AUCTION, BULLISH_PATH, "
    "BEARISH_PATH, NEXT_TRANSITION, and frozen trigger status for every candidate before ranking. "
    "Encode that exact complete ledger in decision_audit.decisive_evidence using the supplied "
    "INSTRUMENT_COMPARISON_V1 template. MCL is Micro Crude Oil; MCLE is only ProjectX identity. "
    "When market.session_levels_reliable is false, do not treat session_high/low as structural edges; "
    "use order_flow windows and observation range features instead. "
    "When order_flow depth.available is false, do not infer book imbalance. "
    "Treat order flow depth as unavailable whenever its bid/ask geometry is internally "
    "inconsistent, including best_bid >= best_ask, spread_ticks <= 0, or material disagreement "
    "with the current market bid/ask, even if depth.available is still true. "
    "ALTERED PARTICIPATION GUIDANCE: do not require all timeframes, a closed candle, "
    "a retest, or sustained multi-window flow as universal entry gates. Use 60m for context, "
    "5m for structure, and 1m for timing; mixed evidence lowers confidence but does not by itself "
    "force NOTHING when a locally falsifiable, protected, bounded thesis exists. Consider continuation, "
    "pullback, breakout, failed breakout, mean reversion, and transition without imposing a trade quota. "
    "Before flat NOTHING, state long and short triggers, invalidations, and plausible paths in decision_audit. "
    "At range edges, sweeps, or failed continuation, compare continuation vs reversion; neither is automatic. "
    "Do not manufacture mid-range trades in CHOP; prefer smallest supported quantity when asymmetry is bounded. "
    "The gateway independently verifies ProjectX truth, hard capacity, geometry, loss-floor survival, "
    "packet issuance, and order transport; rejection is an attributable episode, not pre-emption. "
    "Return exactly one strict glitch.intent.v3 JSON object with no prose. "
    "Preserve account, instrument, snapshot_hash, and operator_profile exactly. "
    "Replace template placeholders action and confidence with real values; never emit placeholder strings. "
    "decision_audit must include bull_case, bear_case, flat_case, aggressive_case, conservative_case, "
    "decisive_evidence, disconfirming_evidence, change_condition, and final_choice (matching action). "
    "decisive_evidence must begin with prior_hypothesis=<CONFIRMED|INVALIDATED|PARTIALLY_CONFIRMED|UNCHANGED> "
    "versus the immediately prior frame when recent_frames is non-empty, then state material deltas since that frame. "
    "change_condition is an advisory re-evaluation hypothesis, not a rigid execution gate; "
    "rewrite it when cycle_evidence_delta or prior ledger repetition guidance indicates stale wording. "
    "Action contract: ENTER_LONG and ENTER_SHORT require positive integer quantity, order_type MARKET, "
    "absolute stop_loss and take_profit_1, plus a bounded entry_price_min/entry_price_max that remains valid only for this packet, contract, scope generation, and expiry; omit wake_triggers and management fields. "
    "NOTHING and HOLD omit quantity, order_type, stop_loss, take_profit_1, amendment fields, and exit sizing. "
    "wake_triggers is optional local scheduling metadata only: NOTHING while flat; HOLD while positioned. "
    "Omit wake_triggers unless you want an early wake "
    '(flat NOTHING example: [{type:"PRICE_CROSS", direction:"ABOVE"|"BELOW", price:number}] '
    "or {type:\"SESSION_PHASE\", phase:\"asia\"|\"europe\"|\"regular\"|\"maintenance\"}); "
    "never treat wake_triggers as a gateway field. "
    "MOVE_STOP needs new_stop_price; MOVE_TP needs new_take_profit or take_profit_1; "
    "for a full EXIT that closes the entire active position, omit both quantity and exit_fraction; "
    "request partial EXIT only when the packet explicitly advertises proven partial-reduction continuity; otherwise use full EXIT or HOLD. "
    "Compare current evidence to prior change_condition observations; current-cycle setup may justify entry "
    "even when a prior advisory trigger was not satisfied, but choose the action the evidence supports now. "
    "Use recent_glitch_ledger as the primary continuity source. "
    "If an external memory read tool is available and materially useful, use it at most once; "
    "never call memory write tools during trading cycles. "
    "When positioned, read protection.protection_status from the packet: confirmed allows full "
    "management; pending favors HOLD while venue brackets land (EXIT if protection fails to confirm); "
    "failed or unknown require explicit failed-protection reasoning and forbid MOVE_STOP/MOVE_TP until "
    "protection is confirmed again. "
    "CURRENT_CYCLE="
)


def build_prompt(
    packet: dict[str, Any],
    frames: list[dict[str, Any]],
    context: dict[str, Any],
    directive: dict[str, Any] | None,
    trade_state: dict[str, Any] | None = None,
) -> str:
    model_packet = cycle_packet_for_model(packet)
    template = copy.deepcopy(packet.get("required_output_template") or {})
    template.pop("wake_triggers", None)
    template.pop("wake_trigger", None)
    template.update(
        schema_version="glitch.intent.v3",
        intent_id=str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"glitch-topstep:{packet['packet_id']}")
        ),
        created_utc=utc_now(),
        instrument=packet["instrument"],
        account=packet["account"]["name"],
        operator_profile=PROFILE_NAME,
        action=ACTION_PLACEHOLDER,
        confidence=CONFIDENCE_PLACEHOLDER,
        snapshot_hash=packet["market"]["snapshot_hash"],
        packet_id=packet["packet_id"],
        contract_id=packet["contract"]["id"],
        scope_hash=packet.get("decision_scope", {}).get("scope_hash"),
        scope_generation=packet.get("decision_scope", {}).get("generation"),
        expires_utc=packet.get("expires_utc"),
        entry_price_min="<BOUNDED_ENTRY_MIN>",
        entry_price_max="<BOUNDED_ENTRY_MAX>",
        model_version=core_model(),
        prompt_version=PROMPT_VERSION,
        reason="Replace with a compact evidence-based reason.",
    )

    audit = template.setdefault("decision_audit", {})
    for field in AUDIT_FIELDS:
        if field == "decisive_evidence":
            audit[field] = (
                "Replace. Begin with prior_hypothesis=<CONFIRMED|INVALIDATED|"
                "PARTIALLY_CONFIRMED|UNCHANGED> then material deltas since prior frame."
            )
        elif field == "final_choice":
            audit[field] = ACTION_PLACEHOLDER
        else:
            audit[field] = "Replace"
    if len(packet.get("market_universe", {}).get("candidates", [])) > 1:
        audit["decisive_evidence"] = comparison_template(packet)

    protection_guidance = protection_status_management_guidance(
        packet_protection_status(packet),
    )
    prior_frame = frames[-1] if frames else None
    evidence_delta = compute_cycle_evidence_delta(packet, prior_frame)
    repetition_warning = repeated_change_condition_warning(
        context.get("decisions") if isinstance(context.get("decisions"), list) else [],
    )
    envelope = {
        "decision_packet": model_packet,
        "recent_frames": [frame_for_model(frame) for frame in frames],
        "continuity_gap": detect_continuity_gap(frames),
        "recent_glitch_ledger": context,
        "active_trade_state": trade_state,
        "operator_directive": directive,
        "required_output_template": template,
        "cycle_evidence_delta": evidence_delta,
        "ledger_repetition_guidance": repetition_warning,
        "protection_management": protection_guidance,
        "operator_authority": {
            "principle": (
                "Hermes chooses the trade; Glitch verifies factual execution safety."
            ),
            "data_quality_is_evidence": True,
            "capacity_is_evidence": True,
            "policy_is_evidence": True,
            "gateway_may_reject_only_factual_execution_invalidity": True,
        },
    }

    return apply_cognitive_overlay(
        CYCLE_OPERATOR_INSTRUCTION
        + json.dumps(envelope, separators=(",", ":"), ensure_ascii=False),
        context.get("active_cognitive_overlay"),
    )


def invoke_hermes(
    profile: str,
    prompt: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    executable = shutil.which("hermes")
    if not executable:
        raise RuntimeError("hermes_executable_not_found")

    python_executable = Path(executable).with_name(
        "python.exe" if sys.platform == "win32" else "python"
    )
    if not python_executable.is_file():
        python_executable = Path(sys.executable)

    root = profile_root(profile)
    cli_args = [
        "chat",
        "-Q",
        "--source",
        TRADING_SOURCE,
        *hermes_chat_model_cli_args(
            root,
            model_env="GLITCH_TOPSTEP_CORE_MODEL",
            provider_env="GLITCH_TOPSTEP_CORE_PROVIDER",
        ),
        "--max-turns",
        "4",
        "--skills",
        (
            "topstep-observe-market,topstep-assess-risk,topstep-form-thesis,"
            "topstep-build-intent"
        ),
        "--toolsets",
        "memory",
    ]
    wrapper = (
        "import os,sys;from pathlib import Path;"
        "os.environ['HERMES_HOME']=str(Path.home()/'AppData'/'Local'/'hermes'/"
        "'profiles'/"
        + repr(profile)
        + ");from hermes_cli.main import main;prompt=sys.stdin.read();"
        "sys.argv=[sys.argv[0]]+"
        + repr(cli_args)
        + "+['-q',prompt];main()"
    )
    completed = subprocess.run(
        [str(python_executable), "-c", wrapper],
        input=prompt,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
        check=False,
        creationflags=(
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            if sys.platform == "win32"
            else 0
        ),
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"hermes_failed:{completed.returncode}:{completed.stderr.strip()[:400]}"
        )
    return extract_single_json_object(
        completed.stdout,
        schema="glitch.intent.v3",
    )


def active_tranches(packet: dict[str, Any]) -> list[dict[str, Any]]:
    protection = packet.get("protection")
    if not isinstance(protection, dict):
        return []
    tranches = protection.get("tranches")
    if not isinstance(tranches, list):
        return []
    return [
        tranche
        for tranche in tranches
        if isinstance(tranche, dict) and int(tranche.get("remaining_qty") or 0) > 0
    ]


def allowed_intent_fields(action: str) -> set[str]:
    fields = set(CORE_FIELDS)
    if action in {"ENTER_LONG", "ENTER_SHORT"}:
        fields |= ENTRY_FIELDS
    elif action == "MOVE_STOP":
        fields |= {"new_stop_price", "target_intent_id"}
    elif action == "MOVE_TP":
        fields |= {"new_take_profit", "take_profit_1", "target_intent_id"}
    elif action == "EXIT":
        fields |= EXIT_FIELDS
    return fields


def validate_target_intent_id(
    intent: dict[str, Any],
    packet: dict[str, Any],
    *,
    required: bool,
) -> None:
    target = intent.get("target_intent_id")
    if target is None:
        if required:
            raise ValueError("target_intent_id_required")
        return
    if not isinstance(target, str) or not TARGET_INTENT_ID_RE.match(target):
        raise ValueError("target_intent_id_invalid")
    active_ids = {
        str(tranche.get("intent_id"))
        for tranche in active_tranches(packet)
        if tranche.get("intent_id")
    }
    if active_ids and target not in active_ids:
        raise ValueError("target_intent_id_not_active")


def _resolve_action_placeholder(action: Any) -> Any:
    if not isinstance(action, str):
        return action
    normalized = action.strip()
    if normalized in {ACTION_PLACEHOLDER, "Replace"}:
        raise ValueError("action_placeholder_not_replaced")
    if "<" in normalized or ">" in normalized:
        raise ValueError("action_placeholder_not_replaced")
    return normalized


def _resolve_confidence_placeholder(confidence: Any) -> Any:
    if isinstance(confidence, str):
        normalized = confidence.strip()
        if normalized in {CONFIDENCE_PLACEHOLDER, "Replace"}:
            raise ValueError("confidence_placeholder_not_replaced")
        if "<" in normalized or ">" in normalized:
            raise ValueError("confidence_placeholder_not_replaced")
    return confidence


def normalize_intent(
    value: dict[str, Any],
    packet: dict[str, Any],
) -> dict[str, Any]:
    intent = copy.deepcopy(value)
    if "wake_triggers" not in intent and "wake_trigger" in intent:
        legacy = intent.pop("wake_trigger")
        intent["wake_triggers"] = [] if legacy is None else [legacy]
    if "wake_triggers" not in intent:
        intent["wake_triggers"] = []
    action = "NOTHING" if intent.get("action") == "NO_ACTION" else intent.get("action")
    action = _resolve_action_placeholder(action)
    confidence = _resolve_confidence_placeholder(intent.get("confidence"))
    intent.update(
        schema_version="glitch.intent.v3",
        intent_id=str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"glitch-topstep:{packet['packet_id']}")
        ),
        created_utc=utc_now(),
        instrument=packet["instrument"],
        account=packet["account"]["name"],
        operator_profile=PROFILE_NAME,
        snapshot_hash=packet["market"]["snapshot_hash"],
        model_version=core_model(),
        prompt_version=PROMPT_VERSION,
        action=action,
        confidence=confidence,
        packet_id=packet.get("packet_id"),
        contract_id=packet.get("contract", {}).get("id"),
        scope_hash=packet.get("decision_scope", {}).get("scope_hash"),
        scope_generation=packet.get("decision_scope", {}).get("generation"),
        expires_utc=packet.get("expires_utc"),
    )
    if action not in {"ENTER_LONG", "ENTER_SHORT"}:
        for field in ENTRY_FIELDS:
            intent.pop(field, None)
    else:
        market = packet.get("market") if isinstance(packet.get("market"), dict) else {}
        bid = _number(market.get("bid", market.get("last")), "entry_price_min")
        ask = _number(market.get("ask", market.get("last")), "entry_price_max")
        intent.setdefault("entry_price_min", min(bid, ask))
        intent.setdefault("entry_price_max", max(bid, ask))
    if action != "MOVE_STOP":
        intent.pop("new_stop_price", None)
    if action != "MOVE_TP":
        intent.pop("new_take_profit", None)
        if action not in {"ENTER_LONG", "ENTER_SHORT"}:
            intent.pop("take_profit_1", None)
    if action not in {"EXIT", "MOVE_STOP", "MOVE_TP"}:
        intent.pop("target_intent_id", None)
    if action not in {"ENTER_LONG", "ENTER_SHORT", "EXIT"}:
        intent.pop("quantity", None)
    if action != "EXIT":
        intent.pop("exit_fraction", None)
    intent["reason"] = truncate_gateway_string(
        str(intent.get("reason") or ""),
        GATEWAY_REASON_MAX_LENGTH,
    )
    audit = intent.get("decision_audit")
    if isinstance(audit, dict):
        for field in AUDIT_FIELDS:
            if isinstance(audit.get(field), str):
                audit[field] = truncate_gateway_string(
                    audit[field],
                    GATEWAY_AUDIT_FIELD_MAX_LENGTH,
                )
    return intent


def _number(value: Any, field: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise ValueError(f"invalid_number:{field}")
    return float(value)


def validate_intent(
    intent: dict[str, Any],
    packet: dict[str, Any],
    directive: dict[str, Any] | None = None,
) -> None:
    action = intent.get("action")
    if action not in ALLOWED_ACTIONS:
        raise ValueError("unsupported_action")

    allowed_fields = allowed_intent_fields(action)
    unknown = set(intent).difference(allowed_fields | {"wake_triggers"})
    required_fields = CORE_FIELDS if intent.get("schema_version") == "glitch.intent.v3" else (CORE_FIELDS - DECISION_IDENTITY_FIELDS)
    missing = required_fields.difference(intent)
    if unknown:
        raise ValueError("unknown_fields:" + ",".join(sorted(unknown)))
    if missing:
        raise ValueError("missing_fields:" + ",".join(sorted(missing)))

    supported = packet.get("execution", {}).get("supported_actions")
    if (
        isinstance(supported, list)
        and action in {"MOVE_STOP", "MOVE_TP"}
        and action not in supported
    ):
        raise ValueError("action_not_supported_by_gateway")

    if intent.get("schema_version") not in {"glitch.intent.v2", "glitch.intent.v3"}:
        raise ValueError("schema_version_invalid")
    if intent.get("instrument") != packet.get("instrument"):
        raise ValueError("instrument_mismatch")
    if intent.get("account") != packet.get("account", {}).get("name"):
        raise ValueError("account_mismatch")
    if intent.get("operator_profile") != PROFILE_NAME:
        raise ValueError("operator_profile_mismatch")
    if intent.get("snapshot_hash") != packet.get("market", {}).get("snapshot_hash"):
        raise ValueError("snapshot_hash_mismatch")
    if not isinstance(intent.get("reason"), str) or not intent["reason"].strip():
        raise ValueError("reason_invalid")

    confidence = _number(intent.get("confidence"), "confidence")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence_out_of_range")

    audit = intent.get("decision_audit")
    if not isinstance(audit, dict) or set(audit) != AUDIT_FIELDS:
        raise ValueError("decision_audit_invalid")
    if any(
        not isinstance(audit[field], str) or not audit[field].strip()
        for field in AUDIT_FIELDS
    ):
        raise ValueError("decision_audit_value_invalid")
    if audit.get("final_choice") != action:
        raise ValueError("decision_audit_choice_mismatch")
    for field in ("final_choice",):
        value = audit.get(field)
        if isinstance(value, str) and value.strip() in {ACTION_PLACEHOLDER, "Replace"}:
            raise ValueError("decision_audit_placeholder_not_replaced")
    decisive = audit.get("decisive_evidence")
    if isinstance(decisive, str) and decisive.strip().startswith("Replace"):
        raise ValueError("decision_audit_placeholder_not_replaced")
    comparison = validate_comparison_ledger(decisive, packet)
    if (
        comparison is not None
        and action in {"ENTER_LONG", "ENTER_SHORT"}
        and str(comparison.get("selected_instrument") or "").upper()
        != str(packet.get("instrument") or "").upper()
    ):
        raise ValueError("selected_instrument_not_executable_in_current_scope")

    wake_triggers = intent.get("wake_triggers")
    if wake_triggers is not None:
        validate_wake_triggers(wake_triggers)
    if action in {"ENTER_LONG", "ENTER_SHORT", "EXIT", "MOVE_STOP", "MOVE_TP"}:
        if wake_triggers:
            raise ValueError("wake_triggers_not_allowed_for_action")

    if action in {"ENTER_LONG", "ENTER_SHORT"}:
        quantity = intent.get("quantity")
        if (
            not isinstance(quantity, int)
            or isinstance(quantity, bool)
            or quantity < 1
        ):
            raise ValueError("entry_quantity_invalid")
        if intent.get("order_type") != "MARKET":
            raise ValueError("entry_order_type_invalid")

        if intent.get("schema_version") == "glitch.intent.v3":
            decision_scope = packet.get("decision_scope") if isinstance(packet.get("decision_scope"), dict) else {}
            if intent.get("packet_id") != packet.get("packet_id"):
                raise ValueError("packet_id_mismatch")
            if intent.get("contract_id") != packet.get("contract", {}).get("id"):
                raise ValueError("contract_id_mismatch")
            if intent.get("scope_hash") != decision_scope.get("scope_hash"):
                raise ValueError("scope_hash_mismatch")
            if intent.get("scope_generation") != decision_scope.get("generation"):
                raise ValueError("scope_generation_mismatch")
            if intent.get("expires_utc") != packet.get("expires_utc"):
                raise ValueError("expires_utc_mismatch")
            range_min = _number(intent.get("entry_price_min"), "entry_price_min")
            range_max = _number(intent.get("entry_price_max"), "entry_price_max")
            if range_min <= 0 or range_min > range_max:
                raise ValueError("entry_price_range_invalid")

        stop = _number(intent.get("stop_loss"), "stop_loss")
        target = _number(intent.get("take_profit_1"), "take_profit_1")
        market = packet.get("market", {})
        reference = market.get("ask") if action == "ENTER_LONG" else market.get("bid")
        if not isinstance(reference, (int, float)) or reference <= 0:
            reference = market.get("last")
        reference = _number(reference, "reference_price")

        if action == "ENTER_LONG" and not stop < reference < target:
            raise ValueError("long_geometry_invalid")
        if action == "ENTER_SHORT" and not target < reference < stop:
            raise ValueError("short_geometry_invalid")
    elif action == "MOVE_STOP":
        if not protection_status_allows_amendment(packet_protection_status(packet)):
            raise ValueError("protection_status_not_confirmed")
        _number(intent.get("new_stop_price"), "new_stop_price")
        validate_target_intent_id(
            intent,
            packet,
            required=len(active_tranches(packet)) > 1,
        )
    elif action == "MOVE_TP":
        if not protection_status_allows_amendment(packet_protection_status(packet)):
            raise ValueError("protection_status_not_confirmed")
        target_price = intent.get("new_take_profit", intent.get("take_profit_1"))
        _number(target_price, "move_tp_target_price")
        validate_target_intent_id(
            intent,
            packet,
            required=len(active_tranches(packet)) > 1,
        )
    elif action == "EXIT":
        quantity = intent.get("quantity")
        exit_fraction = intent.get("exit_fraction")
        if quantity is not None:
            if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 1:
                raise ValueError("exit_quantity_invalid")
        if exit_fraction is not None:
            fraction = _number(exit_fraction, "exit_fraction")
            if not 0 < fraction <= 1:
                raise ValueError("exit_fraction_invalid")
        if quantity is not None and exit_fraction is not None:
            raise ValueError("exit_quantity_and_fraction_conflict")
        validate_target_intent_id(
            intent,
            packet,
            required=len(active_tranches(packet)) > 1 and (
                quantity is not None or exit_fraction is not None
            ),
        )
    elif any(field in intent for field in ENTRY_FIELDS):
        raise ValueError("non_entry_contains_entry_fields")
    elif any(field in intent for field in AMENDMENT_FIELDS | EXIT_FIELDS):
        raise ValueError("non_action_contains_management_fields")

    if directive and directive.get("directive_type") == "forced_entry":
        expected_action = (
            "ENTER_LONG" if directive.get("bias") == "long" else "ENTER_SHORT"
        )
        if action != expected_action:
            raise ValueError("forced_entry_not_honored")


def invoke_valid_intent(
    profile: str,
    prompt: str,
    packet: dict[str, Any],
    directive: dict[str, Any] | None,
    timeout_seconds: int,
) -> tuple[dict[str, Any], int]:
    current_prompt = prompt
    for repair_count in range(2):
        try:
            intent = normalize_intent(
                invoke_hermes(profile, current_prompt, timeout_seconds),
                packet,
            )
            validate_intent(intent, packet, directive)
            return intent, repair_count
        except ValueError as error:
            if repair_count:
                raise
            current_prompt += "\nSTRICT_OUTPUT_CORRECTION=" + json.dumps(
                {
                    "validation_error": str(error)[:240],
                    "instruction": (
                        "Regenerate the same current decision as one complete "
                        "strict glitch.intent.v3 object. Preserve current "
                        "identities and requested forced direction."
                    ),
                },
                separators=(",", ":"),
            )
    raise AssertionError("unreachable")


def prepare_intent_for_delivery(
    intent: dict[str, Any],
    directive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    packet_status, fresh_packet = request_json("/packet", token=local_token())
    if packet_status != 200:
        raise RuntimeError(f"gateway_packet_failed:{packet_status}")
    if (
        fresh_packet.get("schema_version") not in SUPPORTED_PACKET_SCHEMAS
        or not packet_is_current(fresh_packet)
    ):
        raise RuntimeError("gateway_packet_stale_before_delivery")
    if intent.get("schema_version") == "glitch.intent.v3":
        scanner_status, scanner = request_json("/scanner", token=local_token())
        if (
            scanner_status == 200
            and isinstance(scanner, dict)
            and scanner.get("schema_version") == "glitch.topstep.market_universe.v1"
        ):
            fresh_packet["market_universe"] = scanner

    aligned = copy.deepcopy(intent)
    action = str(aligned.get("action") or "")
    fresh_hash = fresh_packet.get("market", {}).get("snapshot_hash")
    same_packet = aligned.get("packet_id") == fresh_packet.get("packet_id")
    if aligned.get("schema_version") == "glitch.intent.v2":
        aligned["snapshot_hash"] = fresh_hash
        same_packet = True
    elif action in {"ENTER_LONG", "ENTER_SHORT"}:
        current_scope = (
            fresh_packet.get("decision_scope")
            if isinstance(fresh_packet.get("decision_scope"), dict)
            else {}
        )
        if (
            aligned.get("contract_id") != fresh_packet.get("contract", {}).get("id")
            or aligned.get("scope_hash") != current_scope.get("scope_hash")
            or aligned.get("scope_generation") != current_scope.get("generation")
        ):
            raise ValueError("entry_scope_superseded")
        market = fresh_packet.get("market") if isinstance(fresh_packet.get("market"), dict) else {}
        reference = market.get("ask") if action == "ENTER_LONG" else market.get("bid")
        if not isinstance(reference, (int, float)) or isinstance(reference, bool):
            reference = market.get("last")
        current = _number(reference, "delivery_reference_price")
        low = _number(aligned.get("entry_price_min"), "entry_price_min")
        high = _number(aligned.get("entry_price_max"), "entry_price_max")
        if current < low or current > high:
            raise ValueError("entry_range_superseded")
        if parse_utc(aligned.get("expires_utc")) < datetime.now(timezone.utc):
            raise ValueError("entry_intent_expired")
    elif not same_packet or aligned.get("snapshot_hash") != fresh_hash:
        raise ValueError("packet_superseded_before_delivery")
    aligned["reason"] = truncate_gateway_string(aligned["reason"], GATEWAY_REASON_MAX_LENGTH)
    audit = aligned.get("decision_audit")
    if isinstance(audit, dict):
        for field in AUDIT_FIELDS:
            if isinstance(audit.get(field), str):
                audit[field] = truncate_gateway_string(audit[field], GATEWAY_AUDIT_FIELD_MAX_LENGTH)
    if same_packet:
        validate_intent(aligned, fresh_packet, directive)
    # wake_triggers drives the local scheduler and is not part of glitch.intent.v3 on the gateway.
    # Validate the complete decision first, then project the already-valid wire payload.
    aligned.pop("wake_triggers", None)
    return aligned


def post_intent(intent: dict[str, Any]) -> dict[str, Any]:
    wire = copy.deepcopy(intent)
    wire.pop("wake_triggers", None)
    wire.pop("wake_trigger", None)
    try:
        status, body = request_json(
            "/intent",
            method="POST",
            body=wire,
            token=local_token(),
        )
        return {"http_status": status, "body": body}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"transport_error": str(error)}


def fetch_gateway_intent_receipt(intent_id: str) -> dict[str, Any] | None:
    if not intent_id:
        return None
    try:
        status, body = request_json(
            f"/intent/receipt?intent_id={urllib.parse.quote(intent_id, safe='')}",
            token=local_token(),
        )
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    if status == 200 and isinstance(body, dict):
        return body
    return None


def deliver_intent(
    state: Path,
    packet_id: str,
    intent: dict[str, Any],
    directive: dict[str, Any] | None,
) -> dict[str, Any]:
    return deliver_packet_intent(
        state,
        packet_id,
        intent,
        directive,
        post_intent,
        prepare_intent_for_delivery,
        fetch_gateway_intent_receipt,
    )


def resolve_wake_invocation_context(
    state: Path,
    packet: dict[str, Any],
    reason: str | None,
    pending_wake: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, str | None]:
    if pending_wake:
        from parity import clear_pending_wake_invocation as _clear_pending_wake_invocation

        _clear_pending_wake_invocation(state)
        return {
            "wake_reason": pending_wake.get("wake_reason"),
            "wake_trigger": pending_wake.get("wake_trigger"),
            "trigger_key": pending_wake.get("trigger_key"),
        }, "monitor"
    if reason == "condition_change":
        detail = evaluate_wake_triggers(state, packet)
        if detail:
            return detail, "cycle"
    return None, None


def run_once(args: argparse.Namespace, root: Path) -> int:
    token = local_token()
    health_status, health = request_json("/health")
    if health_status != 200 or health.get("status") not in {"ok", "degraded"}:
        raise RuntimeError("gateway_health_unavailable")
    verify_gateway_compatibility(health)

    state = state_root(root)
    sync_gateway_outcomes(state)

    packet_status, packet = request_json("/packet", token=token)
    if packet_status != 200:
        raise RuntimeError(f"gateway_packet_failed:{packet_status}")
    capabilities = health.get("compatibility", {}).get("capabilities", [])
    if isinstance(capabilities, list) and "multi_instrument_observation_v1" in capabilities:
        scanner_status, scanner = request_json("/scanner", token=token)
        if scanner_status != 200 or not isinstance(scanner, dict):
            raise RuntimeError(f"gateway_scanner_failed:{scanner_status}")
        if scanner.get("schema_version") == "glitch.topstep.market_universe.v1":
            packet["market_universe"] = scanner
    packet = wait_for_packet_rollover(
        packet,
        float(getattr(args, "packet_rollover_wait_seconds", 0) or 0),
        token=token,
    )
    if (
        packet.get("schema_version") not in SUPPORTED_PACKET_SCHEMAS
        or not packet_is_current(packet)
    ):
        return 0

    state = state_root(root)
    prune_delivered_outboxes(state)
    capture_frame(packet, state)
    directive = read_directive(state)

    pending = pending_outbox(state)
    if pending is not None:
        pending_id, pending_path = pending
        pending_intent = read_json(pending_path)
        if discard_stale_outbox_intent(
            state,
            pending_path,
            pending_id,
            pending_intent,
            token=token,
        ):
            return run_once(args, root)
        pending_packet = packet_for_outbox_id(state, pending_id)
        if pending_packet is None:
            raise ValueError("pending_outbox_packet_not_found")
        validate_intent(pending_intent, pending_packet, None)
        if args.dry_run:
            print(
                json.dumps(
                    {"packet_id": pending_id, "submitted": False, "reused_outbox": True},
                    separators=(",", ":"),
                )
            )
            return 0
        try:
            result = deliver_intent(state, pending_id, pending_intent, None)
        except ValueError as error:
            if discard_unexecutable_entry_outbox(
                state, pending_path, pending_id, pending_intent, error
            ):
                return run_once(args, root)
            raise
        classification = classify_delivery_result(result)
        if classification != "transport_uncertain":
            receipt = {
                "schema_version": "glitch.topstep.delivery_receipt.v2",
                "recorded_utc": utc_now(),
                "packet_id": pending_id,
                "intent_id": pending_intent["intent_id"],
                "result": result,
            }
            write_json_atomic(state / "receipts" / f"{pending_id}.json", receipt)
            append_jsonl(state / "receipts.jsonl", receipt)
            pending_path.unlink(missing_ok=True)
            clear_delivery_wire(state, pending_id)
        mark_attempt_from_receipt(state, pending_id, result)
        print(json.dumps({"packet_id": pending_id, "result": result}, separators=(",", ":")))
        return 0 if classification == "successful" else 1

    reason = invocation_reason(
        packet,
        state,
        directive,
        flat_decision_interval_minutes=flat_decision_interval_minutes(),
    )
    pending_wake = read_pending_wake_invocation(state)
    if reason is None and pending_wake:
        reason = "condition_change"
    wake_detail, wake_source = resolve_wake_invocation_context(
        state,
        packet,
        reason,
        pending_wake,
    )
    if reason is None:
        if flat_outside_session_window(packet, directive):
            if packet_minute(packet) % flat_decision_interval_minutes() == 0:
                append_jsonl(
                    state / "events.jsonl",
                    {
                        "schema_version": "glitch.topstep.cycle_event.v2",
                        "event": "llm_skipped",
                        "recorded_utc": utc_now(),
                        "packet_id": packet.get("packet_id"),
                        "invocation_reason": None,
                        "reason": "session_closed",
                        "session": packet.get("session"),
                    },
                )
        return 0

    maintenance = session_maintenance_skip_details(packet, directive)
    if maintenance:
        append_jsonl(
            state / "events.jsonl",
            {
                "schema_version": "glitch.topstep.cycle_event.v2",
                "event": "llm_skipped",
                "recorded_utc": utc_now(),
                "packet_id": packet.get("packet_id"),
                **cycle_wake_fields(reason, wake_detail),
                **maintenance,
            },
        )
        return 0

    quiescent = market_quiescent_skip_details(packet, directive)
    if quiescent and reason != "condition_change":
        append_jsonl(
            state / "events.jsonl",
            {
                "schema_version": "glitch.topstep.cycle_event.v2",
                "event": "llm_skipped",
                "recorded_utc": utc_now(),
                "packet_id": packet.get("packet_id"),
                **cycle_wake_fields(reason, wake_detail),
                **quiescent,
            },
        )
        return 0

    if wake_detail and wake_source == "cycle":
        trigger = wake_detail.get("wake_trigger")
        if isinstance(trigger, dict):
            record_wake_trigger_fire(state, trigger, packet, source="cycle")

    if should_skip_unchanged_evidence(packet, directive, state):
        append_jsonl(
            state / "events.jsonl",
            {
                "schema_version": "glitch.topstep.cycle_event.v2",
                "event": "cognition_skipped",
                "recorded_utc": utc_now(),
                "packet_id": packet.get("packet_id"),
                **cycle_wake_fields(reason, wake_detail),
                "reason": "unchanged_evidence",
                "fingerprint": evidence_fingerprint(packet),
            },
        )
        return 0

    frames = cycle_recent_frames(state, packet)

    packet_id = str(packet.get("packet_id") or "")
    if not packet_id:
        raise ValueError("packet_id_missing")

    receipt_path = state / "receipts" / f"{packet_id}.json"
    outbox_path = state / "outbox" / f"{packet_id}.json"
    attempt_path = state / "attempts" / f"{packet_id}.json"
    if receipt_path.is_file():
        receipt = read_json(receipt_path)
        if classify_delivery_result(receipt.get("result", {})) != "transport_uncertain":
            mark_attempt_from_receipt(state, packet_id, receipt.get("result", {}))
            return 0

    trade_state = active_trade_state(state, packet)
    context = recent_context(state)

    if outbox_path.is_file():
        intent = read_json(outbox_path)
        validate_intent(intent, packet, None)
    else:
        if attempt_path.is_file():
            return 0

        write_json_atomic(
            attempt_path,
            {
                "schema_version": "glitch.topstep.model_attempt.v2",
                "packet_id": packet_id,
                "started_utc": utc_now(),
                "status": "started",
                "model": core_model(),
                "provider": core_provider(),
                "session_mode": "isolated",
                "invocation_reason": reason,
            },
        )
        try:
            intent, repair_count = invoke_valid_intent(
                args.profile,
                build_prompt(packet, frames, context, directive, trade_state),
                packet,
                directive,
                args.timeout_seconds,
            )
        except Exception as error:
            attempt = read_json(attempt_path)
            attempt.update(
                completed_utc=utc_now(),
                status="failed",
                error=f"{type(error).__name__}:{error}"[:500],
            )
            write_json_atomic(attempt_path, attempt)
            append_jsonl(
                state / "events.jsonl",
                {
                    "schema_version": "glitch.topstep.cycle_event.v2",
                    "event": "decision_failed",
                    "recorded_utc": utc_now(),
                    "packet_id": packet_id,
                    **cycle_wake_fields(reason, wake_detail),
                    "error": attempt["error"],
                },
            )
            raise

        if discard_stale_outbox_intent(state, outbox_path, packet_id, intent, token=token):
            attempt = read_json(attempt_path)
            attempt.update(
                completed_utc=utc_now(),
                status="stale_packet_discarded",
                invocation_reason=reason,
            )
            write_json_atomic(attempt_path, attempt)
            return run_once(args, root)

        persist_wake_triggers(state, intent, packet_id)
        write_json_atomic(outbox_path, intent)
        append_jsonl(
            state / "decisions.jsonl",
            {
                "schema_version": "glitch.topstep.decision_record.v2",
                "recorded_utc": utc_now(),
                "packet_id": packet_id,
                "regime_detected": detect_regime(packet),
                "intent": intent,
            },
        )
        write_last_evidence_fingerprint(
            state,
            packet,
            evidence_fingerprint(packet),
        )
        attempt = read_json(attempt_path)
        attempt.update(
            completed_utc=utc_now(),
            status="decision_ready",
            output_repair_count=repair_count,
            invocation_reason=reason,
        )
        write_json_atomic(attempt_path, attempt)
        append_jsonl(
            state / "events.jsonl",
            {
                "schema_version": "glitch.topstep.cycle_event.v2",
                "event": "decision_ready",
                "recorded_utc": utc_now(),
                "packet_id": packet_id,
                **cycle_wake_fields(reason, wake_detail),
            },
        )
        if directive:
            consume_directive(state, directive, packet_id)

    if args.dry_run:
        print(
            json.dumps(
                {"packet_id": packet_id, "submitted": False},
                separators=(",", ":"),
            )
        )
        return 0

    try:
        result = deliver_intent(state, packet_id, intent, directive)
    except ValueError as error:
        if discard_unexecutable_entry_outbox(
            state, outbox_path, packet_id, intent, error
        ):
            return 0
        raise
    classification = classify_delivery_result(result)
    if classification != "transport_uncertain":
        receipt = {
            "schema_version": "glitch.topstep.delivery_receipt.v2",
            "recorded_utc": utc_now(),
            "packet_id": packet_id,
            "intent_id": intent["intent_id"],
            "result": result,
        }
        write_json_atomic(receipt_path, receipt)
        append_jsonl(state / "receipts.jsonl", receipt)
        outbox_path.unlink(missing_ok=True)
        clear_delivery_wire(state, packet_id)
        print(json.dumps(receipt, separators=(",", ":")))
        if classification == "terminal_rejection":
            detail = delivery_diagnostic_detail(result)
            if detail:
                append_jsonl(
                    state / "events.jsonl",
                    {
                        "schema_version": "glitch.topstep.cycle_event.v2",
                        "event": "intent_delivery_rejected",
                        "recorded_utc": utc_now(),
                        "packet_id": packet_id,
                        "intent_id": intent["intent_id"],
                        **detail,
                    },
                )
    else:
        print(json.dumps({"packet_id": packet_id, "result": result}, separators=(",", ":")))
    mark_attempt_from_receipt(state, packet_id, result)
    return 0 if classification == "successful" else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.environ.get("GLITCH_TOPSTEP_MODEL_TIMEOUT_SECONDS", "240")),
    )
    parser.add_argument(
        "--packet-rollover-wait-seconds",
        type=float,
        default=float(os.environ.get("GLITCH_TOPSTEP_PACKET_ROLLOVER_WAIT_SECONDS", "5")),
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = configure_environment()
    state = state_root(root)
    state.mkdir(parents=True, exist_ok=True)
    lock_path = state / "direct-cycle.lock"
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    status_path = supervisor / "direct-worker-status.json"
    run_id = str(uuid.uuid4())
    started_utc = utc_now()
    if not acquire_cycle_lock(lock_path):
        write_json_atomic(status_path, {
            "schema_version": "glitch.topstep.direct_worker_status.v2",
            "run_id": run_id,
            "recorded_utc": utc_now(),
            "status": "preempted",
            "phase": "lock_admission",
            "retryable": True,
        })
        return 0
    write_json_atomic(
        status_path,
        {
            "schema_version": "glitch.topstep.direct_worker_status.v2",
            "run_id": run_id,
            "pid": os.getpid(),
            "started_utc": started_utc,
            "recorded_utc": utc_now(),
            "status": "running",
            "phase": "cognition_and_delivery",
            "retryable": False,
        },
    )
    try:
        try:
            exit_code = run_once(args, root)
        except Exception as error:
            write_json_atomic(
                status_path,
                {
                    "schema_version": "glitch.topstep.direct_worker_status.v2",
                    "run_id": run_id,
                    "started_utc": started_utc,
                    "recorded_utc": utc_now(),
                    "status": "failed",
                    "phase": "cognition_and_delivery",
                    "retryable": isinstance(error, (OSError, TimeoutError, urllib.error.URLError)),
                    "error": f"{type(error).__name__}:{error}"[:500],
                },
            )
            raise
        write_json_atomic(
            status_path,
            {
                "schema_version": "glitch.topstep.direct_worker_status.v2",
                "run_id": run_id,
                "started_utc": started_utc,
                "completed_utc": utc_now(),
                "recorded_utc": utc_now(),
                "status": "ok" if exit_code == 0 else "failed",
                "phase": "completed",
                "retryable": exit_code != 0,
                "exit_code": exit_code,
            },
        )
        return exit_code
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            json.dumps(
                {"event": "topstep_cycle_failed", "error": str(error)}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
