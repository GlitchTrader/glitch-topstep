import type { InstrumentUniverse } from "../domain/instrument-universe.js";

export type ActiveExecutionMode = "selected" | "eligible" | "flat_required";

export type AccountSelectionMode = "single_active_position" | "single_contract";

export const RUNTIME_ACCOUNT_SELECTION_MODE: AccountSelectionMode = "single_active_position";

export interface ResolveActivePositionScopeInput {
  universe: InstrumentUniverse;
  referenceContractId: string;
  referenceInstrument: string;
  requestedContractId?: string | null;
  requestedInstrument?: string | null;
  openContractIds: readonly string[];
  workingOrderContractIds: readonly string[];
}

export interface ActivePositionScope {
  activeContractId: string | null;
  activeInstrument: string | null;
  packetTargetContractId: string;
  packetTargetInstrument: string;
  accountFlat: boolean;
  executionModeFor(contractId: string): ActiveExecutionMode;
}

function allowlistedContractIds(universe: InstrumentUniverse): Set<string> {
  return new Set(universe.contracts.map((contract) => contract.contract_id));
}

function resolveRequestedContractId(input: ResolveActivePositionScopeInput): string | null {
  const allowlisted = allowlistedContractIds(input.universe);
  const requestedContractId = input.requestedContractId?.trim();
  if (requestedContractId && allowlisted.has(requestedContractId)) {
    return requestedContractId;
  }
  const requestedInstrument = input.requestedInstrument?.trim().toUpperCase();
  if (requestedInstrument) {
    const matches = input.universe.contracts.filter(
      (contract) => contract.instrument.toUpperCase() === requestedInstrument,
    );
    if (matches.length === 1) {
      return matches[0]!.contract_id;
    }
  }
  return null;
}

function resolveActiveContractId(input: ResolveActivePositionScopeInput): string | null {
  const allowlisted = allowlistedContractIds(input.universe);
  for (const contractId of input.openContractIds) {
    if (allowlisted.has(contractId)) {
      return contractId;
    }
  }
  for (const contractId of input.workingOrderContractIds) {
    if (allowlisted.has(contractId)) {
      return contractId;
    }
  }
  return null;
}

/** Account-wide single-active-position scope for scanner and decision packets. */
export function resolveActivePositionScope(
  input: ResolveActivePositionScopeInput,
): ActivePositionScope {
  const activeContractId = resolveActiveContractId(input);
  const activeContract = activeContractId
    ? input.universe.contracts.find((contract) => contract.contract_id === activeContractId)
    : undefined;
  const requestedContractId = resolveRequestedContractId(input);
  const packetTargetContractId = activeContractId
    ?? requestedContractId
    ?? input.referenceContractId;
  const packetTarget = input.universe.contracts.find(
    (contract) => contract.contract_id === packetTargetContractId,
  ) ?? input.universe.contracts.find(
    (contract) => contract.contract_id === input.referenceContractId,
  )!;

  const executionModeFor = (contractId: string): ActiveExecutionMode => {
    if (activeContractId) {
      return contractId === activeContractId ? "selected" : "flat_required";
    }
    return "eligible";
  };

  return {
    activeContractId,
    activeInstrument: activeContract?.instrument ?? null,
    packetTargetContractId: packetTarget.contract_id,
    packetTargetInstrument: packetTarget.instrument,
    accountFlat: activeContractId === null,
    executionModeFor,
  };
}

export function acceptsAccountSelectionMode(mode: unknown): mode is AccountSelectionMode {
  return mode === "single_active_position" || mode === "single_contract";
}
