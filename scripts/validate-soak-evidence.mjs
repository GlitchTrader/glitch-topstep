import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing_${name}`);
  }
  return process.argv[index + 1];
}

const requiredChaos = [
  "reconnect",
  "rate_limit_429",
  "auth_expiry",
  "disk_pressure",
  "partial_restart",
];

const evidencePath = resolve(argument("evidence"));
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (evidence.schema_version !== "glitch.topstep.soak_evidence.v1") {
  throw new Error("invalid_schema_version");
}
if (!Array.isArray(evidence.chaos_scenarios)) {
  throw new Error("missing_chaos_scenarios");
}
for (const scenario of requiredChaos) {
  if (!evidence.chaos_scenarios.includes(scenario)) {
    throw new Error(`missing_chaos_scenario:${scenario}`);
  }
}
if (typeof evidence.duration_hours !== "number" || evidence.duration_hours < 24) {
  throw new Error("insufficient_soak_duration");
}
if (!Array.isArray(evidence.invariants_violated) || evidence.invariants_violated.length > 0) {
  throw new Error("invariants_violated_must_be_empty");
}
if (!evidence.paired_release_ref || typeof evidence.paired_release_ref !== "string") {
  throw new Error("missing_paired_release_ref");
}

console.log("soak_evidence_ok");
