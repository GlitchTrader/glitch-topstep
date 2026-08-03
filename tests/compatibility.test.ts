import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { GATEWAY_COMPATIBILITY } from "../src/release/compatibility.js";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  name: string;
  version: string;
};

describe("gateway compatibility contract", () => {
  it("matches the packaged gateway identity", () => {
    assert.equal(GATEWAY_COMPATIBILITY.gateway_name, packageJson.name);
    assert.equal(GATEWAY_COMPATIBILITY.gateway_version, packageJson.version);
    assert.equal(GATEWAY_COMPATIBILITY.health_schema, "glitch.direct.health.v2");
  });

  it("names the profile-facing wire contracts and capabilities", () => {
    assert.deepEqual(GATEWAY_COMPATIBILITY.intent_schemas, ["glitch.intent.v2"]);
    assert.deepEqual(GATEWAY_COMPATIBILITY.decision_packet_schemas, [
      "glitch.direct.decision_packet.v1",
      "glitch.direct.decision_packet.v2",
    ]);
    assert.ok(GATEWAY_COMPATIBILITY.capabilities.includes("packet_supported_actions"));
    assert.ok(GATEWAY_COMPATIBILITY.capabilities.includes("position_management"));
    assert.ok(GATEWAY_COMPATIBILITY.capabilities.includes("native_protection"));
    assert.ok(GATEWAY_COMPATIBILITY.capabilities.includes("restart_reconciliation"));
  });

  it("is present in health and contains no credential-shaped fields", () => {
    const service = fs.readFileSync("src/service.ts", "utf8");
    assert.match(service, /compatibility: GATEWAY_COMPATIBILITY/);
    const serialized = JSON.stringify(GATEWAY_COMPATIBILITY).toLowerCase();
    for (const forbidden of ["api_key", "apikey", "password", "secret", "token"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
