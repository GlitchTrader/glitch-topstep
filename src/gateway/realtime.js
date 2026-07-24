import { HubConnectionBuilder, HttpTransportType } from "@microsoft/signalr";
import { ORDER_SIDE, POSITION_TYPE } from "./constants.js";

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export class RealtimeCache {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.marketConnection = null;
    this.userConnection = null;
    this.quote = null;
    this.tape = [];
    this.depth = [];
    this.account = null;
    this.positions = [];
    this.orders = [];
    this.lastError = null;
    this.started = false;
    this.contractId = null;
    this.accountId = null;
  }

  get status() {
    return {
      enabled: this.config.realtimeEnabled,
      connected: Boolean(this.marketConnection || this.userConnection),
      market_connected: Boolean(this.marketConnection),
      user_connected: Boolean(this.userConnection),
      last_error: this.lastError,
      quote_age_ms: this.quote?.received_at ? Date.now() - this.quote.received_at : null,
      tape_size: this.tape.length,
      depth_size: this.depth.length,
    };
  }

  async ensureStarted(accountId, contractId) {
    if (!this.config.realtimeEnabled) {
      return;
    }
    this.accountId = accountId;
    this.contractId = contractId;
    if (this.started) {
      return;
    }
    this.started = true;
    await Promise.allSettled([this.startMarketHub(contractId), this.startUserHub(accountId)]);
  }

  async startMarketHub(contractId) {
    try {
      const token = await this.client.ensureSession();
      const url = `${this.config.realtimeMarketHubUrl}?access_token=${encodeURIComponent(token)}`;
      const connection = new HubConnectionBuilder()
        .withUrl(url, {
          skipNegotiation: true,
          transport: HttpTransportType.WebSockets,
          accessTokenFactory: () => this.client.token,
          timeout: 10000,
        })
        .withAutomaticReconnect()
        .build();

      connection.on("GatewayQuote", (_contractId, data) => {
        this.quote = {
          symbol: data?.symbol ?? data?.symbolId ?? null,
          last: Number(data?.lastPrice ?? data?.last),
          bid: Number(data?.bestBid ?? data?.bid),
          ask: Number(data?.bestAsk ?? data?.ask),
          change: Number(data?.change ?? 0),
          change_percent: Number(data?.changePercent ?? 0),
          open: Number(data?.open),
          high: Number(data?.high),
          low: Number(data?.low),
          volume: Number(data?.volume ?? 0),
          quote_timestamp: data?.timestamp ?? data?.lastUpdated ?? utcNow(),
          source: "realtime",
          received_at: Date.now(),
        };
      });

      connection.on("GatewayTrade", (_contractId, data) => {
        this.tape.push({
          price: Number(data?.price),
          volume: Number(data?.volume ?? 1),
          timestamp: data?.timestamp ?? utcNow(),
          side: data?.type === 1 ? "sell" : "buy",
        });
        if (this.tape.length > this.config.realtimeTapeLimit) {
          this.tape.splice(0, this.tape.length - this.config.realtimeTapeLimit);
        }
      });

      connection.on("GatewayDepth", (_contractId, data) => {
        this.depth.push({
          timestamp: data?.timestamp ?? utcNow(),
          type: data?.type,
          price: Number(data?.price),
          volume: Number(data?.volume ?? 0),
          current_volume: Number(data?.currentVolume ?? 0),
        });
        if (this.depth.length > this.config.realtimeDepthLimit) {
          this.depth.splice(0, this.depth.length - this.config.realtimeDepthLimit);
        }
      });

      connection.onreconnected(() => {
        connection.invoke("SubscribeContractQuotes", contractId).catch(() => {});
        connection.invoke("SubscribeContractTrades", contractId).catch(() => {});
        connection.invoke("SubscribeContractMarketDepth", contractId).catch(() => {});
      });

      await connection.start();
      await connection.invoke("SubscribeContractQuotes", contractId);
      await connection.invoke("SubscribeContractTrades", contractId);
      await connection.invoke("SubscribeContractMarketDepth", contractId);
      this.marketConnection = connection;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async startUserHub(accountId) {
    try {
      const token = await this.client.ensureSession();
      const url = `${this.config.realtimeUserHubUrl}?access_token=${encodeURIComponent(token)}`;
      const connection = new HubConnectionBuilder()
        .withUrl(url, {
          skipNegotiation: true,
          transport: HttpTransportType.WebSockets,
          accessTokenFactory: () => this.client.token,
          timeout: 10000,
        })
        .withAutomaticReconnect()
        .build();

      const subscribe = () => {
        connection.invoke("SubscribeAccounts").catch(() => {});
        connection.invoke("SubscribeOrders", accountId).catch(() => {});
        connection.invoke("SubscribePositions", accountId).catch(() => {});
        connection.invoke("SubscribeTrades", accountId).catch(() => {});
      };

      connection.on("GatewayUserAccount", (data) => {
        this.account = data;
      });
      connection.on("GatewayUserPosition", (data) => {
        const index = this.positions.findIndex((item) => item.id === data.id);
        if (index >= 0) {
          this.positions[index] = data;
        } else {
          this.positions.push(data);
        }
      });
      connection.on("GatewayUserOrder", (data) => {
        const index = this.orders.findIndex((item) => item.id === data.id);
        if (index >= 0) {
          this.orders[index] = data;
        } else {
          this.orders.push(data);
        }
      });

      connection.onreconnected(() => subscribe());
      await connection.start();
      subscribe();
      this.userConnection = connection;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  getQuoteSnapshot() {
    return this.quote;
  }

  getTape(limit) {
    return this.tape.slice(-limit);
  }

  getDepthTop(limit = 5) {
    const latestByPrice = new Map();
    for (const level of this.depth.slice(-100)) {
      latestByPrice.set(`${level.type}:${level.price}`, level);
    }
    return Array.from(latestByPrice.values()).slice(-limit);
  }

  mapPosition(position, contract, tickSize, tickValue, lastPrice) {
    if (!position) {
      return {
        side: "flat",
        size: 0,
        average_price: null,
        unrealized_pnl_usd: 0,
        unrealized_pnl_ticks: 0,
        age_seconds: null,
      };
    }
    const size = Number(position.size) || 0;
    const side = POSITION_TYPE[position.type] || (size > 0 ? "long" : "flat");
    const averagePrice = Number(position.averagePrice);
    const created = Date.parse(position.creationTimestamp || "");
    const ageSeconds = Number.isFinite(created)
      ? Math.max(0, Math.round((Date.now() - created) / 1000))
      : null;
    let unrealizedTicks = 0;
    if (Number.isFinite(averagePrice) && Number.isFinite(lastPrice) && size > 0) {
      const delta = lastPrice - averagePrice;
      unrealizedTicks =
        side === "short" ? -delta / tickSize : delta / tickSize;
    }
    const unrealizedUsd = unrealizedTicks * tickValue * size;
    return {
      side,
      size,
      average_price: Number.isFinite(averagePrice) ? averagePrice : null,
      unrealized_pnl_usd: Number(unrealizedUsd.toFixed(2)),
      unrealized_pnl_ticks: Number(unrealizedTicks.toFixed(2)),
      age_seconds: ageSeconds,
      creation_timestamp: position.creationTimestamp ?? null,
    };
  }

  mapOrders(orders, contractId) {
    return (orders || [])
      .filter((order) => !contractId || order.contractId === contractId)
      .map((order) => ({
        id: order.id,
        status: order.status,
        type: order.type,
        side: ORDER_SIDE[order.side] ?? order.side,
        size: Number(order.size) || 0,
        limit_price: order.limitPrice == null ? null : Number(order.limitPrice),
        stop_price: order.stopPrice == null ? null : Number(order.stopPrice),
        filled_price: order.filledPrice == null ? null : Number(order.filledPrice),
        custom_tag: order.customTag ?? null,
        updated_timestamp: order.updateTimestamp ?? order.creationTimestamp ?? null,
      }));
  }
}
