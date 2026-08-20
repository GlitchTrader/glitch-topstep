import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectXOrderFlowState } from "../src/domain/order-flow.js";
import {
  DEPTH_QUOTE_MAX_DIVERGENCE_TICKS,
  buildDecisionPacket,
  emptyMarketObservationState,
  emptyOrderFlowState,
  sanitizeOrderFlowDepthAgainstQuote,
} from "../src/hermes/packet-builder.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { snapshot, testSessionConfig } from "./fixtures.js";

const TICK = 0.25;
const NOW = Date.parse("2026-07-21T12:00:05Z");
const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

function depthOrderFlow(bestBid: number, bestAsk: number): ProjectXOrderFlowState {
  return {
    last_attempt_utc: "2026-07-21T12:00:00Z",
    last_succeeded_utc: "2026-07-21T12:00:00Z",
    last_error: null,
    observation: {
      schema_version: "glitch.projectx.order_flow.v1",
      generated_utc: "2026-07-21T12:00:00Z",
      source: "projectx_market_evidence",
      contract_id: "CON.F.US.MNQ.U26",
      lookback_start_utc: "2026-07-21T11:55:00Z",
      through_sequence: 1,
      events_read: 1,
      truncated: false,
      source_complete: true,
      invalid_events: 0,
      windows: [],
      depth: {
        depth_levels_requested: 10,
        available: true,
        unavailable_reason: null,
        reconstruction_basis: "bounded_window_without_reset",
        book_complete: false,
        latest_reset_sequence: null,
        best_bid: bestBid,
        best_ask: bestAsk,
        spread_ticks: 1,
        bid_volume: 10,
        ask_volume: 8,
        imbalance_ratio: 0.1,
        bid_levels: [{ price: bestBid, current_volume: 10 }],
        ask_levels: [{ price: bestAsk, current_volume: 8 }],
        depth_events_applied: 1,
        depth_events_ignored: 0,
        depth_events_invalid: 0,
      },
      issues: [],
      last_trade_utc: null,
    },
  };
}

test("TS-DATA-01 B1: seven-tick depth divergence is sanitized at four ticks", () => {
  assert.equal(DEPTH_QUOTE_MAX_DIVERGENCE_TICKS, 4);
  const quote = snapshot().quote!;
  const quoteBid = quote.bestBid;
  const quoteAsk = quote.bestAsk;
  const divergedBid = quoteBid + 7 * TICK;
  const sanitized = sanitizeOrderFlowDepthAgainstQuote(
    depthOrderFlow(divergedBid, quoteAsk),
    quote,
    TICK,
  );
  assert.equal(sanitized.observation?.depth.available, false);
  assert.equal(sanitized.observation?.depth.unavailable_reason, "depth_bbo_diverges_from_quote");
});

test("TS-DATA-01 B2: depth exposes raw_available and integrity_valid", () => {
  const aligned = sanitizeOrderFlowDepthAgainstQuote(
    depthOrderFlow(20_000, 20_000.25),
    snapshot().quote,
    TICK,
  );
  assert.equal(aligned.observation?.depth.raw_available, true);
  assert.equal(aligned.observation?.depth.integrity_valid, true);

  const diverged = sanitizeOrderFlowDepthAgainstQuote(
    depthOrderFlow(20_050, 20_050.25),
    snapshot().quote,
    TICK,
  );
  assert.equal(diverged.observation?.depth.raw_available, true);
  assert.equal(diverged.observation?.depth.integrity_valid, false);
});

test("TS-DATA-01 B3: session_levels.available is separate from reliable", () => {
  const base = snapshot();
  const mirrored = {
    ...base,
    quote: {
      ...base.quote!,
      lastPrice: 20_000,
      open: 20_000,
      high: 20_000,
      low: 20_000,
    },
  };
  const packet = buildDecisionPacket(
    mirrored,
    {
      accountStage: "express_funded_standard",
      lossModel: "express_funded_eod",
      authority: "operator_configured",
      verifiedAtUtc: null,
      startingBalance: 50_000,
      initialMaximumLoss: 2_000,
      highestEndOfDayBalance: 0,
      lossFloorLockedAtZero: false,
      payoutProcessed: false,
      operatorProvidedLossFloorUsd: null,
      maxContracts: 5,
    },
    {
      estimatedRoundTurnFeesUsd: 2.5,
      slippageReserveTicks: 2,
      maxQuoteAgeMs: 5_000,
      maxStateAgeMs: 5_000,
      maxIntentAgeMs: 300_000,
    },
    recovery,
    "MNQ",
    "shadow",
    300_000,
    new Date(NOW),
    emptyMarketObservationState(),
    emptyOrderFlowState(),
    [],
    testSessionConfig,
    null,
  );
  assert.equal(packet.market.session_levels_reliable, false);
  assert.equal(packet.market.session_high, null);
  assert.equal(packet.market.session_low, null);
  assert.equal(packet.market.session_levels.available, true);
  assert.equal(packet.market.session_levels.reliable, false);
  assert.equal(packet.market.session_levels.reason, "mirror_last_open_heuristic");
});
