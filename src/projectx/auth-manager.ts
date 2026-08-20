import type { AccountInfo } from "../domain/models.js";
import { ProjectXApiClient, ProjectXApiError, type ProjectXClientOptions } from "./client.js";

export interface ProjectXAuthStatus {
  degraded: boolean;
  lastRefreshUtc: string | null;
  expiresAtUtc: string | null;
  refreshInFlight: boolean;
}

export class ProjectXAuthManager {
  private readonly client: ProjectXApiClient;
  private lastRefreshUtc: string | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private degraded = false;

  public constructor(options: ProjectXClientOptions) {
    this.client = new ProjectXApiClient(options);
  }

  public status(): ProjectXAuthStatus {
    return {
      degraded: this.degraded,
      lastRefreshUtc: this.lastRefreshUtc,
      expiresAtUtc: null,
      refreshInFlight: this.refreshInFlight !== null,
    };
  }

  public async ensureAuthenticated(): Promise<string> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
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
  }

  private clearSessionForTests(): void {
    (this.client as unknown as { token: string | null }).token = null;
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
      this.degraded = false;
      return token;
    } catch (error: unknown) {
      this.degraded = true;
      throw error;
    }
  }
}
