import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePortfolioAdmission } from "../src/risk/portfolio-risk.js";

test("simultaneous cross-contract exposure is opt-in and account-wide risk is additive", () => {
  const base = {
    hard_loss_buffer_usd: 500,
    existing: [{ contract_id: "MNQ", quantity: 1, stop_distance_ticks: 20, tick_value: 0.5, fees_usd: 2, slippage_ticks: 2 }],
    pending: [],
    candidate: { contract_id: "MCL", quantity: 1, stop_distance_ticks: 30, tick_value: 1, fees_usd: 2, slippage_ticks: 2 },
  };
  assert.equal(evaluatePortfolioAdmission({ ...base, simultaneous_exposure_enabled: false }).code, "simultaneous_exposure_disabled");
  const allowed = evaluatePortfolioAdmission({ ...base, simultaneous_exposure_enabled: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.protected_downside_usd, 47);
});

