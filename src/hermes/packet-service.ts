import type { AppConfig } from "../config.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import {
  buildDecisionPacket,
  type DirectDecisionPacket,
} from "./packet-builder.js";

export class DecisionPacketService {
  private cachedPacket: DirectDecisionPacket | null = null;
  private expiresAtMs = 0;

  public constructor(
    private readonly config: AppConfig,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly now: () => number = Date.now,
  ) {}

  public current(): DirectDecisionPacket {
    const nowMs = this.now();
    if (this.cachedPacket && nowMs < this.expiresAtMs) {
      return this.cachedPacket;
    }
    this.cachedPacket = buildDecisionPacket(
      this.snapshot(),
      this.config.policy,
      this.config.risk,
      this.config.scope.instrument,
    );
    this.expiresAtMs = nowMs + this.config.packetLeaseMs;
    return this.cachedPacket;
  }

  public invalidate(): void {
    this.expiresAtMs = 0;
  }
}
