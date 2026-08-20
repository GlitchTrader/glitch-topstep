import type { AccountInfo } from "../domain/models.js";
import { ProjectXApiClient, type ProjectXClientOptions } from "./client.js";

export interface ProjectXAuthStatus {
  degraded: boolean;
  lastRefreshUtc: string | null;
  expiresAtUtc: string | null;
  refreshInFlight: boolean;
}

/** ponytail: interim wrapper — TS-AUDIT-06 will add single-flight + 401 recovery here. */
export class ProjectXAuthManager {
  private readonly client: ProjectXApiClient;
  private lastRefreshUtc: string | null = null;

  public constructor(options: ProjectXClientOptions) {
    this.client = new ProjectXApiClient(options);
  }

  public status(): ProjectXAuthStatus {
    return {
      degraded: false,
      lastRefreshUtc: this.lastRefreshUtc,
      expiresAtUtc: null,
      refreshInFlight: false,
    };
  }

  public async ensureAuthenticated(): Promise<string> {
    const token = await this.client.login();
    this.lastRefreshUtc = new Date().toISOString();
    return token;
  }

  public async searchAccounts(onlyActiveAccounts = true): Promise<AccountInfo[]> {
    await this.ensureAuthenticated();
    return this.client.searchAccounts(onlyActiveAccounts);
  }

  /** Test hook — forces the next call down the re-auth path. */
  public forceExpiredForTests(): void {
    (this.client as unknown as { token: string | null }).token = null;
  }
}
