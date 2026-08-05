import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { SnapshotDataQuality } from "../state/data-quality.js";

export interface StreamHealthPacket {
  quote_age_ms: number | null;
  last_trade_age_ms: number | null;
  trade_count_60s: number | null;
  reconnect_pending: boolean;
  notes: string[];
}

function ageMilliseconds(timestamp: string | null | undefined, now: Date): number | null {
  if (!timestamp) {
    return null;
  }
  const epochMs = Date.parse(timestamp);
  return Number.isFinite(epochMs) ? now.getTime() - epochMs : null;
}

function tradeCount60s(orderFlow: ProjectXOrderFlowState): number | null {
  const observation = orderFlow.observation;
  if (!observation) {
    return null;
  }
  const window = observation.windows.find((item) => item.window_seconds === 60);
  return window?.trade_count ?? null;
}

export function buildStreamHealthPacket(
  quality: SnapshotDataQuality,
  orderFlow: ProjectXOrderFlowState,
  marketStreamState: string,
  userStreamState: string,
  now = new Date(),
): StreamHealthPacket {
  const notes = ["stream_health mirrors data_quality and order_flow; not a cognition gate."];
  const trade_count_60s = tradeCount60s(orderFlow);
  const lastTradeUtc = orderFlow.observation?.last_trade_utc ?? null;
  const last_trade_age_ms = ageMilliseconds(lastTradeUtc, now);
  if (orderFlow.last_error) {
    notes.push(`order_flow.last_error=${orderFlow.last_error}`);
  }
  if (trade_count_60s === null) {
    notes.push("trade_count_60s unavailable until order_flow observation succeeds.");
  }
  if (last_trade_age_ms === null && trade_count_60s === 0) {
    notes.push("no trades in order_flow lookback windows.");
  }
  const reconnect_pending = marketStreamState === "reconnecting"
    || userStreamState === "reconnecting";
  if (reconnect_pending) {
    notes.push(`streams reconnecting: market=${marketStreamState} user=${userStreamState}`);
  }
  return {
    quote_age_ms: quality.quoteAgeMs,
    last_trade_age_ms,
    trade_count_60s,
    reconnect_pending,
    notes,
  };
}
