import { Worker } from "node:worker_threads";
import type { DurableControlStore } from "../control/durable-control-store.js";
import type { ProjectXOrderOwnershipService } from "../ownership/projectx-order-ownership.js";
import type { MayPromise } from "./may-promise.js";
import type { SqliteExecutionStore } from "./sqlite-execution-store.js";
import type { SqliteOutcomeFeed } from "./sqlite-outcome-feed.js";
import type { SqliteProviderEvidenceStore } from "./sqlite-provider-evidence-store.js";
import type { SqliteWriteLatencyMetrics } from "./sqlite-write-latency.js";
import type { ProviderEvidenceStatus } from "../domain/provider-evidence.js";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";

export interface SqlitePersistenceOwnership {
  accountId: number;
  accountName: string;
  contractId: string;
  instrument: string;
}

export interface SqlitePersistencePaths {
  execution: string;
  evidence: string;
  control: string;
  outcome: string;
  evidenceOptions?: {
    marketEventRetention?: number;
    marketPruneInterval?: number;
  };
  ownership: SqlitePersistenceOwnership | null;
}

interface WorkerSuccess {
  id: number;
  ok: true;
  result: unknown;
  caches: CacheSnapshot | null;
}

interface WorkerFailure {
  id: number;
  ok: false;
  error: string;
}

interface CacheSnapshot {
  execution: {
    recovery: ExecutionRecoveryStatus | null;
    recoveryStale: boolean;
    unprotectedSince: string | null;
    unprotectedSinceStale: boolean;
    facts: { live: number; superseded: number; high_water_sequence: number } | null;
    factsWarmed: boolean;
    factsStale: boolean;
    writeLatency: SqliteWriteLatencyMetrics;
  } | null;
  control: {
    status: ReturnType<DurableControlStore["peekStatus"]>;
    pendingFlatten: boolean;
    oldestPendingFlattenCreatedUtc: string | null;
    warmed: boolean;
    stale: boolean;
    writeLatency: SqliteWriteLatencyMetrics;
  } | null;
  outcome: {
    status: ReturnType<SqliteOutcomeFeed["peekStatus"]>;
    warmed: boolean;
    stale: boolean;
    writeLatency: SqliteWriteLatencyMetrics;
  } | null;
  evidence: {
    status: ProviderEvidenceStatus;
    warmed: boolean;
    stale: boolean;
  } | null;
}

const ZERO_LATENCY: SqliteWriteLatencyMetrics = {
  last_write_latency_ms: 0,
  max_write_latency_ms: 0,
  write_count: 0,
};

/**
 * Main-thread handle for the persistence worker.
 * Health peeks read `caches` in this process. Every prepare/run/get/all/exec stays in the worker.
 */
export class SqlitePersistence {
  private readonly worker: Worker;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private seq = 0;
  private closed = false;
  private readonly ready: Promise<void>;
  readonly caches: CacheSnapshot = {
    execution: null,
    control: null,
    outcome: null,
    evidence: null,
  };
  readonly execution: MayPromise<SqliteExecutionStore>;
  readonly control: MayPromise<DurableControlStore>;
  readonly outcome: MayPromise<SqliteOutcomeFeed>;
  readonly evidence: MayPromise<SqliteProviderEvidenceStore>;
  readonly ownership: MayPromise<ProjectXOrderOwnershipService> | null;

  public constructor(paths: SqlitePersistencePaths) {
    this.worker = new Worker(new URL("./sqlite-worker.js", import.meta.url));
    this.worker.on("message", (message: WorkerSuccess | WorkerFailure) => {
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(message.id);
      if (!message.ok) {
        waiter.reject(new Error(message.error));
        return;
      }
      if (message.caches) {
        this.caches.execution = message.caches.execution;
        this.caches.control = message.caches.control;
        this.caches.outcome = message.caches.outcome;
        this.caches.evidence = message.caches.evidence;
      }
      waiter.resolve(message.result);
    });
    this.worker.on("error", (error) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    });
    this.execution = facade(this, "execution");
    this.control = facade(this, "control");
    this.outcome = facade(this, "outcome");
    this.evidence = facade(this, "evidence");
    this.ownership = paths.ownership ? facade(this, "ownership") : null;
    this.ready = this.send({ op: "init", paths }).then(() => undefined);
  }

  public whenReady(): Promise<void> {
    return this.ready;
  }

  /** Test hook: block the worker without touching the main thread. */
  public delay(ms: number): Promise<void> {
    return this.send({ op: "delay", ms }).then(() => undefined);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.ready;
      await this.send({ op: "close" });
    } finally {
      await this.worker.terminate();
    }
  }

  public call(store: string, method: string, args: unknown[]): Promise<unknown> {
    return this.ready.then(() => this.send({ op: "call", store, method, args }));
  }

  private send(message: Record<string, unknown>): Promise<unknown> {
    if (this.closed && message.op !== "close") {
      return Promise.reject(new Error("sqlite_persistence_closed"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }
}

const LOCAL: Record<string, (persistence: SqlitePersistence, args: unknown[]) => unknown> = {
  "execution.peekRecoveryStatus": (persistence) => persistence.caches.execution?.recovery ?? null,
  "execution.isRecoveryCacheStale": (persistence) => persistence.caches.execution?.recoveryStale ?? true,
  "execution.peekUnprotectedSinceUtc": (persistence) => persistence.caches.execution?.unprotectedSince ?? null,
  "execution.isUnprotectedSinceCacheStale": (persistence) =>
    persistence.caches.execution?.unprotectedSinceStale ?? true,
  "execution.peekExecutionFactsStatus": (persistence) => persistence.caches.execution?.facts ?? null,
  "execution.isExecutionFactsCacheWarmed": (persistence) => persistence.caches.execution?.factsWarmed ?? false,
  "execution.isExecutionFactsCacheStale": (persistence) => persistence.caches.execution?.factsStale ?? true,
  "execution.writeLatencyMetrics": (persistence) => persistence.caches.execution?.writeLatency ?? ZERO_LATENCY,
  "control.peekStatus": (persistence) => persistence.caches.control?.status ?? {
    pending: 0,
    applying: 0,
    completed: 0,
    rejected: 0,
    failed: 0,
  },
  "control.peekHasPendingFlatten": (persistence) => persistence.caches.control?.pendingFlatten ?? false,
  "control.peekOldestPendingFlattenAgeMs": (persistence, args) => {
    const oldest = persistence.caches.control?.oldestPendingFlattenCreatedUtc;
    if (!oldest) {
      return null;
    }
    const now = typeof args[0] === "number" ? args[0] : Date.now();
    return Math.max(0, now - Date.parse(oldest));
  },
  "control.isHealthCacheWarmed": (persistence) => persistence.caches.control?.warmed ?? false,
  "control.isHealthCacheStale": (persistence) => persistence.caches.control?.stale ?? true,
  "control.writeLatencyMetrics": (persistence) => persistence.caches.control?.writeLatency ?? ZERO_LATENCY,
  "outcome.peekStatus": (persistence) => persistence.caches.outcome?.status ?? {
    current_count: 0,
    revision_count: 0,
    high_water_sequence: 0,
    integrity: "ok",
    integrity_error: null,
  },
  "outcome.isHealthCacheWarmed": (persistence) => persistence.caches.outcome?.warmed ?? false,
  "outcome.isHealthCacheStale": (persistence) => persistence.caches.outcome?.stale ?? true,
  "outcome.writeLatencyMetrics": (persistence) => persistence.caches.outcome?.writeLatency ?? ZERO_LATENCY,
  "evidence.peekStatus": (persistence) => persistence.caches.evidence?.status ?? emptyEvidenceStatus(),
  "evidence.isHealthCacheWarmed": (persistence) => persistence.caches.evidence?.warmed ?? false,
  "evidence.isHealthCacheStale": (persistence) => persistence.caches.evidence?.stale ?? true,
};

function emptyEvidenceStatus(): ProviderEvidenceStatus {
  return {
    eventCount: 0,
    marketEventCount: 0,
    earliestSequence: null,
    latestSequence: null,
    latestReceivedUtc: null,
    marketEventRetention: 0,
    marketPruneInterval: 0,
    maximumMarketEventsBetweenPrunes: 0,
  };
}

function facade<T>(persistence: SqlitePersistence, store: string): MayPromise<T> {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }
      const local = LOCAL[`${store}.${property}`];
      if (local) {
        return (...args: unknown[]) => local(persistence, args);
      }
      return (...args: unknown[]) => persistence.call(store, property, args);
    },
  }) as MayPromise<T>;
}
