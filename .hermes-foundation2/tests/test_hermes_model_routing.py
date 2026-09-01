import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("common", SCRIPTS / "common.py")
COMMON = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(COMMON)


class HermesModelRoutingTests(unittest.TestCase):
    def test_default_uses_hermes_config_without_cli_override(self):
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            (root / "config.yaml").write_text(
                "model:\n  default: test/model\n  provider: openrouter\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertTrue(COMMON.use_hermes_model_routing())
                self.assertEqual(
                    COMMON.hermes_model_version_label(
                        root,
                        model_env="GLITCH_TOPSTEP_CORE_MODEL",
                        fallback="fallback",
                    ),
                    "test/model",
                )
                self.assertEqual(COMMON.hermes_chat_model_cli_args(root, model_env="x", provider_env="y"), [])

    def test_explicit_env_mode_passes_cli_args(self):
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            env = {
                "GLITCH_TOPSTEP_USE_HERMES_MODEL": "false",
                "GLITCH_TOPSTEP_CORE_MODEL": "override/model",
                "GLITCH_TOPSTEP_CORE_PROVIDER": "override-provider",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertFalse(COMMON.use_hermes_model_routing())
                self.assertEqual(
                    COMMON.hermes_chat_model_cli_args(
                        root,
                        model_env="GLITCH_TOPSTEP_CORE_MODEL",
                        provider_env="GLITCH_TOPSTEP_CORE_PROVIDER",
                    ),
                    ["--model", "override/model", "--provider", "override-provider"],
                )


if __name__ == "__main__":
    unittest.main()
