import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, loadCredential, loadEnvFile } from "./env.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnvFile(path.join(root, ".env"));

const localToken = loadCredential("GLITCH_TOPSTEP_LOCAL_TOKEN");
if (!localToken) {
  throw new Error("GLITCH_TOPSTEP_LOCAL_TOKEN is required in .env");
}

function boolEnv(name, defaultValue = false) {
  const raw = envValue(name);
  if (raw == null || raw === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  host: envValue("GLITCH_TOPSTEP_HOST", "127.0.0.1"),
  port: Number(envValue("GLITCH_TOPSTEP_PORT", "8790")),
  localToken,
  tradingMode: envValue("GLITCH_TOPSTEP_TRADING_MODE", "shadow").toLowerCase(),
  instrument: envValue("GLITCH_TOPSTEP_INSTRUMENT", "MNQ").toUpperCase(),
  projectXApiUrl: envValue("PROJECT_X_API_URL", "https://api.topstepx.com"),
  projectXUsername: loadCredential("PROJECT_X_USERNAME", "PROJECT_X_USERNAME_FILE"),
  projectXApiKey: loadCredential("PROJECT_X_API_KEY", "PROJECT_X_API_KEY_FILE"),
  projectXAccountId: envValue("PROJECT_X_ACCOUNT_ID")
    ? Number(envValue("PROJECT_X_ACCOUNT_ID"))
    : null,
  projectXContractId: envValue("PROJECT_X_CONTRACT_ID") || null,
  projectXLiveData: boolEnv("PROJECT_X_LIVE_DATA", false),
  policyAccountSize: Number(envValue("GLITCH_TOPSTEP_ACCOUNT_SIZE", "50000")),
  policyInitialMaxLoss: Number(envValue("GLITCH_TOPSTEP_INITIAL_MAX_LOSS", "2000")),
  policyAllowedRiskUsd: Number(envValue("GLITCH_TOPSTEP_ALLOWED_RISK_USD", "50")),
  policyMaxContracts: Number(envValue("GLITCH_TOPSTEP_MAX_CONTRACTS", "5")),
  policyDailyLossLimitUsd: Number(envValue("GLITCH_TOPSTEP_DAILY_LOSS_LIMIT_USD", "1000")),
  sessionHistoryHours: Number(envValue("GLITCH_TOPSTEP_SESSION_HISTORY_HOURS", "8")),
  bars1mLimit: Number(envValue("GLITCH_TOPSTEP_BARS_1M_LIMIT", "60")),
  bars5mLimit: Number(envValue("GLITCH_TOPSTEP_BARS_5M_LIMIT", "12")),
  bars15sLimit: Number(envValue("GLITCH_TOPSTEP_BARS_15S_LIMIT", "80")),
  microBarsEnabled: boolEnv("GLITCH_TOPSTEP_MICRO_BARS_ENABLED", true),
  microBarsAlways: boolEnv("GLITCH_TOPSTEP_MICRO_BARS_ALWAYS", false),
  microBarsRthOnly: boolEnv("GLITCH_TOPSTEP_MICRO_BARS_RTH_ONLY", true),
  microBarsExtremeThreshold: Number(envValue("GLITCH_TOPSTEP_MICRO_BARS_EXTREME_THRESHOLD", "0.85")),
  realtimeEnabled: boolEnv("GLITCH_TOPSTEP_REALTIME_ENABLED", true),
  realtimeMarketHubUrl: envValue("PROJECT_X_RTC_MARKET_URL", "https://rtc.topstepx.com/hubs/market"),
  realtimeUserHubUrl: envValue("PROJECT_X_RTC_USER_URL", "https://rtc.topstepx.com/hubs/user"),
  realtimeTapeLimit: Number(envValue("GLITCH_TOPSTEP_REALTIME_TAPE_LIMIT", "40")),
  realtimeDepthLimit: Number(envValue("GLITCH_TOPSTEP_REALTIME_DEPTH_LIMIT", "10")),
  correlationSymbol: envValue("GLITCH_TOPSTEP_CORRELATION_SYMBOL", "ES").toUpperCase(),
  outcomesPath: envValue("GLITCH_TOPSTEP_OUTCOMES_PATH", ""),
};
