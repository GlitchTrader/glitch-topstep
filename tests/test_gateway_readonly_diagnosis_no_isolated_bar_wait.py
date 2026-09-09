"""Regression: gateway diagnosis must not run isolated bar-wait pre-steps."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
DIAGNOSIS = SCRIPTS / "gateway-readonly-diagnosis.py"


def _load_diagnosis():
    spec = importlib.util.spec_from_file_location("gateway_readonly_diagnosis", DIAGNOSIS)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    # Avoid executing side effects that require gateway token at import of helpers —
    # module import still pulls prac_gateway_helpers; that is fine in this repo.
    spec.loader.exec_module(mod)
    return mod


class TestNoIsolatedBarWait(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = DIAGNOSIS.read_text(encoding="utf-8")
        cls.mod = _load_diagnosis()

    def test_source_has_no_wait_for_bar_complete_definition(self) -> None:
        self.assertNotRegex(self.source, r"def\s+wait_for_bar_complete\s*\(")
        self.assertNotIn("legacy_partial_poll", self.source)
        self.assertNotIn("from operational_stability_gate import wait_for_bar_complete", self.source)

    def test_source_delegates_or_points_to_canonical_runner(self) -> None:
        self.assertIn("run-canonical-live-stability.py", self.source)
        self.assertIn("isolated_bar_wait_forbidden", self.source)
        self.assertIn("validate_live_context_before_fetch", self.source)

    def test_module_has_no_wait_for_bar_complete_callable(self) -> None:
        self.assertFalse(hasattr(self.mod, "wait_for_bar_complete"))
        self.assertTrue(hasattr(self.mod, "refuse_isolated_bar_wait"))
        self.assertTrue(hasattr(self.mod, "run_stability_window"))

    def test_refuse_isolated_bar_wait_payload(self) -> None:
        payload = self.mod.refuse_isolated_bar_wait()
        self.assertTrue(payload["refused"])
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["reason"], "isolated_bar_wait_forbidden")
        self.assertIn("run-canonical-live-stability.py", payload["hint"])

    def test_cli_wait_bar_complete_exits_without_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            with mock.patch.object(self.mod, "capture_gateway_diagnosis") as capture:
                with mock.patch.object(sys, "argv", ["gateway-readonly-diagnosis.py", "--wait-bar-complete", "--output-dir", str(out)]):
                    code = self.mod.main()
            capture.assert_not_called()
            self.assertEqual(code, 2)
            refused = list(out.glob("bar-wait-refused-*.json"))
            self.assertEqual(len(refused), 1)
            doc = json.loads(refused[0].read_text(encoding="utf-8"))
            self.assertEqual(doc["reason"], "isolated_bar_wait_forbidden")

    def test_forbidden_checkout_markers(self) -> None:
        self.assertTrue(self.mod.path_is_forbidden_checkout(Path(r"C:\x\.wt-fix-bar\y")))
        self.assertTrue(self.mod.path_is_forbidden_checkout(Path(r"C:\x\wave0-offline\y")))
        self.assertTrue(self.mod.path_is_forbidden_checkout(Path(r"C:\x\docs\evidence\adhoc")))
        self.assertFalse(self.mod.path_is_forbidden_checkout(Path(r"C:\x\glitch-topstep-hermes-profile")))

    def test_no_other_live_script_calls_wait_for_bar_complete(self) -> None:
        offenders = []
        for path in SCRIPTS.iterdir():
            if path.suffix.lower() not in {".py", ".mjs", ".ps1", ".js", ".ts"}:
                continue
            if path.name in {"gateway-readonly-diagnosis.py", "assert-no-isolated-bar-wait.mjs"}:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if "wait_for_bar_complete(" in text or "--wait-bar-complete" in text:
                offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_assert_mjs_gate_passes(self) -> None:
        script = SCRIPTS / "assert-no-isolated-bar-wait.mjs"
        proc = subprocess.run(["node", str(script)], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        payload = json.loads(proc.stdout.strip())
        self.assertTrue(payload["ok"])


if __name__ == "__main__":
    unittest.main()
