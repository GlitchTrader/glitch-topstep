import type { InstrumentUniverse } from "../domain/instrument-universe.js";

export interface PortfolioSelectionInput {
  universe: InstrumentUniverse;
  selected_contract_id: string;
  open_contract_ids: readonly string[];
  simultaneous_exposure_enabled: boolean;
}

export interface PortfolioSelectionResult {
  allowed: boolean;
  code:
    | "ok"
    | "selected_contract_not_allowlisted"
    | "selected_contract_ambiguous"
    | "foreign_exposure_requires_accountwide_opt_in";
  selected_instrument: string | null;
  selected_contract_id: string;
}

/**
 * Account-wide selection is deliberately single-contract by default. This is
 * an admission identity check, not a strategy or ranking decision.
 */
export function validatePortfolioSelection(
  input: PortfolioSelectionInput,
): PortfolioSelectionResult {
  const matches = input.universe.contracts.filter(
    (candidate) => candidate.contract_id === input.selected_contract_id,
  );
  const base = {
    selected_instrument: matches[0]?.instrument ?? null,
    selected_contract_id: input.selected_contract_id,
  } as const;
  if (matches.length === 0) {
    return { ...base, allowed: false, code: "selected_contract_not_allowlisted" };
  }
  if (matches.length !== 1) {
    return { ...base, allowed: false, code: "selected_contract_ambiguous" };
  }
  const foreignExposure = input.open_contract_ids.some(
    (contractId) => contractId !== input.selected_contract_id,
  );
  if (foreignExposure && !input.simultaneous_exposure_enabled) {
    return {
      ...base,
      allowed: false,
      code: "foreign_exposure_requires_accountwide_opt_in",
    };
  }
  return { ...base, allowed: true, code: "ok" };
}
