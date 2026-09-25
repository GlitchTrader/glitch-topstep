import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VenueStreamKind } from "../src/domain/models.js";
import { ProjectXRealtimeClient, type SignalRConnection } from "../src/projectx/realtime.js";
import { VenueStateStore } from "../src/state/venue-state.js";

class FakeHub implements SignalRConnection {
  private readonly reconnectedHandlers: Array<(connectionId?: string) => void> = [];
  private readonly closeHandlers: Array<(error?: Error) => void> = [];

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async invoke(): Promise<unknown> {
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
  public emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler(new Error("transport_closed"));
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 15; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("hub recovery generation", () => {
  it("keeps user-hub generation across restartHub while recovery is still active", async () => {
    const generations: number[] = [];
    const hubs = new Map<VenueStreamKind, FakeHub>();
    const client = new ProjectXRealtimeClient(
      {
        userHubUrl: "user",
        marketHubUrl: "market",
        token: () => "token",
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        evidence: { append: () => undefined },
        sleep: async () => undefined,
        onReconnected: async ({ kind, generation }) => {
          if (kind === "user") {
            generations.push(generation);
          }
        },
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    hubs.get("user")!.emitClose();
    await settle();
    hubs.get("user")!.emitClose();
    await settle();

    assert.deepEqual(generations, [1, 1]);
    assert.equal(client.isStaleRecovery("user", 1), false);
    assert.equal(client.hubRecoverySnapshot("user").generation, 1);
    assert.equal(client.hubRecoverySnapshot("user").attempt, 2);
    assert.equal(client.hubRecoverySnapshot("market").generation, 0);

    assert.equal(client.recoveryController("user").complete(1, "2026-09-24T22:48:00.000Z"), true);
    hubs.get("user")!.emitClose();
    await settle();
    assert.deepEqual(generations, [1, 1, 2]);
    assert.equal(client.isStaleRecovery("user", 1), true);
    assert.equal(client.hubRecoverySnapshot("user").generation, 2);
    await client.stop();
  });

  it("keeps market and user recovery generations independent", async () => {
    const hubs = new Map<VenueStreamKind, FakeHub>();
    const client = new ProjectXRealtimeClient(
      {
        userHubUrl: "user",
        marketHubUrl: "market",
        token: () => "token",
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        evidence: { append: () => undefined },
        sleep: async () => undefined,
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    hubs.get("user")!.emitClose();
    await settle();
    hubs.get("market")!.emitClose();
    await settle();

    assert.equal(client.hubRecoverySnapshot("user").generation, 1);
    assert.equal(client.hubRecoverySnapshot("market").generation, 1);
    assert.equal(client.isStaleRecovery("user", 1), false);
    assert.equal(client.isStaleRecovery("market", 1), false);
    await client.stop();
  });
});
