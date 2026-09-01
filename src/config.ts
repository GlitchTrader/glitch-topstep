import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RiskSettings,
  TopstepLossModel,
  TopstepPolicyAuthority,
  TopstepPolicyState,
  TradingMode,
} from "./domain/models.js";
import {
  assertValidSessionTimezone,
  parseSessionLocalTime,
  type TopstepSessionConfig,
} from "./policy/session-calendar.js";
import type { DailyEconomicsConfig } from "./policy/daily-economics.js";

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
    operatorToken?: string;
    ownership?: {
      executionDatabasePath: string;
      evidenceDatabasePath: string;
      accountId: number;
      accountName: string;
      contractId: string;
      instrument: string;
    };
  };
  tradingMode: TradingMode;
  policy: TopstepPolicyState;
  session: TopstepSessionConfig;
  dailyEconomics: DailyEconomicsConfig;
  multiInstrument?: {
    allowlist: string[];
    rolloverGeneration: number;
    simultaneousExposureEnabled: boolean;
    depthAllowlist: string[];
    historyRequestsPerMinute: number;
  };
  risk: RiskSettings;
  providerEvidence: {
    marketEventRetention: number;
    marketPruneInterval: number;
  };
  providerHistory?: {
    initialLookbackHours: number;
    overlapMinutes: number;
    windowMinutes: number;
    syncIntervalMs: number;
  };
  dataDir: string;
  outcomesExportPath?: string;
  reconcileIntervalMs: number;
  packetLeaseMs: number;
  entrySubmissionLatchStaleMs: number;
  streamLivenessMs?: number;
}

const NUMERIC_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/** Parse the small, dependency-free .env dialect used by the gateway. */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = assignment.slice(separator + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function loadDotEnvIntoProcess(): void {
  try {
    const values = parseDotEnv(readFileSync(join(process.cwd(), ".env"), "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

function loopbackHost(environment: NodeJS.ProcessEnv): string {
  const host = optional(environment, "GLITCH_LOCAL_HOST", "127.0.0.1").toLowerCase();
  if (!NUMERIC_LOOPBACK_HOSTS.has(host)) {
    throw new Error("GLITCH_LOCAL_HOST must be the numeric loopback address 127.0.0.1 or ::1");
  }
  return host;
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

function nullableNumberValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  predicate: (value: number) => boolean,
): number | null {
  const raw = environment[name]?.trim();
  if (!raw) {
    return null;
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
  fallback?: T,
): T {
  const raw = (environment[name]?.trim() || fallback) as T | undefined;
  if (!raw) {
    throw new Error(`missing_environment_variable:${name}`);
  }
  if (!allowed.includes(raw)) {
    throw new Error(`invalid_environment_enum:${name}`);
  }
  return raw;
}

function optionalUtc(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim() || null;
  if (!value) {
    return null;
  }
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid_environment_datetime:${name}`);
  }
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  if (environment === process.env) loadDotEnvIntoProcess();
  const tradingMode = enumValue<TradingMode>(
    environment,
    "GLITCH_TRADING_MODE",
    ["disabled", "shadow", "armed"],
    "shadow",
  );
  const lossModel = enumValue<TopstepLossModel>(
    environment,
    "GLITCH_LOSS_MODEL",
    ["trading_combine_eod", "express_funded_eod", "operator_provided_floor"],
  );
  const policyAuthority = enumValue<TopstepPolicyAuthority>(
    environment,
    "GLITCH_POLICY_AUTHORITY",
    ["operator_configured", "provider_reconciled"],
    "operator_configured",
  );
  const localToken = required(environment, "GLITCH_LOCAL_TOKEN");
  if (localToken.length < 24) {
    throw new Error("GLITCH_LOCAL_TOKEN must contain at least 24 characters");
  }
  const operatorToken = required(environment, "GLITCH_OPERATOR_TOKEN");
  if (operatorToken.length < 24 || operatorToken === localToken) {
    throw new Error("GLITCH_OPERATOR_TOKEN must be a distinct value of at least 24 characters");
  }
  if (
    tradingMode === "armed"
    && environment.GLITCH_ARMED_ACK !== "I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY"
  ) {
    throw new Error("armed_mode_requires_explicit_scaffold_acknowledgement");
  }

  const startingBalance = numberValue(environment, "GLITCH_STARTING_BALANCE", 50_000, (value) => value > 0);
  const operatorProvidedLossFloorUsd = nullableNumberValue(
    environment,
    "GLITCH_HARD_LOSS_FLOOR_USD",
    Number.isFinite,
  );
  if (lossModel === "operator_provided_floor") {
    if (operatorProvidedLossFloorUsd === null) {
      throw new Error("GLITCH_HARD_LOSS_FLOOR_USD is required for operator_provided_floor");
    }
    if (!Number.isFinite(operatorProvidedLossFloorUsd)) {
      throw new Error("GLITCH_HARD_LOSS_FLOOR_USD must be finite");
    }
    if (operatorProvidedLossFloorUsd <= 0) {
      throw new Error("GLITCH_HARD_LOSS_FLOOR_USD must be positive");
    }
    if (operatorProvidedLossFloorUsd >= startingBalance) {
      throw new Error("GLITCH_HARD_LOSS_FLOOR_USD must be below GLITCH_STARTING_BALANCE");
    }
  }

  const marketEventRetention = numberValue(
    environment,
    "GLITCH_PROVIDER_MARKET_EVENT_RETENTION",
    500_000,
    (value) => Number.isInteger(value) && value >= 10_000 && value <= 50_000_000,
  );
  const marketPruneInterval = numberValue(
    environment,
    "GLITCH_PROVIDER_MARKET_PRUNE_INTERVAL",
    10_000,
    (value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000,
  );
  if (marketPruneInterval > marketEventRetention) {
    throw new Error("GLITCH_PROVIDER_MARKET_PRUNE_INTERVAL cannot exceed retention");
  }

  const accountId = numberValue(
    environment,
    "GLITCH_ACCOUNT_ID",
    undefined,
    (value) => Number.isInteger(value) && value > 0,
  );
  const accountName = required(environment, "GLITCH_ACCOUNT_NAME");
  const contractId = required(environment, "GLITCH_CONTRACT_ID");
  const instrument = required(environment, "GLITCH_INSTRUMENT").toUpperCase();
  const dataDir = optional(environment, "GLITCH_DATA_DIR", "./data");

  const initialLookbackHours = numberValue(
    environment,
    "GLITCH_PROVIDER_HISTORY_INITIAL_LOOKBACK_HOURS",
    168,
    (value) => Number.isInteger(value) && value >= 1 && value <= 8_760,
  );
  const overlapMinutes = numberValue(
    environment,
    "GLITCH_PROVIDER_HISTORY_OVERLAP_MINUTES",
    1_440,
    (value) => Number.isInteger(value) && value >= 1 && value <= 1_440,
  );
  const windowMinutes = numberValue(
    environment,
    "GLITCH_PROVIDER_HISTORY_WINDOW_MINUTES",
    1_440,
    (value) => Number.isInteger(value) && value >= 5 && value <= 10_080,
  );
  const syncIntervalMs = numberValue(
    environment,
    "GLITCH_PROVIDER_HISTORY_SYNC_INTERVAL_MS",
    60_000,
    (value) => Number.isInteger(value) && value >= 30_000 && value <= 86_400_000,
  );

  const sessionTimezone = optional(environment, "GLITCH_SESSION_TIMEZONE", "America/Chicago");
  assertValidSessionTimezone(sessionTimezone);
  const mustFlatLocalTime = environment.GLITCH_SESSION_MUST_FLAT_LOCAL_TIME?.trim() || null;
  if (mustFlatLocalTime) {
    parseSessionLocalTime(mustFlatLocalTime);
  }
  const entryOpenLocalTime = environment.GLITCH_SESSION_ENTRY_OPEN_LOCAL_TIME?.trim() || null;
  if (entryOpenLocalTime) {
    parseSessionLocalTime(entryOpenLocalTime);
  }
  const sessionAuthority = enumValue(
    environment,
    "GLITCH_SESSION_AUTHORITY",
    ["operator_configured", "topstep_verified"],
    "operator_configured",
  );
  const tradingDayResetLocalTime = optional(
    environment,
    "GLITCH_TRADING_DAY_RESET_LOCAL_TIME",
    "17:00",
  );
  parseSessionLocalTime(tradingDayResetLocalTime);
  const phaseCalendarEnabled = booleanValue(environment, "GLITCH_SESSION_PHASE_CALENDAR", true);
  const maintenanceStartLocalTime = phaseCalendarEnabled
    ? optional(environment, "GLITCH_SESSION_MAINTENANCE_START_LOCAL_TIME", "16:00")
    : null;
  const maintenanceEndLocalTime = phaseCalendarEnabled
    ? optional(environment, "GLITCH_SESSION_MAINTENANCE_END_LOCAL_TIME", "17:00")
    : null;
  if (maintenanceStartLocalTime) {
    parseSessionLocalTime(maintenanceStartLocalTime);
  }
  if (maintenanceEndLocalTime) {
    parseSessionLocalTime(maintenanceEndLocalTime);
  }
  const asiaStartLocalTime = environment.GLITCH_SESSION_ASIA_START_LOCAL_TIME?.trim() || null;
  const asiaEndLocalTime = environment.GLITCH_SESSION_ASIA_END_LOCAL_TIME?.trim() || null;
  if (asiaStartLocalTime) {
    parseSessionLocalTime(asiaStartLocalTime);
  }
  if (asiaEndLocalTime) {
    parseSessionLocalTime(asiaEndLocalTime);
  }
  const dailyEconomicsEnabled = booleanValue(environment, "GLITCH_DAILY_ECONOMICS", true);
  const nominalSizeUsd = nullableNumberValue(
    environment,
    "GLITCH_NOMINAL_SIZE_USD",
    (value) => value > 0,
  );
  const profitTargetUsd = nullableNumberValue(
    environment,
    "GLITCH_PROFIT_TARGET_USD",
    (value) => value > 0,
  );

  return {
    projectX: {
      username: required(environment, "PROJECTX_USERNAME"),
      apiKey: required(environment, "PROJECTX_API_KEY"),
      apiUrl: optional(environment, "PROJECTX_API_URL", "https://api.topstepx.com").replace(/\/$/, ""),
      userHubUrl: optional(environment, "PROJECTX_USER_HUB_URL", "https://rtc.topstepx.com/hubs/user"),
      marketHubUrl: optional(environment, "PROJECTX_MARKET_HUB_URL", "https://rtc.topstepx.com/hubs/market"),
    },
    scope: {
      accountId,
      accountName,
      contractId,
      instrument,
      liveMarketData: booleanValue(environment, "GLITCH_LIVE_MARKET_DATA", false),
    },
    localGateway: {
      host: loopbackHost(environment),
      port: numberValue(
        environment,
        "GLITCH_LOCAL_PORT",
        8790,
        (value) => Number.isInteger(value) && value >= 1024 && value <= 65_535,
      ),
      token: localToken,
      operatorToken,
      ownership: {
        executionDatabasePath: join(dataDir, "glitch-topstep.sqlite"),
        evidenceDatabasePath: join(dataDir, "projectx-evidence.sqlite"),
        accountId,
        accountName,
        contractId,
        instrument,
      },
    },
    tradingMode,
    policy: {
      accountStage: optional(environment, "GLITCH_ACCOUNT_STAGE", "unknown"),
      lossModel,
      authority: policyAuthority,
      verifiedAtUtc: optionalUtc(environment, "GLITCH_POLICY_VERIFIED_AT_UTC"),
      startingBalance,
      initialMaximumLoss: numberValue(environment, "GLITCH_INITIAL_MAXIMUM_LOSS", 2_000, (value) => value > 0),
      highestEndOfDayBalance: numberValue(environment, "GLITCH_HIGHEST_EOD_BALANCE", 0, Number.isFinite),
      lossFloorLockedAtZero: booleanValue(environment, "GLITCH_LOSS_FLOOR_LOCKED_AT_ZERO", false),
      payoutProcessed: booleanValue(environment, "GLITCH_PAYOUT_PROCESSED", false),
      operatorProvidedLossFloorUsd,
      maxContracts: numberValue(environment, "GLITCH_MAX_CONTRACTS", 1, (value) => Number.isInteger(value) && value > 0),
    },
    session: {
      authority: sessionAuthority,
      timezone: sessionTimezone,
      tradingDayResetLocalTime,
      mustFlatLocalTime,
      entryOpenLocalTime,
      phaseCalendarEnabled,
      maintenanceStartLocalTime,
      maintenanceEndLocalTime,
      asiaStartLocalTime,
      asiaEndLocalTime,
      notes: [],
    },
    dailyEconomics: {
      enabled: dailyEconomicsEnabled,
      nominalSizeUsd,
      profitTargetUsd,
      objectiveRatePct: numberValue(
        environment,
        "GLITCH_DAILY_CAPTURE_OBJECTIVE_PCT",
        0.5,
        (value) => value > 0 && value <= 100,
      ),
      lockNewExposureOnReached: booleanValue(
        environment,
        "GLITCH_DAILY_CAPTURE_LOCK_ENABLED",
        true,
      ),
    },
    multiInstrument: {
      allowlist: optional(environment, "GLITCH_INSTRUMENT_ALLOWLIST", instrument)
        .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean),
      rolloverGeneration: numberValue(
        environment,
        "GLITCH_INSTRUMENT_ROLLOVER_GENERATION",
        1,
        (value) => Number.isInteger(value) && value >= 1,
      ),
      simultaneousExposureEnabled: booleanValue(
        environment,
        "GLITCH_SIMULTANEOUS_EXPOSURE_ENABLED",
        false,
      ),
      depthAllowlist: optional(environment, "GLITCH_DEPTH_ALLOWLIST", instrument)
        .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean),
      historyRequestsPerMinute: numberValue(
        environment,
        "GLITCH_HISTORY_REQUESTS_PER_MINUTE",
        30,
        (value) => Number.isInteger(value) && value >= 1 && value <= 60,
      ),
    },
    risk: {
      estimatedRoundTurnFeesUsd: numberValue(environment, "GLITCH_ESTIMATED_ROUND_TURN_FEES_USD", 2.5, (value) => value >= 0),
      slippageReserveTicks: numberValue(environment, "GLITCH_SLIPPAGE_RESERVE_TICKS", 2, (value) => Number.isInteger(value) && value >= 0),
      maxQuoteAgeMs: numberValue(environment, "GLITCH_MAX_QUOTE_AGE_MS", 5_000, (value) => Number.isInteger(value) && value > 0),
      maxStateAgeMs: numberValue(environment, "GLITCH_MAX_STATE_AGE_MS", 15_000, (value) => Number.isInteger(value) && value > 0),
      maxIntentAgeMs: numberValue(environment, "GLITCH_MAX_INTENT_AGE_MS", 300_000, (value) => Number.isInteger(value) && value > 0),
    },
    providerEvidence: {
      marketEventRetention,
      marketPruneInterval,
    },
    providerHistory: {
      initialLookbackHours,
      overlapMinutes,
      windowMinutes,
      syncIntervalMs,
    },
    dataDir,
    outcomesExportPath: optional(environment, "GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH", "").trim() || undefined,
    reconcileIntervalMs: numberValue(environment, "GLITCH_RECONCILE_INTERVAL_MS", 3_000, (value) => Number.isInteger(value) && value >= 1_000),
    packetLeaseMs: numberValue(environment, "GLITCH_PACKET_LEASE_MS", 300_000, (value) => Number.isInteger(value) && value >= 1_000),
    entrySubmissionLatchStaleMs: numberValue(
      environment,
      "GLITCH_ENTRY_SUBMISSION_LATCH_STALE_MS",
      300_000,
      (value) => Number.isInteger(value) && value >= 60_000,
    ),
    streamLivenessMs: numberValue(
      environment,
      "GLITCH_STREAM_LIVENESS_MS",
      15_000,
      (value) => Number.isInteger(value) && value >= 5_000,
    ),
  };
}
