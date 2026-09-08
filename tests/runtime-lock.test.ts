import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeScopeLock, writeRuntimeLockFixture } from "../src/service/runtime-lock.js";

test("runtime account lock prevents a second mutation owner and releases cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-"));
  const first = new RuntimeScopeLock(directory, 42);
  const second = new RuntimeScopeLock(directory, 42);
  try {
    await first.acquire();
    await assert.rejects(() => second.acquire(), /runtime_account_lock_held/);
    await first.release();
    await second.acquire();
  } finally {
    await first.release();
    await second.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime account lock isolates owners by account_id in the same data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-accounts-"));
  const owner = new RuntimeScopeLock(directory, 101);
  const rival = new RuntimeScopeLock(directory, 101);
  const otherAccount = new RuntimeScopeLock(directory, 202);
  try {
    await owner.acquire();
    await assert.rejects(() => rival.acquire(), /runtime_account_lock_held/);
    await otherAccount.acquire();
  } finally {
    await owner.release();
    await rival.release();
    await otherAccount.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime account lock treats pid reuse with mismatched process boot as stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-reuse-"));
  const staleBootMs = 1_700_000_000_000;
  const liveBootMs = staleBootMs + 60_000;
  await writeRuntimeLockFixture(directory, 55, {
    pid: process.pid,
    hostname: hostname(),
    process_boot_ms: staleBootMs,
    invocation_id: "stale-invocation",
  });
  const lock = new RuntimeScopeLock(directory, 55, async (pid) => {
    assert.equal(pid, process.pid);
    return liveBootMs;
  });
  try {
    await lock.acquire();
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime account lock does not remove a live owner with matching process boot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-live-"));
  const bootMs = Math.floor(Date.now() - process.uptime() * 1000);
  await writeRuntimeLockFixture(directory, 77, {
    pid: process.pid,
    hostname: hostname(),
    process_boot_ms: bootMs,
    invocation_id: "live-invocation",
  });
  const rival = new RuntimeScopeLock(directory, 77, async () => bootMs);
  try {
    await assert.rejects(() => rival.acquire(), /runtime_account_lock_held/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
