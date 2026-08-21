import type { InstrumentUniverse } from "../domain/instrument-universe.js";
import type { AccountVenueSnapshot, QuoteInfo } from "../domain/models.js";
import { buildCandidateAlignment } from "./candidate-freshness.js";
import type { MultiInstrumentMarketPacket } from "./multi-instrument-data-plane.js";

export interface ScannerAccountSelection {
  schema_version: "glitch.topstep.account_selection.v1";
  mode: "single_contract";
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
 * observation and venue state; exactly one carries `execution_mode: "selected"`. Ranking and
 * candidate choice belong to Hermes, so this composition stays strictly descriptive.
 */
export function buildScannerPacket(input: {
  packet: MultiInstrumentMarketPacket;
  accountId: number;
  selectedInstrument: string;
  selectedContractId: string;
  universe: InstrumentUniverse;
  simultaneousExposureEnabled: boolean;
  candidateSnapshot: (contractId: string) => AccountVenueSnapshot;
}): ScannerPacket {
  return {
    ...input.packet,
    account_id: input.accountId,
    simultaneous_exposure_enabled: input.simultaneousExposureEnabled,
    account_selection: {
      schema_version: "glitch.topstep.account_selection.v1",
      mode: "single_contract",
      selected_instrument: input.selectedInstrument,
      selected_contract_id: input.selectedContractId,
      scope_generation: input.universe.generation,
      scope_hash: input.universe.scope_hash,
      simultaneous_exposure_enabled: input.simultaneousExposureEnabled,
    },
    candidates: input.packet.candidates.map((candidate) => {
      const snapshot = input.candidateSnapshot(candidate.contract_id);
      const asOf = new Date(input.packet.generated_utc);
      return {
        ...candidate,
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
