import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { RiskSettings, TopstepPolicyState } from "../src/domain/models.js";
import {
  dataQualityHealthFields,
  evaluateSnapshotDataQuality,
  mutationBlockCode,
  resetQuoteGeometryTelemetryRetentionForTest,
} from "../src/state/data-quality.js";
import { classifyQuoteState } from "../src/state/quote-state.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import { orderFlowWithTrades, snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

const policy: TopstepPolicyState = {
  accountStage: "practice",
  lossModel: "trading_combine_eod",
  authority: "operator_configured",
  verifiedAtUtc: null,
  startingBalance: 50_000,
  initialMaximumLoss: 2_000,
  highestEndOfDayBalance: 0,
  lossFloorLockedAtZero: false,
  payoutProcessed: false,
  operatorProvidedLossFloorUsd: null,
  maxContracts: 1,
};

const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

/** Preserved from PRAC-SOAK-2026-09-09-v2/quote-quality-analysis.json */
const LOCKED_EPISODES = [
  { best_bid: 29423.75, best_ask: 29423.75, reconnect_generation: 1, quote_timestamp: "2026-09-09T16:34:00.7436079+00:00", snapshot_captured_at: "2026-09-09T16:33:57.519Z" },
  { best_bid: 29456, best_ask: 29456, reconnect_generation: 3, quote_timestamp: "2026-09-09T16:47:59.0421402+00:00", snapshot_captured_at: "2026-09-09T16:47:56.545Z" },
  { best_bid: 29456, best_ask: 29456, reconnect_generation: 3, quote_timestamp: "2026-09-09T16:47:59.0421402+00:00", snapshot_captured_at: "2026-09-09T16:47:56.545Z" },
  { best_bid: 29472.25, best_ask: 29472.25, reconnect_generation: 3, quote_timestamp: "2026-09-09T16:53:19.0401922+00:00", snapshot_captured_at: "2026-09-09T16:53:15.604Z" },
  { best_bid: 29467.75, best_ask: 29467.75, reconnect_generation: 3, quote_timestamp: "2026-09-09T16:57:15.1433827+00:00", snapshot_captured_at: "2026-09-09T16:57:13.107Z" },
  { best_bid: 29467.75, best_ask: 29467.75, reconnect_generation: 3, quote_timestamp: "2026-09-09T16:57:15.1433827+00:00", snapshot_captured_at: "2026-09-09T16:57:13.107Z" },
] as const;

afterEach(() => {
  resetQuoteGeometryTelemetryRetentionForTest();
});

describe("classifyQuoteState", () => {
  it("classifies bid < ask as normal", () => {
    assert.deepEqual(classifyQuoteState(100, 100.25), {
      quote_state: "normal",
      reason_codes: ["normal"],
    });
  });

  it("classifies bid == ask as locked", () => {
    assert.deepEqual(classifyQuoteState(100, 100), {
      quote_state: "locked",
      reason_codes: ["locked_bbo"],
    });
  });

  it("classifies bid > ask as invalid", () => {
    const result = classifyQuoteState(101, 100);
    assert.equal(result.quote_state, "invalid");
    assert.ok(result.reason_codes.includes("crossed_bbo"));
  });

  it("classifies missing bid/ask as invalid", () => {
    assert.equal(classifyQuoteState(null, 100).quote_state, "invalid");
    assert.equal(classifyQuoteState(100, null).quote_state, "invalid");
    assert.equal(classifyQuoteState(undefined, undefined).quote_state, "invalid");
  });

  it("classifies NaN/Infinity/zero as invalid", () => {
    assert.equal(classifyQuoteState(Number.NaN, 100).quote_state, "invalid");
    assert.equal(classifyQuoteState(100, Number.POSITIVE_INFINITY).quote_state, "invalid");
    assert.equal(classifyQuoteState(0, 100).quote_state, "invalid");
    assert.equal(classifyQuoteState(100, 0).quote_state, "invalid");
  });
});

describe("quote_state transitions and health/packet parity", () => {
  it("transitions locked → normal", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000 };
    const locked = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(locked.quoteState, "locked");
    assert.equal(locked.executionEligibility, "blocked_locked");
    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25 };
    const ok = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(ok.quoteState, "normal");
    assert.equal(ok.executionEligibility, "eligible");
    assert.equal(ok.stateComplete, true);
  });

  it("transitions invalid → normal", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20100, bestAsk: 20000 };
    const bad = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(bad.quoteState, "invalid");
    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25 };
    const ok = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(ok.quoteState, "normal");
    assert.equal(ok.stateComplete, true);
  });

  it("reconnect generation during locked stays blocked_locked", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 29456, bestAsk: 29456, lastPrice: 29456 };
    locked.operational.generation = 3;
    const result = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"), {
      quoteSource: "projectx_quote_stream",
    });
    assert.equal(result.quoteState, "locked");
    assert.equal(result.executionEligibility, "blocked_locked");
    assert.equal(result.quoteGeometryTelemetry?.reconnect_generation, 3);
    assert.equal(mutationBlockCode(result), "quote_locked");
  });

  it("health and packet share the same quote_state decision", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 29423.75, bestAsk: 29423.75, lastPrice: 29423.75 };
    const now = new Date("2026-07-21T12:00:05Z");
    const quality = evaluateSnapshotDataQuality(locked, settings, now);
    const health = dataQualityHealthFields(quality, now);
    const packet = buildDecisionPacket(
      locked,
      policy,
      settings,
      recovery,
      "MNQ",
      "shadow",
      300_000,
      now,
      undefined,
      orderFlowWithTrades(1),
    );
    assert.equal(health.quote_state, "locked");
    assert.equal(health.execution_eligibility, "blocked_locked");
    assert.equal(packet.data_quality.quote_state, "locked");
    assert.equal(packet.data_quality.execution_eligibility, "blocked_locked");
    assert.equal(packet.data_quality.data_completeness, true);
    assert.equal(packet.data_quality.state_complete, false);
    assert.ok(packet.data_quality.issues.includes("quote_locked"));
  });
});

describe("locked_bbo episode offline replay", () => {
  it("replays six preserved locked_bbo episodes as locked with zero execution eligibility", () => {
    assert.equal(LOCKED_EPISODES.length, 6);
    for (const episode of LOCKED_EPISODES) {
      const classified = classifyQuoteState(episode.best_bid, episode.best_ask);
      assert.equal(classified.quote_state, "locked");
      const current = snapshot();
      current.capturedAt = episode.snapshot_captured_at;
      current.operational.generation = episode.reconnect_generation;
      current.quote = {
        ...current.quote!,
        bestBid: episode.best_bid,
        bestAsk: episode.best_ask,
        lastPrice: episode.best_bid,
        timestamp: episode.quote_timestamp,
      };
      const quality = evaluateSnapshotDataQuality(
        current,
        settings,
        new Date(Date.parse(episode.snapshot_captured_at) + 1_000),
      );
      assert.equal(quality.quoteState, "locked");
      assert.equal(quality.executionEligibility, "blocked_locked");
      assert.equal(mutationBlockCode(quality), "quote_locked");
      assert.equal(quality.stateComplete, false);
    }
  });
});
