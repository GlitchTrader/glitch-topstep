import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectXRealtimeClient, type SignalRConnection } from "../src/projectx/realtime.js";
import type { VenueStreamKind } from "../src/domain/models.js";
import { VenueStateStore } from "../src/state/venue-state.js";

const MNQ = "CON.F.US.MNQ.U26";
const MES = "CON.F.US.MES.U26";
const MCLE = "CON.F.US.MCLE.V26";

class FakeHub implements SignalRConnection {
  public readonly invocations: Array<{ method: string; contractId: string | null }> = [];
  public starts = 0;
  public stops = 0;
  private readonly reconnectedHandlers: Array<(connectionId?: string) => void> = [];
  private readonly closeHandlers: Array<(error?: Error) => void> = [];

  public async start(): Promise<void> {
    this.starts += 1;
  }

  public async stop(): Promise<void> {
    this.stops += 1;
  }

  public async invoke(methodName: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({
      method: methodName,
      contractId: typeof args[0] === "string" ? args[0] : null,
    });
    return undefined;
  }

  public on(): void {}

  public onreconnecting(): void {}

  public onreconnected(handler: (connectionId?: string) => void): void {
    this.reconnectedHandlers.push(handler);
  }

  public onclose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  public emitReconnected(): void {
    for (const handler of this.reconnectedHandlers) {
      handler("connection-1");
    }
  }

  public emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler(new Error("transport_closed"));
    }
  }

  public subscriptionKeys(): string[] {
    return this.invocations.map((row) => `${row.method}:${row.contractId ?? "-"}`);
  }
}

/** Lifecycle handlers are fire-and-forget; drain the queued async work before asserting. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function harness(options: { contractIds: readonly string[]; depthContractIds: readonly string[] }) {
  const hubs = new Map<VenueStreamKind, FakeHub>();
  const state = new VenueStateStore();
  const client = new ProjectXRealtimeClient(
    {
      userHubUrl: "user",
      marketHubUrl: "market",
      token: () => "token",
      accountId: 101,
      contractId: options.contractIds[0]!,
      contractIds: options.contractIds,
      depthContractIds: options.depthContractIds,
      evidence: { append: () => undefined },
      sleep: async () => undefined,
      connectionFactory: (kind) => {
        const hub = new FakeHub();
        hubs.set(kind, hub);
        return hub;
      },
    },
    state,
  );
  return { client, state, market: hubs.get("market")!, user: hubs.get("user")! };
}

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  return keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
}

describe("TS-MULTI-02 multi-contract subscription lifecycle", () => {
  it("subscribes each configured contract exactly once on connect", async () => {
    const { client, market, user } = harness({
      contractIds: [MNQ, MES, MCLE],
      depthContractIds: [MNQ],
    });

    await client.start();

    assert.deepEqual(duplicates(market.subscriptionKeys()), []);
    assert.deepEqual(market.subscriptionKeys().sort(), [
      `SubscribeContractMarketDepth:${MNQ}`,
      `SubscribeContractQuotes:${MCLE}`,
      `SubscribeContractQuotes:${MES}`,
      `SubscribeContractQuotes:${MNQ}`,
      `SubscribeContractTrades:${MCLE}`,
      `SubscribeContractTrades:${MES}`,
      `SubscribeContractTrades:${MNQ}`,
    ].sort());
    assert.equal(user.invocations.length, 4);

    await client.stop();
  });

  it("restores every configured subscription exactly once after an automatic reconnect", async () => {
    const { client, market } = harness({
      contractIds: [MNQ, MES, MCLE],
      depthContractIds: [MNQ, MES],
    });
    await client.start();
    const afterConnect = market.subscriptionKeys();

    market.emitReconnected();
    await settle();

    const afterReconnect = market.subscriptionKeys().slice(afterConnect.length);
    assert.deepEqual(duplicates(afterReconnect), []);
    assert.deepEqual(afterReconnect.sort(), afterConnect.slice().sort());

    await client.stop();
  });

  it("restores every configured subscription exactly once after a hub restart", async () => {
    const { client, market } = harness({
      contractIds: [MNQ, MES, MCLE],
      depthContractIds: [],
    });
    await client.start();
    const afterConnect = market.subscriptionKeys();
    const startsAfterConnect = market.starts;

    market.emitClose();
    await settle();

    const afterRestart = market.subscriptionKeys().slice(afterConnect.length);
    assert.equal(market.starts, startsAfterConnect + 1);
    assert.deepEqual(duplicates(afterRestart), []);
    assert.deepEqual(afterRestart.sort(), afterConnect.slice().sort());
    assert.deepEqual(afterRestart.filter((key) => key.startsWith("SubscribeContractMarketDepth")), []);

    await client.stop();
  });

  it("collapses a duplicated allowlist entry into a single subscription per contract", async () => {
    const { client, market } = harness({
      contractIds: [MNQ, MES, MNQ],
      depthContractIds: [MNQ, MNQ],
    });

    await client.start();
    market.emitReconnected();
    await settle();

    const quotes = market.subscriptionKeys().filter((key) => key === `SubscribeContractQuotes:${MNQ}`);
    const depth = market.subscriptionKeys().filter((key) => key === `SubscribeContractMarketDepth:${MNQ}`);
    assert.equal(quotes.length, 2, "one subscription per connect cycle, not one per allowlist entry");
    assert.equal(depth.length, 2);

    await client.stop();
  });
});
