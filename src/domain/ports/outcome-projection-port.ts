import type { TradeOutcomeV1 } from "../../learning/trade-outcome.js";
import type { OutcomeRevisionPage } from "./outcome-feed-port.js";
import type {
  PublishTradeOutcomeInput,
} from "../../learning/trade-outcome-publisher.js";

/** TS-REAUDIT-07: closed-trade projection plus revision feed for paired profile sync. */
export interface OutcomeProjectionPort {
  publishClosedTranches(input: PublishTradeOutcomeInput): Promise<TradeOutcomeV1[]>;
  revisionPage(afterSequence: number, limit: number): OutcomeRevisionPage;
  current(): TradeOutcomeV1[];
}
