import { ProjectXApiError } from "./client.js";
import { isMutationPath } from "./retry-policy.js";

/**
 * Groups read endpoints so a failure burst on one family cannot open the breaker for another.
 * `/api/History/retrieveBars` sits on its own tight rate-limit budget (50 req/30s) and is the
 * endpoint most likely to fail under reconnect-storm load; without isolation, that alone could
 * trip the breaker for reconciliation-critical reads (positions/orders/accounts) too
 * (TS-AUDIT31-PX-01).
 */
export function readEndpointFamily(path: string): string {
  if (path === "/api/History/retrieveBars") {
    return "bars";
  }
  if (path === "/api/Position/searchOpen") {
    return "positions";
  }
  if (path === "/api/Order/searchOpen" || path === "/api/Order/search") {
    return "orders";
  }
  if (path === "/api/Trade/search") {
    return "trades";
  }
  if (path === "/api/Account/search") {
    return "accounts";
  }
  if (path === "/api/Contract/available") {
    return "contracts";
  }
  if (path === "/api/Auth/validate") {
    return "auth";
  }
  return "other";
}

interface FamilyState {
  failures: number;
  openUntilMs: number;
}

/** Per-endpoint-family breaker for idempotent reads; each family auto-clears after cooldown. */
export class ReadCircuitBreaker {
  private readonly families = new Map<string, FamilyState>();

  public constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  public assertAllows(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    const state = this.families.get(readEndpointFamily(path));
    if (state && Date.now() < state.openUntilMs) {
      throw new ProjectXApiError("read_circuit_open", "ProjectX read circuit breaker is open");
    }
  }

  public recordSuccess(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    this.families.delete(readEndpointFamily(path));
  }

  public recordFailure(path: string): void {
    if (isMutationPath(path)) {
      return;
    }
    const family = readEndpointFamily(path);
    const state = this.families.get(family) ?? { failures: 0, openUntilMs: 0 };
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openUntilMs = Date.now() + this.cooldownMs;
      state.failures = 0;
    }
    this.families.set(family, state);
  }

  /** Cooldown state per family, for /health and diagnostics. */
  public status(): Record<string, { failures: number; open: boolean; openUntilMs: number }> {
    const nowMs = Date.now();
    const result: Record<string, { failures: number; open: boolean; openUntilMs: number }> = {};
    for (const [family, state] of this.families) {
      result[family] = {
        failures: state.failures,
        open: nowMs < state.openUntilMs,
        openUntilMs: state.openUntilMs,
      };
    }
    return result;
  }
}
