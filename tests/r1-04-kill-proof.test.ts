import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  R1_04_KILL_PROOF_SCHEMA,
  validateR1_04KillProof,
  type R1_04KillProof,
} from "../src/projectx/r1-04-kill-proof.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "projectx", "live", "r1_04_kill_matrix_proof.json");

describe("TS-R1-04 real kill matrix proof", () => {
  it("validates the live PRAC kill matrix fixture when present", () => {
    if (!fs.existsSync(FIXTURE)) {
      return;
    }
    const proof = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as R1_04KillProof;
    assert.equal(proof.schema_version, R1_04_KILL_PROOF_SCHEMA);
    const failures = validateR1_04KillProof(proof);
    assert.deepEqual(failures, [], failures.join(", "));
    assert.equal(proof.proof_passed, true);
  });
});
