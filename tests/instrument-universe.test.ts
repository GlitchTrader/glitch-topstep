import assert from "node:assert/strict";
import test from "node:test";
import type { ContractInfo } from "../src/domain/models.js";
import { normalizeInstrument, resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";

const contracts: ContractInfo[] = [
  { id: "CON.F.US.MNQ.U26", name: "MNQU6", description: "Micro Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
  { id: "CON.F.US.MES.U26", name: "MESU6", description: "Micro S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
  { id: "CON.F.US.MCLE.U26", name: "MCLU6", description: "Micro WTI Crude Oil", tickSize: 0.01, tickValue: 1, activeContract: true, symbolId: "F.US.MCLE" },
];

test("MCL is the operator symbol and resolves to the ProjectX MCLE family", () => {
  assert.equal(normalizeInstrument("mcle"), "MCL");
  const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], contracts, 7);
  assert.equal(universe.contracts[2]?.instrument, "MCL");
  assert.equal(universe.contracts[2]?.contract_id, "CON.F.US.MCLE.U26");
  assert.equal(universe.generation, 7);
  assert.match(universe.scope_hash, /^[a-f0-9]{64}$/);
});

test("contract resolution fails closed on absent or ambiguous active contracts", () => {
  assert.throws(() => resolveInstrumentUniverse(["MCL"], []), /active_contract_not_found:MCL/);
  assert.throws(
    () => resolveInstrumentUniverse(["MCL"], [...contracts, { ...contracts[2]!, id: "duplicate" }]),
    /active_contract_ambiguous:MCL/,
  );
});

test("contract resolution rejects duplicate exact identity and invalid tick economics", () => {
  assert.throws(
    () => resolveInstrumentUniverse(
      ["MNQ", "MES"],
      [contracts[0]!, { ...contracts[1]!, id: contracts[0]!.id, symbolId: "F.US.MES" }],
    ),
    /instrument_contract_collision:CON\.F\.US\.MNQ\.U26/,
  );
  assert.throws(
    () => resolveInstrumentUniverse(["MCL"], [{ ...contracts[2]!, tickValue: 0 }]),
    /contract_economics_invalid:MCL:CON\.F\.US\.MCLE\.U26/,
  );
});

