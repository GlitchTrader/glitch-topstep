import type { AccountInfo } from "../domain/models.js";
import { ProjectXApiClient, ProjectXApiError, type ProjectXClientOptions } from "./client.js";

export interface ProjectXAuthStatus {
  degraded: boolean;
  lastRefreshUtc: string | null;
  expiresAtUtc: string | null;
  refreshInFlight: boolean;
  refreshFailureCount: number;
}

/** Matches the proactive refresh timer in AppService (12h). */
export const PROJECTX_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Refresh before expiry so concurrent callers never race a dead token (TS-REAUDIT-01). */
export const PROJECTX_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Bounded backoff after a failed refresh/login so a persistent outage cannot turn every caller's
 * ensureAuthenticated() into a tight retry loop against ProjectX's auth endpoint (TS-REAUDIT-01). */
export const PROJECTX_AUTH_BACKOFF_BASE_MS = 1_000;
export const PROJECTX_AUTH_BACKOFF_MAX_MS = 30_000;

export function projectXAuthBackoffDelayMs(
  failureCount: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(failureCount, 1), 5);
  const bounded = Math.min(
    PROJECTX_AUTH_BACKOFF_BASE_MS * 2 ** (exponent - 1),
    PROJECTX_AUTH_BACKOFF_MAX_MS,
  );
  const jitter = bounded * 0.25 * random();
  return Math.round(bounded + jitter);
}

const AUTHENTICATED_READ_METHODS = new Set([
  "searchAccounts",
  "searchAccountsCollection",
  "listAvailableContracts",
  "listAvailableContractsCollection",
  "searchOpenPositions",
  "searchOpenPositionsCollection",
  "searchOpenOrders",
  "searchOpenOrdersCollection",
  "searchOrders",
  "searchTrades",
  "retrieveBars",
]);

export class ProjectXAuthManager {
  /** @deprecated Prefer authenticatedClient() for production REST consumers. */
  public apiClient(): ProjectXApiClient {
    return this.client;
  }

  /** Production REST surface: ensure auth before every call; safe reads retry once on 401/403. */
  public authenticatedClient(): ProjectXApiClient {
    const inner = this.client;
    const manager = this;
    return new Proxy(inner, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }
        const methodName = String(property);
        return (...args: unknown[]) => {
          const invoke = () => (value as (...params: unknown[]) => unknown).apply(target, args);
          if (AUTHENTICATED_READ_METHODS.has(methodName)) {
            return manager.withAuthenticatedRead(() => invoke() as Promise<unknown>);
          }
          return manager.withAuthenticatedMutation(() => invoke() as Promise<unknown>);
        };
      },
    }) as ProjectXApiClient;
  }

  private readonly client: ProjectXApiClient;
  private lastRefreshUtc: string | null = null;
  private expiresAtUtc: string | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private degraded = false;
  /** Lifetime count surfaced via status()/invariant metrics -- never reset, diagnostic only. */
  private refreshFailureCount = 0;
  /** Consecutive-failure streak driving backoff staging only; resets on any success. */
  private consecutiveRefreshFailures = 0;
  private nextRefreshAttemptAtMs = 0;

  public constructor(
    options: ProjectXClientOptions,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.client = new ProjectXApiClient(options);
  }

  public status(): ProjectXAuthStatus {
    return {
      degraded: this.degraded,
      lastRefreshUtc: this.lastRefreshUtc,
      expiresAtUtc: this.expiresAtUtc,
      refreshInFlight: this.refreshInFlight !== null,
      refreshFailureCount: this.refreshFailureCount,
    };
  }

  public async ensureAuthenticated(): Promise<string> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    if (this.hasUsableSession()) {
      return this.client.sessionToken;
    }
    const run = this.refreshSession();
    this.refreshInFlight = run;
    try {
      return await run;
    } finally {
      if (this.refreshInFlight === run) {
        this.refreshInFlight = null;
      }
    }
  }

  public async searchAccounts(onlyActiveAccounts = true): Promise<AccountInfo[]> {
    return this.withAuthenticatedRead(() => this.client.searchAccounts(onlyActiveAccounts));
  }

  /** Safe read retry once after auth failure (TS-REAUDIT-01). */
  public async withAuthenticatedRead<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureAuthenticated();
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof ProjectXApiError && (error.status === 401 || error.status === 403)) {
        this.invalidateSession();
        await this.ensureAuthenticated();
        return await operation();
      }
      throw error;
    }
  }

  /** Mutations authenticate once; ambiguous failures reconcile upstream — no blind replay (TS-REAUDIT-01). */
  public async withAuthenticatedMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureAuthenticated();
    return operation();
  }

  /** Test hook — forces the next call down the re-auth path. */
  public forceExpiredForTests(): void {
    this.invalidateSession();
    this.expiresAtUtc = null;
  }

  private invalidateSession(): void {
    (this.client as unknown as { token: string | null }).token = null;
    this.expiresAtUtc = null;
  }

  private hasUsableSession(): boolean {
    if (this.degraded) {
      return false;
    }
    try {
      this.client.sessionToken;
    } catch {
      return false;
    }
    if (!this.expiresAtUtc) {
      return false;
    }
    const refreshByMs = Date.parse(this.expiresAtUtc) - PROJECTX_REFRESH_MARGIN_MS;
    return Date.now() < refreshByMs;
  }

  private async refreshSession(): Promise<string> {
    const waitMs = this.nextRefreshAttemptAtMs - this.now();
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    try {
      const hasToken = Boolean((this.client as unknown as { token: string | null }).token);
      const token = hasToken
        ? await this.client.validateSession()
        : await this.client.login();
      if (!hasToken) {
        await this.client.validateSession();
      }
      this.lastRefreshUtc = new Date().toISOString();
      this.expiresAtUtc = new Date(
        Date.parse(this.lastRefreshUtc) + PROJECTX_SESSION_TTL_MS,
      ).toISOString();
      this.degraded = false;
      this.consecutiveRefreshFailures = 0;
      this.nextRefreshAttemptAtMs = 0;
      return token;
    } catch (error: unknown) {
      this.degraded = true;
      this.refreshFailureCount += 1;
      this.consecutiveRefreshFailures += 1;
      this.nextRefreshAttemptAtMs = this.now()
        + projectXAuthBackoffDelayMs(this.consecutiveRefreshFailures);
      throw error;
    }
  }
}
