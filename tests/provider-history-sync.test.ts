import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OrderInfo, TradeInfo } from "../src/domain/models.js";
import { ProjectXHistorySyncService } from "../src/projectx/history-sync.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

const ACCOUNT_ID = 101;
const CONTRACT_ID = "CON.F.US.MNQ.U26";

function order(status = 1): OrderInfo {
  return {
    id: 9001,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-07-21T10:20:00Z",
    updateTimestamp: "2026-07-21T10:30:00Z",
    status,
    type: 2,
    side: 0,
    size: 1,
    limitPrice: null,
    stopPrice: null,
    customTag: "glt-history",
  };
}

function trade(): TradeInfo {
  return {
    id: 7001,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-07-21T10:31:00Z",
    price: 20_000,
    profitAndLoss: null,
    fees: 1.25,
    side: 0,
    size: 1,
    voided: false,
    orderId: 9001,
  };
}

describe("ProjectX history synchronization", () => {
  it("advances durable windows and suppresses unchanged overlap evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-history-sync-"));
    const path = join(directory, "evidence.sqlite");
    let now = Date.parse("2026-07-21T12:00:00Z");
    let currentOrder = order();
    const store = new SqliteProviderEvidenceStore(path);
    const sync = new ProjectXHistorySyncService(
      {
        searchOrders: async () => [currentOrder],
        searchTrades: async () => [trade()],
      },
      store,
      {
        accountId: ACCOUNT_ID,
        initialLookbackHours: 2,
        overlapMinutes: 10,
        windowMinutes: 60,
        generation: () => 1,
      },
      () => new Date(now),
    );
    try {
      const first = await sync.sync();
      assert.equal(first.completedWindows, 2);
      assert.equal(first.eventsAppended, 2);
      assert.equal(first.status.cursorUtc, "2026-07-21T12:00:00.000Z");

      now = Date.parse("2026-07-21T12:01:00Z");
      const second = await sync.sync();
      assert.equal(second.eventsAppended, 0);

      currentOrder = {
        ...currentOrder,
        status: 2,
        updateTimestamp: "2026-07-21T12:01:30Z",
      };
      now = Date.parse("2026-07-21T12:02:00Z");
      const third = await sync.sync();
      assert.equal(third.eventsAppended, 1);
      assert.equal(store.query({ eventType: "historical_order" }).length, 2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the last completed cursor when a later window fails", async () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    let calls = 0;
    const sync = new ProjectXHistorySyncService(
      {
        searchOrders: async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error("provider unavailable");
          }
          return [order()];
        },
        searchTrades: async () => [trade()],
      },
      store,
      {
        accountId: ACCOUNT_ID,
        initialLookbackHours: 2,
        overlapMinutes: 10,
        windowMinutes: 60,
        generation: () => 1,
      },
      () => new Date("2026-07-21T12:00:00Z"),
    );
    try {
      const result = await sync.sync();
      assert.equal(result.completedWindows, 1);
      assert.equal(result.status.cursorUtc, "2026-07-21T11:00:00.000Z");
      assert.match(result.status.lastError ?? "", /provider unavailable/);
    } finally {
      store.close();
    }
  });

  it("coalesces overlapping runs and waitForIdle observes completion", async () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const sync = new ProjectXHistorySyncService(
      {
        searchOrders: async () => {
          calls += 1;
          await gate;
          return [order()];
        },
        searchTrades: async () => {
          await gate;
          return [trade()];
        },
      },
      store,
      {
        accountId: ACCOUNT_ID,
        initialLookbackHours: 1,
        overlapMinutes: 10,
        windowMinutes: 60,
        generation: () => 1,
      },
      () => new Date("2026-07-21T12:00:00Z"),
    );
    try {
      const first = sync.sync();
      const second = sync.sync();
      assert.equal(first, second);
      const idle = sync.waitForIdle();
      release();
      await idle;
      assert.equal((await first).completedWindows, 1);
      assert.equal(calls, 1);
    } finally {
      store.close();
    }
  });
});
