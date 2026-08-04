/**
 * Tracks peak/trough unrealized PnL while the scoped instrument is open.
 * Used for MAE/MFE on flat -> trade_outcome enrichment.
 */
export class TradeExcursionTracker {
  private active = false;
  private peakUnrealized = 0;
  private troughUnrealized = 0;

  public observe(openContracts: number, unrealizedPnlUsd: number): void {
    if (openContracts <= 0) {
      this.active = false;
      return;
    }
    if (!this.active) {
      this.active = true;
      this.peakUnrealized = unrealizedPnlUsd;
      this.troughUnrealized = unrealizedPnlUsd;
      return;
    }
    this.peakUnrealized = Math.max(this.peakUnrealized, unrealizedPnlUsd);
    this.troughUnrealized = Math.min(this.troughUnrealized, unrealizedPnlUsd);
  }

  public reset(): void {
    this.active = false;
    this.peakUnrealized = 0;
    this.troughUnrealized = 0;
  }

  /** Favorable / adverse magnitudes in USD (both >= 0 when a path was observed). */
  public excursionUsd(): { mfe_usd: number; mae_usd: number } | null {
    if (!this.active && this.peakUnrealized === 0 && this.troughUnrealized === 0) {
      return null;
    }
    return {
      mfe_usd: roundUsd(Math.max(0, this.peakUnrealized)),
      mae_usd: roundUsd(Math.max(0, -this.troughUnrealized)),
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
