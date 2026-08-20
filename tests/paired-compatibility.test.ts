import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_COMPATIBILITY } from "../src/release/compatibility.js";

/**
 * Mirrors glitch-topstep-hermes-profile scripts/compatibility.py PROFILE_COMPATIBILITY
 * required surfaces after Hermes PR #116 (saga + outcome_feed.v2).
 * Keep in lockstep when bumping either side — paired.v3.
 */
const PROFILE_REQUIRED = Object.freeze({
  protocol_revision: "glitch.topstep.paired.v3",
  health_schema: "glitch.direct.health.v2",
  gateway_name: "glitch-topstep",
  required_capabilities: Object.freeze([
    "packet_supported_actions",
    "durable_mutation_receipts",
    "restart_reconciliation",
    "bounded_entry_range_v1",
    "daily_capture_context_v1",
    "explicit_partial_completed_bars_v1",
    "revisioned_outcome_feed_v1",
    "multi_instrument_observation_v1",
    "protected_reduction_saga_v1",
  ]),
  required_semantic_revisions: Object.freeze({
    bounded_entry_range: "glitch.topstep.entry_range.v1",
    daily_capture: "glitch.topstep.daily_capture.v1",
    outcome_feed: "glitch.topstep.outcome_feed.v2",
    market_universe: "glitch.topstep.market_universe.v1",
    execution_facts: "glitch.topstep.execution_fact.v1",
  }),
  required_provider_acceptance_evidence: Object.freeze({
    partial_exit_protection_transition: "proven_prac_short_long_with_saga",
    exact_contract_resolution: "catalog_fixture_plus_runtime_resolution",
  }),
});

test("TS-PROD-07 gateway advertises the Hermes-required paired contract", () => {
  assert.equal(GATEWAY_COMPATIBILITY.protocol_revision, PROFILE_REQUIRED.protocol_revision);
  assert.equal(GATEWAY_COMPATIBILITY.health_schema, PROFILE_REQUIRED.health_schema);
  assert.equal(GATEWAY_COMPATIBILITY.gateway_name, PROFILE_REQUIRED.gateway_name);
  const advertised = new Set(GATEWAY_COMPATIBILITY.capabilities);
  for (const capability of PROFILE_REQUIRED.required_capabilities) {
    assert.ok(advertised.has(capability), `missing capability ${capability}`);
  }
  for (const [name, expected] of Object.entries(PROFILE_REQUIRED.required_semantic_revisions)) {
    assert.equal(
      GATEWAY_COMPATIBILITY.semantic_revisions[name as keyof typeof GATEWAY_COMPATIBILITY.semantic_revisions],
      expected,
      `semantic revision ${name}`,
    );
  }
  for (const [name, expected] of Object.entries(PROFILE_REQUIRED.required_provider_acceptance_evidence)) {
    assert.equal(
      GATEWAY_COMPATIBILITY.provider_acceptance_evidence[
        name as keyof typeof GATEWAY_COMPATIBILITY.provider_acceptance_evidence
      ],
      expected,
      `provider evidence ${name}`,
    );
  }
});

test("TS-PROD-07 intentionally incompatible capability set is detected", () => {
  const broken = new Set(GATEWAY_COMPATIBILITY.capabilities);
  broken.delete("protected_reduction_saga_v1");
  const missing = PROFILE_REQUIRED.required_capabilities.filter((item) => !broken.has(item));
  assert.deepEqual(missing, ["protected_reduction_saga_v1"]);
});
