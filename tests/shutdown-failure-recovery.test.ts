/**
 * TS-REAUDIT-08: proves the actual composition AppService.stopSerial() relies on -- not just
 * requiresShutdownRetention()'s boolean in isolation -- using a REAL file-based RuntimeScopeLock
 * so "the lock is retained" is verified by a second lock genuinely failing to acquire, the same
 * way a second process instance would fail after a critical-disposer shutdown failure.
 *
 * This is not a full AppService end-to-end test (AppService has no test harness anywhere in this
 * repo -- constructing one would require faking ProjectX auth, SignalR, and an HTTP listener).
 * It is the composition-level proof that IS feasible without that: the same
 * runShutdownFailureRecovery() function AppService.stopSerial() actually calls, driven with a
 * real lock and a closeStores callback that really releases it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runShutdownFailureRecovery } from "../src/service/lifecycle-supervisor.js";
import { RuntimeScopeLock } from "../src/service/runtime-lock.js";

describe("shutdown failure recovery, composed with a real runtime lock (TS-REAUDIT-08)", () => {
  it("a critical disposer failure with an EMPTY backlog still retains the lock and stores", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-shutdown-critical-"));
    try {
      const lock = new RuntimeScopeLock(directory, 101);
      await lock.acquire();

      let storesClosed = false;
      const networkHandlesClosed: string[] = [];

      const outcome = await runShutdownFailureRecovery({
        criticalFailedDisposers: ["realtime"], // the exact failure mode this ticket is about
        backlogPending: false, // this is the specific gap: empty backlog alone used to be enough
        closeStores: async () => {
          storesClosed = true;
          await lock.release(); // mirrors AppService.closeStores() releasing the lock at the end
        },
        retainNetworkHandles: (disposers) => {
          networkHandlesClosed.push(...disposers, "gateway", "realtime_ref", "packets");
        },
      });

      assert.equal(outcome, "retained");
      assert.equal(storesClosed, false, "closeStores must NOT run when a critical disposer failed");
      assert.deepEqual(networkHandlesClosed, ["realtime", "gateway", "realtime_ref", "packets"]);

      // The real proof: a second instance (simulating a restart) must NOT be able to acquire the
      // lock while it's retained -- this is what actually protects against two writers.
      const second = new RuntimeScopeLock(directory, 101);
      await assert.rejects(second.acquire(), /runtime_account_lock_held/);

      // Cleanup for the test's own sake -- release what the first instance still holds.
      await lock.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a critical disposer failure retains the lock even with an empty backlog and no other issues", async () => {
    // Same shape as above, phrased as the exact ticket scenario: critical disposer fails,
    // durable backlog is empty (the old bug: shouldRetainShutdownRecoveryState() alone would have
    // said "safe to close" here), and the lock must still be retained.
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-shutdown-empty-backlog-"));
    try {
      const lock = new RuntimeScopeLock(directory, 202);
      await lock.acquire();
      const outcome = await runShutdownFailureRecovery({
        criticalFailedDisposers: ["local_gateway"],
        backlogPending: false,
        closeStores: async () => {
          await lock.release();
        },
        retainNetworkHandles: () => undefined,
      });
      assert.equal(outcome, "retained");
      const second = new RuntimeScopeLock(directory, 202);
      await assert.rejects(second.acquire());
      await lock.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("no critical failure and no backlog: closes stores and genuinely releases the lock -- a restart can then acquire it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-shutdown-clean-"));
    try {
      const lock = new RuntimeScopeLock(directory, 303);
      await lock.acquire();

      let storesClosed = false;
      const outcome = await runShutdownFailureRecovery({
        criticalFailedDisposers: [],
        backlogPending: false,
        closeStores: async () => {
          storesClosed = true;
          await lock.release();
        },
        retainNetworkHandles: () => {
          throw new Error("must not retain when nothing requires it");
        },
      });

      assert.equal(outcome, "closed");
      assert.equal(storesClosed, true);

      // Simulates a restart: a fresh process/instance must be able to acquire the lock cleanly.
      const restarted = new RuntimeScopeLock(directory, 303);
      await assert.doesNotReject(restarted.acquire());
      await restarted.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backlog alone (no critical failure) also retains -- unchanged pre-existing behavior", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-shutdown-backlog-"));
    try {
      const lock = new RuntimeScopeLock(directory, 404);
      await lock.acquire();
      const outcome = await runShutdownFailureRecovery({
        criticalFailedDisposers: [],
        backlogPending: true,
        closeStores: async () => {
          await lock.release();
        },
        retainNetworkHandles: () => undefined,
      });
      assert.equal(outcome, "retained");
      const second = new RuntimeScopeLock(directory, 404);
      await assert.rejects(second.acquire());
      await lock.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a closeStores failure during the clean path is reported, not swallowed silently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-shutdown-cleanup-error-"));
    try {
      let reportedError: unknown = null;
      const outcome = await runShutdownFailureRecovery({
        criticalFailedDisposers: [],
        backlogPending: false,
        closeStores: async () => {
          throw new Error("disk full during close");
        },
        retainNetworkHandles: () => undefined,
        onCleanupError: (error) => {
          reportedError = error;
        },
      });
      assert.equal(outcome, "closed", "the decision was still to close -- the failure is in execution, not the gate");
      assert.ok(reportedError instanceof Error);
      assert.equal((reportedError as Error).message, "disk full during close");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
