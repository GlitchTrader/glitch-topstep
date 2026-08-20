import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BarInfo, ContractInfo } from "../src/domain/models.js";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import { MultiInstrumentMarketDataPlane } from "../src/market/multi-instrument-data-plane.js";
import type { RetrieveBarsRequest } from "../src/projectx/client.js";

const NOW = new Date("2026-08-20T12:00:00Z");

const AVAILABLE: ContractInfo[] = [
  { id: "CON.F.US.MNQ.U26", name: "MNQU6", description: "Micro Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
  { id: "CON.F.US.MES.U26", name: "MESU6", description: "Micro S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
  { id: "CON.F.US.MCLE.V26", name: "MCLEV6", description: "Micro Crude Oil", tickSize: 0.01, tickValue: 1, activeContract: true, symbolId: "F.US.MCLE" },
];

/** Distinct price level per contract so cross-instrument bleed is visible in the observation. */
function bars(contractId: string, timeframeMinutes: number): BarInfo[] {
  const base = AVAILABLE.findIndex((contract) => contract.id === contractId) * 1_000 + 100;
  return Array.from({ length: 240 }, (_, index) => ({
    timestamp: new Date(NOW.getTime() - (240 - index) * timeframeMinutes * 60_000).toISOString(),
    open: base + index,
    high: base + index + 1,
    low: base + index - 1,
    close: base + index + 0.5,
    volume: 100 + index,
  }));
}

/** Fake clock so the throttle is exercised deterministically instead of in wall-clock seconds. */
function clock() {
  let value = NOW.getTime();
  return {
    now: () => new Date(value),
    sleep: async (ms: number) => {
      value += ms;
    },
  };
}

function plane(selectedContractId: string, requestsPerMinute = 60) {
  const requests: RetrieveBarsRequest[] = [];
  const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], AVAILABLE);
  const time = clock();
  const dataPlane = new MultiInstrumentMarketDataPlane(
    {
      retrieveBars: async (request) => {
        requests.push(request);
        return bars(request.contractId, request.unitNumber);
      },
    },
    universe,
    requestsPerMinute,
    selectedContractId,
    false,
    time.now,
    time.sleep,
  );
  return { dataPlane, requests, universe };
}

describe("TS-MULTI-02 multi-instrument market data plane", () => {
  it("observes every allowlisted contract while arming only the selected one", async () => {
    const { dataPlane, universe } = plane("CON.F.US.MNQ.U26");

    const packet = await dataPlane.refreshAll();

    assert.equal(packet.schema_version, "glitch.topstep.market_universe.v1");
    assert.equal(packet.scope_hash, universe.scope_hash);
    assert.deepEqual(
      packet.candidates.map((candidate) => [candidate.instrument, candidate.execution_mode]),
      [["MNQ", "selected"], ["MES", "observation_only"], ["MCL", "observation_only"]],
    );
  });

  it("keeps contract identity, tick economics, and bars partitioned per contract", async () => {
    const { dataPlane, requests } = plane("CON.F.US.MCLE.V26");

    const packet = await dataPlane.refreshAll();

    for (const candidate of packet.candidates) {
      const source = AVAILABLE.find((contract) => contract.id === candidate.contract_id)!;
      assert.equal(candidate.symbol_id, source.symbolId);
      assert.equal(candidate.tick_size, source.tickSize);
      assert.equal(candidate.tick_value, source.tickValue);
      assert.equal(candidate.market_observation.observation?.contract_id, candidate.contract_id);
      assert.equal(candidate.market_observation.observation?.instrument, candidate.instrument);
      assert.equal(candidate.observation_quality.status, "ready");
      assert.equal(candidate.observation_quality.completed_timeframe_count, 4);
    }

    // MCL is the operator alias; only the exact MCLE contract may be armed.
    assert.equal(
      packet.candidates.filter((candidate) => candidate.execution_mode === "selected")
        .map((candidate) => candidate.contract_id)
        .join(),
      "CON.F.US.MCLE.V26",
    );

    const perContract = new Map<string, number[]>();
    for (const request of requests) {
      perContract.set(request.contractId, [...(perContract.get(request.contractId) ?? []), request.unitNumber]);
    }
    assert.equal(perContract.size, 3);
    for (const [, timeframes] of perContract) {
      assert.deepEqual(timeframes.sort((left, right) => left - right), [1, 5, 15, 60]);
    }
  });

  it("routes every history request through the rate-aware scheduler and reports headroom", async () => {
    const { dataPlane } = plane("CON.F.US.MNQ.U26");

    const packet = await dataPlane.refreshAll();
    await dataPlane.waitForIdle();

    assert.equal(packet.scheduler.completed, 12);
    assert.equal(packet.scheduler.failed, 0);
    assert.equal(packet.scheduler.budget_per_window, 50);
    assert.ok(
      packet.scheduler.observed_peak_per_window <= packet.scheduler.budget_per_window,
      `observed peak ${packet.scheduler.observed_peak_per_window} exceeded the ProjectX history budget`,
    );
    assert.ok(packet.scheduler.headroom_per_window > 0);
  });

  it("isolates a failing instrument instead of degrading the whole universe", async () => {
    const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], AVAILABLE);
    const time = clock();
    const dataPlane = new MultiInstrumentMarketDataPlane(
      {
        retrieveBars: async (request) => {
          if (request.contractId === "CON.F.US.MES.U26") {
            throw new Error("history unavailable");
          }
          return bars(request.contractId, request.unitNumber);
        },
      },
      universe,
      60,
      "CON.F.US.MNQ.U26",
      false,
      time.now,
      time.sleep,
    );

    const packet = await dataPlane.refreshAll();

    const byInstrument = new Map(packet.candidates.map((candidate) => [candidate.instrument, candidate]));
    assert.equal(byInstrument.get("MES")!.observation_quality.status, "error");
    assert.equal(byInstrument.get("MNQ")!.observation_quality.status, "ready");
    assert.equal(byInstrument.get("MCL")!.observation_quality.status, "ready");
  });

  it("refreshSelected refreshes only the requested contract", async () => {
    const universe = resolveInstrumentUniverse(["MNQ", "MES"], AVAILABLE, 1);
    const time = clock();
    const calls: string[] = [];
    const dataPlane = new MultiInstrumentMarketDataPlane(
      {
        retrieveBars: async (request) => {
          calls.push(request.contractId);
          return bars(request.contractId, request.unitNumber);
        },
      },
      universe,
      60,
      "CON.F.US.MNQ.U26",
      false,
      time.now,
      time.sleep,
    );

    await dataPlane.refreshSelected("CON.F.US.MNQ.U26");

    assert.ok(calls.length >= 4);
    assert.ok(calls.every((contractId) => contractId === "CON.F.US.MNQ.U26"));
  });
});
