import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProtectionHealth } from "../src/execution/protection-supervisor.js";
import { snapshot } from "./fixtures.js";

test("TS-AUDIT-09 protection supervisor reports zero unprotected on flat healthy snapshot", () => {
  const health = evaluateProtectionHealth({
    snapshot: snapshot(),
    tranches: [],
    activeReduction: null,
    accountId: 101,
    contractId: "CON.F.US.MNQ.U26",
  });
  assert.equal(health.unprotected_open_quantity, 0);
  assert.equal(health.orphan_protective_orders, 0);
});
