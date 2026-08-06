"""Watch next Glitch round-trip for Phase C MAE/MFE learning_eligible."""
from __future__ import annotations
import json, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GW_OUTCOMES = DATA / "trade-outcomes.jsonl"
EVENTS = DATA / "events.jsonl"
HERMES_OUTCOMES = Path(r"C:\Users\arifr\AppData\Local\hermes\profiles\glitch-topstep\state\outcomes.jsonl")
POLL = 15
MAX_HOURS = 12

def token() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("GLITCH_LOCAL_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("token missing")

def get(path: str, tok: str) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:8790{path}", headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.loads(r.read().decode())

def load_outcomes(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows

def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {msg}", flush=True)

def main() -> int:
    tok = token()
    baseline = load_outcomes(GW_OUTCOMES)
    baseline_ids = {o.get("outcome_id") for o in baseline}
    log(f"PHASE_C_MONITOR_START baseline_outcomes={len(baseline_ids)} waiting open->flat with MAE/MFE")
    last_open = None
    saw_open = False
    deadline = time.time() + MAX_HOURS * 3600
    while time.time() < deadline:
        try:
            st = get("/state", tok)
            packet = get("/packet", tok)
            health = get("/health", tok)
        except Exception as e:
            log(f"GATEWAY_UNREACHABLE {e}")
            time.sleep(POLL)
            continue
        open_c = int(st.get("instrumentOpenContracts") or packet.get("account", {}).get("instrument_open_contracts") or 0)
        if last_open is not None and open_c != last_open:
            log(f"POSITION_CHANGE {last_open}->{open_c} health={health.get('status')} mode={health.get('gateway_mode')}")
        last_open = open_c
        if open_c > 0:
            saw_open = True
            prot = (packet.get("protection") or {}).get("status")
            log(f"POSITIONED open={open_c} protection={prot} unrealized={st.get('unrealizedPnl')}")
        rows = load_outcomes(GW_OUTCOMES)
        new = [o for o in rows if o.get("outcome_id") not in baseline_ids]
        if saw_open and open_c == 0 and new:
            o = new[-1]
            mae, mfe = o.get("mae_usd"), o.get("mfe_usd")
            eligible = o.get("learning_eligible")
            fills = len(o.get("fills") or [])
            log(f"NEW_OUTCOME intent={o.get('intent_id')} pnl={o.get('realized_pnl_usd')} fills={fills} mae={mae} mfe={mfe} eligible={eligible} exit={o.get('exit_reason')} ver={(o.get('evidence') or {}).get('publisher_version')}")
            print("=== PHASE_C_RESULT ===", flush=True)
            print(json.dumps({"outcome": o, "hermes_tail": load_outcomes(HERMES_OUTCOMES)[-1:]}, indent=2), flush=True)
            if mae is not None and mfe is not None and fills >= 2:
                log("SUCCESS Phase C enrichment present")
                return 0
            log("PARTIAL outcome published but MAE/MFE incomplete")
            return 2
        if saw_open and open_c == 0 and not new:
            log("FLAT_AFTER_POSITION waiting for new outcome row...")
        time.sleep(POLL)
    log("TIMEOUT")
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
