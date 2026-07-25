// @ts-ignore The official package supplies its own declarations after npm install.
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
import { VenueStateStore } from "../state/venue-state.js";
import type { VenueStreamKind } from "../domain/models.js";
import {
  parseAccount,
  parseDepth,
  parseMarketTrade,
  parseOrder,
  parsePosition,
  parseQuote,
  parseTrade,
} from "./schemas.js";

export interface ProjectXRealtimeOptions {
  userHubUrl: string;
  marketHubUrl: string;
  token: () => string;
  accountId: number;
  contractId: string;
  logLevel?: number;
  onReconnected?: () => void | Promise<void>;
  onStateInvalidated?: () => void | Promise<void>;
}

interface SignalRConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke(methodName: string, ...args: unknown[]): Promise<unknown>;
  on(methodName: string, handler: (...args: unknown[]) => void): void;
  onreconnecting(handler: (error?: Error) => void): void;
  onreconnected(handler: (connectionId?: string) => void): void;
  onclose(handler: (error?: Error) => void): void;
}

export class ProjectXRealtimeClient {
  private readonly userConnection: SignalRConnection;
  private readonly marketConnection: SignalRConnection;

  public constructor(
    private readonly options: ProjectXRealtimeOptions,
    private readonly state: VenueStateStore,
  ) {
    const signalROptions = {
      accessTokenFactory: options.token,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    };
    this.userConnection = new HubConnectionBuilder()
      .withUrl(options.userHubUrl, signalROptions)
      .configureLogging(options.logLevel ?? LogLevel.Warning)
      .withAutomaticReconnect()
      .build();
    this.marketConnection = new HubConnectionBuilder()
      .withUrl(options.marketHubUrl, signalROptions)
      .configureLogging(options.logLevel ?? LogLevel.Warning)
      .withAutomaticReconnect()
      .build();

    this.registerHandlers();
    this.registerLifecycle("user", this.userConnection, () => this.subscribeUser());
    this.registerLifecycle("market", this.marketConnection, () => this.subscribeMarket());
  }

  public async start(): Promise<void> {
    this.state.markStreamConnecting("user");
    this.state.markStreamConnecting("market");
    try {
      await Promise.all([this.userConnection.start(), this.marketConnection.start()]);
      this.state.markStreamConnected("user");
      this.state.markStreamConnected("market");
      await Promise.all([this.subscribeUser(), this.subscribeMarket()]);
    } catch (error) {
      this.state.markStreamDisconnected("user", error);
      this.state.markStreamDisconnected("market", error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await Promise.allSettled([this.userConnection.stop(), this.marketConnection.stop()]);
    this.state.markStreamDisconnected("user", "service_stopped");
    this.state.markStreamDisconnected("market", "service_stopped");
  }

  private registerHandlers(): void {
    this.userConnection.on("GatewayUserAccount", (input: unknown) => {
      this.tryApply("user", () => this.state.applyAccount(parseAccount(input)));
    });
    this.userConnection.on("GatewayUserPosition", (input: unknown) => {
      this.tryApply("user", () => this.state.applyPosition(parsePosition(input)));
    });
    this.userConnection.on("GatewayUserOrder", (input: unknown) => {
      this.tryApply("user", () => this.state.applyOrder(parseOrder(input)));
    });
    this.userConnection.on("GatewayUserTrade", (input: unknown) => {
      this.tryApply("user", () => this.state.applyTrade(parseTrade(input)));
    });

    this.marketConnection.on("GatewayQuote", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("quote_contract_id_invalid"));
        return;
      }
      this.tryApply("market", () => this.state.applyQuote(parseQuote(contractId, input)));
    });
    this.marketConnection.on("GatewayTrade", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("trade_contract_id_invalid"));
        return;
      }
      this.tryApply("market", () => this.state.applyMarketTrade(parseMarketTrade(contractId, input)));
    });
    this.marketConnection.on("GatewayDepth", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("depth_contract_id_invalid"));
        return;
      }
      this.tryApply("market", () => this.state.applyDepth(parseDepth(contractId, input)));
    });
  }

  private registerLifecycle(
    kind: VenueStreamKind,
    connection: SignalRConnection,
    subscribe: () => Promise<void>,
  ): void {
    connection.onreconnecting((error?: Error) => {
      this.state.markStreamReconnecting(kind, error ?? "signalr_reconnecting");
      void this.options.onStateInvalidated?.();
    });
    connection.onreconnected(() => {
      void (async () => {
        this.state.markStreamConnected(kind);
        try {
          await subscribe();
          await this.options.onReconnected?.();
        } catch (error) {
          this.state.markStreamDisconnected(kind, error);
          await this.options.onStateInvalidated?.();
        }
      })();
    });
    connection.onclose((error?: Error) => {
      this.state.markStreamDisconnected(kind, error ?? "signalr_closed");
      void this.options.onStateInvalidated?.();
    });
  }

  private tryApply(kind: VenueStreamKind, action: () => void): void {
    try {
      action();
      this.state.markStreamEvent(kind);
    } catch (error) {
      this.payloadFault(kind, error);
    }
  }

  private payloadFault(kind: VenueStreamKind, error: unknown): void {
    this.state.markPayloadFault(kind, error);
    console.error("Rejected invalid ProjectX realtime payload", error);
    void this.options.onStateInvalidated?.();
  }

  private async subscribeUser(): Promise<void> {
    await Promise.all([
      this.userConnection.invoke("SubscribeAccounts"),
      this.userConnection.invoke("SubscribeOrders", this.options.accountId),
      this.userConnection.invoke("SubscribePositions", this.options.accountId),
      this.userConnection.invoke("SubscribeTrades", this.options.accountId),
    ]);
  }

  private async subscribeMarket(): Promise<void> {
    await Promise.all([
      this.marketConnection.invoke("SubscribeContractQuotes", this.options.contractId),
      this.marketConnection.invoke("SubscribeContractTrades", this.options.contractId),
      this.marketConnection.invoke("SubscribeContractMarketDepth", this.options.contractId),
    ]);
  }
}
