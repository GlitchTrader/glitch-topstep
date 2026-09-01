# GTHP-012 — Learning parity with Glitch NT supervisor

**Status:** done  
**Priority:** P1 learning quality  
**Profile version target:** 0.1.14+  
**Gateway dependency:** `glitch-topstep:TS-R3-03`  
**Depends on:** GTHP-010, PROFILE-BETA-01, TS-R3-01 (baseline outcomes)

## Problem

The Topstep Hermes profile already runs the same five-loop supervisor architecture as Glitch NinjaTrader (`debrief → hourly → planning → daily → weekly`). However, learning quality is capped by:

1. **Thin canonical outcomes** — gateway publishes minimal `glitch.topstep.trade_outcome.v1` (PnL/fees/eligibility only); `OUTCOME-CONTRACT.md` recommends MAE/MFE, prices, and exit cause but they are not yet authoritative.
2. **Ingestion gap** — `sync_gateway_outcomes()` runs only in the direct decision cycle, not in the learning worker.
3. **Coarse rejection taxonomy** — decision episodes treat many gateway rejections generically; NT maps firewall/executor codes to system vs trading lessons.
4. **Indirect lesson feedback** — `lessons.jsonl` is not summarized into the direct decision prompt.
5. **Overlay policy drift** — optional auto-activate differs from NT's conservative activate-only-after-posterior-outcomes model.

Reference comparison: Glitch NT `run-hermes-learning-cycle.py`, `reconcile-hermes-outcomes.py`, `glitch_hermes_docs/docs/11_snapshot_ingestion_learning_pipeline.md`.

## Invariant

- Learning worker never submits intents or mutates the gateway.
- Outcomes remain gateway-owned facts; profile interpretations stay subordinate.
- `trading_influence: outcome_backed` gate is preserved.
- No daily PnL targets, quotas, or anti-abstention pressure introduced via learning.

## Profile-side improvements (this repo)

### P0 — Ingestion reliability

| ID | Change | Files |
|----|--------|-------|
| P0.1 | Call `sync_gateway_outcomes()` at start of `run-topstep-learning.py` `run_once()` | `scripts/common.py`, `scripts/run-topstep-learning.py` |
| P0.2 | Log sync count / HTTP status in `learning-worker-status.json` | `scripts/run-topstep-learning.py` |

### P1 — Richer debrief input (after TS-R3-03)

| ID | Change | Files |
|----|--------|-------|
| P1.1 | Extend `debrief_evidence()` with MAE/MFE, exit_reason, R-multiple, structural prices | `scripts/parity.py` |
| P1.2 | Update `topstep-review-outcomes` skill for new outcome fields | `skills/topstep-review-outcomes/SKILL.md` |
| P1.3 | Tests with fixture outcomes v1.1 | `tests/test_learning.py` |

### P2 — Rejection taxonomy

| ID | Change | Files |
|----|--------|-------|
| P2.1 | Whitelist `rejection_code` → `system_defect` vs `cognitive_rejection` | `scripts/parity.py`, gateway contract doc |
| P2.2 | Decision episodes carry `rejection_class` for hourly | `scripts/run-topstep-learning.py` |

### P3 — Decision feedback loop

| ID | Change | Files |
|----|--------|-------|
| P3.1 | Inject top-N summarized `lessons.jsonl` (outcome_backed only) into `recent_glitch_ledger` | `scripts/parity.py`, `scripts/run-topstep-cycle.py` |
| P3.2 | Default `GLITCH_TOPSTEP_AUTO_ACTIVATE_OVERLAY=false`; require posterior outcome evidence kind | `scripts/run-topstep-learning.py`, `docs/OPERATIONS.md` |
| P3.3 | Overlay effectiveness note in hourly review when active | `scripts/run-topstep-learning.py` |

### P4 — Operational parity

| ID | Change | Files |
|----|--------|-------|
| P4.1 | List weekly loop in `operator.json` | `operator.json` |
| P4.2 | Daily journal keyed to Topstep session boundary (when packet carries session authority — pairs with TS-R3-02) | `scripts/run-topstep-learning.py` |
| P4.3 | Fix ARCHITECTURE cron 15 vs 30 min drift | `docs/ARCHITECTURE.md` |

## NT features explicitly not ported

- Master/follower replication diagnostics (single Topstep account model).
- Apex multi-account portfolio plan v2 semantics without Topstep policy authority.
- Codex `build-requests.jsonl` automation (optional future; not P0).

## Acceptance

- Learning worker syncs outcomes even when direct cron is paused.
- After TS-R3-03 lands, debrief consumes MAE/MFE/exit_reason in evidence payloads.
- Decision episodes classify gateway rejections into system vs cognitive buckets.
- At least one shadow week shows hourly reviews referencing rich outcome fields without increased repair rate on direct cycle.
- Ledger and `OUTCOME-CONTRACT.md` cross-reference TS-R3-03.

## Evidence (when done)

- `scripts/run-topstep-learning.py`, `scripts/parity.py`, `scripts/common.py`
- `tests/test_learning.py`
- `docs/evidence/learning-parity-shadow-*.md`
- regenerated `SHA256SUMS`
