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

export class ProjectXAuthManager {
  /** ponytail: single ProjectX session authority (TS-REAUDIT-01). */
  public apiClient(): ProjectXApiClient {
    return this.client;
  }

  private readonly client: ProjectXApiClient;
  private lastRefreshUtc: string | null = null;
  private expiresAtUtc: string | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private degraded = false;
  private refreshFailureCount = 0;

  public constructor(options: ProjectXClientOptions) {
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
    await this.ensureAuthenticated();
    try {
      return await this.client.searchAccounts(onlyActiveAccounts);
    } catch (error: unknown) {
      if (error instanceof ProjectXApiError && error.status === 401) {
        this.clearSessionForTests();
        await this.ensureAuthenticated();
        return this.client.searchAccounts(onlyActiveAccounts);
      }
      throw error;
    }
  }

  /** Test hook — forces the next call down the re-auth path. */
  public forceExpiredForTests(): void {
    this.clearSessionForTests();
    this.expiresAtUtc = null;
  }

  private clearSessionForTests(): void {
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
      return token;
    } catch (error: unknown) {
      this.degraded = true;
      this.refreshFailureCount += 1;
      throw error;
    }
  }
}
