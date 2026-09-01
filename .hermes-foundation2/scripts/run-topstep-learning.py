"""Evidence-gated debrief, supervision, planning, and daily learning.

The worker consumes only canonical `glitch.topstep.trade_outcome.v1` records. It
never infers a completed trade from balances or position disappearance. Cognitive
overlays are proposed by default and activate only when the operator explicitly
enables automatic activation and the configured evidence threshold is met.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from common import (
    PROFILE_NAME,
    acquire_cycle_lock,
    append_jsonl,
    configure_environment,
    extract_single_json_object,
    gateway_feed_is_fresh,
    hermes_chat_model_cli_args,
    hermes_model_version_label,
    parse_utc,
    profile_root,
    read_jsonl,
    read_optional_json,
    sync_gateway_outcomes_meta,
    sync_gateway_execution_facts,
    utc_now,
    write_json_atomic,
    write_jsonl_atomic,
)
from parity import (
    PROMPT_VERSION,
    classify_delivery_result,
    classify_gateway_rejection,
    debrief_evidence,
    debrief_prompt_evidence,
    frame_for_packet_id,
    suggest_flat_abstention_classification,
)


def learning_model(root: Path | None = None) -> str:
    return hermes_model_version_label(
        root or profile_root(),
        model_env="GLITCH_TOPSTEP_CORE_MODEL",
        fallback="gpt-5.6-luna",
    )


SOURCE = "trading"
EASTERN = ZoneInfo("America/New_York")
GATEWAY_COGNITIVE_REJECTION_ERRORS = frozenset({
    "move_stop_unavailable",
})
LOOP_SCHEMAS = {
    "debrief": "glitch.topstep.trade_episode.v1",
    "hourly": "glitch.topstep.hourly_review.v1",
    "planning": "glitch.topstep.portfolio_plan.v1",
    "daily": "glitch.topstep.daily_journal.v1",
    "weekly": "glitch.topstep.weekly_skill_proposal.v1",
}


def stable_id(kind: str, value: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"glitch-topstep:{kind}:{value}"))


def is_gateway_cognitive_rejection(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    http_status = result.get("http_status")
    if isinstance(http_status, int) and 400 <= http_status < 500:
        return True
    body = result.get("body")
    if not isinstance(body, dict):
        return False
    message = str(body.get("message") or body.get("error") or "")
    if message in GATEWAY_COGNITIVE_REJECTION_ERRORS:
        return True
    return str(body.get("status") or "").lower() in {"rejected", "invalid"}


def packet_is_flat(packet: dict[str, Any]) -> bool:
    account = packet.get("account")
    if not isinstance(account, dict):
        return True
    return int(account.get("instrument_open_contracts") or 0) == 0


def price_observation(frame: dict[str, Any]) -> dict[str, Any] | None:
    packet = frame.get("packet") if isinstance(frame.get("packet"), dict) else None
    if packet is None:
        return None
    market = packet.get("market")
    if not isinstance(market, dict):
        return None
    try:
        close = float(market["last"])
        high = float(market.get("high", close))
        low = float(market.get("low", close))
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "minute_id": frame.get("minute_id"),
        "close": close,
        "high": high,
        "low": low,
    }


def collect_decision_episodes(state_root: Path, supervisor: Path) -> list[dict[str, Any]]:
    output_path = supervisor / "decision-episodes.jsonl"
    existing = {str(row.get("intent_id")) for row in read_jsonl(output_path) if row.get("intent_id")}
    frames_root = state_root / "minute-frames"
    records: list[dict[str, Any]] = []
    seen_intents: set[str] = set()

    def enqueue(packet_id: str, intent: dict[str, Any]) -> None:
        nonlocal records
        receipt_path = state_root / "receipts" / f"{packet_id}.json"
        if not receipt_path.is_file():
            return
        receipt = read_optional_json(receipt_path)
        if not isinstance(receipt, dict):
            return
        if classify_delivery_result(
            receipt.get("result") if isinstance(receipt.get("result"), dict) else {}
        ) == "transport_uncertain":
            return
        intent_id = str(intent.get("intent_id") or receipt.get("intent_id") or "")
        if not intent_id or intent_id in existing or intent_id in seen_intents:
            return
        frame = frame_for_packet_id(frames_root, packet_id)
        if frame is None:
            return
        minute_id = str(frame.get("minute_id") or "")
        if not minute_id:
            return
        future_paths = [path for path in sorted(frames_root.glob("*.json")) if path.stem > minute_id][:5]
        if len(future_paths) < 5:
            return
        future: list[dict[str, Any]] = []
        for path in future_paths:
            observed = price_observation(read_optional_json(path) or {})
            if observed is None:
                future = []
                break
            future.append(observed)
        if len(future) < 5:
            return
        packet = frame.get("packet")
        if not isinstance(packet, dict):
            return
        action = str(intent.get("action") or "")
        flat_nothing = action == "NOTHING" and packet_is_flat(packet)
        relevant_failure = (
            action in {"ENTER_LONG", "ENTER_SHORT", "MOVE_STOP", "EXIT"}
            and is_gateway_cognitive_rejection(receipt.get("result"))
        )
        if not flat_nothing and not relevant_failure:
            return
        try:
            initial = float(packet["market"]["last"])
        except (KeyError, TypeError, ValueError):
            return
        forward_high = max(row["high"] for row in future)
        forward_low = min(row["low"] for row in future)
        account = packet.get("account") if isinstance(packet.get("account"), dict) else {}
        contract = packet.get("contract") if isinstance(packet.get("contract"), dict) else {}
        delivery_result = receipt.get("result") if isinstance(receipt.get("result"), dict) else {}
        records.append({
            "schema_version": "glitch.topstep.decision_episode.v1",
            "episode_id": stable_id("decision-episode", intent_id),
            "recorded_utc": utc_now(),
            "intent_id": intent_id,
            "packet_id": packet_id,
            "decision_utc": intent.get("created_utc") or receipt.get("recorded_utc"),
            "account": intent.get("account") or account.get("name"),
            "instrument": intent.get("instrument") or contract.get("symbol"),
            "action": action,
            "reason": intent.get("reason"),
            "decision_audit": intent.get("decision_audit"),
            "pre_decision_state": {
                "position_contracts": account.get("instrument_open_contracts"),
                "initial_price": initial,
                "regime": packet.get("regime"),
            },
            "proposed_geometry": {
                key: intent.get(key)
                for key in (
                    "quantity", "stop_loss", "take_profit_1", "take_profit_2",
                    "quantity_tp1", "stop_loss_2", "take_profit_3", "quantity_tp2",
                    "stop_loss_3",
                )
                if key in intent
            },
            "delivery_result": delivery_result,
            "rejection_class": classify_gateway_rejection(delivery_result),
            "evidence_kind": "flat_nothing" if flat_nothing else "rejected_or_nonexecuted_intent",
            "forward_observation_count": len(future),
            "forward_observations": future,
            "forward_high": forward_high,
            "forward_low": forward_low,
            "forward_close": future[-1]["close"],
            "upward_excursion_points": forward_high - initial,
            "downward_excursion_points": initial - forward_low,
            "classification": None,
            "classification_hint": (
                suggest_flat_abstention_classification(
                    initial_price=initial,
                    forward_high=forward_high,
                    forward_low=forward_low,
                    forward_close=future[-1]["close"],
                )
                if flat_nothing
                else None
            ),
            "classification_owner": "hermes",
        })
        seen_intents.add(intent_id)
        existing.add(intent_id)

    for row in read_jsonl(state_root / "decisions.jsonl"):
        packet_id = str(row.get("packet_id") or "")
        intent = row.get("intent")
        if packet_id and isinstance(intent, dict):
            enqueue(packet_id, intent)

    for outbox_path in sorted((state_root / "outbox").glob("*.json")):
        intent = read_optional_json(outbox_path)
        if isinstance(intent, dict):
            enqueue(outbox_path.stem, intent)

    append_unique(output_path, records, "episode_id")
    return read_jsonl(output_path)


def cognitive_evidence_ids(supervisor: Path) -> list[str]:
    rows = read_jsonl(supervisor / "trade-episodes.jsonl") + read_jsonl(supervisor / "decision-episodes.jsonl")
    rows.sort(key=lambda row: str(row.get("recorded_utc") or row.get("decision_utc") or ""))
    return [str(row.get("episode_id")) for row in rows if row.get("episode_id")]


def bounded_learning_rows(
    rows: list[dict[str, Any]], max_rows: int, max_chars: int
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    used_chars = 0
    for row in reversed(rows):
        row_chars = len(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
        if len(selected) >= max_rows or used_chars + row_chars > max_chars:
            break
        selected.append(row)
        used_chars += row_chars
    return list(reversed(selected))


def outcomes_path(root: Path) -> Path:
    configured = os.environ.get("GLITCH_TOPSTEP_OUTCOMES_PATH", "").strip()
    return Path(configured).expanduser().resolve() if configured else root / "state" / "outcomes.jsonl"


def valid_outcomes(path: Path) -> list[dict[str, Any]]:
    required = {
        "schema_version", "outcome_id", "intent_id", "account", "instrument",
        "entry_utc", "exit_utc", "realized_pnl_usd", "fees_usd", "learning_eligible",
    }
    values = []
    for row in read_jsonl(path):
        if row.get("schema_version") != "glitch.topstep.trade_outcome.v1":
            continue
        if not required.issubset(row):
            continue
        if row.get("learning_eligible") is not True:
            continue
        values.append(row)
    return values


def canonical_outcomes(path: Path) -> list[dict[str, Any]]:
    required = {
        "schema_version", "outcome_id", "intent_id", "account", "instrument",
        "entry_utc", "exit_utc", "realized_pnl_usd", "fees_usd", "learning_eligible",
    }
    return [
        row for row in read_jsonl(path)
        if row.get("schema_version") == "glitch.topstep.trade_outcome.v1"
        and required.issubset(row)
    ]


def invoke_hermes(profile: str, prompt: str, skills: str, timeout_seconds: int) -> dict[str, Any]:
    executable = shutil.which("hermes")
    if not executable:
        raise RuntimeError("hermes_executable_not_found")
    python_executable = Path(executable).with_name("python.exe" if sys.platform == "win32" else "python")
    if not python_executable.is_file():
        python_executable = Path(sys.executable)
    root = profile_root(profile)
    args = [
        "chat", "-Q", "--source", SOURCE,
        *hermes_chat_model_cli_args(
            root,
            model_env="GLITCH_TOPSTEP_CORE_MODEL",
            provider_env="GLITCH_TOPSTEP_CORE_PROVIDER",
        ),
        "--max-turns", "8", "--skills", skills,
        "--toolsets", "memory",
    ]
    wrapper = (
        "import os,sys;from pathlib import Path;"
        "os.environ['HERMES_HOME']=str(Path.home()/'AppData'/'Local'/'hermes'/'profiles'/"
        + repr(profile)
        + ");from hermes_cli.main import main;prompt=sys.stdin.read();"
        "sys.argv=[sys.argv[0]]+" + repr(args) + "+['-q',prompt];main()"
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
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"hermes_failed:{completed.returncode}:{completed.stderr.strip()[:400]}")
    return extract_single_json_object(completed.stdout, schema="glitch.topstep.learning_output.v1")


def output_template(loop_id: str, record_ids: list[str]) -> dict[str, Any]:
    records = []
    for record_id in record_ids:
        if loop_id == "debrief":
            records.append({
                "schema_version": LOOP_SCHEMAS[loop_id],
                "episode_id": record_id,
                "recorded_utc": utc_now(),
                "outcome_id": "COPY_FROM_EVIDENCE",
                "intent_id": "COPY_FROM_EVIDENCE",
                "account": "COPY_FROM_EVIDENCE",
                "instrument": "COPY_FROM_EVIDENCE",
                "entry_assessment": "REPLACE",
                "exit_assessment": "REPLACE",
                "risk_assessment": "REPLACE",
                "what_went_well": ["REPLACE"],
                "what_went_wrong": ["REPLACE"],
                "lesson_candidates": ["REPLACE"],
                "uncertainties": ["REPLACE"],
            })
        elif loop_id == "hourly":
            records.append({
                "schema_version": LOOP_SCHEMAS[loop_id],
                "review_id": record_id,
                "recorded_utc": utc_now(),
                "working": ["REPLACE"],
                "failing": ["REPLACE"],
                "unknown": ["REPLACE"],
                "repeated_patterns": ["REPLACE"],
                "system_findings": ["REPLACE"],
                "guidance": {"summary": "REPLACE", "consider": ["REPLACE"], "avoid": ["REPLACE"]},
                "decision_episode_classifications": [{
                    "episode_id": "COPY_FROM_EVIDENCE",
                    "classification": "justified_abstention|avoided_adverse_movement|missed_directional_participation|ambiguous",
                    "counterfactual_summary": "REPLACE",
                    "change_condition_review": "met|reassessed|threshold_moved|not_applicable",
                }],
                "cognitive_change_candidate": {
                    "propose": False,
                    "candidate_id": "",
                    "target": "core_prompt",
                    "instruction": "",
                    "evidence_episode_ids": [],
                    "expected_effect": "",
                    "evaluation_metric": "",
                    "rollback_condition": ""
                }
            })
        elif loop_id == "planning":
            records.append({
                "schema_version": LOOP_SCHEMAS[loop_id],
                "plan_id": record_id,
                "recorded_utc": utc_now(),
                "horizon_minutes": 360,
                "regime_posture": "REPLACE",
                "objectives": ["REPLACE"],
                "risk_guidance": "REPLACE",
                "geometry_guidance": "REPLACE",
                "management_guidance": "REPLACE",
                "experiments": ["REPLACE"],
                "preservation_conditions": ["REPLACE"],
                "revision_triggers": ["REPLACE"]
            })
        elif loop_id == "daily":
            records.append({
                "schema_version": LOOP_SCHEMAS[loop_id],
                "journal_id": record_id,
                "recorded_utc": utc_now(),
                "session_date_et": datetime.now(EASTERN).date().isoformat(),
                "net_performance": "REPLACE",
                "survival_and_rule_compliance": "REPLACE",
                "what_worked": ["REPLACE"],
                "what_failed": ["REPLACE"],
                "durable_memory_updates": [],
                "tomorrow_questions": ["REPLACE"],
                "cognitive_change_candidate": {
                    "propose": False,
                    "candidate_id": "",
                    "target": "core_prompt",
                    "instruction": "",
                    "evidence_episode_ids": [],
                    "expected_effect": "",
                    "evaluation_metric": "",
                    "rollback_condition": ""
                }
            })
        else:
            records.append({
                "schema_version": LOOP_SCHEMAS[loop_id],
                "skill_proposal_id": record_id,
                "recorded_utc": utc_now(),
                "proposal_summary": "REPLACE",
                "skill_candidates": [{
                    "skill_name": "REPLACE",
                    "instruction": "REPLACE",
                    "evidence_journal_ids": ["REPLACE"],
                    "expected_effect": "REPLACE",
                    "evaluation_metric": "REPLACE",
                    "rollback_condition": "REPLACE",
                }],
                "uncertainties": ["REPLACE"],
            })
    return {
        "schema_version": "glitch.topstep.learning_output.v1",
        "loop_id": loop_id,
        "records": records,
    }


def prompt_for(loop_id: str, evidence: Any, template: dict[str, Any], continuity: dict[str, Any]) -> str:
    instructions = {
        "debrief": (
            "Produce one honest debrief per canonical completed outcome. Reconstruct decision quality, stop-aware risk, "
            "execution, fees, account-buffer impact, payout-state impact when supplied, and plausible alternatives. Each "
            "evidence row includes facts and facts_sha256; treat the hash as the audit anchor and do not invent facts "
            "beyond the supplied facts block. A provider or gateway defect is a system finding, not a trading lesson."
        ),
        "hourly": (
            "Supervise recent trade and decision episodes. For each flat NOTHING, preserve the "
            "developing movement, favorable participation condition, invalidation, and later observed "
            "path. Classify matured flat abstentions as justified_abstention, avoided_adverse_movement, "
            "missed_directional_participation, or ambiguous by comparing the declared forecast and "
            "change_condition with the observed path. Label the actual outcome no trade and every "
            "counterfactual informational only; never invent counterfactual fills, geometry, or PnL. "
            "When supplied evidence includes daily_economics mirrors, note band position and stage-appropriate "
            "preservation or eval-target context without creating entry pressure or automatic stop rules. "
            "For each prior change_condition, record met, reassessed, threshold_moved, or not_applicable. "
            "Separate repeated cognitive errors from venue, policy, transport, or execution defects. "
            "Propose at most one compact cognitive change only when multiple comparable episodes support it. "
            "Decision episodes may improve questions and attention, but must not create entry pressure, "
            "anti-abstention pressure, or quantity pressure."
        ),
        "planning": (
            "Create a six-hour advisory plan. Preserve deterministic risk and gateway authority. Do not create entry "
            "gates, fixed quantities, daily profit quotas, or instructions that bypass current packets. "
            "When daily_economics mirrors are available in current packets, you may name a daily intent band "
            "(for example preserve upper-band gains on approved accounts) and stop-trading questions — not quotas. "
            "Use completed decision episodes to question habitual abstention and rejected geometry while preserving "
            "uncertainty; decision-only findings are observational and cannot pressure entries or size."
        ),
        "daily": (
            "Distill the supplied supervision summaries and plans into a compact maintenance learning journal. Do not "
            "reconstruct a whole trading session or consume raw market packets. Evaluate survival, rule compliance, "
            "evidence quality, and when mirrors were present whether band position supported good day-level sizing. "
            "Write durable native memory only for repeated attributable lessons; current account "
            "state is never memory."
        ),
        "weekly": (
            "Distill only the supplied daily journals into compact proposal-only skill language. Preserve contradictions "
            "and uncertainty; do not infer new trading rules from a single outcome. Each skill proposal must include "
            "evidence IDs, expected effect, evaluation metric, and rollback condition. Do not activate skills in this loop."
        ),
    }[loop_id]
    memory = "Retrieve relevant durable memory exactly once. Do not write memory in this loop. "
    return (
        "Apply the Glitch Topstep SOUL and loaded learning skills. Canonical outcome records and gateway evidence outrank "
        "memory and interpretation. Optimize long-run net payouts, survival, and rule compliance; never manufacture a "
        "daily target. " + memory + instructions + " Return exactly the required_output_template shape as one strict "
        "JSON object with no markdown or prose. Preserve every supplied ID. CURRENT_LEARNING_CYCLE="
        + json.dumps({
            "loop_id": loop_id,
            "evidence": evidence,
            "continuity": continuity,
            "required_output_template": template,
        }, separators=(",", ":"), ensure_ascii=False)
    )


def validate_output(value: dict[str, Any], loop_id: str, expected_ids: list[str]) -> list[dict[str, Any]]:
    if value.get("schema_version") != "glitch.topstep.learning_output.v1" or value.get("loop_id") != loop_id:
        raise ValueError("learning_output_envelope_invalid")
    records = value.get("records")
    if not isinstance(records, list) or len(records) != len(expected_ids):
        raise ValueError("learning_output_record_count_invalid")
    id_field = {
        "debrief": "episode_id",
        "hourly": "review_id",
        "planning": "plan_id",
        "daily": "journal_id",
        "weekly": "skill_proposal_id",
    }[loop_id]
    ids = [str(record.get(id_field) or "") for record in records if isinstance(record, dict)]
    if ids != expected_ids:
        raise ValueError("learning_output_identity_mismatch")
    if any(record.get("schema_version") != LOOP_SCHEMAS[loop_id] for record in records):
        raise ValueError("learning_output_schema_invalid")
    return records


def invoke_loop(args: argparse.Namespace, loop_id: str, evidence: Any, ids: list[str], supervisor: Path) -> list[dict[str, Any]]:
    template = output_template(loop_id, ids)
    skills = {
        "debrief": "topstep-review-outcomes,topstep-self-learning,topstep-learning-loop",
        "hourly": "topstep-review-outcomes,topstep-self-learning,topstep-self-heal,topstep-supervisor-ledger,topstep-learning-loop",
        "planning": "topstep-self-learning,topstep-supervisor-ledger,topstep-learning-loop",
        "daily": "topstep-review-outcomes,topstep-self-learning,topstep-supervisor-ledger,topstep-learning-loop",
        "weekly": "topstep-self-learning,topstep-supervisor-ledger,topstep-learning-loop",
    }[loop_id]
    continuity = {
        "current_plan": read_optional_json(supervisor / "current-plan.json"),
        "current_guidance": read_optional_json(supervisor / "current-guidance.json"),
        "active_cognitive_overlay": read_optional_json(supervisor / "active-cognitive-overlay.json"),
    }
    prompt = prompt_for(loop_id, evidence, template, continuity)
    try:
        value = invoke_hermes(args.profile, prompt, skills, args.timeout_seconds)
        return validate_output(value, loop_id, ids)
    except (json.JSONDecodeError, ValueError) as error:
        repair_prompt = (
            prompt
            + "\nThe previous response failed strict validation with: "
            + f"{type(error).__name__}:{error}"[:300]
            + ". Re-answer the same evidence once using exactly required_output_template. "
            + "Return one complete JSON object only; do not explain the repair."
        )
        value = invoke_hermes(args.profile, repair_prompt, skills, args.timeout_seconds)
        return validate_output(value, loop_id, ids)


def append_unique(path: Path, records: list[dict[str, Any]], id_field: str) -> None:
    existing = {str(row.get(id_field)) for row in read_jsonl(path) if row.get(id_field)}
    for record in records:
        identifier = str(record.get(id_field) or "")
        if identifier and identifier not in existing:
            append_jsonl(path, record)
            existing.add(identifier)


def upsert_unique(path: Path, records: list[dict[str, Any]], id_field: str) -> None:
    """Replace corrected episodes in place while preserving one stable episode identity."""
    rows = read_jsonl(path)
    positions = {
        str(row.get(id_field)): index
        for index, row in enumerate(rows)
        if row.get(id_field)
    }
    for record in records:
        identifier = str(record.get(id_field) or "")
        if not identifier:
            continue
        position = positions.get(identifier)
        if position is None:
            positions[identifier] = len(rows)
            rows.append(record)
        else:
            rows[position] = record
    write_jsonl_atomic(path, rows)


def reconcile_corrected_episodes(
    path: Path,
    outcomes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Retract an existing episode when its canonical outcome becomes ineligible."""
    current = {str(row.get("outcome_id")): row for row in outcomes if row.get("outcome_id")}
    rows = read_jsonl(path)
    changed = False
    for episode in rows:
        outcome_id = str(episode.get("outcome_id") or "")
        outcome = current.get(outcome_id)
        if not outcome or outcome.get("learning_eligible") is True:
            continue
        if episode.get("status") != "retracted":
            episode["status"] = "retracted"
            episode["learning_eligible"] = False
            episode["retracted_revision"] = int(outcome.get("_feed_revision") or 1)
            episode["retraction_reason"] = "canonical_outcome_not_learning_eligible"
            changed = True
    if changed:
        write_jsonl_atomic(path, rows)
    return rows


def auto_overlay_enabled() -> bool:
    return os.environ.get("GLITCH_TOPSTEP_AUTO_ACTIVATE_OVERLAY", "false").strip().lower() == "true"


def overlay_min_episodes() -> int:
    try:
        return max(2, int(os.environ.get("GLITCH_TOPSTEP_OVERLAY_MIN_EPISODES", "6")))
    except ValueError:
        return 6


def process_candidate(record: dict[str, Any], supervisor: Path, episode_ids: list[str]) -> None:
    candidate = record.get("cognitive_change_candidate")
    if not isinstance(candidate, dict) or candidate.get("propose") is not True:
        return
    instruction = str(candidate.get("instruction") or "").strip()
    evidence_ids = [str(value) for value in candidate.get("evidence_episode_ids", [])]
    target = str(candidate.get("target") or "")
    if target not in {"core_prompt", "soul"} and not target.startswith("skill:"):
        return
    if not instruction or len(instruction) > 1200 or len(set(evidence_ids)) < overlay_min_episodes():
        return
    if any(value not in set(episode_ids) for value in evidence_ids):
        return
    candidate_id = str(candidate.get("candidate_id") or stable_id("cognitive-change", target + "|" + instruction))
    value = {
        "schema_version": "glitch.topstep.cognitive_candidate.v1",
        "candidate_id": candidate_id,
        "recorded_utc": utc_now(),
        "target": target,
        "instruction": instruction,
        "evidence_episode_ids": evidence_ids,
        "expected_effect": candidate.get("expected_effect"),
        "evaluation_metric": candidate.get("evaluation_metric"),
        "rollback_condition": candidate.get("rollback_condition"),
        "status": "active" if auto_overlay_enabled() else "proposed",
    }
    append_unique(supervisor / "cognitive-candidates.jsonl", [value], "candidate_id")
    if auto_overlay_enabled() and not read_optional_json(supervisor / "active-cognitive-overlay.json"):
        write_json_atomic(supervisor / "active-cognitive-overlay.json", value)


def trade_evidence_ids(supervisor: Path) -> list[str]:
    return [
        str(row.get("episode_id"))
        for row in read_jsonl(supervisor / "trade-episodes.jsonl")
        if row.get("episode_id")
    ]


def later_evidence_ids(value: dict[str, Any], episode_ids: list[str]) -> set[str]:
    baseline = value.get("baseline_evidence_ids")
    if isinstance(baseline, list):
        return set(episode_ids).difference(str(item) for item in baseline)
    cursor = int(value.get("evaluation_episode_count", value.get("baseline_episode_count")) or 0)
    return set(episode_ids[cursor:])


def apply_cognitive_decision(record: dict[str, Any], supervisor: Path, episode_ids: list[str]) -> None:
    active_path = supervisor / "active-cognitive-overlay.json"
    active = read_optional_json(active_path)
    decision = record.get("cognitive_change_decision")
    if not isinstance(decision, dict):
        return
    action = str(decision.get("action") or "").lower()
    contradiction_review = str(decision.get("contradiction_review") or "").strip()
    if (
        active
        and active.get("status") in {"active", "promoted"}
        and active.get("replacement_text")
        and str(decision.get("candidate_id")) == str(active.get("candidate_id"))
    ):
        later_episode_ids = later_evidence_ids(active, episode_ids).intersection(
            trade_evidence_ids(supervisor)
        )
        later = [value for value in decision.get("evidence_episode_ids", []) if value in later_episode_ids]
        if len(set(later)) < 1 or action not in {"continue", "promote", "rollback"} or not contradiction_review:
            return
        active["status"] = {"continue": "active", "promote": "promoted", "rollback": "rolled_back"}[action]
        active["evaluated_utc"] = utc_now()
        active["evaluation_episode_count"] = len(episode_ids)
        active["baseline_evidence_ids"] = list(episode_ids)
        active["evaluation"] = decision
        if action == "rollback":
            active.pop("replacement_text", None)
        write_json_atomic(active_path, active)
        return

    proposed_path = supervisor / "proposed-cognitive-overlay.json"
    proposed = read_optional_json(proposed_path)
    if (
        not proposed
        or proposed.get("status") != "proposed"
        or not proposed.get("replacement_text")
        or str(decision.get("candidate_id")) != str(proposed.get("candidate_id"))
        or action not in {"activate", "rollback"}
    ):
        return
    later_episode_ids = later_evidence_ids(proposed, episode_ids).intersection(
        trade_evidence_ids(supervisor)
    )
    later = [value for value in decision.get("evidence_episode_ids", []) if value in later_episode_ids]
    if len(set(later)) < 1 or not contradiction_review:
        return
    proposed["status"] = "activated" if action == "activate" else "rolled_back"
    proposed["evaluated_utc"] = utc_now()
    proposed["evaluation"] = decision
    if action == "rollback":
        proposed.pop("replacement_text", None)
    write_json_atomic(proposed_path, proposed)
    if action == "activate":
        write_json_atomic(
            active_path,
            {
                **proposed,
                "status": "active",
                "activated_utc": utc_now(),
                "baseline_episode_count": len(episode_ids),
                "evaluation_episode_count": len(episode_ids),
                "baseline_evidence_ids": list(episode_ids),
                "prompt_version": PROMPT_VERSION,
                "operation": "replace",
                "target": "core_prompt",
            },
        )


def activate_cognitive_candidate(record: dict[str, Any], supervisor: Path, episode_ids: list[str]) -> None:
    candidate = record.get("cognitive_change_candidate")
    if not isinstance(candidate, dict) or candidate.get("propose") is not True:
        return
    current = read_optional_json(supervisor / "active-cognitive-overlay.json")
    if current and current.get("status") in {"active", "promoted"} and current.get("replacement_text"):
        return
    proposed_path = supervisor / "proposed-cognitive-overlay.json"
    proposed = read_optional_json(proposed_path)
    if proposed and proposed.get("status") == "proposed" and proposed.get("replacement_text"):
        return
    target = str(candidate.get("target") or "")
    operation = str(candidate.get("operation") or "replace")
    expected_old_text = str(candidate.get("expected_old_text") or candidate.get("instruction") or "").strip()
    replacement_text = str(candidate.get("replacement_text") or candidate.get("instruction") or "").strip()
    evidence_ids = [str(value) for value in candidate.get("evidence_episode_ids", [])]
    if (
        target != "core_prompt"
        or operation != "replace"
        or not expected_old_text
        or not replacement_text
        or expected_old_text == replacement_text
        or len(expected_old_text) > 600
        or len(replacement_text) > 600
        or len(set(evidence_ids)) < 1
        or any(value not in set(episode_ids) for value in evidence_ids)
    ):
        return
    candidate_id = str(
        candidate.get("candidate_id")
        or stable_id("cognitive-change", target + "|" + expected_old_text + "|" + replacement_text)
    )
    value = {
        "schema_version": "glitch.topstep.cognitive_overlay.v1",
        "candidate_id": candidate_id,
        "recorded_utc": utc_now(),
        "target": target,
        "operation": operation,
        "expected_old_text": expected_old_text,
        "expected_old_sha256": hashlib.sha256(expected_old_text.encode("utf-8")).hexdigest(),
        "replacement_text": replacement_text,
        "evidence_episode_ids": evidence_ids,
        "expected_effect": candidate.get("expected_effect"),
        "evaluation_metric": candidate.get("evaluation_metric"),
        "rollback_condition": candidate.get("rollback_condition"),
        "status": "proposed",
        "prompt_version": PROMPT_VERSION,
    }
    write_json_atomic(proposed_path, value)


def persist_hourly(record: dict[str, Any], supervisor: Path, episode_ids: list[str]) -> None:
    append_unique(supervisor / "hourly-reviews.jsonl", [record], "review_id")
    append_unique(supervisor / "observations.jsonl", [record], "review_id")
    trade_count = len(trade_evidence_ids(supervisor))
    decision_count = len(read_jsonl(supervisor / "decision-episodes.jsonl"))
    lesson_influence = "outcome_backed" if trade_count >= 2 else "observational"
    guidance = {
        "schema_version": "glitch.topstep.guidance.v1",
        "guidance_id": stable_id("guidance", str(record["review_id"])),
        "recorded_utc": record.get("recorded_utc") or utc_now(),
        "source_review_id": record["review_id"],
        "prompt_version": PROMPT_VERSION,
        "trading_influence": "outcome_backed" if trade_count >= 2 else "observational",
        "trade_episode_count": trade_count,
        "decision_episode_count": decision_count,
        "guidance": record.get("guidance"),
    }
    append_unique(supervisor / "guidance.jsonl", [guidance], "guidance_id")
    write_json_atomic(supervisor / "current-guidance.json", guidance)
    lessons = []
    for index, lesson in enumerate(record.get("candidate_lessons", [])):
        if not isinstance(lesson, dict):
            continue
        lessons.append({
            "schema_version": "glitch.topstep.candidate_lesson.v1",
            "lesson_id": str(lesson.get("lesson_id") or stable_id("lesson", f"{record['review_id']}:{index}")),
            "recorded_utc": utc_now(),
            "source_review_id": record["review_id"],
            "trading_influence": lesson_influence,
            **lesson,
        })
    append_unique(supervisor / "lessons.jsonl", lessons, "lesson_id")
    apply_cognitive_decision(record, supervisor, episode_ids)
    activate_cognitive_candidate(record, supervisor, episode_ids)
    process_candidate(record, supervisor, episode_ids)


def minutes_since(value: Any, now: datetime) -> float:
    try:
        return (now - parse_utc(value)).total_seconds() / 60
    except (TypeError, ValueError):
        return float("inf")


def run_once(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    state_root = root / "state"
    supervisor = state_root / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    state_path = supervisor / "learning-state.json"
    state = read_optional_json(state_path) or {"schema_version": "glitch.topstep.learning_state.v1"}
    sync_meta = sync_gateway_outcomes_meta(state_root)
    execution_facts_meta = sync_gateway_execution_facts(state_root)
    outcome_file = outcomes_path(root)
    all_outcomes = canonical_outcomes(outcome_file)
    outcomes = [row for row in all_outcomes if row.get("learning_eligible") is True]
    episodes = read_jsonl(supervisor / "trade-episodes.jsonl")
    if not args.dry_run:
        episodes = reconcile_corrected_episodes(supervisor / "trade-episodes.jsonl", all_outcomes)
    processed_revisions = {
        str(key): int(value)
        for key, value in (state.get("debriefed_outcome_revisions") or {}).items()
    }
    for row in episodes:
        outcome_id = str(row.get("outcome_id") or "")
        if outcome_id:
            processed_revisions[outcome_id] = max(
                processed_revisions.get(outcome_id, 0),
                int(row.get("outcome_revision") or 1),
            )
    for row in all_outcomes:
        if row.get("learning_eligible") is not True:
            processed_revisions[str(row["outcome_id"])] = max(
                processed_revisions.get(str(row["outcome_id"]), 0),
                int(row.get("_feed_revision") or 1),
            )
    pending = [
        row for row in outcomes
        if int(row.get("_feed_revision") or 1) > processed_revisions.get(str(row.get("outcome_id")), 0)
    ]
    pending = sorted(pending, key=lambda row: str(row.get("exit_utc") or ""), reverse=True)[:8]
    now = datetime.now(timezone.utc)
    feed_fresh = gateway_feed_is_fresh()
    if feed_fresh and not args.dry_run:
        decision_episodes = collect_decision_episodes(state_root, supervisor)
    else:
        decision_episodes = read_jsonl(supervisor / "decision-episodes.jsonl")
    result: dict[str, Any] = {
        "feed_fresh": feed_fresh,
        "outcomes_synced": int(sync_meta.get("added") or 0),
        "outcomes_sync_http_status": sync_meta.get("http_status"),
        "outcome_feed_sequence": sync_meta.get("sequence"),
        "outcome_revisions_synced": int(sync_meta.get("revised") or 0),
        "execution_facts_synced": int(execution_facts_meta.get("added") or 0),
        "execution_facts_sequence": execution_facts_meta.get("sequence"),
        "debriefed": 0,
        "hourly": False,
        "planning": False,
        "daily": False,
        "weekly": False,
    }

    if feed_fresh and pending and args.force_loop in {None, "debrief"}:
        ids = [stable_id("episode", str(row["outcome_id"])) for row in pending]
        if not args.dry_run:
            factual_evidence = debrief_evidence(state_root, pending)
            records = invoke_loop(
                args,
                "debrief",
                debrief_prompt_evidence(factual_evidence),
                ids,
                supervisor,
            )
            for record, outcome in zip(records, pending):
                record["outcome_id"] = outcome["outcome_id"]
                record["intent_id"] = outcome["intent_id"]
                record["account"] = outcome["account"]
                record["instrument"] = outcome["instrument"]
                record["outcome_revision"] = int(outcome.get("_feed_revision") or 1)
                record["outcome_content_hash"] = str(outcome.get("_feed_content_hash") or "")
                record["prompt_version"] = PROMPT_VERSION
            upsert_unique(supervisor / "trade-episodes.jsonl", records, "episode_id")
            for row in pending:
                processed_revisions[str(row["outcome_id"])] = int(row.get("_feed_revision") or 1)
            state["debriefed_outcome_revisions"] = dict(sorted(processed_revisions.items()))
            state["debriefed_outcome_ids"] = sorted(processed_revisions)
        result["debriefed"] = len(pending)

    episodes = read_jsonl(supervisor / "trade-episodes.jsonl")
    episode_ids = cognitive_evidence_ids(supervisor)
    supervision_trade_cursor = int(state.get("supervision_trade_count", max(0, len(episodes) - 12)))
    supervision_decision_cursor = int(
        state.get("supervision_decision_count", max(0, len(decision_episodes) - 24))
    )
    hourly_due = (
        (len(episodes) > supervision_trade_cursor or len(decision_episodes) > supervision_decision_cursor or int(sync_meta.get("revised") or 0) > 0)
        and minutes_since(state.get("last_hourly_utc"), now) >= 60
    )
    if feed_fresh and (hourly_due or args.force_loop == "hourly") and args.force_loop in {None, "hourly"}:
        review_id = stable_id("hourly", now.strftime("%Y%m%dT%H"))
        overlay = read_optional_json(supervisor / "active-cognitive-overlay.json")
        if overlay and overlay.get("status") not in {"active", "promoted"}:
            overlay = None
        if not args.dry_run:
            record = invoke_loop(
                args,
                "hourly",
                {
                    "trade_episodes": bounded_learning_rows(episodes[supervision_trade_cursor:], 12, 180_000),
                    "decision_episodes": bounded_learning_rows(
                        decision_episodes[supervision_decision_cursor:], 24, 220_000
                    ),
                    "active_cognitive_overlay": overlay,
                    "scope": {"kind": "supervision_delta", "since_utc": state.get("last_hourly_utc")},
                },
                [review_id],
                supervisor,
            )[0]
            persist_hourly(record, supervisor, episode_ids)
            state["last_hourly_utc"] = utc_now()
            state["supervision_trade_count"] = len(episodes)
            state["supervision_decision_count"] = len(decision_episodes)
        result["hourly"] = True

    reviews = read_jsonl(supervisor / "observations.jsonl") or read_jsonl(supervisor / "hourly-reviews.jsonl")
    planning_due = bool(reviews) and minutes_since(state.get("last_planning_utc"), now) >= 360 and int(state.get("planning_review_count", 0)) < len(reviews)
    if feed_fresh and (planning_due or args.force_loop == "planning") and args.force_loop in {None, "planning"}:
        plan_id = stable_id("plan", now.strftime("%Y%m%dT%H") + f":{now.minute // 5 * 5:02d}")
        if not args.dry_run:
            record = invoke_loop(
                args,
                "planning",
                {
                    "reviews": bounded_learning_rows(reviews, 6, 240_000),
                    "episodes": bounded_learning_rows(episodes, 24, 180_000),
                },
                [plan_id],
                supervisor,
            )[0]
            trade_count = len(episodes)
            record["trading_influence"] = "outcome_backed" if trade_count >= 2 else "observational"
            record["prompt_version"] = PROMPT_VERSION
            record["trade_episode_count"] = trade_count
            record["decision_episode_count"] = len(decision_episodes)
            append_unique(supervisor / "plans.jsonl", [record], "plan_id")
            write_json_atomic(supervisor / "current-plan.json", record)
            state["last_planning_utc"] = utc_now()
            state["planning_review_count"] = len(reviews)
        result["planning"] = True

    plans = read_jsonl(supervisor / "plans.jsonl")
    daily_due = (
        (not feed_fresh and (
            len(reviews) > int(state.get("daily_review_count", 0))
            or len(plans) > int(state.get("daily_plan_count", 0))
        ))
        or args.force_loop == "daily"
    )
    if daily_due and args.force_loop in {None, "daily"}:
        session_date = now.astimezone(EASTERN).date().isoformat()
        journal_id = stable_id("daily-distill", f"{len(reviews)}:{len(plans)}")
        if not args.dry_run:
            evidence = {
                "session_date_et": session_date,
                "scope": {
                    "kind": "maintenance_distillation",
                    "source": "supervision_summaries_plus_plans",
                    "through_utc": now.isoformat(),
                },
                "reviews": bounded_learning_rows(reviews, max_rows=12, max_chars=260_000),
                "plans": bounded_learning_rows(plans, max_rows=4, max_chars=260_000),
            }
            record = invoke_loop(args, "daily", evidence, [journal_id], supervisor)[0]
            append_unique(supervisor / "daily-journal.jsonl", [record], "journal_id")
            apply_cognitive_decision(record, supervisor, episode_ids)
            activate_cognitive_candidate(record, supervisor, episode_ids)
            process_candidate(record, supervisor, episode_ids)
            state["daily_review_count"] = len(reviews)
            state["daily_plan_count"] = len(plans)
        result["daily"] = True
        result["daily_distilled"] = True

    daily_journals = read_jsonl(supervisor / "daily-journal.jsonl")
    weekly_due = len(daily_journals) - int(state.get("weekly_daily_count", 0)) >= 7
    if args.force_loop == "weekly":
        weekly_due = True
    if weekly_due and args.force_loop in {None, "weekly"}:
        proposal_id = stable_id("weekly-skill-proposal", f"{len(daily_journals)}")
        if not args.dry_run:
            records = invoke_loop(
                args,
                "weekly",
                {
                    "scope": {"kind": "weekly_distillation", "daily_journal_count": len(daily_journals)},
                    "daily_journals": bounded_learning_rows(daily_journals[-7:], 7, 260_000),
                    "recent_plans": bounded_learning_rows(plans[-4:], 4, 160_000),
                },
                [proposal_id],
                supervisor,
            )
            append_unique(supervisor / "weekly-skill-proposals.jsonl", records, "skill_proposal_id")
            state["weekly_daily_count"] = len(daily_journals)
        result["weekly"] = True

    if not args.dry_run:
        state["updated_utc"] = utc_now()
        write_json_atomic(state_path, state)
    result["canonical_outcomes"] = len(outcomes)
    result["episodes"] = len(episodes)
    result["decision_episodes"] = len(decision_episodes)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=PROFILE_NAME)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force-loop", choices=("debrief", "hourly", "planning", "daily", "weekly"))
    args = parser.parse_args()
    root = configure_environment()
    state = root / "state"
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    lock_path = state / "learning-cycle.lock"
    run_id = stable_id("learning-run", utc_now())
    started_utc = utc_now()
    if not acquire_cycle_lock(lock_path):
        write_json_atomic(supervisor / "learning-worker-status.json", {
            "schema_version": "glitch.topstep.learning_worker_status.v2",
            "run_id": run_id,
            "recorded_utc": utc_now(),
            "status": "preempted",
            "phase": "lock_admission",
            "retryable": True,
        })
        return 0
    try:
        try:
            result = run_once(args, root)
        except Exception as error:
            failure = {
                "schema_version": "glitch.topstep.learning_worker_status.v2",
                "run_id": run_id,
                "started_utc": started_utc,
                "recorded_utc": utc_now(),
                "status": "failed",
                "phase": "learning",
                "retryable": isinstance(error, (OSError, TimeoutError)),
                "error": f"{type(error).__name__}:{error}"[:500],
            }
            write_json_atomic(supervisor / "learning-worker-status.json", failure)
            print(json.dumps(failure, separators=(",", ":")), file=sys.stderr)
            return 1
        write_json_atomic(supervisor / "learning-worker-status.json", {
            "schema_version": "glitch.topstep.learning_worker_status.v2",
            "run_id": run_id,
            "started_utc": started_utc,
            "completed_utc": utc_now(),
            "recorded_utc": utc_now(),
            "status": "ok",
            "phase": "completed",
            "retryable": False,
            "result": result,
        })
        print(json.dumps(result, separators=(",", ":")))
        return 0
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
