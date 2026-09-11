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


if __name__ == "__main__":
    unittest.main()
