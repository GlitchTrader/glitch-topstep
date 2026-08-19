import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot, testSessionConfig } from "./fixtures.js";

const contracts = [
  { instrument: "MNQ", id: "CON.F.US.MNQ.U26", name: "MNQU6", symbolId: "F.US.MNQ", tickSize: 0.25, tickValue: 0.5 },
  { instrument: "MES", id: "CON.F.US.MES.U26", name: "MESU6", symbolId: "F.US.MES", tickSize: 0.25, tickValue: 1.25 },
  { instrument: "MCL", id: "CON.F.US.MCLE.V26", name: "MCLEV6", symbolId: "F.US.MCLE", tickSize: 0.01, tickValue: 1 },
] as const;

const healthyRecovery = (): ExecutionRecoveryStatus => ({
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
});

function config(contract: (typeof contracts)[number]): AppConfig {
  return {
    projectX: { username: "user", apiKey: "key", apiUrl: "https://api.topstepx.com", userHubUrl: "user", marketHubUrl: "market" },
    scope: { accountId: 101, accountName: "SIM", contractId: contract.id, instrument: contract.instrument, liveMarketData: false },
    localGateway: { host: "127.0.0.1", port: 8790, token: "012345678901234567890123" },
    tradingMode: "shadow",
    policy: { accountStage: "express_funded_standard", lossModel: "express_funded_eod", authority: "operator_configured", verifiedAtUtc: null, startingBalance: 50_000, initialMaximumLoss: 2_000, highestEndOfDayBalance: 0, lossFloorLockedAtZero: false, payoutProcessed: false, operatorProvidedLossFloorUsd: null, maxContracts: 5 },
    session: testSessionConfig,
    dailyEconomics: { enabled: false, nominalSizeUsd: null, profitTargetUsd: null },
    risk: { estimatedRoundTurnFeesUsd: 2.5, slippageReserveTicks: 2, maxQuoteAgeMs: 5_000, maxStateAgeMs: 5_000, maxIntentAgeMs: 300_000 },
    providerEvidence: { marketEventRetention: 500_000, marketPruneInterval: 10_000 },
    dataDir: "./data", reconcileIntervalMs: 3_000, packetLeaseMs: 300_000, entrySubmissionLatchStaleMs: 300_000,
  };
}

test("simulated contract session matrix preserves exact MNQ, MES, and MCL/MCLE identity", () => {
  for (const contract of contracts) {
    const current = snapshot();
    current.contract = { ...current.contract, id: contract.id, name: contract.name, symbolId: contract.symbolId, tickSize: contract.tickSize, tickValue: contract.tickValue, description: contract.instrument === "MCL" ? "Micro Crude Oil" : contract.instrument };
    current.quote = { ...current.quote!, contractId: contract.id, symbol: contract.symbolId };
    const store = new SqliteExecutionStore(":memory:");
    const packet = new DecisionPacketService(config(contract), () => current, store, healthyRecovery, () => Date.parse("2026-08-19T12:00:05Z")).current();
    assert.equal(packet.contract.id, contract.id);
    assert.equal(packet.contract.symbol_id, contract.symbolId);
    assert.equal(packet.account_selection.selected_contract_id, contract.id);
    assert.equal(packet.account_selection.selected_instrument, contract.instrument);
    assert.equal(packet.account_selection.mode, "single_contract");
    store.close();
  }
});
