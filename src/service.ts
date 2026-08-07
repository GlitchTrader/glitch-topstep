import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { RecoveredExecutionResolution } from "./domain/execution-state.js";
import type { OrderInfo, PositionInfo } from "./domain/models.js";
import { ExecutionCoordinator } from "./execution/coordinator.js";
import { recoverExecutionMutations } from "./execution/recovery.js";
import { reconcilePendingReceipts } from "./execution/receipt-reconciliation.js";
import { DecisionPacketService } from "./hermes/packet-service.js";
import { ProjectXMarketObservationService } from "./market/projectx-observation-service.js";
import { ProjectXOrderFlowService } from "./market/projectx-order-flow-service.js";
import { ProjectXApiClient, ProjectXApiError } from "./projectx/client.js";
import { ProjectXHistorySyncService } from "./projectx/history-sync.js";
import { ProviderRestSnapshotRecorder } from "./projectx/provider-event-recorder.js";
import { ProjectXRealtimeClient } from "./projectx/realtime.js";
import {
  buildReconnectProof,
  snapshotReconnectPhase,
  type ReconnectProofPhase,
} from "./projectx/reconnect-proof.js";
import { LocalGatewayServer } from "./server/local-gateway.js";
import { GATEWAY_COMPATIBILITY } from "./release/compatibility.js";
import { ProjectXOrderOwnershipService } from "./ownership/projectx-order-ownership.js";
import { resolveGatewayMode } from "./execution/gateway-mode.js";
import { evaluateSnapshotDataQuality } from "./state/data-quality.js";
import { VenueStateStore } from "./state/venue-state.js";
import { TradeOutcomePublisher, isIncompleteOutcome, outcomeSharesForeignClosingFill } from "./learning/trade-outcome-publisher.js";
import {
  latchProvenProtectionFromReceipt,
  preferRicherClosedTranches,
  projectedInstrumentOpenContracts,
  shouldPublishTradeOutcomesOnFlat,
  tranchesForClosedPosition,
  type TradeOutcomeFlatTrigger,
} from "./learning/trade-outcome-flat.js";
import { TradeExcursionTracker } from "./learning/trade-excursion-tracker.js";
import type { TrancheView } from "./ownership/tranches.js";
import { SqliteExecutionStore } from "./storage/sqlite-execution-store.js";
import { JsonlEventStore } from "./storage/jsonl-event-store.js";
import { TradeOutcomeStore } from "./storage/trade-outcome-store.js";
import { SqliteProviderEvidenceStore } from "./storage/sqlite-provider-evidence-store.js";

const DEFAULT_PROVIDER_HISTORY = {
  initialLookbackHours: 168,
  overlapMinutes: 1_440,
  windowMinutes: 1_440,
  syncIntervalMs: 60_000,
} as const;
const MARKET_OBSERVATION_REFRESH_MS = 60_000;
const MARKET_OBSERVATION_BAR_LIMIT = 500;
const MARKET_OBSERVATION_LOOKBACK_MULTIPLIER = 3;
const ORDER_FLOW_REFRESH_MS = 10_000;
const ORDER_FLOW_MAX_EVENTS = 50_000;
const ORDER_FLOW_DEPTH_LEVELS = 10;

export class GlitchTopstepService {
  private readonly api: ProjectXApiClient;
  private readonly state = new VenueStateStore();
  private readonly ledger: JsonlEventStore;
  private readonly executionStore: SqliteExecutionStore;
  private readonly tradeOutcomeStore: TradeOutcomeStore;
  private readonly tradeOutcomePublisher: TradeOutcomePublisher;
  private readonly providerEvidenceStore: SqliteProviderEvidenceStore;
  private readonly restEvidenceRecorder: ProviderRestSnapshotRecorder;
  private readonly historySync: ProjectXHistorySyncService;
  private readonly historySyncIntervalMs: number;
  private readonly marketObservation: ProjectXMarketObservationService;
  private orderFlow: ProjectXOrderFlowService | null = null;
  private realtime: ProjectXRealtimeClient | null = null;
  private gateway: LocalGatewayServer | null = null;
  private coordinator: ExecutionCoordinator | null = null;
  private ownershipService: ProjectXOrderOwnershipService | null = null;
  private packets: DecisionPacketService | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private historySyncTimer: NodeJS.Timeout | null = null;
  private marketObservationTimer: NodeJS.Timeout | null = null;
  private orderFlowTimer: NodeJS.Timeout | null = null;
  private reconciliationInFlight = false;
  private tradeOutcomePublishInFlight = false;
  private lastReconciledOpenContracts = 0;
  private cachedOpenTranches: TrancheView[] = [];
  private readonly tradeExcursion = new TradeExcursionTracker();
  private storesClosed = false;

  public constructor(private readonly config: AppConfig) {
    this.api = new ProjectXApiClient({
      apiUrl: config.projectX.apiUrl,
      username: config.projectX.username,
      apiKey: config.projectX.apiKey,
    });
    this.ledger = new JsonlEventStore(config.dataDir);
    this.executionStore = new SqliteExecutionStore(
      join(config.dataDir, "glitch-topstep.sqlite"),
    );
    this.tradeOutcomeStore = new TradeOutcomeStore(
      config.dataDir,
      "trade-outcomes.jsonl",
      config.outcomesExportPath,
    );
    this.tradeOutcomePublisher = new TradeOutcomePublisher(this.api, this.tradeOutcomeStore);
    this.providerEvidenceStore = new SqliteProviderEvidenceStore(
      join(config.dataDir, "projectx-evidence.sqlite"),
      {
        marketEventRetention: config.providerEvidence.marketEventRetention,
        marketPruneInterval: config.providerEvidence.marketPruneInterval,
      },
    );
    this.restEvidenceRecorder = new ProviderRestSnapshotRecorder(this.providerEvidenceStore);
    const history = config.providerHistory ?? DEFAULT_PROVIDER_HISTORY;
    this.historySyncIntervalMs = history.syncIntervalMs;
    this.historySync = new ProjectXHistorySyncService(
      this.api,
      this.providerEvidenceStore,
      {
        accountId: config.scope.accountId,
        initialLookbackHours: history.initialLookbackHours,
        overlapMinutes: history.overlapMinutes,
        windowMinutes: history.windowMinutes,
        generation: () => this.state.operationalStatus().generation,
      },
    );
    this.marketObservation = new ProjectXMarketObservationService(
      this.api,
      {
        contractId: config.scope.contractId,
        instrument: config.scope.instrument,
        live: config.scope.liveMarketData,
        barLimit: MARKET_OBSERVATION_BAR_LIMIT,
        lookbackMultiplier: MARKET_OBSERVATION_LOOKBACK_MULTIPLIER,
      },
    );
  }

  public async start(): Promise<void> {
    await this.api.login();
    const [accounts, contracts, positions, orders] = await this.fetchStartupScope();

    const account = accounts.find((candidate) => candidate.id === this.config.scope.accountId);
    if (!account) {
      throw new Error(`configured_account_not_found:${this.config.scope.accountId}`);
    }
    if (account.name !== this.config.scope.accountName) {
      throw new Error(`configured_account_name_mismatch:${account.name}`);
    }
    const contract = contracts.find((candidate) => candidate.id === this.config.scope.contractId);
    if (!contract) {
      throw new Error(`configured_contract_not_found:${this.config.scope.contractId}`);
    }
    this.orderFlow = new ProjectXOrderFlowService(
      join(this.config.dataDir, "projectx-evidence.sqlite"),
      {
        contractId: this.config.scope.contractId,
        tickSize: contract.tickSize,
        maxEvents: ORDER_FLOW_MAX_EVENTS,
        depthLevels: ORDER_FLOW_DEPTH_LEVELS,
      },
    );

    const receivedAt = new Date().toISOString();
    this.recordRestSnapshot(
      "accounts_snapshot",
      receivedAt,
      sortedById(accounts),
      this.config.scope.accountId,
      null,
    );
    this.recordRestSnapshot(
      "contracts_snapshot",
      receivedAt,
      sortedById(contracts),
      null,
      this.config.scope.contractId,
    );
    this.recordRestSnapshot(
      "positions_snapshot",
      receivedAt,
      sortedById(positions),
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    this.recordRestSnapshot(
      "open_orders_snapshot",
      receivedAt,
      sortedById(orders),
      this.config.scope.accountId,
      this.config.scope.contractId,
    );

    this.state.registerContracts(contracts);
    this.state.replaceAccounts(accounts, receivedAt);
    this.state.replacePositions(positions, receivedAt);
    this.state.replaceOrders(orders, receivedAt);
    await Promise.all([
      this.historySync.sync(),
      this.marketObservation.refresh(),
      this.orderFlow.refresh(),
    ]);
    const initialRecovery = await recoverExecutionMutations(
      this.executionStore,
      this.api,
      this.config.scope.accountId,
      this.config.scope.contractId,
      positions,
      undefined,
      {
        accountName: this.config.scope.accountName,
        instrument: this.config.scope.instrument,
        openOrders: orders,
      },
    );
    await this.persistRecoveryResolutions(initialRecovery.resolutions);
    this.reconcileEntrySubmissionLatch(positions, orders);

    const ownershipConfig = this.config.localGateway.ownership;
    if (ownershipConfig) {
      this.ownershipService = new ProjectXOrderOwnershipService(
        ownershipConfig.executionDatabasePath,
        ownershipConfig.evidenceDatabasePath,
        {
          accountId: ownershipConfig.accountId,
          accountName: ownershipConfig.accountName,
          contractId: ownershipConfig.contractId,
          instrument: ownershipConfig.instrument,
        },
      );
    }

    const snapshot = () => this.state.buildSnapshot(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    await this.tradeOutcomeStore.load();
    this.packets = new DecisionPacketService(
      this.config,
      snapshot,
      this.executionStore,
      () => this.executionStore.recoveryStatus(),
      Date.now,
      () => this.marketObservation.current(),
      () => this.orderFlow?.current() ?? {
        last_attempt_utc: null,
        last_succeeded_utc: null,
        last_error: "order_flow_service_unavailable",
        observation: null,
      },
      () => this.ownershipService?.current(snapshot().instrumentOpenContracts).tranches ?? [],
      () => this.tradeOutcomeStore.all(),
      () => this.tradeOutcomeStore.isLoaded(),
    );

    this.realtime = new ProjectXRealtimeClient(
      {
        userHubUrl: this.config.projectX.userHubUrl,
        marketHubUrl: this.config.projectX.marketHubUrl,
        token: () => this.api.sessionToken,
        accountId: this.config.scope.accountId,
        contractId: this.config.scope.contractId,
        evidence: this.providerEvidenceStore,
        onReconnected: async () => {
          this.packets?.invalidateAll();
          await Promise.all([
            this.reconcile().catch((error: unknown) => {
              console.error("ProjectX reconciliation failed after reconnect", error);
            }),
            this.historySync.sync(),
            this.marketObservation.refresh(),
            this.orderFlow?.refresh() ?? Promise.resolve(null),
          ]);
          this.packets?.invalidateAll();
        },
        onStateInvalidated: async () => {
          this.packets?.invalidateAll();
          try {
            await this.reconcile();
          } catch (error: unknown) {
            console.error("ProjectX reconciliation failed after state invalidation", error);
          }
        },
        onBeforePositionApply: (position, receivedUtc) => {
          this.handleStreamPositionBeforeApply(position, receivedUtc);
        },
      },
      this.state,
    );
    await this.realtime.start();
    try {
      await this.reconcile();
    } catch (error: unknown) {
      console.error("ProjectX reconciliation failed during service start", error);
    }

    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        console.error("ProjectX reconciliation failed", error);
      });
    }, this.config.reconcileIntervalMs);
    this.reconciliationTimer.unref();

    this.historySyncTimer = setInterval(() => {
      void this.historySync.sync().catch((error: unknown) => {
        console.error("ProjectX history synchronization failed", error);
      });
    }, this.historySyncIntervalMs);
    this.historySyncTimer.unref();

    // Refreshing observation data does not retract a packet: it feeds the snapshot hash, so a
    // stale packet already fails to resolve. Invalidating here only killed packets a client
    // was still holding.
    this.marketObservationTimer = setInterval(() => {
      void this.marketObservation.refresh();
    }, MARKET_OBSERVATION_REFRESH_MS);
    this.marketObservationTimer.unref();

    this.orderFlowTimer = setInterval(() => {
      void this.orderFlow?.refresh();
    }, ORDER_FLOW_REFRESH_MS);
    this.orderFlowTimer.unref();

    const coordinator = new ExecutionCoordinator(
      this.config,
      this.api,
      this.ledger,
      this.executionStore,
      snapshot,
      (snapshotHash) => this.packets?.resolve(snapshotHash) ?? null,
      () => this.packets?.invalidateAll(),
      () => this.ownershipService?.current(snapshot().instrumentOpenContracts).tranches ?? [],
    );
    this.coordinator = coordinator;
    this.gateway = new LocalGatewayServer(
      this.config.localGateway,
      () => {
        const recordedAt = new Date();
        const current = snapshot();
        const quality = evaluateSnapshotDataQuality(current, this.config.risk, recordedAt);
        const executionRecovery = this.executionStore.recoveryStatus();
        const providerHistory = this.historySync.currentStatus();
        const marketObservation = this.marketObservation.current();
        const orderFlow = this.orderFlow?.current() ?? {
          last_attempt_utc: null,
          last_succeeded_utc: null,
          last_error: "order_flow_service_unavailable",
          observation: null,
        };
        const gatewayMode = resolveGatewayMode(
          this.config.tradingMode,
          current,
          this.config.risk,
          orderFlow,
          recordedAt,
        );
        return {
          schema_version: "glitch.direct.health.v2",
          compatibility: GATEWAY_COMPATIBILITY,
          status:
            quality.stateComplete
            && !executionRecovery.blockingAmbiguity
            && providerHistory.lastError === null
            && marketObservation.last_error === null
            && orderFlow.last_error === null
              ? "ok"
              : "degraded",
          trading_mode: this.config.tradingMode,
          gateway_mode: gatewayMode.effective,
          gateway_mode_downgrade_reason: gatewayMode.downgradeReason,
          recorded_utc: recordedAt.toISOString(),
          data_quality: {
            state_complete: quality.stateComplete,
            issues: quality.issues,
            quote_age_ms: quality.quoteAgeMs,
            state_age_ms: quality.stateAgeMs,
            operational: current.operational,
          },
          execution_recovery: executionRecovery,
          provider_evidence: this.providerEvidenceStore.status(),
          provider_history: providerHistory,
          market_observation: marketObservation,
          order_flow: orderFlow,
        };
      },
      snapshot,
      () => {
        if (!this.packets) {
          throw new Error("packet_service_unavailable");
        }
        return this.packets.current();
      },
      (limit) => this.providerEvidenceStore.recent(limit),
      coordinator,
      this.ownershipService,
      (limit) => this.tradeOutcomeStore.recent(limit),
      process.env.GLITCH_ACCEPTANCE_STREAM_GAP === "1"
        ? () => this.forceAcceptanceStreamGap()
        : undefined,
    );
    await this.gateway.start();

    this.tokenRefreshTimer = setInterval(() => {
      void this.api.validateSession().catch((error: unknown) => {
        console.error("ProjectX session validation failed", error);
      });
    }, 12 * 60 * 60 * 1000);
    this.tokenRefreshTimer.unref();

    await this.ledger.append({
      schema_version: "glitch.direct.event.v1",
      event_id: randomUUID(),
      recorded_utc: new Date().toISOString(),
      event: "service_started",
      payload: {
        account_id: account.id,
        account_name: account.name,
        simulated: account.simulated ?? null,
        contract_id: contract.id,
        instrument: this.config.scope.instrument,
        trading_mode: this.config.tradingMode,
        policy_authority: this.config.policy.authority,
        execution_recovery: this.executionStore.recoveryStatus(),
        provider_evidence: this.providerEvidenceStore.status(),
        provider_history: this.historySync.currentStatus(),
        market_observation: this.marketObservation.current(),
        order_flow: this.orderFlow.current(),
      },
    });
  }

  public async stop(): Promise<void> {
    if (this.orderFlowTimer) {
      clearInterval(this.orderFlowTimer);
      this.orderFlowTimer = null;
    }
    if (this.marketObservationTimer) {
      clearInterval(this.marketObservationTimer);
      this.marketObservationTimer = null;
    }
    if (this.historySyncTimer) {
      clearInterval(this.historySyncTimer);
      this.historySyncTimer = null;
    }
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    await Promise.allSettled([
      this.gateway?.stop() ?? Promise.resolve(),
      this.realtime?.stop() ?? Promise.resolve(),
    ]);
    this.ownershipService?.close();
    this.ownershipService = null;
    await Promise.all([
      this.historySync.waitForIdle(),
      this.marketObservation.waitForIdle(),
      this.orderFlow?.waitForIdle() ?? Promise.resolve(),
    ]);
    this.orderFlow?.close();
    this.orderFlow = null;
    this.gateway = null;
    this.realtime = null;
    this.packets = null;
    if (!this.storesClosed) {
      this.providerEvidenceStore.close();
      this.executionStore.close();
      this.storesClosed = true;
    }
  }

  private async fetchStartupScope(): Promise<
    [Awaited<ReturnType<ProjectXApiClient["searchAccounts"]>>,
      Awaited<ReturnType<ProjectXApiClient["listAvailableContracts"]>>,
      Awaited<ReturnType<ProjectXApiClient["searchOpenPositions"]>>,
      Awaited<ReturnType<ProjectXApiClient["searchOpenOrders"]>>]
  > {
    const retryDelaysMs = [0, 30_000, 60_000];
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      const delayMs = retryDelaysMs[attempt] ?? 0;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        return await Promise.all([
          this.api.searchAccounts(true),
          this.api.listAvailableContracts(this.config.scope.liveMarketData),
          this.api.searchOpenPositions(this.config.scope.accountId),
          this.api.searchOpenOrders(this.config.scope.accountId),
        ]);
      } catch (error: unknown) {
        const rateLimited = error instanceof ProjectXApiError && error.status === 429;
        const nextDelayMs = retryDelaysMs[attempt + 1];
        if (rateLimited && nextDelayMs !== undefined) {
          console.error(
            `ProjectX startup fetch rate limited; retrying in ${nextDelayMs / 1000}s`,
            error,
          );
          continue;
        }
        throw error;
      }
    }
    throw new Error("startup_scope_fetch_exhausted");
  }

  private async reconcile(): Promise<void> {
    if (this.reconciliationInFlight) {
      return;
    }
    this.reconciliationInFlight = true;
    this.state.markReconciliationStarted();
    try {
      const beforeOpen = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      ).instrumentOpenContracts;
      const openTranches = this.resolveClosedTranchesForFlat(beforeOpen);
      const [accounts, positions, orders] = await Promise.all([
        this.api.searchAccounts(true),
        this.api.searchOpenPositions(this.config.scope.accountId),
        this.api.searchOpenOrders(this.config.scope.accountId),
      ]);
      const account = accounts.find((candidate) => candidate.id === this.config.scope.accountId);
      if (!account || account.name !== this.config.scope.accountName) {
        throw new Error("configured_account_disappeared_or_changed");
      }

      const receivedAt = new Date().toISOString();
      this.recordRestSnapshot(
        "accounts_snapshot",
        receivedAt,
        sortedById(accounts),
        this.config.scope.accountId,
        null,
      );
      this.recordRestSnapshot(
        "positions_snapshot",
        receivedAt,
        sortedById(positions),
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      this.recordRestSnapshot(
        "open_orders_snapshot",
        receivedAt,
        sortedById(orders),
        this.config.scope.accountId,
        this.config.scope.contractId,
      );

      this.state.replaceAccounts(accounts, receivedAt);
      this.state.replacePositions(positions, receivedAt);
      this.state.replaceOrders(orders, receivedAt);
      this.state.markReconciliationSucceeded(receivedAt);

      const afterOpen = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      ).instrumentOpenContracts;
      if (shouldPublishTradeOutcomesOnFlat({
        beforeOpen,
        afterOpen,
        lastReconciledOpenContracts: this.lastReconciledOpenContracts,
        tranches: openTranches,
      })) {
        await this.publishTradeOutcomesOnFlat(openTranches, receivedAt, "reconcile");
      }
      this.lastReconciledOpenContracts = afterOpen;
      if (afterOpen > 0) {
        this.refreshCachedOpenTranches(afterOpen);
        this.tradeExcursion.observe(afterOpen, this.state.buildSnapshot(
          this.config.scope.accountId,
          this.config.scope.contractId,
        ).unrealizedPnl);
      } else {
        this.cachedOpenTranches = [];
        await this.retryIncompleteTradeOutcomes(receivedAt);
      }

      const latchCleared = this.reconcileEntrySubmissionLatch(positions, orders);
      const positionOpen = positions.some(
        (position) => position.accountId === this.config.scope.accountId
          && position.contractId === this.config.scope.contractId
          && position.type !== 0
          && Math.abs(position.size) > 0,
      );
      const receiptReconciliation = reconcilePendingReceipts(
        this.executionStore,
        orders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        positionOpen,
        receivedAt,
      );
      const requiresRecovery = this.executionStore.recoveryStatus().unresolvedMutations > 0
        || this.executionStore.terminalMutationsWithoutReceipts().length > 0
        || this.executionStore.intentsWithoutReceiptsOrMutations().length > 0;
      if (requiresRecovery) {
        const before = JSON.stringify(this.executionStore.recoveryStatus());
        const recovery = await recoverExecutionMutations(
          this.executionStore,
          this.api,
          this.config.scope.accountId,
          this.config.scope.contractId,
          positions,
          undefined,
          {
            accountName: this.config.scope.accountName,
            instrument: this.config.scope.instrument,
            openOrders: orders,
          },
        );
        await this.persistRecoveryResolutions(recovery.resolutions);
        if (JSON.stringify(this.executionStore.recoveryStatus()) !== before) {
          this.packets?.invalidateAll();
        }
      }
      if (latchCleared || receiptReconciliation.changed) {
        this.packets?.invalidateAll();
      }
      for (const event of receiptReconciliation.events) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: receivedAt,
          event: event.event,
          payload: event,
        });
      }
      if (afterOpen > 0) {
        // Bracket confirmation updates ownership; refresh cache after receipts so stream-flat
        // can keep proven SL/TP ids when Auto OCO removes working brackets on exit.
        this.refreshCachedOpenTranches(afterOpen);
      }
      const liveSnapshot = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      if (this.coordinator) {
        if (liveSnapshot.instrumentOpenContracts === 0) {
          const swept = await this.coordinator.sweepOrphanProtectiveOrders(liveSnapshot);
          if (swept) {
            this.packets?.invalidateAll();
          }
        } else {
          const rearmed = await this.coordinator.rearmTrancheProtection(liveSnapshot);
          if (rearmed) {
            this.packets?.invalidateAll();
          }
        }
      }
    } catch (error) {
      this.state.markReconciliationFailed(error);
      throw error;
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  private handleStreamPositionBeforeApply(position: PositionInfo, receivedUtc: string): void {
    if (position.accountId !== this.config.scope.accountId
      || position.contractId !== this.config.scope.contractId) {
      return;
    }
    const snapshot = this.state.buildSnapshot(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    const beforeOpen = snapshot.instrumentOpenContracts;
    if (beforeOpen === 0) {
      return;
    }
    const afterOpen = projectedInstrumentOpenContracts(
      snapshot.positions,
      this.config.scope.accountId,
      this.config.scope.contractId,
      position,
    );
    if (afterOpen > 0) {
      this.refreshCachedOpenTranches(afterOpen);
      const live = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      this.tradeExcursion.observe(afterOpen, live.unrealizedPnl);
      return;
    }
    // Capture excursion against the last open unrealized before publishing.
    this.tradeExcursion.observe(beforeOpen, snapshot.unrealizedPnl);
    const tranches = this.resolveClosedTranchesForFlat(beforeOpen);
    void this.publishTradeOutcomesOnFlat(tranches, receivedUtc, "stream").catch((error: unknown) => {
      console.error("Trade outcome publication failed after stream flat", error);
    });
  }

  private resolveClosedTranchesForFlat(beforeOpen: number): TrancheView[] {
    const live = this.ownershipService
      ? tranchesForClosedPosition(
        this.ownershipService.current(beforeOpen > 0 ? beforeOpen : 0).tranches,
      )
      : [];
    const cached = this.cachedOpenTranches.length > 0
      ? tranchesForClosedPosition(this.cachedOpenTranches)
      : [];
    return preferRicherClosedTranches(live, cached);
  }

  private refreshCachedOpenTranches(openContracts: number): void {
    if (!this.ownershipService || openContracts <= 0) {
      return;
    }
    const active = this.ownershipService.current(openContracts).tranches
      .filter((tranche) => tranche.remaining_qty > 0)
      .map((tranche) => this.enrichClosedTrancheForOutcome(tranche));
    if (active.length > 0) {
      this.cachedOpenTranches = preferRicherClosedTranches(active, this.cachedOpenTranches);
    }
  }

  private enrichClosedTrancheForOutcome(tranche: TrancheView): TrancheView {
    const receipt = this.executionStore.receiptForIntent<{
      code?: string;
      detail?: string | null;
    }>(tranche.intent_id);
    const intent = this.executionStore.registeredIntentPayload(tranche.intent_id);
    return latchProvenProtectionFromReceipt(tranche, receipt, {
      stop: intent?.stopLoss ?? null,
      target: intent?.takeProfit1 ?? null,
    });
  }

  private async retryIncompleteTradeOutcomes(exitUtc: string): Promise<void> {
    if (!this.ownershipService) {
      return;
    }
    await this.tradeOutcomeStore.load();
    const filled = this.ownershipService.current(0).tranches
      .filter((tranche) => tranche.filled_qty > 0);
    const incomplete = filled.filter((tranche) => {
      const existing = this.tradeOutcomeStore.get(tranche.intent_id);
      if (existing === undefined) {
        return false;
      }
      return isIncompleteOutcome(existing)
        || outcomeSharesForeignClosingFill(existing, this.tradeOutcomeStore);
    });
    if (incomplete.length === 0) {
      return;
    }
    await this.publishTradeOutcomesOnFlat(incomplete, exitUtc, "reconcile");
  }

  private async publishTradeOutcomesOnFlat(
    tranches: readonly TrancheView[],
    exitUtc: string,
    trigger: TradeOutcomeFlatTrigger,
  ): Promise<void> {
    if (tranches.length === 0 || this.tradeOutcomePublishInFlight) {
      return;
    }
    this.tradeOutcomePublishInFlight = true;
    try {
      const snapshot = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      const excursion = this.tradeExcursion.excursionUsd();
      const enriched = tranches.map((tranche) => this.enrichClosedTrancheForOutcome(tranche));
      const decisionLinks = new Map<string, { packet_id: string | null; snapshot_hash: string | null }>();
      for (const tranche of enriched) {
        const link = this.executionStore.decisionLinkForIntent(tranche.intent_id);
        if (link) {
          decisionLinks.set(tranche.intent_id, link);
        }
      }
      const published = await this.tradeOutcomePublisher.publishClosedTranches({
        accountId: this.config.scope.accountId,
        accountName: this.config.scope.accountName,
        contractId: this.config.scope.contractId,
        instrument: this.config.scope.instrument,
        tranches: enriched,
        exitUtc,
        trigger,
        tickSize: snapshot.contract.tickSize,
        tickValue: snapshot.contract.tickValue,
        maeUsd: excursion?.mae_usd ?? null,
        mfeUsd: excursion?.mfe_usd ?? null,
        decisionLinks,
      });
      if (published.length > 0) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: exitUtc,
          event: "trade_outcomes_published",
          payload: {
            count: published.length,
            intent_ids: published.map((outcome) => outcome.intent_id),
            trigger,
          },
        });
        this.cachedOpenTranches = [];
        this.lastReconciledOpenContracts = 0;
        this.tradeExcursion.reset();
      }
    } finally {
      this.tradeOutcomePublishInFlight = false;
    }
  }

  private recordRestSnapshot(
    eventType: string,
    receivedUtc: string,
    normalizedPayload: unknown,
    accountId: number | null,
    contractId: string | null,
  ): boolean {
    return this.restEvidenceRecorder.recordIfChanged({
      receivedUtc,
      eventType,
      generation: this.state.operationalStatus().generation,
      accountId,
      contractId,
      normalizedPayload,
    });
  }

  private reconcileEntrySubmissionLatch(
    positions: PositionInfo[],
    orders: OrderInfo[],
  ): boolean {
    const intentId = this.executionStore.entrySubmissionIntentId();
    if (!intentId) {
      return false;
    }
    const mutation = this.executionStore.mutationForIntent(intentId);
    if (!mutation || mutation.operation !== "place_order") {
      return false;
    }

    const positionObserved = positions.some(
      (position) => position.accountId === this.config.scope.accountId
        && position.contractId === this.config.scope.contractId
        && position.type !== 0
        && Math.abs(position.size) > 0,
    );
    const orderObserved = mutation.customTag !== null && orders.some(
      (order) => order.accountId === this.config.scope.accountId
        && order.contractId === this.config.scope.contractId
        && order.customTag === mutation.customTag,
    );
    return positionObserved || orderObserved
      ? this.executionStore.clearEntrySubmissionLatch(intentId)
      : false;
  }

  private async persistRecoveryResolutions(
    resolutions: RecoveredExecutionResolution[],
  ): Promise<void> {
    for (const resolution of resolutions) {
      const recordedUtc = new Date().toISOString();
      const status = resolution.outcome === "ambiguous"
        ? "ambiguous"
        : resolution.outcome === "ignored"
          ? "ignored"
          : resolution.outcome === "confirmed_not_submitted" || resolution.outcome === "rejected"
            ? "rejected"
            : resolution.operation === "close_position"
              ? "closed"
              : "submitted";
      const receipt = {
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: randomUUID(),
        recorded_utc: recordedUtc,
        intent_id: resolution.intentId,
        mode: this.config.tradingMode,
        status,
        code: resolution.code,
        ...(resolution.providerOrderId === null
          ? {}
          : { order_id: resolution.providerOrderId }),
        detail: resolution.detail
          ?? "Recovered from durable outbox and current ProjectX evidence.",
      };
      this.executionStore.recordReceipt(receipt);
      try {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: receipt.receipt_id,
          recorded_utc: recordedUtc,
          event: "execution_recovery_receipt",
          payload: receipt,
        });
      } catch (error) {
        console.error("SQLite recovery receipt committed but JSONL evidence mirror failed", error);
      }
    }
  }

  public async forceAcceptanceStreamGap(): Promise<{ phases: ReconnectProofPhase[] }> {
    if (process.env.GLITCH_ACCEPTANCE_STREAM_GAP !== "1") {
      throw new Error("acceptance_stream_gap_forbidden");
    }
    if (!this.packets) {
      throw new Error("packet_service_unavailable");
    }

    const accountId = this.config.scope.accountId;
    const contractId = this.config.scope.contractId;
    const stamp = () => new Date().toISOString();

    const packetBefore = this.packets.current();
    const hashBefore = packetBefore.market.snapshot_hash;
    const baseline = snapshotReconnectPhase(
      "baseline",
      this.state.buildSnapshot(accountId, contractId),
      hashBefore,
      this.packets.resolve(hashBefore) !== null,
      stamp(),
    );

    this.state.markStreamReconnecting("market", new Error("acceptance_forced_gap"));
    this.packets.invalidateAll();
    const gap = snapshotReconnectPhase(
      "after_stream_gap",
      this.state.buildSnapshot(accountId, contractId),
      hashBefore,
      this.packets.resolve(hashBefore) !== null,
      stamp(),
    );

    await this.reconcile();
    this.state.markStreamConnected("market");
    this.state.markStreamEvent("market");

    const packetAfter = this.packets.current();
    const hashAfter = packetAfter.market.snapshot_hash;
    const settled = snapshotReconnectPhase(
      "after_reconciliation",
      this.state.buildSnapshot(accountId, contractId),
      hashAfter,
      this.packets.resolve(hashAfter) !== null,
      stamp(),
    );

    return { phases: [baseline, gap, settled] };
  }
}

function sortedById<T extends { id: number | string }>(values: T[]): T[] {
  return [...values].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
