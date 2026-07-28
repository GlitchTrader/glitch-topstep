import type {
  AccountInfo,
  BarInfo,
  ContractInfo,
  OrderInfo,
  PositionInfo,
  TradeInfo,
} from "../domain/models.js";
import {
  isRecord,
  parseAccount,
  parseBar,
  parseContract,
  parseOrder,
  parsePosition,
  parseTrade,
} from "./schemas.js";

export interface ProjectXClientOptions {
  apiUrl: string;
  username: string;
  apiKey: string;
  requestTimeoutMs?: number;
  /** ponytail: test-only override; production uses ProjectXApiClient default backoff */
  rateLimitRetryMs?: readonly number[];
}

export interface PlaceOrderRequest {
  accountId: number;
  contractId: string;
  type: 1 | 2 | 4 | 5 | 6 | 7;
  side: 0 | 1;
  size: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  trailPrice?: number | null;
  customTag?: string | null;
  stopLossBracket?: { ticks: number; type: 4 | 5 } | null;
  takeProfitBracket?: { ticks: number; type: 1 } | null;
}

export interface ModifyOrderRequest {
  accountId: number;
  orderId: number;
  size?: number | null;
  limitPrice?: number | null;
  stopPrice?: number | null;
  trailPrice?: number | null;
}

export interface RetrieveBarsRequest {
  contractId: string;
  live: boolean;
  startTime: string;
  endTime: string;
  unit: 1 | 2 | 3 | 4 | 5 | 6;
  unitNumber: number;
  limit: number;
  includePartialBar: boolean;
}

export class ProjectXApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProjectXApiError";
  }
}

interface ApiEnvelope {
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
  [key: string]: unknown;
}

export class ProjectXApiClient {
  private token: string | null = null;
  private readonly requestTimeoutMs: number;
  private readonly rateLimitRetryMs: readonly number[];
  private static readonly defaultRateLimitRetryMs = [0, 5_000, 15_000, 30_000] as const;

  public constructor(private readonly options: ProjectXClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.rateLimitRetryMs = options.rateLimitRetryMs ?? ProjectXApiClient.defaultRateLimitRetryMs;
  }

  public get sessionToken(): string {
    if (!this.token) {
      throw new ProjectXApiError("not_authenticated", "ProjectX session token is unavailable");
    }
    return this.token;
  }

  public async login(): Promise<string> {
    const response = this.asEnvelope(
      await this.post("/api/Auth/loginKey", {
        userName: this.options.username,
        apiKey: this.options.apiKey,
      }, false),
    );
    this.assertSuccess(response);
    if (typeof response.token !== "string" || response.token.length === 0) {
      throw new ProjectXApiError("token_missing", "ProjectX login returned no session token");
    }
    this.token = response.token;
    return this.token;
  }

  public async validateSession(): Promise<string> {
    const response = this.asEnvelope(await this.post("/api/Auth/validate", {}));
    this.assertSuccess(response);
    if (typeof response.newToken === "string" && response.newToken.length > 0) {
      this.token = response.newToken;
    }
    return this.sessionToken;
  }

  public async searchAccounts(onlyActiveAccounts = true): Promise<AccountInfo[]> {
    const response = this.asEnvelope(
      await this.post("/api/Account/search", { onlyActiveAccounts }),
    );
    this.assertSuccess(response);
    return this.parseArray(response.accounts, "accounts", parseAccount);
  }

  public async listAvailableContracts(live: boolean): Promise<ContractInfo[]> {
    const response = this.asEnvelope(await this.post("/api/Contract/available", { live }));
    this.assertSuccess(response);
    return this.parseArray(response.contracts, "contracts", parseContract);
  }

  public async searchOpenPositions(accountId: number): Promise<PositionInfo[]> {
    const response = this.asEnvelope(
      await this.post("/api/Position/searchOpen", { accountId }),
    );
    this.assertSuccess(response);
    return this.parseArray(response.positions, "positions", parsePosition);
  }

  public async searchOpenOrders(accountId: number): Promise<OrderInfo[]> {
    const response = this.asEnvelope(await this.post("/api/Order/searchOpen", { accountId }));
    this.assertSuccess(response);
    return this.parseArray(response.orders, "orders", parseOrder);
  }

  public async searchOrders(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<OrderInfo[]> {
    const response = this.asEnvelope(
      await this.post("/api/Order/search", { accountId, startTimestamp, endTimestamp }),
    );
    this.assertSuccess(response);
    return this.parseArray(response.orders, "orders", parseOrder);
  }

  public async searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeInfo[]> {
    const response = this.asEnvelope(
      await this.post("/api/Trade/search", { accountId, startTimestamp, endTimestamp }),
    );
    this.assertSuccess(response);
    return this.parseArray(response.trades, "trades", parseTrade);
  }

  public async retrieveBars(request: RetrieveBarsRequest): Promise<BarInfo[]> {
    const response = this.asEnvelope(await this.post("/api/History/retrieveBars", request));
    this.assertSuccess(response);
    return this.parseArray(response.bars, "bars", parseBar);
  }

  public async placeOrder(request: PlaceOrderRequest): Promise<number> {
    const response = this.asEnvelope(await this.post("/api/Order/place", request));
    this.assertSuccess(response);
    if (typeof response.orderId !== "number" || !Number.isInteger(response.orderId)) {
      throw new ProjectXApiError("order_id_missing", "ProjectX accepted an order without an orderId");
    }
    return response.orderId;
  }

  public async modifyOrder(request: ModifyOrderRequest): Promise<void> {
    const response = this.asEnvelope(await this.post("/api/Order/modify", request));
    this.assertSuccess(response);
  }

  public async cancelOrder(accountId: number, orderId: number): Promise<void> {
    const response = this.asEnvelope(await this.post("/api/Order/cancel", { accountId, orderId }));
    this.assertSuccess(response);
  }

  public async closePosition(accountId: number, contractId: string): Promise<void> {
    const response = this.asEnvelope(
      await this.post("/api/Position/closeContract", { accountId, contractId }),
    );
    this.assertSuccess(response);
  }

  private async post(path: string, body: unknown, authenticated = true): Promise<unknown> {
    let lastError: unknown;
    const maxAttempts = Math.max(1, this.rateLimitRetryMs.length);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const delayMs = this.rateLimitRetryMs[attempt]
          ?? this.rateLimitRetryMs.at(-1)
          ?? 30_000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        return await this.postOnce(path, body, authenticated);
      } catch (error: unknown) {
        lastError = error;
        if (
          error instanceof ProjectXApiError
          && error.status === 429
          && attempt < maxAttempts - 1
        ) {
          console.error(`ProjectX ${path} rate limited; retrying (${attempt + 1})`);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async postOnce(path: string, body: unknown, authenticated = true): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authenticated) {
      headers.Authorization = `Bearer ${this.sessionToken}`;
    }

    const response = await fetch(`${this.options.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new ProjectXApiError(
        "invalid_json_response",
        `ProjectX returned non-JSON content for ${path}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new ProjectXApiError(
        "http_error",
        `ProjectX ${path} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return payload;
  }

  private asEnvelope(input: unknown): ApiEnvelope {
    if (!isRecord(input)) {
      throw new ProjectXApiError("response_not_object", "ProjectX response was not an object");
    }
    if (
      typeof input.success !== "boolean"
      || typeof input.errorCode !== "number"
      || (input.errorMessage !== null && typeof input.errorMessage !== "string")
    ) {
      throw new ProjectXApiError("response_contract_invalid", "ProjectX response envelope was invalid");
    }
    return input as ApiEnvelope;
  }

  private assertSuccess(response: ApiEnvelope): void {
    if (!response.success || response.errorCode !== 0) {
      throw new ProjectXApiError(
        `projectx_${response.errorCode}`,
        response.errorMessage ?? "ProjectX request failed",
      );
    }
  }

  private parseArray<T>(
    input: unknown,
    name: string,
    parser: (value: unknown) => T,
  ): T[] {
    if (!Array.isArray(input)) {
      throw new ProjectXApiError("response_contract_invalid", `${name} must be an array`);
    }
    return input.map(parser);
  }
}
