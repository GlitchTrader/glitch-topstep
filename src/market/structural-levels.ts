import type { MarketObservationState } from "../domain/market-observation.js";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";

export interface StructuralLevel {
  kind: string;
  label: string;
  price: number;
  provenance: string;
}

export interface StructuralLevelsPacket {
  schema_version: "glitch.topstep.structural_levels.v1";
  generated_utc: string;
  levels: StructuralLevel[];
}

function timeframe(
  observation: MarketObservationState,
  minutes: number,
) {
  return observation.observation?.timeframes?.find(
    (row) => row.timeframe_minutes === minutes,
  ) ?? null;
}

export function buildStructuralLevels(input: {
  generatedUtc: string;
  sessionHigh: number | null;
  sessionLow: number | null;
  sessionOpen: number | null;
  sessionLevelsReliable: boolean;
  marketObservation: MarketObservationState;
  orderFlow: ProjectXOrderFlowState;
}): StructuralLevelsPacket {
  const levels: StructuralLevel[] = [];

  if (input.sessionLevelsReliable && input.sessionHigh !== null) {
    levels.push({
      kind: "session_high",
      label: "session_high",
      price: input.sessionHigh,
      provenance: "market.session_high",
    });
  }
  if (input.sessionLevelsReliable && input.sessionLow !== null) {
    levels.push({
      kind: "session_low",
      label: "session_low",
      price: input.sessionLow,
      provenance: "market.session_low",
    });
  }
  if (input.sessionLevelsReliable && input.sessionOpen !== null) {
    levels.push({
      kind: "session_open",
      label: "session_open",
      price: input.sessionOpen,
      provenance: "market.session_open",
    });
  }

  const tf5 = timeframe(input.marketObservation, 5);
  const tf15 = timeframe(input.marketObservation, 15);
  const tf60 = timeframe(input.marketObservation, 60);

  const vwap5 = tf5?.features?.rolling_vwap_20 ?? null;
  if (vwap5 !== null) {
    levels.push({
      kind: "vwap",
      label: "rolling_vwap_20_5m",
      price: vwap5,
      provenance: "market_observation.5m.features.rolling_vwap_20",
    });
  }

  const partial5 = tf5?.current_partial_bar;
  if (partial5) {
    levels.push({
      kind: "swing",
      label: "partial_bar_high_5m",
      price: partial5.high,
      provenance: "market_observation.5m.current_partial_bar.high",
    });
    levels.push({
      kind: "swing",
      label: "partial_bar_low_5m",
      price: partial5.low,
      provenance: "market_observation.5m.current_partial_bar.low",
    });
  }
  const prior5 = tf5?.prior_completed_bar;
  if (prior5) {
    levels.push({
      kind: "swing",
      label: "prior_completed_high_5m",
      price: prior5.high,
      provenance: "market_observation.5m.prior_completed_bar.high",
    });
    levels.push({
      kind: "swing",
      label: "prior_completed_low_5m",
      price: prior5.low,
      provenance: "market_observation.5m.prior_completed_bar.low",
    });
  }

  const flow60 = input.orderFlow.observation?.windows?.find((row) => row.window_seconds === 60);
  if (flow60?.high_price !== null && flow60?.high_price !== undefined) {
    levels.push({
      kind: "range",
      label: "tape_high_60s",
      price: flow60.high_price,
      provenance: "order_flow.observation.windows.60.high_price",
    });
  }
  if (flow60?.low_price !== null && flow60?.low_price !== undefined) {
    levels.push({
      kind: "range",
      label: "tape_low_60s",
      price: flow60.low_price,
      provenance: "order_flow.observation.windows.60.low_price",
    });
  }

  const ema200 = tf60?.features?.ema_200 ?? null;
  if (ema200 !== null) {
    levels.push({
      kind: "location",
      label: "ema_200_60m",
      price: ema200,
      provenance: "market_observation.60m.features.ema_200",
    });
  }

  const rangeClose15 = tf15?.features?.latest_close ?? null;
  if (rangeClose15 !== null) {
    levels.push({
      kind: "range",
      label: "structure_anchor_15m_close",
      price: rangeClose15,
      provenance: "market_observation.15m.features.latest_close",
    });
  }

  return {
    schema_version: "glitch.topstep.structural_levels.v1",
    generated_utc: input.generatedUtc,
    levels,
  };
}
