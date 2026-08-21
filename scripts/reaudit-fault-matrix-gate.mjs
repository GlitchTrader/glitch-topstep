#!/usr/bin/env node
/**
 * TS-REAUDIT-10: run automated fault-matrix proofs and emit JSON for release evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const proofFiles = [
  "tests/reaudit-fault-matrix.test.ts",
  "tests/projectx-auth-manager.test.ts",
  "tests/reaudit-phase1.test.ts",
  "tests/lifecycle-supervisor.test.ts",
  "tests/flatten-workflow.test.ts",
  "tests/kill-matrix.test.ts",
  "tests/paired-release-manifest.test.ts",
];

execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });

for (const file of proofFiles) {
  const compiled = file.replace(/^tests\//, "dist/tests/").replace(/\.ts$/, ".js");
  execFileSync(
    process.execPath,
    ["--test", join(ROOT, compiled)],
    { cwd: ROOT, stdio: "inherit" },
  );
}

const gatewayCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

const proof = {
  schema_version: "glitch.topstep.reaudit_fault_matrix_proof.v1",
  recorded_utc: new Date().toISOString(),
  gateway_commit: gatewayCommit,
  proofs: proofFiles.map((file) => ({
    file,
    sha256: createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex"),
  })),
};

const output = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : join(ROOT, "release", "reaudit-fault-matrix-proof.json");

writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(`reaudit_fault_matrix_proof:${output}`);
