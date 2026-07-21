// @ts-ignore The official package supplies its own declarations after npm install.
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
import { VenueStateStore } from "../state/venue-state.js";
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
}

interface SignalRConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke(methodName: string, ...args: unknown[]): Promise<unknown>;
  on(methodName: string, handler: (...args: unknown[]) => void): void;
  onreconnected(handler: () => void): void;
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
    this.userConnection.onreconnected(() => void this.subscribeUser());
    this.marketConnection.onreconnected(() => void this.subscribeMarket());
  }

  public async start(): Promise<void> {
    await Promise.all([this.userConnection.start(), this.marketConnection.start()]);
    await Promise.all([this.subscribeUser(), this.subscribeMarket()]);
  }

  public async stop(): Promise<void> {
    await Promise.allSettled([this.userConnection.stop(), this.marketConnection.stop()]);
  }

  private registerHandlers(): void {
    this.userConnection.on("GatewayUserAccount", (input: unknown) => {
      this.tryApply(() => this.state.applyAccount(parseAccount(input)));
    });
    this.userConnection.on("GatewayUserPosition", (input: unknown) => {
      this.tryApply(() => this.state.applyPosition(parsePosition(input)));
    });
    this.userConnection.on("GatewayUserOrder", (input: unknown) => {
      this.tryApply(() => this.state.applyOrder(parseOrder(input)));
    });
    this.userConnection.on("GatewayUserTrade", (input: unknown) => {
      this.tryApply(() => this.state.applyTrade(parseTrade(input)));
    });

    this.marketConnection.on("GatewayQuote", (contractId: unknown, input: unknown) => {
      if (typeof contractId === "string") {
        this.tryApply(() => this.state.applyQuote(parseQuote(contractId, input)));
      }
    });
    this.marketConnection.on("GatewayTrade", (contractId: unknown, input: unknown) => {
      if (typeof contractId === "string") {
        this.tryApply(() => this.state.applyMarketTrade(parseMarketTrade(contractId, input)));
      }
    });
    this.marketConnection.on("GatewayDepth", (contractId: unknown, input: unknown) => {
      if (typeof contractId === "string") {
        this.tryApply(() => this.state.applyDepth(parseDepth(contractId, input)));
      }
    });
  }

  private tryApply(action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error("Ignored invalid ProjectX realtime payload", error);
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
    await Promise.all([
      this.marketConnection.invoke("SubscribeContractQuotes", this.options.contractId),
      this.marketConnection.invoke("SubscribeContractTrades", this.options.contractId),
      this.marketConnection.invoke("SubscribeContractMarketDepth", this.options.contractId),
    ]);
  }
}
