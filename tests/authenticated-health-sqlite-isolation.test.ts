import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import { DurableControlStore } from "../src/control/durable-control-store.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import {
  peekAuthenticatedHealthSqlite,
  refreshAuthenticatedHealthSqliteCaches,
} from "../src/observability/authenticated-health-sqlite.js";
import { buildHealthLiveness } from "../src/observability/health-liveness.js";
import { ProjectXOrderOwnershipService } from "../src/ownership/projectx-order-ownership.js";
import type { ProjectXApiClient } from "../src/projectx/client.js";
import { GATEWAY_COMPATIBILITY } from "../src/release/compatibility.js";
import { LocalGatewayServer } from "../src/server/local-gateway.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";
import { snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

const TOKEN = "012345678901234567890123456";

function installPrepareGuard(database: DatabaseSync): { prepareCalls: number } {
  const state = { prepareCalls: 0 };
  const original = database.prepare.bind(database);
  database.prepare = ((...args: Parameters<DatabaseSync["prepare"]>) => {
    state.prepareCalls += 1;
    return original(...args);
  }) as DatabaseSync["prepare"];
  return state;
}

function dbOf(store: object): DatabaseSync {
  return (store as { database: DatabaseSync }).database;
}

function ownershipDbs(ownership: ProjectXOrderOwnershipService): {
  execution: DatabaseSync;
  evidence: DatabaseSync;
} {
  return {
    execution: (ownership as unknown as { executionDatabase: DatabaseSync }).executionDatabase,
    evidence: (ownership as unknown as { evidenceDatabase: DatabaseSync }).evidenceDatabase,
  };
}

function outcomeFeedDb(store: TradeOutcomeStore): DatabaseSync {
  return dbOf((store as unknown as { feed: object }).feed);
}

function appConfig(dataDir: string): AppConfig {
  return {
    projectX: {
      username: "user",
      apiKey: "key",
      apiUrl: "https://api.topstepx.com",
      userHubUrl: "https://rtc.topstepx.com/hubs/user",
      marketHubUrl: "https://rtc.topstepx.com/hubs/market",
    },
    scope: {
      accountId: 101,
      accountName: "TEST_ACCOUNT",
      contractId: "CON.F.US.MNQ.U26",
      instrument: "MNQ",
      liveMarketData: false,
    },
    localGateway: {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
    },
    tradingMode: "shadow",
    policy: {
      accountStage: "express_funded_standard",
      lossModel: "express_funded_eod",
      authority: "operator_configured",
      verifiedAtUtc: null,
      startingBalance: 50_000,
      initialMaximumLoss: 2_000,
      highestEndOfDayBalance: 0,
      lossFloorLockedAtZero: false,
      payoutProcessed: false,
      operatorProvidedLossFloorUsd: null,
      maxContracts: 3,
    },
    session: testSessionConfig,
    dailyEconomics: testDailyEconomicsConfig,
    risk: {
      estimatedRoundTurnFeesUsd: 2.5,
      slippageReserveTicks: 2,
      maxQuoteAgeMs: 5_000,
      maxStateAgeMs: 5_000,
      maxIntentAgeMs: 300_000,
    },
    providerEvidence: {
      marketEventRetention: 500_000,
      marketPruneInterval: 10_000,
    },
    dataDir,
    reconcileIntervalMs: 3_000,
    packetLeaseMs: 300_000,
    entrySubmissionLatchStaleMs: 300_000,
  };
}

describe("authenticated /health SQLite class isolation", () => {
  it("after reconcile-equivalent warm, authenticated /health prepareCalls===0 on every SQLite connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-health-sqlite-"));
    const executionPath = join(dir, "glitch-topstep.sqlite");
    const evidencePath = join(dir, "projectx-evidence.sqlite");
    const executionStore = new SqliteExecutionStore(executionPath);
    const controlStore = new DurableControlStore(join(dir, "controls.sqlite"));
    const tradeOutcomeStore = new TradeOutcomeStore(dir);
    const providerEvidenceStore = new SqliteProviderEvidenceStore(evidencePath, {
      marketEventRetention: 500_000,
      marketPruneInterval: 10_000,
    });
    const ownership = new ProjectXOrderOwnershipService(executionPath, evidencePath, {
      accountId: 101,
      accountName: "TEST_ACCOUNT",
      contractId: "CON.F.US.MNQ.U26",
      instrument: "MNQ",
    });
    const current = snapshot();
    const config = appConfig(dir);
    const coordinator = new ExecutionCoordinator(
      config,
      { placeOrder: async () => 1, closePosition: async () => undefined } as unknown as ProjectXApiClient,
      new JsonlEventStore(dir),
      executionStore,
      () => current,
      () => null,
      () => undefined,
      () => ownership.current(current.instrumentOpenContracts).tranches,
    );
    const healthStores = {
      executionStore,
      controlStore,
      tradeOutcomeStore,
      providerEvidenceStore,
      coordinator,
    };

    try {
      // Reconcile-equivalent warm: live evaluate once, then /health must never prepare.
      refreshAuthenticatedHealthSqliteCaches(healthStores, current);
      executionStore.updateUnprotectedSince(0, new Date().toISOString());
      executionStore.recoveryStatus();

      const ownershipDb = ownershipDbs(ownership);
      const guards = {
        execution: installPrepareGuard(dbOf(executionStore)),
        control: installPrepareGuard(dbOf(controlStore)),
        outcome: installPrepareGuard(outcomeFeedDb(tradeOutcomeStore)),
        evidence: installPrepareGuard(dbOf(providerEvidenceStore)),
        ownershipExecution: installPrepareGuard(ownershipDb.execution),
        ownershipEvidence: installPrepareGuard(ownershipDb.evidence),
      };

      const gateway = new LocalGatewayServer(
        { host: "127.0.0.1", port: 0, token: TOKEN },
        (authenticated) => {
          if (!authenticated) {
            return buildHealthLiveness(GATEWAY_COMPATIBILITY);
          }
          const sqlite = peekAuthenticatedHealthSqlite(healthStores);
          return {
            schema_version: "glitch.direct.health.v3",
            compatibility: GATEWAY_COMPATIBILITY,
            status: "degraded",
            protected_reduction: sqlite.protectedReduction,
            provider_evidence: sqlite.providerEvidence,
            execution_facts: sqlite.executionFacts,
            controls: sqlite.controlCounts,
            outcome_feed: sqlite.outcomeFeed,
            execution_recovery: sqlite.recoveryPeek,
          };
        },
        () => current,
        async () => ({ schema_version: "glitch.direct.decision_packet.v2" } as never),
        () => [],
        coordinator,
        ownership,
      );
      await gateway.start();
      const server = (gateway as unknown as { server: ReturnType<typeof createServer> }).server!;
      const port = (server.address() as { port: number }).port;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(response.status, 200);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.schema_version, "glitch.direct.health.v3");
        assert.ok(body.protected_reduction);
        assert.ok(body.provider_evidence);
        assert.ok(body.execution_facts);

        assert.equal(guards.execution.prepareCalls, 0, "execution store");
        assert.equal(guards.control.prepareCalls, 0, "control store");
        assert.equal(guards.outcome.prepareCalls, 0, "outcome feed");
        assert.equal(guards.evidence.prepareCalls, 0, "provider evidence store");
        assert.equal(guards.ownershipExecution.prepareCalls, 0, "ownership execution RO");
        assert.equal(guards.ownershipEvidence.prepareCalls, 0, "ownership evidence RO");
      } finally {
        await gateway.stop();
      }
    } finally {
      ownership.close();
      executionStore.close();
      controlStore.close();
      await tradeOutcomeStore.close();
      providerEvidenceStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("service.ts routes authenticated /health SQLite through the class-closing peek module", () => {
    const src = readFileSync(join(process.cwd(), "src", "service.ts"), "utf8");
    assert.match(src, /peekAuthenticatedHealthSqlite/);
    assert.match(src, /refreshAuthenticatedHealthSqliteCaches/);
    const gatewayStart = src.indexOf("this.gateway = new LocalGatewayServer(");
    assert.ok(gatewayStart >= 0);
    const healthStart = src.indexOf("(authenticated) => {", gatewayStart);
    assert.ok(healthStart > gatewayStart);
    const healthEnd = src.indexOf("},\n      snapshot,", healthStart);
    assert.ok(healthEnd > healthStart, "could not bound the authenticated /health builder");
    const healthBuilder = src.slice(healthStart, healthEnd);
    assert.match(healthBuilder, /peekAuthenticatedHealthSqlite/);
    assert.equal(/executionFactsStatus\(/.test(healthBuilder), false);
    assert.equal(/providerEvidenceStore\.status\(/.test(healthBuilder), false);
    assert.equal(/activeProtectedReduction\(/.test(healthBuilder), false);
    assert.equal(/ownershipService\?\.current\(/.test(healthBuilder), false);
    assert.equal(/protectedReductionHealth\(/.test(healthBuilder), false);
  });
});
