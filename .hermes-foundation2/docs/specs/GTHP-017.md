# GTHP-017 — Daily economics as cognition evidence (eval vs approved)

**Status:** done  
**Priority:** P1 cognition / account objectives  
**Profile version target:** 0.1.15+ (`prompt_version` bump when implemented)  
**Gateway dependency:** `glitch-topstep:TS-R3-04` (packet mirror; profile phase A may ship with existing `policy.*` only)  
**Depends on:** GTHP-009, GTHP-010, RAIL-010

## Problem

Operators want **profitable trading days and payout progress** as a first-class objective. Glitch v2 §23 proposes solving this with an engine **profit lock** (+1.5% arms floor, blocks new entries). That conflicts with **GTHP-009** and `docs/AUTHORITY.md`: daily profit belongs in **Hermes cognition**, not in a hidden Glitch execution gate.

The profile SOUL already states a **0.4–2% per-day calibration band** and treats winning days as state variables — but stage-specific playbooks (evaluation vs express-funded vs practice) and authoritative **daily PnL mirrors** in the packet are thin. Hermes cannot plan “bank and preserve” vs “press eval target” without inventing numbers.

## Invariant

| Layer | Rule |
|-------|------|
| **Objective** | Long-run expectancy, survival, compliance, and **realized payout quality** include good trading days. |
| **Hermes** | Decides when daily economics justify `ENTER_*`, `HOLD`, `EXIT`, `NOTHING`, stop tightening, or end-of-day abstention. |
| **Glitch gateway** | Publishes **labeled mirrors** of daily PnL and program targets when computable; **never** rejects `ENTER_*` solely because daily PnL crossed a band. |
| **Profile worker** | Never skips Luna or blocks intents because “daily target met”; may surface plan/guidance when operator sets them. |
| **Learning** | May review day-level outcomes; must not introduce anti-abstention or quota pressure. |

This is **not** a reversal of GTHP-009. GTHP-009 removed **deterministic vetoes** and prompt quotas. GTHP-017 **adds explicit evidence and doctrine** so Hermes can pursue daily profit **deliberately**.

## Non-goals

- Engine profit lock / guardian auto-flatten for +1.5% (v2 §23).
- Gateway `if daily_pnl >= X → reject entry`.
- Daily trade quotas or “must take N trades”.
- Inferring Topstep dashboard truth when API lacks fields (mirrors are explicit).

---

## Account stages (cognition doctrine)

### Evaluation / Combine (`account_stage` evaluation family)

- **Primary objective:** lawful, efficient approval — profit target and consistency rules as **evidence**, not desperation.
- **May continue** after a winning day when independent edge remains; no approved-account profit ceiling.
- **Must preserve** MLL / hard loss floor; never chase target with naked risk or account-burning size.
- **Daily band (0.4–2% of nominal):** calibration for “was today a well-sized good day?”, not a stop rule.

### Practice / sim

- Same cognition discipline; economics are training evidence only.

### Express funded / approved (`express_funded_*`)

- **Primary objective:** survivability and **repeatable payout eligibility**.
- **Daily band:** prefer days in ~0.4–2% of nominal; when **net daily PnL** is in the **upper band** with open risk, prioritize **preserving** via `MOVE_STOP`, partial/full `EXIT`, or `NOTHING` for new entries — **Hermes decides**, not the gateway.
- **Soft floor concept (cognition):** when day is strongly positive, treat further entries as requiring **higher bar**; document in plan/guidance, not code gate.
- **Downside (cognition):** near **-1% of nominal** intraday, bias toward stopping new risk and protecting open trades; still Hermes-owned.

### Unknown stage

- Use only fields present in `policy`; do not invent payout path.

---

## Gateway packet (TS-R3-04)

Optional block under `policy` or sibling `daily_economics`:

```json
{
  "daily_economics": {
    "authority": "operator_configured | reconciled_trades | null",
    "trading_day_id": "2026-08-05",
    "nominal_size_usd": 50000,
    "realized_pnl_usd": 420.0,
    "unrealized_pnl_usd": 85.0,
    "net_daily_pnl_usd": 505.0,
    "net_daily_pnl_pct": 1.01,
    "calibration_band_pct": { "low": 0.4, "high": 2.0 },
    "profit_target_usd": 3000,
    "profit_target_remaining_usd": 2495,
    "largest_winning_day_usd": null,
    "consistency_pct_mirror": null,
    "notes": ["mirrors are not Topstep dashboard authority"]
  }
}
```

All nullable when unknown. `notes` must state mirror provenance.

---

## Profile work (this repo)

### Phase A — Doctrine and skills (no gateway change)

| ID | Change | Files |
|----|--------|-------|
| A.1 | Expand SOUL stage bullets (eval vs approved) without contradicting GTHP-009 | `SOUL.md` |
| A.2 | Account economics skill: daily band, eval target, approved preservation | `skills/topstep-assess-risk/SKILL.md` or new `skills/topstep-account-economics/SKILL.md` |
| A.3 | Form-thesis: weigh daily state in audit, not as automatic veto | `skills/topstep-form-thesis/SKILL.md` |
| A.4 | Planning prompt: six-hour plan may name daily intent band and stop-trading **questions**, not quotas | `scripts/run-topstep-learning.py` |
| A.5 | Supervisor seeds: example `current-plan.json` / `current-guidance.json` with `outcome_backed: false` | `supervisor-seeds/` |
| A.6 | Tests: prompts contain stage doctrine; no new execution gates in worker | `tests/test_learning.py`, `tests/test_direct_cycle.py` |

### Phase B — Consume TS-R3-04

| ID | Change | Files |
|----|--------|-------|
| B.1 | Surface `daily_economics` in `packet_for_model` / decision prompt | `scripts/packet_model.py`, `scripts/run-topstep-cycle.py` |
| B.2 | `topstep-assess-risk` documents field semantics | skill |
| B.3 | Hourly/daily learning references band position when mirror present | `scripts/run-topstep-learning.py` |

### Phase C — Operator controls (optional)

| ID | Change | Files |
|----|--------|-------|
| C.1 | Document `/pause` or directive `daily_objective_met` as operator override | `SOUL.md`, `docs/OPERATIONS.md`, plugin |

---

## Acceptance

- SOUL and skills state clearly: **daily profit is an objective; Hermes owns stop/continue; Glitch does not gate entries on PnL band.**
- Eval and approved stages have distinct playbook text in profile artifacts.
- After TS-R3-04: packet carries `daily_economics` mirror; Hermes prompt includes it without inventing values when null.
- Planning/hourly loops may reference band position; learning prompts still forbid “manufacture a daily target”.
- No regression to GTHP-009: flat cadence and evidence visibility unchanged; no worker skip on PnL.
- `docs/AUTHORITY.md` cross-reference added (profile doc link only; gateway doc unchanged).

## Stop line

Do not implement v2 guardian profit lock, automatic entry ban at +1.5%, or cron suppression when daily goal is met. Any future **operator-opt-in** hard lock requires a separate AUTHORITY amendment and explicit issue — out of scope for GTHP-017.

## Related

- GTHP-009 (removed hidden vetoes)
- GTHP-012 (outcome-backed learning)
- `glitch-topstep:TS-R3-04` (packet daily economics mirror)
- GPT `GLITCH_V2_MODIFICATIONS.md` §13, §23, §24 (cherry-pick evidence, reject engine lock)
