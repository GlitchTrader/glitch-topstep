import { createHash } from "node:crypto";
import type { TradeInfo } from "../domain/models.js";
import type { TrancheView } from "../ownership/tranches.js";
import {
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
}

export class TradeOutcomePublisher {
  public constructor(
    private readonly api: TradeSearchApi,
    private readonly store: TradeOutcomeStore,
  ) {}

  public async publishClosedTranches(input: PublishTradeOutcomeInput): Promise<TradeOutcomeV1[]> {
    await this.store.load();
    const published: TradeOutcomeV1[] = [];
    for (const tranche of input.tranches) {
      if (this.store.hasIntent(tranche.intent_id)) {
        continue;
      }
      const outcome = await this.buildOutcome(input, tranche);
      if (!outcome) {
        continue;
      }
      await this.store.append(outcome);
      published.push(outcome);
    }
    return published;
  }

  private async buildOutcome(
    input: PublishTradeOutcomeInput,
    tranche: TrancheView,
  ): Promise<TradeOutcomeV1 | null> {
    const trades = await this.api.searchTrades(
      input.accountId,
      tranche.created_utc,
      input.exitUtc,
    );
    const scoped = trades.filter(
      (trade) => trade.contractId === input.contractId
        && !trade.voided
        && trade.creationTimestamp >= tranche.created_utc
        && trade.creationTimestamp <= input.exitUtc,
    );
    const entryOrderId = tranche.entry_order_id;
    const attributed = entryOrderId === null
      ? scoped
      : scoped.filter((trade) => trade.orderId === entryOrderId || trade.creationTimestamp >= tranche.created_utc);

    const realized = attributed.reduce(
      (sum, trade) => sum + (trade.profitAndLoss ?? 0),
      0,
    );
    const fees = attributed.reduce(
      (sum, trade) => sum + (trade.fees ?? 0),
      0,
    );
    const protectionProven = tranche.protection.status === "proven";
    const hasTrades = attributed.length > 0;
    const learningEligible = protectionProven && hasTrades && entryOrderId !== null;

    return {
      schema_version: TRADE_OUTCOME_SCHEMA,
      outcome_id: tradeOutcomeId(tranche.intent_id),
      intent_id: tranche.intent_id,
      account: input.accountName,
      instrument: input.instrument,
      entry_utc: tranche.created_utc,
      exit_utc: input.exitUtc,
      realized_pnl_usd: roundUsd(realized),
      fees_usd: roundUsd(fees),
      learning_eligible: learningEligible,
      exit_reason: "instrument_flat",
      attribution: {
        entry_order_id: entryOrderId,
        trade_count: attributed.length,
        protection_status: tranche.protection.status,
      },
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function stableOutcomeFingerprint(outcome: TradeOutcomeV1): string {
  return createHash("sha256").update(JSON.stringify({
    intent_id: outcome.intent_id,
    exit_utc: outcome.exit_utc,
    realized_pnl_usd: outcome.realized_pnl_usd,
  })).digest("hex").slice(0, 16);
}
