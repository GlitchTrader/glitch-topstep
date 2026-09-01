import importlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
PARITY = importlib.import_module("parity")
COMMON = importlib.import_module("common")


def packet(
    minute: int = 5,
    *,
    last: float = 20000.0,
    phase: str | None = None,
    positioned: bool = False,
    trade_count_60s: int = 42,
    quote_age_ms: int = 1000,
) -> dict:
    stamp = (
        datetime(2099, 1, 1, 14, minute, tzinfo=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    session = {
        "authority": "operator_configured",
        "must_flat_utc": "2099-01-01T20:00:00Z",
        "entry_window_open": True,
        "notes": [],
    }
    if phase is not None:
        session["phase"] = phase
        session["phase_authority"] = "exchange_calendar"
    return {
        "schema_version": "glitch.direct.decision_packet.v2",
        "packet_id": f"packet-{minute}",
        "created_utc": stamp,
        "account": {
            "instrument_open_contracts": 1 if positioned else 0,
        },
        "market": {
            "last": last,
            "high": last,
            "low": last,
        },
        "data_quality": {
            "state_complete": True,
            "quote_age_ms": quote_age_ms,
            "issues": [],
        },
        "order_flow": {
            "observation": {
                "windows": [{"window_seconds": 60, "trade_count": trade_count_60s}],
            },
        },
        "session": session,
    }


def write_trigger_state(state: Path, triggers: list[dict], **extra: object) -> None:
    supervisor = state / "supervisor"
    supervisor.mkdir(parents=True, exist_ok=True)
    document = {
        "schema_version": PARITY.WAKE_TRIGGER_SCHEMA,
        "triggers": triggers,
        "updated_utc": "2099-01-01T14:00:00Z",
        **extra,
    }
    COMMON.write_json_atomic(PARITY.wake_trigger_path(supervisor), document)


class WakeTriggerTests(unittest.TestCase):
    def test_price_cross_fires_with_eval_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                eval_snapshot={"price": 19990.0},
            )
            detail = PARITY.evaluate_wake_triggers(state, packet(last=20010.0))
            self.assertIsNotNone(detail)
            self.assertEqual(detail["wake_reason"], "PRICE_CROSS:ABOVE:20000.0")

    def test_session_phase_fires_on_transition(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            write_trigger_state(
                state,
                [{"type": "SESSION_PHASE", "phase": "regular"}],
                eval_snapshot={"phase": "maintenance"},
            )
            detail = PARITY.evaluate_wake_triggers(
                state,
                packet(phase="regular"),
            )
            self.assertIsNotNone(detail)
            self.assertEqual(detail["wake_reason"], "SESSION_PHASE:regular")

    def test_cooldown_blocks_repeat_fire(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                eval_snapshot={"price": 19990.0},
                fire_history={
                    "PRICE_CROSS:ABOVE:20000.0": {
                        "last_fired_utc": datetime.now(timezone.utc)
                        .isoformat()
                        .replace("+00:00", "Z"),
                    }
                },
            )
            with mock.patch.dict(
                os.environ,
                {"GLITCH_TOPSTEP_WAKE_TRIGGER_COOLDOWN_SECONDS": "120"},
                clear=False,
            ):
                detail = PARITY.evaluate_wake_triggers(state, packet(last=20010.0))
            self.assertIsNone(detail)

    def test_persist_wake_triggers_preserves_fire_history(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            history = {
                "PRICE_CROSS:ABOVE:20000.0": {
                    "last_fired_utc": "2099-01-01T14:00:00Z",
                }
            }
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                fire_history=history,
                eval_snapshot={"price": 19990.0},
            )
            PARITY.persist_wake_triggers(
                state,
                {
                    "wake_triggers": [
                        {"type": "PRICE_CROSS", "direction": "BELOW", "price": 19990.0},
                    ]
                },
                "packet-1",
            )
            document = COMMON.read_json(PARITY.wake_trigger_path(state / "supervisor"))
            self.assertEqual(document["fire_history"], history)
            self.assertEqual(len(document["triggers"]), 1)
            self.assertEqual(document["triggers"][0]["direction"], "BELOW")

    def test_record_wake_trigger_fire_audits_events(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
            )
            trigger = {"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}
            PARITY.record_wake_trigger_fire(state, trigger, packet(), source="test")
            events_path = state / "events.jsonl"
            self.assertTrue(events_path.is_file())
            row = json.loads(events_path.read_text(encoding="utf-8").strip())
            self.assertEqual(row["event"], "wake_trigger_fired")
            self.assertEqual(row["wake_reason"], "PRICE_CROSS:ABOVE:20000.0")

    def test_positioned_invocation_reason_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            reason = PARITY.invocation_reason(
                packet(positioned=True),
                state,
                None,
                flat_decision_interval_minutes=5,
            )
            self.assertEqual(reason, "positioned")

    def test_wake_trigger_condition_change_while_quiescent(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                eval_snapshot={"price": 19990.0},
            )
            quiescent = packet(
                minute=3,
                last=20010.0,
                trade_count_60s=0,
                quote_age_ms=9000,
            )
            COMMON.write_json_atomic(
                state / "last-evidence.json",
                {"schema_version": "glitch.topstep.last_evidence.v1", "fingerprint": "x"},
            )
            reason = PARITY.invocation_reason(
                quiescent,
                state,
                None,
                flat_decision_interval_minutes=5,
            )
            self.assertEqual(reason, "condition_change")
            self.assertIsNotNone(PARITY.market_quiescent_skip_details(quiescent, None))

    def test_monitor_should_launch_when_flat_between_ticks(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            COMMON.write_json_atomic(
                state / "last-evidence.json",
                {"schema_version": "glitch.topstep.last_evidence.v1", "fingerprint": "x"},
            )
            write_trigger_state(
                state,
                [{"type": "PRICE_CROSS", "direction": "ABOVE", "price": 20000.0}],
                eval_snapshot={"price": 19990.0},
            )
            current = packet(minute=3, last=20010.0)
            detail = PARITY.monitor_should_launch_cycle(
                state,
                current,
                None,
                flat_decision_interval_minutes=5,
            )
            self.assertIsNotNone(detail)
            self.assertEqual(detail["wake_reason"], "PRICE_CROSS:ABOVE:20000.0")

    def test_validate_session_phase_trigger(self):
        PARITY.validate_wake_triggers([{"type": "SESSION_PHASE", "phase": "asia"}])
        with self.assertRaises(ValueError):
            PARITY.validate_wake_triggers([{"type": "SESSION_PHASE", "phase": "invalid"}])

    def test_packet_one_minute_range_uses_session_high_low(self):
        current = packet(last=20005.0)
        current["market"] = {
            "last": 20005.0,
            "session_high": 20020.0,
            "session_low": 19990.0,
        }
        self.assertEqual(PARITY.packet_one_minute_range(current), (19990.0, 20020.0))

    def test_packet_one_minute_range_prefers_order_flow_window(self):
        current = packet(last=20005.0)
        current["market"] = {
            "last": 20005.0,
            "session_high": 20020.0,
            "session_low": 19990.0,
        }
        current["order_flow"]["observation"]["windows"][0]["high_price"] = 20008.0
        current["order_flow"]["observation"]["windows"][0]["low_price"] = 20002.0
        self.assertEqual(PARITY.packet_one_minute_range(current), (20002.0, 20008.0))


if __name__ == "__main__":
    unittest.main()
