import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const statePath = path.join(root, "data", "session-policy.json");

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function readState() {
  try {
    if (!fs.existsSync(statePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function summarizeTrades(trades) {
  const active = (trades || []).filter((trade) => !trade.voided);
  let realized = 0;
  let fees = 0;
  let closed = 0;
  let consecutiveLosses = 0;
  let lastTrade = null;
  const closedTrades = [];
  for (const trade of active) {
    fees += Number(trade.fees) || 0;
    if (trade.profitAndLoss != null) {
      const pnl = Number(trade.profitAndLoss) || 0;
      realized += pnl;
      closed += 1;
      closedTrades.push({ pnl, timestamp: trade.creationTimestamp });
    }
    if (!lastTrade || String(trade.creationTimestamp) > String(lastTrade.creationTimestamp)) {
      lastTrade = trade;
    }
  }
  closedTrades.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  for (const trade of closedTrades) {
    if (trade.pnl < 0) {
      consecutiveLosses += 1;
    } else {
      break;
    }
  }
  return {
    trades_count: active.length,
    closed_trades: closed,
    realized_pnl_usd: Number(realized.toFixed(2)),
    fees_usd: Number(fees.toFixed(2)),
    net_pnl_usd: Number((realized - fees).toFixed(2)),
    consecutive_losses: consecutiveLosses,
    last_trade: lastTrade
      ? {
          price: Number(lastTrade.price),
          side: lastTrade.side,
          size: Number(lastTrade.size),
          profit_and_loss:
            lastTrade.profitAndLoss == null ? null : Number(lastTrade.profitAndLoss),
          fees: Number(lastTrade.fees) || 0,
          timestamp: lastTrade.creationTimestamp,
        }
      : null,
  };
}

export function buildSessionPolicy({
  account,
  tradesSummary,
  config,
  now = new Date(),
}) {
  const balance = Number(account.balance) || config.policyAccountSize;
  const initialMaxLoss = Number(config.policyInitialMaxLoss) || 2000;
  const liquidationFloor = balance - initialMaxLoss;
  const state = readState();
  const dayKey = utcDayKey(now);
  const dayState = state[dayKey] || {};
  const openingBalance = dayState.opening_balance ?? balance;
  if (!dayState.opening_balance) {
    dayState.opening_balance = openingBalance;
    dayState.updated_utc = now.toISOString();
    state[dayKey] = dayState;
    writeState(state);
  }

  const highestEod = Math.max(
    Number(config.policyAccountSize) || balance,
    Number(dayState.highest_balance) || openingBalance,
    balance,
  );
  dayState.highest_balance = highestEod;
  dayState.updated_utc = now.toISOString();
  state[dayKey] = dayState;
  writeState(state);

  const dailyLossLimit = Number(config.policyDailyLossLimitUsd) || 1000;
  const realizedToday = tradesSummary?.net_pnl_usd ?? 0;
  const dailyLossRemaining = Math.max(0, dailyLossLimit + Math.min(0, realizedToday));
  const bufferToLiquidation = Math.max(0, balance - liquidationFloor);
  const consecutiveLosses = tradesSummary?.consecutive_losses ?? 0;
  const lossCooldown = consecutiveLosses >= 3;

  return {
    program: "xfa",
    account_size: Number(config.policyAccountSize) || balance,
    initial_max_loss: initialMaxLoss,
    highest_end_of_day_balance: highestEod,
    liquidation_floor: liquidationFloor,
    current_buffer: bufferToLiquidation,
    allowed_risk_usd: Number(config.policyAllowedRiskUsd) || 50,
    max_contracts: Number(config.policyMaxContracts) || 5,
    entry_window_open: Boolean(account.canTrade),
    daily_loss_limit_usd: dailyLossLimit,
    daily_realized_pnl_usd: realizedToday,
    daily_loss_remaining_usd: Number(dailyLossRemaining.toFixed(2)),
    trades_today: tradesSummary?.trades_count ?? 0,
    closed_trades_today: tradesSummary?.closed_trades ?? 0,
    consecutive_losses: consecutiveLosses,
    entry_cooldown_after_losses: lossCooldown,
    opening_balance_today: openingBalance,
    buffer_to_liquidation_usd: Number(bufferToLiquidation.toFixed(2)),
  };
}
