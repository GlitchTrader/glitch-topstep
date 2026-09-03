export interface TradeExcursionSnapshot {
  mfe_usd: number;
  mae_usd: number;
  mfe_price: number | null;
  mfe_utc: string | null;
  mae_price: number | null;
  mae_utc: string | null;
}

/**
 * Tracks peak/trough unrealized PnL while the scoped instrument is open.
 * Used for MAE/MFE on flat -> trade_outcome enrichment.
 */
export class TradeExcursionTracker {
  private active = false;
  private peakUnrealized = 0;
  private troughUnrealized = 0;
  private peakPrice: number | null = null;
  private peakUtc: string | null = null;
  private troughPrice: number | null = null;
  private troughUtc: string | null = null;

  public observe(
    openContracts: number,
    unrealizedPnlUsd: number,
    markPrice: number | null = null,
    observedUtc: string | null = null,
  ): void {
    if (openContracts <= 0) {
      this.active = false;
      return;
    }
    if (!this.active) {
      this.active = true;
      this.peakUnrealized = unrealizedPnlUsd;
      this.troughUnrealized = unrealizedPnlUsd;
      this.peakPrice = markPrice;
      this.peakUtc = observedUtc;
      this.troughPrice = markPrice;
      this.troughUtc = observedUtc;
      return;
    }
    if (unrealizedPnlUsd >= this.peakUnrealized) {
      this.peakUnrealized = unrealizedPnlUsd;
      this.peakPrice = markPrice;
      this.peakUtc = observedUtc;
    }
    if (unrealizedPnlUsd <= this.troughUnrealized) {
      this.troughUnrealized = unrealizedPnlUsd;
      this.troughPrice = markPrice;
      this.troughUtc = observedUtc;
    }
  }

  public reset(): void {
    this.active = false;
    this.peakUnrealized = 0;
    this.troughUnrealized = 0;
    this.peakPrice = null;
    this.peakUtc = null;
    this.troughPrice = null;
    this.troughUtc = null;
  }

  /** Favorable / adverse magnitudes in USD (both >= 0 when a path was observed). */
  public excursionUsd(): TradeExcursionSnapshot | null {
    if (!this.active && this.peakUnrealized === 0 && this.troughUnrealized === 0) {
      return null;
    }
    return {
      mfe_usd: roundUsd(Math.max(0, this.peakUnrealized)),
      mae_usd: roundUsd(Math.max(0, -this.troughUnrealized)),
      mfe_price: this.peakPrice,
      mfe_utc: this.peakUtc,
      mae_price: this.troughPrice,
      mae_utc: this.troughUtc,
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
