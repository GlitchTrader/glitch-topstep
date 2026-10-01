import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";
import { buildProjectXOrderFlowObservation } from "./order-flow.js";

export interface OrderFlowLoad {
  events: readonly StoredProviderEvidenceEvent[];
  truncated: boolean;
  coverageStartUtc: string | null;
}

export type OrderFlowLoader = (input: {
  contractId: string;
  lookbackStartUtc: string;
  limit: number;
}) => OrderFlowLoad | Promise<OrderFlowLoad>;

export interface ProjectXOrderFlowServiceOptions {
  contractId: string;
  tickSize: number;
  maxEvents: number;
  depthLevels: number;
  lookbackSeconds?: number;
}

export class ProjectXOrderFlowService {
  private readonly lookbackSeconds: number;
  private closed = false;
  private state: ProjectXOrderFlowState = {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
  private inFlight: Promise<ProjectXOrderFlowState> | null = null;

  public constructor(
    private readonly load: OrderFlowLoader,
    private readonly options: ProjectXOrderFlowServiceOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(options.tickSize) || options.tickSize <= 0) {
      throw new Error("order_flow_tick_size_invalid");
    }
    if (!Number.isInteger(options.maxEvents) || options.maxEvents < 1_000 || options.maxEvents > 1_000_000) {
      throw new Error("order_flow_max_events_invalid");
    }
    if (!Number.isInteger(options.depthLevels) || options.depthLevels < 1 || options.depthLevels > 100) {
      throw new Error("order_flow_depth_levels_invalid");
    }
    this.lookbackSeconds = options.lookbackSeconds ?? 300;
    if (!Number.isInteger(this.lookbackSeconds) || this.lookbackSeconds < 300 || this.lookbackSeconds > 3_600) {
      throw new Error("order_flow_lookback_invalid");
    }
  }

  public close(): void {
    this.closed = true;
  }

  public current(): ProjectXOrderFlowState {
    return structuredClone(this.state);
  }

  public refresh(): Promise<ProjectXOrderFlowState> {
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

  private async run(): Promise<ProjectXOrderFlowState> {
    const generatedAt = this.now();
    const attemptedUtc = generatedAt.toISOString();
    this.state = {
      ...this.state,
      last_attempt_utc: attemptedUtc,
    };
    try {
      if (this.closed) {
        throw new Error("database is closed");
      }
      const lookbackStartUtc = new Date(
        generatedAt.getTime() - this.lookbackSeconds * 1_000,
      ).toISOString();
      const loaded = await this.load({
        contractId: this.options.contractId,
        lookbackStartUtc,
        limit: this.options.maxEvents,
      });
      this.state = {
        last_attempt_utc: attemptedUtc,
        last_succeeded_utc: attemptedUtc,
        last_error: null,
        observation: buildProjectXOrderFlowObservation({
          events: [...loaded.events],
          contractId: this.options.contractId,
          tickSize: this.options.tickSize,
          generatedAt,
          truncated: loaded.truncated,
          coverageStartUtc: loaded.coverageStartUtc,
          depthLevels: this.options.depthLevels,
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
}
