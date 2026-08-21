import type { InstrumentUniverse } from "../domain/instrument-universe.js";
import type { AccountVenueSnapshot, QuoteInfo } from "../domain/models.js";
import {
  RUNTIME_ACCOUNT_SELECTION_MODE,
  type AccountSelectionMode,
  type ActivePositionScope,
} from "./active-position-scope.js";
import { buildCandidateAlignment } from "./candidate-freshness.js";
import type { MultiInstrumentMarketPacket } from "./multi-instrument-data-plane.js";

export interface ScannerAccountSelection {
  schema_version: "glitch.topstep.account_selection.v1";
  mode: AccountSelectionMode;
  selected_instrument: string;
  selected_contract_id: string;
  scope_generation: number;
  scope_hash: string;
  simultaneous_exposure_enabled: boolean;
}

export type ScannerCandidate = MultiInstrumentMarketPacket["candidates"][number] & {
  quote: QuoteInfo | null;
  open_contracts: number;
  state_complete: boolean;
  state_issues: string[];
};

export type ScannerPacket = Omit<MultiInstrumentMarketPacket, "candidates"> & {
  account_id: number;
  simultaneous_exposure_enabled: boolean;
  account_selection: ScannerAccountSelection;
  candidates: ScannerCandidate[];
};

/**
 * The gateway-to-Hermes scanner boundary. Every allowlisted contract is published with its own
 * observation and venue state. When flat every candidate is eligible; when positioned exactly one
 * is selected and the rest require a flat account.
 */
export function buildScannerPacket(input: {
  packet: MultiInstrumentMarketPacket;
  accountId: number;
  scope: ActivePositionScope;
  universe: InstrumentUniverse;
  simultaneousExposureEnabled: boolean;
  candidateSnapshot: (contractId: string) => AccountVenueSnapshot;
  accountSelectionMode?: AccountSelectionMode;
}): ScannerPacket {
  const accountSelectionMode = input.accountSelectionMode ?? RUNTIME_ACCOUNT_SELECTION_MODE;
  return {
    ...input.packet,
    account_id: input.accountId,
    simultaneous_exposure_enabled: input.simultaneousExposureEnabled,
    account_selection: {
      schema_version: "glitch.topstep.account_selection.v1",
      mode: accountSelectionMode,
      selected_instrument: input.scope.packetTargetInstrument,
      selected_contract_id: input.scope.packetTargetContractId,
      scope_generation: input.universe.generation,
      scope_hash: input.universe.scope_hash,
      simultaneous_exposure_enabled: input.simultaneousExposureEnabled,
    },
    candidates: input.packet.candidates.map((candidate) => {
      const snapshot = input.candidateSnapshot(candidate.contract_id);
      const asOf = new Date(input.packet.generated_utc);
      return {
        ...candidate,
        execution_mode: input.scope.executionModeFor(candidate.contract_id),
        quote: snapshot.quote,
        open_contracts: snapshot.instrumentOpenContracts,
        state_complete: snapshot.stateComplete,
        state_issues: snapshot.stateIssues,
        candidate_alignment: buildCandidateAlignment(
          candidate.market_observation,
          snapshot.quote,
          asOf,
          input.packet.universe_freshness.ranking_freshness_valid,
        ),
      };
    }),
  };
}
