import type { AppConfig } from "./config.js";
import { ExecutionCoordinator } from "./execution/coordinator.js";
import { DecisionPacketService } from "./hermes/packet-service.js";
import { ProjectXApiClient } from "./projectx/client.js";
import { ProjectXRealtimeClient } from "./projectx/realtime.js";
import { LocalGatewayServer } from "./server/local-gateway.js";
import { VenueStateStore } from "./state/venue-state.js";
import { JsonlEventStore } from "./storage/jsonl-event-store.js";

export class GlitchTopTraderService {
  private readonly api: ProjectXApiClient;
  private readonly state = new VenueStateStore();
  private readonly ledger: JsonlEventStore;
  private realtime: ProjectXRealtimeClient | null = null;
  private gateway: LocalGatewayServer | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private reconciliationInFlight = false;

  public constructor(private readonly config: AppConfig) {
    this.api = new ProjectXApiClient({
      apiUrl: config.projectX.apiUrl,
      username: config.projectX.username,
      apiKey: config.projectX.apiKey,
    });
    this.ledger = new JsonlEventStore(config.dataDir);
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

    this.state.registerContracts(contracts);
    this.state.replaceAccounts(accounts);
    this.state.replacePositions(positions);
    this.state.replaceOrders(orders);

    this.realtime = new ProjectXRealtimeClient(
      {
        userHubUrl: this.config.projectX.userHubUrl,
        marketHubUrl: this.config.projectX.marketHubUrl,
        token: () => this.api.sessionToken,
        accountId: this.config.scope.accountId,
        contractId: this.config.scope.contractId,
      },
      this.state,
    );
    await this.realtime.start();

    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        console.error("ProjectX reconciliation failed", error);
      });
    }, this.config.reconcileIntervalMs);
    this.reconciliationTimer.unref();

    const snapshot = () => this.state.buildSnapshot(
      this.config.scope.accountId,
      this.config.scope.contractId,
    );
    const packets = new DecisionPacketService(this.config, snapshot);
    const coordinator = new ExecutionCoordinator(
      this.config,
      this.api,
      this.ledger,
      snapshot,
      () => packets.current(),
    );
    this.gateway = new LocalGatewayServer(
      {
        ...this.config.localGateway,
        tradingMode: this.config.tradingMode,
      },
      snapshot,
      () => packets.current(),
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
      event_id: crypto.randomUUID(),
      recorded_utc: new Date().toISOString(),
      event: "service_started",
      payload: {
        account_id: account.id,
        account_name: account.name,
        simulated: account.simulated ?? null,
        contract_id: contract.id,
        trading_mode: this.config.tradingMode,
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
  }

  private async reconcile(): Promise<void> {
    if (this.reconciliationInFlight) {
      return;
    }
    this.reconciliationInFlight = true;
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
      this.state.replaceAccounts(accounts, receivedAt);
      this.state.replacePositions(positions, receivedAt);
      this.state.replaceOrders(orders, receivedAt);
    } finally {
      this.reconciliationInFlight = false;
    }
  }
}
