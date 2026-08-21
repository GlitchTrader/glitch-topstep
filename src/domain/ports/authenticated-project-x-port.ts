import type { AccountInfo } from "../models.js";

export interface ProjectXAuthSessionStatus {
  degraded: boolean;
  lastRefreshUtc: string | null;
  expiresAtUtc: string | null;
  refreshInFlight: boolean;
  refreshFailureCount: number;
}

/** Minimal REST surface required by production consumers behind auth refresh. */
export interface AuthenticatedProjectXApi {
  readonly sessionToken: string;
}

/** TS-REAUDIT-07: single authenticated ProjectX session authority for REST consumers. */
export interface AuthenticatedProjectXPort {
  apiClient(): AuthenticatedProjectXApi;
  status(): ProjectXAuthSessionStatus;
  ensureAuthenticated(): Promise<string>;
  searchAccounts(onlyActiveAccounts?: boolean): Promise<AccountInfo[]>;
}
