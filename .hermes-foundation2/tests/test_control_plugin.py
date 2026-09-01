import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "topstep-control" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("topstep_control", PLUGIN)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ControlPluginTests(unittest.TestCase):
    def test_flatten_intent_uses_strict_risk_reducing_contract(self):
        packet = {
            "instrument": "MNQ",
            "account": {"name": "TopstepX-50K"},
            "market": {"snapshot_hash": "hash"},
        }
        value = MODULE.build_exit_intent(packet)
        self.assertEqual(value["schema_version"], "glitch.intent.v2")
        self.assertEqual(value["operator_profile"], "glitch-topstep")
        self.assertEqual(value["action"], "EXIT")
        self.assertEqual(value["decision_audit"]["final_choice"], "EXIT")
        self.assertNotIn("quantity", value)
        self.assertNotIn("stop_loss", value)

    def test_direct_worker_status_exposes_detached_worker_failure(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ,
            {"HERMES_HOME": root},
        ):
            path = Path(root) / "state" / "supervisor" / "direct-worker-status.json"
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "error": "ValueError:wake_triggers_missing",
                        "recorded_utc": "2099-01-01T12:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            status = MODULE._direct_worker_status()
        self.assertEqual(
            status,
            "failed (ValueError:wake_triggers_missing) @ 2099-01-01T12:00:00Z",
        )

    def test_status_reports_gateway_compatibility(self):
        compatible_health = {
            "schema_version": "glitch.direct.health.v2",
            "status": "ok",
            "trading_mode": "shadow",
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
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ,
            {"HERMES_HOME": root},
        ), mock.patch.object(
            MODULE,
            "_request",
            side_effect=[(200, compatible_health), (200, {"account": {"name": "TopstepX-50K", "canTrade": True}})],
        ), mock.patch.object(MODULE, "_job", return_value={"enabled": False}), mock.patch.object(
            MODULE,
            "_direct_worker_status",
            return_value="ok",
        ):
            text = MODULE._status_text()
        self.assertIn("compatibility: compatible", text)

    def test_long_accepts_v2_packet_new_exposure_gate(self):
        packet = {
            "instrument": "MNQ",
            "account": {"name": "PRAC-V2", "instrument_open_contracts": 0},
            "market": {"snapshot_hash": "hash"},
            "execution": {
                "new_exposure_technically_supported": True,
                "maximum_additional_contracts": 2,
                "supported_actions": ["ENTER_LONG", "ENTER_SHORT", "NOTHING"],
            },
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ,
            {"HERMES_HOME": root},
        ), mock.patch.object(MODULE, "_request", return_value=(200, packet)), mock.patch.object(
            MODULE,
            "_resume_jobs",
            return_value="glitch-topstep-direct-operator=running",
        ):
            text = MODULE._long("teste")
        self.assertIn("long experiment is queued", text)

    def test_long_rejects_when_new_exposure_not_supported(self):
        packet = {
            "instrument": "MNQ",
            "account": {"name": "PRAC-V2", "instrument_open_contracts": 0},
            "market": {"snapshot_hash": "hash"},
            "execution": {
                "new_exposure_technically_supported": False,
                "maximum_additional_contracts": 2,
                "supported_actions": ["ENTER_LONG", "NOTHING"],
            },
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ,
            {"HERMES_HOME": root},
        ), mock.patch.object(MODULE, "_request", return_value=(200, packet)):
            with self.assertRaisesRegex(RuntimeError, "not entry-eligible"):
                MODULE._long("teste")

    def test_trade_blocks_incompatible_gateway(self):
        incompatible_health = {
            "schema_version": "glitch.direct.health.v2",
            "status": "ok",
            "trading_mode": "shadow",
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ,
            {"HERMES_HOME": root},
        ), mock.patch.object(
            MODULE,
            "_request",
            return_value=(200, incompatible_health),
        ):
            with self.assertRaises(RuntimeError):
                MODULE._trade("")


if __name__ == "__main__":
    unittest.main()
