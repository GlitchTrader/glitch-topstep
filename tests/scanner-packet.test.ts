import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveInstrumentUniverse } from "../src/domain/instrument-universe.js";
import type { AccountVenueSnapshot, ContractInfo } from "../src/domain/models.js";
import type { MultiInstrumentMarketPacket } from "../src/market/multi-instrument-data-plane.js";
import { buildScannerPacket, type ScannerPacket } from "../src/market/scanner-packet.js";
import { snapshot } from "./fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "gateway", "scanner_packet_observation_only.json");

const CATALOG: ContractInfo[] = [
  { id: "CON.F.US.MNQ.U26", name: "MNQU6", description: "Micro E-mini Nasdaq", tickSize: 0.25, tickValue: 0.5, activeContract: true, symbolId: "F.US.MNQ" },
  { id: "CON.F.US.MES.U26", name: "MESU6", description: "Micro E-mini S&P", tickSize: 0.25, tickValue: 1.25, activeContract: true, symbolId: "F.US.MES" },
  { id: "CON.F.US.MCLE.V26", name: "MCLEV6", description: "Micro Crude Oil", tickSize: 0.01, tickValue: 1, activeContract: true, symbolId: "F.US.MCLE" },
];

const universe = resolveInstrumentUniverse(["MNQ", "MES", "MCL"], CATALOG);

function candidateSnapshot(contractId: string): AccountVenueSnapshot {
  const contract = CATALOG.find((row) => row.id === contractId)!;
  const base = snapshot();
  return {
    ...base,
    contract,
    quote: { ...base.quote!, contractId, symbol: contract.symbolId },
    // Only the armed contract carries exposure; observation-only candidates stay flat.
    instrumentOpenContracts: contractId === "CON.F.US.MNQ.U26" ? 1 : 0,
  };
}

function marketPacket(): MultiInstrumentMarketPacket {
  return {
    schema_version: "glitch.topstep.market_universe.v1",
    market_data_mode: "simulated",
    generated_utc: "2026-08-20T12:00:00.000Z",
    generation: universe.generation,
    scope_hash: universe.scope_hash,
    scheduler: {
      pending: 0,
      completed: 12,
      failed: 0,
      last_started_utc: "2026-08-20T11:59:58.000Z",
      last_error: null,
      window_ms: 30_000,
      budget_per_window: 50,
      observed_peak_per_window: 12,
      headroom_per_window: 38,
    },
    candidates: universe.contracts.map((contract) => ({
      instrument: contract.instrument,
      contract_id: contract.contract_id,
      symbol_id: contract.symbol_id,
      tick_size: contract.tick_size,
      tick_value: contract.tick_value,
      execution_mode: contract.instrument === "MNQ" ? "selected" : "observation_only",
      market_observation: {
        last_attempt_utc: "2026-08-20T12:00:00.000Z",
        last_succeeded_utc: "2026-08-20T12:00:00.000Z",
        last_error: null,
        observation: null,
      },
      observation_quality: {
        status: "ready",
        observation_ready: true,
        last_succeeded_utc: "2026-08-20T12:00:00.000Z",
        last_error: null,
        timeframe_count: 4,
        completed_timeframe_count: 4,
        gap_count: 0,
        identity_issue_count: 0,
      },
    })),
  };
}

export function build(): ScannerPacket {
  return buildScannerPacket({
    packet: marketPacket(),
    accountId: 101,
    selectedInstrument: "MNQ",
    selectedContractId: "CON.F.US.MNQ.U26",
    universe,
    simultaneousExposureEnabled: false,
    candidateSnapshot,
  });
}

describe("GTHP-MULTI-01 gateway scanner boundary", () => {
  it("publishes every allowlisted candidate with exactly one armed contract", () => {
    const packet = build();

    assert.equal(packet.account_selection.schema_version, "glitch.topstep.account_selection.v1");
    assert.equal(packet.account_selection.mode, "single_contract");
    assert.equal(packet.account_selection.simultaneous_exposure_enabled, false);
    assert.equal(packet.account_selection.scope_hash, universe.scope_hash);
    assert.equal(packet.simultaneous_exposure_enabled, false);

    const selected = packet.candidates.filter((candidate) => candidate.execution_mode === "selected");
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.contract_id, packet.account_selection.selected_contract_id);
    assert.deepEqual(
      packet.candidates.filter((candidate) => candidate.execution_mode === "observation_only")
        .map((candidate) => candidate.instrument),
      ["MES", "MCL"],
    );
  });

  it("binds venue state to each exact contract without cross-instrument bleed", () => {
    const packet = build();

    for (const candidate of packet.candidates) {
      assert.equal(candidate.quote?.contractId, candidate.contract_id);
      assert.equal(candidate.quote?.symbol, candidate.symbol_id);
      assert.equal(candidate.state_complete, true);
      assert.deepEqual(candidate.state_issues, []);
    }
    assert.equal(packet.candidates.find((row) => row.instrument === "MNQ")!.open_contracts, 1);
    assert.equal(packet.candidates.find((row) => row.instrument === "MCL")!.open_contracts, 0);
  });

  it("matches the checked-in fixture Hermes codes against", () => {
    const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as ScannerPacket;
    assert.deepEqual(JSON.parse(JSON.stringify(build())), expected);
  });
});
