# ISSUE-74 — structural packet evidence (gateway side, 2026-08-20)

Proof bundle for paired release with Hermes profile [#74](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/74): gateway publishes deterministic structural context in `decision_packet.v2`.

## Acceptance mapping

| Criterion | Evidence |
|-----------|----------|
| `structural_levels` in packet v2 | `src/market/structural-levels.ts`, `src/hermes/packet-builder.ts` |
| PDH/PDL, session open, VWAP 5m, swing bars, tape 60s, EMA 200 | `buildStructuralLevels()` with nullable fields when observation incomplete |
| `price_delta_relationship` in packet v2 | `src/market/price-delta-relationship.ts`, wired in `packet-builder.ts` |
| 15/60/300s alignment summary (`aligned|conflict|neutral|unknown`) | `buildPriceDeltaRelationship()` + `tests/price-delta-relationship.test.ts` |
| No execution gates on new fields | Evidence-only packet fields; no coordinator/admission changes |
| Regression suite green | `npm run check` — 365 tests |

## Paired profile

- Hermes `GTHP-031` consumes `structural_levels`, `price_delta_relationship`, `regime`, optional `decision_scores`
- Gateway `0.2.1` + profile `0.2.1`

## Non-goals

- Strategy gates on structural alignment
- Automatic flatten or entry suppression from price/delta conflict alone
