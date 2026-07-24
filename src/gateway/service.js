import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { ProjectXClient } from "../projectx/client.js";
import * as shadow from "../shadow.js";
import { PACKET_SCHEMA } from "./constants.js";
import { buildCorrelationSummary, pickCorrelationContract } from "./correlation.js";
import {
  buildEnrichedMarket,
  mapPositionState,
  mapWorkingOrders,
  shouldFetchMicroBars,
} from "./enrichment.js";
import {
  getIdempotencyState,
  hasSubmission,
  markSubmission,
  recordSubmission,
} from "./idempotency.js";
import { syncOutcomes } from "./outcomes.js";
import { verifyProtection } from "./protection.js";
import {
  buildReconciliation,
  bumpConnectionGeneration,
  currentConnectionGeneration,
} from "./reconciliation.js";
import { RealtimeCache } from "./realtime.js";
import { buildSessionPolicy, summarizeTrades } from "./session-policy.js";
import { buildSetupCandidates } from "./setup.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const intentsPath = path.join(dataDir, "intents.jsonl");

const client = new ProjectXClient({
  apiUrl: config.projectXApiUrl,
  username: config.projectXUsername,
  apiKey: config.projectXApiKey,
});

const realtime = new RealtimeCache(client, config);

const runtime = {
  ready: false,
  mode: "shadow",
  lastError: null,
  account: null,
  contract: null,
  positions: [],
  openOrders: [],
  bars1m: [],
  bars5m: [],
  bars15s: [],
  trades: [],
  tradesSummary: null,
  correlationBars: [],
  correlation: null,
  lastRefreshAt: null,
};

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function minutePacketId(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${iso}Z`;
}

function snapshotHash(seed) {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function instrumentRoot(contract) {
  const symbolId = contract?.symbolId || "";
  const match = /F\.US\.([A-Z0-9]+)/.exec(symbolId);
  if (match) {
    return match[1].replace(/\d+$/, "");
  }
  const name = contract?.name || "";
  return name.replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase() || "MNQ";
}

function pickAccount(accounts) {
  if (!accounts.length) {
    throw new Error("No ProjectX accounts returned");
  }
  if (config.projectXAccountId) {
    const selected = accounts.find((item) => item.id === config.projectXAccountId);
    if (!selected) {
      throw new Error(`Configured account id ${config.projectXAccountId} was not found`);
    }
    return selected;
  }
  const preferred = accounts.find((item) => item.canTrade && item.isVisible);
  return preferred || accounts[0];
}

function pickContract(contracts) {
  if (config.projectXContractId) {
    const selected = contracts.find((item) => item.id === config.projectXContractId);
    if (!selected) {
      throw new Error(`Configured contract id ${config.projectXContractId} was not found`);
    }
    return selected;
  }
  const needle = config.instrument.toUpperCase();
  const active = contracts.filter((item) => item.activeContract);
  const exact = active.find(
    (item) =>
      item.symbolId?.toUpperCase().includes(needle) ||
      item.name?.toUpperCase().includes(needle) ||
      item.description?.toUpperCase().includes(needle),
  );
  if (!exact) {
    throw new Error(`No active ProjectX contract matched instrument ${needle}`);
  }
  return exact;
}

function positionForContract(positions, contractId) {
  return positions.find((item) => item.contractId === contractId) || null;
}

function openContractsFor(position) {
  if (!position) {
    return 0;
  }
  return Number(position.size) || 0;
}

function validEntryQuantities(policy, positioned) {
  if (positioned || !policy.entry_window_open || policy.entry_cooldown_after_losses) {
    return [];
  }
  const maxQty = Math.max(1, Math.min(policy.max_contracts, 2));
  return Array.from({ length: maxQty }, (_, index) => index + 1);
}

function buildMarketContext() {
  const market = buildEnrichedMarket({
    contract: runtime.contract,
    bars1m: runtime.bars1m,
    bars5m: runtime.bars5m,
    bars15s: runtime.bars15s,
    realtime,
    config,
    correlation: runtime.correlation,
  });
  return market;
}

async function fetchBars(contractId, { unit, unitNumber, limit, hours }) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
  return client.retrieveBars({
    contractId,
    live: config.projectXLiveData,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    unit,
    unitNumber,
    limit,
    includePartialBar: true,
  });
}

export function usesProjectX() {
  return client.configured;
}

export function getHealth() {
  return {
    status: runtime.ready || !client.configured ? "ok" : "degraded",
    trading_mode: config.tradingMode,
    operator_profile: "glitch-topstep",
    projectx_configured: client.configured,
    projectx_connected: runtime.ready,
    projectx_error: runtime.lastError,
    account: runtime.account?.name || null,
    contract: runtime.contract?.name || null,
    packet_schema: PACKET_SCHEMA,
    connection_generation: currentConnectionGeneration(),
    realtime: realtime.status,
    last_refresh_utc: runtime.lastRefreshAt,
  };
}

export async function initialize() {
  runtime.mode = config.tradingMode;
  bumpConnectionGeneration();
  if (!client.configured) {
    runtime.ready = false;
    runtime.lastError = null;
    return;
  }
  try {
    await refreshRuntime(true);
    runtime.ready = true;
    runtime.lastError = null;
    console.log(
      `[projectx] connected account=${runtime.account.name} contract=${runtime.contract.name}`,
    );
  } catch (error) {
    runtime.ready = false;
    runtime.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[projectx] initialization failed: ${runtime.lastError}`);
  }
}

export async function refreshRuntime(force = false) {
  if (!client.configured) {
    return;
  }
  const now = Date.now();
  if (!force && runtime.lastRefreshAt && now - Date.parse(runtime.lastRefreshAt) < 15_000) {
    return;
  }

  const accounts = await client.searchAccounts(true);
  runtime.account = pickAccount(accounts);
  const contracts = await client.listContracts(config.projectXLiveData);
  runtime.contract = pickContract(contracts);
  runtime.positions = await client.searchOpenPositions(runtime.account.id);
  runtime.openOrders = await client.searchOpenOrders(runtime.account.id);

  const contractId = runtime.contract.id;
  const historyHours = Math.max(1, config.sessionHistoryHours);
  runtime.bars1m = await fetchBars(contractId, {
    unit: 2,
    unitNumber: 1,
    limit: config.bars1mLimit,
    hours: historyHours,
  });
  runtime.bars5m = await fetchBars(contractId, {
    unit: 2,
    unitNumber: 5,
    limit: config.bars5mLimit,
    hours: Math.max(historyHours, 2),
  });

  const preliminaryMarket = buildEnrichedMarket({
    contract: runtime.contract,
    bars1m: runtime.bars1m,
    bars5m: runtime.bars5m,
    bars15s: [],
    realtime,
    config,
    correlation: null,
  });
  const positioned = openContractsFor(positionForContract(runtime.positions, contractId)) > 0;
  if (shouldFetchMicroBars(config, preliminaryMarket.features, new Date(), positioned)) {
    runtime.bars15s = await fetchBars(contractId, {
      unit: 1,
      unitNumber: 15,
      limit: config.bars15sLimit,
      hours: 0.5,
    });
  } else {
    runtime.bars15s = [];
  }

  const sessionStart = new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();
  runtime.trades = await client.searchTrades(runtime.account.id, sessionStart);
  runtime.tradesSummary = summarizeTrades(runtime.trades);

  const correlationContract = pickCorrelationContract(contracts, config.correlationSymbol);
  if (correlationContract) {
    runtime.correlationBars = await fetchBars(correlationContract.id, {
      unit: 2,
      unitNumber: 1,
      limit: 20,
      hours: 1,
    });
    runtime.correlation = buildCorrelationSummary(
      runtime.bars1m,
      runtime.correlationBars,
      instrumentRoot(runtime.contract),
      config.correlationSymbol,
    );
  } else {
    runtime.correlationBars = [];
    runtime.correlation = { available: false, symbol: config.correlationSymbol };
  }

  syncOutcomes({
    outcomesPath: config.outcomesPath,
    trades: runtime.trades,
    accountName: runtime.account.name,
    instrument: instrumentRoot(runtime.contract),
    registry: getIdempotencyState(),
  });

  await realtime.ensureStarted(runtime.account.id, contractId);
  runtime.lastRefreshAt = utcNow();
  runtime.ready = true;
  runtime.lastError = null;
}

export async function buildState() {
  if (!runtime.ready) {
    if (client.configured) {
      await refreshRuntime(true);
    } else {
      return shadow.buildState();
    }
  }
  const position = positionForContract(runtime.positions, runtime.contract.id);
  const openContracts = openContractsFor(position);
  const market = buildMarketContext();
  const positionState = mapPositionState(position, runtime.contract, market);
  const protection = verifyProtection(runtime.openOrders, positionState);
  return {
    schema_version: "glitch.topstep.state.v1",
    updated_utc: utcNow(),
    trading_mode: config.tradingMode,
    account: {
      name: runtime.account.name,
      canTrade: Boolean(runtime.account.canTrade),
      simulated: !config.projectXLiveData,
      balance: Number(runtime.account.balance) || 0,
      unrealized_pnl: positionState.unrealized_pnl_usd,
      conservative_equity:
        (Number(runtime.account.balance) || 0) + positionState.unrealized_pnl_usd,
      total_open_contracts: openContracts,
      instrument_open_contracts: openContracts,
    },
    contract: {
      name: runtime.contract.name,
      instrument: instrumentRoot(runtime.contract),
    },
    market: {
      last: market.last,
      regime: market.features?.regime_1m ?? null,
    },
    session_activity: runtime.tradesSummary,
    protection,
    reconciliation: buildReconciliation({
      runtimeReady: runtime.ready,
      realtimeStatus: realtime.status,
      protection,
      lastRefreshAt: runtime.lastRefreshAt,
      idempotencyState: getIdempotencyState(),
    }),
    realtime: realtime.status,
  };
}

export async function buildPacket(now = new Date()) {
  if (!runtime.ready) {
    if (client.configured) {
      await refreshRuntime(true);
    } else {
      return shadow.buildPacket(now);
    }
  } else {
    await refreshRuntime(false);
  }

  const stamp = utcNow();
  const packetId = minutePacketId(now);
  const position = positionForContract(runtime.positions, runtime.contract.id);
  const openContracts = openContractsFor(position);
  const positioned = openContracts > 0;
  const instrument = instrumentRoot(runtime.contract);

  const market = buildMarketContext();
  const positionState = mapPositionState(position, runtime.contract, market);
  const ordersWorking = mapWorkingOrders(runtime.openOrders, runtime.contract.id);
  const protection = verifyProtection(runtime.openOrders, positionState);
  const policy = buildSessionPolicy({
    account: runtime.account,
    tradesSummary: runtime.tradesSummary,
    config,
    now,
  });
  const setupCandidates = buildSetupCandidates({
    market,
    positionState,
    policy,
    contract: runtime.contract,
    protection,
  });
  const hash = snapshotHash(
    `${packetId}:${market.last}:${openContracts}:${ordersWorking.length}:${market.features?.regime_1m}:${setupCandidates.length}`,
  );
  market.snapshot_hash = hash;
  const defaultAction = positioned ? "HOLD" : "NOTHING";
  const idempotencyState = getIdempotencyState();
  const reconciliation = buildReconciliation({
    runtimeReady: runtime.ready,
    realtimeStatus: realtime.status,
    protection,
    lastRefreshAt: runtime.lastRefreshAt,
    idempotencyState,
  });
  const entryEnabled =
    Boolean(runtime.account.canTrade) &&
    config.tradingMode !== "disabled" &&
    !positioned &&
    !policy.entry_cooldown_after_losses &&
    policy.daily_loss_remaining_usd > 0;

  return {
    schema_version: PACKET_SCHEMA,
    packet_id: packetId,
    created_utc: stamp,
    venue: "projectx",
    firm: "topstep",
    instrument,
    account: {
      id: runtime.account.id,
      name: runtime.account.name,
      simulated: !config.projectXLiveData,
      can_trade: Boolean(runtime.account.canTrade),
      balance: Number(runtime.account.balance) || 0,
      unrealized_pnl: positionState.unrealized_pnl_usd,
      conservative_equity:
        (Number(runtime.account.balance) || 0) + positionState.unrealized_pnl_usd,
      total_open_contracts: openContracts,
      instrument_open_contracts: openContracts,
      working_orders: ordersWorking.length,
    },
    contract: {
      id: runtime.contract.id,
      name: runtime.contract.name,
      symbol_id: runtime.contract.symbolId,
      description: runtime.contract.description ?? null,
      tick_size: Number(runtime.contract.tickSize) || 0.25,
      tick_value: Number(runtime.contract.tickValue) || 0.5,
    },
    market,
    position_state: positionState,
    orders_working: ordersWorking,
    session_activity: runtime.tradesSummary,
    protection,
    reconciliation,
    policy,
    execution: {
      state_complete: reconciliation.state_trusted,
      entry_actions_enabled: entryEnabled,
      valid_entry_quantities: validEntryQuantities(policy, positioned),
      setup_candidates: setupCandidates,
      move_stop_available: protection.move_stop_available,
      move_tp_available: false,
      authority: "Glitch validates and executes; Hermes proposes only",
    },
    required_output_template: {
      schema_version: "glitch.intent.v2",
      intent_id: "GENERATE_UUID",
      created_utc: stamp,
      instrument,
      account: runtime.account.name,
      operator_profile: "glitch-topstep",
      action: defaultAction,
      confidence: 0.5,
      snapshot_hash: hash,
      model_version: "CONFIGURED_MODEL",
      prompt_version: "glitch-topstep-v2",
      reason: "Replace",
      decision_audit: {
        bull_case: "Replace",
        bear_case: "Replace",
        flat_case: "Replace",
        aggressive_case: "Replace",
        conservative_case: "Replace",
        decisive_evidence: "Replace",
        disconfirming_evidence: "Replace",
        change_condition: "Replace",
        final_choice: defaultAction,
      },
    },
  };
}

function priceTicks(distance, tickSize) {
  return Math.max(1, Math.round(Math.abs(distance) / tickSize));
}

function buildBracketOrder(intent, packet) {
  const tickSize = Number(packet.contract.tick_size) || 0.25;
  const reference =
    intent.action === "ENTER_LONG" ? Number(packet.market.ask) : Number(packet.market.bid);
  const stopDistance = priceTicks(reference - Number(intent.stop_loss), tickSize);
  const targetDistance = priceTicks(Number(intent.take_profit_1) - reference, tickSize);
  const isLong = intent.action === "ENTER_LONG";
  return {
    accountId: runtime.account.id,
    contractId: runtime.contract.id,
    type: 2,
    side: isLong ? 0 : 1,
    size: Number(intent.quantity),
    limitPrice: null,
    stopPrice: null,
    trailPrice: null,
    customTag: `glitch-topstep:${intent.intent_id}`,
    stopLossBracket: { ticks: isLong ? -stopDistance : stopDistance, type: 4 },
    takeProfitBracket: { ticks: isLong ? targetDistance : -targetDistance, type: 1 },
  };
}

export async function handleIntent(intent, packet) {
  fs.mkdirSync(dataDir, { recursive: true });
  const shadowOnly = config.tradingMode !== "armed";
  const record = {
    schema_version: "glitch.topstep.intent_receipt.v1",
    recorded_utc: utcNow(),
    trading_mode: config.tradingMode,
    accepted: true,
    shadow_only: shadowOnly,
    packet_id: packet.packet_id,
    intent,
  };

  let venueResult = null;
  if (!shadowOnly && client.configured && runtime.ready) {
    const action = intent.action;
    if ((action === "ENTER_LONG" || action === "ENTER_SHORT") && hasSubmission(packet.packet_id, action)) {
      venueResult = { duplicate: true, message: "Intent already submitted for this packet." };
    } else if (action === "ENTER_LONG" || action === "ENTER_SHORT") {
      recordSubmission({
        packetId: packet.packet_id,
        action,
        intentId: intent.intent_id,
        status: "pending",
      });
      venueResult = await client.placeOrder(buildBracketOrder(intent, packet));
      markSubmission(packet.packet_id, action, "submitted", venueResult);
    } else if (action === "EXIT") {
      venueResult = await client.closePosition(runtime.account.id, runtime.contract.id);
    } else if (action === "MOVE_STOP") {
      const protection = packet.protection || verifyProtection(
        runtime.openOrders,
        mapPositionState(
          positionForContract(runtime.positions, runtime.contract.id),
          runtime.contract,
          packet.market,
        ),
      );
      if (!protection.move_stop_available || !protection.stop_order_id) {
        throw new Error("move_stop_unavailable");
      }
      venueResult = await client.modifyOrder(runtime.account.id, protection.stop_order_id, {
        stopPrice: Number(intent.stop_loss),
      });
    }
    await refreshRuntime(true);
  }

  record.venue_result = venueResult;
  fs.appendFileSync(intentsPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    schema_version: "glitch.topstep.intent_response.v1",
    status: "accepted",
    shadow: shadowOnly,
    message: shadowOnly
      ? "Intent recorded in shadow mode; no venue order submitted."
      : venueResult?.duplicate
        ? "Duplicate intent ignored; prior submission stands."
        : "Intent forwarded to ProjectX.",
    intent_id: intent.intent_id,
    packet_id: packet.packet_id,
    venue_result: venueResult,
  };
}

export async function testAuthentication() {
  if (!client.configured) {
    throw new Error("PROJECT_X_USERNAME and PROJECT_X_API_KEY are required");
  }
  await client.ensureSession();
  const accounts = await client.searchAccounts(true);
  return {
    success: true,
    account_count: accounts.length,
    accounts: accounts.map((item) => ({
      id: item.id,
      name: item.name,
      canTrade: item.canTrade,
      balance: item.balance,
    })),
  };
}
