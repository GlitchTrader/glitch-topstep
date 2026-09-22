import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSnapshotDataQuality,
} from "../src/state/data-quality.js";
import { isReconciliationCurrent, VenueStateStore } from "../src/state/venue-state.js";
import {
  contractIdFromQuoteRawPayload,
  isQuoteBboIncompleteError,
  RateLimitedQuoteBboIncompleteLog,
} from "../src/projectx/quote-bbo-fault.js";
import { parseQuote } from "../src/projectx/schemas.js";

const stamp = "2026-09-09T18:00:00Z";
const CONTRACT = "CON.F.US.MNQ.U26";
const RISK = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
} as const;

function qualityOf(snap: ReturnType<VenueStateStore["buildSnapshot"]>) {
  return evaluateSnapshotDataQuality(snap, RISK, new Date(stamp));
}

function readyState(): VenueStateStore {
  const state = new VenueStateStore();
  state.registerContracts([{
    id: "MNQ",
    name: "MNQ",
    description: "MNQ",
    tickSize: 0.25,
    tickValue: 0.5,
    activeContract: true,
    symbolId: "F.US.MNQ",
  }]);
  state.replaceAccounts([{
    id: 1,
    name: "SIM",
    balance: 100_000,
    canTrade: true,
    isVisible: true,
  }], stamp);
  state.replacePositions([], stamp);
  state.replaceOrders([], stamp);
  state.markStreamConnected("user", stamp);
  state.markStreamConnected("market", stamp);
  state.applyQuote({
    contractId: "MNQ",
    symbol: "F.US.MNQ",
    lastPrice: 20_010.25,
    bestBid: 20_010,
    bestAsk: 20_010.25,
    open: 20_000,
    high: 20_020,
    low: 19_990,
    volume: 1_000,
    timestamp: stamp,
  }, stamp);
  state.markStreamEvent("user", stamp);
  state.markStreamEvent("market", stamp);
  state.markReconciliationStarted(stamp);
  state.markReconciliationSucceeded(stamp);
  return state;
}

function validQuote(overrides: Partial<{
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  timestamp: string;
}> = {}) {
  const bestBid = overrides.bestBid ?? 20_010;
  const bestAsk = overrides.bestAsk ?? 20_010.25;
  return {
    contractId: "MNQ",
    symbol: "F.US.MNQ",
    lastPrice: overrides.lastPrice ?? (bestBid + bestAsk) / 2,
    bestBid,
    bestAsk,
    open: 20_000,
    high: 20_020,
    low: 19_990,
    volume: 1_000,
    timestamp: overrides.timestamp ?? stamp,
  };
}

describe("quote BBO incomplete payload fault (no generation thrash)", () => {
  it("one incomplete BBO clears quote, blocks exposure, keeps generation and reconciliation", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    assert.equal(state.buildSnapshot(1, "MNQ").stateComplete, true);

    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
    const snap = state.buildSnapshot(1, "MNQ");
    const quality = qualityOf(snap);

    assert.equal(state.operationalStatus().generation, before);
    assert.equal(isReconciliationCurrent(snap.operational), true);
    assert.ok(!snap.stateIssues.includes("reconciliation_not_current"));
    assert.ok(snap.stateIssues.includes("quote_missing"));
    assert.equal(snap.operational.marketStream.state, "connected");
    assert.equal(snap.stateComplete, false);
    assert.equal(quality.quoteState, "invalid");
    assert.equal(quality.executionEligibility, "blocked_invalid");
    assert.equal(quality.riskReductionEligibility, "eligible");
    assert.equal(snap.totalOpenContracts, 0);
    assert.equal(snap.openOrders.length, 0);
  });

  it("1000 consecutive incomplete BBOs do not thrash generation or reconciliation", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1_000; i += 1) {
      state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
      // Interleave reconcile success the way live REST would — must stay current.
      if (i % 50 === 0) {
        state.markReconciliationStarted(stamp);
        state.markReconciliationSucceeded(stamp);
      }
    }

    const after = state.operationalStatus();
    const snap = state.buildSnapshot(1, "MNQ");
    const heapAfter = process.memoryUsage().heapUsed;

    assert.equal(after.generation, before);
    assert.equal(state.quoteBboIncompleteTelemetry().total, 1_000);
    assert.equal(isReconciliationCurrent(after), true);
    assert.ok(!snap.stateIssues.includes("reconciliation_not_current"));
    assert.ok(snap.stateIssues.includes("quote_missing"));
    assert.equal(snap.stateComplete, false);
    // Bounded: telemetry is counters only — heap growth must stay well under a pathological Map thrash.
    assert.ok(
      heapAfter - heapBefore < 32 * 1024 * 1024,
      `heap grew too much: ${heapAfter - heapBefore}`,
    );
  });

  it("incomplete then valid BBO recovers to normal without generation bump", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
    assert.equal(state.buildSnapshot(1, "MNQ").stateComplete, false);

    state.applyQuote(validQuote({ timestamp: "2026-09-09T18:00:01Z" }), "2026-09-09T18:00:01Z");
    state.markStreamEvent("market", "2026-09-09T18:00:01Z");
    const snap = state.buildSnapshot(1, "MNQ");
    const quality = qualityOf(snap);

    assert.equal(state.operationalStatus().generation, before);
    assert.equal(snap.stateComplete, true);
    assert.equal(quality.quoteState, "normal");
    assert.equal(quality.executionEligibility, "eligible");
    assert.equal(isReconciliationCurrent(snap.operational), true);
  });

  it("incomplete intercalated with valid BBO never bumps generation", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    for (let i = 0; i < 20; i += 1) {
      state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
      state.applyQuote(validQuote({ lastPrice: 20_010 + i * 0.25 }), stamp);
      state.markStreamEvent("market", stamp);
    }
    assert.equal(state.operationalStatus().generation, before);
    assert.equal(qualityOf(state.buildSnapshot(1, "MNQ")).quoteState, "normal");
  });

  it("locked BBO stays locked classification without generation bump", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.applyQuote(validQuote({ bestBid: 20_010, bestAsk: 20_010 }), stamp);
    const quality = qualityOf(state.buildSnapshot(1, "MNQ"));
    assert.equal(quality.quoteState, "locked");
    assert.equal(quality.executionEligibility, "blocked_locked");
    assert.equal(state.operationalStatus().generation, before);
  });

  it("crossed BBO stays invalid without generation bump", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.applyQuote(validQuote({ bestBid: 20_011, bestAsk: 20_010 }), stamp);
    const quality = qualityOf(state.buildSnapshot(1, "MNQ"));
    assert.equal(quality.quoteState, "invalid");
    assert.equal(quality.executionEligibility, "blocked_invalid");
    assert.equal(state.operationalStatus().generation, before);
  });

  it("real reconnect still bumps generation and requires reconciliation", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.markStreamReconnecting("market", new Error("signalr_reconnecting"), stamp);
    const gap = state.buildSnapshot(1, "MNQ");
    assert.equal(gap.operational.generation, before + 1);
    assert.ok(gap.stateIssues.includes("reconciliation_not_current"));
    assert.ok(gap.stateIssues.includes("market_stream_reconnecting"));

    state.markStreamConnected("market", stamp);
    state.markStreamEvent("market", stamp);
    state.markReconciliationStarted(stamp);
    state.markReconciliationSucceeded(stamp);
    assert.equal(state.buildSnapshot(1, "MNQ").stateComplete, true);
  });

  it("reconnect generation mismatch is not caused by incomplete BBO", () => {
    const state = readyState();
    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
    state.markReconciliationStarted(stamp);
    state.markReconciliationSucceeded(stamp);
    assert.equal(isReconciliationCurrent(state.operationalStatus()), true);

    state.markStreamDisconnected("market", new Error("signalr_closed"), stamp);
    assert.equal(isReconciliationCurrent(state.operationalStatus()), false);
  });

  it("reconciliation during payload fault stays current (no false not_current)", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
    state.markReconciliationStarted(stamp);
    state.markReconciliationSucceeded(stamp);
    const snap = state.buildSnapshot(1, "MNQ");
    assert.equal(state.operationalStatus().generation, before);
    assert.equal(isReconciliationCurrent(snap.operational), true);
    assert.ok(!snap.stateIssues.includes("reconciliation_not_current"));
    assert.equal(snap.stateComplete, false);
  });

  it("generic markPayloadFault does not bump generation", () => {
    const state = readyState();
    const before = state.operationalStatus().generation;
    state.markPayloadFault("market", new Error("trade_not_object"), stamp);
    assert.equal(state.operationalStatus().generation, before);
    assert.equal(state.operationalStatus().marketStream.state, "degraded");
    assert.equal(isReconciliationCurrent(state.operationalStatus()), true);
  });

  it("parseQuote still rejects incomplete BBO without fabricating from last", () => {
    assert.throws(
      () => parseQuote(CONTRACT, {
        symbol: "F.US.MNQ",
        lastPrice: 27972.25,
        bestBid: 27972,
        bestAsk: null,
        timestamp: stamp,
      }),
      /quote_bbo_incomplete/,
    );
    assert.equal(isQuoteBboIncompleteError(new Error("quote_bbo_incomplete")), true);
    assert.equal(contractIdFromQuoteRawPayload({ contractId: "MNQ", payload: {} }), "MNQ");
  });

  it("rate-limits incomplete BBO log emissions", () => {
    const lines: string[] = [];
    let now = 1_000;
    const log = new RateLimitedQuoteBboIncompleteLog(5_000, () => now, (line) => {
      lines.push(line);
    });
    for (let i = 0; i < 100; i += 1) {
      log.record(new Error("quote_bbo_incomplete"));
    }
    assert.equal(lines.length, 1);
    now = 6_500;
    log.record(new Error("quote_bbo_incomplete"));
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /suppressed_since_last_log=99/);
    assert.equal(log.snapshot().total, 101);
  });

  it("does not invent intents, orders, or position writes on incomplete BBO", () => {
    const state = readyState();
    const before = state.buildSnapshot(1, "MNQ");
    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), stamp);
    const after = state.buildSnapshot(1, "MNQ");
    assert.equal(after.totalOpenContracts, before.totalOpenContracts);
    assert.equal(after.openOrders.length, before.openOrders.length);
    assert.deepEqual(
      after.positions.map((p) => p.id),
      before.positions.map((p) => p.id),
    );
  });
});
