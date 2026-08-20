# TS-DATA-01 — Data temporal alignment and evidence hygiene (phases A–D)

**Issue:** [#171](https://github.com/GlitchTrader/glitch-topstep/issues/171)  
**Priority:** P1  
**Status:** planned  
**Origin:** prompt review `glitch-topstep-prompt-review.md` (2026-08-20)

## Intent

Reduce quote/bar/order-flow temporal divergence and ambiguous evidence **without** adding execution gates or forcing flat `NOTHING`. Mixed or lagged evidence lowers timing confidence; structure and falsifiable theses may still justify entry.

## Authority invariant (non-negotiable)

1. `market_alignment`, depth integrity, and session-level semantics are **cognition evidence only**.
2. They must **not** appear in `data_quality.issues` or flip `state_complete`.
3. They must **not** downgrade `gateway_mode` or block `new_exposure_technically_supported`.
4. Prompt language must **not** require perfect bar/quote sync as a universal entry gate.

## Root cause (why divergence exists)

| Source | Channel | Typical cadence | Timestamp semantics |
|--------|---------|-----------------|---------------------|
| Quote | SignalR | sub-second | event time |
| Order flow | evidence SQLite rebuild | 10 s | `generated_utc`, window aggregates |
| Bars | REST `retrieveBars` | 60 s (+ scanner rate limit) | candle **open** time (`latest_bar_utc`) |

Lag of 1–2 minutes between live quote and last **completed** 1m bar is expected when partial-bar roles are misread or bar refresh is timer-bound. Fix freshness first; expose alignment second; tune evidence third.

---

## Phase A — Reduce lag at source (gateway, no new vetoes)

**Goal:** Fresher bars at packet time + explicit alignment metadata.

### A1 — On-demand bar refresh for selected contract

**Files:** `src/service.ts`, `src/hermes/packet-service.ts` (if packet build path differs), `src/market/projectx-observation-service.ts`

**Change:**

- Before `DecisionPacketService.current()` / `/packet` response, await a bar refresh for the **selected** contract only (not full scanner `refreshAll` unless already scheduled).
- Keep existing 60 s background timer for scanner candidates; selected contract gets an extra refresh coalesced with in-flight work (`ProjectXMarketObservationService.refresh()` dedupes via `inFlight`).
- ponytail: coalesce — at most one extra refresh per packet request; do not N×4 REST calls per second.

**Acceptance:**

- `market_observation.last_succeeded_utc` within one REST cycle of `packet.created_utc` under normal load.
- `latest_bar_utc` for 1m is current partial open or prior minute, not two+ minutes stale vs quote during RTH.
- Rate limit headroom unchanged for 3-candidate scanner (measure via `scheduler` status in scanner packet).

**Tests:** extend `tests/market-observation.test.ts` or add `tests/packet-bar-freshness.test.ts` with fixed clock + mocked `retrieveBars`.

### A2 — `market_alignment` block on decision packet v2

**Files:** `src/hermes/packet-builder.ts`, `src/domain/models` if typed, `tests/packet-builder.test.ts` (or new)

**Schema (additive):**

```yaml
market_alignment:
  packet_created_utc: string
  quote_timestamp: string | null
  order_flow_generated_utc: string | null
  order_flow_last_trade_utc: string | null
  bars:
    "1": { latest_bar_open_utc, latest_bar_partial, observation_succeeded_utc }
    "5": { ... }
  lags_ms:
    quote_vs_1m_bar_open: number | null
    quote_vs_order_flow: number | null
    packet_vs_observation_1m: number | null
  timing_reference:
    price_for_timing: "quote"   # bid/ask/last authority unchanged
    features_reference_1m: "partial_bar" | "completed_bar"
  synchronized: boolean         # advisory; true when all lags below threshold
  notes: string[]
```

**Thresholds (advisory only):**

- `synchronized: true` when `quote_vs_1m_bar_open <= 90_000` ms AND `quote_age_ms <= maxQuoteAgeMs` AND 1m observation succeeded this packet cycle.
- Never push `bar_lag` into `data_quality.issues`.

**Acceptance:**

- Block present on every v2 packet when quote and 1m observation exist.
- `synchronized` false does not change execution gates in tests.

### A3 — Clarify partial vs completed on compact observation

**Files:** `src/market/observation.ts` (if needed), Hermes `scripts/packet_model.py` `compact_market_observation_state`

**Change:**

- On 1m timeframe in model-facing compact output, include `features_reference: "partial_bar"|"completed_bar"` derived from `latest_bar_partial`.
- Add one-line `timing_note` when partial: "bar timestamps are open times; use quote for executable price."

**Paired profile:** `GTHP-DATA-01-A` — consume fields in `topstep-observe-market` skill (read-only).

---

## Phase B — Evidence hygiene (gateway + Hermes sanitize, no vetoes)

**Goal:** Discard misleading depth/session edges; never block entry.

### B1 — Tighten depth vs quote divergence

**Files:**

- `src/hermes/packet-builder.ts` — `DEPTH_QUOTE_MAX_DIVERGENCE_TICKS` (currently 8)
- `.hermes-foundation2/scripts/packet_model.py` — `sanitize_depth_for_model` max_ticks (must match)

**Change:** Reduce to **4 ticks** (config env optional later: `GLITCH_DEPTH_QUOTE_MAX_DIVERGENCE_TICKS`). Review example (7 ticks) would correctly mark depth unavailable.

**Acceptance:**

- `tests/packet-order-flow.test.ts` updated for new threshold.
- Hermes `tests/test_packet_model.py` diverged depth case still passes.
- `data_quality.state_complete` remains true when depth marked unavailable.

### B2 — Depth integrity fields

**Files:** `src/hermes/packet-builder.ts`, `src/domain/order-flow.ts`, Hermes `packet_model.py`

**Change (additive on depth object):**

```yaml
raw_available: boolean      # reconstruction succeeded before sanitize
integrity_valid: boolean    # false when geometry bad or quote diverges
unavailable_reason: string | null
```

Gateway sets these in `sanitizeOrderFlowDepthAgainstQuote`; Hermes sanitize respects gateway flags.

### B3 — Session levels `available` vs `reliable`

**Files:** `src/hermes/packet-builder.ts` `resolveSessionMarketLevels`, Hermes `sanitize_market_for_model`

**Change:**

- `available: high != null && low != null`
- `reliable: available && !mirror_last_open_heuristic`
- When `!available`, force `session_levels_reliable: false` even if quote session fields missing.
- Keep backward-compatible top-level `session_high/low/session_levels_reliable` for one release; add nested `session_levels: { available, reliable, high, low, reason }`.

**Acceptance:** no packet with `session_high=null`, `session_low=null`, `session_levels_reliable=true`.

**Tests:** `tests/structural-levels.test.ts`, Hermes `test_sanitize_market_flags_unreliable_session_levels`.

---

## Phase C — Cognition contract (Hermes profile, no forced NOTHING)

**Goal:** Model uses alignment to calibrate timing confidence, not abstain by default.

### C1 — Alignment cognition rules

**Files:** `.hermes-foundation2/scripts/run-topstep-cycle.py` (`CYCLE_OPERATOR_INSTRUCTION`), `skills/topstep-observe-market/SKILL.md`, `SOUL.md` (short pointer)

**Rules to add:**

- When `market_alignment.synchronized` is false: use quote + order flow for **timing**; use 5m/60m + partial 1m for **structure**.
- Do **not** choose flat `NOTHING` solely because bar lag exceeds threshold.
- Reduce confidence on timing-sensitive entries when lag > 90 s; state lag in `disconfirming_evidence`, not as automatic veto.

### C2 — Symmetric multi-instrument ranking (Option B)

**Files:** `CYCLE_OPERATOR_INSTRUCTION`, `skills/topstep-form-thesis/SKILL.md`

**Rule:** Cross-instrument ranking uses evidence classes present for **all** candidates (bars, quote, observation quality). Order flow on selected contract is **post-selection** microstructure, not a ranking bonus for MNQ.

### C3 — Prompt organization (four blocks)

**Files:** `SOUL.md` or new `docs/PROMPT-LAYOUT.md` in profile; refactor `CYCLE_OPERATOR_INSTRUCTION` into labeled sections: MANDATORY COGNITION | EVIDENCE RULES | ACTION CONTRACT | OUTPUT CONTRACT.

**Non-goal:** change gateway schema or validation in this sub-phase.

**Paired profile issue label:** `GTHP-DATA-01-C`

---

## Phase D — Conditional / schema migration (metrics-gated)

**Do not start until Phase A–C shipped and measured for 5+ sessions.**

### D1 — Order flow per scanner candidate

**Gate:** Documented bias in decision logs (MNQ wins ranking >80% when only candidate with flow).

**Scope:** Partitioned evidence or scoped rebuild per contract in `MultiInstrumentMarketDataPlane`; respect `GLITCH_DEPTH_ALLOWLIST` and rate limits.

**Stop line:** No default-on; observation-only flow for non-selected contracts.

### D2 — Native `instrument_comparison` object

**Gate:** JSON-in-string parse failure rate >0 in production decisions.

**Scope:** Extend `decision_audit` with `instrument_comparison` object; gateway `AUDIT_FIELDS`; Hermes `scanner_contract.py` migration; learning pipeline; deprecate `INSTRUMENT_COMPARISON_V1:` prefix in `decisive_evidence`.

**Stop line:** No breaking v3 intent without compatibility window.

---

## Success metrics (before/after Phase A–C)

| Metric | Must not regress | Should improve |
|--------|------------------|----------------|
| Flat `NOTHING` rate | ±5% relative | stable or down |
| Gateway `ENTER_*` rejections | no increase | stable |
| Median `quote_vs_1m_bar_open` lag | — | down ≥30% |
| Decisions citing lag as sole abstention reason | — | rare (<2%) |
| Invalid depth used in decisive_evidence | — | down |

## Stop line (whole initiative)

Do not convert temporal misalignment, depth unavailability, or missing session levels into execution gates, quota pressure, or mandatory flat abstention. Participation doctrine from TS-AUDIT-03 and TS-CAP-01 remains authoritative.

## Sources

- `src/hermes/packet-builder.ts`
- `src/market/observation.ts`
- `src/market/projectx-observation-service.ts`
- `src/service.ts`
- `.hermes-foundation2/scripts/packet_model.py`
- `.hermes-foundation2/scripts/run-topstep-cycle.py`
- `docs/ledger/audits/2026-08-20-data-alignment-phases.md`
