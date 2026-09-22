/**
 * Standalone ProjectX SignalR hub stability probe — bypasses the gateway entirely.
 *
 * Connects directly to PROJECTX_USER_HUB_URL / PROJECTX_MARKET_HUB_URL with a
 * bare @microsoft/signalr client (no HubRecoveryController, no stream-supervisor
 * liveness/restart logic, no ProjectXRealtimeClient). Logs raw connection
 * lifecycle events for a fixed duration so we can tell whether hub flapping is
 * coming from ProjectX's own infrastructure or from our reconnect/liveness code.
 *
 * Read-only: only calls Auth/loginKey, Account/search, Contract/available, and
 * hub Subscribe* methods (same subscriptions the real client makes). No order,
 * no mutation, no gateway process touched.
 *
 * Usage: node scripts/probe-signalr-hubs-standalone.mjs [durationMinutes]
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
const outPath = path.join(
  ROOT,
  "docs",
  "evidence",
  `signalr-standalone-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);

const events = [];
function record(event) {
  const entry = { utc: new Date().toISOString(), ...event };
  events.push(entry);
  console.log(JSON.stringify(entry));
  fs.appendFileSync(outPath, JSON.stringify(entry) + "\n");
}

async function postJson(pathname, body, token) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.success === false) {
    throw new Error(`${pathname} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return payload;
}

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  record({ phase: "start", duration_minutes: durationMinutes, api_url: apiUrl });

  const login = await postJson("/api/Auth/loginKey", {
    userName: process.env.PROJECTX_USERNAME,
    apiKey: process.env.PROJECTX_API_KEY,
  });
  const token = login.token;
  record({ phase: "rest_login_ok" });

  const accounts = await postJson("/api/Account/search", { onlyActiveAccounts: true }, token);
  const accountId = accounts.accounts?.[0]?.id;
  const contracts = await postJson("/api/Contract/available", { live: false }, token);
  const contract = contracts.contracts?.find((c) => /MNQ/i.test(c.name ?? c.id ?? "")) ?? contracts.contracts?.[0];
  record({ phase: "rest_lookup_ok", accountId, contractId: contract?.id });

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
  if (contract?.id) {
    await Promise.all([
      marketConn.invoke("SubscribeContractQuotes", contract.id),
      marketConn.invoke("SubscribeContractTrades", contract.id),
    ]);
    record({ phase: "subscribed", hub: "market" });
  }

  await new Promise((resolve) => setTimeout(resolve, durationMinutes * 60_000));

  deliberateStop = true;
  await userConn.stop();
  await marketConn.stop();

  // Only reconnecting/reconnected and closed_unexpected count as instability;
  // closed_deliberate is our own end-of-probe shutdown, not a hub drop.
  const instabilityEvents = events.filter(
    (e) => e.phase === "reconnecting" || e.phase === "closed_unexpected",
  );
  record({
    phase: "summary",
    total_events: events.length,
    instability_events: instabilityEvents.length,
    verdict: instabilityEvents.length === 0
      ? "stable_standalone_no_flapping_without_gateway"
      : "flapping_reproduced_without_gateway",
  });
  console.log(`\nEvidence written to: ${outPath}`);
}

main().catch((error) => {
  record({ phase: "fatal_error", error: String(error?.message ?? error) });
  process.exitCode = 1;
});
