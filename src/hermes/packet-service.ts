import type { AppConfig } from "../config.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import {
  buildDecisionPacket,
  type DirectDecisionPacket,
} from "./packet-builder.js";

interface IssuedPacket {
  packet: DirectDecisionPacket;
  expiresAtMs: number;
}

export class DecisionPacketService {
  private readonly issuedBySnapshotHash = new Map<string, IssuedPacket>();

  public constructor(
    private readonly config: AppConfig,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly now: () => number = Date.now,
  ) {}

  public current(): DirectDecisionPacket {
    const nowMs = this.now();
    this.prune(nowMs);
    const packet = buildDecisionPacket(
      this.snapshot(),
      this.config.policy,
      this.config.risk,
      this.config.scope.instrument,
      this.config.tradingMode,
      this.config.packetLeaseMs,
      new Date(nowMs),
    );
    this.issuedBySnapshotHash.set(packet.market.snapshot_hash, {
      packet,
      expiresAtMs: nowMs + this.config.packetLeaseMs,
    });
    return packet;
  }

  public resolve(snapshotHash: string): DirectDecisionPacket | null {
    const nowMs = this.now();
    this.prune(nowMs);
    const issued = this.issuedBySnapshotHash.get(snapshotHash);
    return issued && nowMs <= issued.expiresAtMs ? issued.packet : null;
  }

  public invalidateAll(): void {
    this.issuedBySnapshotHash.clear();
  }

  private prune(nowMs: number): void {
    for (const [hash, issued] of this.issuedBySnapshotHash) {
      if (nowMs > issued.expiresAtMs) {
        this.issuedBySnapshotHash.delete(hash);
      }
    }
  }
}
