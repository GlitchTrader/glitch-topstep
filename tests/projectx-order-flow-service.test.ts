import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectXOrderFlowService } from "../src/market/projectx-order-flow-service.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

const CONTRACT = "CON.F.US.MNQ.U26";
const NOW = new Date("2026-07-21T12:05:00Z");

function marketEvent(
  receivedUtc: string,
  eventType: string,
  normalizedPayload: unknown,
) {
  return {
    receivedUtc,
    providerTimestampUtc: receivedUtc,
    source: "projectx_market_stream" as const,
    eventType,
    generation: 1,
    accountId: null,
    contractId: CONTRACT,
    providerEntityId: null,
    relatedProviderEntityId: null,
    rawPayload: null,
    normalizedPayload,
  };
}

describe("ProjectX order-flow service", () => {
  it("reads recent local evidence without calling ProjectX", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-order-flow-"));
    const path = join(directory, "projectx-evidence.sqlite");
    const store = new SqliteProviderEvidenceStore(path);
    try {
      store.append(marketEvent("2026-07-21T11:59:00Z", "quote", { marker: "coverage" }));
      store.append(marketEvent("2026-07-21T12:04:55Z", "market_trade", {
        contractId: CONTRACT,
        symbolId: "F.US.MNQ",
        timestamp: "2026-07-21T12:04:55Z",
        type: 0,
        price: 100,
        volume: 2,
      }));
      store.append(marketEvent("2026-07-21T12:04:56Z", "depth", {
        contractId: CONTRACT,
        timestamp: "2026-07-21T12:04:56Z",
        type: 2,
        price: 99.75,
        volume: 4,
        currentVolume: 4,
      }));
      store.append(marketEvent("2026-07-21T12:04:57Z", "depth", {
        contractId: CONTRACT,
        timestamp: "2026-07-21T12:04:57Z",
        type: 1,
        price: 100,
        volume: 3,
        currentVolume: 3,
      }));

      const service = new ProjectXOrderFlowService(path, {
        contractId: CONTRACT,
        tickSize: 0.25,
        maxEvents: 1_000,
        depthLevels: 10,
      }, () => NOW);
      try {
        const state = await service.refresh();
        assert.equal(state.last_error, null);
        assert.equal(state.observation?.source_complete, true);
        assert.equal(state.observation?.windows[0]?.buy_volume, 2);
        assert.equal(state.observation?.depth.spread_ticks, 1);
      } finally {
        service.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("coalesces refreshes and preserves last success after database failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-order-flow-failure-"));
    const path = join(directory, "projectx-evidence.sqlite");
    const store = new SqliteProviderEvidenceStore(path);
    store.append(marketEvent("2026-07-21T11:59:00Z", "quote", { marker: "coverage" }));
    const service = new ProjectXOrderFlowService(path, {
      contractId: CONTRACT,
      tickSize: 0.25,
      maxEvents: 1_000,
      depthLevels: 10,
    }, () => NOW);
    try {
      const first = service.refresh();
      const second = service.refresh();
      assert.equal(first, second);
      const successful = await first;
      assert.ok(successful.observation);
      service.close();
      const degraded = await service.refresh();
      assert.deepEqual(degraded.observation, successful.observation);
      assert.match(degraded.last_error ?? "", /database/i);
      await service.waitForIdle();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
