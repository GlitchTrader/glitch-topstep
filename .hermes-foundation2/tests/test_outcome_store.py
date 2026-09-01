import json
import tempfile
import unittest
from pathlib import Path

from scripts.outcome_store import OutcomeStore


def revision(sequence: int, outcome_id: str = "o-1", pnl: float = 1.0, rev: int = 1) -> dict:
    return {
        "sequence": sequence,
        "revision": rev,
        "status": "corrected" if rev > 1 else "enriched",
        "content_hash": f"hash-{sequence}-{rev}",
        "outcome": {
            "schema_version": "glitch.topstep.trade_outcome.v1",
            "outcome_id": outcome_id,
            "intent_id": f"i-{outcome_id}",
            "realized_pnl_usd": pnl,
        },
    }


class OutcomeStoreTests(unittest.TestCase):
    def test_atomic_revision_projection_and_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            store = OutcomeStore(state)
            first = store.apply([revision(1)], 1, "2026-08-19T18:00:00Z")
            corrected = store.apply([revision(2, pnl=2.0, rev=2)], 2, "2026-08-19T18:01:00Z")
            self.assertEqual(first["added"], 1)
            self.assertEqual(corrected["revised"], 1)
            self.assertEqual(store.current()[0]["realized_pnl_usd"], 2.0)
            self.assertEqual(store.status()["integrity"], "ok")
            store.close()

            reopened = OutcomeStore(state)
            try:
                self.assertEqual(reopened.cursor(), 2)
                self.assertEqual(len(reopened.current()), 1)
                self.assertEqual(reopened.current()[0]["realized_pnl_usd"], 2.0)
            finally:
                reopened.close()

    def test_duplicate_is_idempotent_and_conflict_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = OutcomeStore(Path(directory))
            try:
                store.apply([revision(1)], 1, "now")
                self.assertEqual(store.apply([revision(1)], 1, "now")["applied"], 0)
                conflicting = revision(1, pnl=99.0)
                conflicting["content_hash"] = "different-content"
                with self.assertRaisesRegex(ValueError, "outcome_sequence_conflict"):
                    store.apply([conflicting], 1, "now")
            finally:
                store.close()

    def test_jsonl_bootstrap_is_idempotent_and_exports_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "outcomes.jsonl"
            path.write_text(json.dumps(revision(0)["outcome"]) + "\n", encoding="utf-8")
            store = OutcomeStore(state)
            try:
                store.bootstrap_jsonl(path)
                store.bootstrap_jsonl(path)
                store.export_jsonl(path)
                self.assertEqual(len(store.current()), 1)
                self.assertFalse((state / "outcomes.jsonl.tmp").exists())
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
