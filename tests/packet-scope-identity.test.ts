import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContractInfo } from "../src/domain/models.js";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import { resolveActivePositionScope } from "../src/market/active-position-scope.js";
import { MultiInstrumentMarketDataPlane } from "../src/market/multi-instrument-data-plane.js";
import type { RetrieveBarsRequest } from "../src/projectx/client.js";

const NOW = new Date("2026-09-08T16:00:00Z");

const AVAILABLE: ContractInfo[] = [
  { id: "CON.F.US.MNQ.U26", name: "MNQU6", description: "Micro Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
  { id: "CON.F.US.MES.U26", name: "MESU6", description: "Micro S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
];

function bars(contractId: string, timeframeMinutes: number) {
  const base = AVAILABLE.findIndex((contract) => contract.id === contractId) * 1_000 + 100;
  return Array.from({ length: 240 }, (_, index) => ({
    timestamp: new Date(NOW.getTime() - (240 - index) * timeframeMinutes * 60_000).toISOString(),
    open: base + index,
    high: base + index + 1,
    low: base - 1,
    close: base + index + 0.5,
    volume: 100 + index,
  }));
}

describe("packet scope identity", () => {
  it("position change during refresh must not retarget packet contract", async () => {
    const universe = resolveInstrumentUniverse(["MNQ", "MES"], AVAILABLE);
    const scopeBeforePositionChange = resolveActivePositionScope({
      universe,
      referenceContractId: "CON.F.US.MNQ.U26",
      referenceInstrument: "MNQ",
      openContractIds: ["CON.F.US.MES.U26"],
      workingOrderContractIds: [],
    });
    const scopeAfterPositionChange = resolveActivePositionScope({
      universe,
      referenceContractId: "CON.F.US.MNQ.U26",
      referenceInstrument: "MNQ",
      openContractIds: ["CON.F.US.MNQ.U26"],
      workingOrderContractIds: [],
    });
    assert.equal(scopeBeforePositionChange.packetTargetContractId, "CON.F.US.MES.U26");
    assert.equal(scopeAfterPositionChange.packetTargetContractId, "CON.F.US.MNQ.U26");

    const refreshedContracts: string[] = [];
    const dataPlane = new MultiInstrumentMarketDataPlane(
      {
        retrieveBars: async (request: RetrieveBarsRequest) => {
          refreshedContracts.push(request.contractId);
          return bars(request.contractId, request.unitNumber);
        },
      },
      universe,
      60,
      "CON.F.US.MNQ.U26",
      false,
      () => NOW,
      async () => undefined,
    );

    await dataPlane.refreshForPacket(NOW, scopeBeforePositionChange);
    assert.ok(
      refreshedContracts.includes("CON.F.US.MES.U26"),
      "refresh must honor scope frozen at request start",
    );

    const packetObservation = dataPlane.current(NOW, scopeBeforePositionChange)
      .candidates.find((candidate) => candidate.contract_id === scopeBeforePositionChange.packetTargetContractId)
      ?.market_observation;
    assert.equal(
      packetObservation?.observation?.contract_id ?? scopeBeforePositionChange.packetTargetContractId,
      scopeBeforePositionChange.packetTargetContractId,
    );
    assert.notEqual(
      scopeBeforePositionChange.packetTargetContractId,
      scopeAfterPositionChange.packetTargetContractId,
    );
  });
});
