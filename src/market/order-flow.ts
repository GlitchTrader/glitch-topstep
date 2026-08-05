import type { MarketDepthInfo, MarketTradeInfo } from "../domain/models.js";
import type {
  DepthBookObservation,
  OrderFlowWindowSeconds,
  ProjectXOrderFlowObservation,
  RollingTapeObservation,
} from "../domain/order-flow.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";

const WINDOWS: OrderFlowWindowSeconds[] = [15, 60, 300];
const MAX_WINDOW_SECONDS = 300;
const BUY = 0;
const SELL = 1;
const DOM_ASK_TYPES = new Set([1, 3, 10]);
const DOM_BID_TYPES = new Set([2, 4, 9]);
const DOM_RESET = 6;
const DOM_IGNORED_TYPES = new Set([0, 5, 7, 8, 11]);
const EPSILON = 1e-12;

export interface BuildOrderFlowInput {
  events: StoredProviderEvidenceEvent[];
  contractId: string;
  tickSize: number;
  generatedAt?: Date;
  truncated?: boolean;
  coverageStartUtc?: string | null;
  depthLevels?: number;
  source?: "projectx_market_evidence" | "replay";
}

interface TimedTrade {
  epochMs: number;
  trade: MarketTradeInfo;
}

export function buildProjectXOrderFlowObservation(
  input: BuildOrderFlowInput,
): ProjectXOrderFlowObservation {
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    throw new Error("order_flow_tick_size_invalid");
  }
  const depthLevels = input.depthLevels ?? 10;
  if (!Number.isInteger(depthLevels) || depthLevels < 1 || depthLevels > 100) {
    throw new Error("order_flow_depth_levels_invalid");
  }
  const generatedAt = input.generatedAt ?? new Date();
  const generatedMs = generatedAt.getTime();
  const lookbackStartMs = generatedMs - MAX_WINDOW_SECONDS * 1_000;
  const lookbackStartUtc = new Date(lookbackStartMs).toISOString();
  const issues: string[] = [];
  if (!isStrictlySequenceOrdered(input.events)) {
    issues.push("input_not_strictly_sequence_ordered");
  }
  const events = [...input.events]
    .filter((event) => event.contractId === input.contractId)
    .sort((left, right) => left.sequence - right.sequence || left.payloadHash.localeCompare(right.payloadHash));
  const trades: TimedTrade[] = [];
  const bidLevels = new Map<number, number>();
  const askLevels = new Map<number, number>();
  let latestResetSequence: number | null = null;
  let depthEventsApplied = 0;
  let depthEventsIgnored = 0;
  let depthEventsInvalid = 0;
  let invalidEvents = 0;

  for (const event of events) {
    if (event.eventType === "market_trade") {
      const trade = marketTradeFromEvidence(event.normalizedPayload);
      if (!trade) {
        invalidEvents += 1;
        issues.push(`market_trade_invalid:${event.sequence}`);
        continue;
      }
      const epochMs = Date.parse(trade.timestamp);
      if (!Number.isFinite(epochMs)) {
        invalidEvents += 1;
        issues.push(`market_trade_timestamp_invalid:${event.sequence}`);
        continue;
      }
      if (epochMs >= lookbackStartMs && epochMs <= generatedMs) {
        trades.push({ epochMs, trade });
      }
      continue;
    }
    if (event.eventType !== "depth") {
      continue;
    }
    const depth = marketDepthFromEvidence(event.normalizedPayload);
    if (!depth) {
      invalidEvents += 1;
      depthEventsInvalid += 1;
      issues.push(`depth_invalid:${event.sequence}`);
      continue;
    }
    if (depth.type === DOM_RESET) {
      bidLevels.clear();
      askLevels.clear();
      latestResetSequence = event.sequence;
      depthEventsApplied += 1;
      continue;
    }
    if (DOM_ASK_TYPES.has(depth.type)) {
      applyDepthLevel(askLevels, depth.price, depth.currentVolume);
      depthEventsApplied += 1;
      continue;
    }
    if (DOM_BID_TYPES.has(depth.type)) {
      applyDepthLevel(bidLevels, depth.price, depth.currentVolume);
      depthEventsApplied += 1;
      continue;
    }
    if (DOM_IGNORED_TYPES.has(depth.type)) {
      depthEventsIgnored += 1;
      continue;
    }
    invalidEvents += 1;
    depthEventsInvalid += 1;
    issues.push(`depth_type_unknown:${event.sequence}:${depth.type}`);
  }

  const coverageStartMs = input.coverageStartUtc === null || input.coverageStartUtc === undefined
    ? null
    : Date.parse(input.coverageStartUtc);
  const coverageComplete = coverageStartMs !== null
    && Number.isFinite(coverageStartMs)
    && coverageStartMs <= lookbackStartMs;
  if (!coverageComplete) {
    issues.push("market_evidence_does_not_cover_full_lookback");
  }
  if (input.truncated) {
    issues.push("market_evidence_query_truncated");
  }

  let lastTradeUtc: string | null = null;
  for (const item of trades) {
    const tradeUtc = new Date(item.epochMs).toISOString();
    if (!lastTradeUtc || item.epochMs > Date.parse(lastTradeUtc)) {
      lastTradeUtc = tradeUtc;
    }
  }

  return {
    schema_version: "glitch.projectx.order_flow.v1",
    generated_utc: generatedAt.toISOString(),
    source: input.source ?? "projectx_market_evidence",
    contract_id: input.contractId,
    lookback_start_utc: lookbackStartUtc,
    through_sequence: events.at(-1)?.sequence ?? 0,
    events_read: events.length,
    truncated: input.truncated ?? false,
    source_complete: coverageComplete && !input.truncated && invalidEvents === 0,
    invalid_events: invalidEvents,
    windows: WINDOWS.map((windowSeconds) => buildTapeWindow(
      trades,
      windowSeconds,
      generatedMs,
    )),
    depth: buildDepthObservation({
      bidLevels,
      askLevels,
      tickSize: input.tickSize,
      depthLevels,
      latestResetSequence,
      depthEventsApplied,
      depthEventsIgnored,
      depthEventsInvalid,
    }),
    issues,
    last_trade_utc: lastTradeUtc,
  };
}

function buildTapeWindow(
  trades: TimedTrade[],
  windowSeconds: OrderFlowWindowSeconds,
  endMs: number,
): RollingTapeObservation {
  const startMs = endMs - windowSeconds * 1_000;
  const window = trades.filter((item) => item.epochMs >= startMs && item.epochMs <= endMs);
  let buyVolume = 0;
  let sellVolume = 0;
  let totalNotional = 0;
  let maxTradeSize: number | null = null;
  let highPrice: number | null = null;
  let lowPrice: number | null = null;
  for (const item of window) {
    if (item.trade.type === BUY) {
      buyVolume += item.trade.volume;
    } else {
      sellVolume += item.trade.volume;
    }
    totalNotional += item.trade.price * item.trade.volume;
    maxTradeSize = maxTradeSize === null
      ? item.trade.volume
      : Math.max(maxTradeSize, item.trade.volume);
    highPrice = highPrice === null ? item.trade.price : Math.max(highPrice, item.trade.price);
    lowPrice = lowPrice === null ? item.trade.price : Math.min(lowPrice, item.trade.price);
  }
  const totalVolume = buyVolume + sellVolume;
  const firstPrice = window[0]?.trade.price ?? null;
  const lastPrice = window.at(-1)?.trade.price ?? null;
  const priceChange = firstPrice === null || lastPrice === null ? null : lastPrice - firstPrice;
  return {
    window_seconds: windowSeconds,
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    trade_count: window.length,
    total_volume: totalVolume,
    buy_volume: buyVolume,
    sell_volume: sellVolume,
    rolling_delta: buyVolume - sellVolume,
    delta_ratio: totalVolume <= EPSILON ? null : (buyVolume - sellVolume) / totalVolume,
    average_trade_size: window.length === 0 ? null : totalVolume / window.length,
    max_trade_size: maxTradeSize,
    vwap: totalVolume <= EPSILON ? null : totalNotional / totalVolume,
    first_price: firstPrice,
    last_price: lastPrice,
    high_price: highPrice,
    low_price: lowPrice,
    price_change: priceChange,
    price_change_bps: priceChange === null || firstPrice === null || Math.abs(firstPrice) <= EPSILON
      ? null
      : (priceChange / Math.abs(firstPrice)) * 10_000,
    trades_per_second: window.length / windowSeconds,
  };
}

function buildDepthObservation(input: {
  bidLevels: Map<number, number>;
  askLevels: Map<number, number>;
  tickSize: number;
  depthLevels: number;
  latestResetSequence: number | null;
  depthEventsApplied: number;
  depthEventsIgnored: number;
  depthEventsInvalid: number;
}): DepthBookObservation {
  const bids = [...input.bidLevels.entries()]
    .filter(([, volume]) => volume > 0)
    .sort(([left], [right]) => right - left)
    .slice(0, input.depthLevels)
    .map(([price, volume]) => ({ price, current_volume: volume }));
  const asks = [...input.askLevels.entries()]
    .filter(([, volume]) => volume > 0)
    .sort(([left], [right]) => left - right)
    .slice(0, input.depthLevels)
    .map(([price, volume]) => ({ price, current_volume: volume }));
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const bidVolume = bids.reduce((total, level) => total + level.current_volume, 0);
  const askVolume = asks.reduce((total, level) => total + level.current_volume, 0);
  const totalVolume = bidVolume + askVolume;
  return {
    depth_levels_requested: input.depthLevels,
    reconstruction_basis: input.latestResetSequence === null
      ? "bounded_window_without_reset"
      : "since_latest_reset",
    book_complete: false,
    latest_reset_sequence: input.latestResetSequence,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_ticks: bestBid === null || bestAsk === null
      ? null
      : (bestAsk - bestBid) / input.tickSize,
    bid_volume: bidVolume,
    ask_volume: askVolume,
    imbalance_ratio: totalVolume <= EPSILON ? null : (bidVolume - askVolume) / totalVolume,
    bid_levels: bids,
    ask_levels: asks,
    depth_events_applied: input.depthEventsApplied,
    depth_events_ignored: input.depthEventsIgnored,
    depth_events_invalid: input.depthEventsInvalid,
  };
}

function applyDepthLevel(levels: Map<number, number>, price: number, currentVolume: number): void {
  if (currentVolume <= 0) {
    levels.delete(price);
  } else {
    levels.set(price, currentVolume);
  }
}

function marketTradeFromEvidence(value: unknown): MarketTradeInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  return isString(value.contractId)
    && isString(value.symbolId)
    && isFiniteNumber(value.price)
    && isString(value.timestamp)
    && isInteger(value.type)
    && (value.type === BUY || value.type === SELL)
    && isFiniteNumber(value.volume)
    && value.volume > 0
    ? value as unknown as MarketTradeInfo
    : null;
}

function marketDepthFromEvidence(value: unknown): MarketDepthInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  return isString(value.contractId)
    && isString(value.timestamp)
    && isInteger(value.type)
    && isFiniteNumber(value.price)
    && isFiniteNumber(value.volume)
    && isFiniteNumber(value.currentVolume)
    ? value as unknown as MarketDepthInfo
    : null;
}

function isStrictlySequenceOrdered(events: StoredProviderEvidenceEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
