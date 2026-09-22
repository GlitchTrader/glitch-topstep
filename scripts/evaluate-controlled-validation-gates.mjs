#!/usr/bin/env node
/**
 * CLI wrapper for controlled-validation gates (after npm run build).
 *
 *   node scripts/evaluate-controlled-validation-gates.mjs \
 *     --health health.json --state state.json [--packet packet.json] \
 *     [--packet-latency-ms 19729] [--capture-now-ms 1727028840000]
 *
 * Capture clock: prefer --capture-now-ms; else health.recorded_utc /
 * state.capturedAt inside the evaluator. Never pass wall-clock against
 * frozen evidence unless you intentionally want that (don't).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(
  pathToFileURL(join(root, "dist/src/ops/controlled-validation-gates.js")).href
);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

const healthPath = argValue("--health");
const statePath = argValue("--state");
if (!healthPath || !statePath) {
  console.error(
    "usage: --health <file> --state <file> [--packet <file>] [--packet-latency-ms <n>] [--capture-now-ms <epoch_ms>]",
  );
  process.exit(1);
}

const packetPath = argValue("--packet");
const latencyRaw = argValue("--packet-latency-ms");
const packetLatencyMs = latencyRaw === null ? null : Number(latencyRaw);
const captureRaw = argValue("--capture-now-ms");
const captureNowMs = captureRaw === null ? undefined : Number(captureRaw);

const result = mod.evaluateControlledValidationGates({
  health: JSON.parse(readFileSync(healthPath, "utf8")),
  state: JSON.parse(readFileSync(statePath, "utf8")),
  packet: packetPath ? JSON.parse(readFileSync(packetPath, "utf8")) : undefined,
  packet_latency_ms: Number.isFinite(packetLatencyMs) ? packetLatencyMs : null,
  capture_now_ms: Number.isFinite(captureNowMs) ? captureNowMs : undefined,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.all_passed ? 0 : 2);
