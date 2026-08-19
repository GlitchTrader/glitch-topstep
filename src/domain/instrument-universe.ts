import { createHash } from "node:crypto";
import type { ContractInfo } from "./models.js";

export const TOPSTEP_INSTRUMENT_ALIASES = Object.freeze({
  MNQ: Object.freeze(["MNQ"]),
  MES: Object.freeze(["MES"]),
  MCL: Object.freeze(["MCL", "MCLE"]),
});

export type SupportedInstrument = keyof typeof TOPSTEP_INSTRUMENT_ALIASES;

export interface ResolvedInstrumentContract {
  instrument: SupportedInstrument;
  contract_id: string;
  contract_name: string;
  symbol_id: string;
  tick_size: number;
  tick_value: number;
  active_contract: true;
}

export interface InstrumentUniverse {
  schema_version: "glitch.topstep.instrument_universe.v1";
  generation: number;
  scope_hash: string;
  contracts: ResolvedInstrumentContract[];
}

function contractTokens(contract: ContractInfo): Set<string> {
  const symbolTail = contract.symbolId.split(".").at(-1)?.toUpperCase() ?? "";
  const nameRoot = contract.name.toUpperCase().replace(/[^A-Z].*$/, "");
  return new Set([symbolTail, nameRoot]);
}

export function normalizeInstrument(value: string): SupportedInstrument {
  const normalized = value.trim().toUpperCase();
  if (normalized === "MCLE") {
    return "MCL";
  }
  if (normalized === "MNQ" || normalized === "MES" || normalized === "MCL") {
    return normalized;
  }
  throw new Error(`unsupported_instrument:${value}`);
}

export function resolveInstrumentUniverse(
  allowlist: readonly string[],
  availableContracts: readonly ContractInfo[],
  generation = 1,
): InstrumentUniverse {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("instrument_universe_generation_invalid");
  }
  const instruments = [...new Set(allowlist.map(normalizeInstrument))];
  if (instruments.length === 0) {
    throw new Error("instrument_universe_empty");
  }
  const contracts = instruments.map((instrument): ResolvedInstrumentContract => {
    const aliases = new Set<string>(TOPSTEP_INSTRUMENT_ALIASES[instrument]);
    const candidates = availableContracts.filter((contract) => (
      contract.activeContract && [...contractTokens(contract)].some((token) => aliases.has(token))
    ));
    if (candidates.length === 0) {
      throw new Error(`active_contract_not_found:${instrument}`);
    }
    if (candidates.length > 1) {
      throw new Error(`active_contract_ambiguous:${instrument}:${candidates.map((row) => row.id).join(",")}`);
    }
    const contract = candidates[0]!;
    return {
      instrument,
      contract_id: contract.id,
      contract_name: contract.name,
      symbol_id: contract.symbolId,
      tick_size: contract.tickSize,
      tick_value: contract.tickValue,
      active_contract: true,
    };
  });
  const canonical = contracts
    .slice()
    .sort((left, right) => left.instrument.localeCompare(right.instrument))
    .map((row) => ({
      instrument: row.instrument,
      contract_id: row.contract_id,
      symbol_id: row.symbol_id,
      tick_size: row.tick_size,
      tick_value: row.tick_value,
    }));
  return {
    schema_version: "glitch.topstep.instrument_universe.v1",
    generation,
    scope_hash: createHash("sha256").update(JSON.stringify({ generation, contracts: canonical })).digest("hex"),
    contracts,
  };
}

