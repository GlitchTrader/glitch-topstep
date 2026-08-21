import type { AccountVenueSnapshot } from "../models.js";
import type { FlattenVenueSnapshot } from "../../control/flatten-control-saga.js";
import type { FlattenControlTransition } from "../../service/flatten-workflow.js";

/** TS-REAUDIT-07: flatten control transitions decoupled from AppService orchestration. */
export interface FlattenSagaPort {
  buildVenueSnapshot(
    snapshot: AccountVenueSnapshot,
    accountId: number,
    contractId: string,
  ): FlattenVenueSnapshot;
  resolveAfterReceipt(receiptStatus: string, venue: FlattenVenueSnapshot): FlattenControlTransition;
  resolveAfterRestart(
    controlDetail: string | null,
    venue: FlattenVenueSnapshot,
  ): FlattenControlTransition;
  shouldCompletePending(venue: FlattenVenueSnapshot): boolean;
}
