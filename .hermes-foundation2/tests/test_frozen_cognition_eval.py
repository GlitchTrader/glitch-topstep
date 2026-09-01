import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "frozen_eval", ROOT / "scripts" / "evaluate-frozen-cognition.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class FrozenCognitionEvalTests(unittest.TestCase):
    def test_reports_action_rejection_and_abstention_diffs_without_promotion(self):
        baseline = {
            "schema_version": "glitch.topstep.cognition_run.v1",
            "prompt_version": "v9", "corpus_hash": "abc",
            "decisions": [{"frame_id": "1", "action": "NOTHING", "rejection": None,
                           "abstention_classification": "missed"}],
        }
        candidate = {
            "schema_version": "glitch.topstep.cognition_run.v1",
            "prompt_version": "v10", "corpus_hash": "abc",
            "decisions": [{"frame_id": "1", "action": "ENTER_LONG", "rejection": "range",
                           "abstention_classification": None}],
        }
        report = MODULE.compare_runs(baseline, candidate)
        self.assertEqual(report["changed_frames"], 1)
        self.assertFalse(report["armed_promotion_allowed"])
        self.assertEqual(
            report["diffs"][0]["changed_fields"],
            ["action", "rejection", "abstention_classification"],
        )

    def test_rejects_non_identical_corpus(self):
        left = {"prompt_version": "a", "corpus_hash": "1", "decisions": []}
        right = {"prompt_version": "b", "corpus_hash": "2", "decisions": []}
        with self.assertRaisesRegex(ValueError, "frozen_corpus_hash_mismatch"):
            MODULE.compare_runs(left, right)


if __name__ == "__main__":
    unittest.main()
