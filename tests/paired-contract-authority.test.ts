import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { GATEWAY_COMPATIBILITY, PAIRED_CONTRACT } from "../src/release/compatibility.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE_ROOT = process.env.GLITCH_HERMES_PROFILE_ROOT
  ?? path.resolve(ROOT, "..", "..", "OneDrive", "Documentos", "GitHub", "glitch-topstep-hermes-profile");

test("TS-AUDIT-10 paired-contract.json drives gateway compatibility", () => {
  assert.equal(GATEWAY_COMPATIBILITY.protocol_revision, PAIRED_CONTRACT.protocol_revision);
  assert.equal(GATEWAY_COMPATIBILITY.runtime_intent_schema, "glitch.intent.v3");
  assert.equal(GATEWAY_COMPATIBILITY.gateway_version, packageJson.version);
  assert.deepEqual(
    [...GATEWAY_COMPATIBILITY.intent_schemas],
    [...PAIRED_CONTRACT.gateway_accepted_intent_schemas],
  );
});

test("TS-AUDIT-10 profile paired-contract.json matches gateway byte-for-byte", async () => {
  const gatewayPath = path.join(ROOT, "release", "paired-contract.json");
  const profilePath = path.join(PROFILE_ROOT, "paired-contract.json");
  const gatewayBytes = await readFile(gatewayPath);
  let profileBytes: Buffer;
  try {
    profileBytes = await readFile(profilePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `profile_paired_contract_missing:${profilePath}; set GLITCH_HERMES_PROFILE_ROOT or checkout glitch-topstep-hermes-profile`,
      );
    }
    throw error;
  }
  const canonicalHash = (raw: Buffer) =>
    createHash("sha256")
      .update(JSON.stringify(JSON.parse(raw.toString("utf8"))))
      .digest("hex");
  assert.equal(canonicalHash(gatewayBytes), canonicalHash(profileBytes));
});

test("TS-AUDIT-10 update-glitch-hermes.ps1 has no personal paths", () => {
  const script = readFileSync(path.join(ROOT, "update-glitch-hermes.ps1"), "utf8");
  assert.doesNotMatch(script, /OneDrive|C:\\Users\\/i);
  assert.match(script, /\$ProfileRoot/);
  assert.match(script, /glitch-topstep/);
  assert.match(script, /paired-contract\.json/);
});
