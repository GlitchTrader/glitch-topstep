import { calculateBracketTicks, isTickAligned } from "../execution/brackets.js";
import type {
  AccountVenueSnapshot,
  RiskSettings,
  TopstepPolicyState,
  TradeIntent,
  ValidatedEntry,
} from "../domain/models.js";
import { evaluateSnapshotDataQuality } from "../state/data-quality.js";
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

  // Decision-identity expiry. This rejects a stale decision at intake; it is not
  // authority to resubmit or terminalize an already-submitted intent.
  const intentAgeMs = now.getTime() - Date.parse(intent.createdUtc);
  if (!Number.isFinite(intentAgeMs)) {
    throw new RiskRejectedError("intent_timestamp_invalid");
  }
  if (intentAgeMs > settings.maxIntentAgeMs) {
    throw new RiskRejectedError("intent_stale", String(intentAgeMs));
  }

  const quality = evaluateSnapshotDataQuality(snapshot, settings, now);
  if (!quality.stateComplete) {
    if (quality.issues.includes("quote_stale")) {
      throw new RiskRejectedError("quote_stale", String(quality.quoteAgeMs));
    }
    if (quality.issues.includes("account_state_stale")) {
      throw new RiskRejectedError("account_state_stale", String(quality.stateAgeMs));
    }
    if (quality.issues.includes("quote_timestamp_future")) {
      throw new RiskRejectedError("quote_timestamp_future", String(quality.quoteAgeMs));
    }
    if (quality.issues.includes("account_state_timestamp_future")) {
      throw new RiskRejectedError("account_state_timestamp_future", String(quality.stateAgeMs));
    }
    if (quality.issues.includes("quote_timestamp_invalid")) {
      throw new RiskRejectedError("quote_timestamp_invalid");
    }
    if (quality.issues.includes("account_state_timestamp_invalid")) {
      throw new RiskRejectedError("account_state_timestamp_invalid");
    }
    throw new RiskRejectedError("venue_state_incomplete", quality.issues.join(","));
  }
  if (!snapshot.account.canTrade) {
    throw new RiskRejectedError("account_cannot_trade");
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
  if (!snapshot.quote) {
    throw new RiskRejectedError("quote_missing");
  }

  // The initial gateway cannot yet prove independent additions or working-order ownership.
  // Rejecting these states protects venue truth; it does not encode a trading strategy.
  if (snapshot.instrumentOpenContracts !== 0) {
    throw new RiskRejectedError("position_addition_not_implemented");
  }
  if (snapshot.openOrders.length !== 0) {
    throw new RiskRejectedError("working_order_ownership_unresolved");
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
    throw new RiskRejectedError("hard_contract_capacity_exceeded");
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

  // Protected downside must be measured from the bracket that is actually
  // submitted. `stopTicks` is rounded away from the reference price, so pricing
  // the requested stop level instead would understate the risk the account bears
  // whenever the reference price is not tick-aligned.
  const rawRisk = brackets.stopTicks * snapshot.contract.tickValue * quantity;
  const slippageReserve = settings.slippageReserveTicks * snapshot.contract.tickValue * quantity;
  const feeReserve = settings.estimatedRoundTurnFeesUsd * quantity;
  const riskUsd = rawRisk + slippageReserve + feeReserve;
  const riskBudget = calculateRiskBudget(snapshot.conservativeEquity, policy);
  if (riskBudget.currentBuffer <= 0) {
    throw new RiskRejectedError("no_hard_loss_buffer");
  }
  if (riskUsd >= riskBudget.currentBuffer - 1e-8) {
    throw new RiskRejectedError(
      "hard_loss_floor_breach",
      `protected_risk=${riskUsd.toFixed(2)},buffer=${riskBudget.currentBuffer.toFixed(2)}`,
    );
  }

  return {
    intent,
    account: snapshot.account,
    contract: snapshot.contract,
    quantity,
    referencePrice,
    riskUsd,
    riskBudget,
    stopTicks: brackets.stopTicks,
    targetTicks: brackets.targetTicks,
    customTag: `glt-${intent.intentId}`.slice(0, 64),
  };
}
