/**
 * Standalone SQLite evidence-store write-load probe — no network, no ProjectX,
 * no SignalR. Isolates a single remaining variable: does the gateway's own
 * synchronous evidence-store write path (recordAndApply -> append()) stall
 * the event loop under 3-instrument message rates, independent of anything
 * else the gateway does?
 *
 * Context: two prior standalone probes (PR #303, #304) proved a bare hub
 * connection is stable, and that a naive fs.appendFileSync-per-message probe
 * reproduced a ~63s process freeze correlated 1:1 with the two "reconnecting"
 * events seen live. The real gateway does the structural equivalent on every
 * single market tick: realtime.ts recordAndApply() -> provider-event-
 * recorder.ts recordProviderEventBeforeApply() -> SqliteProviderEvidenceStore
 * .append(), which is 1-2 synchronous node:sqlite statements per event, PLUS
 * a periodic bulk DELETE (pruneMarketEvents) every marketPruneInterval
 * (default 10,000) market events once marketEventRetention (default 500,000)
 * is exceeded. The real data/projectx-evidence.sqlite already sits at
 * ~505,000 market rows -- i.e. pruning is firing on essentially every
 * 10,000-event boundary in production right now.
 *
 * This script uses the REAL, compiled SqliteProviderEvidenceStore class
 * (dist/src/storage/sqlite-provider-evidence-store.js) against a disposable
 * COPY of the real evidence database (never the live file -- the running
 * gateway, if any, is never touched), feeds it synthetic quote/trade/depth
 * events for 3 fake contracts at the same combined rate observed in today's
 * live 3-market probe (~69 events/sec), and times every single append() call
 * directly (plus event-loop lag as a cross-check), so a prune-triggered
 * stall shows up as an exact, attributable spike -- not an inference.
 *
 * Usage: node scripts/probe-sqlite-evidence-write-load.mjs [durationMinutes]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DB = path.join(ROOT, "data", "projectx-evidence.sqlite");
const COPY_DB = path.join(ROOT, "data", `_diag-evidence-copy-${Date.now()}.sqlite`);
const durationMinutes = Number(process.argv[2] ?? "10");

// Matches the combined rate observed in docs/evidence/multimarket-latency-probe-*:
// ~41,143 messages / 600s ~= 68.6/s across quote+trade+depth x {MNQ,MES,MCL}.
const EVENTS_PER_SECOND = 69;
const CONTRACTS = ["DIAG.MNQ", "DIAG.MES", "DIAG.MCL"];
const EVENT_TYPES = ["quote", "quote", "depth", "depth", "trade"]; // roughly matches observed quote/depth/trade ratio

const outPath = path.join(
  ROOT,
  "docs",
  "evidence",
  `sqlite-evidence-write-load-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
const events = [];
function record(entry) {
  const full = { utc: new Date().toISOString(), ...entry };
  events.push(full);
  fs.appendFileSync(outPath, JSON.stringify(full) + "\n");
  if (full.phase !== "append_timing" && full.phase !== "event_loop_sample") {
    console.log(JSON.stringify(full));
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const hasRealDb = fs.existsSync(REAL_DB);
  if (hasRealDb) {
    fs.copyFileSync(REAL_DB, COPY_DB);
    // WAL/SHM aren't required for a cold-open copy; a fresh connection will
    // recover/ignore them. We deliberately do NOT copy -wal/-shm to avoid any
    // chance of touching the live gateway's in-flight write-ahead state.
    record({ phase: "copied_real_db", source: REAL_DB, copy: COPY_DB, source_size_bytes: fs.statSync(REAL_DB).size });
  } else {
    record({ phase: "no_real_db_found_using_fresh_db", path: COPY_DB });
  }

  const { SqliteProviderEvidenceStore } = await import(
    pathToFileURL(path.join(ROOT, "dist", "src", "storage", "sqlite-provider-evidence-store.js")).href
  );
  const { DatabaseSync } = await import("node:sqlite");

  const inspectDb = new DatabaseSync(hasRealDb ? COPY_DB : COPY_DB, { readOnly: hasRealDb });
  let startingMarketRows = 0;
  try {
    startingMarketRows = inspectDb
      .prepare("SELECT COUNT(*) as c FROM provider_events WHERE source = 'projectx_market_stream'")
      .get().c;
  } catch {
    startingMarketRows = 0;
  }
  inspectDb.close();
  record({
    phase: "starting_state",
    starting_market_rows: startingMarketRows,
    default_market_event_retention: 500_000,
    default_market_prune_interval: 10_000,
    rows_until_next_prune_boundary: 10_000 - (startingMarketRows % 10_000),
  });

  const constructStartedMs = Date.now();
  const store = new SqliteProviderEvidenceStore(COPY_DB);
  record({ phase: "store_construct_timing", latency_ms: Date.now() - constructStartedMs, note: "includes migrate() and the constructor's own initial pruneMarketEvents() call" });

  const appendLatenciesMs = [];
  const eventLoopLagsMs = [];
  let lastTick = Date.now();
  const eventLoopTimer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lastTick - 250);
    lastTick = now;
    eventLoopLagsMs.push(lag);
    record({ phase: "event_loop_sample", lag_ms: lag });
  }, 250);

  const totalEvents = durationMinutes * 60 * EVENTS_PER_SECOND;
  const intervalMs = 1000 / EVENTS_PER_SECOND;
  let generation = 0;
  let appended = 0;

  record({ phase: "load_start", target_total_events: totalEvents, events_per_second: EVENTS_PER_SECOND, duration_minutes: durationMinutes });

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (appended >= totalEvents) {
        clearInterval(timer);
        resolve();
        return;
      }
      const contractId = CONTRACTS[appended % CONTRACTS.length];
      const eventType = EVENT_TYPES[appended % EVENT_TYPES.length];
      const receivedUtc = new Date().toISOString();
      const startedMs = Date.now();
      try {
        store.append({
          receivedUtc,
          providerTimestampUtc: receivedUtc,
          source: "projectx_market_stream",
          eventType,
          generation,
          accountId: null,
          contractId,
          providerEntityId: contractId,
          relatedProviderEntityId: null,
          rawPayload: { synthetic: true, seq: appended, contractId, eventType },
          normalizedPayload: { synthetic: true, seq: appended, contractId, eventType },
        });
      } catch (error) {
        record({ phase: "append_error", error: String(error?.message ?? error) });
      }
      const latencyMs = Date.now() - startedMs;
      appendLatenciesMs.push(latencyMs);
      if (latencyMs > 200) {
        record({ phase: "append_slow", latency_ms: latencyMs, seq: appended, market_row_boundary: appended % 10_000 });
      } else {
        record({ phase: "append_timing", latency_ms: latencyMs });
      }
      appended += 1;
    }, intervalMs);
  });

  clearInterval(eventLoopTimer);
  store.close();

  const finalDb = new DatabaseSync(COPY_DB, { readOnly: true });
  const finalMarketRows = finalDb
    .prepare("SELECT COUNT(*) as c FROM provider_events WHERE source = 'projectx_market_stream'")
    .get().c;
  finalDb.close();

  record({
    phase: "summary",
    appended_events: appended,
    starting_market_rows: startingMarketRows,
    final_market_rows: finalMarketRows,
    append_latency_ms: {
      max: appendLatenciesMs.length ? Math.max(...appendLatenciesMs) : null,
      p95: percentile(appendLatenciesMs, 95),
      p50: percentile(appendLatenciesMs, 50),
      avg: appendLatenciesMs.length ? Math.round(appendLatenciesMs.reduce((a, b) => a + b, 0) / appendLatenciesMs.length) : null,
      slow_over_200ms_count: appendLatenciesMs.filter((v) => v > 200).length,
      slow_over_1000ms_count: appendLatenciesMs.filter((v) => v > 1000).length,
    },
    event_loop_lag_ms: {
      max: eventLoopLagsMs.length ? Math.max(...eventLoopLagsMs) : null,
      p95: percentile(eventLoopLagsMs, 95),
      avg: eventLoopLagsMs.length ? Math.round(eventLoopLagsMs.reduce((a, b) => a + b, 0) / eventLoopLagsMs.length) : null,
    },
    verdict: appendLatenciesMs.some((v) => v > 1000)
      ? "sqlite_write_path_stalls_confirmed"
      : "sqlite_write_path_no_stall_observed",
    diag_db_copy_path: COPY_DB,
    note: "diag_db_copy_path is a disposable copy for this test only; safe to delete, never the live gateway's database.",
  });
  console.log(`\nEvidence written to: ${outPath}`);
  console.log(`Disposable DB copy at: ${COPY_DB} (safe to delete)`);
}

main().catch((error) => {
  record({ phase: "fatal_error", error: String(error?.message ?? error) });
  process.exitCode = 1;
});
