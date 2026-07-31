/**
 * TS-R2-05: capture live reconnect proof via acceptance stream-gap endpoint.
 * Requires gateway running with GLITCH_ACCEPTANCE_STREAM_GAP=1 in its environment.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "tests", "fixtures", "projectx", "live");

for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "config.js")).href);
const { buildReconnectProof, extractReconnectEvidenceTimeline } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "projectx", "reconnect-proof.js")).href
);
const { redactSecrets } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "storage", "sqlite-provider-evidence-store.js")).href
);

const config = loadConfig();
const capturedUtc = new Date().toISOString();
const baseUrl = `http://${config.localGateway.host}:${config.localGateway.port}`;
const headers = {
  Authorization: `Bearer ${config.localGateway.token}`,
  "Content-Type": "application/json",
};

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`http_${response.status}:${url}:${JSON.stringify(body)}`);
  }
  return body;
}

function loadEvidenceTimeline() {
  const dataDir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.join(ROOT, config.dataDir);
  const evidencePath = path.join(dataDir, "projectx-evidence.sqlite");
  if (!fs.existsSync(evidencePath)) {
    return [];
  }
  const db = new DatabaseSync(evidencePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT sequence, event_type, source, generation, received_utc
      FROM provider_events
      WHERE source IN ('projectx_lifecycle', 'projectx_rest')
      ORDER BY sequence ASC
    `).all();
    return extractReconnectEvidenceTimeline(rows);
  } finally {
    db.close();
  }
}

const gapResult = await fetchJson(`${baseUrl}/acceptance/force-stream-gap`, {
  method: "POST",
  body: "{}",
});

const proof = buildReconnectProof({
  capturedUtc,
  mode: "live_acceptance_gap",
  scope: {
    account_id: config.scope.accountId,
    account_name: config.scope.accountName,
    contract_id: config.scope.contractId,
    instrument: config.scope.instrument,
  },
  phases: gapResult.phases,
  evidenceTimeline: loadEvidenceTimeline(),
});

const sanitized = redactSecrets(proof);
const outPath = path.join(OUT_DIR, "reconnect_proof.json");
fs.writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`);

if (!proof.proof_passed) {
  throw new Error(`reconnect_proof_failed:${proof.proof_failures.join(",")}`);
}

const manifestPath = path.join(OUT_DIR, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files = [
    ...manifest.files.filter((entry) => entry.name !== "reconnect_proof"),
    { name: "reconnect_proof", path: path.relative(ROOT, outPath) },
  ];
  manifest.captured_utc = capturedUtc;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`reconnect_proof_written=${outPath}`);
console.log(`generation_bump=${proof.phases[0]?.operational_generation}->${proof.phases[1]?.operational_generation}`);
