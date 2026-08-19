import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeScopeLock } from "../src/service/runtime-lock.js";

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

