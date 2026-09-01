"""Strict multi-instrument cognition ledger carried in decision_audit.decisive_evidence."""

from __future__ import annotations

import json
from typing import Any

MARKER = "INSTRUMENT_COMPARISON_V1:"
PATH_FIELDS = ("current_auction", "bullish_path", "bearish_path", "next_transition")
TRIGGER_STATUSES = {"HELD", "FAILED", "EXPIRED"}


def candidate_instruments(packet: dict[str, Any]) -> list[str]:
    universe = packet.get("market_universe")
    candidates = universe.get("candidates") if isinstance(universe, dict) else None
    if not isinstance(candidates, list):
        return []
    return [
        str(row.get("instrument") or "").upper()
        for row in candidates
        if isinstance(row, dict) and str(row.get("instrument") or "").strip()
    ]


def comparison_template(packet: dict[str, Any]) -> str:
    rows = []
    for instrument in candidate_instruments(packet):
        rows.append({
            "instrument": instrument,
            "current_auction": "REPLACE",
            "bullish_path": "REPLACE",
            "bearish_path": "REPLACE",
            "next_transition": "REPLACE",
            "triggers": [{
                "trigger_id": "REPLACE_STABLE_ID",
                "source_packet_id": packet.get("packet_id"),
                "path": "BULLISH|BEARISH|NEXT",
                "condition": "REPLACE_FROZEN_CONDITION",
                "expires_utc": packet.get("expires_utc"),
                "status": "HELD|FAILED|EXPIRED",
            }],
        })
    return MARKER + json.dumps({
        "candidates": rows,
        "ranking": [row["instrument"] for row in rows],
        "selected_instrument": packet.get("instrument"),
    }, separators=(",", ":"), ensure_ascii=False)


def validate_comparison_ledger(text: Any, packet: dict[str, Any]) -> dict[str, Any] | None:
    expected = candidate_instruments(packet)
    if len(expected) <= 1:
        return None
    if not isinstance(text, str) or not text.startswith(MARKER):
        raise ValueError("instrument_comparison_missing")
    try:
        value = json.loads(text[len(MARKER):])
    except json.JSONDecodeError as error:
        raise ValueError("instrument_comparison_invalid_json") from error
    if not isinstance(value, dict):
        raise ValueError("instrument_comparison_invalid")
    candidates = value.get("candidates")
    if not isinstance(candidates, list):
        raise ValueError("instrument_candidates_missing")
    actual = [
        str(row.get("instrument") or "").upper()
        for row in candidates if isinstance(row, dict)
    ]
    if len(actual) != len(candidates) or set(actual) != set(expected) or len(set(actual)) != len(actual):
        raise ValueError("instrument_candidates_incomplete")
    for row in candidates:
        assert isinstance(row, dict)
        for field in PATH_FIELDS:
            if not isinstance(row.get(field), str) or not row[field].strip() or row[field] == "REPLACE":
                raise ValueError(f"instrument_candidate_field_invalid:{row.get('instrument')}:{field}")
        triggers = row.get("triggers")
        if not isinstance(triggers, list) or not triggers:
            raise ValueError("instrument_triggers_invalid")
        for trigger in triggers:
            if not isinstance(trigger, dict):
                raise ValueError("instrument_trigger_invalid")
            required = {"trigger_id", "source_packet_id", "path", "condition", "expires_utc", "status"}
            if set(trigger) != required:
                raise ValueError("instrument_trigger_fields_invalid")
            if trigger.get("source_packet_id") != packet.get("packet_id"):
                raise ValueError("instrument_trigger_source_mismatch")
            if trigger.get("status") not in TRIGGER_STATUSES:
                raise ValueError("instrument_trigger_status_invalid")
            if not all(isinstance(trigger.get(field), str) and trigger[field].strip() for field in required):
                raise ValueError("instrument_trigger_value_invalid")
    ranking = value.get("ranking")
    if not isinstance(ranking, list) or set(map(str.upper, ranking)) != set(expected) or len(ranking) != len(expected):
        raise ValueError("instrument_ranking_incomplete")
    selected = value.get("selected_instrument")
    if selected is not None and str(selected).upper() not in expected:
        raise ValueError("selected_instrument_invalid")
    return value
