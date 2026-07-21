import { calculateBracketTicks, isTickAligned } from "../execution/brackets.js";
import type {
  AccountVenueSnapshot,
  RiskSettings,
  TopstepPolicyState,
  TradeIntent,
  ValidatedEntry,
} from "../domain/models.js";
import { calculateRiskBudget } from "./mll.js";

export class RiskRejectedError extends Error {
  public readonly code: string;

  public constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "RiskRejectedError";
    this.code = code;
  }
}

export interface RiskValidationContext {
  expectedAccountId: number;
  expectedAccountName: string;
  expectedInstrument: string;
  expectedSnapshotHash: string;
  requireSimulatedAccount: boolean;
  now?: Date;
}

export function validateEntryRisk(
  intent: TradeIntent,
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  settings: RiskSettings,
  context: RiskValidationContext,
): ValidatedEntry {
  const now = context.now ?? new Date();
  if (intent.action !== "ENTER_LONG" && intent.action !== "ENTER_SHORT") {
    throw new RiskRejectedError("entry_action_required");
  }
  if (!snapshot.stateComplete) {
    throw new RiskRejectedError("venue_state_incomplete");
  }
  if (!snapshot.account.canTrade) {
    throw new RiskRejectedError("account_cannot_trade");
  }
  if (context.requireSimulatedAccount && snapshot.account.simulated !== true) {
    throw new RiskRejectedError("simulated_account_required");
  }
  if (snapshot.account.id !== context.expectedAccountId) {
    throw new RiskRejectedError("account_id_mismatch");
  }
  if (snapshot.account.name !== context.expectedAccountName || intent.account !== context.expectedAccountName) {
    throw new RiskRejectedError("account_name_mismatch");
  }
  if (intent.instrument.toUpperCase() !== context.expectedInstrument.toUpperCase()) {
    throw new RiskRejectedError("instrument_mismatch");
  }
  if (intent.snapshotHash !== context.expectedSnapshotHash) {
    throw new RiskRejectedError("snapshot_hash_mismatch");
  }
  if (!policy.entryWindowOpen) {
    throw new RiskRejectedError("entry_window_closed");
  }
  if (!snapshot.quote) {
    throw new RiskRejectedError("quote_missing");
  }

  const intentAge = now.getTime() - new Date(intent.createdUtc).getTime();
  const quoteAge = now.getTime() - new Date(snapshot.quote.timestamp).getTime();
  const stateAge = now.getTime() - new Date(snapshot.capturedAt).getTime();
  if (intentAge < -2_000 || intentAge > settings.maxIntentAgeMs) {
    throw new RiskRejectedError("intent_stale", String(intentAge));
  }
  if (quoteAge < -2000 || quoteAge > settings.maxQuoteAgeMs) {
    throw new RiskRejectedError("quote_stale", String(quoteAge));
  }
  if (stateAge < -2000 || stateAge > settings.maxStateAgeMs) {
    throw new RiskRejectedError("account_state_stale", String(stateAge));
  }

  if (snapshot.instrumentOpenContracts !== 0) {
    throw new RiskRejectedError("position_already_open");
  }
  if (snapshot.openOrders.length !== 0) {
    throw new RiskRejectedError("working_orders_present");
  }

  const quantity = intent.quantity;
  const stopLoss = intent.stopLoss;
  const takeProfit = intent.takeProfit1;
  if (!quantity || !Number.isInteger(quantity) || quantity < 1) {
    throw new RiskRejectedError("quantity_invalid");
  }
  if (intent.orderType !== "MARKET" || stopLoss === undefined || takeProfit === undefined) {
    throw new RiskRejectedError("protected_market_entry_required");
  }

  const remainingCapacity = Math.max(0, policy.maxContracts - snapshot.totalOpenContracts);
  if (quantity > remainingCapacity) {
    throw new RiskRejectedError("max_contracts_exceeded");
  }
  if (!isTickAligned(stopLoss, snapshot.contract.tickSize)) {
    throw new RiskRejectedError("stop_not_tick_aligned");
  }
  if (!isTickAligned(takeProfit, snapshot.contract.tickSize)) {
    throw new RiskRejectedError("target_not_tick_aligned");
  }

  const side = intent.action === "ENTER_LONG" ? "long" : "short";
  const referencePrice = side === "long" ? snapshot.quote.bestAsk : snapshot.quote.bestBid;
  const brackets = calculateBracketTicks(
    side,
    referencePrice,
    stopLoss,
    takeProfit,
    snapshot.contract.tickSize,
  );

  const pointValue = snapshot.contract.tickValue / snapshot.contract.tickSize;
  const rawRisk = Math.abs(referencePrice - stopLoss) * pointValue * quantity;
  const slippageReserve = settings.slippageReserveTicks * snapshot.contract.tickValue * quantity;
  const riskUsd = rawRisk + slippageReserve + settings.estimatedRoundTurnFeesUsd;
  const riskBudget = calculateRiskBudget(
    snapshot.conservativeEquity,
    policy,
    settings.maxRiskFractionOfBuffer,
  );
  if (riskBudget.currentBuffer <= 0) {
    throw new RiskRejectedError("no_mll_buffer");
  }
  if (riskUsd > riskBudget.allowedRiskUsd + 1e-8) {
    throw new RiskRejectedError(
      "risk_budget_exceeded",
      `risk=${riskUsd.toFixed(2)},allowed=${riskBudget.allowedRiskUsd.toFixed(2)}`,
    );
  }

  return {
    intent,
    account: snapshot.account,
    contract: snapshot.contract,
    referencePrice,
    riskUsd,
    riskBudget,
    stopTicks: brackets.stopTicks,
    targetTicks: brackets.targetTicks,
    customTag: `glt-${intent.intentId}`.slice(0, 64),
  };
}
