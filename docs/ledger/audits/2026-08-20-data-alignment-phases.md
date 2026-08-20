# Data alignment phases A–D — implementation plan

**Date:** 2026-08-20  
**Ledger item:** `TS-DATA-01`  
**Issue:** [#171](https://github.com/GlitchTrader/glitch-topstep/issues/171)  
**Authority:** `docs/ledger/ledger.json`  
**Spec:** `docs/specs/TS-DATA-01.md`  
**Origin:** external prompt review; operator constraint: **do not block trades or inflate NOTHING**

## Problem statement

Decision packets combine sub-second quotes, ~10 s order-flow rebuilds, and ~60 s REST bar refresh. Features on 1m bars can describe structure 1–2 minutes behind live tape. The model may treat EMA/VWAP/range distance as current price context. Depth BBO can diverge within the 8-tick sanitize threshold. Session high/low can be null while `session_levels_reliable` stays true.

## Design principle

**Fix freshness → expose alignment → sanitize misleading evidence → teach cognition.**  
Never: `bar_lag` in `state_complete`, prompt rules that force NOTHING on lag, or depth/session fixes that downgrade `armed`.

---

## Phase A — Gateway freshness + alignment metadata

| ID | Task | Owner | Files | Done when |
|----|------|-------|-------|-----------|
| A1 | Coalesced on-demand `retrieveBars` for selected contract before `/packet` | gateway | `service.ts`, `packet-service.ts`, `projectx-observation-service.ts` | 1m `latest_bar_utc` within 1 min of quote in RTH fixture test |
| A2 | Add `market_alignment` to `DirectDecisionPacket` | gateway | `packet-builder.ts`, tests | Block populated; `synchronized` does not affect gates |
| A3 | `features_reference` + `timing_note` on compact 1m observation | gateway + Hermes | `packet_model.py`, optional `observation.ts` | Model packet shows partial vs completed role |

**Implementation notes (A1):**

```typescript
// ponytail: in LocalGatewayServer packet handler or DecisionPacketService.current()
// await selectedContractObservation.refresh() once if last_succeeded_utc older than e.g. 45s
// scanner refreshAll() unchanged on 60s timer
```

**Implementation notes (A2):**

```typescript
function buildMarketAlignment(
  now: Date,
  quote: QuoteInfo | null,
  orderFlow: ProjectXOrderFlowState,
  marketObservation: MarketObservationState,
): MarketAlignmentPacket {
  const tf1 = marketObservation.observation?.timeframes.find(t => t.timeframe_minutes === 1);
  const quoteMs = quote?.timestamp ? Date.parse(quote.timestamp) : null;
  const barOpenMs = tf1?.latest_bar_utc ? Date.parse(tf1.latest_bar_utc) : null;
  const lag = quoteMs && barOpenMs ? quoteMs - barOpenMs : null;
  return {
    // ...
    synchronized: lag !== null && lag <= 90_000 && /* quote_age ok */,
  };
}
```

**Rollout:** ship A1+A2 together; A3 can follow in same PR or immediate follow-up.

---

## Phase B — Evidence hygiene (no gates)

| ID | Task | Owner | Files | Done when |
|----|------|-------|-------|-----------|
| B1 | `DEPTH_QUOTE_MAX_DIVERGENCE_TICKS` 8 → 4 (shared) | gateway + Hermes | `packet-builder.ts`, `packet_model.py` | Review cycle example (7 ticks) sanitizes depth |
| B2 | `raw_available` / `integrity_valid` on depth | gateway | `packet-builder.ts`, `order-flow.ts` | Fields present; optional_issues unchanged |
| B3 | `session_levels.available` separate from `reliable` | gateway + Hermes | `resolveSessionMarketLevels`, `sanitize_market_for_model` | Impossible null+reliable combo |

**Regression suite:** `tests/packet-order-flow.test.ts`, `tests/structural-levels.test.ts`, Hermes `test_packet_model.py`.

---

## Phase C — Hermes cognition (paired profile)

| ID | Task | Owner | Files | Done when |
|----|------|-------|-------|-----------|
| C1 | Lag-aware timing vs structure rules | Hermes | `run-topstep-cycle.py`, `topstep-observe-market/SKILL.md` | Frozen fixture: lagged packet still allows ENTER when structure supports |
| C2 | Symmetric scanner ranking rule | Hermes | `CYCLE_OPERATOR_INSTRUCTION`, `topstep-form-thesis/SKILL.md` | Prompt explicit; no code gate |
| C3 | Four-block prompt layout | Hermes | `SOUL.md` or `PROMPT-LAYOUT.md` | Reviewable diff; no schema change |

**Profile label:** `GTHP-DATA-01` (sub-items A/C mirror gateway phases).

**Validation:** extend frozen cognition corpus with one lagged-bar fixture; assert no mandatory NOTHING.

---

## Phase D — Conditional (metrics-gated)

| ID | Task | Gate | Effort |
|----|------|------|--------|
| D1 | Order flow per scanner candidate | Ranking bias audit | High |
| D2 | Native `instrument_comparison` JSON | Parse failure rate | High |

**Do not schedule D1/D2 until A–C metrics stable.**

---

## PR strategy

1. **PR1 (gateway):** A1 + A2 + tests — `feat/data-alignment-phase-a`
2. **PR2 (gateway):** B1–B3 — `feat/data-evidence-hygiene-phase-b`
3. **PR3 (Hermes profile):** A3 + C1–C3 — paired with PR2 merge
4. **PR4+ (optional):** D* only after metric review

## Paired repositories

| Gateway | Hermes profile |
|---------|----------------|
| `GlitchTrader/glitch-topstep` | `GlitchTrader/glitch-topstep-hermes-profile` |
| TS-DATA-01 | GTHP-DATA-01 |

Release compatibility bump only if packet schema additive fields require `GATEWAY_COMPATIBILITY` note (alignment block is additive to v2 packet, not a breaking change).
