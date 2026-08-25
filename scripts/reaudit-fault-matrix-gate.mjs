#!/usr/bin/env node
/**
 * TS-REAUDIT-10: run automated fault-matrix proofs and emit JSON for release evidence.
 * Expects `npm run build` already completed (see package.json reaudit:fault-matrix).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROOF_CONFIG = JSON.parse(
  readFileSync(join(ROOT, "scripts/reaudit-fault-matrix-proofs.json"), "utf8"),
);
const GATEWAY_PROOF_FILES = Array.isArray(PROOF_CONFIG)
  ? PROOF_CONFIG
  : PROOF_CONFIG.gateway;
const PROFILE_PROOF_CONFIG = Array.isArray(PROOF_CONFIG) ? null : PROOF_CONFIG.profile;

function resolveProfileRoot() {
  const candidates = [
    process.env.GLITCH_HERMES_PROFILE_ROOT,
    join(ROOT, "profile"),
    join(ROOT, "..", "glitch-topstep-hermes-profile"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const root = resolve(String(candidate));
    if (existsSync(join(root, "tests", "test_fault_injection.py"))) {
      return root;
    }
  }
  return null;
}

function resolvePythonExecutable() {
  const candidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
  for (const executable of candidates) {
    const probe = spawnSync(executable, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) {
      return executable;
    }
  }
  throw new Error("python_not_found_for_profile_fault_matrix");
}

function runGatewayProof(file) {
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

function runProfileProof(profileRoot, profileConfig) {
  const python = resolvePythonExecutable();
  execFileSync(
    python,
    ["-m", "unittest", profileConfig.unittest_module],
    {
      cwd: profileRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONPATH: join(profileRoot, "scripts"),
      },
    },
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function validateProof(proof) {
  if (proof.schema_version !== "glitch.topstep.reaudit_fault_matrix_proof.v1") {
    throw new Error("invalid_fault_matrix_proof_schema_version");
  }
  if (!/^[0-9a-f]{40}$/.test(proof.gateway_commit)) {
    throw new Error("invalid_fault_matrix_proof_gateway_commit");
  }
  if (!Array.isArray(proof.proofs) || proof.proofs.length === 0) {
    throw new Error("invalid_fault_matrix_proof_gateway_proofs");
  }
  for (const row of proof.proofs) {
    if (!row.file || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new Error(`invalid_fault_matrix_proof_gateway_row:${row.file ?? "missing"}`);
    }
  }
  if (proof.profile_commit != null && !/^[0-9a-f]{40}$/.test(proof.profile_commit)) {
    throw new Error("invalid_fault_matrix_proof_profile_commit");
  }
  if (proof.profile_proofs != null) {
    if (!Array.isArray(proof.profile_proofs) || proof.profile_proofs.length === 0) {
      throw new Error("invalid_fault_matrix_proof_profile_proofs");
    }
    for (const row of proof.profile_proofs) {
      if (!row.file || !/^[0-9a-f]{64}$/.test(row.sha256)) {
        throw new Error(`invalid_fault_matrix_proof_profile_row:${row.file ?? "missing"}`);
      }
    }
  }
}

for (const file of GATEWAY_PROOF_FILES) {
  runGatewayProof(file);
}

const gatewayCommit = gitHead(ROOT);
const proof = {
  schema_version: "glitch.topstep.reaudit_fault_matrix_proof.v1",
  recorded_utc: new Date().toISOString(),
  gateway_commit: gatewayCommit,
  proofs: GATEWAY_PROOF_FILES.map((file) => ({
    file,
    sha256: sha256File(join(ROOT, file)),
  })),
};

const profileRoot = resolveProfileRoot();
if (PROFILE_PROOF_CONFIG && profileRoot) {
  runProfileProof(profileRoot, PROFILE_PROOF_CONFIG);
  proof.profile_commit = gitHead(profileRoot);
  proof.profile_proofs = PROFILE_PROOF_CONFIG.proofs.map((file) => ({
    file,
    sha256: sha256File(join(profileRoot, file)),
  }));
} else if (PROFILE_PROOF_CONFIG) {
  throw new Error(
    "profile_fault_matrix_root_missing: set GLITCH_HERMES_PROFILE_ROOT or checkout sibling profile repo",
  );
}

validateProof(proof);

const output = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : join(ROOT, "release", "reaudit-fault-matrix-proof.json");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(`reaudit_fault_matrix_proof:${output}`);
