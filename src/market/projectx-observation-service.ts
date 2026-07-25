import type {
  CanonicalMarketBar,
  MarketObservationState,
  MarketObservationTimeframeMinutes,
} from "../domain/market-observation.js";
import type { BarInfo } from "../domain/models.js";
import type {
  ProjectXApiClient,
  RetrieveBarsRequest,
} from "../projectx/client.js";
import { buildMultiTimeframeMarketObservation } from "./observation.js";

const TIMEFRAMES: MarketObservationTimeframeMinutes[] = [1, 5, 15, 60];
const MINUTE_MS = 60_000;

export interface ProjectXObservationOptions {
  contractId: string;
  instrument: string;
  live: boolean;
  barLimit: number;
  lookbackMultiplier: number;
}

export class ProjectXMarketObservationService {
  private state: MarketObservationState = {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
  private inFlight: Promise<MarketObservationState> | null = null;

  public constructor(
    private readonly api: Pick<ProjectXApiClient, "retrieveBars">,
    private readonly options: ProjectXObservationOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(options.barLimit) || options.barLimit < 200 || options.barLimit > 20_000) {
      throw new Error("market_observation_bar_limit_invalid");
    }
    if (
      !Number.isInteger(options.lookbackMultiplier)
      || options.lookbackMultiplier < 1
      || options.lookbackMultiplier > 10
    ) {
      throw new Error("market_observation_lookback_multiplier_invalid");
    }
  }

  public current(): MarketObservationState {
    return structuredClone(this.state);
  }

  public refresh(): Promise<MarketObservationState> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.run();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
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

  private async run(): Promise<MarketObservationState> {
    const now = this.now();
    this.state = {
      ...this.state,
      last_attempt_utc: now.toISOString(),
    };
    try {
      const entries = await Promise.all(TIMEFRAMES.map(async (timeframe) => {
        const bars = await this.api.retrieveBars(this.request(timeframe, now));
        return [timeframe, bars.map(toCanonicalMarketBar)] as const;
      }));
      this.state = {
        last_attempt_utc: now.toISOString(),
        last_succeeded_utc: now.toISOString(),
        last_error: null,
        observation: buildMultiTimeframeMarketObservation({
          instrument: this.options.instrument,
          contractId: this.options.contractId,
          source: "projectx_bars",
          now,
          series: Object.fromEntries(entries) as Partial<
            Record<MarketObservationTimeframeMinutes, CanonicalMarketBar[]>
          >,
        }),
      };
    } catch (error) {
      this.state = {
        ...this.state,
        last_error: error instanceof Error ? `${error.name}:${error.message}` : String(error),
      };
    }
    return this.current();
  }

  private request(
    timeframeMinutes: MarketObservationTimeframeMinutes,
    now: Date,
  ): RetrieveBarsRequest {
    const lookbackMs = timeframeMinutes
      * this.options.barLimit
      * this.options.lookbackMultiplier
      * MINUTE_MS;
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

export function toCanonicalMarketBar(bar: BarInfo): CanonicalMarketBar {
  return {
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}
