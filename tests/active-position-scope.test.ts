import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContractInfo } from "../src/domain/models.js";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import { resolveActivePositionScope } from "../src/market/active-position-scope.js";

const CATALOG: ContractInfo[] = [
  { id: "CON.F.US.MNQ.U26", name: "MNQU6", description: "Micro Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
  { id: "CON.F.US.MES.U26", name: "MESU6", description: "Micro S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
  { id: "CON.F.US.MCLE.V26", name: "MCLEV6", description: "Micro Crude Oil", tickSize: 0.01, tickValue: 1, activeContract: true, symbolId: "F.US.MCLE" },
];

const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], CATALOG);

const baseInput = {
  universe,
  referenceContractId: "CON.F.US.MNQ.U26",
  referenceInstrument: "MNQ",
  openContractIds: [] as string[],
  workingOrderContractIds: [] as string[],
};

describe("active-position-scope", () => {
  it("marks every candidate eligible when the account is flat", () => {
    const scope = resolveActivePositionScope(baseInput);

    assert.equal(scope.accountFlat, true);
    assert.equal(scope.packetTargetContractId, "CON.F.US.MNQ.U26");
    assert.deepEqual(
      universe.contracts.map((contract) => scope.executionModeFor(contract.contract_id)),
      ["eligible", "eligible", "eligible"],
    );
  });

  it("prefers an explicit flat-account packet request over the reference contract", () => {
    const scope = resolveActivePositionScope({
      ...baseInput,
      requestedContractId: "CON.F.US.MES.U26",
    });

    assert.equal(scope.packetTargetContractId, "CON.F.US.MES.U26");
    assert.equal(scope.packetTargetInstrument, "MES");
  });

  it("locks to the active contract and marks others flat_required when positioned", () => {
    const scope = resolveActivePositionScope({
      ...baseInput,
      openContractIds: ["CON.F.US.MES.U26"],
      requestedContractId: "CON.F.US.MNQ.U26",
    });

    assert.equal(scope.activeContractId, "CON.F.US.MES.U26");
    assert.equal(scope.packetTargetContractId, "CON.F.US.MES.U26");
    assert.equal(scope.executionModeFor("CON.F.US.MES.U26"), "selected");
    assert.equal(scope.executionModeFor("CON.F.US.MNQ.U26"), "flat_required");
    assert.equal(scope.executionModeFor("CON.F.US.MCLE.V26"), "flat_required");
  });

  it("resolves instrument alias requests inside the allowlisted universe", () => {
    const scope = resolveActivePositionScope({
      ...baseInput,
      requestedInstrument: "MCL",
    });

    assert.equal(scope.packetTargetContractId, "CON.F.US.MCLE.V26");
    assert.equal(scope.packetTargetInstrument, "MCL");
  });
});
