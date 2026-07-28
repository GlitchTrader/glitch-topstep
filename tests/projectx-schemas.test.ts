import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuote } from "../src/projectx/schemas.js";

describe("parseQuote", () => {
  it("uses lastUpdated for freshness when ProjectX freezes session timestamp", () => {
    const quote = parseQuote("CON.F.US.MNQ.U26", {
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

  it("derives lastPrice from bid and ask when lastPrice is null", () => {
    const quote = parseQuote("CON.F.US.MNQ.U26", {
      symbol: "F.US.MNQ",
      lastPrice: null,
      bestBid: 28011.5,
      bestAsk: 28012,
      open: null,
      high: null,
      low: null,
      volume: null,
      timestamp: "2026-07-27T21:00:00.188+00:00",
      lastUpdated: "2026-07-28T02:28:00.000Z",
    });
    assert.equal(quote.lastPrice, 28011.75);
    assert.equal(quote.open, 28011.75);
    assert.equal(quote.volume, 0);
  });
});
