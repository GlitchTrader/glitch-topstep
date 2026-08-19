import type { TopstepPolicyState } from "../domain/models.js";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";
import {
  parseSessionLocalTime,
  resolveTradingDayId,
  tradingDayBoundsUtc,
  type TopstepSessionConfig,
} from "./session-calendar.js";

export type DailyEconomicsAuthority = "operator_configured" | "reconciled_trades" | null;

export interface DailyEconomicsConfig {
  enabled: boolean;
  nominalSizeUsd: number | null;
  profitTargetUsd: number | null;
  objectiveRatePct?: number;
  lockNewExposureOnReached?: boolean;
}

export interface DailyCaptureObjectivePacket {
  schema_version: "glitch.topstep.daily_capture.v1";
  objective_rate_pct: number;
  baseline_equity_usd: number;
  objective_usd: number;
  realized_progress_usd: number | null;
  remaining_usd: number | null;
  reached: boolean | null;
  new_exposure_lock_configured: boolean;
  reset_start_utc: string;
  reset_end_exclusive_utc: string;
  authority: "operator_configured" | "reconciled_trades";
  note: string;
}

export interface DailyEconomicsPacket {
  authority: DailyEconomicsAuthority;
  trading_day_id: string | null;
  nominal_size_usd: number | null;
  realized_pnl_usd: number | null;
  unrealized_pnl_usd: number | null;
  net_daily_pnl_usd: number | null;
  net_daily_pnl_pct: number | null;
  calibration_band_pct: { low: number; high: number };
  profit_target_usd: number | null;
  profit_target_remaining_usd: number | null;
  largest_winning_day_usd: number | null;
  consistency_pct_mirror: number | null;
  daily_capture: DailyCaptureObjectivePacket;
  notes: string[];
}

const CALIBRATION_BAND = Object.freeze({ low: 0.4, high: 2.0 });

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumRealizedForTradingDay(
  outcomes: readonly TradeOutcomeV1[],
  startUtc: string,
  endExclusiveUtc: string,
): number {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endExclusiveUtc);
  let sum = 0;
  for (const outcome of outcomes) {
    const exitMs = Date.parse(outcome.exit_utc);
    if (exitMs >= startMs && exitMs < endMs) {
      sum += outcome.realized_pnl_usd;
    }
  }
  return roundMoney(sum);
}

export function computeDailyEconomics(
  config: DailyEconomicsConfig,
  session: TopstepSessionConfig,
  policy: TopstepPolicyState,
  unrealizedPnlUsd: number,
  conservativeEquity: number,
  outcomes: readonly TradeOutcomeV1[],
  outcomesLoaded: boolean,
  now = new Date(),
): DailyEconomicsPacket | null {
  if (!config.enabled) {
    return null;
  }

  const resetLocalTime = session.tradingDayResetLocalTime ?? "17:00";
  const tradingDayId = resolveTradingDayId(now, session.timezone, resetLocalTime);
  const bounds = tradingDayBoundsUtc(tradingDayId, session.timezone, resetLocalTime);
  const nominalSizeUsd = config.nominalSizeUsd ?? policy.startingBalance;
  const objectiveRatePct = config.objectiveRatePct ?? 0.5;
  if (!Number.isFinite(objectiveRatePct) || objectiveRatePct <= 0 || objectiveRatePct > 100) {
    throw new Error("daily_capture_objective_rate_invalid");
  }
  const objectiveUsd = roundMoney(nominalSizeUsd * objectiveRatePct / 100);
  const captureBase = {
    schema_version: "glitch.topstep.daily_capture.v1" as const,
    objective_rate_pct: objectiveRatePct,
    baseline_equity_usd: nominalSizeUsd,
    objective_usd: objectiveUsd,
    new_exposure_lock_configured: config.lockNewExposureOnReached ?? true,
    reset_start_utc: bounds.startUtc,
    reset_end_exclusive_utc: bounds.endExclusiveUtc,
    note: "Context for disciplined participation; never a quota, direction, sizing formula, or promise of profit.",
  };
  const notes = [
    "mirrors are not Topstep dashboard authority",
    "daily_economics is cognition evidence only; Glitch does not gate ENTER_* on PnL bands",
  ];

  if (!outcomesLoaded) {
    notes.push("realized_pnl_usd unavailable until trade outcomes are loaded");
    return {
      authority: "operator_configured",
      trading_day_id: tradingDayId,
      nominal_size_usd: nominalSizeUsd,
      realized_pnl_usd: null,
      unrealized_pnl_usd: roundMoney(unrealizedPnlUsd),
      net_daily_pnl_usd: null,
      net_daily_pnl_pct: null,
      calibration_band_pct: { ...CALIBRATION_BAND },
      profit_target_usd: config.profitTargetUsd,
      profit_target_remaining_usd: config.profitTargetUsd === null
        ? null
        : roundMoney(Math.max(0, config.profitTargetUsd - (conservativeEquity - policy.startingBalance))),
      largest_winning_day_usd: null,
      consistency_pct_mirror: null,
      daily_capture: {
        ...captureBase,
        realized_progress_usd: null,
        remaining_usd: null,
        reached: null,
        authority: "operator_configured",
      },
      notes,
    };
  }

  const realizedPnlUsd = sumRealizedForTradingDay(outcomes, bounds.startUtc, bounds.endExclusiveUtc);
  const netDailyPnlUsd = roundMoney(realizedPnlUsd + unrealizedPnlUsd);
  const netDailyPnlPct = nominalSizeUsd > 0
    ? roundMoney((netDailyPnlUsd / nominalSizeUsd) * 100)
    : null;

  return {
    authority: "reconciled_trades",
    trading_day_id: tradingDayId,
    nominal_size_usd: nominalSizeUsd,
    realized_pnl_usd: realizedPnlUsd,
    unrealized_pnl_usd: roundMoney(unrealizedPnlUsd),
    net_daily_pnl_usd: netDailyPnlUsd,
    net_daily_pnl_pct: netDailyPnlPct,
    calibration_band_pct: { ...CALIBRATION_BAND },
    profit_target_usd: config.profitTargetUsd,
    profit_target_remaining_usd: config.profitTargetUsd === null
      ? null
      : roundMoney(Math.max(0, config.profitTargetUsd - (conservativeEquity - policy.startingBalance))),
    largest_winning_day_usd: null,
    consistency_pct_mirror: null,
    daily_capture: {
      ...captureBase,
      realized_progress_usd: realizedPnlUsd,
      remaining_usd: roundMoney(Math.max(0, objectiveUsd - realizedPnlUsd)),
      reached: realizedPnlUsd >= objectiveUsd,
      authority: "reconciled_trades",
    },
    notes,
  };
}
