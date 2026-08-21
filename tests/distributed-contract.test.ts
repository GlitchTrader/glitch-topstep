import assert from "node:assert/strict";
import test from "node:test";
import { TRANSITION_GRAPHS } from "../src/domain/state-machines.js";
import {
  AMENDMENT_SOURCES,
  DISTRIBUTED_STATE_MACHINE,
  isTightenOnlyAmendmentSource,
} from "../src/release/distributed-contract.js";
import { GATEWAY_COMPATIBILITY, PAIRED_CONTRACT } from "../src/release/compatibility.js";

test("TS-REAUDIT-09 distributed contract is paired and versioned", () => {
  assert.equal(
    PAIRED_CONTRACT.distributed_contract.schema_version,
    DISTRIBUTED_STATE_MACHINE.schema_version,
  );
  assert.equal(
    GATEWAY_COMPATIBILITY.distributed_contract.schema_version,
    "glitch.topstep.distributed_state_machine.v1",
  );
  assert.deepEqual(
    [...AMENDMENT_SOURCES],
    DISTRIBUTED_STATE_MACHINE.field_contracts.amendment_source.enum,
  );
  assert.ok(isTightenOnlyAmendmentSource("AUTO_BREAKEVEN"));
  assert.ok(!isTightenOnlyAmendmentSource("HERMES_INTENT"));
});

test("TS-REAUDIT-09 state machine document references runtime graphs", () => {
  const machines = Object.keys(TRANSITION_GRAPHS);
  for (const key of Object.keys(DISTRIBUTED_STATE_MACHINE.state_machines)) {
    const mapped = {
      lifecycle: "lifecycle",
      intent_admission: "intentAdmission",
      execution_saga: "executionSaga",
      protection_saga: "protectionSaga",
      reconciliation: "reconciliation",
      outcome_feed: "outcomeFeed",
      protected_reduction: "protectedReduction",
    }[key];
    assert.ok(mapped && machines.includes(mapped), `missing runtime graph for ${key}`);
  }
});

test("TS-REAUDIT-09 frozen daily-capture and breakeven policies are published", () => {
  assert.equal(DISTRIBUTED_STATE_MACHINE.frozen_policies.daily_capture_blocks_new_entries, true);
  assert.equal(DISTRIBUTED_STATE_MACHINE.frozen_policies.automatic_breakeven_intent_free, true);
  assert.equal(GATEWAY_COMPATIBILITY.distributed_contract.frozen_policies.automatic_paths_tighten_only, true);
});

test("TS-REAUDIT-09 cadence is configuration-only in contract", () => {
  assert.equal(DISTRIBUTED_STATE_MACHINE.cadence.configuration_only, true);
  assert.equal(DISTRIBUTED_STATE_MACHINE.cadence.not_trade_eligibility_gates, true);
  assert.equal(PAIRED_CONTRACT.distributed_contract.cadence.flat_decision_interval_minutes, 5);
});
