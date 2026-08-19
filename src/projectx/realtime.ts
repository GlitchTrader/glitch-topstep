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
  parseDepthBatch,
  parseMarketTrade,
  parseOrder,
  parsePosition,
  parseQuote,
  parseTrade,
  unwrapMarketStreamArgs,
  unwrapUserStreamPayload,
  userStreamPayloadFaultDetail,
} from "./schemas.js";
import {
  DEFAULT_STREAM_LIVENESS_MS,
  nextSignalRReconnectDelayMs,
  shouldForceMarketLivenessRestart,
  shouldScheduleHubRestart,
} from "./stream-supervisor.js";

export interface ProjectXRealtimeOptions {
  userHubUrl: string;
  marketHubUrl: string;
  token: () => string;
  accountId: number;
  contractId: string;
  contractIds?: readonly string[];
  depthContractIds?: readonly string[];
  evidence: ProviderEvidenceSink;
  logLevel?: number;
  onReconnected?: () => void | Promise<void>;
  onStateInvalidated?: () => void | Promise<void>;
  onBeforePositionApply?: (position: PositionInfo, receivedUtc: string) => void | Promise<void>;
  livenessMs?: number;
  isMarketExpectedLive?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  private stopped = false;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private readonly restartInFlight: Record<VenueStreamKind, boolean> = {
    user: false,
    market: false,
  };
  private readonly restartAttempts: Record<VenueStreamKind, number> = {
    user: 0,
    market: 0,
  };

  public constructor(
    private readonly options: ProjectXRealtimeOptions,
    private readonly state: VenueStateStore,
  ) {
    const signalROptions = {
      accessTokenFactory: options.token,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    };
    const reconnectPolicy = {
      nextRetryDelayInMilliseconds: (context: { previousRetryCount: number }) =>
        nextSignalRReconnectDelayMs(context.previousRetryCount),
    };
    this.userConnection = new HubConnectionBuilder()
      .withUrl(options.userHubUrl, signalROptions)
      .configureLogging(options.logLevel ?? LogLevel.Warning)
      .withAutomaticReconnect(reconnectPolicy)
      .build();
    this.marketConnection = new HubConnectionBuilder()
      .withUrl(options.marketHubUrl, signalROptions)
      .configureLogging(options.logLevel ?? LogLevel.Warning)
      .withAutomaticReconnect(reconnectPolicy)
      .build();

    this.registerHandlers();
    this.registerLifecycle("user", this.userConnection, () => this.subscribeUser());
    this.registerLifecycle("market", this.marketConnection, () => this.subscribeMarket());
  }

  public async start(): Promise<void> {
    this.stopped = false;
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
      this.startLivenessWatch();
    } catch (error) {
      this.recordLifecycleSafely("user", "connect_failed", error);
      this.recordLifecycleSafely("market", "connect_failed", error);
      this.state.markStreamDisconnected("user", error);
      this.state.markStreamDisconnected("market", error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    this.recordLifecycleSafely("user", "stopping");
    this.recordLifecycleSafely("market", "stopping");
    await Promise.allSettled([this.userConnection.stop(), this.marketConnection.stop()]);
    this.state.markStreamDisconnected("user", "service_stopped");
    this.state.markStreamDisconnected("market", "service_stopped");
  }

  private registerHandlers(): void {
    this.userConnection.on("GatewayUserAccount", (input: unknown) => {
      const payload = unwrapUserStreamPayload(input);
      this.recordAndApply(
        "user",
        "account",
        input,
        () => parseAccount(payload),
        (value) => ({
          accountId: value.id,
          contractId: null,
          providerEntityId: String(value.id),
          providerTimestampUtc: null,
        }),
        (value, receivedUtc) => this.state.applyAccount(value, receivedUtc),
      );
    });
    this.userConnection.on("GatewayUserPosition", (input: unknown) => {
      const payload = unwrapUserStreamPayload(input);
      this.recordAndApply(
        "user",
        "position",
        input,
        () => parsePosition(payload),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.creationTimestamp,
        }),
        (value, receivedUtc) => {
          void this.options.onBeforePositionApply?.(value, receivedUtc);
          this.state.applyPosition(value, receivedUtc);
        },
      );
    });
    this.userConnection.on("GatewayUserOrder", (input: unknown) => {
      const payload = unwrapUserStreamPayload(input);
      this.recordAndApply(
        "user",
        "order",
        input,
        () => parseOrder(payload),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.updateTimestamp,
        }),
        (value, receivedUtc) => this.state.applyOrder(value, receivedUtc),
      );
    });
    this.userConnection.on("GatewayUserTrade", (input: unknown) => {
      const payload = unwrapUserStreamPayload(input);
      this.recordAndApply(
        "user",
        "trade",
        input,
        () => parseTrade(payload),
        (value) => ({
          accountId: value.accountId,
          contractId: value.contractId,
          providerEntityId: String(value.id),
          providerTimestampUtc: value.creationTimestamp,
        }),
        () => undefined,
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
        (value, receivedUtc) => this.state.applyQuote(value, receivedUtc),
      );
    });
    this.marketConnection.on("GatewayTrade", (contractId: unknown, input: unknown) => {
      let resolved: { contractId: string; payload: unknown };
      try {
        resolved = unwrapMarketStreamArgs(contractId, input);
      } catch (error) {
        this.payloadFault("market", error);
        return;
      }
      this.recordAndApply(
        "market",
        "market_trade",
        { contractId: resolved.contractId, payload: resolved.payload },
        () => parseMarketTrade(resolved.contractId, resolved.payload),
        (value) => ({
          accountId: null,
          contractId: value.contractId,
          providerEntityId: `${value.contractId}:${value.timestamp}`,
          providerTimestampUtc: value.timestamp,
        }),
        () => undefined,
      );
    });
    this.marketConnection.on("GatewayDepth", (contractId: unknown, input: unknown) => {
      let resolved: { contractId: string; payload: unknown };
      try {
        resolved = unwrapMarketStreamArgs(contractId, input);
      } catch (error) {
        this.payloadFault("market", error);
        return;
      }
      let depths: ReturnType<typeof parseDepthBatch>;
      try {
        depths = parseDepthBatch(resolved.contractId, resolved.payload);
      } catch (error) {
        this.payloadFault("market", error);
        return;
      }
      for (const depth of depths) {
        this.recordAndApply(
          "market",
          "depth",
          { contractId: resolved.contractId, payload: depth },
          () => depth,
          (value) => ({
            accountId: null,
            contractId: value.contractId,
            providerEntityId: `${value.contractId}:${value.timestamp}:${value.type}:${value.price}`,
            providerTimestampUtc: value.timestamp,
          }),
          () => undefined,
        );
      }
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
      if (this.stopped) {
        void this.options.onStateInvalidated?.();
        return;
      }
      // Automatic reconnect exhausted or close skipped the retry loop — start the hub again.
      void this.restartHub(kind);
    });
  }

  private startLivenessWatch(): void {
    if (this.livenessTimer) {
      return;
    }
    const livenessMs = this.options.livenessMs ?? DEFAULT_STREAM_LIVENESS_MS;
    this.livenessTimer = setInterval(() => {
      this.checkMarketLiveness();
    }, Math.min(5_000, livenessMs));
    this.livenessTimer.unref();
  }

  private checkMarketLiveness(): void {
    const market = this.state.operationalStatus().marketStream;
    if (!shouldForceMarketLivenessRestart({
      stopped: this.stopped,
      expectedLive: this.options.isMarketExpectedLive?.() ?? true,
      streamState: market.state,
      lastEventAt: this.state.lastQuoteReceivedAt(this.options.contractId) ?? market.lastEventAt,
      connectedSinceUtc: market.lastChangedAt,
      nowMs: (this.options.now ?? Date.now)(),
      livenessMs: this.options.livenessMs ?? DEFAULT_STREAM_LIVENESS_MS,
    })) {
      return;
    }
    this.recordLifecycleSafely("market", "liveness_restart");
    void this.restartHub("market");
  }

  private async restartHub(kind: VenueStreamKind): Promise<void> {
    if (!shouldScheduleHubRestart({
      stopped: this.stopped,
      restartInFlight: this.restartInFlight[kind],
    })) {
      return;
    }
    this.restartInFlight[kind] = true;
    let retry = false;
    const connection = kind === "user" ? this.userConnection : this.marketConnection;
    const subscribe = kind === "user"
      ? () => this.subscribeUser()
      : () => this.subscribeMarket();
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    try {
      const delay = nextSignalRReconnectDelayMs(this.restartAttempts[kind]);
      this.restartAttempts[kind] += 1;
      if (delay > 0) {
        await sleep(delay);
      }
      if (this.stopped) {
        return;
      }
      this.state.markStreamConnecting(kind);
      await connection.stop().catch(() => undefined);
      await connection.start();
      await subscribe();
      this.recordLifecycle(kind, "reconnected_and_subscribed");
      this.state.markStreamConnected(kind);
      this.restartAttempts[kind] = 0;
      await this.options.onReconnected?.();
    } catch (error) {
      this.recordLifecycleSafely(kind, "restart_failed", error);
      this.state.markStreamDisconnected(kind, error);
      retry = !this.stopped;
    } finally {
      this.restartInFlight[kind] = false;
    }
    if (retry) {
      void this.restartHub(kind);
    }
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
    apply: (value: T, receivedUtc: string) => void,
  ): void {
    try {
      const receivedUtc = new Date().toISOString();
      recordProviderEventBeforeApply({
        sink: this.options.evidence,
        receivedUtc,
        source: kind === "user" ? "projectx_user_stream" : "projectx_market_stream",
        eventType,
        generation: this.state.operationalStatus().generation,
        rawPayload,
        parse,
        identity,
        apply: (value) => apply(value, receivedUtc),
      });
      this.state.markStreamEvent(kind);
    } catch (error) {
      this.payloadFault(kind, error, kind === "user" ? { eventType, rawPayload } : undefined);
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

  private payloadFault(
    kind: VenueStreamKind,
    error: unknown,
    context?: { eventType: string; rawPayload: unknown },
  ): void {
    this.state.markPayloadFault(kind, error);
    console.error("Rejected ProjectX realtime event", error);
    if (kind === "user" && context) {
      console.error(
        "Rejected ProjectX user stream payload detail",
        userStreamPayloadFaultDetail(context.eventType, context.rawPayload),
      );
    }
    // ponytail: market parse faults are local evidence gaps; REST reconcile amplifies 429 pressure.
    if (kind !== "market") {
      void this.options.onStateInvalidated?.();
    }
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
    const contractIds = [...new Set(this.options.contractIds ?? [this.options.contractId])];
    const depthContractIds = new Set(this.options.depthContractIds ?? [this.options.contractId]);
    await Promise.all(contractIds.flatMap((contractId) => [
      this.marketConnection.invoke("SubscribeContractQuotes", contractId),
      this.marketConnection.invoke("SubscribeContractTrades", contractId),
      ...(depthContractIds.has(contractId)
        ? [this.marketConnection.invoke("SubscribeContractMarketDepth", contractId)]
        : []),
    ]));
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
