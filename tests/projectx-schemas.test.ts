import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDepth,
  parseMarketTrade,
  parseOrder,
  parsePosition,
  parseQuote,
  parseTrade,
  unwrapMarketStreamArgs,
  unwrapUserStreamPayload,
  userStreamPayloadFaultDetail,
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

    const sparseBatch = parseDepth(CONTRACT, [
      null,
      {
        price: 28010,
        volume: 2,
        currentVolume: 1,
        type: 4,
        timestamp: "2026-07-28T03:12:48Z",
      },
    ]);
    assert.equal(sparseBatch.price, 28010);
  });
});

describe("user stream numeric coercion", () => {
  it("parses GatewayUserOrder payloads when ProjectX sends numeric ids as strings", () => {
    const order = parseOrder({
      id: "9123456",
      accountId: "25915453",
      contractId: CONTRACT,
      creationTimestamp: "2026-07-29T20:27:21.000Z",
      updateTimestamp: "2026-07-29T20:27:21.100Z",
      status: "1",
      type: "2",
      side: "1",
      size: "1",
      limitPrice: null,
      stopPrice: "27200",
      customTag: "glitch-intent-test",
    });
    assert.equal(order.id, 9123456);
    assert.equal(order.accountId, 25915453);
    assert.equal(order.stopPrice, 27200);
    assert.equal(order.customTag, "glitch-intent-test");
  });

  it("parses order ids delivered as near-integer floats", () => {
    const order = parseOrder({
      id: 9123456.0000001,
      accountId: 25915453,
      contractId: CONTRACT,
      creationTimestamp: "2026-07-29T20:27:21.000Z",
      updateTimestamp: "2026-07-29T20:27:21.100Z",
      status: 1,
      type: 2,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: null,
    });
    assert.equal(order.id, 9123456);
  });

  it("falls back to orderId when id is absent on GatewayUserOrder payloads", () => {
    const order = parseOrder({
      orderId: "88776655",
      accountId: "25915453",
      contractId: CONTRACT,
      creationTimestamp: "2026-07-29T20:27:21.000Z",
      updateTimestamp: "2026-07-29T20:27:21.100Z",
      status: "1",
      type: "2",
      side: "0",
      size: "1",
      limitPrice: null,
      stopPrice: null,
    });
    assert.equal(order.id, 88776655);
  });

  it("defaults position type to Undefined (0) when ProjectX omits type on flat updates", () => {
    const position = parsePosition({
      id: "441122",
      accountId: 25915453,
      contractId: CONTRACT,
      creationTimestamp: "2026-07-29T20:27:21.000Z",
      size: 0,
      averagePrice: 0,
    });
    assert.equal(position.id, 441122);
    assert.equal(position.type, 0);
  });

  it("parses documented GatewayUserTrade id and orderId fields as strings", () => {
    const trade = parseTrade({
      id: "2926551391",
      accountId: "25915453",
      contractId: CONTRACT,
      creationTimestamp: "2026-07-29T20:27:21.000Z",
      price: 27590.75,
      profitAndLoss: null,
      fees: null,
      side: "1",
      size: "1",
      voided: false,
      orderId: "3338853733",
    });
    assert.equal(trade.id, 2926551391);
    assert.equal(trade.orderId, 3338853733);
  });
});

describe("userStreamPayloadFaultDetail", () => {
  it("reports id field types without leaking full payload", () => {
    const detail = userStreamPayloadFaultDetail("order", {
      id: "9123456",
      orderId: 88776655,
      orderID: "bad",
      accountId: 25915453,
      contractId: CONTRACT,
      customTag: "secret-should-not-appear",
    });
    assert.equal(detail.eventType, "order");
    assert.deepEqual(detail.idFieldTypes, {
      accountId: "number",
      id: "string",
      orderID: "string",
      orderId: "number",
    });
    assert.equal((detail as { customTag?: string }).customTag, undefined);
  });
});

describe("unwrapUserStreamPayload", () => {
  it("unwraps ProjectX user hub action/data envelopes before parsing", () => {
    const order = parseOrder(unwrapUserStreamPayload({
      action: 1,
      data: {
        id: "9123456",
        accountId: 25915453,
        contractId: CONTRACT,
        creationTimestamp: "2026-07-29T20:27:21.000Z",
        updateTimestamp: "2026-07-29T20:27:21.100Z",
        status: 1,
        type: 2,
        side: 1,
        size: 1,
        limitPrice: null,
        stopPrice: null,
      },
    }));
    assert.equal(order.id, 9123456);
  });
});
