import { compactBars, normalizeBars, summarizeBars } from "./bars.js";
import { buildStructuralLevels } from "./levels.js";
import { buildMarketFeatures, isNearSessionExtreme } from "./features.js";
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_TYPE } from "./constants.js";

function isRthOpenWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(weekday)) {
    return false;
  }
  const minutes = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 10 * 60;
  return minutes >= open && minutes < close;
}

export function shouldFetchMicroBars(config, features, now = new Date(), positioned = false) {
  if (!config.microBarsEnabled) {
    return false;
  }
  if (positioned) {
    return true;
  }
  if (config.microBarsAlways) {
    return true;
  }
  if (config.microBarsRthOnly && isRthOpenWindow(now)) {
    return true;
  }
  return isNearSessionExtreme(features, config.microBarsExtremeThreshold);
}

export function deriveQuoteFromBars(contract, bars, realtimeQuote = null) {
  const tickSize = Number(contract.tickSize) || 0.25;
  const normalized = normalizeBars(bars);
  const latest = normalized.at(-1);
  if (!latest) {
    throw new Error("ProjectX bars did not include a usable last price");
  }

  if (realtimeQuote?.last) {
    return {
      last: realtimeQuote.last,
      bid: realtimeQuote.bid ?? realtimeQuote.last - tickSize,
      ask: realtimeQuote.ask ?? realtimeQuote.last + tickSize,
      spread_ticks: Math.max(
        1,
        Math.round(
          ((realtimeQuote.ask ?? realtimeQuote.last + tickSize) -
            (realtimeQuote.bid ?? realtimeQuote.last - tickSize)) /
            tickSize,
        ),
      ),
      session_open: realtimeQuote.open ?? normalized[0]?.o ?? latest.c,
      session_high: realtimeQuote.high ?? Math.max(...normalized.map((bar) => bar.h)),
      session_low: realtimeQuote.low ?? Math.min(...normalized.map((bar) => bar.l)),
      volume:
        realtimeQuote.volume ??
        normalized.reduce((sum, bar) => sum + (bar.v || 0), 0),
      quote_timestamp: realtimeQuote.quote_timestamp ?? latest.t,
      change: realtimeQuote.change ?? null,
      change_percent: realtimeQuote.change_percent ?? null,
      source: "realtime",
    };
  }

  const last = latest.c;
  let sessionHigh = last;
  let sessionLow = last;
  let volume = 0;
  for (const bar of normalized) {
    sessionHigh = Math.max(sessionHigh, bar.h);
    sessionLow = Math.min(sessionLow, bar.l);
    volume += bar.v || 0;
  }
  return {
    last,
    bid: last - tickSize,
    ask: last + tickSize,
    spread_ticks: 2,
    session_open: normalized[0]?.o ?? last,
    session_high: sessionHigh,
    session_low: sessionLow,
    volume,
    quote_timestamp: latest.t,
    change: null,
    change_percent: null,
    source: "bars",
  };
}

export function mapPositionState(position, contract, quote) {
  const tickSize = Number(contract.tickSize) || 0.25;
  const tickValue = Number(contract.tickValue) || 0.5;
  if (!position) {
    return {
      side: "flat",
      size: 0,
      average_price: null,
      unrealized_pnl_usd: 0,
      unrealized_pnl_ticks: 0,
      age_seconds: null,
    };
  }
  const size = Number(position.size) || 0;
  const side = POSITION_TYPE[position.type] || "flat";
  const averagePrice = Number(position.averagePrice);
  const created = Date.parse(position.creationTimestamp || "");
  const ageSeconds = Number.isFinite(created)
    ? Math.max(0, Math.round((Date.now() - created) / 1000))
    : null;
  const last = Number(quote.last);
  let unrealizedTicks = 0;
  if (Number.isFinite(averagePrice) && Number.isFinite(last) && size > 0) {
    const delta = last - averagePrice;
    unrealizedTicks = side === "short" ? -delta / tickSize : delta / tickSize;
  }
  return {
    side,
    size,
    average_price: Number.isFinite(averagePrice) ? averagePrice : null,
    unrealized_pnl_usd: Number((unrealizedTicks * tickValue * size).toFixed(2)),
    unrealized_pnl_ticks: Number(unrealizedTicks.toFixed(2)),
    age_seconds: ageSeconds,
    creation_timestamp: position.creationTimestamp ?? null,
  };
}

export function mapWorkingOrders(orders, contractId) {
  return (orders || [])
    .filter((order) => !contractId || order.contractId === contractId)
    .map((order) => ({
      id: order.id,
      status: ORDER_STATUS[order.status] ?? String(order.status),
      type: ORDER_TYPE[order.type] ?? String(order.type),
      side: ORDER_SIDE[order.side] ?? String(order.side),
      size: Number(order.size) || 0,
      limit_price: order.limitPrice == null ? null : Number(order.limitPrice),
      stop_price: order.stopPrice == null ? null : Number(order.stopPrice),
      filled_price: order.filledPrice == null ? null : Number(order.filledPrice),
      custom_tag: order.customTag ?? null,
      updated_timestamp: order.updateTimestamp ?? order.creationTimestamp ?? null,
    }));
}

export function buildEnrichedMarket({
  contract,
  bars1m,
  bars5m,
  bars15s,
  realtime,
  config,
  correlation = null,
}) {
  const tickSize = Number(contract.tickSize) || 0.25;
  const normalized1m = compactBars(normalizeBars(bars1m), config.bars1mLimit);
  const normalized5m = compactBars(normalizeBars(bars5m), config.bars5mLimit);
  const normalized15s = bars15s
    ? compactBars(normalizeBars(bars15s), config.bars15sLimit)
    : [];

  const quote = deriveQuoteFromBars(contract, normalized1m, realtime?.getQuoteSnapshot?.());
  const features = buildMarketFeatures({
    bars1m: normalized1m,
    bars5m: normalized5m,
    quote,
    tickSize,
  });
  const levels = buildStructuralLevels({
    bars1m: normalized1m,
    bars5m: normalized5m,
    features,
    quote,
  });

  return {
    snapshot_hash: null,
    quote_timestamp: quote.quote_timestamp,
    last: quote.last,
    bid: quote.bid,
    ask: quote.ask,
    spread_ticks: features.spread_ticks ?? quote.spread_ticks,
    session_open: quote.session_open,
    session_high: quote.session_high,
    session_low: quote.session_low,
    volume: quote.volume,
    quote: {
      last: quote.last,
      bid: quote.bid,
      ask: quote.ask,
      change: quote.change,
      change_percent: quote.change_percent,
      source: quote.source,
    },
    session: {
      open: quote.session_open,
      high: quote.session_high,
      low: quote.session_low,
      range_pts: features.session_range_pts,
      position_in_range: features.position_in_range,
    },
    bars_1m: normalized1m,
    bars_5m: normalized5m,
    bars_15s: normalized15s,
    features,
    levels,
    correlation,
    structure: {
      bars_1m: summarizeBars(normalized1m),
      bars_5m: summarizeBars(normalized5m),
      bars_15s: normalized15s.length ? summarizeBars(normalized15s) : null,
    },
    realtime: realtime
      ? {
          status: realtime.status,
          tape: realtime.getTape(config.realtimeTapeLimit),
          depth_top: realtime.getDepthTop(config.realtimeDepthLimit),
        }
      : { status: { enabled: false }, tape: [], depth_top: [] },
  };
}

export { isRthOpenWindow };
