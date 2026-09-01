import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from prac_gateway_helpers import clear_daily_capture_lock, packet_snapshot, restart_gateway, wait_gateway_ready

db = ROOT / "data" / "trade-outcomes.sqlite"
conn = sqlite3.connect(str(db))
conn.execute("DELETE FROM outcomes_current WHERE outcome_id LIKE 'prac-seed%'")
conn.execute("DELETE FROM outcome_revisions WHERE outcome_id LIKE 'prac-seed%'")
conn.commit()
print("remaining outcomes", conn.execute("SELECT COUNT(*) FROM outcomes_current").fetchone()[0])
conn.close()
clear_daily_capture_lock("2027-03-04")
restart_gateway(None)
wait_gateway_ready(120)
snap = packet_snapshot()
econ = (snap.get("packet") or {}).get("daily_economics") or {}
print("realized", econ.get("realized_pnl_usd"), "reached", (econ.get("daily_capture") or {}).get("reached"), "locked", snap.get("daily_capture_locked"))
