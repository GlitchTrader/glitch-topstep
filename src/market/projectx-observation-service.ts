import type { MarketObservationState } from "../domain/market-observation-state.js";
import type { CanonicalBar } from "../domain/market-observation.js";
import type { BarInfo } from "../domain/models.js";
import type {
  ProjectXApiClient,
  RetrieveBarsRequest,
} from "../projectx/client.js";
import { buildObservationFromTimeframeSeries } from "./timeframe-observation.js";

const TIMEFRAMES = [1, 5, 15, 60] as const;
const MINUTE_MS = 60_000;

export interface ProjectXObservationOptions {
  contractId: string;
  instrument: string;
  live: boolean;
  barLimit: number;
}

export class ProjectXObservationService {
  private state: MarketObservationState = {
    lastAttemptUtc: null,
    lastSucceededUtc: null,
    lastError: null,
    observation: null,
  };

  public constructor(
    private readonly api: ProjectXApiClient,
    private readonly options: ProjectXObservationOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(options.barLimit) || options.barLimit < 20 || options.barLimit > 20_000) {
      throw new Error("market_observation_bar_limit_invalid");
    }
  }

  public current(): MarketObservationState {
    return structuredClone(this.state);
  }

  public async refresh(): Promise<MarketObservationState> {
    const now = this.now();
    this.state = {
      ...this.state,
      lastAttemptUtc: now.toISOString(),
    };
    try {
      const seriesEntries = await Promise.all(
        TIMEFRAMES.map(async (timeframeMinutes) => {
          const bars = await this.api.retrieveBars(
            this.request(timeframeMinutes, now),
          );
          return [timeframeMinutes, bars.map(toCanonicalBar)] as const;
        }),
      );
      const observation = buildObservationFromTimeframeSeries({
        instrument: this.options.instrument,
        contractId: this.options.contractId,
        source: "projectx_bars",
        now,
        series: Object.fromEntries(seriesEntries) as Partial<
          Record<1 | 5 | 15 | 60, CanonicalBar[]>
        >,
      });
      this.state = {
        lastAttemptUtc: now.toISOString(),
        lastSucceededUtc: now.toISOString(),
        lastError: null,
        observation,
      };
    } catch (error) {
      this.state = {
        ...this.state,
        lastError: error instanceof Error ? `${error.name}:${error.message}` : String(error),
      };
    }
    return this.current();
  }

  private request(
    timeframeMinutes: 1 | 5 | 15 | 60,
    now: Date,
  ): RetrieveBarsRequest {
    const lookbackMs = timeframeMinutes * this.options.barLimit * MINUTE_MS;
    return {
      contractId: this.options.contractId,
      live: this.options.live,
      startTime: new Date(now.getTime() - lookbackMs).toISOString(),
      endTime: now.toISOString(),
      unit: 2,
      unitNumber: timeframeMinutes,
      limit: this.options.barLimit,
      includePartialBar: true,
    };
  }
}

export function toCanonicalBar(bar: BarInfo): CanonicalBar {
  return {
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}
