import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { GATEWAY_COMPATIBILITY, PAIRED_CONTRACT } from "../src/release/compatibility.js";

// Compiled tests live under dist/tests → repo root is ../..
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE_ROOT = process.env.GLITCH_HERMES_PROFILE_ROOT
  ?? path.resolve(ROOT, "..", "glitch-topstep-hermes-profile");

function pairedContractSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPairedContractsByteIdentical(gatewayPath: string, profilePath: string): void {
  const gatewayBytes = readFileSync(gatewayPath);
  const profileBytes = readFileSync(profilePath);
  if (Buffer.compare(gatewayBytes, profileBytes) !== 0) {
    throw new Error(
      `paired_contract_byte_mismatch gateway=${pairedContractSha256(gatewayBytes)} profile=${pairedContractSha256(profileBytes)}`,
    );
  }
}

test("TS-AUDIT-10 paired-contract.json drives gateway compatibility", () => {
  assert.equal(GATEWAY_COMPATIBILITY.protocol_revision, PAIRED_CONTRACT.protocol_revision);
  assert.equal(GATEWAY_COMPATIBILITY.runtime_intent_schema, "glitch.intent.v3");
  assert.equal(GATEWAY_COMPATIBILITY.gateway_version, packageJson.version);
  assert.deepEqual(
    [...GATEWAY_COMPATIBILITY.intent_schemas],
    [...PAIRED_CONTRACT.gateway_accepted_intent_schemas],
  );
});

test("TS-AUDIT-10 profile paired-contract.json matches gateway byte-for-byte", async (t) => {
  const gatewayPath = path.join(ROOT, "release", "paired-contract.json");
  const profilePath = path.join(PROFILE_ROOT, "paired-contract.json");
  const gatewayBytes = await readFile(gatewayPath);
  let profileBytes: Buffer;
  try {
    profileBytes = await readFile(profilePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip(`profile_paired_contract_missing:${profilePath}`);
      return;
    }
    throw error;
  }
  assert.equal(
    Buffer.compare(gatewayBytes, profileBytes),
    0,
    `paired_contract_byte_mismatch gateway=${pairedContractSha256(gatewayBytes)} profile=${pairedContractSha256(profileBytes)}`,
  );
});

test("paired-contract helper detects content divergence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paired-contract-"));
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    await writeFile(a, '{"x":1}\n');
    await writeFile(b, '{"x":2}\n');
    assert.throws(
      () => assertPairedContractsByteIdentical(a, b),
      /paired_contract_byte_mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paired-contract helper detects newline divergence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paired-contract-nl-"));
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    await writeFile(a, '{"x":1}\n');
    await writeFile(b, '{"x":1}\r\n');
    assert.throws(
      () => assertPairedContractsByteIdentical(a, b),
      /paired_contract_byte_mismatch/,
    );
    const hashA = createHash("sha256").update(await readFile(a)).digest("hex");
    const hashB = createHash("sha256").update(await readFile(b)).digest("hex");
    assert.notEqual(hashA, hashB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TS-AUDIT-10 update-glitch-hermes.ps1 has no personal paths", () => {
  const script = readFileSync(path.join(ROOT, "update-glitch-hermes.ps1"), "utf8");
  assert.doesNotMatch(script, /OneDrive|C:\\Users\\/i);
  assert.match(script, /\$ProfileRoot/);
  assert.match(script, /glitch-topstep/);
  assert.match(script, /paired-contract\.json/);
});
