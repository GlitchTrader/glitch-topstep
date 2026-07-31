import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import {
  buildReconnectProof,
  snapshotReconnectPhase,
  validateReconnectProof,
  type ReconnectProof,
} from "../src/projectx/reconnect-proof.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { VenueStateStore } from "../src/state/venue-state.js";
import { snapshot } from "./fixtures.js";

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "projectx", "live");
const stamp = "2026-07-21T12:00:00Z";

function config(): AppConfig {
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
      maxContracts: 5,
    },
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
    dataDir: "./data",
    reconcileIntervalMs: 3_000,
    packetLeaseMs: 300_000,
  };
}

function readyVenueState(): VenueStateStore {
  const state = new VenueStateStore();
  const current = snapshot();
  state.registerContracts([current.contract]);
  state.replaceAccounts([current.account], stamp);
  state.replacePositions(current.positions, stamp);
  state.replaceOrders(current.openOrders, stamp);
  state.markStreamConnected("user", stamp);
  state.markStreamConnected("market", stamp);
  state.applyQuote(current.quote!, stamp);
  state.markStreamEvent("user", stamp);
  state.markStreamEvent("market", stamp);
  state.markReconciliationStarted(stamp);
  state.markReconciliationSucceeded(stamp);
  return state;
}

describe("TS-R2-05 reconnect proof", () => {
  it("bumps generation, invalidates issued packets, and requires reconciliation before state is complete again", () => {
    const state = readyVenueState();
    const store = new SqliteExecutionStore(":memory:");
    const packets = new DecisionPacketService(
      config(),
      () => state.buildSnapshot(101, "CON.F.US.MNQ.U26"),
      store,
      healthyRecovery,
      () => Date.parse("2026-07-21T12:00:05Z"),
    );

    const issued = packets.current();
    const baseline = snapshotReconnectPhase(
      "baseline",
      state.buildSnapshot(101, "CON.F.US.MNQ.U26"),
      issued.market.snapshot_hash,
      packets.resolve(issued.market.snapshot_hash) !== null,
      stamp,
    );
    assert.equal(baseline.operational_generation, 1);

    state.markStreamReconnecting("market", new Error("acceptance_forced_gap"));
    packets.invalidateAll();
    const gap = snapshotReconnectPhase(
      "after_stream_gap",
      state.buildSnapshot(101, "CON.F.US.MNQ.U26"),
      issued.market.snapshot_hash,
      packets.resolve(issued.market.snapshot_hash) !== null,
      stamp,
    );
    assert.equal(gap.operational_generation, 2);
    assert.equal(gap.reconciliation_current, false);
    assert.equal(gap.state_complete, false);
    assert.equal(gap.issued_packet_resolvable, false);

    state.markStreamConnected("market");
    state.markStreamEvent("market");
    state.markReconciliationStarted();
    state.markReconciliationSucceeded();
    const reissued = packets.current();
    const settled = snapshotReconnectPhase(
      "after_reconciliation",
      state.buildSnapshot(101, "CON.F.US.MNQ.U26"),
      reissued.market.snapshot_hash,
      packets.resolve(reissued.market.snapshot_hash) !== null,
      stamp,
    );
    assert.equal(settled.reconciliation_current, true);
    assert.equal(settled.state_complete, true);
    assert.equal(settled.issued_packet_resolvable, true);

    const proof = buildReconnectProof({
      capturedUtc: stamp,
      mode: "deterministic_fixture",
      scope: {
        account_id: 101,
        account_name: "TEST_ACCOUNT",
        contract_id: "CON.F.US.MNQ.U26",
        instrument: "MNQ",
      },
      phases: [baseline, gap, settled],
    });
    assert.deepEqual(validateReconnectProof(proof), []);
    store.close();
  });

  it("validates the live reconnect proof fixture captured on Windows", () => {
    const proof = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, "reconnect_proof.json"), "utf8"),
    ) as ReconnectProof;
    const failures = validateReconnectProof(proof);
    assert.deepEqual(failures, [], `reconnect_proof failures: ${failures.join(", ")}`);
    assert.equal(proof.proof_passed, true);
    assert.equal(proof.mode, "live_acceptance_gap");
    const gap = proof.phases.find((phase) => phase.label === "after_stream_gap");
    assert.ok(gap);
    assert.equal(gap.issued_packet_resolvable, false);
    const packet = proof.phases.at(-1);
    assert.equal(packet?.issued_packet_resolvable, true);
    assert.equal(
      packet?.reconciliation_generation,
      packet?.operational_generation,
    );
  });
});
