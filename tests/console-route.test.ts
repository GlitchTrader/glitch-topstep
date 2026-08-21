import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import type { ExecutionCoordinator } from "../src/execution/coordinator.js";
import type { DirectDecisionPacket } from "../src/hermes/packet-builder.js";
import { isLoopbackGatewayHost, LocalGatewayServer } from "../src/server/local-gateway.js";
import { snapshot } from "./fixtures.js";

const TOKEN = "012345678901234567890123";

function stubCoordinator(): ExecutionCoordinator {
  return {
    receiptForIntent: () => null,
    handleWireIntent: async () => ({
      status: "rejected",
      intentId: "test",
      reason: "test_stub",
    }),
  } as unknown as ExecutionCoordinator;
}

function boundPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected_tcp_port");
  }
  return address.port;
}

describe("local gateway /console route", () => {
  it("accepts only loopback gateway host bindings", () => {
    assert.equal(isLoopbackGatewayHost("127.0.0.1"), true);
    assert.equal(isLoopbackGatewayHost("::1"), true);
    assert.equal(isLoopbackGatewayHost("0.0.0.0"), false);
  });

  it("serves the read-only console HTML on loopback", async () => {
    const gateway = new LocalGatewayServer(
      { host: "127.0.0.1", port: 0, token: TOKEN },
      () => ({ status: "ok" }),
      () => snapshot(),
      async () => ({ schema_version: "glitch.direct.decision_packet.v2" } as DirectDecisionPacket),
      () => [],
      stubCoordinator(),
    );
    await gateway.start();

    const underlying = (gateway as unknown as { server: ReturnType<typeof createServer> | null }).server;
    assert.ok(underlying);
    const port = boundPort(underlying!);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/console`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const body = await response.text();
      assert.match(body, /read-only console/);
      assert.match(body, /\/health/);
      assert.match(body, /\/state/);
    } finally {
      await gateway.stop();
    }
  });
});
