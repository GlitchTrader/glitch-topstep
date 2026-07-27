import type {
  ProviderHistorySyncResult,
  ProviderHistorySyncStatus,
} from "../domain/provider-history.js";
import type { OrderInfo, TradeInfo } from "../domain/models.js";
import { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface ProjectXHistoryApi {
  searchOrders(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<OrderInfo[]>;
  searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeInfo[]>;
}

export interface ProjectXHistorySyncOptions {
  accountId: number;
  initialLookbackHours: number;
  overlapMinutes: number;
  windowMinutes: number;
  generation: () => number;
  syncKey?: string;
}

export class ProjectXHistorySyncService {
  private inFlight: Promise<ProviderHistorySyncResult> | null = null;
  private readonly syncKey: string;

  public constructor(
    private readonly api: ProjectXHistoryApi,
    private readonly evidence: SqliteProviderEvidenceStore,
    private readonly options: ProjectXHistorySyncOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isInteger(options.initialLookbackHours)
      || options.initialLookbackHours < 1
      || options.initialLookbackHours > 8_760
    ) {
      throw new Error("provider_history_initial_lookback_invalid");
    }
    if (
      !Number.isInteger(options.overlapMinutes)
      || options.overlapMinutes < 1
      || options.overlapMinutes > 1_440
    ) {
      throw new Error("provider_history_overlap_invalid");
    }
    if (
      !Number.isInteger(options.windowMinutes)
      || options.windowMinutes < 5
      || options.windowMinutes > 10_080
    ) {
      throw new Error("provider_history_window_invalid");
    }
    this.syncKey = options.syncKey ?? `projectx-history:${options.accountId}`;
  }

  public currentStatus(): ProviderHistorySyncStatus {
    return this.evidence.historySyncStatus(this.syncKey);
  }

  public sync(): Promise<ProviderHistorySyncResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.run();
    this.inFlight = run;
    void run.then(
      () => {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
      },
      () => {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
      },
    );
    return run;
  }

  public async waitForIdle(): Promise<void> {
    if (!this.inFlight) {
      return;
    }
    await this.inFlight.then(
      () => undefined,
      () => undefined,
    );
  }

  private async run(): Promise<ProviderHistorySyncResult> {
    const targetEnd = this.now().getTime();
    const existing = this.evidence.historySyncStatus(this.syncKey);
    const cursorMs = existing.cursorUtc === null ? null : Date.parse(existing.cursorUtc);
    if (cursorMs !== null && !Number.isFinite(cursorMs)) {
      throw new Error("provider_history_cursor_invalid");
    }
    const initialStart = cursorMs === null
      ? targetEnd - this.options.initialLookbackHours * HOUR_MS
      : cursorMs - this.options.overlapMinutes * MINUTE_MS;
    let windowStart = Math.min(initialStart, targetEnd);
    const windowSizeMs = this.options.windowMinutes * MINUTE_MS;
    let attemptedWindows = 0;
    let completedWindows = 0;
    let ordersSeen = 0;
    let tradesSeen = 0;
    let eventsAppended = 0;

    while (windowStart < targetEnd) {
      const windowEnd = Math.min(windowStart + windowSizeMs, targetEnd);
      const attemptedUtc = this.now().toISOString();
      const windowStartUtc = new Date(windowStart).toISOString();
      const windowEndUtc = new Date(windowEnd).toISOString();
      attemptedWindows += 1;
      this.evidence.recordHistorySyncAttempt(
        this.syncKey,
        attemptedUtc,
        windowStartUtc,
        windowEndUtc,
      );

      try {
        const [orders, trades] = await Promise.all([
          this.api.searchOrders(this.options.accountId, windowStartUtc, windowEndUtc),
          this.api.searchTrades(this.options.accountId, windowStartUtc, windowEndUtc),
        ]);
        const orderedOrders = [...orders].sort(compareOrders);
        const orderedTrades = [...trades].sort(compareTrades);
        let windowEventsAppended = 0;

        for (const order of orderedOrders) {
          const result = this.evidence.appendIfChanged(
            `historical-order:${this.options.accountId}:${order.id}`,
            {
              receivedUtc: this.now().toISOString(),
              providerTimestampUtc: order.updateTimestamp,
              source: "projectx_rest",
              eventType: "historical_order",
              generation: this.options.generation(),
              accountId: order.accountId,
              contractId: order.contractId,
              providerEntityId: String(order.id),
              relatedProviderEntityId: null,
              rawPayload: null,
              normalizedPayload: order,
            },
          );
          if (result.appended) {
            windowEventsAppended += 1;
          }
        }
        for (const trade of orderedTrades) {
          const result = this.evidence.appendIfChanged(
            `historical-trade:${this.options.accountId}:${trade.id}`,
            {
              receivedUtc: this.now().toISOString(),
              providerTimestampUtc: trade.creationTimestamp,
              source: "projectx_rest",
              eventType: "historical_trade",
              generation: this.options.generation(),
              accountId: trade.accountId,
              contractId: trade.contractId,
              providerEntityId: String(trade.id),
              relatedProviderEntityId: String(trade.orderId),
              rawPayload: null,
              normalizedPayload: trade,
            },
          );
          if (result.appended) {
            windowEventsAppended += 1;
          }
        }

        const succeededUtc = this.now().toISOString();
        this.evidence.recordHistorySyncSuccess(
          this.syncKey,
          windowEndUtc,
          succeededUtc,
          windowStartUtc,
          windowEndUtc,
          orderedOrders.length,
          orderedTrades.length,
          windowEventsAppended,
        );
        completedWindows += 1;
        ordersSeen += orderedOrders.length;
        tradesSeen += orderedTrades.length;
        eventsAppended += windowEventsAppended;
        windowStart = windowEnd;
      } catch (error) {
        const detail = error instanceof Error
          ? `${error.name}:${error.message}`
          : String(error);
        this.evidence.recordHistorySyncFailure(
          this.syncKey,
          this.now().toISOString(),
          windowStartUtc,
          windowEndUtc,
          detail,
        );
        break;
      }
    }

    return {
      attemptedWindows,
      completedWindows,
      ordersSeen,
      tradesSeen,
      eventsAppended,
      status: this.evidence.historySyncStatus(this.syncKey),
    };
  }
}

function compareOrders(left: OrderInfo, right: OrderInfo): number {
  return left.updateTimestamp.localeCompare(right.updateTimestamp) || left.id - right.id;
}

function compareTrades(left: TradeInfo, right: TradeInfo): number {
  return left.creationTimestamp.localeCompare(right.creationTimestamp) || left.id - right.id;
}
