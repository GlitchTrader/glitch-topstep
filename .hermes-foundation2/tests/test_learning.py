import argparse
import argparse
import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import common as common_module
SPEC = importlib.util.spec_from_file_location("topstep_learning", SCRIPTS / "run-topstep-learning.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
PARITY = importlib.import_module("parity")


class LearningTests(unittest.TestCase):
    def test_only_canonical_learning_eligible_outcomes_are_consumed(self):
        rows = [
            {"schema_version": "glitch.topstep.trade_outcome.v1", "outcome_id": "ok", "intent_id": "i", "account": "a", "instrument": "MNQ", "entry_utc": "2026-01-01T00:00:00Z", "exit_utc": "2026-01-01T00:01:00Z", "realized_pnl_usd": 1, "fees_usd": 0, "learning_eligible": True},
            {"schema_version": "glitch.topstep.trade_outcome.v1", "outcome_id": "bad", "intent_id": "i", "account": "a", "instrument": "MNQ", "entry_utc": "2026-01-01T00:00:00Z", "exit_utc": "2026-01-01T00:01:00Z", "realized_pnl_usd": -1, "fees_usd": 0, "learning_eligible": False},
            {"schema_version": "other", "outcome_id": "other"},
        ]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "outcomes.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            values = MODULE.valid_outcomes(path)
        self.assertEqual([row["outcome_id"] for row in values], ["ok"])

    def test_overlay_is_proposed_by_default(self):
        record = {
            "cognitive_change_candidate": {
                "propose": True,
                "candidate_id": "candidate",
                "target": "core_prompt",
                "instruction": "Prefer exits after repeated failed progress.",
                "evidence_episode_ids": [f"e{i}" for i in range(6)],
                "expected_effect": "less rollback",
                "evaluation_metric": "rollback",
                "rollback_condition": "worse expectancy",
            }
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_AUTO_ACTIVATE_OVERLAY": "false", "GLITCH_TOPSTEP_OVERLAY_MIN_EPISODES": "6"}, clear=False):
            supervisor = Path(root)
            MODULE.process_candidate(record, supervisor, [f"e{i}" for i in range(6)])
            candidates = MODULE.read_jsonl(supervisor / "cognitive-candidates.jsonl")
            self.assertEqual(candidates[0]["status"], "proposed")
            self.assertFalse((supervisor / "active-cognitive-overlay.json").exists())

    def test_overlay_requires_configured_evidence_threshold(self):
        record = {
            "cognitive_change_candidate": {
                "propose": True,
                "target": "core_prompt",
                "instruction": "Change",
                "evidence_episode_ids": ["e1", "e2"],
            }
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ, {"GLITCH_TOPSTEP_OVERLAY_MIN_EPISODES": "6"}, clear=False):
            MODULE.process_candidate(record, Path(root), ["e1", "e2"])
            self.assertFalse((Path(root) / "cognitive-candidates.jsonl").exists())

    def test_learning_prompt_keeps_gateway_truth_above_memory(self):
        template = MODULE.output_template("daily", ["j1"])
        prompt = MODULE.prompt_for("daily", {"episodes": []}, template, {})
        self.assertIn("Canonical outcome records and gateway evidence outrank memory", prompt)
        self.assertIn("never manufacture a daily target", prompt)

    def test_gateway_feed_is_fresh_requires_health_packet_and_quote(self):
        packet = {"data_quality": {"state_complete": True, "quote_age_ms": 100}}
        compatible_health = {
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
        }
        with mock.patch.object(
            common_module,
            "request_json",
            side_effect=[(200, compatible_health), (200, packet)],
        ), mock.patch.object(common_module, "local_token", return_value="token"):
            self.assertTrue(common_module.gateway_feed_is_fresh())

    def test_gateway_feed_is_fresh_fails_on_stale_quote(self):
        packet = {"data_quality": {"state_complete": True, "quote_age_ms": 12000}}
        compatible_health = {
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
        }
        with mock.patch.object(
            common_module,
            "request_json",
            side_effect=[(200, compatible_health), (200, packet)],
        ), mock.patch.object(common_module, "local_token", return_value="token"):
            self.assertFalse(common_module.gateway_feed_is_fresh())

    def test_maintenance_daily_prompt_ignores_market_packets(self):
        template = MODULE.output_template("daily", ["j1"])
        evidence = {"scope": {"kind": "maintenance_distillation"}}
        prompt = MODULE.prompt_for("daily", evidence, template, {})
        self.assertIn("maintenance learning journal", prompt)
        self.assertIn("Do not reconstruct a whole trading session", prompt)

    def test_hourly_prompt_references_daily_economics_without_entry_pressure(self):
        template = MODULE.output_template("hourly", ["e1"])
        prompt = MODULE.prompt_for("hourly", {"episodes": []}, template, {})
        self.assertIn("daily_economics", prompt)
        self.assertIn("without creating entry pressure", prompt)

    def test_planning_prompt_allows_daily_intent_band_questions_not_quotas(self):
        template = MODULE.output_template("planning", ["r1"])
        prompt = MODULE.prompt_for("planning", {"reviews": []}, template, {})
        self.assertIn("daily_economics", prompt)
        self.assertIn("stop-trading questions", prompt)
        self.assertIn("not quotas", prompt)

    def test_collect_decision_episode_from_flat_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            state_root = Path(root) / "state"
            supervisor = state_root / "supervisor"
            frames = state_root / "minute-frames"
            outbox = state_root / "outbox"
            receipts = state_root / "receipts"
            for path in (supervisor, frames, outbox, receipts):
                path.mkdir(parents=True)
            packet = {
                "packet_id": "20260728T2130Z",
                "created_utc": "2026-07-28T21:30:00Z",
                "market": {"last": 100.0, "high": 100.5, "low": 99.5},
                "account": {"name": "PRAC", "instrument_open_contracts": 0},
                "contract": {"symbol": "MNQ"},
            }
            for minute_id, last in (
                ("20260728T2130Z", 100.0),
                ("20260728T2131Z", 101.0),
                ("20260728T2132Z", 102.0),
                ("20260728T2133Z", 101.5),
                ("20260728T2134Z", 103.0),
                ("20260728T2135Z", 102.5),
            ):
                (frames / f"{minute_id}.json").write_text(
                    json.dumps(
                        {
                            "schema_version": "glitch.topstep.minute_frame.v2",
                            "minute_id": minute_id,
                            "packet": {**packet, "market": {"last": last, "high": last + 0.5, "low": last - 0.5}},
                        }
                    ),
                    encoding="utf-8",
                )
            intent = {
                "schema_version": "glitch.intent.v2",
                "intent_id": "intent-flat-1",
                "action": "NOTHING",
                "created_utc": "2026-07-28T21:30:01Z",
            }
            (outbox / "20260728T2130Z.json").write_text(json.dumps(intent), encoding="utf-8")
            (receipts / "20260728T2130Z.json").write_text(
                json.dumps(
                    {
                        "schema_version": "glitch.topstep.delivery_receipt.v2",
                        "intent_id": "intent-flat-1",
                        "result": {"http_status": 202, "body": {"status": "accepted"}},
                    }
                ),
                encoding="utf-8",
            )
            episodes = MODULE.collect_decision_episodes(state_root, supervisor)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0]["evidence_kind"], "flat_nothing")
        self.assertEqual(episodes[0]["action"], "NOTHING")

    def test_gateway_cognitive_rejection_detects_client_errors(self):
        self.assertTrue(
            MODULE.is_gateway_cognitive_rejection({"http_status": 422, "body": {"status": "invalid"}})
        )
        self.assertFalse(
            MODULE.is_gateway_cognitive_rejection({"http_status": 202, "body": {"status": "accepted"}})
        )

    def test_debrief_evidence_enriches_outcome_context(self):
        with tempfile.TemporaryDirectory() as root:
            state_root = Path(root) / "state"
            frames = state_root / "minute-frames"
            frames.mkdir(parents=True)
            outcome = {
                "schema_version": "glitch.topstep.trade_outcome.v1",
                "outcome_id": "o1",
                "intent_id": "intent-1",
                "account": "PRAC",
                "instrument": "MNQ",
                "entry_utc": "2026-07-28T21:30:00Z",
                "exit_utc": "2026-07-28T21:35:00Z",
                "realized_pnl_usd": 10,
                "fees_usd": 0,
                "learning_eligible": True,
                "exit_reason": "manual_exit",
                "mae_usd": 5.0,
                "mfe_usd": 12.0,
                "initial_risk_usd": 40.0,
                "r_multiple": 0.25,
                "entry_price": 100.0,
                "exit_price": 101.0,
                "stop_price": 99.0,
                "target_price": 102.0,
                "side": "long",
                "quantity": 1,
                "fills": [
                    {
                        "price": 100.0,
                        "size": 1,
                        "side": 0,
                        "order_id": 10,
                        "timestamp": "2026-07-28T21:30:01Z",
                        "profit_and_loss": None,
                        "fees": 0.36,
                    },
                    {
                        "price": 101.0,
                        "size": 1,
                        "side": 1,
                        "order_id": 20,
                        "timestamp": "2026-07-28T21:34:50Z",
                        "profit_and_loss": 10,
                        "fees": 0.36,
                    },
                ],
                "attribution": {
                    "protection_status": "proven",
                    "entry_order_id": 10,
                    "closing_order_id": 20,
                    "stop_order_id": 11,
                    "target_order_id": 12,
                },
                "evidence": {"publisher_version": "test", "trade_ids": [1, 2], "order_ids": [10, 20]},
            }
            (state_root / "decisions.jsonl").write_text(
                json.dumps(
                    {
                        "recorded_utc": "2026-07-28T21:30:01Z",
                        "packet_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "intent": {
                            "intent_id": "intent-1",
                            "account": "PRAC",
                            "action": "ENTER_LONG",
                            "created_utc": "2026-07-28T21:30:01Z",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (frames / "20260728T2130Z.json").write_text(
                json.dumps(
                    {
                        "minute_id": "20260728T2130Z",
                        "packet": {
                            "created_utc": "2026-07-28T21:30:00Z",
                            "market": {"last": 100.0, "high": 100.5, "low": 99.5},
                        },
                    }
                ),
                encoding="utf-8",
            )
            (frames / "20260728T2132Z.json").write_text(
                json.dumps(
                    {
                        "minute_id": "20260728T2132Z",
                        "packet": {
                            "created_utc": "2026-07-28T21:32:00Z",
                            "market": {"last": 100.5, "high": 101.0, "low": 100.0},
                        },
                    }
                ),
                encoding="utf-8",
            )
            (frames / "20260728T2135Z.json").write_text(
                json.dumps(
                    {
                        "minute_id": "20260728T2135Z",
                        "packet": {
                            "created_utc": "2026-07-28T21:35:00Z",
                            "market": {"last": 101.0, "high": 101.5, "low": 100.5},
                        },
                    }
                ),
                encoding="utf-8",
            )
            evidence = PARITY.debrief_evidence(state_root, [outcome])
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["outcome"]["outcome_id"], "o1")
        self.assertEqual(evidence[0]["entry_decision"]["intent_id"], "intent-1")
        self.assertEqual(evidence[0]["outcome_execution"]["exit_reason"], "manual_exit")
        self.assertEqual(evidence[0]["outcome_execution"]["mae_usd"], 5.0)
        self.assertEqual(evidence[0]["outcome_execution"]["r_multiple"], 0.25)
        self.assertEqual(evidence[0]["outcome_execution"]["protection_status"], "proven")
        self.assertEqual(evidence[0]["outcome_execution"]["closing_order_id"], 20)
        self.assertEqual(evidence[0]["outcome_execution"]["order_ids"], [10, 20])
        self.assertEqual(len(evidence[0]["market_path"]), 3)
        self.assertEqual(evidence[0]["market_path"][0]["close"], 100.0)
        self.assertEqual(evidence[0]["market_path"][-1]["close"], 101.0)
        self.assertIn("facts", evidence[0])
        self.assertEqual(evidence[0]["facts"]["entry_price"], 100.0)
        self.assertEqual(evidence[0]["facts"]["exit_price"], 101.0)
        self.assertEqual(evidence[0]["facts"]["closing_order_id"], 20)
        self.assertEqual(len(evidence[0]["facts"]["fills"]), 2)
        self.assertEqual(evidence[0]["facts_sha256"], PARITY.stable_facts_sha256(evidence[0]["facts"]))

    def test_debrief_prompt_evidence_omits_full_outcome_blob(self):
        facts = {"outcome_id": "o1", "intent_id": "intent-1", "realized_pnl_usd": 10}
        rows = [
            {
                "facts": facts,
                "facts_sha256": PARITY.stable_facts_sha256(facts),
                "outcome": {"outcome_id": "o1", "realized_pnl_usd": 10, "fills": [{"price": 1}]},
                "entry_decision": {"intent_id": "intent-1"},
                "related_decisions": [{"packet_id": "p1"}],
                "market_path": [{"close": 100.0}],
            }
        ]
        prompt_rows = PARITY.debrief_prompt_evidence(rows)
        self.assertNotIn("outcome", prompt_rows[0])
        self.assertEqual(prompt_rows[0]["facts_sha256"], rows[0]["facts_sha256"])
        self.assertEqual(prompt_rows[0]["related_decision_count"], 1)

    def test_classify_gateway_rejection_buckets(self):
        self.assertEqual(
            PARITY.classify_gateway_rejection(
                {"http_status": 422, "body": {"code": "stop_would_widen"}}
            ),
            "cognitive_rejection",
        )
        self.assertEqual(
            PARITY.classify_gateway_rejection(
                {"http_status": 409, "body": {"code": "projectx_mutation_rejected"}}
            ),
            "system_defect",
        )

    def test_learning_context_includes_outcome_backed_lessons(self):
        with tempfile.TemporaryDirectory() as root:
            supervisor = Path(root) / "supervisor"
            supervisor.mkdir(parents=True)
            (supervisor / "lessons.jsonl").write_text(
                "\n".join(
                    json.dumps(row)
                    for row in (
                        {
                            "lesson_id": "l1",
                            "summary": "Keep stops tight after proven protection.",
                            "trading_influence": "outcome_backed",
                        },
                        {
                            "lesson_id": "l2",
                            "summary": "Ignore this observational note.",
                            "trading_influence": "observational",
                        },
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            context = PARITY.learning_context(supervisor)
        self.assertEqual(len(context["outcome_backed_lessons"]), 1)
        self.assertEqual(context["outcome_backed_lessons"][0]["lesson_id"], "l1")

    def test_run_once_syncs_gateway_outcomes(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            state_root = root_path / "state"
            supervisor = state_root / "supervisor"
            supervisor.mkdir(parents=True)
            args = argparse.Namespace(profile="glitch-topstep", dry_run=True, force_loop=None, timeout_seconds=30)
            outcome = {
                "schema_version": "glitch.topstep.trade_outcome.v1",
                "outcome_id": "o-sync",
                "intent_id": "intent-sync",
                "account": "PRAC",
                "instrument": "MNQ",
                "entry_utc": "2026-01-01T00:00:00Z",
                "exit_utc": "2026-01-01T00:01:00Z",
                "realized_pnl_usd": 1,
                "fees_usd": 0,
                "learning_eligible": True,
            }
            with mock.patch.object(
                MODULE,
                "sync_gateway_outcomes_meta",
                return_value={"added": 1, "http_status": 200},
            ), mock.patch.object(MODULE, "gateway_feed_is_fresh", return_value=False):
                result = MODULE.run_once(args, root_path)
            self.assertEqual(result["outcomes_synced"], 1)
            self.assertEqual(result["outcomes_sync_http_status"], 200)

    def test_weekly_output_template_schema(self):
        template = MODULE.output_template("weekly", ["proposal-1"])
        self.assertEqual(template["loop_id"], "weekly")
        self.assertEqual(
            template["records"][0]["schema_version"],
            "glitch.topstep.weekly_skill_proposal.v1",
        )
        self.assertEqual(template["records"][0]["skill_proposal_id"], "proposal-1")

    def test_collect_decision_episodes_skips_transport_uncertain(self):
        with tempfile.TemporaryDirectory() as root:
            state_root = Path(root) / "state"
            supervisor = state_root / "supervisor"
            frames = state_root / "minute-frames"
            outbox = state_root / "outbox"
            receipts = state_root / "receipts"
            for path in (supervisor, frames, outbox, receipts):
                path.mkdir(parents=True)
            packet = {
                "packet_id": "20260728T2130Z",
                "created_utc": "2026-07-28T21:30:00Z",
                "market": {"last": 100.0, "high": 100.5, "low": 99.5},
                "account": {"name": "PRAC", "instrument_open_contracts": 0},
                "contract": {"symbol": "MNQ"},
            }
            for minute_id, last in (
                ("20260728T2130Z", 100.0),
                ("20260728T2131Z", 101.0),
                ("20260728T2132Z", 102.0),
                ("20260728T2133Z", 101.5),
                ("20260728T2134Z", 103.0),
                ("20260728T2135Z", 102.5),
            ):
                (frames / f"{minute_id}.json").write_text(
                    json.dumps(
                        {
                            "schema_version": "glitch.topstep.minute_frame.v2",
                            "minute_id": minute_id,
                            "packet": {**packet, "market": {"last": last, "high": last + 0.5, "low": last - 0.5}},
                        }
                    ),
                    encoding="utf-8",
                )
            intent = {
                "schema_version": "glitch.intent.v2",
                "intent_id": "intent-transport",
                "action": "NOTHING",
                "created_utc": "2026-07-28T21:30:01Z",
            }
            (outbox / "20260728T2130Z.json").write_text(json.dumps(intent), encoding="utf-8")
            (receipts / "20260728T2130Z.json").write_text(
                json.dumps(
                    {
                        "schema_version": "glitch.topstep.delivery_receipt.v2",
                        "intent_id": "intent-transport",
                        "result": {"transport_error": "timeout"},
                    }
                ),
                encoding="utf-8",
            )
            episodes = MODULE.collect_decision_episodes(state_root, supervisor)
        self.assertEqual(episodes, [])

    def test_collect_decision_episodes_from_decisions_jsonl(self):
        with tempfile.TemporaryDirectory() as root:
            state_root = Path(root) / "state"
            supervisor = state_root / "supervisor"
            frames = state_root / "minute-frames"
            receipts = state_root / "receipts"
            decisions = state_root / "decisions.jsonl"
            for path in (supervisor, frames, receipts):
                path.mkdir(parents=True)
            packet_id = "pkt-decision-1"
            packet = {
                "packet_id": packet_id,
                "created_utc": "2026-07-28T21:30:00Z",
                "market": {"last": 100.0, "high": 100.5, "low": 99.5},
                "account": {"name": "PRAC", "instrument_open_contracts": 0},
                "contract": {"symbol": "MNQ"},
            }
            for minute_id, last in (
                ("20260728T2130Z", 100.0),
                ("20260728T2131Z", 101.0),
                ("20260728T2132Z", 102.0),
                ("20260728T2133Z", 101.5),
                ("20260728T2134Z", 103.0),
                ("20260728T2135Z", 102.5),
            ):
                (frames / f"{minute_id}.json").write_text(
                    json.dumps(
                        {
                            "schema_version": "glitch.topstep.minute_frame.v2",
                            "minute_id": minute_id,
                            "packet": {**packet, "packet_id": packet_id, "market": {"last": last, "high": last + 0.5, "low": last - 0.5}},
                        }
                    ),
                    encoding="utf-8",
                )
            intent = {
                "schema_version": "glitch.intent.v2",
                "intent_id": "intent-from-decisions",
                "action": "NOTHING",
                "created_utc": "2026-07-28T21:30:01Z",
            }
            decisions.write_text(
                json.dumps(
                    {
                        "schema_version": "glitch.topstep.decision_record.v2",
                        "packet_id": packet_id,
                        "intent": intent,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (receipts / f"{packet_id}.json").write_text(
                json.dumps(
                    {
                        "schema_version": "glitch.topstep.delivery_receipt.v2",
                        "intent_id": "intent-from-decisions",
                        "result": {"http_status": 200, "body": {"executor": "ok"}},
                    }
                ),
                encoding="utf-8",
            )
            episodes = MODULE.collect_decision_episodes(state_root, supervisor)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0]["intent_id"], "intent-from-decisions")

    def test_suggest_flat_abstention_classification(self):
        self.assertEqual(
            PARITY.suggest_flat_abstention_classification(
                initial_price=20000.0,
                forward_high=20000.5,
                forward_low=19999.5,
                forward_close=20000.0,
            ),
            "justified_abstention",
        )
        self.assertEqual(
            PARITY.suggest_flat_abstention_classification(
                initial_price=20000.0,
                forward_high=20020.0,
                forward_low=19999.0,
                forward_close=20015.0,
            ),
            "missed_directional_participation",
        )
        self.assertEqual(
            PARITY.suggest_flat_abstention_classification(
                initial_price=20000.0,
                forward_high=20001.0,
                forward_low=19970.0,
                forward_close=19975.0,
            ),
            "avoided_adverse_movement",
        )


if __name__ == "__main__":
    unittest.main()
