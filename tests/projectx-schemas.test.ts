import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDepth,
  parseMarketTrade,
  parseQuote,
  unwrapMarketStreamArgs,
} from "../src/projectx/schemas.js";

const CONTRACT = "CON.F.US.MNQ.U26";

describe("parseQuote", () => {
  it("uses lastUpdated for freshness when ProjectX freezes session timestamp", () => {
    const quote = parseQuote(CONTRACT, {
      symbol: "F.US.MNQ",
      lastPrice: 28012,
      bestBid: 28011.5,
      bestAsk: 28012,
      open: 28210.5,
      high: 28229,
      low: 27969.25,
      volume: 306373,
      timestamp: "2026-07-27T21:00:00.188+00:00",
      lastUpdated: "2026-07-28T02:23:56.4744617+00:00",
    });
    assert.equal(quote.timestamp, "2026-07-28T02:23:56.4744617+00:00");
  });

  it("accepts quotes with missing bid or ask when lastPrice is present", () => {
    const quote = parseQuote(CONTRACT, {
      symbol: "F.US.MNQ",
      lastPrice: 27972.25,
      bestAsk: null,
      timestamp: "2026-07-28T02:37:54.090Z",
    });
    assert.equal(quote.lastPrice, 27972.25);
    assert.equal(quote.bestBid, 27972.25);
    assert.equal(quote.bestAsk, 27972.25);
  });
});

describe("market stream payload normalization", () => {
  it("unwraps SignalR tuple payloads", () => {
    const trade = {
      symbolId: "F.US.MNQ",
      price: 28012,
      timestamp: "2026-07-28T02:30:00Z",
      type: 0,
      volume: 2,
    };
    assert.deepEqual(
      unwrapMarketStreamArgs([CONTRACT, trade], undefined),
      { contractId: CONTRACT, payload: trade },
    );
  });

  it("parses market trades from envelope and primitive arrays", () => {
    const objectTrade = parseMarketTrade(CONTRACT, {
      symbolId: "F.US.MNQ",
      price: 28012,
      timestamp: "2026-07-28T02:30:00Z",
      type: 1,
      volume: 3,
    });
    assert.equal(objectTrade.type, 1);
    assert.equal(objectTrade.volume, 3);

    const envelopeTrade = parseMarketTrade(CONTRACT, {
      contractId: CONTRACT,
      data: {
        symbolId: "F.US.MNQ",
        price: 28011,
        timestamp: "2026-07-28T02:30:01Z",
        type: 0,
        volume: 1,
      },
    });
    assert.equal(envelopeTrade.price, 28011);

    const arrayTrade = parseMarketTrade(CONTRACT, [
      "F.US.MNQ",
      28010,
      "2026-07-28T02:30:02Z",
      0,
      4,
    ]);
    assert.equal(arrayTrade.symbolId, "F.US.MNQ");
    assert.equal(arrayTrade.volume, 4);
  });

  it("parses depth from envelope and primitive arrays", () => {
    const objectDepth = parseDepth(CONTRACT, {
      timestamp: "2026-07-28T02:30:00Z",
      type: 2,
      price: 28010.5,
      volume: 12,
      currentVolume: 8,
    });
    assert.equal(objectDepth.currentVolume, 8);

    const arrayDepth = parseDepth(CONTRACT, [
      "2026-07-28T02:30:01Z",
      4,
      28010.75,
      10,
      6,
    ]);
    assert.equal(arrayDepth.type, 4);
    assert.equal(arrayDepth.price, 28010.75);

    const batchDepth = parseDepth(CONTRACT, {
      contractId: CONTRACT,
      payload: [{
        price: 28010.25,
        volume: 5,
        currentVolume: 3,
        type: 6,
        timestamp: "2026-07-28T03:08:20.4448161+00:00",
      }],
    });
    assert.equal(batchDepth.type, 6);
    assert.equal(batchDepth.currentVolume, 3);
  });
});
