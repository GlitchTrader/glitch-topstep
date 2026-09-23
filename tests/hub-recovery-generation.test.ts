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
  it("increments user-hub generation on each restartHub", async () => {
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

    assert.deepEqual(generations, [1, 2]);
    await client.stop();
  });
});
