import { ProjectXApiError } from "../projectx/client.js";

export interface StartupScopeFetchRetryOptions {
  retryDelaysMs?: readonly number[];
  onRateLimited?: (delayMs: number, error: unknown) => void;
}

/** Centralizes ProjectX startup retry classification for service wiring. */
export async function fetchWithStartupRetry<T>(
  fetch: () => Promise<T>,
  options: StartupScopeFetchRetryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? [0, 30_000, 60_000];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delayMs = retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await fetch();
    } catch (error: unknown) {
      const rateLimited = error instanceof ProjectXApiError && error.status === 429;
      const nextDelayMs = retryDelaysMs[attempt + 1];
      if (rateLimited && nextDelayMs !== undefined) {
        options.onRateLimited?.(nextDelayMs, error);
        continue;
      }
      throw error;
    }
  }
  throw new Error("startup_scope_fetch_exhausted");
}
