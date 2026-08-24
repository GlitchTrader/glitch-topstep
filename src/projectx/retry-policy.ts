import { ProjectXApiError } from "./client.js";

export type RetryClass = "read_idempotent" | "auth_revalidate" | "mutation_ambiguous" | "no_retry";

export function classifyProjectXError(error: unknown): RetryClass {
  if (!(error instanceof ProjectXApiError)) {
    return "no_retry";
  }
  if (error.status === 401 || error.status === 403) {
    return "auth_revalidate";
  }
  if (error.status === 429) {
    return "read_idempotent";
  }
  if (error.code === "response_too_large" || error.code === "invalid_json_response") {
    return "no_retry";
  }
  if (error.status === undefined || error.status >= 500) {
    return "read_idempotent";
  }
  return "no_retry";
}

export function retryDelayMs(attempt: number, baseMs = 1_000): number {
  const jitter = Math.floor(Math.random() * 250);
  return baseMs * (attempt + 1) + jitter;
}

export function shouldRetryRead(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts - 1) {
    return false;
  }
  return classifyProjectXError(error) === "read_idempotent";
}
