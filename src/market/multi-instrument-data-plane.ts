import type { InstrumentUniverse } from "../domain/instrument-universe.js";
import type { MarketObservationState } from "../domain/market-observation.js";
import type { ProjectXApiClient } from "../projectx/client.js";
import {
  buildCandidateAlignment,
  buildUniverseFreshness,
  latest1mBarAgeMs,
  observationAgeMs,
  PACKET_OBSERVATION_STALE_MS,
  TIMEFRAMES_PER_INSTRUMENT,
  type CandidateAlignmentPacket,
  type UniverseFreshnessPacket,
} from "./candidate-freshness.js";
import { ProjectXMarketObservationService } from "./projectx-observation-service.js";
import {
  PROJECTX_HISTORY_MIN_HEADROOM,
  RateAwareScheduler,
  type HistoryScheduleOptions,
  type RateAwareSchedulerStatus,
} from "./rate-aware-scheduler.js";
import { summarizeScannerObservation, type ScannerObservationQuality } from "./scanner-quality.js";

export interface MultiInstrumentMarketPacket {
  schema_version: "glitch.topstep.market_universe.v1";
  market_data_mode: "live" | "simulated";
  generated_utc: string;
  generation: number;
  scope_hash: string;
  scheduler: RateAwareSchedulerStatus;
  universe_freshness: UniverseFreshnessPacket;
  candidates: Array<{
    instrument: string;
    contract_id: string;
    symbol_id: string;
    tick_size: number;
    tick_value: number;
    execution_mode: "selected" | "observation_only";
    market_observation: MarketObservationState;
    observation_quality: ScannerObservationQuality;
    candidate_alignment: CandidateAlignmentPacket;
  }>;
}

export class MultiInstrumentMarketDataPlane {
  private readonly scheduler: RateAwareScheduler;
  private readonly observations: Map<string, ProjectXMarketObservationService>;
  private refreshChain: Promise<unknown> = Promise.resolve();
  private scheduleMinHeadroom = PROJECTX_HISTORY_MIN_HEADROOM;

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
        this.scheduler.schedule(
          () => api.retrieveBars(request),
          { minHeadroom: this.scheduleMinHeadroom },
        )
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

  public refreshAll(): Promise<MultiInstrumentMarketPacket> {
    return this.enqueueUniverseRefresh(async () => {
      await this.withScheduleMinHeadroom(PROJECTX_HISTORY_MIN_HEADROOM, () => (
        this.refreshContractsParallel(this.universe.contracts.map((contract) => contract.contract_id))
      ));
      return this.current();
    });
  }

  /** Packet-time refresh: selected always; observation-only when stale; parallel per contract. */
  public refreshForPacket(now: Date = new Date()): Promise<MultiInstrumentMarketPacket> {
    return this.enqueueUniverseRefresh(async () => {
      const contractIds = this.contractIdsForPacketRefresh(now);
      const requestCount = contractIds.length * TIMEFRAMES_PER_INSTRUMENT;
      const minHeadroom = this.scheduler.canSchedule(requestCount, PROJECTX_HISTORY_MIN_HEADROOM)
        ? PROJECTX_HISTORY_MIN_HEADROOM
        : 0;
      if (
        minHeadroom === 0
        && !this.scheduler.canSchedule(requestCount, 0)
      ) {
        contractIds.splice(0, contractIds.length, this.selectedContractId);
      }
      await this.withScheduleMinHeadroom(minHeadroom, () => (
        this.refreshContractsParallel(contractIds)
      ));
      return this.current(now);
    });
  }

  public refreshSelected(contractId: string): Promise<MarketObservationState> {
    return this.enqueueUniverseRefresh(async () => {
      await this.withScheduleMinHeadroom(PROJECTX_HISTORY_MIN_HEADROOM, () => (
        this.refreshContractsParallel([contractId])
      ));
      return this.observations.get(contractId)!.current();
    });
  }

  public current(now: Date = new Date()): MultiInstrumentMarketPacket {
    const universeFreshness = buildUniverseFreshness(
      this.universe.contracts.map((contract) => (
        observationAgeMs(this.observations.get(contract.contract_id)!.current(), now.getTime())
      )),
      now,
    );
    return {
      schema_version: "glitch.topstep.market_universe.v1",
      market_data_mode: this.liveMarketData ? "live" : "simulated",
      generated_utc: now.toISOString(),
      generation: this.universe.generation,
      scope_hash: this.universe.scope_hash,
      scheduler: this.scheduler.status(),
      universe_freshness: universeFreshness,
      candidates: this.universe.contracts.map((contract) => {
        const marketObservation = this.observations.get(contract.contract_id)!.current();
        return {
          instrument: contract.instrument,
          contract_id: contract.contract_id,
          symbol_id: contract.symbol_id,
          tick_size: contract.tick_size,
          tick_value: contract.tick_value,
          execution_mode: contract.contract_id === this.selectedContractId ? "selected" : "observation_only",
          market_observation: marketObservation,
          observation_quality: summarizeScannerObservation(marketObservation),
          candidate_alignment: buildCandidateAlignment(
            marketObservation,
            null,
            now,
            universeFreshness.ranking_freshness_valid,
          ),
        };
      }),
    };
  }

  public async waitForIdle(): Promise<void> {
    await Promise.all([...this.observations.values()].map((service) => service.waitForIdle()));
    await this.scheduler.waitForIdle();
  }

  private contractIdsForPacketRefresh(now: Date): string[] {
    const asOfMs = now.getTime();
    return this.universe.contracts
      .filter((contract) => {
        if (contract.contract_id === this.selectedContractId) {
          return true;
        }
        const age = observationAgeMs(this.observations.get(contract.contract_id)!.current(), asOfMs);
        return age === null || age >= PACKET_OBSERVATION_STALE_MS;
      })
      .map((contract) => contract.contract_id);
  }

  private refreshContractsParallel(contractIds: string[]): Promise<MarketObservationState[]> {
    return Promise.all(contractIds.map((contractId) => this.observations.get(contractId)!.refresh()));
  }

  private withScheduleMinHeadroom<T>(minHeadroom: number, run: () => Promise<T>): Promise<T> {
    const previous = this.scheduleMinHeadroom;
    this.scheduleMinHeadroom = minHeadroom;
    return run().finally(() => {
      this.scheduleMinHeadroom = previous;
    });
  }

  private enqueueUniverseRefresh<T>(run: () => Promise<T>): Promise<T> {
    const next = this.refreshChain.then(run, run);
    this.refreshChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}