import assert from "node:assert/strict";
import test from "node:test";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import { validatePortfolioSelection } from "../src/risk/portfolio-selection.js";

const universe = resolveInstrumentUniverse(
  ["MNQ", "MES", "MCL"],
  [
    { id: "MNQ", name: "MNQU6", description: "Micro Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
    { id: "MES", name: "MESU6", description: "Micro S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
    { id: "MCLE", name: "MCLU6", description: "Micro Crude Oil", tickSize: 0.01, tickValue: 1, activeContract: true, symbolId: "F.US.MCLE" },
  ],
);

test("single-contract account selection accepts only an allowlisted exact contract", () => {
  const selected = validatePortfolioSelection({
    universe,
    selected_contract_id: "MCLE",
    open_contract_ids: [],
    simultaneous_exposure_enabled: false,
  });
  assert.deepEqual(selected, {
    allowed: true,
    code: "ok",
    selected_instrument: "MCL",
    selected_contract_id: "MCLE",
  });
  assert.equal(
    validatePortfolioSelection({ ...selectedInput(universe), selected_contract_id: "UNKNOWN" }).code,
    "selected_contract_not_allowlisted",
  );
});

test("foreign open exposure is blocked until explicit simultaneous opt-in", () => {
  const input = { ...selectedInput(universe), open_contract_ids: ["MNQ"] };
  assert.equal(
    validatePortfolioSelection({ ...input, selected_contract_id: "MES" }).code,
    "foreign_exposure_requires_accountwide_opt_in",
  );
  assert.equal(
    validatePortfolioSelection({ ...input, selected_contract_id: "MES", simultaneous_exposure_enabled: true }).allowed,
    true,
  );
});

function selectedInput(value: typeof universe) {
  return {
    universe: value,
    selected_contract_id: "MNQ",
    open_contract_ids: [],
    simultaneous_exposure_enabled: false,
  };
}
