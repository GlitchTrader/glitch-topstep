import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BarInfo } from "../src/domain/models.js";
import type { RetrieveBarsRequest } from "../src/projectx/client.js";
import { ProjectXMarketObservationService } from "../src/market/projectx-observation-service.js";

function bars(timeframe: number): BarInfo[] {
  return Array.from({ length: 240 }, (_, index) => ({
    timestamp: new Date(Date.parse("2026-07-01T00:00:00Z") + index * timeframe * 60_000).toISOString(),
    open: 20_000 + index,
    high: 20_001 + index,
    low: 19_999 + index,
    close: 20_000.5 + index,
    volume: 100 + index,
  }));
}

describe("ProjectX market observation service", () => {
  it("requests native 1m 5m 15m and 60m series and builds one observation", async () => {
    const requests: RetrieveBarsRequest[] = [];
    const service = new ProjectXMarketObservationService(
      {
        retrieveBars: async (request) => {
          requests.push(request);
          return bars(request.unitNumber);
        },
      },
      {
        contractId: "CON.F.US.MNQ.U26",
        instrument: "MNQ",
        live: false,
        barLimit: 500,
        lookbackMultiplier: 3,
      },
      () => new Date("2026-07-21T12:00:00Z"),
    );
    const state = await service.refresh();
    assert.deepEqual(requests.map((request) => request.unitNumber).sort((a, b) => a - b), [1, 5, 15, 60]);
    assert.ok(requests.every((request) => request.unit === 2));
    assert.ok(requests.every((request) => request.limit === 500));
    assert.ok(requests.every((request) => request.includePartialBar));
    assert.equal(state.last_error, null);
    assert.equal(state.observation?.timeframes.length, 4);
    assert.equal(state.observation?.timeframes[3]?.features?.ema_200 !== null, true);
  });

  it("coalesces concurrent refresh calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const service = new ProjectXMarketObservationService(
      {
        retrieveBars: async (request) => {
          calls += 1;
          await gate;
          return bars(request.unitNumber);
        },
      },
      {
        contractId: "CON.F.US.MNQ.U26",
        instrument: "MNQ",
        live: false,
        barLimit: 500,
        lookbackMultiplier: 3,
      },
    );
    const first = service.refresh();
    const second = service.refresh();
    assert.equal(first, second);
    const idle = service.waitForIdle();
    release();
    await idle;
    assert.equal(calls, 4);
    assert.equal((await first).last_error, null);
  });

  it("preserves the last successful observation while publishing refresh failure", async () => {
    let fail = false;
    const service = new ProjectXMarketObservationService(
      {
        retrieveBars: async (request) => {
          if (fail) {
            throw new Error("history unavailable");
          }
          return bars(request.unitNumber);
        },
      },
      {
        contractId: "CON.F.US.MNQ.U26",
        instrument: "MNQ",
        live: false,
        barLimit: 500,
        lookbackMultiplier: 3,
      },
      () => new Date("2026-07-21T12:00:00Z"),
    );
    const successful = await service.refresh();
    fail = true;
    const degraded = await service.refresh();
    assert.ok(successful.observation);
    assert.deepEqual(degraded.observation, successful.observation);
    assert.match(degraded.last_error ?? "", /history unavailable/);
    assert.equal(degraded.last_succeeded_utc, successful.last_succeeded_utc);
  });
});
