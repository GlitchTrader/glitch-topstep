import type {
  RiskSettings,
  TopstepPolicyState,
  TopstepProgram,
  TradingMode,
} from "./domain/models.js";

export interface AppConfig {
  projectX: {
    username: string;
    apiKey: string;
    apiUrl: string;
    userHubUrl: string;
    marketHubUrl: string;
  };
  scope: {
    accountId: number;
    accountName: string;
    contractId: string;
    instrument: string;
    liveMarketData: boolean;
  };
  localGateway: {
    host: string;
    port: number;
    token: string;
  };
  tradingMode: TradingMode;
  requireSimulatedAccount: boolean;
  policy: TopstepPolicyState;
  risk: RiskSettings;
  dataDir: string;
  reconcileIntervalMs: number;
  packetLeaseMs: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`missing_environment_variable:${name}`);
  }
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return environment[name]?.trim() || fallback;
}

function numberValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number | undefined,
  predicate: (value: number) => boolean,
): number {
  const raw = environment[name]?.trim();
  if (!raw && fallback !== undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !predicate(value)) {
    throw new Error(`invalid_environment_number:${name}`);
  }
  return value;
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`invalid_environment_boolean:${name}`);
}

function enumValue<T extends string>(
  environment: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = (environment[name]?.trim() || fallback) as T;
  if (!allowed.includes(raw)) {
    throw new Error(`invalid_environment_enum:${name}`);
  }
  return raw;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const tradingMode = enumValue<TradingMode>(
    environment,
    "GLITCH_TRADING_MODE",
    ["disabled", "shadow", "armed"],
    "shadow",
  );
  const program = enumValue<TopstepProgram>(
    environment,
    "GLITCH_PROGRAM",
    ["combine", "xfa"],
    "xfa",
  );
  const localToken = required(environment, "GLITCH_LOCAL_TOKEN");
  if (localToken.length < 24) {
    throw new Error("GLITCH_LOCAL_TOKEN must contain at least 24 characters");
  }
  if (
    tradingMode === "armed"
    && environment.GLITCH_ARMED_ACK !== "I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY"
  ) {
    throw new Error("armed_mode_requires_explicit_scaffold_acknowledgement");
  }

  return {
    projectX: {
      username: required(environment, "PROJECTX_USERNAME"),
      apiKey: required(environment, "PROJECTX_API_KEY"),
      apiUrl: optional(environment, "PROJECTX_API_URL", "https://api.topstepx.com").replace(/\/$/, ""),
      userHubUrl: optional(environment, "PROJECTX_USER_HUB_URL", "https://rtc.topstepx.com/hubs/user"),
      marketHubUrl: optional(environment, "PROJECTX_MARKET_HUB_URL", "https://rtc.topstepx.com/hubs/market"),
    },
    scope: {
      accountId: numberValue(environment, "GLITCH_ACCOUNT_ID", undefined, (value) => Number.isInteger(value) && value > 0),
      accountName: required(environment, "GLITCH_ACCOUNT_NAME"),
      contractId: required(environment, "GLITCH_CONTRACT_ID"),
      instrument: optional(environment, "GLITCH_INSTRUMENT", "MNQ").toUpperCase(),
      liveMarketData: booleanValue(environment, "GLITCH_LIVE_MARKET_DATA", false),
    },
    localGateway: {
      host: optional(environment, "GLITCH_LOCAL_HOST", "127.0.0.1"),
      port: numberValue(environment, "GLITCH_LOCAL_PORT", 8790, (value) => Number.isInteger(value) && value >= 1024 && value <= 65_535),
      token: localToken,
    },
    tradingMode,
    requireSimulatedAccount: booleanValue(environment, "GLITCH_REQUIRE_SIMULATED", true),
    policy: {
      program,
      accountSize: numberValue(environment, "GLITCH_ACCOUNT_SIZE", 50_000, (value) => value > 0),
      initialMaxLoss: numberValue(environment, "GLITCH_INITIAL_MAX_LOSS", 2_000, (value) => value > 0),
      highestEndOfDayBalance: numberValue(environment, "GLITCH_HIGHEST_EOD_BALANCE", 0, () => true),
      mllLockedAtZero: booleanValue(environment, "GLITCH_MLL_LOCKED_AT_ZERO", false),
      payoutProcessed: booleanValue(environment, "GLITCH_PAYOUT_PROCESSED", false),
      maxContracts: numberValue(environment, "GLITCH_MAX_CONTRACTS", 1, (value) => Number.isInteger(value) && value > 0),
      maxDailyRiskUsd: numberValue(environment, "GLITCH_MAX_DAILY_RISK_USD", 200, (value) => value >= 0),
      dailyRealizedPnlUsd: numberValue(environment, "GLITCH_DAILY_REALIZED_PNL_USD", 0, () => true),
      entryWindowOpen: booleanValue(environment, "GLITCH_ENTRY_WINDOW_OPEN", false),
    },
    risk: {
      maxRiskFractionOfBuffer: numberValue(environment, "GLITCH_MAX_RISK_FRACTION_OF_BUFFER", 0.04, (value) => value > 0 && value <= 1),
      estimatedRoundTurnFeesUsd: numberValue(environment, "GLITCH_ESTIMATED_ROUND_TURN_FEES_USD", 2.5, (value) => value >= 0),
      slippageReserveTicks: numberValue(environment, "GLITCH_SLIPPAGE_RESERVE_TICKS", 2, (value) => Number.isInteger(value) && value >= 0),
      maxQuoteAgeMs: numberValue(environment, "GLITCH_MAX_QUOTE_AGE_MS", 5_000, (value) => Number.isInteger(value) && value > 0),
      maxStateAgeMs: numberValue(environment, "GLITCH_MAX_STATE_AGE_MS", 5_000, (value) => Number.isInteger(value) && value > 0),
      maxIntentAgeMs: numberValue(environment, "GLITCH_MAX_INTENT_AGE_MS", 60_000, (value) => Number.isInteger(value) && value > 0),
    },
    dataDir: optional(environment, "GLITCH_DATA_DIR", "./data"),
    reconcileIntervalMs: numberValue(environment, "GLITCH_RECONCILE_INTERVAL_MS", 3_000, (value) => Number.isInteger(value) && value >= 1_000),
    packetLeaseMs: numberValue(environment, "GLITCH_PACKET_LEASE_MS", 60_000, (value) => Number.isInteger(value) && value >= 1_000),
  };
}
