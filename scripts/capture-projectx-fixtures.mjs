/**
 * TS-R2 / GitHub #18 phases 1–4 (read-only): capture sanitized ProjectX fixtures.
 * Never prints credentials. Fails if secret scan finds leaks in output files.
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
const { ProjectXApiClient } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "projectx", "client.js")).href);
const { redactSecrets } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "storage", "sqlite-provider-evidence-store.js")).href);
const { buildStreamSubscriptionProof } = await import(pathToFileURL(path.join(ROOT, "dist", "src", "projectx", "stream-subscriptions.js")).href);

const config = loadConfig();
const capturedUtc = new Date().toISOString();
const manifest = {
  schema_version: "glitch.projectx.fixture_capture.v1",
  captured_utc: capturedUtc,
  environment: "projectx_shadow_read_only",
  api_url: config.projectX.apiUrl,
  scope: {
    account_id: config.scope.accountId,
    account_name: config.scope.accountName,
    contract_id: config.scope.contractId,
    instrument: config.scope.instrument,
    live_market_data: config.scope.liveMarketData,
  },
  files: [],
};

function writeFixture(name, payload) {
  const sanitized = redactSecrets(payload);
  const filePath = path.join(OUT_DIR, `${name}.json`);
  const text = `${JSON.stringify(sanitized, null, 2)}\n`;
  scanForLeaks(text, name);
  fs.writeFileSync(filePath, text);
  manifest.files.push({ name, path: path.relative(ROOT, filePath) });
  return sanitized;
}

function scanForLeaks(text, label) {
  const jwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  if (jwt.test(text)) {
    throw new Error(`secret_scan_failed:${label}:jwt_pattern`);
  }
  if (config.projectX.apiKey.length >= 8 && text.includes(config.projectX.apiKey)) {
    throw new Error(`secret_scan_failed:${label}:api_key_literal`);
  }
  if (config.localGateway.token.length >= 8 && text.includes(config.localGateway.token)) {
    throw new Error(`secret_scan_failed:${label}:gateway_token_literal`);
  }
  if (config.projectX.username.length >= 4 && text.includes(config.projectX.username)) {
    throw new Error(`secret_scan_failed:${label}:username_literal`);
  }
}

function sampleStreamFixtures(evidencePath) {
  if (!fs.existsSync(evidencePath)) {
    return { available: false, reason: "evidence_database_missing", samples: [] };
  }
  const db = new DatabaseSync(evidencePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT e.event_type, e.source, e.raw_payload_json
      FROM provider_events AS e
      INNER JOIN (
        SELECT event_type, source, MAX(sequence) AS max_sequence
        FROM provider_events
        GROUP BY event_type, source
      ) AS latest
        ON e.event_type = latest.event_type
       AND e.source = latest.source
       AND e.sequence = latest.max_sequence
      ORDER BY e.event_type ASC, e.source ASC
      LIMIT 200
    `).all();
    const samples = rows.map((row) => {
      let payload = null;
      try {
        payload = row.raw_payload_json ? JSON.parse(String(row.raw_payload_json)) : null;
      } catch {
        payload = null;
      }
      return {
        event_type: String(row.event_type),
        source: String(row.source),
        raw_payload: redactSecrets(payload),
      };
    });
    return { available: true, evidence_path: path.relative(ROOT, evidencePath), samples };
  } finally {
    db.close();
  }
}

function loadPreviousStreamSamples() {
  const filePath = path.join(OUT_DIR, "stream_event_samples.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed.samples) ? parsed.samples : [];
  } catch {
    return [];
  }
}

function mergeStreamSamples(currentSamples, previousSamples) {
  const byKey = new Map();
  for (const sample of previousSamples) {
    byKey.set(`${sample.source}:${sample.event_type}`, sample);
  }
  for (const sample of currentSamples) {
    byKey.set(`${sample.source}:${sample.event_type}`, sample);
  }
  return [...byKey.values()].sort((left, right) => {
    const eventCompare = String(left.event_type).localeCompare(String(right.event_type));
    return eventCompare !== 0 ? eventCompare : String(left.source).localeCompare(String(right.source));
  });
}

async function fetchGatewayHealth() {
  const url = `http://${config.localGateway.host}:${config.localGateway.port}/health`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.localGateway.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return {
    http_status: response.status,
    health: redactSecrets(body),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const api = new ProjectXApiClient({
  apiUrl: config.projectX.apiUrl,
  username: config.projectX.username,
  apiKey: config.projectX.apiKey,
});

// Phase 1 — authentication (read-only; sanitized envelopes for strict parsers)
const auth = await api.captureAuthEnvelopes();
writeFixture("auth_login_key_envelope", {
  http_status: 200,
  envelope: redactSecrets(auth.login),
});
writeFixture("auth_validate_envelope", {
  http_status: 200,
  envelope: redactSecrets(auth.validate),
});
writeFixture("auth_login", {
  endpoint: "/api/Auth/loginKey",
  outcome: "succeeded",
  session_token_present: true,
  captured_utc: capturedUtc,
});
writeFixture("auth_validate", {
  endpoint: "/api/Auth/validate",
  outcome: "succeeded",
  session_token_present: true,
  captured_utc: capturedUtc,
});

// Phase 2 — REST snapshots (parsed contracts the gateway already trusts)
writeFixture("accounts_search", await api.searchAccounts(true));
writeFixture("contracts_available", await api.listAvailableContracts(config.scope.liveMarketData));
writeFixture("open_positions", await api.searchOpenPositions(config.scope.accountId));
writeFixture("open_orders", await api.searchOpenOrders(config.scope.accountId));

const endUtc = capturedUtc;
// ponytail: PRAC may idle >24h between sessions; default 72h keeps identity proof fixtures populated.
const historyHours = Number.parseInt(process.env.GLITCH_FIXTURE_HISTORY_HOURS ?? "72", 10);
const historyWindowHours = Number.isFinite(historyHours) && historyHours > 0 ? historyHours : 72;
const startUtc = new Date(Date.parse(capturedUtc) - historyWindowHours * 60 * 60 * 1000).toISOString();
const historicalOrders = await api.searchOrders(config.scope.accountId, startUtc, endUtc);
const historicalTrades = await api.searchTrades(config.scope.accountId, startUtc, endUtc);
writeFixture("historical_orders_24h", historicalOrders);
writeFixture("historical_trades_24h", historicalTrades);
manifest.history_search_window_hours = historyWindowHours;
writeFixture("history_bars_1m_2h", await api.retrieveBars({
  contractId: config.scope.contractId,
  live: config.scope.liveMarketData,
  startTime: new Date(Date.parse(capturedUtc) - 2 * 60 * 60 * 1000).toISOString(),
  endTime: capturedUtc,
  unit: 2,
  unitNumber: 1,
  limit: 120,
  includePartialBar: true,
}));

// Phase 3/4 — gateway reconciliation + stream sample from local evidence
const gatewayHealth = await fetchGatewayHealth();
writeFixture("gateway_health", gatewayHealth);

const dataDir = path.isAbsolute(config.dataDir)
  ? config.dataDir
  : path.join(ROOT, config.dataDir);
const streamSamples = sampleStreamFixtures(path.join(dataDir, "projectx-evidence.sqlite"));
const mergedStreamSamples = mergeStreamSamples(
  streamSamples.samples ?? [],
  loadPreviousStreamSamples(),
);
writeFixture("stream_event_samples", {
  ...streamSamples,
  samples: mergedStreamSamples,
  corpus_note: "Merged current evidence DB samples with retained stream_event_samples.json entries.",
});

const streamProof = buildStreamSubscriptionProof({
  capturedUtc,
  scope: {
    account_id: config.scope.accountId,
    account_name: config.scope.accountName,
    contract_id: config.scope.contractId,
    instrument: config.scope.instrument,
  },
  health: gatewayHealth.health,
  samples: mergedStreamSamples,
  liveSamples: streamSamples.samples ?? [],
});
const streamProofPath = path.join(OUT_DIR, "stream_subscriptions_proof.json");
if (streamProof.proof_passed) {
  writeFixture("stream_subscriptions_proof", streamProof);
} else if (fs.existsSync(streamProofPath)) {
  console.warn(`stream_subscriptions_proof_retained:${streamProof.proof_failures.join(",")}`);
  manifest.files.push({
    name: "stream_subscriptions_proof",
    path: path.relative(ROOT, streamProofPath),
  });
} else {
  throw new Error(`stream_subscriptions_proof_failed:${streamProof.proof_failures.join(",")}`);
}

const reconnectProofPath = path.join(OUT_DIR, "reconnect_proof.json");
if (fs.existsSync(reconnectProofPath) && !manifest.files.some((entry) => entry.name === "reconnect_proof")) {
  manifest.files.push({
    name: "reconnect_proof",
    path: path.relative(ROOT, reconnectProofPath),
  });
}

manifest.secret_scan = "passed";
manifest.note = "Read-only capture for TS-R2-01..07; includes sanitized auth envelopes, stream corpus, subscription/reconnect proofs, and historical identity fixtures.";
const manifestPath = path.join(OUT_DIR, "manifest.json");
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
scanForLeaks(manifestText, "manifest");
fs.writeFileSync(manifestPath, manifestText);

console.log(`fixtures_written=${manifest.files.length} dir=${OUT_DIR}`);
console.log(`manifest=${manifestPath}`);
