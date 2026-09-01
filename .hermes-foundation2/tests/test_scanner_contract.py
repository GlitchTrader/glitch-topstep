import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from scanner_contract import MARKER, comparison_template, validate_comparison_ledger


def packet():
    return {
        "packet_id": "packet-1",
        "expires_utc": "2026-08-19T12:05:00Z",
        "instrument": "MNQ",
        "market_universe": {
            "candidates": [
                {"instrument": "MNQ"},
                {"instrument": "MES"},
                {"instrument": "MCL", "symbol_id": "F.US.MCLE"},
            ]
        },
    }


class ScannerContractTests(unittest.TestCase):
    def test_requires_complete_candidate_ledger_before_ranking(self):
        value = json.loads(comparison_template(packet())[len(MARKER):])
        for row in value["candidates"]:
            for field in ("current_auction", "bullish_path", "bearish_path", "next_transition"):
                row[field] = f"{row['instrument']} {field} evidence"
            row["triggers"][0].update(
                trigger_id=f"trigger-{row['instrument']}",
                path="NEXT",
                condition="price crosses frozen level",
                status="HELD",
            )
        validated = validate_comparison_ledger(MARKER + json.dumps(value), packet())
        self.assertEqual(validated["ranking"], ["MNQ", "MES", "MCL"])

    def test_rejects_missing_mcl_and_mutated_trigger_source(self):
        value = json.loads(comparison_template(packet())[len(MARKER):])
        value["candidates"] = value["candidates"][:2]
        with self.assertRaisesRegex(ValueError, "instrument_candidates_incomplete"):
            validate_comparison_ledger(MARKER + json.dumps(value), packet())


if __name__ == "__main__":
    unittest.main()

