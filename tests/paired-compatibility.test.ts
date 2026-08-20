import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_COMPATIBILITY, PAIRED_CONTRACT } from "../src/release/compatibility.js";

test("TS-PROD-07 gateway advertises the Hermes-required paired contract", () => {
  assert.equal(GATEWAY_COMPATIBILITY.protocol_revision, PAIRED_CONTRACT.protocol_revision);
  assert.equal(GATEWAY_COMPATIBILITY.health_schema, PAIRED_CONTRACT.health_schema);
  assert.equal(GATEWAY_COMPATIBILITY.gateway_name, PAIRED_CONTRACT.gateway.name);
  const advertised = new Set(GATEWAY_COMPATIBILITY.capabilities);
  for (const capability of PAIRED_CONTRACT.required_capabilities) {
    assert.ok(advertised.has(capability), `missing capability ${capability}`);
  }
  for (const [name, expected] of Object.entries(PAIRED_CONTRACT.semantic_revisions)) {
    assert.equal(
      GATEWAY_COMPATIBILITY.semantic_revisions[name as keyof typeof GATEWAY_COMPATIBILITY.semantic_revisions],
      expected,
      `semantic revision ${name}`,
    );
  }
  for (const [name, expected] of Object.entries(PAIRED_CONTRACT.provider_acceptance_evidence)) {
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
  const missing = PAIRED_CONTRACT.required_capabilities.filter((item) => !broken.has(item));
  assert.deepEqual(missing, ["protected_reduction_saga_v1"]);
});
