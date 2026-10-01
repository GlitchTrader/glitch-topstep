import type { AppConfig } from "../config.js";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { MarketObservationState } from "../domain/market-observation.js";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import { computeDailyEconomics } from "../policy/daily-economics.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { MayPromise } from "../storage/may-promise.js";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";
import type { AccountSelectionMode } from "../market/active-position-scope.js";
import { RUNTIME_ACCOUNT_SELECTION_MODE } from "../market/active-position-scope.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";
import {
  buildDecisionPacket,
  emptyMarketObservationState,
  emptyOrderFlowState,
  type BracketVerificationContext,
  type DirectDecisionPacket,
} from "./packet-builder.js";
import type { TrancheView } from "../ownership/tranches.js";

export interface DecisionPacketBuildOptions {
  snapshot?: AccountVenueSnapshot;
  instrument?: string;
  marketObservation?: MarketObservationState;
  orderFlow?: ProjectXOrderFlowState;
  accountSelectionMode?: AccountSelectionMode;
}

export class DecisionPacketService {
  public constructor(
    private readonly config: AppConfig,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly store: MayPromise<SqliteExecutionStore>,
    private readonly recovery: () => ExecutionRecoveryStatus | Promise<ExecutionRecoveryStatus>,
    private readonly now: () => number = Date.now,
    private readonly marketObservation: () => MarketObservationState = emptyMarketObservationState,
    private readonly orderFlow: () => ProjectXOrderFlowState = emptyOrderFlowState,
    private readonly tranches: () => TrancheView[] | Promise<TrancheView[]> = () => [],
    private readonly tradeOutcomes: () => TradeOutcomeV1[] = () => [],
    private readonly tradeOutcomesLoaded: () => boolean = () => false,
    private readonly decisionScope: () => { generation: number; scopeHash: string } | undefined = () => undefined,
    private readonly effectiveTradingMode: () => "disabled" | "shadow" | "armed" = () => this.config.tradingMode,
    /** Fires once per trading day, right after the capture lock becomes durable. */
    private readonly onDailyCaptureLatched: () => void = () => {},
    private readonly authStatus: () => ProjectXAuthStatus = () => ({
      degraded: false,
      lastRefreshUtc: null,
      expiresAtUtc: null,
      refreshInFlight: false,
      refreshFailureCount: 0,
    }),
  ) {}

  public async current(options: DecisionPacketBuildOptions = {}): Promise<DirectDecisionPacket> {
    const nowMs = this.now();
    const now = new Date(nowMs);
    const venueSnapshot = options.snapshot ?? this.snapshot();
    const instrument = options.instrument ?? this.config.scope.instrument;
    const marketObservation = options.marketObservation ?? this.marketObservation();
    const orderFlow = options.orderFlow ?? this.orderFlow();
    const accountSelectionMode = options.accountSelectionMode ?? RUNTIME_ACCOUNT_SELECTION_MODE;
    const qualityStateComplete = venueSnapshot.stateComplete;
    const bracketVerification: BracketVerificationContext = {
      fillObservedUtc: await this.store.earliestPendingEntryFillObservedUtc(),
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
      const alreadyLatched = await this.store.isDailyCaptureLocked(dailyEconomics.trading_day_id);
      await this.store.latchDailyCapture(dailyEconomics.trading_day_id, now.toISOString());
      if (!alreadyLatched) {
        this.onDailyCaptureLatched();
      }
    }
    const dailyCaptureLocked = await this.store.isDailyCaptureLocked(
      dailyEconomics?.trading_day_id ?? null,
    );
    const packet = buildDecisionPacket(
      venueSnapshot,
      this.config.policy,
      this.config.risk,
      await this.recovery(),
      instrument,
      this.effectiveTradingMode(),
      this.config.packetLeaseMs,
      now,
      marketObservation,
      orderFlow,
      await this.tranches(),
      this.config.session,
      dailyEconomics,
      bracketVerification,
      this.decisionScope(),
      dailyCaptureLocked,
      this.config.multiInstrument?.simultaneousExposureEnabled ?? false,
      this.authStatus(),
      accountSelectionMode,
    );
    await this.store.recordIssuedPacket(packet);
    return packet;
  }

  public async resolve(snapshotHash: string): Promise<DirectDecisionPacket | null> {
    return await this.store.resolveIssuedPacket(snapshotHash, new Date(this.now()).toISOString());
  }

  public async invalidateAll(): Promise<void> {
    const nowUtc = new Date(this.now()).toISOString();
    await this.store.invalidateIssuedPackets(nowUtc);
    await this.store.pruneExpiredPackets(nowUtc);
  }
}
