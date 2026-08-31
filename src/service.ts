import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { RecoveredExecutionResolution } from "./domain/execution-state.js";
import type { OrderInfo, PositionInfo, AccountVenueSnapshot, VenueStreamKind } from "./domain/models.js";
import { ExecutionCoordinator } from "./execution/coordinator.js";
import { shouldClearStaleEntrySubmissionLatch } from "./execution/entry-submission-latch.js";
import { trancheLifecycleFact } from "./execution/lifecycle-facts.js";
import { recoverExecutionMutations } from "./execution/recovery.js";
import { DecisionPacketService } from "./hermes/packet-service.js";
import { ProjectXMarketObservationService } from "./market/projectx-observation-service.js";
import { ProjectXOrderFlowService } from "./market/projectx-order-flow-service.js";
import { ProjectXApiClient, ProjectXApiError } from "./projectx/client.js";
import {
  EvidenceWriteQueue,
  type EvidenceQueueMetrics,
} from "./projectx/evidence-write-queue.js";
import { ProjectXHistorySyncService } from "./projectx/history-sync.js";
import { ProviderRestSnapshotRecorder } from "./projectx/provider-event-recorder.js";
import { ProjectXRealtimeClient } from "./projectx/realtime.js";
import { HubRecoveryController } from "./projectx/hub-recovery-controller.js";
import { resolveTopstepSession } from "./policy/session-calendar.js";
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
import {
  DurableControlStore,
  parseControlCommand,
  type StoredControlCommand,
} from "./control/durable-control-store.js";
import {
  buildFlattenVenueSnapshot,
  resolveFlattenAfterReceipt,
  resolveFlattenAfterRestart,
  shouldCompletePendingFlatten,
} from "./service/flatten-workflow.js";
import { fetchWithStartupRetry } from "./service/auth-session-workflow.js";
import type { TradingMode } from "./domain/models.js";
import {
  GLITCH_TOPSTEP_OPERATOR_PROFILE,
  GLITCH_TOPSTEP_PROMPT_VERSION,
} from "./domain/operator.js";
import { LifecycleSupervisor, requiresShutdownRetention } from "./service/lifecycle-supervisor.js";
import { TaskScheduler } from "./service/task-scheduler.js";
import { runReconciliationCycle } from "./service/reconciliation-service.js";
import { RuntimeScopeLock } from "./service/runtime-lock.js";
import { evaluateSafetySupervisor } from "./safety/safety-supervisor.js";
import { buildInvariantMetrics } from "./observability/invariant-metrics.js";
import { HealthAlertTracker } from "./observability/health-alerts.js";
import {
  ProjectXAuthManager,
  projectXAuthBackoffDelayMs,
  type ProjectXAuthStatus,
} from "./projectx/auth-manager.js";
import { resolveInstrumentUniverse, type InstrumentUniverse } from "./domain/instrument-universe.js";
import { MultiInstrumentMarketDataPlane } from "./market/multi-instrument-data-plane.js";
import { resolveActivePositionScope, type ActivePositionScope } from "./market/active-position-scope.js";
import { buildScannerPacket, type ScannerPacket } from "./market/scanner-packet.js";
import type { MarketObservationState } from "./domain/market-observation.js";

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
const RECONCILE_METADATA_INTERVAL_MS = 15 * 60 * 1000;

export class GlitchTopstepService {
  private readonly authManager: ProjectXAuthManager;
  private readonly api: ProjectXApiClient;
  private readonly state = new VenueStateStore();
  private readonly ledger: JsonlEventStore;
  private readonly executionStore: SqliteExecutionStore;
  private readonly tradeOutcomeStore: TradeOutcomeStore;
  private readonly tradeOutcomePublisher: TradeOutcomePublisher;
  private readonly providerEvidenceStore: SqliteProviderEvidenceStore;
  private readonly evidenceQueue: EvidenceWriteQueue;
  private readonly controlStore: DurableControlStore;
  private readonly restEvidenceRecorder: ProviderRestSnapshotRecorder;
  private readonly historySync: ProjectXHistorySyncService;
  private readonly historySyncIntervalMs: number;
  private readonly marketObservation: ProjectXMarketObservationService;
  private instrumentUniverse: InstrumentUniverse | null = null;
  private scannerMarketData: MultiInstrumentMarketDataPlane | null = null;
  private orderFlow: ProjectXOrderFlowService | null = null;
  private orderFlows = new Map<string, ProjectXOrderFlowService>();
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
  private tradeOutcomePublication: Promise<void> | null = null;
  private lastReconciledOpenContracts = 0;
  private cachedOpenTranches: TrancheView[] = [];
  private readonly tradeExcursion = new TradeExcursionTracker();
  private storesClosed = false;
  private controlPaused = false;
  private runtimeTradingMode: TradingMode;
  private readonly lifecycle = new LifecycleSupervisor();
  /** Persists across /health polls so hysteresis/dedup state (TS-REAUDIT-11) is real, not per-call. */
  private readonly healthAlerts = new HealthAlertTracker();
  /** Coordinates the four periodic REST-bound timers below (TS-STREAM-RECOVERY-01 PR-F). */
  private readonly taskScheduler = new TaskScheduler({ maxConcurrent: 2 });
  private readonly marketHubRecovery = new HubRecoveryController();
  private lastMetadataReconcileAt: string | null = null;
  /** Bounded jittered backoff on repeated reconcile failures (TS-STREAM-RECOVERY-01 PR-G). */
  private reconcileConsecutiveFailures = 0;
  private nextReconcileAttemptAtMs = 0;
  private readonly runtimeLock: RuntimeScopeLock;
  private stopping: Promise<void> | null = null;
  private starting: Promise<void> | null = null;

  public constructor(private readonly config: AppConfig) {
    this.runtimeTradingMode = config.tradingMode;
    this.runtimeLock = new RuntimeScopeLock(config.dataDir, config.scope.accountId);
    this.authManager = new ProjectXAuthManager({
      apiUrl: config.projectX.apiUrl,
      username: config.projectX.username,
      apiKey: config.projectX.apiKey,
    });
    this.api = this.authManager.authenticatedClient();
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
    this.evidenceQueue = new EvidenceWriteQueue(this.providerEvidenceStore, {
      onStageIdentity: (event) => {
        this.providerEvidenceStore.stageIdentityOutbox(event);
      },
      onDegraded: (metrics) => {
        this.handleEvidenceQueueDegraded(metrics);
      },
      onRecovered: () => {
        this.state.markEvidenceBacklog(false);
        this.packets?.invalidateAll();
      },
      onWriteError: (error, pending) => {
        console.error("Provider evidence batch write failed", { pending }, error);
      },
      onApplyError: (error, event) => {
        this.state.markPayloadFault(
          event.source === "projectx_user_stream" ? "user" : "market",
          error,
        );
        console.error("Provider evidence apply failed after durable commit", error);
      },
    });
    this.controlStore = new DurableControlStore(join(config.dataDir, "glitch-topstep-controls.sqlite"));
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
    if (this.starting) return this.starting;
    this.starting = this.startSerial();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startSerial(): Promise<void> {
    this.lifecycle.transition("starting");
    await this.runtimeLock.acquire();
    try {
      await this.startResources();
    } catch (error: unknown) {
      // The lock is released by stop(); rollback only unwinds what this start acquired,
      // so a half-built service never reports ready.
      await this.lifecycle.rollbackAfterFailure(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async startResources(): Promise<void> {
    await this.authManager.ensureAuthenticated();
    while (true) {
      const pending = this.providerEvidenceStore.loadPendingOutboxEvents(500);
      if (pending.length === 0) {
        break;
      }
      for (const event of pending) {
        this.evidenceQueue.submit(event, null, { skipOutboxStage: true });
      }
      // ponytail: submit only schedules the writer; without await drain this loop never
      // yields, outbox stays pending, and startup busy-hangs before listen().
      await this.evidenceQueue.drain();
    }
    const [accountsCol, contractsCol, positionsCol, ordersCol] = await this.fetchStartupScope();
    const accounts = accountsCol.items;
    const contracts = contractsCol.items;
    const positions = positionsCol.items;
    const orders = ordersCol.items;

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
    const multi = this.config.multiInstrument ?? {
      allowlist: [this.config.scope.instrument],
      rolloverGeneration: 1,
      simultaneousExposureEnabled: false,
      depthAllowlist: [this.config.scope.instrument],
      historyRequestsPerMinute: 30,
    };
    this.instrumentUniverse = resolveInstrumentUniverse(
      multi.allowlist,
      contracts,
      multi.rolloverGeneration,
    );
    if (!this.instrumentUniverse.contracts.some((candidate) => candidate.contract_id === contract.id)) {
      throw new Error("configured_contract_not_in_resolved_universe");
    }
    this.scannerMarketData = new MultiInstrumentMarketDataPlane(
      this.api,
      this.instrumentUniverse,
      multi.historyRequestsPerMinute,
      contract.id,
      this.config.scope.liveMarketData,
    );
    this.orderFlows = new Map(this.instrumentUniverse.contracts.map((candidate) => [
      candidate.contract_id,
      new ProjectXOrderFlowService(
        join(this.config.dataDir, "projectx-evidence.sqlite"),
        {
          contractId: candidate.contract_id,
          tickSize: candidate.tick_size,
          maxEvents: ORDER_FLOW_MAX_EVENTS,
          depthLevels: ORDER_FLOW_DEPTH_LEVELS,
        },
      ),
    ]));
    this.orderFlow = this.orderFlows.get(contract.id) ?? null;

    const receivedAt = new Date().toISOString();
    this.recordRestSnapshot(
      "accounts_snapshot",
      receivedAt,
      sortedById(accounts),
      this.config.scope.accountId,
      null,
      accountsCol.envelope,
    );
    this.recordRestSnapshot(
      "contracts_snapshot",
      receivedAt,
      sortedById(contracts),
      null,
      this.config.scope.contractId,
      contractsCol.envelope,
    );
    this.recordRestSnapshot(
      "positions_snapshot",
      receivedAt,
      sortedById(positions),
      this.config.scope.accountId,
      this.config.scope.contractId,
      positionsCol.envelope,
    );
    this.recordRestSnapshot(
      "open_orders_snapshot",
      receivedAt,
      sortedById(orders),
      this.config.scope.accountId,
      this.config.scope.contractId,
      ordersCol.envelope,
    );

    this.state.registerContracts(contracts);
    this.state.replaceAccounts(accounts, receivedAt);
    this.state.replacePositions(positions, receivedAt);
    this.state.replaceOrders(orders, receivedAt);
    await Promise.all([
      this.historySync.sync(),
      this.refreshMarketObservations(),
      ...[...this.orderFlows.values()].map((service) => service.refresh()),
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
    this.reconcileEntrySubmissionLatch(positions, orders, new Date().toISOString());

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
      this.lifecycle.register("order_ownership", () => {
        this.ownershipService?.close();
        this.ownershipService = null;
      });
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
      () => this.currentMarketObservation(),
      () => this.orderFlow?.current() ?? {
        last_attempt_utc: null,
        last_succeeded_utc: null,
        last_error: "order_flow_service_unavailable",
        observation: null,
      },
      () => this.ownershipService?.current(snapshot().instrumentOpenContracts).tranches ?? [],
      () => this.tradeOutcomeStore.all(),
      () => this.tradeOutcomeStore.isLoaded(),
      () => this.instrumentUniverse === null
        ? undefined
        : { generation: this.instrumentUniverse.generation, scopeHash: this.instrumentUniverse.scope_hash },
      () => this.runtimeTradingMode,
      () => {
        void this.coordinator?.tightenOwnedStopsAfterCaptureLock();
      },
      () => this.authManager.status(),
    );

    this.realtime = new ProjectXRealtimeClient(
      {
        userHubUrl: this.config.projectX.userHubUrl,
        marketHubUrl: this.config.projectX.marketHubUrl,
        token: () => this.api.sessionToken,
        accountId: this.config.scope.accountId,
        contractId: this.config.scope.contractId,
        contractIds: this.instrumentUniverse.contracts.map((candidate) => candidate.contract_id),
        depthContractIds: this.instrumentUniverse.contracts
          .filter((candidate) => multi.depthAllowlist.includes(candidate.instrument))
          .map((candidate) => candidate.contract_id),
        evidence: this.evidenceQueue,
        marketRecovery: this.marketHubRecovery,
        onReconnected: async ({ kind, generation }) => {
          await this.handleHubReconnected(kind, generation);
        },
        onStateInvalidated: async () => {
          this.packets?.invalidateAll();
          try {
            await this.reconcile({ includeMetadata: false });
          } catch (error: unknown) {
            console.error("ProjectX reconciliation failed after state invalidation", error);
          }
        },
        onBeforePositionApply: (position, receivedUtc) => {
          this.handleStreamPositionBeforeApply(position, receivedUtc);
        },
        livenessMs: this.config.streamLivenessMs,
        isMarketExpectedLive: () => resolveTopstepSession(this.config.session).phase !== "maintenance",
      },
      this.state,
    );
    await this.realtime.start();
    this.lifecycle.register("realtime", async () => {
      await this.realtime?.stop();
      this.realtime = null;
    }, { critical: true });
    try {
      await this.reconcile({ includeMetadata: true });
      this.lastMetadataReconcileAt = new Date().toISOString();
    } catch (error: unknown) {
      console.error("ProjectX reconciliation failed during service start", error);
    }

    // Each timer below still fires on its own unchanged cadence; TaskScheduler only coordinates
    // ordering and concurrency of the resulting REST-bound work (TS-STREAM-RECOVERY-01 PR-F) --
    // it does not change what runs or how often it's requested, only how many run at once and
    // in what priority order a post-reconnect burst drains in.
    this.reconciliationTimer = setInterval(() => {
      // Skip this tick entirely while backed off from repeated failures, rather than hammering
      // ProjectX with reconcile calls every interval during an outage (TS-STREAM-RECOVERY-01 PR-G).
      if (Date.now() < this.nextReconcileAttemptAtMs) {
        return;
      }
      this.taskScheduler.enqueue("critical_reconcile", "reconcile", () => (
        this.reconcile().catch((error: unknown) => {
          console.error("ProjectX reconciliation failed", error);
        })
      ), this.config.reconcileIntervalMs);
    }, this.config.reconcileIntervalMs);
    this.reconciliationTimer.unref();
    this.lifecycle.register("reconciliation_timer", () => {
      this.clearTimer("reconciliationTimer");
    });

    this.historySyncTimer = setInterval(() => {
      this.taskScheduler.enqueue("history_sync", "history_sync", () => (
        this.historySync.sync().catch((error: unknown) => {
          console.error("ProjectX history synchronization failed", error);
        })
      ), this.historySyncIntervalMs);
    }, this.historySyncIntervalMs);
    this.historySyncTimer.unref();
    this.lifecycle.register("history_sync_timer", () => {
      this.clearTimer("historySyncTimer");
    });

    // Refreshing observation data does not retract a packet: it feeds the snapshot hash, so a
    // stale packet already fails to resolve. Invalidating here only killed packets a client
    // was still holding.
    this.marketObservationTimer = setInterval(() => {
      // The scheduler already logs failures via its onError handler; this timer doesn't need
      // the result, but must still handle the returned promise's rejection itself or it becomes
      // an unhandled rejection (a caller that DOES need the result, e.g. handleHubReconnected,
      // awaits and catches this same task id normally).
      this.taskScheduler.enqueue(
        "market_observation",
        "market_observation",
        () => this.refreshMarketObservations(),
        MARKET_OBSERVATION_REFRESH_MS,
      ).catch(() => undefined);
    }, MARKET_OBSERVATION_REFRESH_MS);
    this.marketObservationTimer.unref();
    this.lifecycle.register("market_observation_timer", () => {
      this.clearTimer("marketObservationTimer");
    });

    this.orderFlowTimer = setInterval(() => {
      this.taskScheduler.enqueue("order_flow", "order_flow", async () => {
        await Promise.all([...this.orderFlows.values()].map((service) => service.refresh()));
      }, ORDER_FLOW_REFRESH_MS).catch(() => undefined);
    }, ORDER_FLOW_REFRESH_MS);
    this.orderFlowTimer.unref();
    this.lifecycle.register("order_flow_timer", () => {
      this.clearTimer("orderFlowTimer");
    });

    const coordinator = new ExecutionCoordinator(
      this.config,
      this.api,
      this.ledger,
      this.executionStore,
      snapshot,
      (snapshotHash) => this.packets?.resolve(snapshotHash) ?? null,
      () => this.packets?.invalidateAll(),
      () => this.ownershipService?.current(snapshot().instrumentOpenContracts).tranches ?? [],
      () => ({ paused: this.controlPaused, mode: this.runtimeTradingMode }),
      () => this.packets?.current().execution.daily_capture_locked ?? false,
      () => this.instrumentUniverse,
      (contractId) => this.state.buildSnapshot(this.config.scope.accountId, contractId),
    );
    this.coordinator = coordinator;
    this.gateway = new LocalGatewayServer(
      this.config.localGateway,
      () => {
        const healthBuildStartMs = performance.now();
        const recordedAt = new Date();
        const current = snapshot();
        const quality = evaluateSnapshotDataQuality(current, this.config.risk, recordedAt);
        const executionRecovery = this.executionStore.recoveryStatus();
        const providerHistory = this.historySync.currentStatus();
        const marketObservation = this.currentMarketObservation();
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
          recordedAt,
        );
        const eventLedger = this.ledger.status();
        const outcomeFeed = this.tradeOutcomeStore.status();
        const protectedReduction = this.coordinator?.protectedReductionHealth(current) ?? {
          active_state: null,
          active_reduction_id: null,
          unprotected_open_quantity: 0,
          orphan_protective_orders: 0,
          ambiguous_age_ms: null,
          fail_closed_rollback: process.env.GLITCH_PARTIAL_EXIT_FAIL_CLOSED === "1",
        };
        this.executionStore.updateUnprotectedSince(
          protectedReduction.unprotected_open_quantity,
          recordedAt.toISOString(),
        );
        const authStatus = this.authStatus();
        const flattenPending = this.controlStore.hasPendingFlatten();
        const controlCounts = this.controlStore.status();
        const safetySupervisor = evaluateSafetySupervisor({
          snapshot: current,
          risk: this.config.risk,
          tradingMode: this.config.tradingMode,
          runtimeTradingMode: this.runtimeTradingMode,
          operatorPaused: this.controlPaused,
          recovery: executionRecovery,
          maxContracts: this.config.policy.maxContracts,
          auth: authStatus,
          protectedReduction,
          flattenPending,
          now: recordedAt,
        });
        const invariantMetrics = buildInvariantMetrics({
          snapshot: current,
          auth: authStatus,
          protectedReduction,
          evidenceQueue: this.evidenceQueue.metrics(),
          recovery: executionRecovery,
          controlCounts,
          flattenPendingAgeMs: this.controlStore.oldestPendingFlattenAgeMs(recordedAt.getTime()),
          unprotectedSinceUtc: this.executionStore.unprotectedSinceUtc(),
          restSnapshotCache: this.restEvidenceRecorder.cacheMetrics(),
          supervisorGateDivergence: !safetySupervisor.agrees_with_execution_gates,
          now: recordedAt,
        });
        return {
          // v3 (2026-08-31): health_alerts entries gained alert_id/dedup_key/recovery_state/
          // first_last_fired_utc/thresholds/runbook_url (alert_id replaces id); added
          // task_scheduler, persistence_bytes, heap_used_bytes, health_build_ms. All additive
          // except the health_alerts id->alert_id rename -- confirmed no consumer in the paired
          // profile reads health_alerts today (TS-STREAM-RECOVERY-01 PR-F/PR-H review).
          schema_version: "glitch.direct.health.v3",
          compatibility: GATEWAY_COMPATIBILITY,
          status:
            quality.stateComplete
            && !executionRecovery.blockingAmbiguity
            && providerHistory.lastError === null
            && marketObservation.last_error === null
            && orderFlow.last_error === null
            && eventLedger.durable
            && outcomeFeed.export_backlog === 0
              ? "ok"
              : "degraded",
          trading_mode: this.config.tradingMode,
          runtime_trading_mode: this.runtimeTradingMode,
          operator_paused: this.controlPaused,
          controls: this.controlStore.status(),
          lifecycle: this.lifecycle.status(),
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
          provider_evidence_queue: this.evidenceQueue.metrics(),
          provider_history: providerHistory,
          market_observation: marketObservation,
          order_flow: orderFlow,
          outcome_feed: outcomeFeed,
          execution_facts: this.executionStore.executionFactsStatus(),
          event_ledger: eventLedger,
          persistence: {
            new_exposure_blocked: !eventLedger.durable,
            event_ledger_backlog: eventLedger.pending,
            event_ledger_failed_writes: eventLedger.failed_writes,
            outcome_export_backlog: outcomeFeed.export_backlog,
            outcome_export_failures: outcomeFeed.export_failures,
            outcome_export_quarantine: outcomeFeed.quarantine,
          },
          protected_reduction: protectedReduction,
          safety_supervisor: safetySupervisor,
          invariant_metrics: invariantMetrics,
          health_alerts: this.healthAlerts.evaluate(invariantMetrics),
          task_scheduler: this.taskScheduler.counts(),
          recovery: this.marketHubRecovery.snapshot(),
          persistence_bytes: this.persistenceSizeBytes(),
          heap_used_bytes: process.memoryUsage().heapUsed,
          health_build_ms: Math.round(performance.now() - healthBuildStartMs),
        };
      },
      snapshot,
      async (request) => {
        await this.ensurePacketMarketObservationFresh(request);
        return this.buildDecisionPacketForScope(this.activePositionScope(request));
      },
      (limit, query) => {
        if (query?.source || query?.eventType) {
          return this.providerEvidenceStore.query({
            limit,
            source: query.source,
            eventType: query.eventType,
          });
        }
        return this.providerEvidenceStore.recent(limit);
      },
      coordinator,
      this.ownershipService,
      (limit) => this.tradeOutcomeStore.recent(limit),
      process.env.GLITCH_ACCEPTANCE_STREAM_GAP === "1"
        ? () => this.forceAcceptanceStreamGap()
        : undefined,
      (afterSequence, limit) => this.tradeOutcomeStore.revisionPage(afterSequence, limit),
      (input) => this.applyControl(input),
      (controlId) => this.controlStore.get(controlId),
      () => this.scannerPacket(),
      (afterSequence, limit) => this.executionStore.executionFactsAfter(afterSequence, limit),
    );
    this.restoreEffectiveControlState();
    await this.resumePendingControls();
    await this.gateway.start();
    this.lifecycle.register("local_gateway", async () => {
      await this.gateway?.stop();
      this.gateway = null;
    }, { critical: true });

    this.tokenRefreshTimer = setInterval(() => {
      void this.authManager.ensureAuthenticated().catch((error: unknown) => {
        console.error("ProjectX session validation failed", error);
      });
    }, 12 * 60 * 60 * 1000);
    this.tokenRefreshTimer.unref();
    this.lifecycle.register("token_refresh_timer", () => {
      this.clearTimer("tokenRefreshTimer");
    });

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
        market_observation: this.currentMarketObservation(),
        order_flow: this.orderFlowForContract(this.config.scope.contractId),
      },
    });
    this.lifecycle.transition("ready");
  }

  public async stop(): Promise<void> {
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    if (this.stopping) {
      return this.stopping;
    }
    this.stopping = this.stopSerial();
    return this.stopping;
  }

  private async stopSerial(): Promise<void> {
    this.lifecycle.transition("draining", "stop_requested");
    let criticalFailedDisposers: readonly string[] = [];
    try {
      // Intents already queued must settle before the stores they write to close.
      await this.coordinator?.drainExecutionQueue();
      const drainResult = await this.lifecycle.drain("disposing_runtime_resources");
      criticalFailedDisposers = drainResult.criticalFailed;
      if (drainResult.criticalFailed.length > 0) {
        throw new Error(`lifecycle_dispose_failed:${drainResult.criticalFailed.join(",")}`);
      }
      if (drainResult.failed.length > 0) {
        console.warn(`lifecycle_best_effort_dispose_failed:${drainResult.failed.join(",")}`);
      }
      await Promise.all([
        this.historySync.waitForIdle(),
        this.marketObservation.waitForIdle(),
        this.scannerMarketData?.waitForIdle() ?? Promise.resolve(),
        this.orderFlow?.waitForIdle() ?? Promise.resolve(),
        this.ledger.waitForIdle(),
        this.taskScheduler.waitForIdle(),
      ]);
      await this.tradeOutcomePublication;
      await this.ledger.waitForIdle();
      await this.closeStores();
      this.lifecycle.transition("stopped");
    } catch (error: unknown) {
      this.lifecycle.transition(
        "failed_shutdown",
        error instanceof Error ? error.message : String(error),
      );
      if (!requiresShutdownRetention(criticalFailedDisposers, this.shouldRetainShutdownRecoveryState())) {
        await this.closeStores().catch((cleanupError: unknown) => {
          console.error("shutdown cleanup failed", cleanupError);
        });
      } else {
        if (criticalFailedDisposers.length > 0) {
          console.error(
            `shutdown_retained_critical_disposer_failed:${criticalFailedDisposers.join(",")}`,
          );
        }
        this.orderFlow?.close();
        this.orderFlow = null;
        this.gateway = null;
        this.realtime = null;
        this.packets = null;
      }
      throw error;
    }
  }

  /** TS-REAUDIT-02/08: retain lock + evidence handles when durable backlog remains. */
  private shouldRetainShutdownRecoveryState(): boolean {
    const metrics = this.evidenceQueue.metrics();
    return metrics.incomplete_shutdown
      || metrics.identity_depth > 0
      || metrics.depth > 0
      || this.providerEvidenceStore.outboxPendingCount() > 0;
  }

  private async closeStores(): Promise<void> {
    this.orderFlow?.close();
    this.orderFlow = null;
    this.gateway = null;
    this.realtime = null;
    this.packets = null;
    if (!this.storesClosed) {
      // Queued evidence is durable before the handle closes; a failed drain reports the
      // resumable cursor instead of discarding what is still pending.
      await this.evidenceQueue.close();
      this.providerEvidenceStore.close();
      await this.tradeOutcomeStore.close();
      this.controlStore.close();
      this.executionStore.close();
      this.storesClosed = true;
    }
    await this.runtimeLock.release();
  }

  /**
   * Overflow is a state gap, not a performance detail: degrading the market stream fails the
   * `state_complete` gate (no new exposure) while EXIT, reconcile and user-stream events stay
   * live under `degraded_armed`.
   */
  private authStatus(): ProjectXAuthStatus {
    return this.authManager.status();
  }

  private handleEvidenceQueueDegraded(metrics: EvidenceQueueMetrics): void {
    this.state.markEvidenceBacklog(true);
    this.state.markPayloadFault(
      "market",
      new Error(`evidence_queue_high_water:depth=${metrics.depth}`),
    );
    this.packets?.invalidateAll();
    void this.reconcile().catch((error: unknown) => {
      console.error("ProjectX reconciliation failed after evidence queue overflow", error);
    });
  }

  private clearTimer(
    key: "tokenRefreshTimer"
      | "reconciliationTimer"
      | "historySyncTimer"
      | "marketObservationTimer"
      | "orderFlowTimer",
  ): void {
    const timer = this[key];
    if (timer) {
      clearInterval(timer);
      this[key] = null;
    }
  }

  private async resumePendingControls(): Promise<void> {
    this.restoreEffectiveControlState();
    for (const control of this.controlStore.pending()) {
      if (control.status === "applying") {
        // Pause/resume/mode are local idempotent state changes. Reapply the
        // recorded effect and complete them; never silently restore an armed
        // state merely because the process crashed during the final write.
        if (control.action === "pause") {
          this.controlPaused = true;
          this.packets?.invalidateAll();
          this.controlStore.transition(control.control_id, "completed", "reconciled_after_restart");
        } else if (control.action === "resume") {
          this.controlPaused = false;
          this.packets?.invalidateAll();
          this.controlStore.transition(control.control_id, "completed", "reconciled_after_restart");
        } else if (control.action === "set_mode" && control.mode) {
          if (control.mode === "armed" && this.config.tradingMode !== "armed") {
            this.controlStore.transition(control.control_id, "rejected", "control_cannot_escalate_beyond_startup_mode");
          } else {
            this.runtimeTradingMode = control.mode;
            this.packets?.invalidateAll();
            this.controlStore.transition(control.control_id, "completed", "reconciled_after_restart");
          }
        } else if (control.action === "flatten") {
          const current = this.state.buildSnapshot(this.config.scope.accountId, this.config.scope.contractId);
          const transition = resolveFlattenAfterRestart(
            control.detail,
            buildFlattenVenueSnapshot(current, this.config.scope.accountId, this.config.scope.contractId),
          );
          if (transition.status === "completed" || transition.status === "applying") {
            this.controlStore.transition(control.control_id, transition.status, transition.detail);
          } else {
            this.controlPaused = true;
            this.runtimeTradingMode = "disabled";
            this.packets?.invalidateAll();
            this.controlStore.transition(control.control_id, transition.status, transition.detail);
          }
        } else {
          this.controlStore.transition(control.control_id, "failed", "control_resume_unsupported_action");
        }
        continue;
      }
      await this.applyStoredControl(control);
    }
  }

  private restoreEffectiveControlState(): void {
    const effective = this.controlStore.effectiveState(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    this.controlPaused = effective.paused;
    if (effective.mode && !(effective.mode === "armed" && this.config.tradingMode !== "armed")) {
      this.runtimeTradingMode = effective.mode;
    }
  }

  private refreshMarketObservations(): Promise<unknown> {
    return this.scannerMarketData?.refreshAll() ?? this.marketObservation.refresh();
  }

  /** ponytail: token-bucket packet refresh; parallel per contract; background timer unchanged. */
  private async ensurePacketMarketObservationFresh(
    request?: { contractId?: string; instrument?: string },
  ): Promise<void> {
    if (this.scannerMarketData) {
      const scope = this.activePositionScope(request);
      await this.scannerMarketData.refreshForPacket(new Date(), scope);
      return;
    }
    await this.marketObservation.refresh();
  }

  private activePositionScope(request?: {
    contractId?: string;
    instrument?: string;
  }): ActivePositionScope {
    if (!this.instrumentUniverse) {
      throw new Error("instrument_universe_unavailable");
    }
    const referenceSnapshot = this.state.buildSnapshot(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    const openContractIds = referenceSnapshot.positions
      .filter((position) => (
        position.accountId === this.config.scope.accountId
        && position.type !== 0
        && position.size !== 0
      ))
      .map((position) => position.contractId);
    const workingOrderContractIds = referenceSnapshot.openOrders
      .filter((order) => order.accountId === this.config.scope.accountId)
      .map((order) => order.contractId);
    return resolveActivePositionScope({
      universe: this.instrumentUniverse,
      referenceContractId: this.config.scope.contractId,
      referenceInstrument: this.config.scope.instrument,
      requestedContractId: request?.contractId,
      requestedInstrument: request?.instrument,
      openContractIds,
      workingOrderContractIds,
    });
  }

  private marketObservationForContract(contractId: string) {
    return this.scannerMarketData?.current().candidates
      .find((candidate) => candidate.contract_id === contractId)
      ?.market_observation
      ?? this.marketObservation.current();
  }

  private orderFlowForContract(contractId: string) {
    return this.orderFlows.get(contractId)?.current()
      ?? this.orderFlow?.current()
      ?? {
        last_attempt_utc: null,
        last_succeeded_utc: null,
        last_error: "order_flow_service_unavailable",
        observation: null,
      };
  }

  private buildDecisionPacketForScope(scope: ActivePositionScope) {
    if (!this.packets) {
      throw new Error("packet_service_unavailable");
    }
    const contractId = scope.packetTargetContractId;
    const snapshot = this.state.buildSnapshot(this.config.scope.accountId, contractId);
    return this.packets.current({
      snapshot,
      instrument: scope.packetTargetInstrument,
      marketObservation: this.marketObservationForContract(contractId),
      orderFlow: this.orderFlowForContract(contractId),
    });
  }

  private currentMarketObservation(): MarketObservationState {
    return this.scannerMarketData?.current().candidates
      .find((candidate) => candidate.contract_id === this.config.scope.contractId)
      ?.market_observation
      ?? this.marketObservation.current();
  }

  private scannerPacket(): ScannerPacket {
    if (!this.scannerMarketData || !this.instrumentUniverse) {
      throw new Error("scanner_not_ready");
    }
    const scope = this.activePositionScope();
    return buildScannerPacket({
      packet: this.scannerMarketData.current(new Date(), scope),
      accountId: this.config.scope.accountId,
      scope,
      universe: this.instrumentUniverse,
      simultaneousExposureEnabled: this.config.multiInstrument?.simultaneousExposureEnabled ?? false,
      candidateSnapshot: (contractId) => this.state.buildSnapshot(this.config.scope.accountId, contractId),
    });
  }

  private async applyControl(input: unknown): Promise<StoredControlCommand> {
    const command = parseControlCommand(input);
    const stored = this.controlStore.submit(command);
    if (["completed", "rejected", "failed"].includes(stored.status)) {
      return stored;
    }
    return this.applyStoredControl(stored);
  }

  private async applyStoredControl(stored: StoredControlCommand): Promise<StoredControlCommand> {
    if (stored.account_id !== this.config.scope.accountId) {
      return this.controlStore.transition(stored.control_id, "rejected", "control_account_mismatch");
    }
    if (stored.contract_id !== null) {
      const allowlisted = this.instrumentUniverse?.contracts.some(
        (candidate) => candidate.contract_id === stored.contract_id,
      ) ?? false;
      const referenceSnapshot = this.state.buildSnapshot(
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      const accountPositioned = referenceSnapshot.totalOpenContracts > 0
        || referenceSnapshot.openOrders.some((order) => order.accountId === this.config.scope.accountId);
      if (!allowlisted || (accountPositioned && stored.contract_id !== this.activePositionScope().packetTargetContractId)) {
        return this.controlStore.transition(stored.control_id, "rejected", "control_contract_outside_scope");
      }
    }
    if (stored.status === "completed" || stored.status === "rejected" || stored.status === "failed") {
      return stored;
    }
    const claimed = this.controlStore.claimPending(stored.control_id);
    if (!claimed) {
      return this.controlStore.get(stored.control_id) ?? stored;
    }
    try {
      if (stored.action === "pause") {
        this.controlPaused = true;
      } else if (stored.action === "resume") {
        this.controlPaused = false;
      } else if (stored.action === "set_mode") {
        if (stored.mode === "armed" && this.config.tradingMode !== "armed") {
          return this.controlStore.transition(
            stored.control_id,
            "rejected",
            "control_cannot_escalate_beyond_startup_mode",
          );
        }
        this.runtimeTradingMode = stored.mode!;
      } else if (stored.action === "flatten") {
        let receiptStatus = "submitted";
        const current = this.state.buildSnapshot(this.config.scope.accountId, this.config.scope.contractId);
        if (current.instrumentOpenContracts > 0) {
          const packet = this.packets?.current();
          if (!packet || !this.coordinator) {
            throw new Error("flatten_execution_path_unavailable");
          }
          const receipt = await this.coordinator.handleWireIntent({
            schema_version: "glitch.intent.v3",
            intent_id: stored.control_id,
            created_utc: new Date().toISOString(),
            instrument: packet.instrument,
            account: packet.account.name,
            operator_profile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
            action: "EXIT",
            confidence: 1,
            snapshot_hash: packet.market.snapshot_hash,
            model_version: "operator-control",
            prompt_version: GLITCH_TOPSTEP_PROMPT_VERSION,
            reason: stored.reason,
            decision_audit: {
              bull_case: "Not applicable to an explicit risk-reducing operator command.",
              bear_case: "Not applicable to an explicit risk-reducing operator command.",
              flat_case: "The requested terminal state is flat.",
              aggressive_case: "Remain exposed contrary to the operator command.",
              conservative_case: "Exit current exposure immediately.",
              decisive_evidence: "The authenticated operator requested flatten.",
              disconfirming_evidence: "No market evidence overrides a human risk-reducing command.",
              change_condition: "A later explicit operator command may resume cognition.",
              final_choice: "EXIT",
            },
            packet_id: packet.packet_id,
            contract_id: packet.decision_scope.contract_id,
            scope_hash: packet.decision_scope.scope_hash,
            scope_generation: packet.decision_scope.generation,
            expires_utc: packet.expires_utc,
          });
          if (["rejected", "shadowed", "ambiguous"].includes(receipt.status)) {
            throw new Error(`flatten_execution_${receipt.code}`);
          }
          receiptStatus = receipt.status;
        }
        const settled = this.state.buildSnapshot(this.config.scope.accountId, this.config.scope.contractId);
        const transition = resolveFlattenAfterReceipt(
          receiptStatus,
          buildFlattenVenueSnapshot(settled, this.config.scope.accountId, this.config.scope.contractId),
        );
        this.packets?.invalidateAll();
        return this.controlStore.transition(stored.control_id, transition.status, transition.detail);
      }
      this.packets?.invalidateAll();
      return this.controlStore.transition(stored.control_id, "completed");
    } catch (error) {
      return this.controlStore.transition(
        stored.control_id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async fetchStartupScope(): Promise<
    [Awaited<ReturnType<ProjectXApiClient["searchAccountsCollection"]>>,
      Awaited<ReturnType<ProjectXApiClient["listAvailableContractsCollection"]>>,
      Awaited<ReturnType<ProjectXApiClient["searchOpenPositionsCollection"]>>,
      Awaited<ReturnType<ProjectXApiClient["searchOpenOrdersCollection"]>>]
  > {
    return fetchWithStartupRetry(
      () => Promise.all([
        this.api.searchAccountsCollection(true),
        this.api.listAvailableContractsCollection(this.config.scope.liveMarketData),
        this.api.searchOpenPositionsCollection(this.config.scope.accountId),
        this.api.searchOpenOrdersCollection(this.config.scope.accountId),
      ]),
      {
        onRateLimited: (delayMs, error) => {
          console.error(
            `ProjectX startup fetch rate limited; retrying in ${delayMs / 1000}s`,
            error,
          );
        },
      },
    );
  }

  private async completePendingFlattenControls(): Promise<void> {
    for (const control of this.controlStore.pending()) {
      if (control.action !== "flatten" || control.status !== "applying") {
        continue;
      }
      if (control.detail !== "waiting_for_flat") {
        continue;
      }
      const current = this.state.buildSnapshot(this.config.scope.accountId, this.config.scope.contractId);
      if (shouldCompletePendingFlatten(
        buildFlattenVenueSnapshot(current, this.config.scope.accountId, this.config.scope.contractId),
      )) {
        this.controlStore.transition(control.control_id, "completed", "venue_flat_confirmed");
      }
    }
  }

  private async handleHubReconnected(kind: VenueStreamKind, generation: number): Promise<void> {
    this.packets?.invalidateAll();
    const recovery = this.marketHubRecovery;
    if (kind === "market" && recovery.isStaleCallback(generation)) {
      return;
    }
    const atUtc = new Date().toISOString();
    if (kind === "market") {
      recovery.markProgress("reconciling", generation, atUtc);
    }
    try {
      if (kind === "market") {
        // Same task ids as the periodic timers below, so a concurrent periodic tick coalesces
        // into this recovery run instead of firing a redundant duplicate REST call
        // (TS-STREAM-RECOVERY-01 PR-F).
        await this.taskScheduler.enqueue(
          "market_recovery",
          "reconcile",
          () => this.reconcile({ includeMetadata: false }),
          this.config.reconcileIntervalMs,
        );
        if (recovery.isStaleCallback(generation)) {
          return;
        }
        await this.taskScheduler.enqueue(
          "market_recovery",
          "market_observation",
          () => this.refreshMarketObservations(),
          MARKET_OBSERVATION_REFRESH_MS,
        );
        await this.taskScheduler.enqueue(
          "market_recovery",
          "order_flow",
          async () => {
            await Promise.all([...this.orderFlows.values()].map((service) => service.refresh()));
          },
          ORDER_FLOW_REFRESH_MS,
        );
        if (recovery.isStaleCallback(generation)) {
          return;
        }
        await this.taskScheduler.enqueue(
          "market_recovery",
          "history_sync",
          () => this.historySync.sync(),
          this.historySyncIntervalMs,
        );
        recovery.complete(generation, new Date().toISOString());
      } else {
        await this.taskScheduler.enqueue(
          "market_recovery",
          "reconcile",
          () => this.reconcile({ includeMetadata: false }),
          this.config.reconcileIntervalMs,
        );
      }
    } catch (error: unknown) {
      if (kind === "market") {
        recovery.fail(generation, new Date().toISOString());
      }
      console.error("ProjectX recovery pipeline failed after reconnect", error);
      throw error;
    }
    this.packets?.invalidateAll();
  }

  private shouldReconcileMetadata(): boolean {
    if (!this.lastMetadataReconcileAt) {
      return true;
    }
    return Date.now() - Date.parse(this.lastMetadataReconcileAt) >= RECONCILE_METADATA_INTERVAL_MS;
  }

  /**
   * Bytes on disk for each durable store, surfaced in /health so DB growth is an observed fact,
   * not something only discovered by an operator running out of disk (TS-STREAM-RECOVERY-01 PR-H).
   * Never throws: a missing/unreadable file reports null rather than degrading /health itself.
   */
  private persistenceSizeBytes(): Record<string, number | null> {
    const files = {
      execution_store: "glitch-topstep.sqlite",
      provider_evidence_store: "projectx-evidence.sqlite",
      control_store: "glitch-topstep-controls.sqlite",
    };
    const sizes: Record<string, number | null> = {};
    for (const [key, filename] of Object.entries(files)) {
      try {
        sizes[key] = statSync(join(this.config.dataDir, filename)).size;
      } catch {
        sizes[key] = null;
      }
    }
    return sizes;
  }

  private async reconcile(options?: { includeMetadata?: boolean }): Promise<void> {
    if (this.reconciliationInFlight) {
      return;
    }
    this.reconciliationInFlight = true;
    const includeMetadata = options?.includeMetadata ?? this.shouldReconcileMetadata();
    try {
      await runReconciliationCycle({
        scope: {
          accountId: this.config.scope.accountId,
          accountName: this.config.scope.accountName,
          contractId: this.config.scope.contractId,
          instrument: this.config.scope.instrument,
        },
        api: this.api,
        state: this.state,
        executionStore: this.executionStore,
        ledger: this.ledger,
        coordinator: this.coordinator,
        lastReconciledOpenContracts: this.lastReconciledOpenContracts,
        setLastReconciledOpenContracts: (value) => {
          this.lastReconciledOpenContracts = value;
        },
        resolveClosedTranchesForFlat: (beforeOpen) => this.resolveClosedTranchesForFlat(beforeOpen),
        recordRestSnapshot: (...args) => this.recordRestSnapshot(...args),
        publishTradeOutcomesOnFlat: (...args) => this.publishTradeOutcomesOnFlat(...args),
        refreshCachedOpenTranches: (openContracts) => this.refreshCachedOpenTranches(openContracts),
        clearCachedOpenTranches: () => {
          this.cachedOpenTranches = [];
        },
        observeTradeExcursion: (openContracts, unrealizedPnl) => {
          this.tradeExcursion.observe(openContracts, unrealizedPnl);
        },
        retryIncompleteTradeOutcomes: (exitUtc) => this.retryIncompleteTradeOutcomes(exitUtc),
        reconcileEntrySubmissionLatch: (positions, orders, receivedUtc) => (
          this.reconcileEntrySubmissionLatch(positions, orders, receivedUtc)
        ),
        persistRecoveryResolutions: (resolutions) => this.persistRecoveryResolutions(resolutions),
        invalidateIssuedPackets: () => {
          this.packets?.invalidateAll();
        },
      }, { includeMetadata });
      if (includeMetadata) {
        this.lastMetadataReconcileAt = new Date().toISOString();
      }
      await this.completePendingFlattenControls();
      this.reconcileConsecutiveFailures = 0;
      this.nextReconcileAttemptAtMs = 0;
    } catch (error) {
      this.state.markReconciliationFailed(error);
      this.reconcileConsecutiveFailures += 1;
      // Reuses the same bounded/jittered shape already proven for auth refresh (TS-REAUDIT-01) --
      // the function is generic (base 1s, doubling per failure, capped at 30s, +jitter), not
      // auth-specific despite its name.
      this.nextReconcileAttemptAtMs = Date.now()
        + projectXAuthBackoffDelayMs(this.reconcileConsecutiveFailures);
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
    this.recordLifecycleFillFacts(active, new Date().toISOString(), false);
  }

  /**
   * Publishes the current fill state of each tranche as an immediate lifecycle fact. Unchanged
   * state is deduplicated by the store, so this can run on every reconciliation pass.
   */
  private recordLifecycleFillFacts(
    tranches: readonly TrancheView[],
    atUtc: string,
    instrumentFlat: boolean,
  ): void {
    for (const tranche of tranches) {
      const fact = trancheLifecycleFact({
        tranche,
        requestedQuantity: this.executionStore.registeredIntentPayload(tranche.intent_id)?.quantity ?? null,
        recordedUtc: atUtc,
        instrumentFlat,
      });
      if (!fact) {
        continue;
      }
      this.executionStore.recordExecutionFact({
        intentId: fact.intentId,
        phase: fact.phase,
        factKey: fact.factKey,
        recordedUtc: fact.recordedUtc,
        detail: fact.detail,
        diagnostics: fact.diagnostics,
      });
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
    let resolvePublication!: () => void;
    this.tradeOutcomePublication = new Promise<void>((resolve) => {
      resolvePublication = resolve;
    });
    // Factual closure is published before the enriched outcome so the next decision does not
    // have to wait for the learner round trip.
    this.recordLifecycleFillFacts(tranches, exitUtc, true);
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
      // Only entry intents named by a submitted EXIT receipt qualify as manual_exit.
      const exitTargets = this.executionStore.submittedExitTargetIntentIds();
      const hadExitIntentByTranche = new Map(
        enriched.map((tranche) => [tranche.intent_id, exitTargets.has(tranche.intent_id)]),
      );
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
        hadExitIntentByTranche,
      });
      if (published.length > 0) {
        for (const outcome of published) {
          this.executionStore.supersedeExecutionFacts(outcome.intent_id, outcome.outcome_id, exitUtc);
        }
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
      resolvePublication();
      this.tradeOutcomePublication = null;
    }
  }

  private recordRestSnapshot(
    eventType: string,
    receivedUtc: string,
    normalizedPayload: unknown,
    accountId: number | null,
    contractId: string | null,
    rawPayload: unknown = null,
  ): boolean {
    return this.restEvidenceRecorder.recordIfChanged({
      receivedUtc,
      eventType,
      generation: this.state.operationalStatus().generation,
      accountId,
      contractId,
      normalizedPayload,
      rawPayload,
    });
  }

  private reconcileEntrySubmissionLatch(
    positions: PositionInfo[],
    orders: OrderInfo[],
    atUtc?: string,
  ): boolean {
    const intentId = this.executionStore.entrySubmissionIntentId();
    if (!intentId) {
      return false;
    }
    const mutation = this.executionStore.mutationForIntent(intentId);
    const venueFlat = this.isVenueFlatForLatch(positions);
    if (!mutation || mutation.operation !== "place_order") {
      return venueFlat ? this.executionStore.clearEntrySubmissionLatch(intentId) : false;
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
    if (positionObserved || orderObserved) {
      return this.executionStore.clearEntrySubmissionLatch(intentId);
    }

    const nowUtc = atUtc ?? new Date().toISOString();
    if (shouldClearStaleEntrySubmissionLatch(
      mutation,
      nowUtc,
      this.config.entrySubmissionLatchStaleMs,
      venueFlat,
      positionObserved,
      orderObserved,
    )) {
      return this.executionStore.clearEntrySubmissionLatch(intentId);
    }
    return false;
  }

  private isVenueFlatForLatch(positions: PositionInfo[]): boolean {
    return !positions.some(
      (position) => position.accountId === this.config.scope.accountId
        && position.contractId === this.config.scope.contractId
        && position.type !== 0
        && Math.abs(position.size) > 0,
    );
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
