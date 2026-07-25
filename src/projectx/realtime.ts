// @ts-ignore The official package supplies its own declarations after npm install.
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
import type {
  AccountInfo,
  MarketDepthInfo,
  MarketTradeInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
  VenueStreamKind,
} from "../domain/models.js";
import { VenueStateStore } from "../state/venue-state.js";
import {
  type ProviderEvidenceSink,
  recordProviderEventBeforeApply,
  recordProviderLifecycleEvent,
} from "./provider-event-recorder.js";
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
  evidence: ProviderEvidenceSink;
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

type RealtimeValue =
  | AccountInfo
  | PositionInfo
  | OrderInfo
  | TradeInfo
  | QuoteInfo
  | MarketTradeInfo
  | MarketDepthInfo;

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
    this.recordLifecycle("user", "connecting");
    this.recordLifecycle("market", "connecting");
    this.state.markStreamConnecting("user");
    this.state.markStreamConnecting("market");
    try {
      await Promise.all([this.userConnection.start(), this.marketConnection.start()]);
      await Promise.all([this.subscribeUser(), this.subscribeMarket()]);
      this.recordLifecycle("user", "connected_and_subscribed");
      this.recordLifecycle("market", "connected_and_subscribed");
      this.state.markStreamConnected("user");
      this.state.markStreamConnected("market");
    } catch (error) {
      this.recordLifecycleSafely("user", "connect_failed", error);
      this.recordLifecycleSafely("market", "connect_failed", error);
      this.state.markStreamDisconnected("user", error);
      this.state.markStreamDisconnected("market", error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.recordLifecycleSafely("user", "stopping");
    this.recordLifecycleSafely("market", "stopping");
    await Promise.allSettled([this.userConnection.stop(), this.marketConnection.stop()]);
    this.state.markStreamDisconnected("user", "service_stopped");
    this.state.markStreamDisconnected("market", "service_stopped");
  }

  private registerHandlers(): void {
    this.userConnection.on("GatewayUserAccount", (input: unknown) => {
      this.recordAndApply(
        "user",
        "account",
        input,
        () => parseAccount(input),
        (value) => ({
          accountId: value.id,
          contractId: null,
          providerEntityId: String(value.id),
          providerTimestampUtc: null,
        }),
        (value) => this.state.applyAccount(value),
      );
    });
    this.userConnection.on("GatewayUserPosition", (input: unknown) => {
      this.recordAndApply(
        "user",
        "position",
        input,
        () => parsePosition(input),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.creationTimestamp,
        }),
        (value) => this.state.applyPosition(value),
      );
    });
    this.userConnection.on("GatewayUserOrder", (input: unknown) => {
      this.recordAndApply(
        "user",
        "order",
        input,
        () => parseOrder(input),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.updateTimestamp,
        }),
        (value) => this.state.applyOrder(value),
      );
    });
    this.userConnection.on("GatewayUserTrade", (input: unknown) => {
      this.recordAndApply(
        "user",
        "trade",
        input,
        () => parseTrade(input),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.creationTimestamp,
        }),
        (value) => this.state.applyTrade(value),
      );
    });

    this.marketConnection.on("GatewayQuote", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("quote_contract_id_invalid"));
        return;
      }
      this.recordAndApply(
        "market",
        "quote",
        { contractId, payload: input },
        () => parseQuote(contractId, input),
        (value) => ({
          accountId: null,
          contractId: value.contractId,
          providerEntityId: value.contractId,
          providerTimestampUtc: value.timestamp,
        }),
        (value) => this.state.applyQuote(value),
      );
    });
    this.marketConnection.on("GatewayTrade", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("trade_contract_id_invalid"));
        return;
      }
      this.recordAndApply(
        "market",
        "market_trade",
        { contractId, payload: input },
        () => parseMarketTrade(contractId, input),
        (value) => ({
          accountId: null,
          contractId: value.contractId,
          providerEntityId: `${value.contractId}:${value.timestamp}`,
          providerTimestampUtc: value.timestamp,
        }),
        (value) => this.state.applyMarketTrade(value),
      );
    });
    this.marketConnection.on("GatewayDepth", (contractId: unknown, input: unknown) => {
      if (typeof contractId !== "string") {
        this.payloadFault("market", new Error("depth_contract_id_invalid"));
        return;
      }
      this.recordAndApply(
        "market",
        "depth",
        { contractId, payload: input },
        () => parseDepth(contractId, input),
        (value) => ({
          accountId: null,
          contractId: value.contractId,
          providerEntityId: `${value.contractId}:${value.timestamp}:${value.type}:${value.price}`,
          providerTimestampUtc: value.timestamp,
        }),
        (value) => this.state.applyDepth(value),
      );
    });
  }

  private registerLifecycle(
    kind: VenueStreamKind,
    connection: SignalRConnection,
    subscribe: () => Promise<void>,
  ): void {
    connection.onreconnecting((error?: Error) => {
      try {
        this.recordLifecycle(kind, "reconnecting", error);
        this.state.markStreamReconnecting(kind, error ?? "signalr_reconnecting");
      } catch (recordError) {
        this.payloadFault(kind, recordError);
      }
      void this.options.onStateInvalidated?.();
    });
    connection.onreconnected(() => {
      void (async () => {
        try {
          await subscribe();
          this.recordLifecycle(kind, "reconnected_and_subscribed");
          this.state.markStreamConnected(kind);
          await this.options.onReconnected?.();
        } catch (error) {
          this.recordLifecycleSafely(kind, "reconnect_failed", error);
          this.state.markStreamDisconnected(kind, error);
          await this.options.onStateInvalidated?.();
        }
      })();
    });
    connection.onclose((error?: Error) => {
      try {
        this.recordLifecycle(kind, "closed", error);
        this.state.markStreamDisconnected(kind, error ?? "signalr_closed");
      } catch (recordError) {
        this.payloadFault(kind, recordError);
      }
      void this.options.onStateInvalidated?.();
    });
  }

  private recordAndApply<T extends RealtimeValue>(
    kind: VenueStreamKind,
    eventType: string,
    rawPayload: unknown,
    parse: () => T,
    identity: (value: T) => {
      accountId: number | null;
      contractId: string | null;
      providerEntityId: string | null;
      providerTimestampUtc: string | null;
    },
    apply: (value: T) => void,
  ): void {
    try {
      recordProviderEventBeforeApply({
        sink: this.options.evidence,
        receivedUtc: new Date().toISOString(),
        source: kind === "user" ? "projectx_user_stream" : "projectx_market_stream",
        eventType,
        generation: this.state.operationalStatus().generation,
        rawPayload,
        parse,
        identity,
        apply,
      });
      this.state.markStreamEvent(kind);
    } catch (error) {
      this.payloadFault(kind, error);
    }
  }

  private recordLifecycle(
    kind: VenueStreamKind,
    eventType: string,
    error?: unknown,
  ): void {
    recordProviderLifecycleEvent(this.options.evidence, {
      receivedUtc: new Date().toISOString(),
      providerTimestampUtc: null,
      eventType: `${kind}_${eventType}`,
      generation: this.state.operationalStatus().generation,
      accountId: kind === "user" ? this.options.accountId : null,
      contractId: kind === "market" ? this.options.contractId : null,
      providerEntityId: null,
      rawPayload: errorPayload(error),
    });
  }

  private recordLifecycleSafely(
    kind: VenueStreamKind,
    eventType: string,
    error?: unknown,
  ): void {
    try {
      this.recordLifecycle(kind, eventType, error);
    } catch (recordError) {
      console.error("Could not persist ProjectX lifecycle evidence", recordError);
    }
  }

  private payloadFault(kind: VenueStreamKind, error: unknown): void {
    this.state.markPayloadFault(kind, error);
    console.error("Rejected ProjectX realtime event", error);
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

function errorPayload(error: unknown): unknown {
  if (error === undefined) {
    return null;
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { value: String(error) };
}
