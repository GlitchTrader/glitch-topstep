import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { QuoteBboAssembler } from "../src/projectx/quote-bbo-assembler.js";
import {
  buildSanitizedQuoteEventDiagnostic,
  classifySnapshotKind,
} from "../src/projectx/quote-reject-diagnostics.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import { actionAllowedForQuote } from "../src/state/quote-state.js";
import { RiskRejectedError, validateEntryRisk } from "../src/risk/risk-engine.js";
import { VenueStateStore } from "../src/state/venue-state.js";

const CONTRACT = "CON.F.US.MNQ.U26";
const OTHER = "CON.F.US.MES.U26";
const T0 = Date.parse("2026-09-09T16:30:00.000Z");

const RISK = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
} as const;

function ts(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function ingest(
  assembler: QuoteBboAssembler,
  payload: Record<string, unknown>,
  opts: { gen?: number; atMs?: number; contractId?: string } = {},
) {
  return assembler.ingest({
    contractId: opts.contractId ?? CONTRACT,
    payload,
    reconnectGeneration: opts.gen ?? 1,
    receivedMs: opts.atMs ?? T0,
  });
}

describe("sanitized quote reject diagnostics", () => {
  it("records presence/absence without raw prices or secrets", () => {
    const diag = buildSanitizedQuoteEventDiagnostic({
      contractId: CONTRACT,
      reconnectGeneration: 3,
      payload: {
        symbol: "F.US.MNQ",
        bestBid: 123456789.125,
        lastUpdated: "2026-09-09T16:30:00.100Z",
        timestamp: "2026-09-09T16:30:00.000Z",
        accessToken: "secret-should-not-appear",
      },
    });
    assert.equal(diag.event_type, "quote");
    assert.equal(diag.snapshot_or_partial, "partial_bbo");
    assert.equal(diag.bid_presence, "set");
    assert.equal(diag.ask_presence, "miss");
    assert.equal(diag.last_presence, "miss");
    assert.equal(diag.sequence_or_update_id, null);
    assert.equal(diag.reconnect_generation, 3);
    assert.ok(diag.fields_present.includes("bestBid"));
    assert.ok(diag.fields_absent.includes("bestAsk"));
    const blob = JSON.stringify(diag);
    assert.equal(blob.includes("123456789.125"), false);
    assert.equal(blob.includes("secret-should-not-appear"), false);
    assert.equal(diag.fields_present.includes("accessToken"), false);
    assert.equal((diag as unknown as Record<string, unknown>).bestBid, undefined);
  });

  it("classifies complete vs partial vs last_only", () => {
    assert.equal(classifySnapshotKind("set", "set", "miss"), "complete_bbo");
    assert.equal(classifySnapshotKind("set", "miss", "miss"), "partial_bbo");
    assert.equal(classifySnapshotKind("miss", "miss", "set"), "last_only");
  });
});

describe("QuoteBboAssembler delta normalization", () => {
  it("assembles bid then ask into normal BBO without fabricating from last", () => {
    const assembler = new QuoteBboAssembler(5_000);
    const bidOnly = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastPrice: 999,
      lastUpdated: ts(0),
      timestamp: ts(0),
    });
    assert.equal(bidOnly.status, "incomplete");
    assert.equal(bidOnly.state_complete, false);
    assert.equal(bidOnly.quote, null);

    const askOnly = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.25,
      lastUpdated: ts(10),
      timestamp: ts(10),
    }, { atMs: T0 + 10 });
    assert.equal(askOnly.status, "ready");
    assert.equal(askOnly.state_complete, true);
    assert.equal(askOnly.quote?.bestBid, 100);
    assert.equal(askOnly.quote?.bestAsk, 100.25);
    assert.notEqual(askOnly.quote?.bestBid, 999);
    assert.notEqual(askOnly.quote?.bestAsk, 999);
  });

  it("keeps locked and crossed classifications when both sides present", () => {
    const assembler = new QuoteBboAssembler();
    const locked = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      bestAsk: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    });
    assert.equal(locked.status, "locked");
    assert.equal(locked.state_complete, true);

    const crossed = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 101,
      bestAsk: 100,
      lastUpdated: ts(20),
      timestamp: ts(20),
    }, { atMs: T0 + 20 });
    assert.equal(crossed.status, "crossed");
  });

  it("updates the same side repeatedly without inventing the opposite side", () => {
    const assembler = new QuoteBboAssembler();
    assert.equal(ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }).status, "incomplete");
    assert.equal(ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100.25,
      lastUpdated: ts(5),
      timestamp: ts(5),
    }, { atMs: T0 + 5 }).status, "incomplete");
    const third = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100.5,
      lastPrice: 777,
      lastUpdated: ts(10),
      timestamp: ts(10),
    }, { atMs: T0 + 10 });
    assert.equal(third.status, "incomplete");
    assert.equal(third.quote, null);
    const complete = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.75,
      lastUpdated: ts(15),
      timestamp: ts(15),
    }, { atMs: T0 + 15 });
    assert.equal(complete.status, "ready");
    assert.equal(complete.quote?.bestBid, 100.5);
    assert.equal(complete.quote?.bestAsk, 100.75);
    assert.notEqual(complete.quote?.bestAsk, 777);
  });

  it("clears only the reconnecting generation path via onReconnectGeneration", () => {
    const assembler = new QuoteBboAssembler();
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      bestAsk: 100.25,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }, { gen: 4 });
    assembler.onReconnectGeneration(5);
    const after = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.5,
      lastUpdated: ts(20),
      timestamp: ts(20),
    }, { gen: 5, atMs: T0 + 20 });
    assert.equal(after.status, "incomplete");
    assert.equal(after.state_complete, false);
  });

  it("keeps per-contract merge isolation on contract switch", () => {
    const assembler = new QuoteBboAssembler();
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }, { contractId: CONTRACT });
    ingest(assembler, {
      symbol: "F.US.MES",
      bestBid: 5000,
      lastUpdated: ts(5),
      timestamp: ts(5),
    }, { contractId: OTHER, atMs: T0 + 5 });
    const mnq = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.25,
      lastUpdated: ts(10),
      timestamp: ts(10),
    }, { contractId: CONTRACT, atMs: T0 + 10 });
    assert.equal(mnq.status, "ready");
    assert.equal(mnq.quote?.contractId, CONTRACT);
    assert.equal(mnq.quote?.bestBid, 100);
    assert.equal(mnq.quote?.bestAsk, 100.25);
  });

  it("does not merge opposite side after TTL expiry", () => {
    const assembler = new QuoteBboAssembler(100);
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }, { atMs: T0 });
    const lateAsk = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.25,
      lastUpdated: ts(250),
      timestamp: ts(250),
    }, { atMs: T0 + 250 });
    assert.equal(lateAsk.status, "incomplete");
    assert.equal(lateAsk.state_complete, false);
  });

  it("clears on timestamp regression (sequence-gap proxy)", () => {
    const assembler = new QuoteBboAssembler();
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      bestAsk: 100.25,
      lastUpdated: ts(100),
      timestamp: ts(100),
    }, { atMs: T0 + 100 });
    const regress = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 99,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }, { atMs: T0 + 110 });
    assert.equal(regress.status, "cleared");
    assert.equal(regress.reason, "timestamp_regression");
  });

  it("never emits quote for a different contract from retained state", () => {
    const assembler = new QuoteBboAssembler();
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    }, { contractId: CONTRACT });
    const other = ingest(assembler, {
      symbol: "F.US.MES",
      bestAsk: 5000.25,
      lastUpdated: ts(10),
      timestamp: ts(10),
    }, { contractId: OTHER, atMs: T0 + 10 });
    assert.equal(other.status, "incomplete");
    assert.equal(other.quote, null);
  });

  it("bounds memory to max contracts", () => {
    const assembler = new QuoteBboAssembler(5_000, 2);
    for (let i = 0; i < 5; i += 1) {
      ingest(assembler, {
        symbol: "F.US.MNQ",
        bestBid: 100 + i,
        lastUpdated: ts(i),
        timestamp: ts(i),
      }, { contractId: `CON.${i}`, atMs: T0 + i });
    }
    assert.ok(assembler.size() <= 2);
  });

  it("recovers to normal after locked when a valid opposite update arrives", () => {
    const assembler = new QuoteBboAssembler();
    ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      bestAsk: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    });
    const recovered = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.25,
      lastUpdated: ts(5),
      timestamp: ts(5),
    }, { atMs: T0 + 5 });
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.quote?.bestBid, 100);
    assert.equal(recovered.quote?.bestAsk, 100.25);
  });

  it("replays representative live-v2 shape mix without fabricating BBO", () => {
    // Shape mix mirrors live-v2-20260909 evidence (partial sides omitted, not null).
    const shapes: Array<Record<string, unknown>> = [
      { symbol: "F.US.MNQ", bestBid: 1, bestAsk: 1.25, lastUpdated: ts(0), timestamp: ts(0) },
      { symbol: "F.US.MNQ", bestBid: 1.25, lastUpdated: ts(1), timestamp: ts(1) },
      { symbol: "F.US.MNQ", bestAsk: 1.5, lastUpdated: ts(2), timestamp: ts(2) },
      { symbol: "F.US.MNQ", lastPrice: 9, lastUpdated: ts(3), timestamp: ts(3) },
      { symbol: "F.US.MNQ", bestBid: 1.5, bestAsk: 1.5, lastUpdated: ts(4), timestamp: ts(4) },
      { symbol: "F.US.MNQ", bestBid: 2, bestAsk: 1.75, lastUpdated: ts(5), timestamp: ts(5) },
      { symbol: "F.US.MNQ", bestBid: 2, bestAsk: 2.25, lastPrice: 2.1, lastUpdated: ts(6), timestamp: ts(6) },
    ];
    const assembler = new QuoteBboAssembler();
    const statuses: string[] = [];
    for (let i = 0; i < shapes.length; i += 1) {
      const result = ingest(assembler, shapes[i]!, { atMs: T0 + i });
      statuses.push(result.status);
      if (result.quote) {
        assert.notEqual(result.quote.bestBid, 9);
        assert.notEqual(result.quote.bestAsk, 9);
      }
    }
    assert.deepEqual(statuses, [
      "ready",
      "locked",
      "ready",
      "ready",
      "locked",
      "crossed",
      "ready",
    ]);
  });

  it("offline sample of 14522 synthetic partials stays bounded and never fabricates", () => {
    const assembler = new QuoteBboAssembler(5_000, 8);
    let ready = 0;
    let incomplete = 0;
    for (let i = 0; i < 14_522; i += 1) {
      const side = i % 2 === 0
        ? { bestBid: 100 + i * 0.25 }
        : { bestAsk: 100.5 + i * 0.25 };
      const result = ingest(assembler, {
        symbol: "F.US.MNQ",
        ...side,
        lastUpdated: ts(i),
        timestamp: ts(i),
      }, { atMs: T0 + i });
      if (result.status === "ready") {
        ready += 1;
        assert.ok(result.quote!.bestBid < result.quote!.bestAsk);
      } else if (result.status === "incomplete") {
        incomplete += 1;
        assert.equal(result.quote, null);
      } else {
        assert.fail(`unexpected status ${result.status} at i=${i}`);
      }
    }
    assert.ok(ready > 14_000);
    assert.ok(incomplete >= 1);
    assert.ok(assembler.size() <= 8);
  });
});

describe("assembler + venue gates (no writes)", () => {
  it("blocks new exposure on missing/locked and keeps flatten eligibility", () => {
    const state = new VenueStateStore();
    state.registerContracts([{
      id: CONTRACT,
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
    }], ts(0));
    state.replacePositions([], ts(0));
    state.replaceOrders([], ts(0));
    state.markStreamConnected("user", ts(0));
    state.markStreamConnected("market", ts(0));
    state.markStreamEvent("user", ts(0));
    state.markStreamEvent("market", ts(0));
    state.markReconciliationStarted(ts(0));
    state.markReconciliationSucceeded(ts(0));

    const assembler = new QuoteBboAssembler();
    const incomplete = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestBid: 100,
      lastUpdated: ts(0),
      timestamp: ts(0),
    });
    assert.equal(incomplete.state_complete, false);
    state.markQuoteBboIncomplete(CONTRACT, new Error("quote_bbo_incomplete"), ts(0));
    let snap = state.buildSnapshot(1, CONTRACT);
    let quality = evaluateSnapshotDataQuality(snap, RISK, new Date(ts(0)));
    assert.ok(snap.stateIssues.includes("quote_missing"));
    assert.equal(snap.stateComplete, false);
    assert.equal(quality.executionEligibility === "eligible", false);
    assert.equal(quality.riskReductionEligibility, "eligible");
    assert.equal(snap.totalOpenContracts, 0);
    assert.equal(snap.openOrders.length, 0);

    const ready = ingest(assembler, {
      symbol: "F.US.MNQ",
      bestAsk: 100.25,
      lastUpdated: ts(10),
      timestamp: ts(10),
    }, { atMs: T0 + 10 });
    assert.equal(ready.status, "ready");
    assert.equal(ready.state_complete, true);
    state.applyQuote(ready.quote!, ts(10));
    state.markStreamEvent("market", ts(10));
    snap = state.buildSnapshot(1, CONTRACT);
    quality = evaluateSnapshotDataQuality(snap, RISK, new Date(ts(10)));
    assert.equal(quality.quoteState, "normal");
    assert.equal(snap.stateComplete, true);
  });

  it("rejects entry risk and records zero intents/orders while quote is incomplete", () => {
    const state = new VenueStateStore();
    state.registerContracts([{
      id: CONTRACT,
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
    }], ts(0));
    state.replacePositions([], ts(0));
    state.replaceOrders([], ts(0));
    state.markStreamConnected("user", ts(0));
    state.markStreamConnected("market", ts(0));
    state.markStreamEvent("user", ts(0));
    state.markStreamEvent("market", ts(0));
    state.markReconciliationStarted(ts(0));
    state.markReconciliationSucceeded(ts(0));
    state.markQuoteBboIncomplete(CONTRACT, new Error("quote_bbo_incomplete"), ts(0));

    const snap = state.buildSnapshot(1, CONTRACT);
    const quality = evaluateSnapshotDataQuality(snap, RISK, new Date(ts(0)));
    assert.equal(actionAllowedForQuote("new_exposure", quality.executionEligibility), false);
    assert.equal(actionAllowedForQuote("flatten", quality.executionEligibility), true);
    assert.equal(actionAllowedForQuote("protective_action", quality.executionEligibility), true);
    assert.equal(actionAllowedForQuote("recovery", quality.executionEligibility), true);
    assert.equal(actionAllowedForQuote("exit_reduction", quality.executionEligibility), true);
    assert.equal(snap.openOrders.length, 0);
    assert.equal(snap.totalOpenContracts, 0);
    assert.throws(
      () => validateEntryRisk(
        {
          schemaVersion: "glitch.intent.v2",
          intentId: "00000000-0000-4000-8000-000000000099",
          createdUtc: ts(0),
          instrument: "MNQ",
          account: "SIM",
          operatorProfile: "glitch-topstep",
          action: "ENTER_LONG",
          confidence: 0.6,
          snapshotHash: "hash",
          modelVersion: "test",
          promptVersion: "glitch-topstep-v17.1",
          reason: "Must not enter on incomplete quote.",
          decisionAudit: {
            bullCase: "b",
            bearCase: "e",
            flatCase: "f",
            aggressiveCase: "a",
            conservativeCase: "c",
            decisiveEvidence: "d",
            disconfirmingEvidence: "x",
            changeCondition: "y",
            finalChoice: "ENTER_LONG",
          },
          quantity: 1,
          orderType: "MARKET",
          stopLoss: 99,
          takeProfit1: 101,
        },
        snap,
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
          maxContracts: 3,
        },
        RISK,
        {
          expectedAccountId: 1,
          expectedAccountName: "SIM",
          expectedInstrument: "MNQ",
          expectedSnapshotHash: "hash",
          now: new Date(ts(0)),
        },
      ),
      (error: unknown) => (
        error instanceof RiskRejectedError
        && (
          (error as RiskRejectedError).code === "quote_missing"
          || (error as RiskRejectedError).code === "quote_geometry_invalid"
        )
      ),
    );
  });
});

describe("structural hash stability", () => {
  it("hashes presence map not prices", () => {
    const a = buildSanitizedQuoteEventDiagnostic({
      contractId: CONTRACT,
      reconnectGeneration: 1,
      payload: { symbol: "F.US.MNQ", bestBid: 1, lastUpdated: ts(0), timestamp: ts(0) },
    });
    const b = buildSanitizedQuoteEventDiagnostic({
      contractId: CONTRACT,
      reconnectGeneration: 1,
      payload: { symbol: "F.US.MNQ", bestBid: 99999, lastUpdated: ts(0), timestamp: ts(0) },
    });
    assert.equal(a.structural_hash, b.structural_hash);
    const presence = { bestBid: "set", bestAsk: "miss" };
    assert.equal(
      a.structural_hash.length,
      createHash("sha256").update("x").digest("hex").slice(0, 16).length,
    );
    void presence;
  });
});
