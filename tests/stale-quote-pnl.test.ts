import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExecutionGates } from "../src/execution/gateway-mode.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import { actionAllowedForQuote } from "../src/state/quote-state.js";
import { VenueStateStore } from "../src/state/venue-state.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";

const STAMP = "2026-09-28T16:00:00.000Z";
const STALE_AT = "2026-09-28T15:59:00.000Z";
const NOW = new Date("2026-09-28T16:00:10.000Z");
const RISK = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 30_000,
  maxIntentAgeMs: 300_000,
} as const;

function healthyRecovery(): ExecutionRecoveryStatus {
  return {
    blockingAmbiguity: false,
    entrySubmissionPending: false,
    blockingNewExposure: false,
    unresolvedMutations: 0,
    ambiguousMutations: 0,
    lastRecoveryUtc: null,
    lastRecoveryError: null,
  };
}

function gatePassed(gates: ReturnType<typeof buildExecutionGates>, id: string): boolean {
  return gates.find((gate) => gate.id === id)?.passed === true;
}

function seededState(quoteTimestamp: string): VenueStateStore {
  const state = new VenueStateStore();
  state.setMaxQuoteAgeMs(RISK.maxQuoteAgeMs);
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
  }], STAMP);
  state.replacePositions([{
    id: 2,
    accountId: 1,
    contractId: "MNQ",
    creationTimestamp: STAMP,
    type: 1,
    size: 2,
    averagePrice: 20_000,
  }], STAMP);
  state.replaceOrders([], STAMP);
  state.markStreamConnected("user", STAMP);
  state.markStreamConnected("market", STAMP);
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
    timestamp: quoteTimestamp,
  }, quoteTimestamp);
  state.markStreamEvent("user", STAMP);
  state.markStreamEvent("market", STAMP);
  state.markReconciliationStarted(STAMP);
  state.markReconciliationSucceeded(STAMP);
  return state;
}

describe("stale quote must not mark PnL (dedicated financial)", () => {
  it("keeps a stale last complete quote after incomplete BBO out of unrealizedPnl", () => {
    const state = seededState(STALE_AT);
    state.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), NOW.toISOString());

    const snap = state.buildSnapshot(1, "MNQ", NOW);
    const quality = evaluateSnapshotDataQuality(snap, RISK, NOW);

    assert.ok(snap.quote, "last complete quote must remain so quote_stale can fire");
    assert.ok(!snap.stateIssues.includes("quote_missing"));
    assert.ok(snap.stateIssues.includes("position_quote_stale:MNQ"));
    assert.equal(snap.unrealizedPnl, 0);
    assert.equal(snap.conservativeEquity, 100_000);
    assert.ok(quality.issues.includes("quote_stale"));
    assert.ok(!quality.issues.includes("quote_missing"));
  });

  it("still counts PnL when the same mark is within the quote_stale ceiling", () => {
    const state = seededState(STAMP);
    const snap = state.buildSnapshot(1, "MNQ", new Date(STAMP));
    assert.equal(snap.unrealizedPnl, 40);
    assert.equal(snap.conservativeEquity, 100_040);
    assert.ok(!snap.stateIssues.includes("position_quote_stale:MNQ"));
  });

  it("still blocks ENTER on stale quote and on never-had quote (gates unchanged)", () => {
    const stale = seededState(STALE_AT);
    stale.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), NOW.toISOString());
    const staleSnap = stale.buildSnapshot(1, "MNQ", NOW);
    const staleQuality = evaluateSnapshotDataQuality(staleSnap, RISK, NOW);
    const staleGates = buildExecutionGates(
      staleSnap,
      RISK,
      healthyRecovery(),
      "armed",
      3,
      NOW,
    );

    assert.equal(actionAllowedForQuote("new_exposure", staleQuality.executionEligibility), false);
    assert.equal(gatePassed(staleGates, "quote_stale"), false);
    assert.equal(gatePassed(staleGates, "state_complete"), false);
    assert.equal(gatePassed(staleGates, "new_exposure_technically_supported"), false);
    assert.equal(actionAllowedForQuote("flatten", staleQuality.executionEligibility), true);

    const never = new VenueStateStore();
    never.registerContracts([{
      id: "MNQ",
      name: "MNQ",
      description: "MNQ",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    }]);
    never.replaceAccounts([{
      id: 1,
      name: "SIM",
      balance: 100_000,
      canTrade: true,
      isVisible: true,
    }], STAMP);
    never.replacePositions([], STAMP);
    never.replaceOrders([], STAMP);
    never.markStreamConnected("user", STAMP);
    never.markStreamConnected("market", STAMP);
    never.markStreamEvent("user", STAMP);
    never.markStreamEvent("market", STAMP);
    never.markReconciliationStarted(STAMP);
    never.markReconciliationSucceeded(STAMP);
    never.markQuoteBboIncomplete("MNQ", new Error("quote_bbo_incomplete"), STAMP);
    const missingSnap = never.buildSnapshot(1, "MNQ", new Date(STAMP));
    const missingQuality = evaluateSnapshotDataQuality(missingSnap, RISK, new Date(STAMP));
    const missingGates = buildExecutionGates(
      missingSnap,
      RISK,
      healthyRecovery(),
      "armed",
      3,
      new Date(STAMP),
    );

    assert.ok(missingSnap.stateIssues.includes("quote_missing"));
    assert.ok(missingQuality.issues.includes("quote_missing"));
    assert.ok(!missingQuality.issues.includes("quote_stale"));
    assert.equal(actionAllowedForQuote("new_exposure", missingQuality.executionEligibility), false);
    assert.equal(gatePassed(missingGates, "state_complete"), false);
    assert.equal(gatePassed(missingGates, "new_exposure_technically_supported"), false);
  });
});
