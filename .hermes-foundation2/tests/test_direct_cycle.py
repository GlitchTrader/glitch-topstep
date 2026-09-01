import argparse
import copy
import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "topstep_cycle",
    SCRIPTS / "run-topstep-cycle.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
PARITY = importlib.import_module("parity")


def packet(
    minute: int = 5,
    *,
    positioned: bool = False,
    state_complete: bool = True,
    session_open: bool = True,
) -> dict:
    stamp = (
        datetime(2099, 1, 1, 14, minute, tzinfo=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    return {
        "schema_version": "glitch.direct.decision_packet.v2",
        "packet_id": f"packet-{minute}",
        "created_utc": stamp,
        "expires_utc": "2099-01-01T15:00:00Z",
        "venue": "projectx",
        "firm": "topstep",
        "instrument": "MNQ",
        "account": {
            "id": 123,
            "name": "TopstepX-50K",
            "simulated": True,
            "can_trade": True,
            "balance": 1000,
            "unrealized_pnl": 0,
            "conservative_equity": 1000,
            "total_open_contracts": 1 if positioned else 0,
            "instrument_open_contracts": 1 if positioned else 0,
            "working_orders": 2 if positioned else 0,
        },
        "contract": {
            "id": "CON",
            "name": "MNQ U99",
            "description": "Micro Nasdaq",
            "symbol_id": "F.US.MNQ",
            "tick_size": 0.25,
            "tick_value": 0.5,
            "active_contract": True,
        },
        "market": {
            "snapshot_hash": "hash-1",
            "quote_timestamp": stamp,
            "last": 20000,
            "bid": 19999.75,
            "ask": 20000.25,
            "spread_ticks": 2,
            "session_open": 19950,
            "session_high": 20020,
            "session_low": 19920,
            "volume": 1000,
        },
        "data_quality": {
            "state_complete": state_complete,
            "issues": [] if state_complete else ["market_stream_reconnecting"],
            "quote_age_ms": 1000,
        },
        "order_flow": {
            "observation": {
                "windows": [
                    {"window_seconds": 60, "trade_count": 42, "rolling_delta": 0},
                ],
            },
        },
        "policy": {
            "account_stage": "express_funded_standard",
            "authority": "operator_configured",
            "verified_at_utc": None,
            "loss_model": "express_funded_eod",
            "starting_balance": 50000,
            "initial_maximum_loss": 2000,
            "highest_end_of_day_balance": 0,
            "hard_loss_floor_usd": -2000,
            "current_buffer_usd": 3000,
            "max_contracts": 5,
        },
        "session": {
            "authority": "operator_configured",
            "must_flat_utc": "2099-01-01T20:00:00Z",
            "entry_window_open": session_open,
            "notes": [],
        },
        "execution": {
            "gateway_mode": "shadow",
            "new_exposure_technically_supported": state_complete,
            "maximum_additional_contracts": 2,
            "supported_actions": [
                "ENTER_LONG",
                "ENTER_SHORT",
                "HOLD",
                "EXIT",
                "NOTHING",
            ],
            "authority": "Hermes decides",
        },
        "required_output_template": {
            "schema_version": "glitch.intent.v2",
            "intent_id": "GENERATE_UUID",
            "created_utc": stamp,
            "instrument": "MNQ",
            "account": "TopstepX-50K",
            "operator_profile": "glitch-topstep",
            "action": "HOLD" if positioned else "NOTHING",
            "confidence": 0.5,
            "snapshot_hash": "hash-1",
            "model_version": "CONFIGURED_MODEL",
            "prompt_version": "glitch-topstep-v2",
            "reason": "Replace",
            "decision_audit": {
                field: (
                    "HOLD" if positioned else "NOTHING"
                ) if field == "final_choice" else "Replace"
                for field in MODULE.AUDIT_FIELDS
            },
        },
    }


def intent(action: str = "NOTHING", quantity: int = 1) -> dict:
    value = {
        "schema_version": "glitch.intent.v2",
        "intent_id": "00000000-0000-4000-8000-000000000001",
        "created_utc": "2099-01-01T14:05:01Z",
        "instrument": "MNQ",
        "account": "TopstepX-50K",
        "operator_profile": "glitch-topstep",
        "action": action,
        "confidence": 0.6,
        "snapshot_hash": "hash-1",
        "model_version": "gpt-5.6-luna",
        "prompt_version": "glitch-topstep-v2",
        "reason": "Evidence supports this decision.",
        "decision_audit": {
            field: action if field == "final_choice" else "Evidence"
            for field in MODULE.AUDIT_FIELDS
        },
    }
    if action == "ENTER_LONG":
        value.update(
            quantity=quantity,
            order_type="MARKET",
            stop_loss=19990,
            take_profit_1=20020,
        )
    if action == "ENTER_SHORT":
        value.update(
            quantity=quantity,
            order_type="MARKET",
            stop_loss=20010,
            take_profit_1=19980,
        )
    if action == "MOVE_STOP":
        value.update(new_stop_price=19995)
    if action == "MOVE_TP":
        value.update(new_take_profit=20025)
    if action == "EXIT" and quantity > 0:
        value.update(quantity=quantity)
    return value


def proven_protection_packet(**kwargs):
    current = packet(positioned=True, **kwargs)
    current["execution"]["supported_actions"] = [
        "HOLD",
        "EXIT",
        "MOVE_STOP",
        "MOVE_TP",
        "NOTHING",
    ]
    current["protection"] = {
        "status": "proven",
        "protection_status": "confirmed",
        "reason": "all_tranches_protected",
        "intent_id": "00000000-0000-4000-8000-000000000101",
        "stop": {"provider_order_id": 1, "custom_tag": "glt-sl", "price": 19990},
        "target": {"provider_order_id": 2, "custom_tag": "glt-tp", "price": 20020},
        "tranches": [
            {
                "intent_id": "00000000-0000-4000-8000-000000000101",
                "entry_order_id": 100,
                "filled_qty": 1,
                "remaining_qty": 1,
                "created_utc": "2099-01-01T14:05:00Z",
                "protection": {
                    "status": "proven",
                    "reason": "matched",
                    "stop": {"provider_order_id": 1, "custom_tag": "glt-sl", "price": 19990},
                    "target": {"provider_order_id": 2, "custom_tag": "glt-tp", "price": 20020},
                },
            }
        ],
    }
    return current


class DirectCycleTests(unittest.TestCase):
    def test_packet_for_model_strips_provider_ids(self):
        value = MODULE.packet_for_model(packet())
        self.assertNotIn("id", value["account"])
        self.assertNotIn("id", value["contract"])
        self.assertNotIn("symbol_id", value["contract"])

    def test_flat_default_cadence_is_every_minute(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GLITCH_TOPSTEP_FLAT_DECISION_INTERVAL_MINUTES", None)
            self.assertTrue(MODULE.should_invoke(packet(6), None))

    def test_configurable_cadence_is_scheduling_not_eligibility(self):
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_FLAT_DECISION_INTERVAL_MINUTES": "5"},
        ):
            self.assertTrue(
                MODULE.should_invoke(packet(5, state_complete=False), None)
            )
            self.assertFalse(MODULE.should_invoke(packet(6), None))

    def test_positioned_and_directive_wake_cycle(self):
        self.assertTrue(MODULE.should_invoke(packet(6, positioned=True), None))
        self.assertTrue(MODULE.should_invoke(packet(6), {"status": "pending"}))

    def test_evidence_fingerprint_ignores_snapshot_hash(self):
        first = packet(6)
        second = copy.deepcopy(first)
        second["packet_id"] = "packet-6b"
        second["market"]["snapshot_hash"] = "hash-2"
        second["data_quality"]["quote_age_ms"] = 99999
        self.assertEqual(
            MODULE.evidence_fingerprint(first),
            MODULE.evidence_fingerprint(second),
        )

    def test_skip_unchanged_evidence_when_flat(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            current = packet(6)
            MODULE.write_last_evidence_fingerprint(
                state,
                current,
                MODULE.evidence_fingerprint(current),
            )
            with mock.patch.dict(
                os.environ,
                {"GLITCH_TOPSTEP_SKIP_UNCHANGED_EVIDENCE": "true"},
            ):
                self.assertTrue(
                    MODULE.should_skip_unchanged_evidence(current, None, state)
                )

    def test_default_worker_does_not_skip_unchanged_or_stale_flat_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            current = packet(6)
            current["data_quality"]["quote_age_ms"] = 12000
            MODULE.write_last_evidence_fingerprint(
                state, current, MODULE.evidence_fingerprint(current)
            )
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT", None)
                os.environ.pop("GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE", None)
                self.assertFalse(
                    MODULE.should_skip_unchanged_evidence(current, None, state)
                )
                self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_flat_frame_count_is_context_window_not_model_gate(self):
        source = (SCRIPTS / "run-topstep-cycle.py").read_text(encoding="utf-8")
        self.assertNotIn("len(frames) < decision_frame_count()", source)

    def test_never_skip_unchanged_evidence_when_positioned(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            current = packet(6, positioned=True)
            MODULE.write_last_evidence_fingerprint(
                state,
                current,
                MODULE.evidence_fingerprint(current),
            )
            with mock.patch.dict(
                os.environ,
                {"GLITCH_TOPSTEP_SKIP_UNCHANGED_EVIDENCE": "true"},
            ):
                self.assertFalse(
                    MODULE.should_skip_unchanged_evidence(current, None, state)
                )

    def test_fingerprint_changes_when_price_changes(self):
        first = packet(6)
        second = copy.deepcopy(first)
        second["market"]["last"] = float(second["market"]["last"]) + 1.0
        self.assertNotEqual(
            MODULE.evidence_fingerprint(first),
            MODULE.evidence_fingerprint(second),
        )

    def test_market_quiescent_skip_not_when_tape_active(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 12000
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_market_quiescent_skip_not_when_positioned(self):
        current = packet(6, positioned=True)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_market_quiescent_skip_on_stale_quote_and_zero_tape(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            details = PARITY.market_quiescent_skip_details(current, None)
        self.assertIsNotNone(details)
        assert details is not None
        self.assertEqual(details["reason"], "market_quiescent")
        self.assertEqual(details["order_flow_trade_count_60s"], 0)

    def test_market_quiescent_legacy_stale_env_alias(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT", None)
            with mock.patch.dict(
                os.environ,
                {"GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE": "true"},
            ):
                self.assertEqual(
                    PARITY.market_quiescent_skip_reason(current, None),
                    "market_quiescent",
                )

    def test_stale_gateway_skip_not_when_state_incomplete(self):
        current = packet(6, state_complete=False)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_stale_gateway_skip_not_when_positioned(self):
        current = packet(6, positioned=True)
        current["data_quality"]["quote_age_ms"] = 12000
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_stale_gateway_skip_on_quote_age_when_explicitly_enabled(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_STALE_GATEWAY_EVIDENCE": "true"},
        ):
            self.assertEqual(
                PARITY.stale_gateway_skip_reason(current, None),
                "market_quiescent",
            )

    def test_market_quiescent_prefers_stream_health(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 1000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 42
        current["stream_health"] = {
            "quote_age_ms": 12000,
            "trade_count_60s": 0,
            "reconnect_pending": False,
        }
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            details = PARITY.market_quiescent_skip_details(current, None)
        self.assertIsNotNone(details)
        assert details is not None
        self.assertEqual(details["evidence_source"], "stream_health")
        self.assertEqual(details["trade_count_60s"], 0)

    def test_market_quiescent_not_when_reconnect_pending(self):
        current = packet(6)
        current["data_quality"]["quote_age_ms"] = 12000
        current["order_flow"]["observation"]["windows"][0]["trade_count"] = 0
        current["stream_health"] = {
            "quote_age_ms": 12000,
            "trade_count_60s": 0,
            "reconnect_pending": True,
        }
        with mock.patch.dict(
            os.environ,
            {"GLITCH_TOPSTEP_SKIP_MARKET_QUIESCENT": "true"},
        ):
            self.assertIsNone(PARITY.market_quiescent_skip_details(current, None))

    def test_session_maintenance_skip_when_flat(self):
        current = packet(6)
        current["session"]["phase"] = "maintenance"
        details = PARITY.session_maintenance_skip_details(current, None)
        self.assertIsNotNone(details)
        assert details is not None
        self.assertEqual(details["reason"], "session_maintenance")
        self.assertEqual(details["session_phase"], "maintenance")

    def test_session_maintenance_skip_not_when_positioned(self):
        current = packet(6, positioned=True)
        current["session"]["phase"] = "maintenance"
        self.assertIsNone(PARITY.session_maintenance_skip_details(current, None))

    def test_session_maintenance_skip_not_when_regular(self):
        current = packet(6)
        current["session"]["phase"] = "regular"
        self.assertIsNone(PARITY.session_maintenance_skip_details(current, None))

    def test_retry_after_failure_blocks_unchanged_skip(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            attempts = state / "attempts"
            attempts.mkdir(parents=True)
            write_json = MODULE.write_json_atomic
            write_json(
                attempts / "prior.json",
                {
                    "schema_version": "glitch.topstep.model_attempt.v2",
                    "packet_id": "prior",
                    "status": "failed",
                },
            )
            current = packet(6)
            write_json(
                state / "last-evidence.json",
                {
                    "schema_version": "glitch.topstep.last_evidence.v1",
                    "fingerprint": MODULE.evidence_fingerprint(current),
                },
            )
            with mock.patch.dict(
                os.environ,
                {"GLITCH_TOPSTEP_SKIP_UNCHANGED_EVIDENCE": "true"},
            ):
                self.assertFalse(
                    MODULE.should_skip_unchanged_evidence(
                        current,
                        None,
                        state,
                    )
                )

    def test_entry_is_not_pre_gated_by_gateway_capacity_metadata(self):
        current_packet = packet(state_complete=False)
        value = MODULE.normalize_intent(intent("ENTER_LONG", 9), current_packet)
        MODULE.validate_intent(value, current_packet)

    def test_positioned_entry_reaches_gateway_for_factual_handling(self):
        current_packet = packet(positioned=True)
        value = MODULE.normalize_intent(intent("ENTER_LONG"), current_packet)
        MODULE.validate_intent(value, current_packet)

    def test_wire_validation_still_rejects_bad_geometry(self):
        current_packet = packet()
        value = MODULE.normalize_intent(intent("ENTER_LONG"), current_packet)
        value["stop_loss"] = 20010
        with self.assertRaisesRegex(ValueError, "long_geometry_invalid"):
            MODULE.validate_intent(value, current_packet)

    def test_move_stop_requires_gateway_support(self):
        current_packet = packet(positioned=True)
        value = MODULE.normalize_intent(
            {
                **intent("HOLD"),
                "action": "MOVE_STOP",
                "decision_audit": {
                    field: "MOVE_STOP" if field == "final_choice" else "Evidence"
                    for field in MODULE.AUDIT_FIELDS
                },
                "new_stop_price": 19995,
            },
            current_packet,
        )
        with self.assertRaisesRegex(ValueError, "action_not_supported_by_gateway"):
            MODULE.validate_intent(value, current_packet)

    def test_move_stop_accepts_proven_protection_packet(self):
        current_packet = packet(positioned=True)
        current_packet["execution"]["supported_actions"] = [
            "HOLD",
            "EXIT",
            "MOVE_STOP",
            "MOVE_TP",
            "NOTHING",
        ]
        current_packet["protection"] = {
            "status": "proven",
            "protection_status": "confirmed",
            "reason": "all_tranches_protected",
            "intent_id": "00000000-0000-4000-8000-000000000101",
            "stop": {
                "provider_order_id": 1,
                "custom_tag": "glt-sl",
                "price": 19990,
            },
            "target": {
                "provider_order_id": 2,
                "custom_tag": "glt-tp",
                "price": 20020,
            },
            "tranches": [
                {
                    "intent_id": "00000000-0000-4000-8000-000000000101",
                    "entry_order_id": 100,
                    "filled_qty": 1,
                    "remaining_qty": 1,
                    "created_utc": "2099-01-01T14:05:00Z",
                    "protection": {
                        "status": "proven",
                        "reason": "matched",
                        "stop": {
                            "provider_order_id": 1,
                            "custom_tag": "glt-sl",
                            "price": 19990,
                        },
                        "target": {
                            "provider_order_id": 2,
                            "custom_tag": "glt-tp",
                            "price": 20020,
                        },
                    },
                }
            ],
        }
        value = MODULE.normalize_intent(
            {
                **intent("HOLD"),
                "action": "MOVE_STOP",
                "decision_audit": {
                    field: "MOVE_STOP" if field == "final_choice" else "Evidence"
                    for field in MODULE.AUDIT_FIELDS
                },
                "new_stop_price": 19995,
            },
            current_packet,
        )
        MODULE.validate_intent(value, current_packet)

    def _positioned_protection_packet(self, *, protection_status: str) -> dict[str, Any]:
        current_packet = packet(positioned=True)
        current_packet["execution"]["supported_actions"] = [
            "HOLD",
            "EXIT",
            "MOVE_STOP",
            "MOVE_TP",
            "NOTHING",
        ]
        current_packet["protection"] = {
            "status": "proven" if protection_status == "confirmed" else "pending",
            "protection_status": protection_status,
            "reason": "test",
            "intent_id": "00000000-0000-4000-8000-000000000101",
            "stop": {"provider_order_id": 1, "custom_tag": "glt-sl", "price": 19990},
            "target": {"provider_order_id": 2, "custom_tag": "glt-tp", "price": 20020},
            "tranches": [
                {
                    "intent_id": "00000000-0000-4000-8000-000000000101",
                    "entry_order_id": 100,
                    "filled_qty": 1,
                    "remaining_qty": 1,
                    "created_utc": "2099-01-01T14:05:00Z",
                    "protection": {
                        "status": "proven" if protection_status == "confirmed" else "pending",
                        "reason": "matched",
                        "stop": {
                            "provider_order_id": 1,
                            "custom_tag": "glt-sl",
                            "price": 19990,
                        },
                        "target": {
                            "provider_order_id": 2,
                            "custom_tag": "glt-tp",
                            "price": 20020,
                        },
                    },
                }
            ],
        }
        return current_packet

    def test_move_stop_rejected_when_protection_status_pending(self):
        current_packet = self._positioned_protection_packet(protection_status="pending")
        value = MODULE.normalize_intent(
            {
                **intent("HOLD"),
                "action": "MOVE_STOP",
                "decision_audit": {
                    field: "MOVE_STOP" if field == "final_choice" else "Evidence"
                    for field in MODULE.AUDIT_FIELDS
                },
                "new_stop_price": 19995,
            },
            current_packet,
        )
        with self.assertRaisesRegex(ValueError, "protection_status_not_confirmed"):
            MODULE.validate_intent(value, current_packet)

    def test_move_stop_rejected_when_protection_status_failed(self):
        current_packet = self._positioned_protection_packet(protection_status="failed")
        value = MODULE.normalize_intent(
            {
                **intent("HOLD"),
                "action": "MOVE_STOP",
                "decision_audit": {
                    field: "MOVE_STOP" if field == "final_choice" else "Evidence"
                    for field in MODULE.AUDIT_FIELDS
                },
                "new_stop_price": 19995,
            },
            current_packet,
        )
        with self.assertRaisesRegex(ValueError, "protection_status_not_confirmed"):
            MODULE.validate_intent(value, current_packet)

    def test_packet_protection_status_legacy_proven_maps_to_confirmed(self):
        current_packet = packet(positioned=True)
        current_packet["protection"] = {"status": "proven"}
        self.assertEqual(PARITY.packet_protection_status(current_packet), "confirmed")

    def test_packet_protection_status_none_when_flat(self):
        self.assertIsNone(PARITY.packet_protection_status(packet()))

    def test_protection_status_management_guidance_for_failed(self):
        guidance = PARITY.protection_status_management_guidance("failed")
        self.assertIn("failed", guidance or "")
        self.assertIn("EXIT", guidance or "")

    def test_resolve_wake_invocation_context_clears_pending_wake(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            PARITY.write_pending_wake_invocation(
                state,
                {
                    "wake_reason": "PRICE_CROSS:ABOVE:20000.0",
                    "wake_trigger": {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0},
                    "trigger_key": "PRICE_CROSS:ABOVE:20000.0",
                },
                packet(),
            )
            detail, source = MODULE.resolve_wake_invocation_context(
                state,
                packet(),
                None,
                PARITY.read_pending_wake_invocation(state),
            )
        self.assertEqual(source, "monitor")
        self.assertEqual(detail["wake_reason"], "PRICE_CROSS:ABOVE:20000.0")
        self.assertIsNone(PARITY.read_pending_wake_invocation(state))

    def test_prompt_includes_protection_management_when_positioned(self):
        current_packet = self._positioned_protection_packet(protection_status="pending")
        prompt = MODULE.build_prompt(current_packet, [], {}, None)
        envelope = json.loads(prompt.split("CURRENT_CYCLE=", 1)[1])
        self.assertIn("pending", envelope["protection_management"])
        self.assertIn("protection.protection_status", prompt)

    def test_prompt_states_position_management(self):
        value = MODULE.build_prompt(packet(positioned=True), [], {}, None)
        self.assertIn("MOVE_STOP", value)
        self.assertIn("execution.supported_actions", value)

    def test_prompt_states_agent_authority(self):
        value = MODULE.build_prompt(packet(state_complete=False), [], {}, None)
        self.assertIn("You are the trading operator", value)
        self.assertIn("not automatic cognitive veto", value)
        self.assertIn("gateway independently verifies", value)

    def test_prompt_recent_frames_use_compact_snapshots(self):
        frame = {
            "schema_version": "glitch.topstep.minute_frame.v2",
            "minute_id": "20990101T1404Z",
            "captured_utc": "2099-01-01T14:04:01Z",
            "packet": packet(4),
        }
        prompt = MODULE.build_prompt(packet(5), [frame], {}, None)
        envelope = json.loads(prompt.split("CURRENT_CYCLE=", 1)[1])
        self.assertEqual(
            envelope["recent_frames"][0]["schema_version"],
            "glitch.topstep.frame_snapshot.v2",
        )
        self.assertNotIn(
            "required_output_template",
            envelope["recent_frames"][0]["packet"],
        )
        self.assertNotIn("required_output_template", envelope["decision_packet"])
        self.assertIn("required_output_template", envelope)

    def test_adaptive_decision_frame_count_uses_fewer_frames_when_flat(self):
        with mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_FLAT_FRAME_COUNT": "4"}):
            self.assertEqual(MODULE.adaptive_decision_frame_count(packet()), 4)
            self.assertEqual(
                MODULE.adaptive_decision_frame_count(packet(positioned=True)),
                MODULE.decision_frame_count(),
            )

    def test_cycle_recent_frames_excludes_current_packet(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            current = packet(5)
            prior = packet(4)
            MODULE.capture_frame(prior, state)
            MODULE.capture_frame(current, state)
            frames = MODULE.cycle_recent_frames(state, current)
            packet_ids = [
                frame["packet"]["packet_id"]
                for frame in frames
                if isinstance(frame.get("packet"), dict)
            ]
            self.assertNotIn(current["packet_id"], packet_ids)
            self.assertIn(prior["packet_id"], packet_ids)

    def test_decision_frame_count_defaults_to_five(self):
        self.assertEqual(MODULE.decision_frame_count(), 5)

    def test_decision_frame_count_reads_env(self):
        with mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_DECISION_FRAME_COUNT": "3"}):
            self.assertEqual(MODULE.decision_frame_count(), 3)

    def test_frame_capture_accepts_first_frame(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            MODULE.capture_frame(packet(1), state)
            self.assertEqual(len(MODULE.recent_frames(state, 5)), 1)

    def test_extract_single_json_accepts_transport_chatter(self):
        raw = "status\n" + json.dumps(intent()) + "\ndone"
        value = MODULE.extract_single_json_object(
            raw,
            schema="glitch.intent.v2",
        )
        self.assertEqual(value["action"], "NOTHING")

    def test_prepare_intent_for_delivery_refreshes_snapshot_hash(self):
        current_packet = packet()
        fresh_packet = copy.deepcopy(current_packet)
        fresh_packet["market"]["snapshot_hash"] = "hash-2"
        with mock.patch.object(
            MODULE,
            "request_json",
            side_effect=[(200, fresh_packet)],
        ), mock.patch.object(MODULE, "local_token", return_value="token"), mock.patch.object(
            MODULE,
            "packet_is_current",
            return_value=True,
        ):
            aligned = MODULE.prepare_intent_for_delivery(intent(), None)
        self.assertEqual(aligned["snapshot_hash"], "hash-2")

    def test_prepare_intent_for_delivery_validates_wake_triggers_before_stripping_them(self):
        value = intent()
        value["decision_audit"]["change_condition"] = (
            "Enter long above 20010 or short below 19990."
        )
        value["wake_triggers"] = [
            {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20010},
            {"type": "PRICE_CROSS", "direction": "BELOW", "price": 19990},
        ]
        with mock.patch.object(
            MODULE,
            "request_json",
            return_value=(200, packet()),
        ), mock.patch.object(
            MODULE,
            "local_token",
            return_value="token",
        ), mock.patch.object(
            MODULE,
            "packet_is_current",
            return_value=True,
        ):
            delivered = MODULE.prepare_intent_for_delivery(value, None)
        self.assertNotIn("wake_triggers", delivered)

    def test_prepare_intent_for_delivery_allows_missing_wake_trigger_for_change_condition(self):
        value = intent()
        value["decision_audit"]["change_condition"] = "Enter long above 20010."
        value["wake_triggers"] = []
        with mock.patch.object(
            MODULE,
            "request_json",
            return_value=(200, packet()),
        ), mock.patch.object(
            MODULE,
            "local_token",
            return_value="token",
        ), mock.patch.object(
            MODULE,
            "packet_is_current",
            return_value=True,
        ):
            delivered = MODULE.prepare_intent_for_delivery(value, None)
        self.assertNotIn("wake_triggers", delivered)

    def test_build_prompt_template_uses_neutral_placeholders(self):
        prompt = MODULE.build_prompt(packet(), [], {}, None)
        envelope = json.loads(prompt.split("CURRENT_CYCLE=", 1)[1])
        template = envelope["required_output_template"]
        self.assertEqual(template["action"], MODULE.ACTION_PLACEHOLDER)
        self.assertEqual(template["confidence"], MODULE.CONFIDENCE_PLACEHOLDER)
        self.assertEqual(template["decision_audit"]["final_choice"], MODULE.ACTION_PLACEHOLDER)
        self.assertIn("prior_hypothesis=", template["decision_audit"]["decisive_evidence"])
        self.assertIn("Rebuild LONG, SHORT, and flat hypotheses", prompt)
        self.assertIn("wake_triggers is optional", prompt)
        self.assertIn("NOTHING while flat", prompt)
        self.assertIn("HOLD while positioned", prompt)
        self.assertNotIn("flat NOTHING or HOLD", prompt)
        self.assertIn("recent_glitch_ledger as the primary continuity source", prompt)
        self.assertIn("never choose HOLD while flat", prompt)
        self.assertIsNone(envelope["cycle_evidence_delta"])

    def test_build_prompt_includes_cycle_evidence_delta(self):
        frame = {
            "schema_version": "glitch.topstep.minute_frame.v2",
            "minute_id": "20990101T1404Z",
            "captured_utc": "2099-01-01T14:04:01Z",
            "packet": packet(4),
        }
        prompt = MODULE.build_prompt(packet(5), [frame], {}, None)
        envelope = json.loads(prompt.split("CURRENT_CYCLE=", 1)[1])
        delta = envelope["cycle_evidence_delta"]
        self.assertIsInstance(delta, dict)
        self.assertEqual(delta["prior_minute_id"], "20990101T1404Z")

    def test_normalize_intent_rejects_action_placeholder(self):
        value = intent()
        value["action"] = MODULE.ACTION_PLACEHOLDER
        with self.assertRaisesRegex(ValueError, "action_placeholder_not_replaced"):
            MODULE.normalize_intent(value, packet())

    def test_validate_intent_rejects_wake_triggers_on_entry(self):
        value = intent("ENTER_LONG")
        value["wake_triggers"] = [
            {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20010},
        ]
        with self.assertRaisesRegex(ValueError, "wake_triggers_not_allowed_for_action"):
            MODULE.validate_intent(value, packet())

    def test_post_intent_strips_wake_triggers(self):
        value = intent()
        value["wake_triggers"] = [
            {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20010},
        ]
        with mock.patch.object(MODULE, "request_json") as request_json:
            request_json.return_value = (200, {"status": "accepted"})
            with mock.patch.object(MODULE, "local_token", return_value="token"):
                MODULE.post_intent(value)
        posted = request_json.call_args.kwargs["body"]
        self.assertNotIn("wake_triggers", posted)

    def test_prepare_intent_for_delivery_truncates_gateway_string_fields(self):
        value = MODULE.normalize_intent(intent(), packet())
        value["reason"] = "r" * 1100
        value["decision_audit"]["bear_case"] = "x" * (MODULE.GATEWAY_AUDIT_FIELD_MAX_LENGTH + 100)
        value["decision_audit"]["decisive_evidence"] = "y" * (MODULE.GATEWAY_AUDIT_FIELD_MAX_LENGTH + 86)
        with mock.patch.object(MODULE, "request_json") as request_json:
            request_json.return_value = (200, packet())
            with mock.patch.object(MODULE, "local_token", return_value="test-token"):
                with mock.patch.object(MODULE, "packet_is_current", return_value=True):
                    delivered = MODULE.prepare_intent_for_delivery(value, None)
        self.assertEqual(len(delivered["reason"]), MODULE.GATEWAY_REASON_MAX_LENGTH)
        self.assertEqual(len(delivered["decision_audit"]["bear_case"]), MODULE.GATEWAY_AUDIT_FIELD_MAX_LENGTH)
        self.assertEqual(len(delivered["decision_audit"]["decisive_evidence"]), MODULE.GATEWAY_AUDIT_FIELD_MAX_LENGTH)

    def test_invocation_reason_first_packet_without_last_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            reason = PARITY.invocation_reason(packet(5), state, None, flat_decision_interval_minutes=5)
        self.assertEqual(reason, "first_packet")

    def test_invocation_reason_scheduled_on_cadence(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            MODULE.write_json_atomic(
                state / "last-evidence.json",
                {"schema_version": "glitch.topstep.last_evidence.v1", "fingerprint": "x"},
            )
            reason = PARITY.invocation_reason(packet(5), state, None, flat_decision_interval_minutes=5)
        self.assertEqual(reason, "scheduled")

    def test_invocation_reason_skips_flat_outside_session_window(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            MODULE.write_json_atomic(
                state / "last-evidence.json",
                {"schema_version": "glitch.topstep.last_evidence.v1", "fingerprint": "x"},
            )
            with mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_RESPECT_SESSION_GATE": "true"}, clear=False):
                reason = PARITY.invocation_reason(
                    packet(5, session_open=False),
                    state,
                    None,
                    flat_decision_interval_minutes=5,
                )
        self.assertIsNone(reason)

    def test_invocation_reason_positioned_outside_session_still_invokes(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            with mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_RESPECT_SESSION_GATE": "true"}, clear=False):
                reason = PARITY.invocation_reason(
                    packet(5, positioned=True, session_open=False),
                    state,
                    None,
                    flat_decision_interval_minutes=5,
                )
        self.assertEqual(reason, "positioned")

    def test_invocation_reason_session_override_allows_scheduled_flat(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            MODULE.write_json_atomic(
                state / "last-evidence.json",
                {"schema_version": "glitch.topstep.last_evidence.v1", "fingerprint": "x"},
            )
            with mock.patch.dict(
                os.environ,
                {
                    "GLITCH_TOPSTEP_RESPECT_SESSION_GATE": "true",
                    "GLITCH_TOPSTEP_SESSION_GATE_OVERRIDE": "true",
                },
                clear=False,
            ):
                reason = PARITY.invocation_reason(
                    packet(5, session_open=False),
                    state,
                    None,
                    flat_decision_interval_minutes=5,
                )
        self.assertEqual(reason, "scheduled")

    def test_wake_trigger_fires_on_price_cross(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            supervisor = state / "supervisor"
            supervisor.mkdir(parents=True)
            frames = state / "minute-frames"
            frames.mkdir(parents=True)
            prior = packet(4)
            prior["market"]["last"] = 19990.0
            MODULE.write_json_atomic(
                frames / "20990101T1404Z.json",
                {"minute_id": "20990101T1404Z", "packet": prior},
            )
            current = packet(5)
            current["market"]["last"] = 20010.0
            MODULE.write_json_atomic(
                PARITY.wake_trigger_path(supervisor),
                {
                    "schema_version": "glitch.topstep.wake_triggers.v1",
                    "triggers": [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                },
            )
            self.assertTrue(PARITY.wake_trigger_fired(state, current))

    def test_classify_delivery_result_transport_uncertain(self):
        self.assertEqual(
            PARITY.classify_delivery_result({"transport_error": "timeout"}),
            "transport_uncertain",
        )
        self.assertEqual(
            PARITY.classify_delivery_result({"http_status": 500, "body": {}}),
            "transport_uncertain",
        )
        self.assertEqual(
            PARITY.classify_delivery_result(
                {
                    "http_status": 503,
                    "body": {"code": "intent_delivery_unreconciled"},
                }
            ),
            "transport_uncertain",
        )

    def test_deliver_packet_intent_freezes_wire_on_transport_retry(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            intent_body = intent("MOVE_STOP")
            intent_body["intent_id"] = "00000000-0000-4000-8000-00000000c013"
            intent_body["snapshot_hash"] = "hash-outbox"
            intent_body["new_stop_price"] = 20000.0
            posts: list[dict[str, Any]] = []
            prepare_calls = 0

            def fake_prepare(value, _directive):
                nonlocal prepare_calls
                prepare_calls += 1
                aligned = copy.deepcopy(value)
                aligned["snapshot_hash"] = f"hash-prepared-{prepare_calls}"
                return aligned

            def fake_post(wire):
                posts.append(copy.deepcopy(wire))
                if len(posts) == 1:
                    return {"transport_error": "timeout"}
                return {
                    "http_status": 202,
                    "body": {
                        "schema_version": "glitch.direct.execution_receipt.v1",
                        "intent_id": intent_body["intent_id"],
                        "status": "pending",
                        "code": "move_stop_submitted_pending_reconciliation",
                    },
                }

            first = PARITY.deliver_packet_intent(
                state,
                "packet-13",
                intent_body,
                None,
                fake_post,
                fake_prepare,
            )
            second = PARITY.deliver_packet_intent(
                state,
                "packet-13",
                intent_body,
                None,
                fake_post,
                fake_prepare,
            )

        self.assertEqual(first.get("transport_error"), "timeout")
        self.assertEqual(second.get("http_status"), 202)
        self.assertEqual(prepare_calls, 1)
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["snapshot_hash"], "hash-prepared-1")
        self.assertEqual(posts[1]["snapshot_hash"], "hash-prepared-1")

    def test_deliver_packet_intent_reconciles_body_conflict(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            intent_body = intent("MOVE_STOP")
            intent_body["intent_id"] = "00000000-0000-4000-8000-00000000c014"
            intent_body["snapshot_hash"] = "hash-outbox"
            intent_body["new_stop_price"] = 20000.0
            posts: list[dict[str, Any]] = []

            def fake_prepare(value, _directive):
                aligned = copy.deepcopy(value)
                aligned["snapshot_hash"] = "hash-frozen"
                return aligned

            def fake_post(wire):
                posts.append(copy.deepcopy(wire))
                if len(posts) == 1:
                    return {
                        "http_status": 422,
                        "body": {
                            "code": "intent_body_conflict",
                            "intent_id": intent_body["intent_id"],
                        },
                    }
                return {
                    "http_status": 202,
                    "body": {
                        "schema_version": "glitch.direct.execution_receipt.v1",
                        "intent_id": intent_body["intent_id"],
                        "status": "pending",
                        "code": "move_stop_submitted_pending_reconciliation",
                    },
                }

            result = PARITY.deliver_packet_intent(
                state,
                "packet-14",
                intent_body,
                None,
                fake_post,
                fake_prepare,
            )

        self.assertEqual(result.get("http_status"), 202)
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["snapshot_hash"], "hash-frozen")
        self.assertEqual(posts[1]["snapshot_hash"], "hash-frozen")

    def test_classify_delivery_result_terminal_rejection(self):
        self.assertEqual(
            PARITY.classify_delivery_result({"http_status": 422, "body": {"status": "invalid"}}),
            "terminal_rejection",
        )

    def test_apply_cognitive_overlay_replaces_verified_text(self):
        old = "Replace with the current evidence-based decision."
        overlay = {
            "status": "active",
            "operation": "replace",
            "target": "core_prompt",
            "expected_old_text": old,
            "expected_old_sha256": __import__("hashlib").sha256(old.encode()).hexdigest(),
            "replacement_text": "Use bounded evidence only.",
        }
        rendered = PARITY.apply_cognitive_overlay(f"Before. {old} After.", overlay)
        self.assertIn("Use bounded evidence only.", rendered)
        self.assertNotIn(old, rendered)

    def test_packet_for_outbox_id_finds_stored_frame(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            frames = state / "minute-frames"
            frames.mkdir(parents=True)
            stored = packet(5)
            MODULE.write_json_atomic(
                frames / "20990101T1405Z.json",
                {"minute_id": "20990101T1405Z", "packet": stored},
            )
            found = PARITY.packet_for_outbox_id(state, "packet-5")
        self.assertEqual(found, stored)

    def test_frame_for_packet_id_returns_full_minute_frame(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            frames = state / "minute-frames"
            frames.mkdir(parents=True)
            stored = packet(5)
            frame = {"minute_id": "20990101T1405Z", "packet": stored}
            MODULE.write_json_atomic(frames / "20990101T1405Z.json", frame)
            found = PARITY.frame_for_packet_id(state, "packet-5")
            found_from_frames_root = PARITY.frame_for_packet_id(frames, "packet-5")
        self.assertEqual(found, frame)
        self.assertEqual(found_from_frames_root, frame)

    def test_frame_for_packet_id_ignores_missing_or_corrupt_frames(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            frames = state / "minute-frames"
            frames.mkdir(parents=True)
            (frames / "broken.json").write_text("{not-json", encoding="utf-8")
            (frames / "empty.json").write_text("{}", encoding="utf-8")
            found = PARITY.frame_for_packet_id(state, "packet-5")
        self.assertIsNone(found)

    def test_prune_delivered_outboxes_removes_with_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            outbox = state / "outbox"
            receipts = state / "receipts"
            outbox.mkdir(parents=True)
            receipts.mkdir(parents=True)
            MODULE.write_json_atomic(outbox / "packet-1.json", intent())
            MODULE.write_json_atomic(
                receipts / "packet-1.json",
                {
                    "schema_version": "glitch.topstep.delivery_receipt.v2",
                    "result": {"http_status": 200, "body": {"executor": "ok"}},
                },
            )
            pruned = PARITY.prune_delivered_outboxes(state)
        self.assertEqual(pruned, 1)
        self.assertFalse((outbox / "packet-1.json").exists())

    def test_pending_outbox_validates_against_stored_packet_not_current(self):
        stored = packet(5)
        stored["account"]["name"] = "TopstepX-50K"
        current = packet(6)
        current["market"]["snapshot_hash"] = "hash-other"
        pending_intent = intent("NOTHING")
        pending_intent["decision_audit"]["change_condition"] = (
            "Reassess above 20010 or below 19990."
        )
        pending_intent["wake_triggers"] = [
            {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20010},
            {"type": "PRICE_CROSS", "direction": "BELOW", "price": 19990},
        ]

        with tempfile.TemporaryDirectory() as root:
            profile_root = Path(root)
            state = MODULE.state_root(profile_root)
            state.mkdir(parents=True)
            frames = state / "minute-frames"
            outbox = state / "outbox"
            frames.mkdir(parents=True)
            outbox.mkdir(parents=True)
            MODULE.write_json_atomic(
                frames / "20990101T1405Z.json",
                {"minute_id": "20990101T1405Z", "packet": stored},
            )
            MODULE.write_json_atomic(outbox / "packet-5.json", pending_intent)

            args = argparse.Namespace(
                profile="glitch-topstep",
                timeout_seconds=30,
                packet_rollover_wait_seconds=0,
                dry_run=False,
            )
            def fake_request_json(path, token=None):
                if path == "/health":
                    return (
                        200,
                        {
                            "schema_version": "glitch.direct.health.v2",
                            "status": "ok",
                            "compatibility": {
                                "gateway_name": "glitch-topstep",
                                "protocol_revision": "glitch.topstep.paired.v3",
                                "gateway_version": "0.2.0",
                                "intent_schemas": ["glitch.intent.v2", "glitch.intent.v3"],
                                "decision_packet_schemas": [
                                    "glitch.direct.decision_packet.v1",
                                    "glitch.direct.decision_packet.v2",
                                ],
                                "capabilities": [
                                    "packet_supported_actions",
                                    "durable_mutation_receipts",
                                    "restart_reconciliation",
                                    "bounded_entry_range_v1",
                                    "daily_capture_context_v1",
                                    "explicit_partial_completed_bars_v1",
                                    "revisioned_outcome_feed_v1",
                                    "multi_instrument_observation_v1",
                                    "partial_exit_fail_closed_v1",
                                ],
                                                "semantic_revisions": {
                                                    "bounded_entry_range": "glitch.topstep.entry_range.v1",
                                                    "daily_capture": "glitch.topstep.daily_capture.v1",
                                                    "outcome_feed": "glitch.topstep.outcome_feed.v1",
                                                    "market_universe": "glitch.topstep.market_universe.v1",
                                                    "execution_facts": "glitch.topstep.execution_fact.v1",
                                                },
                                                "provider_acceptance_evidence": {
                                                    "partial_exit_protection_transition": "not_proven_fail_closed",
                                                    "exact_contract_resolution": "catalog_fixture_plus_runtime_resolution",
                                                },
                                                "paired_manifest_schema": "glitch.topstep.paired_release.v1",
                            },
                        },
                    )
                return (200, current)

            with mock.patch.object(MODULE, "local_token", return_value="token"), mock.patch.object(
                MODULE,
                "request_json",
                side_effect=fake_request_json,
            ), mock.patch.object(MODULE, "wait_for_packet_rollover", return_value=current), mock.patch.object(
                MODULE,
                "packet_is_current",
                return_value=True,
            ), mock.patch.object(
                MODULE,
                "post_intent",
                return_value={"http_status": 200, "body": {"executor": "ok"}},
            ) as post_intent:
                exit_code = MODULE.run_once(args, profile_root)

        self.assertEqual(exit_code, 0)
        post_intent.assert_called_once()
        self.assertFalse((outbox / "packet-5.json").exists())

    def test_main_records_detached_worker_failure(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            MODULE,
            "configure_environment",
            return_value=Path(root),
        ), mock.patch.object(
            MODULE,
            "acquire_cycle_lock",
            return_value=True,
        ), mock.patch.object(
            MODULE,
            "run_once",
            side_effect=ValueError("wake_triggers_missing_for_change_condition"),
        ), mock.patch.object(
            sys,
            "argv",
            ["run-topstep-cycle.py"],
        ):
            with self.assertRaisesRegex(
                ValueError,
                "wake_triggers_missing_for_change_condition",
            ):
                MODULE.main()
            status = json.loads(
                (
                    Path(root)
                    / "state"
                    / "supervisor"
                    / "direct-worker-status.json"
                ).read_text(encoding="utf-8")
            )
        self.assertEqual(status["status"], "failed")
        self.assertIn("wake_triggers_missing_for_change_condition", status["error"])

    def test_discard_stale_outbox_intent_only_when_stored_packet_missing(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            outbox = state / "outbox"
            frames = state / "minute-frames"
            outbox.mkdir(parents=True)
            frames.mkdir(parents=True)
            stored = packet(5)
            MODULE.write_json_atomic(
                frames / "20990101T1405Z.json",
                {"packet": stored},
            )
            outbox_path = outbox / "packet-5.json"
            MODULE.write_json_atomic(outbox_path, intent("NOTHING"))
            discarded = PARITY.discard_stale_outbox_intent(
                state,
                outbox_path,
                "packet-5",
                intent("NOTHING"),
                token="token",
            )
            self.assertFalse(discarded)
            self.assertTrue(outbox_path.exists())

    def test_discard_unexecutable_entry_outbox_on_geometry_error(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            outbox = state / "outbox"
            wire_dir = state / "delivery-wire"
            outbox.mkdir(parents=True)
            wire_dir.mkdir(parents=True)
            pending = intent("ENTER_SHORT")
            outbox_path = outbox / "packet-5.json"
            MODULE.write_json_atomic(outbox_path, pending)
            MODULE.write_json_atomic(
                wire_dir / "packet-5.json",
                {"schema_version": "glitch.topstep.delivery_wire.v1", "wire": pending},
            )
            discarded = PARITY.discard_unexecutable_entry_outbox(
                state,
                outbox_path,
                "packet-5",
                pending,
                ValueError("short_geometry_invalid"),
            )
            self.assertTrue(discarded)
            self.assertFalse(outbox_path.exists())
            self.assertFalse((wire_dir / "packet-5.json").exists())
            events = (state / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("intent_discarded_geometry_invalid", events)

    def test_pending_outbox_discards_when_fresh_geometry_invalid(self):
        stored = packet(5)
        current = packet(6)
        current["market"]["snapshot_hash"] = "hash-moved"
        current["market"]["last"] = 20050
        current["market"]["bid"] = 20049.75
        current["market"]["ask"] = 20050.25
        pending_intent = intent("ENTER_SHORT")

        with tempfile.TemporaryDirectory() as root:
            profile_root = Path(root)
            state = MODULE.state_root(profile_root)
            state.mkdir(parents=True)
            frames = state / "minute-frames"
            outbox = state / "outbox"
            frames.mkdir(parents=True)
            outbox.mkdir(parents=True)
            MODULE.write_json_atomic(
                frames / "20990101T1405Z.json",
                {"minute_id": "20990101T1405Z", "packet": stored},
            )
            MODULE.write_json_atomic(outbox / "packet-5.json", pending_intent)

            args = argparse.Namespace(
                profile="glitch-topstep",
                timeout_seconds=30,
                packet_rollover_wait_seconds=0,
                dry_run=False,
            )

            def fake_request_json(path, token=None):
                if path == "/health":
                    return (
                        200,
                        {
                            "schema_version": "glitch.direct.health.v2",
                            "status": "ok",
                            "compatibility": {
                                "gateway_name": "glitch-topstep",
                                "protocol_revision": "glitch.topstep.paired.v3",
                                "gateway_version": "0.2.0",
                                "intent_schemas": ["glitch.intent.v2", "glitch.intent.v3"],
                                "decision_packet_schemas": [
                                    "glitch.direct.decision_packet.v1",
                                    "glitch.direct.decision_packet.v2",
                                ],
                                "capabilities": [
                                    "packet_supported_actions",
                                    "durable_mutation_receipts",
                                    "restart_reconciliation",
                                    "bounded_entry_range_v1",
                                    "daily_capture_context_v1",
                                    "explicit_partial_completed_bars_v1",
                                    "revisioned_outcome_feed_v1",
                                    "multi_instrument_observation_v1",
                                    "partial_exit_fail_closed_v1",
                                ],
                                                "semantic_revisions": {
                                                    "bounded_entry_range": "glitch.topstep.entry_range.v1",
                                                    "daily_capture": "glitch.topstep.daily_capture.v1",
                                                    "outcome_feed": "glitch.topstep.outcome_feed.v1",
                                                    "market_universe": "glitch.topstep.market_universe.v1",
                                                    "execution_facts": "glitch.topstep.execution_fact.v1",
                                                },
                                                "provider_acceptance_evidence": {
                                                    "partial_exit_protection_transition": "not_proven_fail_closed",
                                                    "exact_contract_resolution": "catalog_fixture_plus_runtime_resolution",
                                                },
                                                "paired_manifest_schema": "glitch.topstep.paired_release.v1",
                            },
                        },
                    )
                return (200, current)

            with mock.patch.object(MODULE, "local_token", return_value="token"), mock.patch.object(
                MODULE,
                "request_json",
                side_effect=fake_request_json,
            ), mock.patch.object(MODULE, "wait_for_packet_rollover", return_value=current), mock.patch.object(
                MODULE,
                "packet_is_current",
                return_value=True,
            ), mock.patch.object(
                MODULE,
                "invocation_reason",
                return_value=None,
            ), mock.patch.object(
                MODULE,
                "post_intent",
            ) as post_intent:
                exit_code = MODULE.run_once(args, profile_root)

            self.assertEqual(exit_code, 0)
            post_intent.assert_not_called()
            self.assertFalse((outbox / "packet-5.json").exists())
            events = (state / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("intent_discarded_geometry_invalid", events)


class IntentContractMatrixTests(unittest.TestCase):
    def test_flat_nothing_valid(self):
        current = packet()
        value = MODULE.normalize_intent(intent("NOTHING"), current)
        MODULE.validate_intent(value, current)

    def test_flat_nothing_rejects_entry_fields(self):
        current = packet()
        value = intent("NOTHING")
        value["quantity"] = 1
        with self.assertRaisesRegex(ValueError, "unknown_fields"):
            MODULE.validate_intent(value, current)

    def test_enter_long_and_short_valid(self):
        for action in ("ENTER_LONG", "ENTER_SHORT"):
            current = packet()
            value = MODULE.normalize_intent(intent(action), current)
            MODULE.validate_intent(value, current)

    def test_enter_long_rejects_missing_stop(self):
        current = packet()
        value = intent("ENTER_LONG")
        value.pop("stop_loss")
        with self.assertRaisesRegex(ValueError, "(missing_fields|invalid_number)"):
            MODULE.validate_intent(value, current)

    def test_positioned_hold_valid(self):
        current = packet(positioned=True)
        value = MODULE.normalize_intent(intent("HOLD"), current)
        MODULE.validate_intent(value, current)

    def test_move_stop_and_move_tp_valid_with_confirmed_protection(self):
        current = proven_protection_packet()
        for action, field, price in (
            ("MOVE_STOP", "new_stop_price", 19995),
            ("MOVE_TP", "new_take_profit", 20030),
        ):
            body = intent("HOLD")
            body["action"] = action
            body["decision_audit"]["final_choice"] = action
            body[field] = price
            value = MODULE.normalize_intent(body, current)
            MODULE.validate_intent(value, current)

    def test_exit_full_and_partial_variants(self):
        current = proven_protection_packet()
        full = MODULE.normalize_intent(intent("EXIT"), current)
        MODULE.validate_intent(full, current)
        partial_qty = MODULE.normalize_intent(intent("EXIT", quantity=1), current)
        MODULE.validate_intent(partial_qty, current)
        partial_fraction = MODULE.normalize_intent(
            {**intent("EXIT"), "exit_fraction": 0.5},
            current,
        )
        MODULE.validate_intent(partial_fraction, current)

    def test_exit_rejects_quantity_and_fraction_together(self):
        current = proven_protection_packet()
        value = intent("EXIT", quantity=1)
        value["exit_fraction"] = 0.5
        with self.assertRaisesRegex(ValueError, "exit_quantity_and_fraction_conflict"):
            MODULE.validate_intent(value, current)

    def test_final_choice_must_match_action(self):
        current = packet()
        value = intent("NOTHING")
        value["decision_audit"]["final_choice"] = "HOLD"
        with self.assertRaisesRegex(ValueError, "decision_audit_choice_mismatch"):
            MODULE.validate_intent(value, current)

    def test_wake_triggers_rejected_on_entry(self):
        current = packet()
        value = intent("ENTER_LONG")
        value["wake_triggers"] = [
            {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000},
        ]
        with self.assertRaisesRegex(ValueError, "wake_triggers_not_allowed_for_action"):
            MODULE.validate_intent(value, current)

    def test_quote_age_observation_normalizes_negative_skip_values(self):
        current = packet()
        current["data_quality"]["quote_age_ms"] = -47
        current["data_quality"]["issues"] = ["quote_clock_skew"]
        observation = PARITY.quote_age_observation(current)
        self.assertEqual(observation["normalized_quote_age_ms"], 0.0)
        self.assertEqual(observation["raw_quote_age_ms"], -47)
        self.assertTrue(observation["clock_skew_detected"])


if __name__ == "__main__":
    unittest.main()
