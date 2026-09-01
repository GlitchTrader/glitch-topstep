import type { DatabaseSync } from "node:sqlite";

const DEFAULT_BUSY_RETRIES = 5;
const DEFAULT_BUSY_BASE_MS = 10;

function syncSleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // ponytail: spin-wait for sub-100ms SQLITE_BUSY backoff only.
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const detail = `${error.message} ${(error as { errstr?: string }).errstr ?? ""}`;
  return /locked|busy/i.test(detail);
}

/** ponytail: bounded SQLITE_BUSY retry for local transactions only — never for ProjectX mutations. */
export function inSqliteTransaction<T>(
  database: DatabaseSync,
  action: () => T,
  options: { retries?: number; baseDelayMs?: number } = {},
): T {
  const retries = options.retries ?? DEFAULT_BUSY_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BUSY_BASE_MS;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      if (attempt < retries && isSqliteBusyError(error)) {
        const delayMs = baseDelayMs * 2 ** attempt;
        syncSleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error("sqlite_transaction_retry_exhausted");
}
