import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("regime", SCRIPTS / "regime.py")
regime = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(regime)


def _features(
    range_position_20: float | None = None,
    ema_20_slope_bps: float | None = None,
    ema_50_slope_bps: float | None = None,
) -> dict:
    return {
        "range_position_20": range_position_20,
        "ema_20_slope_bps": ema_20_slope_bps,
        "ema_50_slope_bps": ema_50_slope_bps,
    }


def _timeframe(minutes: int, features: dict | None) -> dict:
    return {
        "timeframe_minutes": minutes,
        "bars_received": 20,
        "bars_accepted": 20,
        "rejected_bars": 0,
        "latest_bar_utc": "2099-01-01T14:00:00Z",
        "latest_bar_partial": False,
        "gaps": [],
        "features": features,
    }


def _packet(
    *,
    state_complete: bool = True,
    issues: list[str] = [],
    market_error: str | None = None,
    order_flow_error: str | None = None,
    timeframes: list[dict] | None = None,
    trade_count_60: int = 50,
) -> dict:
    windows = [
        {
            "window_seconds": 60,
            "trade_count": trade_count_60,
            "trades_per_second": trade_count_60 / 60,
        }
    ]
    return {
        "data_quality": {
            "state_complete": state_complete,
            "issues": issues,
            "quote_age_ms": 100,
        },
        "market_observation": {
            "last_error": market_error,
            "observation": {
                "timeframes": timeframes or [],
            },
        },
        "order_flow": {
            "last_error": order_flow_error,
            "observation": {"windows": windows},
        },
    }


class RegimeTests(unittest.TestCase):
    def test_data_degraded_on_incomplete_state(self):
        packet = _packet(state_complete=False)
        self.assertEqual(regime.detect_regime(packet), "DATA_DEGRADED")

    def test_data_degraded_on_quote_stale_issue(self):
        packet = _packet(issues=["quote_stale"])
        self.assertEqual(regime.detect_regime(packet), "DATA_DEGRADED")

    def test_low_liquidity_on_thin_tape(self):
        packet = _packet(trade_count_60=1)
        self.assertEqual(regime.detect_regime(packet), "LOW_LIQUIDITY")

    def test_trend_up_from_60m_extreme_and_slopes(self):
        packet = _packet(
            timeframes=[
                _timeframe(60, _features(0.85, 5.0, 4.0)),
            ],
        )
        self.assertEqual(regime.detect_regime(packet), "TREND_UP")

    def test_trend_down_from_60m_extreme_and_slopes(self):
        packet = _packet(
            timeframes=[
                _timeframe(60, _features(0.10, -5.0, -4.0)),
            ],
        )
        self.assertEqual(regime.detect_regime(packet), "TREND_DOWN")

    def test_chop_on_conflicting_htf_slopes(self):
        packet = _packet(
            timeframes=[
                _timeframe(60, _features(0.50, 6.0, -6.0)),
            ],
        )
        self.assertEqual(regime.detect_regime(packet), "CHOP")


if __name__ == "__main__":
    unittest.main()
