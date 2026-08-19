import type { AppConfig } from "../config.js";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { MarketObservationState } from "../domain/market-observation.js";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import { computeDailyEconomics } from "../policy/daily-economics.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";
import {
  buildDecisionPacket,
  emptyMarketObservationState,
  emptyOrderFlowState,
  type BracketVerificationContext,
  type DirectDecisionPacket,
} from "./packet-builder.js";
import type { TrancheView } from "../ownership/tranches.js";

export class DecisionPacketService {
  public constructor(
    private readonly config: AppConfig,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly store: SqliteExecutionStore,
    private readonly recovery: () => ExecutionRecoveryStatus,
    private readonly now: () => number = Date.now,
    private readonly marketObservation: () => MarketObservationState = emptyMarketObservationState,
    private readonly orderFlow: () => ProjectXOrderFlowState = emptyOrderFlowState,
    private readonly tranches: () => TrancheView[] = () => [],
    private readonly tradeOutcomes: () => TradeOutcomeV1[] = () => [],
    private readonly tradeOutcomesLoaded: () => boolean = () => false,
    private readonly decisionScope: () => { generation: number; scopeHash: string } | undefined = () => undefined,
    private readonly effectiveTradingMode: () => "disabled" | "shadow" | "armed" = () => this.config.tradingMode,
  ) {}

  public current(): DirectDecisionPacket {
    const nowMs = this.now();
    const now = new Date(nowMs);
    const venueSnapshot = this.snapshot();
    const qualityStateComplete = venueSnapshot.stateComplete;
    const bracketVerification: BracketVerificationContext = {
      fillObservedUtc: this.store.earliestPendingEntryFillObservedUtc(),
      stateComplete: qualityStateComplete,
      nowUtc: now.toISOString(),
    };
    const dailyEconomics = computeDailyEconomics(
      this.config.dailyEconomics,
      this.config.session,
      this.config.policy,
      venueSnapshot.unrealizedPnl,
      venueSnapshot.conservativeEquity,
      this.tradeOutcomes(),
      this.tradeOutcomesLoaded(),
      now,
    );
    if (
      dailyEconomics?.daily_capture.reached === true
      && dailyEconomics.daily_capture.new_exposure_lock_configured
      && dailyEconomics.trading_day_id
    ) {
      this.store.latchDailyCapture(dailyEconomics.trading_day_id, now.toISOString());
    }
    const dailyCaptureLocked = this.store.isDailyCaptureLocked(
      dailyEconomics?.trading_day_id ?? null,
    );
    const packet = buildDecisionPacket(
      venueSnapshot,
      this.config.policy,
      this.config.risk,
      this.recovery(),
      this.config.scope.instrument,
      this.effectiveTradingMode(),
      this.config.packetLeaseMs,
      now,
      this.marketObservation(),
      this.orderFlow(),
      this.tranches(),
      this.config.session,
      dailyEconomics,
      bracketVerification,
      this.decisionScope(),
      dailyCaptureLocked,
      this.config.multiInstrument?.simultaneousExposureEnabled ?? false,
    );
    this.store.recordIssuedPacket(packet);
    return packet;
  }

  public resolve(snapshotHash: string): DirectDecisionPacket | null {
    return this.store.resolveIssuedPacket(snapshotHash, new Date(this.now()).toISOString());
  }

  public invalidateAll(): void {
    this.store.invalidateIssuedPackets(new Date(this.now()).toISOString());
  }
}
