#!/usr/bin/env node
/**
 * TS-REAUDIT-10: run automated fault-matrix proofs and emit JSON for release evidence.
 * Expects `npm run build` already completed (see package.json reaudit:fault-matrix).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAULT_MATRIX_PROOF_FILES = JSON.parse(
  readFileSync(join(ROOT, "scripts/reaudit-fault-matrix-proofs.json"), "utf8"),
);

function runProof(file) {
  const absolute = join(ROOT, file);
  if (file.endsWith(".mjs")) {
    execFileSync(process.execPath, [absolute], { cwd: ROOT, stdio: "inherit" });
    return;
  }
  const compiled = file.replace(/^tests\//, "dist/tests/").replace(/\.ts$/, ".js");
  execFileSync(process.execPath, ["--test", join(ROOT, compiled)], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

for (const file of FAULT_MATRIX_PROOF_FILES) {
  runProof(file);
}

const gatewayCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

const proof = {
  schema_version: "glitch.topstep.reaudit_fault_matrix_proof.v1",
  recorded_utc: new Date().toISOString(),
  gateway_commit: gatewayCommit,
  proofs: FAULT_MATRIX_PROOF_FILES.map((file) => ({
    file,
    sha256: createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex"),
  })),
};

const output = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : join(ROOT, "release", "reaudit-fault-matrix-proof.json");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(`reaudit_fault_matrix_proof:${output}`);
