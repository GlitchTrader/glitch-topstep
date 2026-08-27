import { ProjectXApiError } from "./client.js";
import { isMutationPath } from "./retry-policy.js";

/** ponytail: per-process breaker for idempotent reads; auto-clears after cooldown. */
export class ReadCircuitBreaker {
  private failures = 0;
  private openUntilMs = 0;

  public constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  public assertAllows(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    if (Date.now() < this.openUntilMs) {
      throw new ProjectXApiError("read_circuit_open", "ProjectX read circuit breaker is open");
    }
  }

  public recordSuccess(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    this.failures = 0;
    this.openUntilMs = 0;
  }

  public recordFailure(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openUntilMs = Date.now() + this.cooldownMs;
      this.failures = 0;
    }
  }
}
