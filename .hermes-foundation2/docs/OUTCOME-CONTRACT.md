# Canonical outcome contract

The learning worker accepts only JSONL records with:

```json
{
  "schema_version": "glitch.topstep.trade_outcome.v1",
  "outcome_id": "stable-id",
  "intent_id": "intent-uuid",
  "account": "account-alias",
  "instrument": "MNQ",
  "entry_utc": "2026-07-21T14:30:00Z",
  "exit_utc": "2026-07-21T14:38:00Z",
  "realized_pnl_usd": 82.5,
  "fees_usd": 2.1,
  "learning_eligible": true
}
```

When `learning_eligible=true`, the gateway may also publish v1.1 enrichment fields:

- `exit_reason`, `entry_price`, `exit_price`, `stop_price`, `target_price`
- `fills[]`, `quantity`, `side`
- `mae_usd`, `mfe_usd`, `mae_ticks`, `mfe_ticks`
- `initial_risk_usd`, `r_multiple`, `protection_confirmed`

Gateway source: `glitch-topstep:TS-R3-03`. Profile consumer: `GTHP-012`.

Recommended additional fields:

- packet and snapshot IDs;
- entry and exit provider order IDs in a sanitized evidence section;
- entry, fill, stop, target, and exit prices;
- quantity, side, MAE, MFE, slippage, and protection-confirmation latency;
- conservative equity, liquidation floor, and buffer before and after;
- Topstep program/account phase and payout-state effects when authoritative;
- disconnect, reconciliation, rejection, and recovery events;
- evidence paths or hashes.

The gateway should mark `learning_eligible=false` when attribution or terminal state is incomplete. System defects should remain available for operational review without becoming trading lessons.
