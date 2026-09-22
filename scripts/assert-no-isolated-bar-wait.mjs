#!/usr/bin/env node
/**
 * Fail if isolated wait_for_bar_complete pre-wait returns in live scripts.
 * Canonical live stability entry: profile scripts/run-canonical-live-stability.py
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const DIAGNOSIS = join(SCRIPTS, "gateway-readonly-diagnosis.py");

const diagnosis = readFileSync(DIAGNOSIS, "utf8");

const failures = [];

if (/def\s+wait_for_bar_complete\s*\(/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must not define wait_for_bar_complete");
}
if (/legacy_partial_poll/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must not keep legacy_partial_poll bar-wait");
}
if (!/isolated_bar_wait_forbidden/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must refuse isolated bar-wait explicitly");
}
if (!/run-canonical-live-stability\.py/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must point operators to run-canonical-live-stability.py");
}
if (!/validate_live_context_before_fetch/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must validate roots/SHAs/contract before fetch");
}
if (/from\s+operational_stability_gate\s+import\s+wait_for_bar_complete/.test(diagnosis)) {
  failures.push("gateway-readonly-diagnosis.py must not import wait_for_bar_complete");
}
if (/run_operational_stability_window\s*\(/.test(diagnosis)) {
  failures.push(
    "gateway-readonly-diagnosis.py must not call run_operational_stability_window directly; delegate to canonical runner",
  );
}

const liveExt = new Set([".py", ".mjs", ".ps1", ".js", ".ts"]);
for (const name of readdirSync(SCRIPTS)) {
  const ext = name.slice(name.lastIndexOf("."));
  if (!liveExt.has(ext)) continue;
  if (name === "gateway-readonly-diagnosis.py") continue;
  if (name === "assert-no-isolated-bar-wait.mjs") continue;
  const text = readFileSync(join(SCRIPTS, name), "utf8");
  if (/wait_for_bar_complete\s*\(/.test(text) || /--wait-bar-complete/.test(text)) {
    failures.push(`${name}: must not call wait_for_bar_complete / --wait-bar-complete as a live pre-step`);
  }
}

if (failures.length) {
  console.error("assert-no-isolated-bar-wait FAILED:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    canonical_entry: "run-canonical-live-stability.py",
    diagnosis: "isolated_bar_wait_forbidden",
  }),
);
