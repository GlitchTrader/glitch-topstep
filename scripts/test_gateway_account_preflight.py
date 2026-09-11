import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("gateway-account-preflight.py")
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("gateway_account_preflight", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class GatewayAccountPreflightTests(unittest.TestCase):
    def test_state_quantity_uses_non_packet_contract_state(self):
        self.assertEqual(MODULE.state_open_quantity({"instrumentOpenContracts": {"MNQ": 0, "MES": 0}}), 0)

    def test_position_quantity_is_absent_or_explicit(self):
        self.assertEqual(MODULE.state_open_quantity({"positions": [{"quantity": -2}]}), 2)
        self.assertIsNone(MODULE.state_open_quantity({"positions": [{"price": 100, "pnl": 5}]}))

    def test_reconciliation_age_is_fail_closed_when_missing(self):
        self.assertIsNone(MODULE.age_seconds(None))
        self.assertIsNone(MODULE.age_seconds("not-a-timestamp"))

    def test_effective_state_requires_explicit_shadow_delivery_and_overnight(self):
        state = MODULE._effective_operational_state({
            "runtime_trading_mode": "shadow",
            "gateway_mode": "shadow",
            "delivery_effective": "disabled",
            "delivery_disabled_by_mode": True,
            "gateway_supervised_overnight": False,
            "process_identity": {"commit": "abc", "checkout": "root"},
        })
        self.assertEqual(state["mode"], "shadow")
        self.assertEqual(state["delivery"], "disabled")
        self.assertIs(state["gateway_supervised_overnight"], False)

    def test_effective_state_does_not_infer_shadow_from_env_shaped_health(self):
        state = MODULE._effective_operational_state({"trading_mode": "shadow"})
        self.assertNotEqual(state["mode"], "shadow")
        self.assertEqual(state["delivery"], "enabled_or_unknown")
        self.assertIsNone(state["gateway_supervised_overnight"])

    def test_missing_process_identity_fails_closed(self):
        self.assertFalse(MODULE._process_identity_matches({}, "abc", "root"))

    def test_mismatched_process_identity_fails_closed(self):
        self.assertFalse(MODULE._process_identity_matches({
            "process_identity": {"commit": "other", "checkout": "root"},
        }, "abc", "root"))


if __name__ == "__main__":
    unittest.main()
