/**
 * Standalone 3-market (MNQ+MES+MCL) SignalR load/latency probe — bypasses the
 * gateway entirely.
 *
 * Subscribes to Quotes+Trades+Depth for all three instruments on ONE market
 * hub connection (mirrors src/projectx/realtime.ts subscribeMarket()), plus
 * the standard user hub subscriptions, with a bare @microsoft/signalr client
 * — no HubRecoveryController, no stream-supervisor, no packet/scanner/SQLite
 * work. While the feeds run, it also:
 *   - samples event-loop lag every 250ms (is *this* process, alone, too busy
 *     to service its own timers under 3-market message volume?)
 *   - pings a lightweight authenticated REST endpoint every 5s and times it
 *     (the direct analog of the gateway's own /packet timeout seen in
 *     production, isolated from all gateway business logic)
 *   - tracks per-contract/per-channel message counts and inter-message gaps
 *
 * Goal: tell whether 3-market data VOLUME alone is enough to stall a bare
 * Node process, or whether the gateway's own extra processing (scanner,
 * packet assembly, SQLite writes) is what's blocking it. If this probe stays
 * fast and reconnect-free, the bottleneck is proven to be gateway-side logic,
 * not hub load or network volume.
 *
 * Read-only: Auth/loginKey, Account/search, Contract/available, and the same
 * Subscribe* hub methods the real client uses. No order, no mutation, no
 * gateway process involved.
 *
 * Usage: node scripts/probe-multimarket-latency-standalone.mjs [durationMinutes]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

const apiUrl = process.env.PROJECTX_API_URL;
const userHubUrl = process.env.PROJECTX_USER_HUB_URL;
const marketHubUrl = process.env.PROJECTX_MARKET_HUB_URL;
const durationMinutes = Number(process.argv[2] ?? "10");
const INSTRUMENT_PATTERNS = { MNQ: /MNQ/i, MES: /MES/i, MCL: /MCL/i };
const EVENT_LOOP_SAMPLE_MS = 250;
const REST_PING_INTERVAL_MS = 5_000;

const outPath = path.join(
  ROOT,
  "docs",
  "evidence",
  `multimarket-latency-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);

const events = [];
function record(event) {
  const entry = { utc: new Date().toISOString(), ...event };
  events.push(entry);
  fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
  if (entry.phase !== "message" && entry.phase !== "event_loop_sample") {
    console.log(JSON.stringify(entry));
  }
}

async function postJson(pathname, body, token) {
  const startedMs = Date.now();
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const latencyMs = Date.now() - startedMs;
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.success === false) {
    throw new Error(`${pathname} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return { payload, latencyMs };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  record({ phase: "start", duration_minutes: durationMinutes, api_url: apiUrl, instruments: Object.keys(INSTRUMENT_PATTERNS) });

  const { payload: login } = await postJson("/api/Auth/loginKey", {
    userName: process.env.PROJECTX_USERNAME,
    apiKey: process.env.PROJECTX_API_KEY,
  });
  const token = login.token;
  record({ phase: "rest_login_ok" });

  const { payload: accounts } = await postJson("/api/Account/search", { onlyActiveAccounts: true }, token);
  const accountId = accounts.accounts?.[0]?.id;

  const { payload: contracts } = await postJson("/api/Contract/available", { live: false }, token);
  const contractIds = {};
  for (const [symbol, pattern] of Object.entries(INSTRUMENT_PATTERNS)) {
    const match = contracts.contracts?.find((c) => pattern.test(c.name ?? c.id ?? ""));
    if (!match) {
      throw new Error(`no_available_contract_matched:${symbol}`);
    }
    contractIds[symbol] = match.id;
  }
  record({ phase: "rest_lookup_ok", accountId, contractIds });

  // --- event-loop lag sampling ---
  const eventLoopLagsMs = [];
  let lastTick = Date.now();
  const eventLoopTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - EVENT_LOOP_SAMPLE_MS;
    lastTick = now;
    eventLoopLagsMs.push(Math.max(0, lag));
    record({ phase: "event_loop_sample", lag_ms: Math.max(0, lag) });
  }, EVENT_LOOP_SAMPLE_MS);

  // --- REST latency under load (analog of the gateway's own /packet timeout) ---
  const restLatenciesMs = [];
  const restPingTimer = setInterval(async () => {
    try {
      const { latencyMs } = await postJson("/api/Account/search", { onlyActiveAccounts: true }, token);
      restLatenciesMs.push(latencyMs);
      record({ phase: "rest_ping", latency_ms: latencyMs });
    } catch (error) {
      record({ phase: "rest_ping_failed", error: String(error?.message ?? error) });
    }
  }, REST_PING_INTERVAL_MS);

  // --- message tracking per contract/channel ---
  const lastMessageAt = {};
  const messageCounts = {};
  const maxGapMs = {};
  function trackMessage(channel, contractId) {
    const key = `${channel}:${contractId}`;
    const now = Date.now();
    messageCounts[key] = (messageCounts[key] ?? 0) + 1;
    if (lastMessageAt[key]) {
      const gap = now - lastMessageAt[key];
      maxGapMs[key] = Math.max(maxGapMs[key] ?? 0, gap);
    }
    lastMessageAt[key] = now;
    record({ phase: "message", channel, contractId });
  }

  const buildConn = (url) =>
    new HubConnectionBuilder()
      .withUrl(url, { accessTokenFactory: () => token, skipNegotiation: true, transport: HttpTransportType.WebSockets })
      .configureLogging(LogLevel.Warning)
      .withAutomaticReconnect([0, 2_000, 10_000, 30_000, 60_000])
      .build();

  const userConn = buildConn(userHubUrl);
  const marketConn = buildConn(marketHubUrl);
  let deliberateStop = false;

  for (const [name, conn] of [["user", userConn], ["market", marketConn]]) {
    conn.onreconnecting((error) => record({ phase: "reconnecting", hub: name, error: error?.message ?? null }));
    conn.onreconnected(() => record({ phase: "reconnected", hub: name }));
    conn.onclose((error) => record({
      phase: deliberateStop ? "closed_deliberate" : "closed_unexpected",
      hub: name,
      error: error?.message ?? null,
    }));
  }

  marketConn.on("GatewayQuote", (contractId) => trackMessage("quote", contractId));
  marketConn.on("GatewayTrade", (contractId) => trackMessage("trade", contractId));
  marketConn.on("GatewayDepth", (contractId) => trackMessage("depth", contractId));

  await userConn.start();
  record({ phase: "connected", hub: "user" });
  await Promise.all([
    userConn.invoke("SubscribeAccounts"),
    userConn.invoke("SubscribeOrders", accountId),
    userConn.invoke("SubscribePositions", accountId),
    userConn.invoke("SubscribeTrades", accountId),
  ]);
  record({ phase: "subscribed", hub: "user" });

  await marketConn.start();
  record({ phase: "connected", hub: "market" });
  const subscribeStartedMs = Date.now();
  await Promise.all(
    Object.values(contractIds).flatMap((contractId) => [
      marketConn.invoke("SubscribeContractQuotes", contractId),
      marketConn.invoke("SubscribeContractTrades", contractId),
      marketConn.invoke("SubscribeContractMarketDepth", contractId),
    ]),
  );
  record({ phase: "subscribed", hub: "market", contracts: 3, channels_per_contract: 3, subscribe_ms: Date.now() - subscribeStartedMs });

  await new Promise((resolve) => setTimeout(resolve, durationMinutes * 60_000));

  deliberateStop = true;
  clearInterval(eventLoopTimer);
  clearInterval(restPingTimer);
  await userConn.stop();
  await marketConn.stop();

  const instabilityEvents = events.filter(
    (e) => e.phase === "reconnecting" || e.phase === "closed_unexpected",
  );

  record({
    phase: "summary",
    total_events: events.length,
    instability_events: instabilityEvents.length,
    event_loop_lag_ms: {
      samples: eventLoopLagsMs.length,
      max: eventLoopLagsMs.length ? Math.max(...eventLoopLagsMs) : null,
      p95: percentile(eventLoopLagsMs, 95),
      avg: eventLoopLagsMs.length ? Math.round(eventLoopLagsMs.reduce((a, b) => a + b, 0) / eventLoopLagsMs.length) : null,
    },
    rest_latency_under_load_ms: {
      samples: restLatenciesMs.length,
      max: restLatenciesMs.length ? Math.max(...restLatenciesMs) : null,
      p95: percentile(restLatenciesMs, 95),
      avg: restLatenciesMs.length ? Math.round(restLatenciesMs.reduce((a, b) => a + b, 0) / restLatenciesMs.length) : null,
    },
    message_counts: messageCounts,
    max_inter_message_gap_ms: maxGapMs,
    verdict: instabilityEvents.length === 0
      ? "stable_3market_no_flapping_without_gateway"
      : "flapping_reproduced_with_3market_load_without_gateway",
  });
  console.log(`\nEvidence written to: ${outPath}`);
}

main().catch((error) => {
  record({ phase: "fatal_error", error: String(error?.message ?? error) });
  process.exitCode = 1;
});
