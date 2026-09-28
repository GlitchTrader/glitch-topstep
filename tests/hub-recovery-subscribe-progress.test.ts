import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VenueStreamKind } from "../src/domain/models.js";
import {
  isRecoveryProgressFresh,
  shouldWatchdogRestartGateway,
  WATCHDOG_RECOVERY_PROGRESS_GRACE_MS,
} from "../src/observability/gateway-watchdog-policy.js";
import { ProjectXRealtimeClient, type SignalRConnection } from "../src/projectx/realtime.js";
import { VenueStateStore } from "../src/state/venue-state.js";

class FakeHub implements SignalRConnection {
  public startCount = 0;
  public subscribeShouldFail = false;
  private readonly closeHandlers: Array<(error?: Error) => void> = [];
  private readonly reconnectedHandlers: Array<(connectionId?: string) => void> = [];

  public async start(): Promise<void> {
    this.startCount += 1;
  }
  public async stop(): Promise<void> {}
  public async invoke(): Promise<unknown> {
    if (this.subscribeShouldFail) {
      throw new Error("subscribe_failed");
    }
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
  public emitReconnected(): void {
    for (const handler of this.reconnectedHandlers) {
      handler("conn-1");
    }
  }
}

async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("hub recovery progress after subscribe", () => {
  it("does not advance last_progress_at when start succeeds and subscribe fails", async () => {
    const hubs = new Map<VenueStreamKind, FakeHub>();
    const client = new ProjectXRealtimeClient(
      {
        userHubUrl: "user",
        marketHubUrl: "market",
        token: () => "token",
        accountId: 101,
        contractId: "CON.F.US.MNQ.Z26",
        evidence: { append: () => undefined },
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        hubStartTimeoutMs: 200,
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
    const t0 = "2026-09-28T14:36:29.000Z";
    const gen = client.recoveryController("market").beginAttempt("market", "suspect", t0);
    assert.equal(gen, 1);
    assert.equal(client.hubRecoverySnapshot("market").last_progress_at, t0);

    market.subscribeShouldFail = true;
    market.emitClose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.stop();

    const snap = client.hubRecoverySnapshot("market");
    assert.equal(snap.last_progress_at, t0);
    assert.ok(market.startCount >= 2);
    const t0Ms = Date.parse(t0);
    assert.equal(isRecoveryProgressFresh(snap, t0Ms + WATCHDOG_RECOVERY_PROGRESS_GRACE_MS - 1), true);
    assert.equal(isRecoveryProgressFresh(snap, t0Ms + WATCHDOG_RECOVERY_PROGRESS_GRACE_MS), false);
  });

  it("does not advance last_progress_at on SignalR onreconnected when subscribe fails", async () => {
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
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    const t0 = "2026-09-28T14:36:29.000Z";
    client.recoveryController("user").beginAttempt("user", "reconnecting", t0);
    hubs.get("user")!.subscribeShouldFail = true;
    hubs.get("user")!.emitReconnected();
    await settle();
    assert.equal(client.hubRecoverySnapshot("user").last_progress_at, t0);
    await client.stop();
  });

  it("marks resubscribing progress after a complete handshake", async () => {
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
        connectionFactory: (kind) => {
          const hub = new FakeHub();
          hubs.set(kind, hub);
          return hub;
        },
      },
      new VenueStateStore(),
    );

    await client.start();
    const t0 = "2026-09-28T14:36:29.000Z";
    client.recoveryController("market").beginAttempt("market", "reconnecting", t0);
    hubs.get("market")!.emitReconnected();
    await settle();
    const snap = client.hubRecoverySnapshot("market");
    assert.equal(snap.phase, "resubscribing");
    assert.notEqual(snap.last_progress_at, t0);
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
        recovery: snap,
      }),
      false,
    );
    await client.stop();
  });
});
