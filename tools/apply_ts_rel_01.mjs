#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function write(rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function replaceOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  const last = text.lastIndexOf(oldText);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return text.replace(oldText, newText);
}

write(
  "src/release/compatibility.ts",
  `export const GATEWAY_COMPATIBILITY = Object.freeze({
  gateway_name: "glitch-topstep",
  gateway_version: "0.1.2",
  health_schema: "glitch.direct.health.v2",
  intent_schemas: Object.freeze(["glitch.intent.v2"]),
  decision_packet_schemas: Object.freeze([
    "glitch.direct.decision_packet.v1",
    "glitch.direct.decision_packet.v2",
  ]),
  capabilities: Object.freeze([
    "packet_supported_actions",
    "position_management",
    "tranche_ownership",
    "native_protection",
    "durable_mutation_receipts",
    "restart_reconciliation",
  ]),
});

export type GatewayCompatibility = typeof GATEWAY_COMPATIBILITY;
`,
);

let service = read("src/service.ts");
service = replaceOnce(
  service,
  `import { LocalGatewayServer } from "./server/local-gateway.js";\n`,
  `import { LocalGatewayServer } from "./server/local-gateway.js";\nimport { GATEWAY_COMPATIBILITY } from "./release/compatibility.js";\n`,
  "service compatibility import",
);
service = replaceOnce(
  service,
  `          schema_version: "glitch.direct.health.v2",\n`,
  `          schema_version: "glitch.direct.health.v2",\n          compatibility: GATEWAY_COMPATIBILITY,\n`,
  "health compatibility field",
);
write("src/service.ts", service);

write(
  "tests/compatibility.test.ts",
  `import assert from "node:assert/strict";
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
`,
);

for (const rel of ["package.json", "package-lock.json"]) {
  const data = JSON.parse(read(rel));
  data.version = "0.1.2";
  if (data.packages?.[""]) {
    data.packages[""].version = "0.1.2";
  }
  write(rel, `${JSON.stringify(data, null, 2)}\n`);
}

write(
  "docs/specs/TS-REL-01.md",
  `# TS-REL-01 — Gateway/profile compatibility metadata

**Issue:** #54  
**Gateway version:** 0.1.2

## Contract

Authenticated `/health` includes a nonsecret `compatibility` object naming the gateway package identity, health schema, accepted intent schema, emitted decision-packet schemas, and software capability families required by the Hermes profile.

Per-packet \`execution.supported_actions\` remains the current-state action authority. Global compatibility metadata never authorizes a trade or adds a market-strategy gate.

## Fields

- \`gateway_name\`
- \`gateway_version\`
- \`health_schema\`
- \`intent_schemas\`
- \`decision_packet_schemas\`
- \`capabilities\`

The contract contains no ProjectX credentials, local gateway token, account identifiers, policy values, or market evidence.

## Acceptance

- package and compatibility versions match in CI;
- health source includes the exact compatibility constant;
- schema and capability lists are stable and tested;
- paired profile setup/cycles fail closed when the contract is incompatible;
- packet-supported actions remain state-dependent.
`,
);

const ledgerPath = "docs/ledger/ledger.json";
const ledger = JSON.parse(read(ledgerPath));
const releaseItem = {
  id: "TS-REL-01",
  title: "Expose one authenticated gateway compatibility contract for Hermes profiles",
  status: "done",
  priority: "P0",
  owner_role: "release_architecture",
  issue: 54,
  pull_request: 55,
  evidence: [
    "src/release/compatibility.ts",
    "src/service.ts health payload",
    "tests/compatibility.test.ts",
    "docs/specs/TS-REL-01.md",
    "package and lockfile version 0.1.2",
  ],
};
const existingIndex = ledger.items.findIndex((item) => item.id === "TS-REL-01");
if (existingIndex >= 0) ledger.items[existingIndex] = releaseItem;
else ledger.items.splice(1, 0, releaseItem);
const beta = ledger.items.find((item) => item.id === "TS-BETA-01");
if (beta && Array.isArray(beta.depends_on) && !beta.depends_on.includes("TS-REL-01")) {
  beta.depends_on.unshift("TS-REL-01");
}
ledger.updated = "2026-08-02";
write(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

console.log("TS-REL-01 rewrite applied");
