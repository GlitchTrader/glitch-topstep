import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PathChronologyTracker,
  syncPathChronologyTracker,
} from "../src/learning/path-chronology-tracker.js";
import {
  buildPathChronology,
  buildPathChronologyFromExcursion,
  pathChronologyHashesMatch,
  rebuildPathChronologyFromEvidence,
  stablePathChronologyHash,
} from "../src/learning/path-chronology.js";
import { PATH_CHRONOLOGY_SCHEMA } from "../src/learning/trade-outcome.js";
import type { AccountVenueSnapshot } from "../src/domain/models.js";
import type { TrancheView } from "../src/ownership/tranches.js";

const TRANCHE: TrancheView = {
  intent_id: "intent-long-1",
  entry_order_id: 100,
  filled_qty: 1,
  remaining_qty: 1,
  created_utc: "2026-08-03T13:55:00.000Z",
  protection: {
    status: "proven",
    reason: "verified",
    stop: { provider_order_id: 200, custom_tag: "glt-stop", price: 28570 },
    target: { provider_order_id: 300, custom_tag: "glt-target", price: 28620 },
  },
};

function snapshot(side: 1 | 2, averagePrice: number, mark: number): AccountVenueSnapshot {
  return {
    capturedAt: "2026-08-03T13:56:00.000Z",
    account: {
      id: 1,
      name: "TEST",
      balance: 50_000,
      canTrade: true,
      isVisible: true,
    },
    contract: {
      id: "CON.F.US.MNQ.U26",
      name: "MNQU26",
      description: "MNQ",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    },
    quote: {
      contractId: "CON.F.US.MNQ.U26",
      symbol: "MNQ",
      lastPrice: mark,
      bestBid: mark - 0.25,
      bestAsk: mark + 0.25,
      open: mark,
      high: mark,
      low: mark,
      volume: 1,
      timestamp: "2026-08-03T13:56:00.000Z",
    },
    positions: [{
      id: 1,
      accountId: 1,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-08-03T13:55:00.000Z",
      type: side,
      size: 1,
      averagePrice,
    }],
    openOrders: [],
    totalOpenContracts: 1,
    instrumentOpenContracts: 1,
    unrealizedPnl: 0,
    conservativeEquity: 50_000,
    operational: {
      generation: 1,
      userStream: {
        state: "connected",
        generation: 1,
        lastChangedAt: "2026-08-03T13:56:00.000Z",
        lastEventAt: "2026-08-03T13:56:00.000Z",
        lastError: null,
      },
      marketStream: {
        state: "connected",
        generation: 1,
        lastChangedAt: "2026-08-03T13:56:00.000Z",
        lastEventAt: "2026-08-03T13:56:00.000Z",
        lastError: null,
      },
      reconciliation: {
        state: "succeeded",
        generation: 1,
        lastStartedAt: "2026-08-03T13:56:00.000Z",
        lastSucceededAt: "2026-08-03T13:56:00.000Z",
        lastError: null,
      },
    },
    stateIssues: [],
    stateComplete: true,
  };
}

describe("buildPathChronologyFromExcursion", () => {
  it("returns null when both excursion magnitudes are missing", () => {
    assert.equal(buildPathChronologyFromExcursion({ mfe_usd: null, mae_usd: null }), null);
  });

  it("marks partial evidence when only USD magnitudes are known", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 50,
      mae_usd: 8,
      mfe_ticks: 100,
      mae_ticks: 16,
    });
    assert.ok(chronology);
    assert.equal(chronology?.schema_version, PATH_CHRONOLOGY_SCHEMA);
    assert.equal(chronology?.evidence_quality, "partial");
    assert.ok(chronology?.chronology_hash);
  });

  it("marks complete evidence when price and utc are present for both extremes", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 50,
      mae_usd: 8,
      mfe_price: 28620,
      mfe_utc: "2026-08-03T13:58:00.000Z",
      mae_price: 28570,
      mae_utc: "2026-08-03T13:57:30.000Z",
      mfe_ticks: 100,
      mae_ticks: 16,
    });
    assert.equal(chronology?.evidence_quality, "complete");
  });

  it("marks same_event_gap when flagged", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 10,
      mae_usd: 5,
      same_event_gap: true,
    });
    assert.equal(chronology?.evidence_quality, "same_event_gap");
    assert.deepEqual(chronology?.gaps, ["same_event_gap"]);
  });
});

describe("PathChronologyTracker", () => {
  it("records first passage through entry and breakeven for a long", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-1",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:55:00.000Z",
    });
    tracker.observe({ markPrice: 28595, observedUtc: "2026-08-03T13:55:10.000Z" });
    tracker.observe({ markPrice: 28601, observedUtc: "2026-08-03T13:55:20.000Z" });
    const built = buildPathChronology({
      mfe_usd: 10,
      mae_usd: 5,
      tracker: tracker.snapshot(),
    });
    assert.equal(built?.first_passage?.entry.observed, true);
    assert.equal(built?.first_passage?.breakeven.observed, true);
    assert.equal(built?.target_before_stop, null);
  });

  it("marks target_before_stop unresolved when stop and target touch same bar", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-1",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:55:00.000Z",
    });
    tracker.observe({
      markPrice: 28600,
      observedUtc: "2026-08-03T13:56:00.000Z",
      barLow: 28560,
      barHigh: 28625,
    });
    const built = buildPathChronology({
      mfe_usd: 10,
      mae_usd: 5,
      tracker: tracker.snapshot(),
    });
    assert.equal(built?.target_before_stop, "unresolved");
    assert.equal(built?.evidence_quality, "unresolved");
    assert.ok(built?.gaps?.includes("intra_bar_touch_ambiguous"));
  });

  it("tracks amendment intervals and first touch per interval", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-1",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:55:00.000Z",
    });
    tracker.observeAmendment(28590, 28620, "HERMES_INTENT", "2026-08-03T13:57:00.000Z");
    tracker.observe({ markPrice: 28625, observedUtc: "2026-08-03T13:58:00.000Z" });
    const built = buildPathChronology({
      mfe_usd: 12,
      mae_usd: 4,
      tracker: tracker.snapshot(),
    });
    assert.equal(built?.amendment_intervals?.length, 2);
    assert.equal(built?.amendment_intervals?.[1]?.first_touch, "target");
    assert.equal(built?.target_before_stop, "target");
  });
});

describe("rebuildPathChronologyFromEvidence", () => {
  it("replays long target-first path with identical hash to live tracker", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-short-1",
      side: "short",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28630,
      targetPrice: 28570,
      entryOrderId: 101,
      filledQty: 1,
      openedUtc: "2026-08-03T14:00:00.000Z",
    });
    tracker.observe({ markPrice: 28560, observedUtc: "2026-08-03T14:01:00.000Z" });
    const live = buildPathChronology({
      mfe_usd: 20,
      mae_usd: 6,
      mfe_price: 28560,
      mfe_utc: "2026-08-03T14:01:00.000Z",
      mae_price: 28610,
      mae_utc: "2026-08-03T14:00:30.000Z",
      tracker: tracker.snapshot(),
    });
    assert.ok(live);
    const replay = rebuildPathChronologyFromEvidence({
      side: "short",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28630,
      initial_target: 28570,
      intent_id: "intent-short-1",
      entry_order_id: 101,
      opened_utc: "2026-08-03T14:00:00.000Z",
      events: [
        { kind: "price", utc: "2026-08-03T14:01:00.000Z", price: 28560 },
      ],
      excursion: {
        mfe_usd: 20,
        mae_usd: 6,
        mfe_price: 28560,
        mfe_utc: "2026-08-03T14:01:00.000Z",
        mae_price: 28610,
        mae_utc: "2026-08-03T14:00:30.000Z",
      },
    });
    assert.equal(pathChronologyHashesMatch(live, replay), true);
    assert.equal(replay.target_before_stop, "target");
    assert.equal(stablePathChronologyHash(live), live.chronology_hash);
  });

  it("preserves partial fill and tranche identity gaps", () => {
    const replay = rebuildPathChronologyFromEvidence({
      side: "long",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28570,
      initial_target: 28620,
      intent_id: "intent-partial",
      entry_order_id: 100,
      opened_utc: "2026-08-03T13:55:00.000Z",
      events: [
        { kind: "partial_fill", utc: "2026-08-03T13:55:05.000Z", filled_qty: 1, remaining_qty: 1 },
        { kind: "partial_exit", utc: "2026-08-03T13:59:00.000Z", remaining_qty: 1 },
      ],
      excursion: { mfe_usd: 5, mae_usd: 2 },
    });
    assert.equal(replay.tranche?.partial_fill_events, 1);
    assert.equal(replay.tranche?.partial_exit_events, 1);
    assert.ok(replay.gaps?.includes("partial_fill_observed"));
    assert.ok(replay.gaps?.includes("partial_exit_observed"));
  });

  it("replays after simulated reconnect with identical chronology hash", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-reconnect",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:55:00.000Z",
    });
    tracker.observe({ markPrice: 28605, observedUtc: "2026-08-03T13:56:00.000Z" });
    // ponytail: snapshot mid-trade simulates reconnect; replay rebuilds from journal
    const midTrade = tracker.snapshot();
    tracker.observe({ markPrice: 28615, observedUtc: "2026-08-03T13:57:00.000Z" });
    const live = buildPathChronology({
      mfe_usd: 15,
      mae_usd: 3,
      tracker: tracker.snapshot(),
    });
    assert.ok(midTrade);
    const replay = rebuildPathChronologyFromEvidence({
      side: "long",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28570,
      initial_target: 28620,
      intent_id: "intent-reconnect",
      entry_order_id: 100,
      opened_utc: "2026-08-03T13:55:00.000Z",
      events: [
        { kind: "price", utc: "2026-08-03T13:56:00.000Z", price: 28605 },
        { kind: "price", utc: "2026-08-03T13:57:00.000Z", price: 28615 },
      ],
      excursion: { mfe_usd: 15, mae_usd: 3 },
    });
    assert.equal(pathChronologyHashesMatch(live!, replay), true);
    assert.equal(midTrade.firstPassage.entry.observed, true);
  });

  it("replays after simulated process restart with identical chronology hash", () => {
    const events = [
      { kind: "price" as const, utc: "2026-08-03T14:00:00.000Z", price: 28610 },
      { kind: "amendment" as const, utc: "2026-08-03T14:01:00.000Z", stop_price: 28590, target_price: 28620, amendment_source: "HERMES_INTENT" },
      { kind: "price" as const, utc: "2026-08-03T14:02:00.000Z", price: 28625, bar_low: 28600, bar_high: 28625 },
    ];
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-restart",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:59:00.000Z",
    });
    for (const event of events) {
      if (event.kind === "price") {
        tracker.observe({
          markPrice: event.price ?? null,
          observedUtc: event.utc,
          barLow: event.bar_low ?? null,
          barHigh: event.bar_high ?? null,
        });
      } else {
        tracker.observeAmendment(event.stop_price ?? null, event.target_price ?? null, event.amendment_source ?? null, event.utc);
      }
    }
    const live = buildPathChronology({ mfe_usd: 25, mae_usd: 4, tracker: tracker.snapshot() });
    const replay = rebuildPathChronologyFromEvidence({
      side: "long",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28570,
      initial_target: 28620,
      intent_id: "intent-restart",
      entry_order_id: 100,
      opened_utc: "2026-08-03T13:59:00.000Z",
      events,
      excursion: { mfe_usd: 25, mae_usd: 4 },
    });
    assert.equal(pathChronologyHashesMatch(live!, replay), true);
    assert.equal(replay.target_before_stop, "target");
  });

  it("fails hash parity when replay evidence diverges from live journal", () => {
    const tracker = new PathChronologyTracker();
    tracker.begin({
      intentId: "intent-diverge",
      side: "long",
      entryPrice: 28600,
      breakevenPrice: 28600,
      stopPrice: 28570,
      targetPrice: 28620,
      entryOrderId: 100,
      filledQty: 1,
      openedUtc: "2026-08-03T13:55:00.000Z",
    });
    tracker.observe({ markPrice: 28610, observedUtc: "2026-08-03T13:56:00.000Z" });
    const live = buildPathChronology({
      mfe_usd: 10,
      mae_usd: 2,
      mfe_price: 28610,
      mfe_utc: "2026-08-03T13:56:00.000Z",
      tracker: tracker.snapshot(),
    });
    const divergentReplay = rebuildPathChronologyFromEvidence({
      side: "long",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28570,
      initial_target: 28620,
      intent_id: "intent-diverge",
      entry_order_id: 100,
      opened_utc: "2026-08-03T13:55:00.000Z",
      events: [
        { kind: "price", utc: "2026-08-03T13:56:00.000Z", price: 28610 },
      ],
      excursion: {
        mfe_usd: 11,
        mae_usd: 2,
        mfe_price: 28610,
        mfe_utc: "2026-08-03T13:56:00.000Z",
      },
    });
    assert.equal(pathChronologyHashesMatch(live!, divergentReplay), false);
  });

  it("does not infer target_before_stop from OHLC without authoritative touch evidence", () => {
    const replay = rebuildPathChronologyFromEvidence({
      side: "long",
      entry_price: 28600,
      breakeven_price: 28600,
      initial_stop: 28570,
      initial_target: 28620,
      intent_id: "intent-missing-intrabar",
      entry_order_id: 100,
      opened_utc: "2026-08-03T13:55:00.000Z",
      events: [
        {
          kind: "price",
          utc: "2026-08-03T13:56:00.000Z",
          price: 28600,
          bar_low: 28560,
          bar_high: 28625,
        },
      ],
      excursion: { mfe_usd: 10, mae_usd: 5 },
    });
    assert.equal(replay.target_before_stop, "unresolved");
    assert.equal(replay.evidence_quality, "unresolved");
    assert.ok(replay.gaps?.includes("intra_bar_touch_ambiguous"));
  });
});

describe("syncPathChronologyTracker", () => {
  it("begins tracker from active tranche and position snapshot", () => {
    const tracker = new PathChronologyTracker();
    const activeIntentId = syncPathChronologyTracker(
      tracker,
      TRANCHE,
      snapshot(1, 28600, 28605),
      "2026-08-03T13:56:00.000Z",
      null,
    );
    assert.equal(activeIntentId, "intent-long-1");
    assert.equal(tracker.snapshot()?.tranche.intent_id, "intent-long-1");
  });
});
