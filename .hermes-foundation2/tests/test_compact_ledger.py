import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import parity as parity_module  # noqa: E402


class CompactLedgerTests(unittest.TestCase):
    def test_latest_two_change_conditions_are_preserved(self):
        rows = [
            {
                "recorded_utc": "t-1",
                "packet_id": "p-1",
                "intent": {
                    "action": "NOTHING",
                    "reason": "old",
                    "decision_audit": {
                        "final_choice": "NOTHING",
                        "change_condition": "a" * 300,
                    },
                },
            },
            {
                "recorded_utc": "t-2",
                "packet_id": "p-2",
                "intent": {
                    "action": "NOTHING",
                    "reason": "mid",
                    "decision_audit": {
                        "final_choice": "NOTHING",
                        "change_condition": "b" * 300,
                    },
                },
            },
            {
                "recorded_utc": "t-3",
                "packet_id": "p-3",
                "intent": {
                    "action": "NOTHING",
                    "reason": "new",
                    "decision_audit": {
                        "final_choice": "NOTHING",
                        "change_condition": "c" * 300,
                    },
                },
            },
        ]
        context = parity_module.compact_cycle_ledger_context(
            decisions=rows,
            receipts=[],
            outcomes=[],
        )
        self.assertTrue(context["decisions"][0]["change_condition"].endswith("..."))
        self.assertEqual(len(context["decisions"][1]["change_condition"]), 300)
        self.assertEqual(len(context["decisions"][2]["change_condition"]), 300)

    def test_receipt_row_extracts_nested_gateway_status(self):
        row = {
            "recorded_utc": "t",
            "intent_id": "i",
            "packet_id": "p",
            "result": {
                "http_status": 202,
                "body": {
                    "status": "ignored",
                    "code": "no_execution_action",
                },
            },
        }
        compact = parity_module.compact_receipt_row(row)
        assert compact is not None
        self.assertEqual(compact["status"], "ignored")
        self.assertEqual(compact["code"], "no_execution_action")

    def test_empty_receipt_row_is_omitted(self):
        self.assertIsNone(parity_module.compact_receipt_row({}))

    def test_receipt_row_preserves_schema_validation_detail(self):
        row = {
            "recorded_utc": "t",
            "intent_id": "i",
            "packet_id": "p",
            "result": {
                "http_status": 422,
                "body": {
                    "status": "rejected",
                    "code": "intent_schema_invalid",
                    "field": "wake_triggers",
                    "error": "unknown field",
                },
            },
        }
        compact = parity_module.compact_receipt_row(row)
        assert compact is not None
        self.assertEqual(compact["field"], "wake_triggers")
        self.assertEqual(compact["error"], "unknown field")

    def test_compute_cycle_evidence_delta_tracks_price_and_flow(self):
        current = {
            "market": {"last": 20010},
            "order_flow": {
                "observation": {
                    "windows": [
                        {"window_seconds": 60, "rolling_delta": 12},
                    ]
                }
            },
        }
        prior_frame = {
            "minute_id": "20990101T1404Z",
            "captured_utc": "2099-01-01T14:04:01Z",
            "packet": {
                "market": {"last": 20000},
                "order_flow": {
                    "observation": {
                        "windows": [
                            {"window_seconds": 60, "rolling_delta": 4},
                        ]
                    }
                },
            },
        }
        delta = parity_module.compute_cycle_evidence_delta(current, prior_frame)
        assert delta is not None
        self.assertEqual(delta["price_change"], 10)
        self.assertEqual(delta["delta_60s"]["change"], 8)

    def test_repeated_change_condition_warning_detects_stale_wording(self):
        decisions = [
            {
                "intent": {
                    "decision_audit": {
                        "change_condition": "Same trigger text for long and short.",
                    }
                }
            },
            {
                "intent": {
                    "decision_audit": {
                        "change_condition": "Same trigger text for long and short.",
                    }
                }
            },
        ]
        warning = parity_module.repeated_change_condition_warning(decisions)
        self.assertIn("rewrite", warning.lower())

    def test_outcome_summary_aggregates_trades(self):
        outcomes = [
            {
                "side": "LONG",
                "realized_pnl_usd": 50,
                "fees_usd": 1,
                "learning_eligible": True,
            },
            {
                "side": "SHORT",
                "realized_pnl_usd": -20,
                "fees_usd": 1,
                "learning_eligible": True,
            },
            {
                "side": "LONG",
                "learning_eligible": False,
            },
        ]
        summary = parity_module.summarize_outcomes_for_cycle(outcomes)
        assert summary is not None
        self.assertEqual(summary["trade_count"], 3)
        self.assertEqual(summary["longs"], 2)
        self.assertEqual(summary["shorts"], 1)
        self.assertEqual(summary["wins"], 1)
        self.assertEqual(summary["losses"], 1)
        self.assertEqual(summary["inconclusive"], 1)
        self.assertEqual(summary["net_after_fees_usd"], 28.0)


if __name__ == "__main__":
    unittest.main()
