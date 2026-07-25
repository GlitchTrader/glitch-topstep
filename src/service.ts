import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { RecoveredExecutionResolution } from "./domain/execution-state.js";
import type { OrderInfo, PositionInfo } from "./domain/models.js";
import { ExecutionCoordinator } from "./execution/coordinator.js";
import { recoverExecutionMutations } from "./execution/recovery.js";
import { DecisionPacketService } from "./hermes/packet-service.js";
import { ProjectXApiClient } from "./projectx/client.js";
import { ProjectXRealtimeClient } from "./projectx/realtime.js";
import { LocalGatewayServer } from "./server/local-gateway.js";
import { evaluateSnapshotDataQuality } from "./state/data-quality.js";
import { VenueStateStore } from "./state/venue-state.js";
import { JsonlEventStore } from "./storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "./storage/sqlite-execution-store.js";
import { SqliteProviderEvidenceStore } from "./storage/sqlite-provider-evidence-store.js";

export class GlitchTopstepService {
  private readonly api: ProjectXApiClient;
  private readonly state = new VenueStateStore();
  private readonly ledger: JsonlEventStore;
  private readonly executionStore: SqliteExecutionStore;
  private readonly providerEvidenceStore: SqliteProviderEvidenceStore;
  private realtime: ProjectXRealtimeClient | null = null;
  private gateway: LocalGatewayServer | null = null;
  private packets: DecisionPacketService | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private reconciliationInFlight = false;
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
    this.providerEvidenceStore = new SqliteProviderEvidenceStore(
      join(config.dataDir, "projectx-evidence.sqlite"),
      {
        marketEventRetention: config.providerEvidence.marketEventRetention,
        marketPruneInterval: config.providerEvidence.marketPruneInterval,
      },
    );
  }

  public async start(): Promise<void> {
    await this.api.login();
    const [accounts, contracts, positions, orders] = await Promise.all([
      this.api.searchAccounts(true),
      this.api.listAvailableContracts(this.config.scope.liveMarketData),
      this.api.searchOpenPositions(this.config.scope.accountId),
      this.api.searchOpenOrders(this.config.scope.accountId),
    ]);

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

    const receivedAt = new Date().toISOString();
    this.recordRestSnapshot("accounts_snapshot", receivedAt, accounts, this.config.scope.accountId, null);
    this.recordRestSnapshot("contracts_snapshot", receivedAt, contracts, null, this.config.scope.contractId);
    this.recordRestSnapshot(
      "positions_snapshot",
      receivedAt,
      positions,
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    this.recordRestSnapshot(
      "open_orders_snapshot",
      receivedAt,
      orders,
      this.config.scope.accountId,
      this.config.scope.contractId,
    );

    this.state.registerContracts(contracts);
    this.state.replaceAccounts(accounts, receivedAt);
    this.state.replacePositions(positions, receivedAt);
    this.state.replaceOrders(orders, receivedAt);
    const initialRecovery = await recoverExecutionMutations(
      this.executionStore,
      this.api,
      this.config.scope.accountId,
      this.config.scope.contractId,
      positions,
    );
    await this.persistRecoveryResolutions(initialRecovery.resolutions);
    this.reconcileEntrySubmissionLatch(positions, orders);

    const snapshot = () => this.state.buildSnapshot(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    this.packets = new DecisionPacketService(
      this.config,
      snapshot,
      this.executionStore,
      () => this.executionStore.recoveryStatus(),
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
          await this.reconcile();
        },
        onStateInvalidated: async () => {
          this.packets?.invalidateAll();
          await this.reconcile();
        },
      },
      this.state,
    );
    await this.realtime.start();
    await this.reconcile();

    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        console.error("ProjectX reconciliation failed", error);
      });
    }, this.config.reconcileIntervalMs);
    this.reconciliationTimer.unref();

    const coordinator = new ExecutionCoordinator(
      this.config,
      this.api,
      this.ledger,
      this.executionStore,
      snapshot,
      (snapshotHash) => this.packets?.resolve(snapshotHash) ?? null,
      () => this.packets?.invalidateAll(),
    );
    this.gateway = new LocalGatewayServer(
      this.config.localGateway,
      () => {
        const recordedAt = new Date();
        const current = snapshot();
        const quality = evaluateSnapshotDataQuality(current, this.config.risk, recordedAt);
        const executionRecovery = this.executionStore.recoveryStatus();
        return {
          schema_version: "glitch.direct.health.v2",
          status: quality.stateComplete && !executionRecovery.blockingAmbiguity
            ? "ok"
            : "degraded",
          trading_mode: this.config.tradingMode,
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
      },
    });
  }

  public async stop(): Promise<void> {
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
    this.gateway = null;
    this.realtime = null;
    this.packets = null;
    if (!this.storesClosed) {
      this.providerEvidenceStore.close();
      this.executionStore.close();
      this.storesClosed = true;
    }
  }

  private async reconcile(): Promise<void> {
    if (this.reconciliationInFlight) {
      return;
    }
    this.reconciliationInFlight = true;
    this.state.markReconciliationStarted();
    try {
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
      this.recordRestSnapshot("accounts_snapshot", receivedAt, accounts, this.config.scope.accountId, null);
      this.recordRestSnapshot(
        "positions_snapshot",
        receivedAt,
        positions,
        this.config.scope.accountId,
        this.config.scope.contractId,
      );
      this.recordRestSnapshot(
        "open_orders_snapshot",
        receivedAt,
        orders,
        this.config.scope.accountId,
        this.config.scope.contractId,
      );

      this.state.replaceAccounts(accounts, receivedAt);
      this.state.replacePositions(positions, receivedAt);
      this.state.replaceOrders(orders, receivedAt);
      this.state.markReconciliationSucceeded(receivedAt);

      const latchCleared = this.reconcileEntrySubmissionLatch(positions, orders);
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
        );
        await this.persistRecoveryResolutions(recovery.resolutions);
        if (JSON.stringify(this.executionStore.recoveryStatus()) !== before) {
          this.packets?.invalidateAll();
        }
      }
      if (latchCleared) {
        this.packets?.invalidateAll();
      }
    } catch (error) {
      this.state.markReconciliationFailed(error);
      throw error;
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  private recordRestSnapshot(
    eventType: string,
    receivedUtc: string,
    normalizedPayload: unknown,
    accountId: number | null,
    contractId: string | null,
  ): void {
    this.providerEvidenceStore.append({
      receivedUtc,
      providerTimestampUtc: null,
      source: "projectx_rest",
      eventType,
      generation: this.state.operationalStatus().generation,
      accountId,
      contractId,
      providerEntityId: null,
      rawPayload: null,
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
}
