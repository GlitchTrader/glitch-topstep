import { parentPort } from "node:worker_threads";
import { DurableControlStore } from "../control/durable-control-store.js";
import { ProjectXOrderOwnershipService } from "../ownership/projectx-order-ownership.js";
import { SqliteExecutionStore } from "./sqlite-execution-store.js";
import { SqliteOutcomeFeed } from "./sqlite-outcome-feed.js";
import { SqliteProviderEvidenceStore } from "./sqlite-provider-evidence-store.js";
import type { SqlitePersistencePaths } from "./sqlite-persistence.js";

/**
 * Owns every gateway DatabaseSync. The main thread only posts messages here.
 * Handlers stay synchronous so one SQLite call finishes before the next message.
 */

if (parentPort === null) {
  throw new Error("sqlite_worker_requires_parent_port");
}

const port = parentPort;

let execution: SqliteExecutionStore | null = null;
let control: DurableControlStore | null = null;
let outcome: SqliteOutcomeFeed | null = null;
let evidence: SqliteProviderEvidenceStore | null = null;
let ownership: ProjectXOrderOwnershipService | null = null;

function caches(): unknown {
  return {
    execution: execution === null ? null : {
      recovery: execution.peekRecoveryStatus(),
      recoveryStale: execution.isRecoveryCacheStale(),
      unprotectedSince: execution.peekUnprotectedSinceUtc(),
      unprotectedSinceStale: execution.isUnprotectedSinceCacheStale(),
      facts: execution.peekExecutionFactsStatus(),
      factsWarmed: execution.isExecutionFactsCacheWarmed(),
      factsStale: execution.isExecutionFactsCacheStale(),
      writeLatency: execution.writeLatencyMetrics(),
    },
    control: control === null ? null : {
      status: control.peekStatus(),
      pendingFlatten: control.peekHasPendingFlatten(),
      oldestPendingFlattenCreatedUtc: oldestFlattenUtc(control),
      warmed: control.isHealthCacheWarmed(),
      stale: control.isHealthCacheStale(),
      writeLatency: control.writeLatencyMetrics(),
    },
    outcome: outcome === null ? null : {
      status: outcome.peekStatus(),
      warmed: outcome.isHealthCacheWarmed(),
      stale: outcome.isHealthCacheStale(),
      writeLatency: outcome.writeLatencyMetrics(),
    },
    evidence: evidence === null ? null : {
      status: evidence.peekStatus(),
      warmed: evidence.isHealthCacheWarmed(),
      stale: evidence.isHealthCacheStale(),
    },
  };
}

function oldestFlattenUtc(store: DurableControlStore): string | null {
  const now = Date.now();
  const age = store.peekOldestPendingFlattenAgeMs(now);
  if (age === null) {
    return null;
  }
  return new Date(now - age).toISOString();
}

function stores(): Record<string, object> {
  return {
    ...(execution ? { execution } : {}),
    ...(control ? { control } : {}),
    ...(outcome ? { outcome } : {}),
    ...(evidence ? { evidence } : {}),
    ...(ownership ? { ownership } : {}),
  };
}

function open(paths: SqlitePersistencePaths): void {
  execution = new SqliteExecutionStore(paths.execution);
  control = new DurableControlStore(paths.control);
  outcome = new SqliteOutcomeFeed(paths.outcome);
  evidence = new SqliteProviderEvidenceStore(paths.evidence, paths.evidenceOptions ?? {});
  if (paths.ownership) {
    ownership = new ProjectXOrderOwnershipService(paths.execution, paths.evidence, paths.ownership);
  }
}

function closeAll(): void {
  for (const store of [ownership, evidence, outcome, control, execution]) {
    try {
      store?.close();
    } catch {
      // A store closed on its own during shutdown is already done.
    }
  }
  ownership = null;
  evidence = null;
  outcome = null;
  control = null;
  execution = null;
}

port.on("message", (message: {
  id: number;
  op: string;
  paths?: SqlitePersistencePaths;
  store?: string;
  method?: string;
  args?: unknown[];
  ms?: number;
}) => {
  try {
    if (message.op === "init") {
      if (!message.paths) {
        throw new Error("sqlite_worker_init_paths_required");
      }
      open(message.paths);
      port.postMessage({ id: message.id, ok: true, result: null, caches: caches() });
      return;
    }
    if (message.op === "delay") {
      const ms = message.ms ?? 0;
      const slot = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(slot, 0, 0, ms);
      port.postMessage({ id: message.id, ok: true, result: null, caches: caches() });
      return;
    }
    if (message.op === "close") {
      closeAll();
      port.postMessage({ id: message.id, ok: true, result: null, caches: null });
      return;
    }
    if (message.op === "call") {
      const storeName = message.store ?? "";
      const method = message.method ?? "";
      const target = stores()[storeName] as Record<string, (...args: unknown[]) => unknown> | undefined;
      const fn = target?.[method];
      if (!fn) {
        throw new Error(`sqlite_worker_unknown_call:${storeName}.${method}`);
      }
      const result = fn.apply(target, message.args ?? []);
      port.postMessage({ id: message.id, ok: true, result, caches: caches() });
      return;
    }
    throw new Error(`sqlite_worker_unknown_op:${message.op}`);
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});
