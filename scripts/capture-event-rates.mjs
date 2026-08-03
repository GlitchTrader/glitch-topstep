/**
 * TS-R2-07: measure quote/print/DOM rates and evidence disk growth from live gateway evidence.
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
  const name = trimmed.slice(0, eq);
  if (process.env[name] === undefined) {
    process.env[name] = trimmed.slice(eq + 1);
  }
}

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "config.js")).href);
const {
  buildEventRatesProof,
  buildMinuteBuckets,
  totalsFromRows,
} = await import(pathToFileURL(path.join(ROOT, "dist", "src", "projectx", "event-rates-proof.js")).href);
const { redactSecrets } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "storage", "sqlite-provider-evidence-store.js")).href
);

const config = loadConfig();
const capturedUtc = new Date().toISOString();
const durationMinutes = Number.parseInt(process.env.GLITCH_EVENT_RATES_DURATION_MINUTES ?? "30", 10);
const diskSampleSeconds = Number.parseInt(process.env.GLITCH_EVENT_RATES_DISK_SAMPLE_SECONDS ?? "60", 10);
const baseUrl = `http://${config.localGateway.host}:${config.localGateway.port}`;
const headers = {
  Authorization: `Bearer ${config.localGateway.token}`,
  "Content-Type": "application/json",
};

const dataDir = path.isAbsolute(config.dataDir)
  ? config.dataDir
  : path.join(ROOT, config.dataDir);
const evidencePath = path.join(dataDir, "projectx-evidence.sqlite");
if (!fs.existsSync(evidencePath)) {
  throw new Error(`evidence_db_missing:${evidencePath}`);
}

async function fetchHealth() {
  const response = await fetch(`${baseUrl}/health`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`health_http_${response.status}`);
  }
  return body;
}

function evidenceDbBytes() {
  return fs.statSync(evidencePath).size;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryRetrospectiveWindow(minutes) {
  const db = new DatabaseSync(evidencePath, { readOnly: true });
  try {
    const endRow = db.prepare("SELECT MAX(received_utc) AS t FROM provider_events").get();
    const endUtc = new Date(String(endRow.t)).toISOString();
    const startUtc = new Date(Date.parse(endUtc) - minutes * 60 * 1000).toISOString();
    const totals = db.prepare(`
      SELECT event_type, COUNT(*) AS count
      FROM provider_events
      WHERE source = 'projectx_market_stream'
        AND received_utc >= ?
        AND received_utc <= ?
        AND event_type IN ('quote', 'market_trade', 'depth')
      GROUP BY event_type
    `).all(startUtc, endUtc).map((row) => ({
      event_type: String(row.event_type),
      count: Number(row.count),
    }));
    const minuteRows = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:%M:00Z', received_utc) AS minute_utc,
        event_type,
        COUNT(*) AS count
      FROM provider_events
      WHERE source = 'projectx_market_stream'
        AND received_utc >= ?
        AND received_utc <= ?
        AND event_type IN ('quote', 'market_trade', 'depth')
      GROUP BY minute_utc, event_type
      ORDER BY minute_utc ASC
    `).all(startUtc, endUtc).map((row) => ({
      minute_utc: String(row.minute_utc),
      event_type: String(row.event_type),
      count: Number(row.count),
    }));
    const marketTotalRow = db.prepare(
      "SELECT COUNT(*) AS c FROM provider_events WHERE source = 'projectx_market_stream'",
    ).get();
    return {
      startUtc,
      endUtc,
      totals,
      minuteRows,
      currentMarketEventCount: Number(marketTotalRow?.c ?? 0),
    };
  } finally {
    db.close();
  }
}

const healthStart = await fetchHealth();
const diskBytesStart = evidenceDbBytes();
const eventCountStart = Number(healthStart.provider_evidence?.eventCount ?? 0);
await sleep(Math.max(diskSampleSeconds, 1) * 1000);
const healthEnd = await fetchHealth();
const diskBytesEnd = evidenceDbBytes();
const eventCountEnd = Number(healthEnd.provider_evidence?.eventCount ?? 0);

const retrospective = queryRetrospectiveWindow(
  Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 30,
);
if (healthEnd.gateway_mode !== "armed") {
  throw new Error(`gateway_not_armed:${healthEnd.gateway_mode}`);
}
const providerEvidence = healthEnd.provider_evidence ?? {};
const retentionPolicy = {
  market_event_retention: Number(providerEvidence.marketEventRetention ?? config.providerEvidence.marketEventRetention),
  market_prune_interval: Number(providerEvidence.marketPruneInterval ?? config.providerEvidence.marketPruneInterval),
  maximum_market_events_between_prunes: Number(
    providerEvidence.maximumMarketEventsBetweenPrunes
    ?? (config.providerEvidence.marketEventRetention + config.providerEvidence.marketPruneInterval - 1),
  ),
};

const proof = buildEventRatesProof({
  capturedUtc,
  mode: "retrospective",
  scope: {
    account_id: config.scope.accountId,
    account_name: config.scope.accountName,
    contract_id: config.scope.contractId,
    instrument: config.scope.instrument,
  },
  windowStartUtc: retrospective.startUtc,
  windowEndUtc: retrospective.endUtc,
  durationMinutes,
  retentionPolicy,
  eventTotals: totalsFromRows(retrospective.totals),
  minuteBuckets: buildMinuteBuckets(retrospective.minuteRows),
  diskBytesStart,
  diskBytesEnd,
  eventCountStart,
  eventCountEnd,
  peakMarketEventCount: retrospective.currentMarketEventCount,
});

const sanitized = redactSecrets(proof);
const outPath = path.join(OUT_DIR, "event_rates_proof.json");
fs.writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`);

if (!proof.proof_passed) {
  throw new Error(`event_rates_proof_failed:${proof.proof_failures.join(",")}`);
}

const manifestPath = path.join(OUT_DIR, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files = [
    ...manifest.files.filter((entry) => entry.name !== "event_rates_proof"),
    { name: "event_rates_proof", path: path.relative(ROOT, outPath) },
  ];
  manifest.captured_utc = capturedUtc;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`event_rates_proof_written=${outPath}`);
console.log(
  `rates_per_second quote=${proof.stream_rates_per_second.quote.toFixed(2)} `
  + `print=${proof.stream_rates_per_second.market_trade.toFixed(2)} `
  + `depth=${proof.stream_rates_per_second.depth.toFixed(2)}`,
);
console.log(`disk_delta_bytes=${proof.disk.evidence_db_bytes_delta}`);
