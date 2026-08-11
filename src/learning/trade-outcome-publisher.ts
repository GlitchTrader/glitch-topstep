import { createHash } from "node:crypto";
import type { TradeInfo } from "../domain/models.js";
import type { TrancheView } from "../ownership/tranches.js";
import {
  entryAndExitPrices,
  inferExitReason,
  inferSideFromFills,
  rMultiple,
  stopTargetFromTranche,
  structuralRiskUsd,
  ticksFromUsd,
  toOutcomeFills,
} from "./trade-outcome-enrichment.js";
import type { TradeOutcomeFlatTrigger } from "./trade-outcome-flat.js";
import {
  TRADE_OUTCOME_PUBLISHER_VERSION,
  TRADE_OUTCOME_SCHEMA,
  tradeOutcomeId,
  type TradeOutcomeV1,
} from "./trade-outcome.js";
import type { TradeOutcomeStore } from "../storage/trade-outcome-store.js";

export interface TradeSearchApi {
  searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeInfo[]>;
}

export interface PublishTradeOutcomeInput {
  accountId: number;
  accountName: string;
  contractId: string;
  instrument: string;
  tranches: TrancheView[];
  exitUtc: string;
  trigger?: TradeOutcomeFlatTrigger;
  tickSize?: number;
  tickValue?: number;
  maeUsd?: number | null;
  mfeUsd?: number | null;
  hadExitIntentByTranche?: ReadonlyMap<string, boolean>;
  bufferImpactUsd?: number | null;
  decisionLinks?: ReadonlyMap<string, { packet_id: string | null; snapshot_hash: string | null }>;
}

export interface TradeOutcomePublisherOptions {
  /** Wait before Trade/search so stream-flat does not outrun the closing fill. */
  settleMs?: number;
  /** Extend search end past flat detection; closing prints often land 1–2s later. */
  searchTailMs?: number;
  /** Second settle when the first search still has no realized PnL. */
  retrySettleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_SEARCH_TAIL_MS = 15_000;
const DEFAULT_RETRY_SETTLE_MS = 2_500;

export class TradeOutcomePublisher {
  private readonly settleMs: number;
  private readonly searchTailMs: number;
  private readonly retrySettleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(
    private readonly api: TradeSearchApi,
    private readonly store: TradeOutcomeStore,
    options: TradeOutcomePublisherOptions = {},
  ) {
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.searchTailMs = options.searchTailMs ?? DEFAULT_SEARCH_TAIL_MS;
    this.retrySettleMs = options.retrySettleMs ?? DEFAULT_RETRY_SETTLE_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  public async publishClosedTranches(input: PublishTradeOutcomeInput): Promise<TradeOutcomeV1[]> {
    await this.store.load();
    const published: TradeOutcomeV1[] = [];
    const rebuilding = new Set(input.tranches.map((tranche) => tranche.intent_id));
    // Prevent concurrent tranche flats — and retries — from claiming fills already owned
    // by another completed outcome.
    const claimedOrderIds = claimedOrderIdsFromStore(this.store, rebuilding);
    for (const tranche of input.tranches) {
      const existing = this.store.get(tranche.intent_id);
      if (
        existing
        && !isIncompleteOutcome(existing)
        && !outcomeSharesForeignClosingFill(existing, this.store)
      ) {
        continue;
      }
      const outcome = await this.buildOutcome(input, tranche, existing, claimedOrderIds);
      if (!outcome) {
        continue;
      }
      for (const orderId of outcome.evidence?.order_ids ?? []) {
        claimedOrderIds.add(orderId);
      }
      if (existing) {
        if (!isRicherOutcome(outcome, existing) && outcome.learning_eligible === existing.learning_eligible) {
          // Still replace when stripping a duplicated closing fill even if PnL drops.
          if (!outcomeSharesForeignClosingFill(existing, this.store)
            || outcomeSharesForeignClosingFill(outcome, this.store)) {
            continue;
          }
        }
        await this.store.replace(outcome);
      } else {
        await this.store.append(outcome);
      }
      published.push(outcome);
    }
    return published;
  }

  private async buildOutcome(
    input: PublishTradeOutcomeInput,
    tranche: TrancheView,
    existing: TradeOutcomeV1 | undefined,
    claimedOrderIds: Set<number>,
  ): Promise<TradeOutcomeV1 | null> {
    if (this.settleMs > 0) {
      await this.sleep(this.settleMs);
    }

    // Retry must keep the original flat clock; using "now" re-opens the search window
    // and lets later unrelated closes contaminate an incomplete outcome.
    const searchExitUtc = existing?.exit_utc && existing.exit_utc < input.exitUtc
      ? existing.exit_utc
      : input.exitUtc;

    let attributed = await this.searchAttributedTrades(
      input,
      tranche,
      searchExitUtc,
      claimedOrderIds,
    );
    if (!hasRealizedPnl(attributed) && this.retrySettleMs > 0) {
      await this.sleep(this.retrySettleMs);
      attributed = await this.searchAttributedTrades(
        input,
        tranche,
        searchExitUtc,
        claimedOrderIds,
      );
    }

    const realized = attributed.reduce(
      (sum, trade) => sum + (trade.profitAndLoss ?? 0),
      0,
    );
    const fees = attributed.reduce(
      (sum, trade) => sum + (trade.fees ?? 0),
      0,
    );
    const protectionStatus = tranche.protection.status === "proven"
      ? "proven"
      : (existing?.attribution?.protection_status === "proven" ? "proven" : tranche.protection.status);
    const hasTrades = attributed.length > 0;
    const fills = toOutcomeFills(attributed);
    const side = inferSideFromFills(attributed, tranche.entry_order_id);
    const prices = entryAndExitPrices(attributed, tranche.entry_order_id);
    const geometry = stopTargetFromTranche(tranche);
    const quantity = Math.max(
      1,
      attributed
        .filter((trade) => trade.orderId === tranche.entry_order_id)
        .reduce((sum, trade) => sum + trade.size, 0)
        || attributed[0]?.size
        || 1,
    );
    const tickSize = input.tickSize ?? 0;
    const tickValue = input.tickValue ?? 0;
    const initialRisk = structuralRiskUsd({
      side,
      entryPrice: prices.entry_price,
      stopPrice: geometry.stop_price,
      quantity,
      tickSize,
      tickValue,
    });
    const maeUsd = input.maeUsd ?? existing?.mae_usd ?? null;
    const mfeUsd = input.mfeUsd ?? existing?.mfe_usd ?? null;
    const excursionComplete = maeUsd !== null && mfeUsd !== null;
    const protectionConfirmed = protectionStatus === "proven";
    const learningEligible = protectionConfirmed
      && hasTrades
      && tranche.entry_order_id !== null
      && excursionComplete
      && fills.length >= 2;
    const closingTrade = attributed
      .filter((trade) => trade.profitAndLoss !== null)
      .sort((left, right) => left.creationTimestamp.localeCompare(right.creationTimestamp))
      .at(-1);
    const latestTradeUtc = attributed.reduce<string | null>((latest, trade) => {
      if (latest === null || trade.creationTimestamp > latest) {
        return trade.creationTimestamp;
      }
      return latest;
    }, null);
    const exitUtc = closingTrade?.creationTimestamp
      ?? latestTradeUtc
      ?? input.exitUtc;
    const exitReason = inferExitReason({
      closingOrderId: closingTrade?.orderId ?? null,
      stopOrderId: tranche.protection.stop.provider_order_id,
      targetOrderId: tranche.protection.target.provider_order_id,
      entryOrderId: tranche.entry_order_id,
      trigger: input.trigger ?? "reconcile",
      hadExitIntent: input.hadExitIntentByTranche?.get(tranche.intent_id) === true,
    });

    return {
      schema_version: TRADE_OUTCOME_SCHEMA,
      outcome_id: tradeOutcomeId(tranche.intent_id),
      intent_id: tranche.intent_id,
      account: input.accountName,
      instrument: input.instrument,
      entry_utc: tranche.created_utc,
      exit_utc: exitUtc,
      realized_pnl_usd: roundUsd(realized),
      fees_usd: roundUsd(fees),
      learning_eligible: learningEligible,
      exit_reason: exitReason,
      attribution: {
        entry_order_id: tranche.entry_order_id,
        trade_count: attributed.length,
        protection_status: protectionStatus,
        closing_order_id: closingTrade?.orderId ?? null,
        stop_order_id: tranche.protection.stop.provider_order_id,
        target_order_id: tranche.protection.target.provider_order_id,
      },
      fills,
      entry_price: prices.entry_price,
      exit_price: prices.exit_price,
      stop_price: geometry.stop_price,
      target_price: geometry.target_price,
      quantity,
      side,
      slippage_ticks: null,
      mae_usd: maeUsd,
      mfe_usd: mfeUsd,
      mae_ticks: ticksFromUsd(maeUsd, quantity, tickValue),
      mfe_ticks: ticksFromUsd(mfeUsd, quantity, tickValue),
      initial_risk_usd: initialRisk,
      r_multiple: rMultiple(realized, initialRisk),
      buffer_impact_usd: input.bufferImpactUsd ?? null,
      protection_confirmed: protectionConfirmed,
      packet_id: input.decisionLinks?.get(tranche.intent_id)?.packet_id
        ?? existing?.packet_id
        ?? null,
      snapshot_hash: input.decisionLinks?.get(tranche.intent_id)?.snapshot_hash
        ?? existing?.snapshot_hash
        ?? null,
      evidence: {
        publisher_version: TRADE_OUTCOME_PUBLISHER_VERSION,
        trade_ids: attributed.map((trade) => trade.id),
        order_ids: [...new Set(attributed.map((trade) => trade.orderId))],
      },
    };
  }

  private async searchAttributedTrades(
    input: PublishTradeOutcomeInput,
    tranche: TrancheView,
    exitUtc: string,
    claimedOrderIds: ReadonlySet<number>,
  ): Promise<TradeInfo[]> {
    const searchEndUtc = addMs(exitUtc, this.searchTailMs);
    const trades = await this.api.searchTrades(
      input.accountId,
      tranche.created_utc,
      searchEndUtc,
    );
    const orderIds = attributedOrderIds(tranche);
    const scoped = trades.filter(
      (trade) => trade.contractId === input.contractId
        && !trade.voided
        && trade.creationTimestamp >= tranche.created_utc
        && trade.creationTimestamp <= searchEndUtc
        && !claimedOrderIds.has(trade.orderId),
    );
    const owned = scoped.filter((trade) => orderIds.has(trade.orderId));
    if (hasRealizedPnl(owned)) {
      return owned;
    }
    // Manual/flatten closes often lack stop/target ids on the tranche at publish time.
    // Allow only enough orphan PnL size to flatten this entry — never every PnL in the window.
    const entryQty = Math.max(
      1,
      owned
        .filter((trade) => trade.orderId === tranche.entry_order_id)
        .reduce((sum, trade) => sum + trade.size, 0)
        || tranche.filled_qty
        || 1,
    );
    const exitEpoch = Date.parse(exitUtc);
    const orphans = scoped
      .filter((trade) => trade.profitAndLoss !== null && !orderIds.has(trade.orderId))
      .sort((left, right) => {
        const leftDistance = Math.abs(Date.parse(left.creationTimestamp) - exitEpoch);
        const rightDistance = Math.abs(Date.parse(right.creationTimestamp) - exitEpoch);
        return leftDistance - rightDistance
          || left.creationTimestamp.localeCompare(right.creationTimestamp)
          || left.id - right.id;
      });
    const selectedOrphans: TradeInfo[] = [];
    let remaining = entryQty;
    for (const orphan of orphans) {
      if (remaining <= 0) {
        break;
      }
      selectedOrphans.push(orphan);
      remaining -= orphan.size;
    }
    return [...owned, ...selectedOrphans];
  }
}

export function isIncompleteOutcome(outcome: TradeOutcomeV1): boolean {
  const tradeCount = outcome.attribution?.trade_count ?? 0;
  if (tradeCount < 2 && outcome.realized_pnl_usd === 0) {
    return true;
  }
  if (
    tradeCount >= 2
    && outcome.learning_eligible === false
    && outcome.attribution?.protection_status !== "proven"
  ) {
    return true;
  }
  // Upgrade pre-v1.1 rows that lack fill enrichment.
  if (tradeCount >= 2 && (outcome.fills?.length ?? 0) < 2) {
    return true;
  }
  if (looksContaminatedOutcome(outcome)) {
    return true;
  }
  return false;
}

export function isRicherOutcome(candidate: TradeOutcomeV1, existing: TradeOutcomeV1): boolean {
  const candidateCount = candidate.attribution?.trade_count ?? 0;
  const existingCount = existing.attribution?.trade_count ?? 0;
  const candidateFills = candidate.fills?.length ?? 0;
  const existingFills = existing.fills?.length ?? 0;

  if (candidate.learning_eligible && !existing.learning_eligible) {
    return true;
  }
  if (candidate.protection_confirmed && !existing.protection_confirmed) {
    return true;
  }
  // Prefer a cleaned attribution over a contaminated row with extra foreign closes.
  if (
    looksContaminatedOutcome(existing)
    && !looksContaminatedOutcome(candidate)
    && candidateCount >= 2
    && Math.abs(candidate.realized_pnl_usd) > 0
  ) {
    return true;
  }
  if (candidateFills >= 2 && existingFills < 2) {
    return true;
  }
  if (candidateCount >= 2 && existingCount < 2) {
    return true;
  }
  if (
    candidate.mae_usd != null
    && candidate.mfe_usd != null
    && (existing.mae_usd == null || existing.mfe_usd == null)
  ) {
    return true;
  }
  if (
    candidateCount === existingCount
    && candidateCount >= 2
    && candidate.realized_pnl_usd === existing.realized_pnl_usd
    && candidate.fees_usd > existing.fees_usd
  ) {
    return true;
  }
  return false;
}

export function looksContaminatedOutcome(outcome: TradeOutcomeV1): boolean {
  const fills = outcome.fills ?? [];
  if (fills.length <= 2) {
    return false;
  }
  const entryOrderId = outcome.attribution?.entry_order_id ?? null;
  const closingOrders = new Set(
    fills
      .filter((fill) => fill.profit_and_loss !== null && fill.order_id !== entryOrderId)
      .map((fill) => fill.order_id),
  );
  // One intent may legitimately scale out twice; three+ distinct closing orders is cross-talk.
  return closingOrders.size >= 3;
}

export function outcomeSharesForeignClosingFill(
  outcome: TradeOutcomeV1,
  store: TradeOutcomeStore,
): boolean {
  const entryOrderId = outcome.attribution?.entry_order_id ?? null;
  const closing = new Set(
    (outcome.evidence?.order_ids ?? []).filter((orderId) => orderId !== entryOrderId),
  );
  if (closing.size === 0) {
    return false;
  }
  for (const other of store.all()) {
    if (other.intent_id === outcome.intent_id) {
      continue;
    }
    const otherEntry = other.attribution?.entry_order_id ?? null;
    for (const orderId of other.evidence?.order_ids ?? []) {
      if (orderId !== otherEntry && closing.has(orderId)) {
        return true;
      }
    }
  }
  return false;
}

function claimedOrderIdsFromStore(
  store: TradeOutcomeStore,
  rebuilding: ReadonlySet<string>,
): Set<number> {
  const claimed = new Set<number>();
  for (const outcome of store.all()) {
    if (rebuilding.has(outcome.intent_id)) {
      continue;
    }
    for (const orderId of outcome.evidence?.order_ids ?? []) {
      claimed.add(orderId);
    }
  }
  return claimed;
}

function attributedOrderIds(tranche: TrancheView): Set<number> {
  const ids = new Set<number>();
  if (tranche.entry_order_id !== null) {
    ids.add(tranche.entry_order_id);
  }
  if (tranche.protection.stop.provider_order_id !== null) {
    ids.add(tranche.protection.stop.provider_order_id);
  }
  if (tranche.protection.target.provider_order_id !== null) {
    ids.add(tranche.protection.target.provider_order_id);
  }
  return ids;
}

function hasRealizedPnl(trades: readonly TradeInfo[]): boolean {
  return trades.some((trade) => trade.profitAndLoss !== null);
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stableOutcomeFingerprint(outcome: TradeOutcomeV1): string {
  return createHash("sha256").update(JSON.stringify({
    intent_id: outcome.intent_id,
    exit_utc: outcome.exit_utc,
    realized_pnl_usd: outcome.realized_pnl_usd,
  })).digest("hex").slice(0, 16);
}
