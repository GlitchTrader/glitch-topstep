import type { AppConfig } from "../config.js";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import {
  buildDecisionPacket,
  type DirectDecisionPacket,
} from "./packet-builder.js";

export class DecisionPacketService {
  public constructor(
    private readonly config: AppConfig,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly store: SqliteExecutionStore,
    private readonly recovery: () => ExecutionRecoveryStatus,
    private readonly now: () => number = Date.now,
  ) {}

  public current(): DirectDecisionPacket {
    const nowMs = this.now();
    const packet = buildDecisionPacket(
      this.snapshot(),
      this.config.policy,
      this.config.risk,
      this.recovery(),
      this.config.scope.instrument,
      this.config.tradingMode,
      this.config.packetLeaseMs,
      new Date(nowMs),
    );
    this.store.recordIssuedPacket(packet);
    return packet;
  }

  public resolve(snapshotHash: string): DirectDecisionPacket | null {
    return this.store.resolveIssuedPacket(snapshotHash, new Date(this.now()).toISOString());
  }

  public invalidateAll(): void {
    this.store.invalidateIssuedPackets(new Date(this.now()).toISOString());
  }
}
