import type { TrancheView } from "../ownership/tranches.js";
import { shouldPublishTradeOutcomesOnFlat } from "../learning/trade-outcome-flat.js";
import type {
  OutcomeFeedPort,
  OutcomeRevisionStatus,
} from "../domain/ports/outcome-feed-port.js";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";

export interface OutcomeFeedFlatInput {
  beforeOpen: number;
  afterOpen: number;
  lastReconciledOpenContracts: number;
  tranches: readonly TrancheView[];
}

/**
 * Service-layer outcome feed helper implementing OutcomeFeedPort delegation
 * with the flat-detection gate used by reconciliation and stream handlers.
 */
export class OutcomeFeed implements OutcomeFeedPort {
  public constructor(private readonly feed: OutcomeFeedPort) {}

  public publish(
    outcome: TradeOutcomeV1,
    status: OutcomeRevisionStatus,
    recordedUtc?: string,
  ) {
    return this.feed.publish(outcome, status, recordedUtc);
  }

  public current(): TradeOutcomeV1[] {
    return this.feed.current();
  }

  public afterSequence(afterSequence: number, limit?: number) {
    return this.feed.afterSequence(afterSequence, limit);
  }

  public status() {
    return this.feed.status();
  }

  public shouldPublishOnFlat(input: OutcomeFeedFlatInput): boolean {
    return shouldPublishTradeOutcomesOnFlat(input);
  }
}
