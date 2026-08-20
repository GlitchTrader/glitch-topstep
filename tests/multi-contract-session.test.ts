import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { ContractInfo } from "../src/domain/models.js";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import { validatePortfolioSelection } from "../src/risk/portfolio-selection.js";
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

const catalog: ContractInfo[] = contracts.map((contract) => ({
  id: contract.id,
  name: contract.name,
  description: contract.instrument,
  tickSize: contract.tickSize,
  tickValue: contract.tickValue,
  activeContract: true,
  symbolId: contract.symbolId,
}));

function config(contract: (typeof contracts)[number], tradingMode: AppConfig["tradingMode"] = "shadow"): AppConfig {
  return {
    projectX: { username: "user", apiKey: "key", apiUrl: "https://api.topstepx.com", userHubUrl: "user", marketHubUrl: "market" },
    scope: { accountId: 101, accountName: "SIM", contractId: contract.id, instrument: contract.instrument, liveMarketData: false },
    localGateway: { host: "127.0.0.1", port: 8790, token: "012345678901234567890123" },
    tradingMode,
    policy: { accountStage: "express_funded_standard", lossModel: "express_funded_eod", authority: "operator_configured", verifiedAtUtc: null, startingBalance: 50_000, initialMaximumLoss: 2_000, highestEndOfDayBalance: 0, lossFloorLockedAtZero: false, payoutProcessed: false, operatorProvidedLossFloorUsd: null, maxContracts: 5 },
    session: testSessionConfig,
    dailyEconomics: { enabled: false, nominalSizeUsd: null, profitTargetUsd: null },
    risk: { estimatedRoundTurnFeesUsd: 2.5, slippageReserveTicks: 2, maxQuoteAgeMs: 5_000, maxStateAgeMs: 5_000, maxIntentAgeMs: 300_000 },
    providerEvidence: { marketEventRetention: 500_000, marketPruneInterval: 10_000 },
    dataDir: "./data", reconcileIntervalMs: 3_000, packetLeaseMs: 300_000, entrySubmissionLatchStaleMs: 300_000,
  };
}

for (const tradingMode of ["shadow", "armed"] as const) {
  test(`TS-MULTI-01 simulated ${tradingMode} session matrix preserves exact MNQ, MES, and MCL/MCLE identity`, () => {
    for (const contract of contracts) {
      const current = snapshot();
      current.contract = { ...current.contract, id: contract.id, name: contract.name, symbolId: contract.symbolId, tickSize: contract.tickSize, tickValue: contract.tickValue, description: contract.instrument === "MCL" ? "Micro Crude Oil" : contract.instrument };
      current.quote = { ...current.quote!, contractId: contract.id, symbol: contract.symbolId };
      const store = new SqliteExecutionStore(":memory:");
      const packet = new DecisionPacketService(config(contract, tradingMode), () => current, store, healthyRecovery, () => Date.parse("2026-08-19T12:00:05Z")).current();
      assert.equal(packet.contract.id, contract.id);
      assert.equal(packet.contract.symbol_id, contract.symbolId);
      assert.equal(packet.account_selection.selected_contract_id, contract.id);
      assert.equal(packet.account_selection.selected_instrument, contract.instrument);
      assert.equal(packet.account_selection.mode, "single_contract");
      assert.equal(packet.account_selection.simultaneous_exposure_enabled, false);
      assert.equal(packet.execution.gateway_mode_configured, tradingMode);
      store.close();
    }
  });
}

test("MCL is an operator alias that only ever arms the exact ProjectX MCLE contract", () => {
  const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], catalog);

  assert.deepEqual(
    universe.contracts.map((contract) => [contract.instrument, contract.contract_id]),
    [["MNQ", "CON.F.US.MNQ.U26"], ["MES", "CON.F.US.MES.U26"], ["MCL", "CON.F.US.MCLE.V26"]],
  );

  // Every allowlisted contract is selectable one at a time; none substitutes for another.
  for (const contract of contracts) {
    const selection = validatePortfolioSelection({
      universe,
      selected_contract_id: contract.id,
      open_contract_ids: [],
      simultaneous_exposure_enabled: false,
    });
    assert.equal(selection.allowed, true);
    assert.equal(selection.selected_instrument, contract.instrument);
  }

  // The operator root alone is not an executable identity.
  assert.equal(
    validatePortfolioSelection({
      universe,
      selected_contract_id: "MCL",
      open_contract_ids: [],
      simultaneous_exposure_enabled: false,
    }).code,
    "selected_contract_not_allowlisted",
  );
});

test("a second contract stays observation-only while another contract holds the account", () => {
  const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], catalog);

  const selection = validatePortfolioSelection({
    universe,
    selected_contract_id: "CON.F.US.MES.U26",
    open_contract_ids: ["CON.F.US.MNQ.U26"],
    simultaneous_exposure_enabled: false,
  });

  assert.equal(selection.allowed, false);
  assert.equal(selection.code, "foreign_exposure_requires_accountwide_opt_in");
});
