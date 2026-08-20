import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketObservationState } from "../src/domain/market-observation.js";
import type { ProjectXOrderFlowState } from "../src/domain/order-flow.js";
import {
  buildDecisionPacket,
  buildMarketAlignment,
  MARKET_ALIGNMENT_SYNCHRONIZED_MAX_LAG_MS,
} from "../src/hermes/packet-builder.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import { snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

const NOW = new Date("2026-08-20T19:50:17.000Z");
const recovery = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

const risk = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

function observation1m(latestBarUtc: string, partial: boolean): MarketObservationState {
  return {
    last_attempt_utc: NOW.toISOString(),
    last_succeeded_utc: NOW.toISOString(),
    last_error: null,
    observation: {
      schema_version: "glitch.projectx.market_observation.v1",
      instrument: "MNQ",
      contract_id: "CON.F.US.MNQ.U26",
      generated_utc: NOW.toISOString(),
      source: "projectx_bars",
      timeframes: [{
        timeframe_minutes: 1,
        bars_received: 100,
        bars_accepted: 100,
        rejected_bars: 0,
        latest_bar_utc: latestBarUtc,
        latest_bar_partial: partial,
        current_partial_bar: partial
          ? {
              timestamp: latestBarUtc,
              open: 29_310,
              high: 29_312,
              low: 29_309,
              close: 29_311,
              volume: 120,
            }
          : null,
        prior_completed_bar: null,
        partial_progress: partial ? 0.28 : null,
        bar_identity_issues: [],
        gaps: [],
        features: null,
      }],
    },
  };
}

function orderFlow(generatedUtc: string): ProjectXOrderFlowState {
  return {
    last_attempt_utc: generatedUtc,
    last_succeeded_utc: generatedUtc,
    last_error: null,
    observation: {
      schema_version: "glitch.projectx.order_flow.v1",
      generated_utc: generatedUtc,
      source: "projectx_market_evidence",
      contract_id: "CON.F.US.MNQ.U26",
      lookback_start_utc: "2026-08-20T19:45:00.000Z",
      through_sequence: 1,
      events_read: 1,
      truncated: false,
      source_complete: true,
      invalid_events: 0,
      windows: [],
      depth: {
        depth_levels_requested: 10,
        available: false,
        unavailable_reason: null,
        reconstruction_basis: "bounded_window_without_reset",
        book_complete: false,
        latest_reset_sequence: null,
        best_bid: null,
        best_ask: null,
        spread_ticks: null,
        bid_volume: 0,
        ask_volume: 0,
        imbalance_ratio: null,
        bid_levels: [],
        ask_levels: [],
        depth_events_applied: 0,
        depth_events_ignored: 0,
        depth_events_invalid: 0,
      },
      issues: [],
      last_trade_utc: generatedUtc,
    },
  };
}

function freshVenue(quoteTimestamp: string) {
  const base = snapshot();
  return {
    ...base,
    capturedAt: NOW.toISOString(),
    quote: {
      ...base.quote!,
      timestamp: quoteTimestamp,
    },
    operational: {
      ...base.operational,
      userStream: {
        ...base.operational.userStream,
        lastEventAt: quoteTimestamp,
      },
      marketStream: {
        ...base.operational.marketStream,
        lastEventAt: quoteTimestamp,
      },
      reconciliation: {
        ...base.operational.reconciliation,
        lastSucceededAt: quoteTimestamp,
      },
    },
  };
}

describe("buildMarketAlignment", () => {
  it("marks synchronized when quote and partial 1m bar open are aligned", () => {
    const venue = freshVenue("2026-08-20T19:50:17.000Z");
    const quality = evaluateSnapshotDataQuality(venue, risk, NOW);
    const alignment = buildMarketAlignment(
      NOW,
      venue.quote,
      observation1m("2026-08-20T19:50:00.000Z", true),
      orderFlow("2026-08-20T19:50:10.000Z"),
      quality,
      risk,
    );

    assert.equal(alignment.synchronized, true);
    assert.equal(alignment.lags_ms.quote_vs_1m_bar_open, 17_000);
    assert.equal(alignment.timing_reference.features_reference_1m, "partial_bar");
    assert.ok(alignment.notes.some((note) => note.includes("candle open times")));
  });

  it("marks unsynchronized without adding execution issues when bars lag materially", () => {
    const venue = freshVenue("2026-08-20T19:50:17.000Z");
    const quality = evaluateSnapshotDataQuality(venue, risk, NOW);
    const alignment = buildMarketAlignment(
      NOW,
      venue.quote,
      observation1m("2026-08-20T19:48:00.000Z", false),
      orderFlow("2026-08-20T19:50:10.000Z"),
      quality,
      risk,
    );

    assert.equal(alignment.synchronized, false);
    assert.equal(alignment.lags_ms.quote_vs_1m_bar_open, 137_000);
    assert.ok(alignment.lags_ms.quote_vs_1m_bar_open! > MARKET_ALIGNMENT_SYNCHRONIZED_MAX_LAG_MS);
    assert.ok(alignment.notes.some((note) => note.includes("advisory_only")));

    const packet = buildDecisionPacket(
      venue,
      {
        accountStage: "express_funded_standard",
        authority: "operator_configured",
        verifiedAtUtc: null,
        lossModel: "express_funded_eod",
        startingBalance: 50_000,
        initialMaximumLoss: 2_000,
        highestEndOfDayBalance: 0,
        lossFloorLockedAtZero: false,
        payoutProcessed: false,
        operatorProvidedLossFloorUsd: null,
        maxContracts: 5,
      },
      risk,
      recovery,
      "MNQ",
      "shadow",
      300_000,
      NOW,
      observation1m("2026-08-20T19:48:00.000Z", false),
      orderFlow("2026-08-20T19:50:10.000Z"),
      [],
      testSessionConfig,
      null,
      null,
      undefined,
      false,
      false,
    );

    assert.equal(packet.market_alignment.synchronized, false);
    assert.equal(packet.data_quality.state_complete, true);
    assert.equal(packet.execution.new_exposure_technically_supported, true);
    assert.deepEqual(packet.data_quality.issues, []);
  });
});
