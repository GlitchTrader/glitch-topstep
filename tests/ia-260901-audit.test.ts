import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { buildHealthLiveness } from "../src/observability/health-liveness.js";
import { GATEWAY_COMPATIBILITY } from "../src/release/compatibility.js";
import { validateScaleIn } from "../src/ownership/scale-in.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";
import { LocalGatewayServer } from "../src/server/local-gateway.js";
import { snapshot } from "./fixtures.js";

const TOKEN = "012345678901234567890123456";

describe("IA-260901 audit remediation", () => {
  it("GW-04 exposes liveness-only /health without auth", async () => {
    const gateway = new LocalGatewayServer(
      { host: "127.0.0.1", port: 0, token: TOKEN },
      (authenticated) => (authenticated
        ? { schema_version: "glitch.direct.health.v3", status: "degraded", secret: true }
        : buildHealthLiveness(GATEWAY_COMPATIBILITY)),
      () => snapshot(),
      async () => ({ schema_version: "glitch.direct.decision_packet.v2" } as never),
      () => [],
      { handleWireIntent: async () => ({ status: "rejected" }) } as never,
    );
    await gateway.start();
    const server = (gateway as unknown as { server: ReturnType<typeof createServer> }).server!;
    const port = (server.address() as { port: number }).port;
    try {
      const publicHealth = await fetch(`http://127.0.0.1:${port}/health`);
      const publicBody = await publicHealth.json() as Record<string, unknown>;
      assert.equal(publicHealth.status, 200);
      assert.equal(publicBody.status, "ok");
      assert.ok(publicBody.compatibility);
      assert.equal("secret" in publicBody, false);

      const authed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const authedBody = await authed.json() as Record<string, unknown>;
      assert.equal(authedBody.status, "degraded");
      assert.equal(authedBody.secret, true);
    } finally {
      await gateway.stop();
    }
  });

  it("GW-05 ignores non-protective working orders on other contracts for scale-in", () => {
    const positioned = snapshot();
    positioned.instrumentOpenContracts = 1;
    positioned.totalOpenContracts = 1;
    positioned.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 1,
      size: 1,
      averagePrice: 20_000,
    }];
    positioned.openOrders = [{
      id: 9301,
      accountId: 101,
      contractId: "CON.F.US.ES.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 2,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: null,
      customTag: "glt-pending-entry",
    }];
    const result = validateScaleIn(
      "ENTER_LONG",
      positioned,
      "CON.F.US.MNQ.U26",
      101,
    );
    assert.equal(result.allowed, true);
  });

  it("GW-03 rejects operator_provided_floor outside policy bounds at startup", () => {
    assert.throws(
      () => loadConfig({
        GLITCH_LOCAL_TOKEN: TOKEN,
        GLITCH_OPERATOR_TOKEN: "987654321098765432109876543",
        GLITCH_PROJECTX_USERNAME: "user",
        GLITCH_PROJECTX_API_KEY: "key",
        GLITCH_ACCOUNT_NAME: "TEST",
        GLITCH_CONTRACT_ID: "CON.F.US.MNQ.U26",
        GLITCH_INSTRUMENT: "MNQ",
        GLITCH_LOSS_MODEL: "operator_provided_floor",
        GLITCH_HARD_LOSS_FLOOR_USD: "60000",
        GLITCH_STARTING_BALANCE: "50000",
      }),
      /GLITCH_HARD_LOSS_FLOOR_USD must be below GLITCH_STARTING_BALANCE/,
    );
  });

  it("GW-06 prunes applied evidence_outbox rows but keeps pending", () => {
    const store = new SqliteProviderEvidenceStore(":memory:", { appliedOutboxRetentionHours: 24 });
    try {
      const oldEvent = {
        receivedUtc: "2020-01-01T00:00:00.000Z",
        providerTimestampUtc: "2020-01-01T00:00:00.000Z",
        source: "projectx_rest" as const,
        eventType: "order_updated",
        generation: 1,
        accountId: 1,
        contractId: "CON.F.US.MNQ.U26",
        providerEntityId: "1",
        rawPayload: {},
        normalizedPayload: {},
      };
      store.stageIdentityOutbox(oldEvent);
      store.appendBatch([oldEvent]);
      store.stageIdentityOutbox({
        receivedUtc: "2026-01-01T00:00:00.000Z",
        providerTimestampUtc: "2026-01-01T00:00:00.000Z",
        source: "projectx_rest",
        eventType: "order_updated",
        generation: 1,
        accountId: 1,
        contractId: "CON.F.US.MNQ.U26",
        providerEntityId: "3",
        rawPayload: {},
        normalizedPayload: {},
      });
      assert.equal(store.outboxPendingCount(), 1);
      const pruned = store.pruneAppliedOutbox(new Date("2026-02-01T00:00:00.000Z"));
      assert.equal(pruned.pruned, 1);
      assert.equal(store.outboxPendingCount(), 1);
    } finally {
      store.close();
    }
  });
});
