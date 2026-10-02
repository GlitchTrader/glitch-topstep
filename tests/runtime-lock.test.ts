import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProcessBootMs, RuntimeScopeLock, writeRuntimeLockFixture } from "../src/service/runtime-lock.js";

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

test("a failed boot lookup stores null and does not look like a recycled pid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-null-boot-"));
  let calls = 0;
  const owner = new RuntimeScopeLock(directory, 55, async () => {
    calls += 1;
    return null;
  });
  try {
    await owner.acquire();
    assert.equal(calls, 3);
    const written = JSON.parse(await readFile(join(directory, "runtime-account-55.lock"), "utf8")) as {
      process_boot_ms: number | null;
    };
    assert.equal(written.process_boot_ms, null);
    await owner.release();
    await writeRuntimeLockFixture(directory, 55, {
      pid: process.pid,
      hostname: hostname(),
      process_boot_ms: null,
      invocation_id: "unknown-boot",
    });
    const rival = new RuntimeScopeLock(directory, 55, async () => 1_700_000_000_000);
    await assert.rejects(() => rival.acquire(), /runtime_account_lock_held/);
  } finally {
    await owner.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient boot lookup is retried before the lock stores null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-boot-retry-"));
  let calls = 0;
  const owner = new RuntimeScopeLock(directory, 56, async () => {
    calls += 1;
    return calls < 3 ? null : 42;
  });
  try {
    await owner.acquire();
    assert.equal(calls, 3);
    const written = JSON.parse(await readFile(join(directory, "runtime-account-56.lock"), "utf8")) as {
      process_boot_ms: number | null;
    };
    assert.equal(written.process_boot_ms, 42);
  } finally {
    await owner.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real process boot resolver releases a recycled pid and holds a matching one", async (t) => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    t.skip("process boot resolver is implemented for win32 and linux");
    return;
  }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const directory = await mkdtemp(join(tmpdir(), "runtime-lock-real-boot-"));
  try {
    if (!child.pid) {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
    }
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    let boot: number | null = null;
    for (let attempt = 0; attempt < 8 && boot === null; attempt += 1) {
      boot = await resolveProcessBootMs(pid as number);
      if (boot === null) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    assert.equal(typeof boot, "number");
    assert.equal(await resolveProcessBootMs(pid as number), boot);
    await writeRuntimeLockFixture(directory, 55, {
      pid: pid as number,
      hostname: hostname(),
      process_boot_ms: (boot as number) + 60_000,
      invocation_id: "recycled-pid",
    });
    const recycled = new RuntimeScopeLock(directory, 55, resolveProcessBootMs);
    await recycled.acquire();
    await recycled.release();
    await writeRuntimeLockFixture(directory, 55, {
      pid: pid as number,
      hostname: hostname(),
      process_boot_ms: boot as number,
      invocation_id: "live-pid",
    });
    const live = new RuntimeScopeLock(directory, 55, resolveProcessBootMs);
    await assert.rejects(() => live.acquire(), /runtime_account_lock_held/);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
