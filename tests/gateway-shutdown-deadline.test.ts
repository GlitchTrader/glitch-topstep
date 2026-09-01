import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { LocalGatewayServer } from "../src/server/local-gateway.js";

describe("LocalGatewayServer shutdown deadline", () => {
  it("stops within the configured deadline when a client keeps a socket open", async () => {
    const hang = createServer(() => {
      // Intentionally never respond.
    });
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", () => resolve()));
    const hangPort = (hang.address() as { port: number }).port;

    const gateway = new LocalGatewayServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "token",
        shutdownDeadlineMs: 100,
      },
      (_authenticated) => ({ status: "ok" }),
      () => ({
        account: { id: 1, name: "TEST", balance: 0, canTrade: true, isVisible: true, simulated: true },
        positions: [],
        orders: [],
        operational: {
          reconciliation: { lastSucceededAt: null, lastFailedAt: null, lastError: null },
          quote: { lastReceivedAt: null, stale: true },
        },
      } as never),
      async () => ({ schema_version: "glitch.direct.packet.v1" } as never),
      () => [],
      {
        submitIntent: async () => ({ status: "rejected" }),
      } as never,
    );
    await gateway.start();
    const server = (gateway as unknown as { server: { address(): { port: number } } }).server;
    const port = server.address().port;
    void fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(50) }).catch(() => undefined);
    void fetch(`http://127.0.0.1:${hangPort}/`, { signal: AbortSignal.timeout(50) }).catch(() => undefined);

    const started = Date.now();
    await gateway.stop();
    hang.close();
    assert.ok(Date.now() - started < 2_000);
  });
});
