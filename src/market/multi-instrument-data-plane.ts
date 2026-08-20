import type { InstrumentUniverse } from "../domain/instrument-universe.js";
import type { MarketObservationState } from "../domain/market-observation.js";
import type { ProjectXApiClient } from "../projectx/client.js";
import { ProjectXMarketObservationService } from "./projectx-observation-service.js";
import { RateAwareScheduler, type RateAwareSchedulerStatus } from "./rate-aware-scheduler.js";
import { summarizeScannerObservation, type ScannerObservationQuality } from "./scanner-quality.js";

export interface MultiInstrumentMarketPacket {
  schema_version: "glitch.topstep.market_universe.v1";
  market_data_mode: "live" | "simulated";
  generated_utc: string;
  generation: number;
  scope_hash: string;
  scheduler: RateAwareSchedulerStatus;
  candidates: Array<{
    instrument: string;
    contract_id: string;
    symbol_id: string;
    tick_size: number;
    tick_value: number;
    execution_mode: "selected" | "observation_only";
    market_observation: MarketObservationState;
    observation_quality: ScannerObservationQuality;
  }>;
}

export class MultiInstrumentMarketDataPlane {
  private readonly scheduler: RateAwareScheduler;
  private readonly observations: Map<string, ProjectXMarketObservationService>;

  public constructor(
    api: Pick<ProjectXApiClient, "retrieveBars">,
    private readonly universe: InstrumentUniverse,
    requestsPerMinute: number,
    private readonly selectedContractId: string,
    private readonly liveMarketData = true,
    now: () => Date = () => new Date(),
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.scheduler = new RateAwareScheduler(requestsPerMinute, () => now().getTime(), sleep);
    const scheduledApi = {
      retrieveBars: (request: Parameters<ProjectXApiClient["retrieveBars"]>[0]) => (
        this.scheduler.schedule(() => api.retrieveBars(request))
      ),
    };
    this.observations = new Map(universe.contracts.map((contract) => [
      contract.contract_id,
      new ProjectXMarketObservationService(
        scheduledApi as Pick<ProjectXApiClient, "retrieveBars">,
        {
          contractId: contract.contract_id,
          instrument: contract.instrument,
          live: this.liveMarketData,
          barLimit: 500,
          lookbackMultiplier: 3,
        },
        now,
      ),
    ]));
  }

  public async refreshAll(): Promise<MultiInstrumentMarketPacket> {
    await Promise.all([...this.observations.values()].map((service) => service.refresh()));
    return this.current();
  }

  public current(): MultiInstrumentMarketPacket {
    return {
      schema_version: "glitch.topstep.market_universe.v1",
      market_data_mode: this.liveMarketData ? "live" : "simulated",
      generated_utc: new Date().toISOString(),
      generation: this.universe.generation,
      scope_hash: this.universe.scope_hash,
      scheduler: this.scheduler.status(),
      candidates: this.universe.contracts.map((contract) => ({
        instrument: contract.instrument,
        contract_id: contract.contract_id,
        symbol_id: contract.symbol_id,
        tick_size: contract.tick_size,
        tick_value: contract.tick_value,
        execution_mode: contract.contract_id === this.selectedContractId ? "selected" : "observation_only",
        market_observation: this.observations.get(contract.contract_id)!.current(),
        observation_quality: summarizeScannerObservation(
          this.observations.get(contract.contract_id)!.current(),
        ),
      })),
    };
  }

  public async waitForIdle(): Promise<void> {
    await Promise.all([...this.observations.values()].map((service) => service.waitForIdle()));
    await this.scheduler.waitForIdle();
  }
}
