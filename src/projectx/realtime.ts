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
  DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
  DEFAULT_HUB_START_TIMEOUT_MS,
  DEFAULT_STREAM_LIVENESS_MS,
  DEFAULT_STUCK_STREAM_MS,
  isHubMarketEventStale,
  livenessCheckIntervalMs,
  nextSignalRReconnectDelayMs,
  shouldForceMarketLivenessRestart,
  shouldForceStuckStreamRestart,
  shouldScheduleHubRestart,
} from "./stream-supervisor.js";
import { HubRecoveryController } from "./hub-recovery-controller.js";

export interface ReconnectContext {
  kind: VenueStreamKind;
  generation: number;
}

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
  onReconnected?: (context: ReconnectContext) => void | Promise<void>;
  onStateInvalidated?: () => void | Promise<void>;
  onBeforePositionApply?: (position: PositionInfo, receivedUtc: string) => void | Promise<void>;
  livenessMs?: number;
  stuckStreamMs?: number;
  hubStartTimeoutMs?: number;
  isMarketExpectedLive?: () => boolean;
  marketRecovery?: HubRecoveryController;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: lets a fake hub replace the SignalR transport without changing lifecycle wiring. */
  connectionFactory?: (kind: VenueStreamKind, url: string) => SignalRConnection;
}

export interface SignalRConnection {
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
  private marketLivenessStaleChecks = 0;
  private readonly recoveryGeneration: Record<VenueStreamKind, number> = {
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
    const build = (kind: VenueStreamKind, url: string): SignalRConnection => (
      options.connectionFactory?.(kind, url) ?? new HubConnectionBuilder()
        .withUrl(url, signalROptions)
        .configureLogging(options.logLevel ?? LogLevel.Warning)
        .withAutomaticReconnect(reconnectPolicy)
        .build()
    );
    this.userConnection = build("user", options.userHubUrl);
    this.marketConnection = build("market", options.marketHubUrl);

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
        (value, receivedUtc) => {
          this.state.markMarketTradeReceived(value.contractId, receivedUtc);
        },
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
          (value, receivedUtc) => {
            this.state.markMarketDepthReceived(value.contractId, receivedUtc);
          },
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
        if (kind === "market" && this.options.marketRecovery) {
          const atUtc = new Date().toISOString();
          this.recoveryGeneration.market = this.options.marketRecovery.beginAttempt(
            "market",
            "reconnecting",
            atUtc,
          );
        }
      } catch (recordError) {
        this.payloadFault(kind, recordError);
      }
      void this.options.onStateInvalidated?.();
    });
    connection.onreconnected(() => {
      void (async () => {
        const generation = this.recoveryGeneration[kind];
        try {
          if (kind === "market" && this.options.marketRecovery) {
            this.options.marketRecovery.markProgress(
              "resubscribing",
              generation,
              new Date().toISOString(),
            );
          }
          await subscribe();
          this.recordLifecycle(kind, "reconnected_and_subscribed");
          this.state.markStreamConnected(kind);
          await this.options.onReconnected?.({ kind, generation });
        } catch (error) {
          if (kind === "market" && this.options.marketRecovery) {
            this.options.marketRecovery.fail(generation, new Date().toISOString());
          }
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
      this.checkStreamLiveness();
    }, livenessCheckIntervalMs(livenessMs));
    this.livenessTimer.unref();
  }

  private checkStreamLiveness(): void {
    const nowMs = (this.options.now ?? Date.now)();
    const operational = this.state.operationalStatus();
    const market = operational.marketStream;
    const user = operational.userStream;
    const livenessMs = this.options.livenessMs ?? DEFAULT_STREAM_LIVENESS_MS;
    const stuckMs = this.options.stuckStreamMs ?? DEFAULT_STUCK_STREAM_MS;
    const lastHubEventAt = market.lastEventAt;

    if (isHubMarketEventStale({
      lastHubEventAt,
      connectedSinceUtc: market.lastChangedAt,
      nowMs,
      livenessMs,
    })) {
      this.marketLivenessStaleChecks += 1;
    } else {
      this.marketLivenessStaleChecks = 0;
    }

    if (shouldForceMarketLivenessRestart({
      stopped: this.stopped,
      expectedLive: this.options.isMarketExpectedLive?.() ?? true,
      streamState: market.state,
      lastHubEventAt,
      connectedSinceUtc: market.lastChangedAt,
      nowMs,
      livenessMs,
      consecutiveStaleChecks: this.marketLivenessStaleChecks,
      debounceFailures: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
    })) {
      this.marketLivenessStaleChecks = 0;
      this.recordLifecycleSafely("market", "liveness_restart");
      void this.restartHub("market");
    } else if (shouldForceStuckStreamRestart({
      stopped: this.stopped,
      streamState: market.state,
      lastChangedAt: market.lastChangedAt,
      nowMs,
      stuckMs,
    })) {
      this.recordLifecycleSafely("market", "stuck_stream_restart");
      void this.restartHub("market");
    }

    if (shouldForceStuckStreamRestart({
      stopped: this.stopped,
      streamState: user.state,
      lastChangedAt: user.lastChangedAt,
      nowMs,
      stuckMs,
    })) {
      this.recordLifecycleSafely("user", "stuck_stream_restart");
      void this.restartHub("user");
    }
  }

  private async restartHub(kind: VenueStreamKind): Promise<void> {
    if (!shouldScheduleHubRestart({
      stopped: this.stopped,
      restartInFlight: this.restartInFlight[kind],
    })) {
      return;
    }
    let retry = false;
    const connection = kind === "user" ? this.userConnection : this.marketConnection;
    const subscribe = kind === "user"
      ? () => this.subscribeUser()
      : () => this.subscribeMarket();
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    const hubStartTimeoutMs = this.options.hubStartTimeoutMs ?? DEFAULT_HUB_START_TIMEOUT_MS;
    const delay = nextSignalRReconnectDelayMs(this.restartAttempts[kind]);
    this.restartAttempts[kind] += 1;
    if (delay > 0) {
      await sleep(delay);
    }
    if (this.stopped) {
      return;
    }
    if (!shouldScheduleHubRestart({
      stopped: this.stopped,
      restartInFlight: this.restartInFlight[kind],
    })) {
      return;
    }
    this.restartInFlight[kind] = true;
    const generation = kind === "market" && this.options.marketRecovery
      ? this.options.marketRecovery.beginAttempt("market", "suspect", new Date().toISOString())
      : this.recoveryGeneration[kind];
    if (kind === "market" && this.options.marketRecovery) {
      this.recoveryGeneration.market = generation;
    }
    try {
      this.state.markStreamConnecting(kind);
      await connection.stop().catch(() => undefined);
      // ponytail: SignalR start() can hang forever with restartInFlight stuck; bound the attempt.
      await withTimeout(
        (async () => {
          await connection.start();
          if (kind === "market" && this.options.marketRecovery) {
            this.options.marketRecovery.markProgress(
              "resubscribing",
              generation,
              new Date().toISOString(),
            );
          }
          await subscribe();
        })(),
        hubStartTimeoutMs,
        `${kind}_hub_start_timeout`,
      );
      this.recordLifecycle(kind, "reconnected_and_subscribed");
      this.state.markStreamConnected(kind);
      this.restartAttempts[kind] = 0;
      await this.options.onReconnected?.({ kind, generation });
    } catch (error) {
      if (kind === "market" && this.options.marketRecovery) {
        this.options.marketRecovery.fail(generation, new Date().toISOString());
      }
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
      if (kind === "market") {
        this.marketLivenessStaleChecks = 0;
      }
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorPayload(error: unknown): unknown {
  if (error === undefined) {
    return null;
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { value: String(error) };
}
