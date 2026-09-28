import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VenueStreamKind } from "../src/domain/models.js";
import { ProjectXRealtimeClient, type SignalRConnection } from "../src/projectx/realtime.js";
import { VenueStateStore } from "../src/state/venue-state.js";

class FakeHub implements SignalRConnection {
  public startCount = 0;
  private readonly closeHandlers: Array<(error?: Error) => void> = [];

  public async start(): Promise<void> {
    this.startCount += 1;
  }
  public async stop(): Promise<void> {}
  public async invoke(): Promise<unknown> {
    return undefined;
  }
  public on(): void {}
  public onreconnecting(): void {}
  public onreconnected(): void {}
  public onclose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }
  public emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler(new Error("transport_closed"));
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("market hub handshake from 1m bar lag", () => {
  it("does not restart the market hub on close while bars are stale, then handshakes when publishing resumes", async () => {
    const hubs = new Map<VenueStreamKind, FakeHub>();
    let publishing = false;
    const client = new ProjectXRealtimeClient(
      {
        userHubUrl: "user",
        marketHubUrl: "market",
        token: () => "token",
        accountId: 101,
        contractId: "CON.F.US.MNQ.Z26",
        evidence: { append: () => undefined },
        sleep: async () => undefined,
        isMarketExpectedLive: () => publishing,
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    const market = hubs.get("market")!;
    assert.equal(market.startCount, 1);

    market.emitClose();
    await settle();
    assert.equal(market.startCount, 1, "weekend/holiday stale bars must not force market restartHub");

    publishing = true;
    client.notifyMarketDataResumed();
    await settle();
    assert.equal(market.startCount, 2, "closed→open bar lag drop must handshake the market hub");

    await client.stop();
  });

  it("still restarts the market hub on close while bars are publishing", async () => {
    const hubs = new Map<VenueStreamKind, FakeHub>();
    const client = new ProjectXRealtimeClient(
      {
        userHubUrl: "user",
        marketHubUrl: "market",
        token: () => "token",
        accountId: 101,
        contractId: "CON.F.US.MNQ.Z26",
        evidence: { append: () => undefined },
        sleep: async () => undefined,
        isMarketExpectedLive: () => true,
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    const market = hubs.get("market")!;
    assert.equal(market.startCount, 1);
    market.emitClose();
    await settle();
    assert.ok(market.startCount >= 2, "live venue + dead hub must still restartHub");
    await client.stop();
  });
});
