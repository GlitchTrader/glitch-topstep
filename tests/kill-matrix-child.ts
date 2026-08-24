/**
 * Child process for TS-R1-01 kill-matrix fixtures.
 * Driven by env: GLITCH_KILL_POINT, GLITCH_KILL_DB, GLITCH_KILL_DATA_DIR,
 * GLITCH_KILL_COUNTER, GLITCH_KILL_READY_FILE (optional).
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { TradeIntent } from "../src/domain/models.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import { KILL_EXIT_CODE, activeKillPoint, killPointIs } from "../src/execution/kill-hook.js";
import { recoverExecutionMutations } from "../src/execution/recovery.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import type { ProjectXApiClient } from "../src/projectx/client.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { orderFlowWithTrades, snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

const INTENT_ID = "00000000-0000-4000-8000-000000000a01";
const EXIT_INTENT_ID = "00000000-0000-4000-8000-000000000a08";
const ORDER_ID = 9001;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function bumpCounter(): void {
  const path = requireEnv("GLITCH_KILL_COUNTER");
  const next = existsSync(path) ? Number(readFileSync(path, "utf8") || "0") + 1 : 1;
  writeFileSync(path, String(next));
}

function signalReady(label: string): void {
  const path = process.env.GLITCH_KILL_READY_FILE;
  if (!path) {
    return;
  }
  writeFileSync(path, `${label}\n${process.pid}\n`);
}

function killAfterProviderStarted(label: string): never {
  signalReady(label);
  // ponytail: exit(73) is more deterministic than parent SIGKILL on Windows while still
  // proving death after outbox submitting + provider call began (counter bumped).
  console.error(`GLITCH_KILL:${activeKillPoint()}:pid=${process.pid}:${label}`);
  process.exit(KILL_EXIT_CODE);
}

function config(dataDir: string): AppConfig {
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
      port: 8790,
      token: "012345678901234567890123",
    },
    tradingMode: "armed",
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

function entryIntent(snapshotHash: string, createdUtc: string, packet?: any): Record<string, unknown> {
  return {
    schema_version: "glitch.intent.v3",
    intent_id: INTENT_ID,
    created_utc: createdUtc,
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operator_profile: "glitch-topstep",
    action: "ENTER_LONG",
    confidence: 0.6,
    snapshot_hash: snapshotHash,
    model_version: "test",
    prompt_version: "glitch-topstep-v14",
    reason: "Kill-matrix entry fixture.",
    decision_audit: {
      bull_case: "Bull case.",
      bear_case: "Bear case.",
      flat_case: "Flat case.",
      aggressive_case: "Aggressive case.",
      conservative_case: "Conservative case.",
      decisive_evidence: "Evidence.",
      disconfirming_evidence: "Counter evidence.",
      change_condition: "Change condition.",
      final_choice: "ENTER_LONG",
    },
    quantity: 1,
    order_type: "MARKET",
    stop_loss: 19_990.25,
    take_profit_1: 20_020.25,
    packet_id: packet?.packet_id,
    contract_id: packet?.contract?.id,
    scope_hash: packet?.decision_scope?.scope_hash,
    scope_generation: packet?.decision_scope?.generation,
    expires_utc: packet?.expires_utc,
    entry_price_min: packet?.market?.bid,
    entry_price_max: packet?.market?.ask,
  };
}

function exitIntent(snapshotHash: string, createdUtc: string): Record<string, unknown> {
  return {
    schema_version: "glitch.intent.v2",
    intent_id: EXIT_INTENT_ID,
    created_utc: createdUtc,
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operator_profile: "glitch-topstep",
    action: "EXIT",
    confidence: 0.9,
    snapshot_hash: snapshotHash,
    model_version: "test",
    prompt_version: "glitch-topstep-v14",
    reason: "Kill-matrix exit fixture.",
    decision_audit: {
      bull_case: "Bull case.",
      bear_case: "Bear case.",
      flat_case: "Flat case.",
      aggressive_case: "Aggressive case.",
      conservative_case: "Conservative case.",
      decisive_evidence: "Evidence.",
      disconfirming_evidence: "Counter evidence.",
      change_condition: "Change condition.",
      final_choice: "EXIT",
    },
  };
}

function healthyRecovery(): ExecutionRecoveryStatus {
  return {
    blockingAmbiguity: false,
    entrySubmissionPending: false,
    blockingNewExposure: false,
    unresolvedMutations: 0,
    ambiguousMutations: 0,
    lastRecoveryUtc: null,
    lastRecoveryError: null,
  };
}

async function runRecoveryScenario(dbPath: string): Promise<void> {
  const store = new SqliteExecutionStore(dbPath);
  try {
    const intent: TradeIntent = {
      schemaVersion: "glitch.intent.v2",
      intentId: INTENT_ID,
      createdUtc: "2026-07-21T12:00:04Z",
      instrument: "MNQ",
      account: "TEST_ACCOUNT",
      operatorProfile: "glitch-topstep",
      action: "ENTER_LONG",
      confidence: 0.6,
      snapshotHash: "kill-matrix-recovery",
      modelVersion: "test",
      promptVersion: "glitch-topstep-v14",
      reason: "Recovery kill seed.",
      decisionAudit: {
        bullCase: "Bull.",
        bearCase: "Bear.",
        flatCase: "Flat.",
        aggressiveCase: "Aggressive.",
        conservativeCase: "Conservative.",
        decisiveEvidence: "Evidence.",
        disconfirmingEvidence: "Counter.",
        changeCondition: "Change.",
        finalChoice: "ENTER_LONG",
      },
      quantity: 1,
      orderType: "MARKET",
      stopLoss: 19_990.25,
      takeProfit1: 20_020.25,
    };
    store.registerIntent(intent, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      intent.intentId,
      "place_order",
      { accountId: 101, contractId: "CON.F.US.MNQ.U26", type: 2, side: 0, size: 1 },
      `glt-${intent.intentId}`.slice(0, 64),
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(intent.intentId, "2026-07-21T12:00:07Z");
    signalReady("recovery_seeded");
    await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      101,
      "CON.F.US.MNQ.U26",
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const point = activeKillPoint();
  if (!point) {
    throw new Error("GLITCH_KILL_POINT is required");
  }
  const dbPath = requireEnv("GLITCH_KILL_DB");
  const dataDir = requireEnv("GLITCH_KILL_DATA_DIR");
  requireEnv("GLITCH_KILL_COUNTER");

  if (point === "during_recovery") {
    await runRecoveryScenario(dbPath);
    process.exit(0);
  }

  const appConfig = config(dataDir);
  const store = new SqliteExecutionStore(dbPath);
  const ledger = new JsonlEventStore(dataDir);
  const current = snapshot();
  const now = new Date();
  current.capturedAt = now.toISOString();
  current.quote = { ...current.quote!, timestamp: now.toISOString() };

  if (point === "during_close_position") {
    current.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: now.toISOString(),
      type: 1,
      size: 1,
      averagePrice: 20_000,
    }];
    current.instrumentOpenContracts = 1;
    current.totalOpenContracts = 1;
  }

  const packet = buildDecisionPacket(
    current,
    appConfig.policy,
    appConfig.risk,
    healthyRecovery(),
    appConfig.scope.instrument,
    appConfig.tradingMode,
    appConfig.packetLeaseMs,
    now,
    undefined,
    orderFlowWithTrades(3),
  );
  store.recordIssuedPacket(packet);

  const api = {
    placeOrder: async () => {
      bumpCounter();
      if (killPointIs("during_transport_stall") || killPointIs("during_duplicate_wait")) {
        killAfterProviderStarted("place_order_stall");
      }
      return ORDER_ID;
    },
    closePosition: async () => {
      bumpCounter();
      if (killPointIs("during_close_position")) {
        killAfterProviderStarted("close_position_stall");
      }
    },
    modifyOrder: async () => undefined,
  } as unknown as ProjectXApiClient;

  const coordinator = new ExecutionCoordinator(
    appConfig,
    api,
    ledger,
    store,
    () => current,
    (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
    () => store.invalidateIssuedPackets(new Date().toISOString()),
  );

  try {
    if (point === "during_close_position") {
      // Hook fires after submitting, before closePosition; no stall needed for exit code 73.
      await coordinator.handleWireIntent(exitIntent(packet.market.snapshot_hash, now.toISOString()));
      process.exit(0);
    }

    const body = entryIntent(packet.market.snapshot_hash, now.toISOString(), packet);
    if (point === "during_duplicate_wait") {
      void coordinator.handleWireIntent(body);
      void coordinator.handleWireIntent(body);
      await new Promise(() => undefined); // first placeOrder exits 73; second stays queued
    }

    await coordinator.handleWireIntent(body);
    process.exit(0);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Re-export sentinel for parent imports via string constant duplication in parent.
void KILL_EXIT_CODE;
