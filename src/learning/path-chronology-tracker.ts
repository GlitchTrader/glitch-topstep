import type {
  PathChronologyAmendmentInterval,
  PathChronologyFirstTouch,
  PathChronologyPassage,
  PathChronologyTargetBeforeStop,
  PathChronologyTrancheIdentity,
} from "./trade-outcome.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { TrancheView } from "../ownership/tranches.js";

export interface PathChronologyBeginInput {
  intentId: string;
  side: "long" | "short";
  entryPrice: number;
  breakevenPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  entryOrderId: number | null;
  filledQty: number;
  openedUtc: string;
}

export interface PathChronologyObservationInput {
  markPrice: number | null;
  observedUtc: string;
  barHigh?: number | null;
  barLow?: number | null;
}

interface ActiveInterval {
  intervalIndex: number;
  effectiveFromUtc: string;
  stopPrice: number | null;
  targetPrice: number | null;
  amendmentSource: string | null;
  firstTouch: PathChronologyFirstTouch;
  firstTouchUtc: string | null;
}

export interface PathChronologyTrackerSnapshot {
  firstPassage: {
    entry: PathChronologyPassage;
    breakeven: PathChronologyPassage;
  };
  amendmentIntervals: PathChronologyAmendmentInterval[];
  targetBeforeStop: PathChronologyTargetBeforeStop | null;
  tranche: PathChronologyTrancheIdentity;
  gaps: string[];
}

/**
 * Tracks first passage, amendment geometry, and stop/target first-touch while open.
 * ponytail: mark-price observations only — intra-bar ordering stays unresolved.
 */
export class PathChronologyTracker {
  private active = false;
  private side: "long" | "short" = "long";
  private entryPrice = 0;
  private breakevenPrice = 0;
  private entryPassage: PathChronologyPassage = emptyPassage();
  private breakevenPassage: PathChronologyPassage = emptyPassage();
  private intervals: ActiveInterval[] = [];
  private partialFillEvents = 0;
  private partialExitEvents = 0;
  private finalFilledQty: number | null = null;
  private intentId = "";
  private entryOrderId: number | null = null;
  private tradeFirstTouch: PathChronologyFirstTouch = "none";
  private tradeFirstTouchUtc: string | null = null;
  private gaps: string[] = [];

  public begin(input: PathChronologyBeginInput): void {
    this.reset();
    this.active = true;
    this.side = input.side;
    this.entryPrice = input.entryPrice;
    this.breakevenPrice = input.breakevenPrice;
    this.intentId = input.intentId;
    this.entryOrderId = input.entryOrderId;
    this.finalFilledQty = input.filledQty;
    this.startInterval(input.openedUtc, input.stopPrice, input.targetPrice, null);
  }

  public observe(input: PathChronologyObservationInput): void {
    if (!this.active || input.markPrice === null) {
      return;
    }
    this.recordPassage(this.entryPrice, "entry", input.markPrice, input.observedUtc);
    this.recordPassage(this.breakevenPrice, "breakeven", input.markPrice, input.observedUtc);
    this.recordIntervalTouch(input);
  }

  public observeAmendment(
    stopPrice: number | null,
    targetPrice: number | null,
    amendmentSource: string | null,
    observedUtc: string,
  ): void {
    if (!this.active) {
      return;
    }
    const current = this.intervals.at(-1);
    if (current
      && current.stopPrice === stopPrice
      && current.targetPrice === targetPrice) {
      return;
    }
    this.startInterval(observedUtc, stopPrice, targetPrice, amendmentSource);
  }

  public observePartialFill(filledQty: number, remainingQty: number): void {
    if (!this.active) {
      return;
    }
    this.partialFillEvents += 1;
    this.finalFilledQty = filledQty;
    if (remainingQty > 0) {
      this.gaps.push("partial_fill_observed");
    }
  }

  public observePartialExit(remainingQty: number): void {
    if (!this.active) {
      return;
    }
    this.partialExitEvents += 1;
    if (remainingQty > 0) {
      this.gaps.push("partial_exit_observed");
    }
  }

  public reset(): void {
    this.active = false;
    this.entryPassage = emptyPassage();
    this.breakevenPassage = emptyPassage();
    this.intervals = [];
    this.partialFillEvents = 0;
    this.partialExitEvents = 0;
    this.finalFilledQty = null;
    this.intentId = "";
    this.entryOrderId = null;
    this.tradeFirstTouch = "none";
    this.tradeFirstTouchUtc = null;
    this.gaps = [];
  }

  public snapshot(): PathChronologyTrackerSnapshot | null {
    if (!this.active && this.intervals.length === 0) {
      return null;
    }
    const amendmentIntervals = this.intervals.map((interval) => ({
      interval_index: interval.intervalIndex,
      effective_from_utc: interval.effectiveFromUtc,
      stop_price: interval.stopPrice,
      target_price: interval.targetPrice,
      amendment_source: interval.amendmentSource,
      first_touch: interval.firstTouch,
      first_touch_utc: interval.firstTouchUtc,
    }));
    return {
      firstPassage: {
        entry: { ...this.entryPassage },
        breakeven: { ...this.breakevenPassage },
      },
      amendmentIntervals,
      targetBeforeStop: resolveTargetBeforeStop(this.tradeFirstTouch),
      tranche: {
        intent_id: this.intentId,
        entry_order_id: this.entryOrderId,
        partial_fill_events: this.partialFillEvents,
        partial_exit_events: this.partialExitEvents,
        final_filled_qty: this.finalFilledQty,
      },
      gaps: [...new Set(this.gaps)],
    };
  }

  private startInterval(
    effectiveFromUtc: string,
    stopPrice: number | null,
    targetPrice: number | null,
    amendmentSource: string | null,
  ): void {
    this.intervals.push({
      intervalIndex: this.intervals.length,
      effectiveFromUtc,
      stopPrice,
      targetPrice,
      amendmentSource,
      firstTouch: "none",
      firstTouchUtc: null,
    });
  }

  private recordPassage(
    level: number,
    kind: "entry" | "breakeven",
    price: number,
    utc: string,
  ): void {
    const passage = kind === "entry" ? this.entryPassage : this.breakevenPassage;
    if (passage.observed) {
      return;
    }
    const crossed = this.side === "long"
      ? price >= level
      : price <= level;
    if (!crossed) {
      return;
    }
    passage.price = level;
    passage.utc = utc;
    passage.observed = true;
  }

  private recordIntervalTouch(input: PathChronologyObservationInput): void {
    const interval = this.intervals.at(-1);
    if (!interval) {
      return;
    }
    const high = input.barHigh ?? input.markPrice;
    const low = input.barLow ?? input.markPrice;
    if (high === null || low === null) {
      return;
    }
    const stopHit = interval.stopPrice !== null
      && (this.side === "long" ? low <= interval.stopPrice : high >= interval.stopPrice);
    const targetHit = interval.targetPrice !== null
      && (this.side === "long" ? high >= interval.targetPrice : low <= interval.targetPrice);
    if (!stopHit && !targetHit) {
      return;
    }
    if (stopHit && targetHit) {
      interval.firstTouch = "ambiguous";
      interval.firstTouchUtc = input.observedUtc;
      this.noteTradeTouch("ambiguous", input.observedUtc);
      this.gaps.push("intra_bar_touch_ambiguous");
      return;
    }
    const touch: PathChronologyFirstTouch = stopHit ? "stop" : "target";
    if (interval.firstTouch === "none") {
      interval.firstTouch = touch;
      interval.firstTouchUtc = input.observedUtc;
    }
    this.noteTradeTouch(touch, input.observedUtc);
  }

  private noteTradeTouch(touch: PathChronologyFirstTouch, utc: string): void {
    if (this.tradeFirstTouch !== "none") {
      if (this.tradeFirstTouch !== touch && touch !== "ambiguous") {
        return;
      }
      if (touch === "ambiguous") {
        this.tradeFirstTouch = "ambiguous";
        this.tradeFirstTouchUtc = utc;
      }
      return;
    }
    this.tradeFirstTouch = touch;
    this.tradeFirstTouchUtc = utc;
  }
}

function emptyPassage(): PathChronologyPassage {
  return { price: null, utc: null, observed: false };
}

function resolveTargetBeforeStop(
  touch: PathChronologyFirstTouch,
): PathChronologyTargetBeforeStop | null {
  if (touch === "target") {
    return "target";
  }
  if (touch === "stop") {
    return "stop";
  }
  if (touch === "ambiguous") {
    return "unresolved";
  }
  return null;
}

export function markPriceFromSnapshot(
  snapshot: AccountVenueSnapshot,
): { price: number | null; utc: string } {
  const position = snapshot.positions.find(
    (candidate) => candidate.contractId === snapshot.contract.id && candidate.type !== 0,
  );
  const quote = snapshot.quote;
  if (!quote) {
    return { price: null, utc: snapshot.capturedAt };
  }
  if (position?.type === 2) {
    return { price: quote.bestAsk, utc: quote.timestamp };
  }
  if (position?.type === 1) {
    return { price: quote.bestBid, utc: quote.timestamp };
  }
  return { price: quote.lastPrice, utc: quote.timestamp };
}

export function inferPositionSide(snapshot: AccountVenueSnapshot): "long" | "short" | null {
  const position = snapshot.positions.find(
    (candidate) => candidate.contractId === snapshot.contract.id && candidate.type !== 0,
  );
  if (!position || position.size === 0) {
    return null;
  }
  return position.type === 1 ? "long" : "short";
}

export function syncPathChronologyTracker(
  tracker: PathChronologyTracker,
  tranche: TrancheView,
  snapshot: AccountVenueSnapshot,
  observedUtc: string,
  activeIntentId: string | null,
): string {
  const side = inferPositionSide(snapshot);
  const position = snapshot.positions.find(
    (candidate) => candidate.contractId === snapshot.contract.id && candidate.type !== 0,
  );
  if (!side || !position) {
    return activeIntentId ?? tranche.intent_id;
  }
  if (activeIntentId !== tranche.intent_id) {
    tracker.begin({
      intentId: tranche.intent_id,
      side,
      entryPrice: position.averagePrice,
      breakevenPrice: position.averagePrice,
      stopPrice: tranche.protection.stop.price,
      targetPrice: tranche.protection.target.price,
      entryOrderId: tranche.entry_order_id,
      filledQty: tranche.filled_qty,
      openedUtc: tranche.created_utc,
    });
    return tranche.intent_id;
  }
  tracker.observeAmendment(
    tranche.protection.stop.price,
    tranche.protection.target.price,
    null,
    observedUtc,
  );
  return activeIntentId ?? tranche.intent_id;
}
